// Boot and wiring: store <-> mic <-> decode queue <-> UI. Nothing here talks to the network except the one-time model download in the worker.
import { $, toast } from './util.js';
import * as Store from './store.js';
import * as ASR from './asr.js';
import { MicCapture } from './vad.js';
import { parseUtterance } from './parser.js';
import { parseBedRoute } from './router.js';
import { initUI, renderAll, setMic, setLevel, ui, promptNeedsBed } from './ui.js';
import { openSettings } from './settings.js';
import { hasPin, showLock } from './lock.js';
import * as DB from './db.js';

const STUB = new URLSearchParams(location.search).has('stub'); // test-only: scripted decoder instead of Whisper
let mic = null;

/* ---------- decoded text -> the right bed ---------- */
async function handleResult(chunk, r) {
  const text = String(r.text || '').trim();
  if (!text) { ASR.markDone(chunk.id, '', ''); return; } // silence or filtered noise: nothing to file
  const route = parseBedRoute(text, Store.state.slots, Store.state.layout.zones);
  let target = chunk.bedId, body = text, orig = r.orig;
  if (route.kind === 'ok') { target = route.bed; body = route.rest; orig = ''; toast('Routed to ' + target); }
  else if (route.kind === 'ambiguous' || route.kind === 'missing') {
    ASR.markNeedsBed(chunk.id, route.options || [], text, r.orig);
    toast('Which bed? "' + route.spoken + '" is ' + (route.kind === 'missing' ? 'not a bed here' : 'unclear'), 'warn');
    return;
  }
  if (!Store.bed(target)) { ASR.markNeedsBed(chunk.id, [], text, r.orig); return; }
  if (!body.trim()) { ASR.markDone(chunk.id, '', ''); return; }
  fileText(target, body, orig, chunk);
  ASR.markDone(chunk.id, body, r.orig);
}
function fileText(target, body, orig, chunk) {
  const p = parseUtterance(body, orig);
  const res = Store.applyParse(target, p, { text: body, orig, chunk: chunk.id, t: chunk.t0, src: 'voice' });
  if (res && (target !== Store.state.selected)) toast(target + ': ' + res.type + (res.filled.length ? ' (' + res.filled.slice(0, 3).join(', ') + ')' : ''));
}
async function resolveNeedsBed(id, pick) {
  const c = ASR.chunks.get(id); if (!c) return;
  if (!pick) { ASR.discard(id); return; }
  const route = parseBedRoute(c.text, Store.state.slots, Store.state.layout.zones);
  const body = route.kind !== 'none' ? route.rest : c.text;
  if (body.trim()) fileText(pick, body, route.kind === 'none' ? c.orig : '', c);
  toast('Filed in ' + pick);
  ASR.markDone(id, body, c.orig);
}
function addTyped(bedId, text) {
  const p = parseUtterance(text, '');
  const res = Store.applyParse(bedId, p, { text, src: 'typed' });
  toast(res ? 'Added to ' + bedId + ': ' + res.type : 'Could not add');
}

/* ---------- mic ---------- */
function toggleMic() {
  if (mic.state === 'listening' || mic.state === 'starting' || mic.state === 'recovering') { mic.stop(); return; }
  mic.start(Store.state.selected, Store.state.settings.wakeLock);
  if (ASR.model.ready[Store.state.settings.model]) ASR.ensureLoaded(false); // warm up so the first chunk decodes at once
}
function downloadModel() { ASR.ensureLoaded(true); }

/* ---------- resource warnings ---------- */
async function checkResources() {
  const w = [];
  const e = await DB.estimate();
  if (e && e.quota && (e.quota - e.usage < 150 * 1048576 || e.usage / e.quota > 0.9)) w.push('Storage on this device is almost full. Export a backup and clear old beds.');
  try {
    const b = navigator.getBattery && await navigator.getBattery();
    if (b && b.level < 0.15 && !b.charging) w.push('Battery is low (' + Math.round(b.level * 100) + '%). Plug in to keep recording.');
  } catch (err) { /* not available */ }
  if (navigator.deviceMemory && navigator.deviceMemory <= 2 && Store.state.settings.model !== 'tiny') w.push('This phone has little memory. If voice stalls, choose the Tiny model in Settings.');
  ui.warnings = w;
  renderAll();
}

/* ---------- boot ---------- */
async function boot() {
  await Store.init();
  ASR.configure({ getSettings: () => Store.state.settings, onResult: handleResult, useStub: STUB });
  await ASR.init();
  mic = new MicCapture({
    onState: (s, msg) => { setMic({ state: s, msg, bed: Store.state.selected }); if (s === 'denied' || s === 'nomic') toast(msg, 'err'); },
    onLevel: (rms, speech) => setLevel(rms, speech),
    onChunk: (c) => ASR.enqueue(c)
  });
  initUI({ toggleMic, openSettings: (f) => openSettings(f, { downloadModel, refreshLock }), downloadModel, addTyped, resolveNeedsBed, lock: () => showLock() });
  const refreshLock = () => { $('#lockbtn').hidden = !hasPin(); };

  Store.on((e) => {
    if (e.type === 'select' && mic) { mic.setBed(e.id); setMic({ bed: e.id }); }       // finalise the running chunk under the OLD bed, continue in the new one
    if (e.type === 'cleared') ASR.discardBed(e.id);
    if (e.type === 'bed') Store.flushSaves().then(() => { $('#savestate').dataset.s = Store.state.saveError ? 'local' : 'saved'; $('#savetext').textContent = Store.state.saveError || 'Saved ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); });
  });
  if (!DB.db.persistent) toast('Private mode: notes will not be kept after you close this tab', 'warn');

  refreshLock();
  await showLock();
  $('#app').hidden = false;
  renderAll();
  if (ASR.needsBed().length) promptNeedsBed();
  checkResources(); setInterval(checkResources, 300000);
  setInterval(() => { if (ui.view !== 'all') { /* due-status ticks */ } renderAll(); }, 60000);
  window.addEventListener('beforeunload', () => { Store.flushSaves(); });
  window.addEventListener('online', () => renderAll()); window.addEventListener('offline', () => renderAll());

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (STUB) window.__nscribe = { Store, ASR, mic, handleResult, fakeChunk: (bedId, hint, hintDelay, ms = 1500) => ASR.enqueue({ bedId, audio: new Float32Array(16 * ms), t0: Date.now() - ms, t1: Date.now(), ms, hint, hintDelay }) };
}
boot().catch((e) => { document.body.prepend(Object.assign(document.createElement('pre'), { textContent: 'NScribe could not start: ' + (e && e.message) })); });
