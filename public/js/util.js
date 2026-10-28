// Tiny DOM helpers, toasts and dialogs. No dependencies.
export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/** h('div', {class:'x', onclick: fn}, child, 'text', [more]) */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else e.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return e;
}

export function toast(msg, kind) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3600);
  setTimeout(() => t.remove(), 4100);
}

/** Modal dialog. Resolves with the chosen button's value. buttons: [{label, value, cls}] */
export function ask(title, body, buttons) {
  return new Promise((resolve) => {
    const done = (v) => { ov.remove(); resolve(v); };
    const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog' },
        h('h2', null, title),
        typeof body === 'string' ? h('p', null, body) : body,
        h('div', { class: 'dlg-actions' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), type: 'button', onclick: () => done(b.value) }, b.label)))));
    document.body.append(ov);
    const first = $('.btn.primary, .btn', ov); if (first) first.focus();
  });
}
export const confirmDlg = (title, body, yes = 'Confirm', danger = true) =>
  ask(title, body, [{ label: 'Cancel', value: false }, { label: yes, value: true, cls: danger ? 'danger' : 'primary' }]);

export function fmtTime(ms) {
  try { return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; }
}
export function hhmm(ms) {
  try { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; }
}
export function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const hr = Math.floor(m / 60);
  return hr < 24 ? hr + ' h ' + (m % 60) + ' min ago' : Math.floor(hr / 24) + ' d ago';
}
export const uid = (p) => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
