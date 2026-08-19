// Single, clearly-marked place holding the Cloudflare Worker's base URL.
//
// V1.0.1 HOSTNAME MIGRATION (prep pass): updated to the neutral
// "hadithchecker" Cloudflare account subdomain, replacing the previous
// account subdomain — see the migration audit report for the full
// rationale (removing an incidental personal-identifier exposure from the
// public source/package). NOT YET LIVE: this exact hostname will not
// resolve until the Cloudflare account-subdomain change is actually
// performed (a separate, not-yet-taken step — see worker/src/index.js and
// the migration report for what still needs verifying before deploy).
// Until that happens, this constant intentionally does NOT match the
// currently-published v1.0.0 extension, which still points at the old,
// still-live account subdomain — this file only becomes the live v1.0.1
// config once the Cloudflare-side change is confirmed and this package is
// actually built/published.
export const WORKER_BASE_URL = 'https://hadith-checker-worker.hadithchecker.workers.dev';
