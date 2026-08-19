// Local-first translation lookups — narrator/muhaddith/source ONLY. Field-
// aware by construction: this module has no idea what a "hadith" or
// "Takhrij" is, it only ever exact-matches a COMPLETE field value against a
// closed dictionary. It never scans prose for known words. The caller
// (app.js's resolveLocalNameField) is responsible for only invoking the
// right lookup for the right field key — see that function for the actual
// field-aware gate.
import { normalizeArabicValue, buildLookup } from './normalize.js';
import { NARRATORS } from './narrators.js';
import { SCHOLARS } from './scholars.js';
import { SOURCES } from './sources.js';
import { GRADING_TERMS } from './grading.js';
import { TAKHRIJ_FIXED_PHRASES, TAKHRIJ_VERB_PREFIXES, TAKHRIJ_COMPILER_NAMES } from './takhrij.js';

const NARRATOR_LOOKUP = buildLookup(NARRATORS);
const SCHOLAR_LOOKUP = buildLookup(SCHOLARS);
const SOURCE_LOOKUP = buildLookup(SOURCES);
const GRADING_LOOKUP = buildLookup(GRADING_TERMS);
const TAKHRIJ_FIXED_LOOKUP = buildLookup(TAKHRIJ_FIXED_PHRASES);
const TAKHRIJ_COMPILER_LOOKUP = buildLookup(TAKHRIJ_COMPILER_NAMES);

function lookupNarrator(rawValue) {
  return NARRATOR_LOOKUP.get(normalizeArabicValue(rawValue)) || null;
}

export function lookupScholar(rawValue) {
  return SCHOLAR_LOOKUP.get(normalizeArabicValue(rawValue)) || null;
}

export function lookupSource(rawValue) {
  return SOURCE_LOOKUP.get(normalizeArabicValue(rawValue)) || null;
}

/**
 * Grading (الدرجة / خلاصة حكم المحدث) field lookup — exact match against a
 * short list of standard classical verdicts only (see grading.js). A long,
 * unique scholarly sentence will simply never match and falls to Gemini —
 * this is never a substring/word replacement inside such a sentence.
 */
export function lookupGrading(rawValue) {
  return GRADING_LOOKUP.get(normalizeArabicValue(rawValue)) || null;
}

/**
 * أصول الحديث Source lookup — SEPARATE from lookupSource's entry point
 * because the real أصول Source field (see parseUsulSources in offscreen.js)
 * is NOT a bare title the way the main card's المصدر is. LIVE-CONFIRMED
 * this pass across 3 real أصول pages (9 source citations sampled): every
 * single one carries trailing "(volume/page ...)" citation decoration, and
 * about half additionally wrap the title in "[...]" — e.g.
 * "[صحيح البخاري] (8/ 87)", "سنن أبي داود (2/ 262 ت محيي الدين عبد الحميد)".
 *
 * This function strips exactly that observed decoration — a trailing
 * "(...)" citation and, if the ENTIRE remainder is bracket-wrapped, the
 * brackets — then looks the result up in the SAME canonical SOURCES table
 * used for the main card (not a duplicated book list: أصول cites the same
 * books, just with page/editor decoration attached). If the decorated
 * value doesn't reduce to a known title (e.g. "سنن الترمذي ت شاكر" — a
 * genuinely different/edition-specific title, not just decoration, and not
 * in the dictionary), this correctly returns null and the caller falls
 * back to Gemini — never a guess.
 */
/**
 * FINAL CORRECTIONS pass: hardened to also tolerate a trailing "- edition"
 * annotation that follows a complete bracketed title, e.g. a hypothetical
 * "[مسند أحمد]- ط الرسالة (15/80)" shape. LIVE-CONFIRMED this pass (via
 * get_usul_hadith on real hadithIds) that Dorar in practice keeps the
 * edition marker INSIDE the same trailing "(...)" citation instead —
 * e.g. the real observed value is "[مسند أحمد] (28/ 146 ط الرسالة)", which
 * the original single trailing-paren strip below already handled
 * correctly. The extra dash-stripping step is kept anyway as a defensive
 * second pass — it only fires when the remainder before the dash is
 * ITSELF a complete "[...]"-wrapped title, so it can never eat into an
 * unbracketed title or a genuine hyphenated book name, and never changes
 * behavior for any of the formats actually observed.
 */
export function lookupUsulSource(rawValue) {
  if (!rawValue) return null;
  let stripped = rawValue.trim();
  // Strip a trailing "(...)" citation — a single balanced group, e.g.
  // "(8/ 87)" or "(28/ 146 ط الرسالة)".
  stripped = stripped.replace(/\s*\([^()]*\)\s*$/u, '').trim();
  // Defensive second pass: strip a trailing "- annotation" that follows a
  // complete bracketed title (see comment above).
  const bracketDash = stripped.match(/^(\[[^[\]]+\])\s*-\s*\S.*$/u);
  if (bracketDash) {
    stripped = bracketDash[1];
  }
  if (stripped.startsWith('[') && stripped.endsWith(']')) {
    stripped = stripped.slice(1, -1).trim();
  }
  return SOURCE_LOOKUP.get(normalizeArabicValue(stripped)) || null;
}

/**
 * التخريج (Takhrij) field lookup — exact-construction match only, scoped
 * EXCLUSIVELY to the structured Takhrij field (see app.js's PROSE_FIELDS
 * loop, gated on field.key === 'takhrij'). Handles exactly two safe
 * shapes:
 *   1. A complete fixed phrase (أخرجاه/متفق عليه/أخرجه الشيخان/etc.) with
 *      nothing else in the field.
 *   2. A recognized attribution verb ("أخرجه"/"رواه", tashkeel-insensitive
 *      via normalizeArabicValue) followed by EXACTLY one recognized
 *      primary-collection compiler name (optionally with a trailing
 *      "(...)" citation/reference number — same stripping precedent as
 *      lookupUsulSource above, since a citation number never changes WHO
 *      reported it) and nothing else.
 * Anything longer, multi-scholar, or containing an unrecognized name
 * returns null and falls back to Gemini whole — never a partial/substring
 * replacement inside a longer Takhrij sentence. For example "أخرجه
 * البخاري (3461)، ومسلم (2134)" does NOT match here (the remainder after
 * stripping one trailing citation still isn't a single known compiler
 * name), by construction — confirmed via the regression tests.
 */
export function lookupTakhrij(rawValue) {
  if (!rawValue) return null;
  const normalized = normalizeArabicValue(rawValue);

  const fixed = TAKHRIJ_FIXED_LOOKUP.get(normalized);
  if (fixed) return fixed;

  for (const verb of TAKHRIJ_VERB_PREFIXES) {
    for (const form of verb.forms) {
      const normVerb = normalizeArabicValue(form);
      if (!normalized.startsWith(`${normVerb} `)) continue;

      const remainder = normalized.slice(normVerb.length).trim();
      if (!remainder) continue;

      const remainderStripped = remainder.replace(/\s*\([^()]*\)\s*$/u, '').trim();
      const compiler = TAKHRIJ_COMPILER_LOOKUP.get(remainderStripped);
      if (compiler) return `${verb.en} ${compiler}`;

      return null; // recognized verb, unrecognized/multi-part object -> Gemini
    }
  }

  return null;
}

/**
 * Resolves a Narrator (الراوي) field value locally, including Dorar's
 * two-narrator case.
 *
 * LIVE-CONFIRMED separator (this pass): Dorar joins two narrators as
 * "NAME1 وNAME2" — a space, then a bare و (Arabic "and") directly prefixed
 * to the second name with no space after it (standard Arabic conjunction
 * attachment), e.g. "أبو هريرة وابن عمر", "عبدالله بن عمر وأبو هريرة",
 * "علي بن أبي طالب وابن مسعود" — all seen live. NOT a comma-separated list.
 *
 * Safety: a split is only ever trusted if it yields exactly two parts AND
 * BOTH independently resolve to a known narrator. Any other outcome (no
 * direct match, an unrecognized split, three+ parts, only one side
 * resolving) returns unresolved — never a partial/forced local guess. The
 * caller falls back to the existing Gemini pipeline in that case.
 */
export function resolveNarratorField(rawValue) {
  const direct = lookupNarrator(rawValue);
  if (direct) return direct;

  const parts = rawValue.split(/\s+و(?=\S)/u);
  if (parts.length === 2) {
    const first = lookupNarrator(parts[0]);
    const second = lookupNarrator(parts[1]);
    if (first && second) {
      return `${first} and ${second}`;
    }
  }

  return null;
}
