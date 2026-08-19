// Local-first lookup for common, high-confidence hadith Takhrij (تخريج)
// attribution constructions — exact-construction match only, scoped
// EXCLUSIVELY to the structured Takhrij (التخريج) field (see index.js's
// lookupTakhrij and app.js's PROSE_FIELDS loop, gated on field.key ===
// 'takhrij'). Never applied via substring/regex replacement inside an
// arbitrary Takhrij sentence — a longer, multi-scholar, or otherwise
// unrecognized construction simply does not match and falls to Gemini
// whole, exactly like every other local dictionary in this project.
//
// Two kinds of entries:
//
//  1. FIXED_PHRASES — a handful of standalone Takhrij values that are
//     complete in themselves, with no attached compiler name to parse out
//     ("أخرجاه"/"أخرجهما" = "reported by both", understood by convention
//     to mean al-Bukhari and Muslim; "متفق عليه" = "agreed upon"; "أخرجه
//     الشيخان" names "the two Shaykhs" explicitly rather than leaving the
//     reader to infer who that refers to, per the explicit requirement).
//
//  2. VERB_PREFIXES + COMPILER_NAMES — recognizes the "<verb> <compiler>"
//     construction (e.g. "أخرجه الترمذي") by splitting the attribution
//     verb ("أخرجه"/"رواه") from its object, translating the verb
//     literally, and resolving the object against COMPILER_NAMES below —
//     see index.js's lookupTakhrij for the exact matching/splitting logic.
//
// COMPILER_NAMES is DELIBERATELY SEPARATE from scholars.js, not a
// duplicate of it, even though three of its entries (البخاري، مسلم،
// الطبراني) also exist there for the Muhaddith field:
//   - Muhaddith-field context (scholars.js) uses the bare label form:
//     "Bukhari", "Muslim", "al-Tabarani".
//   - This Takhrij-sentence context needs the form that reads naturally
//     inside a full English sentence ("Reported by al-Bukhari"), which
//     for Bukhari specifically differs ("al-Bukhari", not "Bukhari").
//   This mirrors the project's own established principle that the exact
//   context determines the exact English rendering, never one shared
//   canonical string blindly reused across different field contexts (the
//   same reasoning already used for narrator/muhaddith short-vs-full-form
//   splits elsewhere in this project).
// The other five compiler names here (أبو داود، الترمذي، النسائي، ابن
// ماجه، أحمد) are intentionally NOT added to scholars.js's general
// Muhaddith dictionary at all: their bare short forms, without any
// author-identifying nisba/surname context, would be too ambiguous to
// resolve safely as a general Muhaddith value (bare "أحمد" in particular
// is an extremely common personal name, not uniquely Ahmad ibn Hanbal,
// outside this specific "<verb> + primary-collection-compiler"
// construction). Scoping them to this file keeps that ambiguity risk
// completely out of the general-purpose Muhaddith lookup.
export const TAKHRIJ_FIXED_PHRASES = [
  { en: 'Reported by both', forms: ['أخرجهما', 'أخرجاه'] },
  { en: 'Narrated by both', forms: ['رواهما'] },
  { en: 'Agreed upon (narrated by al-Bukhari and Muslim)', forms: ['متفق عليه'] },
  { en: 'Reported by the two Shaykhs (al-Bukhari and Muslim)', forms: ['أخرجه الشيخان'] },
];

export const TAKHRIJ_VERB_PREFIXES = [
  { en: 'Reported by', forms: ['أخرجه', 'أخرجَهُ'] },
  { en: 'Narrated by', forms: ['رواه', 'رواهُ'] },
];

export const TAKHRIJ_COMPILER_NAMES = [
  { en: 'al-Bukhari', forms: ['البخاري'] },
  { en: 'Muslim', forms: ['مسلم'] },
  { en: 'Abu Dawud', forms: ['أبو داود'] },
  { en: 'al-Tirmidhi', forms: ['الترمذي'] },
  { en: "al-Nasa'i", forms: ['النسائي'] },
  { en: 'Ibn Majah', forms: ['ابن ماجه'] },
  { en: 'Ahmad', forms: ['أحمد'] },
  { en: 'al-Tabarani', forms: ['الطبراني'] },
];
