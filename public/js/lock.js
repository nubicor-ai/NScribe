// Optional PIN lock. This keeps casual viewers out of an unattended phone. It does not encrypt the data on the device.
import { $, h } from './util.js';
import { state, setSettings } from './store.js';

async function hash(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const hasPin = () => !!state.settings.pinHash;
export async function setPin(pin) {
  if (!pin) { setSettings({ pinHash: '', pinSalt: '' }); return; }
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  setSettings({ pinSalt: salt, pinHash: await hash(pin, salt) });
}
export function showLock() {
  if (!hasPin()) return Promise.resolve();
  const box = $('#lock'); box.hidden = false;
  return new Promise((resolve) => {
    const inp = h('input', { class: 'fld', type: 'password', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'PIN', maxlength: '8' });
    const msg = h('p', null, 'Enter your PIN to open NScribe.');
    const go = async () => {
      if (await hash(inp.value, state.settings.pinSalt) === state.settings.pinHash) { box.hidden = true; box.replaceChildren(); resolve(); }
      else { msg.textContent = 'Wrong PIN. Try again.'; inp.value = ''; inp.focus(); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    box.replaceChildren(h('div', { class: 'dialog' }, h('h2', null, 'NScribe is locked'), msg, inp, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Unlock'))));
    inp.focus();
  });
}
