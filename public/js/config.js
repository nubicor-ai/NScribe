// Single place to change the ED layout and app defaults.
// Edit LAYOUT_DEFAULT here, or use Settings > Beds in the app (the app's choice is saved on the device and wins).

export const LAYOUT_DEFAULT = {
  zones: [
    // count = number of physical beds; perBed = patients that can share one bed (HDU: 2 -> H1A, H1B)
    { id: 'RED', name: 'REDZONE', prefix: 'R', count: 6, perBed: 1 },
    { id: 'HDU', name: 'HDU', prefix: 'H', count: 7, perBed: 2 }
  ]
};

export const SETTINGS_DEFAULT = {
  model: 'base',            // tiny | base | small
  language: 'auto',         // auto | ta | hi | en  (what is being spoken)
  keepOriginal: false,      // also keep the original-language transcript (doubles decode time)
  modelHost: 'https://huggingface.co/', // used ONLY for the one-time model download; no patient data is sent
  reassessMin: 60,          // minutes before a bed shows "Reassessment due"
  idleUnloadMin: 10,        // free model memory after this many idle minutes
  wakeLock: true,
  pinHash: '', pinSalt: ''
};

export const MODELS = {
  tiny:  { id: 'Xenova/whisper-tiny',  label: 'Tiny (~40 MB, fastest, least accurate)' },
  base:  { id: 'Xenova/whisper-base',  label: 'Base (~80 MB, recommended)' },
  small: { id: 'Xenova/whisper-small', label: 'Small (~250 MB, most accurate, slow on phones)' }
};

export const VITAL_KEYS = ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'gcs', 'rbs'];
export const VITAL_DEFS = [
  { k: 'hr', l: 'HR', u: '/min', cl: 40, lo: 50, hi: 100, ch: 140, mode: 'numeric' },
  { k: 'sbp', l: 'SBP', u: 'mmHg', cl: 90, lo: null, hi: 180, ch: null, mode: 'numeric', strict: true },
  { k: 'dbp', l: 'DBP', u: 'mmHg', cl: null, lo: null, hi: 110, ch: null, mode: 'numeric' },
  { k: 'rr', l: 'RR', u: '/min', cl: 8, lo: 10, hi: 22, ch: 30, mode: 'numeric' },
  { k: 'spo2', l: 'SpO2', u: '%', cl: 90, lo: 94, hi: null, ch: null, mode: 'numeric', strict: true },
  { k: 'temp', l: 'Temp', u: '°C', cl: 35, lo: 36, hi: 38, ch: 40, mode: 'decimal' },
  { k: 'gcs', l: 'GCS', u: '/15', cl: 8, lo: 15, hi: null, ch: null, mode: 'numeric' },
  { k: 'rbs', l: 'RBS', u: 'mg/dL', cl: 54, lo: 70, hi: 250, ch: 400, mode: 'numeric' }
];

// Note columns (same as the single-patient app).
export const SECTIONS = [
  { t: 'Presenting complaint', f: [
    { k: 'cc', l: 'Chief complaint', type: 'input', ph: 'Chest pain, 2 hours' },
    { k: 'hpi', l: 'History of present illness', type: 'area', ph: 'Onset, character, radiation, associated symptoms' }
  ] },
  { t: 'Background', f: [
    { k: 'pmh', l: 'Past history', type: 'area', ph: 'Comorbidities, surgeries' },
    { k: 'meds', l: 'Medications', type: 'area', ph: 'Drug, dose, last taken' },
    { k: 'allergies', l: 'Allergies', type: 'input', ph: 'No known drug allergies', chips: ['No known drug allergies'] }
  ] },
  { t: 'Primary survey', f: [
    { k: 'pa', l: 'A · Airway', type: 'input', ph: 'Patent, speaking in sentences', chips: ['Patent, speaking in full sentences', 'Secretions, suctioned', 'At risk, GCS 8 or below'] },
    { k: 'pb', l: 'B · Breathing', type: 'input', ph: 'Air entry, work of breathing', chips: ['Bilateral equal air entry', 'Tachypnoeic, accessory muscle use', 'Wheeze bilaterally'] },
    { k: 'pc', l: 'C · Circulation', type: 'input', ph: 'Pulse, perfusion, access', chips: ['Warm peripheries, CRT under 2 s', 'Cold and clammy, CRT over 3 s', 'IV access ×2 secured'] },
    { k: 'pd', l: 'D · Disability', type: 'input', ph: 'GCS, pupils, glucose', chips: ['GCS 15, pupils equal and reactive', 'No focal deficit', 'Pupils unequal'] },
    { k: 'pe', l: 'E · Exposure', type: 'input', ph: 'Injuries, temperature', chips: ['Fully exposed, no external injury', 'Covered, temperature maintained'] }
  ] },
  { t: 'Examination', f: [
    { k: 'ex_gen', l: 'General', type: 'input', ph: 'Alert, comfortable at rest', chips: ['Alert, comfortable at rest', 'Pallor', 'No icterus, cyanosis or clubbing'] },
    { k: 'ex_cvs', l: 'Cardiovascular', type: 'input', ph: 'Heart sounds, JVP, oedema', chips: ['S1 S2 normal, no murmur', 'JVP not raised, no pedal oedema'] },
    { k: 'ex_rs', l: 'Respiratory', type: 'input', ph: 'Air entry, added sounds', chips: ['Bilateral equal air entry, no added sounds', 'Bilateral crepitations', 'Rhonchi'] },
    { k: 'ex_abd', l: 'Abdomen', type: 'input', ph: 'Tenderness, guarding, organomegaly', chips: ['Soft, non-tender, no guarding', 'Tenderness with guarding'] },
    { k: 'ex_cns', l: 'Neurological', type: 'input', ph: 'Orientation, power, tone', chips: ['Oriented, power 5/5 in all limbs', 'Plantars flexor'] }
  ] },
  { t: 'Work-up and plan', f: [
    { k: 'ix', l: 'Investigations', type: 'area', ph: 'ECG, labs, imaging, POCUS' },
    { k: 'imp', l: 'Impression', type: 'area', ph: 'Working diagnosis, differentials' },
    { k: 'plan', l: 'Treatment and plan', type: 'area', ph: 'Drug, dose, route, time; consults requested' },
    { k: 'dispo', l: 'Disposition', type: 'input', ph: 'Where the patient is going', chips: ['Observation in ED', 'Admitted to ward', 'Admitted to ICU/HDU', 'Referred', 'Discharged', 'LAMA'] }
  ] }
];
export const TEXT_KEYS = SECTIONS.flatMap((s) => s.f.map((f) => f.k));
export const PATIENT_KEYS = ['age', 'sex', 'triage', 'arrival', 'mlc'];
export const SEXES = ['M', 'F', 'Other'];
export const TRIAGES = ['Red', 'Orange', 'Yellow', 'Green'];
export const ARRIVALS = ['Walk-in', '108 ambulance', 'Referred', 'Other'];
export const TRIAGE_COLOR = { Red: '#C62F3B', Orange: '#D2690E', Yellow: '#E8BC1C', Green: '#23834F' };
export const TIMELINE_TYPES = ['Initial presentation', 'Vitals update', 'Reassessment', 'Intervention', 'Posting/Disposition', 'Other'];

/** Expand a layout into the flat, ordered list of slots: [{id, zone, bedNo, letter, pairKey}] */
export function slotsOf(layout) {
  const out = [];
  for (const z of layout.zones) {
    for (let n = 1; n <= z.count; n++) {
      for (let p = 0; p < z.perBed; p++) {
        const letter = z.perBed > 1 ? String.fromCharCode(65 + p) : '';
        out.push({ id: `${z.prefix}${n}${letter}`, zone: z.id, bedNo: n, letter, pairKey: `${z.prefix}${n}` });
      }
    }
  }
  return out;
}
