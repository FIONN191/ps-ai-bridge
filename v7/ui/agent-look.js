/* 夏三六 · 看图量坐标 + 按坐标建选区（2026-10-17）
 *
 * 写给：以后接手 Agent 的人。用户原话：「我要求我们的Agent能够把图片拉出来计算出坐标」「给Agent的权限没给够」。
 * 两样东西：
 *   look()   把 PS 画布（整张，或用 region 放大某一块）读出来，四周画上标着【原图像素坐标】的刻度尺 + 图上格线，
 *            可选再画几个彩色框（marks，用来核对打算框的位置），然后把这张图交给大脑看。
 *            ⭐ 刻度上写的就是原图坐标 —— 大脑读刻度就行，不用自己按缩放比换算
 *              （老坑：把缩小图上的像素当原图坐标报，整组位置偏；记忆「归一化坐标必须配源的长宽比」）。
 *   select() 按原图坐标在 PS 建选区（矩形 / 椭圆，多个合并），PS 那头建完回读核对（uxp-bridge/assistant-selection.js）。
 * 都不动像素、不动图层、不花钱。
 * 量得准不准靠「先整张 → 放大那一块 → 画框核对」几轮（提示词 agent-prompt.js 写了这个顺序）。
 * ⚠ 各家大脑读刻度能读多准，没实测过。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.V7AgentLookCore = api;
  const bridge = (action, params, timeoutMs) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('Photoshop 没有响应，请确认联动插件已连接'), { code: 'AGENT_LOOK_TIMEOUT' })), timeoutMs || 45000);
    try {
      Promise.resolve(linkQueue(action, params, {
        after: data => finish(resolve, data),
        afterError: r => finish(reject, Object.assign(new Error(linkResultMessage(r)), { code: r && r.error && r.error.code }))
      })).then(r => { if (r && r.ok === false) finish(reject, new Error(linkResultMessage(r))); }).catch(e => finish(reject, e));
    } catch (e) { finish(reject, e); }
  });
  root.V7AgentLook = api.createService({
    capture: params => bridge('ps.assistant.capture', params),
    select: params => bridge('ps.assistant.selectShapes', params),
    activeDoc: async () => {
      const d = await bridge('ps.selection.rect', {}, 15000);
      return d && d.hasDoc ? { docId: d.docId, docName: d.docName, docWidth: d.docWidth, docHeight: d.docHeight } : null;
    },
    decode: (mime, base64) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(Object.assign(new Error('读到的画布图片解不开'), { code: 'AGENT_LOOK_DECODE' }));
      img.src = 'data:' + mime + ';base64,' + base64;
    }),
    canvas: (width, height) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      return { ctx: c.getContext('2d'), toBase64: () => c.toDataURL('image/jpeg', 0.88).split(',')[1] || '' };
    },
    now: () => Date.now()
  });
  root.addEventListener('wheelchair:storage-context', () => root.V7AgentLook.clear());
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const error = (code, message) => Object.assign(new Error(message), { code });
  const KEEP_MS = 15 * 60 * 1000;          // 量过的坐标多久内算数（画面可能被用户改了）
  const MARK_COLORS = ['#ff2d2d', '#00b7ff', '#ffd400', '#22e06a', '#ff4fe6'];
  const PAD = { left: 64, right: 64, top: 30, bottom: 30 };

  // 刻度间隔：1 / 2 / 5 × 10ⁿ（≥10 时也用 25、250…），让屏幕上大约每 90 像素一条线
  function niceStep(span, target) {
    const raw = Math.max(1, span) / Math.max(1, target);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const options = pow >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
    for (const m of options) if (m * pow >= raw) return Math.max(1, Math.round(m * pow));
    return Math.max(1, Math.round(10 * pow));
  }
  function ticks(from, to, step) { const out = []; for (let v = Math.ceil(from / step) * step; v <= to; v += step) out.push(v); return out; }
  function rectOf(value, what) {
    const n = ['left', 'top', 'right', 'bottom'].map(k => Number(value && value[k]));
    if (!n.every(Number.isFinite) || n[2] <= n[0] || n[3] <= n[1]) throw error('AGENT_LOOK_PARAMS', what + '的坐标无效：要给原图像素坐标 left、top、right、bottom，并且 left < right、top < bottom');
    return { left: n[0], top: n[1], right: n[2], bottom: n[3] };
  }

  // ⭐ 2026-10-17 夜（用户：「让它框选的选区尽可能的是正方形，并且多包裹一点，至少包裹住，就至少多扩展一点，这样方便后续抠擦」）
  //   夏三六给的是「紧贴物体的框」，这里替它做成正方形、往外多包一圈。三样冲突时按这个顺序让：
  //     ① 一定把物体整个包住（硬要求）② 尽量正方形 ③ 再往外多包（余量）
  //   · 余量 = 物体长边 × padPercent%（每边），至少 minPadPx 像素
  //   · 贴着画布边：整块往里挪（那一边余量变少），不裁 —— 裁了就不是正方形了
  //   · 正方形比画布短边还大：先缩余量保正方形；物体本身就比短边大，才只能做成长方形
  //   · 椭圆：要包住物体框的四个角，直径至少是对角线；圆塞不进画布就改成矩形（PS 会把出界的椭圆连形状一起裁小，就包不住了）
  const FIT = { padPercent: 15, minPadPercent: 10, maxPadPercent: 100, minPadPx: 24 };
  function squareFit(rect, docWidth, docHeight, options) {
    const o = options || {}, W = Number(docWidth), H = Number(docHeight);
    if (!(W > 0 && H > 0)) throw error('ASSISTANT_SELECT_NO_DOCUMENT', '不知道画布多大，没法定选区');
    const c = (v, max) => Math.max(0, Math.min(max, v));
    const l = Math.floor(c(rect.left, W)), t = Math.floor(c(rect.top, H)), r = Math.ceil(c(rect.right, W)), b = Math.ceil(c(rect.bottom, H));
    if (r - l < 1 || b - t < 1) throw error('ASSISTANT_SELECT_OUTSIDE', '框在画布外面（画布 ' + W + '×' + H + '），坐标可能量错了，请重新看图');
    const w = r - l, h = b - t, long = Math.max(w, h), notes = [];
    const padPercent = Number.isFinite(Number(o.padPercent)) ? Number(o.padPercent) : FIT.padPercent;
    const pad = Math.max(o.minPadPx == null ? FIT.minPadPx : Number(o.minPadPx), Math.round(long * padPercent / 100));
    let shape = o.shape === 'ellipse' ? 'ellipse' : 'rect';
    let base = shape === 'ellipse' ? Math.ceil(Math.hypot(w, h)) : long;
    const limit = Math.min(W, H);
    if (shape === 'ellipse' && base > limit) { shape = 'rect'; base = long; notes.push('圆形选区要包住这个东西就超出画布了，改成了矩形'); }
    let spanX, spanY;
    if (base <= limit) {
      const side = Math.min(base + 2 * pad, limit);
      if (side < base + 2 * pad) notes.push('画布不够大，往外多包的那圈缩小了（保正方形）');
      spanX = spanY = side;
    } else {
      spanX = Math.min(W, base + 2 * pad); spanY = Math.min(H, base + 2 * pad);
      notes.push('这个东西比画布的短边还大，没法做成正方形，只能做成 ' + spanX + '×' + spanY);
    }
    // 以物体中心为中心摆，再推进画布里；推的时候不准让物体露出去
    const place = (a, z, span, max) => { let s = Math.round((a + z) / 2 - span / 2); s = Math.min(s, a); s = Math.max(s, z - span); return Math.max(0, Math.min(max - span, s)); };
    const x = place(l, r, spanX, W), y = place(t, b, spanY, H);
    const out = { left: x, top: y, right: x + spanX, bottom: y + spanY, shape };
    // 椭圆贴着画布边被推过以后，圆心不在物体中心了 —— 再核一遍四个角在不在圆里，不在就改矩形（包住是硬要求）
    if (shape === 'ellipse') {
      const cx = x + spanX / 2, cy = y + spanY / 2, rx = spanX / 2, ry = spanY / 2;
      const inside = [[l, t], [r, t], [l, b], [r, b]].every(([px, py]) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1);
      if (!inside) { out.shape = 'rect'; notes.push('贴着画布边，圆形选区包不住整个东西，改成了矩形'); }
    }
    const gap = Math.min(l - out.left, out.right - r, t - out.top, out.bottom - b);
    if (gap < Math.min(pad, 8) && !notes.length) notes.push('贴着画布边，那一边多包的少一些');
    return { ...out, square: spanX === spanY, notes };
  }

  // 排版（纯计算，测试直接验）：shown = 这张图对应原图哪一块；imgW/imgH = 读回来的图多大
  function plan(shown, imgW, imgH, marks) {
    const long = Math.max(imgW, imgH);
    // 小块放大到长边 900 左右再画刻度（最多 4 倍），大图不再放大
    const zoom = Math.min(Math.max(1, Math.min(4, 900 / long)), 1600 / long);
    const w = Math.max(1, Math.round(imgW * zoom)), h = Math.max(1, Math.round(imgH * zoom));
    const sx = w / shown.width, sy = h / shown.height;
    const step = niceStep(Math.max(shown.width, shown.height), Math.max(w, h) / 90);
    const X = x => PAD.left + (x - shown.left) * sx, Y = y => PAD.top + (y - shown.top) * sy;
    const minor = step % 5 === 0 && step / 5 * Math.min(sx, sy) >= 8 ? step / 5 : 0;
    return {
      width: w + PAD.left + PAD.right, height: h + PAD.top + PAD.bottom, image: { x: PAD.left, y: PAD.top, w, h },
      step, minor, shown: { ...shown },
      xs: ticks(shown.left, shown.right, step).map(v => ({ v, at: X(v) })),
      ys: ticks(shown.top, shown.bottom, step).map(v => ({ v, at: Y(v) })),
      minorXs: minor ? ticks(shown.left, shown.right, minor).filter(v => v % step).map(X) : [],
      minorYs: minor ? ticks(shown.top, shown.bottom, minor).filter(v => v % step).map(Y) : [],
      marks: (marks || []).map((m, i) => ({ label: m.label, color: MARK_COLORS[i % MARK_COLORS.length], shape: m.shape,
        x: X(m.left), y: Y(m.top), w: (m.right - m.left) * sx, h: (m.bottom - m.top) * sy }))
    };
  }
  function paint(ctx, p, img) {
    ctx.fillStyle = '#1b1d22'; ctx.fillRect(0, 0, p.width, p.height);
    ctx.drawImage(img.source || img, p.image.x, p.image.y, p.image.w, p.image.h);
    const x0 = p.image.x, y0 = p.image.y, x1 = x0 + p.image.w, y1 = y0 + p.image.h;
    // 格线：先画一道深色宽线、再压一道浅色细线 —— 亮背景暗背景都看得见
    const line = (ax, ay, bx, by) => {
      for (const [color, width] of [['rgba(0,0,0,.45)', 3], ['rgba(255,255,255,.75)', 1]]) {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    };
    for (const t of p.xs) line(t.at, y0, t.at, y1);
    for (const t of p.ys) line(x0, t.at, x1, t.at);
    // 刻度尺：四边都标，读最近的那边
    ctx.strokeStyle = '#cfd3da'; ctx.lineWidth = 1;
    const tick = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };
    for (const x of p.minorXs) { tick(x, y0 - 5, x, y0); tick(x, y1, x, y1 + 5); }
    for (const y of p.minorYs) { tick(x0 - 5, y, x0, y); tick(x1, y, x1 + 5, y); }
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 13px sans-serif'; ctx.textBaseline = 'middle';
    for (const t of p.xs) {
      tick(t.at, y0 - 9, t.at, y0); tick(t.at, y1, t.at, y1 + 9);
      ctx.textAlign = 'center'; ctx.fillText(String(t.v), t.at, y0 / 2 - 2); ctx.fillText(String(t.v), t.at, y1 + (p.height - y1) / 2 + 2);
    }
    for (const t of p.ys) {
      tick(x0 - 9, t.at, x0, t.at); tick(x1, t.at, x1 + 9, t.at);
      ctx.textAlign = 'right'; ctx.fillText(String(t.v), x0 - 11, t.at);
      ctx.textAlign = 'left'; ctx.fillText(String(t.v), x1 + 11, t.at);
    }
    // 核对框：带字母标签，对应 marks 的顺序
    for (const m of p.marks) {
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 5;
      const outline = () => { ctx.beginPath(); if (m.shape === 'ellipse' && ctx.ellipse) ctx.ellipse(m.x + m.w / 2, m.y + m.h / 2, Math.abs(m.w / 2), Math.abs(m.h / 2), 0, 0, Math.PI * 2); else ctx.rect(m.x, m.y, m.w, m.h); ctx.stroke(); };
      outline(); ctx.strokeStyle = m.color; ctx.lineWidth = 3; outline();
      ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const tw = (ctx.measureText ? ctx.measureText(m.label).width : 10) + 8;
      ctx.fillStyle = m.color; ctx.fillRect(m.x, m.y - 20, tw, 20); ctx.fillStyle = '#000000'; ctx.fillText(m.label, m.x + 4, m.y - 17);
    }
  }

  function createService(host) {
    const now = host.now || (() => Date.now());
    const docs = new Map();      // docId → 最近一次看过 / 找过的那张图（docName、尺寸、什么时候）
    let epoch = 0, latest = '';
    function remember(d) {
      if (!d || d.docId == null) return null;
      const w = Number(d.docWidth != null ? d.docWidth : d.width), h = Number(d.docHeight != null ? d.docHeight : d.height);
      if (!(Number.isSafeInteger(w) && w > 0 && Number.isSafeInteger(h) && h > 0)) return null;
      const row = { docId: d.docId, docName: String(d.docName || ''), docWidth: w, docHeight: h, at: now() };
      docs.delete(String(d.docId)); docs.set(String(d.docId), row); latest = String(d.docId);
      while (docs.size > 8) docs.delete(docs.keys().next().value);
      return row;
    }
    async function look(options) {
      const o = options || {}, mine = epoch;
      const region = o.region ? rectOf(o.region, '要放大看的区域') : null;
      const rawMarks = Array.isArray(o.marks) ? o.marks : [];
      if (rawMarks.length > 5) throw error('AGENT_LOOK_PARAMS', '一次最多画 5 个核对框');
      const marks = rawMarks.map((m, i) => ({ ...rectOf(m, '核对框'), label: String(m && m.label || String.fromCharCode(65 + i)).slice(0, 6), shape: m && m.shape === 'ellipse' ? 'ellipse' : 'rect' }));
      const shot = await host.capture({ ...(o.docId != null ? { docId: o.docId } : {}), ...(region ? { region } : {}), maxEdge: 1536, expiresAt: now() + 120000 });
      if (mine !== epoch) throw error('AGENT_LOOK_CONTEXT_CHANGED', '账号或会话已经切换，这次看图作废');
      const [width, height, docWidth, docHeight] = [shot && shot.width, shot && shot.height, shot && shot.docWidth, shot && shot.docHeight].map(Number);
      if (!shot || shot.docId == null || !shot.imageBase64 || ![width, height, docWidth, docHeight].every(n => Number.isSafeInteger(n) && n > 0))
        throw error('AGENT_LOOK_CAPTURE_INVALID', '没有拿到完整、尺寸明确的 Photoshop 画布');
      const shown = shot.region && Number(shot.region.right) > Number(shot.region.left)
        ? { left: Number(shot.region.left), top: Number(shot.region.top), right: Number(shot.region.right), bottom: Number(shot.region.bottom) }
        : { left: 0, top: 0, right: docWidth, bottom: docHeight };
      shown.width = shown.right - shown.left; shown.height = shown.bottom - shown.top;
      if (region && (shown.left === 0 && shown.top === 0 && shown.width === docWidth && shown.height === docHeight) && !(region.left <= 0 && region.top <= 0 && region.right >= docWidth && region.bottom >= docHeight))
        throw error('AGENT_LOOK_REGION_IGNORED', 'Photoshop 联动插件还是旧版，不认「放大看某一块」：请用户在 UXP Developer Tool 里 Reload 联动插件');
      const img = await host.decode(shot.mime || 'image/jpeg', shot.imageBase64);
      if (mine !== epoch) throw error('AGENT_LOOK_CONTEXT_CHANGED', '账号或会话已经切换，这次看图作废');
      const p = plan(shown, img.width, img.height, marks);
      const out = host.canvas(p.width, p.height); paint(out.ctx, p, img);
      const base64 = out.toBase64();
      if (!base64) throw error('AGENT_LOOK_ENCODE', '画好刻度的图导不出来');
      remember(shot);
      const range = 'x ' + shown.left + '～' + shown.right + '、y ' + shown.top + '～' + shown.bottom;
      return {
        ok: true, docId: shot.docId, docName: String(shot.docName || ''), docWidth, docHeight,
        shown: { left: shown.left, top: shown.top, right: shown.right, bottom: shown.bottom }, gridStep: p.step,
        selection: shot.selection || null,
        marks: marks.map(m => ({ label: m.label, left: m.left, top: m.top, right: m.right, bottom: m.bottom, shape: m.shape })),
        howToRead: '图已附上。四周刻度和图上格线标的都是【原图像素坐标】（x 向右、y 向下；原图 ' + docWidth + '×' + docHeight + '）。' +
          '这张图显示的是原图 ' + range + ' 这一块，每格 ' + p.step + ' 像素' + (p.minor ? '，刻度尺上的短线每 ' + p.minor + ' 像素一条' : '') + '。' +
          '报坐标直接读刻度，不要按这张图自己的像素去算。要更准就用 region 放大那一块再看；定好了先用 marks 画框核对，框准了再建选区。' +
          (marks.length ? '这次画的框：' + marks.map(m => m.label).join('、') + '（颜色按顺序：红、蓝、黄、绿、粉）。' : ''),
        __modelImage: { mime: 'image/jpeg', base64 }
      };
    }
    async function select(options) {
      const o = options || {}, mine = epoch;
      const list = Array.isArray(o.shapes) ? o.shapes : [];
      if (!list.length || list.length > 10) throw error('ASSISTANT_SELECT_INVALID', '一次给 1～10 个框');
      const asked = list.map(s => ({ ...rectOf(s, '选区框'), shape: s && s.shape === 'ellipse' ? 'ellipse' : 'rect' }));
      let doc = o.docId != null ? docs.get(String(o.docId)) : docs.get(latest);
      if (!doc && o.docId == null) { const active = await host.activeDoc(); if (mine !== epoch) throw error('AGENT_LOOK_CONTEXT_CHANGED', '账号或会话已经切换'); doc = remember(active); }
      if (!doc) throw error('ASSISTANT_SELECT_NO_DOCUMENT', o.docId != null ? '没看过这张图（docId ' + o.docId + '），坐标对不上号：先用看图工具看一眼再建选区' : '没有打开的 Photoshop 文档');
      if (now() - doc.at > KEEP_MS) throw error('ASSISTANT_SELECT_EXPIRED', '这张图是 15 分钟以前看的，画面可能变了：先重新看图，再建选区');
      // 默认：每个框做成正方形、往外多包一圈（squareFit）；exact = 用户明确要「就按这个框」时才原样建
      const exact = o.exact === true;
      const padPercent = Math.max(FIT.minPadPercent, Math.min(FIT.maxPadPercent, Number.isFinite(Number(o.padPercent)) ? Number(o.padPercent) : FIT.padPercent));
      const fitted = exact ? asked.map(s => ({ ...s, notes: [] })) : asked.map(s => squareFit(s, doc.docWidth, doc.docHeight, { padPercent, shape: s.shape }));
      const shapes = fitted.map(({ left, top, right, bottom, shape }) => ({ left, top, right, bottom, shape }));
      const result = await host.select({ docId: doc.docId, docName: doc.docName, docWidth: doc.docWidth, docHeight: doc.docHeight,
        shapes, mode: o.mode === 'add' ? 'add' : 'replace', expiresAt: doc.at + KEEP_MS });
      if (!result || result.applied !== true) throw error('ASSISTANT_SELECT_FAILED', 'Photoshop 没有确认选区已经建立');
      const notes = [...new Set(fitted.flatMap(f => f.notes || []))];
      return { ok: true, ...result, fit: exact ? 'exact' : 'square', ...(exact ? {} : { padPercent }), asked: asked.map(({ left, top, right, bottom, shape }) => ({ left, top, right, bottom, shape })),
        ...(notes.length ? { fitNotes: notes } : {}) };
    }
    return { look, select, remember, clear() { epoch++; docs.clear(); latest = ''; } };
  }

  return { createService, plan, paint, niceStep, ticks, squareFit, FIT, KEEP_MS };
});
