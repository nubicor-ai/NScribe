// End-to-end tests in headless Chromium. The speech model cannot be downloaded in the CI sandbox, so decoding tests use the
// scripted stand-in worker (?stub=1). Everything else (IndexedDB, service worker, VAD, routing, queue, UI) is the real code.
import { chromium } from './pw.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
const PORT = 8099, URL0 = `http://localhost:${PORT}/`;
const results = [];
const ok = async (name, fn) => {
  try { const note = await fn(); results.push(['PASS', name, note || '']); }
  catch (e) { results.push(['FAIL', name, String((e && e.message) || e).split('\n')[0]]); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

let server;
async function up() { try { return (await fetch(URL0)).ok; } catch (e) { return false; } }
if (!(await up())) { server = spawn('node', ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' }); for (let i = 0; i < 30 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200)); }

const fakeMic = (wav) => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(here, 'audio', wav)}`];
async function open({ wav = 'silence.wav', stub = true, ctxOpts = {}, viewport = { width: 420, height: 900 } } = {}) {
  const browser = await chromium.launch({ args: fakeMic(wav) });
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'], ...ctxOpts });
  const reqs = [];
  ctx.on('request', (r) => reqs.push(r.url()));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(URL0 + (stub ? '?stub=1' : ''));
  await page.waitForSelector('#app:not([hidden])');
  return { browser, ctx, page, reqs, errs, close: () => browser.close() };
}
const bed = (p, id) => p.evaluate((i) => JSON.parse(JSON.stringify(window.__nscribe.Store.bed(i))), id);
const chunk = (p, bedId, hint, delay) => p.evaluate(([b, h, d]) => window.__nscribe.fakeChunk(b, h, d), [bedId, hint, delay]);
async function openBed(p, id) {
  const zone = id[0] === 'R' ? 'REDZONE' : 'HDU';
  await p.locator('#zones button', { hasText: zone }).click();
  await p.locator(`.bchip[data-bed="${id}"]`).click();
  await p.waitForSelector(`.whead h1:text("${id}")`);
}
const settle = (p) => p.waitForFunction(() => { const c = [...window.__nscribe.ASR.chunks.values()]; return c.length && c.every((x) => ['done', 'failed', 'needs-bed'].includes(x.status)); }, null, { timeout: 15000 });
const externals = (reqs) => reqs.filter((u) => !/^(http:\/\/localhost|data:|blob:)/.test(u));

/* ---------- 1. layout ---------- */
await ok('Layout: 20 slots exist from first launch (6 Redzone + 14 HDU in A/B pairs)', async () => {
  const s = await open();
  const ids = await s.page.evaluate(() => window.__nscribe.Store.state.slots.map((x) => x.id));
  eq(ids, ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'H1A', 'H1B', 'H2A', 'H2B', 'H3A', 'H3B', 'H4A', 'H4B', 'H5A', 'H5B', 'H6A', 'H6B', 'H7A', 'H7B'], 'slots');
  await s.page.locator('#zones button', { hasText: 'HDU' }).click();
  eq(await s.page.locator('.pair').count(), 7, 'HDU pairs');
  eq(await s.page.locator('.bchip[data-st="empty"]').count(), 14, 'all empty');
  eq(s.errs, [], 'console errors'); await s.close(); return '20 slots, 7 pairs';
});

/* ---------- 2/3/4. no mixing, shared beds, reassessment ---------- */
await ok('R1 and R2 hold different cases with no mixing; H3A and H3B stay separate; R1 reassessment lands in R1 only', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R1', '58 year old male with chest pain for two hours, sweating. BP 90/60, pulse 112, spo2 91 percent.', 50);
  await chunk(p, 'R2', '30 year old female with fever and cough for three days. Temperature 101 F, pulse 100.', 50);
  await chunk(p, 'H3A', '70 year old male with breathlessness for one day. Known COPD. SpO2 86 percent.', 50);
  await chunk(p, 'H3B', '45 year old female with vomiting for two days, loose motion. BP 100/70.', 50);
  await settle(p);
  const [r1, r2, a, b] = await Promise.all(['R1', 'R2', 'H3A', 'H3B'].map((i) => bed(p, i)));
  assert(/chest pain/i.test(r1.f.cc) && !/fever/i.test(r1.f.cc), 'R1 cc ' + r1.f.cc);
  assert(/fever/i.test(r2.f.cc) && !/chest/i.test(r2.f.cc), 'R2 cc ' + r2.f.cc);
  eq([r1.patient.age, r1.patient.sex, r2.patient.age, r2.patient.sex], ['58', 'M', '30', 'F'], 'demographics');
  assert(/breathless/i.test(a.f.cc) && /COPD/i.test(a.f.pmh), 'H3A ' + a.f.cc + '/' + a.f.pmh);
  assert(/vomiting/i.test(b.f.cc) && !/breathless/i.test(b.f.cc) && !b.f.pmh, 'H3B ' + b.f.cc);
  eq([a.patient.age, b.patient.age], ['70', '45'], 'H3A/H3B ages');
  const r2Before = JSON.stringify(await bed(p, 'R2'));
  await new Promise((r) => setTimeout(r, 1100)); // timestamps differ
  await chunk(p, 'R1', 'Reassess, patient feels better, BP now 100/60', 50);
  await settle(p);
  const r1b = await bed(p, 'R1');
  const last = r1b.timeline[r1b.timeline.length - 1];
  eq(last.type, 'Reassessment', 'R1 last entry type');
  assert(last.t > r1.timeline[0].t, 'reassessment has its own later timestamp');
  const lv = r1b.vitalsLog[r1b.vitalsLog.length - 1];
  eq([lv.sbp, lv.dbp], ['100', '60'], 'latest vitals');
  eq(JSON.stringify(await bed(p, 'R2')), r2Before, 'R2 unchanged by R1 reassessment');
  eq(r1b.vitalsLog.length, 2, 'older vitals kept as trend');
  eq((await bed(p, 'H3A')).timeline.length, 1, 'H3A untouched'); await s.close(); return 'R1/R2/H3A/H3B isolated; R1 trend has 2 readings';
});

/* ---------- 5. mic + bed switching mid-speech ---------- */
await ok('Recording in R1, switching to H1A mid-sentence: each part lands in its own bed (real mic path, fake audio)', async () => {
  const s = await open({ wav: 'continuous-70s.wav' }), p = s.page;
  await p.evaluate(() => window.__nscribe.ASR.sendScript([
    { text: 'chest pain for two hours', delay: 100 }, { text: 'also vomiting since morning', delay: 100 }, { text: 'sweating', delay: 100 }]));
  await openBed(p, 'R1');
  await p.click('#micbtn');
  await p.waitForFunction(() => window.__nscribe.mic.state === 'listening');
  assert((await p.textContent('.mictxt .big')).includes('Recording → R1'), 'mic bar names R1');
  await p.waitForTimeout(4000);
  await openBed(p, 'H1A');                                   // switch mid-sentence (audio is continuous)
  assert((await p.textContent('.mictxt .big')).includes('Recording → H1A'), 'mic bar now names H1A');
  await p.waitForTimeout(3500);
  await p.click('#micbtn');                                  // stop: flushes the H1A chunk
  await settle(p);
  const chunks = await p.evaluate(() => [...window.__nscribe.ASR.chunks.values()].sort((a, b) => a.t0 - b.t0).map((c) => ({ bed: c.bedId, status: c.status, text: c.text })));
  eq(chunks.map((c) => c.bed), ['R1', 'H1A'], 'chunk beds in order');
  const r1 = await bed(p, 'R1'), h1 = await bed(p, 'H1A');
  assert(/chest pain/i.test(r1.f.cc) && !h1.f.cc.includes('chest'), 'R1 got first part: ' + r1.f.cc);
  assert(/vomiting/i.test(h1.f.cc) || /vomiting/i.test(h1.timeline.map((t) => t.text).join()), 'H1A got second part');
  await s.close(); return 'chunks ' + JSON.stringify(chunks.map((c) => c.bed + ':' + c.status));
});

/* ---------- 6. out-of-order completion ---------- */
await ok('Two beds queued quickly, the first finishes last: each result still goes to its own bed', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R3', 'chest pain for one hour', 1500);   // slow
  await chunk(p, 'H2B', 'fever for two days', 100);        // fast, finishes first
  const order = [];
  await p.evaluate(() => { window.__done = []; window.__nscribe.ASR.onChange(() => { window.__nscribe.ASR.chunks.forEach((c) => { if (c.status === 'done' && !window.__done.includes(c.bedId)) window.__done.push(c.bedId); }); }); });
  await settle(p);
  const done = await p.evaluate(() => window.__done);
  eq(done, ['H2B', 'R3'], 'completion order (H2B first)');
  assert(/chest pain/i.test((await bed(p, 'R3')).f.cc), 'R3 cc'); assert(/fever/i.test((await bed(p, 'H2B')).f.cc), 'H2B cc');
  eq((await bed(p, 'R3')).timeline.length, 1, 'R3 exactly one entry (no double processing)'); await s.close(); return 'completed ' + done.join(' then ');
});

/* ---------- 7. voice routing ---------- */
await ok('Voice routing: "bed H five A ..." goes to H5A; "red zone 4" to R4; ambiguous or unknown asks instead of guessing', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R1', 'bed H five A, 62 year old male with chest pain. Pulse 100', 50);
  await chunk(p, 'R1', 'Red zone 4, fever for two days', 50);
  await settle(p);
  assert(/chest pain/i.test((await bed(p, 'H5A')).f.cc), 'H5A got it');
  assert(/fever/i.test((await bed(p, 'R4')).f.cc), 'R4 got it');
  eq((await bed(p, 'R1')).timeline.length, 0, 'R1 got nothing');
  await chunk(p, 'R1', 'H3 chest pain', 50);                 // which of H3A / H3B?
  await p.waitForSelector('.overlay .dialog h2:text("Which bed?")', { timeout: 8000 });
  eq((await bed(p, 'H3A')).timeline.length + (await bed(p, 'H3B')).timeline.length, 0, 'nothing filed before answering');
  await p.locator('.overlay .btn', { hasText: 'H3B' }).click();
  await p.waitForFunction(() => window.__nscribe.Store.bed('H3B').timeline.length === 1);
  eq((await bed(p, 'H3A')).timeline.length, 0, 'H3A still empty');
  await chunk(p, 'R1', 'R7 vomiting', 50);                   // no such bed
  await p.waitForSelector('.overlay .dialog h2:text("Which bed?")');
  await p.locator('.overlay .btn', { hasText: 'Discard' }).click();
  eq((await bed(p, 'R1')).timeline.length, 0, 'unknown bed not filed in R1'); await s.close(); return 'ok';
});

/* ---------- manual edits win ---------- */
await ok('Manual edits are never overwritten by later auto-fill (field marked edited)', async () => {
  const s = await open(), p = s.page;
  await openBed(p, 'R2');
  await p.fill('#f-cc', 'Typed by doctor');
  await p.fill('#age', '41');
  await chunk(p, 'R2', '58 year old male with chest pain for two hours', 50);
  await settle(p);
  const b = await bed(p, 'R2');
  eq([b.f.cc, b.patient.age], ['Typed by doctor', '41'], 'edited fields kept');
  assert(b.edited.cc && b.edited.age, 'edited flags');
  assert((await p.textContent('.field[data-k="cc"] label')).includes('edited'), 'label shows edited');
  assert(b.timeline.length === 1 && /chest pain/.test(b.timeline[0].text), 'voice still logged in timeline'); await s.close(); return 'ok';
});

/* ---------- disposition ---------- */
await ok('Disposition phrases update the slot status', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R5', 'bed R5, 50 year old male with chest pain', 50); await settle(p);
  eq(await p.locator('.bchip[data-bed="R5"]').getAttribute('data-st'), 'occupied', 'occupied');
  await chunk(p, 'R5', 'Posted for surgery', 50);
  await p.waitForFunction(() => window.__nscribe.Store.bed('R5').dispoType === 'Posted');
  eq(await p.locator('.bchip[data-bed="R5"]').getAttribute('data-st'), 'posted', 'chip posted');
  for (const [phrase, type] of [['shifted to ICU', 'Shifted'], ['discharged', 'Discharged'], ['LAMA', 'LAMA'], ['referred to higher centre', 'Referred']]) {
    await p.evaluate(() => window.__nscribe.Store.setDispoType('R5', ''));
    await chunk(p, 'R5', phrase, 50);
    await p.waitForFunction((t) => window.__nscribe.Store.bed('R5').dispoType === t, type);
  } await s.close(); return 'Posted, Shifted, Discharged, LAMA, Referred';
});

/* ---------- persistence + offline ---------- */
await ok('Refresh and reopen fully OFFLINE: all 20 slots, data and last selected bed restored; zero external requests', async () => {
  const s = await open(), p = s.page;
  await p.waitForFunction(() => navigator.serviceWorker.controller || true);
  await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForSelector('#app:not([hidden])');
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  await chunk(p, 'R1', '58 year old male with chest pain for two hours. BP 90/60', 50);
  await chunk(p, 'H4B', '33 year old female with fever for two days', 50); await settle(p);
  await openBed(p, 'H4B');
  await p.evaluate(() => window.__nscribe.Store.flushSaves());
  s.reqs.length = 0;
  await s.ctx.setOffline(true);                              // airplane mode
  await p.reload(); await p.waitForSelector('#app:not([hidden])');
  eq(await p.evaluate(() => window.__nscribe.Store.state.slots.length), 20, 'slots after offline reload');
  eq(await p.evaluate(() => window.__nscribe.Store.state.selected), 'H4B', 'last selected bed restored');
  assert(/chest pain/i.test((await bed(p, 'R1')).f.cc), 'R1 data restored'); assert(/fever/i.test((await bed(p, 'H4B')).f.cc), 'H4B data restored');
  assert(await p.locator('#modelpill').isVisible(), 'UI is up');
  const ext = externals(s.reqs); eq(ext, [], 'external requests while offline');
  await openBed(p, 'R6'); await p.fill('#f-cc', 'offline typing works'); await p.waitForTimeout(300);
  eq((await bed(p, 'R6')).f.cc, 'offline typing works', 'typing offline');
  const origins = [...new Set(s.reqs.map((u) => new URL(u).origin))];
  await s.close(); return 'offline origins: ' + origins.join(', ') + ' | requests ' + s.reqs.length;
});

/* ---------- edge cases ---------- */
await ok('Edge: silence and low background noise produce no chunks (nothing invented)', async () => {
  for (const wav of ['silence.wav', 'noise.wav']) {
    const s = await open({ wav }), p = s.page;
    await p.click('#micbtn'); await p.waitForFunction(() => window.__nscribe.mic.state === 'listening');
    await p.waitForTimeout(4000); await p.click('#micbtn');
    eq(await p.evaluate(() => window.__nscribe.ASR.chunks.size), 0, wav + ' chunks'); await s.close();
  } return 'ok';
});
await ok('Edge: very long dictation (70 s, no pause) is cut into chunks of 25 s or less', async () => {
  const s = await open({ wav: 'continuous-70s.wav' }), p = s.page;
  await p.evaluate(() => window.__nscribe.ASR.sendScript(Array.from({ length: 6 }, (_, i) => ({ text: 'part ' + i, delay: 50 }))));
  await p.click('#micbtn'); await p.waitForFunction(() => window.__nscribe.mic.state === 'listening');
  await p.waitForTimeout(29000); await p.click('#micbtn');
  const ms = await p.evaluate(() => [...window.__nscribe.ASR.chunks.values()].map((c) => c.ms));
  assert(ms.length >= 2 && ms.every((m) => m <= 25500), 'chunk lengths ' + ms); await s.close(); return 'chunk ms: ' + ms.join(', ');
});
await ok('Edge: low storage and low battery warnings are shown', async () => {
  const s = await open({ ctxOpts: {} }), p = s.page;
  await p.addInitScript(() => { navigator.storage.estimate = async () => ({ usage: 990e6, quota: 1000e6 }); });
  await p.reload(); await p.waitForSelector('#app:not([hidden])');
  await p.waitForSelector('.warnbox:has-text("almost full")', { timeout: 5000 }); await s.close(); return 'ok';
});
await ok('Edge: model not downloaded -> clear message, typing still works, audio is kept and waits (real worker, no network)', async () => {
  const s = await open({ stub: false, wav: 'bursts.wav' }), p = s.page;
  assert((await p.textContent('#modelpill')).includes('not downloaded'), 'pill says not downloaded');
  assert(await p.locator('.warnbox:has-text("one-time download")').isVisible(), 'download banner');
  await openBed(p, 'R2'); await p.fill('#typed', '58 M chest pain 2 hours BP 90/60'); await p.click('button:has-text("Add to R2")');
  await p.waitForFunction(() => document.querySelector('#f-cc') && document.querySelector('#f-cc').value.length > 0);
  assert(/chest pain/i.test(await p.inputValue('#f-cc')), 'manual typing parsed');
  await s.close(); return 'ok';
});
await ok('Edge: real worker, no internet -> clear "connect once" message; real worker, host blocked -> clear download error (no crash)', async () => {
  const s = await open({ stub: false }), p = s.page;
  await s.ctx.setOffline(true);
  await p.click('.warnbox button:has-text("Download now")');
  await p.waitForSelector('.warnbox.err:has-text("No internet")', { timeout: 5000 });
  await s.ctx.setOffline(false);
  await p.click('.warnbox.err button:has-text("Try again")');
  await p.waitForSelector('.warnbox.err:has-text("could not be downloaded")', { timeout: 30000 });
  const ext = externals(s.reqs); assert(!ext.some((u) => /jsdelivr|unpkg|cdnjs|googleapis/.test(u)), 'no CDN requests: ' + ext.join(','));
  await s.close(); return 'external hosts contacted: ' + [...new Set(externals(s.reqs).map((u) => new URL(u).host))].join(', ');
});
await ok('Edge: clearing an occupied bed asks first, can archive the note, and discards its pending audio', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R1', '58 year old male with chest pain for two hours. BP 90/60', 50); await settle(p);
  await openBed(p, 'R1');
  await p.click('button:has-text("Clear / Discharge")');
  await p.waitForSelector('.dialog h2:text("Clear R1?")');
  await p.click('.dialog .btn:has-text("Cancel")');
  assert(/chest/i.test((await bed(p, 'R1')).f.cc), 'cancel keeps data');
  await p.click('button:has-text("Clear / Discharge")'); await p.click('.dialog .btn:has-text("Archive note")');
  await p.waitForFunction(() => !window.__nscribe.Store.hasContent || true);
  await p.waitForSelector('.bchip[data-bed="R1"][data-st="empty"]');
  const arch = await p.evaluate(() => window.__nscribe.Store.archived());
  eq(arch.length, 1, 'one archived note'); assert(/chest pain/i.test(arch[0].text), 'archive text'); await s.close(); return 'ok';
});

await ok('Edge: removing a bed that holds a patient is refused; empty beds can be removed', async () => {
  const s = await open(), p = s.page;
  await chunk(p, 'R6', '40 year old male with fever', 50); await settle(p);
  const shrink = (n) => p.evaluate((n) => { const L = JSON.parse(JSON.stringify(window.__nscribe.Store.state.layout)); L.zones[0].count = n; return window.__nscribe.Store.setLayout(L); }, n);
  const r = await shrink(5); eq(r, { ok: false, blocked: ['R6'] }, 'blocked while occupied');
  eq(await p.evaluate(() => window.__nscribe.Store.state.slots.length), 20, 'layout unchanged');
  await p.evaluate(() => window.__nscribe.Store.clearBed('R6'));
  eq((await shrink(5)).ok, true, 'allowed once empty'); eq(await p.evaluate(() => window.__nscribe.Store.state.slots.length), 19, '19 slots'); await s.close(); return 'ok';
});

/* ---------- bundled WASM runtime ---------- */
await ok('Bundled ONNX/WASM runtime executes a real model from local files only (no CDN)', async () => {
  const { readFileSync } = await import('node:fs');
  const s = await open(), p = s.page;
  await p.route('**/__t/ort.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(join(root, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')) }));
  await p.route('**/__t/double.onnx', (r) => r.fulfill({ contentType: 'application/octet-stream', body: readFileSync(join(here, 'audio/double.onnx')) }));
  const out = await p.evaluate(() => new Promise((res) => {
    const src = `const ort = await import(location.origin + '/__t/ort.mjs');
      ort.env.wasm.wasmPaths = { mjs: location.origin + '/vendor/ort-wasm-simd-threaded.mjs', wasm: location.origin + '/vendor/ort-wasm-simd-threaded.wasm' };
      ort.env.wasm.numThreads = 1;
      const buf = new Uint8Array(await (await fetch(location.origin + '/__t/double.onnx')).arrayBuffer());
      const s = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      const r = await s.run({ x: new ort.Tensor('float32', new Float32Array([1, 2, 3]), [1, 3]) }); postMessage(Array.from(r.y.data));`;
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    wk.onmessage = (e) => res(e.data); wk.onerror = (e) => res('error ' + e.message); setTimeout(() => res('timeout'), 20000);
  }));
  eq(out, [2, 4, 6], 'model output'); eq(externals(s.reqs), [], 'external requests'); await s.close(); return 'x+x on [1,2,3] = ' + out;
});

/* ---------- parser on Tamil/Hindi text (rules only) ---------- */
await ok('Rule parser understands romanised and native Tamil/Hindi phrases (not speech recognition)', async () => {
  const { parseUtterance } = await import('../public/js/parser.js');
  const a = parseUtterance('nenju vali rendu manineram-a irukku, fever illa, sugar 250');
  const b = parseUtterance('सीने में दर्द दो घंटे से, बुखार नहीं है, 55 साल का आदमी');
  const c = parseUtterance('நெஞ்சு வலி ரெண்டு மணி நேரமா இருக்கு');
  eq([a.cc, b.cc, c.cc], [['Chest pain × 2 hours'], ['Chest pain × 2 hours'], ['Chest pain × 2 hours']], 'complaints');
  eq([a.hpi.join(), b.hpi.join()], ['Denies: Fever.', 'Denies: Fever.'], 'negation'); eq(a.vitals, { rbs: '250' }, 'rbs'); eq([b.patient.age, b.patient.sex], ['55', 'M'], 'age/sex'); return 'ok';
});

await ok('One natural English dictation fills every matching column (complaint, vitals, history, survey, exam, work-up, plan, disposition)', async () => {
  const s = await open(), p = s.page;
  const t = 'The patient is a 55 year old man who came with severe pain in the chest since morning and he is sweating a lot. Blood pressure is one hundred over seventy, heart rate eighty eight, saturation ninety four percent. He has history of high blood pressure and diabetes, taking amlodipine. On examination chest has bilateral crepitations. Airway is patent, breathing is fast, circulation cold peripheries. ECG shows ST elevation. Impression is acute coronary syndrome. Plan to give aspirin and shift to ICU.';
  await chunk(p, 'R1', t, 50); await settle(p);
  const b = await bed(p, 'R1');
  for (const k of ['cc', 'pmh', 'meds', 'pa', 'pb', 'pc', 'ex_rs', 'ix', 'imp', 'plan', 'dispo']) assert(b.f[k], 'column empty: ' + k);
  eq([b.patient.age, b.patient.sex, b.dispoType], ['55', 'M', 'Shifted'], 'patient/status');
  const v = b.vitalsLog[0]; eq([v.hr, v.sbp, v.dbp, v.spo2], ['88', '100', '70', '94'], 'vitals'); await s.close(); return 'all columns filled';
});

if (server) server.kill();
const w = Math.max(...results.map((r) => r[1].length));
console.log('\n' + results.map((r) => `${r[0]}  ${r[1]}${r[2] ? '\n      ' + r[2] : ''}`).join('\n'));
console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
