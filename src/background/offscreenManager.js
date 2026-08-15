// Manages the offscreen document that does the actual HTML parsing.
//
// Why this exists: MV3 background service workers have no DOM — no `document`,
// no `DOMParser`. The offscreen document API (chrome.offscreen) gives the extension
// a hidden real page context that DOES have a normal DOM, purely so we can parse
// fetched HTML there and message the structured result back.

import { MESSAGE_TARGETS, MESSAGE_TYPES } from '../shared/constants.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

/**
 * Ensures exactly one offscreen document exists. Chrome only allows a single
 * offscreen document per extension at a time, so a second createDocument() call
 * throws — we treat that specific failure as "already have one, reuse it" rather
 * than as a real error.
 */
export async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['DOM_PARSER'],
      justification:
        'Parse Dorar search-result HTML with DOMParser, which is unavailable in the background service worker.',
    });
  } catch (err) {
    const message = String((err && err.message) || err);
    const alreadyExists =
      message.includes('single offscreen') || message.includes('already exists');
    if (!alreadyExists) {
      throw err;
    }
  }
}

/**
 * Sends raw search-page HTML to the offscreen document and returns the parsed,
 * structured result. The offscreen document owns ALL DOM/selector knowledge —
 * this module just relays the message.
 */
export function parseSearchHtmlInOffscreen(html) {
  return chrome.runtime.sendMessage({
    target: MESSAGE_TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.PARSE_SEARCH_HTML,
    html,
  });
}

/**
 * Extracts plain text (never raw HTML) from a small Dorar fragment — used for
 * the شرح (commentary) action content. Safe by construction: the offscreen
 * document reads only .textContent, so nothing is ever injected as HTML.
 */
export function parsePlainTextInOffscreen(html) {
  return chrome.runtime.sendMessage({
    target: MESSAGE_TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.PARSE_PLAIN_TEXT,
    html,
  });
}

/**
 * Parses a full أصول الحديث (?osoul=1) page into {sources: [{source, chain,
 * hadithText}]} — real content, cleanly extracted (no raw HTML/CSS/JS), used
 * for the in-extension usul modal.
 */
export function parseUsulHtmlInOffscreen(html) {
  return chrome.runtime.sendMessage({
    target: MESSAGE_TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.PARSE_USUL_HTML,
    html,
  });
}
