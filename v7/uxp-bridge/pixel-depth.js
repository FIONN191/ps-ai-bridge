'use strict';
// ═══ PS 像素统一降到 8 位 RGB（2026-10-21）═══
//  PS 在 16 位 / 32 位文档上，有时不管 getPixels 要的 componentSize:8，照样回：
//    · Uint16Array（16 位）· 两倍长度的 Uint8Array（16 位按字节）· Float32Array（32 位）。
//  当 8 位直接用 ⇒ 通道错乱、图发洋红；当格式不对直接报错 ⇒ 16 位文档上用不了。
//  规则逐条照搬主抓图（vendor/ps-io.js，V6 原样）：
//    · 16 位值域靠采样判断：PS 自己的 0-32768，还是标准 0-65535；
//    · 按字节回来的 16 位：先采样判断大端 / 小端，再判断值域；
//    · 32 位浮点：截到 0-1 再 ×255（预览 / 送 AI 用，不做线性光校正，跟主抓图「色彩稳定」关着时一样）。
//  以前只有主抓图有这套；助手看图、分区抓图（分区 / 分块 / 拼接）没有 —— 这里收成一份给它们共用。

function isPsRange(maxValue) { return maxValue > 0 && maxValue <= 32769; }
function from16(value, psRange) {
  return psRange ? Math.min(255, Math.round(value * 255 / 32768)) : Math.min(255, (value + 128) >> 8);
}

// 返回 { data: Uint8Array(长度 = width*height*components), depth: 8|16|32, note }
function toEightBit(raw, width, height, components) {
  const count = width * height * components;
  if (raw instanceof Uint16Array) {
    let max = 0;
    for (let i = 0, n = Math.min(raw.length, 5000); i < n; i++) if (raw[i] > max) max = raw[i];
    const ps = isPsRange(max), out = new Uint8Array(count);
    for (let i = 0; i < count && i < raw.length; i++) out[i] = from16(raw[i], ps);
    return { data: out, depth: 16, note: '16 位（' + (ps ? 'PS 0-32768' : '标准 0-65535') + '）→ 8 位' };
  }
  if (raw instanceof Float32Array) {
    const out = new Uint8Array(count);
    for (let i = 0; i < count && i < raw.length; i++) { let v = raw[i]; if (!(v > 0)) v = 0; if (v > 1) v = 1; out[i] = Math.round(v * 255); }
    return { data: out, depth: 32, note: '32 位浮点 → 8 位' };
  }
  const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : raw && raw.buffer ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength) : new Uint8Array(raw || 0);
  if (bytes.length === count * 2) {
    let even = 0, odd = 0;
    for (let i = 0, n = Math.min(100, count); i < n; i++) { even += bytes[i * 2]; odd += bytes[i * 2 + 1]; }
    const big = even >= odd, hi = big ? 0 : 1, lo = big ? 1 : 0;
    let max = 0;
    for (let i = 0, n = Math.min(5000, count); i < n; i++) { const v = (bytes[i * 2 + hi] << 8) | bytes[i * 2 + lo]; if (v > max) max = v; }
    const ps = isPsRange(max), out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = from16((bytes[i * 2 + hi] << 8) | bytes[i * 2 + lo], ps);
    return { data: out, depth: 16, note: '16 位字节（' + (big ? '大端' : '小端') + '，' + (ps ? 'PS 0-32768' : '标准 0-65535') + '）→ 8 位' };
  }
  return { data: bytes, depth: 8, note: '' };
}

// 降成 8 位后，再统一成 3 通道 RGB（4 通道的丢掉透明度 —— 调用方都要 applyAlpha，透明度已经合进颜色了）。
// 返回 null = 长度对不上（调用方照旧报「不支持的像素格式」，不硬猜）。
function toRgb8(raw, width, height, components) {
  const c = Number(components) || 3;
  if (c !== 3 && c !== 4) return null;
  const eight = toEightBit(raw, width, height, c);
  if (eight.data.length !== width * height * c) return null;
  if (c === 3) return eight;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) { out[i] = eight.data[j]; out[i + 1] = eight.data[j + 1]; out[i + 2] = eight.data[j + 2]; }
  return { data: out, depth: eight.depth, note: (eight.note ? eight.note + '；' : '') + '去掉透明通道' };
}

module.exports = { toEightBit, toRgb8 };
