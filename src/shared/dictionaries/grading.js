// Local grading-terminology dictionary — exact-match only, scoped
// EXCLUSIVELY to the structured Grading (الدرجة / خلاصة حكم المحدث) field
// (see app.js's PROSE_FIELDS loop, gated on field.key === 'grading'). Never
// applied to hadith text or Takhrij — those stay in the same loop but never
// reach this dictionary, by construction (the check is inside an `if
// (field.key === 'grading')` branch that hadith/takhrij never enter).
//
// LIVE VERIFICATION (this pass): sampled real خلاصة حكم المحدث/درجة الحديث
// output across 2 live searches ("من كذب علي متعمدا", plus earlier-session
// data). Every entry below is either a COMPLETE field value observed
// verbatim this session, or (رجاله ثقات / إسناده ضعيف) observed verbatim
// during this project's earlier live testing (see project history).
//
// DELIBERATELY EXCLUDED (real candidates the user suggested, checked
// against real output, and rejected as unsafe for exact-phrase matching):
//   - "علة" / "له علة" / "معلول" — never observed as a COMPLETE grading
//     value on their own; every real occurrence was embedded inside a
//     longer, unique scholarly sentence (e.g. "إسناده صحيح على شرط الصحيح
//     لا نعلم له علة وله شاهد من وجه آخر"). Exactly the case the user
//     warned about — mapping "علة" in isolation risks corrupting a
//     dynamic sentence via substring replacement, which this architecture
//     never does. Left entirely to Gemini.
//   - "إسناده صحيح" (bare) — only observed as part of a longer phrase
//     ("إسناده صحيح على شرط الشيخين"), never as a standalone value this
//     session. Not added, despite being a plausible counterpart to the
//     confirmed "إسناده ضعيف", to avoid adding an unverified entry.
//
// FINAL CORRECTIONS pass — "فيه علة" added per explicit instruction as an
// EXACT complete-field match only (never a substring/word replacement).
// Live re-sampling this pass (30 more "علة"-containing grade values
// checked) again found no COMPLETE grading value that is bare "فيه علة" —
// every real occurrence of "علة" remains embedded in a unique longer
// sentence, most commonly the "[فيه] <narrator> قال <verdict>" pattern
// (e.g. "[فيه] الهيثم بن جماز قال ابن معين ضعيف"), which this entry's
// exact whole-field match (see lookupGrading in index.js, a Map.get on
// the full normalized field value) cannot and will not partially match.
// The entry is therefore added as instructed, on the same "only fires on
// an exact complete value, otherwise structurally inert" basis as every
// other entry in this file — if "فيه علة" is ever returned verbatim as a
// complete grading value, it resolves; until then it simply never fires
// and Gemini continues to handle every real sentence containing "علة".
//
// "له علة" was NOT added (per the instruction's own conditional wording):
// re-checked this pass across the same sampling, never observed as a
// complete grading value either — left to Gemini.
export const GRADING_TERMS = [
  { en: 'Sahih (authentic)', forms: ['صحيح', '[صحيح]'] },
  { en: "Da'if (weak)", forms: ['ضعيف', '[ضعيف]'] },
  { en: 'Not authentic', forms: ['لا يصح'] },
  { en: 'Sahih li-ghairihi (authentic due to corroborating evidence)', forms: ['صحيح لغيره'] },
  { en: 'Hasan (good)', forms: ['حسن'] },
  { en: 'Hasan Sahih (good, authentic)', forms: ['حسن صحيح'] },
  { en: 'Mutawatir (mass-transmitted)', forms: ['حديث متواتر', 'متواتر'] },
  { en: 'Its chain of transmission is weak', forms: ['إسناده ضعيف'] },
  { en: 'Its narrators are trustworthy', forms: ['رجاله ثقات'] },
  { en: 'It has a defect', forms: ['فيه علة'] },
];
