// Rule-based, on-device parser: English (or romanised/native Tamil/Hindi) text -> structured note pieces.
// No network, no model. It only copies what was said; it never invents a value. Unsure items are returned in `flags`.
//
// Pipeline: normalise number words -> vitals/patient/background regexes -> symptom dictionary (Tamil/Hindi/English)
// -> sentence rules (investigations, impression, plan, examination) -> disposition -> classify the utterance.

/* ---------- Offline decoder: rules and word lists, no network ---------- */
var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  oru: 1, onnu: 1, rendu: 2, irandu: 2, moonu: 3, munu: 3, naalu: 4, anju: 5, aaru: 6, ezhu: 7, ettu: 8, onbadhu: 9, patthu: 10,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  'ஒரு': 1, 'ரெண்டு': 2, 'இரண்டு': 2, 'மூணு': 3, 'மூன்று': 3, 'நாலு': 4, 'ஐந்து': 5, 'அஞ்சு': 5,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5 };
var UNITS = { hour: ['hours', 'hour', 'hrs', 'hr', 'manineram', 'mani neram', 'manikku', 'ghante', 'ghanta', 'ghanton', 'மணி நேரம', 'மணிநேரம', 'மணி', 'घंटे', 'घंटा'],
  day: ['days', 'day', 'naalaa', 'naala', 'naal', 'dino', 'din', 'நாட்க', 'நாள', 'दिन'],
  week: ['weeks', 'week', 'vaarama', 'vaaram', 'hafte', 'hafta', 'haftey', 'வாரம', 'हफ्ते', 'हफ्ता', 'सप्ताह'],
  month: ['months', 'month', 'maatham', 'madham', 'mahine', 'mahina', 'மாத', 'மாச', 'महीने', 'महीना'],
  minute: ['minutes', 'minute', 'mins', 'min', 'nimidam', 'nimisham', 'நிமிட', 'நிமிஷ', 'मिनट'],
  year: ['years', 'year', 'yrs', 'yr', 'varusham', 'varudam', 'saal', 'வருட', 'வருஷ', 'साल', 'वर्ष'] };

function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
var ASCII = /^[\x00-\x7f]+$/;
// Build one regex from a list of phrases. Latin phrases need word edges; Tamil and Devanagari do not.
// Groups: 1 = Latin hit, 3 = Tamil/Devanagari hit.
function phraseRe(list) {
  var lat = [], nat = [];
  list.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (p) { (ASCII.test(p) ? lat : nat).push(esc(p).replace(/ /g, '\\s+')); });
  return new RegExp('(?:^|[^a-z0-9])(' + (lat.join('|') || '(?!)') + ')(?![a-z0-9])|()(' + (nat.join('|') || '(?!)') + ')', 'g');
}
function matches(re, s) {
  var out = [], m; re.lastIndex = 0;
  while ((m = re.exec(s))) {
    var g = m[1] || m[3] || '';
    var start = m.index + m[0].length - g.length;
    out.push({ i: start, e: start + g.length, t: g });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

var DURE = (function () {
  var nums = Object.keys(NUMW), allU = [], map = {};
  Object.keys(UNITS).forEach(function (u) { UNITS[u].forEach(function (w) { allU.push(w); map[w] = u; }); });
  allU.sort(function (a, b) { return b.length - a.length; });
  var re = new RegExp('(?:^|[^a-z0-9])(\\d+(?:\\.\\d+)?|' + nums.map(esc).join('|') + ')\\s*(' + allU.map(function (w) { return esc(w).replace(/ /g, '\\s*'); }).join('|') + ')(?![a-z])', 'g');
  return { re: re, map: map };
})();
function durations(s) {
  var out = [], m; DURE.re.lastIndex = 0;
  while ((m = DURE.re.exec(s))) {
    var n = /^\d/.test(m[1]) ? parseFloat(m[1]) : NUMW[m[1]];
    var unit = DURE.map[m[2]] || DURE.map[m[2].replace(/\s+/g, ' ')];
    if (!unit) { Object.keys(DURE.map).forEach(function (k) { if (k.replace(/ /g, '') === m[2].replace(/\s+/g, '')) unit = DURE.map[k]; }); }
    if (unit === 'year' && /^\s*-?\s*(?:old|of age)/.test(s.slice(m.index + m[0].length))) continue;
    if (n && unit && n <= 999) out.push({ i: m.index, t: n + ' ' + unit + (n === 1 ? '' : 's') });
  }
  var since = /since\s+(morning|last night|yesterday|evening|afternoon|today)/.exec(s);
  if (since) out.push({ i: since.index, t: 'since ' + since[1] });
  return out;
}

// [english term, english phrases, Tamil phrases, Hindi phrases, needs confirmation]
var SYMPTOMS = [
  ['Chest pain', ['chest pain', 'chest discomfort', 'chest tightness', 'chest heaviness', 'chest pressure', 'pain in the chest', 'pain in my chest', 'pain in chest', 'chest hurts', 'chest is paining', 'pain over the chest', 'pain in left chest'], ['nenju vali', 'nenjuvali', 'nenju valikkudhu', 'நெஞ்சு வலி', 'நெஞ்சுவலி', 'நெஞ்சில் வலி'], ['seene mein dard', 'seene me dard', 'chhati mein dard', 'सीने में दर्द', 'सीने मे दर्द', 'छाती में दर्द']],
  ['Breathlessness', ['breathless', 'breathlessness', 'shortness of breath', 'short of breath', 'dyspnea', 'dyspnoea', 'difficulty breathing', 'difficulty in breathing', 'trouble breathing', 'cannot breathe', 'can\'t breathe', 'breathing problem', 'out of breath', 'breathing difficulty', 'sob'], ['moochu thinaral', 'moochu thinaruthu', 'moochu vaangudhu', 'moochu muttudhu', 'மூச்சு திணறல்', 'மூச்சுத் திணறல்', 'மூச்சு வாங்குது', 'மூச்சு விட'], ['saans phoolna', 'saans phool', 'saans bhi phool', 'saans lene mein', 'saans nahi aa', 'dum phoolna', 'सांस फूल', 'सांस लेने में', 'दम फूल']],
  ['Sweating', ['sweating', 'diaphoresis', 'sweaty', 'sweats'], ['viyarthu', 'viyarkudhu', 'viyarvai', 'வியர்', 'வேர்'], ['paseena', 'pasina', 'पसीना']],
  ['Fever', ['fever', 'pyrexia', 'febrile', 'chills'], ['jwaram', 'kaichal', 'suram', 'காய்ச்சல்', 'ஜுரம்', 'சுரம்'], ['bukhar', 'bukhaar', 'tez bukhar', 'बुखार']],
  ['Cough', ['cough', 'coughing'], ['irumal', 'irumbudhu', 'இருமல்'], ['khansi', 'khasi', 'khaansi', 'खांसी', 'खासी']],
  ['Vomiting', ['vomit', 'vomiting', 'vomited', 'emesis'], ['vandhi', 'vaanthi', 'vandhi edukkudhu', 'வாந்தி'], ['ulti', 'ulti ho', 'उल्टी']],
  ['Nausea', ['nausea', 'nauseous', 'nauseated'], ['kumattal', 'குமட்டல்'], ['ji machlana', 'ji machal', 'जी मिचलाना', 'जी मचल']],
  ['Abdominal pain', ['abdominal pain', 'stomach pain', 'belly pain', 'tummy pain', 'stomach ache', 'pain in the abdomen', 'pain in abdomen', 'pain in the stomach', 'pain in stomach', 'pain in the belly', 'abdominal discomfort'], ['vayiru vali', 'vayiru valikkudhu', 'vayitru vali', 'வயிற்று வலி', 'வயிறு வலி', 'வயிற்றில் வலி'], ['pet dard', 'pet mein dard', 'pet me dard', 'पेट दर्द', 'पेट में दर्द', 'पेट मे दर्द']],
  ['Headache', ['headache', 'head ache', 'pain in the head'], ['thalai vali', 'thalaivali', 'தலைவலி', 'தலை வலி'], ['sir dard', 'sar dard', 'sirdard', 'सिर दर्द', 'सरदर्द', 'सिरदर्द']],
  ['Dizziness', ['dizzy', 'dizziness', 'giddiness', 'vertigo', 'lightheaded'], ['thalai suthal', 'thalai suthudhu', 'தலை சுற்றல்', 'தலைச்சுற்றல்', 'தலை சுத்து'], ['chakkar', 'chakkar aa', 'चक्कर'], true],
  ['Syncope / loss of consciousness', ['syncope', 'fainted', 'faint', 'blackout', 'blacked out', 'loss of consciousness', 'collapsed', 'collapse'], ['mayakkam', 'mayangi', 'மயக்கம்', 'மயங்கி'], ['behosh', 'behoshi', 'बेहोश', 'बेहोशी']],
  ['Palpitations', ['palpitation', 'palpitations', 'heart racing', 'racing heart'], ['padapadappu', 'padapadakkudhu', 'படபடப்பு', 'படபடன்னு'], ['dhadkan', 'dhadkan tez', 'धड़कन', 'धडकन']],
  ['Uneasiness / restlessness', [], [], ['ghabrahat', 'ghabrahat ho', 'घबराहट'], true],
  ['Weakness', ['weakness', 'weak', 'tiredness', 'fatigue'], ['sorvu', 'sorvaa', 'சோர்வு'], ['kamzori', 'kamjori', 'कमजोरी'], true],
  ['Loose stools', ['loose motion', 'loose motions', 'diarrhea', 'diarrhoea', 'loose stools', 'watery stools'], ['bedhi', 'pedhi', 'பேதி'], ['dast', 'दस्त']],
  ['Burning micturition', ['burning micturition', 'dysuria', 'burning urine', 'burning while passing urine'], ['neer erichal', 'neerkadupu', 'நீர் எரிச்சல்', 'சிறுநீர் எரிச்சல்'], ['peshab mein jalan', 'peshab me jalan', 'पेशाब में जलन']],
  ['Back pain', ['back pain', 'backache', 'pain in the back'], ['muthugu vali', 'முதுகு வலி'], ['kamar dard', 'peeth dard', 'कमर दर्द', 'पीठ दर्द']],
  ['Leg swelling', ['leg swelling', 'pedal edema', 'pedal oedema', 'swollen legs', 'swelling of legs'], ['kaal veekkam', 'கால் வீக்கம்'], ['pair mein sujan', 'pairon mein sujan', 'पैरों में सूजन', 'पैर में सूजन']],
  ['Seizure', ['seizure', 'seizures', 'convulsion', 'convulsions', 'fits', 'epileptic fit'], ['valippu', 'வலிப்பு'], ['daura', 'mirgi', 'दौरा', 'मिर्गी']],
  ['Focal weakness / slurred speech', ['slurred speech', 'one side weakness', 'weakness of one side', 'facial droop', 'hemiparesis', 'paralysis'], ['pakkavadham', 'பக்கவாதம்'], ['lakwa', 'लकवा']],
  ['Altered sensorium', ['altered sensorium', 'confused', 'confusion', 'unresponsive', 'drowsy', 'drowsiness'], ['kuzhappam', 'குழப்பம்'], ['bhram', 'भ्रम']],
  ['Trauma / accident', ['accident', 'road traffic', 'rta', 'injury', 'fell down', 'fall from', 'head injury'], ['vibathu', 'viboththu', 'விபத்து'], ['durghatna', 'gir gaya', 'दुर्घटना', 'गिर गया']],
  ['Poisoning / ingestion', ['poisoning', 'poison', 'overdose', 'ingestion', 'snake bite', 'snakebite'], ['vishham', 'visham', 'paambu kadi', 'விஷம்', 'பாம்பு கடி'], ['zeher', 'jahar', 'saanp ne kaata', 'जहर', 'ज़हर', 'सांप']],
  ['Bleeding', ['bleeding', 'haematemesis', 'hematemesis', 'melena', 'blood in stool', 'blood in urine'], ['ratham', 'ரத்தம்', 'இரத்தம்'], ['khoon', 'खून'], true],
  ['Epigastric burning / acidity', ['acidity', 'gas trouble', 'gastric', 'heartburn', 'gas'], ['nenju erichal', 'nenjeri', 'நெஞ்செரிச்சல்'], ['seene mein jalan', 'सीने में जलन'], true]
];
SYMPTOMS = SYMPTOMS.map(function (s) {
  return { en: s[0], check: !!s[4], re: { en: phraseRe(s[1]), ta: phraseRe(s[2]), hi: phraseRe(s[3]) }, has: { en: s[1].length, ta: s[2].length, hi: s[3].length } };
});

var RADIATE = phraseRe(['left arm', 'left hand', 'left shoulder', 'jaw pain', 'radiating to the jaw', 'left kai', 'இடது கை', 'baayein haath', 'bayen haath', 'बाएं हाथ', 'बायें हाथ']);
var NEG_BEFORE = /(?:^|[^a-z])(?:no|denies|denied|without|nil|negative for|not having|no history of|nahi|nahin|nhi)\s+(?:[^\s,.;]+\s+){0,2}$/;
var NEG_AFTER = /^\s*(?:[^\s,.;]+\s+)?(?:illa|illai|illama|illaama|இல்ல|இல்லை|இல்லாம|nahi|nahin|nhi|nai|नहीं|नही)/;
function negated(s, i, e) {
  var before = s.slice(Math.max(0, i - 28), i), after = s.slice(e, e + 26);
  return NEG_BEFORE.test(before) || NEG_AFTER.test(after);
}

var PMH = [
  ['Diabetes mellitus', ['diabetes', 'diabetic', 'dm', 't2dm', 'type 2 dm', 'sakkarai noi', 'sugar patient', 'சர்க்கரை நோய்', 'சுகர்', 'madhumeh', 'मधुमेह']],
  ['Hypertension', ['hypertension', 'hypertensive', 'htn', 'high bp', 'high blood pressure', 'blood pressure problem', 'raised blood pressure', 'bp patient', 'ரத்த அழுத்தம்', 'ucch raktchap', 'उच्च रक्तचाप']],
  ['Coronary artery disease', ['cad', 'ischemic heart disease', 'ischaemic heart disease', 'heart disease', 'previous mi', 'old mi', 'stent', 'cabg', 'ptca', 'bypass surgery']],
  ['Asthma', ['asthma', 'dama', 'ஆஸ்துமா', 'दमा', 'अस्थमा']],
  ['COPD', ['copd']],
  ['Chronic kidney disease', ['ckd', 'kidney disease', 'kidney failure', 'dialysis', 'சிறுநீரக']],
  ['Epilepsy', ['epilepsy', 'epileptic', 'known seizure', 'mirgi', 'मिर्गी']],
  ['Prior stroke', ['previous stroke', 'old stroke', 'cva']],
  ['Hypothyroidism', ['hypothyroid', 'hypothyroidism', 'thyroid', 'தைராய்டு', 'थायराइड']],
  ['Tuberculosis', ['tuberculosis', 'tb treatment', 'on att']]
].map(function (x) { return { t: x[0], re: phraseRe(x[1]) }; });
var DRUGS = ['aspirin', 'ecosprin', 'clopidogrel', 'atorvastatin', 'rosuvastatin', 'metformin', 'glimepiride', 'gliclazide', 'insulin', 'amlodipine', 'telmisartan', 'losartan', 'atenolol', 'metoprolol', 'enalapril', 'ramipril', 'furosemide', 'lasix', 'salbutamol', 'asthalin', 'budesonide', 'paracetamol', 'dolo', 'levothyroxine', 'thyronorm', 'warfarin', 'sorbitrate', 'isosorbide', 'nitroglycerin', 'gtn', 'ondansetron', 'pantoprazole', 'omeprazole', 'phenytoin', 'levetiracetam', 'eptoin'];
var DRUGRE = new RegExp('(?:^|[^a-z0-9])(' + DRUGS.join('|') + ')(?:\\s+(\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|g|units?|iu)))?(?![a-z])', 'g');

function pickNum(s, re, lo, hi, g) {
  var m = re.exec(s); if (!m) return '';
  var v = parseFloat(m[g || 1]);
  return !isNaN(v) && v >= lo && v <= hi ? String(v) : '';
}
var L = '\\s*(?:(?:is|was|of|at|now|currently|around|about|today|has been|came to|came down to|dropped to|rose to|improved to)\\s+)*[:=-]?\\s*';
function extractFields(raw) {
  var s = ' ' + raw.toLowerCase().replace(/(\d)\s+(?:by|over)\s+(\d)/g, '$1/$2').replace(/\bmm\s*hg\b/g, 'mmhg') + ' ';
  var f = {};
  var m = new RegExp('(?:\\bbp\\b|blood pressure|b\\.p\\.?|ரத்த அழுத்தம்)' + L + '(\\d{2,3})\\s*(?:\\/|-|x)\\s*(\\d{2,3})').exec(s) || /(?:^|[^\d\/.])(\d{2,3})\s*\/\s*(\d{2,3})(?![\d\/])/.exec(s);
  if (m && +m[1] >= 50 && +m[1] <= 300 && +m[2] >= 20 && +m[2] <= 200 && +m[1] > +m[2]) { f.sbp = m[1]; f.dbp = m[2]; }
  f.hr = pickNum(s, new RegExp('(?:\\bhr\\b|heart rate|pulse rate|pulse|\\bp\\/r\\b|nadi|நாடி)' + L + '(\\d{2,3})'), 20, 250) || pickNum(s, /(\d{2,3})\s*(?:bpm|beats per minute)/, 20, 250);
  f.rr = pickNum(s, new RegExp('(?:\\brr\\b|resp(?:iratory)? rate|respiration)' + L + '(\\d{1,2})'), 4, 70);
  f.spo2 = pickNum(s, new RegExp('(?:spo2|spo 2|sp o2|o2 sats?|oxygen saturation|saturation|saturating|sats?)' + L + '(\\d{2,3})'), 50, 100) || pickNum(s, /(\d{2,3})\s*%\s*(?:on )?(?:room air|ra\b)/, 50, 100);
  var t = new RegExp('(?:\\btemp(?:erature)?\\b)' + L + '(\\d{2,3}(?:\\.\\d)?)\\s*(?:°|degrees?|deg)?\\s*(f\\b|c\\b|fahrenheit|celsius)?').exec(s);
  if (t) {
    var tv = parseFloat(t[1]), unit = t[2] ? t[2].charAt(0) : (tv > 45 ? 'f' : 'c');
    if (unit === 'f') tv = (tv - 32) * 5 / 9;
    if (tv >= 30 && tv <= 45) f.temp = String(Math.round(tv * 10) / 10);
  }
  var g = new RegExp('\\bgcs' + L + '(\\d{1,2})').exec(s), evm = /\be\s*(\d)\s*v\s*(\d)\s*m\s*(\d)\b/.exec(s);
  if (g && +g[1] >= 3 && +g[1] <= 15) f.gcs = g[1];
  else if (evm) f.gcs = String(+evm[1] + +evm[2] + +evm[3]);
  f.rbs = pickNum(s, new RegExp('(?:\\brbs\\b|\\bgrbs\\b|random blood sugar|random sugar|blood sugar|blood glucose|glucose|\\bcbg\\b|\\bhgt\\b|\\bdxt\\b|sugar level|sugar)' + L + '(\\d{2,3})(?!\\s*[\\/%\\d])'), 20, 700);

  var a = /(\d{1,3})\s*[- ]?\s*(?:years?\s*old|year[- ]old|y\/o|yo\b|vayasu|vayadhu|வயது|வயசு|saal ka|saal ki|साल का|साल की)/.exec(s) || /\bage[d]?\s*(?:is|:)?\s*(\d{1,3})/.exec(s) || /(\d{1,3})(?:m|f)\b/.exec(s);
  if (a && +a[1] >= 1 && +a[1] <= 110) f.age = a[1];
  if (/(?:^|[^a-z])(?:female|woman|lady|girl|aurat|mahila)(?![a-z])|பெண்(?![\u0B80-\u0BFF])|महिला|औरत|लड़की/.test(s) || /(?:^|[^a-z0-9.])\d{1,3}f\b/.test(s)) f.sex = 'F';
  else if (/(?:^|[^a-z])(?:male|man|gentleman|boy|aadmi|purush)(?![a-z])|ஆண்(?![\u0B80-\u0BFF])|पुरुष|आदमी|लड़का/.test(s) || /(?:^|[^a-z0-9.])\d{1,3}m\b/.test(s)) f.sex = 'M';
  var tr = /triage\s*(?:is|:)?\s*(red|orange|yellow|green)|(red|orange|yellow|green)\s*(?:triage|zone|category)/.exec(s);
  if (tr) f.triage = (tr[1] || tr[2]).charAt(0).toUpperCase() + (tr[1] || tr[2]).slice(1);
  if (/(?:^|[^a-z0-9])(?:108|ambulance)(?![a-z])|ஆம்புலன்ஸ்|एम्बुलेंस|एंबुलेंस/.test(s)) f.arrival = '108 ambulance';
  else if (/walk[- ]?in|walked in/.test(s)) f.arrival = 'Walk-in';
  else if (/referred|transferred from/.test(s)) f.arrival = 'Referred';
  if (/\bmlc\b|medico[- ]?legal/.test(s)) f.mlc = true;

  if (/no known (?:drug )?allerg|\bnkda\b|no (?:drug )?allerg|allergy (?:illa|illai|nahi|nahin)|ஒவ்வாமை இல்ல|एलर्जी नहीं/.test(s)) f.allergies = 'No known drug allergies';
  else { var al = /allergic to ([a-z][a-z ,]{2,40}?)(?:[.;\n]|\band\b|$)/.exec(s); if (al) f.allergies = 'Allergic to ' + al[1].trim(); }

  var pm = [];
  PMH.forEach(function (p) { var hit = matches(p.re, s).filter(function (x) { return !negated(s, x.i, x.e); }); if (hit.length) pm.push(p.t); });
  if (pm.length) f.pmh = pm.join(', ');
  var md = [], seen = {};
  // Home medicines only: a drug mentioned in a sentence about something GIVEN or STARTED here belongs to the plan, not the history.
  s.split(/[.\n]+/).forEach(function (sent) {
    if (/\b(given|gave|give|started|start|starting|loading|stat|bolus|inj|injection|infusion|nebuli[sz]\w*|administered|advised|prescribe\w*)\b/.test(sent)) return;
    var dm; DRUGRE.lastIndex = 0;
    while ((dm = DRUGRE.exec(sent))) {
      var nm = dm[1]; if (seen[nm]) continue; seen[nm] = 1;
      md.push(nm.charAt(0).toUpperCase() + nm.slice(1) + (dm[2] ? ' ' + dm[2].replace(/\s+/g, ' ') : ''));
    }
  });
  if (md.length) f.meds = md.join(', ');
  Object.keys(f).forEach(function (k) { if (f[k] === '' || f[k] === undefined) delete f[k]; });
  return f;
}


function hasSymptom(cl) {
  return SYMPTOMS.some((sy) => ['en', 'ta', 'hi'].some((lg) => sy.has[lg] && matches(sy.re[lg], cl).length));
}

/* ---------- Spoken numbers: "one twenty over eighty" -> "120 over 80" ---------- */
const W_ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const W_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const VITAL_CUE = /(?:bp|pressure|hr|pulse|rate|rr|spo2|sat|sats|saturation|gcs|temp|temperature|sugar|rbs|age)\W*(?:is|was|of|at|:|-|=)?\W*$/;
function evalNumberWords(ws) {
  const pt = ws.indexOf('point');
  const intW = pt >= 0 ? ws.slice(0, pt) : ws, decW = pt >= 0 ? ws.slice(pt + 1) : [];
  let int;
  if (intW.length > 1 && intW.every((w) => w in W_ONES && W_ONES[w] < 10)) int = intW.map((w) => W_ONES[w]).join('');
  else {
    let cur = 0, seenH = false, prevUnit = false;
    for (const w of intW) {
      if (w === 'and') continue;
      if (w === 'hundred') { cur = (cur || 1) * 100; seenH = true; prevUnit = false; }
      else if (w in W_TENS) { cur += W_TENS[w]; prevUnit = false; }
      else if (w in W_ONES) {
        const v = W_ONES[w];
        if (prevUnit && !seenH && v >= 10 && cur < 10) cur = cur * 100 + v; // "one twelve" = 112
        else cur += v;
        prevUnit = v < 10 && cur === v;
      }
    }
    // "one twenty": unit followed by a tens word
    const m = /^(\w+)\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+(\w+))?$/.exec(intW.join(' '));
    if (m && m[1] in W_ONES && W_ONES[m[1]] < 10 && W_ONES[m[1]] > 0) cur = W_ONES[m[1]] * 100 + W_TENS[m[2]] + (m[3] in W_ONES ? W_ONES[m[3]] : 0);
    int = String(cur);
  }
  if (decW.length && decW.every((w) => w in W_ONES && W_ONES[w] < 10)) int += '.' + decW.map((w) => W_ONES[w]).join('');
  return int;
}
export function numberWords(text) {
  const toks = text.match(/[A-Za-z]+|\d+(?:\.\d+)?|[^A-Za-z\d]+/g) || [];
  const isNum = (w) => w in W_ONES || w in W_TENS || w === 'hundred';
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].toLowerCase();
    if (!isNum(w) || w === 'oh') { out += toks[i]; continue; }
    const run = [w]; let j = i + 1, last = i;
    while (j < toks.length) {
      const t = toks[j];
      if (/^[\s-]+$/.test(t)) { j++; continue; }
      const lw = t.toLowerCase();
      if (isNum(lw) || lw === 'oh' || (lw === 'and' && run.includes('hundred')) || (lw === 'point' && !run.includes('point'))) { run.push(lw); last = j; j++; continue; }
      break;
    }
    while (run.length && (run[run.length - 1] === 'and' || run[run.length - 1] === 'point' || run[run.length - 1] === 'oh')) { run.pop(); last--; while (last > i && /^[\s-]+$/.test(toks[last])) last--; }
    const val = evalNumberWords(run);
    const single = run.length === 1 && W_ONES[run[0]] < 10;
    if (single && !VITAL_CUE.test(out.toLowerCase().slice(-24))) out += toks.slice(i, last + 1).join('');
    else out += val;
    i = last;
  }
  return out;
}

/* ---------- Disposition ---------- */
const DISPO = [
  { type: 'LAMA', re: /\blama\b|against medical advice|left against/ },
  { type: 'Discharged', re: /\bdischarg(?:e|ed|ing)\b|\bsend home\b|\bsent home\b|\bgo home\b|வீட்டுக்கு அனுப்ப|ghar bhej|घर भेज/ },
  { type: 'Referred', re: /\brefer(?:red|ring)?\b|\bto be referred\b/ },
  { type: 'Posted', re: /\bposted for\b|\bpost(?:ed)? (?:to|for)? ?(?:ot|surgery|operation|theatre|theater)\b|\btaking (?:him|her|patient) to (?:ot|theatre)\b|\bfor (?:emergency )?(?:surgery|laparotomy|operation)\b/ },
  { type: 'Shifted', re: /\bshift(?:ed|ing)? to\b|\btransferr?ed to\b|\badmit(?:ted)? (?:to|in|under)\b|\bshift (?:him|her|patient)\b|icu[- ]?(?:ku|ko)? shift|ward[- ]?(?:ku|ko)? shift/ }
];
export function findDispo(text) {
  const low = text.toLowerCase();
  for (const d of DISPO) {
    const m = d.re.exec(low);
    if (m) {
      const sentence = (low.slice(0, m.index).split(/[.?!\n]/).pop() + low.slice(m.index).split(/[.?!\n]/)[0]).trim();
      const original = text.toLowerCase().indexOf(sentence);
      return { type: d.type, text: (original >= 0 ? text.slice(original, original + sentence.length) : sentence).trim().replace(/^\w/, (c) => c.toUpperCase()) };
    }
  }
  return null;
}

/* ---------- Sentence rules: copy the sentence, never rewrite clinical content ---------- */
const SENT_RULES = [
  ['ix', /\b(ecg|ekg|troponin|trop[- ]?[it]|x-?ray|cxr|ct\b|ct scan|mri|echo\b|echocardiogram|usg|ultrasound|pocus|abg|cbc|lft|rft|kft|electrolytes|creatinine|d-?dimer|blood tests?|labs?|culture|urine routine)\b/],
  ['imp', /\b(impression|diagnosis|diagnosed|provisional|working diagnosis|probably|likely|suspect(?:ed|ing)?|rule out|r\/o|differentials?|consistent with|suggestive of|c\/w|s\/o)\b/],
  ['plan', /\b(start(?:ed)?|give|given|gave|inj(?:ection)?|iv fluids?|nebuli[sz](?:e|ed|ation)|oxygen|o2 (?:started|given|via)|intubat\w+|monitor(?:ing)?|consult|continue|stat dose|loading dose|bolus|infusion|thrombolys\w+|cath lab|plan)\b/],
  ['pa', /\bairway\b/],
  ['pb', /\b(?:breathing (?:is|was|looks)|breathing (?:fast|normal|laboured|labored|effort)|work of breathing|respiratory effort)\b/],
  ['pc', /\b(?:circulation|peripheries|capillary refill|\bcrt\b|cold and clammy|iv access|iv cannula|two cannulas)\b/],
  ['pd', /\b(?:disability|avpu|alert and oriented|pupils (?:are|were))\b/],
  ['pe', /\b(?:exposure|fully exposed|temperature maintained|no external injur\w+)\b/],
  ['ex_rs', /\b(air entry|crepitations?|crackles|wheeze|rhonchi|chest (?:is )?clear|breath sounds)\b/],
  ['ex_cvs', /\b(s1 ?s2|murmurs?|jvp|pedal oedema|pedal edema|heart sounds|peripheral pulses|capillary refill|\bcrt\b)\b/],
  ['ex_abd', /\b(abdomen|guarding|rigidity|tenderness|bowel sounds|hepatomegaly|splenomegaly)\b/],
  ['ex_cns', /\b(power|tone|pupils?|plantars?|reflexes|oriented|disoriented|neck stiffness|focal deficit|facial deviation)\b/],
  ['ex_gen', /\b(pallor|pale|icterus|jaundice|cyanosis|clubbing|lymphadenopathy|in distress)\b/]
];
const INTERVENTION = /\b(given|gave|started|inj(?:ection)?|nebuli[sz]\w*|intubat\w+|oxygen|cpr|defib\w*|shock delivered|bolus|infusion|thrombolys\w+|catheter\w*|ryles|ng tube|suturing|sutured|cannula|iv access|iv fluids?)\b/;

const VITAL_MENTION = {
  hr: /\b(heart rate|pulse|\bhr\b)\b/, sbp: /\b(bp|blood pressure)\b/, rr: /\b(respiratory rate|\brr\b)\b/,
  spo2: /\b(spo2|saturation|sats?)\b/, temp: /\b(temperature|temp)\b/, gcs: /\bgcs\b/, rbs: /\b(rbs|grbs|random sugar|blood sugar)\b/
};

/**
 * Parse one utterance. `text` is the English translation (or typed text), `orig` the original-language transcript if any.
 * Returns pieces for store.applyParse(). Nothing here touches the UI or storage.
 */
export function parseUtterance(text, orig) {
  const both = [text || '', orig && orig !== text ? orig : ''].filter(Boolean).join('\n');
  const norm = numberWords(both);
  const f = extractFields(norm);
  const flags = [];
  const low = norm.toLowerCase();

  // vitals: only keep what was spoken; flag mentions with no usable number
  const vitals = {};
  ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'gcs', 'rbs'].forEach((k) => { if (f[k]) vitals[k] = f[k]; });
  Object.keys(VITAL_MENTION).forEach((k) => {
    if (!vitals[k] && new RegExp(VITAL_MENTION[k].source + '[^.\\n]{0,24}\\d').test(low)) flags.push((k === 'sbp' ? 'BP' : k.toUpperCase()) + ' was mentioned but no usable value was heard. Enter it by hand.');
  });
  const patient = {};
  ['age', 'sex', 'triage', 'arrival'].forEach((k) => { if (f[k]) patient[k] = f[k]; });
  if (f.mlc) patient.mlc = true;

  const sym = scanSymptoms(norm);
  const cc = sym.complaints.map((x) => x.en + (x.duration ? (/^since/.test(x.duration) ? ' ' : ' × ') + x.duration : ''));
  const hpi = [];
  if (sym.symptoms.length) hpi.push('Associated symptoms: ' + sym.symptoms.map((x) => x.en + (x.duration ? ' (' + x.duration + ')' : '')).join(', ') + '.');
  if (sym.negatives.length) hpi.push('Denies: ' + sym.negatives.map((x) => x.en).join(', ') + '.');
  sym.details.forEach((d) => hpi.push(d.en + '.'));
  sym.items.filter((x) => x.check && !x.neg).forEach((x) => flags.push('"' + x.en + '" is an ambiguous word. Confirm what was meant.'));

  const fields = {};
  ['pmh', 'meds', 'allergies'].forEach((k) => { if (f[k]) fields[k] = f[k]; });
  const dispo = findDispo(norm);
  const sentences = norm.split(/(?:[.?!]+\s+|\n+)/).map((x) => x.trim().replace(/[.?!]+$/, '')).filter(Boolean);
  sentences.forEach((snt) => {
    const sl = snt.toLowerCase();
    SENT_RULES.forEach(([k, re]) => {
      if (/^p[a-e]$/.test(k)) { // primary survey: one clause per letter
        snt.split(/,|;|\band\b/).forEach((cl) => { if (re.test(cl.toLowerCase())) { (fields[k] = fields[k] || []); const t = cl.trim(); if (t && !fields[k].includes(t)) fields[k].push(t); } });
        return;
      }
      if (!re.test(sl)) return;
      if (k === 'plan' && /\b(started|starts) (?:\d|on)\b/.test(sl) && false) return;
      (fields[k] = fields[k] || []);
      if (Array.isArray(fields[k]) && !fields[k].includes(snt)) fields[k].push(snt);
    });
  });
  // arrays -> strings only where the store expects strings
  ['pa', 'pb', 'pc', 'pd', 'pe', 'ix', 'imp', 'plan', 'ex_rs', 'ex_cvs', 'ex_abd', 'ex_cns', 'ex_gen'].forEach((k) => { if (Array.isArray(fields[k])) fields[k] = fields[k].join('. ') + '.'; });

  // Anything that matched nothing is kept as spoken in History, so spoken content is never silently dropped.
  const leftovers = [];
  sentences.forEach((snt) => {
    const sl = snt.toLowerCase();
    if (snt.split(/\s+/).length < 4 || SENT_RULES.some(([, re]) => re.test(sl)) || hasSymptom(sl) || findDispo(snt) || Object.keys(extractFields(numberWords(snt))).length) return;
    if (/^(?:ok(?:ay)?|yes|no|right|alright|thank|please|sir|doctor)\b/.test(sl)) return;
    leftovers.push(snt.replace(/^re-?assess(?:ment)?[.:,]?\s*/i, ''));
  });
  leftovers.filter(Boolean).forEach((l) => hpi.push(l + '.'));
  if (leftovers.length) flags.push('Some of what was said did not match a specific column, so it was added to History as spoken. Move it if needed.');

  const kind = {
    reassess: /\bre-?assess(?:ment|ed)?\b/.test(low),
    intervention: INTERVENTION.test(low),
    vitals: Object.keys(vitals).length > 0,
    history: sym.complaints.length + sym.symptoms.length + sym.negatives.length > 0
  };
  return { vitals: kind.vitals ? vitals : null, patient, cc, hpi, fields, dispo, kind, flags, symptoms: sym, text: norm };
}

/** Pick the timeline label. `firstEntry` = the bed had no chief complaint before this. */
export function classify(p, firstEntry) {
  if (p.dispo) return 'Posting/Disposition';
  if (p.kind.reassess) return 'Reassessment';
  if (p.kind.intervention && !(firstEntry && p.kind.history)) return 'Intervention';
  if (firstEntry && (p.kind.history || Object.keys(p.patient).length)) return 'Initial presentation';
  if (p.kind.vitals && !p.kind.history) return 'Vitals update';
  if (firstEntry) return 'Initial presentation';
  return 'Other';
}

/** Symptom scan used by parseUtterance (single utterance, no speaker labels). */
function scanSymptoms(raw) {
  const items = [], details = [];
  raw.split(/\n+/).forEach((line) => {
    line.split(/[.?!]+\s+/).forEach((sent) => {
      const sentLower = sent.toLowerCase();
      const parts = sent.split(/,|;|\bbut\b|\bhowever\b|\baur\b|\bpar\b|\band\b(?=\s+(?:no|not|denies)\b)/i);
      parts.forEach((clause, ci) => {
        const cl = clause.toLowerCase();
        const nxt = parts[ci + 1] ? parts[ci + 1].toLowerCase() : '';
        const nextDur = nxt && !hasSymptom(nxt) ? durations(nxt)[0] : null;
        SYMPTOMS.forEach((sy) => {
          ['en', 'ta', 'hi'].forEach((lg) => {
            if (!sy.has[lg]) return;
            const hit = matches(sy.re[lg], cl)[0]; if (!hit) return;
            const neg = negated(cl, hit.i, hit.e);
            const du = durations(cl)[0] || nextDur;
            items.push({ en: sy.en, neg, duration: neg || !du ? '' : du.t, check: sy.check });
          });
        });
        const rh = matches(RADIATE, cl)[0];
        if (rh && !negated(cl, rh.i, rh.e) && /pain|vali|dard|வலி|दर्द/.test(sentLower)) details.push({ en: 'Radiates to left arm / jaw' });
      });
    });
  });
  const pos = [], negs = [], seenPos = {}, seenNeg = {};
  items.forEach((x) => { if (!x.neg && !seenPos[x.en]) { seenPos[x.en] = 1; pos.push({ ...x }); } });
  items.forEach((x) => {
    if (!x.neg || seenNeg[x.en]) return; seenNeg[x.en] = 1;
    if (seenPos[x.en]) { pos.forEach((p) => { if (p.en === x.en) p.check = true; }); return; }
    negs.push({ en: x.en });
  });
  const timed = pos.filter((x) => x.duration).slice(0, 2);
  const main = timed.length ? timed : pos.slice(0, 1);
  return { complaints: main, symptoms: pos.filter((x) => !main.includes(x)), negatives: negs, details: details.slice(0, 2), items };
}
