// Shared translation-cache primitives — the canonical cache-key builder used
// by BOTH the results page's in-memory session cache and the 15-day
// persistent cache below, plus the persistent cache's own storage layer.
//
// V1.0.2 PERFORMANCE PASS: adds a second, complementary cache layer on top of
// the existing (unchanged, still-primary) in-memory session cache in
// src/results/app.js. The lookup hierarchy is, and remains:
//
//   local dictionary -> session cache -> 15-day persistent cache -> Gemini
//
// This module owns ONLY the persistent layer + the shared key scheme. It
// never touches the session Map itself (that stays exactly where it was,
// in app.js) and never talks to the background service worker or the
// Cloudflare Worker — it is a pure, local, per-installation storage helper.
//
// STORAGE MECHANISM: chrome.storage.local (the "storage" permission is
// already declared in manifest.json — no manifest change needed). NOT
// chrome.storage.sync (would silently sync translations across a user's
// signed-in Chrome devices and is subject to a much smaller quota — neither
// wanted). NOT IndexedDB (chrome.storage.local is simpler, already
// permission-granted, and entirely sufficient for a bounded key/value cache
// of short strings). NOT Cloudflare KV / anything server-side — this cache
// belongs to the individual user's own browser/extension installation only,
// per the explicit requirement; the Worker is never involved in reading or
// writing it.
//
// KEY SAFETY: every cache key folds in TRANSLATION_PROMPT_VERSION (below).
// If the Worker's translation prompts ever change methodology in a future
// release, bump this constant — every old entry (session AND persistent)
// becomes a silent miss under the new version and is naturally replaced by
// a fresh, current-methodology translation. Nothing needs to "detect" a
// prompt change; the version number is simply part of what must match.

// Bump this whenever worker/src/index.js's TRANSLATE_SYSTEM_PROMPT,
// TRANSLITERATE_SYSTEM_PROMPT, or BATCH_SYSTEM_PROMPT changes in a way that
// could change translation OUTPUT for the same input (wording, tone,
// transliteration convention, etc.) — not for unrelated Worker changes
// (rate limits, error handling, hostname, ...).
export const TRANSLATION_PROMPT_VERSION = 1;

/**
 * The ONE canonical cache key shape, shared by the session Map (app.js) and
 * the persistent store below — "so different translation contexts cannot
 * incorrectly share a translation." `mode` is the same discriminator the
 * Worker itself uses to pick a system prompt ('name' = transliteration,
 * anything else/undefined = faithful prose translation) — see
 * worker/src/index.js's handleTranslate/handleTranslateBatch. That is the
 * real correctness boundary (it's literally what changes which prompt runs),
 * so it — plus the exact Arabic text, plus the prompt version — is what the
 * key is built from. No separate per-field key component is added on top:
 * every PROSE_FIELDS/شرح/أصول(chain/wording) field shares the identical
 * mode-undefined prompt today, so splitting the cache further by field name
 * would only fragment hit rate without adding safety.
 */
export function buildTranslationCacheKey(mode, text) {
  return `${mode || 'prose'}::v${TRANSLATION_PROMPT_VERSION}::${text}`;
}

// ---------------------------------------------------------------------------
// 15-day persistent cache.
// ---------------------------------------------------------------------------

const PERSISTENT_CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
// Storage-key namespace prefix — lets cleanup enumerate/filter just this
// cache's own entries out of chrome.storage.local without touching anything
// else (currently nothing else uses storage.local in this extension, but
// this keeps the cache self-contained regardless).
const ENTRY_PREFIX = 'ptc:'; // "persistent translation cache"
const META_LAST_CLEANUP_KEY = 'ptc_meta:lastCleanupAt';
// A small, deliberately modest cap — these are short translated strings, not
// media, so this is generous for real usage while still bounding worst-case
// storage.local usage (well under its ~10MB default quota) and keeping a
// full-scan cleanup pass cheap.
const MAX_ENTRIES = 2000;
// Only run the full-scan cleanup pass at most this often, gated by a
// timestamp stored alongside the cache itself — never on every write.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * SHA-256 of the logical cache key, hex-encoded, used as the actual
 * chrome.storage.local key. Not for security — just a compact, fixed-length,
 * collision-resistant identifier so arbitrarily long Arabic text never
 * itself becomes (part of) a storage key. Web Crypto (`crypto.subtle`) is
 * available in both the results-page extension context and MV3 service
 * workers, so this needs no external dependency.
 */
async function hashKey(logicalKey) {
  const bytes = new TextEncoder().encode(logicalKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Looks up a persisted translation. Returns the translation string, or
 * `null` on a miss, an expired entry, or ANY failure (storage unavailable,
 * corrupt entry, quota error, etc.) — this function is deliberately
 * "cannot throw." A cache failure must never prevent translation from
 * falling through to Gemini; the caller only ever sees "found" or "not
 * found," never an error to handle.
 */
export async function getPersistentTranslation(mode, text) {
  try {
    const storageKey = ENTRY_PREFIX + (await hashKey(buildTranslationCacheKey(mode, text)));
    const stored = await chrome.storage.local.get(storageKey);
    const entry = stored[storageKey];
    if (!entry || typeof entry.translation !== 'string' || typeof entry.ts !== 'number') {
      return null; // miss, or a corrupt/unexpected shape — treat identically to a miss
    }
    if (Date.now() - entry.ts > PERSISTENT_CACHE_TTL_MS) {
      // Expired — opportunistically remove it (fire-and-forget; a failure
      // here is harmless, the TTL check above already keeps it from being
      // served again regardless of whether the delete succeeds).
      chrome.storage.local.remove(storageKey).catch(() => {});
      return null;
    }
    return entry.translation;
  } catch {
    return null; // storage unavailable/full/corrupt — fall through to Gemini
  }
}

/**
 * Writes a freshly-translated string to the persistent cache. Fire-and-
 * forget safe: callers never need to await this (and never should, on the
 * UI-critical path) — it fully swallows its own failures. Also
 * opportunistically kicks off a throttled cleanup pass (see
 * maybeRunCleanup) — never awaited by the caller either, never blocks
 * rendering or translation.
 */
export async function setPersistentTranslation(mode, text, translation) {
  try {
    if (typeof translation !== 'string' || !translation) return;
    const storageKey = ENTRY_PREFIX + (await hashKey(buildTranslationCacheKey(mode, text)));
    await chrome.storage.local.set({ [storageKey]: { translation, ts: Date.now() } });
  } catch {
    // Storage unavailable/full — the translation still rendered fine from
    // the in-memory session cache; simply not persisted for next time.
  }
  maybeRunCleanup().catch(() => {});
}

/**
 * Throttled, best-effort cleanup: removes expired entries and, if still
 * over MAX_ENTRIES afterward, trims the oldest-by-timestamp entries down to
 * the cap. Only actually runs at most once per CLEANUP_INTERVAL_MS (gated
 * by a timestamp stored in chrome.storage.local itself, so the gate holds
 * across page reloads/service-worker restarts, not just in memory). This is
 * the ONE place that does a full chrome.storage.local.get(null) scan — never
 * done on the per-lookup/per-write hot path, only here, and only
 * occasionally.
 */
async function maybeRunCleanup() {
  try {
    const meta = await chrome.storage.local.get(META_LAST_CLEANUP_KEY);
    const lastRun = meta[META_LAST_CLEANUP_KEY] || 0;
    if (Date.now() - lastRun < CLEANUP_INTERVAL_MS) return;
    // Claim the slot immediately (before the scan even runs) so two nearly-
    // simultaneous writes can't both kick off a redundant full scan.
    await chrome.storage.local.set({ [META_LAST_CLEANUP_KEY]: Date.now() });

    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const entries = Object.entries(all).filter(([key]) => key.startsWith(ENTRY_PREFIX));

    const toRemove = [];
    const live = [];
    for (const [key, value] of entries) {
      if (!value || typeof value.ts !== 'number' || now - value.ts > PERSISTENT_CACHE_TTL_MS) {
        toRemove.push(key);
      } else {
        live.push([key, value.ts]);
      }
    }

    if (live.length > MAX_ENTRIES) {
      live.sort((a, b) => a[1] - b[1]); // oldest first
      const excess = live.length - MAX_ENTRIES;
      for (let i = 0; i < excess; i += 1) toRemove.push(live[i][0]);
    }

    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  } catch {
    // Best-effort only — a failed cleanup pass just means stale/excess
    // entries linger a bit longer; never surfaced, never blocks anything.
  }
}
