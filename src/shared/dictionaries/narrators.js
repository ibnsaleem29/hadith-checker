// Local narrator dictionary — canonical identities + aliases, exact-match
// only, scoped to the Narrator (الراوي) field exclusively (see app.js's
// resolveLocalNameField). Never applied to hadith/grading/Takhrij/شرح/أصول
// prose — those always go through the existing Gemini pipeline unchanged.
//
// LIVE VERIFICATION (this pass): checked against real Dorar output across 3
// live searches (~90 individual results: "إنما الأعمال بالنيات", "بني
// الإسلام على خمس", "إنَّ اللهَ وِتْرٌ يُحِبُّ الوِتْرَ"). Findings and the
// resulting corrections below are reported in full in the milestone report
// — summarized here at the point they apply:
//
//   - "عبد الله بن X" vs "عبدالله بن X": BOTH spacings confirmed live for
//     the same narrators (e.g. Ibn Umar, Ibn Abbas, Ibn Masud all appeared
//     both ways). Handled by normalizeArabicValue's targeted "عبد الله" ->
//     "عبدالله" collapse, not by listing every spacing as a separate form.
//   - "ابن عمر" and "ابن مسعود" (bare short forms, no "عبدالله") confirmed
//     live as real narrator-field values — added as aliases. Ibn Umar/Ibn
//     Masud unambiguously mean these two Companions in hadith literature.
//   - "جرير بن عبدالله" (no nisba) confirmed live — added as an alias of
//     the supplied "جرير بن عبد الله البجلي" (same well-known Companion,
//     no ambiguity).
//   - A bare "علي" narrator value was observed once live, but was NOT
//     added as an alias for "علي بن أبي طالب" — a single bare given name
//     is not unambiguous enough on its own to safely commit to one
//     identity; left for Gemini fallback and reported as an open item.
//   - The supplied alternate forms "عائشة بنت أبي بكر أم المؤمنين" and "أم
//     سلمة هند بنت أبي أمية أم المؤمنين" are folded in as aliases of their
//     respective canonical entries, per the supplied note (not verified
//     live this pass, but explicitly instructed as same-identity aliases).
//
// All other 44 canonical identities are exactly the supplied dataset,
// unmodified. No entries were removed or silently reworded.
export const NARRATORS = [
  { en: 'Abu Huraira', forms: ['أبو هريرة'] },
  {
    en: 'Aisha, Mother of the Believers',
    forms: ['عائشة أم المؤمنين', 'عائشة بنت أبي بكر أم المؤمنين'],
  },
  { en: 'Abdullah ibn Umar', forms: ['عبد الله بن عمر', 'ابن عمر'] },
  { en: 'Abdullah ibn Abbas', forms: ['عبد الله بن عباس'] },
  { en: 'Anas ibn Malik', forms: ['أنس بن مالك'] },
  { en: 'Jabir ibn Abdullah', forms: ['جابر بن عبد الله'] },
  { en: 'Abu Said al-Khudri', forms: ['أبو سعيد الخدري'] },
  { en: 'Abdullah ibn Masud', forms: ['عبد الله بن مسعود', 'ابن مسعود'] },
  { en: 'Abdullah ibn Amr ibn al-As', forms: ['عبد الله بن عمرو بن العاص'] },
  { en: 'Abu Musa al-Ashari', forms: ['أبو موسى الأشعري'] },
  { en: 'al-Bara ibn Azib', forms: ['البراء بن عازب'] },
  { en: 'Abu Dharr al-Ghifari', forms: ['أبو ذر الغفاري'] },
  { en: 'Hudhayfah ibn al-Yaman', forms: ['حذيفة بن اليمان'] },
  { en: 'Muadh ibn Jabal', forms: ['معاذ بن جبل'] },
  {
    en: 'Umm Salama, Mother of the Believers',
    forms: ['أم سلمة أم المؤمنين', 'أم سلمة هند بنت أبي أمية أم المؤمنين'],
  },
  { en: 'Abu al-Darda', forms: ['أبو الدرداء'] },
  { en: 'Zayd ibn Thabit', forms: ['زيد بن ثابت'] },
  { en: 'Abu Qatada al-Ansari', forms: ['أبو قتادة الأنصاري'] },
  { en: 'Imran ibn Husayn', forms: ['عمران بن حصين'] },
  { en: 'Abu Umamah al-Bahili', forms: ['أبو أمامة الباهلي'] },
  { en: 'Ubadah ibn al-Samit', forms: ['عبادة بن الصامت'] },
  { en: 'al-Numan ibn Bashir', forms: ['النعمان بن بشير'] },
  {
    en: 'Jarir ibn Abdullah al-Bajali',
    forms: ['جرير بن عبد الله البجلي', 'جرير بن عبدالله'],
  },
  { en: 'Thawban, Freedman of the Messenger of Allah', forms: ['ثوبان مولى رسول الله'] },
  { en: 'Adi ibn Hatim al-Tai', forms: ['عدي بن حاتم الطائي'] },
  { en: 'Uqbah ibn Amir al-Juhani', forms: ['عقبة بن عامر الجهني'] },
  { en: 'Abu Thalaba al-Khushani', forms: ['أبو ثعلبة الخشني'] },
  { en: 'Salman al-Farisi', forms: ['سلمان الفارسي'] },
  { en: "Abu Juhaifa al-Suwa'i", forms: ['أبو جحيفة السوائي'] },
  { en: 'Sahl ibn Sad al-Saidi', forms: ['سهل بن سعد الساعدي'] },
  { en: 'Sad ibn Abi Waqqas', forms: ['سعد بن أبي وقاص'] },
  { en: 'Ali ibn Abi Talib', forms: ['علي بن أبي طالب'] },
  { en: 'Umar ibn al-Khattab', forms: ['عمر بن الخطاب'] },
  { en: 'Abu Bakr al-Siddiq', forms: ['أبو بكر الصديق'] },
  { en: 'Uthman ibn Affan', forms: ['عثمان بن عفان'] },
  {
    en: 'Khadijah bint Khuwaylid, Mother of the Believers',
    forms: ['خديجة بنت خويلد أم المؤمنين'],
  },
  { en: "Sawdah bint Zam'ah, Mother of the Believers", forms: ['سودة بنت زمعة أم المؤمنين'] },
  { en: 'Hafsah bint Umar, Mother of the Believers', forms: ['حفصة بنت عمر أم المؤمنين'] },
  {
    en: 'Zaynab bint Khuzaymah, Mother of the Believers',
    forms: ['زينب بنت خزيمة أم المؤمنين'],
  },
  { en: 'Zaynab bint Jahsh, Mother of the Believers', forms: ['زينب بنت جحش أم المؤمنين'] },
  {
    en: 'Juwayriyyah bint al-Harith, Mother of the Believers',
    forms: ['جويرية بنت الحارث أم المؤمنين'],
  },
  {
    en: 'Umm Habibah Ramlah bint Abi Sufyan, Mother of the Believers',
    forms: ['أم حبيبة رملة بنت أبي سفيان أم المؤمنين'],
  },
  { en: 'Safiyyah bint Huyayy, Mother of the Believers', forms: ['صفية بنت حيي أم المؤمنين'] },
  {
    en: 'Maymunah bint al-Harith, Mother of the Believers',
    forms: ['ميمونة بنت الحارث أم المؤمنين'],
  },
];
