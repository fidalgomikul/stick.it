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
const DB_VERSION = 1;

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

// ---------------------------------------------------------------- IndexedDB autosave
let dbPromise = null;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

const storedKeys = new Set(); // blob keys known to be in IndexedDB already

/** Save meta + any blobs not stored yet; drop blobs no longer referenced. */
export async function autosaveWrite(meta, blobs) {
  const db = await openDb();
  if (!storedKeys.size) {
    (await reqP(db.transaction('blobs').objectStore('blobs').getAllKeys())).forEach((k) => storedKeys.add(k));
  }
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  const bs = tx.objectStore('blobs');
  for (const [key, blob] of blobs) if (!storedKeys.has(key)) { bs.put(blob, key); storedKeys.add(key); }
  for (const key of [...storedKeys]) if (!blobs.has(key)) { bs.delete(key); storedKeys.delete(key); }
  tx.objectStore('meta').put({ meta, savedAt: Date.now() }, 'current');
  await txDone(tx);
}

/** Returns { meta, blobs, savedAt } or null. */
export async function autosaveRead() {
  const db = await openDb();
  const rec = await reqP(db.transaction('meta').objectStore('meta').get('current'));
  if (!rec) return null;
  const store = db.transaction('blobs').objectStore('blobs');
  const [keys, values] = await Promise.all([reqP(store.getAllKeys()), reqP(store.getAll())]);
  const blobs = new Map(keys.map((k, i) => [k, values[i]]));
  keys.forEach((k) => storedKeys.add(k));
  return { meta: rec.meta, blobs, savedAt: rec.savedAt };
}

export async function autosaveClear() {
  const db = await openDb();
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  tx.objectStore('meta').clear();
  tx.objectStore('blobs').clear();
  await txDone(tx);
  storedKeys.clear();
}
