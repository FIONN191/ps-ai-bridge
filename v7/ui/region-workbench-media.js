(function(root) {
  'use strict';
  const core = () => root.V7RegionCore;
  async function sheet(regions, layout, store) {
    const canvas = new OffscreenCanvas(layout.width, layout.height), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const item of layout.items) {
      const region = regions.find(r => r.id === item.regionId), bitmap = await createImageBitmap((await store.asset(region.inputAssetId)).full);
      try { ctx.drawImage(bitmap, item.x, item.y, item.width, item.height); } finally { bitmap.close(); }
    }
    return { full: await canvas.convertToBlob({ type: 'image/png' }), width: layout.width, height: layout.height };
  }
  async function split(asset, layout, store) {
    const bitmap = await createImageBitmap(asset.full), results = [];
    try {
      for (const item of layout.items) {
        const rect = core().resultCrop(item, layout, bitmap.width, bitmap.height);
        if (rect.width < 1 || rect.height < 1) throw new Error('返回图太小，无法按区域拆回');
        const canvas = new OffscreenCanvas(rect.width, rect.height);
        canvas.getContext('2d').drawImage(bitmap, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
        results.push({ regionId: item.regionId, asset: await store.put(await canvas.convertToBlob({ type: 'image/png' })) });
      }
      return results;
    } finally { bitmap.close(); }
  }
  async function compose(regions, variant, store) {
    if (!regions.length || regions.some(r => String(r.doc.id) !== String(regions[0].doc.id))) throw new Error('一次合成只能包含同一原文档');
    const doc = regions[0].doc, scale = Math.min(1, 8192 / Math.max(doc.width, doc.height));
    const width = Math.max(1, Math.round(doc.width * scale)), height = Math.max(1, Math.round(doc.height * scale));
    if (width * height > 33554432) throw new Error('合成超过 3200 万像素，请按区域分别传回');
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    const placed = [];
    for (const region of regions) {
      const output = region.outputs[variant]; if (!output) throw new Error('有区域缺少第 ' + (variant + 1) + ' 张结果，请先重试失败块');
      const bitmap = await createImageBitmap((await store.asset(output.assetId)).full), s = region.selection;
      try {
        const x = Math.round(s.left * scale), y = Math.round(s.top * scale), w = Math.round(s.right * scale) - x, h = Math.round(s.bottom * scale) - y;
        const tile = new OffscreenCanvas(w, h), tc = tile.getContext('2d'); tc.drawImage(bitmap, 0, 0, w, h);
        // Fade only edges already covered by an earlier tile; canvas outer edges stay opaque.
        let overlapX = 0, overlapY = 0;
        for (const p of placed) {
          if (p.left < s.left && p.right > s.left && p.top <= s.top && p.bottom >= s.bottom) overlapX = Math.max(overlapX, p.right - s.left);
          if (p.top < s.top && p.bottom > s.top && p.left <= s.left && p.right >= s.right) overlapY = Math.max(overlapY, p.bottom - s.top);
        }
        for (const [axis, extent] of [['x', overlapX], ['y', overlapY]]) if (extent > 0) {
          const end = Math.min(axis === 'x' ? w : h, Math.max(1, Math.round(extent * scale)));
          const gradient = tc.createLinearGradient(0, 0, axis === 'x' ? end : 0, axis === 'y' ? end : 0);
          gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(1, 'rgba(0,0,0,1)');
          tc.globalCompositeOperation = 'destination-in'; tc.fillStyle = gradient; tc.fillRect(0, 0, w, h);
        }
        ctx.drawImage(tile, x, y); placed.push(s);
      } finally { bitmap.close(); }
    }
    return { full: await canvas.convertToBlob({ type: 'image/png' }), width, height };
  }
  root.V7RegionMedia = { sheet, split, compose };
})(window);
