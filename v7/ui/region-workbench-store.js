(function(root) {
  'use strict';
  function create(name) {
    let database;
    const urls = new Set(), previews = new Map(); let previewEpoch = 0;
    const open = () => database || (database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('runs', { keyPath: 'id' }); request.result.createObjectStore('assets', { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }));
    async function tx(table, mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(table, mode), request = operation(transaction.objectStore(table)); let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('区域记录写入中断'));
      });
    }
    async function put(blob) {
      if (!(blob instanceof Blob) || !blob.type.startsWith('image/') || blob.size > 128 * 1024 * 1024) throw new Error('区域图片为空或超过 128 MB');
      const image = await createImageBitmap(blob);
      try {
        if (image.width * image.height > 67108864) throw new Error('区域图片超过 6400 万像素');
        const scale = Math.min(1, 256 / Math.max(image.width, image.height));
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const asset = { id: 'region-asset-' + crypto.randomUUID(), width: image.width, height: image.height, full: blob, thumb: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 }) };
        await tx('assets', 'readwrite', table => table.put(asset)); return { id: asset.id, width: asset.width, height: asset.height };
      } finally { image.close(); }
    }
    async function asset(id) { const row = await tx('assets', 'readonly', table => table.get(id)); if (!row) throw new Error('区域图片已丢失，请重新抓取或生成'); return row; }
    function preview(id) {
      if (!previews.has(id)) {
        const epoch = previewEpoch;
        const pending = asset(id).then(row => { if (epoch !== previewEpoch) return ''; const url = URL.createObjectURL(row.thumb); urls.add(url); return url; }).catch(error => { previews.delete(id); throw error; });
        previews.set(id, pending);
      }
      return previews.get(id);
    }
    function release() { previewEpoch++; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); previews.clear(); }
    async function save(run) {
      // Persist an explicit contract: no host configuration, Key or image strings.
      const row = { id: run.id, mode: run.mode, createdAt: run.createdAt, updatedAt: Date.now(), options: run.options, presetId: run.presetId, prompt: run.prompt,
        regions: run.regions.map(r => ({ id: r.id, doc: r.doc, selection: r.selection, label: r.label, status: r.status, attempts: r.attempts, lastTaskId: r.lastTaskId || '', error: r.error || '', inputAssetId: r.inputAssetId || '', outputs: r.outputs || [] })), layout: run.layout || null };
      await tx('runs', 'readwrite', table => table.put(row));
    }
    async function list() { return (await tx('runs', 'readonly', table => table.getAll())).sort((a, b) => b.updatedAt - a.updatedAt); }
    async function remove(id) {
      await tx('runs', 'readwrite', table => table.delete(id));
      const keep = new Set((await list()).flatMap(run => run.regions.flatMap(r => [r.inputAssetId, ...r.outputs.map(o => o.assetId)])));
      const all = await tx('assets', 'readonly', table => table.getAllKeys());
      for (const key of all) if (!keep.has(key)) await tx('assets', 'readwrite', table => table.delete(key));
    }
    return { put, asset, preview, save, list, remove, release };
  }
  root.V7RegionStore = { create };
})(window);
