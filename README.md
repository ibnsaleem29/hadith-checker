# Hadith Checker [English & Arabic] - Chrome Extension

**Version: 1.0.0**

Research & Explore Hadith in English & Arabic — translations, grading, sources, takhreej & sharh from scholarly supervised Dorar.net.

Hadith Checker searches **Dorar.net** and presents the Arabic results alongside English translations for research and exploration.

## Features

- Search Dorar.net using Arabic, English, or part of a Hadith
- Bilingual results — English and Arabic shown side by side
- English translations of Dorar's Arabic Hadith content
- Grading, narrator, Muhaddith, source, page/number, and Takhrij information
- شرح الحديث (Hadith commentary) and أصول الحديث (Hadith principles) available from the result cards
- Right-click selected text on any webpage → **Check in Hadith Checker**
- Multiple independent searches in separate tabs
- Local translation dictionaries for frequently recurring narrators, scholars, sources, and grading terminology, with AI translation used when a local match is unavailable

## How it works

The extension retrieves Hadith and metadata from **Dorar.net**. Frequently recurring terminology is resolved locally using bundled lookup dictionaries. Text that requires translation or English-to-Arabic search-query generation is handled through the project's Cloudflare Worker relay and Google Gemini API.

No Gemini API key is included in the extension package; the API credential is held server-side by the Cloudflare Worker.

## Usage

1. Install the extension from the Chrome Web Store once the public listing is approved.
2. Click the toolbar icon and enter a search, or select text on any webpage and choose **Check in Hadith Checker** from the right-click menu.
3. Results open in a dedicated tab with Arabic and English presented side by side.

English text is an AI-assisted translation of Dorar's Arabic content and is provided as an aid to understanding. The Arabic original remains the primary source.

## Privacy

See the full [Privacy Policy](./PRIVACY.md).

The extension does not collect accounts, identity information, location data, browsing history, analytics, advertising identifiers, or unrelated webpage content. For the context-menu feature, only the text explicitly selected by the user is received.

## Project

- **Source:** [GitHub repository](https://github.com/ibnsaleem29/hadith-checker)
- **Hadith source:** [Dorar.net](https://dorar.net)
- **Privacy policy:** [PRIVACY.md](./PRIVACY.md)

A direct Chrome Web Store link will be added here after the extension's V1.0.0 public listing has completed review and received its permanent store URL.

## License

MIT License
