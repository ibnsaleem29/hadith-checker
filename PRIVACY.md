# Privacy Policy — Hadith Checker [English & Arabic]

_Last updated: 2026._

This document describes exactly what the **Hadith Checker [English &
Arabic]** Chrome extension does with data. It reflects the extension's
actual code, not aspirational practice.

## What you provide

- **A search query** — text you type into the search box, or text you
  select on a webpage and send via the "Check in Hadith Checker" right-click
  action.

## Where that data goes

- **Dorar.net** — every search query is sent to Dorar.net's own public site
  search, exactly as you entered/selected it, to retrieve matching Hadith
  results. This is the same as searching Dorar.net directly in a browser.
- **Google Gemini, via a Cloudflare Worker relay** — to produce the English
  text shown alongside Dorar's Arabic content, the following is sent to a
  small relay service the extension author operates on Cloudflare, which
  forwards it to Google's Gemini API for translation:
  - The Arabic hadith text, grading, narrator, muhaddith, source, Takhrij,
    commentary (شرح الحديث), and Hadith-principles (أصول الحديث) content
    retrieved from Dorar, when it needs to be translated to English.
  - Your search text, if you type an English query, so it can be turned into
    an Arabic search query for Dorar.
  - Text you select via "Check in Hadith Checker," if it needs translation
    (Arabic) or an Arabic search query generated for it (English).

  The Gemini API key is held only as a server-side secret on the Cloudflare
  Worker — it is never included in the extension itself and never visible to
  or accessible from your browser.

No other destination ever receives this data. The extension does not contact
any analytics, advertising, or tracking service.

## What is stored, and for how long

- **Search results and translations** are kept only in memory, only for the
  current browser tab, only for the duration of your current search. Opening
  a new search, or refreshing the page, clears this immediately. Nothing is
  written to disk.
- **`chrome.storage.session`** is used for exactly one purpose: briefly
  handing off text you selected via "Check in Hadith Checker" to the new tab
  that opens for it. That entry is read once and deleted immediately when
  the new tab loads; if it's never read, `chrome.storage.session` itself is
  automatically cleared when the browser closes. Nothing here persists
  across browser restarts.
- No cookies are set by the extension. No browsing history is read, stored,
  or transmitted. No data is retained after your session ends.

## What is not collected

- No advertising or tracking identifiers.
- No browsing history beyond the single page you invoke "Check in Hadith
  Checker" from (and only the text you explicitly selected on it, not the
  rest of the page).
- No account, login, or personally identifying information is requested or
  required.
- Data is never sold, shared for advertising, or used to train unrelated
  models by the extension author.

## Third-party services

- **Dorar.net** — receives your search text as a normal site search request.
  See Dorar.net's own terms for how they handle that.
- **Google Gemini API** — receives text solely for translation/search-query
  generation, via the extension author's Cloudflare Worker relay. See
  Google's API terms for how Google handles data sent to Gemini.

## Contact

Questions about this policy can be raised via the
[GitHub repository](https://github.com/ibnsaleem29/hadith-checker)'s issue
tracker.
