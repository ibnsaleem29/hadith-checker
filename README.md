# Hadith Checker [English & Arabic]

A Chrome extension for searching and checking Hadith from
[Dorar.net](https://dorar.net) in Arabic and English — with AI-generated
translations, grading, sources, and commentary, side by side.

This is a browser extension, distinct from the separate
[`dorar-hadith-mcp`](https://github.com/ibnsaleem29/dorar-hadith-mcp) project
(a Claude Desktop MCP connector). The two are independent products.

## Features

- **Search Dorar.net** by pasting Arabic, English, or part of a Hadith.
- **Bilingual parallel layout** — English on the left, Arabic on the right,
  with corresponding fields aligned row by row.
- **Automatic translation** of the first five results as soon as a search
  loads; later results translate lazily as you scroll to them.
- **Hadith grading, source, narrator, and Takhrij** (further references)
  shown for every result, in both languages.
- **شرح الحديث (commentary)** and **أصول الحديث (Hadith principles/sources)**
  open inline, translated lazily and progressively as you read — never sent
  to the translation service all at once.
- **Session translation cache** — a completed translation is never
  re-requested while you stay on the same search, even if you close and
  reopen commentary/sources, or scroll away and back. A new search always
  starts a fresh session.
- **"Check in Hadith Checker"** — right-click any selected Arabic or English
  text on any webpage to open it as a new Hadith Checker search in its own
  tab, without leaving the page you're reading.
- **Multiple independent tabs** — open as many Hadith Checker tabs as you
  like; each keeps its own search and its own translation state.

## How it works

1. The extension sends your search to Dorar.net's own site search and
   retrieves the matching Hadith results.
2. Dorar's Arabic content — the hadith text, grading, narrator, source, and
   commentary — is displayed exactly as published, unmodified.
3. English text is produced by sending the Arabic to Google's Gemini model
   (via a small relay service the extension talks to) and is clearly an
   **AI-generated translation**, not part of Dorar's own published content.
   It should be read as an aid to understanding, not a substitute for the
   Arabic original.

## Installation (development / unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this repository's root folder (the one
   containing `manifest.json`).
5. Click the extension's toolbar icon to open the search launcher, or
   right-click any selected text on a webpage and choose **Check in Hadith
   Checker**.

## Chrome Web Store

This extension is intended for eventual publication on the Chrome Web Store.
See the repository's releases for packaged builds.

## Project structure

```
manifest.json        Extension manifest (Manifest V3)
icons/                Toolbar/store icon assets
src/background/       Service worker — Dorar retrieval, translation queue
src/offscreen/        Offscreen document (HTML parsing; service workers have no DOM)
src/results/          The full-page results interface
src/sidepanel/        Minimal search launcher (opens results in a new tab)
src/shared/           Small utilities shared across contexts
worker/                A separate Cloudflare Worker — the only component that
                        talks to the Gemini API. Deployed independently; see
                        worker/README.md.
```

## Privacy

See [PRIVACY.md](./PRIVACY.md) for what the extension sends, stores, and does
not collect.

## License

TBD.
