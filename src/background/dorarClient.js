// Dorar retrieval layer — the ONLY module that knows Dorar's URL shapes.
// No parsing, no selection logic here — just fetch in, HTML text out.

const SEARCH_BASE_URL = 'https://dorar.net/hadith/search';

/**
 * Builds the Dorar site-search URL for a given query and page.
 *
 * RETRIEVAL-FIDELITY CORRECTION: now includes the exact parameter set Dorar's
 * own search form (#inner-search) submits — searchType/st/optional_phrase1-4/
 * test/xclude/undefined_text/rawi[] — captured live by submitting that real
 * form, not guessed. Query text is passed through completely unmodified (no
 * diacritic stripping, no normalization) — that was already true before this
 * change (see resolveArabicQuery in results/app.js), just restated here since
 * it's now an explicit requirement.
 *
 * `all`/`page` mechanics confirmed live during the pagination investigation:
 * `&all` absent -> `page` controls the general/non-specialist tab (specialist
 * pinned to page 1). `&all` present -> reversed. Appended as a bare `&all`
 * flag (no value) to match the exact form confirmed working, not run through
 * URLSearchParams (which would encode it as `all=`, untested against Dorar).
 */
export function buildSearchUrl(query, { page = 1, all = false } = {}) {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('searchType', 'word');
  params.set('st', 'w');
  params.set('optional_phrase1', '');
  params.set('optional_phrase2', '');
  params.set('optional_phrase3', '');
  params.set('optional_phrase4', '');
  params.set('test', '1');
  params.set('xclude', '');
  params.set('undefined_text', '');
  params.append('rawi[]', '');

  let url = `${SEARCH_BASE_URL}?${params.toString()}`;
  if (page > 1) {
    url += `&page=${page}`;
  }
  if (all) {
    url += '&all';
  }
  return url;
}

/**
 * Builds the URL for a single hadith's شرح (commentary) fragment.
 * Confirmed live during the read-only investigation: a small, bare HTML
 * fragment, no site chrome — GET only, no parameters beyond the id.
 */
export function buildExplainUrl(sharhId) {
  return `https://dorar.net/hadith/explain/${encodeURIComponent(sharhId)}`;
}

/**
 * Fetches a Dorar URL and returns the raw HTML text.
 * Throws on network failure or a non-2xx status; callers decide how to surface that.
 */
export async function fetchDorarHtml(url) {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Dorar returned HTTP ${response.status}`);
  }
  return response.text();
}
