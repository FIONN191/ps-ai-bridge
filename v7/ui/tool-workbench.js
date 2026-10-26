/* ═══════════════════════════════════════════════════════════════
   工具工作面 · 原地展开（2026-09-28 实装）

   用户定案：点「工具与功能」里的某一项 → 不在弹窗里用，
   而是【原地展开】成一块横条，横向占满一级卡+二级卡+三级卡的总宽。

   几何（anchor 坐标系）：
     主卡 left=0 宽 300 · 二级 left=340 宽 200 · 三级 left=580 宽 300
     → 横跨三段 = left 0, width 880；卡片高 400
     正好是用户要的 880×400。

   复用现成机制：
     · .detail-card.workspace-host + --workspace-* 四个变量（ui.html 的现成撑开）
     · V7Workspaces 的工作面壳（顶栏/返回/Esc 关闭都是它给的）
   本模块只负责：算几何、画 12 个面板、把控件接到预设上。

   ⚠ 全部包在 IIFE 里，只导出 root.V7ToolWorkbench，不污染全局
     （2026-09-28 栽过：全局 `const top` 撞 window.top，整个脚本静默不执行）。
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc || root.V7ToolWorkbench) return;

  let host = {};                 // { open(key, preset), close() } —— 由 ui.html 注入
  let active = null;             // { key, presetId, vals, save }

  /* ─── 预设参数读写 ─────────────────────────────────────────────
     vals 是这条预设的 content(JSON)。改一个字段就整条存回去。
     ⚠ 跟 fillToolDetail 同一条规矩：save 前【现查一遍库】再合并，
       拿着打开那一刻的旧对象去存会覆盖掉期间别处的改动。 */
  function currentVals() {
    return active ? active.vals : {};
  }
  function patch(key, value) {
    if (!active) return;
    active.vals[key] = value;
    active.save();
  }

  /* ─── 通用控件绑定 ─────────────────────────────────────────────
     约定：控件带 data-twp="参数名"。
     range  → 拖滑块写值（并更新旁边的数值）
     check  → .v7tw-sw 开关
     chip   → .v7tw-chip 一组单选（data-twpg="组名"）
     其它   → input/select/textarea 直接写值 */
  function bindControls(scopeEl) {
    const vals = currentVals();

    // 滑块 / 输入框 / 下拉
    scopeEl.querySelectorAll('[data-twp]').forEach(el => {
      const key = el.dataset.twp;
      const isRange = el.type === 'range';
      const isCheck = el.classList.contains('v7tw-sw');
      if (isCheck) {
        el.classList.toggle('on', !!vals[key]);
        el.setAttribute('role', 'switch');
        el.setAttribute('aria-checked', String(!!vals[key]));
        el.addEventListener('click', () => {
          const next = !el.classList.contains('on');
          el.classList.toggle('on', next);
          el.setAttribute('aria-checked', String(next));
          patch(key, next ? 1 : 0);
        });
        return;
      }
      // 初值
      if (vals[key] !== undefined && vals[key] !== null) el.value = vals[key];
      const out = el.parentElement && el.parentElement.querySelector('[data-twpval="' + key + '"]');
      const show = () => { if (out) out.textContent = el.value; };
      show();
      el.addEventListener('input', () => { show(); patch(key, isRange ? Number(el.value) : el.value); });
      if (el.tagName === 'SELECT') el.addEventListener('change', () => patch(key, el.value));
    });

    // 芯片单选组
    const groups = new Map();
    scopeEl.querySelectorAll('[data-twpg]').forEach(chip => {
      const g = chip.dataset.twpg;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(chip);
    });
    groups.forEach((chips, g) => {
      const cur = vals[g];
      chips.forEach(chip => {
        const on = String(chip.dataset.twpv) === String(cur);
        chip.classList.toggle('on', on);
        chip.setAttribute('aria-pressed', String(on));
        chip.addEventListener('click', () => {
          chips.forEach(c => { c.classList.remove('on'); c.setAttribute('aria-pressed', 'false'); });
          chip.classList.add('on');
          chip.setAttribute('aria-pressed', 'true');
          patch(g, chip.dataset.twpv);
        });
      });
    });
  }

  /* ─── 小工具 ────────────────────────────────────────────────── */
  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sect = (t, mt) => `<p class="v7tw-sect${mt ? ' mt' : ''}">${esc(t)}</p>`;
  const fRow = (label, inner) =>
    `<div class="v7tw-f"><label>${esc(label)}</label>${inner}</div>`;
  const fWide = (label, inner) =>
    `<div class="v7tw-f wide"><label>${esc(label)}</label>${inner}</div>`;
  const slider = (label, key, min, max, step) =>
    `<div class="v7tw-slider"><label>${esc(label)}</label>` +
    `<input type="range" data-twp="${esc(key)}" min="${min}" max="${max}" step="${step || 1}">` +
    `<span class="v7tw-val" data-twpval="${esc(key)}"></span></div>`;
  const toggle = (label, key) =>
    `<div class="v7tw-tog"><span>${esc(label)}</span>` +
    `<div class="v7tw-sw" data-twp="${esc(key)}"></div></div>`;
  const select = (label, key, opts) =>
    fRow(label, `<select data-twp="${esc(key)}">` +
      opts.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('') + `</select>`);
  const number = (label, key) => fRow(label, `<input type="number" data-twp="${esc(key)}">`);
  const text = (label, key, ro) =>
    fRow(label, `<input type="text" data-twp="${esc(key)}"${ro ? ' readonly' : ''}>`);
  const textarea = (label, key, rows) =>
    fWide(label, `<textarea data-twp="${esc(key)}" rows="${rows || 3}"></textarea>`);
  const chips = (key, list) =>
    `<div class="v7tw-chips">` + list.map(([v, t]) =>
      `<button type="button" class="v7tw-chip" data-twpg="${esc(key)}" data-twpv="${esc(v)}">${esc(t)}</button>`
    ).join('') + `</div>`;
  const btn = (label, attrs, cls) =>
    `<button type="button" class="v7tw-btn${cls ? ' ' + cls : ''}" ${attrs || ''}>${esc(label)}</button>`;

  /* ─── 颜色工具两块大卡共用（2026-09-29）────────────────────────
     双区颜色匹配 / AI 调色都挂在 V7ColorTools 的无窗口会话上（attach）：
     按钮、下拉、开关、文本框直接改会话；缩略图 / 结果 / 状态靠订阅实时刷新。
     错误由模块统一 ERR.report 并写进状态行，这里只接住 Promise，不重复报。 */
  const COLOR_RESULT_BLOCK =
    `<p class="v7tw-sect mt">结果</p>` +
    `<div class="v7tw-box v7tw-colorthumb" data-twcolorthumb="1"><span data-twslotinfo>还没有结果</span></div>` +
    `<div class="v7tw-btnrow"><button type="button" class="v7tw-btn wide" data-twtransfer="1" disabled>传回到 PS</button>` +
    `<button type="button" class="v7tw-btn danger" data-twstop="1" hidden>停止</button></div>`;
  const RUN_STATUS = { running: '处理中…', ready: '已完成', failed: '未完成', cancelled: '已停止' };
  function mountColorPanel(el, mode) {
    const M = root.V7ColorTools;
    const msg = el.querySelector('[data-twcolormsg]');
    const say = text => { if (msg && text) msg.textContent = text; };
    if (!M || typeof M.attach !== 'function') { say('调色模块没有加载，请重新打开软件。'); return undefined; }
    let api = null, alive = true, off = null, last = null, promptTimer = null;
    const urls = new Map();                      // asset id → 缩略图 object URL
    const setThumb = (box, id, caption) => {
      if (!box) return;
      const info = box.querySelector('[data-twslotinfo]');
      if (info && info.dataset.empty === undefined) info.dataset.empty = info.textContent;
      let img = box.querySelector('img.v7tw-thumb');
      if (!id) {
        if (img) img.remove();
        if (info) { info.textContent = info.dataset.empty || ''; info.classList.remove('v7tw-cap'); }
        return;
      }
      if (info) { info.textContent = caption || ''; info.classList.add('v7tw-cap'); }
      if (!img) { img = document.createElement('img'); img.className = 'v7tw-thumb'; img.alt = ''; box.appendChild(img); }
      if (img.dataset.assetId === id) return;
      img.dataset.assetId = id;
      if (urls.has(id)) { img.src = urls.get(id); return; }
      Promise.resolve(api && api.thumb(id)).then(blob => {
        if (!alive || !blob) return;
        const url = URL.createObjectURL(blob); urls.set(id, url);
        if (img.dataset.assetId === id) img.src = url;
      }).catch(() => {});
    };
    const paint = snap => {
      if (!alive || !el.isConnected) return;
      last = snap;
      const busy = !!snap.busy;
      for (const key of ['a', 'b']) {
        const v = snap[key];
        setThumb(el.querySelector('[data-twslot="' + key + '"]'), v && v.id, v ? (v.docName ? v.docName + ' · ' : '') + v.width + ' × ' + v.height : '');
      }
      el.querySelectorAll('[data-twcolor]').forEach(c => {
        const f = c.dataset.twcolor;
        if (c.classList.contains('v7tw-sw')) { c.classList.toggle('on', !!snap[f]); c.setAttribute('role', 'switch'); c.setAttribute('aria-checked', String(!!snap[f])); return; }
        c.disabled = busy;
        if (document.activeElement === c) return;        // 用户正在输入的别覆盖
        if (f === 'amount') c.value = String(Math.round((snap.amount == null ? 1 : snap.amount) * 100));
        else if (snap[f] != null) c.value = snap[f];
      });
      const amount = el.querySelector('[data-twcolorval="amount"]');
      if (amount) amount.textContent = Math.round((snap.amount == null ? 1 : snap.amount) * 100) + '%';
      const run = snap.runs.filter(r => r.mode === mode).pop();
      const out = run && run.outputs[0];
      setThumb(el.querySelector('[data-twcolorthumb]'), out && out.id, run ? (RUN_STATUS[run.status] || run.status) + (run.error ? '：' + run.error : '') : '');
      if (run && !out) { const info = el.querySelector('[data-twcolorthumb] [data-twslotinfo]'); if (info) info.textContent = (RUN_STATUS[run.status] || run.status) + (run.error ? '：' + run.error : ''); }
      const transfer = el.querySelector('[data-twtransfer]');
      if (transfer) {
        transfer.disabled = busy || !out || out.complete || out.uncertain;
        transfer.textContent = out && out.complete ? '已传回到 PS' : out && out.uncertain ? '传回待核对（先看图层面板）' : '传回到 PS';
      }
      const stop = el.querySelector('[data-twstop]');
      if (stop) stop.hidden = !busy;
      el.querySelectorAll('[data-twcap],[data-twclr]').forEach(b => { b.disabled = busy; });
      const runBtn = el.querySelector('[data-twrun]');
      if (runBtn) runBtn.disabled = busy;
      if (snap.status) say(snap.status);
    };
    el.addEventListener('click', ev => {
      const t = ev.target.closest && ev.target.closest('[data-twcap],[data-twclr],[data-twtransfer],[data-twstop],.v7tw-sw[data-twcolor]');
      if (!t || !api || t.disabled) return;
      ev.stopPropagation();
      if (t.dataset.twcap) { api.capture(t.dataset.twcap).catch(() => {}); return; }
      if (t.dataset.twclr) { api.clear(t.dataset.twclr).catch(() => {}); return; }
      if (t.dataset.twstop) { Promise.resolve(api.stop()).catch(() => {}); return; }
      if (t.dataset.twtransfer) {
        const run = last && last.runs.filter(r => r.mode === mode).pop();
        if (run) api.transfer(run.id, 0).catch(() => {});
        return;
      }
      if (last && last.busy) return;
      api.set(t.dataset.twcolor, !t.classList.contains('on')).catch(() => {});
    });
    el.addEventListener('change', ev => {
      const c = ev.target;
      if (!api || !c.dataset || !c.dataset.twcolor) return;
      if (c.tagName === 'SELECT') api.set(c.dataset.twcolor, c.value).catch(() => {});
      else if (c.dataset.twcolor === 'amount') api.set('amount', Number(c.value) / 100).catch(() => {});
    });
    el.addEventListener('input', ev => {
      const c = ev.target;
      if (!c.dataset || !c.dataset.twcolor) return;
      if (c.dataset.twcolor === 'amount') { const v = el.querySelector('[data-twcolorval="amount"]'); if (v) v.textContent = c.value + '%'; }
      if (c.dataset.twcolor === 'prompt') { clearTimeout(promptTimer); promptTimer = setTimeout(() => { promptTimer = null; if (api) api.set('prompt', c.value).catch(() => {}); }, 400); }
    });
    const flushPrompt = () => {
      const t = el.querySelector('textarea[data-twcolor="prompt"]');
      if (!t || !api || promptTimer === null) return Promise.resolve();
      clearTimeout(promptTimer); promptTimer = null;
      return api.set('prompt', t.value);
    };
    el._twRun = async () => {
      if (!api) { root.ERR && root.ERR.report('TOOL_OPEN_FAILED', { message: '调色会话还没准备好，稍等一下再点' }); return; }
      if (last && last.busy) return;
      try {
        // AI 调色：目标 = 点开始这一刻 PS 里的选区（没选区就整张画布，模块在 grade 模式下允许整张）
        if (mode === 'grade') { await flushPrompt(); await api.capture('b'); }
        await api.run();
      } catch (_) { /* 模块已 ERR.report 并写进状态行 */ }
    };
    Promise.resolve().then(() => M.attach(mode)).then(a => {
      if (!alive) { a.detach(); return; }
      api = a; off = api.subscribe(paint);
    }).catch(e => {
      say('调色会话打不开：' + (e && e.message || e));
      root.ERR && root.ERR.report('COLOR_TOOL_FAILED', { message: String(e && e.message || e) });
    });
    return () => {
      alive = false;
      const pending = flushPrompt().catch(() => {});
      if (off) off();
      Promise.resolve(pending).then(() => { if (api) api.detach(); });
      urls.forEach(u => URL.revokeObjectURL(u)); urls.clear();
    };
  }

  /* ─── DLSS 大卡（2026-09-29）：挂在 V7DLSS.attach() 上 ─────────── */
  const dlssSlider = (label, key, max) =>
    `<div class="v7tw-slider"><label>${esc(label)}</label>` +
    `<input type="range" min="0" max="${max}" step="0.01" data-twdlssp="${esc(key)}">` +
    `<span class="v7tw-val" data-twdlssval="${esc(key)}"></span></div>`;
  function mountDlssPanel(el) {
    const D = root.V7DLSS;
    const msg = el.querySelector('[data-twdlssmsg]');
    const tag = el.querySelector('.v7tw-top .v7tw-tag');
    if (!D || typeof D.attach !== 'function') { if (msg) msg.textContent = 'DLSS 模块没有加载，请重新打开软件。'; return undefined; }
    const api = D.attach();
    let alive = true, url = '', shown = null;
    const paint = s => {
      if (!alive || !el.isConnected) return;
      if (tag) { tag.textContent = s.signedIn ? '● 已连接 · 控制服务' : '● 未连接 · 请先登录'; tag.className = 'v7tw-tag ' + (s.signedIn ? 'ok' : 'err'); }
      const box = el.querySelector('[data-twdlssprev]');
      const info = box && box.querySelector('[data-twslotinfo]');
      if (info && info.dataset.empty === undefined) info.dataset.empty = info.textContent;
      let img = box && box.querySelector('img.v7tw-thumb');
      if (s.preview && s.preview.blob !== shown) {
        shown = s.preview.blob;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(s.preview.blob);
        if (!img) { img = document.createElement('img'); img.className = 'v7tw-thumb'; img.alt = ''; box.appendChild(img); }
        img.src = url;
      } else if (!s.preview && img) { img.remove(); shown = null; }
      if (info) {
        info.textContent = s.preview ? s.preview.label : info.dataset.empty;
        info.classList.toggle('v7tw-cap', !!s.preview);
      }
      const bar = el.querySelector('[data-twdlssbar]');
      if (bar) bar.style.width = Math.max(0, Math.min(100, Number(s.progress) || 0)) + '%';
      el.querySelectorAll('[data-twdlssp]').forEach(c => {
        const k = c.dataset.twdlssp;
        c.disabled = !!s.paramsLocked;
        if (document.activeElement !== c) c.value = String(s.parameters[k]);
        const v = el.querySelector('[data-twdlssval="' + k + '"]');
        if (v) v.textContent = Number(s.parameters[k]).toFixed(2);
      });
      const auto = el.querySelector('[data-twdlssauto]');
      if (auto) { auto.classList.toggle('on', !!s.autoReturn); auto.setAttribute('role', 'switch'); auto.setAttribute('aria-checked', String(!!s.autoReturn)); }
      const enable = (name, on) => { const b = el.querySelector('[data-twdlss="' + name + '"]'); if (b) b.disabled = !on; };
      enable('resume', s.canResume); enable('cancel', s.canCancel); enable('transfer', s.canTransfer);
      const transfer = el.querySelector('[data-twdlss="transfer"]');
      if (transfer) transfer.textContent = s.placed ? '已传回到 PS' : '传回到 PS';
      const runBtn = el.querySelector('[data-twrun]');
      if (runBtn) runBtn.disabled = !!s.busy || !s.canCapture;
      if (msg && s.status) msg.textContent = s.status;
    };
    el.addEventListener('input', ev => {
      const c = ev.target;
      if (!c.dataset || !c.dataset.twdlssp || c.tagName === 'SELECT') return;
      api.setParam(c.dataset.twdlssp, c.value);
      const v = el.querySelector('[data-twdlssval="' + c.dataset.twdlssp + '"]');
      if (v) v.textContent = Number(c.value).toFixed(2);
    });
    el.addEventListener('change', ev => { const c = ev.target; if (c.tagName === 'SELECT' && c.dataset && c.dataset.twdlssp) api.setParam(c.dataset.twdlssp, c.value); });
    el.addEventListener('click', ev => {
      const t = ev.target.closest && ev.target.closest('[data-twdlss],[data-twdlssauto]');
      if (!t || t.disabled) return;
      ev.stopPropagation();
      if (t.dataset.twdlssauto) { api.setAutoReturn(!t.classList.contains('on')); return; }
      const action = t.dataset.twdlss;
      if (action === 'resume') api.resume();
      else if (action === 'cancel') api.cancel();
      else if (action === 'transfer') api.transfer();
    });
    // 主按钮：抓整张画布 → 开始（中途断掉的任务要先「恢复传输」或「取消任务」，免得重复扣费）
    el._twRun = async () => {
      const s = api.snapshot();
      if (s.busy) return;
      if (s.canResume) { if (msg) msg.textContent = '上一次增强还没结束：点「恢复传输」继续，或点「取消任务」后再开始。'; return; }
      await api.capture();
      if (alive && api.snapshot().canRun) await api.start();
    };
    const off = api.subscribe(paint);
    return () => { alive = false; off(); if (url) URL.revokeObjectURL(url); };
  }

  /* ─── 照片批处理大卡（2026-09-29）：挂在 V7BatchQueue.attach() 上 ─── */
  function mountBatchPanel(el) {
    const Q = root.V7BatchQueue;
    const msg = el.querySelector('[data-twbatchmsg]');
    if (!Q || typeof Q.attach !== 'function') { if (msg) msg.textContent = '批处理模块没有加载，请重新打开软件。'; return undefined; }
    const list = el.querySelector('[data-twqueue]');
    let api = null, off = null, alive = true, presetKey = '';
    const urls = new Map();
    const loadThumb = img => {
      const id = img.dataset.twthumb;
      if (urls.has(id)) { img.src = urls.get(id); return; }
      Promise.resolve(api && api.thumb(id)).then(blob => {
        if (!alive || !blob) return;
        const url = URL.createObjectURL(blob); urls.set(id, url);
        if (img.isConnected && img.dataset.twthumb === id) img.src = url;
      }).catch(() => {});
    };
    const RETRY = new Set(['failed', 'interrupted', 'cancelled']);
    const paint = s => {
      if (!alive || !el.isConnected) return;
      const locked = !!(s.busy || s.running);
      const sel = el.querySelector('[data-twbatchpreset]');
      const key = s.presets.map(p => p.id + ':' + p.title).join('|');
      if (sel && key !== presetKey && document.activeElement !== sel) {
        presetKey = key;
        const cur = sel.value;
        sel.innerHTML = '<option value="">当前主界面配置</option>' + s.presets.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
        sel.value = s.presets.some(p => p.id === cur) ? cur : '';
      }
      if (list) {
        const top = list.scrollTop;
        list.innerHTML = s.items.length ? s.items.map((it, i) =>
          `<div class="v7tw-row" data-twbatchid="${esc(it.id)}" title="${esc(it.error || it.label)}">
            <span class="v7tw-idx">${i + 1}</span>
            <div class="v7tw-th">${it.thumb ? `<img alt="" data-twthumb="${esc(it.thumb)}">` : ''}</div>
            <span class="v7tw-txt">${esc(it.docName)}${it.size ? ' · ' + esc(it.size) : ''} · ${esc(it.presetTitle)} · <b>${esc(it.label)}</b>${it.error ? ' · ' + esc(it.error) : ''}</span>
            <button type="button" class="v7tw-mini" data-twbatchact="up" title="上移"${locked || i === 0 ? ' disabled' : ''}>▲</button>
            <button type="button" class="v7tw-mini" data-twbatchact="down" title="下移"${locked || i === s.items.length - 1 ? ' disabled' : ''}>▼</button>
            ${RETRY.has(it.status) ? `<button type="button" class="v7tw-mini" data-twbatchact="retry"${locked ? ' disabled' : ''}>重新排队</button>` : ''}
            <button type="button" class="v7tw-del" data-twbatchact="remove" title="删除这一项" aria-label="删除这一项"${locked || it.status === 'running' ? ' disabled' : ''}>×</button>
          </div>`).join('')
          : '<div class="v7tw-hint">队列是空的。在 PS 里框选后点右边「加入当前选区」。</div>';
        list.scrollTop = top;
        list.querySelectorAll('img[data-twthumb]').forEach(loadThumb);
      }
      const count = el.querySelector('[data-twbatchcount]');
      if (count) count.value = s.count + ' 项 · ' + s.queued + ' 项待运行';
      el.querySelectorAll('[data-twbatch]').forEach(b => { if (b.dataset.twbatch !== 'stop') b.disabled = locked; });
      const stop = el.querySelector('[data-twbatch="stop"]');
      if (stop) stop.hidden = !s.running;
      const runBtn = el.querySelector('[data-twrun]');
      if (runBtn) runBtn.disabled = locked || !s.queued;
      if (msg && s.status) msg.textContent = s.status;
    };
    el.addEventListener('click', ev => {
      const t = ev.target.closest && ev.target.closest('[data-twbatch],[data-twbatchact]');
      if (!t || t.disabled || !api) return;
      ev.stopPropagation();
      const swallow = p => { Promise.resolve(p).catch(() => {}); };
      if (t.dataset.twbatch === 'enqueue') return swallow(api.enqueue(el.querySelector('[data-twbatchpreset]')?.value || ''));
      if (t.dataset.twbatch === 'dedupe') return swallow(api.dedupe());
      if (t.dataset.twbatch === 'clear') return swallow(api.clear());
      if (t.dataset.twbatch === 'stop') return swallow(api.stop());
      const row = t.closest('[data-twbatchid]'), id = row && row.dataset.twbatchid;
      if (!id) return;
      const act = t.dataset.twbatchact;
      if (act === 'up') swallow(api.move(id, -1));
      else if (act === 'down') swallow(api.move(id, 1));
      else if (act === 'retry') swallow(api.retry(id));
      else if (act === 'remove') swallow(api.remove(id));
    });
    el._twRun = async () => { if (!api) return; try { await api.run(); } catch (_) { /* 模块已 ERR.report 并写进状态 */ } };
    Promise.resolve().then(() => Q.attach()).then(a => {
      if (!alive) return;
      api = a; off = api.subscribe(paint);
    }).catch(e => {
      if (msg) msg.textContent = '批处理队列打不开：' + (e && e.message || e);
      root.ERR && root.ERR.report('BATCH_QUEUE_FAILED', { message: String(e && e.message || e) });
    });
    return () => { alive = false; if (off) off(); urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };
  }

  /* ─── 分块增强 / 多区拼接 两块大卡共用（2026-09-29）：挂在 V7RegionWorkbench.attach(mode) 上 ─── */
  // ⚠⚠⚠ 2026-10-07 用户："检查我们所有的 UI 元素，看看哪些东西应该关联到主题色，但是没关联。"
  //   体检结果：这两张表原来是【写死的常量】（待处理蓝/进行中橙/完成绿/失败红），
  //   而且是在【模块加载时】算一次的 ⇒ 用户后来换主题色，它永远不可能跟着变。
  //   ⇒ 改成【每次取用时现读代币】。颜色语义保持不变（状态还是那四种颜色），
  //     但色值改由代币决定：待处理 = 主题色、进行中/部分 = 警告、完成 = 成功、失败/中断 = 错误。
  //   ⚠ 别改回写死的常量表 —— "加载时算一次"就等于把主题钉死在那一次的值上。
  //   ⚠ --accent-hsl 是【三分量】("211 100% 68%")，直接塞进 hsl() 就是它的用法。
  const cssVar = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  };
  const accentHsl = () => cssVar('--accent-hsl', '211 100% 68%');
  const REG_COLOR = () => ({
    pending: `hsl(${accentHsl()} / .10)`,
    running: `hsl(${cssVar('--sem-warn', '32 100% 75%')} / .20)`,
    done: `hsl(${cssVar('--sem-ok', '142 69% 58%')} / .16)`,
    failed: `hsl(${cssVar('--sem-err', '0 84% 65%')} / .18)`,
    partial: `hsl(${cssVar('--sem-warn', '32 100% 75%')} / .16)`,
    interrupted: `hsl(${cssVar('--sem-err', '0 84% 65%')} / .12)`,
  });
  const REG_STROKE = () => ({
    pending: `hsl(${accentHsl()} / .75)`,
    running: `hsl(${cssVar('--sem-warn', '32 100% 75%')})`,
    done: `hsl(${cssVar('--sem-ok', '142 69% 58%')} / .8)`,
    failed: `hsl(${cssVar('--sem-err', '0 84% 65%')} / .85)`,
    partial: `hsl(${cssVar('--sem-warn', '32 100% 75%')} / .8)`,
    interrupted: `hsl(${cssVar('--sem-err', '0 84% 65%')} / .6)`,
  });
  const regNumber = (label, key, min, max) =>
    `<div class="v7tw-f"><label>${esc(label)}</label><input type="number" data-twregnum="${esc(key)}" min="${min}" max="${max}"></div>`;
  function mountRegionPanel(el, mode) {
    const R = root.V7RegionWorkbench;
    const canvas = el.querySelector('[data-twregcanvas]');
    const label = el.querySelector('[data-twreglabel]');
    const msg = el.querySelector('[data-twregmsg]');
    const stateEl = el.querySelector('[data-twregstate]');
    const listBox = el.querySelector('[data-twreglist]');
    const presetSel = el.querySelector('[data-twregpreset]');
    const promptEl = el.querySelector('[data-twregfield="prompt"]');
    if (!R || typeof R.attach !== 'function') { if (msg) msg.textContent = '区域工具没有加载，请重新打开软件。'; return undefined; }
    let api = null, off = null, alive = true, rev = 0, presetKey = '', lastSnap = null;
    const urls = new Map();
    const thumbUrl = (id, fn) => {
      if (!id) return null;
      if (urls.has(id)) { fn(urls.get(id)); return null; }
      const my = rev;
      return Promise.resolve(api.thumb(id)).then(url => { if (!alive || my !== rev || !url) return; urls.set(id, url); fn(url); }).catch(() => {});
    };
    const cfg = () => ({
      presetId: presetSel ? presetSel.value : '',
      prompt: promptEl ? promptEl.value : '',
      batch: Number(el.querySelector('[data-twregnum="batch"]')?.value) || 1,
      options: {
        tileSize: Number(el.querySelector('[data-twregnum="tileSize"]')?.value) || 2048,
        overlap: Number(el.querySelector('[data-twregnum="overlap"]')?.value) || 256,
        maxEdge: 2048, inset: Number(el.querySelector('[data-twregnum="inset"]')?.value) || 0, blur: Number(el.querySelector('[data-twregnum="blur"]')?.value) || 80
      }
    });
    const draw = s => {
      if (!canvas) return;
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const box = canvas.parentElement.getBoundingClientRect();
      const w = Math.max(80, box.width), h = Math.max(80, box.height - 22);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = '100%'; canvas.style.height = 'calc(100% - 22px)';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!s.regions.length) return;
      let minX = Infinity, minY = Infinity, spanX = 0, spanY = 0;
      if (mode === 'stitch') {
        if (!s.layout) return;
        spanX = s.layout.width; spanY = s.layout.height;
      } else {
        for (const r of s.regions) { minX = Math.min(minX, r.selection.left); minY = Math.min(minY, r.selection.top); spanX = Math.max(spanX, r.selection.right); spanY = Math.max(spanY, r.selection.bottom); }
        spanX -= minX; spanY -= minY;
      }
      const pad = 10, k = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
      const ox = (w - spanX * k) / 2, oy = (h - spanY * k) / 2;
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
      // ⚠ 主题色/语义色【每画一次读一遍】，但只读一次、不在循环里读
      //   （getComputedStyle 会触发布局计算，放循环里会卡）。
      const 色 = REG_COLOR(), 描边色 = REG_STROKE();
      s.regions.forEach((r, i) => {
        const rect = mode === 'stitch'
          ? (s.layout.items.find(item => item.regionId === r.id) || { x: 0, y: 0, width: 0, height: 0 })
          : { x: r.selection.left - minX, y: r.selection.top - minY, width: r.selection.width, height: r.selection.height };
        const x = ox + rect.x * k, y = oy + rect.y * k, rw = Math.max(1, rect.width * k), rh = Math.max(1, rect.height * k);
        ctx.fillStyle = 色[r.status] || 'rgba(255,255,255,.05)';
        ctx.fillRect(x, y, rw, rh);
        const paintFrame = url => {
          if (url && alive && rev === my) { const img = new Image(); img.onload = () => { ctx.drawImage(img, x, y, rw, rh); ctx.strokeStyle = 描边色[r.status] || '#888'; ctx.lineWidth = 1.2; ctx.strokeRect(x + .5, y + .5, Math.max(0, rw - 1), Math.max(0, rh - 1)); }; img.src = url; }
          else { ctx.strokeStyle = 描边色[r.status] || '#888'; ctx.lineWidth = 1.2; ctx.strokeRect(x + .5, y + .5, Math.max(0, rw - 1), Math.max(0, rh - 1)); }
        };
        const my = rev;
        paintFrame(null);
        if (rw > 6 && rh > 6 && r.inputAssetId) { const pending = thumbUrl(r.inputAssetId, paintFrame); void pending; }
        if (rw > 16 && rh > 12) { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillText(String(i + 1), x + 3, y + 3); }
      });
    };
    const paint = s => {
      if (!alive || !el.isConnected) return;
      rev++;
      lastSnap = s;
      const locked = !!s.busy;
      if (label) label.textContent = s.regions.length ? s.regions.length + ' 个区域' + (s.layout ? ' · 拼图 ' + s.layout.width + ' × ' + s.layout.height : '') : '还没有分块';
      if (stateEl) stateEl.value = [s.status, s.regions.length + ' 块', s.done + ' 已完成', s.pending ? s.pending + ' 组待处理' : '', s.failed ? s.failed + ' 组可重试' : ''].filter(Boolean).join(' · ');
      if (presetSel) {
        const key = s.presets.map(p => p.id + ':' + p.title).join('|');
        if (key !== presetKey && document.activeElement !== presetSel) {
          presetKey = key;
          const cur = presetSel.value || s.presetId || '';
          presetSel.innerHTML = '<option value="">选择预设</option>' + s.presets.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
          presetSel.value = s.presets.some(p => p.id === cur) ? cur : '';
        }
        presetSel.disabled = locked || (s.regions.length > 0 && s.regions.some(r => r.outputs.length));
      }
      if (promptEl && document.activeElement !== promptEl && s.prompt && !promptEl.value) promptEl.value = s.prompt;
      if (promptEl) promptEl.disabled = locked || s.regions.some(r => r.outputs.length);
      el.querySelectorAll('[data-twregnum]').forEach(c => {
        const opts = s.options || {};
        c.disabled = locked || (s.regions.length > 0 && s.regions.some(r => r.outputs.length));
        if (c.dataset.twregnum === 'batch') { if (document.activeElement !== c) c.value = String(opts.batch ?? 1); }
        else if (opts[c.dataset.twregnum] != null && document.activeElement !== c) c.value = String(opts[c.dataset.twregnum]);
      });
      el.querySelectorAll('[data-twreg]').forEach(b => {
        const a = b.dataset.twreg;
        b.disabled = locked && a !== 'stop';
        if (a === 'transfer') b.disabled = locked || !s.returnable;
        if (a === 'retry') b.disabled = locked || !s.failed;
        if (a === 'relayout') b.disabled = locked || !s.regions.length || s.regions.some(r => r.outputs.length);
        if (a === 'stop') b.hidden = !s.busy;
      });
      if (listBox) {
        listBox.innerHTML = s.regions.length ? s.regions.map((r, i) =>
          `<div class="v7tw-row" data-twregid="${esc(r.id)}">
            <span class="v7tw-idx">${i + 1}</span>
            <div class="v7tw-th">${r.inputAssetId ? `<img alt="" data-twregthumb="${esc(r.inputAssetId)}">` : ''}</div>
            <span class="v7tw-txt"><b>${esc(r.label || '区域 ' + (i + 1))}</b> · ${esc(r.selection.width)} × ${esc(r.selection.height)} · <b>${esc(r.statusLabel)}</b>${r.error ? ' · ' + esc(r.error) : ''}</span>
            <button type="button" class="v7tw-mini" data-twregact="up" title="上移"${locked || i === 0 ? ' disabled' : ''}>▲</button>
            <button type="button" class="v7tw-mini" data-twregact="down" title="下移"${locked || i === s.regions.length - 1 ? ' disabled' : ''}>▼</button>
            <button type="button" class="v7tw-del" data-twregact="remove" title="移除" aria-label="移除"${locked ? ' disabled' : ''}>×</button>
          </div>`).join('') : (root.V7Format ? root.V7Format.emptyHtml({ title: '还没有区域', hint: '在 PS 里框选一块，点下面「+ 从当前选区添加」；加几个就按顺序竖直排开，生成后各回各位', action: { label: '从当前选区添加', attrs: 'data-twreg="add"' } }) : '<div class="v7tw-hint">还没有区域。在 PS 里框选一块，点下面「+ 从当前选区添加」。</div>');
        listBox.querySelectorAll('img[data-twregthumb]').forEach(img => { const my = rev; thumbUrl(img.dataset.twregthumb, url => { if (my === rev && img.isConnected) img.src = url; }); });
      }
      const runBtn = el.querySelector('[data-twrun]');
      if (runBtn) runBtn.disabled = locked || (mode === 'tiles' ? !s.regions.length : !s.regions.length);
      if (msg && s.status) msg.textContent = s.status;
      draw(s);
    };
    let promptTimer = null;
    el.addEventListener('click', ev => {
      const t = ev.target.closest && ev.target.closest('[data-twreg],[data-twregact]');
      if (!t || t.disabled || !api) return;
      ev.stopPropagation();
      const swallow = p => { Promise.resolve(p).catch(() => {}); };
      if (t.dataset.twreg === 'plan') return swallow(api.plan(cfg()));
      if (t.dataset.twreg === 'add') return swallow(api.addRegion(cfg()));
      if (t.dataset.twreg === 'relayout') return swallow(api.relayout());
      if (t.dataset.twreg === 'transfer') return swallow(api.transfer());
      if (t.dataset.twreg === 'retry') return swallow(api.retry());
      if (t.dataset.twreg === 'stop') return swallow(api.stop());
      if (t.dataset.twreg === 'reset') { api.reset(); return; }
      const row = t.closest('[data-twregid]'), id = row && row.dataset.twregid;
      if (!id) return;
      const act = t.dataset.twregact;
      if (act === 'up') swallow(api.moveRegion(id, -1));
      else if (act === 'down') swallow(api.moveRegion(id, 1));
      else if (act === 'remove') swallow(api.removeRegion(id));
    });
    el.addEventListener('change', ev => {
      const c = ev.target;
      if (c === presetSel && api && lastSnap) {
        const p = lastSnap.presets.find(x => x.id === presetSel.value);
        if (promptEl && p && !promptEl.value) promptEl.value = p.content || '';
        swallowSet({ presetId: presetSel.value });
      }
      if (c.dataset && c.dataset.twregnum && api) swallowSet({ batch: Number(el.querySelector('[data-twregnum="batch"]')?.value) || 1 });
    });
    el.addEventListener('input', ev => {
      if (ev.target === promptEl && api) {
        clearTimeout(promptTimer);
        promptTimer = setTimeout(() => { promptTimer = null; swallowSet({ prompt: promptEl.value }); }, 500);
      }
    });
    const swallowSet = patch => { if (api) Promise.resolve(api.update(patch)).catch(() => {}); };
    el._twRun = async () => {
      if (!api) return;
      try {
        const s = lastSnap;
        // ⚠ 全局分区和分块增强【行为一样】：还没规划过就先按当前文档算区域，算过就只更新参数。
        //   2026-10-03 加 partition 时差点漏掉这一条 —— 漏了的话点「开始」会
        //   直接调 api.run()，而 run 里第一步就检查"先规划"，用户看到的是报错而不是开始生成。
        if (mode === 'tiles' || mode === 'partition') {
          if (!s || !s.regions.length) { await api.plan(cfg()); } else { await api.update(cfg()); }
        } else { await api.update(cfg()); }
        await api.run();
      } catch (_) { /* 模块已 ERR.report 并写进状态 */ }
    };
    Promise.resolve().then(() => R.attach(mode)).then(a => {
      if (!alive) return;
      api = a; off = api.subscribe(paint);
    }).catch(e => {
      if (msg) msg.textContent = '区域工具打不开：' + (e && e.message || e);
      root.ERR && root.ERR.report('REGION_WORKBENCH_FAILED', { message: String(e && e.message || e) });
    });
    return () => { alive = false; if (off) off(); urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };
  }

  const ENGINES = [['auto', '自动'], ['banana', 'nano-banana'], ['comfyui', 'ComfyUI']];
  const SIZES = [['1024', '1024'], ['1536', '1536'], ['2048', '2048']];
  const RATIOS = [['auto', 'Auto'], ['1:1', '1:1'], ['3:2', '3:2'], ['2:3', '2:3'], ['16:9', '16:9'], ['9:16', '9:16']];

  /* ─── 12 个面板 ────────────────────────────────────────────────
     每个返回 { title, tag, tagClass, action, pv, params }
       pv     = 左栏（看）
       params = 右栏（调）
       action = 顶栏主按钮 {label, attr}
     有 cross 的（尻特效/场景）params 分两栏。 */

  const PANELS = {

    /* ① DLSS —— 加连接状态；删两个开关；算完整画布不抓选区
       ⭐ 2026-09-29 实装：挂在 V7DLSS.attach() 的无弹窗会话上。
         「开始增强完整画布」= 抓整张画布 → 服务器分块原尺寸增强（计费确认窗口照旧）→ 默认完成后自动传回。
         进度 / 恢复传输 / 取消任务 / 传回都在大卡里；任务卡上点 DLSS 任务也打开这里（老弹窗已收掉）。
         ⚠ 滑块刻度对齐真模块（0–1，皮肤质感 0–2）。以前这里是 0–100 且根本传不过去。 */
    dlss: () => ({
      title: 'DLSS 画质增强',
      action: { label: '开始增强完整画布', attr: 'data-twrun="dlss"' },
      pv: `<p class="v7tw-sect">预览</p>
        <div class="v7tw-box fill" data-twdlssprev="1"><span class="v7tw-boxlbl">增强前 / 后</span><span data-twslotinfo>开始后先显示整张画布，完成后换成增强结果</span></div>
        <div class="v7tw-progress"><div class="v7tw-bar" data-twdlssbar="1"></div></div>
        <div class="v7tw-btnrow">${btn('恢复传输', 'data-twdlss="resume" disabled')}${btn('取消任务', 'data-twdlss="cancel" disabled', 'danger')}${btn('传回到 PS', 'data-twdlss="transfer" disabled', 'wide')}</div>`,
      params:
        sect('处理强度') +
        dlssSlider('处理强度', 'intensity', 1) +
        dlssSlider('本地色调', 'localTone', 1) +
        dlssSlider('本地结构', 'localStruct', 1) +
        dlssSlider('皮肤质感', 'skin', 2) +
        dlssSlider('平滑区保护', 'smoothProtect', 1) +
        sect('渲染', true) +
        fRow('风格', `<select data-twdlssp="style"><option value="0">默认</option><option value="1">自然</option><option value="2">电影</option></select>`) +
        `<div class="v7tw-tog"><span>完成后自动传回</span><div class="v7tw-sw" data-twdlssauto="1"></div></div>` +
        fRow('计费', `<input type="text" readonly value="1 通用积分 / 张">`) +
        sect('状态', true) +
        `<div class="v7tw-hint" data-twdlssmsg="1">直接对当前完整画布做原尺寸增强，不用框选。结果传回新图层，原图层保留。</div>`,
      onMount(el) { return mountDlssPanel(el); },
    }),

    /* ③ 分块增强
       ⭐ 2026-09-29 实装：挂在 V7RegionWorkbench.attach('tiles') 上（V6「分块放大」搬来的那套：
         按 PS 文档 + 块大小 + 重叠切块，逐块生成，再按重叠拼回去）。
         左边画的是真分块（按当前文档尺寸和块参数算），每块按状态上色；右边选预设 / 提示词 / 张数 / 重叠 / 块大小。
         「重新分块」= 按现在的参数重算（不生成）；生成、传回、重试、停止都在大卡里。
         ⚠ 以前：左边是写死的 4×4 假网格，参数传不过去，主按钮弹老区域窗口。
         ⚠ 没移植：V6 的「可视化测试」（往 PS 里铺彩色块看分块）；大卡里已经能直接看到分块图，先不铺进 PS。 */

    /* ② 全局分区（2026-10-03 做回来）
       ⭐ 用户 2026-10-03 明确纠正：这个功能【做回来】，别删名字。
          （2026-09-29 那版定案是删掉，理由是"点开始会跳一个莫名其妙的窗口" ——
           那其实是【接线没做】。今天把接线补上，跳窗口的问题自然就没了。）
       ⭐ 做法跟分块增强是同一套总线（V7RegionWorkbench.attach('partition')），
          区别只在「块大小怎么算」：
            · 分块增强 —— 用户自己填块大小 / 重叠（"我知道要多大的块"）
            · 全局分区 —— 不填，按画布长边自动分成【正方形】区域，
              铺满整张画布、中间不留空当（这是 V6「全局分区」的原意）
       ⚠ 真链路（抓选区 → 生成 → 贴回）无头环境验不了，要用户在真 PS 里验；
         这里只能验到"大卡能打开、参数在、规划得出区域、零报错"。 */
    partition: () => ({
      title: '全局分区',
      action: { label: '开始分区生成', attr: 'data-twrun="partition"' },
      pv: `<p class="v7tw-sect">分区预览 · 按当前 PS 画布自动分</p>
        <div class="v7tw-box fill" data-twregprev="1"><canvas data-twregcanvas="1" width="800" height="600"></canvas><span class="v7tw-boxlbl" data-twreglabel="1">还没有分区</span></div>
        <div class="v7tw-btnrow">${btn('↺ 重新分区', 'data-twreg="plan"', 'wide')}${btn('传回结果', 'data-twreg="transfer" disabled')}${btn('停止', 'data-twreg="stop" hidden', 'danger')}</div>`,
      params:
        sect('生成') +
        fRow('生成预设', `<select data-twregpreset="1"><option value="">选择预设</option></select>`) +
        `<div class="v7tw-f wide"><label>提示词</label><textarea data-twregfield="prompt" rows="3"></textarea></div>` +
        regNumber('每块张数', 'batch', 1, 4) +
        sect('分区', true) +
        `<div class="v7tw-hint">块大小不用填 —— 按画布自动分成正方形，铺满整张、中间不留空当。</div>` +
        sect('传回蒙版', true) +
        regNumber('蒙版内收 px', 'inset', 0, 4096) +
        regNumber('蒙版羽化 px', 'blur', 0, 4096) +
        sect('进度', true) +
        fRow('状态', `<input type="text" readonly data-twregstate="1" value="还没规划">`) +
        `<div class="v7tw-btnrow col">${btn('重试失败区', 'data-twreg="retry" disabled', 'wide')}</div>` +
        `<div class="v7tw-hint" data-twregmsg="1">点「重新分区」按当前画布算区域；确认没问题再点右上角开始生成。生成结果按原坐标传回。</div>`,
      onMount(el) { return mountRegionPanel(el, 'partition'); },
    }),

    tiles: () => ({
      title: '分块增强',
      action: { label: '开始分块生成', attr: 'data-twrun="tiles"' },
      pv: `<p class="v7tw-sect">分块预览 · 按当前 PS 文档算</p>
        <div class="v7tw-box fill" data-twregprev="1"><canvas data-twregcanvas="1" width="800" height="600"></canvas><span class="v7tw-boxlbl" data-twreglabel="1">还没有分块</span></div>
        <div class="v7tw-btnrow">${btn('↺ 重新分块', 'data-twreg="plan"', 'wide')}${btn('传回结果', 'data-twreg="transfer" disabled')}${btn('停止', 'data-twreg="stop" hidden', 'danger')}</div>`,
      params:
        sect('生成') +
        fRow('生成预设', `<select data-twregpreset="1"><option value="">选择预设</option></select>`) +
        `<div class="v7tw-f wide"><label>提示词</label><textarea data-twregfield="prompt" rows="3"></textarea></div>` +
        sect('分块', true) +
        regNumber('块大小 px', 'tileSize', 128, 8192) +
        regNumber('重叠 px', 'overlap', 0, 8191) +
        regNumber('每块张数', 'batch', 1, 4) +
        sect('传回蒙版', true) +
        regNumber('蒙版内收 px', 'inset', 0, 4096) +
        regNumber('蒙版羽化 px', 'blur', 0, 4096) +
        sect('进度', true) +
        fRow('状态', `<input type="text" readonly data-twregstate="1" value="还没规划">`) +
        `<div class="v7tw-btnrow col">${btn('重试失败块', 'data-twreg="retry" disabled', 'wide')}</div>` +
        `<div class="v7tw-hint" data-twregmsg="1">点「重新分块」先按当前文档算块；确认分块没问题再点右上角开始生成。生成结果按原坐标传回。</div>`,
      onMount(el) { return mountRegionPanel(el, 'tiles'); },
    }),

    /* ④ 多区拼接
       ⭐ 2026-09-29 实装：挂在 V7RegionWorkbench.attach('stitch') 上（V6「多区拼接」：多个选区各生成一次，
         拼成一张图一起生成，再按各自的位置切回来传回，省算力）。
         左边画的是真拼接排布（每块带自己的缩略图与状态），右边能上下移 / 移除 / 重新自动排布。
         ⚠ 没移植：V6 的「拖块移动 / 拖右下角等比缩放」手动排布编辑器（V7 只保留了自动排布），已写进交接文档。 */
    stitch: () => ({
      title: '多区拼接',
      action: { label: '开始生成', attr: 'data-twrun="stitch"' },
      pv: `<p class="v7tw-sect">拼接排布 · 每块生成一次，拼成一张再切回原位置</p>
        <div class="v7tw-box fill" data-twregprev="1"><canvas data-twregcanvas="1" width="800" height="600"></canvas><span class="v7tw-boxlbl" data-twreglabel="1">还没有区域</span></div>
        <div class="v7tw-btnrow">${btn('+ 从当前选区添加', 'data-twreg="add"', 'wide')}${btn('↺ 重新自动排布', 'data-twreg="relayout"')}${btn('传回结果', 'data-twreg="transfer" disabled')}${btn('新建一组', 'data-twreg="reset"', 'danger')}</div>`,
      params:
        sect('生成') +
        fRow('生成预设', `<select data-twregpreset="1"><option value="">选择预设</option></select>`) +
        `<div class="v7tw-f wide"><label>提示词</label><textarea data-twregfield="prompt" rows="3"></textarea></div>` +
        regNumber('每区张数', 'batch', 1, 4) +
        sect('区域列表', true) +
        `<div class="v7tw-list" data-twreglist="1"></div>` +
        fRow('状态', `<input type="text" readonly data-twregstate="1" value="还没有区域">`) +
        `<div class="v7tw-btnrow col">${btn('重试失败区', 'data-twreg="retry" disabled', 'wide')}</div>` +
        `<div class="v7tw-hint" data-twregmsg="1">在 PS 里框选一块 → 点「+ 从当前选区添加」，重复到加完；按顺序自动竖向排布，生成后按各自位置切回来传回。</div>`,
      onMount(el) { return mountRegionPanel(el, 'stitch'); },
    }),

    /* ⑤ 双区颜色匹配
       ⭐ 2026-09-29 实装：挂在 V7ColorTools 的无窗口会话上（V6「双区调色」+「颜色匹配」搬过来的那套本机算法）。
         A/B 框显示真抓到的区域；方式/方向/强度/自动传回直接改会话；结果和「传回到 PS」在右下。
         以前：框里只有字、按钮全报「没接上」、主按钮弹老调色窗口。 */
    'color-match': () => ({
      title: '双区颜色匹配',
      action: { label: '开始匹配', attr: 'data-twrun="color-match"' },
      pv: `<p class="v7tw-sect">两个区域 · 在 PS 框选后点「载入选区」</p>
        <div style="display:flex;gap:10px;flex:1;min-height:0">
          <div style="flex:1;display:flex;flex-direction:column;min-width:0">
            <div class="v7tw-box fill" data-twslot="a"><span class="v7tw-boxlbl">A · 参考（颜色来源）</span><span data-twslotinfo>还没抓取</span></div>
            <div class="v7tw-btnrow">${btn('↺ 载入选区', 'data-twcap="a"', 'wide')}${btn('✕', 'data-twclr="a" title="移除 A"')}</div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;min-width:0">
            <div class="v7tw-box fill" data-twslot="b"><span class="v7tw-boxlbl">B · 目标（要被改）</span><span data-twslotinfo>还没抓取</span></div>
            <div class="v7tw-btnrow">${btn('↺ 载入选区', 'data-twcap="b"', 'wide')}${btn('✕', 'data-twclr="b" title="移除 B"')}</div>
          </div>
        </div>`,
      params:
        sect('校色方式') +
        fRow('方式', `<select data-twcolor="method"><option value="global">整体匹配 · 构图不同</option><option value="precise">精准匹配 · 构图相近</option></select>`) +
        fRow('方向', `<select data-twcolor="direction"><option value="ab">A → B（按 A 的颜色改 B）</option><option value="ba">B → A（按 B 的颜色改 A）</option></select>`) +
        `<div class="v7tw-slider"><label>强度</label><input type="range" min="0" max="100" data-twcolor="amount"><span class="v7tw-val" data-twcolorval="amount"></span></div>` +
        `<div class="v7tw-tog"><span>完成后自动传回</span><div class="v7tw-sw" data-twcolor="autoReturn"></div></div>` +
        COLOR_RESULT_BLOCK +
        `<div class="v7tw-hint" data-twcolormsg="1">本机计算，不扣生图积分。结果以新图层传回到被改那一块的原位置。</div>`,
      onMount(el) { return mountColorPanel(el, 'match'); },
    }),

    /* ⑥ AI 调色
       ⭐ 2026-09-29 实装：同一个 V7ColorTools 会话（grade 模式）。点「开始调色」时抓 PS 当前选区当目标
         （没选区就整张画布），左边框是可选的风格参考 A。
         ⚠ 删掉了「API 引擎 / 模型 / 分辨率 / 宽高比」四个下拉：真模块用的是当前生成模型，
           还会把画面补成正方形再裁回来 —— 那四个选了也不生效（铁律 16：设置项要么真接线，要么别出现）。 */
    'color-grade': () => ({
      title: 'AI 调色',
      action: { label: '开始调色', attr: 'data-twrun="color-grade"' },
      pv: `<p class="v7tw-sect">风格参考（可选）</p>
        <div class="v7tw-box fill" data-twslot="a"><span class="v7tw-boxlbl">参考 A · 从 PS 选区抓取</span><span data-twslotinfo>不抓也行：只按文字要求调色</span></div>
        <div class="v7tw-btnrow">
          ${btn('↺ 抓取参考', 'data-twcap="a"', 'wide')}
          ${btn('清除参考', 'data-twclr="a"')}
        </div>`,
      params:
        sect('调色要求') +
        `<div class="v7tw-f wide"><label>调色要求</label><textarea data-twcolor="prompt" rows="4" maxlength="12000" placeholder="例如：暖色胶片氛围，肤色自然，压低绿色饱和度"></textarea></div>` +
        sect('传回', true) +
        fRow('混合模式', `<select data-twcolor="blendMode"><option value="color">颜色 · 保留原明度</option><option value="softLight">柔光</option><option value="overlay">叠加</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="normal">正常</option></select>`) +
        `<div class="v7tw-tog"><span>完成后自动传回</span><div class="v7tw-sw" data-twcolor="autoReturn"></div></div>` +
        COLOR_RESULT_BLOCK +
        `<div class="v7tw-hint" data-twcolormsg="1">目标 = 点「开始调色」时 PS 里的选区，没选区就整张画布。使用当前生成模型，费用以生成确认窗口为准。</div>`,
      onMount(el) { return mountColorPanel(el, 'grade'); },
    }),

    /* ⑦ 图像示波器 —— 4 块铺满左侧
       ⭐ 2026-09-29 实装：左边 4 块是真画布，用 V7ImageScopes 自己的 paint 画；读整张文档（只读，后台线程采样）。
         右边芯片一改立刻重画，不用重新抓。以前：左边是手画的假曲线，芯片不起作用，主按钮会再弹一个老示波器窗口。
       ⭐ 2026-09-29 下午 用户要求：打开就【实时自动】轮询采样 PS 整张画布。
         每秒 probe() 一次（只读文档信息 + 历史记录编号），编号变了（画一笔 / 撤销 / 改显隐 / 换文档）才 sample() 真读像素 ——
         画面没变就不读、不占用 PS。右上角按钮 = 暂停 / 继续实时。关掉大卡轮询立刻停。 */
    'image-scopes': () => ({
      title: '图像示波器',
      action: { label: '暂停实时', attr: 'data-twrun="image-scopes"' },
      pv: `<div class="v7tw-scopes">` + [['luma', '亮度波形'], ['rgb', 'RGB 分量'], ['vector', '矢量示波器'], ['histogram', '直方图']].map(([type, name]) =>
          `<div class="v7tw-scope"><span class="v7tw-boxlbl">${esc(name)}</span><canvas data-twscope="${type}" width="512" height="256"></canvas></div>`).join('') + `</div>`,
      params:
        sect('范围') + chips('range', [['16-235', '16-235'], ['0-255', '0-255'], ['0-110', '0-110']]) +
        sect('矢量增益', true) + chips('vecGain', [['1', '1×'], ['2', '2×'], ['4', '4×'], ['8', '8×']]) +
        sect('直方图刻度', true) + chips('histScale', [['log', 'LOG'], ['lin', 'LIN']]) +
        sect('采样', true) + select('采样长边', 'quality', [['512', '512'], ['256', '256'], ['1024', '1024'], ['2048', '2048']]) +
        // ⭐ 2026-09-29 用户要求：实时刷新的快慢能调。每隔这么久问一次 PS「画面变没变」，变了才重读像素。
        //   快了跟手但更频繁地占用 PS；慢了省事。0.5 秒以下没意义（一次往返本身就要一两百毫秒）。
        sect('实时刷新', true) + chips('pollMs', [['500', '0.5 秒'], ['1000', '1 秒'], ['2000', '2 秒'], ['5000', '5 秒']]) +
        toggle('肤色参考线', 'skin') +
        `<div class="v7tw-hint" data-twscopemsg="1">打开就自动读取当前 PS 文档整张画布：按「实时刷新」的间隔看一次 PS，画面一变（多一步历史记录）就重读。只读，不改图层、选区或颜色。</div>`,
      onMount(el) {
        const api = root.V7ImageScopes;
        const msg = el.querySelector('[data-twscopemsg]');
        const tag = el.querySelector('.v7tw-top .v7tw-tag');
        const runBtn = el.querySelector('[data-twrun]');
        const RANGE = { '16-235': 'broadcast', '0-255': 'full', '0-110': 'extended' };
        const SLOW_MS = 3000;
        let last = null, alive = true, paused = false, running = false, timer = null;
        let lastKey = '', lastQuality = 0, lastError = '';
        // 芯片没存过值时，把默认那颗点亮（只点亮不保存）
        const chipValue = (group, fallback) => {
          const on = el.querySelector('[data-twpg="' + group + '"].on');
          if (on) return on.dataset.twpv;
          const def = el.querySelector('[data-twpg="' + group + '"][data-twpv="' + fallback + '"]');
          if (def) { def.classList.add('on'); def.setAttribute('aria-pressed', 'true'); }
          return fallback;
        };
        const prefs = () => ({
          range: RANGE[chipValue('range', '0-255')] || 'full',
          gain: Number(chipValue('vecGain', '1')) || 1,
          log: chipValue('histScale', 'log') !== 'lin',
          skin: !!el.querySelector('.v7tw-sw[data-twp="skin"].on'),
        });
        // 刷新间隔（毫秒）：没存过就点亮「1 秒」
        const pollMs = () => Number(chipValue('pollMs', '1000')) || 1000;
        // ⚠ 画之前先把画布的像素大小对齐到它在屏幕上的实际大小（2026-09-29）：
        //   以前画布固定 512×256，再被样式拉伸去填满格子 —— 画什么都跟着变形，矢量图的圆就成了椭圆。
        const fit = c => {
          const r = c.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
          if (!(r.width > 0 && r.height > 0)) return;
          const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
          if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        };
        const draw = () => {
          if (!api || typeof api.paint !== 'function') return;
          const p = prefs();
          el.querySelectorAll('canvas[data-twscope]').forEach(c => { fit(c); api.paint(c, c.dataset.twscope, last, p); });
        };
        draw();
        // 格子大小变了（展开动画走完、自由模式下缩放窗口）就按新尺寸重画
        const grid = el.querySelector('.v7tw-scopes');
        const resized = (typeof ResizeObserver === 'function' && grid) ? new ResizeObserver(() => { if (alive) draw(); }) : null;
        if (resized) resized.observe(grid);
        // 芯片 / 开关的保存由 bindControls 先做（绑在元素自己身上），这里冒泡到面板时只负责重画；
        //   换了刷新间隔就按新间隔重新排下一次检查
        el.addEventListener('click', ev => {
          const hit = ev.target.closest && ev.target.closest('[data-twpg],.v7tw-sw[data-twp="skin"]');
          if (!hit) return;
          if (hit.dataset.twpg === 'pollMs') { if (!paused) schedule(pollMs()); return; }
          draw();
        });
        const quality = () => Number(el.querySelector('select[data-twp="quality"]')?.value) || 512;
        const say = text => { if (msg) msg.textContent = text; };
        const setBtn = () => { if (runBtn) runBtn.textContent = paused ? '继续实时' : '暂停实时'; };
        // 同一个原因只弹一次报错卡（轮询每秒一次，不能每秒弹一张）；面板里始终写着当前原因（铁律 17：不静默）
        const failed = e => {
          const text = String(e && e.message || e);
          say('读取失败：' + text + '。好了会自动继续。');
          if (tag) tag.textContent = '读取失败';
          if (text !== lastError) { lastError = text; root.ERR && root.ERR.report('IMAGE_SCOPES_FAILED', { message: text }); }
        };
        // 画面「版本号」：文档 + 历史记录编号 + 尺寸。PS 报不出历史记录编号时退成每 3 秒重读一次。
        const keyOf = info => info.historyStateId != null
          ? [info.id, info.historyStateId, info.width, info.height].join(':')
          : [info.id, info.width, info.height, Math.floor(Date.now() / Math.max(SLOW_MS, pollMs()))].join(':');
        const tick = async () => {
          if (!api || typeof api.probe !== 'function' || typeof api.sample !== 'function') throw new Error('示波器模块没有加载，请重新打开软件');
          const info = await api.probe();
          if (!alive || paused) return;
          if (!info || info.hasDoc === false || info.id == null) {
            if (lastKey || last) { last = null; lastKey = ''; draw(); }
            lastError = '';
            if (tag) tag.textContent = '等待文档';
            say('Photoshop 里还没有打开的文档 —— 打开后自动开始。');
            return;
          }
          const key = keyOf(info), q = quality();
          if (key === lastKey && q === lastQuality) return;          // 画面没变：不读像素、不占用 PS
          const out = await api.sample({ quality: q, doc: info });
          if (!alive || paused) return;
          last = out.result; lastKey = key; lastQuality = q; lastError = '';
          draw();
          const name = out.name || info.name || '';
          if (tag) tag.textContent = '实时 · ' + (name ? name + ' · ' : '') + out.result.width + ' × ' + out.result.height;
          say('实时读取中：每 ' + (pollMs() / 1000) + ' 秒看一次 PS，画面变了就刷新（只读）。上次更新 ' + new Date().toLocaleTimeString('zh-CN') + '。');
        };
        // 只有一条轮询链：schedule 先清掉旧定时器再排新的；run 正在跑时不会再开第二条
        const schedule = ms => { clearTimeout(timer); timer = null; if (alive && !paused) timer = setTimeout(run, ms); };
        const run = async () => {
          timer = null;
          if (!alive || paused) return;
          if (running) { schedule(pollMs()); return; }
          // 软件窗口被最小化、看不见时不读（document.hidden），回来再继续
          if (document.hidden) { schedule(pollMs()); return; }
          running = true;
          try { await tick(); } catch (e) { if (alive && !paused) failed(e); } finally { running = false; }
          schedule(pollMs());
        };
        el._twRun = async () => {
          if (!alive) return;
          paused = !paused; setBtn();
          if (paused) {
            schedule(0);   // paused 时 schedule 只会清掉定时器，不会再排
            if (tag) tag.textContent = '已暂停';
            say('已暂停实时读取。点右上角「继续实时」恢复。');
          } else {
            lastKey = ''; say('正在读取当前 PS 文档…'); schedule(0);
          }
        };
        // 采样长边改了：马上按新精度重读（tick 里比较 lastQuality）
        el.addEventListener('change', ev => { if (ev.target.matches && ev.target.matches('select[data-twp="quality"]') && !paused) schedule(0); });
        setBtn(); say('正在读取当前 PS 文档…'); schedule(0);
        return () => { alive = false; clearTimeout(timer); timer = null; last = null; if (resized) resized.disconnect(); };
      },
    }),

    /* ⑧ 照片批处理 —— 队列在左，操作在右
       ⭐ 2026-09-29 实装：挂在 V7BatchQueue.attach() 上（V6「批处理」搬过来的那套：每项冻结照片 / 区域 / 参数，顺序执行）。
         左边是真队列（缩略图 / 文档 / 区域 / 预设 / 状态，▲▼ 移动、重新排队、×删除）；右边选预设加入、去掉重复项、清空、停止。
         ⚠ 删掉了假的「预计耗时」（没有真数据）；「重排 / 去重」V6 没有，按实用意思做成「去掉重复项」（同文档同区域同配置只留一个）。
         ⚠ 以前：列表只在打开那一刻读一次（模块没初始化时永远显示空），× 没反应，「清空队列」确认后却是打开老窗口。 */
    'batch-queue': () => ({
      title: '照片批处理',
      action: { label: '开始批处理', attr: 'data-twrun="batch-queue"' },
      pv: `<p class="v7tw-sect">队列 · 每项冻结照片、区域和参数，按顺序执行</p>
        <div class="v7tw-list" data-twqueue="1"></div>`,
      params:
        sect('加入') +
        fRow('用哪个预设', `<select data-twbatchpreset="1"><option value="">当前主界面配置</option></select>`) +
        `<div class="v7tw-btnrow">${btn('+ 加入当前选区', 'data-twbatch="enqueue"', 'wide')}</div>` +
        sect('队列', true) +
        fRow('队列', `<input type="text" readonly data-twbatchcount="1" value="0 项">`) +
        `<div class="v7tw-btnrow col">
          ${btn('去掉重复项', 'data-twbatch="dedupe"', 'wide')}
          ${btn('清空队列', 'data-twbatch="clear"', 'wide danger')}
          ${btn('停止当前与后续', 'data-twbatch="stop" hidden', 'wide danger')}
        </div>` +
        `<div class="v7tw-hint" data-twbatchmsg="1">在 PS 里框选后点「加入当前选区」。每项按加入时的预设和参数跑，结果是否自动传回看那一项的配置。</div>`,
      onMount(el) { return mountBatchPanel(el); },
    }),

    /* ⑨ 半合成 */
    hemisynth: () => ({
      title: '半合成',
      action: { label: '开始生成', attr: 'data-twrun="hemisynth"' },
      pv: `<p class="v7tw-sect">预览 / 参考</p>
        <div class="v7tw-box fill"><span class="v7tw-boxlbl">参考图（可开关）</span>从 PS 选区抓取</div>`,
      params:
        sect('模式') + chips('mode', [['semi', '半合成'], ['diorama', '手办地台'], ['hang', '垂悬环绕物']]) +
        sect('开关', true) +
        toggle('半身像兼容', 'bust') +
        toggle('垂悬环绕物', 'hangToggle') +
        toggle('体块控制', 'bodyblock') +
        toggle('使用参考图', 'useRef') +
        sect('丰富度', true) + slider('丰富度', 'rich', 0, 100) +
        sect('角色补充', true) + textarea('角色补充', 'charHint', 2) +
        sect('模板填充', true) +
        text('道具密度', 'density') +
        select('物体高度', 'height', [['knee', '及膝'], ['waist', '及腰']]) +
        text('背景', 'background') +
        sect('生成参数', true) +
        select('引擎', 'provider', ENGINES),
    }),

    /* ⑩ 场景 —— 参数分两栏 */
    scene: () => ({
      title: '场景',
      two: true,
      action: { label: '开始生成', attr: 'data-twrun="scene"' },
      pv: `<p class="v7tw-sect">场景预览</p>
        <div class="v7tw-box fill"><span class="v7tw-boxlbl">合成效果预览</span>选完场景包后显示</div>`,
      params:
        sect('场景包') + chips('pack', [['cyber', '赛博朋克'], ['waste', '废土'], ['jp', '和风']]) +
        sect('灯光', true) + chips('light', [['neon', '霓虹'], ['warm', '暖调'], ['cool', '冷调'], ['back', '逆光'], ['soft', '柔光']]) +
        sect('俯仰', true) + chips('tilt', [['up', '俯视'], ['flat', '平视'], ['down', '仰视']]) +
        sect('焦段 / 位置', true) +
        slider('焦段', 'focal', 14, 200) +
        text('拍摄位置', 'area') +
        sect('物品篮子', true) +
        chips('basketLayer', [['front', '前景'], ['mid', '中景'], ['back', '背景']]) +
        `<div class="v7tw-cells" style="grid-template-columns:repeat(2,1fr)">
          ${['霓虹灯牌', '广告牌', '天线', '管道', '电缆', '雨棚', '飞车', '机械臂']
            .map(n => `<button type="button" class="v7tw-cell" data-twcells="${esc(n)}">${esc(n)}</button>`).join('')}
        </div>` +
        sect('参考与生成', true) +
        toggle('使用人物参考', 'useRef') +
        select('引擎', 'provider', ENGINES) +
        `<div class="v7tw-btnrow">${btn('抓取人物参考', 'data-twaux="capture-ref"', 'wide')}</div>`,
    }),

    /* ⑪ 尻特效 —— 参数分两栏 */
    kao: () => {
      const fx = ['火星', '烟雾', '光斑', '闪烁', '流光', '灰尘', '雨丝', '雪花', '花瓣', '能量', '光环'];
      const fxKeys = ['spark', 'smoke', 'flare', 'flicker', 'flow', 'dust', 'rain', 'snow', 'petal', 'energy', 'halo'];
      return {
        title: '尻特效',
        two: true,
        action: { label: '生成特效', attr: 'data-twrun="kao"' },
        pv: `<p class="v7tw-sect">特效预览</p>
          <div class="v7tw-box fill"><span class="v7tw-boxlbl">粒子效果预览</span>开始后显示</div>`,
        params:
          sect('粒子类型') +
          select('主粒子', 'mainType', [['spark', '火星四溅'], ['smoke', '烟雾'], ['flare', '光斑']]) +
          select('辅粒子', 'subType', [['none', '无'], ['smoke', '烟雾'], ['dust', '灰尘']]) +
          slider('混合占比', 'mix', 0, 100) +
          sect('粒子特效', true) +
          `<div class="v7tw-span2" style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">
            ${fx.map((n, i) =>
              `<div class="v7tw-fx"><span>${esc(n)}</span>
                 <input type="range" min="0" max="100" data-twfx="${esc(fxKeys[i])}">
                 <div class="v7tw-sw" data-twfxtog="${esc(fxKeys[i])}"></div>
               </div>`).join('')}
          </div>` +
          sect('光学物理', true) +
          slider('折射 IOR', 'ior', 1, 3) +
          slider('噪波范围', 'noiseR', 0, 100) +
          slider('噪波幅度', 'noiseA', 0, 100) +
          slider('动态模糊', 'blur', 0, 100) +
          slider('菲涅尔', 'fresnel', 0, 100) +
          slider('重力', 'gravity', 0, 100) +
          sect('生成', true) +
          select('引擎', 'provider', ENGINES) +
          select('分辨率', 'size', SIZES) +
          select('宽高比', 'ratio', RATIOS) +
          `<div class="v7tw-span2 v7tw-btnrow">
            ${btn('尻子大爆炸', 'data-twaux="random"')}
            ${btn('关闭所有粒子', 'data-twaux="disable-all"', 'wide')}
          </div>`,
      };
    },

    /* ⑫ AI 修图痕迹检测 —— 结果在左，操作在右
       ⭐ 2026-09-29 用户定案：每处痕迹在 PS 里是单独一个图层（装在一个组里）。
         点列表一条 → PS「按屏幕大小缩放图层」跳过去 + 组里只显示这一处；「显示全部」恢复。
         列表订阅 V7SeamReview，检测进度 / 跳转结果实时刷新（以前只在打开那一刻读一次，检测完要关了重开）。 */
    /* ⭐ 眼神调整（眼珠随动，2026-10-25 用户定，docs/290）。干活的在 eyegaze-tool.js（V7EyeGaze.mount），
         这里只给外壳：左边预览 + 底下一排按钮，右边两列调节。主按钮「抓取选区」= mount 挂的 _twRun。 */
    eyegaze: () => ({
      title: '眼神调整',
      tag: '本机计算',
      action: { label: '抓取选区', attr: 'data-twrun="eyegaze"' },
      two: true,
      pv: root.V7EyeGaze ? root.V7EyeGaze.previewHtml() : '<div class="v7tw-hint">眼神调整模块没加载，重新打开软件再试。</div>',
      params: root.V7EyeGaze ? '<div class="v7tw-span2 v7eg-params">' + root.V7EyeGaze.paramsHtml() + '</div>' : '',
      onMount(el) { return root.V7EyeGaze ? root.V7EyeGaze.mount(el) : null; },
    }),

    'seam-review': () => ({
      title: 'AI 修图痕迹检测',
      action: { label: '抓取画布并检测', attr: 'data-twrun="seam-review"' },
      pv: `<p class="v7tw-sect">痕迹列表 · 点一条，PS 跳过去并只显示它</p>
        <div class="v7tw-list" data-twseam="1"></div>
        <div class="v7tw-btnrow">${btn('显示全部痕迹', 'data-twseamall="1"', 'wide')}</div>`,
      params:
        sect('说明') +
        `<div class="v7tw-hint">抓取当前 PS 文档整张画布，在本机检测疑似 AI 修图痕迹。每处痕迹单独一个图层，装进「AI修图痕迹检测标注」组。候选位置需要人工确认。</div>` +
        sect('状态', true) +
        text('当前', '_state', true) +
        text('痕迹数', '_seamCount', true) +
        `<div class="v7tw-hint" data-twseammsg="1"></div>`,
      onMount(el) {
        const api = root.V7SeamReview;
        const list = el.querySelector('[data-twseam]');
        const all = el.querySelector('[data-twseamall]');
        const run = el.querySelector('[data-twrun]');
        const st = el.querySelector('[data-twp="_state"]');
        const cnt = el.querySelector('[data-twp="_seamCount"]');
        const msg = el.querySelector('[data-twseammsg]');
        if (!api || typeof api.subscribe !== 'function') {
          if (list) list.innerHTML = '<div class="v7tw-hint">检测模块没有加载，请重新打开软件。</div>';
          return;
        }
        const paint = snap => {
          if (!list || !list.isConnected) return;
          const cands = Array.isArray(snap.candidates) ? snap.candidates : [];
          const groupReady = !!(snap.manifest && Number.isSafeInteger(snap.manifest.groupId));
          if (st) st.value = snap.busy ? '检测中…' : snap.focusBusy ? '跳转中…' : '空闲';
          if (cnt) cnt.value = String(cands.length);
          if (msg) msg.textContent = snap.message || '';
          if (run) run.disabled = !!snap.busy;
          if (all) all.disabled = !!snap.busy || !groupReady;
          const top = list.scrollTop;
          if (!cands.length) {
            list.innerHTML = '<div class="v7tw-hint">' + (snap.busy ? '正在检测，结果出来后显示在这里。' : '还没有检测结果。点右上角「抓取画布并检测」开始。') + '</div>';
            return;
          }
          list.innerHTML = cands.map(c => {
            const r = c.region || {};
            const jumpable = Number.isSafeInteger(c.layerId) && groupReady;
            const cls = 'v7tw-row v7tw-pick' + (c.id === snap.selectedCandidateId ? ' sel' : '');
            const solo = c.id === snap.soloCandidateId ? '<span class="v7tw-tag ok">只显示中</span>' : '';
            const note = jumpable ? '' : ' · 旧版结果，不能跳转';
            return `<button type="button" class="${cls}" data-twseamid="${esc(c.id)}"${jumpable && !snap.busy ? '' : ' disabled'}
              title="${esc(jumpable ? '点一下：Photoshop 跳到这里，组里只显示这一处' : '联动插件是旧版，重新 Reload 后再检测一次就能逐条跳转')}">
              <span class="v7tw-idx">${String(c.index || 0).padStart(2, '0')}</span>
              <span class="v7tw-txt">${esc(c.label || '复核线索')} · 左 ${Math.round(r.left || 0)} / 上 ${Math.round(r.top || 0)} · ${Math.round(r.width || 0)}×${Math.round(r.height || 0)}${note}</span>${solo}
            </button>`;
          }).join('');
          list.scrollTop = top;
        };
        // 点一条就跳。错误在 V7SeamReview 里已统一走 ERR.report，这里只防未处理的 Promise
        if (list) list.addEventListener('click', ev => {
          const row = ev.target.closest && ev.target.closest('[data-twseamid]');
          if (!row || row.disabled) return;
          ev.stopPropagation();
          Promise.resolve(api.select(row.dataset.twseamid)).catch(() => {});
        });
        if (all) all.addEventListener('click', ev => {
          ev.stopPropagation();
          Promise.resolve(api.showAll()).catch(() => {});
        });
        return api.subscribe(paint);   // 返回退订函数：大卡关掉时由 dispose 调用
      },
    }),
  };

  /* ─── 渲染 ──────────────────────────────────────────────────── */
  // onMount 可以返回一个清理函数（退订、停计时器）。存在面板根节点上：
  // 重画前、大卡关闭时各调一次 —— 否则每开一次大卡就多挂一个订阅，越开越卡。
  function runCleanup(el) {
    const fn = el && el._twCleanup;
    if (el) { el._twCleanup = null; el._twRun = null; }
    if (typeof fn === 'function') { try { fn(); } catch (_) {} }
  }
  function render(key, bodyEl, preset) {
    const def = PANELS[key];
    if (!def) return false;
    runCleanup(bodyEl);
    const spec = def();
    const title = spec.title;

    bodyEl.innerHTML =
      `<div class="v7tw">
        <div class="v7tw-top">
          <button type="button" class="v7tw-btn" data-twback="1" title="返回" aria-label="返回">←</button>
          <h2>${esc(title)}</h2>
          <span class="v7tw-tag${spec.tagClass ? ' ' + spec.tagClass : ''}">${esc(spec.tag || '')}</span>
          <span class="v7tw-spacer"></span>
          <button type="button" class="v7tw-btn primary" ${spec.action ? spec.action.attr : ''}>${esc(spec.action ? spec.action.label : '')}</button>
          <button type="button" class="v7tw-btn v7tw-x" data-twclose="1" title="全部收起" aria-label="全部收起">×</button>
        </div>
        <div class="v7tw-body">
          <div class="v7tw-pv">${spec.pv || ''}</div>
          <div class="v7tw-params${spec.two ? ' two' : ''}">${spec.params || ''}</div>
        </div>
      </div>`;

    bindControls(bodyEl);

    // 面板自己的一次性补充（读真实状态、建列表）
    if (typeof spec.onMount === 'function') {
      try { const cleanup = spec.onMount(bodyEl, preset); if (typeof cleanup === 'function') bodyEl._twCleanup = cleanup; }
      catch (e) { root.ERR && root.ERR.report('TOOL_OPEN_FAILED', { message: String(e && e.message || e) }); }
    }

    // 返回
    const back = bodyEl.querySelector('[data-twback]');
    // ⚠ 必须 stopPropagation：close() 会同步清空面板（按钮自己也被移除），
    //   事件继续往上冒时 target 已经脱离 DOM，全局"点外面就收起"会把它当成点外面，
    //   连工具列表一起关掉 —— 用户点 ← 本来只想回到列表（2026-09-28 实测抓到）。
    if (back) back.addEventListener('click', ev => { ev.stopPropagation(); close(); });
    // × 全部收起：跟三级卡导航条上那个 × 同一个语义（工具模式下那条导航条被藏了，按钮挪到这里）。
    //   ← 回到工具列表、× 连列表一起收 —— 两条关闭路径都得有。
    const shut = bodyEl.querySelector('[data-twclose]');
    if (shut) shut.addEventListener('click', ev => {
      ev.stopPropagation();
      if (typeof host.closeAll === 'function') host.closeAll(); else close();
    });

    // 主按钮：面板自己接了真功能（onMount 里挂 bodyEl._twRun）就在大卡里直接干活 ——
    //   用户定案「老弹窗全部收掉，大卡是唯一入口」（2026-09-29），逐个工具替换中；
    //   还没替换的暂时退回 runTool 打开老模块，不静默失败。
    const run = bodyEl.querySelector('[data-twrun]');
    if (run) run.addEventListener('click', () => {
      if (typeof bodyEl._twRun === 'function') {
        Promise.resolve().then(() => bodyEl._twRun()).catch(e => root.ERR && root.ERR.report('TOOL_OPEN_FAILED', { message: String(e && e.message || e) }));
        return;
      }
      runTool(run.dataset.twrun, preset);
    });

    // 次要按钮：先接到真实模块，没有就报"未接线"，不装样子
    bodyEl.querySelectorAll('[data-twaux]').forEach(b => {
      b.addEventListener('click', () => auxAction(b.dataset.twaux, preset));
    });

    return true;
  }

  /* ─── 主按钮：调真实工具模块 ──────────────────────────────────
     ⚠ key 必须用【工具定义里的真实 key】（tool-silhouettes.js 的 definitions），
       不能用我自己起的简称。2026-09-28 栽过：我写了 tiled/layercm/colorgrade/
       scopes/batch，而真实 key 是 tiles/color-match/color-grade/image-scopes/
       batch-queue —— 对不上 → 走不到分支 → 退回旧的弹窗入口。
       用户看到的就是"点按还是出现的老入口"。 */
  function runTool(key, preset) {
    const R = root;
    try {
      if (key === 'dlss') { if (R.V7DLSS && R.V7DLSS.open) return void R.V7DLSS.open(); }
      // 全局分区 / 分块 / 拼接：三个都在大卡里直接干活（面板里的 _twRun），
      // 这里只是"剪影上双击 / 从别处按 key 打开"时的兜底，统一交给 V7RegionWorkbench.open。
      // ⚠ 2026-10-03：partition 加回来。用户当天明确纠正"做回来，别删名字" ——
      //   之前那句"2026-09-29 用户定案删除"已经不成立，别再照它写。
      else if (key === 'partition' || key === 'tiles' || key === 'stitch') {
        if (R.V7RegionWorkbench && R.V7RegionWorkbench.open) return void R.V7RegionWorkbench.open(key);
      }
      else if (key === 'color-match') { if (R.V7ColorTools && R.V7ColorTools.open) return void R.V7ColorTools.open('match'); }
      else if (key === 'color-grade') { if (R.V7ColorTools && R.V7ColorTools.open) return void R.V7ColorTools.open('grade'); }
      else if (key === 'image-scopes') { if (R.V7ImageScopes && R.V7ImageScopes.open) return void R.V7ImageScopes.open(); }
      else if (key === 'batch-queue') { if (R.V7BatchQueue && R.V7BatchQueue.open) return void R.V7BatchQueue.open(); }
      else if (key === 'hemisynth' || key === 'scene' || key === 'kao') {
        if (R.V7CreativeTools && R.V7CreativeTools.open) return void R.V7CreativeTools.open(key, preset);
      }
      else if (key === 'eyegaze') { if (R.V7EyeGaze && R.V7EyeGaze.open) return void R.V7EyeGaze.open(); }
      else if (key === 'seam-review') {
        // 检测就在大卡里跑，结果直接出现在左边列表（不再弹别的窗口）。失败已在模块内 ERR.report，这里只接住 Promise。
        if (R.V7SeamReview && R.V7SeamReview.run) { Promise.resolve(R.V7SeamReview.run()).catch(() => {}); return; }
      }
    } catch (e) {
      R.ERR && R.ERR.report('TOOL_OPEN_FAILED', { message: String(e && e.message || e) });
      return;
    }
    // 没走到 = 模块没加载。明说，别静默（铁律 17）
    R.ERR && R.ERR.report('TOOL_OPEN_FAILED', {
      message: '这个工具的工作面还没接上（' + key + '）。功能模块可能没加载，重新打开软件再试。',
    });
  }

  function auxAction(name, preset) {
    // 这些次要动作目前只有一部分有真实接口。没接上的明说，不装样子。
    const creative = (mode, step) => {
      const C = root.V7CreativeTools;
      if (!C || typeof C.act !== 'function') throw new Error('创作工具模块没加载，重新打开软件再试');
      return void C.act(mode, preset, step);
    };
    const map = {
      'preset-search': () => { if (host.focusList) host.focusList(); },
      'enqueue': () => { if (root.V7BatchQueue && root.V7BatchQueue.enqueueCurrent) return void root.V7BatchQueue.enqueueCurrent(); },
      // 场景「抓取人物参考」/ 尻特效「尻子大爆炸」「关闭所有粒子」：打开创作工具对应模式，再做这一步。
      //   之前三个都没接，点了只报「按钮还没接上」（10-21 查遥测：1.9.5 抓人物参考有 5 次）。
      'capture-ref': () => creative('scene', 'capture'),
      'random': () => creative('kao', 'randomEffects'),
      'disable-all': () => creative('kao', 'disableEffects'),
      'clear-queue': () => { if (host.confirmThen) return void host.confirmThen('清空队列？', () => root.V7BatchQueue && root.V7BatchQueue.open && root.V7BatchQueue.open()); },
    };
    const fn = map[name];
    if (fn) { try { return fn(); } catch (e) { root.ERR && root.ERR.report('TOOL_OPEN_FAILED', { message: String(e && e.message || e) }); } return; }
    root.ERR && root.ERR.report('TOOL_OPEN_FAILED', {
      message: '这个按钮还没接上（' + name + '）。先用工具主页面的对应功能。',
    });
  }

  /* ─── 开 / 关 ───────────────────────────────────────────────── */
  function open(key, preset) {
    if (!host.open) return null;
    active = { key: key, presetId: preset && preset.id, vals: null, save: null };
    const handle = host.open({
      id: 'tool:' + key,
      title: (PANELS[key] && PANELS[key]().title) || '工具',
      description: '',
      mount(bodyEl) {
        // 参数：读这条预设的 content
        const store = root.PRESETS;
        const live = (store && preset && store.presetById(preset.id)) || preset || {};
        let parsed = {};
        try { parsed = JSON.parse(live.content || '{}') || {}; } catch (_) { parsed = {}; }
        active.vals = parsed;
        active.save = function () {
          if (!store || !live.id) return;
          const now = store.presetById(live.id) || live;
          store.savePreset(Object.assign({}, now, { content: JSON.stringify(active.vals) }))
            .catch(e => root.ERR && root.ERR.report('PRESET_SAVE_FAILED', { message: String(e && e.message || e) }));
        };
        render(key, bodyEl, live);
        return function dispose() { runCleanup(bodyEl); active = null; };
      },
    });
    return handle;
  }

  function close() {
    if (host.close) host.close();
    // ⚠ 展开动画途中就点关闭时，mount 还没跑、dispose 也就不存在 ——
    //   这里必须自己清，否则 ownsGeometry() 一直为真，别的工作面从此不能调尺寸。
    active = null;
  }

  function configure(value) {
    host = value || {};
  }

  /* ══════════════════════════════════════════════════════════════
     让位编排 v3（2026-09-28，用户实测"展开/收起时别的界面完全没动"后重做）

     读法：【先收拢，再变身】两拍，绝不能同时。
       ① 收拢  0–260ms   叠在当前卡下面的卡往上收进当前卡；二级卡往当前卡缩；
                         任务堆 / 报错堆往当前卡方向缩 —— 全部"缩到一起"并淡掉
       ② 变身  240ms 起  大卡先在【当前卡原位】淡入盖住它、当前卡同时淡出，
                         随后大卡展开到目标尺寸（普通 880×400 / 自由模式就地）
     收起完全镜像：大卡缩回当前卡原位 → 当前卡淡回 → 其它元素从当前卡"放出来"。
     自由模式同一套：所有元素朝【当前卡中心】收拢（取连线 35%，封顶 56px）。

     ⚠ v2 用户看不到任何动画的三个原因 —— 别再犯：
       · 收拢和展开同时起：面板 z50 盖在卡片上面，卡片在它背后淡 = 等于没动画
       · 任务堆/报错堆在普通模式没进名单；而且 #errors 容器自身高度是 0
         （子元素全 absolute），用 offsetHeight>0 判断会把它筛掉
       · restoreYield 导出了，ui.html 却一次都没调用 → 收起时没有任何弹回
     ⚠ 叠压卡的下垂是 setStack 写的【内联 transform】，CSS 类改不动；
       这里用 WAAPI 的独立属性 translate / scale —— 与 transform 是两条通道、叠加生效，
       不会冲掉 setStack 的值。关键帧只写一端（另一端 = 元素当前真实值），
       这样不管卡片原本什么透明度都不会跳。
     ══════════════════════════════════════════════════════════════ */
  const EASE_GATHER  = 'cubic-bezier(.4,0,.6,1)';
  const EASE_RELEASE = 'cubic-bezier(.22,.9,.32,1)';
  let yieldRecs = [];
  let motionReported = false;

  // ⚠ 2026-10-20：不再读系统的「减少动画」偏好（用户 Windows 关了显示动画，原来这里会把工具卡原地展开 / 收回的动画砍掉）。
  //   同自由摆放（free-mode-ui.js）和 reference-card.css 那条规矩：整个界面不尊重这个系统偏好。
  // 2026-10-22：改读软件自己的「减少动画」开关（motion-tokens.js），仍然不读系统偏好
  function reducedMotion(){
    return !!(root.V7Motion&&root.V7Motion.reduced());
  }
  function MS(){ return (root.V7Motion&&root.V7Motion.MS)||{fast:120,base:200,slow:340}; }
  // 体检日志：从 PowerShell 里启动 exe 时能看到；开发者工具里看 body 的 data-v7tw-yield
  function trace(message){
    const text='[工具工作面] '+message;
    try{ console.log(text); }catch(_){}
    try{ const p=root.__TAURI__?.core?.invoke?.('debug_log',{message:text}); if(p&&p.catch)p.catch(()=>{}); }catch(_){}
  }
  // ⚠ 不许吞（v2 的 catch(_){} 把问题藏成"什么都没发生"，铁律 17）。
  //   一次开关可能十几个元素一起失败，只报一次，免得弹一串报错卡。
  function motionIssue(error){
    const text='让位动画没能播放：'+String(error&&error.message||error);
    trace(text);
    if(!motionReported){ motionReported=true; root.ERR&&root.ERR.report('TOOL_OPEN_FAILED',{message:text}); }
  }
  // 容器自身可能高 0（子元素全 absolute，比如 #errors），取子元素的并集当可见范围
  function visualRect(node){
    const own=node.getBoundingClientRect();
    if(own.width>0&&own.height>0) return own;
    let l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;
    for(const child of node.children){
      const c=child.getBoundingClientRect();
      if(!(c.width>0&&c.height>0)) continue;
      l=Math.min(l,c.left); t=Math.min(t,c.top); r=Math.max(r,c.right); b=Math.max(b,c.bottom);
    }
    return l===Infinity?null:{left:l,top:t,width:r-l,height:b-t};
  }
  function isShown(node){
    if(!node||node.hidden) return false;
    const s=root.getComputedStyle(node);
    return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.01;
  }
  // 待确认的报错（L3/L4）必须留在原位、能点 —— 不参与让位
  function blockingErrors(node){
    return !!node&&(node.classList.contains('has-blocking')||node.hasAttribute('data-v7-confirmation')||!!node.querySelector('.ec-l3,.ec-l4'));
  }
  // 朝目标中心收拢：取两中心连线的 35%，封顶 cap 像素
  function towards(rect,target,cap){
    const ax=rect.left+rect.width/2, ay=rect.top+rect.height/2;
    const bx=target.left+target.width/2, by=target.top+target.height/2;
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy);
    if(!len||!cap) return {x:0,y:0};
    const k=Math.min(cap,len*.35)/len;
    return {x:Math.round(dx*k), y:Math.round(dy*k)};
  }
  function tuck(node,to,timing,role,order){
    try{
      const anim=node.animate(
        [{opacity:to.opacity, scale:String(to.scale), translate:to.x+'px '+to.y+'px', offset:1}],
        {duration:timing.duration, delay:timing.delay||0, easing:timing.easing||EASE_GATHER, fill:'forwards'});
      node.classList.add('v7tw-yielded');      // 让位期间一律不吃鼠标（见 tool-workbench.css）
      yieldRecs.push({anim,node,to,role,order:order||0});
      return true;
    }catch(error){ motionIssue(error); return false; }
  }

  // 立刻复原（不播动画）：切账号、重复打开等场合用
  function cancelYield(){
    for(const rec of yieldRecs.splice(0)){
      try{ rec.anim.cancel(); }catch(_){}
      rec.node.classList.remove('v7tw-yielded');
    }
  }

  /** ① 收拢。返回参与动画的元素个数（0 = 没东西可收，调用方直接展开）。 */
  function yieldOut(currentCard){
    cancelYield();
    const card=currentCard||null;
    if(!card||!card.isConnected) return 0;
    // 系统开了减速动画：只淡出、不位移。⚠ 不整段跳过 —— 跳过=用户以为没做（v2 就是这么干的）
    const reduce=reducedMotion();
    const cap=reduce?0:56;
    const target=card.getBoundingClientRect();
    const freeMode=!!root.V7FreeMode?.isActive?.();
    let count=0;

    // 1) 同一叠里的其它卡
    const stack=doc.getElementById('stack');
    const others=stack?[...stack.querySelectorAll('.block-card')].filter(c=>c!==card&&isShown(c)):[];
    if(freeMode){
      // 自由模式：卡是用户自己摆的、各在各处 —— 朝当前卡中心收拢、缩小、淡掉
      others.forEach((c,i)=>{
        const v=towards(c.getBoundingClientRect(),target,cap);
        if(tuck(c,{opacity:0,scale:reduce?1:.9,x:v.x,y:v.y},{duration:MS().base,delay:Math.min(i,8)*22},'other',i)) count++;
      });
    }else{
      // 普通模式：叠在当前卡下面、只露 34px 边的那几张 —— 往上【正好收齐】到当前卡背后，
      //   露出的边就像被"抽回去"。离当前卡最近的先收。
      others
        .map(c=>({c,r:c.getBoundingClientRect()}))
        .sort((a,b)=>a.r.top-b.r.top)
        .forEach(({c,r},i)=>{
          const x=reduce?0:Math.round(target.left-r.left), y=reduce?0:Math.round(target.top-r.top);
          // 错落只排前 4 层：更深的卡叠在同一位置（MAX_STACK_VISIBLE=4），再往后排只是白白拖长
          if(tuck(c,{opacity:0,scale:1,x,y},{duration:MS().base,delay:Math.min(i,3)*34},'other',i)) count++;
        });
    }

    // 2) 二级卡（工具列表就在这里）：朝当前卡缩
    const zones=doc.getElementById('zones');
    if(isShown(zones)){
      const r=visualRect(zones);
      if(r){
        const v=towards(r,target,cap);
        if(tuck(zones,{opacity:0,scale:reduce?1:.94,x:v.x,y:v.y},{duration:MS().base,delay:0},'other',0)) count++;
      }
    }

    // 3) 任务堆 / 报错堆 —— 用户点名要一起收
    for(const [id,delay,order] of [['tasks',50,1],['errors',80,2]]){
      const node=doc.getElementById(id);
      if(!isShown(node)) continue;
      if(id==='errors'&&blockingErrors(node)) continue;
      const r=visualRect(node);
      if(!r) continue;                                   // 空堆不动
      const v=towards(r,target,cap);
      if(tuck(node,{opacity:0,scale:reduce?1:.92,x:v.x,y:v.y},{duration:MS().base,delay},'other',order)) count++;
    }

    doc.body.dataset.v7twYield=String(count);
    trace('收拢 '+count+' 个元素'+(freeMode?'（自由模式）':'')+(reduce?' · 系统开了减速动画，只淡出不位移':''));
    return count;
  }

  /** ② 变身：当前卡在原位淡出，由同位置淡入的大卡接替。 */
  function morphCurrentOut(card){
    if(!card||!card.isConnected) return false;
    return tuck(card,{opacity:0,scale:1,x:0,y:0},{duration:MS().base,delay:60,easing:EASE_RELEASE},'current',0);
  }

  /** 收起：先还当前卡，再把其它元素从当前卡"放出来"。返回整段所需毫秒数。 */
  function restoreYield(options){
    const o=options||{};
    const recs=yieldRecs.splice(0);
    if(!recs.length) return 0;
    const reduce=reducedMotion();
    let longest=0;
    for(const rec of recs){
      const current=rec.role==='current';
      const delay=current?(o.currentDelay!=null?o.currentDelay:160):(o.othersDelay!=null?o.othersDelay:280)+Math.min(rec.order,8)*28;
      const duration=current?220:280;
      longest=Math.max(longest,delay+duration);
      const node=rec.node;
      try{
        // ⚠ 取消让位动画和起播复位动画必须在【同一个任务里】，中间不能让出一帧，
        //   否则元素会先闪回原样、再从隐藏态出来。fill:backwards 让它在 delay 期间保持隐藏态。
        rec.anim.cancel();
        const back=node.animate(
          [{opacity:rec.to.opacity, scale:String(rec.to.scale), translate:(reduce?0:rec.to.x)+'px '+(reduce?0:rec.to.y)+'px', offset:0}],
          {duration, delay, easing:EASE_RELEASE, fill:'backwards'});
        // 播完才恢复点击；期间若又被收拢（快速连点）就别动它的标记
        back.finished.catch(()=>{}).then(()=>{ if(!yieldRecs.some(r=>r.node===node)) node.classList.remove('v7tw-yielded'); });
      }catch(error){ motionIssue(error); node.classList.remove('v7tw-yielded'); }
    }
    trace('复位 '+recs.length+' 个元素');
    return longest;
  }

  root.V7ToolWorkbench = {
    configure, open, close,
    // 让位动画：由 ui.html 在开/关时调用
    yieldOut, restoreYield, morphCurrentOut, cancelYield,
    // 能不能开：主脚本注入过 open 才算接上。没接上时调用方退回旧路径，不静默。
    canOpen: () => !!(host && typeof host.open === 'function'),
    isOpen: () => !!(active && host.isOpen && typeof host.isOpen === 'function' && host.isOpen()),
    // 几何归属：开着的时候由本模块说了算，主脚本的 resizeWorkspace 要让路
    // （否则窗口一 resize 就会把 880×400 覆盖回工作面的默认尺寸）
    ownsGeometry: () => !!(active && host && host.ownsGeometry),
    keys: () => Object.keys(PANELS),
    has: key => !!PANELS[key],
    renderInto: (key, el, preset) => render(key, el, preset),
  };
})(window);
