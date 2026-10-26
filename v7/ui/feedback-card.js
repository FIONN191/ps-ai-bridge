/* ══════════════════════════════════════════════════════════════════════════
 * 问题反馈卡（feedback-card.js）· 2026-10-18 深夜（docs/248）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：「新增一个问题反馈卡片 默认打开 里面的内容需要提醒用户尽可能详细的描述现在的问题
 *           可以贴图片 防止注入攻击 这个内容要直接到服务器的内容反馈内来 方便用户直接反馈问题
 *           快速修改 快速迭代 要做好安全性隔离」
 * 拍板（同晚 10 问）：单向反馈箱（后台「问题反馈」页）；必须登录；诊断信息默认带、能取消；
 *   图片最多 4 张、每张 ≤ 2MB；主卡堆第 9 张「问题反馈」主卡，右滑大二级写长的、贴图；
 *   L2 / L3 报错卡加「反馈这个问题」，自动带上错误码和当时情况。
 *
 * 这个文件只管【内容】：卡面（renderFace）+ 大二级的一列（renderPage）+ 发送。
 *   开 / 关 / 右滑 / 滚轮 / 路由这些宿主胶水在 ui.html（搜 feedbackCardMount），跟生成卡同一套。
 *
 * 安全（防注入）：
 *   · 用户写的字只走 textContent / textarea.value，绝不拼进 innerHTML；
 *   · 图片在本机先用 canvas 重新画一遍（顺带缩小到 2MB 以内），服务器还会再解码核对一次；
 *   · 诊断信息跟「复制诊断信息」同一份（版本、状态、最近报错；没有密码 / Key / 图片），发之前能展开看、能取消。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var MAX_IMAGES = 4;
  var MAX_BYTES = 2 * 1024 * 1024;
  var TARGET_BYTES = 1900 * 1024;      // 留点余量：服务器按 2MB 卡
  var MAX_EDGE = 2560;
  var BODY_MIN = 5, BODY_MAX = 8000;
  var KINDS = [['bug', '遇到问题'], ['idea', '建议'], ['other', '其他']];
  var GUIDE = [
    '你在做什么（比如：框选了脸，选了「修脸」预设，点了开始生成）',
    '出了什么问题（报错原文、卡住不动、结果不对、哪里看不懂……）',
    '每次都这样，还是偶尔一次？换张图 / 重开软件还会吗？',
    '你希望它怎样'
  ];
  var PLACEHOLDER = '越详细修得越快。可以照着下面几条写：\n1. 你在做什么\n2. 出了什么问题（报错原文可以直接粘贴）\n3. 每次都这样还是偶尔\n4. 你希望它怎样\n\n截图直接 Ctrl+V 粘贴到这一页。';

  var cfg = { navigate: null, report: null };
  var state = {
    kind: 'bug', body: '', images: [], diag: true, context: null,
    sending: false, status: '', statusKind: '', last: null, clientId: ''
  };
  var faces = new Set();
  var pages = new Set();
  var seq = 0;

  // ── 草稿：只存文字（按账号分开），发出去就清；图片只在内存里 ──
  function draftKey() {
    try { if (root.WHEELCHAIR_STORAGE && root.WHEELCHAIR_STORAGE.key) return root.WHEELCHAIR_STORAGE.key('feedback.draft.v1'); } catch (_) {}
    return 'wheelchair.v7.feedback.draft.v1';
  }
  function loadDraft() {
    try {
      var raw = root.localStorage.getItem(draftKey());
      var d = raw ? JSON.parse(raw) : null;
      if (d && typeof d.body === 'string') state.body = d.body.slice(0, BODY_MAX + 500);
      if (d && KINDS.some(function (k) { return k[0] === d.kind; })) state.kind = d.kind;
      // ⭐ 2026-10-24（查生产库反馈 ce4e63b6：正文「【报错】引擎启动失败」但 context 是空的）：
      //   从报错卡点「反馈这个问题」时错误码 / 详情只在内存里 —— 关掉再开、换账号后草稿正文回来了，错误码却丢了。现在跟草稿一起存。
      if (d && d.context && typeof d.context === 'object' && !Array.isArray(d.context)) {
        var c = {};
        ['errorCode', 'level', 'errorTitle', 'errorDetail', 'when', 'source'].forEach(function (k) { if (typeof d.context[k] === 'string') c[k] = d.context[k].slice(0, k === 'errorDetail' ? 2000 : 200); });
        state.context = Object.keys(c).length ? c : null;
      }
    } catch (_) {}
  }
  var saveTimer = 0;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        if (state.body.trim()) root.localStorage.setItem(draftKey(), JSON.stringify({ body: state.body, kind: state.kind, context: state.context || null }));
        else root.localStorage.removeItem(draftKey());
      } catch (_) {}
    }, 300);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function signedIn() {
    try { var s = root.V7Backend && root.V7Backend.state && root.V7Backend.state(); return !!(s && s.signedIn); } catch (_) { return false; }
  }
  function appVersion() {
    try { return String(root.V7_VERSION && root.V7_VERSION.app || '').slice(0, 32); } catch (_) { return ''; }
  }
  function randomId() {
    var a = '';
    try { var b = new Uint8Array(12); root.crypto.getRandomValues(b); for (var i = 0; i < b.length; i++) a += ('0' + b[i].toString(16)).slice(-2); }
    catch (_) { a = Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
    return 'fb-' + a;
  }

  // ── 诊断信息（跟设置 → 关于软件 →「复制诊断信息」同一份内容）──
  //   ⚠ 那边的拼法写在 card-architecture.js 的闭包里拿不出来，这里照抄一份（改那边记得看这里）。
  var backendHealth = null;
  function diagnosticsText() {
    var i = {};
    try { i = root.V7AboutInfo ? root.V7AboutInfo() : {}; } catch (_) {}
    var lines = [];
    lines.push('软件 ' + (i.app || '?') + ' ' + (i.channel || '') + ' ' + (i.date || ''),
      'PS 插件 ' + (i.uxpConnected ? (i.uxpVersion || '已连接') : '没连上'),
      '后台 ' + (i.backendUrl || '') + ' ' + (backendHealth ? ('线上 ' + backendHealth.version + ' ' + backendHealth.build) : backendHealth === false ? '连不上' : '未知'),
      '登录 ' + (i.signedIn ? '是' : '否'), '引擎 ' + (i.engine ? JSON.stringify(i.engine) : '没装'), '开源模型 ' + (i.qwen ? JSON.stringify(i.qwen) : '无'),
      '任务数 ' + i.tasks, '界面内存 ' + (i.memory || ''), '更新 ' + (root.V7AppUpdate ? root.V7AppUpdate.describe() : '没加载'),
      '界面缩放 ' + (function () { try { return root.V7UiScale ? root.V7UiScale.describe() : '跟随系统'; } catch (_) { return '?'; } })(),
      '屏幕 ' + (root.screen ? root.screen.width + '×' + root.screen.height : '?') + ' · 窗口 ' + root.innerWidth + '×' + root.innerHeight + ' · 系统缩放 ' + Math.round((root.devicePixelRatio || 1) * 100) + '%',
      '系统 ' + (i.ua || ''), '时间 ' + new Date().toString());
    var probs = Array.isArray(i.problems) ? i.problems : [];
    lines.push('—— 最近的报错 / 警告（' + (probs.length ? probs.length + ' 种，一样的合并了，最新的在最后' : '没有') + '）——');
    probs.forEach(function (p) {
      lines.push(String(p.at || '').replace('T', ' ').slice(0, 19) + ' [' + (p.level === 'error' ? '错误' : '警告') + (p.from ? ' · ' + p.from : '') + '] ' + p.message + (p.count > 1 ? '（×' + p.count + '）' : ''));
    });
    return lines.join('\n');
  }
  function refreshHealth() {
    if (!root.V7Backend || typeof root.V7Backend.publicHealth !== 'function') return;
    Promise.resolve(root.V7Backend.publicHealth()).then(function (h) { backendHealth = h && h.ok ? h : false; paintAll(); }, function () { backendHealth = false; });
  }

  // ── 图片：本机先重新画一遍，缩到 2MB 以内 ──
  function readAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('读不出这张图')); };
      r.readAsDataURL(blob);
    });
  }
  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, type, quality); });
  }
  async function prepareImage(file) {
    if (!file || !/^image\//.test(file.type || '')) throw new Error('只能贴图片（PNG / JPG / WebP 截图都行）');
    if (file.size > 40 * 1024 * 1024) throw new Error('这张图太大了（' + fmtBytes(file.size) + '），截一部分再贴');
    var bitmap;
    try { bitmap = await createImageBitmap(file); } catch (_) { throw new Error('这个文件打不开，不像是图片'); }
    var w = bitmap.width, h = bitmap.height;
    if (!w || !h) throw new Error('这张图是空的');
    var direct = /^image\/(png|jpeg)$/.test(file.type) && file.size <= TARGET_BYTES && Math.max(w, h) <= MAX_EDGE;
    if (direct) {
      var url = await readAsDataUrl(file);
      try { bitmap.close(); } catch (_) {}
      return { dataUrl: url, bytes: file.size, w: w, h: h };
    }
    // 重新画：先按长边缩到 2560，PNG 装不下就换 JPG，再装不下就继续缩
    var edge = Math.min(MAX_EDGE, Math.max(w, h));
    var out = null;
    for (var round = 0; round < 6 && !out; round++) {
      var s = edge / Math.max(w, h);
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas'); c.width = cw; c.height = ch;
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
      g.drawImage(bitmap, 0, 0, cw, ch);
      var tries = round === 0 ? [['image/png'], ['image/jpeg', 0.9]] : [['image/jpeg', 0.85]];
      for (var t = 0; t < tries.length && !out; t++) {
        var b = await canvasBlob(c, tries[t][0], tries[t][1]);
        if (b && b.size <= TARGET_BYTES) out = { blob: b, w: cw, h: ch };
      }
      edge = Math.round(edge * 0.75);
    }
    try { bitmap.close(); } catch (_) {}
    if (!out) throw new Error('这张图压不到 2MB 以内，截小一点再贴');
    return { dataUrl: await readAsDataUrl(out.blob), bytes: out.blob.size, w: out.w, h: out.h };
  }
  async function addFiles(list, how) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) { return f && /^image\//.test(f.type || ''); });
    if (!files.length) { if (how !== 'paste') setStatus('没找到图片。截图后直接 Ctrl+V，或者点「选图片」。', 'warn'); return 0; }
    var room = MAX_IMAGES - state.images.length;
    if (room <= 0) { setStatus('最多 ' + MAX_IMAGES + ' 张图。先点图上的 × 删掉一张。', 'warn'); return 0; }
    var added = 0, problems = [];
    for (var i = 0; i < files.length && added < room; i++) {
      try {
        var img = await prepareImage(files[i]);
        img.id = ++seq; img.name = String(files[i].name || '截图').slice(0, 60);
        state.images.push(img); added++;
      } catch (error) { problems.push(String(error && error.message || error)); }
    }
    if (files.length > room) problems.push('只收了前 ' + room + ' 张（最多 ' + MAX_IMAGES + ' 张）');
    setStatus(added ? ('加了 ' + added + ' 张图' + (problems.length ? '；' + problems.join('；') : '')) : problems.join('；'), problems.length ? 'warn' : 'ok');
    paintAll();
    return added;
  }

  // ── 状态 / 重画 ──
  function setStatus(text, kind) { state.status = text || ''; state.statusKind = kind || ''; paintStatus(); }
  function paintStatus() {
    var nodes = document.querySelectorAll('[data-fb-status]');
    for (var i = 0; i < nodes.length; i++) { nodes[i].textContent = state.status; nodes[i].dataset.kind = state.statusKind; }
  }
  function canSend() { return !state.sending && state.body.trim().length >= BODY_MIN && state.body.length <= BODY_MAX; }
  function paintAll() {
    faces.forEach(function (n) { if (n.isConnected) paintFace(n); else faces.delete(n); });
    pages.forEach(function (p) { if (p.root.isConnected) p.paint(); else pages.delete(p); });
    paintStatus();
  }

  // ══ 卡面（一级卡正面）══════════════════════════════════
  //   ⚠ 卡面不放输入框：主卡上拖动 / 右滑是手势，在输入框里拖选文字会跟手势打架。写字、贴图都在右滑出来的大二级里。
  function renderFace(node) {
    if (!node) return;
    faces.add(node);
    node.textContent = '';
    var wrap = el('div', 'fb-face');
    wrap.append(el('p', 'fb-face-lead', '遇到问题、有想法？写下来直接发到后台，修得更快。'),
      el('div', 'fb-face-draft'), el('div', 'fb-face-meta'));
    var btns = el('div', 'fb-face-btns');
    var open = el('button', 'ai-btn primary', '写反馈 · 贴截图');
    open.type = 'button'; open.setAttribute('data-fb-open', '');
    open.addEventListener('click', function (e) { e.stopPropagation(); openCard('write'); });
    var send = el('button', 'ai-btn', '发送');
    send.type = 'button'; send.setAttribute('data-fb-send', '');
    send.addEventListener('click', function (e) { e.stopPropagation(); submit(); });
    btns.append(open, send);
    var status = el('p', 'fb-status'); status.setAttribute('data-fb-status', ''); status.setAttribute('role', 'status');
    wrap.append(btns, status);
    node.append(wrap);
    paintFace(node);
    paintStatus();
  }
  function paintFace(node) {
    var draft = node.querySelector('.fb-face-draft'), meta = node.querySelector('.fb-face-meta'), send = node.querySelector('[data-fb-send]');
    var text = state.body.trim();
    if (draft) {
      draft.textContent = text ? text.slice(0, 120) + (text.length > 120 ? '…' : '') : '还没写。右滑这张卡，或点下面的按钮开始写。';
      draft.classList.toggle('empty', !text);
    }
    if (meta) {
      var bits = [];
      if (state.context && state.context.errorCode) bits.push('带着报错 ' + state.context.errorCode);
      bits.push(state.images.length + ' 张图', state.diag ? '带诊断信息' : '不带诊断信息');
      if (state.last) bits.push('上次发送 ' + state.last.when);
      meta.textContent = bits.join(' · ');
    }
    if (send) {
      send.disabled = !canSend();
      send.textContent = state.sending ? '正在发…' : '发送';
      send.title = canSend() ? '' : (state.sending ? '正在发送…' :'先写几句（至少 ' + BODY_MIN + ' 个字）');
    }
  }
  function openCard(section) {
    if (typeof cfg.navigate === 'function') {
      try { return cfg.navigate(section || 'write'); } catch (error) { report(error); }
    }
    return null;
  }

  // ══ 大二级的一列（右边导航四节：写问题 / 截图 / 诊断信息 / 发送）══════
  var TABS = [
    { id: 'write', name: '写下问题', sub: '越详细修得越快：在做什么、出了什么问题、能不能重复', group: '反馈' },
    { id: 'images', name: '截图', sub: '最多 4 张，每张 2MB 以内（太大会自动缩小）。Ctrl+V 粘贴、拖进来、或选文件', group: '反馈' },
    { id: 'diag', name: '诊断信息', sub: '版本、连接状态、最近的报错；没有密码 / Key / 图片。默认带上，可以不带', group: '反馈' },
    { id: 'send', name: '发送', sub: '发到夏三七的后台「问题反馈」，他每天看', group: '发出去' }
  ];

  function renderPage(body) {
    if (!body) return null;
    body.textContent = '';
    var rootEl = el('div', 'settings-panel sc-flat fb-page');
    rootEl.setAttribute('data-feedback-page', '');
    function sec(id) {
      var t = TABS.filter(function (x) { return x.id === id; })[0];
      var s = el('section', 'settings-section');
      s.setAttribute('data-sec-anchor', id);
      s.append(el('h3', 'settings-section-title', t.name), el('p', 'sec-sub', t.sub));
      rootEl.append(s);
      return s;
    }

    // ① 写下问题
    var w = sec('write');
    var kinds = el('div', 'fb-kinds'); kinds.setAttribute('role', 'radiogroup'); kinds.setAttribute('aria-label', '反馈类型');
    KINDS.forEach(function (k) {
      var b = el('button', 'fb-kind', k[1]); b.type = 'button'; b.dataset.kind = k[0]; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { state.kind = k[0]; saveDraft(); paintAll(); });
      kinds.append(b);
    });
    var ctx = el('div', 'fb-context');
    var ctxText = el('span', 'fb-context-text');
    var ctxDrop = el('button', 'fb-context-x', '不带这条报错'); ctxDrop.type = 'button';
    ctxDrop.addEventListener('click', function () { state.context = null; paintAll(); });
    ctx.append(ctxText, ctxDrop);
    var guide = el('ol', 'fb-guide');
    GUIDE.forEach(function (g) { guide.append(el('li', '', g)); });
    var ta = el('textarea', 'fb-text');
    ta.setAttribute('data-fb-text', ''); ta.rows = 10; ta.maxLength = BODY_MAX; ta.placeholder = PLACEHOLDER; ta.value = state.body;
    ta.setAttribute('aria-label', '反馈内容');
    ta.addEventListener('input', function () { state.body = ta.value; saveDraft(); grow(); paintCount(); faces.forEach(paintFace); paintSendBtns(); });
    // 跟着内容长高（大二级里滚轮只滚整列，框里自己滚不动 —— 见 feedback-card.css 的说明）
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.max(180, ta.scrollHeight + 2) + 'px'; }
    var count = el('div', 'fb-count');
    w.append(kinds, ctx, guide, ta, count);

    // ② 截图
    var im = sec('images');
    var drop = el('div', 'fb-drop');
    drop.setAttribute('data-fb-drop', ''); drop.tabIndex = 0;
    drop.append(el('b', '', '截图后在这一页任意位置按 Ctrl+V 粘贴'), el('span', '', '也可以把图片拖进这个框，或者'));
    var pick = el('button', 'ai-btn', '选图片…'); pick.type = 'button';
    var file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'; file.multiple = true; file.hidden = true;
    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { addFiles(file.files, 'pick'); file.value = ''; });
    drop.append(pick, file);
    drop.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); addFiles(e.dataTransfer && e.dataTransfer.files, 'drop'); });
    var thumbs = el('div', 'fb-thumbs');
    im.append(drop, thumbs);

    // ③ 诊断信息
    var dg = sec('diag');
    var lab = el('label', 'fb-check');
    var cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('data-fb-diag', '');
    cb.addEventListener('change', function () { state.diag = cb.checked; paintAll(); });
    lab.append(cb, el('span', '', '附带诊断信息（推荐：能一眼看出你的版本和最近的报错）'));
    var det = el('details', 'fb-diag');
    var sum = el('summary', '', '看看会带什么');
    var pre = el('pre', 'fb-diag-text');
    det.append(sum, pre);
    det.addEventListener('toggle', function () { if (det.open) pre.textContent = diagnosticsText(); });
    dg.append(lab, det);

    // ④ 发送
    var sd = sec('send');
    var acts = el('div', 'ai-actions');
    var send = el('button', 'ai-btn primary', '发送'); send.type = 'button'; send.setAttribute('data-fb-send', '');
    send.addEventListener('click', function () { submit(); });
    var clear = el('button', 'ai-btn', '清空重写'); clear.type = 'button';
    clear.addEventListener('click', function () {
      if (state.sending) return;
      state.body = ''; state.images = []; state.context = null; state.clientId = ''; saveDraft(); setStatus('', ''); paintAll();
      ta.value = ''; paintCount();
    });
    acts.append(send, clear);
    var st = el('p', 'fb-status'); st.setAttribute('data-fb-status', ''); st.setAttribute('role', 'status');
    var lastLine = el('p', 'fb-last');
    var note = el('p', 'fb-foot', '这是单向反馈：发出去后夏三七在后台能看到，修好会在更新说明里写。要人工回复、查积分，请用「设置 → 客服记录」。');
    sd.append(acts, st, lastLine, note);

    body.append(rootEl);

    // 整页任意位置 Ctrl+V 都收图（文字照常粘进输入框）
    function onPaste(e) {
      var items = e.clipboardData && e.clipboardData.items, list = [];
      for (var i = 0; items && i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { var f = items[i].getAsFile(); if (f) list.push(f); }
      if (!list.length) return;
      e.preventDefault();
      addFiles(list, 'paste');
    }
    rootEl.addEventListener('paste', onPaste);

    function paintCount() {
      var n = ta.value.length;
      count.textContent = n + ' / ' + BODY_MAX + ' 字' + (n && ta.value.trim().length < BODY_MIN ? ' · 再多写几句' : '');
      count.dataset.kind = n > BODY_MAX ? 'err' : '';
    }
    function paintSendBtns() {
      var btns = document.querySelectorAll('[data-fb-send]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].disabled = !canSend();
        btns[i].textContent = state.sending ? '正在发…' : '发送';
      }
    }
    var page = {
      root: rootEl,
      paint: function () {
        kinds.querySelectorAll('.fb-kind').forEach(function (b) { var on = b.dataset.kind === state.kind; b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); });
        if (ta.value !== state.body) ta.value = state.body;
        grow();
        ta.disabled = state.sending;
        var c = state.context;
        ctx.hidden = !c;
        if (c) ctxText.textContent = '会带上这条报错：' + [c.level, c.errorCode, c.errorTitle].filter(Boolean).join(' · ');
        thumbs.textContent = '';
        state.images.forEach(function (img) {
          var cell = el('div', 'fb-thumb');
          var pic = el('img'); pic.src = img.dataUrl; pic.alt = img.name;
          var x = el('button', 'fb-thumb-x', '×'); x.type = 'button'; x.title = '删掉这张';
          x.addEventListener('click', function () { state.images = state.images.filter(function (i) { return i.id !== img.id; }); paintAll(); });
          cell.append(pic, x, el('span', 'fb-thumb-meta', img.w + '×' + img.h + ' · ' + fmtBytes(img.bytes)));
          thumbs.append(cell);
        });
        thumbs.hidden = !state.images.length;
        drop.classList.toggle('full', state.images.length >= MAX_IMAGES);
        cb.checked = state.diag;
        if (det.open) pre.textContent = diagnosticsText();
        lastLine.textContent = state.last ? '上次发送：' + state.last.when + '（编号 ' + state.last.id.slice(0, 8) + '）' : '';
        paintCount(); paintSendBtns();
      }
    };
    pages.add(page);
    page.paint();
    paintStatus();
    refreshHealth();
    return function () { rootEl.removeEventListener('paste', onPaste); pages.delete(page); };
  }

  // ══ 发送 ═════════════════════════════════════════════
  async function submit() {
    if (state.sending) return { ok: false, reason: 'busy' };
    var text = state.body.trim();
    if (text.length < BODY_MIN) { setStatus('再多写几句：遇到了什么、你当时在做什么、希望怎样。', 'warn'); openCard('write'); return { ok: false, reason: 'short' }; }
    if (state.body.length > BODY_MAX) { setStatus('文字太长了（最多 ' + BODY_MAX + ' 字），可以分两条发。', 'warn'); return { ok: false, reason: 'long' }; }
    if (!root.V7Backend || typeof root.V7Backend.submitFeedback !== 'function') { setStatus('这一份软件不能发反馈（后台模块没加载）。', 'err'); return { ok: false, reason: 'unavailable' }; }
    if (!signedIn()) {
      setStatus('要先登录才能发反馈（防止有人乱刷）。登录后草稿还在，直接点发送。', 'warn');
      try { if (cfg.login) cfg.login(); } catch (_) {}
      return { ok: false, reason: 'login' };
    }
    // ⚠ 同一条内容重发用同一个编号：网断了、超时了再点一次，后台不会记成两条
    if (!state.clientId) state.clientId = randomId();
    state.sending = true;
    setStatus('正在发送' + (state.images.length ? '（带 ' + state.images.length + ' 张图，网慢的话要等一会儿）' : '') + '…', '');
    paintAll();
    try {
      var payload = {
        clientId: state.clientId, category: state.kind, body: state.body,
        images: state.images.map(function (i) { return i.dataUrl; }),
        appVersion: appVersion(),
        diagnostics: state.diag ? diagnosticsText() : '',
        context: state.context || undefined
      };
      var result = await root.V7Backend.submitFeedback(payload);
      var now = new Date();
      state.last = { id: String(result && result.id || ''), when: now.getHours() + ':' + ('0' + now.getMinutes()).slice(-2) };
      state.body = ''; state.images = []; state.context = null; state.clientId = '';
      saveDraft();
      setStatus('发出去了，谢谢！夏三七在后台能看到这条（编号 ' + state.last.id.slice(0, 8) + '）。', 'ok');
      return { ok: true, id: state.last.id };
    } catch (error) {
      var code = error && error.code || '';
      var msg = String(error && error.message || error || '');
      var why = code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID' ? '登录过期了，重新登录后再点发送（草稿还在）。'
        : code === 'FEEDBACK_RATE_LIMITED' ? '发得太频繁了，过一会儿再发（已经发出去的都收到了）。'
        : /^FEEDBACK_/.test(code) ? msg
        : code === 'NOT_FOUND' || error && error.status === 404 ? '后台还没开通反馈功能（要等服务器更新），草稿先留着。'
        : '没发出去：' + (msg || '网络不通') + '。草稿还在，网好了再点发送。';
      setStatus(why, 'err');
      // ⚠ 内容 / 图片本身被拒（太短、图不对）：换个编号，改完再发是新的一条
      if (/^FEEDBACK_(TOO|IMAGE)/.test(code)) state.clientId = '';
      return { ok: false, reason: code || 'network', message: msg };
    } finally {
      state.sending = false;
      paintAll();
    }
  }

  // ══ 报错卡「反馈这个问题」：带上错误码和当时情况，打开反馈卡 ══
  function fromError(info) {
    info = info || {};
    var c = {};
    var code = String(info.errorCode || info.code || '').trim();
    if (/^[A-Za-z0-9_.:\-]{1,64}$/.test(code)) c.errorCode = code;
    var level = String(info.level || info.severity || '').toUpperCase();
    if (/^L[1-3]$/.test(level)) c.level = level;
    if (info.title || info.errorTitle) c.errorTitle = String(info.title || info.errorTitle).slice(0, 200);
    var detail = [info.body, info.detail, info.errorDetail].filter(Boolean).join('\n').trim();
    if (detail) c.errorDetail = detail.slice(0, 2000);
    c.when = new Date().toISOString();
    c.source = 'error-card';
    state.context = c;
    if (!state.body.trim()) {
      state.body = '【报错】' + (c.errorTitle || c.errorCode || '') + '\n我当时在做：\n\n出了什么问题：\n\n';
      saveDraft();
    }
    setStatus('已经带上这条报错。补几句你当时在做什么，再点发送。', '');
    paintAll();
    openCard('write');
    return c;
  }

  function report(error) {
    try { if (typeof cfg.report === 'function') cfg.report(error); } catch (_) {}
  }

  loadDraft();
  // 换账号：草稿按账号分开存，换过去要读那个账号自己的草稿（图片、报错上下文不跨账号带过去）
  var lastDraftKey = draftKey();
  try {
    if (root.V7Backend && typeof root.V7Backend.onChange === 'function') root.V7Backend.onChange(function () {
      var k = draftKey();
      if (k !== lastDraftKey && !state.sending) { lastDraftKey = k; state.body = ''; state.kind = 'bug'; state.images = []; state.context = null; state.clientId = ''; state.last = null; setStatus('', ''); loadDraft(); }
      paintAll();
    });
  } catch (_) {}

  root.V7Feedback = {
    TABS: TABS,
    MAX_IMAGES: MAX_IMAGES, MAX_BYTES: MAX_BYTES, BODY_MIN: BODY_MIN, BODY_MAX: BODY_MAX,
    configure: function (o) { Object.assign(cfg, o || {}); },
    renderFace: renderFace,
    renderPage: renderPage,
    submit: submit,
    fromError: fromError,
    addFiles: addFiles,
    diagnosticsText: diagnosticsText,
    state: function () { return { kind: state.kind, body: state.body, images: state.images.length, diag: state.diag, context: state.context, sending: state.sending, status: state.status, last: state.last }; },
    _prepareImage: prepareImage
  };
})(typeof window !== 'undefined' ? window : globalThis);
