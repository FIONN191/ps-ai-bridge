'use strict';
/* 分割（新增物体抠图）的后台线程（docs/289）。算法在 diff-mask-core.js，这里只管：
 *   prepare：解码原图 + 生成图 → 生成图缩到原图尺寸（core_diff.prep 同款：工作尺寸 = 原图，长边上限 4096）→ 差值、大津阈值
 *   tune   ：按滑块重算 D1/D2 + 收边 → 回一张预览（mask = 黑白蒙版 / comp = 原图上叠出生成图被选中的那块）
 *   export ：当前蒙版缩放到【PS 里贴回那块选区的像素尺寸】→ 灰度、游程编码（插件 imaging.putLayerMask 按选区左上角精确写）
 *            ⚠ 10-26 改：原来出「黑底 + 透明度」PNG 走置入 + 载入选区，真机实测会被按不透明部分拉伸到整块（docs/292 第八节）
 * ⚠ 一个线程只服务一张图：换图就 terminate 重开，旧状态不会串到新图上。
 */
importScripts('diff-mask-core.js');

const WORK_MAX = 4096, PREVIEW_MAX = 1400;
let S = null;   // { w, h, gw, gh, orig, gen, base, mask, pw, ph }

async function decode(blob) {
  const bmp = await createImageBitmap(blob);
  return bmp;
}
function pixels(bmp, w, h) {
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

async function prepare(m) {
  const [ob, gb] = await Promise.all([decode(m.orig), decode(m.gen)]);
  const W = ob.width, H = ob.height, k = Math.min(1, WORK_MAX / Math.max(W, H));
  const w = Math.max(8, V7DiffMask.pyRound(W * k)), h = Math.max(8, V7DiffMask.pyRound(H * k));
  const orig = pixels(ob, w, h), gen = pixels(gb, w, h);
  const gw = gb.width, gh = gb.height;
  ob.close(); gb.close();
  const base = V7DiffMask.prepare(orig, gen, w, h);
  const ps = Math.min(1, PREVIEW_MAX / Math.max(w, h));
  S = { w, h, gw, gh, orig, gen, base, mask: null, pw: Math.max(1, Math.round(w * ps)), ph: Math.max(1, Math.round(h * ps)) };
  // 长宽比差太多 = AI 裁过边 / 拉伸过，结果会整体偏（core_diff.run 同一句提醒）
  const ar = (gw / gh) / (W / H);
  return { w, h, gw, gh, t0: base.t0, aspectOff: Math.abs(ar - 1) };
}

// 预览：按预览尺寸取样（最近邻，够看；导出用的是全尺寸蒙版，不受影响）
function preview(view) {
  const { w, h, pw, ph, mask, orig, gen } = S, out = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / ph));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / pw)), i = sy * w + sx, o = (y * pw + x) * 4, a = mask[i];
      if (view === 'mask') { out[o] = out[o + 1] = out[o + 2] = a; }
      else {
        const t = a / 255, j = i * 4;
        out[o] = orig[j] + (gen[j] - orig[j]) * t;
        out[o + 1] = orig[j + 1] + (gen[j + 1] - orig[j + 1]) * t;
        out[o + 2] = orig[j + 2] + (gen[j + 2] - orig[j + 2]) * t;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// 游程编码：[值 1 字节][次数 LEB128]… —— 插件 ps-io.js 的 _rleDecode 解
function rle(gray) {
  const out = []; let i = 0;
  while (i < gray.length) {
    const v = gray[i]; let n = 1;
    while (i + n < gray.length && gray[i + n] === v) n++;
    out.push(v);
    let m = n; do { let b = m & 127; m = Math.floor(m / 128); if (m) b |= 128; out.push(b); } while (m);
    i += n;
  }
  return Uint8Array.from(out);
}
// tw×th = PS 里贴回那块选区的像素尺寸（生成图会被缩放到这么大贴回去，蒙版就按这个尺寸出，线性插值 = core_diff write_masks 同款）
function exportMask(tw, th) {
  const { w, h, mask } = S;
  tw = Math.max(1, Math.round(tw || w)); th = Math.max(1, Math.round(th || h));
  let gray;
  if (tw === w && th === h) gray = mask;
  else {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i]; rgba[i * 4 + 3] = 255; }
    const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const o = new OffscreenCanvas(tw, th), g = o.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low';
    g.drawImage(c, 0, 0, tw, th);
    const d = g.getImageData(0, 0, tw, th).data;
    gray = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) gray[i] = d[i * 4];
  }
  return { rle: rle(gray), width: tw, height: th };
}

self.onmessage = async event => {
  const m = event.data || {};
  try {
    if (m.type === 'prepare') { postMessage({ id: m.id, ok: true, result: await prepare(m) }); return; }
    if (!S) throw new Error('还没准备好图片');
    if (m.type === 'tune') {
      const t0 = Date.now(), r = V7DiffMask.tune(S.base, m.params || {});
      S.mask = r.mask;
      const px = preview(m.view === 'mask' ? 'mask' : 'comp');
      postMessage({ id: m.id, ok: true, result: { t: r.t, t0: r.t0, coverage: r.coverage, ms: Date.now() - t0, pw: S.pw, ph: S.ph, pixels: px.buffer } }, [px.buffer]);
      return;
    }
    if (m.type === 'view') {
      if (!S.mask) throw new Error('还没算过蒙版');
      const px = preview(m.view === 'mask' ? 'mask' : 'comp');
      postMessage({ id: m.id, ok: true, result: { pw: S.pw, ph: S.ph, pixels: px.buffer } }, [px.buffer]);
      return;
    }
    if (m.type === 'export') {
      if (!S.mask) throw new Error('还没算过蒙版');
      const r = exportMask(m.width, m.height);
      postMessage({ id: m.id, ok: true, result: r }, [r.rle.buffer]);
      return;
    }
    throw new Error('不认识的指令：' + m.type);
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: String(e && e.message || e) });
  }
};
