// 回图后处理（全部在本机算，不上传）。思路参考夏三七「修图轮椅 V7」直播里讲的做法：
//  · 快速对齐：先整体对齐（缩放 + 平移），再把画面切成 10×10 块，选区外那一圈对不上的块各自微调扭过去，
//    保证接缝能对上；选区里面（真正修改的地方）不扭，免得把修改撤回去。
//  · 校色：全局 = 整图亮度颜色匹配（适合去杂物）；精准 = 逐像素把原图的低频颜色还回来（适合修脸这类几乎不变形的修改）；
//    混合 = 只在和原图很接近的地方校正。精准和混合都不碰 AI 明显改过的地方（去掉的杂物、新加的东西）和它们周围一圈，
//    否则会把去掉的东西以模糊的影子补回来；精准的「明显」门槛更高，AI 只是偏了点颜色的地方照样逐像素还原。
//  · 替换纹理：把原图的高频噪点/颗粒叠回 AI 图，补回原片质感；AI 明显改过的地方和周围一圈不叠。
//  · 强度：不是调透明度。先按块匹配算出原图→AI 图的位移场，强度 t 时两边各沿位移走一段再混合（简化版插帧），
//    0 = 原图，100% = AI 图，中间不会有明显重影。
import fs from 'node:fs';
import sharp from 'sharp';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- 读写 ----------
async function rgb(file, W, H) {
  return sharp(file).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}
const rawOpts = (W, H) => ({ raw: { width: W, height: H, channels: 3 } });
async function blurRGB(buf, W, H, sigma) {
  if (sigma < 0.3) return Buffer.from(buf);
  return sharp(buf, rawOpts(W, H)).blur(sigma).raw().toBuffer();
}
async function savePNG(buf, W, H, out) {
  await sharp(buf, rawOpts(W, H)).png({ compressionLevel: 6 }).toFile(out);
  return out;
}
async function grayAt(buf, W, H, w, h) {
  return sharp(buf, rawOpts(W, H)).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
}
function gradient(g, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i + 1] - g[i - 1];
    const gy = g[i + w] - g[i - w];
    out[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return out;
}

// ---------- 位移场与重采样 ----------
// field: { gw, gh, dx: Float32Array, dy: Float32Array }，单位是全尺寸像素，格点均匀铺满画面
const _d = [0, 0];
function sampleField(f, u, v) {
  const fx = clamp(u * (f.gw - 1), 0, f.gw - 1);
  const fy = clamp(v * (f.gh - 1), 0, f.gh - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, f.gw - 1);
  const y1 = Math.min(y0 + 1, f.gh - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const i00 = y0 * f.gw + x0;
  const i10 = y0 * f.gw + x1;
  const i01 = y1 * f.gw + x0;
  const i11 = y1 * f.gw + x1;
  _d[0] = (f.dx[i00] * (1 - ax) + f.dx[i10] * ax) * (1 - ay) + (f.dx[i01] * (1 - ax) + f.dx[i11] * ax) * ay;
  _d[1] = (f.dy[i00] * (1 - ax) + f.dy[i10] * ax) * (1 - ay) + (f.dy[i01] * (1 - ax) + f.dy[i11] * ax) * ay;
  return _d;
}

// dst(x) = src(x + k·d(x))，双线性采样
function warp(src, W, H, field, k = 1) {
  const dst = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = H > 1 ? y / (H - 1) : 0;
    for (let x = 0; x < W; x++) {
      const d = sampleField(field, W > 1 ? x / (W - 1) : 0, v);
      const dx = d[0];
      const dy = d[1];
      const sx = clamp(x + k * dx, 0, W - 1.001);
      const sy = clamp(y + k * dy, 0, H - 1.001);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const ax = sx - x0;
      const ay = sy - y0;
      const p00 = (y0 * W + x0) * 3;
      const p10 = p00 + 3;
      const p01 = p00 + W * 3;
      const p11 = p01 + 3;
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        dst[o + c] = (src[p00 + c] * (1 - ax) + src[p10 + c] * ax) * (1 - ay) + (src[p01 + c] * (1 - ax) + src[p11 + c] * ax) * ay;
      }
    }
  }
  return dst;
}

// 选区内外权重：选区外 = 1，选区里 = 0，边上平滑过渡
function ringWeight(u, v, focus) {
  if (!focus) return 0;
  const m = 0.06;
  const dx = Math.max(focus.x0 - u, u - focus.x1, 0);
  const dy = Math.max(focus.y0 - v, v - focus.y1, 0);
  const inside = u > focus.x0 && u < focus.x1 && v > focus.y0 && v < focus.y1;
  if (inside) {
    const din = Math.min(u - focus.x0, focus.x1 - u, v - focus.y0, focus.y1 - v);
    return clamp(1 - din / m, 0, 1);
  }
  return clamp(0.5 + Math.max(dx, dy) / m, 0, 1);
}

// 块匹配：I 上以 (cx,cy) 为中心的块，在 O 上找最像的位置，返回位移和置信度
function matchBlock(I, O, w, h, cx, cy, half, radius, base = [0, 0]) {
  let best = { dx: base[0], dy: base[1], e: Infinity };
  let e0 = Infinity;
  for (let sy = -radius; sy <= radius; sy++) for (let sx = -radius; sx <= radius; sx++) {
    const ox = Math.round(base[0] + sx);
    const oy = Math.round(base[1] + sy);
    let sum = 0;
    let n = 0;
    for (let y = cy - half; y <= cy + half; y += 2) {
      if (y < 1 || y >= h - 1 || y + oy < 1 || y + oy >= h - 1) continue;
      for (let x = cx - half; x <= cx + half; x += 2) {
        if (x < 1 || x >= w - 1 || x + ox < 1 || x + ox >= w - 1) continue;
        sum += Math.abs(I[y * w + x] - O[(y + oy) * w + x + ox]);
        n++;
      }
    }
    if (n < 8) continue;
    const e = sum / n;
    if (sx === 0 && sy === 0) e0 = e;
    if (e < best.e) best = { dx: ox, dy: oy, e };
  }
  return { ...best, gain: Number.isFinite(e0) && e0 > 0 ? (e0 - best.e) / e0 : 0 };
}

function smoothField(f, passes = 1) {
  for (let p = 0; p < passes; p++) {
    for (const key of ['dx', 'dy']) {
      const a = f[key];
      const b = new Float32Array(a.length);
      for (let y = 0; y < f.gh; y++) for (let x = 0; x < f.gw; x++) {
        let s = 0;
        let n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(f.gh - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(f.gw - 1, x + 1); xx++) { s += a[yy * f.gw + xx]; n++; }
        b[y * f.gw + x] = s / n;
      }
      f[key] = b;
    }
  }
  return f;
}

// ---------- 对齐 ----------
const WORK = 192;

function globalScore(I, O, w, h, mask, s, tx, ty) {
  let sum = 0;
  let n = 0;
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 4; y < h - 4; y += 2) for (let x = 4; x < w - 4; x += 2) {
    const i = y * w + x;
    if (mask && !mask[i]) continue;
    const ox = Math.round(cx + s * (x - cx) + tx);
    const oy = Math.round(cy + s * (y - cy) + ty);
    if (ox < 1 || oy < 1 || ox >= w - 1 || oy >= h - 1) continue;
    sum += Math.abs(I[i] - O[oy * w + ox]);
    n++;
  }
  return n > 50 ? sum / n : Infinity;
}

function ringMask(w, h, focus) {
  const m = new Uint8Array(w * h).fill(1);
  if (!focus) return { mask: m, ratio: 1 };
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= focus.x0 * w && x < focus.x1 * w && y >= focus.y0 * h && y < focus.y1 * h;
    m[y * w + x] = inside ? 0 : 1;
    if (!inside) n++;
  }
  return { mask: m, ratio: n / (w * h) };
}

/**
 * 把 AI 回图对齐到原图的画框里，输出同尺寸的 aligned.png。
 * 返回 { applied, scale, shift, localTiles, path }
 */
export async function alignOutput(inputPath, outputPath, focus, outPath) {
  const meta = await sharp(outputPath).metadata();
  const W = meta.width;
  const H = meta.height;
  const k = WORK / Math.max(W, H);
  const w = Math.max(32, Math.round(W * k));
  const h = Math.max(32, Math.round(H * k));
  const Ibuf = await rgb(inputPath, W, H);
  const Obuf = await rgb(outputPath, W, H);
  const I = gradient(await grayAt(Ibuf, W, H, w, h), w, h);
  const O = gradient(await grayAt(Obuf, W, H, w, h), w, h);
  let { mask, ratio } = ringMask(w, h, focus);
  if (ratio < 0.15) mask = null;

  // 1. 整体：缩放 0.94–1.06，平移 ±6%
  const base = globalScore(I, O, w, h, mask, 1, 0, 0);
  let best = { s: 1, tx: 0, ty: 0, e: base };
  const maxShift = Math.round(Math.max(w, h) * 0.06);
  for (let s = 0.94; s <= 1.0601; s += 0.01) for (let ty = -maxShift; ty <= maxShift; ty++) for (let tx = -maxShift; tx <= maxShift; tx++) {
    const e = globalScore(I, O, w, h, mask, s, tx, ty);
    if (e < best.e) best = { s, tx, ty, e };
  }
  for (let s = best.s - 0.008; s <= best.s + 0.0081; s += 0.002) for (let ty = best.ty - 1; ty <= best.ty + 1.01; ty += 0.5) for (let tx = best.tx - 1; tx <= best.tx + 1.01; tx += 0.5) {
    const e = globalScore(I, O, w, h, mask, s, tx, ty);
    if (e < best.e) best = { s, tx, ty, e };
  }
  const globalOn = base > 0 && (base - best.e) / base >= 0.04 && !(best.s === 1 && best.tx === 0 && best.ty === 0);
  const G = globalOn ? best : { s: 1, tx: 0, ty: 0 };

  // 2. 分块：10×10 块，在整体对齐的基础上各自再找 ±3% 的微小偏移，只用在选区外那圈
  const GN = 10;
  const field = { gw: GN + 1, gh: GN + 1, dx: new Float32Array((GN + 1) ** 2), dy: new Float32Array((GN + 1) ** 2) };
  let localTiles = 0;
  const half = Math.round(Math.min(w, h) / GN / 2) + 2;
  const radius = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let gy = 0; gy <= GN; gy++) for (let gx = 0; gx <= GN; gx++) {
    const u = gx / GN;
    const v = gy / GN;
    const cx = Math.round(u * (w - 1));
    const cy = Math.round(v * (h - 1));
    // 整体对齐给出的位移
    const gdx = w / 2 + G.s * (cx - w / 2) + G.tx - cx;
    const gdy = h / 2 + G.s * (cy - h / 2) + G.ty - cy;
    let ldx = 0;
    let ldy = 0;
    const wgt = focus ? ringWeight(u, v, focus) : 0;
    if (wgt > 0) {
      const m = matchBlock(I, O, w, h, cx, cy, half, radius, [gdx, gdy]);
      if (m.gain > 0.08) { ldx = (m.dx - gdx) * wgt; ldy = (m.dy - gdy) * wgt; localTiles++; }
    }
    field.dx[gy * field.gw + gx] = (gdx + ldx) / k;
    field.dy[gy * field.gw + gx] = (gdy + ldy) / k;
  }
  smoothField(field, 1);
  const applied = globalOn || localTiles > 0;
  if (!applied) return { applied: false, path: outputPath };
  await savePNG(warp(Obuf, W, H, field), W, H, outPath);
  return { applied: true, scale: G.s, shift: { x: G.tx / w, y: G.ty / h }, localTiles, path: outPath };
}

// ---------- 校色 ----------
function meanStdY(buf) {
  let s = 0;
  let s2 = 0;
  let cb = 0;
  let cr = 0;
  const n = buf.length / 3;
  for (let p = 0; p < buf.length; p += 3) {
    const r = buf[p];
    const g = buf[p + 1];
    const b = buf[p + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    s += Y; s2 += Y * Y;
    cb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const mean = s / n;
  return { Y: mean, std: Math.sqrt(Math.max(1, s2 / n - mean * mean)), Cb: cb / n, Cr: cr / n };
}

function globalColor(I, O) {
  const a = meanStdY(I);
  const b = meanStdY(O);
  const gain = clamp(a.std / b.std, 0.75, 1.33);
  const out = Buffer.alloc(O.length);
  for (let p = 0; p < O.length; p += 3) {
    const r = O[p];
    const g = O[p + 1];
    const bb = O[p + 2];
    let Y = 0.299 * r + 0.587 * g + 0.114 * bb;
    let Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * bb;
    let Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * bb;
    Y = (Y - b.Y) * gain + a.Y;
    Cb += a.Cb - b.Cb;
    Cr += a.Cr - b.Cr;
    out[p] = clamp(Math.round(Y + 1.402 * (Cr - 128)), 0, 255);
    out[p + 1] = clamp(Math.round(Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128)), 0, 255);
    out[p + 2] = clamp(Math.round(Y + 1.772 * (Cb - 128)), 0, 255);
  }
  return out;
}

// 和原图的相似度（低频亮度差越小越接近 1）
function similarity(Ilo, Olo, tau = 28) {
  const n = Ilo.length / 3;
  const s = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const d = Math.abs(0.299 * (Ilo[p] - Olo[p]) + 0.587 * (Ilo[p + 1] - Olo[p + 1]) + 0.114 * (Ilo[p + 2] - Olo[p + 2]))
      + 0.5 * (Math.abs(Ilo[p] - Olo[p]) + Math.abs(Ilo[p + 2] - Olo[p + 2])) / 2;
    s[i] = Math.exp(-(d / tau) * (d / tau));
  }
  return s;
}

export const CC_MODES = ['none', 'global', 'precise', 'mixed'];
// 算法改过的校色模式 / 替换纹理记个版本号，旧任务缓存的结果文件就不会再被拿来用
export const CC_VERSION = { mixed: 3, precise: 2 };
export const TEX_VERSION = 2;
// 「AI 改过」的门槛（低频亮度差的尺度）：越大越多地方被当成「只是偏了颜色」照样校正
const TAU = { mixed: 28, precise: 45, texture: 28 };

// 一维最小值滤波（horizontal 为真时按行，否则按列），半径 r
function minFilter(src, w, h, r, horizontal) {
  const out = new Float32Array(src.length);
  const [len, lines, step, lineStep] = horizontal ? [w, h, 1, w] : [h, w, w, 1];
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let x = 0; x < len; x++) {
      let m = 1;
      for (let k = Math.max(0, x - r), e = Math.min(len - 1, x + r); k <= e; k++) {
        const v = src[base + k * step];
        if (v < m) m = v;
      }
      out[base + x * step] = m;
    }
  }
  return out;
}

// 哪里可以拿原图的东西补回去（0–255，和原图同尺寸）：和原图接近的地方接近 255，AI 改过的地方是 0。
// 原图模糊以后，被 AI 去掉的杂物会向外晕开约 3σ：那一圈背景 AI 图和原图本来很接近，照「接近就补」会把杂物的轮廓一起带回来（淡淡的残影），
// 所以把「AI 改过的区域」向外扩 3σ（相似度图做最小值滤波），扩到的地方也不补，再模糊一下让过渡平滑。
// 低频图在 1/4 尺寸上算就够了，之后放大回原尺寸
async function keepWeight(Ilo, Olo, W, H, sigma, tau) {
  const k = 4;
  const w = Math.max(1, Math.round(W / k));
  const h = Math.max(1, Math.round(H / k));
  const small = (buf) => sharp(buf, rawOpts(W, H)).resize(w, h, { fit: 'fill' }).raw().toBuffer();
  const [Is, Os] = await Promise.all([small(Ilo), small(Olo)]);
  const r = Math.max(1, Math.round((3 * sigma) / k));
  const sim = minFilter(minFilter(similarity(Is, Os, tau), w, h, r, true), w, h, r, false);
  const u8 = Buffer.alloc(w * h);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.round(sim[i] * 255);
  const { data, info } = await sharp(u8, { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.5, sigma / k)).resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const out = Buffer.alloc(W * H);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return out;
}

async function localColor(I, O, W, H, mode) {
  const sigma = Math.max(2, Math.min(W, H) * 0.015);
  const [Ilo, Olo] = await Promise.all([blurRGB(I, W, H, sigma), blurRGB(O, W, H, sigma)]);
  const weight = await keepWeight(Ilo, Olo, W, H, sigma, TAU[mode]);
  const out = Buffer.alloc(O.length);
  for (let i = 0, p = 0; p < O.length; i++, p += 3) {
    const wgt = weight[i] / 255;
    for (let c = 0; c < 3; c++) out[p + c] = clamp(Math.round(O[p + c] + wgt * (Ilo[p + c] - Olo[p + c])), 0, 255);
  }
  return out;
}

// ---------- 替换纹理 ----------
async function restoreTexture(I, O, W, H) {
  const fine = Math.max(0.8, Math.min(W, H) / 1400);
  const sigma = Math.max(2, Math.min(W, H) * 0.015);
  const [Ib, Ob, Ilo, Olo] = await Promise.all([blurRGB(I, W, H, fine), blurRGB(O, W, H, fine), blurRGB(I, W, H, sigma), blurRGB(O, W, H, sigma)]);
  const weight = await keepWeight(Ilo, Olo, W, H, sigma, TAU.texture);
  const out = Buffer.alloc(O.length);
  for (let i = 0, p = 0; p < O.length; i++, p += 3) {
    const wgt = weight[i] / 255;
    for (let c = 0; c < 3; c++) {
      // AI 图的低频 + 原图的高频（只在和原图接近的地方）
      const hiI = I[p + c] - Ib[p + c];
      const hiO = O[p + c] - Ob[p + c];
      out[p + c] = clamp(Math.round(O[p + c] + wgt * (hiI - hiO)), 0, 255);
    }
  }
  return out;
}

// ---------- 强度（简化插帧） ----------
async function flowField(I, O, W, H) {
  const k = 320 / Math.max(W, H);
  const w = Math.max(32, Math.round(W * k));
  const h = Math.max(32, Math.round(H * k));
  const Ig = gradient(await grayAt(I, W, H, w, h), w, h);
  const Og = gradient(await grayAt(O, W, H, w, h), w, h);
  const GN = 24;
  const gw = GN + 1;
  const gh = Math.max(2, Math.round(GN * (h / w)) + 1);
  const f = { gw, gh, dx: new Float32Array(gw * gh), dy: new Float32Array(gw * gh) };
  const half = Math.round(w / GN) + 2;
  const radius = Math.max(3, Math.round(Math.min(w, h) * 0.04));
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const cx = Math.round((gx / (gw - 1)) * (w - 1));
    const cy = Math.round((gy / (gh - 1)) * (h - 1));
    const m = matchBlock(Ig, Og, w, h, cx, cy, half, radius);
    const ok = m.gain > 0.1;
    f.dx[gy * gw + gx] = ok ? m.dx / k : 0;
    f.dy[gy * gw + gx] = ok ? m.dy / k : 0;
  }
  return smoothField(f, 2);
}

// t：0 = 原图，1 = AI 图
async function interpolate(I, O, W, H, t) {
  const F = await flowField(I, O, W, H);
  // 中间帧：原图沿位移往前走 t，AI 图往回走 1-t，再按 t 混合
  const Iw = warp(I, W, H, F, -t);
  const Ow = warp(O, W, H, F, 1 - t);
  const out = Buffer.alloc(O.length);
  for (let p = 0; p < O.length; p++) out[p] = Math.round(Iw[p] * (1 - t) + Ow[p] * t);
  return out;
}

/**
 * 生成某个版本：base 是对齐后的 AI 图；cc 校色；tex 是否替换纹理；t 强度（0–1）。
 */
export async function makeVariant({ inputPath, basePath, cc, tex, t, outPath }) {
  const meta = await sharp(basePath).metadata();
  const W = meta.width;
  const H = meta.height;
  const I = await rgb(inputPath, W, H);
  let O = await rgb(basePath, W, H);
  if (cc === 'global') O = globalColor(I, O);
  else if (cc === 'precise' || cc === 'mixed') O = await localColor(I, O, W, H, cc);
  if (tex) O = await restoreTexture(I, O, W, H);
  if (t < 1) O = t <= 0 ? I : await interpolate(I, O, W, H, t);
  // Colour/texture adjustments must not discard the cutout's transparency.
  if (meta.hasAlpha) {
    const alpha = await sharp(basePath).ensureAlpha().extractChannel('alpha').raw().toBuffer();
    await sharp(O, rawOpts(W, H)).joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toFile(outPath);
    return outPath;
  }
  return savePNG(O, W, H, outPath);
}

export async function thumbnail(file, outPath, size = 320) {
  await sharp(file).resize(size, size, { fit: 'inside' }).jpeg({ quality: 82 }).toFile(outPath);
  return outPath;
}

export const exists = (p) => p && fs.existsSync(p);
