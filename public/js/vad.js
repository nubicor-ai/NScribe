// Microphone capture + voice-activity segmentation. Audio never leaves the page except to the on-device decoder.
//
// Segmenter (pure, testable): cuts a stream of 16 kHz frames into speech chunks at natural pauses.
// Every chunk is stamped with the bed that was selected when the chunk STARTED. Switching beds finalises the
// running chunk under the old bed first, so speech is never attributed to the wrong patient.
// MicCapture: getUserMedia + AudioWorklet + wake lock + auto-recovery.

export const RATE = 16000;

export class Segmenter {
  /** @param {{onChunk:Function, silenceMs?:number, minSpeechMs?:number, maxSec?:number, prerollMs?:number, threshold?:number}} o */
  constructor(o) {
    this.onChunk = o.onChunk;
    this.silenceMs = o.silenceMs || 700;
    this.minSpeechMs = o.minSpeechMs || 350;
    this.maxMs = (o.maxSec || 25) * 1000;
    this.prerollMs = o.prerollMs || 300;
    this.threshold = o.threshold || 0.012;
    this.bed = ''; this.chunkBed = '';
    this.noise = 0.004; this.level = 0;
    this.pre = []; this.preMs = 0;
    this.reset();
  }
  reset() { this.inSpeech = false; this.buf = []; this.bufMs = 0; this.speechMs = 0; this.silentMs = 0; this.run = 0; this.runFrames = []; this.t0 = 0; }
  setBed(id) {
    if (this.inSpeech && id !== this.chunkBed) { this.finalize('bed-switch'); this.inSpeech = true; this.chunkBed = id; this.t0 = Date.now(); }
    this.bed = id;
  }
  feed(frame) {
    const ms = frame.length / RATE * 1000;
    let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = rms;
    const thr = Math.max(this.threshold, this.noise * 3.5);
    const loud = rms > thr;
    if (!this.inSpeech) {
      if (!loud) this.noise = Math.max(0.002, this.noise * 0.95 + rms * 0.05);
      this.pre.push(frame); this.preMs += ms;
      while (this.preMs - this.pre[0].length / RATE * 1000 >= this.prerollMs) { this.preMs -= this.pre[0].length / RATE * 1000; this.pre.shift(); }
      this.run = loud ? this.run + ms : 0;
      if (this.run >= 60) { // 60 ms of sound: speech has started
        this.inSpeech = true; this.chunkBed = this.bed;
        this.buf = this.pre.slice(); this.bufMs = this.preMs; this.speechMs = this.run; this.silentMs = 0;
        this.t0 = Date.now() - this.bufMs; this.pre = []; this.preMs = 0; this.run = 0;
      }
      return;
    }
    this.buf.push(frame); this.bufMs += ms;
    if (loud) { this.speechMs += ms; this.silentMs = 0; } else this.silentMs += ms;
    if (this.silentMs >= this.silenceMs) { this.finalize('pause'); this.inSpeech = false; }
    else if (this.bufMs >= this.maxMs) { this.finalize('max'); this.inSpeech = true; this.chunkBed = this.bed; this.t0 = Date.now(); }
  }
  /** Close the running chunk (if long enough) and emit it under the bed it started on. */
  finalize(reason) {
    const keep = this.speechMs >= this.minSpeechMs && this.buf.length;
    if (keep) {
      let n = 0; this.buf.forEach((f) => { n += f.length; });
      const audio = new Float32Array(n); let o = 0; this.buf.forEach((f) => { audio.set(f, o); o += f.length; });
      this.onChunk({ bedId: this.chunkBed, audio, t0: this.t0, t1: Date.now(), ms: Math.round(n / RATE * 1000), reason });
    }
    this.buf = []; this.bufMs = 0; this.speechMs = 0; this.silentMs = 0; this.pre = []; this.preMs = 0; this.run = 0;
  }
  /** Mic stopped: emit whatever is pending. */
  flush() { if (this.inSpeech) this.finalize('stop'); this.inSpeech = false; }
}

function resample(frame, from) {
  if (from === RATE) return frame;
  const n = Math.round(frame.length * RATE / from), out = new Float32Array(n), k = from / RATE;
  for (let i = 0; i < n; i++) { const p = i * k, a = Math.floor(p), b = Math.min(a + 1, frame.length - 1); out[i] = frame[a] + (frame[b] - frame[a]) * (p - a); }
  return out;
}

export class MicCapture {
  /** cb: {onState(state,msg), onLevel(rms), onChunk(chunk)}  states: idle | starting | listening | recovering | denied | nomic | error */
  constructor(cb) {
    this.cb = cb; this.state = 'idle'; this.wake = null; this.retries = 0; this.wantOn = false;
    this.seg = new Segmenter({ onChunk: (c) => cb.onChunk(c) });
    this._lvl = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantOn) { this.ctx && this.ctx.state !== 'running' && this.ctx.resume().catch(() => {}); this._wake(); }
    });
  }
  _set(s, msg) { this.state = s; this.cb.onState(s, msg || ''); }
  setBed(id) { this.seg.setBed(id); }

  async start(bedId, wakeLock = true) {
    this.wantOn = true; this.useWake = wakeLock; this.seg.setBed(bedId);
    this._set('starting');
    try { await this._open(); this.retries = 0; this._wake(); this._set('listening'); }
    catch (e) { this.wantOn = false; this._fail(e); }
  }
  async _open() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new Ctx({ sampleRate: RATE }); } catch (e) { this.ctx = new Ctx(); }
    const src = this.ctx.createMediaStreamSource(this.stream);
    const sink = this.ctx.createGain(); sink.gain.value = 0; sink.connect(this.ctx.destination);
    const from = this.ctx.sampleRate;
    const onFrame = (f) => {
      const fr = resample(f, from);
      this.seg.feed(fr);
      const now = performance.now();
      if (now - this._lvl > 100) { this._lvl = now; this.cb.onLevel(this.seg.level, this.seg.inSpeech); }
    };
    if (this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule(new URL('./vad-worklet.js', import.meta.url).href);
      this.node = new AudioWorkletNode(this.ctx, 'nscribe-capture');
      this.node.port.onmessage = (e) => onFrame(e.data);
    } else { // older Safari
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(this.node); this.node.connect(sink);
    this.stream.getAudioTracks().forEach((t) => { t.onended = () => this._dropped(); });
    this.ctx.onstatechange = () => { if (this.wantOn && (this.ctx.state === 'interrupted' || this.ctx.state === 'suspended')) this.ctx.resume().catch(() => {}); };
  }
  _close() {
    try { this.node && this.node.disconnect(); } catch (e) { /* already closed */ }
    try { this.stream && this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); } catch (e) { /* already closed */ }
    try { this.ctx && this.ctx.close(); } catch (e) { /* already closed */ }
    this.node = this.stream = this.ctx = null;
  }
  /** Stream dropped (Bluetooth mic left, OS took the mic): keep the chunk so far, then retry quietly. */
  async _dropped() {
    if (!this.wantOn) return;
    this.seg.flush(); this._close();
    this._set('recovering', 'Microphone dropped. Reconnecting…');
    while (this.wantOn && this.retries < 8) {
      this.retries++;
      await new Promise((r) => setTimeout(r, Math.min(1000 * this.retries, 5000)));
      if (!this.wantOn) return;
      try { await this._open(); this.retries = 0; this._set('listening'); return; } catch (e) { if (e && e.name === 'NotAllowedError') break; }
    }
    this.wantOn = false; this._close(); this._set('error', 'Microphone lost. Tap the mic to start again.');
  }
  _fail(e) {
    this._close();
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') this._set('denied', 'Microphone permission was denied. Allow it in the browser or phone settings, then tap the mic.');
    else if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') this._set('nomic', 'No microphone found on this device.');
    else if (n === 'NotSupportedError') this._set('error', 'This browser cannot record audio here. Use HTTPS or the installed app.');
    else this._set('error', 'Could not start the microphone.');
  }
  stop() {
    this.wantOn = false;
    this.seg.flush();
    this._close(); this._release();
    this._set('idle');
  }
  async _wake() {
    if (!this.useWake || !('wakeLock' in navigator)) return;
    try {
      if (this.wake && !this.wake.released) return;
      this.wake = await navigator.wakeLock.request('screen');
    } catch (e) { /* not supported or denied: the screen may sleep, recording still runs while the page is visible */ }
  }
  _release() { try { this.wake && this.wake.release(); } catch (e) { /* ignore */ } this.wake = null; }
}
