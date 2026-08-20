// Local book/source dictionary — exact-match only, scoped EXCLUSIVELY to
// the structured Source (المصدر) field (see app.js's resolveLocalNameField
// and the SOURCE VS TAKHRIJ safety test in the milestone report). Never
// applied to Takhrij, hadith text, شرح الحديث, or أصول الحديث — those
// remain dynamic prose translated by the existing Gemini pipeline, exactly
// as required: a book name appearing INSIDE a Takhrij sentence must never
// be locally substituted.
//
// LIVE VERIFICATION (this pass): checked against real Dorar المصدر output
// across 3 live searches. Confirmed EXACT matches with no correction
// needed: صحيح البخاري, صحيح مسلم, صحيح ابن خزيمة, صحيح ابن حبان, المعجم
// الصغير. One live-confirmed short-form correction: "مجمع الزوائد" (without
// the second half of the title) appeared as the real Source value where the
// supplied dataset had the full title "مجمع الزوائد ومنبع الفوائد" — added
// as an alias. All other supplied entries were not observed in the sampled
// results (not an error — Dorar simply didn't surface them in this
// particular sample of searches); they are kept exactly as supplied.
//
// EXPANSION (this pass): two new entries added, both confirmed live as
// real, complete المصدر values — "علل الدارقطني" (seen for a الدارقطني-
// attributed result) and "الصحيح المسند" (Muqbil al-Wadi'i's collection,
// seen for a الوادعي-attributed result). The user's other two suggested
// candidates — "تخريج سنن أبي داود" and "صحيح أبي داود" — were searched for
// but not observed as real المصدر values in this session's sampling; they
// are NOT added, to avoid guessing at an unverified exact form.
//
// EXPANSION 2 (FINAL CORRECTIONS pass): two more new entries, both
// confirmed against Dorar's own canonical book list (get_books_data) AND,
// for لسان الميزان, an actual live Source-field citation this pass
// ("لسان الميزان", 6/303, under ابن حجر العسقلاني) —
//   - "لسان الميزان" → Lisan al-Mizan
//   - "الأحاديث المختارة" → al-Ahadith al-Mukhtarah (Diya al-Din
//     al-Maqdisi's collection; Dorar's book list carries this as a
//     DISTINCT canonical entry, key 95, separate from the shorter
//     "أحاديث مختارة", key 6079 — the "ال" prefix is not decoration, it is
//     part of the exact title, so no alias merge was made between them)
// Also added: "مسند أحمد" as an additional short-form alias on the
// existing "Musnad Ahmad ibn Hanbal" entry — LIVE-CONFIRMED this pass as
// the real bracketed أصول Source value ("[مسند أحمد] (28/ 146 ط
// الرسالة)"), which is short-form only, never carrying "بن حنبل". See
// index.js's lookupUsulSource for the extraction logic that feeds this.
//
// REJECTED this pass: "المعجم الأوسط للطبراني" as a separate canonical
// entry. Checked against Dorar's own book list (get_books_data) — only a
// plain "المعجم الأوسط" exists there (key 16584), no "...للطبراني" variant
// — and checked live across two مصدر searches restricted to
// mohdith:"الطبراني" (زهاء 30 sampled results), neither of which ever
// produced a "المعجم الأوسط للطبراني" Source-field value. Kept as a single
// existing "المعجم الأوسط" entry only; adding a second canonical entry for
// an unverified exact string would risk a permanently-dead/incorrect
// mapping, so it was left out per the "verify before adding" rule.
//
// DICTIONARY EXPANSION pass: nine new entries, each confirmed live as a
// complete, exact المصدر value against a dedicated book-id-scoped Dorar
// search — علل ابن أبي حاتم (15/15), تاريخ الطبري (1/1), صحيح الجامع
// (15/15), الفتاوى الحديثية للوادعي (8/8), أطراف الغرائب (4+, seen across
// multiple independent searches), سؤالات البرقاني للدارقطني (4/4), الكامل
// في الضعفاء (2+), تخريج المسند لشاكر (15/15), الجامع الصغير (3+). None of
// these duplicate or overlap an existing entry — "علل ابن أبي حاتم" is a
// different book from the existing "Ilal al-Daraqutni" (علل الدارقطني);
// "الجامع الصغير" is different from the existing "Jami al-Tirmidhi" (جامع
// الترمذي). "الاعتبار في الناسخ والمنسوخ" was investigated and explicitly
// REJECTED — no matching book id was found and no live occurrence was
// confirmed — so it is deliberately NOT added here.
//
// FINAL V1.0.2 lookup-addition request: "الاستذكار" -> "al-Istidhkar"
// (Ibn ʿAbd al-Barr's Maliki commentary on al-Muwatta). Inspected first —
// no existing entry (under this or any other spelling) matched; added as a
// genuinely new entry, not a duplicate.
export const SOURCES = [
  { en: 'Ilal Ibn Abi Hatim', forms: ['علل ابن أبي حاتم'] },
  { en: 'Tarikh al-Tabari', forms: ['تاريخ الطبري'] },
  { en: 'Sahih al-Jami', forms: ['صحيح الجامع'] },
  { en: "al-Fatawa al-Hadithiyyah by al-Wadi'i", forms: ['الفتاوى الحديثية للوادعي'] },
  { en: "Atraf al-Ghara'ib", forms: ['أطراف الغرائب'] },
  { en: "Su'alat al-Barqani li-al-Daraqutni", forms: ['سؤالات البرقاني للدارقطني'] },
  { en: "al-Kamil fi al-Du'afa", forms: ['الكامل في الضعفاء'] },
  { en: 'Takhrij al-Musnad by Shakir', forms: ['تخريج المسند لشاكر'] },
  { en: 'al-Jami al-Saghir', forms: ['الجامع الصغير'] },
  { en: 'Sahih al-Bukhari', forms: ['صحيح البخاري'] },
  { en: 'Sahih Muslim', forms: ['صحيح مسلم'] },
  { en: 'Ilal al-Daraqutni', forms: ['علل الدارقطني'] },
  { en: 'al-Sahih al-Musnad', forms: ['الصحيح المسند'] },
  { en: 'Sunan Abi Dawud', forms: ['سنن أبي داود'] },
  { en: 'Jami al-Tirmidhi', forms: ['جامع الترمذي'] },
  { en: "Sunan al-Nasa'i", forms: ['سنن النسائي'] },
  { en: 'Sunan Ibn Majah', forms: ['سنن ابن ماجه'] },
  { en: 'Muwatta Malik', forms: ['موطأ مالك'] },
  { en: 'Sunan al-Darimi', forms: ['سنن الدارمي'] },
  { en: 'Musnad Ahmad ibn Hanbal', forms: ['مسند أحمد بن حنبل', 'مسند أحمد'] },
  { en: 'Musannaf Abd al-Razzaq', forms: ['مصنف عبد الرزاق'] },
  { en: 'Musannaf Ibn Abi Shaybah', forms: ['مصنف ابن أبي شيبة'] },
  { en: 'Sahih Ibn Khuzaymah', forms: ['صحيح ابن خزيمة'] },
  { en: 'Sahih Ibn Hibban', forms: ['صحيح ابن حبان'] },
  { en: 'al-Mustadrak ala al-Sahihayn', forms: ['المستدرك على الصحيحين'] },
  { en: 'al-Sunan al-Kubra by al-Bayhaqi', forms: ['السنن الكبرى للبيهقي'] },
  { en: 'Sunan al-Daraqutni', forms: ['سنن الدارقطني'] },
  { en: 'al-Mujam al-Kabir', forms: ['المعجم الكبير'] },
  { en: 'al-Mujam al-Awsat', forms: ['المعجم الأوسط'] },
  { en: 'al-Mujam al-Saghir', forms: ['المعجم الصغير'] },
  { en: "Musnad Abu Ya'la", forms: ['مسند أبي يعلى'] },
  { en: 'Musnad al-Bazzar', forms: ['مسند البزار'] },
  { en: 'Musnad Abi Dawud al-Tayalisi', forms: ['مسند أبي داود الطيالسي'] },
  { en: 'Musnad Ishaq ibn Rahuyah', forms: ['مسند إسحاق بن راهويه'] },
  { en: 'Musnad Abi Awanah', forms: ['مسند أبي عوانة'] },
  { en: 'Shuab al-Iman', forms: ['شعب الإيمان'] },
  { en: 'al-Adab al-Mufrad', forms: ['الأدب المفرد'] },
  { en: 'Riyad al-Salihin', forms: ['رياض الصالحين'] },
  { en: 'Mishkat al-Masabih', forms: ['مشكاة المصابيح'] },
  { en: 'Masabih al-Sunnah', forms: ['مصابيح السنة'] },
  { en: 'al-Targhib wa al-Tarhib', forms: ['الترغيب والترهيب'] },
  { en: 'Bulugh al-Maram min Adillat al-Ahkam', forms: ['بلوغ المرام من أدلة الأحكام'] },
  { en: 'Umdat al-Ahkam', forms: ['عمدة الأحكام'] },
  { en: 'Jami al-Usul fi Ahadith al-Rasul', forms: ['جامع الأصول في أحاديث الرسول'] },
  {
    en: "Majma al-Zawa'id wa Manba al-Fawa'id",
    forms: ['مجمع الزوائد ومنبع الفوائد', 'مجمع الزوائد'],
  },
  { en: 'Nasb al-Rayah li-Ahadith al-Hidayah', forms: ['نصب الراية لأحاديث الهداية'] },
  { en: 'Fath al-Bari Sharh Sahih al-Bukhari', forms: ['فتح الباري شرح صحيح البخاري'] },
  { en: 'Fath al-Bari by Ibn Rajab', forms: ['فتح الباري شرح صحيح البخاري لابن رجب'] },
  { en: 'Sharh al-Nawawi ala Sahih Muslim', forms: ['شرح النووي على صحيح مسلم'] },
  { en: 'Umdat al-Qari Sharh Sahih al-Bukhari', forms: ['عمدة القاري شرح صحيح البخاري'] },
  { en: 'Irshad al-Sari li-Sharh Sahih al-Bukhari', forms: ['إرشاد الساري لشرح صحيح البخاري'] },
  { en: "Awn al-Ma'bud Sharh Sunan Abi Dawud", forms: ['عون المعبود شرح سنن أبي داود'] },
  { en: 'Tuhfat al-Ahwadhi Sharh Jami al-Tirmidhi', forms: ['تحفة الأحوذي بشرح جامع الترمذي'] },
  { en: 'Sharh Sahih al-Bukhari by Ibn Battal', forms: ['شرح صحيح البخاري لابن بطال'] },
  { en: "Jami al-Bayan an Ta'wil Ay al-Quran", forms: ['جامع البيان عن تأويل آي القرآن'] },
  { en: "Ma'alim al-Tanzil", forms: ['معالم التنزيل'] },
  { en: 'Tafsir Ibn Abi Hatim', forms: ['تفسير ابن أبي حاتم'] },
  { en: 'al-Jami li-Ahkam al-Quran', forms: ['الجامع لأحكام القرآن'] },
  { en: 'Tafsir al-Quran al-Azim', forms: ['تفسير القرآن العظيم'] },
  {
    en: 'Taysir al-Karim al-Rahman fi Tafsir Kalam al-Mannan',
    forms: ['تيسير الكريم الرحمن في تفسير كلام المنان'],
  },
  { en: 'al-Tahrir wa al-Tanwir', forms: ['التحرير والتنوير'] },
  { en: 'Lisan al-Mizan', forms: ['لسان الميزان'] },
  { en: 'al-Ahadith al-Mukhtarah', forms: ['الأحاديث المختارة'] },
  { en: 'al-Istidhkar', forms: ['الاستذكار'] },
];
