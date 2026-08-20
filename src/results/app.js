// Full results page — the primary results surface.
//
// Reuses the EXACT SAME background messaging contract the side panel used
// (SEARCH_DORAR / TRANSLATE_TEXT / TRANSLATE_BATCH / GENERATE_SEARCH_QUERY) —
// not a second, disconnected search system. Owns: language routing for the
// query, the session-only translation cache, and rendering the COMPLETE
// result set (background/resultSelector.js has already picked specialist-if-
// present-else-general — this file never shows that choice to the user and
// never re-merges/re-splits it; see the UI-simplification note below).
//
// UI-SIMPLIFICATION PASS (this correction): all "Specialist"/"General"
// wording, counts, and the "View General instead" toggle have been removed
// from the UI entirely — the user must never see Dorar's internal retrieval
// category. The background's specialist-if-present-else-general selection
// logic is completely unchanged; this file just stopped exposing which one
// it picked. Only ONE unified result list is rendered now. Also removed:
// التصنيف الموضوعي (topic/classification tags) — offscreen.js no longer even
// extracts them (see its file-level note), so `result.classifications` no
// longer exists; nothing here references it.
//
// MULTI-TAB CORRECTION (this pass): the translation concurrency queue +
// bounded retry used to live here, per tab. That meant every simultaneously
// open results tab ran its own independent queue against the SAME shared
// Gemini quota, with no coordination — the diagnosed cause of a real
// symptom (tab 1 of 3 simultaneous tabs translated fine, tabs 2 and 3 showed
// "unavailable"). The queue + retry have moved to src/background/index.js,
// the one thing genuinely shared by every tab of this extension, giving all
// tabs one real global concurrency cap. This file now just fires a
// TRANSLATE_TEXT/TRANSLATE_BATCH message directly — no local queue, no local
// retry — and trusts the background to pace/retry/back off. The translation
// CACHE stays here, per tab: each tab's already-completed translations are
// its own and are never shared with or corrupted by another tab.
//
// LAZY-TRANSLATION PASS (this correction): only the first 5 rendered results
// translate immediately on search load (still funneled through the shared
// background queue, so even that initial burst is paced/bounded — never an
// unbounded simultaneous fire). Results beyond the first 5 translate lazily,
// only once their card actually scrolls near the viewport (IntersectionObserver).
// شرح الحديث / أصول الحديث NEVER auto-translate just because the main list
// loaded — only when the user actually opens that action — and once open,
// long content is translated progressively as the user scrolls the MODAL's
// own scrollable container, not all sent to Gemini in one shot.
//
// SESSION CACHE (clarified this pass): "session" means ONE search. Every
// explicit new search submission (search icon / Enter / search button) —
// even one that differs from the previous query by a single word or a
// diacritic — starts a brand-new session: the in-memory cache is cleared
// unconditionally at the top of runSearch(), regardless of how similar the
// new query or its results are to the previous search. The only other thing
// that resets it is a page refresh/crash (which loses this in-memory state
// naturally). Within one unchanged session, already-translated text —
// whether a main list field, a شرح chunk, or an أصول source field — is never
// re-sent to Gemini, no matter how many times its card/modal is scrolled
// past, closed, or reopened.
//
// V1.0.2 PERFORMANCE PASS — TWO complementary cache layers now exist:
//   1. The in-memory session cache above (translationCache, unchanged in
//      nature — still per-tab, still wiped every new search).
//   2. A NEW 15-day persistent cache (src/shared/translationCache.js),
//      backed by chrome.storage.local — belongs to this browser
//      installation only, survives page refreshes/restarts/new searches,
//      expires entries after 15 days, and is consulted ONLY after both the
//      local dictionaries AND the session cache have already missed:
//        local dictionary -> session cache -> 15-day persistent cache -> Gemini
//      Neither cache replaces the other; see that module's file-level
//      comment for the full storage-mechanism/key/TTL rationale. A
//      persistent-cache failure (storage full/unavailable/corrupt) always
//      degrades silently to "fall through to Gemini" — never breaks
//      translation.

import { MESSAGE_TARGETS, MESSAGE_TYPES, DORAR_FIELD_LABELS } from '../shared/constants.js';
import { looksArabic } from '../shared/language.js';
import {
  resolveNarratorField,
  lookupScholar,
  lookupSource,
  lookupGrading,
  lookupUsulSource,
  lookupTakhrij,
} from '../shared/dictionaries/index.js';
import {
  buildTranslationCacheKey,
  getPersistentTranslation,
  setPersistentTranslation,
} from '../shared/translationCache.js';

const form = document.getElementById('search-form');
const input = document.getElementById('query-input');
const button = document.getElementById('search-button');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('results-summary');
const listEl = document.getElementById('result-list');

// Free-form Arabic prose: faithful translation (default Worker mode).
// arLabel reuses Dorar's OWN label text (shared/constants.js) — not a new
// translation, just the exact Arabic wording Dorar already uses for that
// field, shown on the Arabic side of the bilingual row.
const PROSE_FIELDS = [
  { key: 'hadith', resultProp: 'arabicText' }, // rendered by appendPrimarySection, not the generic helper
  { key: 'grading', resultProp: 'grading', label: 'Grading', arLabel: 'الدرجة' },
  { key: 'takhrij', resultProp: 'takhrij', label: 'Takhrij', arLabel: DORAR_FIELD_LABELS.takhrij },
];

// Proper names / titles: transliteration mode ('name'), never ordinary
// translation — see worker/src/index.js's TRANSLITERATE_SYSTEM_PROMPT.
const NAME_FIELDS = [
  { key: 'narrator', resultProp: 'narrator', label: 'Narrator', arLabel: DORAR_FIELD_LABELS.rawi },
  { key: 'muhaddith', resultProp: 'muhaddith', label: 'Muhaddith', arLabel: DORAR_FIELD_LABELS.mohdith },
  { key: 'source', resultProp: 'source', label: 'Source', arLabel: DORAR_FIELD_LABELS.book },
];

// Fixed, permanent bilingual labels for Dorar's action names. This wording
// never changes, so it is NEVER sent to Gemini — hardcoded once, here.
const ACTION_LABELS = {
  similar: { ar: 'أحاديث مشابهة', en: 'Similar Hadiths' },
  usul: { ar: 'أصول الحديث', en: 'Hadith Principles (Usul al-Hadith)' },
  sharh: { ar: 'شرح الحديث', en: 'Hadith Explanation' },
  sharhSimilar: { ar: 'شرح حديث مشابه', en: 'Explanation of a Similar Hadith' },
  asbabWurud: { ar: 'أسباب ورود الحديث', en: "Circumstances of the Hadith's Occurrence" },
  alternateSahih: { ar: 'الصحيح البديل', en: 'Alternate Ṣaḥīḥ' },
};

// How many of the top rendered results auto-translate immediately on search
// load. Everything after this translates lazily (IntersectionObserver) as
// the user scrolls near it.
//
// V1.0.2 PERFORMANCE PASS: reduced from 5 to 3 — results far below the
// viewport were consuming RPM budget and dispatch slots before the user had
// scrolled anywhere near them. Lazy loading (below) is completely
// unchanged; this only shrinks the eager burst that fires the instant a
// search loads, prioritizing the content actually in view.
const AUTO_TRANSLATE_COUNT = 3;

// Long شرح/أصول content is broken into chunks translated progressively; only
// the first chunk (visible the instant the modal opens) translates eagerly,
// the rest translate lazily as the user scrolls the modal.
const EAGER_MODAL_CHUNK_COUNT = 1;
const MAX_CHUNK_CHARS = 700;

// Session-only caches. Reset on every new search — nothing here ever touches
// disk (chrome.storage, localStorage, IndexedDB — none used).
//
// translationCache is CONTENT-keyed ("<mode>::<arabicText>" -> English), not
// per-result — see the file-level note above for why. sharhTextCache/
// usulSourcesCache stay keyed by their own fetch identity (sharhId / url)
// since those are fetch-dedup caches, not translation-dedup caches.
let translationCache = new Map();
let sharhTextCache = new Map();
let usulSourcesCache = new Map();

// IntersectionObserver driving lazy translation of results 6+ in the main
// list. Recreated (and the old one disconnected) on every new search.
let mainListLazyObserver = null;

// ---------------------------------------------------------------------------
// STALE-QUEUE FIX (this pass) — search generation tracking.
//
// currentSearchGeneration increments once per runSearch() call (see below).
// Every translation task created during a given search's render pass
// captures THAT search's generation number as a plain parameter threaded
// through the render/translate call chain (renderResults -> ... ->
// runBatchTranslation / translateFieldGroup / translateOneField) — never
// read fresh from this module-level variable at response time, since by
// then a newer search may already have incremented it. Each outgoing
// TRANSLATE_TEXT/TRANSLATE_BATCH message carries that captured generation;
// the background (src/background/index.js) uses it to avoid ever
// DISPATCHING now-obsolete queued work. This variable, here, is the
// CURRENT generation — used only to decide, when a response finally
// arrives (whether freshly dispatched or an old one that was already in
// flight when a newer search started), whether it's still safe to touch
// this tab's DOM/cache: if the response's captured generation no longer
// matches this value, the result is silently discarded (see
// isResponseStale below) rather than corrupting a newer search's state.
let currentSearchGeneration = 0;

function isResponseStale(searchGeneration) {
  return searchGeneration !== currentSearchGeneration;
}

// ---------------------------------------------------------------------------
// STALE-QUEUE FIX (this pass), Part 2 — "Queued…" vs "Translating…".
//
// requestId is generated fresh for each individual outbound TRANSLATE_TEXT/
// TRANSLATE_BATCH message (unlike searchGeneration, it does not need to be
// threaded through the render tree — it's created right where the message
// is actually sent). pendingDispatchSlots maps a requestId to the slot
// element(s) that message covers; the background sends a one-way
// TRANSLATION_DISPATCHED notification (see background/index.js's
// notifyDispatched) the instant that request's real Worker fetch begins,
// letting those specific slots flip from "Queued…" to "Translating…". This
// is a pure UI-truthfulness affordance: if the notification is ever missed
// (tab busy, message dropped — chrome.tabs.sendMessage is best-effort), the
// slot simply stays "Queued…" a little longer than ideal and still
// resolves correctly the moment the real response arrives — never wrong,
// never stuck.
let nextRequestId = 1;
const pendingDispatchSlots = new Map(); // requestId -> HTMLElement[]

function registerPendingDispatch(requestId, slotEls) {
  pendingDispatchSlots.set(requestId, slotEls);
}

function clearPendingDispatch(requestId) {
  pendingDispatchSlots.delete(requestId);
}

// V1.0.2 PERFORMANCE PASS — exact user-facing translation-state wording
// (specified verbatim by requirement, not free-form copy). Used for every
// loading-state slot across the main list, شرح, and أصول.
const STATUS_QUEUED = 'Queued for translation, will be sent shortly';
const STATUS_TRANSLATING = 'Translating, please hold on a moment';
const STATUS_RATE_LIMITED = 'Translation temporarily delayed — continuing automatically in a few seconds.';

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;

  if (message.type === MESSAGE_TYPES.TRANSLATION_DISPATCHED) {
    // V1.0.2 CORRECTION: does NOT delete the pendingDispatchSlots entry
    // here (v1.0.1 did — harmless there, since nothing else depended on the
    // entry surviving past the first dispatch). This entry must now survive
    // across MULTIPLE dispatch notifications for the SAME requestId — a
    // retried request dispatches more than once (once per attempt), and a
    // 429-triggered retry needs TRANSLATION_RATE_LIMITED to still find this
    // entry AFTER the first dispatch already fired. The entry is removed
    // exactly once, only when the request truly settles (success or final
    // failure) — see clearPendingDispatch, called from the response-handler
    // functions below (runBatchTranslation / runFieldGroupBatch /
    // translateOneField) — never from this notification handler.
    const slots = pendingDispatchSlots.get(message.requestId);
    if (!slots) return;
    for (const slotEl of slots) {
      // Checking the `is-loading` CLASS (not an exact previous-text match)
      // is deliberate: this same flip-to-"Translating" now also fires after
      // a rate-limited retry (see TRANSLATION_RATE_LIMITED below), whose
      // slot was showing STATUS_RATE_LIMITED, not STATUS_QUEUED — both are
      // still legitimately "loading" states this notification should
      // resolve.
      if (slotEl.classList.contains('is-loading')) {
        slotEl.textContent = STATUS_TRANSLATING;
      }
    }
    return;
  }

  if (message.type === MESSAGE_TYPES.TRANSLATION_RATE_LIMITED) {
    // V1.0.2: background/index.js's withRetry hit a genuine HTTP 429 and is
    // about to wait (intelligently — see that file) before its next retry
    // attempt, which still goes through the exact same central queue. Purely
    // an honesty affordance for the UI; do NOT clear pendingDispatchSlots
    // here — the SAME requestId will fire another TRANSLATION_DISPATCHED
    // once the retry actually dispatches.
    const slots = pendingDispatchSlots.get(message.requestId);
    if (!slots) return;
    for (const slotEl of slots) {
      if (slotEl.classList.contains('is-loading')) {
        slotEl.textContent = STATUS_RATE_LIMITED;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// LOCAL-LOOKUP INDICATOR — permanent feature, not a temporary/debug toggle.
//
// Every narrator/muhaddith/source/grading value that was resolved from the
// local dictionaries (src/shared/dictionaries/) — never Gemini — gets a
// tiny superscript "ᴸ" appended ONLY at render time, meaning "resolved from
// a verified local lookup." This is presentation-only: the marker is never
// written into translationCache (setCachedTranslation always stores the
// plain, unmarked English text — see resolveLocalNameField's call sites
// below), never sent to Gemini or anywhere else, and never affects which
// branch (local vs Gemini) a value takes. localResolvedKeys is a separate
// bookkeeping Set (not the translation cache itself) that remembers which
// content-keys were resolved locally, purely so a later cache-hit render of
// the SAME value still shows the marker consistently; it carries no
// translated text, only keys, and is reset alongside the other session
// caches on every new search. LOCAL_TRANSLATION_DEBUG stays a named
// constant (clean, conventional way to gate this) rather than being
// unconditionally inlined — kept `true` as the permanent, shipped setting.
const LOCAL_TRANSLATION_DEBUG = true;
const LOCAL_DEBUG_MARKER = 'ᴸ';

let localResolvedKeys = new Set();

function markLocallyResolved(mode, text) {
  localResolvedKeys.add(cacheKeyForText(mode, text));
}

function withLocalDebugMarker(displayText, mode, sourceText) {
  if (!LOCAL_TRANSLATION_DEBUG) return displayText;
  return localResolvedKeys.has(cacheKeyForText(mode, sourceText))
    ? `${displayText}${LOCAL_DEBUG_MARKER}`
    : displayText;
}

// V1.0.2 PERFORMANCE PASS: now delegates to the SAME canonical key builder
// the 15-day persistent cache uses (src/shared/translationCache.js) —
// "ONE coherent... cache key" scheme shared by both layers, folding in
// TRANSLATION_PROMPT_VERSION so a future prompt-methodology change (bumping
// that constant) invalidates stale entries in both caches uniformly, with
// nothing here needing to change.
function cacheKeyForText(mode, text) {
  return buildTranslationCacheKey(mode, text);
}

function getCachedTranslation(mode, text) {
  return translationCache.get(cacheKeyForText(mode, text));
}

function setCachedTranslation(mode, text, translation) {
  translationCache.set(cacheKeyForText(mode, text), translation);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch(input.value.trim());
});

// Opened from the side panel with ?q=..., or from the "Check in Hadith
// Checker" right-click context-menu action — run immediately either way.
// ?q= carries the query directly (short selections/manual side-panel
// launches); ?ctxKey= carries a one-time chrome.storage.session key instead
// (longer selections — see background/index.js's openHadithCheckerWithQuery
// for why). Exactly one of the two is ever present on a given load.
const initialUrlParams = new URLSearchParams(location.search);
const initialQuery = initialUrlParams.get('q');
const contextMenuKey = initialUrlParams.get('ctxKey');

if (contextMenuKey) {
  chrome.storage.session
    .get(contextMenuKey)
    .then((stored) => {
      const text = stored[contextMenuKey];
      chrome.storage.session.remove(contextMenuKey).catch(() => {}); // one-time use, clean up either way
      if (text) {
        input.value = text;
        runSearch(text);
      } else {
        setStatus('Could not retrieve the selected text. Please search again.', 'error');
      }
    })
    .catch((err) => {
      setStatus(`Could not retrieve the selected text: ${err.message || err}`, 'error');
    });
} else if (initialQuery) {
  input.value = initialQuery;
  runSearch(initialQuery);
}

async function runSearch(rawQuery) {
  listEl.innerHTML = '';
  summaryEl.textContent = '';

  // New search = new session, ALWAYS — even if rawQuery is nearly identical
  // to the previous one (different diacritics, one changed word, etc.). Never
  // reuse translations across two distinct search submissions.
  translationCache = new Map();
  sharhTextCache = new Map();
  usulSourcesCache = new Map();
  localResolvedKeys = new Set(); // debug-only bookkeeping, see its declaration above
  if (mainListLazyObserver) {
    mainListLazyObserver.disconnect();
    mainListLazyObserver = null;
  }

  // STALE-QUEUE FIX: a brand-new generation for this search, captured here
  // (not read fresh later) and threaded through the whole render/translate
  // call chain below. Incremented unconditionally, even for an ultimately-
  // invalid/empty query, matching the existing reset-everything-up-front
  // pattern above — an old search's in-flight work is retired the instant a
  // new search begins, regardless of whether the new one turns out valid.
  currentSearchGeneration += 1;
  const searchGeneration = currentSearchGeneration;

  if (!rawQuery) {
    setStatus('Please enter a search query.', 'error');
    return;
  }

  button.disabled = true;

  try {
    const arabicQuery = await resolveArabicQuery(rawQuery);
    if (arabicQuery === null) return; // resolveArabicQuery already set an error status

    setStatus('Searching Dorar…', 'loading');
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.SEARCH_DORAR,
      query: arabicQuery,
    });

    if (!response || !response.ok) {
      setStatus(response?.error || 'Something went wrong.', 'error');
      if (response && response.resultsReportedCount !== undefined) {
        // Deliberately no specialist/general wording here either — see the
        // file-level UI-simplification note.
        const totalReported = (response.resultsReportedCount || 0) + (response.otherReportedCount || 0);
        summaryEl.textContent = `(Dorar reported ${totalReported} result${totalReported === 1 ? '' : 's'}, but none could be parsed.)`;
      }
      return;
    }

    clearStatus();
    renderSummary(response);
    renderResults(response.results, searchGeneration);
  } catch (err) {
    setStatus(`Extension error: ${err.message || err}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function resolveArabicQuery(rawQuery) {
  if (looksArabic(rawQuery)) {
    return rawQuery;
  }

  setStatus('Translating your search…', 'loading');
  const response = await sendMessage({
    target: MESSAGE_TARGETS.BACKGROUND,
    type: MESSAGE_TYPES.GENERATE_SEARCH_QUERY,
    text: rawQuery,
  });

  if (!response || !response.ok) {
    setStatus(`Could not translate your search to Arabic: ${response?.error || 'unknown error'}`, 'error');
    return null;
  }

  return response.arabicQuery;
}

// Plain, unified result count — no mention of which internal Dorar category
// (specialist/general) it came from. background/resultSelector.js has
// already made that choice; resultsReportedCount is that chosen category's
// Dorar-reported total, i.e. the "current accurate result count."
function renderSummary(response) {
  summaryEl.innerHTML = '';

  const count = response.resultsReportedCount;
  const countEl = document.createElement('span');
  countEl.className = 'summary-count';
  countEl.textContent = `${count} result${count === 1 ? '' : 's'}`;
  summaryEl.appendChild(countEl);
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className = '';
}

// ---------------------------------------------------------------------------
// Lazy-translation helper — shared by the main result list (results 6+) and
// modal content (شرح/أصول chunks beyond the first). One-shot: the first time
// an observed element intersects, its callback fires and it stops being
// observed. `rootEl` null means "the viewport" (used for the main list);
// passing a modal's own scrollable overlay scopes it to that modal instead.
// ---------------------------------------------------------------------------

function createLazyObserver(rootEl) {
  let observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const callback = entry.target.__onLazyVisible;
        entry.target.__onLazyVisible = null;
        if (callback) callback();
      }
    },
    { root: rootEl || null, rootMargin: '600px 0px', threshold: 0 },
  );
  return observer;
}

function observeForLazyTranslation(observer, element, callback) {
  element.__onLazyVisible = callback;
  observer.observe(element);
}

// ---------------------------------------------------------------------------
// Rendering — the COMPLETE result set, in Dorar's own order, never truncated
// for layout reasons. Numbering is this list's own position (Result #1..#N)
// — never a Dorar hadithId, page number, or citation number, and stable
// regardless of translation progress (assigned at render time, not touched
// afterward).
// ---------------------------------------------------------------------------

function renderResults(results, searchGeneration) {
  const rendered = results.map((result, index) => {
    const { card, slots } = renderCard(result, index, searchGeneration);
    listEl.appendChild(card);
    return { result, slots, card };
  });

  mainListLazyObserver = createLazyObserver(null);

  rendered.forEach(({ result, slots, card }, index) => {
    if (index < AUTO_TRANSLATE_COUNT) {
      // Still goes through the shared background queue — see background/
      // index.js. Auto-translating the first 3 never means firing 3+ raw
      // simultaneous Gemini calls.
      translateAllFieldsForCard(result, slots, searchGeneration);
    } else {
      observeForLazyTranslation(mainListLazyObserver, card, () =>
        translateAllFieldsForCard(result, slots, searchGeneration),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// BILINGUAL REDESIGN (this pass — visual/structural only; the translation
// data flow above is untouched). `.hadith-card` is now itself a single CSS
// grid (see styles.css) so every field's English cell (left) and Arabic cell
// (right) stay column-aligned across the whole card. Each row-building
// function below appends its cells DIRECTLY to `card` — Arabic cell first in
// DOM order, English cell second. That DOM order is deliberate: desktop CSS
// explicitly places English in the left grid column and Arabic in the right
// one regardless of source order, but the narrow-viewport fallback (see the
// responsive block in styles.css) drops back to a single column and simply
// stacks children in DOM order — Arabic on top, English below, matching this
// project's established "Arabic is the authoritative content" convention.
// Takhrij is the deliberate exception (per spec): it's often much longer
// than the other fields, so it gets its own full-width two-ROW block
// (Arabic row above, English row below) instead of being squeezed into two
// narrow side-by-side columns.
// ---------------------------------------------------------------------------

function renderCard(result, index, searchGeneration) {
  const card = document.createElement('article');
  card.className = 'hadith-card';
  const slots = {};

  // ALIGNMENT FIX (found via live DOM measurement of this pass's redesign):
  // giving each cell an explicit `grid-column` but leaving `grid-row` to the
  // browser's auto-placement does NOT reliably pair an EN/AR cell into the
  // SAME row — CSS Grid's row-less placement cursor can advance past an
  // earlier row before a later, column-1 item gets a chance to backfill it,
  // so the two cells can land one row apart (confirmed live: their
  // getBoundingClientRect().top values differed). Fixed by assigning both
  // cells of a pair the SAME explicit grid-row via this counter, which also
  // gives full-width elements (serial/divider/takhrij/actions) their own row.
  // On narrow viewports this is overridden back to `auto` (see the
  // responsive block in styles.css) so single-column stacking still works.
  const rowCounter = { n: 1 };

  card.appendChild(placeInRow(renderSerialNumber(index + 1), rowCounter));
  appendPrimarySection(card, result, slots, rowCounter);

  for (const field of NAME_FIELDS) {
    const value = result[field.resultProp];
    if (!value) continue;
    appendBilingualFieldRow(card, field, value, slots, 'name', rowCounter);
  }

  if (result.pageOrNumber) {
    // Language-neutral (a page/citation number — same value both sides, no
    // translation needed) but still a proper bilingual PAIR of cells, same
    // as every other metadata row: English cell in the LEFT column, Arabic
    // cell in the RIGHT column. (FIX: this used to be a single combined
    // full-width row with both labels concatenated together, which could
    // visually land the Arabic label on the English/left side.)
    appendPageNumberRow(card, result.pageOrNumber, rowCounter);
  }

  const gradingField = PROSE_FIELDS.find((f) => f.key === 'grading');
  if (result.grading) {
    appendBilingualFieldRow(card, gradingField, result.grading, slots, undefined, rowCounter);
  }

  if (result.takhrij) {
    appendTakhrijRow(card, result.takhrij, slots, rowCounter);
  }

  const actionBar = renderActionBar(result, searchGeneration);
  if (actionBar) card.appendChild(placeInRow(actionBar, rowCounter));

  return { card, slots };
}

/** Assigns the next grid row to a full-width (single) element and advances
 * the counter. See renderCard's alignment-fix note above. */
function placeInRow(el, rowCounter) {
  el.style.gridRow = String(rowCounter.n);
  rowCounter.n += 1;
  return el;
}

/** Assigns the SAME grid row to both cells of an EN/AR pair and advances the
 * counter once. See renderCard's alignment-fix note above. */
function placePairInRow(arCell, enCell, rowCounter) {
  const row = String(rowCounter.n);
  arCell.style.gridRow = row;
  enCell.style.gridRow = row;
  rowCounter.n += 1;
}

function renderSerialNumber(n) {
  const badge = document.createElement('div');
  badge.className = 'result-serial';
  badge.textContent = `Result #${n}`;
  return badge;
}

function renderDivider() {
  const hr = document.createElement('hr');
  hr.className = 'card-divider';
  return hr;
}

/** The hadith itself — the card's visual centerpiece. Arabic (right) and its
 * English translation (left) both get full-size, generously-spaced prose
 * treatment, not the compact "inline note" styling used for metadata. */
function appendPrimarySection(card, result, slots, rowCounter) {
  const arCell = document.createElement('div');
  arCell.className = 'bi-cell bi-cell-ar hadith-cell';
  arCell.dir = 'rtl';
  const arabicBlock = document.createElement('div');
  arabicBlock.className = 'arabic-block';
  arabicBlock.dir = 'rtl';
  arabicBlock.lang = 'ar';
  arabicBlock.textContent = result.arabicText;
  arCell.appendChild(arabicBlock);

  const enCell = document.createElement('div');
  enCell.className = 'bi-cell bi-cell-en hadith-cell';
  enCell.dir = 'ltr';
  const englishBlock = document.createElement('div');
  englishBlock.className = 'translation-text hadith-en-text is-loading';
  englishBlock.dir = 'ltr';
  englishBlock.lang = 'en';
  englishBlock.title = 'AI-generated translation — not Dorar’s own English wording.';
  englishBlock.textContent = STATUS_QUEUED;
  slots.hadith = englishBlock;
  enCell.append(englishBlock);

  placePairInRow(arCell, enCell, rowCounter);
  card.append(arCell, enCell);
}

/** One full-width, language-neutral row — used only by the modal recap's
 * grading fallback (see renderModalRecap), which sits in a plain flex
 * container, not the main card's bilingual grid. */
function renderSimpleFullRow(arLabel, enLabel, value) {
  const row = document.createElement('div');
  row.className = 'field-row field-row-full';

  const labelEl = document.createElement('span');
  labelEl.className = 'field-row-label';
  labelEl.textContent = `${enLabel} / ${arLabel}: `;

  const valueEl = document.createElement('span');
  valueEl.className = 'field-row-value';
  valueEl.dir = 'auto';
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  return row;
}

/**
 * Page/Number: language-neutral (a citation number, e.g. "3/348") so the
 * SAME value appears on both sides — but still rendered as a proper
 * left=English/right=Arabic cell PAIR like every other metadata row, not a
 * single combined row. That combined-row shape was the bug: with both
 * labels concatenated into one LTR text run, the Arabic label could end up
 * visually appearing on the English/left side instead of its own column.
 */
function appendPageNumberRow(card, value, rowCounter) {
  const arCell = document.createElement('div');
  arCell.className = 'bi-cell bi-cell-ar field-cell';
  arCell.dir = 'rtl';
  const arLabel = document.createElement('span');
  arLabel.className = 'field-row-label';
  arLabel.textContent = DORAR_FIELD_LABELS.numberOrPage;
  const arValue = document.createElement('span');
  arValue.className = 'field-row-value';
  arValue.dir = 'auto';
  arValue.textContent = value;
  arCell.append(arLabel, arValue);

  const enCell = document.createElement('div');
  enCell.className = 'bi-cell bi-cell-en field-cell';
  enCell.dir = 'ltr';
  const enLabel = document.createElement('span');
  enLabel.className = 'field-row-label';
  enLabel.textContent = 'Page/Number';
  const enValue = document.createElement('span');
  enValue.className = 'field-row-value';
  enValue.dir = 'auto';
  enValue.textContent = value;
  enCell.append(enLabel, enValue);

  placePairInRow(arCell, enCell, rowCounter);
  card.append(arCell, enCell);
}

/**
 * One bilingual metadata row — narrator/muhaddith/source (mode: 'name') or
 * grading (mode: undefined/prose). Arabic cell (Dorar's own label + own
 * wording) and English cell (fixed label + AI translation slot) are two
 * separate grid items so they stay column-aligned with every other row.
 */
function appendBilingualFieldRow(card, field, arabicValue, slots, mode, rowCounter) {
  const arCell = document.createElement('div');
  arCell.className = 'bi-cell bi-cell-ar field-cell';
  arCell.dir = 'rtl';
  const arLabel = document.createElement('span');
  arLabel.className = 'field-row-label';
  arLabel.textContent = field.arLabel;
  const arValue = document.createElement('span');
  arValue.className = 'field-row-value';
  arValue.lang = 'ar';
  arValue.textContent = arabicValue;
  arCell.append(arLabel, arValue);

  const enCell = document.createElement('div');
  enCell.className = 'bi-cell bi-cell-en field-cell';
  enCell.dir = 'ltr';
  const enLabel = document.createElement('span');
  enLabel.className = 'field-row-label';
  enLabel.textContent = field.label;
  enLabel.title = 'AI-generated translation — not Dorar’s own English wording.';
  const enValue = document.createElement('span');
  enValue.className = mode === 'name' ? 'translation-text name-english is-loading' : 'translation-text is-loading';
  enValue.dir = 'ltr';
  enValue.lang = 'en';
  enValue.textContent = mode === 'name' ? '…' : STATUS_QUEUED;
  slots[field.key] = enValue;
  enCell.append(enLabel, enValue);

  placePairInRow(arCell, enCell, rowCounter);
  card.append(arCell, enCell);
}

/**
 * Takhrij is the deliberate exception to the side-by-side layout: it can run
 * substantially longer than the other fields, so forcing it into two narrow
 * columns would make the card unnecessarily tall/cramped. Instead it's a
 * full-width block with the Arabic row on top and the English row directly
 * beneath it.
 */
function appendTakhrijRow(card, arabicValue, slots, rowCounter) {
  const block = document.createElement('div');
  block.className = 'takhrij-block';

  const arRow = document.createElement('div');
  arRow.className = 'takhrij-row takhrij-row-ar';
  arRow.dir = 'rtl';
  const arLabel = document.createElement('span');
  arLabel.className = 'field-row-label';
  arLabel.textContent = DORAR_FIELD_LABELS.takhrij;
  const arValue = document.createElement('span');
  arValue.className = 'field-row-value';
  arValue.lang = 'ar';
  arValue.textContent = arabicValue;
  arRow.append(arLabel, arValue);

  const enRow = document.createElement('div');
  enRow.className = 'takhrij-row takhrij-row-en';
  enRow.dir = 'ltr';
  const enLabel = document.createElement('span');
  enLabel.className = 'field-row-label';
  enLabel.textContent = 'Takhrij';
  enLabel.title = 'AI-generated translation — not Dorar’s own English wording.';
  const enValue = document.createElement('span');
  enValue.className = 'translation-text is-loading';
  enValue.dir = 'ltr';
  enValue.lang = 'en';
  enValue.textContent = STATUS_QUEUED;
  slots.takhrij = enValue;
  enRow.append(enLabel, enValue);

  block.append(arRow, enRow);
  card.appendChild(placeInRow(block, rowCounter));
}

function renderInlineTranslation(initialText) {
  const wrap = document.createElement('div');
  wrap.className = 'inline-translation';

  const tag = document.createElement('span');
  tag.className = 'inline-translation-tag';
  tag.textContent = 'EN';
  tag.title = 'AI-generated translation — not Dorar’s own English wording.';

  const slot = document.createElement('span');
  slot.className = 'translation-text is-loading';
  slot.dir = 'ltr';
  slot.lang = 'en';
  slot.textContent = initialText;

  wrap.append(tag, slot);
  return { wrap, slotEl: slot };
}

// ---------------------------------------------------------------------------
// Action bar — real controls only, only for actions Dorar actually provides
// for THIS result. Labels are the fixed static bilingual map above — never
// sent to Gemini. شرح fetches and shows real content in a modal; أصول fetches
// and shows real parsed content in a modal; the rest open the real Dorar page
// in a new tab (marked with a trailing ↗ — a deliberate, kept UI signal that
// those specific actions leave the page; شرح/أصول don't get one since they
// open inline instead).
// ---------------------------------------------------------------------------

function renderActionBar(result, searchGeneration) {
  const actions = result.actions || {};
  const hasAny =
    actions.sharh || actions.similar || actions.usul || actions.alternateSahih || actions.asbabWurud;
  if (!hasAny) return null;

  const bar = document.createElement('section');
  bar.className = 'action-bar';

  if (actions.sharh) {
    const labelKey = actions.sharh.isSimilarHadith ? 'sharhSimilar' : 'sharh';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-btn action-btn-sharh';
    btn.textContent = actionButtonText(labelKey);
    btn.addEventListener('click', () => openSharhModal(result, actions.sharh.sharhId, labelKey, searchGeneration));
    bar.appendChild(btn);
  }
  if (actions.similar) {
    bar.appendChild(renderExternalAction('similar', 'action-btn-similar', actions.similar.url));
  }
  if (actions.usul) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-btn action-btn-usul';
    btn.textContent = actionButtonText('usul');
    btn.addEventListener('click', () => openUsulModal(result, actions.usul.url, searchGeneration));
    bar.appendChild(btn);
  }
  if (actions.alternateSahih) {
    bar.appendChild(renderExternalAction('alternateSahih', 'action-btn-alt', actions.alternateSahih.url));
  }
  if (actions.asbabWurud) {
    bar.appendChild(renderExternalAction('asbabWurud', 'action-btn-asbab', actions.asbabWurud.url));
  }

  return bar;
}

function actionButtonText(labelKey) {
  const label = ACTION_LABELS[labelKey];
  return `${label.ar} (${label.en})`;
}

function renderExternalAction(labelKey, colorClass, url) {
  const link = document.createElement('a');
  link.className = `action-btn ${colorClass}`;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${actionButtonText(labelKey)} ↗`;
  return link;
}

// ---------------------------------------------------------------------------
// Modal shell — shared by شرح and أصول. Passes the scrollable overlay element
// down to buildContent so callers can scope a lazy-translation observer to
// THIS modal's own scroll container (not the outer page viewport).
// ---------------------------------------------------------------------------

function openModal(buildContent) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');

  const panel = document.createElement('div');
  panel.className = 'modal-panel';

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  buildContent(panel, overlay);
  overlay.append(closeBtn, panel);
  document.body.appendChild(overlay);

  return panel;
}

// ---------------------------------------------------------------------------
// شرح modal — content is fetched only on open (never on main-list load), and
// translated progressively: only the first chunk (visible immediately) is
// translated eagerly, the rest translate lazily as the user scrolls this
// modal's own overlay.
// ---------------------------------------------------------------------------

/**
 * Modal recap header (used by both شرح and أصول). Reads ONLY from the
 * existing session cache — never triggers a new translation just because a
 * modal opened. If the hadith/grading were already translated (e.g. this
 * result was in the auto-translated first 5, or was already scrolled past),
 * the recap shows both languages side by side, matching the main list's
 * bilingual philosophy. If not yet translated (e.g. a lazy result the user
 * jumped straight to an action on), the recap shows Arabic only rather than
 * forcing an extra request — opening شرح/أصول must never itself trigger
 * translation of the recap fields.
 */
function renderModalRecap(result) {
  const recap = document.createElement('div');
  recap.className = 'modal-recap';

  const cachedHadith = getCachedTranslation(undefined, result.arabicText);
  const arabicEl = document.createElement('div');
  arabicEl.className = 'arabic-block modal-recap-arabic';
  arabicEl.dir = 'rtl';
  arabicEl.lang = 'ar';
  arabicEl.textContent = result.arabicText;

  if (cachedHadith) {
    recap.classList.add('modal-recap-bilingual');

    const arCell = document.createElement('div');
    arCell.className = 'bi-cell bi-cell-ar';
    arCell.dir = 'rtl';
    arCell.appendChild(arabicEl);

    const enCell = document.createElement('div');
    enCell.className = 'bi-cell bi-cell-en';
    enCell.dir = 'ltr';
    const englishEl = document.createElement('div');
    englishEl.className = 'translation-text modal-recap-english is-done';
    englishEl.dir = 'ltr';
    englishEl.lang = 'en';
    englishEl.textContent = cachedHadith;
    enCell.appendChild(englishEl);

    recap.append(arCell, enCell);
  } else {
    recap.appendChild(arabicEl);
  }

  if (result.grading) {
    const cachedGrading = getCachedTranslation(undefined, result.grading);
    if (cachedGrading) {
      const gradingRow = document.createElement('div');
      gradingRow.className = 'modal-recap-grading-bilingual';
      const arGrading = document.createElement('span');
      arGrading.dir = 'rtl';
      arGrading.lang = 'ar';
      arGrading.textContent = `الدرجة: ${result.grading}`;
      const enGrading = document.createElement('span');
      enGrading.dir = 'ltr';
      enGrading.lang = 'en';
      enGrading.textContent = `Grading: ${cachedGrading}`;
      gradingRow.append(arGrading, enGrading);
      recap.appendChild(gradingRow);
    } else {
      recap.appendChild(renderSimpleFullRow('الدرجة', 'Grading', result.grading));
    }
  }

  return recap;
}

function openSharhModal(result, sharhId, labelKey, searchGeneration) {
  openModal((container, overlay) => {
    container.appendChild(renderModalRecap(result));
    container.appendChild(renderDivider());

    const heading = document.createElement('div');
    heading.className = 'modal-section-heading';
    heading.textContent = actionButtonText(labelKey);
    container.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'sharh-modal-body';
    body.textContent = 'Loading…';
    container.appendChild(body);

    loadSharh(sharhId, body, overlay, searchGeneration);
  });
}

async function loadSharh(sharhId, body, overlay, searchGeneration) {
  const cachedText = sharhTextCache.get(sharhId);
  if (cachedText) {
    renderSharhBody(body, cachedText, overlay, searchGeneration);
    return;
  }

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.FETCH_SHARH,
      sharhId,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }
    sharhTextCache.set(sharhId, response.text);
    renderSharhBody(body, response.text, overlay, searchGeneration);
  } catch (err) {
    console.error(`Sharh fetch failed for ${sharhId}:`, err); // dev-visible only
    body.textContent = 'Could not load commentary right now.';
    body.classList.add('is-unavailable');
  }
}

function renderSharhBody(body, arabicText, overlay, searchGeneration) {
  body.textContent = ''; // safe: only text-content child elements appended below, never raw HTML
  body.classList.remove('is-unavailable');

  const chunks = chunkLongArabicText(arabicText);
  // PERFORMANCE PATCH (this pass, CHANGE 2): the FIRST chunk stays exactly as
  // before — eager, standalone, translateOneField/TRANSLATE_TEXT — nothing
  // to batch it with at that moment. Every later (lazy) chunk now goes
  // through a dedicated batching-aware observer (below) instead of the
  // shared createLazyObserver: existing chunk boundaries (chunkLongArabicText/
  // MAX_CHUNK_CHARS) are completely unchanged, this only changes how many of
  // those already-chunked pieces ride in one /translate-batch call when they
  // become relevant at the same time (the modal's large rootMargin routinely
  // makes several lazy chunks intersect together the moment the modal opens).
  // A chunk that ends up intersecting alone still goes through the same
  // grouped-batch call path, just as a group of one.
  const sharhLazyObserver = createSharhBatchingLazyObserver(overlay, searchGeneration);
  let sharhLazyKeyCounter = 0;

  chunks.forEach((chunkText, chunkIndex) => {
    const chunkEl = document.createElement('div');
    chunkEl.className = 'sharh-chunk';

    const arabicEl = document.createElement('div');
    arabicEl.className = 'secondary-prose-arabic';
    arabicEl.dir = 'rtl';
    arabicEl.lang = 'ar';
    arabicEl.textContent = chunkText;
    chunkEl.appendChild(arabicEl);

    const { wrap, slotEl } = renderInlineTranslation(STATUS_QUEUED);
    chunkEl.appendChild(wrap);
    body.appendChild(chunkEl);

    if (chunkIndex < EAGER_MODAL_CHUNK_COUNT) {
      translateOneField('sharh', chunkText, slotEl, undefined, undefined, searchGeneration);
    } else {
      const key = `sharh${sharhLazyKeyCounter}`;
      sharhLazyKeyCounter += 1;
      chunkEl.__sharhGroupItem = { key, arabicText: chunkText, slotEl, mode: undefined };
      sharhLazyObserver.observe(chunkEl);
    }
  });
}

/**
 * Like createLazyObserver, but scoped locally to ONE شرح modal (not shared
 * with the main list or أصول, which keep using the original createLazyObserver
 * unchanged) — whenever multiple observed chunks intersect in the SAME
 * IntersectionObserver callback tick, they're grouped into one
 * translateFieldGroup() call instead of firing one independently. Same
 * rootMargin/threshold as createLazyObserver, so scroll-trigger behavior is
 * otherwise identical to before.
 */
function createSharhBatchingLazyObserver(rootEl, searchGeneration) {
  const observer = new IntersectionObserver(
    (entries) => {
      const nowVisible = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const item = entry.target.__sharhGroupItem;
        entry.target.__sharhGroupItem = null;
        if (item) nowVisible.push(item);
      }
      if (nowVisible.length > 0) {
        translateFieldGroup(nowVisible, searchGeneration);
      }
    },
    { root: rootEl || null, rootMargin: '600px 0px', threshold: 0 },
  );
  return observer;
}

/**
 * Splits long Arabic content into paragraph-sized chunks so progressive
 * translation has natural, deterministic boundaries (same text always chunks
 * the same way, which matters for the content-keyed cache to hit reliably on
 * reopen). Paragraph breaks (blank lines, from extractCleanText's block-level
 * handling) are the primary split; a single paragraph that's still very long
 * gets further split near a sentence end or word boundary rather than a hard
 * character cut.
 */
function chunkLongArabicText(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const source = paragraphs.length > 0 ? paragraphs : [text.trim()];

  const chunks = [];
  for (const paragraph of source) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      chunks.push(paragraph);
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > MAX_CHUNK_CHARS) {
      let cut = remaining.lastIndexOf('.', MAX_CHUNK_CHARS);
      if (cut < MAX_CHUNK_CHARS * 0.4) cut = remaining.lastIndexOf(' ', MAX_CHUNK_CHARS);
      if (cut <= 0) cut = MAX_CHUNK_CHARS;
      chunks.push(remaining.slice(0, cut + 1).trim());
      remaining = remaining.slice(cut + 1).trim();
    }
    if (remaining) chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// أصول الحديث modal — same on-open-only fetch + progressive translation
// approach: the first source entry (visible immediately) translates eagerly,
// every later source entry translates lazily as it scrolls into view within
// this modal.
// ---------------------------------------------------------------------------

function openUsulModal(result, url, searchGeneration) {
  openModal((container, overlay) => {
    container.appendChild(renderModalRecap(result));
    container.appendChild(renderDivider());

    const heading = document.createElement('div');
    heading.className = 'modal-section-heading';
    heading.textContent = actionButtonText('usul');
    container.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'usul-modal-body';
    body.textContent = 'Loading…';
    container.appendChild(body);

    loadUsul(url, body, overlay, searchGeneration);
  });
}

async function loadUsul(url, body, overlay, searchGeneration) {
  const cachedSources = usulSourcesCache.get(url);
  if (cachedSources) {
    renderUsulBody(body, cachedSources, overlay, searchGeneration);
    return;
  }

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.FETCH_USUL,
      url,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }
    usulSourcesCache.set(url, response.sources);
    renderUsulBody(body, response.sources, overlay, searchGeneration);
  } catch (err) {
    console.error(`Usul fetch failed for ${url}:`, err); // dev-visible only
    body.textContent = 'Could not load hadith origins right now.';
    body.classList.add('is-unavailable');
  }
}

function renderUsulBody(body, sources, overlay, searchGeneration) {
  body.textContent = '';
  body.classList.remove('is-unavailable');

  if (!sources || sources.length === 0) {
    body.textContent = 'No source details were found on the Dorar page for this action.';
    body.classList.add('is-unavailable');
    return;
  }

  const lazyObserver = createLazyObserver(overlay);
  sources.forEach((source, sourceIndex) => {
    body.appendChild(renderUsulSourceEntry(source, sourceIndex, lazyObserver, searchGeneration));
  });
}

function renderUsulSourceEntry(source, sourceIndex, lazyObserver, searchGeneration) {
  const entry = document.createElement('div');
  entry.className = 'usul-source-entry';

  const heading = document.createElement('div');
  heading.className = 'usul-source-heading';
  heading.textContent = `Source ${sourceIndex + 1}`;
  entry.appendChild(heading);

  // PERFORMANCE PATCH (this pass, CHANGE 2): each field is now collected as a
  // { key, arabicText, slotEl, mode, localLookupFn } descriptor rather than
  // an independently-callable translation task — the whole entry's fields
  // (Source/Chain/Wording) are then translated together in ONE
  // /translate-batch call via translateFieldGroup, either eagerly (entry 0)
  // or lazily as one unit when this entry scrolls into view (entries 1+) —
  // same trigger points as before, just one network request instead of up
  // to three. Cache/local-dictionary behavior for each field is completely
  // unchanged (see translateFieldGroup) — only the Source field is eligible
  // for the Usul/Sharh source dictionary, Chain/Wording always go to Gemini,
  // exactly as before.
  const fieldItems = [];

  if (source.source) {
    entry.appendChild(renderUsulField('Source', source.source, 'name', fieldItems, 'source', lookupUsulSource));
  }
  if (source.chain) {
    entry.appendChild(renderUsulField('Chain (Isnad)', source.chain, undefined, fieldItems, 'chain'));
  }
  if (source.hadithText) {
    entry.appendChild(renderUsulField('Wording', source.hadithText, undefined, fieldItems, 'wording'));
  }

  if (sourceIndex < EAGER_MODAL_CHUNK_COUNT) {
    translateFieldGroup(fieldItems, searchGeneration);
  } else {
    observeForLazyTranslation(lazyObserver, entry, () => translateFieldGroup(fieldItems, searchGeneration));
  }

  return entry;
}

function renderUsulField(label, arabicValue, mode, fieldItems, batchKey, localLookupFn) {
  const row = document.createElement('div');
  row.className = 'field-row field-row-prose';

  const labelLine = document.createElement('div');
  const labelEl = document.createElement('span');
  labelEl.className = 'field-row-label';
  labelEl.textContent = `${label}: `;
  const arabicEl = document.createElement('span');
  arabicEl.className = 'field-row-value';
  arabicEl.dir = 'rtl';
  arabicEl.lang = 'ar';
  arabicEl.textContent = arabicValue;
  labelLine.append(labelEl, arabicEl);
  row.appendChild(labelLine);

  const { wrap, slotEl } = renderInlineTranslation(mode === 'name' ? '…' : STATUS_QUEUED);
  row.appendChild(wrap);

  fieldItems.push({ key: batchKey, arabicText: arabicValue, slotEl, mode, localLookupFn });

  return row;
}

// ---------------------------------------------------------------------------
// Translation orchestration — no local queue or retry anymore (both live in
// the shared background service worker now, see the file-level note). This
// section just: checks the per-tab cache, fires a message if not cached,
// and updates the cache + DOM on response.
//
// LOCAL-FIRST DICTIONARIES (this pass): before falling back to Gemini, the
// three structured NAME_FIELDS (narrator/muhaddith/source — never the
// prose fields above) are checked against src/shared/dictionaries/ for a
// safe exact match. Field-aware and exact-match only, by construction: see
// resolveLocalNameField below and the dictionaries' own file-level notes
// for the live Dorar verification behind them. Everything else about the
// translation pipeline (queue, retry, RPM limiter, session cache, batching)
// is completely unchanged — a local hit just means fieldsToRequest never
// gets that one key, so it's simply never sent to Gemini.
// ---------------------------------------------------------------------------

/**
 * Returns a safe local English translation for one NAME_FIELDS value, or
 * null if there is no safe local match (caller falls back to Gemini).
 * fieldKey is always exactly 'narrator' | 'muhaddith' | 'source' here — the
 * PROSE_FIELDS loop (hadith/grading/takhrij) never calls this function, so
 * these dictionaries can never be applied to prose, by construction.
 */
function resolveLocalNameField(fieldKey, value) {
  if (fieldKey === 'narrator') return resolveNarratorField(value);
  if (fieldKey === 'muhaddith') return lookupScholar(value);
  if (fieldKey === 'source') return lookupSource(value);
  return null;
}

// ---------------------------------------------------------------------------
// V1.0.2 PERFORMANCE PASS — safe in-flight request deduplication.
//
// FINAL SCOPE (per the explicit primary-Hadith-vs-Sharh/Usul clarification):
// dedup applies to metadata (narrator, muhaddith, source, grading, takhrij),
// to شرح (commentary) chunks (batch keys "sharh0", "sharh1", ... AND the
// eager first chunk — see translateOneField), to أصول's own structured
// Source field (batch key 'source', mode 'name' — the exact same
// bibliographic-metadata nature as the main list's Source field, already
// reuses lookupUsulSource), and to أصول's Wording field ('wording').
//
// NEVER dedup-eligible, by explicit, deliberate exclusion:
//   - 'hadith' — the PRIMARY main-result Hadith text. This is the one field
//     that must NEVER be in-flight-deduplicated, cross-result-deduplicated,
//     or reused via anything other than an exact cache hit (session or
//     15-day persistent) — see translateAllFieldsForCard, which never even
//     calls attemptDedupFollow for this field.
//   - 'chain' — أصول's Isnad/chain-of-narration field. Explicitly held to
//     the SAME no-dedup policy as the primary Hadith field (still fully
//     eligible for ordinary exact session/persistent CACHE reuse, just never
//     in-flight-deduplicated against a concurrently-requested duplicate).
// 'wording' (أصول's own Wording field) and شرح content are, by contrast,
// EXPLICITLY approved for exact-text in-flight dedup — this is a narrower,
// deliberate distinction from an earlier draft of this feature (which had
// excluded wording/sharh too); this is the current, authoritative scope.
//
// Mechanism: if a caller is about to request a translation for a dedup-
// eligible (mode, text) pair, and another request for the EXACT SAME pair
// is already pending (owned by an earlier, still-in-flight caller within
// this SAME tab/session), the caller becomes a "follower" — it creates NO
// second network request at all, just awaits the owner's outcome and
// applies it to its own slot once the owner settles. Exact string matching
// only (via buildTranslationCacheKey, the SAME key scheme as both caches
// use) — no fuzzy/similarity/semantic matching of any kind, anywhere.
const pendingDedupRequests = new Map(); // dedup key -> { promise, resolve, reject }
const DEDUP_ELIGIBLE_KEYS = new Set(['narrator', 'muhaddith', 'source', 'grading', 'takhrij', 'wording']);

/** 'chain' and 'hadith' are intentionally NEVER eligible — see this
 * section's file-level comment. شرح's chunk keys are dynamic ("sharh0",
 * "sharh1", ... — one per chunk index, always distinct per chunk) so a
 * prefix check is used instead of enumerating them in the Set above. */
function isDedupEligible(fieldKey) {
  if (DEDUP_ELIGIBLE_KEYS.has(fieldKey)) return true;
  return typeof fieldKey === 'string' && fieldKey.startsWith('sharh');
}

/**
 * For a dedup-eligible field: if an identical (mode, value) request is
 * already pending, registers `slotEl` to receive that owner's eventual
 * result and returns true — the caller must NOT create its own request for
 * this field. Otherwise (not eligible, or no existing request) claims
 * ownership as a side effect (a no-op for non-eligible fields) and returns
 * false — the caller proceeds normally and becomes responsible for calling
 * settleDedupRequest once it knows the outcome, from ANY resolution path
 * (persistent-cache hit, Gemini success, or Gemini failure).
 */
function attemptDedupFollow(fieldKey, mode, value, slotEl, searchGeneration) {
  if (!isDedupEligible(fieldKey)) return false;

  const key = buildTranslationCacheKey(mode, value);
  const existing = pendingDedupRequests.get(key);
  if (existing) {
    // Follower: a real request for this exact text IS already in flight
    // somewhere else on this page.
    setTranslationContent(slotEl, STATUS_TRANSLATING, 'loading');
    existing.promise.then(
      (translation) => {
        if (isResponseStale(searchGeneration)) return;
        setTranslationContent(slotEl, translation, 'done');
      },
      () => {
        if (isResponseStale(searchGeneration)) return;
        markUnavailable(slotEl, mode);
      },
    );
    return true;
  }

  // No one owns this key yet — claim it. The eventual owner (whichever
  // function actually resolves this field) calls settleDedupRequest.
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  promise.catch(() => {}); // avoid an unhandled-rejection warning if no follower ever attaches
  pendingDedupRequests.set(key, { promise, resolve: resolveFn, reject: rejectFn });
  return false;
}

/**
 * Settles (and removes) the pending dedup slot for (mode, value), if this
 * field is dedup-eligible and a slot is actually owned here — a safe no-op
 * otherwise. Called UNCONDITIONALLY on every resolution path (persistent-
 * cache hit, Gemini success, Gemini failure) and regardless of whether the
 * response is "stale" (see the generation note) — the underlying translated
 * text is valid, reusable content independent of which search generation
 * originally asked for it; only DOM writes are ever gated on staleness.
 */
function settleDedupRequest(fieldKey, mode, value, outcome, isError) {
  if (!isDedupEligible(fieldKey)) return;
  const key = buildTranslationCacheKey(mode, value);
  const entry = pendingDedupRequests.get(key);
  if (!entry) return;
  pendingDedupRequests.delete(key);
  if (isError) entry.reject(outcome);
  else entry.resolve(outcome);
}

/**
 * Translates one result's fields, in up to three passes:
 *   PASS 1 (sync):  session cache -> local dictionary -> dedup claim/follow.
 *                   Must stay fully synchronous so concurrently-rendered
 *                   cards (the auto-translate burst, or several lazy cards
 *                   intersecting together) see a race-free, consistent view
 *                   of "who owns this request" — see attemptDedupFollow.
 *   PASS 2 (async): 15-day persistent-cache lookup for whatever PASS 1
 *                   didn't resolve and this card actually OWNS (never for a
 *                   dedup follower, which is already being handled above).
 *   PASS 3:         whatever PASS 2 didn't resolve goes to Gemini in ONE
 *                   batch call, exactly as before this pass.
 */
async function translateAllFieldsForCard(result, slots, searchGeneration) {
  const fieldsToRequest = {};
  const slotInfoByKey = {};
  const persistentCandidates = []; // { key, mode, value, slotEl }

  for (const field of PROSE_FIELDS) {
    const value = result[field.resultProp];
    const slotEl = slots[field.key];
    if (!value || !slotEl) continue; // absent Dorar field — nothing to translate, nothing to fake

    const cached = getCachedTranslation(undefined, value);
    if (cached) {
      setTranslationContent(slotEl, withLocalDebugMarker(cached, undefined, value), 'done');
      continue;
    }

    // Local-first, GRADING ONLY: a safe exact match against a short list of
    // standard classical grading verdicts bypasses Gemini. field.key check
    // keeps this scoped exactly to 'grading' — hadith and takhrij share this
    // loop but never reach this branch, so they can never be looked up here.
    if (field.key === 'grading') {
      const localGrading = lookupGrading(value);
      if (localGrading) {
        setCachedTranslation(undefined, value, localGrading);
        markLocallyResolved(undefined, value);
        setTranslationContent(slotEl, withLocalDebugMarker(localGrading, undefined, value), 'done');
        continue;
      }
    }

    // Local-first, TAKHRIJ ONLY: a safe exact-construction match against a
    // small set of common attribution formulae (أخرجه/رواه + a single known
    // compiler, or a handful of fixed phrases like متفق عليه) bypasses
    // Gemini. field.key check keeps this scoped exactly to 'takhrij' —
    // hadith and grading share this loop but never reach this branch. See
    // dictionaries/takhrij.js and lookupTakhrij for the exact-construction
    // matching rules — never a substring/word replacement inside a longer
    // or multi-scholar Takhrij sentence, which still falls to Gemini whole.
    if (field.key === 'takhrij') {
      const localTakhrij = lookupTakhrij(value);
      if (localTakhrij) {
        setCachedTranslation(undefined, value, localTakhrij);
        markLocallyResolved(undefined, value);
        setTranslationContent(slotEl, withLocalDebugMarker(localTakhrij, undefined, value), 'done');
        continue;
      }
    }

    // NOTE: hadith (field.key === 'hadith') is never dedup-eligible — see
    // DEDUP_ELIGIBLE_KEYS above; attemptDedupFollow is a guaranteed no-op
    // (always returns false) for it, exactly preserving prior behavior.
    if (!attemptDedupFollow(field.key, undefined, value, slotEl, searchGeneration)) {
      persistentCandidates.push({ key: field.key, mode: undefined, value, slotEl });
    }
  }

  for (const field of NAME_FIELDS) {
    const value = result[field.resultProp];
    const slotEl = slots[field.key];
    if (!value || !slotEl) continue;

    const cached = getCachedTranslation('name', value);
    if (cached) {
      setTranslationContent(slotEl, withLocalDebugMarker(cached, 'name', value), 'done');
      continue;
    }

    // Local-first: a safe exact match in the narrator/scholar/source
    // dictionary bypasses Gemini entirely. Field-aware by construction —
    // field.key here is only ever 'narrator'/'muhaddith'/'source' (this is
    // the NAME_FIELDS loop; hadith/grading/takhrij live in the separate
    // PROSE_FIELDS loop above and are never touched by these dictionaries).
    const localMatch = resolveLocalNameField(field.key, value);
    if (localMatch) {
      setCachedTranslation('name', value, localMatch);
      markLocallyResolved('name', value);
      setTranslationContent(slotEl, withLocalDebugMarker(localMatch, 'name', value), 'done');
      continue;
    }

    if (!attemptDedupFollow(field.key, 'name', value, slotEl, searchGeneration)) {
      persistentCandidates.push({ key: field.key, mode: 'name', value, slotEl });
    }
  }

  if (persistentCandidates.length === 0) return; // everything resolved locally/from cache, or handed off to a dedup owner

  // PASS 2 (async): 15-day persistent-cache lookup, only for fields this
  // card actually owns. Never blocks rendering — the card is already on
  // screen; this only delays dispatch of whatever's still genuinely unknown
  // by a few targeted, parallel storage reads.
  await Promise.all(
    persistentCandidates.map(async (c) => {
      c.persistentHit = await getPersistentTranslation(c.mode, c.value);
    }),
  );

  for (const c of persistentCandidates) {
    if (c.persistentHit) {
      setCachedTranslation(c.mode, c.value, c.persistentHit);
      setTranslationContent(c.slotEl, c.persistentHit, 'done');
      settleDedupRequest(c.key, c.mode, c.value, c.persistentHit, false);
      continue;
    }
    fieldsToRequest[c.key] = c.value;
    slotInfoByKey[c.key] = { slotEl: c.slotEl, mode: c.mode, value: c.value };
  }

  const keysToRequest = Object.keys(fieldsToRequest);
  if (keysToRequest.length === 0) return; // fully resolved by the persistent cache

  for (const key of keysToRequest) {
    const { slotEl, mode } = slotInfoByKey[key];
    setTranslationContent(slotEl, mode === 'name' ? '…' : STATUS_QUEUED, 'loading');
  }

  runBatchTranslation(fieldsToRequest, slotInfoByKey, searchGeneration);
}

/**
 * V1.0.2 PERFORMANCE PASS: cache writes (session + 15-day persistent) and
 * dedup settlement now happen UNCONDITIONALLY — a good, faithful
 * translation is valid, reusable content regardless of which search
 * generation originally asked for it, and a dedup follower's promise must
 * be settled even if the owning card's search has since gone stale
 * (otherwise it would hang forever — see attemptDedupFollow). Only the DOM
 * write (setTranslationContent) is still gated on isResponseStale, exactly
 * as before — a stale response still can never modify the new search's
 * page.
 */
async function runBatchTranslation(fieldsToRequest, slotInfoByKey, searchGeneration) {
  const requestId = nextRequestId++;
  registerPendingDispatch(
    requestId,
    Object.keys(fieldsToRequest).map((key) => slotInfoByKey[key].slotEl),
  );

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      fields: fieldsToRequest,
      generation: searchGeneration,
      requestId,
    });
    clearPendingDispatch(requestId);

    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }

    const translatedFields = response.fields || {};
    for (const key of Object.keys(fieldsToRequest)) {
      const { slotEl, mode, value } = slotInfoByKey[key];
      const translation = translatedFields[key];
      if (typeof translation === 'string' && translation.trim()) {
        const trimmed = translation.trim();
        setCachedTranslation(mode, value, trimmed);
        setPersistentTranslation(mode, value, trimmed); // fire-and-forget — never awaited on the UI path
        settleDedupRequest(key, mode, value, trimmed, false);
        if (!isResponseStale(searchGeneration)) {
          setTranslationContent(slotEl, trimmed, 'done');
        }
      } else {
        // The model omitted this one key — treat it individually as
        // unavailable rather than failing the whole card.
        settleDedupRequest(key, mode, value, new Error('Model omitted this field.'), true);
        if (!isResponseStale(searchGeneration)) {
          markUnavailable(slotEl, mode);
        }
      }
    }
  } catch (err) {
    clearPendingDispatch(requestId);
    for (const key of Object.keys(fieldsToRequest)) {
      const { mode, value } = slotInfoByKey[key];
      settleDedupRequest(key, mode, value, err, true);
    }
    if (isResponseStale(searchGeneration)) return; // stale failure — never touch a newer search's DOM either
    // The background already retried transiently-failing requests before
    // giving up (see background/index.js's withRetry) — reaching here means
    // it genuinely could not get a translation, not a single hiccup.
    console.error('Batch translation failed:', err); // dev-visible only
    for (const key of Object.keys(fieldsToRequest)) {
      const { slotEl, mode } = slotInfoByKey[key];
      markUnavailable(slotEl, mode);
    }
  }
}

// ---------------------------------------------------------------------------
// PERFORMANCE PATCH (this pass, CHANGE 2) — generalized batching for شرح and
// أصول الحديث, reusing the EXACT SAME /translate-batch endpoint, request
// shape, and cache/local-dictionary-first pattern as translateAllFieldsForCard
// above (which is left completely untouched — this is an ADDITIONAL helper,
// not a refactor of the main-list path). Call sites (renderUsulSourceEntry
// and renderSharhBody's lazy chunk path, below) build an array of
// { key, arabicText, slotEl, mode, localLookupFn } items that became
// relevant together (one أصول source entry's fields, or several شرح chunks
// that scrolled into view in the same tick) and pass the whole group here in
// one call. Cache hits and local-dictionary hits still render instantly and
// never reach the network, exactly like the main list. Whatever remains is
// sent in as few /translate-batch calls as possible (split only if it would
// exceed the Worker's BATCH_MAX_FIELDS cap — see worker/src/index.js).
// ---------------------------------------------------------------------------

const FIELD_GROUP_BATCH_MAX_FIELDS = 8; // mirrors worker/src/index.js's BATCH_MAX_FIELDS

/**
 * V1.0.2 PERFORMANCE PASS: same three-pass structure as
 * translateAllFieldsForCard above (sync cache/local/dedup pass, then an
 * async 15-day persistent-cache pass for whatever this call owns, then
 * whatever's left goes to Gemini). Dedup eligibility is decided per-item via
 * isDedupEligible(item.key) — this correctly includes أصول's own 'source'
 * and 'wording' fields and شرح's "sharh0"/"sharh1"/... keys, while excluding
 * أصول's 'chain' field (held to the same no-dedup policy as the primary
 * Hadith field — see DEDUP_ELIGIBLE_KEYS's file-level comment).
 */
async function translateFieldGroup(items, searchGeneration) {
  const toRequest = {};
  const infoByKey = {};
  const persistentCandidates = []; // { key, mode, arabicText, slotEl }

  for (const item of items) {
    const { key, arabicText, slotEl, mode, localLookupFn } = item;

    const cached = getCachedTranslation(mode, arabicText);
    if (cached) {
      setTranslationContent(slotEl, withLocalDebugMarker(cached, mode, arabicText), 'done');
      continue;
    }

    if (localLookupFn) {
      const localMatch = localLookupFn(arabicText);
      if (localMatch) {
        setCachedTranslation(mode, arabicText, localMatch);
        markLocallyResolved(mode, arabicText);
        setTranslationContent(slotEl, withLocalDebugMarker(localMatch, mode, arabicText), 'done');
        continue;
      }
    }

    if (!attemptDedupFollow(key, mode, arabicText, slotEl, searchGeneration)) {
      persistentCandidates.push({ key, mode, arabicText, slotEl });
    }
  }

  if (persistentCandidates.length === 0) return; // everything cached/local/handed to a dedup owner

  await Promise.all(
    persistentCandidates.map(async (c) => {
      c.persistentHit = await getPersistentTranslation(c.mode, c.arabicText);
    }),
  );

  for (const c of persistentCandidates) {
    if (c.persistentHit) {
      setCachedTranslation(c.mode, c.arabicText, c.persistentHit);
      setTranslationContent(c.slotEl, c.persistentHit, 'done');
      settleDedupRequest(c.key, c.mode, c.arabicText, c.persistentHit, false);
      continue;
    }
    toRequest[c.key] = c.arabicText;
    infoByKey[c.key] = { slotEl: c.slotEl, mode: c.mode, arabicText: c.arabicText };
  }

  const keys = Object.keys(toRequest);
  if (keys.length === 0) return; // fully resolved by the persistent cache

  for (const key of keys) {
    const { slotEl, mode } = infoByKey[key];
    setTranslationContent(slotEl, mode === 'name' ? '…' : STATUS_QUEUED, 'loading');
  }

  // Defensive split: keeps every single /translate-batch call within the
  // Worker's own BATCH_MAX_FIELDS cap, even in the (rare) case that more
  // than 8 شرح chunks intersect together in one observer tick.
  const batches = [];
  for (let i = 0; i < keys.length; i += FIELD_GROUP_BATCH_MAX_FIELDS) {
    batches.push(keys.slice(i, i + FIELD_GROUP_BATCH_MAX_FIELDS));
  }

  await Promise.all(
    batches.map((batchKeys) => runFieldGroupBatch(batchKeys, toRequest, infoByKey, searchGeneration)),
  );
}

/** See runBatchTranslation's identical comment: cache writes + dedup
 * settlement happen unconditionally; only the DOM write is staleness-gated. */
async function runFieldGroupBatch(batchKeys, toRequest, infoByKey, searchGeneration) {
  const fieldsToRequest = {};
  for (const key of batchKeys) {
    fieldsToRequest[key] = toRequest[key];
  }

  const requestId = nextRequestId++;
  registerPendingDispatch(
    requestId,
    batchKeys.map((key) => infoByKey[key].slotEl),
  );

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      fields: fieldsToRequest,
      generation: searchGeneration,
      requestId,
    });
    clearPendingDispatch(requestId);

    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }

    const translatedFields = response.fields || {};
    for (const key of batchKeys) {
      const { slotEl, mode, arabicText } = infoByKey[key];
      const translation = translatedFields[key];
      if (typeof translation === 'string' && translation.trim()) {
        const trimmed = translation.trim();
        setCachedTranslation(mode, arabicText, trimmed);
        setPersistentTranslation(mode, arabicText, trimmed);
        settleDedupRequest(key, mode, arabicText, trimmed, false);
        if (!isResponseStale(searchGeneration)) {
          setTranslationContent(slotEl, trimmed, 'done');
        }
      } else {
        settleDedupRequest(key, mode, arabicText, new Error('Model omitted this field.'), true);
        if (!isResponseStale(searchGeneration)) {
          markUnavailable(slotEl, mode);
        }
      }
    }
  } catch (err) {
    clearPendingDispatch(requestId);
    for (const key of batchKeys) {
      const { mode, arabicText } = infoByKey[key];
      settleDedupRequest(key, mode, arabicText, err, true);
    }
    if (isResponseStale(searchGeneration)) return;
    console.error('Grouped batch translation failed:', err); // dev-visible only
    for (const key of batchKeys) {
      const { slotEl, mode } = infoByKey[key];
      markUnavailable(slotEl, mode);
    }
  }
}

/**
 * Used by شرح / أصول content, which is fetched on demand rather than known
 * up front — one field/chunk at a time, still content-cached. NOTE: in
 * practice this is only ever called for شرح's eager first chunk (see
 * renderSharhBody). That content IS dedup-eligible (see the "sharh" prefix
 * rule in isDedupEligible) — this uses a fixed label, 'sharh-eager', purely
 * to gate eligibility (it is never part of the actual dedup key itself,
 * which is built from the real mode+text — see attemptDedupFollow/
 * settleDedupRequest). This function is never used for the primary Hadith
 * field or أصول's Chain field — both stay excluded via DEDUP_ELIGIBLE_KEYS.
 */
async function translateOneField(debugLabel, arabicText, slotEl, mode, localLookupFn, searchGeneration) {
  const dedupFieldKey = 'sharh-eager';

  const cached = getCachedTranslation(mode, arabicText);
  if (cached) {
    setTranslationContent(slotEl, withLocalDebugMarker(cached, mode, arabicText), 'done');
    return;
  }

  // Optional local-first lookup — used ONLY by the أصول الحديث modal's
  // structured Source field (see renderUsulSourceEntry), which passes
  // lookupUsulSource here explicitly. Every other caller (شرح chunks,
  // أصول's own Chain/Wording fields) omits this argument entirely, so this
  // block is a complete no-op for them — unchanged behavior, unchanged
  // Gemini path below.
  if (localLookupFn) {
    const localMatch = localLookupFn(arabicText);
    if (localMatch) {
      setCachedTranslation(mode, arabicText, localMatch);
      markLocallyResolved(mode, arabicText);
      setTranslationContent(slotEl, withLocalDebugMarker(localMatch, mode, arabicText), 'done');
      return;
    }
  }

  if (attemptDedupFollow(dedupFieldKey, mode, arabicText, slotEl, searchGeneration)) {
    return; // a real request for this exact شرح text is already in flight elsewhere on the page
  }

  // 15-day persistent cache — checked before ever creating a Gemini task.
  const persistentHit = await getPersistentTranslation(mode, arabicText);
  if (persistentHit) {
    setCachedTranslation(mode, arabicText, persistentHit);
    setTranslationContent(slotEl, persistentHit, 'done');
    settleDedupRequest(dedupFieldKey, mode, arabicText, persistentHit, false);
    return;
  }

  setTranslationContent(slotEl, mode === 'name' ? '…' : STATUS_QUEUED, 'loading');

  const requestId = nextRequestId++;
  registerPendingDispatch(requestId, [slotEl]);

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.TRANSLATE_TEXT,
      text: arabicText,
      mode,
      generation: searchGeneration,
      requestId,
    });
    clearPendingDispatch(requestId);

    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }
    setCachedTranslation(mode, arabicText, response.translation);
    setPersistentTranslation(mode, arabicText, response.translation); // fire-and-forget
    settleDedupRequest(dedupFieldKey, mode, arabicText, response.translation, false);
    if (!isResponseStale(searchGeneration)) {
      setTranslationContent(slotEl, response.translation, 'done');
    }
  } catch (err) {
    clearPendingDispatch(requestId);
    settleDedupRequest(dedupFieldKey, mode, arabicText, err, true);
    if (isResponseStale(searchGeneration)) return;
    console.error(`Translation failed (${debugLabel}):`, err); // dev-visible only
    markUnavailable(slotEl, mode);
  }
}

function markUnavailable(slotEl, mode) {
  const text = mode === 'name' ? '(English representation unavailable)' : 'English translation temporarily unavailable.';
  setTranslationContent(slotEl, text, 'unavailable');
}

function setTranslationContent(el, text, state) {
  el.textContent = text;
  el.classList.remove('is-loading', 'is-unavailable', 'is-done');
  el.classList.add(`is-${state}`);
}
