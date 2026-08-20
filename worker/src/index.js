// Hadith Checker — Cloudflare Worker (AI boundary).
//
// This is the ONLY component in the whole project that talks to the AI
// provider. The API key lives in `env.GEMINI_API_KEY`, a Cloudflare Worker
// *secret* (set via `wrangler secret put GEMINI_API_KEY` — never committed to
// source, never in wrangler.toml, never sent to the Chrome extension). The
// extension only ever sees this Worker's own JSON responses.
//
// PROVIDER CHANGE (from the earlier milestone): this Worker previously called
// Cloudflare Workers AI (`env.AI.run(...)`, Gemma). That has been fully
// removed from the active path — Workers AI is no longer used anywhere in this
// file. The Worker now calls the official Google Gemini API directly via
// fetch(), model `gemini-3.5-flash-lite`.
//
// Two endpoints, deliberately kept separate rather than merged into one,
// because they need genuinely different prompts and different failure
// semantics:
//   POST /translate     — faithfully translate actual Dorar Arabic into English.
//   POST /search-query   — turn an English search *intent* into an Arabic search
//                          string for Dorar. This is retrieval assistance, not
//                          hadith generation, and must never be confused with the
//                          first endpoint's job.
//
// GEMINI API SCHEMA — verified against ai.google.dev's live docs during this
// change, not assumed:
//   - Model ID confirmed real/current/stable: "gemini-3.5-flash-lite".
//   - Endpoint used: the classic
//     POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//     with the API key sent via the "x-goog-api-key" header.
//   - Request body: { contents: [{role:"user", parts:[{text}]}],
//     systemInstruction: {parts:[{text}]}, generationConfig }.
//   - Response body: candidates[0].content.parts[0].text.
//   ⚠️ Google's docs ALSO currently describe a newer "Interactions API"
//   (POST /v1beta/interactions) as their now-recommended endpoint for "the
//   latest features and models." I deliberately did NOT use it here: its
//   documented examples only show gemini-3.6-flash/3.7-flash (gemini-3.5-flash-lite
//   compatibility with it isn't confirmed), its response shape is a more
//   complex multi-step "steps[]" structure clearly aimed at agentic/tool-use
//   workflows, and generateContent is explicitly still supported — not
//   deprecated. For a simple one-shot "translate this text" call, the classic
//   endpoint is the better-fit, lower-risk choice. Flagging this as a
//   judgment call made under genuine documented ambiguity, not a guess.

const MODEL_ID = 'gemini-3.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;
// PERFORMANCE PATCH (this pass, CHANGE 3): a conservative cap on the Worker
// -> Gemini call itself. Without this, a genuinely slow/hung Gemini response
// had no ceiling and could occupy one of the extension's translation-
// concurrency slots indefinitely. AbortSignal.timeout() rejects the fetch
// with a TimeoutError once the deadline passes; that rejection propagates
// out of runModel/runModelJson exactly like any other failure and is caught
// by the existing per-endpoint try/catch -> handleModelError() (a normal 502
// response) — no new special-casing needed, so it flows through the
// extension's EXISTING retry path (background/index.js's withRetry) exactly
// like a real network failure or a 5xx from Gemini. Does not change retry
// count, backoff, or the RPM limiter.
const GEMINI_REQUEST_TIMEOUT_MS = 15000;
// Raised from 4000: real شرح content observed live up to ~5800 characters
// (id 163874) was being rejected outright by the old limit. This model's
// context window is large (256K tokens per the live docs check during the
// provider swap), so 10000 chars is a conservative, safely-clearing limit,
// not a stretch of the model's real capacity.
const MAX_TEXT_LENGTH = 10000;

// Prose translation — main hadith, grading, takhrij, sharh. Fluency guidance
// added in the complete-retrieval correction pass to fix awkward literal
// output observed in real testing (e.g. "Its isnad is weak with in it is
// ankarah.") WITHOUT relaxing any fidelity requirement — the fix is "write a
// grammatical English sentence," not "take liberties with the content."
const TRANSLATE_SYSTEM_PROMPT = `You are a precise Arabic-to-English translator working with authentic Islamic hadith content sourced directly from Dorar.net.
Translate the given Arabic text accurately into natural, academic English.
Preserve the complete meaning, including qualifications, conditions, and distinctions.
Do not summarize.
Do not omit qualifications.
Do not simplify scholarly judgments.
Do not add commentary or explanation.
Do not harmonize disagreements between scholars.
Do not invent information that is not present in the Arabic.
Preserve names, attributions, and citation details exactly.
Translate the actual meaning rather than producing an awkward, mechanical word-for-word rendering.
Write in fluent, grammatically correct English — a native academic reader should be able to read the sentence naturally, not have to decode a literal word-order translation.
When a technical hadith-science term (e.g. نكارة/nakarah, علة/illah, انقطاع/inqita) has no single perfect English equivalent, render it as a natural English phrase or clause; you may add the transliterated Arabic term in parentheses for precision, but the surrounding English must still be a complete, grammatical sentence.
Return only the English translation text, with no preface, labels, quotation marks, or additional commentary.`;

// Transliteration — narrator/muhaddith/source fields. These are proper names
// and titles, not prose: the job is NOT "translate the meaning" (that would
// turn a name into an unrelated English phrase), it's "give the standard
// English scholarly rendering of this specific name/title."
const TRANSLITERATE_SYSTEM_PROMPT = `You produce standard English bibliographic representations of Arabic proper names and book titles used in Islamic hadith scholarship — narrator names, hadith-scholar (muhaddith) names, and book/source titles.
Given a single Arabic name or title, return its standard English scholarly transliteration/romanization (using conventional Islamic-studies romanization, e.g. with macrons and ʿayn/hamza marks where standard), or, if it is a book title with a well-established standard English rendering, that standard rendering.
Do not translate the meaning of the name into ordinary English words.
Do not invent a name or title that is not a faithful representation of the given Arabic.
Do not add commentary, explanation, honorifics, or extra words beyond the name/title itself.
Return only the English representation, with no preface, labels, or quotation marks.`;

const SEARCH_QUERY_SYSTEM_PROMPT = `You are a search-query assistant for Dorar.net's Arabic Hadith Search.
The user will describe, in English, a hadith they are trying to find.
Translate their search intent into a concise, natural Arabic search query suitable for Dorar's Arabic hadith search engine.
Do not invent or quote a hadith.
Do not answer the user's question.
Do not explain your reasoning.
Return only the Arabic search query text, with no preface, labels, quotation marks, or additional commentary.`;

// Batched per-result translation — added in the "complete result content"
// correction pass to cut request volume (previously up to 6 separate calls
// per result — hadith/grading/takhrij/narrator/muhaddith/source — which at
// 15 results was ~90 calls, far past the 15 RPM free-tier limit, which is
// why only the first result or two would ever finish translating before
// later ones started failing). One call now covers one result's fields.
// Mixes both translation modes in a single structured prompt: some keys are
// prose (translate faithfully), some are proper names/titles (transliterate,
// don't translate meaning) — the model is told explicitly which is which by
// key name, and asked to return a same-shaped JSON object.
//
// PERFORMANCE PATCH (this pass, CHANGE 2): extended — additively, no wording
// of the actual translation instructions changed — to also recognize the key
// names results/app.js now uses when batching شرح (commentary) chunks and
// أصول الحديث (Chain/Wording) fields into this SAME endpoint, instead of one
// /translate call per chunk/field. "chain" and "wording" are simply added to
// the existing prose-key list (they are exactly that: free-form prose, same
// as hadith/grading/takhrij). شرح chunks use synthetic keys "sharh0",
// "sharh1", ... (one JSON object per group of chunks that became visible
// together) — recognized via the same "starts with sharh" rule, also
// prose. "source" (used for both the main list's Source field AND أصول's
// structured Source field, when it isn't already resolved locally) already
// matched the existing name/transliteration rule and needed no change.
const BATCH_SYSTEM_PROMPT = `You will receive a JSON object of Arabic text values — either one hadith result's fields, or a group of related شرح (commentary) or أصول الحديث (hadith-principles) fields/chunks. Its keys are Arabic text of two different kinds:
- "hadith", "grading", "takhrij", "chain", "wording", and any key starting with "sharh" (e.g. "sharh0", "sharh1"): free-form Arabic prose. Translate each faithfully into natural, academic English. Preserve every qualification, attribution, name, number, and citation exactly. Do not summarize, simplify, invent information, or harmonize scholarly disagreements. Write fluent, grammatically correct English — not a literal word-for-word rendering. When a technical hadith-science term has no single perfect English equivalent, render it as a natural English phrase or clause, optionally with the transliterated Arabic term in parentheses.
- "narrator", "muhaddith", "source": an Arabic proper name or book title, not prose. For each, return its standard English scholarly transliteration/romanization (using conventional Islamic-studies romanization, e.g. macrons and ʿayn/hamza marks where standard), or the well-established standard English rendering if the title has one. Do not translate the meaning of a name into ordinary English words.

Return ONLY a single JSON object with exactly the same keys you were given (only the keys present in the input — omit none, add none), each mapped to its English value as a plain string. No markdown code fences, no commentary, no nested objects — just the raw JSON object.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return jsonError('Only POST is supported.', 405);
    }

    if (url.pathname === '/translate') {
      return handleTranslate(request, env);
    }

    if (url.pathname === '/search-query') {
      return handleSearchQuery(request, env);
    }

    if (url.pathname === '/translate-batch') {
      return handleTranslateBatch(request, env);
    }

    return jsonError('Not found.', 404);
  },
};

async function handleTranslate(request, env) {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body; // parse/validation error already built

  const { text, mode } = body;
  const validationError = validateText(text);
  if (validationError) return jsonError(validationError, 400);

  // mode: 'name' -> transliteration (narrator/muhaddith/source). Anything
  // else/omitted -> faithful prose translation (hadith/grading/takhrij/sharh).
  const systemPrompt = mode === 'name' ? TRANSLITERATE_SYSTEM_PROMPT : TRANSLATE_SYSTEM_PROMPT;

  try {
    const translation = await runModel(env, systemPrompt, text);
    return jsonOk({ translation });
  } catch (err) {
    return handleModelError(err);
  }
}

async function handleSearchQuery(request, env) {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const { text } = body;
  const validationError = validateText(text);
  if (validationError) return jsonError(validationError, 400);

  try {
    const arabicQuery = await runModel(env, SEARCH_QUERY_SYSTEM_PROMPT, text);
    return jsonOk({ arabicQuery });
  } catch (err) {
    return handleModelError(err);
  }
}

const BATCH_MAX_FIELDS = 8;
const BATCH_MAX_TOTAL_LENGTH = MAX_TEXT_LENGTH * 2;

async function handleTranslateBatch(request, env) {
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const { fields } = body;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return jsonError('Request must include a "fields" object.', 400);
  }

  const entries = Object.entries(fields).filter(
    ([, value]) => typeof value === 'string' && value.trim().length > 0,
  );
  if (entries.length === 0) {
    return jsonError('Request must include at least one non-empty field.', 400);
  }
  if (entries.length > BATCH_MAX_FIELDS) {
    return jsonError(`Too many fields in one batch request (max ${BATCH_MAX_FIELDS}).`, 400);
  }
  const totalLength = entries.reduce((sum, [, value]) => sum + value.length, 0);
  if (totalLength > BATCH_MAX_TOTAL_LENGTH) {
    return jsonError(`Combined field length exceeds the ${BATCH_MAX_TOTAL_LENGTH}-character batch limit.`, 400);
  }

  const inputObject = Object.fromEntries(entries);

  try {
    const translations = await runModelJson(env, BATCH_SYSTEM_PROMPT, JSON.stringify(inputObject));
    return jsonOk({ fields: translations });
  } catch (err) {
    return handleModelError(err);
  }
}

/**
 * Like runModel, but asks Gemini for structured JSON output (responseMimeType)
 * and parses the result — used only by the batch endpoint above.
 */
async function runModelJson(env, systemPrompt, userText) {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on this Worker.');
  }

  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw buildUpstreamError(response, errorBody);
  }

  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    console.error('Unrecognized Gemini response shape (batch):', JSON.stringify(result));
    throw new Error('Model returned an unrecognized or empty response.');
  }

  try {
    return JSON.parse(text);
  } catch {
    console.error('Gemini batch response was not valid JSON:', text.slice(0, 500));
    throw new Error('Model returned malformed JSON.');
  }
}

async function runModel(env, systemPrompt, userText) {
  if (!env.GEMINI_API_KEY) {
    // Distinct, dev-visible error for "the secret was never configured" vs. a
    // real API failure — never surfaced to the caller (see handleModelError).
    throw new Error('GEMINI_API_KEY is not configured on this Worker.');
  }

  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        // Low temperature: this is faithful translation, not creative writing —
        // matches the "do not summarize/interpret/harmonize" requirement.
        temperature: 0.2,
      },
    }),
    signal: AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw buildUpstreamError(response, errorBody);
  }

  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text || !text.trim()) {
    console.error('Unrecognized Gemini response shape:', JSON.stringify(result));
    throw new Error('Model returned an unrecognized or empty response.');
  }
  return text.trim();
}

/**
 * V1.0.2 PERFORMANCE PASS: preserves Gemini's real HTTP status (specifically
 * 429) and any Retry-After header it sent, as properties on the thrown
 * Error, INSTEAD of collapsing every upstream failure into an opaque 502
 * (handleModelError below still decides what status/body the EXTENSION
 * actually sees — this only carries the raw signal that far). Everything
 * else about error handling is unchanged: the raw Gemini error body is
 * still never exposed to the caller, still only logged server-side.
 */
function buildUpstreamError(response, errorBody) {
  const err = new Error(`Gemini API returned HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
  err.upstreamStatus = response.status;
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) err.retryAfterHeader = retryAfter;
  return err;
}

function validateText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'Request must include a non-empty "text" field.';
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return `"text" exceeds the ${MAX_TEXT_LENGTH}-character limit.`;
  }
  return null;
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      return jsonError('Request body must be a JSON object.', 400);
    }
    return body;
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }
}

function handleModelError(err) {
  // Logged for development only — never expose raw stack traces, response
  // bodies, or (obviously) the API key to the caller.
  console.error('Gemini call failed:', err);

  // V1.0.2 PERFORMANCE PASS: a genuine 429 from Gemini is surfaced to the
  // extension AS a 429 (instead of the generic 502 every other failure
  // gets), with Retry-After passed through if Gemini provided one — this is
  // the ONLY signal the extension's retry logic (background/index.js's
  // withRetry) has to distinguish "rate limited, back off intelligently"
  // from "something else went wrong, use the normal retry delay." The
  // message text stays the same generic, non-leaking wording either way.
  if (err && err.upstreamStatus === 429) {
    const headers = err.retryAfterHeader ? { 'Retry-After': err.retryAfterHeader } : undefined;
    return jsonError('Translation service is temporarily rate-limited.', 429, headers);
  }

  return jsonError('Translation service is temporarily unavailable.', 502);
}

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jsonError(message, status, extraHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  // No secret is exposed by permissive CORS here — GEMINI_API_KEY never leaves
  // this Worker's server-side code — so this stays simple rather than
  // maintaining an origin allowlist for a free, small-scale initial service.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // V1.0.2 PERFORMANCE PASS: Retry-After is not one of the CORS-safelisted
    // response headers, so without explicitly exposing it, the extension's
    // fetch() would silently see `null` from response.headers.get(...) even
    // when this Worker did send the header on the wire. Needed for
    // handleModelError's 429 Retry-After passthrough to actually reach
    // aiClient.js.
    'Access-Control-Expose-Headers': 'Retry-After',
  };
}
