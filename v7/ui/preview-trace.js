/* ═══ 预览追踪（谁把任务预览收掉的）════════════════════════════════
 *
 * 为什么有这东西
 * --------------
 * 「任务卡右滑 → 预览条 + 上方大框」这条链上，能让它消失的路径【有七八条】
 * 分属两个文件（ui.html 管预览条、tween-preview.js 管大框），
 * 谁都有权收，而且收的时候都不出声。用户报的"闪一下就没"根本看不出是谁干的 ——
 * 光读代码只能猜（前几轮就是这么修错的）。
 *
 * ⇒ 把【所有】能改 .task-preview / .tween-box 上 'show' 的地方都记一笔，
 *   连调用栈一起记，然后在调试卡里列出来。用户实测一次，凶手自己现形。
 *
 * ⚠ 为什么用 patch classList 而不是 MutationObserver：
 *   MO 的回调是【异步微任务】，触发时栈已经没了 —— 只能告诉你"它变了"，
 *   告诉不了你"谁把它变的"。要看凶手就必须在改的那一瞬间抓栈。
 *
 * ⚠ 开销：所有 classList.add/remove 都会过这里。第一道闸门只比一个字符串
 *   （token === 'show'），不命中当场返回，所以常规重绘不受影响。
 *   命中之后才去认元素、抓栈（抓栈几百微秒，但每条链一辈子也就几次）。
 */
(function (root) {
  'use strict';

  var MAX = 400;              // 环形缓冲，够看一整轮实测
  var records = [];
  var seq = 0;
  var via = '';               // 当前动作标签（由下面几个入口包装写进去）
  var listeners = [];

  var SELF = 'preview-trace.js';

  // ⚠ 认元素必须按类名边界认：tween-box-inner / tween-box-img 里也含着 'tween-box'，
  //   用 indexOf 会把它们一起记进来（日志里全是噪声，真凶反而被埋掉）。
  function targetOf(el) {
    if (!el || !el.classList) return null;
    if (el.classList.contains('tween-box')) return '大框';
    if (el.classList.contains('task-preview')) return '预览条';
    return null;
  }

  // 调用栈：去掉本文件自己的几帧，剩下的头几帧就是凶手
  function callerFrames(skip) {
    var stack;
    try { stack = (new Error()).stack || ''; } catch (_) { return []; }
    var lines = stack.split('\n').slice(1);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf(SELF) >= 0) continue;
      if (line.indexOf('Error') === 0) continue;
      out.push(line);
      if (out.length >= (skip || 4)) break;
    }
    return out;
  }

  // 事发时的现场状态（能自动拿到的都拿上，拿不到的就 null）
  function snapshot() {
    var state = {
      free: null, zones: null, detail: null, zoneOpen: null,
      embedded: null, pvKeep: null, boxTaskId: null, shot: null,
      pointerAway: null, lastMX: null, lastMY: null,
      overlay: null, errCards: null, tasks: null
    };
    try { state.free = root.V7FreeMode && root.V7FreeMode.isActive ? !!root.V7FreeMode.isActive() : null; } catch (_) {}
    try { var z = document.getElementById('zones'); state.zones = z ? z.classList.contains('show') : null; } catch (_) {}
    try { var d = document.getElementById('detail'); state.detail = d ? d.classList.contains('show') : null; } catch (_) {}
    try { state.zoneOpen = (typeof root.zoneOpen === 'boolean') ? root.zoneOpen : null; } catch (_) {}
    try { state.pvKeep = (typeof root.pvKeepOpen === 'boolean') ? root.pvKeepOpen : null; } catch (_) {}
    try { state.overlay = (typeof root.v7OverlayOpen === 'function') ? !!root.v7OverlayOpen() : null; } catch (_) {}
    try { state.embedded = root.V7Workspaces && root.V7Workspaces.hasEmbedded ? !!root.V7Workspaces.hasEmbedded() : null; } catch (_) {}
    try { state.errCards = document.querySelectorAll('.error-card').length; } catch (_) {}
    try { state.tasks = document.querySelectorAll('.task:not(.leaving)').length; } catch (_) {}
    try {
      if (root.V7Tween && typeof root.V7Tween._diag === 'function') {
        var g = root.V7Tween._diag() || {};
        state.boxTaskId = g.boxTaskId != null ? g.boxTaskId : null;
        state.shot = g.boxShotIndex != null ? g.boxShotIndex : null;
        state.pointerAway = g.pointerAway != null ? g.pointerAway : null;
        state.lastMX = g.lastMX != null ? g.lastMX : null;
        state.lastMY = g.lastMY != null ? g.lastMY : null;
      }
    } catch (_) {}
    return state;
  }

  function record(kind, el, extra) {
    var target = targetOf(el);
    if (!target) return;
    var rec = {
      n: ++seq,
      t: Math.round(performance.now()),
      clock: (function () { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) + '.' + String(d.getMilliseconds()).padStart(3, '0'); })(),
      kind: kind,                 // 'open' | 'close'
      target: target,             // '大框' | '预览条'
      via: via || '(未标注)',
      task: (el.closest && el.closest('.task')) ? (el.closest('.task').dataset.task || null) : null,
      ownText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      stack: callerFrames(4),
      state: snapshot(),
      extra: extra || null
    };
    records.push(rec);
    if (records.length > MAX) records.splice(0, records.length - MAX);
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](rec); } catch (_) {} }
    return rec;
  }

  // ── ① 先解决"怎么从 classList 找回它属于哪个元素"──
  //
  // ⚠⚠⚠ 2026-10-06 实测踩的坑（第一版就是这样一条都没记到，静默失效）：
  //   DOMTokenList 上【本来有】一个 ownerElement 属性，我按它写的第一版 ——
  //   实跑 `'ownerElement' in el.classList` 是 **false**：这个 Electron 的 Chromium
  //   根本没实现它（那是 DOM 规范里后加的，各浏览器实现不齐）。
  //   于是每次算出来都是 undefined → 认不出元素 → 记录函数当场 return → 面板永远空的。
  //   ⚠ 教训同 docs/134 那批：按印象写了个【存在性没验证过】的接口，
  //     一句错都不报，功能整个不工作。
  //
  // ⇒ 正解：自己去拿。包一层 Element.prototype.classList 的 getter，
  //   每次有人取 classList 就把它和宿主元素记进 WeakMap（WeakMap 不会拖住元素，不泄漏）。
  //   取 list 时顺手 set 一次，代价是一次哈希写入，比抓栈便宜得多。
  var ownerMap = new WeakMap();
  try {
    var elemProto = root.Element && root.Element.prototype;
    var desc = elemProto && Object.getOwnPropertyDescriptor(elemProto, 'classList');
    if (desc && typeof desc.get === 'function' && !desc.get.__v7OwnerTraced) {
      var origClassListGet = desc.get;
      var tracedGet = function () {
        var list = origClassListGet.call(this);
        try { if (list && typeof list === 'object') ownerMap.set(list, this); } catch (_) {}
        return list;
      };
      tracedGet.__v7OwnerTraced = true;
      Object.defineProperty(elemProto, 'classList', {
        get: tracedGet, configurable: true, enumerable: desc.enumerable
      });
    }
  } catch (_) { /* getter 包不上就退化成"只记 via/栈"，不能因此让整个模块挂掉 */ }

  // 从 DOMTokenList 反查宿主元素：能用 ownerElement 就先用（标准实现），否则查 WeakMap
  function elementOf(list) {
    if (!list) return null;
    try { if (list.ownerElement) return list.ownerElement; } catch (_) {}
    try { return ownerMap.get(list) || null; } catch (_) { return null; }
  }

  // ── ② 抓 classList 的真相（唯一的必经之路）──
  var proto = root.DOMTokenList && root.DOMTokenList.prototype;
  if (proto && typeof proto.add === 'function' && !proto.__v7Traced) {
    var origAdd = proto.add, origRemove = proto.remove, origToggle = proto.toggle;

    proto.add = function () {
      var r = origAdd.apply(this, arguments);
      if (arguments.length === 1 && arguments[0] === 'show') record('open', elementOf(this));
      return r;
    };
    proto.remove = function () {
      if (arguments.length === 1 && arguments[0] === 'show') record('close', elementOf(this));
      return origRemove.apply(this, arguments);
    };
    proto.toggle = function () {
      var r = origToggle.apply(this, arguments);
      if (arguments[0] === 'show' && r === false) record('close', elementOf(this));
      else if (arguments[0] === 'show' && r === true) record('open', elementOf(this));
      return r;
    };
    Object.defineProperty(proto, '__v7Traced', { value: true, enumerable: false });
  }

  // ── ② 给几个"主动收"的入口贴名字（栈里看得出是它们，但贴上更直观）──
  function wrapEntry(owner, name) {
    if (!owner || typeof owner[name] !== 'function' || owner[name].__v7Wrapped) return;
    var orig = owner[name];
    var wrapped = function () {
      var prev = via;
      via = name;
      try { return orig.apply(this, arguments); }
      finally { via = prev; }
    };
    wrapped.__v7Wrapped = true;
    try { owner[name] = wrapped; } catch (_) {}
  }
  function wrapKnown() {
    if (root.V7Tween) {
      wrapEntry(root.V7Tween, 'hideBox');
      wrapEntry(root.V7Tween, 'hideBoxIfTask');
      wrapEntry(root.V7Tween, 'leaveTaskCard');
      wrapEntry(root.V7Tween, 'hoverTaskCard');
    }
    // ui.html 里的顶层函数（经典脚本的顶层 function 会挂到 window 上）
    wrapEntry(root, 'clearPreview');
    wrapEntry(root, 'closeAll');
    wrapEntry(root, 'closeZones');
    wrapEntry(root, 'setTasks');
  }
  wrapKnown();
  // V7Tween / clearPreview 在别的脚本里，可能比本文件晚就位 —— 补挂一次
  var lateTries = 0;
  var lateTimer = setInterval(function () {
    wrapKnown();
    if (++lateTries >= 20) clearInterval(lateTimer);
  }, 500);

  // ── 对外接口 ──
  function all() { return records.slice(); }
  function clear() { records = []; seq = 0; return true; }
  function onRecord(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function enabled() { return true; }

  // 给"手动打点"用：实测时想标注"我点了这里"就这么调
  function mark(text) {
    records.push({
      n: ++seq, t: Math.round(performance.now()),
      clock: (function () { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); })(),
      kind: 'mark', target: '·', via: String(text || '').slice(0, 60), task: null, ownText: '',
      stack: [], state: snapshot(), extra: null
    });
    if (records.length > MAX) records.splice(0, records.length - MAX);
  }

  // 纯文本导出（复制给别的对话看）
  function toText() {
    var lines = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      lines.push('#' + r.n + ' ' + r.clock + ' [' + r.kind + '] ' + r.target + ' via=' + r.via +
        (r.task ? (' 任务=' + r.task) : '') +
        ' | 自由=' + r.state.free + ' 分区=' + r.state.zones + ' 三级=' + r.state.detail +
        ' 遮罩=' + r.state.overlay + ' 工作区=' + r.state.embedded + ' 框归属=' + r.state.boxTaskId);
      for (var j = 0; j < r.stack.length; j++) lines.push('     ← ' + r.stack[j]);
    }
    return lines.join('\n') || '(还没有记录)';
  }

  root.V7PreviewTrace = {
    all: all, clear: clear, onRecord: onRecord, enabled: enabled,
    mark: mark, text: toText,
    record: record,
    // 给"我就是想手测某段代码"用的：临时改一次标签
    withVia: function (name, fn) { var prev = via; via = name; try { return fn(); } finally { via = prev; } }
  };

  // ══════════════════════════════════════════════════════════
  //  调试卡里的面板（标记在 ui.html 的 debugMarkup 里）
  // ══════════════════════════════════════════════════════════
  //
  // ⚠ 为什么面板代码放这个文件、不写进 ui.html：
  //   面板和记录器是【同一件事的两半】（一个负责记、一个负责显示），
  //   拆到两个文件里，以后改字段必漏一边（本项目的铁律：一套逻辑只写一处）。
  //   而且 ui.html 是 1.5 万行单文件，能少碰就少碰。
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shortVia(name) {
    return String(name || '').replace(/^V7Tween\./, '');
  }

  function rowHtml(r) {
    var kindCls = r.kind === 'close' ? 'err' : (r.kind === 'open' ? 'ok' : '');
    var who = r.stack.length ? String(r.stack[0]).replace(/^at\s+/, '') : '';
    var lines = [];
    for (var i = 1; i < r.stack.length; i++) lines.push(String(r.stack[i]).replace(/^at\s+/, ''));
    var st = r.state || {};
    var flags = [
      ['自由', st.free], ['分区', st.zones], ['三级', st.detail],
      ['遮罩', st.overlay], ['工作区', st.embedded], ['保持', st.pvKeep],
      ['指针离开', st.pointerAway], ['框归属', st.boxTaskId]
    ].map(function (p) { return esc(p[0]) + ':' + esc(p[1]); }).join(' · ');
    return '<div class="log-entry ' + kindCls + '">'
      + '<div class="log-head"><span>' + esc(r.clock) + ' · ' + esc(r.kind) + ' · ' + esc(r.target)
      + (r.task ? (' · 任务 ' + esc(r.task)) : '') + '</span><span>via=' + esc(shortVia(r.via)) + '</span></div>'
      + '<div class="log-msg"><strong>' + esc(who) + '</strong>'
      + (lines.length ? ('<br>' + lines.map(function (l) { return '← ' + esc(l); }).join('<br>')) : '')
      + '<br><span style="opacity:0.75">' + flags + '</span></div></div>';
  }

  function renderPanel(host) {
    if (!host || !host.isConnected) return;
    var list = host.querySelector('[data-pt-list]');
    var countEl = host.querySelector('[data-pt-count]');
    if (!list) return;
    var all = records.slice().reverse();            // 最新在上
    if (countEl) countEl.textContent = records.length + ' 条';
    list.innerHTML = all.length
      ? all.map(rowHtml).join('')
      : '<div class="devrow"><span>还没有记录</span><span class="dv-val">滑一下任务卡试试</span></div>';
  }

  function mount(host) {
    if (!host || host.dataset.ptReady) return;
    host.dataset.ptReady = '1';
    host.innerHTML =
      '<div class="ai-actions">'
      + '<button class="ai-btn" data-pt-refresh>刷新</button>'
      + '<button class="ai-btn" data-pt-copy>复制记录</button>'
      + '<button class="ai-btn" data-pt-mark>打一个标记</button>'
      + '<button class="ai-btn danger" data-pt-clear>清空记录</button>'
      + '</div>'
      + '<div class="devrow"><span>已记录</span><span class="dv-val" data-pt-count>0 条</span></div>'
      // ⚠ 面板是"随时看着它，然后去滑任务卡"的用法 —— 滑的时候面板在【调试卡的三级】里，
      //   而三级一被别的操作收掉，这块 DOM 就没了。所以列表只在面板活着时渲染。
      + '<div class="log-list" data-pt-list></div>';
    host.querySelector('[data-pt-refresh]').onclick = function (e) { e.stopPropagation(); renderPanel(host); };
    host.querySelector('[data-pt-clear]').onclick = function (e) { e.stopPropagation(); clear(); renderPanel(host); };
    // ⭐ 复制：这份记录就是要【拿出去给人看】的（贴给别的对话 / 存起来），
    //   没有复制键就只能截图，调用栈会糊得看不清，等于白记。
    host.querySelector('[data-pt-copy]').onclick = function (e) {
      e.stopPropagation();
      var text = toText();
      var btn = e.currentTarget, label = btn.textContent;
      var done = function (ok) {
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () { if (btn.isConnected) btn.textContent = label; }, 1200);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          var ok = document.execCommand('copy'); ta.remove(); done(ok);
        }
      } catch (_) { done(false); }
    };
    host.querySelector('[data-pt-mark]').onclick = function (e) {
      e.stopPropagation();
      mark('手动标记（用户点的）');
      renderPanel(host);
    };
    onRecord(function () { renderPanel(host); });
    renderPanel(host);
  }

  // 调试卡一渲染出来就挂上（三级是动态填内容的，所以得盯着）
  function scan() {
    var hosts = document.querySelectorAll('[data-preview-trace]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }
  try {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  root.V7PreviewTrace.mount = mount;
  root.V7PreviewTrace.render = scan;
})(typeof window !== 'undefined' ? window : this);
