// Local muhaddith/scholar dictionary — canonical identities + aliases,
// exact-match only, scoped to the Muhaddith (المحدث) field exclusively (see
// app.js's resolveLocalNameField).
//
// LIVE VERIFICATION (this pass): checked against real Dorar output across 3
// live searches. Confirmed finding — Dorar's المحدث field very commonly
// shows a SHORT form for the most frequently-cited scholars, not the full
// scholarly name: البخاري, مسلم, ابن خزيمة, ابن حبان, and الألباني all
// appeared repeatedly in real results in their short form, none matching
// the supplied full names on their own. Added as aliases below — every
// addition is a live-confirmed, unambiguous short form for a well-known
// scholar in this exact hadith-attribution context.
//
// Also live-confirmed as EXACT matches with no correction needed:
// الدارقطني, الهيثمي, العراقي, ابن حجر العسقلاني, الطبراني, شعيب الأرناؤوط,
// أحمد شاكر, البيهقي.
//
// NOT independently live-verified this pass (did not appear in the ~90
// results sampled): مالك بن أنس, أحمد بن حنبل, أبو داود السجستاني, محمد بن
// عيسى الترمذي, أحمد بن شعيب النسائي, محمد بن يزيد بن ماجه, عبد الله بن عبد
// الرحمن الدارمي, الحاكم النيسابوري, البزار, أبو يعلى الموصلي, عبد الرزاق
// الصنعاني, ابن أبي شيبة, الخطيب البغدادي, ابن عبد البر, المزي, ابن الصلاح,
// النووي, ابن تيمية, ابن القيم, ابن كثير, الذهبي, ابن رجب الحنبلي,
// السخاوي, السيوطي, المناوي, الزيلعي, الشوكاني. Kept EXACTLY as supplied,
// with no short-form aliases invented for them — if Dorar commonly
// abbreviates any of these too (plausible for e.g. الترمذي/النسائي/ابن ماجه/
// أبو داود by the same pattern seen for البخاري/مسلم), that is a reasonable
// follow-up but is deliberately NOT included here without live confirmation,
// per the explicit "do not invent, leave uncertain entries out" instruction.
// Unmatched values fall through to the existing Gemini pipeline exactly as
// before — no regression, just an unclaimed optimization opportunity.
//
// The two spellings called out for preservation — "محمد بن يزيد بن ماجه"
// and "محمد بن إسحاق بن خزيمة" — are exactly as supplied, unchanged.
//
// EXPANSION (this pass): "الوادعي" (Muqbil ibn Hadi al-Wadi'i, author of
// الصحيح المسند — see sources.js) confirmed live as a real المحدث value.
// Only the short form was observed this session; no full form
// ("مقبل بن هادي الوادعي") was seen, so only the observed short form is
// added, per the "exact Arabic value determines the exact mapping"
// principle — not invented or assumed.
//
// SMALL CORRECTION pass: "ابن بطال" added — was previously falling through
// to Gemini unresolved as a Muhaddith value. This is a SEPARATE identity
// from the Source/Book dictionary's unrelated "شرح صحيح البخاري لابن بطال"
// entry (sources.js) — that entry is a whole book TITLE string, matched
// only via lookupSource against the Source field; this entry is the bare
// person's name, matched only via lookupScholar against the Muhaddith
// field. The two lookups run against different tables from different
// field-scoped call sites and cannot collide or substitute into one
// another.
//
// DICTIONARY EXPANSION pass: three more entries, all live-verified this
// pass against real Dorar المحدث output — "أبو حاتم الرازي" and "أبو زرعة
// الرازي" both confirmed as complete, recurring Muhaddith values (8 and 7
// occurrences respectively in one sampled book, علل ابن أبي حاتم — see
// sources.js), and "ابن جرير الطبري" confirmed once (تاريخ الطبري, 1/65).
// "ابن جرير الطبري" is a DISTINCT person from the existing "al-Tabarani"
// entry (الطبراني, compiler of the المعاجم) — no relation, no conflict,
// kept as fully separate entries.
//
// FINAL V1.0.2 lookup-addition request: "ابن عبد البر" -> "Ibn ʿAbd al-Barr"
// was requested as a new addition. Inspected first per instruction — the
// exact Arabic form "ابن عبد البر" already existed below (added in an
// earlier expansion pass) as "Ibn Abd al-Barr" (no ʿayn mark). Rather than
// add a second, duplicate entry for the identical Arabic key, the existing
// entry's English text was updated in place to the requested "Ibn ʿAbd
// al-Barr" — no duplicate created, no new Arabic key added.
export const SCHOLARS = [
  { en: 'Abu Hatim al-Razi', forms: ['أبو حاتم الرازي'] },
  { en: 'Ibn Jarir al-Tabari', forms: ['ابن جرير الطبري'] },
  { en: "Abu Zur'ah al-Razi", forms: ['أبو زرعة الرازي'] },
  { en: 'Ibn Battal', forms: ['ابن بطال'] },
  { en: "al-Wadi'i", forms: ['الوادعي'] },
  { en: 'Malik ibn Anas', forms: ['مالك بن أنس'] },
  { en: 'Ahmad ibn Hanbal', forms: ['أحمد بن حنبل'] },
  // Short vs. full Dorar forms deliberately return DIFFERENT English text —
  // the exact Arabic input determines which mapping fires, never a shared
  // canonical string. Two separate entries per scholar, not aliases of one.
  { en: 'Muhammad ibn Ismail al-Bukhari', forms: ['محمد بن إسماعيل البخاري'] },
  { en: 'Bukhari', forms: ['البخاري'] },
  { en: 'Muslim ibn al-Hajjaj', forms: ['مسلم بن الحجاج'] },
  { en: 'Muslim', forms: ['مسلم'] },
  { en: 'Abu Dawud al-Sijistani', forms: ['أبو داود السجستاني'] },
  { en: 'Muhammad ibn Isa al-Tirmidhi', forms: ['محمد بن عيسى الترمذي'] },
  { en: "Ahmad ibn Shuaib al-Nasa'i", forms: ['أحمد بن شعيب النسائي'] },
  { en: 'Muhammad ibn Yazid Ibn Majah', forms: ['محمد بن يزيد بن ماجه'] },
  { en: 'Abdullah ibn Abd al-Rahman al-Darimi', forms: ['عبد الله بن عبد الرحمن الدارمي'] },
  { en: 'Muhammad ibn Ishaq Ibn Khuzaymah', forms: ['محمد بن إسحاق بن خزيمة', 'ابن خزيمة'] },
  { en: 'Muhammad ibn Hibban al-Busti', forms: ['محمد بن حبان البستي', 'ابن حبان'] },
  { en: 'al-Hakim al-Naysaburi', forms: ['الحاكم النيسابوري'] },
  { en: 'al-Bayhaqi', forms: ['البيهقي'] },
  { en: 'al-Daraqutni', forms: ['الدارقطني'] },
  { en: 'al-Tabarani', forms: ['الطبراني'] },
  { en: 'al-Bazzar', forms: ['البزار'] },
  { en: "Abu Ya'la al-Mawsili", forms: ['أبو يعلى الموصلي'] },
  { en: 'Abd al-Razzaq al-Sanani', forms: ['عبد الرزاق الصنعاني'] },
  { en: 'Ibn Abi Shaybah', forms: ['ابن أبي شيبة'] },
  { en: 'al-Khatib al-Baghdadi', forms: ['الخطيب البغدادي'] },
  { en: 'Ibn ʿAbd al-Barr', forms: ['ابن عبد البر'] },
  { en: 'al-Mizzi', forms: ['المزي'] },
  { en: 'Ibn al-Salah', forms: ['ابن الصلاح'] },
  { en: 'al-Nawawi', forms: ['النووي'] },
  { en: 'Ibn Taymiyyah', forms: ['ابن تيمية'] },
  { en: 'Ibn al-Qayyim', forms: ['ابن القيم'] },
  { en: 'Ibn Kathir', forms: ['ابن كثير'] },
  { en: 'al-Dhahabi', forms: ['الذهبي'] },
  { en: 'Ibn Rajab al-Hanbali', forms: ['ابن رجب الحنبلي'] },
  { en: 'Ibn Hajar al-Asqalani', forms: ['ابن حجر العسقلاني'] },
  { en: 'al-Sakhawi', forms: ['السخاوي'] },
  { en: 'al-Suyuti', forms: ['السيوطي'] },
  { en: 'al-Iraqi', forms: ['العراقي'] },
  { en: 'al-Haythami', forms: ['الهيثمي'] },
  { en: 'al-Manawi', forms: ['المناوي'] },
  { en: "al-Zayla'i", forms: ['الزيلعي'] },
  { en: 'al-Shawkani', forms: ['الشوكاني'] },
  { en: 'Ahmad Shakir', forms: ['أحمد شاكر'] },
  { en: 'Shuaib al-Arnaout', forms: ['شعيب الأرناؤوط'] },
  { en: 'Muhammad Nasir al-Din al-Albani', forms: ['محمد ناصر الدين الألباني'] },
  { en: 'Albani', forms: ['الألباني'] },
];
