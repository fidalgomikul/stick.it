// Project persistence: autosave to IndexedDB and a portable ".collage" project file.
//
// A project is { meta, blobs } where meta is plain JSON that references images by key,
// and blobs maps key → Blob (the actual image data, stored once).
//
// .collage file layout (binary, no dependencies):
//   "COLLAGE1" (8 bytes) | header length (uint32 BE) | header JSON (UTF-8) | blob bytes, back to back
//   header = { meta, blobs: [{ key, type, offset, size }] }  (offsets relative to the start of the blob area)

const MAGIC = 'COLLAGE1';
const DB_NAME = 'collage-studio';
const DB_VERSION = 2;

// ---------------------------------------------------------------- .collage files
export function encodeProjectFile(meta, blobs) {
  const index = [];
  let offset = 0;
  const parts = [];
  for (const [key, blob] of blobs) {
    index.push({ key, type: blob.type, offset, size: blob.size });
    offset += blob.size;
    parts.push(blob);
  }
  const header = new TextEncoder().encode(JSON.stringify({ meta, blobs: index }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return new Blob([MAGIC, len, header, ...parts], { type: 'application/octet-stream' });
}

export async function decodeProjectFile(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(head.subarray(0, 8)) !== MAGIC) throw new Error('This is not a Collage Studio project file.');
  const len = new DataView(head.buffer).getUint32(8);
  const header = JSON.parse(new TextDecoder().decode(await file.slice(12, 12 + len).arrayBuffer()));
  const base = 12 + len;
  const blobs = new Map();
  for (const b of header.blobs) blobs.set(b.key, file.slice(base + b.offset, base + b.offset + b.size, b.type));
  return { meta: header.meta, blobs };
}

// ---------------------------------------------------------------- browser storage (IndexedDB)
// Stores (version 2):
//   projects    id → { id, name, savedAt, meta, thumb (Blob), summary }
//   collections id → { id, name, savedAt, items, thumbs }
//   blobs       key → Blob — image data, shared: a sticker used by several projects is stored once
//   refs        'p:<id>' / 'c:<id>' → [blob keys] — which images each project / collection uses
//   settings    name → value (e.g. the project that was open last)
// An image is deleted only when no project or collection refers to it any more.
// Version 1 kept a single "current" collage in a 'meta' store; it's moved into 'projects' on upgrade.
let dbPromise = null;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result, tx = req.transaction;
      for (const name of ['blobs', 'projects', 'collections', 'refs', 'settings']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (ev.oldVersion === 1 && db.objectStoreNames.contains('meta')) {
        // move the single autosaved collage into the projects list
        const getOld = tx.objectStore('meta').get('current');
        getOld.onsuccess = () => {
          const rec = getOld.result;
          if (!rec?.meta) return;
          const id = 'p' + Date.now().toString(36);
          const keys = tx.objectStore('blobs').getAllKeys();
          keys.onsuccess = () => {
            tx.objectStore('projects').put({ id, name: rec.meta.name || 'Untitled collage', savedAt: rec.savedAt || Date.now(), meta: rec.meta, thumb: null, summary: summarise(rec.meta) }, id);
            tx.objectStore('refs').put(keys.result, 'p:' + id);
            tx.objectStore('settings').put(id, 'currentProject');
          };
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // if a newer version of the app (in another tab) needs to upgrade the storage, step aside
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of this app and reload.'));
  });
  return dbPromise;
}
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

/** Short description for the projects list. */
function summarise(meta) {
  const p = meta.print || {};
  const size = p.mode === 'pixels' ? `${p.pxW} × ${p.pxH} px` : `${p.w} × ${p.h} ${p.unit}`;
  const leaves = (meta.objects || []).flatMap((o) => (o.kind === 'group' ? o.children : [o]));
  return { stickers: (meta.library || []).length, onPrint: leaves.length, size };
}

/**
 * Write a set of blobs and point refs[refKey] at exactly these keys; images that nothing refers to
 * any more are deleted. Runs inside the given read-write transaction (stores: blobs, refs).
 */
async function storeBlobs(tx, refKey, blobs) {
  const bs = tx.objectStore('blobs'), refs = tx.objectStore('refs');
  const existing = new Set(await reqP(bs.getAllKeys()));
  for (const [key, blob] of blobs) if (!existing.has(key)) bs.put(blob, key);
  const before = (await reqP(refs.get(refKey))) || [];
  refs.put([...blobs.keys()], refKey);
  await collectGarbage(tx, before.filter((k) => !blobs.has(k)));
}
async function collectGarbage(tx, candidates) {
  if (!candidates.length) return;
  const allRefs = await reqP(tx.objectStore('refs').getAll());
  const used = new Set(allRefs.flat());
  for (const k of candidates) if (!used.has(k)) tx.objectStore('blobs').delete(k);
}
async function readBlobs(tx, refKey) {
  const keys = (await reqP(tx.objectStore('refs').get(refKey))) || [];
  const bs = tx.objectStore('blobs');
  const values = await Promise.all(keys.map((k) => reqP(bs.get(k))));
  return new Map(keys.map((k, i) => [k, values[i]]).filter(([, v]) => v));
}

// ---- projects
export async function saveProject(id, meta, blobs, thumb) {
  const db = await openDb();
  const tx = db.transaction(['projects', 'blobs', 'refs'], 'readwrite');
  tx.objectStore('projects').put({ id, name: meta.name || 'Untitled collage', savedAt: Date.now(), meta, thumb: thumb || null, summary: summarise(meta) }, id);
  await storeBlobs(tx, 'p:' + id, blobs);
  await txDone(tx);
}
/** Returns { meta, blobs, savedAt } or null. */
export async function loadProject(id) {
  const db = await openDb();
  const tx = db.transaction(['projects', 'blobs', 'refs']);
  const rec = await reqP(tx.objectStore('projects').get(id));
  if (!rec) return null;
  const blobs = await readBlobs(tx, 'p:' + id);
  return { meta: rec.meta, blobs, savedAt: rec.savedAt };
}
/** Newest first; without the full project data. */
export async function listProjects() {
  const db = await openDb();
  const all = await reqP(db.transaction('projects').objectStore('projects').getAll());
  return all.map(({ meta, ...rest }) => rest).sort((a, b) => b.savedAt - a.savedAt);
}
export async function deleteProject(id) {
  const db = await openDb();
  const tx = db.transaction(['projects', 'blobs', 'refs'], 'readwrite');
  const keys = (await reqP(tx.objectStore('refs').get('p:' + id))) || [];
  tx.objectStore('projects').delete(id);
  tx.objectStore('refs').delete('p:' + id);
  await collectGarbage(tx, keys);
  await txDone(tx);
}
export async function duplicateProject(id, newId, newName) {
  const db = await openDb();
  const tx = db.transaction(['projects', 'refs'], 'readwrite');
  const rec = await reqP(tx.objectStore('projects').get(id));
  if (!rec) throw new Error('Project not found');
  const keys = (await reqP(tx.objectStore('refs').get('p:' + id))) || [];
  const meta = { ...rec.meta, name: newName };
  tx.objectStore('projects').put({ ...rec, id: newId, name: newName, meta, savedAt: Date.now() }, newId);
  tx.objectStore('refs').put(keys, 'p:' + newId); // images are shared, not copied
  await txDone(tx);
}

// ---- sticker collections
export async function saveCollection(id, record, blobs) {
  const db = await openDb();
  const tx = db.transaction(['collections', 'blobs', 'refs'], 'readwrite');
  tx.objectStore('collections').put({ ...record, id, savedAt: Date.now() }, id);
  await storeBlobs(tx, 'c:' + id, blobs);
  await txDone(tx);
}
export async function listCollections() {
  const db = await openDb();
  const all = await reqP(db.transaction('collections').objectStore('collections').getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
/** Returns { record, blobs } or null. */
export async function loadCollection(id) {
  const db = await openDb();
  const tx = db.transaction(['collections', 'blobs', 'refs']);
  const record = await reqP(tx.objectStore('collections').get(id));
  if (!record) return null;
  return { record, blobs: await readBlobs(tx, 'c:' + id) };
}
export async function renameCollection(id, name) {
  const db = await openDb();
  const tx = db.transaction('collections', 'readwrite');
  const rec = await reqP(tx.objectStore('collections').get(id));
  if (rec) tx.objectStore('collections').put({ ...rec, name }, id);
  await txDone(tx);
}
export async function deleteCollection(id) {
  const db = await openDb();
  const tx = db.transaction(['collections', 'blobs', 'refs'], 'readwrite');
  const keys = (await reqP(tx.objectStore('refs').get('c:' + id))) || [];
  tx.objectStore('collections').delete(id);
  tx.objectStore('refs').delete('c:' + id);
  await collectGarbage(tx, keys);
  await txDone(tx);
}

// ---- settings
export async function getSetting(name) {
  const db = await openDb();
  return reqP(db.transaction('settings').objectStore('settings').get(name));
}
export async function setSetting(name, value) {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(value, name);
  await txDone(tx);
}
