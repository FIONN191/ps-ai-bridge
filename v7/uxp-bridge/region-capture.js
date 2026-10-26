'use strict';

const { selectionOf, padCanvas, documentById } = require('./assistant-capture');
const pixels = require('./vendor/ps-pixels');
const depth = require('./pixel-depth');
const fail = (message) => Object.assign(new Error(message), { code: 'REGION_CAPTURE_FAILED' });

function rectangle(value, width, height) {
  if (!value) return null;
  const left = Number(value.left), top = Number(value.top), right = Number(value.right), bottom = Number(value.bottom);
  if (![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) {
    throw fail('区域坐标无效或超出原文档，请重新规划');
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function createRegionCapture({ app, imaging, now = Date.now }) {
  return async function capture(params = {}) {
    const doc = params.docId != null ? documentById(app, params.docId) : app.activeDocument;
    if (!doc) throw fail('来源文档已关闭，请重新绑定图片');
    const docWidth = Number(doc.width), docHeight = Number(doc.height);
    const expected = params.expected || {};
    if ((expected.width && Number(expected.width) !== docWidth) || (expected.height && Number(expected.height) !== docHeight)) throw fail('原文档尺寸已变化，请重新规划区域');
    if (expected.name && expected.name !== doc.name) throw fail('原文档已更名，请重新绑定图片');
    if (!imaging || typeof imaging.getPixels !== 'function') throw fail('Photoshop 版本不支持像素读取，请更新桥接和 Photoshop');
    const selected = params.selection || (await selectionOf(doc, app)).bounds;
    const selection = rectangle(selected, docWidth, docHeight);
    if (!selection) throw fail('请先在 Photoshop 框选区域');
    const requestedEdge = Number(params.maxEdge == null ? 2048 : params.maxEdge);
    if (!Number.isSafeInteger(requestedEdge) || requestedEdge < 64 || requestedEdge > 4096) throw fail('抓取长边须为 64 至 4096 像素');
    const scale = Math.min(1, requestedEdge / Math.max(selection.width, selection.height));
    const width = Math.max(1, Math.round(selection.width * scale)), height = Math.max(1, Math.round(selection.height * scale));
    let image;
    try {
      const result = await imaging.getPixels({ documentID: doc.id,
        sourceBounds: { left: selection.left, top: selection.top, right: selection.right, bottom: selection.bottom },
        targetSize: { width, height }, componentSize: 8, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1', applyAlpha: true });
      image = result && result.imageData;
      const bounds = result && result.sourceBounds, level = Number(result && result.level);
      if (!image || image.width * image.height > 4096 * 4096 || !bounds || !Number.isInteger(level) || level < 0 || level > 20) throw fail('Photoshop 未返回可靠的区域像素范围');
      const factor = 2 ** level;
      const area = {
        left: Math.max(0, Math.round((bounds.left * factor - selection.left) * width / selection.width)),
        top: Math.max(0, Math.round((bounds.top * factor - selection.top) * height / selection.height)),
        right: Math.min(width, Math.round((bounds.right * factor - selection.left) * width / selection.width)),
        bottom: Math.min(height, Math.round((bounds.bottom * factor - selection.top) * height / selection.height))
      };
      if (![area.left, area.top, area.right, area.bottom].every(Number.isFinite) || area.right <= area.left || area.bottom <= area.top) throw fail('Photoshop 返回的内容不在请求区域中');
      const raw = await image.getData({ chunky: true });
      // ⭐ 2026-10-21：16 位 / 32 位文档上 PS 可能不管 componentSize:8 —— 原来当 8 位直接用（通道错乱、发洋红）或报格式不对。
      //   现在先降成 8 位 RGB（pixel-depth.js，规则同主抓图 / V6）。
      const eightBit = image.components === 3 && image.componentSize === 8 && raw instanceof Uint8Array
        && raw.length === Number(image.width) * Number(image.height) * 3;   // 自称 8 位、实际回了两倍长度（16 位按字节）也要转
      const got = eightBit ? { data: raw } : depth.toRgb8(raw, Number(image.width), Number(image.height), Number(image.components));
      if (!got) throw fail('Photoshop 返回了无法识别的像素格式，请确认 Photoshop 版本后重试');
      const img8 = { width: image.width, height: image.height, components: 3, componentSize: 8 };
      const full = area.left === 0 && area.top === 0 && area.right === width && area.bottom === height && image.width === width && image.height === height
        && got.data.length === width * height * 3;
      const rgb = full ? got.data : padCanvas(got.data, img8, { width, height }, area);
      const png = pixels.encodePNGFromRGB(width, height, rgb, 3, true);
      return { docId: doc.id, docName: String(doc.name || ''), docWidth, docHeight, selection,
        width, height, mime: 'image/png', imageBase64: pixels.arrayBufferToBase64(png), capturedAt: now(),
        antiMode: 0, hasSelection: true, selectionChanged: false, layersChanged: false };
    } finally { if (image && image.dispose) image.dispose(); }
  };
}

module.exports = { rectangle, createRegionCapture };
