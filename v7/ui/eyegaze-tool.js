/* ═══════════════════════════════════════════════════════════════
   工具与功能 →「眼神调整」（眼珠随动，2026-10-25 用户定，docs/290）

   用户原话：「关于技术验证二，也就是眼珠随动，直接放到工具箱里面去，取名叫眼神调整」。
   ⇒ 工具定义在 tool-silhouettes.js（key 'eyegaze'），面板外壳在 tool-workbench.js（PANELS.eyegaze → mount），这里是干活的：
     ① 抓 PS 选区（选区要包住整张脸）→ ② 后台线程 eyegaze-worker.js 准备（找眼睛、抠眼珠、补眼白，CPU，不到 1 秒）
     ③ 每拖一下滑块，用 eyegaze-core.js 把两只眼那一小块逐像素重叠一遍（实时，不发请求）
     ④「传回 PS」：只把两只眼那块做成一个新图层贴回原位（不覆盖原图层），图层名「眼神调整」

   ⭐ 10-26 改（用户：「眼神调整需要装 python，有些人电脑没有，能不能绕过 python」→ 方案 A）：
     原来 ② 走本机引擎 POST /eyegaze/prepare（Python + mediapipe），没装引擎的人用不了。现在整个在软件里算：
     网页版 MediaPipe 找关键点 + eyegaze-prep.js（eyelib.py 的逐行 JS 版）出图层，不要引擎、不要联网、不收积分。
     跟引擎版的对照（11 组样张）：同一组关键点时图层逐像素一样；关键点网页版跟 Python 版最多差 0.05 像素。
     引擎那条路由没删（老软件还在用），这里不再调。
   ⚠ 预览只画两只眼附近那一块（不是整张图），整张原图不进 DOM（铁律 13）；底图从抓到的图裁、眼部用后台线程出的图层。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc || root.V7EyeGaze) return;
  const C = () => root.V7EyeGazeCore;
  const MAX_CAPTURE = 2048;      // 功能限定 2048 以内（后台线程也会再缩一次）
  const PREP_TIMEOUT_MS = 90000; // 第一次要加载两套 WASM（约 25MB 本地文件），慢机器也该在这之内

  let host = {};                 // { bridge(action, params) → data, layerType() }
  let cur = null;                // 当前挂着的面板

  function configure(h) { host = h || {}; }
  function err(code, message, extra) { const e = new Error(message); e.code = code; if (extra) Object.assign(e, extra); return e; }
  function report(e) {
    try { root.ERR && root.ERR.report(e && e.code && /^EYEGAZE_/.test(e.code) ? e.code : 'EYEGAZE_FAILED', { message: String(e && e.message || e) }); } catch (_) {}
  }

  // ─── 后台线程（整个软件共用一个：模型加载一次，关掉面板也留着，下次打开就快）──
  let worker = null, seq = 0;
  const pending = new Map();     // id → { resolve, reject, say, timer }
  function failAll(e) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); }
  function getWorker() {
    if (worker) return worker;
    try { worker = new root.Worker('eyegaze-worker.js'); }
    catch (e) { throw err('EYEGAZE_FAILED', '眼神调整的后台线程开不起来（' + ((e && e.message) || e) + '），重开软件再试。'); }
    worker.onmessage = ev => {
      const m = ev.data || {}, p = pending.get(m.id);
      if (!p) return;
      if (m.progress) { p.say(m.progress); return; }
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(err(m.code === 'EYEGAZE_UNUSABLE' ? 'EYEGAZE_UNUSABLE' : 'EYEGAZE_FAILED', m.error || '眼神调整没算出来'));
    };
    worker.onerror = ev => {
      // 线程整个挂了：丢掉，下次重开一个（别让一次出错把这个功能锁死）
      const e = err('EYEGAZE_FAILED', '眼神调整的后台线程出错了（' + ((ev && ev.message) || '未知原因') + '），再点一次「抓取选区」试试。');
      try { worker.terminate(); } catch (_) {}
      worker = null; failAll(e);
    };
    return worker;
  }
  /** 抓到的图 + 处理倍率 + 手动圈 → 跟原来引擎 /eyegaze/prepare 一样的结果（图层是 {w,h,data:RGBA}） */
  function prepareInWorker(bytes, up, ov, key, say) {
    return new Promise((resolve, reject) => {
      const w = getWorker(), id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        try { w.terminate(); } catch (_) {}
        if (worker === w) worker = null;
        failAll(err('EYEGAZE_FAILED', '眼神调整 ' + PREP_TIMEOUT_MS / 1000 + ' 秒还没算完，已经停掉了。再点一次「抓取选区」试试。'));
        reject(err('EYEGAZE_FAILED', '眼神调整 ' + PREP_TIMEOUT_MS / 1000 + ' 秒还没算完，已经停掉了。再点一次「抓取选区」试试。'));
      }, PREP_TIMEOUT_MS);
      pending.set(id, { resolve, reject, say: say || (() => {}), timer });
      // ⚠ 图要拷一份再给线程（transfer 会把这边的清空，「按这个圈重做」还要用）
      const copy = bytes.slice().buffer;
      w.postMessage({ id, cmd: 'prepare', bytes: copy, up, ov: ov || null, key }, [copy]);
    });
  }

  // ─── 图片小工具 ───────────────────────────────────────────────
  function b64Bytes(b64) {
    const s = atob(String(b64 || '').replace(/^data:[^,]*,/, '')), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function decodePng(b64) {
    const bmp = await createImageBitmap(new Blob([b64Bytes(b64)], { type: 'image/png' }));
    const c = doc.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0); bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  }

  // ─── 面板 ────────────────────────────────────────────────────
  // ⚠ 用 data-eg 而不是 data-twp：data-twp 会被工具面板自动绑定、存进预设 —— 这些是「这一张图」的调节，不该存
  const SLIDERS = [
    ['depth', '远近', 0, 1000, 10, st => C().depthCm(st) + '厘米', 'target'],
    ['yaw', '左右', -45, 45, 1, v => (v > 0 ? '右' : v < 0 ? '左' : '') + Math.abs(v) + '°', 'manual'],
    ['pitch', '上下', -30, 30, 1, v => (v > 0 ? '上' : v < 0 ? '下' : '') + Math.abs(v) + '°', 'manual'],
    ['conv', '对眼', -20, 40, 1, v => v + '°', 'manual'],
    ['amp', '转动幅度', 40, 100, 1, v => v + '%'],
    ['size', '眼珠大小', 70, 140, 1, v => v + '%'],
    ['pupil', '瞳孔大小', 40, 220, 1, v => v + '%'],
    ['white', '眼白提亮', 0, 100, 1, v => v + '%'],
    ['follow', '眼神光跟随', 0, 100, 1, v => v + '%'],
    ['shrink', '眼眶收缩', 0, 3, 0.1, v => v.toFixed(1) + 'px'],
    ['feather', '边缘羽化', 0.2, 3, 0.1, v => v.toFixed(1) + 'px'],
  ];
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function paramsHtml() {
    const sl = ([k, label, min, max, step, , grp]) =>
      '<div class="v7tw-slider"' + (grp ? ' data-eg-grp="' + grp + '"' : '') + '><label>' + esc(label) + '</label>' +
      '<input type="range" data-eg="' + k + '" min="' + min + '" max="' + max + '" step="' + step + '" aria-label="' + esc(label) + '">' +
      '<span class="v7tw-val" data-egv="' + k + '"></span></div>';
    const tog = (k, label) => '<div class="v7tw-tog"><span>' + esc(label) + '</span><div class="v7tw-sw" data-egsw="' + k + '" role="switch" tabindex="0" aria-label="' + esc(label) + '"></div></div>';
    return '<div class="v7tw-hint" data-eg-status role="status"></div>' +
      '<p class="v7tw-sect">视线</p>' +
      '<div class="v7tw-chips"><button type="button" class="v7tw-chip" data-egmode="target">跟着点看</button><button type="button" class="v7tw-chip" data-egmode="manual">手动角度</button></div>' +
      '<div class="v7tw-hint" data-eg-grp="target">在左边图上按住拖一个点，两只眼一起看过去；「远近」拉近了就是斗鸡眼。</div>' +
      SLIDERS.filter(s => s[6]).map(sl).join('') +
      '<div class="v7tw-btnrow" data-eg-grp="target"><button type="button" class="v7tw-btn" data-eg-act="cam">看镜头</button><button type="button" class="v7tw-btn" data-eg-act="nose">看鼻尖</button></div>' +
      '<p class="v7tw-sect mt">眼珠</p>' +
      SLIDERS.filter(s => !s[6]).map(sl).join('') +
      tog('shade', '明暗跟随') + tog('camNeutral', '原图就是看镜头的') +
      '<p class="v7tw-sect mt">处理倍率</p>' +
      '<div class="v7tw-chips"><button type="button" class="v7tw-chip" data-egup="1">1x</button><button type="button" class="v7tw-chip" data-egup="2">2x</button><button type="button" class="v7tw-chip" data-egup="3">3x</button></div>' +
      '<div class="v7tw-hint">放大再算，小眼睛更稳（会重新准备一次）。预览里滚轮缩放、右键拖动平移、双击回到整张。</div>' +
      '<div class="v7tw-btnrow"><button type="button" class="v7tw-btn" data-eg-act="reset">恢复默认</button></div>';
  }
  function previewHtml() {
    return '<div class="v7tw-box fill v7eg-view" data-eg-view>' +
      '<canvas class="v7eg-cv" data-eg-cv aria-label="眼神调整预览"></canvas>' +
      '<span class="v7tw-boxlbl" data-eg-lbl>在 PS 里框选包住整张脸的区域，点右上角「抓取选区」</span>' +
      '<div class="v7eg-busy" data-eg-busy hidden>正在处理…</div></div>' +
      '<div class="v7tw-btnrow">' +
      '<button type="button" class="v7tw-btn" data-eg-act="hold" disabled title="按住看原图，松开回到调整后">按住看原图</button>' +
      '<button type="button" class="v7tw-btn" data-eg-act="grid" disabled>多方向预览</button>' +
      '<button type="button" class="v7tw-btn" data-eg-act="edit" disabled title="自动认错时：拖橙色圈到眼珠上，拖右边小方块改大小，再点「按圈重做」">调眼珠圈</button>' +
      '<button type="button" class="v7tw-btn" data-eg-act="redo" disabled title="按手动调好的圈重新准备一次">按圈重做</button>' +
      '<button type="button" class="v7tw-btn primary" data-eg-act="send" disabled>传回 PS</button></div>';
  }

  function mount(el) {
    const cv = el.querySelector('[data-eg-cv]'), ctx = cv.getContext('2d');
    const st = Object.assign({}, C().DEFAULTS, { showOrig: false, grid: false, editing: false });
    const view = { s: 1, ox: 0, oy: 0 };
    const state = { el, st, view, S: null, capture: null, bytes: null, up: 1, edit: null, busy: false, alive: true, raf: 0, drag: null };
    cur = state;
    const $ = s => el.querySelector(s);
    const setStatus = (t, level) => { const n = $('[data-eg-status]'); if (n) { n.textContent = t || ''; n.dataset.level = level || ''; } };
    const setBusy = (on, t) => { state.busy = on; const b = $('[data-eg-busy]'); if (b) { b.hidden = !on; if (t) b.textContent = t; } syncButtons(); };
    const lbl = t => { const n = $('[data-eg-lbl]'); if (n) { n.textContent = t || ''; n.hidden = !t; } };

    function syncButtons() {
      const ready = !!(state.S && state.S.eyes.length) && !state.busy;
      el.querySelectorAll('[data-eg-act="hold"],[data-eg-act="grid"],[data-eg-act="edit"],[data-eg-act="send"]').forEach(b => { b.disabled = !ready; });
      const redo = $('[data-eg-act="redo"]'); if (redo) redo.disabled = !(ready && st.editing);
      const run = el.querySelector('[data-twrun]'); if (run) run.disabled = state.busy;
      const g = $('[data-eg-act="grid"]'); if (g) g.classList.toggle('primary', st.grid);
      const e = $('[data-eg-act="edit"]'); if (e) { e.classList.toggle('primary', st.editing); e.textContent = st.editing ? '不调了' : '调眼珠圈'; }
    }
    function syncControls() {
      for (const [k, , , , , fmt] of SLIDERS) {
        const inp = el.querySelector('[data-eg="' + k + '"]'); if (inp) inp.value = st[k];
        const v = el.querySelector('[data-egv="' + k + '"]'); if (v) v.textContent = k === 'depth' ? fmt(st) : fmt(+st[k]);
      }
      el.querySelectorAll('[data-egsw]').forEach(sw => { const on = !!st[sw.dataset.egsw]; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); });
      el.querySelectorAll('[data-egmode]').forEach(b => { const on = b.dataset.egmode === st.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      el.querySelectorAll('[data-eg-grp]').forEach(n => { n.hidden = n.dataset.egGrp !== st.mode; });
      el.querySelectorAll('[data-egup]').forEach(b => { const on = Number(b.dataset.egup) === state.up; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      syncButtons();
    }

    // ── 画面 ──
    function fitCanvas() {
      const r = cv.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      if (!(r.width > 0 && r.height > 0)) return false;
      const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      return true;
    }
    function fitRect(x, y, w, h) {
      if (!fitCanvas()) return;
      view.s = Math.min(cv.width / w, cv.height / h);
      view.ox = (cv.width - w * view.s) / 2 - x * view.s;
      view.oy = (cv.height - h * view.s) / 2 - y * view.s;
    }
    function fitAll() { const S = state.S; if (S) fitRect(S.rx, S.ry, S.rw, S.rh); }
    function renderEyes() {
      const S = state.S; if (!S) return;
      C().renderAll(S.eyes, st, S.sdfScale);
      for (const E of S.eyes) S.rctx.putImageData(E.outImg, E.x0 - S.rx, E.y0 - S.ry);
    }
    function draw() {
      fitCanvas();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, cv.width, cv.height);
      const S = state.S; if (!S) return;
      if (st.grid && S.gridCv) {
        const g = S.gridCv, sc = Math.min(cv.width / g.width, cv.height / g.height);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(g, (cv.width - g.width * sc) / 2, (cv.height - g.height * sc) / 2, g.width * sc, g.height * sc);
        return;
      }
      ctx.imageSmoothingEnabled = view.s < 3; ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
      ctx.drawImage(st.showOrig || st.editing ? S.origCv : S.region, S.rx, S.ry);
      const lw = 1.5 / view.s;
      if (st.editing && state.edit) {
        const hs = 6 / view.s;
        for (const k of Object.keys(state.edit)) {
          const [x, y, r] = state.edit[k];
          ctx.strokeStyle = '#ff9f1a'; ctx.lineWidth = 2 / view.s;
          ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - hs, y); ctx.lineTo(x + hs, y); ctx.moveTo(x, y - hs); ctx.lineTo(x, y + hs); ctx.stroke();
          ctx.fillStyle = '#ff9f1a'; ctx.fillRect(x + r - hs, y - hs, hs * 2, hs * 2);
        }
        return;
      }
      if (st.mode === 'target' && st.tx != null && !st.showOrig) {
        const r = 10 / view.s;
        ctx.strokeStyle = 'rgba(0,200,255,.9)'; ctx.lineWidth = lw; ctx.beginPath();
        ctx.moveTo(st.tx - r, st.ty); ctx.lineTo(st.tx + r, st.ty); ctx.moveTo(st.tx, st.ty - r); ctx.lineTo(st.tx, st.ty + r);
        ctx.stroke(); ctx.beginPath(); ctx.arc(st.tx, st.ty, r * 0.6, 0, 7); ctx.stroke();
      }
    }
    function requestRender() {
      if (state.raf) return;
      state.raf = root.requestAnimationFrame(() => { state.raf = 0; if (!state.alive) return; if (!st.grid) renderEyes(); draw(); });
    }
    function buildGrid() {
      const S = state.S, saved = Object.assign({}, st);
      const [rx, ry, rw, rh] = C().eyesRect(S.eyes, 0.06), cols = 4, rows = Math.ceil(C().GRID.length / cols);
      const cw = 360, ch = Math.max(40, Math.round(cw * rh / rw)), gap = 6, lab = 22;
      const g = doc.createElement('canvas');
      g.width = cw * cols + gap * (cols + 1); g.height = (ch + lab) * rows + gap * (rows + 1);
      const gc = g.getContext('2d');
      gc.fillStyle = '#16181f'; gc.fillRect(0, 0, g.width, g.height); gc.imageSmoothingQuality = 'high';
      C().GRID.forEach(([name, cfg], i) => {
        Object.assign(st, saved, cfg);
        if (!cfg.orig) renderEyes();
        const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + lab + gap);
        gc.drawImage(cfg.orig ? S.origCv : S.region, rx - S.rx, ry - S.ry, rw, rh, x, y + lab, cw, ch);
        gc.fillStyle = '#dfe3ec'; gc.font = '14px "Microsoft YaHei", sans-serif'; gc.fillText(name, x + 4, y + 16);
      });
      Object.assign(st, saved);
      renderEyes();
      S.gridCv = g;
    }
    function changed() { syncControls(); if (st.grid && state.S) buildGrid(); requestRender(); }

    // ── 准备（抓图 → 引擎 → 图层）──
    async function load(meta, img) {
      const eyes = [];
      // 图层：后台线程给的是 {w,h,data:RGBA}；老的引擎回包是 PNG base64（留着兼容，测试脚本还会喂这种）
      const layer = v => (typeof v === 'string' ? decodePng(v) : new ImageData(new Uint8ClampedArray(v.data.buffer, v.data.byteOffset, v.data.length), v.w, v.h));
      for (const m of meta.eyes) {
        const [x0, y0, w, h] = m.crop, L = m.layers;
        const [B, O, M1, M2, TR, TF, TA] = await Promise.all([L.base, L.orig, L.maps1, L.maps2, L.tex_raw, L.tex_flat, L.tex_a].map(layer));
        const outImg = new ImageData(w, h);
        eyes.push({ m, x0, y0, w, h, B: B.data, O: O.data, M1: M1.data, M2: M2.data, TR: TR.data, TF: TF.data, TA: TA.data, out: outImg.data, outImg, Oimg: O });
        delete m.layers;
      }
      // ⭐ 10-26（用户：预览要是百分之百的图片、展示完全）：预览 = 抓到的整张图（处理后坐标），打开时整张放进框里
      const rx = 0, ry = 0, rw = meta.w, rh = meta.h;
      const sc = meta.scale || 1;
      const region = doc.createElement('canvas'); region.width = rw; region.height = rh;
      const rctx = region.getContext('2d', { willReadFrequently: true });
      rctx.imageSmoothingEnabled = true; rctx.imageSmoothingQuality = 'high';
      rctx.drawImage(img, rx / sc, ry / sc, rw / sc, rh / sc, 0, 0, rw, rh);
      const origCv = doc.createElement('canvas'); origCv.width = rw; origCv.height = rh;
      const octx = origCv.getContext('2d');
      octx.drawImage(region, 0, 0);
      for (const E of eyes) octx.putImageData(E.Oimg, E.x0 - rx, E.y0 - ry);
      const pair = C().eyePair(eyes);
      state.S = { meta, eyes, sdfScale: meta.sdfScale || 8, region, rctx, origCv, rx, ry, rw, rh, ipd: pair.ipd, mid: pair.mid, gridCv: null };
      const side = { R: '右眼(画面左)', L: '左眼(画面右)' };
      const lines = [meta.w + '×' + meta.h + (state.up > 1 ? '（' + state.up + 'x）' : '') + ' · 准备 ' + meta.seconds + ' 秒 · 找到 ' + meta.faces + ' 张脸（只处理最大那张）'];
      for (const E of eyes) {
        const m = E.m;
        lines.push((side[m.side] || m.side) + '：眼珠半径 ' + m.R.toFixed(1) + 'px · 复原误差 ' + (m.neutralErr || 0).toFixed(1) + (m.notes && m.notes.length ? ' · ' + m.notes.join('；') : ''));
      }
      const bad = eyes.some(E => (E.m.neutralErr || 0) > 10);
      if (bad) lines.push('⚠ 复原误差超过 10：眼珠圈多半认错了，点「手动调眼珠圈」拖到眼珠上，再点「按这个圈重做」');
      if (!eyes.length) lines.push('没找到能用的眼睛。');
      setStatus(lines.join('\n'), bad ? 'warn' : '');
      lbl('');
      st.grid = false; st.editing = false; state.edit = null;
      fitAll(); syncControls(); requestRender();
    }
    async function prepare(ov) {
      if (!state.bytes || state.busy) return;
      setBusy(true, '正在准备（找眼睛、补眼珠、补眼白）…');
      try {
        const meta = await prepareInWorker(state.bytes, state.up, ov || null, state.capKey, t => { if (state.alive) setBusy(true, t); });
        if (!state.alive) return;
        await load(meta, state.img);
      } catch (e) {
        if (!state.alive) return;
        setStatus((e && e.message) || String(e), 'err');
        if (!e || e.code !== 'EYEGAZE_UNUSABLE') report(e);
      } finally {
        if (state.alive) setBusy(false);
      }
    }
    async function capture() {
      if (state.busy) return;
      if (!host.bridge) { setStatus('眼神调整没接上 Photoshop（宿主没配置），重开软件再试。', 'err'); return; }
      setBusy(true, '正在从 Photoshop 抓取选区…');
      try {
        const cap = await host.bridge('ps.selection.capture', { allowFullCanvas: true, maxResolution: MAX_CAPTURE });
        if (!state.alive) return;
        const b64 = cap && (cap.imageBase64 || cap.inputImageBase64);
        if (!b64) throw err('EYEGAZE_FAILED', 'Photoshop 没回图片，检查联动插件是不是连着');
        const bytes = b64Bytes(b64);
        const img = await createImageBitmap(new Blob([bytes], { type: cap.mime || 'image/png' }));
        if (state.img && state.img.close) state.img.close();
        state.capture = { docId: cap.docId, docName: cap.docName, selection: cap.selection, width: img.width, height: img.height };
        state.bytes = bytes; state.img = img; state.S = null; state.edit = null;
        state.capKey = 'cap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);   // 后台线程按它认「还是同一张图」，免得重做时再解码
        Object.assign(st, C().DEFAULTS, { showOrig: false, grid: false, editing: false });
        setBusy(false);
        await prepare(null);
      } catch (e) {
        if (!state.alive) return;
        setBusy(false);
        const msg = (e && e.message) || String(e);
        setStatus('抓取没成功：' + msg, 'err');
        if (!/NO_SELECTION|没有选区/.test(String(e && e.code) + msg)) report(Object.assign(e instanceof Error ? e : new Error(msg), { code: 'EYEGAZE_FAILED', message: '抓取没成功：' + msg }));
      }
    }

    // ── 传回 PS：只贴两只眼那块，新图层 ──
    async function send() {
      const S = state.S, cap = state.capture;
      if (!S || !S.eyes.length || !cap || state.busy) return;
      if (!host.bridge) { setStatus('眼神调整没接上 Photoshop，重开软件再试。', 'err'); return; }
      setBusy(true, '正在传回 Photoshop…');
      try {
        st.grid = false; renderEyes();
        // ⚠ 10-26 改（真机实测走「置入」会偏 1 像素）：按 PS 文档像素直接写一个新图层（ps.layer.putPixels），位置精确、不缩放
        //   坐标链：处理图（可能 2x/3x）→ 抓图（÷ scale）→ PS 文档（× 选区/抓图，抓图被缩小过时放回去）
        const sc = S.meta.scale || 1;
        const sel = cap.selection || { left: 0, top: 0, width: cap.width, height: cap.height };
        const fx = (Number(sel.width) || cap.width) / cap.width, fy = (Number(sel.height) || cap.height) / cap.height;
        const kx = fx / sc, ky = fy / sc;                                   // 处理图 1 像素 = 文档 kx × ky 像素
        const [bx, by, bw, bh] = C().eyesRect(S.eyes, 0);
        const dx0 = Math.floor(Number(sel.left) + bx * kx), dy0 = Math.floor(Number(sel.top) + by * ky);
        const dx1 = Math.ceil(Number(sel.left) + (bx + bw) * kx), dy1 = Math.ceil(Number(sel.top) + (by + bh) * ky);
        const work = doc.createElement('canvas'); work.width = Math.ceil(bw); work.height = Math.ceil(bh);
        const wctx = work.getContext('2d');
        for (const E of S.eyes) wctx.putImageData(E.outImg, E.x0 - bx, E.y0 - by);
        const outCv = doc.createElement('canvas'); outCv.width = dx1 - dx0; outCv.height = dy1 - dy0;
        const o = outCv.getContext('2d', { willReadFrequently: true }); o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
        o.drawImage(work, 0, 0, work.width, work.height, Number(sel.left) + bx * kx - dx0, Number(sel.top) + by * ky - dy0, work.width * kx, work.height * ky);
        const px = o.getImageData(0, 0, outCv.width, outCv.height).data;
        let bin = ''; for (let i = 0; i < px.length; i += 32768) bin += String.fromCharCode.apply(null, px.subarray(i, i + 32768));
        await host.bridge('ps.layer.putPixels', { docId: cap.docId, name: '眼神调整', rgba: btoa(bin), width: outCv.width, height: outCv.height, left: dx0, top: dy0,
          layerType: typeof host.layerType === 'function' ? host.layerType() : 'smartObject' });
        if (!state.alive) return;
        setStatus('已传回 Photoshop：新图层「眼神调整」，只盖住两只眼那一块。', 'ok');
        try { root.UI && root.UI.toast && root.UI.toast('眼神调整已传回 Photoshop', 'ok', 2400); } catch (_) {}
      } catch (e) {
        if (!state.alive) return;
        setStatus('传回没成功：' + ((e && e.message) || e), 'err');
        report(Object.assign(e instanceof Error ? e : new Error(String(e)), { code: 'EYEGAZE_RETURN_FAILED', message: '传回没成功：' + ((e && e.message) || e) }));
      } finally {
        if (state.alive) setBusy(false);
      }
    }

    // ── 控件 ──
    el.addEventListener('input', ev => {
      const t = ev.target;
      if (!t.matches || !t.matches('input[type=range][data-eg]')) return;
      st[t.dataset.eg] = Number(t.value);
      changed();
    });
    const toggleSw = sw => { st[sw.dataset.egsw] = !st[sw.dataset.egsw]; changed(); };
    el.addEventListener('keydown', ev => { const sw = ev.target.closest && ev.target.closest('[data-egsw]'); if (sw && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleSw(sw); } });
    el.addEventListener('click', ev => {
      const sw = ev.target.closest && ev.target.closest('[data-egsw]');
      if (sw) { toggleSw(sw); return; }
      const b = ev.target.closest && ev.target.closest('button');
      if (!b || !el.contains(b)) return;
      if (b.dataset.egmode) { st.mode = b.dataset.egmode; changed(); return; }
      if (b.dataset.egup) {
        const up = Number(b.dataset.egup);
        if (up === state.up) return;
        state.up = up; syncControls();
        if (state.bytes) prepare(null);
        return;
      }
      const act = b.dataset.egAct;
      const S = state.S;
      if (act === 'reset') { Object.assign(st, C().DEFAULTS, { grid: st.grid, editing: st.editing }); changed(); }
      else if (act === 'cam' && S && S.mid) { st.tx = S.mid[0]; st.ty = S.mid[1]; st.depth = 1000; changed(); }
      else if (act === 'nose' && S && S.mid) { st.tx = S.mid[0]; st.ty = S.mid[1] + 0.75 * S.ipd; st.depth = Math.round(1000 * Math.log(0.4 / 0.3) / Math.log(100)); changed(); }
      else if (act === 'grid' && S) { st.grid = !st.grid; st.editing = false; state.edit = null; if (st.grid) buildGrid(); syncControls(); draw(); }
      else if (act === 'edit' && S && S.eyes.length) {
        if (st.editing) { st.editing = false; state.edit = null; }
        else { state.edit = {}; for (const E of S.eyes) state.edit[E.m.side] = [E.x0 + E.m.iris[0], E.y0 + E.m.iris[1], E.m.R]; st.editing = true; st.grid = false; }
        syncControls(); draw();
      }
      else if (act === 'redo' && state.edit) {
        const ov = {};
        for (const k of Object.keys(state.edit)) ov[k] = state.edit[k].map(v => Math.round(v * 100) / 100);
        st.editing = false; state.edit = null; syncControls();
        prepare(ov);
      }
      else if (act === 'send') send();
    });
    const hold = $('[data-eg-act="hold"]');
    hold.addEventListener('pointerdown', () => { st.showOrig = true; draw(); });
    for (const evn of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(evn, () => { if (st.showOrig) { st.showOrig = false; draw(); } });

    // 画面：滚轮缩放、右键 / 中键拖平移、左键拖 = 设目标点（跟着点看）、双击 = 回到两只眼
    const toImg = e => {
      const r = cv.getBoundingClientRect(), dpr = cv.width / r.width;
      const sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr;
      return [(sx - view.ox) / view.s, (sy - view.oy) / view.s, sx, sy];
    };
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('dblclick', () => { st.grid = false; syncControls(); fitAll(); draw(); });
    cv.addEventListener('wheel', e => {
      if (!state.S || st.grid) return;
      e.preventDefault(); e.stopPropagation();
      const [ix, iy, sx, sy] = toImg(e);
      view.s = C().clamp(view.s * Math.pow(1.0015, -e.deltaY), 0.05, 40);
      view.ox = sx - ix * view.s; view.oy = sy - iy * view.s;
      draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      if (!state.S || st.grid) return;
      cv.setPointerCapture(e.pointerId);
      const [ix, iy, sx, sy] = toImg(e);
      const edit = state.edit;
      if (st.editing && edit && e.button === 0) {
        const tol = 10 / view.s;
        for (const k of Object.keys(edit)) { const [x, y, r] = edit[k]; if (Math.hypot(ix - (x + r), iy - y) < tol) { state.drag = { kind: 'radius', k }; return; } }
        for (const k of Object.keys(edit)) { const [x, y, r] = edit[k]; if (Math.hypot(ix - x, iy - y) < r) { state.drag = { kind: 'move', k, dx: ix - x, dy: iy - y }; return; } }
        state.drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }; return;
      }
      if (e.button === 0 && st.mode === 'target') { state.drag = { kind: 'target' }; st.tx = ix; st.ty = iy; requestRender(); }
      else state.drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy };
    });
    cv.addEventListener('pointermove', e => {
      const d = state.drag; if (!state.S || st.grid || !d) return;
      const [ix, iy, sx, sy] = toImg(e);
      if (d.kind === 'pan') { view.ox = d.ox + sx - d.sx; view.oy = d.oy + sy - d.sy; draw(); }
      else if (d.kind === 'radius') { const c = state.edit[d.k]; c[2] = Math.max(2, Math.hypot(ix - c[0], iy - c[1])); draw(); }
      else if (d.kind === 'move') { const c = state.edit[d.k]; c[0] = ix - d.dx; c[1] = iy - d.dy; draw(); }
      else if (d.kind === 'target') { st.tx = ix; st.ty = iy; requestRender(); }
    });
    const endDrag = () => { state.drag = null; };
    cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (state.S && !state.drag) { fitCanvas(); draw(); } }) : null;
    if (ro) ro.observe(cv);

    el._twRun = capture;
    syncControls(); draw();
    return function dispose() {
      state.alive = false;
      if (state.raf) root.cancelAnimationFrame(state.raf);
      if (ro) ro.disconnect();
      if (state.img && state.img.close) try { state.img.close(); } catch (_) {}
      state.S = null; state.bytes = null;
      if (cur === state) cur = null;
    };
  }

  /** 工具列表 / 剪影 / 快捷入口：打开工具大卡（tool-silhouettes.open 优先走大卡，这里是兜底） */
  function open() {
    const TW = root.V7ToolWorkbench;
    if (TW && typeof TW.open === 'function' && (!TW.canOpen || TW.canOpen())) {
      const preset = root.PRESETS && root.PRESETS.presetById ? root.PRESETS.presetById('__tool_eyegaze_default__') : null;
      return TW.open('eyegaze', preset || { id: '__tool_eyegaze_default__' });
    }
    throw new Error('工具大卡没加载起来，重新打开软件再试');
  }

  root.V7EyeGaze = { configure, open, mount, paramsHtml, previewHtml, _state: () => cur, _prepare: prepareInWorker };
})(typeof window !== 'undefined' ? window : globalThis);
