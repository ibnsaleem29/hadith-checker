// Side panel — now a minimal search LAUNCHER, not a results renderer.
//
// CORRECTION (complete-retrieval pass): the side panel used to render results
// itself, in a ~350px-wide panel, showing exactly one result. That width was
// never going to fit Dorar's real result sets (e.g. 31 for the "إنَّ اللهَ
// وِتْرٌ..." test query) in any readable way, and — per explicit product
// direction — the side panel's width must never be allowed to affect how many
// results are retrieved or shown. So: the side panel now only collects the
// query and opens the full results page (src/results/) in a normal browser
// tab, which has the space for the complete set. All retrieval, translation,
// caching, and rendering logic now lives there — see src/results/app.js.
//
// The side panel deliberately does NOT resolve Arabic/English here — the
// results page does that itself from the raw query, so there's exactly one
// place that owns search-language routing, not two.

const form = document.getElementById('search-form');
const input = document.getElementById('query-input');
const button = document.getElementById('search-button');
const statusEl = document.getElementById('status');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openResults();
});

async function openResults() {
  const rawQuery = input.value.trim();
  if (!rawQuery) {
    setStatus('Please enter a search query.', 'error');
    return;
  }

  button.disabled = true;
  setStatus('Opening results…', 'loading');

  try {
    const url = `${chrome.runtime.getURL('src/results/index.html')}?q=${encodeURIComponent(rawQuery)}`;
    await chrome.tabs.create({ url });
    setStatus('Results opened in a new tab.', 'info');
  } catch (err) {
    setStatus(`Could not open results: ${err.message || err}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}
