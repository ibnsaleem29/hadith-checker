// Lightweight language detection - intentionally simple (per the milestone-2
// instruction not to build a complicated detection system yet).
//
// If the input contains any Arabic-script character, treat the whole query as
// Arabic and send it to Dorar directly. Otherwise, treat it as English and route
// it through the search-query translation step first.
//
// Ranges cover the Arabic, Arabic Supplement, Arabic Extended-A, and Arabic
// Presentation Forms A/B Unicode blocks.
const ARABIC_SCRIPT_PATTERN = new RegExp(
  '[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]'
);

export function looksArabic(text) {
  return ARABIC_SCRIPT_PATTERN.test(text || '');
}
