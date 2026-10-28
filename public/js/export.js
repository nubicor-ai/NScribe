// Note text, handover sheet, print/PDF and backup. Pure formatting plus a few download helpers.
import { state, bed, statusOf, latestVitals, hasContent } from './store.js';
import { VITAL_DEFS, TEXT_KEYS } from './config.js';
import { fmtTime, hhmm, h } from './util.js';

const L = { cc: 'Chief complaint', hpi: 'History of present illness', pmh: 'Past history', meds: 'Medications', allergies: 'Allergies',
  ix: 'Investigations', imp: 'Impression', plan: 'Treatment and plan', dispo: 'Disposition' };
const SURVEY = [['pa', 'A'], ['pb', 'B'], ['pc', 'C'], ['pd', 'D'], ['pe', 'E']];
const EXAM = [['ex_gen', 'General'], ['ex_cvs', 'CVS'], ['ex_rs', 'RS'], ['ex_abd', 'Abdomen'], ['ex_cns', 'CNS']];
const VLABEL = { hr: 'HR', sbp: 'SBP', dbp: 'DBP', rr: 'RR', spo2: 'SpO2', temp: 'Temp', gcs: 'GCS', rbs: 'RBS' };
const VUNIT = Object.fromEntries(VITAL_DEFS.map((v) => [v.k, v.u]));

export function vitalsLine(vals) {
  const p = [];
  if (vals.hr) p.push('HR ' + vals.hr + ' /min');
  if (vals.sbp || vals.dbp) p.push('BP ' + (vals.sbp || '?') + '/' + (vals.dbp || '?') + ' mmHg');
  if (vals.rr) p.push('RR ' + vals.rr + ' /min');
  if (vals.spo2) p.push('SpO2 ' + vals.spo2 + '%');
  if (vals.temp) p.push('Temp ' + vals.temp + ' °C');
  if (vals.gcs) p.push('GCS ' + vals.gcs + '/15');
  if (vals.rbs) p.push('RBS ' + vals.rbs + ' mg/dL');
  return p.join('  ·  ');
}
/** Every reading with its time, newest first, as {t, src, line}. */
export function vitalsTrend(b) {
  return b.vitalsLog.slice().reverse().map((e) => ({ t: e.t, src: e.src, line: vitalsLine(e) })).filter((x) => x.line);
}
const flat = (b) => { const o = {}; const lv = latestVitals(b); Object.keys(lv).forEach((k) => { o[k] = lv[k].v; }); return o; };

/** Structured note: {title, meta:[], blocks:[{h, lines:[{k?, t}]}]} used by both the screen and the exports. */
export function noteModel(b) {
  const meta = [];
  const demo = [b.patient.age ? b.patient.age + ' y' : '', b.patient.sex].filter(Boolean).join(' ');
  if (demo) meta.push(demo);
  if (b.patient.triage) meta.push('Triage ' + b.patient.triage.toUpperCase());
  if (b.patient.arrival) meta.push(b.patient.arrival);
  if (b.patient.mlc) meta.push('MLC');
  const blocks = [];
  const one = (k) => { if (String(b.f[k] || '').trim()) blocks.push({ h: L[k], lines: [{ t: b.f[k].trim() }] }); };
  one('cc'); one('hpi'); one('pmh'); one('meds');
  blocks.push({ h: 'Allergies', lines: [{ t: String(b.f.allergies || '').trim() || 'Not documented', nd: !String(b.f.allergies || '').trim() }] });
  const vl = vitalsLine(flat(b));
  if (vl) {
    const lv = latestVitals(b), times = Object.values(lv).map((x) => x.t);
    const lines = [{ t: vl, mono: true }];
    if (times.length) lines.push({ t: 'Latest reading ' + hhmm(Math.max(...times)), mono: true, muted: true });
    const trend = vitalsTrend(b).slice(1, 6);
    trend.forEach((x) => lines.push({ t: hhmm(x.t) + '  ' + x.line, mono: true, muted: true }));
    blocks.push({ h: 'Vitals', lines });
  }
  const sv = SURVEY.filter(([k]) => String(b.f[k] || '').trim()).map(([k, n]) => ({ k: n, t: b.f[k].trim() }));
  if (sv.length) blocks.push({ h: 'Primary survey', lines: sv });
  const ex = EXAM.filter(([k]) => String(b.f[k] || '').trim()).map(([k, n]) => ({ k: n, t: b.f[k].trim() }));
  if (ex.length) blocks.push({ h: 'Examination', lines: ex });
  one('ix'); one('imp'); one('plan'); one('dispo');
  const course = b.timeline.filter((e) => ['Reassessment', 'Intervention', 'Posting/Disposition'].includes(e.type));
  if (course.length) blocks.push({ h: 'Course in ED', lines: course.map((e) => ({ k: hhmm(e.t), t: e.type + ': ' + e.text })) });
  const done = ['cc', 'hpi', 'allergies', 'imp', 'plan', 'dispo'].filter((k) => String(b.f[k] || '').trim()).length + (vl ? 1 : 0) + (sv.length ? 1 : 0) + (ex.length ? 1 : 0);
  return { title: 'Emergency department note', bedId: b.id, time: b.createdAt || Date.now(), meta, blocks, done, total: 9 };
}

export function noteText(b) {
  const m = noteModel(b);
  const out = ['EMERGENCY DEPARTMENT NOTE — BED ' + b.id, fmtTime(m.time)];
  if (m.meta.length) out.push(m.meta.join(' | '));
  m.blocks.forEach((bl) => { out.push('', bl.h.toUpperCase()); bl.lines.forEach((ln) => out.push((ln.k ? ln.k + ': ' : '') + ln.t)); });
  out.push('', 'Draft prepared with NScribe. To be verified and signed by the treating clinician.');
  return out.join('\n');
}

function bedHandover(b) {
  const st = statusOf(b), out = [];
  const demo = [b.patient.age ? b.patient.age + ' y' : '', b.patient.sex, b.patient.triage ? 'Triage ' + b.patient.triage : '', b.patient.mlc ? 'MLC' : ''].filter(Boolean).join(' · ');
  out.push('=== ' + b.id + (demo ? '  ' + demo : '') + '  [' + (b.dispoType || (st === 'due' ? 'Reassessment due' : 'Occupied')) + ']');
  if (b.f.cc) out.push('CC: ' + b.f.cc);
  if (b.f.pmh) out.push('PMH: ' + b.f.pmh);
  const vl = vitalsLine(flat(b)); if (vl) out.push('Vitals: ' + vl);
  if (b.f.imp) out.push('Impression: ' + b.f.imp);
  if (b.f.plan) out.push('Plan: ' + b.f.plan);
  if (b.f.dispo) out.push('Disposition: ' + b.f.dispo);
  const last = b.timeline.filter((e) => e.type === 'Reassessment').pop();
  if (last) out.push('Last reassessment ' + hhmm(last.t) + ': ' + last.text);
  out.push('Updated ' + fmtTime(b.updatedAt));
  return out;
}
const occupied = () => state.slots.map((s) => bed(s.id)).filter((b) => b && hasContent(b));

export function handoverText() {
  const occ = occupied();
  const out = ['ED HANDOVER SHEET', fmtTime(Date.now()) + '  ·  ' + occ.length + ' occupied bed' + (occ.length === 1 ? '' : 's'), ''];
  if (!occ.length) out.push('No occupied beds.');
  occ.forEach((b) => out.push(...bedHandover(b), ''));
  out.push('Drafts prepared with NScribe. To be verified by the treating clinician.');
  return out.join('\n');
}

export function download(name, data, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); };
export const downloadNote = (b) => download('ED-note-' + b.id + '-' + stamp() + '.txt', noteText(b));
export const downloadHandover = () => download('ED-handover-' + stamp() + '.txt', handoverText());

/** PDF without a PDF library: fill the print area and open the print dialog; choose "Save as PDF". */
export function printText(title, text) {
  const area = document.getElementById('printarea');
  area.replaceChildren(h('h1', null, title), h('pre', null, text));
  setTimeout(() => window.print(), 50);
}
export function printHandover() {
  const occ = occupied();
  const kids = [h('h1', null, 'ED handover sheet'), h('p', null, fmtTime(Date.now()) + ' · ' + occ.length + ' occupied')];
  occ.forEach((b) => kids.push(h('div', { class: 'pb' }, h('pre', null, bedHandover(b).join('\n')))));
  document.getElementById('printarea').replaceChildren(...kids);
  setTimeout(() => window.print(), 50);
}
export function backupJson() {
  return JSON.stringify({ app: 'nscribe', version: 2, exported: new Date().toISOString(), layout: state.layout,
    beds: state.slots.map((s) => bed(s.id)).filter((b) => b && hasContent(b)) }, null, 1);
}
