// IndexedDB wrapper. Every write is awaited and committed immediately, so a crash or phone lock loses nothing.
// Stores: beds (one record per slot), chunks (audio + decode status), kv (settings, last bed, layout), archive (cleared notes).
// If IndexedDB is unavailable (some private modes) it falls back to memory and reports that via db.persistent=false.

const NAME = 'nscribe', VER = 1;
const STORES = ['beds', 'chunks', 'kv', 'archive'];
let dbp = null;
const mem = { beds: new Map(), chunks: new Map(), kv: new Map(), archive: new Map() };
export const db = { persistent: true };

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (!('indexedDB' in self)) { db.persistent = false; return resolve(null); }
    let req;
    try { req = indexedDB.open(NAME, VER); } catch (e) { db.persistent = false; return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('beds', { keyPath: 'id' });
      d.createObjectStore('chunks', { keyPath: 'id' });
      d.createObjectStore('kv', { keyPath: 'k' });
      d.createObjectStore('archive', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { db.persistent = false; resolve(null); };
    req.onblocked = () => { db.persistent = false; resolve(null); };
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((d) => {
    if (!d) return fn(null, mem[store]);
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      try { result = fn(os, null); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  });
}
const keyOf = (store, v) => (store === 'kv' ? v.k : v.id);

export const put = (store, value) => run(store, 'readwrite', (os, m) => {
  if (m) { m.set(keyOf(store, value), value); return; }
  os.put(value);
});
export const del = (store, key) => run(store, 'readwrite', (os, m) => { if (m) { m.delete(key); return; } os.delete(key); });
export const get = (store, key) => run(store, 'readonly', (os, m) => {
  if (m) return m.get(key);
  const r = os.get(key); return { __req: r };
});
export const getAll = (store) => run(store, 'readonly', (os, m) => {
  if (m) return Array.from(m.values());
  const r = os.getAll(); return { __req: r };
});

export const kvGet = async (k, dflt) => { const r = await get('kv', k); return r ? r.v : dflt; };
export const kvSet = (k, v) => put('kv', { k, v });

export async function estimate() {
  try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; } catch (e) { return null; }
}
export async function wipeAll() {
  for (const s of STORES) {
    const rows = await getAll(s);
    for (const r of rows) await del(s, keyOf(s, r));
  }
}
