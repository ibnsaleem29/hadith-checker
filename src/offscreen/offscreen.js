// Offscreen document script — the ONLY place in the extension with a real DOM.
// Owns all Dorar HTML selector/parsing knowledge. Receives raw HTML from the
// background service worker, returns plain structured data (no DOM nodes) back.
//
// Selectors and field-matching logic below are carried over unchanged from the
// selector knowledge validated live against dorar.net during the read-only
// investigation phase (same approach v3's own parser uses, ported from Node/linkedom
// to the browser's native DOMParser — this file does not import or depend on v3).
//
// CORRECTION (complete-retrieval pass): parseTab() previously kept only the
// FIRST result block per tab (`blocks[0]`) — that was the root cause of the
// "only one result" bug. It now maps every block. Also added: per-result
// action-availability extraction (sims/osoul/alts/asbab hrefs, the شرح
// modal's xplain id).
//
// CORRECTION (functional-bug pass): PARSE_PLAIN_TEXT previously read
// `doc.body.textContent` directly. That's a real bug, not a Dorar-content
// problem: `.textContent` concatenates ALL descendant text nodes, including
// the literal source text inside any <style>/<script> element the fragment
// happens to contain — confirmed as the cause of raw CSS ("font-weight:
// bold; /* ... */") leaking into the شرح modal. Fixed by stripping
// script/style/etc. from a clone before reading text (extractCleanText()).
// Also added PARSE_USUL_HTML for the new real أصول الحديث in-extension
// content, reusing the same extraction approach v3's own hadithMapper.service
// documented for this exact page shape (articles/h5/colored spans).

import { MESSAGE_TARGETS, MESSAGE_TYPES, DORAR_FIELD_LABELS } from '../shared/constants.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== MESSAGE_TARGETS.OFFSCREEN) {
    return undefined; // not addressed to us
  }

  if (message.type === MESSAGE_TYPES.PARSE_SEARCH_HTML) {
    try {
      sendResponse(parseSearchHtml(message.html));
    } catch (err) {
      sendResponse({ error: (err && err.message) || String(err) });
    }
    return false;
  }

  if (message.type === MESSAGE_TYPES.PARSE_PLAIN_TEXT) {
    try {
      const doc = new DOMParser().parseFromString(message.html, 'text/html');
      sendResponse({ text: extractSharhText(doc) });
    } catch (err) {
      sendResponse({ error: (err && err.message) || String(err) });
    }
    return false;
  }

  if (message.type === MESSAGE_TYPES.PARSE_USUL_HTML) {
    try {
      sendResponse({ sources: parseUsulSources(message.html) });
    } catch (err) {
      sendResponse({ error: (err && err.message) || String(err) });
    }
    return false;
  }

  return undefined;
});

function parseSearchHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return {
    specialist: parseTab(doc, 'specialist'),
    general: parseTab(doc, 'home'),
  };
}

/**
 * Parses one Dorar result tab (#specialist or #home) — ALL result blocks on
 * the page, not just the first.
 */
function parseTab(doc, tabId) {
  const tab = doc.querySelector(`#${tabId}`);
  const blocks = tab ? Array.from(tab.querySelectorAll('.border-bottom')) : [];

  const results = blocks
    .map((block) => {
      try {
        return parseResultBlock(block);
      } catch {
        return null; // one malformed block should never take down the whole page
      }
    })
    .filter(Boolean);

  return {
    count: blocks.length,
    results,
  };
}

function parseResultBlock(container) {
  const hadithNode = container.children[0] || container;
  const infoNode = container.children[1] || container;

  const fields = extractLabeledFields(infoNode);
  const grading = nullIfEmpty(fields.grade) ?? nullIfEmpty(fields.explainGrade);

  return {
    hadithId: container.querySelector('a[tag]')?.getAttribute('tag') || null,
    arabicText: cleanHadithText(hadithNode.textContent),
    grading,
    narrator: nullIfEmpty(fields.rawi),
    muhaddith: nullIfEmpty(fields.mohdith),
    source: nullIfEmpty(fields.book),
    pageOrNumber: nullIfEmpty(fields.numberOrPage),
    takhrij: nullIfEmpty(fields.takhrij),
    actions: extractActions(container),
  };
}

function cleanHadithText(text) {
  return (text || '').replace(/\d+\s+-/g, '').trim();
}

function extractLabeledFields(infoElement) {
  const result = {
    rawi: '',
    mohdith: '',
    book: '',
    numberOrPage: '',
    grade: '',
    explainGrade: '',
    takhrij: '',
  };

  const strongElements = Array.from(infoElement.querySelectorAll('strong'));

  for (const strong of strongElements) {
    const label = normalizeLabel(strong.textContent);
    for (const [key, expectedLabel] of Object.entries(DORAR_FIELD_LABELS)) {
      if (label.includes(expectedLabel)) {
        const span = strong.querySelector('span');
        if (span) {
          result[key] = span.textContent.trim();
        }
      }
    }
  }

  return result;
}

function normalizeLabel(text) {
  return (text || '').split(':')[0].replace(/\|/g, '').trim();
}

function extractActions(container) {
  const actions = {};

  const similarHref = container.querySelector('a[href$="?sims=1"]')?.getAttribute('href');
  if (similarHref) actions.similar = { url: toAbsoluteDorarUrl(similarHref) };

  const usulHref = container.querySelector('a[href$="?osoul=1"]')?.getAttribute('href');
  if (usulHref) actions.usul = { url: toAbsoluteDorarUrl(usulHref) };

  const altHref = container.querySelector('a[href$="?alts=1"]')?.getAttribute('href');
  if (altHref) actions.alternateSahih = { url: toAbsoluteDorarUrl(altHref) };

  const asbabHref = container.querySelector('a[href$="?asbab=1"]')?.getAttribute('href');
  if (asbabHref) actions.asbabWurud = { url: toAbsoluteDorarUrl(asbabHref) };

  const sharhLink = container.querySelector('a.xplain[xplain]');
  const sharhId = sharhLink?.getAttribute('xplain');
  if (sharhId && sharhId !== '0') {
    // Dorar shows two different link labels for the same underlying mechanism
    // (/hadith/explain/<id>): "شرح الحديث" (this hadith's own commentary) vs
    // "شرح حديث مشابه" (borrowed from a similar hadith). Captured so the UI
    // can display the correct label — see the app.js correction note for why
    // both still route to the same internal fetch (there is no separate real
    // URL for the "similar" variant; Dorar's own site uses the identical
    // popup mechanism for both).
    const linkText = (sharhLink.textContent || '').replace(/\|/g, '').trim();
    actions.sharh = { sharhId, isSimilarHadith: linkText.includes('مشابه') };
  }

  return actions;
}

function toAbsoluteDorarUrl(href) {
  if (!href) return null;
  return href.startsWith('http') ? href : `https://dorar.net${href}`;
}

function nullIfEmpty(value) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Strips <script>/<style>/<noscript>/<template>/the permalink anchor before
 * reading text, and turns <br>/block-level elements into line breaks so
 * multi-paragraph content doesn't collapse into one run-on line.
 */
function extractCleanText(root) {
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, template, #sharh-link').forEach((el) => el.remove());
  clone.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  clone.querySelectorAll('p, div, li').forEach((el) => el.append('\n'));
  return clone.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The شرح fragment comes in two shapes, both confirmed live: a "rich" shape
 * (full hadith-info recap + a bold "شرح الحديث :" label + a `.h-label` span
 * holding the actual commentary + a trailing `#sharh-link` permalink whose
 * visible text is a raw Dorar URL), and a "minimal" shape (just the
 * commentary text + the same trailing permalink, no recap). Extracting the
 * whole fragment's text — the original bug — leaked the permalink URL in
 * both shapes, and duplicated the redundant metadata recap in the rich one.
 * Fixed by targeting the labeled span in the rich shape, and by stripping
 * #sharh-link explicitly either way (see extractCleanText above). Verified
 * live against 9 real شرح ids covering both shapes — see the milestone report.
 */
function extractSharhText(doc) {
  const boldEls = Array.from(doc.querySelectorAll('b'));
  const labelBold = boldEls.find((b) => b.textContent.includes('شرح الحديث'));
  const valueSpan = labelBold ? labelBold.nextElementSibling : null;

  if (valueSpan && valueSpan.classList.contains('h-label')) {
    return extractCleanText(valueSpan);
  }
  return extractCleanText(doc.body);
}

/**
 * Parses the أصول الحديث (?osoul=1) page — a full Dorar page listing every
 * source that narrated the hadith. Selector approach carried over from v3's
 * own documented extraction for this exact page shape (see the file-level
 * correction note): each source is an <article>, its heading (<h5>) contains
 * a maroon-colored span (source/book citation) and a blue-colored span
 * (isnad chain), with the hadith's own wording as the article's remaining text.
 */
function parseUsulSources(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const articles = Array.from(doc.querySelectorAll('article'));
  const sources = [];

  // article[0] is the original hadith itself on this page, not a "source" —
  // matches the same skip v3's extractUsulSources used.
  for (let i = 1; i < articles.length; i += 1) {
    const heading = articles[i].querySelector('h5');
    if (!heading) continue;

    const sourceSpan = heading.querySelector('span[style*="color:maroon"]');
    const chainSpan = heading.querySelector('span[style*="color:blue"]');

    const source = sourceSpan ? extractCleanText(sourceSpan) : '';
    const chain = chainSpan ? extractCleanText(chainSpan) : '';

    let fullText = extractCleanText(heading);
    if (source) fullText = fullText.replace(source, '').trim();
    if (chain) fullText = fullText.replace(chain, '').trim();
    const hadithText = fullText.replace(/^[،,.\s]+/, '').trim();

    if (source || chain || hadithText) {
      sources.push({ source, chain, hadithText });
    }
  }

  return sources;
}
