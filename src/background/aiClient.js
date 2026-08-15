// AI client — the ONLY module that talks to our Cloudflare Worker.
//
// This is deliberately a thin, generic relay: it knows the Worker's two endpoint
// shapes, nothing about Gemini specifically, and nothing about prompts (those live
// entirely in the Worker — see worker/src/index.js). That's what keeps the model/
// provider swappable later without touching the extension.
//
// Neither function here ever talks to Dorar, and neither result is authoritative
// Dorar content — see src/shared/workerConfig.js and the milestone report for the
// "generated content, not Dorar's own wording" distinction.

import { WORKER_BASE_URL } from '../shared/workerConfig.js';

/**
 * Translates Dorar-sourced Arabic text into English.
 *
 * @param {string} arabicText
 * @param {string} [mode] - omitted/undefined: faithful prose translation
 *   (hadith/grading/takhrij/sharh). 'name': standard English bibliographic
 *   transliteration instead of ordinary translation — for narrator/muhaddith/
 *   source, which are proper names and titles, not prose (see the milestone
 *   report's Priority #2). The Worker picks the system prompt based on this
 *   flag; this client stays agnostic to what those prompts actually say.
 */
export async function translateText(arabicText, mode) {
  const data = await callWorker('/translate', {
    text: arabicText,
    sourceLanguage: 'ar',
    targetLanguage: 'en',
    ...(mode ? { mode } : {}),
  });

  if (typeof data.translation !== 'string' || !data.translation.trim()) {
    throw new Error('Worker returned no translation text.');
  }
  return data.translation.trim();
}

/**
 * Translates several of one result's fields in a single Gemini call.
 *
 * @param {Object} fields - e.g. { hadith, grading, takhrij, narrator, muhaddith, source }.
 *   Only include keys you actually want translated (already-cached ones should
 *   be omitted by the caller — this function doesn't know about the cache).
 * @returns {Promise<Object>} same keys, English values.
 */
export async function translateFieldsBatch(fields) {
  const data = await callWorker('/translate-batch', { fields });

  if (!data.fields || typeof data.fields !== 'object') {
    throw new Error('Worker returned no translated fields.');
  }
  return data.fields;
}

/**
 * Turns an English hadith-search description into an Arabic search query for
 * Dorar. The result is ONLY ever used as a search parameter — never displayed,
 * never treated as hadith content.
 */
export async function generateArabicSearchQuery(englishText) {
  const data = await callWorker('/search-query', { text: englishText });

  if (typeof data.arabicQuery !== 'string' || !data.arabicQuery.trim()) {
    throw new Error('Worker returned no search query.');
  }
  return data.arabicQuery.trim();
}

async function callWorker(path, body) {
  let response;
  try {
    response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (Worker unreachable, not deployed, DNS, etc.)
    throw new Error(`Could not reach the translation service: ${describeError(err)}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errorBody = await response.json();
      detail = errorBody && errorBody.error ? `: ${errorBody.error}` : '';
    } catch {
      // response wasn't JSON — ignore, use the plain status
    }
    throw new Error(`Translation service returned HTTP ${response.status}${detail}`);
  }

  return response.json();
}

function describeError(err) {
  return (err && err.message) || String(err);
}
