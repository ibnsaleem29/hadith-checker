// Shared normalization for local-dictionary lookups (narrator/muhaddith/
// source values only — never applied to prose fields; see the file-level
// notes in narrators.js/scholars.js/sources.js and app.js's
// resolveLocalNameField for the field-aware scoping that guarantees this).
//
// Every step here is a lossless, identity-preserving Arabic-text
// normalization — it never merges two DIFFERENT words/names into one, only
// collapses known formatting variance of the SAME word:
//   - tashkeel (diacritics) are a pronunciation overlay on the same base
//     letters, never a different word;
//   - tatweel (ـ) is a pure visual elongation with no letter of its own;
//   - whitespace runs are trimmed/collapsed;
//   - "عبد الله" vs "عبدالله" (spaced vs compound) is a CONFIRMED, live-
//     verified Dorar formatting inconsistency for the exact same name (seen
//     both ways for the same narrators across real results during this
//     pass's verification — see the milestone report) — collapsing it is a
//     targeted correction for an evidenced case, not a general "merge any
//     عبد-compound" rule (which would risk conflating different names).
const TASHKEEL_PATTERN = /[ً-ْٰۖ-ۭ]/g;
const TATWEEL_PATTERN = /ـ/g;

export function normalizeArabicValue(text) {
  if (!text) return '';
  return text
    .replace(TASHKEEL_PATTERN, '')
    .replace(TATWEEL_PATTERN, '')
    .replace(/عبد\s+الله/g, 'عبدالله')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds a normalized-form -> canonical-English lookup Map from a list of
 * { en, forms: [...] } entries. Every declared form (canonical + aliases)
 * resolves to the same English value.
 */
export function buildLookup(entries) {
  const map = new Map();
  for (const entry of entries) {
    for (const form of entry.forms) {
      const key = normalizeArabicValue(form);
      if (map.has(key) && map.get(key) !== entry.en) {
        // Defensive: a real collision between two different canonical
        // entries would be a data bug, not something to silently resolve.
        // eslint-disable-next-line no-console
        console.error(`Dictionary collision on "${key}": "${map.get(key)}" vs "${entry.en}"`);
      }
      map.set(key, entry.en);
    }
  }
  return map;
}
