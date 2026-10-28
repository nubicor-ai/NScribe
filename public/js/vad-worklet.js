// AudioWorklet: runs on the audio thread, hands 20 ms frames of microphone samples to the page.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate * 0.02); this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('nscribe-capture', Capture);
