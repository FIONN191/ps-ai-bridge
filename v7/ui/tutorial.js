/* ⭐ 2026-10-18 新手教程 · 总控（方案 docs/243，交接 docs/245；10-18 晚按用户试用意见第二版）。
 *
 * 管这几件事：
 *   ① 假 PS 的「脸」：画布（示例照片 + 贴回来的图层合成）、工具栏（只有矩形选框能框）、目标虚线框、蚂蚁线、
 *      图层面板、文档标签、双击缩略图后的缩放、「增效工具」菜单、可拖动 / 可停靠的桥接插件面板。
 *      「脑子」在 tutorial-fake-ps.js（文档 / 图层 / 选区 + 照插件格式回结果）。
 *   ② 跟 iframe 里的真界面说话（协议见 tutorial-host.js 文件头）：
 *      link.enqueue → 先回 requestId，插件连上了再像真插件一样稍后推 link:result（没连上就排着队，跟真的一样）；
 *      link.status → 插件面板开着才算「刚问过话」；ai.generate → 预制结果；
 *      ps-install / ps-inspect → 假的「用户账户控制」+ 记着装没装；viewer → 盖一层看大图。
 *   ③ 教程层：章节 / 步骤、高亮框（可以同时框几块、带名字）、假手（点 / 悬停 / 滚轮 / 右滑 / 拖）、气泡、
 *      演示锁（演示时学员动不了界面）、检查「做对了没」、记进度、跳过 / 选章节。
 *      章节内容在 tutorial-chapters.js（V7Tutorial.chapters），这里只管怎么播。
 *   ④ 出口：跳过按钮、Esc、真界面里点「退出」都走 exitTutorial（真软件里由外壳关窗口；托盘菜单也能关，见 planner.rs）。
 *
 * 用户定的播放规矩（10-18 晚）：
 *   · 演示时锁住：学员的鼠标键盘碰不到真界面和假 PS（遮罩 + 真界面里拦 isTrusted 事件）；演示自己发的是合成事件，照常生效。
 *   · 「看我做」和「轮到你了」在气泡上一眼分得开（颜色 + 标签 + 锁）。
 *   · 气泡永远不挡高亮的东西，也不挡右滑要经过的那片（step.swipe / step.avoid）。
 *
 * ⚠ 真界面跟这页同源（都是软件自己的文件），要读状态 / 点按钮直接用 iframe.contentWindow ——
 *   不要用 eval 传代码：软件的 CSP 没开 unsafe-eval，真软件里必挂。
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var $ = function (id) { return doc.getElementById(id); };
  var frame = $('app');
  var PROGRESS_KEY = 'wheelchair.v7.tutorial.progress.v1';
  var DOC_W = 1600, DOC_H = 2000;

  // ═══ 示例照片 ═══════════════════════════════════════════════
  // 素材（tutorial-assets/）到了就用素材；没到就画一张占位「照片」，教程照样能走通。
  var ASSETS = root.V7TutorialAssets || {};
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }
  function placeholderPhoto(w, h, title) {
    var c = doc.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#c9d6e8'); bg.addColorStop(1, '#8aa2c0');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // 简单的人像剪影：头 + 肩 + 衣服，方便框「脸」「衣服」
    g.fillStyle = '#e9c4a6'; g.beginPath(); g.ellipse(w * 0.5, h * 0.3, w * 0.15, h * 0.13, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a2a24'; g.beginPath(); g.ellipse(w * 0.5, h * 0.24, w * 0.17, h * 0.1, 0, Math.PI, Math.PI * 2); g.fill();
    g.fillStyle = '#d65a5a'; g.beginPath(); g.moveTo(w * 0.2, h); g.quadraticCurveTo(w * 0.22, h * 0.48, w * 0.5, h * 0.46); g.quadraticCurveTo(w * 0.78, h * 0.48, w * 0.8, h); g.fill();
    g.fillStyle = '#2b2b2b'; g.beginPath(); g.arc(w * 0.44, h * 0.3, w * 0.012, 0, Math.PI * 2); g.arc(w * 0.56, h * 0.3, w * 0.012, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)'; g.font = Math.round(w * 0.035) + 'px "Microsoft YaHei UI", sans-serif'; g.textAlign = 'center';
    g.fillText(title || '示例照片（教程素材到了会换成真照片）', w * 0.5, h * 0.95);
    return c.toDataURL('image/png');
  }

  // ═══ 假 PS ═══════════════════════════════════════════════════
  var canvas = $('psCanvas');
  var imageCache = {};
  function imgFor(src) {
    if (!src) return null;
    var hit = imageCache[src];
    if (hit) return hit.complete ? hit : null;
    var img = new Image(); img.onload = function () { scheduleDraw(); }; img.src = src; imageCache[src] = img;
    return null;
  }
  // 合成：从下往上画可见图层；贴回的图层画在它的选区里；带蒙版的按蒙版抠
  function composite(target, d, scale) {
    var g = target.getContext('2d');
    g.clearRect(0, 0, target.width, target.height);
    if (!d) return;
    function drawList(list) {
      for (var i = list.length - 1; i >= 0; i--) {
        var l = list[i];
        if (l.visible === false) continue;
        if (l.layers) { g.save(); g.globalAlpha *= (l.opacity == null ? 100 : l.opacity) / 100; drawList(l.layers); g.restore(); continue; }
        var src = l.image || (l.stampOf ? stampSource(d) : '');
        var img = imgFor(src); if (!img) continue;
        var r = l.rect || { left: 0, top: 0, width: d.width, height: d.height };
        g.save(); g.globalAlpha *= (l.opacity == null ? 100 : l.opacity) / 100;
        if (l.mask && l.mask !== 'mask') {
          var m = imgFor(l.mask);
          if (m) {
            var tmp = doc.createElement('canvas'); tmp.width = Math.max(1, Math.round(r.width * scale)); tmp.height = Math.max(1, Math.round(r.height * scale));
            var tg = tmp.getContext('2d');
            tg.drawImage(img, 0, 0, tmp.width, tmp.height);
            tg.globalCompositeOperation = 'destination-in';
            tg.drawImage(maskToAlpha(m), 0, 0, tmp.width, tmp.height);
            g.drawImage(tmp, r.left * scale, r.top * scale);
            g.restore(); continue;
          }
        }
        g.drawImage(img, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
        g.restore();
      }
    }
    drawList(d.layers);
  }
  // 盖印层（抠像结果）：用底图当内容
  function stampSource(d) { var bottom = d.layers[d.layers.length - 1]; return bottom && bottom.image || ''; }
  // 黑白蒙版 → 透明度（白 = 留，黑 = 去）
  var alphaCache = new WeakMap();
  function maskToAlpha(m) {
    if (alphaCache.has(m)) return alphaCache.get(m);
    var c = doc.createElement('canvas'); c.width = m.naturalWidth; c.height = m.naturalHeight;
    var g = c.getContext('2d'); g.drawImage(m, 0, 0);
    var data = g.getImageData(0, 0, c.width, c.height);
    for (var i = 0; i < data.data.length; i += 4) { data.data[i + 3] = data.data[i]; }
    g.putImageData(data, 0, 0); alphaCache.set(m, c);
    return c;
  }
  var drawPending = false;
  function scheduleDraw() {
    if (drawPending) return; drawPending = true;
    root.requestAnimationFrame(function () { drawPending = false; drawCanvas(); renderLayers(); renderTabs(); positionMarquee(); positionGuide(); });
  }
  function drawCanvas() {
    var d = ps.active();
    if (!d) return;
    if (canvas.width !== d.width / 2 || canvas.height !== d.height / 2) { canvas.width = d.width / 2; canvas.height = d.height / 2; }
    composite(canvas, d, 0.5);
  }
  function snapshot(d, sel, maxSide, mime) {
    var w = sel ? sel.width : d.width, h = sel ? sel.height : d.height;
    var s = Math.min(1, (maxSide || 4096) / Math.max(w, h));
    var full = doc.createElement('canvas'); full.width = Math.round(d.width * s); full.height = Math.round(d.height * s);
    composite(full, d, s);
    var out = doc.createElement('canvas'); out.width = Math.max(1, Math.round(w * s)); out.height = Math.max(1, Math.round(h * s));
    out.getContext('2d').drawImage(full, -(sel ? sel.left : 0) * s, -(sel ? sel.top : 0) * s);
    return out.toDataURL(mime || 'image/png').replace(/^data:[^,]+,/, '');
  }
  var ps = root.V7FakePS.create({
    crop: function (d, sel) { return snapshot(d, sel, 2048, 'image/png'); },
    thumb: function (d) { return snapshot(d, null, 512, 'image/jpeg'); }
  });
  var stats = {};           // 发生过什么（章节检查用）：a:<动作> / engine:<路径> / userSelect / drag / uacYes …
  var actionLog = [];       // 真界面发过来的动作（完整性检查用）
  var flashIds = {}, layerSig = {};
  function bump(k, n) { stats[k] = (stats[k] || 0) + (n == null ? 1 : n); }
  ps.onChange(function (kind, detail) {
    bump(kind);
    if (kind === 'layers' && detail) {
      // 图层一变就闪一下：让人看见「PS 跟着动了」（图层联动）
      (function walk(list) { list.forEach(function (l) { var key = l.id + ':' + l.visible + ':' + l.opacity + ':' + (l.layers ? l.layers.length : ''); if (layerSig[l.id] !== key) { if (layerSig[l.id] != null) flashIds[l.id] = Date.now(); layerSig[l.id] = key; } if (l.layers) walk(l.layers); }); })(detail.layers);
    }
    if (kind === 'view' && detail && detail.rect) zoomTo(detail.rect);
    scheduleDraw();
  });

  function renderLayers() {
    var d = ps.active(), box = $('psLayers');
    if (!d) { box.innerHTML = ''; return; }
    var html = [];
    (function walk(list, depth) {
      list.forEach(function (l) {
        var cls = 'ps-layer' + (l.layers ? ' group' : '') + (depth ? ' child' : '') + (l.visible === false ? ' hidden' : '') + (flashIds[l.id] && Date.now() - flashIds[l.id] < 700 ? ' flash' : '');
        var thumb = l.layers ? '' : '<span class="thumb" style="background-image:url(' + (l.image || (l.stampOf ? stampSource(d) : '')) + ')"></span>';
        var mask = l.mask ? '<span class="mask"' + (l.mask !== 'mask' ? ' style="background-image:url(' + l.mask + ')"' : '') + '></span>' : '';
        html.push('<div class="' + cls + '" data-layer-id="' + l.id + '"' + (l.layers ? ' data-group="1"' : '') + ' style="padding-left:' + (6 + depth * 16) + 'px"><span class="eye" data-eye="' + l.id + '">' + (l.visible === false ? '○' : '●') + '</span>' + thumb + mask + '<span class="name">' + esc(l.name) + (l.opacity != null && l.opacity < 100 ? ' <small>' + l.opacity + '%</small>' : '') + '</span></div>');
        if (l.layers && l.open !== false) walk(l.layers, depth + 1);
      });
    })(d.layers, 0);
    box.innerHTML = html.join('');
    if (Object.keys(flashIds).length) root.setTimeout(function () {
      var now = Date.now(), any = false;
      Object.keys(flashIds).forEach(function (k) { if (now - flashIds[k] >= 700) delete flashIds[k]; else any = true; });
      if (!any) renderLayers();
    }, 720);
  }
  // 眼睛：学员在假 PS 里自己点显示 / 隐藏
  $('psLayers').addEventListener('click', function (e) {
    var eye = e.target.closest('[data-eye]'); if (!eye) return;
    var l = ps.layerById(eye.dataset.eye); if (!l) return;
    bump('eyeClick');
    ps.run('ps.layer.visibility', { layerId: l.id, visible: l.visible === false });
  });
  var zoom = { scale: 1 };
  function renderTabs() {
    var box = $('psTabs');
    var pct = Math.round(50 * zoom.scale);
    box.innerHTML = ps.docs().map(function (d) { return '<span class="ps-tab' + (d === ps.active() ? ' active' : '') + '" data-doc="' + d.id + '">' + esc(d.name) + ' @ ' + pct + '%</span>'; }).join('');
  }
  $('psTabs').addEventListener('click', function (e) {
    var t = e.target.closest('[data-doc]'); if (!t) return;
    ps.run('ps.doc.select', { docId: Number(t.dataset.doc) }).then(function () { pushEvent({ type: 'status', connected: true, message: '切换文档' }); scheduleDraw(); });
  });
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ── 缩放：双击任务卡缩略图时 PS 跳到那张图并放大（真插件 focusRegion） ──
  function zoomTo(rect) {
    var d = ps.active(); if (!d) return;
    canvas.style.transform = '';
    var base = canvas.getBoundingClientRect(), wrap = $('psCanvasWrap').getBoundingClientRect();
    var k = base.width / d.width;                       // 文档像素 → 屏幕像素（没放大时）
    var s = Math.max(1, Math.min(4, Math.min(wrap.width * 0.8 / (rect.width * k), wrap.height * 0.8 / (rect.height * k))));
    var cx = (rect.left + rect.width / 2) * k, cy = (rect.top + rect.height / 2) * k;          // 画布内坐标
    var tx = (wrap.left + wrap.width / 2) - base.left - cx * s, ty = (wrap.top + wrap.height / 2) - base.top - cy * s;
    canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    zoom.scale = s; bump('zoom');
    root.setTimeout(function () { positionMarquee(); positionGuide(); }, 480);
    renderTabs();
  }
  function zoomFit() { canvas.style.transform = ''; zoom.scale = 1; renderTabs(); root.setTimeout(function () { positionMarquee(); positionGuide(); }, 480); }
  $('psFit').addEventListener('click', zoomFit);

  // ── 工具栏：只有矩形选框工具能框（其余只是摆设） ──
  var tool = 'move';
  var TOOL_INFO = { move: ['移动工具', '自动选择：图层'], marquee: ['矩形选框工具', '羽化：0 像素　样式：正常'] };
  function setTool(t) {
    tool = t;
    doc.querySelectorAll('[data-ps-tool]').forEach(function (el) { el.classList.toggle('active', el.dataset.psTool === t); });
    var info = TOOL_INFO[t] || [doc.querySelector('[data-ps-tool="' + t + '"]').title.replace(/（.*）/, ''), ''];
    $('psToolName').textContent = info[0]; $('psToolOpts').textContent = info[1];
    canvas.classList.toggle('marquee', t === 'marquee');
    hint(t === 'marquee' ? '在画布上按住拖动，框出一块区域' : '');
    if (t === 'marquee') bump('toolMarquee');
  }
  $('psTools').addEventListener('click', function (e) { var b = e.target.closest('[data-ps-tool]'); if (b) setTool(b.dataset.psTool); });
  function hint(text, warn) { var h = $('psHint'); h.textContent = text || ''; h.classList.toggle('warn', !!warn); }

  // ── 框选：选了矩形选框工具后，在画布上按住拖 ──
  var drag = null;
  function canvasToDoc(clientX, clientY) {
    var r = canvas.getBoundingClientRect(), d = ps.active();
    return { x: Math.max(0, Math.min(d.width, (clientX - r.left) / r.width * d.width)), y: Math.max(0, Math.min(d.height, (clientY - r.top) / r.height * d.height)) };
  }
  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !ps.active()) return;
    if (tool !== 'marquee') { hint('现在是「' + $('psToolName').textContent + '」—— 先点左边工具栏的「矩形选框工具」⬚', true); bump('wrongTool'); return; }
    drag = canvasToDoc(e.clientX, e.clientY);
    ps.setSelection(null);
    e.preventDefault();
  });
  root.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var p = canvasToDoc(e.clientX, e.clientY);
    ps.setSelection({ left: Math.min(drag.x, p.x), top: Math.min(drag.y, p.y), right: Math.max(drag.x, p.x), bottom: Math.max(drag.y, p.y) });
  });
  root.addEventListener('mouseup', function () {
    if (!drag) return; drag = null;
    if (ps.selection()) bump('userSelect');
  });
  function docRectToScreen(r) {
    var c = canvas.getBoundingClientRect(), wrap = $('psCanvasWrap').getBoundingClientRect(), d = ps.active();
    var k = c.width / d.width;
    return { left: c.left - wrap.left + r.left * k, top: c.top - wrap.top + r.top * k, width: r.width * k, height: r.height * k };
  }
  function positionMarquee() {
    var sel = ps.selection(), m = $('psMarquee');
    if (!sel || !ps.active()) { m.hidden = true; return; }
    var s = docRectToScreen(sel);
    m.hidden = false;
    m.style.left = s.left + 'px'; m.style.top = s.top + 'px'; m.style.width = s.width + 'px'; m.style.height = s.height + 'px';
  }
  ps.onChange(function (kind) { if (kind === 'selection') { positionMarquee(); positionGuide(); } });
  // ── 目标虚线框：「照着这个框选」（box 是 0~1 的 [x, y, w, h]） ──
  var guide = null;
  function boxToDoc(b) { var d = ps.active(); return { left: b[0] * d.width, top: b[1] * d.height, width: b[2] * d.width, height: b[3] * d.height }; }
  function iou(a, b) {
    var x1 = Math.max(a.left, b.left), y1 = Math.max(a.top, b.top), x2 = Math.min(a.left + a.width, b.left + b.width), y2 = Math.min(a.top + a.height, b.top + b.height);
    var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter || 1);
  }
  function selectionScore(b) { var s = ps.selection(); return s && ps.active() ? iou(s, boxToDoc(b)) : 0; }
  function positionGuide() {
    var g = $('psGuide');
    if (!guide || !ps.active()) { g.hidden = true; return; }
    var s = docRectToScreen(boxToDoc(guide.box));
    g.hidden = false;
    g.style.left = s.left + 'px'; g.style.top = s.top + 'px'; g.style.width = s.width + 'px'; g.style.height = s.height + 'px';
    $('psGuideLabel').textContent = guide.label || '照着这个框选';
    g.classList.toggle('ok', selectionScore(guide.box) >= (guide.min || 0.55));
  }

  // ═══ 桥接插件：装没装、面板开没开、放好了没有 ═══════════════════
  var plugin = { installed: false, open: false, placed: false, docked: false };
  function pluginConnected() { return plugin.installed && plugin.open; }
  function renderPlugin() {
    var p = $('psPlugin');
    p.hidden = !plugin.open;
    $('psPluginDot').classList.toggle('on', pluginConnected());
    $('psPluginStatus').textContent = pluginConnected() ? '已连上修图轮椅' : '正在连接修图轮椅…';
  }
  function renderPluginsMenu() {
    var m = $('psPluginsMenu');
    m.innerHTML = (plugin.installed
      ? '<div class="ps-dd-item" data-ps="open-plugin">修图轮椅 V7 连接 PS 插件工具</div>'
      : '<div class="ps-dd-item muted">（还没有修图轮椅的插件 —— 先在修图轮椅「设置 → Photoshop 联动」里安装）</div>')
      + '<div class="ps-dd-sep"></div><div class="ps-dd-item muted">浏览增效工具…</div><div class="ps-dd-item muted">管理增效工具…</div>';
  }
  function toggleMenu(open) {
    var m = $('psPluginsMenu'), btn = $('psPluginsMenuBtn');
    var show = open == null ? m.hidden : open;
    if (show) { renderPluginsMenu(); var r = btn.getBoundingClientRect(); m.style.left = r.left + 'px'; bump('menuOpen'); }
    m.hidden = !show; btn.classList.toggle('open', show);
  }
  $('psPluginsMenuBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
  $('psPluginsMenu').addEventListener('click', function (e) {
    var it = e.target.closest('[data-ps="open-plugin"]'); if (!it) return;
    toggleMenu(false); openPluginPanel();
  });
  doc.addEventListener('click', function (e) { if (!$('psPluginsMenu').hidden && !e.target.closest('#psPluginsMenu, #psPluginsMenuBtn')) toggleMenu(false); });
  function openPluginPanel() {
    var p = $('psPlugin');
    if (!plugin.open) {
      plugin.open = true; plugin.placed = false; plugin.docked = false;
      p.classList.remove('docked');
      if (p.parentNode !== $('ps')) $('ps').appendChild(p);
      var w = $('psCanvasWrap').getBoundingClientRect();
      p.style.left = (w.left + w.width * 0.35) + 'px'; p.style.top = (w.top + w.height * 0.3) + 'px';
      bump('pluginOpen');
    }
    renderPlugin();
    if (pluginConnected()) connectBridge();
  }
  // 拖插件面板：拖到右边面板区就停靠；拖到别处松手就浮在那里（都算「放好了」）
  (function () {
    var start = null;
    $('psPluginTitle').addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var p = $('psPlugin');
      if (plugin.docked) { plugin.docked = false; p.classList.remove('docked'); $('ps').appendChild(p); }
      var r = p.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY };
      p.style.left = r.left + 'px'; p.style.top = r.top + 'px';
      e.preventDefault();
    });
    root.addEventListener('mousemove', function (e) {
      if (!start) return;
      var p = $('psPlugin');
      p.style.left = (e.clientX - start.dx) + 'px'; p.style.top = (e.clientY - start.dy) + 'px';
      $('psDockHint').hidden = !overPanels(e.clientX, e.clientY);
    });
    root.addEventListener('mouseup', function (e) {
      if (!start) return;
      var moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
      start = null; $('psDockHint').hidden = true;
      if (moved < 10) return;
      placePlugin(overPanels(e.clientX, e.clientY));
    });
    function overPanels(x, y) { var r = $('psPanels').getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
  })();
  function placePlugin(dock) {
    var p = $('psPlugin');
    if (dock) { plugin.docked = true; p.classList.add('docked'); p.style.left = p.style.top = ''; $('psPanels').appendChild(p); }
    plugin.placed = true; bump('pluginPlaced');
  }

  // ═══ 跟真界面说话 ═══════════════════════════════════════════
  var app = null;              // iframe 里的 window（同源，可直接读）
  var appReadyResolve, appReady = new Promise(function (r) { appReadyResolve = r; });
  // 真界面准备好了（登录、假出图服务、示例预设都弄好），封面出来之前 resolve —— 自动走查等这个
  var preparedResolve, preparedReady = new Promise(function (r) { preparedResolve = r; });
  var linkSeq = 0, readyAt = '', blockedUrls = [], backendMiss = [], waitingLink = [];
  function reply(id, payload) { if (app) app.postMessage({ v7tutorialReply: 1, id: id, payload: payload }, '*'); }
  function push(kind, payload) { if (app) app.postMessage({ v7tutorialReply: 1, push: kind, payload: payload }, '*'); }
  function pushEvent(ev) { push('link:event', Object.assign({ at: new Date().toISOString() }, ev)); }
  // 插件连上了：跟真插件一样报一声 ready，把排着队的命令一起执行
  function connectBridge() {
    if (!pluginConnected()) return;
    if (!readyAt) { readyAt = new Date().toISOString(); pushEvent({ type: 'ready', clientId: 'tutorial', bridgeVersion: '教程', actions: [] }); bump('bridgeReady'); }
    var q = waitingLink.splice(0); q.forEach(function (fn) { fn(); });
  }
  function runLink(requestId, action, params) {
    var started = new Date().toISOString();
    // 真插件是轮询拿命令，回结果有一点点延迟；太快了界面上的「执行中」根本看不见
    root.setTimeout(function () {
      ps.run(action, params).then(function (data) {
        push('link:result', { requestId: requestId, action: action, success: true, data: data, startedAt: started, finishedAt: new Date().toISOString() });
      }, function (err) {
        push('link:result', { requestId: requestId, action: action, success: false, error: { code: err.code || 'TUTORIAL_PS_ERROR', message: err.message || String(err) }, startedAt: started, finishedAt: new Date().toISOString() });
      });
    }, 160);
  }
  var uacWaiting = null;
  root.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.v7tutorial || e.source !== frame.contentWindow) return;
    app = frame.contentWindow;
    switch (d.kind) {
      case 'hello':
        appReadyResolve(app);
        if (pluginConnected()) { readyAt = ''; connectBridge(); }
        break;
      case 'link:status': {
        var on = pluginConnected();
        reply(d.id, { ok: true, port: 0, queued: waitingLink.length, sessionId: 'tutorial',
          bridge: on ? { connected: true, clientId: 'tutorial', bridgeVersion: '教程', lastPollAt: new Date().toISOString(), lastReadyAt: readyAt, lastEventAt: readyAt } : { connected: false } });
        break;
      }
      case 'link:enqueue': {
        var action = d.payload && d.payload.action, params = (d.payload && d.payload.params) || {};
        var requestId = 'tut-link-' + Date.now() + '-' + (++linkSeq);
        reply(d.id, { ok: true, requestId: requestId, command: { requestId: requestId, action: action, params: params } });
        actionLog.push(action); bump('a:' + action);
        // 插件还没连上：跟真的一样排着队，连上再执行
        if (pluginConnected()) runLink(requestId, action, params);
        else waitingLink.push(function () { runLink(requestId, action, params); });
        break;
      }
      case 'ai:generate':
        fakeGenerate(d.payload || {}).then(function (r) { reply(d.id, r); });
        break;
      case 'ps-inspect':
        reply(d.id, { installed: plugin.installed });
        break;
      case 'ps-install':
        // 装插件要管理员权限：弹假的「用户账户控制」，学员点「是」才算装好
        bump('installClick');
        $('tutUac').hidden = false;
        uacWaiting = function (yes) {
          $('tutUac').hidden = true; uacWaiting = null;
          if (yes) { plugin.installed = true; bump('uacYes'); renderPluginsMenu(); renderPlugin(); connectBridge(); }
          reply(d.id, { ok: !!yes });
        };
        break;
      case 'viewer':
        $('tutViewerImg').src = d.payload && d.payload.url || '';
        $('tutViewerNum').textContent = d.payload && d.payload.total ? (d.payload.num + ' / ' + d.payload.total) : '';
        $('tutViewer').hidden = false; bump('viewer');
        break;
      case 'viewer-close':
        $('tutViewer').hidden = true;
        break;
      case 'blocked':
        blockedUrls.push(d.url || (d.payload && d.payload.url) || '');
        console.warn('[教程] 拦下一个对外请求：', d.url);
        break;
      case 'shortcut':
        bump('key:' + (d.payload && d.payload.which));
        break;
      case 'drag':
        appOffset.x += Number(d.payload && d.payload.dx) || 0; appOffset.y += Number(d.payload && d.payload.dy) || 0;
        bump('dragMoved', Math.abs(Number(d.payload && d.payload.dx) || 0) + Math.abs(Number(d.payload && d.payload.dy) || 0));
        applyFrameTransform();
        break;
      case 'drag-end':
        bump('drag');
        break;
      case 'backend-miss':
        backendMiss.push((d.payload && d.payload.method) + ' ' + (d.payload && d.payload.path));
        break;
      case 'engine':
        bump('engine:' + (d.payload && d.payload.path));
        break;
      case 'quit':
        askSkip();
        break;
    }
  });
  $('tutUacYes').addEventListener('click', function () { if (uacWaiting) uacWaiting(true); });
  $('tutUacNo').addEventListener('click', function () { if (uacWaiting) uacWaiting(false); });
  // 看大图：点空白 / Esc 关，← → 换张（跟真窗口一样告诉真界面）
  function closeViewer() { if ($('tutViewer').hidden) return; $('tutViewer').hidden = true; if (app && app.__V7_TUTORIAL_VIEWER_CLOSED__) app.__V7_TUTORIAL_VIEWER_CLOSED__(); bump('viewerClosed'); }
  $('tutViewer').addEventListener('click', function (e) { if (e.target === $('tutViewerImg')) return; closeViewer(); });

  // ── 预制结果 ──
  // 有素材：按预设 / 章节挑（V7TutorialAssets.results[presetId] 或 .default）；没有：把抓到的图上个色、打水印
  var TINTS = ['rgba(255,170,60,.35)', 'rgba(80,170,255,.35)', 'rgba(160,90,255,.35)', 'rgba(60,200,120,.35)'];
  function tintImage(b64, i, label) {
    return loadImage('data:image/png;base64,' + b64).then(function (img) {
      var w = img ? img.naturalWidth : 512, h = img ? img.naturalHeight : 512;
      var c = doc.createElement('canvas'); c.width = w; c.height = h;
      var g = c.getContext('2d');
      if (img) g.drawImage(img, 0, 0); else { g.fillStyle = '#888'; g.fillRect(0, 0, w, h); }
      g.globalCompositeOperation = 'color'; g.fillStyle = TINTS[i % TINTS.length].replace('.35', '1'); g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over'; g.fillStyle = TINTS[i % TINTS.length]; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.9)'; g.font = 'bold ' + Math.max(14, Math.round(w / 14)) + 'px "Microsoft YaHei UI", sans-serif';
      g.textAlign = 'center'; g.fillText(label || ('示例结果 ' + (i + 1)), w / 2, h - Math.max(10, h / 14));
      return c.toDataURL('image/png').replace(/^data:[^,]+,/, '');
    });
  }
  function fakeResults(payload) {
    var n = Math.max(1, Math.min(8, Number(payload.batch) || 1));
    var src = String(payload.inputImageBase64 || payload.sourceImageBase64 || snapshot(ps.active(), ps.selection(), 1024)).replace(/^data:[^,]+,/, '');
    var pre = ASSETS.results && (ASSETS.results[payload.presetId] || ASSETS.results.default);
    var jobs = [];
    for (var i = 0; i < n; i++) jobs.push(pre && pre[i % pre.length] ? fetchB64(pre[i % pre.length]) : tintImage(src, i));
    return Promise.all(jobs).then(function (list) { return list.map(function (b64, i) { return { index: i, imageBase64: b64, mime: 'image/png' }; }); });
  }
  function fetchB64(url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      return new Promise(function (resolve) { var fr = new FileReader(); fr.onload = function () { resolve(String(fr.result).replace(/^data:[^,]+,/, '')); }; fr.readAsDataURL(blob); });
    });
  }
  function fakeGenerate(payload) {
    bump('generate');
    // 假装算一会儿（太快看不出任务卡的进度）
    return new Promise(function (r) { root.setTimeout(r, 1600); }).then(function () { return fakeResults(payload); }).then(function (results) { return { results: results }; });
  }

  // ═══ 真界面的大小：照主窗口 1020×1100，窗口矮就等比缩；自由模式铺满（真软件自由模式是全屏透明窗口） ═══
  var APP_W = 1020, APP_H = 1100, appScale = 1, appOffset = { x: 0, y: 0 }, freeLayout = false;
  function applyFrameTransform() { frame.style.transform = freeLayout ? '' : 'translate(' + appOffset.x + 'px,' + appOffset.y + 'px) scale(' + appScale + ')'; }
  function layout() {
    var avail = root.innerHeight - 64 - 8;
    appScale = Math.min(1, avail / APP_H, (root.innerWidth - 290 - 300) / APP_W);
    appScale = Math.max(0.45, appScale);
    applyFrameTransform();
    // 照片放在真界面左边的空位里（真界面的卡堆在 iframe 里左边 60px 起；二级卡往右展开，右边要留着）
    var wrap = $('psCanvasWrap').getBoundingClientRect(), f = frame.getBoundingClientRect();
    var room = freeLayout ? wrap.width * 0.45 : Math.max(240, f.left + 50 * appScale - wrap.left - 40);
    canvas.style.maxWidth = room + 'px';
    canvas.style.maxHeight = Math.max(240, wrap.height - 40) + 'px';
    $('psCanvasWrap').style.justifyItems = 'start';
    $('psCanvasWrap').style.paddingLeft = '20px';
    scheduleDraw();
    if (current) placeStep();
  }
  root.addEventListener('resize', layout);
  function scaleNow() { return freeLayout ? 1 : appScale; }
  // 自由模式开 / 关：iframe 跟着铺满 / 缩回
  root.setInterval(function () {
    var on = false;
    try { on = !!(app && app.V7FreeMode && app.V7FreeMode.isActive()); } catch (_) {}
    if (on !== freeLayout) { freeLayout = on; frame.classList.toggle('free', on); layout(); }
  }, 300);

  // ═══ 教程层 ═══════════════════════════════════════════════════
  var chapters = (root.V7Tutorial && root.V7Tutorial.chapters) || [];
  var current = null;       // { ch, chIndex, stepIndex, step }
  var checkTimer = 0, helpTimer = 0, runToken = 0;

  function loadProgress() { try { return JSON.parse(root.localStorage.getItem(PROGRESS_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function saveProgress(p) { try { root.localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (_) {} }
  function markDone(ch) { var p = loadProgress(); p.done = p.done || {}; p.done[ch.id] = ch.version || 1; p.at = Date.now(); saveProgress(p); }
  function chapterDone(ch) { var p = loadProgress(); return !!(p.done && p.done[ch.id] >= (ch.version || 1)); }
  // 还没看完（跟主窗口 tutorial-launcher.js 的 pending 一个口径）。⭐ 10-18 深夜用户定：跳过不算看过，下次启动照样弹
  function chapterPending(ch) { var p = loadProgress(), v = ch.version || 1; return !(p.done && p.done[ch.id] >= v); }

  // ── 找东西的位置 ──
  //   {app:'css'} 真界面里 / {ps:'css'} 假 PS 里 / function(api) 返回元素，或 {appRect:{left,top,width,height}}（真界面坐标的一块区域）
  //   / {canvasBox:[x,y,w,h]}（照片上 0~1 的一块）。label：高亮框上的名字。
  function findEl(target) {
    if (!target) return null;
    if (typeof target === 'function') { try { return target(api); } catch (_) { return null; } }
    if (target.app) return app && app.document.querySelector(target.app);
    if (target.ps) return doc.querySelector(target.ps);
    return null;
  }
  function appRectToScreen(r) {
    var f = frame.getBoundingClientRect(), s = scaleNow();
    return { left: f.left + r.left * s, top: f.top + r.top * s, width: r.width * s, height: r.height * s };
  }
  // 真的看得见吗：连外层一起查（二级卡收起来时里面的按钮还在原位置，只是外层透明 / 藏了 ——
  //   只看元素自己会把高亮框画在空地方，10-18 晚用户报「安装桥接定位错误」就是这个）
  function deepVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var W = el.ownerDocument.defaultView;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var st = W.getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    }
    return true;
  }
  function rectOf(target) {
    if (!target) return null;
    if (target.canvasBox && ps.active()) {
      var c = canvas.getBoundingClientRect(), b = target.canvasBox;
      return { left: c.left + b[0] * c.width, top: c.top + b[1] * c.height, width: b[2] * c.width, height: b[3] * c.height };
    }
    var el = findEl(target);
    if (!el) return null;
    if (el.appRect) return appRectToScreen(el.appRect);
    if (el.left != null && el.width != null && !el.getBoundingClientRect) return el;
    if (!el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    if (el.ownerDocument !== doc && !deepVisible(el)) return null;
    if (el.ownerDocument === doc) return { left: r.left, top: r.top, width: r.width, height: r.height };
    // 真界面里的元素：换算到教程页坐标（iframe 被缩放过）
    return appRectToScreen(r);
  }
  function targetList(t) { return !t ? [] : Array.isArray(t) ? t : [t]; }
  // 高亮：第一块用带暗化的主框，其余的是额外的框（不再叠暗化）；有 label 就在框上写名字
  function showRings(targets) {
    var list = targetList(targets).map(function (t) { var r = rectOf(t); return r ? { r: r, label: t && t.label } : null; }).filter(Boolean);
    var main = $('tutRing'), box = $('tutRings');
    if (!list.length) { main.hidden = true; box.innerHTML = ''; $('tutDim').hidden = !current || !current.step || current.step.dim === false; return []; }
    $('tutDim').hidden = true;
    var pad = 6;
    function put(el, it) {
      el.hidden = false;
      el.style.left = (it.r.left - pad) + 'px'; el.style.top = (it.r.top - pad) + 'px';
      el.style.width = (it.r.width + pad * 2) + 'px'; el.style.height = (it.r.height + pad * 2) + 'px';
      el.innerHTML = it.label ? '<span class="tut-ring-label">' + esc(it.label) + '</span>' : '';
    }
    put(main, list[0]);
    while (box.children.length < list.length - 1) { var x = doc.createElement('div'); x.className = 'tut-ring extra'; box.appendChild(x); }
    while (box.children.length > list.length - 1) box.removeChild(box.lastChild);
    list.slice(1).forEach(function (it, i) { put(box.children[i], it); });
    return list.map(function (it) { return it.r; });
  }
  // 气泡放哪：不能盖住任何一个高亮框，也不能盖住要躲开的区域（右滑经过的那片等）
  function placeBubble(rects, avoid) {
    var b = $('tutBubble'), bw = b.offsetWidth || 360, bh = b.offsetHeight || 170, vw = root.innerWidth, vh = root.innerHeight, gap = 18;
    var blocks = rects.concat(avoid || []);
    var u = rects.length ? rects.reduce(function (a, r) { return { left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.left + r.width), bottom: Math.max(a.bottom, r.top + r.height) }; }, { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 }) : null;
    var cands = [];
    if (u) {
      var cy = (u.top + u.bottom) / 2 - bh / 2, cx = (u.left + u.right) / 2 - bw / 2;
      cands.push([u.left - bw - gap, cy], [u.right + gap, cy], [cx, u.bottom + gap], [cx, u.top - bh - gap],
        [u.left - bw - gap, u.top], [u.left - bw - gap, u.bottom - bh], [u.right + gap, u.top], [u.right + gap, u.bottom - bh]);
    }
    cands.push([vw * 0.04, vh * 0.12], [vw * 0.04, vh - bh - 30], [vw - bw - 300, vh - bh - 30], [(vw - bw) / 2, vh * 0.3]);
    function clamp(p) { return [Math.max(8, Math.min(vw - bw - 8, p[0])), Math.max(36, Math.min(vh - bh - 8, p[1]))]; }
    function overlap(p) {
      var a = 0;
      blocks.forEach(function (r) {
        var w = Math.min(p[0] + bw, r.left + r.width + 8) - Math.max(p[0], r.left - 8), h = Math.min(p[1] + bh, r.top + r.height + 8) - Math.max(p[1], r.top - 8);
        if (w > 0 && h > 0) a += w * h;
      });
      return a;
    }
    var best = null, bestA = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var p = clamp(cands[i]), a = overlap(p);
      if (a === 0) { best = p; break; }
      if (a < bestA) { bestA = a; best = p; }
    }
    b.style.left = best[0] + 'px'; b.style.top = best[1] + 'px';
  }
  function avoidRects(step, rects) {
    var out = [];
    // 要往右滑的步骤：把目标右边那一大片空出来（右滑要经过、二级 / 缩略图要从那里出来）
    if (step.swipe && rects[0]) { var r = rects[0]; out.push({ left: r.left, top: r.top - 30, width: r.width + 520, height: r.height + 60 }); }
    if (typeof step.avoid === 'function') { try { targetList(step.avoid(api)).forEach(function (t) { var r = rectOf(t); if (r) out.push(r); }); } catch (_) {} }
    return out;
  }
  // step.needs = { test(api) 现在能不能做这一步（比如设置卡的二级开着没有）, how 收起来时跟学员说的话,
  //                target 收起来时改指哪里, fix(api) 帮它重新打开 }
  //   · 演示 / 说明（学员动不了）：收起来了就自己 fix 一下；
  //   · 轮到你了：高亮改指 target，任务栏提示 how；学员自己打开了就指回原目标。
  var needsFixAt = 0;
  function placeStep() {
    if (!current || !current.step) return;
    var step = current.step, target = step.target, needs = step.needs;
    if (needs && typeof needs.test === 'function') {
      var ok = false; try { ok = !!needs.test(api); } catch (_) {}
      if (!ok) {
        if (step.kind !== 'try' || current.helping) { if (Date.now() - needsFixAt > 1500 && typeof needs.fix === 'function') { needsFixAt = Date.now(); try { needs.fix(api); } catch (_) {} } }
        else { target = needs.target || target; if (!current.needsNoted) { current.needsNoted = true; api.note(needs.how); } }
      } else if (current.needsNoted) { current.needsNoted = false; api.note(''); }
    }
    var rects = showRings(target);
    placeBubble(rects, avoidRects(step, rects));
  }
  // 目标会动（卡片展开、列表滚动）：一直跟着
  root.setInterval(function () { if (current && !$('tutBubble').hidden) placeStep(); }, 250);

  // ── 演示锁：演示时学员动不了真界面和假 PS ──
  function setLock(on) {
    $('tutLock').hidden = !on;
    try { if (app) app.__V7_TUTORIAL_LOCKED__ = !!on; } catch (_) {}
  }

  // ── 假手 ──
  var hand = $('tutHand');
  function handAt(x, y, fast) { hand.hidden = false; hand.classList.toggle('fast', !!fast); hand.style.left = (x - 8) + 'px'; hand.style.top = (y - 4) + 'px'; }
  function moveHand(target, opts) {
    var r = target && (target.left != null && target.width != null ? target : rectOf(target));
    if (!r) { hand.hidden = true; return Promise.resolve(false); }
    handAt(r.left + r.width / 2, r.top + r.height / 2);
    return sleep((opts && opts.ms) || 650).then(function () { return true; });
  }
  function tapHand() {
    hand.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)' }, { transform: 'scale(1)' }], { duration: (window.V7Motion ? window.V7Motion.MS.base : 200) });
    return sleep(280);
  }
  function sleep(ms) { return new Promise(function (r) { root.setTimeout(r, ms); }); }
  // 屏幕坐标 → 真界面里的坐标
  function screenToApp(x, y) { var f = frame.getBoundingClientRect(), s = scaleNow(); return { x: (x - f.left) / s, y: (y - f.top) / s }; }
  function appEvent(type, x, y, extra) {
    if (!app) return;
    var p = screenToApp(x, y), W = app;
    var el = W.document.elementFromPoint(p.x, p.y) || W.document.body;
    var o = Object.assign({ bubbles: true, cancelable: true, view: W, clientX: p.x, clientY: p.y, screenX: x, screenY: y, button: 0 }, extra || {});
    var Ctor = /^pointer/.test(type) ? (W.PointerEvent || W.MouseEvent) : /^wheel/.test(type) ? W.WheelEvent : W.MouseEvent;
    if (/^pointer/.test(type)) o = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o);
    el.dispatchEvent(new Ctor(type, o));
    return el;
  }
  function fireClick(el) {
    var W = el.ownerDocument.defaultView, o = { bubbles: true, cancelable: true, view: W, button: 0 };
    // ⚠ 只发鼠标事件 + click，不发合成的 pointerdown：真界面有的地方（预设列表拖排序）会对它 setPointerCapture，
    //   合成的指针没有「活着的 pointerId」，直接抛 NotFoundError（10-18 走查实测）
    ['mousedown', 'mouseup'].forEach(function (t) { el.dispatchEvent(new W.MouseEvent(t, o)); });
    el.click();
  }

  // ── 给章节用的工具箱 ──
  var api = {
    get app() { return app; },
    get doc() { return app && app.document; },
    ps: ps,
    stats: stats,
    plugin: plugin,
    // 真界面此刻的状态（ui.html 的 __V7_TUTORIAL_PEEK__：当前卡、收没收起、任务列表、设置…）
    peek: function () { try { return (app && app.__V7_TUTORIAL_PEEK__ && app.__V7_TUTORIAL_PEEK__()) || {}; } catch (_) { return {}; } },
    // 生成任务（最新的在前）
    tasks: function () { return (api.peek().tasks || []).slice(); },
    navigate: function (card, zone, options) { try { return Promise.resolve(app.navigateCard(card, zone || 0, options)).catch(function () {}); } catch (_) { return Promise.resolve(); } },
    settings: function () { return api.peek().settings || {}; },
    saveSettings: function (patch) { var s = app.__V7_QWEN_SETTINGS__(); Object.assign(s, patch || {}); app.__V7_QWEN_SAVE__(); },
    actionLog: actionLog,
    sleep: sleep,
    q: function (sel) { return app && app.document.querySelector(sel); },
    qa: function (sel) { return app ? Array.prototype.slice.call(app.document.querySelectorAll(sel)) : []; },
    visible: function (sel) {
      var el = typeof sel === 'string' ? api.q(sel) : sel;
      return deepVisible(el);
    },
    rect: rectOf,
    // 照片上的一块（文档像素）→ 屏幕位置（高亮「贴回到哪了」用）
    docToScreen: function (r) { var w = $('psCanvasWrap').getBoundingClientRect(), s = docRectToScreen(r); return { left: w.left + s.left, top: w.top + s.top, width: s.width, height: s.height }; },
    // 在真界面里按屏幕坐标点一下（剪影上点某个部位：那是一整张图，靠点的位置判断部位）
    clickAt: function (x, y) {
      handAt(x, y);
      return sleep(600).then(tapHand).then(function () { appEvent('mousemove', x, y); appEvent('mousedown', x, y); appEvent('mouseup', x, y); appEvent('click', x, y); return true; });
    },
    // 在真界面里拖（自由模式拖卡片：在小横线上按下 → 移动 → 松开）
    dragApp: function (from, to) {
      handAt(from.x, from.y);
      return sleep(500).then(function () {
        appEvent('mousedown', from.x, from.y);
        var i = 0, n = 20;
        return new Promise(function (resolve) {
          (function step() {
            i++;
            var x = from.x + (to.x - from.x) * i / n, y = from.y + (to.y - from.y) * i / n;
            handAt(x, y, true); appEvent('mousemove', x, y);
            if (i < n) return root.setTimeout(step, 30);
            appEvent('mouseup', x, y); hand.classList.remove('fast'); resolve(true);
          })();
        });
      });
    },
    appToScreen: function (r) { return appRectToScreen(r); },
    // 演示用：假手移过去点一下（真点：触发真界面 / 假 PS 自己的点击逻辑）
    click: function (target) {
      return moveHand(target).then(function () {
        // ⚠ 找不到位置（藏起来的勾选框宽高是 0）也照样点：不然「帮我做一下」静默什么都没做（10-18 走查实测）
        if (!findEl(target)) return false;
        return tapHand().then(function () { var el = findEl(target); if (el && el.click) fireClick(el); return true; });
      });
    },
    dblclick: function (target) {
      return moveHand(target).then(function () {
        var el = findEl(target); if (!el) return false;
        return tapHand().then(function () { return tapHand(); }).then(function () {
          var W = el.ownerDocument.defaultView;
          el.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: W, button: 0 }));
          return true;
        });
      });
    },
    hover: function (target) {
      return moveHand(target).then(function (ok) {
        var el = ok && findEl(target);
        if (el && el.dispatchEvent) {
          var W = el.ownerDocument.defaultView, r = rectOf(target), o = { bubbles: true, view: W };
          ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'].forEach(function (t) { el.dispatchEvent(new W.MouseEvent(t, o)); });
          if (r && el.ownerDocument !== doc) appEvent('mousemove', r.left + r.width / 2, r.top + r.height / 2);
          else el.dispatchEvent(new W.MouseEvent('mousemove', o));
        }
        return !!el;
      });
    },
    // 右滑：从目标中间慢慢往右移出右边缘（跟真界面的右滑判定一样：每帧往右几像素、不能太快）
    swipe: function (target, opts) {
      var r = rectOf(target);
      if (!r) return Promise.resolve(false);
      var x0 = r.left + r.width * 0.5, x1 = r.left + r.width + ((opts && opts.beyond) || 60), y = r.top + Math.min(r.height * 0.45, 140);
      handAt(x0, y);
      return sleep(500).then(function () {
        return new Promise(function (resolve) {
          var x = x0;
          (function step() {
            x = Math.min(x1, x + 6);
            handAt(x, y, true);
            appEvent('pointermove', x, y); appEvent('mousemove', x, y);
            if (x < x1) root.setTimeout(step, 16); else { hand.classList.remove('fast'); resolve(true); }
          })();
        });
      });
    },
    // 鼠标从真界面上移开（让二级 / 预览自己收起来）
    leave: function () { var f = frame.getBoundingClientRect(); appEvent('mousemove', f.left + 2, f.bottom - 4); appEvent('mousemove', f.left + 1, f.bottom - 2); },
    wheel: function (target, dy, times, gap) {
      return moveHand(target).then(function (ok) {
        var el = ok && findEl(target); if (!el) return false;
        var r = el.getBoundingClientRect(), W = el.ownerDocument.defaultView;
        var seq = Promise.resolve();
        for (var i = 0; i < (times || 1); i++) seq = seq.then(function () {
          el.dispatchEvent(new W.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: W }));
          return sleep(gap || 140);
        });
        return seq.then(function () { return true; });
      });
    },
    // 拖：从 a 拖到 b（屏幕坐标），全程发真界面能收到的鼠标事件（用于拖面板）
    dragScreen: function (from, to, el) {
      handAt(from.x, from.y);
      return sleep(450).then(function () {
        var t = el || doc.elementFromPoint(from.x, from.y);
        t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: from.x, clientY: from.y, button: 0 }));
        var i = 0, n = 18;
        return new Promise(function (resolve) {
          (function step() {
            i++;
            var x = from.x + (to.x - from.x) * i / n, y = from.y + (to.y - from.y) * i / n;
            handAt(x, y, true);
            root.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
            if (i < n) return root.setTimeout(step, 30);
            root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            hand.classList.remove('fast'); resolve(true);
          })();
        });
      });
    },
    hide: function () { hand.hidden = true; },
    // 假 PS：选工具、引导框、框选
    setTool: function (t) { return api.click({ ps: '[data-ps-tool="' + t + '"]' }); },
    tool: function () { return tool; },
    guide: function (box, label, min) { guide = box ? { box: box, label: label, min: min } : null; positionGuide(); },
    selectionScore: selectionScore,
    zoom: function () { return zoom.scale; },
    zoomFit: zoomFit,
    // 演示用：假手在假 PS 画布上拖一个框（照片 0~1 坐标）
    marquee: function (fx, fy, fw, fh) {
      var d = ps.active(), r = canvas.getBoundingClientRect();
      var a = { left: r.left + fx * r.width, top: r.top + fy * r.height, width: 0, height: 0 };
      return moveHand(a).then(function () {
        var steps = 14, i = 0;
        return new Promise(function (resolve) {
          (function tick() {
            i++;
            var t = i / steps;
            ps.setSelection({ left: fx * d.width, top: fy * d.height, right: (fx + fw * t) * d.width, bottom: (fy + fh * t) * d.height });
            handAt(a.left + fw * t * r.width, a.top + fh * t * r.height, true);
            if (i < steps) root.setTimeout(tick, 45); else { hand.classList.remove('fast'); resolve(true); }
          })();
        });
      });
    },
    // 学员没设快捷键也能演示：直接触发那个动作（气泡里会写明「真用时按你设的快捷键」）
    shortcut: function (which) {
      var keys = (app && app.__V7_TUTORIAL_PEEK__ && api.settings()) || {};
      var spec = which === 'generation' ? keys.generationShortcut : which === 'reference' ? keys.referenceShortcut : keys.collapseShortcut;
      showKeycap(spec ? formatKey(spec) : '（快捷键）');
      return sleep(500).then(function () { bump('key:' + which); if (app && app.__V7_TUTORIAL_SHORTCUT__) app.__V7_TUTORIAL_SHORTCUT__(which); return sleep(300); });
    },
    // 等到条件成立（演示里用：等任务跑完再往下）
    until: function (fn, ms) {
      var t0 = Date.now();
      return new Promise(function (resolve) {
        (function poll() {
          var ok = false; try { ok = !!fn(api); } catch (_) {}
          if (ok || Date.now() - t0 > (ms || 15000)) resolve(ok); else root.setTimeout(poll, 200);
        })();
      });
    },
    // 插件：章节从中间开始时，直接当作已经装好、连上（不用每章都重新装一遍）
    ensureConnected: function () {
      if (!plugin.installed) { plugin.installed = true; renderPluginsMenu(); }
      if (!plugin.open) { plugin.open = true; plugin.placed = true; placePlugin(true); plugin.placed = true; }
      renderPlugin(); connectBridge();
    },
    pluginConnected: pluginConnected,
    openMenu: function () { return api.click({ ps: '#psPluginsMenuBtn' }); },
    placePlugin: placePlugin,
    uacOpen: function () { return !$('tutUac').hidden; },
    viewerOpen: function () { return !$('tutViewer').hidden; },
    closeViewer: closeViewer,
    flashMenu: function (on) { $('psPluginsMenuBtn').classList.toggle('hot', on !== false); },
    // 动手步骤里给一句提醒（框得不准之类）；空 = 恢复成任务原文
    note: function (text) {
      var task = $('tutTask'); if (!current || !current.step || task.classList.contains('done')) return;
      task.className = 'tut-task' + (text ? ' note' : '');
      task.textContent = text ? '注意：' + text : (current.step.task || '');
    },
    // 演示前把场景摆好：新开一份示例文档
    newDoc: function (name, image) { return ensurePhoto().then(function (src) { ps.addDoc({ name: name || '示例照片.psd', width: DOC_W, height: DOC_H, image: image || src }); scheduleDraw(); if (pluginConnected()) pushEvent({ type: 'status', connected: true, message: '文档已打开' }); }); },
    // 章节开始时记一下计数，检查「这一步里做过没有」用差值
    mark: function () { var m = {}; Object.keys(stats).forEach(function (k) { m[k] = stats[k]; }); return m; },
    since: function (mark, key) { return (stats[key] || 0) - (mark[key] || 0); }
  };
  function formatKey(spec) {
    var names = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', space: 'Space' };
    return String(spec).split('+').filter(Boolean).map(function (k) { return names[k] || k.toUpperCase(); }).join(' + ');
  }
  function showKeycap(text) {
    var k = $('tutKeycap'); k.textContent = text; k.hidden = false;
    k.animate([{ opacity: 0, transform: 'translate(-50%, 10px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: (window.V7Motion ? window.V7Motion.MS.base : 200) });
    root.clearTimeout(showKeycap.t); showKeycap.t = root.setTimeout(function () { k.hidden = true; }, 1400);
  }

  var photoSrc = '';
  function ensurePhoto() {
    if (photoSrc) return Promise.resolve(photoSrc);
    var want = ASSETS.photo;
    return loadImage(want).then(function (img) {
      if (img) {
        var c = doc.createElement('canvas'); c.width = DOC_W; c.height = DOC_H;
        var g = c.getContext('2d'), s = Math.max(DOC_W / img.naturalWidth, DOC_H / img.naturalHeight);
        g.drawImage(img, (DOC_W - img.naturalWidth * s) / 2, (DOC_H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
        photoSrc = c.toDataURL('image/jpeg', 0.92);
      } else photoSrc = placeholderPhoto(DOC_W, DOC_H);
      return photoSrc;
    });
  }

  // ── 播一步 ──
  var MODE_TEXT = { demo: '看我做 · 先别动', try: '轮到你了', tell: '说明' };
  function startChapter(index, stepIndex) {
    var ch = chapters[index];
    if (!ch) return finishAll();
    current = { ch: ch, chIndex: index, stepIndex: stepIndex || 0, step: null, mark: api.mark() };
    var p = loadProgress(); p.current = { ch: ch.id, step: current.stepIndex }; saveProgress(p);
    $('tutCover').hidden = true;
    setLock(true);
    guide = null; positionGuide();
    // 第 1 章之后的章节都要插件连着（学员从中间某章开始时，直接当作已经装好）
    if (ch.needsPlugin !== false) api.ensureConnected();
    var me = current;
    Promise.resolve(ch.setup && current.stepIndex === 0 ? ch.setup(api) : null).catch(function (e) { console.warn('[教程] 章节准备出错', e); }).then(function () { if (current === me) showStep(me.stepIndex); });
  }
  function showStep(i) {
    var ch = current.ch, step = ch.steps[i];
    root.clearInterval(checkTimer); root.clearTimeout(helpTimer);
    hand.hidden = true;
    if (!step) { markDone(ch); return nextChapter(); }
    var token = ++runToken;
    current.stepIndex = i; current.step = step; current.needsNoted = false; current.helping = false;
    var p = loadProgress(); p.current = { ch: ch.id, step: i }; saveProgress(p);
    var kind = step.kind || 'tell';
    var bubble = $('tutBubble');
    bubble.className = 'tut-bubble mode-' + kind;
    $('tutMode').textContent = MODE_TEXT[kind] || '';
    $('tutChapter').textContent = '第 ' + (ch.no != null ? ch.no : current.chIndex) + ' 章 · ' + ch.title;
    $('tutText').innerHTML = step.text;
    var task = $('tutTask');
    task.hidden = !step.task; task.className = 'tut-task'; task.textContent = step.task ? '' + step.task : '';
    $('tutProgress').textContent = (i + 1) + ' / ' + ch.steps.length;
    $('tutBack').disabled = i === 0;
    $('tutHelp').hidden = true; $('tutReplay').hidden = true;
    var next = $('tutNext');
    next.textContent = i === ch.steps.length - 1 ? (current.chIndex === chapters.length - 1 ? '完成' : '下一章') : '下一步';
    bubble.hidden = false;
    // 只有「轮到你了」才解锁；演示和说明的时候学员动不了界面（用户 10-18 晚定）
    setLock(kind !== 'try');
    guide = step.guide ? { box: step.guide, label: step.guideLabel, min: step.guideMin } : null; positionGuide();
    // 有检查条件的步骤：做对了才放行；演示要等演示完
    var needCheck = typeof step.check === 'function';
    next.disabled = needCheck || !!step.demo;
    placeStep();
    var stepMark = api.mark();
    current.stepMark = stepMark;
    Promise.resolve(step.enter ? step.enter(api, stepMark) : null).catch(function (e) { console.warn('[教程] 步骤准备出错', e); }).then(function () {
      if (token !== runToken) return;
      placeStep();
      if (step.demo) {
        return Promise.resolve(step.demo(api, stepMark)).catch(function (e) { console.warn('[教程] 演示出错', e); }).then(function () {
          if (token !== runToken) return;
          hand.hidden = true;
          if (!needCheck) { next.disabled = false; $('tutReplay').hidden = false; }
        });
      }
    }).then(function () {
      if (token !== runToken || !needCheck) return;
      checkTimer = root.setInterval(function () {
        var ok = false;
        try { ok = !!step.check(api, stepMark, current.mark); } catch (_) {}
        if (!ok) return;
        root.clearInterval(checkTimer); root.clearTimeout(helpTimer);
        task.className = 'tut-task done'; task.textContent = '✓ ' + (step.doneText || '做对了！');
        next.disabled = false; $('tutHelp').hidden = true;
        if (guide) { $('psGuide').classList.add('ok'); }
        if (step.autoNext !== false) root.setTimeout(function () { if (token === runToken) goNext(); }, 1000);
      }, 300);
      // 卡住了：过一会儿给个「帮我做一下」（真点按钮，不跳过检查）
      if (typeof step.help === 'function') helpTimer = root.setTimeout(function () { if (token === runToken) $('tutHelp').hidden = false; }, step.helpAfter || 20000);
    });
  }
  function goNext() {
    if (!current) return;
    if (current.stepIndex >= current.ch.steps.length - 1) { markDone(current.ch); return nextChapter(); }
    showStep(current.stepIndex + 1);
  }
  function nextChapter() {
    var i = current ? current.chIndex + 1 : 0;
    // 只看新章节的模式：跳过已经做完 / 跳过的
    if (mode === 'new') while (chapters[i] && !chapterPending(chapters[i])) i++;
    if (i >= chapters.length) return finishAll();
    startChapter(i, 0);
  }
  $('tutNext').addEventListener('click', function () { if (!this.disabled) goNext(); });
  $('tutBack').addEventListener('click', function () { if (current && current.stepIndex > 0) showStep(current.stepIndex - 1); });
  $('tutHelp').addEventListener('click', function () {
    var step = current && current.step; if (!step || typeof step.help !== 'function') return;
    $('tutHelp').hidden = true;
    setLock(true);
    if (current) current.helping = true;
    Promise.resolve(step.help(api)).catch(function (e) { console.warn('[教程] 帮做出错', e); }).then(function () { hand.hidden = true; if (current && current.step === step) { current.helping = false; setLock(false); } });
  });
  $('tutReplay').addEventListener('click', function () { if (current) showStep(current.stepIndex); });

  // ── 封面：从哪章开始 ──
  var mode = 'all';
  function showCover(kind) {
    current = null; runToken++;
    root.clearInterval(checkTimer);
    setLock(false); guide = null; positionGuide();
    $('tutBubble').hidden = true; showRings(null); $('tutDim').hidden = true; hand.hidden = true;
    var fresh = chapters.filter(function (c) { return !chapterDone(c); });
    var anyDone = fresh.length < chapters.length;
    // 「新的」= 以前做过 / 跳过一批之后，又加了的章节（或者改版的章节）
    var p0 = loadProgress(), seenBefore = !!(p0.skippedAt || p0.finishedAt || anyDone);
    var newOnes = seenBefore ? chapters.filter(chapterPending) : [];
    var box = $('tutCover');
    var head = kind === 'end'
      ? '<h1>教程做完了</h1><p>以后想再看哪一章，在「设置 → 关于软件 → 重新看教程」里打开就行。下面也能直接再点一章。</p>'
      : newOnes.length
        ? '<h1>还有 ' + newOnes.length + ' 章没看完</h1><p>下面标黄的是还没看完的（有的是新加的功能）。点「开始」只看这几章；全部看完以后，打开软件就不会再弹了。</p>'
        : '<h1>修图轮椅 · 新手教程</h1><p>左边是一个<b>假的 Photoshop</b>，右边是<b>真的修图轮椅</b>。每一章我先做一遍给你看（这时你动不了，看就行），然后轮到你自己动手。<br>出图都是示例结果：<b>不联网、不扣积分</b>。随时可以点右上角「跳过教程」。</p>';
    box.innerHTML = '<div class="tut-cover-box">' + head +
      '<div class="tut-chapters">' + chapters.map(function (c, i) {
        return '<button type="button" class="tut-ch' + (chapterDone(c) ? ' done' : '') + (newOnes.indexOf(c) >= 0 ? ' new' : '') + '" data-ch="' + i + '">' + (c.no != null ? c.no : i) + '. ' + esc(c.title) + '<small>' + esc(c.summary || '') + '</small></button>';
      }).join('') + '</div>' +
      '<div class="tut-actions"><button type="button" data-cover="skip">跳过教程</button><span class="tut-progress"></span>' +
      (kind === 'end' ? '<button type="button" class="pri" data-cover="close">关闭教程</button>' :
        '<button type="button" class="pri" data-cover="start">' + (newOnes.length ? '开始（只看没看完的）' : anyDone && fresh.length ? '接着学' : '从头开始') + '</button>') + '</div></div>';
    box.hidden = false;
    box.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ch != null) { mode = 'all'; startChapter(Number(b.dataset.ch), 0); return; }
      if (b.dataset.cover === 'skip') return askSkip();
      if (b.dataset.cover === 'close') return exitTutorial('done');
      if (b.dataset.cover === 'start') {
        if (newOnes.length) { mode = 'new'; current = null; return nextChapter(); }
        var first = chapters.findIndex(function (c) { return !chapterDone(c); });
        mode = 'all';
        startChapter(first < 0 ? 0 : first, 0);
      }
    };
  }
  function finishAll() { var p = loadProgress(); p.finishedAt = Date.now(); delete p.current; saveProgress(p); showCover('end'); }

  // ── 跳过 / 退出（多条出口：跳过按钮、Esc、真界面里的退出、托盘菜单）──
  function askSkip() { $('tutConfirm').hidden = false; $('tutConfirmNo').focus(); }
  $('tutSkip').addEventListener('click', askSkip);
  $('tutSkip').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') askSkip(); });
  $('tutConfirmNo').addEventListener('click', function () { $('tutConfirm').hidden = true; });
  $('tutConfirmYes').addEventListener('click', function () {
    // 跳过：按「章节 id + 版本」记下这一批都跳过了 —— 以后加了新章节（或者某章改版），只弹新的那几章
    var p = loadProgress(); p.skippedAt = Date.now(); p.skipped = p.skipped || {};
    chapters.forEach(function (c) { p.skipped[c.id] = c.version || 1; });
    saveProgress(p); exitTutorial('skip');
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!$('tutViewer').hidden) return closeViewer();
      if (!$('tutConfirm').hidden) $('tutConfirm').hidden = true; else askSkip();
      return;
    }
    if (!$('tutViewer').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { if (app && app.__V7_TUTORIAL_VIEWER_NAV__) app.__V7_TUTORIAL_VIEWER_NAV__(e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (!$('tutLock').hidden) return;     // 演示时不认学员的按键
    // PS 的快捷键 M = 矩形选框工具
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.altKey && !e.metaKey) { setTool('marquee'); return; }
    // 焦点在假 PS 上时按的快捷键：交给真界面（真软件是全局快捷键，焦点在 PS 里也能用）
    if (app && typeof app.__V7_TUTORIAL_KEY__ === 'function' && app.__V7_TUTORIAL_KEY__(e)) e.preventDefault();
  });
  function exitTutorial(reason) {
    root.__V7_TUTORIAL_EXIT__ = reason || 'exit';
    var T = root.__TAURI__;
    if (T && T.core && typeof T.core.invoke === 'function') {
      T.core.invoke('tutorial_close', { reason: String(reason || '') }).catch(function () { try { root.close(); } catch (_) {} });
      return;
    }
    // 不在软件里（浏览器 / 测试）：显示一句话就行
    $('tutConfirm').hidden = true;
    doc.body.innerHTML = '<div class="tut-cover"><div class="tut-cover-box"><h1>教程已关闭</h1><p>可以关掉这个窗口了。</p></div></div>';
  }

  // ── 给自动测试 / 排查用 ──
  root.V7TutorialRuntime = {
    api: api, ps: ps, stats: stats, actionLog: actionLog, blocked: blockedUrls, backendMiss: backendMiss, chapters: chapters, plugin: plugin,
    unknownActions: function () { return ps.unknown(); },
    current: function () { return current && current.step && { ch: current.ch.id, step: current.stepIndex, kind: current.step.kind, hasTarget: !!current.step.target, checkable: typeof current.step.check === 'function', nextEnabled: !$('tutNext').disabled, locked: !$('tutLock').hidden }; },
    start: function (i) { mode = 'all'; startChapter(i || 0, 0); },
    goNext: goNext, showCover: showCover, ready: function () { return preparedReady; },
    // 自动走查用：立刻执行这一步的「帮我做一下」
    helpNow: function () { var s = current && current.step; return Promise.resolve(s && typeof s.help === 'function' ? s.help(api) : null).then(function () { hand.hidden = true; return true; }); },
    bubbleRect: function () { var r = $('tutBubble').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; },
    ringRects: function () { return [$('tutRing')].concat(Array.prototype.slice.call($('tutRings').children)).filter(function (el) { return !el.hidden; }).map(function (el) { var r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }); },
    progressKey: PROGRESS_KEY
  };

  // ── 开场 ──
  // 教程专用的「修脸」预设（用户 10-18 晚：要一个带文字滑块和填空的虚拟预设，教提示词面板）。只在教程那一格的预设库里。
  var TUTORIAL_PRESET = {
    id: 'tutorial-face-retouch', title: '教程·修脸', category: 'head', starred: true, kind: 'prompt', source: 'tutorial',
    content: '（教程示例预设）修脸：保持人物身份、五官结构和脸型不变，自然地修饰面部皮肤，去掉痘印和小瑕疵，保留真实的皮肤质感。\n'
      + '"@param:磨皮强度": 0.40,\n"@param:磨皮强度_label": "磨皮强度",\n"@param:磨皮强度_desc": "越大皮肤越光滑；太大会像塑料",\n'
      + '"@param:瘦脸": 0.20,\n"@param:瘦脸_label": "瘦脸",\n"@param:瘦脸_desc": "轻轻收一点下颌线",\n'
      + '妆容：【填空:妆容=淡妆】'
  };
  // 真界面准备：等「教程学员」自动登录完（换账号会重载一遍设置），再给它配一个假的出图服务 ——
  //   跟用户自己填地址 + Key 一模一样的那条路（出图走 uiwin.ai.generate → 上面的 fakeGenerate），
  //   Key 是假的、地址是 .invalid，就算漏网也连不出去（tutorial-host.js 还有一道断网）。
  function prepareApp() {
    return api.until(function () { return app.V7Backend && app.V7Backend.state().signedIn && typeof app.__V7_QWEN_SETTINGS__ === 'function'; }, 20000).then(function () {
      return sleep(400);
    }).then(function () {
      api.saveSettings({ provider: 'aji', ajiUrl: 'https://tutorial.invalid', ajiKey: 'tutorial-key', imageComputeSource: 'own', qwenMode: false });
      // 校色引擎先探一次：没探到之前出的图不存底版，任务卡 👁 会说「没有底版，切不了」
      try { if (app.MATCHENGINE && typeof app.MATCHENGINE.probe === 'function') app.MATCHENGINE.probe(true); } catch (_) {}
      // 学员点了预设列表的哪一行（章节检查「点一个预设」用：同一个预设再点一次也算）
      app.document.addEventListener('click', function (e) { if (e.isTrusted && e.target && e.target.closest && e.target.closest('.pz-row[data-preset-id]')) bump('presetClick'); }, true);
      // 在任务卡缩略图上滚滚轮（调强度）：过渡帧算过一次就走缓存、不再请求引擎，所以单独记一笔
      app.document.addEventListener('wheel', function (e) { if (e.target && e.target.closest && e.target.closest('.pv-cell, .task-preview')) bump('thumbWheel'); }, true);
      app.document.addEventListener('dblclick', function (e) { if (e.target && e.target.closest && e.target.closest('.pv-cell')) bump('thumbDbl'); }, true);
      // 开机时冒的那几张「账号已切换 / 账号已变化」小卡（预设其实已经加载好了），跟教程无关，用卡片自己的按钮收掉
      var clearBootNoise = function () {
        try {
          app.document.querySelectorAll('.error-card').forEach(function (card) {
            if (!/账号已切换|账号已变化/.test(card.textContent || '')) return;
            var d = card._detailEl, btn = d && (d.querySelector('[data-a="cancel"]') || d.querySelector('[data-a="confirm"]'));
            if (btn) btn.click();
          });
        } catch (_) {}
      };
      clearBootNoise(); root.setTimeout(clearBootNoise, 1500); root.setTimeout(clearBootNoise, 4000);
      // 放进教程那一格的预设库（每次都覆盖成原样：学员上次拖过的滑块不影响这次）
      return api.until(function () { return app.PRESETS && typeof app.PRESETS.savePreset === 'function' && app.PRESETS.presets().length > 0; }, 15000).then(function () {
        return Promise.resolve(app.PRESETS.savePreset(Object.assign({}, TUTORIAL_PRESET))).catch(function (e) { console.warn('[教程] 示例预设没存进去', e); });
      }).then(function () { try { app.PRESETUI.fillZone(); app.PRESETUI.renderCrumb(); } catch (_) {} });
    });
  }
  layout();
  renderPlugin(); renderPluginsMenu();
  ensurePhoto().then(function () { return api.newDoc('示例照片.psd'); });
  appReady.then(function () {
    var start = new URLSearchParams(root.location.search).get('chapter') || root.__V7_TUTORIAL_START__ || '';
    // 等真界面把卡片摆好（主卡出来）再开始
    return api.until(function () { return api.q('.block-card'); }, 20000).then(prepareApp).then(function () {
      preparedResolve(true);
      if (start != null && start !== '') startChapter(Math.max(0, chapters.findIndex(function (c) { return c.id === start || String(c.no) === start; })), 0);
      else showCover('start');
    });
  });
  root.V7TutorialRuntime.preset = TUTORIAL_PRESET;
})(window);
