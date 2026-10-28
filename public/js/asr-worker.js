// On-device speech recognition in a Web Worker (Whisper via transformers.js, WebAssembly). Runs entirely in the browser.
// The page never waits on this file: it posts chunks and gets results tagged with the chunk id.
//
// Messages in : {type:'init', model, host, wasmBase, offlineOnly, threads}
//               {type:'decode', id, audio:Float32Array(16 kHz), lang, keepOriginal}
// Messages out: {type:'status', state:'loading'|'ready'|'error', msg}  {type:'progress', file, loaded, total}
//               {type:'result', id, text, orig}  {type:'error', id, msg}
import { pipeline, env } from '../vendor/transformers.min.js';

let asr = null;
let chain = Promise.resolve();
const LANG = { ta: 'tamil', hi: 'hindi', en: 'english' };
// Whisper tends to invent these on silence or noise. Dropping them is safer than filing them in a patient's note.
const HALLUCINATIONS = /^\s*(?:thanks? for watching[.!]?|thank you(?: so much)?(?: for watching)?[.!]?|you[.!]?|bye[.!]?|\.+|♪.*|\[.*\]|\(.*\)|subtitles? by.*|please subscribe.*)\s*$/i;

function clean(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t || HALLUCINATIONS.test(t)) return '';
  const w = t.toLowerCase().split(' ');
  if (w.length >= 8 && new Set(w).size <= Math.ceil(w.length / 6)) return ''; // "the the the the ..." loops
  return t;
}

async function init(m) {
  try {
    self.postMessage({ type: 'status', state: 'loading', msg: 'Loading speech model…' });
    env.allowLocalModels = true;                                   // optional self-hosted copy under /models/
    env.localModelPath = new URL('../models/', self.location.href).href;
    env.allowRemoteModels = !m.offlineOnly;                         // once downloaded, the network is never touched again
    env.remoteHost = m.host;
    env.useBrowserCache = true;                                     // Cache Storage: survives restarts
    const wasm = env.backends.onnx.wasm;
    wasm.wasmPaths = { mjs: m.wasmBase + 'ort-wasm-simd-threaded.mjs', wasm: m.wasmBase + 'ort-wasm-simd-threaded.wasm' }; // never the CDN
    wasm.numThreads = self.crossOriginIsolated ? m.threads : 1;
    asr = await pipeline('automatic-speech-recognition', m.model, {
      device: 'wasm', dtype: 'q8',
      progress_callback: (p) => { if (p && p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); }
    });
    self.postMessage({ type: 'status', state: 'ready' });
  } catch (e) {
    asr = null;
    self.postMessage({ type: 'status', state: 'error', msg: String((e && e.message) || e) });
  }
}

async function decode(m) {
  if (!asr) throw new Error('Model is not loaded');
  const lang = LANG[m.lang] || null;
  const base = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
  // Task "translate" makes Whisper write English directly from Tamil/Hindi/mixed speech.
  const en = await asr(m.audio, lang === 'english' ? { ...base, task: 'transcribe', language: 'english' } : { ...base, task: 'translate', ...(lang ? { language: lang } : {}) });
  let orig = '';
  if (m.keepOriginal && lang !== 'english') {
    const o = await asr(m.audio, { ...base, task: 'transcribe', ...(lang ? { language: lang } : {}) });
    orig = clean(o && o.text);
  }
  return { text: clean(en && en.text), orig };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { chain = chain.then(() => init(m)); return; }
  if (m.type === 'decode') {
    chain = chain.then(() => decode(m)).then(
      (r) => self.postMessage({ type: 'result', id: m.id, text: r.text, orig: r.orig }),
      (err) => self.postMessage({ type: 'error', id: m.id, msg: String((err && err.message) || err) }));
  }
};
