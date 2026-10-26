(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7RegionCore = api;
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  const fail = message => Object.assign(new Error(message), { code: 'REGION_WORKBENCH_FAILED' });
  const clone = value => JSON.parse(JSON.stringify(value));
  function integer(value, min, max, label) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw fail(label + '必须为 ' + min + ' 至 ' + max + ' 的整数');
    return n;
  }
  function dimensions(doc) { return { width: integer(doc.width, 1, 300000, '文档宽度'), height: integer(doc.height, 1, 300000, '文档高度') }; }
  function axis(total, size, overlap) {
    integer(total, 1, 300000, '长度'); integer(size, 1, 300000, '分块大小'); integer(overlap, 0, size - 1, '重叠');
    if (total <= size) return [{ start: 0, end: total }];
    const result = [];
    for (let start = 0; ; start += size - overlap) {
      const position = Math.min(start, total - size);
      result.push({ start: position, end: position + size });
      if (position + size === total) break;
      if (result.length > 64) throw fail('分块超过 64 块，请增大分块尺寸或减少重叠');
    }
    return result;
  }
  function plan(mode, docs, options = {}) {
    if (!['partition', 'tiles'].includes(mode) || !Array.isArray(docs) || !docs.length) throw fail('请先勾选 Photoshop 文档');
    const regions = [];
    for (const doc of docs) {
      if (doc.id == null) throw fail('文档缺少来源编号');
      const { width, height } = dimensions(doc), size = mode === 'partition' ? Math.min(width, height) : integer(options.tileSize, 128, 8192, '分块大小');
      const overlap = mode === 'partition' ? Math.floor(size * 0.15) : integer(options.overlap, 0, size - 1, '重叠');
      const xs = axis(width, size, overlap), ys = axis(height, size, overlap);
      for (let y = 0; y < ys.length; y++) for (let x = 0; x < xs.length; x++) {
        if (regions.length >= 64) throw fail('本次区域超过 64 块，请减少文档或增大分块尺寸');
        const selection = { left: xs[x].start, top: ys[y].start, right: xs[x].end, bottom: ys[y].end, width: xs[x].end - xs[x].start, height: ys[y].end - ys[y].start };
        regions.push({ id: 'region-' + regions.length, doc: { id: doc.id, name: String(doc.name || ''), path: String(doc.path || ''), width, height }, selection, label: (y + 1) + '-' + (x + 1), status: 'pending', attempts: 0, outputs: [] });
      }
    }
    return regions;
  }
  function stitchLayout(regions, maxEdge = 4096, gap = 24) {
    integer(maxEdge, 256, 8192, '拼图长边'); integer(gap, 0, 256, '分隔带');
    if (!regions.length || regions.length > 32) throw fail('拼图需要 1 至 32 个区域');
    let width = Math.min(2048, Math.max(...regions.map(r => r.selection.width))), top = 0;
    const layout = regions.map(region => {
      const height = Math.max(1, Math.round(width * region.selection.height / region.selection.width));
      const rect = { regionId: region.id, x: 0, y: top, width, height }; top += height + gap; return rect;
    });
    const height = top - gap, scale = Math.min(1, maxEdge / Math.max(width, height));
    const result = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
      items: layout.map(item => { const x = Math.round(item.x * scale), y = Math.round(item.y * scale); return { regionId: item.regionId, x, y, width: Math.round((item.x + item.width) * scale) - x, height: Math.round((item.y + item.height) * scale) - y }; }) };
    if (result.items.some(item => item.width < 32 || item.height < 32)) throw fail('拼接后部分区域不足 32 像素，请减少区域数量或调整长宽比');
    return result;
  }
  function resultCrop(item, layout, width, height) {
    const left = Math.round(item.x * width / layout.width), top = Math.round(item.y * height / layout.height);
    return { left, top, width: Math.round((item.x + item.width) * width / layout.width) - left, height: Math.round((item.y + item.height) * height / layout.height) - top };
  }
  function jobs(run, onlyFailed = false) {
    if (run.mode === 'stitch') return run.regions.length && run.regions.some(r => (onlyFailed ? ['failed', 'partial', 'interrupted'] : ['pending', 'failed', 'partial', 'interrupted']).includes(r.status)) ? [run.regions] : [];
    return run.regions.filter(r => (onlyFailed ? ['failed', 'partial', 'interrupted'] : ['pending', 'failed', 'partial', 'interrupted']).includes(r.status)).map(r => [r]);
  }
  function restore(value) {
    const run = clone(value);
    if (!run || !['partition', 'tiles', 'stitch'].includes(run.mode) || !Array.isArray(run.regions) || run.regions.length > 64) throw fail('区域记录无效');
    for (const r of run.regions) { if (!r.doc || !r.selection) throw fail('区域记录缺少坐标'); dimensions(r.doc); r.bound = false; if (r.status === 'running') { r.status = 'interrupted'; r.error = '上次运行已中断，请确认后重试'; } }
    return run;
  }
  function feather(region, inset, blur) {
    const size = Math.min(region.selection.width, region.selection.height);
    const shrinkPercent = 100 * integer(inset, 0, Math.floor(size / 2) - 1, '蒙版内收') / size;
    const blurPercent = 100 * integer(blur, 0, Math.floor(size / 2), '蒙版羽化') / size;
    return { enabled: shrinkPercent > 0 || blurPercent > 0, shrinkPercent, blurPercent };
  }
  return { axis, plan, stitchLayout, resultCrop, jobs, restore, feather, integer, fail };
});
