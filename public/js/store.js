// App state + every bed-changing action. All writes go through save() -> IndexedDB immediately.
// Rules enforced here (not in the UI): auto-fill never overwrites a field the user edited; vitals are never invented;
// every action takes an explicit bed id, so a late result can never land in whichever bed is on screen.
import * as DB from './db.js';
import { LAYOUT_DEFAULT, SETTINGS_DEFAULT, slotsOf, TEXT_KEYS, VITAL_KEYS, PATIENT_KEYS } from './config.js';
import { classify } from './parser.js';
import { uid } from './util.js';

export const state = { layout: null, slots: [], beds: new Map(), settings: { ...SETTINGS_DEFAULT }, selected: '', ready: false, saveError: '' };
const listeners = new Set();
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (evt) => listeners.forEach((fn) => { try { fn(evt); } catch (e) { /* a UI bug must not break saving */ } });

export function blankBed(id, zone) {
  const f = {}; TEXT_KEYS.forEach((k) => { f[k] = ''; });
  return { id, zone, patient: { age: '', sex: '', triage: '', arrival: '', mlc: false }, f, edited: {}, vitalsLog: [], timeline: [],
    dispoType: '', lastAssess: 0, createdAt: 0, updatedAt: 0, unseen: 0 };
}
export const hasContent = (b) =>
  !!(b.patient.age || b.patient.sex || b.patient.triage || b.patient.arrival || b.patient.mlc ||
    TEXT_KEYS.some((k) => String(b.f[k] || '').trim()) || b.vitalsLog.length || b.timeline.length);

/** 'empty' | 'occupied' | 'due' (reassessment overdue) | 'posted' (disposition recorded) */
export function statusOf(b, now = Date.now()) {
  if (!hasContent(b)) return 'empty';
  if (b.dispoType) return 'posted';
  const last = b.lastAssess || b.updatedAt || b.createdAt;
  return now - last > state.settings.reassessMin * 60000 ? 'due' : 'occupied';
}

/** Latest value per vital with its time: {hr:{v:'112',t:...}, ...}. Older readings stay in vitalsLog as the trend. */
export function latestVitals(b) {
  const out = {};
  for (let i = b.vitalsLog.length - 1; i >= 0; i--) {
    const e = b.vitalsLog[i];
    VITAL_KEYS.forEach((k) => { if (e[k] !== undefined && e[k] !== '' && !out[k]) out[k] = { v: e[k], t: e.t, src: e.src }; });
  }
  return out;
}

/* ---------- persistence ---------- */
let saveChain = Promise.resolve();
function save(b) {
  b.updatedAt = Date.now();
  if (!b.createdAt) b.createdAt = b.updatedAt;
  const snap = JSON.parse(JSON.stringify(b));
  saveChain = saveChain.then(() => (hasContent(snap) ? DB.put('beds', snap) : DB.del('beds', snap.id)))
    .then(() => { if (state.saveError) { state.saveError = ''; emit({ type: 'saveerror' }); } })
    .catch((e) => { state.saveError = (e && e.name === 'QuotaExceededError') ? 'Storage is full. Export notes and clear old beds.' : 'Could not save to this device.'; emit({ type: 'saveerror' }); });
  emit({ type: 'bed', id: b.id });
  return saveChain;
}
export const flushSaves = () => saveChain;

export async function init() {
  const saved = await DB.kvGet('settings', null);
  state.settings = { ...SETTINGS_DEFAULT, ...(saved || {}) };
  state.layout = await DB.kvGet('layout', null) || JSON.parse(JSON.stringify(LAYOUT_DEFAULT));
  rebuildSlots();
  const rows = await DB.getAll('beds');
  rows.forEach((r) => { const b = Object.assign(blankBed(r.id, r.zone), r); b.f = Object.assign(blankBed().f, r.f); state.beds.set(b.id, b); });
  // beds saved under slots that no longer exist stay in the database and come back if the layout is restored
  state.slots.forEach((s) => { if (!state.beds.has(s.id)) state.beds.set(s.id, blankBed(s.id, s.zone)); });
  const last = await DB.kvGet('lastBed', '');
  state.selected = state.slots.some((s) => s.id === last) ? last : (state.slots[0] && state.slots[0].id) || '';
  state.ready = true;
  emit({ type: 'ready' });
}
function rebuildSlots() { state.slots = slotsOf(state.layout); }
export const bed = (id) => state.beds.get(id);
export const slot = (id) => state.slots.find((s) => s.id === id);

export function select(id) {
  if (!bed(id)) return;
  state.selected = id;
  const b = bed(id);
  if (b.unseen) { b.unseen = 0; save(b); }
  DB.kvSet('lastBed', id).catch(() => {});
  emit({ type: 'select', id });
}

/* ---------- settings / layout ---------- */
export function setSetting(k, v) {
  state.settings[k] = v;
  DB.kvSet('settings', state.settings).catch(() => {});
  emit({ type: 'settings', key: k });
}
export function setSettings(obj) { Object.assign(state.settings, obj); DB.kvSet('settings', state.settings).catch(() => {}); emit({ type: 'settings' }); }

/** Change bed counts. Refuses to remove a slot that has patient data. Returns {ok} or {ok:false, blocked:[ids]}. */
export function setLayout(layout) {
  const next = slotsOf(layout).map((s) => s.id);
  const blocked = state.slots.filter((s) => !next.includes(s.id) && hasContent(bed(s.id))).map((s) => s.id);
  if (blocked.length) return { ok: false, blocked };
  state.layout = layout;
  DB.kvSet('layout', layout).catch(() => {});
  rebuildSlots();
  state.slots.forEach((s) => { if (!state.beds.has(s.id)) state.beds.set(s.id, blankBed(s.id, s.zone)); });
  if (!slot(state.selected)) state.selected = state.slots[0] ? state.slots[0].id : '';
  emit({ type: 'layout' });
  return { ok: true };
}

/* ---------- manual edits (always win over auto-fill) ---------- */
export function setPatient(id, key, val) {
  const b = bed(id); if (!b) return;
  b.patient[key] = val; b.edited[key] = key === 'mlc' ? !!val : val !== '' && val !== false;
  return save(b);
}
export function setText(id, key, val) {
  const b = bed(id); if (!b) return;
  b.f[key] = val; b.edited[key] = String(val).trim() !== ''; // clearing a field hands it back to auto-fill
  if (key === 'dispo' && !String(val).trim()) b.dispoType = '';
  return save(b);
}
/** A hand-typed vital is a new timestamped reading, so the trend keeps what it replaced. */
export function setVital(id, key, val) {
  const b = bed(id); if (!b) return;
  const now = Date.now(), last = b.vitalsLog[b.vitalsLog.length - 1];
  val = String(val).trim();
  if (last && last.src === 'manual' && now - last.t < 120000 && Object.keys(last).filter((k) => VITAL_KEYS.includes(k)).every((k) => k === key)) {
    if (val === '') b.vitalsLog.pop(); else { last[key] = val; last.t = now; }
  } else if (val !== '') b.vitalsLog.push({ id: uid('v'), t: now, src: 'manual', [key]: val });
  return save(b);
}
export function setDispoType(id, type) {
  const b = bed(id); if (!b) return;
  b.dispoType = type; if (type) b.lastAssess = Date.now();
  return save(b);
}

/* ---------- auto-fill from decoded / typed text ---------- */
const lc = (x) => String(x).toLowerCase();
function appendLine(b, key, text, sep) {
  if (!text || b.edited[key]) return false;
  const cur = String(b.f[key] || '').trim();
  if (cur && lc(cur).includes(lc(text.replace(/[.;]\s*$/, '')))) return false;
  b.f[key] = cur ? cur.replace(/[;,]\s*$/, '') + (sep || '\n') + text : text;
  return true;
}
function mergeList(b, key, text) {
  if (!text || b.edited[key]) return false;
  const have = String(b.f[key] || '').split(/,\s*/).map((x) => x.trim()).filter(Boolean);
  let added = false;
  text.split(/,\s*/).forEach((x) => { if (x && !have.some((h) => lc(h) === lc(x))) { have.push(x); added = true; } });
  if (added) b.f[key] = have.join(', ');
  return added;
}

/**
 * Write one parsed utterance into bed `id`. `meta`: {t, text, orig, chunk, src:'voice'|'typed'}
 * Returns {type, filled:[...]} for the toast.
 */
export function applyParse(id, p, meta) {
  const b = bed(id); if (!b) return null;
  const t = meta.t || Date.now();
  const firstEntry = !b.f.cc.trim() && !b.timeline.some((e) => e.type === 'Initial presentation');
  const type = classify(p, firstEntry);
  const filled = [];

  PATIENT_KEYS.forEach((k) => {
    if (p.patient[k] === undefined || p.patient[k] === '' || b.edited[k]) return;
    if (k === 'mlc') { if (!b.patient.mlc) { b.patient.mlc = true; filled.push('MLC'); } return; }
    if (b.patient[k] !== p.patient[k] && (!b.patient[k] || k === 'triage' || k === 'arrival')) { b.patient[k] = p.patient[k]; filled.push(k); }
  });
  if (p.vitals) {
    b.vitalsLog.push({ id: uid('v'), t, src: meta.src || 'voice', chunk: meta.chunk || '', ...p.vitals });
    filled.push('vitals');
  }
  if (p.cc.length) {
    if (!b.f.cc.trim()) { if (appendLine(b, 'cc', p.cc.join('; '))) filled.push('complaint'); }
    else if (type !== 'Initial presentation') { if (appendLine(b, 'hpi', 'New: ' + p.cc.join('; ') + '.')) filled.push('history'); }
    else if (appendLine(b, 'cc', p.cc.join('; '), '; ')) filled.push('complaint');
  }
  p.hpi.forEach((line) => { if (appendLine(b, 'hpi', line)) filled.push('history'); });
  if (p.fields.pmh && mergeList(b, 'pmh', p.fields.pmh)) filled.push('past history');
  if (p.fields.meds && mergeList(b, 'meds', p.fields.meds)) filled.push('medicines');
  if (p.fields.allergies && !b.edited.allergies && !b.f.allergies) { b.f.allergies = p.fields.allergies; filled.push('allergies'); }
  ['pa', 'pb', 'pc', 'pd', 'pe', 'ix', 'imp', 'plan', 'ex_rs', 'ex_cvs', 'ex_abd', 'ex_cns', 'ex_gen'].forEach((k) => { if (p.fields[k] && appendLine(b, k, p.fields[k])) filled.push(k); });
  if (p.dispo) {
    b.dispoType = p.dispo.type;
    if (!b.edited.dispo) b.f.dispo = p.dispo.text;
    filled.push('disposition');
  }
  if (type !== 'Other') b.lastAssess = t;
  b.timeline.push({ id: uid('t'), t, type, text: meta.text || p.text, orig: meta.orig || '', chunk: meta.chunk || '', src: meta.src || 'voice', flags: p.flags || [], filled: [...new Set(filled)] });
  if (b.id !== state.selected) b.unseen = (b.unseen || 0) + 1;
  save(b);
  return { type, filled: [...new Set(filled)] };
}

/** Save and refresh a bed after an out-of-band change (used by the legacy import). */
export const touchBed = (id) => { const b = bed(id); return b ? save(b) : undefined; };

/** A timeline note with no parsing (used when a chunk could not be placed, or by "Add note"). */
export function addNote(id, text, type = 'Other', extra = {}) {
  const b = bed(id); if (!b) return;
  b.timeline.push({ id: uid('t'), t: Date.now(), type, text, orig: '', chunk: '', src: 'typed', flags: [], filled: [], ...extra });
  return save(b);
}
export function deleteTimelineEntry(id, entryId) {
  const b = bed(id); if (!b) return;
  b.timeline = b.timeline.filter((e) => e.id !== entryId);
  b.vitalsLog = b.vitalsLog.filter((e) => e.id !== entryId);
  return save(b);
}

/** Empty a slot. `archiveText` (if given) is kept in the archive store first. */
export async function clearBed(id, archiveText) {
  const b = bed(id); if (!b) return;
  if (archiveText) await DB.put('archive', { id: uid('a'), bedId: id, t: Date.now(), text: archiveText });
  const fresh = blankBed(id, b.zone);
  state.beds.set(id, fresh);
  saveChain = saveChain.then(() => DB.del('beds', id)).catch(() => {});
  emit({ type: 'cleared', id });
  emit({ type: 'bed', id });
  return saveChain;
}
export const archived = () => DB.getAll('archive').then((r) => r.sort((a, b) => b.t - a.t));
export const deleteArchived = (id) => DB.del('archive', id);
