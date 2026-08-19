// Shared constants used by background, offscreen, and side panel contexts.
// Kept dependency-free (no bundler) so each context can import this file directly
// via a relative path as a native ES module.

export const MESSAGE_TARGETS = {
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
};

export const MESSAGE_TYPES = {
  SEARCH_DORAR: 'SEARCH_DORAR',
  PARSE_SEARCH_HTML: 'PARSE_SEARCH_HTML',
  // Milestone 2 additions — both relay through the background service worker to
  // our Cloudflare Worker (see src/background/aiClient.js). Neither ever touches
  // Dorar directly; neither is authoritative content (see workerConfig.js).
  TRANSLATE_TEXT: 'TRANSLATE_TEXT',
  TRANSLATE_BATCH: 'TRANSLATE_BATCH', // one Gemini call covering one result's fields
  GENERATE_SEARCH_QUERY: 'GENERATE_SEARCH_QUERY',
  // Complete-retrieval / action-bar correction additions.
  PARSE_PLAIN_TEXT: 'PARSE_PLAIN_TEXT', // offscreen: extract clean text only, never raw HTML/CSS/JS
  FETCH_SHARH: 'FETCH_SHARH', // background: fetch + parse a شرح fragment for one result
  // Functional-bug-fix pass additions.
  PARSE_USUL_HTML: 'PARSE_USUL_HTML', // offscreen: parse an أصول الحديث page into {sources}
  FETCH_USUL: 'FETCH_USUL', // background: fetch + parse أصول الحديث content for one result
  // STALE-QUEUE-FIX pass addition: a one-way, background-initiated
  // notification (via chrome.tabs.sendMessage, not a response to any
  // TRANSLATE_* call) sent to the originating tab at the exact moment a
  // queued translation task is actually dispatched (its real Worker fetch
  // begins) — lets the UI distinguish "Queued…" (task scheduled, not yet
  // dispatched) from "Translating…" (network request genuinely in
  // flight). See background/index.js's pumpTranslationQueue and
  // results/app.js's onMessage listener for TRANSLATION_DISPATCHED.
  TRANSLATION_DISPATCHED: 'TRANSLATION_DISPATCHED',
};

// Arabic field labels as they literally appear in Dorar's search-result markup.
// Confirmed against live dorar.net during the read-only investigation phase.
export const DORAR_FIELD_LABELS = {
  rawi: 'الراوي',
  mohdith: 'المحدث',
  book: 'المصدر',
  numberOrPage: 'الصفحة أو الرقم',
  grade: 'درجة الحديث',
  explainGrade: 'خلاصة حكم المحدث',
  takhrij: 'التخريج',
};
