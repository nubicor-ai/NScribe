// All screen rendering. Reads the store, never holds patient data of its own.
// The bed workspace is built once per bed switch and then only *refreshed* (so typing is never interrupted).
import { $, h, toast, ask, confirmDlg, fmtTime, hhmm, ago } from './util.js';
import { state, bed, slot, hasContent, statusOf, latestVitals, select, setPatient, setText, setVital, setDispoType, deleteTimelineEntry, clearBed, on, flushSaves } from './store.js';
import { VITAL_DEFS, SECTIONS, SEXES, TRIAGES, ARRIVALS, TRIAGE_COLOR } from './config.js';
import { findDispo } from './parser.js';
import { noteModel, noteText, vitalsTrend, downloadNote, printText } from './export.js';
import * as ASR from './asr.js';

export const ui = { view: '', tab: 'capture', mic: { state: 'idle', msg: '', bed: '' }, cb: {} };
let refs = null;                 // refs into the currently built workspace
const ZLABEL = { empty: 'Empty', occupied: 'Occupied', due: 'Reassessment due', posted: 'Posted / shifted' };

/* ---------- small helpers ---------- */
const pending = (id) => { const c = ASR.counts(id); return c.queued + c.decoding + c.failed + c.needsBed; };
const failedAny = (id) => ASR.counts(id).failed + ASR.counts(id).needsBed > 0;
const demo = (b) => [b.patient.age ? b.patient.age + ' y' : '', b.patient.sex].filter(Boolean).join(' ');
function vitalSev(v, raw) {
  if (raw === '' || raw == null || isNaN(Number(raw))) return null;
  const n = Number(raw);
  if (v.cl != null && (v.strict ? n < v.cl : n <= v.cl)) return { s: 'crit', d: 'lo' };
  if (v.ch != null && n >= v.ch) return { s: 'crit', d: 'hi' };
  if (v.lo != null && n < v.lo) return { s: 'warn', d: 'lo' };
  if (v.hi != null && n > v.hi) return { s: 'warn', d: 'hi' };
  return null;
}
function derived(vals) {
  const hr = parseFloat(vals.hr), sbp = parseFloat(vals.sbp), dbp = parseFloat(vals.dbp), rr = parseFloat(vals.rr), gcs = parseFloat(vals.gcs);
  const out = [];
  if (!isNaN(sbp) && !isNaN(dbp)) { const map = Math.round((sbp + 2 * dbp) / 3); out.push({ t: 'MAP ' + map, s: map < 65 ? 'crit' : '' }); }
  if (!isNaN(hr) && !isNaN(sbp) && sbp > 0) { const si = hr / sbp; out.push({ t: 'Shock index ' + si.toFixed(2), s: si >= 1 ? 'crit' : si >= 0.9 ? 'warn' : '' }); }
  let known = 0, pts = 0;
  if (!isNaN(rr)) { known++; if (rr >= 22) pts++; } if (!isNaN(sbp)) { known++; if (sbp <= 100) pts++; } if (!isNaN(gcs)) { known++; if (gcs < 15) pts++; }
  if (known) out.push({ t: 'qSOFA ' + pts + '/3' + (known < 3 ? ' (' + known + ' entered)' : ''), s: pts >= 2 ? 'crit' : pts === 1 ? 'warn' : '' });
  return out;
}
const flatVitals = (b) => { const o = {}, lv = latestVitals(b); Object.keys(lv).forEach((k) => { o[k] = lv[k].v; }); return o; };
function grow(el) { if (el.tagName !== 'TEXTAREA') return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; }
function setIfIdle(el, val) { if (document.activeElement !== el && el.value !== val) { el.value = val; grow(el); } }

/* ---------- top: pill, zones, chips ---------- */
export function renderModelPill() {
  const m = ASR.model, p = $('#modelpill');
  const map = {
    ready: ['ready', 'Model ready – offline mode'], unloaded: ['ready', 'Model ready – offline mode'],
    loading: ['busy', 'Loading speech model…'], downloading: ['busy', 'Downloading model ' + m.pct + '%'],
    none: ['none', 'Model not downloaded'], error: ['error', 'Model problem – tap']
  };
  const [s, t] = map[m.state] || map.none;
  p.dataset.s = s; p.textContent = t; p.title = m.msg || t;
}
export function renderZones() {
  const nav = $('#zones');
  const occ = (zid) => state.slots.filter((s) => s.zone === zid && hasContent(bed(s.id))).length;
  const tab = (id, label, cnt) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(ui.view === id), onclick: () => setView(id) }, label, cnt != null ? h('span', { class: 'cnt' }, cnt) : null);
  nav.replaceChildren(
    ...state.layout.zones.map((z) => tab(z.id, z.name, occ(z.id) + '/' + state.slots.filter((s) => s.zone === z.id).length)),
    tab('all', 'ALL BEDS', state.slots.filter((s) => hasContent(bed(s.id))).length));
}
export function renderChips() {
  const box = $('#beds');
  if (ui.view === 'all') { box.hidden = true; return; }
  box.hidden = false;
  const z = state.layout.zones.find((x) => x.id === ui.view);
  box.className = 'beds' + (z && z.perBed > 1 ? ' hdu' : '');
  const slots = state.slots.filter((s) => s.zone === ui.view);
  const mk = (s) => {
    const b = bed(s.id), st = statusOf(b);
    const rec = ui.mic.state === 'listening' && ui.mic.bed === s.id;
    const showDot = pending(s.id) > 0 || b.unseen > 0;
    return h('button', { type: 'button', class: 'bchip' + (rec ? ' rec' : ''), 'data-st': st, 'data-bed': s.id, 'aria-pressed': String(state.selected === s.id),
      'aria-label': 'Bed ' + s.id + ', ' + ZLABEL[st] + (showDot ? ', new content' : ''), onclick: () => { select(s.id); } },
      h('b', null, s.id), h('small', null, st === 'empty' ? 'Empty' : (demo(b) || ZLABEL[st])),
      showDot ? h('span', { class: 'dot2' + (failedAny(s.id) ? ' fail' : '') }) : null);
  };
  if (z && z.perBed > 1) {
    const pairs = {}; slots.forEach((s) => { (pairs[s.pairKey] = pairs[s.pairKey] || []).push(s); });
    box.replaceChildren(...Object.values(pairs).map((p) => h('div', { class: 'pair' }, p.map(mk))));
  } else box.replaceChildren(...slots.map(mk));
}
function renderLegend() {
  return h('div', { class: 'legend' }, [['--line', 'Empty'], ['--ok', 'Occupied'], ['--warn', 'Reassessment due'], ['--coral', 'Posted / shifted']].map(([c, t]) => h('span', null, h('i', { style: 'background:var(' + c + ')' }), t)),
    h('span', null, h('i', { style: 'background:var(--coral);border-radius:50%' }), 'New / undecoded'));
}

/* ---------- views ---------- */
export function setView(v) {
  ui.view = v;
  try { localStorage.setItem('nscribe-view', v); } catch (e) { /* optional */ }
  renderAll();
}
export function renderAll() {
  if (!state.ready) return;
  if (!ui.view) { try { ui.view = localStorage.getItem('nscribe-view') || ''; } catch (e) { /* optional */ } }
  const sl = slot(state.selected);
  if (!ui.view || (ui.view !== 'all' && !state.layout.zones.some((z) => z.id === ui.view))) ui.view = sl ? sl.zone : state.layout.zones[0].id;
  renderModelPill(); renderZones(); renderChips(); renderBanner(); renderMic();
  const all = ui.view === 'all';
  $('#overview').hidden = !all; $('#work').hidden = all;
  if (all) renderOverview(); else { if (!refs || refs.id !== state.selected) buildWorkspace(state.selected); refreshWorkspace(); }
}
function renderOverview() {
  const box = $('#overview'), kids = [renderLegend()];
  let any = false;
  state.layout.zones.forEach((z) => {
    const occ = state.slots.filter((s) => s.zone === z.id && hasContent(bed(s.id)));
    if (!occ.length) return; any = true;
    kids.push(h('div', { class: 'ov-zone' }, z.name));
    kids.push(h('div', { class: 'ov-grid' }, occ.map((s) => {
      const b = bed(s.id), st = statusOf(b), fv = flatVitals(b);
      const vit = [];
      VITAL_DEFS.forEach((v) => {
        if (v.k === 'dbp') return;
        let txt = '', raw = fv[v.k];
        if (v.k === 'sbp') { if (fv.sbp || fv.dbp) { txt = 'BP ' + (fv.sbp || '?') + '/' + (fv.dbp || '?'); raw = fv.sbp; } }
        else if (raw) txt = v.l + ' ' + raw;
        if (!txt) return;
        const sev = vitalSev(v, raw);
        vit.push(h('span', { class: sev ? sev.s : '' }, txt), ' · ');
      });
      if (vit.length) vit.pop();
      return h('button', { type: 'button', class: 'ocard', 'data-st': st, 'data-bed': s.id, onclick: () => { select(s.id); setView(s.zone); } },
        h('span', { class: 'r1' }, h('span', { class: 'lbl2' }, s.id), h('span', { class: 'badge ' + st }, b.dispoType || ZLABEL[st]),
          b.patient.triage ? h('span', { class: 'dot', style: 'background:' + TRIAGE_COLOR[b.patient.triage] }) : null,
          pending(s.id) ? h('span', { class: 'badge' }, pending(s.id) + ' pending') : null),
        h('span', { class: 'meta' }, [demo(b), b.patient.mlc ? 'MLC' : ''].filter(Boolean).join(' · ') || ' '),
        h('span', { class: 'cc' }, b.f.cc || b.f.imp || 'No complaint recorded yet'),
        h('span', { class: 'vit' }, vit.length ? vit : 'No vitals yet'),
        h('span', { class: 'upd' }, 'Updated ' + ago(b.updatedAt)));
    })));
  });
  if (!any) kids.push(h('div', { class: 'libempty' }, h('b', null, 'No occupied beds'), 'A bed becomes occupied as soon as you start entering data.'));
  box.replaceChildren(...kids);
}

/* ---------- banner (model download, storage and save warnings) ---------- */
export function renderBanner() {
  const box = $('#banner'), m = ASR.model, kids = [];
  if (m.state === 'none') kids.push(h('div', { class: 'warnbox' }, h('span', { class: 'grow' }, 'Voice needs a one-time download of the speech model. Until then you can still type notes by hand.'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => ui.cb.downloadModel() }, 'Download now'), h('button', { class: 'btn', type: 'button', onclick: () => ui.cb.openSettings('model') }, 'Choose size')));
  if (m.state === 'downloading') kids.push(h('div', { class: 'warnbox' }, h('span', { class: 'grow' }, 'Downloading speech model: ' + m.pct + '%' + (m.msg ? ' (' + m.msg + ')' : '') + '. Keep this page open. This happens only once.'), h('div', { class: 'dlbar' }, h('i', { style: 'width:' + m.pct + '%' }))));
  if (m.state === 'error') kids.push(h('div', { class: 'warnbox err' }, h('span', { class: 'grow' }, m.msg || 'The speech model could not be loaded.'),
    h('button', { class: 'btn', type: 'button', onclick: () => ui.cb.downloadModel() }, 'Try again')));
  if (state.saveError) kids.push(h('div', { class: 'warnbox err' }, state.saveError));
  (ui.warnings || []).forEach((w) => kids.push(h('div', { class: 'warnbox' }, w)));
  box.replaceChildren(...kids);
}

/* ---------- workspace ---------- */
function field(f) {
  const el = f.type === 'area' ? h('textarea', { class: 'fld', id: 'f-' + f.k, rows: '2', placeholder: f.ph }) : h('input', { class: 'fld', id: 'f-' + f.k, placeholder: f.ph, autocomplete: 'off' });
  const tag = h('span', { class: 'tagx' });
  const wrap = h('div', { class: 'field', 'data-k': f.k }, h('label', { for: 'f-' + f.k }, f.l, tag), el);
  el.addEventListener('input', () => {
    grow(el); setText(refs.id, f.k, el.value);
    if (f.k === 'dispo') { const d = findDispo(el.value); setDispoType(refs.id, d ? d.type : ''); }
  });
  if (f.chips) wrap.append(h('div', { class: 'chips below' }, f.chips.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => {
    const b = bed(refs.id), cur = String(b.f[f.k] || '').trim();
    const val = cur ? cur.replace(/[;.]\s*$/, '') + '; ' + c : c;
    setText(refs.id, f.k, val);
    if (f.k === 'dispo') { const d = findDispo(val); setDispoType(refs.id, d ? d.type : ''); }
    refreshWorkspace(); el.focus();
  } }, c))));
  refs.f[f.k] = el; refs.w[f.k] = wrap; refs.tag[f.k] = tag;
  return wrap;
}
function seg(items, key, cls) {
  const box = h('div', { class: 'seg' });
  items.forEach((it) => box.append(h('button', { type: 'button', 'aria-pressed': 'false', 'data-v': it, class: cls ? cls(it) : '', onclick: () => {
    const cur = bed(refs.id).patient[key]; setPatient(refs.id, key, cur === it ? '' : it);
  } }, key === 'triage' ? h('span', { class: 'dot', style: 'background:' + TRIAGE_COLOR[it] }) : null, it)));
  return box;
}

function buildWorkspace(id) {
  const sl = slot(id), work = $('#work');
  refs = { id, f: {}, w: {}, tag: {}, v: {}, vw: {}, vwhen: {}, secCount: [] };
  if (!sl) { work.replaceChildren(h('p', null, 'No bed selected.')); return; }

  const status = h('span', { class: 'badge' });
  const head = h('div', { class: 'whead' }, h('h1', null, sl.id), h('span', { class: 'zn' }, state.layout.zones.find((z) => z.id === sl.zone).name), status,
    h('div', { class: 'acts' },
      h('button', { class: 'btn', type: 'button', onclick: () => copyNote() }, 'Copy note'),
      h('button', { class: 'btn', type: 'button', onclick: () => downloadNote(bed(refs.id)) }, 'Save .txt'),
      h('button', { class: 'btn', type: 'button', onclick: () => printText('Bed ' + refs.id, noteText(bed(refs.id))) }, 'Print / PDF'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => clearFlow(refs.id) }, 'Clear / Discharge')));
  refs.status = status;

  // tabs (phones)
  const tabs = h('div', { class: 'wtabs', role: 'tablist' }, ['capture', 'timeline', 'note'].map((t) => h('button', { type: 'button', role: 'tab', 'data-t': t, 'aria-selected': String(ui.tab === t), onclick: () => { ui.tab = t; applyTab(); } }, t[0].toUpperCase() + t.slice(1))));
  refs.tabs = tabs;

  /* capture column */
  const typed = h('textarea', { class: 'fld', id: 'typed', rows: '3', placeholder: 'Type or paste what you want filed in this bed, for example: 58 M, chest pain 2 hours, BP 90/60, pulse 112. Then tap Add.' });
  const addBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => { const t = typed.value.trim(); if (!t) return; ui.cb.addTyped(refs.id, t); typed.value = ''; } }, 'Add to ' + sl.id);
  const typedCard = h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Type a note', h('span', { class: 'sub' }, 'works without the speech model')),
    h('div', { class: 'body' }, typed, h('div', { class: 'actions' }, addBtn), h('p', { class: 'hint' }, 'Filled by word match, never by guessing. Every auto-filled field is marked so you can check it. Edit anything by hand: your edits are never overwritten.')));

  const patient = h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Patient'),
    h('div', { class: 'body' },
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'age' }, 'Age'), refs.age = h('input', { class: 'fld', id: 'age', inputmode: 'numeric', placeholder: 'years', oninput: (e) => setPatient(refs.id, 'age', e.target.value) })),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Sex'), refs.sex = seg(SEXES, 'sex')),
        h('div', { class: 'field' }, h('label', { for: 'arrival' }, 'Arrival'), refs.arrival = h('select', { class: 'fld', id: 'arrival', onchange: (e) => setPatient(refs.id, 'arrival', e.target.value) }, h('option', { value: '' }, 'Select'), ARRIVALS.map((a) => h('option', null, a))))),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Triage'), refs.triage = seg(TRIAGES, 'triage', (t) => 't-' + t.toLowerCase())),
      h('label', { class: 'toggle' }, refs.mlc = h('input', { type: 'checkbox', onchange: (e) => setPatient(refs.id, 'mlc', e.target.checked) }), 'Medico-legal case (MLC)')));

  const vgrid = h('div', { class: 'vgrid' });
  VITAL_DEFS.forEach((v) => {
    const inp = h('input', { class: 'fld', id: 'v-' + v.k, inputmode: v.mode, autocomplete: 'off', 'aria-label': v.l + ' ' + v.u, onchange: (e) => setVital(refs.id, v.k, e.target.value) });
    const flag = h('span', { class: 'flag', 'aria-hidden': 'true' }), when = h('span', { class: 'when' });
    const wrap = h('div', { class: 'v', 'data-k': v.k }, h('label', { for: 'v-' + v.k }, h('span', null, v.l), h('span', null, flag, h('span', { class: 'unit' }, ' ' + v.u))), inp, when);
    vgrid.append(wrap); refs.v[v.k] = inp; refs.vw[v.k] = wrap; refs.vwhen[v.k] = when;
  });
  refs.derived = h('div', { class: 'derived' }); refs.trend = h('div', { class: 'trend-wrap' });
  const vitals = h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Vitals', h('span', { class: 'sub' }, 'latest on top · adult cut-offs')), h('div', { class: 'body' }, vgrid, refs.derived,
    h('details', null, h('summary', { class: 'hint' }, 'Trend (all readings)'), refs.trend)));

  const sections = SECTIONS.map((sec, i) => {
    const count = h('span', { class: 'count' });
    refs.secCount.push({ el: count, keys: sec.f.map((f) => f.k) });
    return h('details', { class: 'card sec', open: i < 3 }, h('summary', null, h('span', null, sec.t), count), h('div', { class: 'body' }, sec.f.map(field)));
  });
  const capture = h('div', { class: 'col', 'data-col': 'capture' }, typedCard, patient, vitals, sections);

  /* timeline column */
  refs.pend = h('div', null); refs.tl = h('div', { class: 'tl' });
  const timeline = h('div', { class: 'col', 'data-col': 'timeline' },
    h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Voice chunks', h('span', { class: 'sub' }, 'this bed')), h('div', { class: 'body' }, refs.pend)),
    h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Timeline'), h('div', { class: 'body' }, refs.tl)));

  /* note column */
  refs.note = h('div', { class: 'note' }); refs.progress = h('i'); refs.progText = h('span', { class: 'sub' }); refs.missing = h('div', { class: 'missing' });
  const note = h('div', { class: 'col right', 'data-col': 'note' }, h('section', { class: 'card' }, h('h2', { class: 'hd' }, 'Live note', refs.progText), h('div', { class: 'progress', 'aria-hidden': 'true' }, refs.progress),
    refs.note, refs.missing, h('p', { class: 'foot' }, 'Draft for clinician review. It becomes part of the record only after you verify and sign it.')));

  // Desktop shows capture + (timeline over note) side by side; phones show one at a time.
  const left = capture, right = h('div', { class: 'col' }, note, timeline);
  work.replaceChildren(head, tabs, h('div', { class: 'wgrid' }, left, right));
  refs.cols = { capture: left, timeline, note };
  applyTab();
}
function applyTab() {
  if (!refs) return;
  const small = window.matchMedia('(max-width: 899px)').matches;
  refs.tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === ui.tab)));
  Object.entries(refs.cols).forEach(([k, el]) => { el.dataset.active = String(!small || k === ui.tab); });
  if (small) { const right = refs.cols.note.parentElement; right.dataset.active = String(ui.tab !== 'capture'); refs.cols.capture.dataset.active = String(ui.tab === 'capture'); }
  else { refs.cols.note.parentElement.dataset.active = 'true'; }
}
window.addEventListener('resize', () => applyTab());

export function refreshWorkspace() {
  if (!refs || ui.view === 'all') return;
  const b = bed(refs.id); if (!b) return;
  const st = statusOf(b);
  refs.status.className = 'badge ' + st; refs.status.textContent = b.dispoType || ZLABEL[st];
  setIfIdle(refs.age, b.patient.age); refs.arrival.value = b.patient.arrival; refs.mlc.checked = !!b.patient.mlc;
  refs.sex.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(b.patient.sex === x.dataset.v)));
  refs.triage.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(b.patient.triage === x.dataset.v)));

  const lv = latestVitals(b), fv = {};
  VITAL_DEFS.forEach((v) => {
    const cur = lv[v.k], raw = cur ? cur.v : '', w = refs.vw[v.k];
    fv[v.k] = raw; setIfIdle(refs.v[v.k], raw);
    refs.vwhen[v.k].textContent = cur ? hhmm(cur.t) + (cur.src === 'manual' ? ' · typed' : '') : '';
    const sev = vitalSev(v, raw);
    if (sev) { w.dataset.sev = sev.s; w.querySelector('.flag').textContent = (sev.s === 'crit' ? '!' : '') + (sev.d === 'hi' ? '↑' : '↓'); } else { delete w.dataset.sev; w.querySelector('.flag').textContent = ''; }
  });
  refs.derived.replaceChildren(...derived(fv).map((x) => h('span', { class: 'pill ' + x.s }, x.t)));
  const tr = b.vitalsLog.slice().reverse();
  refs.trend.replaceChildren(tr.length ? h('table', { class: 'trend' }, h('tr', null, h('th', null, 'Time'), h('th', null, 'Source'), h('th', null, 'Values')),
    tr.map((e) => h('tr', null, h('td', null, hhmm(e.t)), h('td', null, e.src === 'manual' ? 'typed' : e.src), h('td', null, vitalsTrend({ vitalsLog: [e] })[0].line)))) : h('p', { class: 'hint' }, 'No readings yet.'));

  Object.keys(refs.f).forEach((k) => {
    const el = refs.f[k], val = b.f[k] || '';
    setIfIdle(el, val);
    const auto = !!String(val).trim() && !b.edited[k], ed = !!b.edited[k];
    refs.w[k].classList.toggle('ai', auto);
    refs.tag[k].className = 'tagx' + (ed ? ' ed' : ''); refs.tag[k].textContent = auto ? ' · auto-filled, verify' : ed ? ' · edited' : '';
  });
  refs.secCount.forEach((sc) => { sc.el.textContent = sc.keys.filter((k) => String(b.f[k] || '').trim()).length + '/' + sc.keys.length; });

  // note
  const m = noteModel(b);
  const kids = [h('p', { class: 'title' }, m.title + ' — ' + b.id), h('p', { class: 'meta' }, h('b', null, fmtTime(m.time)), m.meta.map((x) => ['  ·  ', x]))];
  if (!hasContent(b)) kids.push(h('p', { class: 'empty' }, 'Nothing recorded for this bed yet. Speak, or type in the fields.'));
  m.blocks.forEach((bl) => kids.push(h('div', { class: 'nb' }, h('h3', null, bl.h), bl.lines.map((ln) => h('p', { class: (ln.mono ? 'mono ' : '') + (ln.nd ? 'nd ' : '') + (ln.muted ? 'nd' : '') }, ln.k ? h('span', { class: 'k' }, ln.k) : null, ln.t)))));
  refs.note.replaceChildren(...kids);
  refs.progress.style.width = Math.round(m.done / m.total * 100) + '%'; refs.progText.textContent = m.done + ' of ' + m.total + ' sections';

  // timeline
  refs.tl.replaceChildren(...(b.timeline.length ? b.timeline.slice().reverse().map((e) => h('div', { class: 'tl-item', 'data-type': e.type },
    h('div', { class: 'tl-h' }, h('time', null, fmtTime(e.t)), h('span', { class: 'tl-type' }, e.type), e.src === 'typed' ? h('span', { class: 'badge' }, 'typed') : null,
      h('button', { class: 'tl-del', type: 'button', onclick: async () => { if (await confirmDlg('Delete this entry?', 'It is removed from the timeline. Values it filled into fields stay until you edit them.', 'Delete')) deleteTimelineEntry(refs.id, e.id); } }, 'Delete')),
    h('div', { class: 'tl-text' }, e.text),
    e.orig ? h('div', { class: 'tl-orig' }, 'Original: ' + e.orig) : null,
    (e.flags || []).map((f) => h('div', { class: 'tl-flag' }, '⚠ ' + f)),
    e.filled && e.filled.length ? h('div', { class: 'hint' }, 'Filled: ' + e.filled.join(', ')) : null)) : [h('p', { class: 'hint' }, 'Nothing yet. Each spoken or typed update appears here with its time.')]));

  // chunks for this bed
  const mine = [...ASR.chunks.values()].filter((c) => c.bedId === refs.id).sort((a, c) => c.t0 - a.t0);
  const show = mine.filter((c) => c.status !== 'done').concat(mine.filter((c) => c.status === 'done').slice(-3));
  refs.pend.replaceChildren(...(show.length ? show.map((c) => chunkRow(c)) : [h('p', { class: 'hint' }, 'No voice chunks for this bed yet.')]));
  refs.missing.hidden = true;
}
const CS = { queued: 'Queued', decoding: 'Decoding', done: 'Done', failed: 'Failed', 'needs-bed': 'Needs bed' };
export function chunkRow(c, showBed) {
  return h('div', { class: 'cstat' }, showBed ? h('b', null, c.bedId) : null, h('span', { class: 'st ' + c.status }, CS[c.status] || c.status), h('span', { class: 'hint' }, hhmm(c.t0) + ' · ' + Math.round((c.ms || 0) / 1000) + ' s'),
    c.status === 'failed' && c.audio ? h('button', { class: 'btn', type: 'button', onclick: () => ASR.retry(c.id) }, 'Retry') : null,
    c.status === 'failed' || c.status === 'needs-bed' ? h('button', { class: 'btn', type: 'button', onclick: () => ASR.discard(c.id) }, 'Discard') : null,
    c.error ? h('span', { class: 'why' }, c.error) : c.text && c.status === 'done' ? h('span', { class: 'why' }, c.text) : null);
}

/* ---------- actions ---------- */
async function copyNote() {
  const txt = noteText(bed(refs.id));
  try { await navigator.clipboard.writeText(txt); toast('Note copied'); }
  catch (e) { const r = document.createRange(); r.selectNodeContents(refs.note); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Note selected. Press copy on your keyboard.', 'warn'); }
}
export async function clearFlow(id) {
  const b = bed(id), has = hasContent(b), pend = pending(id);
  if (!has && !pend) { toast(id + ' is already empty'); return; }
  const choice = await ask('Clear ' + id + '?', (has ? 'This removes all notes, vitals and the timeline for ' + id + (demo(b) ? ' (' + demo(b) + ')' : '') + '. ' : '') + (pend ? pend + ' unprocessed voice chunk(s) for this bed will be discarded. ' : '') + 'This cannot be undone unless you archive the note first.',
    [{ label: 'Cancel', value: 'cancel' }, { label: 'Clear without saving', value: 'clear', cls: 'danger' }, { label: 'Archive note, then clear', value: 'archive', cls: 'primary' }]);
  if (choice === 'cancel') return;
  const text = choice === 'archive' && has ? noteText(b) : '';
  ASR.discardBed(id);
  await clearBed(id, text);
  toast(id + ' is empty' + (text ? '. Note archived (Settings > Archive).' : ''));
}

/* ---------- mic bar ---------- */
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
export function renderMic() {
  const bar = $('#micbar'); bar.hidden = !state.ready;
  if (!state.ready) return;
  const m = ui.mic, on_ = m.state === 'listening' || m.state === 'recovering' || m.state === 'starting';
  const target = on_ ? (m.bed || state.selected) : state.selected;
  const c = ASR.counts(), mod = ASR.model;
  let sub = '', err = false;
  if (m.msg && !on_) { sub = m.msg; err = true; }
  else if (m.state === 'recovering') sub = m.msg;
  else if (c.decoding || c.queued) sub = (c.decoding ? 'Decoding ' + c.decoding : '') + (c.decoding && c.queued ? ' · ' : '') + (c.queued ? 'Queued ' + c.queued : '');
  else if (mod.state === 'none') sub = 'Speech model not downloaded: type notes by hand, or download it';
  else if (mod.state === 'downloading') sub = 'Downloading speech model ' + mod.pct + '%';
  else if (on_) sub = 'Listening… pauses are cut into chunks automatically';
  else sub = 'Tap the mic and speak. Audio stays on this device.';
  if (c.failed || c.needsBed) { sub += (sub ? ' · ' : '') + (c.failed ? c.failed + ' failed' : '') + (c.needsBed ? ' ' + c.needsBed + ' need a bed' : ''); err = err || false; }
  const btn = h('button', { class: 'micbtn', id: 'micbtn', type: 'button', 'aria-pressed': String(on_), 'aria-label': (on_ ? 'Stop recording' : 'Start recording') + ' for bed ' + target, onclick: () => ui.cb.toggleMic() });
  btn.innerHTML = MIC_SVG + (on_ ? '<span style="font-size:.62rem">STOP</span>' : '');
  const meter = h('div', { class: 'meter' }, h('i'));
  ui.meter = meter;
  const q = c.queued + c.decoding + c.failed + c.needsBed;
  bar.replaceChildren(h('div', { class: 'micin' }, btn,
    h('div', { class: 'mictxt' }, h('div', { class: 'big' }, on_ ? 'Recording → ' : 'Tap to record → ', h('em', null, target)), h('div', { class: 'sub' + (err ? ' err' : ''), id: 'micsub' }, sub), meter),
    h('button', { class: 'qbtn' + (c.failed || c.needsBed ? ' bad' : q ? ' has' : ''), type: 'button', onclick: openQueue }, 'Queue', h('br'), String(q))));
}
export function setLevel(rms, speech) {
  if (!ui.meter) return;
  ui.meter.classList.toggle('speech', !!speech);
  ui.meter.firstChild.style.width = Math.min(100, Math.round(rms * 700)) + '%';
}
export function setMic(s) { ui.mic = { ...ui.mic, ...s }; renderMic(); renderChips(); }

function openQueue() {
  const all = [...ASR.chunks.values()].sort((a, b) => b.t0 - a.t0).slice(0, 30);
  ask('Voice chunks', h('div', null, all.length ? all.map((c) => chunkRow(c, true)) : h('p', null, 'No chunks yet.')), [{ label: 'Close', value: true, cls: 'primary' }]);
}

/* ---------- "which bed?" prompt for ambiguous or unknown spoken beds ---------- */
let asking = false;
export async function promptNeedsBed() {
  if (asking) return; asking = true;
  try {
    for (;;) {
      const next = ASR.needsBed()[0]; if (!next) break;
      const opts = (next.options && next.options.length ? next.options : []).filter((id) => slot(id));
      const buttons = opts.map((id) => ({ label: id, value: id, cls: 'primary' }));
      if (slot(next.bedId) && !opts.includes(next.bedId)) buttons.push({ label: 'Use ' + next.bedId + ' (where it was recorded)', value: next.bedId });
      buttons.push({ label: 'Discard', value: '', cls: 'danger' });
      const pick = await ask('Which bed?', h('div', null, h('p', null, 'The speech included a bed name that could not be matched for certain, so nothing was filed.'), h('p', null, '“' + next.text + '”')), buttons);
      await ui.cb.resolveNeedsBed(next.id, pick);
    }
  } finally { asking = false; }
}

/* ---------- wiring ---------- */
export function initUI(cb) {
  ui.cb = cb;
  $('#settingsbtn').onclick = () => cb.openSettings();
  $('#modelpill').onclick = () => (ASR.model.state === 'none' || ASR.model.state === 'error' ? cb.downloadModel() : cb.openSettings('model'));
  $('#lockbtn').onclick = () => cb.lock();
  on((e) => {
    if (e.type === 'select') { ui.view = ui.view === 'all' ? 'all' : (slot(e.id) || {}).zone || ui.view; ui.tab = 'capture'; if (refs) refs = null; renderAll(); window.scrollTo({ top: 0 }); }
    else if (e.type === 'cleared') { refs = null; renderAll(); }
    else if (e.type === 'bed') { renderZones(); renderChips(); if (ui.view === 'all') renderOverview(); else if (refs && e.id === refs.id) refreshWorkspace(); }
    else if (e.type === 'layout' || e.type === 'ready') { refs = null; renderAll(); }
    else if (e.type === 'settings' || e.type === 'saveerror') { renderBanner(); }
    if (e.type === 'saveerror') { const t = $('#savetext'); $('#savestate').dataset.s = state.saveError ? 'local' : 'saved'; t.textContent = state.saveError || 'Saved on this device'; }
  });
  ASR.onChange(() => { renderModelPill(); renderBanner(); renderMic(); renderChips(); if (ui.view !== 'all') refreshWorkspace(); else renderOverview(); if (ASR.needsBed().length) promptNeedsBed(); });
}
