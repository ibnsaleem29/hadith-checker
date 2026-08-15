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
// diacritic — starts a brand-new session: the cache is cleared unconditionally
// at the top of runSearch(), regardless of how similar the new query or its
// results are to the previous search. The only other thing that resets it is
// a page refresh/crash (which loses this in-memory state naturally, since
// nothing here ever touches chrome.storage/localStorage/IndexedDB). Within
// one unchanged session, already-translated text — whether a main list field,
// a شرح chunk, or an أصول source field — is never re-sent to Gemini, no
// matter how many times its card/modal is scrolled past, closed, or reopened.

import { MESSAGE_TARGETS, MESSAGE_TYPES, DORAR_FIELD_LABELS } from '../shared/constants.js';
import { looksArabic } from '../shared/language.js';

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
const AUTO_TRANSLATE_COUNT = 5;

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

function cacheKeyForText(mode, text) {
  return `${mode || 'prose'}::${text}`;
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
  if (mainListLazyObserver) {
    mainListLazyObserver.disconnect();
    mainListLazyObserver = null;
  }

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
    renderResults(response.results);
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

function renderResults(results) {
  const rendered = results.map((result, index) => {
    const { card, slots } = renderCard(result, index);
    listEl.appendChild(card);
    return { result, slots, card };
  });

  mainListLazyObserver = createLazyObserver(null);

  rendered.forEach(({ result, slots, card }, index) => {
    if (index < AUTO_TRANSLATE_COUNT) {
      // Still goes through the shared background queue — see background/
      // index.js. Auto-translating the first 5 never means firing 5+ raw
      // simultaneous Gemini calls.
      translateAllFieldsForCard(result, slots);
    } else {
      observeForLazyTranslation(mainListLazyObserver, card, () => translateAllFieldsForCard(result, slots));
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

function renderCard(result, index) {
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
    // Language-neutral (a page/citation number) — no English translation to
    // pair it with, so it stays a single full-width row.
    card.appendChild(
      placeInRow(
        renderSimpleFullRow(DORAR_FIELD_LABELS.numberOrPage, 'Page/Number', result.pageOrNumber),
        rowCounter,
      ),
    );
  }

  const gradingField = PROSE_FIELDS.find((f) => f.key === 'grading');
  if (result.grading) {
    appendBilingualFieldRow(card, gradingField, result.grading, slots, undefined, rowCounter);
  }

  if (result.takhrij) {
    appendTakhrijRow(card, result.takhrij, slots, rowCounter);
  }

  const actionBar = renderActionBar(result);
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
  const tag = document.createElement('span');
  tag.className = 'bi-cell-tag';
  tag.textContent = 'AI TRANSLATION';
  tag.title = 'AI-generated translation — not Dorar’s own English wording.';
  const englishBlock = document.createElement('div');
  englishBlock.className = 'translation-text hadith-en-text is-loading';
  englishBlock.dir = 'ltr';
  englishBlock.lang = 'en';
  englishBlock.textContent = 'Translating…';
  slots.hadith = englishBlock;
  enCell.append(tag, englishBlock);

  placePairInRow(arCell, enCell, rowCounter);
  card.append(arCell, enCell);
}

/** One full-width, language-neutral row (currently just Page/Number). */
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
  arLabel.textContent = `${field.arLabel}: `;
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
  enLabel.textContent = `${field.label}: `;
  enLabel.title = 'AI-generated translation — not Dorar’s own English wording.';
  const enValue = document.createElement('span');
  enValue.className = mode === 'name' ? 'translation-text name-english is-loading' : 'translation-text is-loading';
  enValue.dir = 'ltr';
  enValue.lang = 'en';
  enValue.textContent = mode === 'name' ? '…' : 'Translating…';
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
  arLabel.textContent = `${DORAR_FIELD_LABELS.takhrij}: `;
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
  enLabel.textContent = 'Takhrij: ';
  enLabel.title = 'AI-generated translation — not Dorar’s own English wording.';
  const enValue = document.createElement('span');
  enValue.className = 'translation-text is-loading';
  enValue.dir = 'ltr';
  enValue.lang = 'en';
  enValue.textContent = 'Translating…';
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

function renderActionBar(result) {
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
    btn.addEventListener('click', () => openSharhModal(result, actions.sharh.sharhId, labelKey));
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
    btn.addEventListener('click', () => openUsulModal(result, actions.usul.url));
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

function openSharhModal(result, sharhId, labelKey) {
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

    loadSharh(sharhId, body, overlay);
  });
}

async function loadSharh(sharhId, body, overlay) {
  const cachedText = sharhTextCache.get(sharhId);
  if (cachedText) {
    renderSharhBody(body, cachedText, overlay);
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
    renderSharhBody(body, response.text, overlay);
  } catch (err) {
    console.error(`Sharh fetch failed for ${sharhId}:`, err); // dev-visible only
    body.textContent = 'Could not load commentary right now.';
    body.classList.add('is-unavailable');
  }
}

function renderSharhBody(body, arabicText, overlay) {
  body.textContent = ''; // safe: only text-content child elements appended below, never raw HTML
  body.classList.remove('is-unavailable');

  const chunks = chunkLongArabicText(arabicText);
  const lazyObserver = createLazyObserver(overlay);

  chunks.forEach((chunkText, chunkIndex) => {
    const chunkEl = document.createElement('div');
    chunkEl.className = 'sharh-chunk';

    const arabicEl = document.createElement('div');
    arabicEl.className = 'secondary-prose-arabic';
    arabicEl.dir = 'rtl';
    arabicEl.lang = 'ar';
    arabicEl.textContent = chunkText;
    chunkEl.appendChild(arabicEl);

    const { wrap, slotEl } = renderInlineTranslation('Translating…');
    chunkEl.appendChild(wrap);
    body.appendChild(chunkEl);

    if (chunkIndex < EAGER_MODAL_CHUNK_COUNT) {
      translateOneField('sharh', chunkText, slotEl);
    } else {
      observeForLazyTranslation(lazyObserver, chunkEl, () => translateOneField('sharh', chunkText, slotEl));
    }
  });
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

function openUsulModal(result, url) {
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

    loadUsul(url, body, overlay);
  });
}

async function loadUsul(url, body, overlay) {
  const cachedSources = usulSourcesCache.get(url);
  if (cachedSources) {
    renderUsulBody(body, cachedSources, overlay);
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
    renderUsulBody(body, response.sources, overlay);
  } catch (err) {
    console.error(`Usul fetch failed for ${url}:`, err); // dev-visible only
    body.textContent = 'Could not load hadith origins right now.';
    body.classList.add('is-unavailable');
  }
}

function renderUsulBody(body, sources, overlay) {
  body.textContent = '';
  body.classList.remove('is-unavailable');

  if (!sources || sources.length === 0) {
    body.textContent = 'No source details were found on the Dorar page for this action.';
    body.classList.add('is-unavailable');
    return;
  }

  const lazyObserver = createLazyObserver(overlay);
  sources.forEach((source, sourceIndex) => {
    body.appendChild(renderUsulSourceEntry(source, sourceIndex, lazyObserver));
  });
}

function renderUsulSourceEntry(source, sourceIndex, lazyObserver) {
  const entry = document.createElement('div');
  entry.className = 'usul-source-entry';

  const heading = document.createElement('div');
  heading.className = 'usul-source-heading';
  heading.textContent = `Source ${sourceIndex + 1}`;
  entry.appendChild(heading);

  // Each field's translation is deferred into a task rather than fired
  // immediately, so the WHOLE entry (all of its fields) can be translated
  // together, either eagerly (entry 0) or lazily as one unit when this entry
  // scrolls into view (entries 1+) — never one field now, one field later.
  const translateTasks = [];

  if (source.source) {
    entry.appendChild(renderUsulField('Source', source.source, 'name', translateTasks));
  }
  if (source.chain) {
    entry.appendChild(renderUsulField('Chain (Isnad)', source.chain, undefined, translateTasks));
  }
  if (source.hadithText) {
    entry.appendChild(renderUsulField('Wording', source.hadithText, undefined, translateTasks));
  }

  if (sourceIndex < EAGER_MODAL_CHUNK_COUNT) {
    translateTasks.forEach((run) => run());
  } else {
    observeForLazyTranslation(lazyObserver, entry, () => translateTasks.forEach((run) => run()));
  }

  return entry;
}

function renderUsulField(label, arabicValue, mode, translateTasks) {
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

  const { wrap, slotEl } = renderInlineTranslation(mode === 'name' ? '…' : 'Translating…');
  row.appendChild(wrap);

  translateTasks.push(() => translateOneField('usul', arabicValue, slotEl, mode));

  return row;
}

// ---------------------------------------------------------------------------
// Translation orchestration — no local queue or retry anymore (both live in
// the shared background service worker now, see the file-level note). This
// section just: checks the per-tab cache, fires a message if not cached,
// and updates the cache + DOM on response.
// ---------------------------------------------------------------------------

/**
 * Translates one result's fields in ONE Gemini call (the batch endpoint),
 * after filtering out anything already in the content-keyed cache.
 */
function translateAllFieldsForCard(result, slots) {
  const fieldsToRequest = {};
  const slotInfoByKey = {};

  for (const field of PROSE_FIELDS) {
    const value = result[field.resultProp];
    const slotEl = slots[field.key];
    if (!value || !slotEl) continue; // absent Dorar field — nothing to translate, nothing to fake

    const cached = getCachedTranslation(undefined, value);
    if (cached) {
      setTranslationContent(slotEl, cached, 'done');
      continue;
    }
    fieldsToRequest[field.key] = value;
    slotInfoByKey[field.key] = { slotEl, mode: undefined, value };
  }

  for (const field of NAME_FIELDS) {
    const value = result[field.resultProp];
    const slotEl = slots[field.key];
    if (!value || !slotEl) continue;

    const cached = getCachedTranslation('name', value);
    if (cached) {
      setTranslationContent(slotEl, cached, 'done');
      continue;
    }
    fieldsToRequest[field.key] = value;
    slotInfoByKey[field.key] = { slotEl, mode: 'name', value };
  }

  const keysToRequest = Object.keys(fieldsToRequest);
  if (keysToRequest.length === 0) return; // everything was already cached

  for (const key of keysToRequest) {
    const { slotEl, mode } = slotInfoByKey[key];
    setTranslationContent(slotEl, mode === 'name' ? '…' : 'Translating…', 'loading');
  }

  runBatchTranslation(fieldsToRequest, slotInfoByKey);
}

async function runBatchTranslation(fieldsToRequest, slotInfoByKey) {
  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      fields: fieldsToRequest,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }

    const translatedFields = response.fields || {};
    for (const key of Object.keys(fieldsToRequest)) {
      const { slotEl, mode, value } = slotInfoByKey[key];
      const translation = translatedFields[key];
      if (typeof translation === 'string' && translation.trim()) {
        setCachedTranslation(mode, value, translation.trim());
        setTranslationContent(slotEl, translation.trim(), 'done');
      } else {
        // The model omitted this one key — treat it individually as
        // unavailable rather than failing the whole card.
        markUnavailable(slotEl, mode);
      }
    }
  } catch (err) {
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

/**
 * Used by شرح / أصول content, which is fetched on demand rather than known
 * up front — one field/chunk at a time, still content-cached.
 */
async function translateOneField(debugLabel, arabicText, slotEl, mode) {
  const cached = getCachedTranslation(mode, arabicText);
  if (cached) {
    setTranslationContent(slotEl, cached, 'done');
    return;
  }

  setTranslationContent(slotEl, mode === 'name' ? '…' : 'Translating…', 'loading');

  try {
    const response = await sendMessage({
      target: MESSAGE_TARGETS.BACKGROUND,
      type: MESSAGE_TYPES.TRANSLATE_TEXT,
      text: arabicText,
      mode,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown error');
    }
    setCachedTranslation(mode, arabicText, response.translation);
    setTranslationContent(slotEl, response.translation, 'done');
  } catch (err) {
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
