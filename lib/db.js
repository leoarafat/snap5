/* IndexedDB store for captures and recordings. Only usable from the extension origin. */
(() => {
  const S = (globalThis.Snap5 ||= {});
  let dbPromise;

  const open = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('snap5', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const has = (name) => db.objectStoreNames.contains(name);
        if (!has('shots')) db.createObjectStore('shots', { keyPath: 'id' });
        if (!has('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        // One row per second of video, so a crash never loses a recording.
        if (!has('chunks')) db.createObjectStore('chunks', { keyPath: ['rec', 'index'] });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    }));

  const run = async (mode, fn, name = 'shots') => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Could not save (is the disk full?)'));
    });
  };

  const newId = () => `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const makeThumb = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const w = 360;
    const h = Math.max(1, Math.min(260, Math.round((bmp.height / bmp.width) * w)));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, (bmp.height / bmp.width) * w);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return { thumb: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), ...size };
  };

  S.db = {
    /* temp=true entries are only a hand-off to the editor and are hidden from history. */
    async add(blob, { title = '', url = '', temp = false } = {}) {
      const id = newId();
      const record = { id, ts: Date.now(), blob, title, url, temp, ...(await makeThumb(blob)) };
      await run('readwrite', (s) => s.put(record));
      return id;
    },
    get: (id) => run('readonly', (s) => s.get(id)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
    async list() {
      const all = await run('readonly', (s) => s.getAll());
      return all.filter((r) => !r.temp).sort((a, b) => b.ts - a.ts);
    },
    async prune(limit) {
      const all = (await run('readonly', (s) => s.getAll())).sort((a, b) => b.ts - a.ts);
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      let kept = 0;
      for (const r of all) {
        const drop = r.temp ? r.ts < dayAgo : ++kept > limit;
        if (drop) await S.db.remove(r.id);
      }
    },
  };

  const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

  /* Recordings are never pruned automatically: only the user deletes them. */
  S.recordings = {
    async create(meta) {
      const record = { id: newId(), ts: Date.now(), done: false, duration: 0, size: 0, ...meta };
      await run('readwrite', (s) => s.put(record), 'recordings');
      return record;
    },
    addChunk: (rec, index, blob) => run('readwrite', (s) => s.put({ rec, index, blob }), 'chunks'),
    async update(id, patch) {
      const record = await S.recordings.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      await run('readwrite', (s) => s.put(record), 'recordings');
      return record;
    },
    get: (id) => run('readonly', (s) => s.get(id), 'recordings'),
    async assemble(id, type) {
      const rows = await run('readonly', (s) => s.getAll(chunkRange(id)), 'chunks');
      return new Blob(rows.map((r) => r.blob), { type });
    },
    dropChunks: (id) => run('readwrite', (s) => s.delete(chunkRange(id)), 'chunks'),
    async remove(id) {
      await S.recordings.dropChunks(id);
      await run('readwrite', (s) => s.delete(id), 'recordings');
    },
    async list() {
      const all = await run('readonly', (s) => s.getAll(), 'recordings');
      return all.sort((a, b) => b.ts - a.ts);
    },
  };
})();
