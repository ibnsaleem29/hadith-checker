# Hadith Checker Worker

Cloudflare Worker — the extension's AI boundary. Two endpoints:

- `POST /translate` — `{ text, sourceLanguage, targetLanguage }` → `{ translation }`
  Faithful Arabic→English translation of actual Dorar content. No summarizing,
  no commentary, no harmonizing scholarly disagreement — see the system prompt
  in `src/index.js`.
- `POST /search-query` — `{ text }` → `{ arabicQuery }`
  Turns an English hadith-search description into an Arabic search query for
  Dorar. Never a hadith quotation, never displayed as content.

**Provider: Google Gemini API, model `gemini-3.5-flash-lite`**, called directly
over `fetch()` from this Worker. Cloudflare Workers AI / Gemma is no longer
used anywhere in this project — that whole code path was removed, not just
switched off.

No secrets live in this Worker's source. `GEMINI_API_KEY` is a Cloudflare
Worker *secret* (set via the CLI, encrypted at rest, never in `wrangler.toml`,
never committed to Git, never sent to the Chrome extension).

## Status

- ✅ Model ID confirmed real, current, and "Stable" against ai.google.dev's
  live docs: `gemini-3.5-flash-lite`.
- ✅ Request/response schema verified against ai.google.dev's live docs (the
  classic `generateContent` endpoint — see the code comment in `src/index.js`
  for why that was chosen over Google's newer "Interactions API").
- ❌ **`GEMINI_API_KEY` is not yet configured** — this is the one thing
  blocking a real test right now.
- ❌ Not deployed to Cloudflare yet.
- ⚠️ No real Gemini request has been made. Everything above is verified
  against documentation, not an observed live response.

## To deploy (your steps — one at a time)

**Step 1.** In the `worker` folder:
```bash
npm install
```

**Step 2.** Log into Cloudflare (skip if you already did this in an earlier
milestone):
```bash
npx wrangler login
```

**Step 3.** Set your Gemini API key as a Worker secret (this prompts you to
paste it — it's encrypted by Cloudflare, never written to any file here, and
I never see it):
```bash
npx wrangler secret put GEMINI_API_KEY
```
Get the key from Google AI Studio, project **Dorar Hadith Chrome Connector**
(`gen-lang-client-0212426672`) if you haven't already.

**Step 4.** Deploy:
```bash
npx wrangler deploy
```
Prints the live Worker URL, e.g. `https://hadith-checker-worker.<your-subdomain>.workers.dev`.

**Step 5** (I'll do this once you give me the URL): update
`../src/shared/workerConfig.js` with it, confirm `manifest.json`'s
`host_permissions` already covers it (the existing `*.workers.dev` wildcard
should), then reload the unpacked extension.

## Free-tier numbers (as configured for this Google AI Studio project)

- Gemini 3.5 Flash Lite: 15 RPM, 250,000 TPM, 500 RPD.
- This is why 3.5 Flash Lite was chosen over 3.6 Flash (500 RPD vs. 20 RPD on
  the free tier) — a deliberate product decision, not a technical default.

## Local-only alternative (optional, still needs the secret)

`npx wrangler dev` runs the Worker at `http://127.0.0.1:8787` (what
`WORKER_BASE_URL` already defaults to). `wrangler dev` reads secrets from a
local `.dev.vars` file (gitignored) instead of the deployed secret store — if
you want to test locally first, create `worker/.dev.vars` containing
`GEMINI_API_KEY=your-key-here` and do not commit it.
