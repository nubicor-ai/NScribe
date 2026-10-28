// Decode queue + model lifecycle. Talks to the worker; never blocks the UI.
// Bed safety: every chunk carries the bed id it was recorded under. Results are delivered to onResult(chunk, result)
// with that id, so even if the user has moved to another bed, the text goes only to the right one.
import * as DB from './db.js';
import { MODELS } from './config.js';
import { uid } from './util.js';

export const model = { state: 'none', pct: 0, msg: '', ready: {}, name: '' }; // state: none|downloading|loading|ready|unloaded|error
export const chunks = new Map(); // id -> {id,bedId,t0,t1,ms,status,text,orig,error,audio?,options?}
const subs = new Set();
export const onChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const notify = () => subs.forEach((f) => { try { f(); } catch (e) { /* UI errors must not stop decoding */ } });

let worker = null, cfgGetter = null, resultHandler = null, stub = false, maxInFlight = 1, idleTimer = null;
const inflight = new Map();   // id -> {timer}
const finished = new Set();   // ids already delivered, prevents double processing
let files = {}, loadWaiters = [], loadStartedByUser = false;

export function configure({ getSettings, onResult, useStub }) {
  cfgGetter = getSettings; resultHandler = onResult; stub = !!useStub; maxInFlight = stub ? 3 : 1;
}
const S = () => cfgGetter();
const persist = (c) => DB.put('chunks', { ...c }).catch(() => {});

export async function init() {
  model.ready = (await DB.kvGet('modelReady', {})) || {};
  model.name = S().model;
  model.state = model.ready[S().model] ? 'unloaded' : 'none';
  const rows = await DB.getAll('chunks');
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const r of rows) {
    if (r.status === 'done' && r.t1 < cutoff) { DB.del('chunks', r.id); continue; }
    if (r.status === 'decoding') r.status = 'queued';  // the app closed mid-decode: run it again
    chunks.set(r.id, r);
  }
  notify();
  pump();
}

/* ---------- chunks ---------- */
export function enqueue({ bedId, audio, t0, t1, ms, hint, hintDelay }) {
  const c = { id: uid('c'), bedId, t0, t1, ms, status: 'queued', text: '', orig: '', error: '', audio, hint, hintDelay, tries: 0 };
  chunks.set(c.id, c);
  persist(c); // audio is saved before decoding, so a crash cannot lose it
  touchIdle(); notify(); pump();
  return c.id;
}
export function retry(id) { const c = chunks.get(id); if (!c || !c.audio) return; c.status = 'queued'; c.error = ''; persist(c); notify(); pump(); }
export function discard(id) { chunks.delete(id); DB.del('chunks', id).catch(() => {}); notify(); }
export function discardBed(bedId) { [...chunks.values()].filter((c) => c.bedId === bedId && c.status !== 'done').forEach((c) => discard(c.id)); }
export function counts(bedId) {
  const o = { queued: 0, decoding: 0, failed: 0, needsBed: 0 };
  chunks.forEach((c) => {
    if (bedId && c.bedId !== bedId) return;
    if (c.status === 'queued') o.queued++; else if (c.status === 'decoding') o.decoding++; else if (c.status === 'failed') o.failed++; else if (c.status === 'needs-bed') o.needsBed++;
  });
  return o;
}
export const needsBed = () => [...chunks.values()].filter((c) => c.status === 'needs-bed').sort((a, b) => a.t0 - b.t0);
export function markNeedsBed(id, options, text, orig) {
  const c = chunks.get(id); if (!c) return;
  c.status = 'needs-bed'; c.options = options; c.text = text; c.orig = orig || ''; c.audio = undefined; persist(c); notify();
}
export function markDone(id, text, orig) {
  const c = chunks.get(id); if (!c) return;
  c.status = 'done'; c.text = text; c.orig = orig || ''; c.audio = undefined; persist(c); notify();
}

/* ---------- worker / model ---------- */
function spawn() {
  if (worker) return;
  const url = new URL(stub ? './asr-worker-stub.js' : './asr-worker.js', import.meta.url).href;
  worker = new Worker(url, { type: 'module' });
  worker.onmessage = (e) => onWorker(e.data);
  worker.onerror = (e) => { setModelError('The speech engine could not start. ' + (e && e.message ? e.message : '')); };
}
function setModelError(msg) {
  model.state = 'error'; model.msg = msg;
  if (worker) { worker.terminate(); worker = null; }
  inflight.forEach((v, id) => { clearTimeout(v.timer); const c = chunks.get(id); if (c && c.status === 'decoding') { c.status = 'queued'; } });
  inflight.clear();
  loadWaiters.splice(0).forEach((w) => w(false));
  notify();
}
function onWorker(m) {
  if (m.type === 'status') {
    if (m.state === 'ready') {
      model.state = 'ready'; model.msg = ''; model.pct = 100;
      if (!model.ready[model.name]) { model.ready[model.name] = true; DB.kvSet('modelReady', model.ready).catch(() => {}); }
      loadWaiters.splice(0).forEach((w) => w(true));
      notify(); pump();
    } else if (m.state === 'error') setModelError(friendly(m.msg));
    return;
  }
  if (m.type === 'progress') {
    files[m.file] = { loaded: m.loaded, total: m.total };
    let l = 0, t = 0; Object.values(files).forEach((f) => { l += f.loaded || 0; t += f.total || 0; });
    model.state = 'downloading'; model.pct = t ? Math.min(99, Math.round(l / t * 100)) : 0; model.msg = Math.round(l / 1048576) + ' of ' + Math.round(t / 1048576) + ' MB';
    notify(); return;
  }
  if (m.type === 'result' || m.type === 'error') {
    const c = chunks.get(m.id), f = inflight.get(m.id);
    if (f) { clearTimeout(f.timer); inflight.delete(m.id); }
    if (!c || c.status !== 'decoding' || finished.has(m.id)) { pump(); return; } // late or duplicate: ignore
    if (m.type === 'error') { c.status = 'failed'; c.error = m.msg || 'Decoding failed'; persist(c); notify(); pump(); return; }
    finished.add(m.id);
    Promise.resolve(resultHandler(c, { text: m.text || '', orig: m.orig || '' }))
      .catch(() => { c.status = 'failed'; c.error = 'Could not file the result'; persist(c); notify(); })
      .then(() => { notify(); pump(); });
  }
}
function friendly(msg) {
  msg = String(msg || '');
  if (/Failed to fetch|NetworkError|Load failed|offline|fetch/i.test(msg)) return 'The speech model files could not be downloaded. Connect to the internet once and tap Download again.';
  if (/allowRemoteModels|not found locally|local_files_only/i.test(msg)) return 'Model files are missing from this device. Connect to the internet and tap Download to fetch them again.';
  return msg || 'The speech model could not be loaded.';
}

/** Load the model (downloads it the first time). Resolves true when ready. */
export function ensureLoaded(byUser) {
  if (model.state === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    loadWaiters.push(resolve);
    if (worker && (model.state === 'loading' || model.state === 'downloading')) return;
    const s = S(), name = MODELS[s.model] ? s.model : 'base';
    model.name = name; files = {}; model.pct = 0; model.msg = '';
    const offlineOnly = !!model.ready[name];
    if (!offlineOnly && !stub && navigator.onLine === false) { setModelError('No internet. Connect once to download the speech model, then it works offline.'); return; }
    model.state = offlineOnly ? 'loading' : 'downloading'; notify();
    if (byUser && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    spawn();
    worker.postMessage({ type: 'init', model: MODELS[name].id, host: s.modelHost, wasmBase: new URL('../vendor/', import.meta.url).href, offlineOnly, threads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) });
  });
}
/** Throw the loaded model away (changing size, or low memory). The files stay cached. */
export function unload() {
  if (worker) { worker.terminate(); worker = null; }
  inflight.forEach((v, id) => { clearTimeout(v.timer); const c = chunks.get(id); if (c && c.status === 'decoding') c.status = 'queued'; });
  inflight.clear();
  model.state = model.ready[S().model] ? 'unloaded' : 'none'; notify();
}
export function switchModel() { unload(); model.name = S().model; model.state = model.ready[S().model] ? 'unloaded' : 'none'; notify(); }
export const sendScript = (items) => { if (stub) { spawn(); worker.postMessage({ type: 'script', items }); } };

function touchIdle() {
  clearTimeout(idleTimer);
  const min = S().idleUnloadMin;
  if (!min) return;
  idleTimer = setTimeout(() => { if (!inflight.size && !counts().queued && (model.state === 'ready')) unload(); }, min * 60000);
}

/* ---------- pump ---------- */
async function pump() {
  if (pump.busy) { pump.again = true; return; }
  pump.busy = true;
  try {
    do {
      pump.again = false;
      const next = [...chunks.values()].filter((c) => c.status === 'queued').sort((a, b) => a.t0 - b.t0);
      if (!next.length) break;
      if (model.state !== 'ready') {
        if (model.state === 'unloaded' || (model.state === 'none' && stub)) { ensureLoaded(false); }
        break; // waits for the model; chunks stay saved
      }
      for (const c of next) {
        if (inflight.size >= maxInFlight) break;
        if (!c.audio) { c.status = 'failed'; c.error = 'Audio was lost'; persist(c); continue; }
        c.status = 'decoding'; c.tries++; persist({ ...c, audio: c.audio });
        const timer = setTimeout(() => { // a hung decode: fail it and restart the engine
          const x = chunks.get(c.id); if (x && x.status === 'decoding') { x.status = 'failed'; x.error = 'Decoding timed out'; persist(x); }
          inflight.delete(c.id); if (worker) { worker.terminate(); worker = null; } model.state = 'unloaded'; notify(); pump();
        }, 240000);
        inflight.set(c.id, { timer });
        const copy = c.audio.slice(0);
        worker.postMessage({ type: 'decode', id: c.id, audio: copy, lang: S().language, keepOriginal: S().keepOriginal, hint: c.hint, hintDelay: c.hintDelay }, [copy.buffer]);
        touchIdle();
      }
    } while (pump.again);
  } finally { pump.busy = false; notify(); }
}
export const kick = () => pump();
