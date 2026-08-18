# Privacy Policy — Hadith Checker [English & Arabic]

_Last updated: 2026._

This document describes exactly what the **Hadith Checker [English &
Arabic]** Chrome extension does with data. It reflects the extension's
actual code, not aspirational practice.

## What you provide

- **A search query** — text you type into the search box, or text you
  select on a webpage and send via the "Check in Hadith Checker" right-click
  action.
- For the right-click action specifically: the extension receives **only**
  the exact text you highlighted before right-clicking, via Chrome's native
  text-selection mechanism. It does not read anything else about the page
  you're on — not the rest of the page's content, not its URL or title, not
  its DOM, not cookies, and not your browsing history. Each right-click
  action is independent; nothing about which pages you've visited is
  retained.

## Where that data goes

- **Dorar.net** — your search query is sent to Dorar.net's own public site
  search to retrieve matching Hadith results, the same as searching
  Dorar.net directly in a browser. If your query is in Arabic (typed or
  selected), it is sent to Dorar.net exactly as entered/selected. If your
  query is in English, it is first sent to the Cloudflare Worker relay
  described below to generate an equivalent Arabic search term, and that
  generated Arabic term — not your original English text — is what is then
  sent to Dorar.net.
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

No other data — including your identity, browsing history, other open tabs,
or anything about the page you're on beyond your explicit text selection —
is ever included in requests to Dorar.net, the Cloudflare Worker, or
Gemini. No other destination ever receives this data. The extension does
not contact any analytics, advertising, or tracking service.

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

- No accounts, logins, or credentials of any kind are requested, required,
  or stored.
- No names, email addresses, or other personal identifiers.
- No location data.
- No financial or payment information.
- No health information.
- No advertising or tracking identifiers, and no analytics of any kind —
  the extension does not include any analytics or tracking SDK.
- No browsing history is read, stored, or transmitted. The extension does
  not know, and never requests, the URL, title, or content of the page you
  invoke "Check in Hadith Checker" from — only the exact text you
  highlighted is received (see "What you provide" above).
- No remotely hosted JavaScript or WebAssembly is loaded or executed —
  every script the extension runs ships inside the extension package
  itself.
- Data is never sold, shared for advertising, or used to determine
  creditworthiness or eligibility for lending, or for any purpose unrelated
  to looking up and translating the Hadith you searched for.

## Third-party services

- **Dorar.net** — receives your search text as a normal site search request.
  See Dorar.net's own terms for how they handle that.
- **Google Gemini API** — receives text solely for translation/search-query
  generation, via the extension author's Cloudflare Worker relay. See
  Google's API terms for how Google handles data sent to Gemini.

## Chrome Web Store Limited Use compliance

Hadith Checker [English & Arabic]'s use and transfer of information
received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/),
including the Limited Use requirements. Text is sent to Google's Gemini
API — via the developer's own Cloudflare Worker relay — solely to
translate Dorar-sourced Arabic Hadith content into English, or to generate
an Arabic search term from an English query. This data is never used for
advertising, never used to build a profile of you, and never used for any
purpose beyond directly fulfilling the search or translation you
requested.

## Contact

Questions about this policy can be raised via the
[GitHub repository](https://github.com/ibnsaleem29/hadith-checker)'s issue
tracker.
