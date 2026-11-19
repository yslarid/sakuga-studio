// Analysis cache (IndexedDB, in this browser): what the editor works out about a file (scenes and
// motion, spoken lines, the song's beats and words, character outlines, faces) is kept by the
// file's content. Opening the same footage again skips the scans, and the same files always build
// the same edit, so a test can be re-run and compared shot for shot.
//
// Each kind of result carries a version: bump it when the analysis that makes it changes, and old
// entries are simply ignored.

export const CACHE_VERSIONS = { video: 3, dialogue: 5, music: 2, words: 4, lyrtimes: 3, phrases: 1, masks: 1, faces: 1 };

const DB = 'sakuga-cache', STORE = 'results';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch((e) => { console.warn('[cache] unavailable:', e); return null; });
  }
  return dbp;
}

const keyOf = (fp, kind, extra = '') => `${fp}:${kind}:v${CACHE_VERSIONS[kind] || 1}${extra ? ':' + extra : ''}`;

export async function cacheGet(fp, kind, extra) {
  if (!fp) return null;
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const q = d.transaction(STORE).objectStore(STORE).get(keyOf(fp, kind, extra));
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}

export async function cachePut(fp, kind, value, extra) {
  if (!fp || value == null) return;
  const d = await db();
  if (!d) return;
  await new Promise((res) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, keyOf(fp, kind, extra));
      tx.oncomplete = res;
      tx.onerror = tx.onabort = () => { console.warn('[cache] could not save', kind, tx.error); res(); };
    } catch (e) { console.warn('[cache] could not save', kind, e); res(); }
  });
}

// Wipe everything (the Sounds/Settings "forget analysis" button, or a fresh test)
export async function cacheClear() {
  const d = await db();
  if (!d) return;
  await new Promise((res) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = tx.onerror = res; });
}

// A file's identity by content: its size plus a hash of its first and last megabyte (renaming a
// file, or loading it from a different folder, still finds its analysis).
export async function fingerprint(file) {
  try {
    const n = 1 << 20;
    const buf = await new Blob([String(file.size), file.slice(0, n), file.slice(Math.max(0, file.size - n))]).arrayBuffer();
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}
