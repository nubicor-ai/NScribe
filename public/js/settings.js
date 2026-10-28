// Settings dialog: model, language, beds layout, timers, PIN, data and offline check.
import { h, ask, toast, confirmDlg, fmtTime, uid } from './util.js';
import { state, setSetting, setSettings, setLayout, slot, bed, hasContent, blankBed, touchBed, archived, deleteArchived, flushSaves } from './store.js';
import { MODELS } from './config.js';
import { setPin, hasPin } from './lock.js';
import { backupJson, download } from './export.js';
import * as ASR from './asr.js';
import * as DB from './db.js';

let open = null;
const mb = (n) => (n / 1048576).toFixed(0) + ' MB';

export async function openSettings(focus, hooks = {}) {
  if (open) open.remove();
  const s = state.settings;
  const body = h('div', { class: 'dialog wide' });
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' }, body);
  open = overlay; document.body.append(overlay);
  const close = () => { overlay.remove(); open = null; unsub(); };
  const unsub = ASR.onChange(() => paintModel());

  const row = (label, desc, ctl) => h('div', { class: 'srow' }, h('div', null, h('div', null, label), desc ? h('div', { class: 'd' }, desc) : null), ctl);

  /* ----- speech model ----- */
  const modelSel = h('select', { class: 'fld', 'aria-label': 'Model size', onchange: (e) => { setSetting('model', e.target.value); ASR.switchModel(); paintModel(); } },
    Object.entries(MODELS).map(([k, m]) => h('option', { value: k, selected: s.model === k }, m.label)));
  const mStatus = h('div', { class: 'd' }), mBar = h('div', { class: 'dlbar', hidden: true }, h('i'));
  const mBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => hooks.downloadModel() }, 'Download');
  const mDel = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
    if (!(await confirmDlg('Remove the speech model?', 'The files are deleted from this device. Voice will not work until you download them again (internet needed once).', 'Remove'))) return;
    try { await caches.delete('transformers-cache'); } catch (e) { /* none */ }
    ASR.unload(); ASR.model.ready = {}; await DB.kvSet('modelReady', {}); ASR.model.state = 'none'; paintModel(); toast('Model removed');
  } }, 'Remove model');
  function paintModel() {
    const m = ASR.model, sel = ASR.model.ready[state.settings.model];
    mStatus.textContent = m.state === 'downloading' ? 'Downloading ' + m.pct + '% ' + (m.msg || '') : m.state === 'loading' ? 'Loading into memory…' : m.state === 'error' ? m.msg
      : sel ? 'Downloaded. Works with no internet.' : 'Not downloaded yet (needs internet once).';
    mBar.hidden = m.state !== 'downloading'; mBar.firstChild.style.width = m.pct + '%';
    mBtn.hidden = !!sel && m.state !== 'error'; mBtn.disabled = m.state === 'downloading' || m.state === 'loading';
    mBtn.textContent = m.state === 'error' ? 'Try again' : 'Download';
    mDel.hidden = !sel;
  }

  /* ----- layout editor ----- */
  const zoneInputs = state.layout.zones.map((z) => ({ z, count: h('input', { class: 'fld', type: 'number', min: '1', max: '30', value: String(z.count), 'aria-label': z.name + ' beds' }),
    per: h('select', { class: 'fld', 'aria-label': z.name + ' patients per bed' }, [1, 2, 3].map((n) => h('option', { value: String(n), selected: z.perBed === n }, n === 1 ? '1 patient / bed' : n + ' patients / bed'))) }));
  const layoutMsg = h('div', { class: 'd' });
  const saveLayout = () => {
    const next = { zones: zoneInputs.map((x) => ({ ...x.z, count: Math.max(1, Math.min(30, parseInt(x.count.value, 10) || 1)), perBed: parseInt(x.per.value, 10) })) };
    const r = setLayout(next);
    layoutMsg.textContent = r.ok ? 'Saved. Beds updated.' : 'Cannot remove ' + r.blocked.join(', ') + ' while it has patient data. Clear or discharge it first.';
    layoutMsg.style.color = r.ok ? '' : 'var(--crit)';
  };

  /* ----- pin ----- */
  const pinIn = h('input', { class: 'fld', type: 'password', inputmode: 'numeric', maxlength: '8', placeholder: hasPin() ? 'New PIN (blank = remove)' : '4-8 digits', 'aria-label': 'PIN' });
  const pinBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const v = pinIn.value.trim();
    if (v && !/^\d{4,8}$/.test(v)) { toast('PIN must be 4 to 8 digits', 'err'); return; }
    await setPin(v); pinIn.value = ''; toast(v ? 'PIN set' : 'PIN removed'); hooks.refreshLock();
  } }, 'Save PIN');

  /* ----- storage + offline proof ----- */
  const est = h('div', { class: 'd' }, 'Checking…');
  DB.estimate().then((e) => { est.textContent = e ? 'Using ' + mb(e.usage) + ' of ' + mb(e.quota) + ' available' + (DB.db.persistent ? '' : ' · private mode: data is not kept after closing') : 'Storage details are not available in this browser.'; });
  const ext = performance.getEntriesByType('resource').filter((r) => { try { return new URL(r.name).origin !== location.origin; } catch (e) { return false; } });
  const sw = 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'active' : 'not yet active (reload once online)') : 'not supported';

  const arch = h('div', null);
  async function paintArchive() {
    const list = await archived();
    arch.replaceChildren(...(list.length ? list.slice(0, 20).map((a) => h('div', { class: 'srow' }, h('div', null, h('div', null, 'Bed ' + a.bedId + ' · ' + fmtTime(a.t)), h('div', { class: 'd' }, a.text.split('\n').slice(2, 4).join(' ').slice(0, 90))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(a.text); toast('Copied'); } catch (e) { download('archived-' + a.bedId + '.txt', a.text); } } }, 'Copy'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { await deleteArchived(a.id); paintArchive(); } }, 'Delete')))) : [h('p', { class: 'd' }, 'No archived notes.')]));
  }

  /* ----- legacy single-patient encounters ----- */
  let legacy = {};
  try { legacy = JSON.parse(localStorage.getItem('nubicor-scribe-encounters-v2') || '{}') || {}; } catch (e) { legacy = {}; }
  const legacyList = Object.values(legacy).filter((e) => e && e.state);
  const legacyBox = h('div', null);
  if (legacyList.length) {
    const empties = state.slots.filter((x) => !hasContent(bed(x.id)));
    legacyBox.append(h('h3', null, 'Older single-patient encounters'), h('p', null, 'Found ' + legacyList.length + ' saved with the earlier version of NScribe on this device. Import one into an empty bed.'));
    legacyList.slice(0, 20).forEach((e) => {
      const pick = h('select', { class: 'fld' }, empties.map((x) => h('option', null, x.id)));
      legacyBox.append(h('div', { class: 'srow' }, h('div', null, (e.title || 'Untitled') + ' · ' + fmtTime(e.rev || e.created || Date.now())), h('div', { class: 'actions' }, pick,
        h('button', { class: 'btn', type: 'button', onclick: () => importLegacy(e, pick.value) }, 'Import'))));
    });
  }
  function importLegacy(e, id) {
    if (!id || hasContent(bed(id))) { toast('Pick an empty bed', 'warn'); return; }
    const st = e.state || {}, b = bed(id);
    ['age', 'sex', 'triage', 'arrival'].forEach((k) => { if (st[k]) { b.patient[k] = st[k]; b.edited[k] = true; } });
    b.patient.mlc = !!st.mlc;
    Object.keys(b.f).forEach((k) => { if (st[k]) { b.f[k] = String(st[k]); b.edited[k] = true; } });
    const v = {}; ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'gcs', 'rbs'].forEach((k) => { if (st[k]) v[k] = String(st[k]); });
    if (Object.keys(v).length) b.vitalsLog.push({ id: uid('v'), t: e.rev || Date.now(), src: 'imported', ...v });
    b.timeline.push({ id: uid('t'), t: e.rev || Date.now(), type: 'Other', text: 'Imported from the earlier single-patient version.' + (e.raw ? '\n' + e.raw : ''), orig: '', chunk: '', src: 'typed', flags: [], filled: [] });
    touchBed(id);
    toast('Imported into ' + id);
  }

  body.append(
    h('h2', null, 'Settings'),
    h('h3', null, 'Speech model (on this device)'),
    row('Model size', 'Bigger is more accurate but slower and uses more memory.', modelSel),
    h('div', { class: 'srow' }, h('div', null, mStatus, mBar), h('div', { class: 'actions' }, mBtn, mDel)),
    row('Language being spoken', 'Pick it when you can: Whisper cannot detect mixed languages reliably.', h('select', { class: 'fld', onchange: (e) => setSetting('language', e.target.value) },
      [['auto', 'Auto-detect'], ['ta', 'Tamil'], ['hi', 'Hindi'], ['en', 'English']].map(([v, l]) => h('option', { value: v, selected: s.language === v }, l)))),
    row('Keep original-language text', 'Also saves what was said in Tamil/Hindi. Doubles decode time.', h('input', { type: 'checkbox', checked: s.keepOriginal, onchange: (e) => setSetting('keepOriginal', e.target.checked), 'aria-label': 'Keep original text' })),
    row('Unload model when idle (minutes)', '0 = never. Frees memory and battery; it reloads on the next recording.', h('input', { class: 'fld', type: 'number', min: '0', max: '240', value: String(s.idleUnloadMin), onchange: (e) => setSetting('idleUnloadMin', Math.max(0, parseInt(e.target.value, 10) || 0)) })),
    row('Keep screen awake while recording', null, h('input', { type: 'checkbox', checked: s.wakeLock, onchange: (e) => setSetting('wakeLock', e.target.checked), 'aria-label': 'Keep screen awake' })),

    h('h3', null, 'Beds'),
    ...zoneInputs.map((x) => row(x.z.name + ' (prefix ' + x.z.prefix + ')', null, h('div', { class: 'actions' }, x.count, x.per))),
    h('div', { class: 'srow' }, layoutMsg, h('button', { class: 'btn primary', type: 'button', onclick: saveLayout }, 'Save beds')),
    row('Reassessment due after (minutes)', 'The bed chip turns amber after this long without an update.', h('input', { class: 'fld', type: 'number', min: '5', max: '1440', value: String(s.reassessMin), onchange: (e) => setSetting('reassessMin', Math.max(5, parseInt(e.target.value, 10) || 60)) })),

    h('h3', null, 'App lock'),
    row('PIN', 'Hides the screen until the PIN is entered. It does not encrypt stored data.', h('div', { class: 'actions' }, pinIn, pinBtn)),

    h('h3', null, 'Data and offline check'),
    row('Storage', null, est),
    row('Offline status', 'Everything runs on this device. No patient data is ever sent anywhere.', h('div', { class: 'd' }, (navigator.onLine ? 'Online now' : 'Offline now') + ' · app cache: ' + sw + ' · requests to other sites from this page since opening: ' + ext.length)),
    row('Backup', 'One file with every occupied bed. Keep it somewhere safe.', h('button', { class: 'btn', type: 'button', onclick: () => download('nscribe-backup-' + new Date().toISOString().slice(0, 10) + '.json', backupJson(), 'application/json') }, 'Download backup')),
    h('h3', null, 'Archive (notes saved when clearing a bed)'), arch,
    legacyBox,
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDlg('Delete ALL data?', 'Every bed, archived note and setting on this device will be erased. This cannot be undone.', 'Delete everything'))) return;
        if (!(await confirmDlg('Are you sure?', 'Last chance. Export a backup first if you might need anything.', 'Yes, erase', true))) return;
        await flushSaves(); await DB.wipeAll(); location.reload();
      } }, 'Erase all data'),
      h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Done')));
  paintModel(); paintArchive();
  if (focus === 'model') mStatus.scrollIntoView({ block: 'center' });
}
