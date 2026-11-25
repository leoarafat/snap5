/* IndexedDB store for captures. Only usable from the extension origin (service worker and pages). */
(() => {
  const S = (globalThis.Snap5 ||= {});
  let dbPromise;

  const open = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('snap5', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('shots', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('shots', mode);
      const req = fn(tx.objectStore('shots'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  };

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
      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
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
})();
