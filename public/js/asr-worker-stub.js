// TEST-ONLY stand-in for asr-worker.js (enabled with ?stub=1). Same message protocol, no model.
// It returns scripted text so the queue, routing and bed-safety logic can be tested without audio models.
// Chunks may carry `hint` (text to return) and `hintDelay` (ms); otherwise items come from a script posted with {type:'script'}.
const script = [];
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'script') { script.push(...m.items); return; }
  if (m.type === 'init') {
    self.postMessage({ type: 'status', state: 'loading', msg: 'Loading (stub)…' });
    setTimeout(() => self.postMessage({ type: 'status', state: 'ready' }), 50);
    return;
  }
  if (m.type === 'decode') {
    const item = m.hint != null ? { text: m.hint, delay: m.hintDelay } : (script.shift() || { text: '' });
    setTimeout(() => {
      if (item.fail) self.postMessage({ type: 'error', id: m.id, msg: 'stub failure' });
      else self.postMessage({ type: 'result', id: m.id, text: item.text, orig: item.orig || '' });
    }, item.delay != null ? item.delay : 200);
  }
};
