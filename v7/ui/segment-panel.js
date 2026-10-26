/* ═══════════════════════════════════════════════════════════════
   任务卡「分割」：新增物体抠图（2026-10-25 用户定，算法 docs/289）

   用户原话：「在任务卡片的传回按钮的右侧，再添加一个分割按钮。点开分割按钮之后，在图片预览的地方打开大图预览，
            即可在里面看到相关参数调整，并且直接实时显示。拖动滑块参数，即直接展示黑白蒙版；松手即显示原图加上调整后显示的区域。
            这时点击回传，回传图层不受影响，附带一个蒙版，蒙版就是我们调出来的区域。这种情况下，蒙版羽化功能就要相对来说避让一下。」

   做法：
     · ⭐ 10-26 改（用户：「分割框的宽度有问题」「联动消失要和任务预览大图框一个规则」）：分割框【骑在大预览框上】——
       打开时照常给这张图打开大预览框（host.attachBox），分割框跟它一样大、摆在同一个位置，大预览框本身藏在底下（visibility:hidden）。
       收不收全由大预览框那一套说了算（鼠标离开 任务卡 / 缩略图条 / 框 这条链 160ms、指针离开窗口）：框一收，分割框跟着收；
       框挪了位置，分割框跟着挪；鼠标划到别的缩略图，框换了张，分割框也换到那一张。Esc / 取消 关掉。
     · 生成图用【调过强度的那一帧】（host.loadGen → V7Tween.frameBytesFor）：用户说「调了强度的图，点分割要继承那个强度」；
     · 算法在后台线程（diff-mask-worker.js → diff-mask-core.js），拖滑块不卡界面、也不用本机引擎；
     · 回传：这张还没传过 → 照常传回 + 带蒙版（这一张不加边缘羽化）；已经传过 → 给 PS 里那个图层换上这个蒙版。
       这两件事由宿主（ui-main 的 segmentHost）做，这里只给它一张「黑底 + 透明度 = 蒙版」的 PNG。

   ⚠ 用 innerHTML 拼的结构里【不许写 style 属性】：CSP 会静默拦掉（铁律 17 那张表）。位置一律 el.style 赋值。
   ⚠ 只认原图 task.sourceImgId + 这一张的 shot.imgId（当前显示的那一版）。两张都在图片管家里，原图不进 DOM（铁律 13）。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc || root.V7SegmentPanel) return;

  const MIN_W = 620, MIN_H = 560;
  const SLIDERS = [
    { key: 'sens', label: '差值灵敏度', hint: '往右：改得轻的也选出来（噪点也会多）；往左更保守' },
    { key: 'denoise', label: '去碎点强度', hint: '往右删得越狠，大一点的孤立杂块也删' },
    { key: 'smooth', label: '平滑', hint: '把锯齿抹圆顺，细长的发丝 / 细杆会保留' },
    { key: 'feather', label: '模糊', hint: '边缘过渡；默认只往外，物体本身不变透' }
  ];
  const KEEP_HINT = ['不管连不连着，全都留', '离最大那块近一点的小块也留', '只留最大那块和紧挨着它的', '只留最大的一块'];

  let host = null;     // { loadBlob(imgId), loadGen(task, idx) → {blob, strength}, attachBox(task, taskEl, idx) → 大预览框元素, boxShot(task), keepBox(), returnWithMask(task, idx, mask), geometry(taskEl), report(code, ctx), latestTask(task) }
  let cur = null;      // 当前打开的那一个
  const savedParams = new WeakMap();   // task → { [shotIndex]: params }（只在这次打开软件期间记着）

  function setHost(h) { host = h || null; }
  function doneShots(task) {
    return ((task && task.shots) || []).map((s, i) => ({ s, i })).filter(x => x.s && x.s.done && x.s.imgId && x.s.restoreState === 'done');
  }
  /** 任务卡上要不要出「分割」按钮 */
  function eligible(task) {
    return !!(task && task.kind === 'generation' && task.sourceImgId && !task.colorToolRunId
      && !(task.migration && task.migration.returnBlocked) && doneShots(task).length);
  }

  // ─── 后台线程 ────────────────────────────────────────────────
  function makeWorker() {
    const worker = new Worker('diff-mask-worker.js');
    const waits = new Map();
    let seq = 0, dead = null;
    worker.onmessage = e => {
      const m = e.data || {}, w = waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      m.ok ? w.resolve(m.result) : w.reject(Object.assign(new Error(m.error || '分割计算失败'), { code: 'ADDMASK_FAILED' }));
    };
    worker.onerror = e => {
      dead = new Error('分割的后台计算中断了' + (e && e.message ? '：' + e.message : '') + '（图太大时可能是内存不够，缩小选区再试）');
      for (const w of waits.values()) w.reject(dead);
      waits.clear();
    };
    return {
      call(type, payload, transfer) {
        if (dead) return Promise.reject(dead);
        const id = ++seq;
        return new Promise((resolve, reject) => { waits.set(id, { resolve, reject }); worker.postMessage(Object.assign({ type, id }, payload || {}), transfer || []); });
      },
      stop() { try { worker.terminate(); } catch (_) {} for (const w of waits.values()) w.reject(Object.assign(new Error('已关闭'), { code: 'ADDMASK_CLOSED' })); waits.clear(); }
    };
  }

  // ─── 界面 ────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function build() {
    const el = doc.createElement('div');
    el.className = 'v7seg';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '分割：抠出新加的东西');
    el.innerHTML =
      '<div class="v7seg-panel">' +
      '  <div class="v7seg-view"><canvas class="v7seg-canvas" aria-label="分割预览"></canvas>' +
      '    <div class="v7seg-busy">正在处理…</div>' +
      '    <div class="v7seg-mode" data-seg-mode></div>' +
      '  </div>' +
      '  <div class="v7seg-side">' +
      '    <div class="v7seg-head"><b>分割</b><span class="v7seg-shot" data-seg-shot></span>' +
      '      <button type="button" class="v7seg-nav" data-seg-prev aria-label="上一张">‹</button>' +
      '      <button type="button" class="v7seg-nav" data-seg-next aria-label="下一张">›</button></div>' +
      '    <p class="v7seg-tip">只抠 AI 新加的东西。拖滑块时看黑白蒙版，松手看贴回去的样子。</p>' +
      SLIDERS.slice(0, 2).map(sliderHtml).join('') +
      '    <div class="v7seg-row"><div class="v7seg-lbl"><span>保持连续</span><em data-segv="keep"></em></div>' +
      '      <div class="v7seg-keep" role="group" aria-label="保持连续">' +
      ['关', '宽松', '标准', '严格'].map((t, i) => '<button type="button" data-seg-keep="' + i + '">' + t + '</button>').join('') +
      '      </div><small data-seg-keephint></small></div>' +
      SLIDERS.slice(2).map(sliderHtml).join('') +
      '    <label class="v7seg-check"><input type="checkbox" data-seg="featherOut"><span>模糊只往外</span></label>' +
      '    <div class="v7seg-status" data-seg-status role="status"></div>' +
      '    <div class="v7seg-acts">' +
      '      <button type="button" class="v7seg-btn" data-seg-reset>恢复默认</button>' +
      '      <button type="button" class="v7seg-btn" data-overlay-close data-seg-cancel>取消</button>' +
      '      <button type="button" class="v7seg-btn primary" data-seg-return>回传</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    return el;
  }
  function sliderHtml(s) {
    return '<label class="v7seg-row"><div class="v7seg-lbl"><span>' + esc(s.label) + '</span><em data-segv="' + s.key + '"></em></div>' +
      '<input type="range" min="0" max="100" step="1" data-seg="' + s.key + '" aria-label="' + esc(s.label) + '"><small>' + esc(s.hint) + '</small></label>';
  }

  function place(el, taskEl) {
    const vw = root.innerWidth || 1020, vh = root.innerHeight || 900;
    // 骑在大预览框上：跟它一模一样大、一样位置
    if (cur && cur.box && cur.box.isConnected) {
      const r = cur.box.getBoundingClientRect(), p = el.querySelector('.v7seg-panel');
      if (r.width > 0 && r.height > 0) {
        p.style.left = Math.round(r.left) + 'px'; p.style.top = Math.round(r.top) + 'px';
        p.style.width = Math.round(r.width) + 'px'; p.style.height = Math.round(r.height) + 'px';
        return;
      }
    }
    let g = null;
    try { g = host && host.geometry ? host.geometry(taskEl) : null; } catch (_) { g = null; }
    if (!g || !(g.width > 0) || !(g.height > 0)) {
      // 拿不到预览框的位置（预览条没弹出来）：贴着任务卡右边放
      const r = taskEl && taskEl.getBoundingClientRect ? taskEl.getBoundingClientRect() : null;
      g = r ? { left: r.right + 12, top: Math.max(8, r.bottom - 520), width: MIN_W, height: 520 } : { left: (vw - MIN_W) / 2, top: 40, width: MIN_W, height: 520 };
    }
    const width = Math.min(vw - 16, Math.max(MIN_W, g.width));
    const height = Math.min(vh - 16, Math.max(MIN_H, g.height));
    const left = Math.max(8, Math.min(vw - width - 8, g.left));
    const top = Math.max(8, Math.min(vh - height - 8, g.top + (g.height - height)));
    const p = el.querySelector('.v7seg-panel');
    p.style.left = Math.round(left) + 'px'; p.style.top = Math.round(top) + 'px';
    p.style.width = Math.round(width) + 'px'; p.style.height = Math.round(height) + 'px';
  }

  // ─── 状态 ────────────────────────────────────────────────────
  function paramsFor(task, idx) {
    const all = savedParams.get(task) || {};
    return Object.assign({}, root.V7DiffMask.DEFAULTS, all[idx] || {});
  }
  function remember() {
    if (!cur) return;
    const all = savedParams.get(cur.task) || {};
    all[cur.idx] = Object.assign({}, cur.params);
    savedParams.set(cur.task, all);
  }
  function syncControls() {
    const el = cur.el, P = cur.params;
    el.querySelectorAll('input[type=range][data-seg]').forEach(inp => { inp.value = String(P[inp.dataset.seg]); });
    SLIDERS.forEach(s => { const v = el.querySelector('[data-segv="' + s.key + '"]'); if (v) v.textContent = String(Math.round(P[s.key])); });
    el.querySelectorAll('[data-seg-keep]').forEach(b => { const on = Number(b.dataset.segKeep) === Number(P.keep); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    const kh = el.querySelector('[data-seg-keephint]'); if (kh) kh.textContent = KEEP_HINT[P.keep] || '';
    const fo = el.querySelector('[data-seg="featherOut"]'); if (fo) fo.checked = P.featherOut !== false;
    const shots = doneShots(cur.task), at = shots.findIndex(x => x.i === cur.idx);
    el.querySelector('[data-seg-shot]').textContent = '第 ' + (cur.idx + 1) + ' 张' + (shots.length > 1 ? '（' + (at + 1) + '/' + shots.length + '）' : '');
    el.querySelector('[data-seg-prev]').hidden = el.querySelector('[data-seg-next]').hidden = shots.length < 2;
  }
  function setBusy(on, text) {
    if (!cur) return;
    const b = cur.el.querySelector('.v7seg-busy');
    b.style.display = on ? '' : 'none';
    if (text) b.textContent = text;
  }
  function setStatus(text, level) {
    if (!cur) return;
    const s = cur.el.querySelector('[data-seg-status]');
    s.textContent = text || '';
    s.dataset.level = level || '';
  }
  function setMode(view) {
    const m = cur && cur.el.querySelector('[data-seg-mode]');
    if (m) m.textContent = view === 'mask' ? '黑白蒙版（白 = 留下）' : '贴回去的样子';
  }

  // 一次只发一个，拖得快时只算最后那一下
  function request(kind) {
    if (!cur || !cur.prepared) return;
    cur.want = kind === 'view' && cur.want === 'tune' ? 'tune' : kind;
    if (cur.inflight) return;
    pump();
  }
  function pump() {
    const c = cur;
    if (!c || !c.want) return;
    const kind = c.want, view = c.view;
    c.want = null;
    c.inflight = true;
    const msg = kind === 'tune' ? { params: Object.assign({}, c.params), view } : { view };
    c.worker.call(kind, msg).then(r => {
      if (cur !== c) return;
      draw(r);
      setMode(view);
      if (kind === 'tune') {
        c.tuned = true;
        const t = Math.round(r.t), pct = (r.coverage * 100);
        let text = (c.strength != null && c.strength < 0.999 ? '按调过的强度 ' + Math.round(c.strength * 100) + '% · ' : '') + '差值门槛 ' + t + (Math.abs(r.t - r.t0) >= 0.5 ? '（自动算的是 ' + Math.round(r.t0) + '）' : '（自动）') + ' · 选中 ' + (pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)) + '%';
        if (c.aspectOff > 0.03) text += '\n⚠ 生成图和原图长宽比差 ' + (c.aspectOff * 100).toFixed(1) + '%（AI 可能裁过边），结果会整体偏';
        setStatus(text, c.aspectOff > 0.03 ? 'warn' : '');
      }
    }).catch(err => {
      if (cur !== c || (err && err.code === 'ADDMASK_CLOSED')) return;
      setStatus('算不出来：' + (err && err.message || err), 'err');
    }).then(() => {
      if (cur !== c) return;
      c.inflight = false;
      if (c.want) pump();
    });
  }
  function draw(r) {
    const cv = cur.el.querySelector('.v7seg-canvas');
    if (cv.width !== r.pw || cv.height !== r.ph) { cv.width = r.pw; cv.height = r.ph; }
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.pw, r.ph), 0, 0);
  }

  async function loadShot(idx) {
    const c = cur;
    c.idx = idx;
    c.prepared = false; c.tuned = false; c.want = null;
    c.params = paramsFor(c.task, idx);
    c.view = 'comp';
    syncControls();
    setBusy(true, '正在处理…');
    setStatus('');
    if (c.worker) c.worker.stop();
    c.worker = makeWorker();
    try {
      const shot = c.task.shots[idx];
      const [orig, g] = await Promise.all([host.loadBlob(c.task.sourceImgId), host.loadGen ? host.loadGen(c.task, idx) : host.loadBlob(shot.imgId).then(blob => ({ blob, strength: 1 }))]);
      const gen = g.blob;
      c.strength = g.strength;
      if (cur !== c || c.idx !== idx) return;
      const info = await c.worker.call('prepare', { orig, gen });
      if (cur !== c || c.idx !== idx) return;
      c.prepared = true;
      c.aspectOff = info.aspectOff;
      c.size = info;
      setBusy(false);
      request('tune');
    } catch (err) {
      if (cur !== c || (err && err.code === 'ADDMASK_CLOSED')) return;
      setBusy(false);
      setStatus('这张图打不开：' + (err && err.message || err) + '（原图或生成图已经被释放的话，重新点开任务卡再试）', 'err');
      if (host && host.report) host.report('ADDMASK_FAILED', { message: String(err && err.message || err), context: { '第几张': idx + 1 } });
    }
  }

  function bind(el) {
    el.addEventListener('input', e => {
      const t = e.target;
      if (!cur || !t.matches('input[type=range][data-seg]')) return;
      cur.params[t.dataset.seg] = Number(t.value);
      const v = el.querySelector('[data-segv="' + t.dataset.seg + '"]'); if (v) v.textContent = t.value;
      cur.view = 'mask';
      request('tune');
    });
    const release = e => {
      if (!cur || !e.target.matches('input[type=range][data-seg]')) return;
      remember();
      if (cur.view !== 'comp') { cur.view = 'comp'; request('view'); }
    };
    el.addEventListener('change', e => {
      const t = e.target;
      if (!cur) return;
      if (t.matches('[data-seg="featherOut"]')) { cur.params.featherOut = !!t.checked; remember(); cur.view = 'comp'; request('tune'); return; }
      release(e);
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    // 按住滑块（还没拖）就先切到黑白蒙版
    el.addEventListener('pointerdown', e => {
      if (!cur || !e.target.matches('input[type=range][data-seg]')) return;
      if (cur.view !== 'mask') { cur.view = 'mask'; request('view'); }
    });
    el.addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t || !cur) return;
      if (t.dataset.segKeep != null) { cur.params.keep = Number(t.dataset.segKeep); remember(); syncControls(); cur.view = 'comp'; request('tune'); return; }
      if (t.hasAttribute('data-seg-reset')) { cur.params = Object.assign({}, root.V7DiffMask.DEFAULTS); remember(); syncControls(); cur.view = 'comp'; request('tune'); return; }
      if (t.hasAttribute('data-seg-cancel')) { close(); return; }
      if (t.hasAttribute('data-seg-prev') || t.hasAttribute('data-seg-next')) {
        const shots = doneShots(cur.task), at = shots.findIndex(x => x.i === cur.idx);
        const next = shots[(at + (t.hasAttribute('data-seg-next') ? 1 : shots.length - 1)) % shots.length];
        if (next && next.i !== cur.idx) { remember(); loadShot(next.i); }
        return;
      }
      if (t.hasAttribute('data-seg-return')) { doReturn(t); }
    });
  }

  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }

  async function doReturn(btn) {
    const c = cur;
    if (!c || !c.tuned || c.returning) return;
    c.returning = true;
    btn.disabled = true;
    setBusy(true, '正在传回…');
    try {
      remember();
      // ⚠ 等最后一次拖动算完：导出的是线程里【当前】那张蒙版
      while (cur === c && (c.inflight || c.want)) await new Promise(r => setTimeout(r, 40));
      const task = host.latestTask ? host.latestTask(c.task) : c.task;
      // 蒙版按 PS 里贴回那块选区的像素尺寸出（生成图会被缩放到那么大贴回去）
      const sel = (task.captureSnapshot && task.captureSnapshot.selection) || task.sourceSelection || {};
      const out = await c.worker.call('export', { width: Number(sel.width) || c.size.gw, height: Number(sel.height) || c.size.gh });
      const r = await host.returnWithMask(task, c.idx, { rle: bytesToBase64(out.rle), width: out.width, height: out.height });
      if (cur !== c) return;
      if (r && r.ok) { close(); return; }
      setStatus('传回没成功：' + (r && r.error || '未知原因') + '（分割框还开着，可以再点一次）', 'err');
    } catch (err) {
      if (cur !== c) return;
      setStatus('传回没成功：' + (err && err.message || err), 'err');
    } finally {
      if (cur === c) { c.returning = false; btn.disabled = false; setBusy(false); }
    }
  }

  function open(task, taskEl, shotIndex) {
    if (!host || !root.V7DiffMask) return false;
    if (!eligible(task)) return false;
    close();
    const shots = doneShots(task);
    const idx = shots.some(x => x.i === shotIndex) ? shotIndex : shots[0].i;
    const el = build();
    doc.body.appendChild(el);
    cur = { task, el, idx, worker: null, params: null, view: 'comp', box: null, watch: null, timers: [] };
    const c = cur;
    // 先打开（或换到）这张图的大预览框，分割框骑在它上面
    let box = null;
    try { box = host.attachBox ? host.attachBox(task, taskEl, idx) : null; } catch (_) { box = null; }
    if (box) {
      c.box = box;
      box.classList.add('v7seg-under');
      c.watch = new MutationObserver(() => {
        if (cur !== c) return;
        if (!box.classList.contains('show')) { close(); return; }      // 大预览框按它的规矩收了 ⇒ 分割框一起收
        place(el, taskEl);
        // 鼠标划到别的缩略图：框换了张 ⇒ 分割也换到那一张
        const s = host.boxShot ? host.boxShot(task) : -1;
        if (s >= 0 && s !== c.idx && doneShots(task).some(x => x.i === s) && !c.returning) { remember(); loadShot(s); }
      });
      c.watch.observe(box, { attributes: true, attributeFilter: ['class', 'style'] });
      const img = box.querySelector('.tween-box-img');
      if (img) c.watch.observe(img, { attributes: true, attributeFilter: ['src'] });
      // 滑入动画那 0.34 秒框还在挪：多量几次
      for (const ms of [60, 200, 400]) c.timers.push(setTimeout(() => { if (cur === c) place(el, taskEl); }, ms));
    } else {
      el.setAttribute('data-ui-overlay', '');   // 没有预览框模块（不该发生）：退回老做法，整窗口工作面
    }
    place(el, taskEl);
    bind(el);
    // 滚轮在分割框里不许冒泡去切卡；按住滑块拖的时候鼠标可能划出链外 —— 一直取消「160ms 后收框」
    el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    let hold = 0;
    el.addEventListener('pointerdown', () => { clearInterval(hold); hold = setInterval(() => { if (cur !== c) { clearInterval(hold); return; } if (host.keepBox) host.keepBox(); }, 50); c.timers.push(hold); });
    const up = () => { clearInterval(hold); };
    doc.addEventListener('pointerup', up, true);
    c.onKey = e => { if (e.key === 'Escape' && cur === c) { e.stopPropagation(); close(); } };
    doc.addEventListener('keydown', c.onKey, true);
    c.offUp = () => doc.removeEventListener('pointerup', up, true);
    loadShot(idx);
    setTimeout(() => { const r = el.querySelector('[data-seg="sens"]'); if (r && cur && cur.el === el) r.focus({ preventScroll: true }); }, 0);
    return true;
  }
  function close() {
    if (!cur) return;
    const c = cur;
    cur = null;
    try { if (c.worker) c.worker.stop(); } catch (_) {}
    try { if (c.watch) c.watch.disconnect(); } catch (_) {}
    (c.timers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
    if (c.onKey) doc.removeEventListener('keydown', c.onKey, true);
    if (c.offUp) c.offUp();
    doc.querySelectorAll('.tween-box.v7seg-under').forEach(b => b.classList.remove('v7seg-under'));
    c.el.remove();
  }

  root.V7SegmentPanel = { setHost, eligible, open, close, isOpen: () => !!cur, _doneShots: doneShots };
})(typeof window !== 'undefined' ? window : globalThis);
