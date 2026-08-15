// MV3 background service worker — entry point.
//
// Responsibilities:
//   1. Receive a search request from a UI surface (side panel or full results page).
//   2. Fetch Dorar search pages (dorarClient.js), walking pagination per tab as needed.
//   3. Hand HTML to the offscreen document for parsing (offscreenManager.js).
//   4. Select ONE category as the displayed result set — specialist if it has
//      any results, general only as a fallback when specialist is empty.
//      NEVER concatenated (resultSelector.js — locked contract, see that
//      file's comment for why this supersedes an earlier "combine both"
//      instruction). The non-selected category is still returned, just not
//      merged into the displayed list.
//   5. Return the selected category's full result array (or a clear error).
//   6. Relay translation / search-query requests to our Cloudflare Worker (aiClient.js).
//   7. Fetch+parse individual شرح (commentary) / أصول الحديث content on demand.
//
// Deliberately stateless: no session cache lives here — see the architecture
// doc's §R. MV3 service workers are unloaded by Chrome after brief idle
// periods; anything meant to survive the user's session belongs in the UI
// surface's own memory (src/results/app.js), not here.
//
// MULTI-TAB CORRECTION (this pass): the translation concurrency queue +
// bounded retry used to live per-tab, inside results/app.js. That meant N
// simultaneously open result tabs each ran their OWN independent queue, all
// unknowingly bursting against the SAME shared Gemini free-tier quota —
// diagnosed as the root cause of a real symptom (tab 1 of 3 simultaneous
// tabs translated fine, tabs 2 and 3 showed "unavailable"). The background
// service worker is the one thing genuinely shared by every tab of this
// extension, so the queue + retry now live here instead, giving all tabs one
// real global concurrency cap. The translation CACHE stays in app.js
// (per-tab) — each tab's already-completed translations must stay its own,
// only the outbound request throttling is shared.
import { MESSAGE_TARGETS, MESSAGE_TYPES } from '../shared/constants.js';
import { buildSearchUrl, buildExplainUrl, fetchDorarHtml } from './dorarClient.js';
import {
  ensureOffscreenDocument,
  parseSearchHtmlInOffscreen,
  parsePlainTextInOffscreen,
  parseUsulHtmlInOffscreen,
} from './offscreenManager.js';
import { selectResultCategory } from './resultSelector.js';
import { translateText, translateFieldsBatch, generateArabicSearchQuery } from './aiClient.js';

// Dorar's own site page size (confirmed live during the pagination
// investigation) and the practical ~300-result/10-page ceiling Dorar itself
// enforces regardless of the reported total — walking further than that would
// just repeatedly hit empty pages.
const DORAR_PAGE_SIZE = 30;
const DORAR_MAX_PAGES = 10;

// ---------------------------------------------------------------------------
// Global translation queue — shared across every tab of this extension (see
// the file-level note above).
//
// RATE-LIMIT CORRECTION (this pass): a concurrency cap + a minimum gap
// between DISPATCHES bounds how many requests are in flight at once, but
// does NOT bound the total request RATE — with concurrency 3 and a 900ms gap,
// sustained demand could still dispatch a new request roughly every 900ms
// indefinitely, i.e. ~66/minute, far past Gemini's real free-tier ceiling.
// The user checked the live Google AI Studio dashboard for this project and
// confirmed the actual limit: 15 requests/minute, and that prior testing had
// already produced ~1,200 real HTTP 429s from bursts exceeding it. Fixed
// with a genuine sliding-window RPM limiter: at most RPM_LIMIT dispatches
// (a safety margin BELOW the real 15/min ceiling) are allowed in any
// trailing 60-second window, full stop — concurrency is now just a secondary
// cap on how many of those can be in flight simultaneously. Retries are NOT
// exempt from this budget: withRetry() re-enqueues each retry attempt as its
// own gated dispatch (see below), so a burst of retries can never itself
// become a retry storm that blows past the RPM ceiling.
// ---------------------------------------------------------------------------
const TRANSLATION_QUEUE_CONCURRENCY = 3;
const TRANSLATION_RPM_LIMIT = 12; // safety margin under Gemini's real 15 RPM free-tier ceiling
const TRANSLATION_MAX_RETRIES = 2;
const TRANSLATION_RETRY_BASE_DELAY_MS = 1500;

let translationQueueActive = 0;
const translationQueuePending = [];
const translationDispatchTimestamps = []; // ms epoch times of dispatches within the trailing 60s window
let rpmRecheckScheduled = false;

/** Enqueues ONE actual outbound call (one real HTTP attempt to the Worker). */
function enqueueTranslationTask(taskFn) {
  return new Promise((resolve, reject) => {
    translationQueuePending.push({ taskFn, resolve, reject });
    pumpTranslationQueue();
  });
}

function pruneDispatchWindow() {
  const cutoff = Date.now() - 60_000;
  while (translationDispatchTimestamps.length && translationDispatchTimestamps[0] < cutoff) {
    translationDispatchTimestamps.shift();
  }
}

function pumpTranslationQueue() {
  if (translationQueuePending.length === 0) return;
  if (translationQueueActive >= TRANSLATION_QUEUE_CONCURRENCY) return; // re-pumped when a slot frees

  pruneDispatchWindow();
  if (translationDispatchTimestamps.length >= TRANSLATION_RPM_LIMIT) {
    // At the RPM ceiling — wait until the oldest counted dispatch ages out of
    // the 60s window, then re-check (rather than firing on a fixed timer).
    if (!rpmRecheckScheduled) {
      rpmRecheckScheduled = true;
      const waitMs = Math.max(25, translationDispatchTimestamps[0] + 60_000 - Date.now());
      setTimeout(() => {
        rpmRecheckScheduled = false;
        pumpTranslationQueue();
      }, waitMs);
    }
    return;
  }

  const next = translationQueuePending.shift();
  if (!next) return;

  translationDispatchTimestamps.push(Date.now());
  translationQueueActive += 1;
  next
    .taskFn()
    // Propagate the task's real outcome (value or error) to the original
    // caller — a background message handler (or withRetry, below) awaits
    // this to know whether the attempt actually succeeded.
    .then(next.resolve, next.reject)
    .finally(() => {
      translationQueueActive -= 1;
      pumpTranslationQueue();
    });

  pumpTranslationQueue(); // fill any remaining concurrency/RPM budget too
}

/**
 * Runs makeCallFn, retrying up to TRANSLATION_MAX_RETRIES times (linear
 * backoff) before giving up — distinguishes "this one request had a hiccup"
 * (transient network blip, 429, 5xx) from "this content is genuinely
 * unavailable." Each attempt — the first try AND every retry — is its own
 * call to enqueueTranslationTask, so retries draw from the exact same
 * concurrency+RPM budget as first attempts; a retry can never bypass the
 * rate limiter or cause a burst.
 */
async function withRetry(makeCallFn) {
  let lastError;
  for (let attempt = 0; attempt <= TRANSLATION_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(TRANSLATION_RETRY_BASE_DELAY_MS * attempt);
    }
    try {
      return await enqueueTranslationTask(makeCallFn);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// "Check in Hadith Checker" — right-click a text selection on ANY page to
// open it as a new Hadith Checker search, in a new tab, without leaving the
// page being read. Reuses the EXACT SAME existing entry point the side panel
// launcher already uses (results/index.html?q=..., via chrome.tabs.create —
// see src/sidepanel/app.js) for short selections. For selections long enough
// that a raw URL parameter would be fragile, the text is handed off through
// chrome.storage.session instead (a short-lived, per-invocation key in the
// URL rather than the text itself) — this project's existing extension
// storage mechanism, not a new bespoke channel. Either way, the selected
// text is passed through completely unmodified — no rewriting, no
// normalization — and the results page's OWN existing search pipeline
// (runSearch(), which unconditionally starts a fresh translation session on
// every call) decides how to handle it, exactly like a manually-typed query.
// ---------------------------------------------------------------------------
const CONTEXT_MENU_ID = 'check-in-hadith-checker';
// Any selection longer than this uses chrome.storage.session instead of a
// raw URL query param — comfortably under real URL-length limits, but this
// keeps ordinary URLs short and avoids ever relying on how large a URL
// happens to be tolerated for a hadith-length (or accidentally
// paragraphs-long) selection.
const CONTEXT_MENU_URL_INLINE_LIMIT = 1500;

// Clicking the toolbar action opens the side panel directly (no popup involved).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Non-fatal: worst case the user opens the side panel via Chrome's own UI.
  });

  // Recreate on every install/update — chrome.contextMenus.create() errors
  // if an item with this id already exists (e.g. the service worker
  // restarting without a real reinstall), which is harmless here, so it's
  // swallowed via the callback's chrome.runtime.lastError check rather than
  // left as an unhandled promise rejection.
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: 'Check in Hadith Checker',
      contexts: ['selection'],
    },
    () => {
      void chrome.runtime.lastError; // expected on duplicate id; nothing to do either way
    },
  );
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  const selectedText = (info.selectionText || '').trim();
  if (!selectedText) return; // Chrome only shows this item when there IS a selection, but guard anyway

  openHadithCheckerWithQuery(selectedText).catch((err) => {
    // Do not log the selected text itself — only that opening failed.
    console.error('Check in Hadith Checker: failed to open results tab:', describeError(err));
  });
});

async function openHadithCheckerWithQuery(queryText) {
  if (queryText.length <= CONTEXT_MENU_URL_INLINE_LIMIT) {
    const url = `${chrome.runtime.getURL('src/results/index.html')}?q=${encodeURIComponent(queryText)}`;
    await chrome.tabs.create({ url });
    return;
  }

  // Longer selection: hand it off via a short-lived, single-use session-
  // storage entry keyed by a random id unique to THIS invocation, so two
  // simultaneous "Check in Hadith Checker" clicks (different pages, or the
  // same text twice) never collide or overwrite one another — each opens
  // its own independent tab reading its own independent key. The results
  // page reads and immediately deletes the entry on load (see app.js).
  const key = `ctxq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.session.set({ [key]: queryText });
  const url = `${chrome.runtime.getURL('src/results/index.html')}?ctxKey=${encodeURIComponent(key)}`;
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== MESSAGE_TARGETS.BACKGROUND) {
    return undefined; // not addressed to us — let other listeners handle it
  }

  if (message.type === MESSAGE_TYPES.SEARCH_DORAR) {
    handleSearch(message.query)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // keep the message channel open for the async sendResponse above
  }

  if (message.type === MESSAGE_TYPES.TRANSLATE_TEXT) {
    withRetry(() => translateText(message.text, message.mode))
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.TRANSLATE_BATCH) {
    withRetry(() => translateFieldsBatch(message.fields))
      .then((fields) => sendResponse({ ok: true, fields }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GENERATE_SEARCH_QUERY) {
    generateArabicSearchQuery(message.text)
      .then((arabicQuery) => sendResponse({ ok: true, arabicQuery }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.FETCH_SHARH) {
    handleFetchSharh(message.sharhId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.FETCH_USUL) {
    handleFetchUsul(message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  return undefined;
});

async function handleSearch(rawQuery) {
  const query = (rawQuery || '').trim();
  if (!query) {
    return { ok: false, error: 'Please enter a search query.' };
  }

  await ensureOffscreenDocument();

  // Page 1 (no &all) returns BOTH tabs' first page in a single request —
  // confirmed live during the pagination investigation.
  let page1Parsed;
  try {
    const page1Html = await fetchDorarHtml(buildSearchUrl(query, { page: 1 }));
    page1Parsed = await parseSearchHtmlInOffscreen(page1Html);
    if (page1Parsed && page1Parsed.error) {
      throw new Error(page1Parsed.error);
    }
  } catch (err) {
    return { ok: false, error: `Dorar request failed: ${describeError(err)}` };
  }

  let specialistResults;
  let generalResults;
  try {
    specialistResults = await collectAllPages(query, 'specialist', page1Parsed.specialist);
    generalResults = await collectAllPages(query, 'general', page1Parsed.general);
  } catch (err) {
    return { ok: false, error: `Failed to parse Dorar response: ${describeError(err)}` };
  }

  const selection = selectResultCategory({
    specialist: { count: page1Parsed.specialist.count, results: specialistResults },
    general: { count: page1Parsed.general.count, results: generalResults },
  });

  if (selection.results.length === 0) {
    return {
      ok: false,
      error: 'No results found in either the specialist or general result sets.',
      ...selection,
    };
  }

  return { ok: true, ...selection };
}

/**
 * Walks additional pages of ONE tab beyond page 1, using the &all mechanism
 * confirmed live during the pagination investigation (&all present -> `page`
 * controls the specialist tab; absent -> general). Only fetches more pages
 * when the page(s) retrieved so far came back completely full (30/30, 60/60,
 * ...) — a partial page is Dorar's own signal that we've reached the end.
 * Stops at DORAR_MAX_PAGES regardless, matching the ~300-result ceiling
 * already confirmed live (querying past it just returns empty pages).
 */
async function collectAllPages(query, tabName, page1TabParsed) {
  let results = [...(page1TabParsed.results || [])];
  let page = 1;

  while (results.length === page * DORAR_PAGE_SIZE && page < DORAR_MAX_PAGES) {
    page += 1;
    const url = buildSearchUrl(query, { page, all: tabName === 'specialist' });

    let html;
    try {
      html = await fetchDorarHtml(url);
    } catch {
      break; // a later page failing shouldn't fail the whole search — keep what we have
    }

    let parsed;
    try {
      parsed = await parseSearchHtmlInOffscreen(html);
    } catch {
      break;
    }
    if (!parsed || parsed.error) break;

    const tabParsed = tabName === 'specialist' ? parsed.specialist : parsed.general;
    const pageResults = tabParsed.results || [];
    if (pageResults.length === 0) break;

    results = results.concat(pageResults);
  }

  return results;
}

async function handleFetchSharh(sharhId) {
  if (!sharhId) {
    return { ok: false, error: 'Missing sharh id.' };
  }

  let html;
  try {
    html = await fetchDorarHtml(buildExplainUrl(sharhId));
  } catch (err) {
    return { ok: false, error: `Dorar request failed: ${describeError(err)}` };
  }

  try {
    await ensureOffscreenDocument();
    const parsed = await parsePlainTextInOffscreen(html);
    if (!parsed || parsed.error) {
      throw new Error((parsed && parsed.error) || 'Empty response.');
    }
    return { ok: true, text: parsed.text };
  } catch (err) {
    return { ok: false, error: `Failed to parse Dorar response: ${describeError(err)}` };
  }
}

async function handleFetchUsul(url) {
  if (!url) {
    return { ok: false, error: 'Missing أصول الحديث URL.' };
  }

  let html;
  try {
    html = await fetchDorarHtml(url);
  } catch (err) {
    return { ok: false, error: `Dorar request failed: ${describeError(err)}` };
  }

  try {
    await ensureOffscreenDocument();
    const parsed = await parseUsulHtmlInOffscreen(html);
    if (!parsed || parsed.error) {
      throw new Error((parsed && parsed.error) || 'Empty response.');
    }
    return { ok: true, sources: parsed.sources };
  } catch (err) {
    return { ok: false, error: `Failed to parse Dorar response: ${describeError(err)}` };
  }
}

function describeError(err) {
  return (err && err.message) || String(err);
}
