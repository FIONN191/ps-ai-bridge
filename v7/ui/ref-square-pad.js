/* ═══════════════════════════════════════════════════════════════
   带参考图时自动补成正方形（2026-10-25 用户定）

   用户原话：「有参考图的时候，参考图需要自动补为 1:1。如果参考图已经是 1:1 的话，就不用补。
            然后图一就需要补成 1:1」（学员实测：参考图比例会影响出图分辨率，图 1 正方形最稳、偏移最小）。

   做什么：
     · 这次带了参考图 ⇒ 图 1 和每张参考图，不是正方形的都补成正方形（居中，四周补边），已经是正方形的不动；
     · 补边 = 把最外一圈像素往外拉伸，再糊一下（AI 会把画面自然接上；图 1 的补边裁回时整块切掉）；
     · 图 1 补过 ⇒ AI 出的正方形图，按补的位置【裁回原来框的大小】再进还原 / 校色，贴回 PS 不错位。

   ⚠ 补边只改发给 AI 的那份（payload.inputImageBase64 / refImages），
     任务卡上记的原图、校色用的参考原图（sourceImageBase64）一律不动 —— 不然校色会拿补过边的图当基准。
   ⚠ 裁回用的是【比例】不是像素：AI 回的图不一定是我们发的那个尺寸（2K 档回 2048），按回图尺寸等比换算。

   纯计算（planSquare / cropRect）不碰 DOM，node 测试直接 require；画图（pad / crop）要 canvas，只在界面里跑。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // 长宽差不超过 1 像素就当已经是正方形（抓图缩放时会有一个像素的取整）
  const SQUARE_TOLERANCE = 1;

  /** 要不要补、怎么补。已经是正方形 ⇒ null */
  function planSquare(width, height) {
    const w = Math.round(Number(width) || 0), h = Math.round(Number(height) || 0);
    if (w <= 0 || h <= 0) return null;
    if (Math.abs(w - h) <= SQUARE_TOLERANCE) return null;
    const size = Math.max(w, h);
    return { size, width: w, height: h, offsetX: Math.floor((size - w) / 2), offsetY: Math.floor((size - h) / 2) };
  }

  /** AI 回来一张 outW×outH 的图 ⇒ 原图那块在回图里的位置（按比例换算，取整后不越界） */
  function cropRect(plan, outW, outH) {
    const W = Math.round(Number(outW) || 0), H = Math.round(Number(outH) || 0);
    if (!plan || !plan.size || W <= 0 || H <= 0) return null;
    const sx = W / plan.size, sy = H / plan.size;
    const x = Math.max(0, Math.min(W - 1, Math.round(plan.offsetX * sx)));
    const y = Math.max(0, Math.min(H - 1, Math.round(plan.offsetY * sy)));
    const w = Math.max(1, Math.min(W - x, Math.round(plan.width * sx)));
    const h = Math.max(1, Math.min(H - y, Math.round(plan.height * sy)));
    return { x, y, w, h };
  }

  /** 这一单要不要启用：开关开着 + 带了参考图 + 不是工作流 / 开源模型那条路（那两条的图 1 尺寸由工作流自己管） */
  function shouldApply(opts) {
    const o = opts || {};
    if (o.enabled === false) return false;
    if (o.workflow || o.qwen) return false;
    return Array.isArray(o.refImages) && o.refImages.length > 0;
  }

  // ─── 画图（界面里才有）────────────────────────────────────
  function cleanB64(value) {
    const s = String(value || '');
    const i = s.indexOf('base64,');
    return i >= 0 ? s.slice(i + 7) : s;
  }
  function loadImage(b64, mime) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Object.assign(new Error('补正方形：图片解码失败'), { code: 'SQUARE_PAD_DECODE_FAILED' }));
      img.src = 'data:' + (mime || 'image/png') + ';base64,' + cleanB64(b64);
    });
  }
  function canvasB64(c) {
    return c.toDataURL('image/png').split(',')[1] || '';
  }
  // 糊多大：补边宽度的 1/8，夹在 4~48 像素（只是让拉伸出来的条纹别太硬，不追求好看，图 1 的补边最后会被切掉）
  function blurPx(plan) {
    const pad = Math.max(plan.offsetX, plan.offsetY);
    return Math.max(4, Math.min(48, Math.round(pad / 8)));
  }

  /** 补成正方形。已经是正方形 ⇒ 原样返回、plan=null */
  async function pad(b64, mime) {
    const img = await loadImage(b64, mime);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const plan = planSquare(w, h);
    if (!plan) return { imageBase64: cleanB64(b64), mime: mime || 'image/png', plan: null };
    const c = document.createElement('canvas');
    c.width = plan.size; c.height = plan.size;
    const g = c.getContext('2d');
    const { offsetX: ox, offsetY: oy, size } = plan;
    // ① 最外一圈像素往外拉伸（左右补 or 上下补，只会有一种）
    if (ox > 0) {
      g.drawImage(img, 0, 0, 1, h, 0, oy, ox, h);
      g.drawImage(img, w - 1, 0, 1, h, ox + w, oy, size - ox - w, h);
    }
    if (oy > 0) {
      g.drawImage(img, 0, 0, w, 1, ox, 0, w, oy);
      g.drawImage(img, 0, h - 1, w, 1, ox, oy + h, w, size - oy - h);
    }
    // ② 整张糊一遍（ctx.filter 不支持的内核就跳过，只剩拉伸，照样能用）
    if ('filter' in g) {
      const tmp = document.createElement('canvas');
      tmp.width = size; tmp.height = size;
      const t = tmp.getContext('2d');
      t.drawImage(c, 0, 0);
      t.drawImage(img, ox, oy);
      g.save(); g.filter = 'blur(' + blurPx(plan) + 'px)'; g.drawImage(tmp, 0, 0); g.restore();
    }
    // ③ 原图盖回正中（一个像素都不改）
    g.drawImage(img, ox, oy);
    return { imageBase64: canvasB64(c), mime: 'image/png', plan };
  }

  /** AI 回的图按 plan 裁回原来那块 */
  async function crop(b64, mime, plan) {
    if (!plan) return { imageBase64: cleanB64(b64), mime: mime || 'image/png' };
    const img = await loadImage(b64, mime);
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const r = cropRect(plan, W, H);
    if (!r) throw Object.assign(new Error('补正方形：回图尺寸无效，裁不回去'), { code: 'SQUARE_PAD_CROP_FAILED' });
    const c = document.createElement('canvas');
    c.width = r.w; c.height = r.h;
    c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return { imageBase64: canvasB64(c), mime: 'image/png', rect: r };
  }

  /** 参考图逐张补（已经是正方形的原样留着，字段不丢） */
  async function padReferences(refs) {
    const out = [];
    let padded = 0;
    for (const ref of refs || []) {
      if (!ref || typeof ref !== 'object') { out.push(ref); continue; }
      const b64 = ref.imageBase64 || ref.base64;
      if (!b64) { out.push(ref); continue; }
      const r = await pad(b64, ref.mime);
      if (!r.plan) { out.push(ref); continue; }
      padded++;
      const next = Object.assign({}, ref, { imageBase64: r.imageBase64, mime: r.mime, squarePadded: true });
      delete next.base64;   // 两个壳都是 imageBase64 优先、base64 兜底 —— 留着旧的 base64 也不会被用到，但别让两份不一样的图挂在一起
      out.push(next);
    }
    return { refs: out, padded };
  }

  const api = { SQUARE_TOLERANCE, planSquare, cropRect, shouldApply, pad, crop, padReferences };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7RefSquarePad = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
