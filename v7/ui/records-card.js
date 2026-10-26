/* 记录与恢复卡 · 大二级渲染（照 桌面\记录与恢复_占位验证.html 定稿样机搬）
 *
 * 这一层只管【画】和【手感】，不碰宿主内部：
 *   · 要什么数据 → 走 options.load()（一次拿回 { projects, tasks, checkpoints }）
 *   · 点「复用」/「恢复」/「去开启」 → 走 options 里的回调，由宿主决定怎么干
 *   · 钱怎么算 / 名字怎么取 / 搜索怎么匹配 → 全在 V7RecordsCore（纯逻辑，已单测）
 *
 * ⚠ 和样机的区别：样机用的是自己造的假数据 + 全局单例状态；这里全部收敛进
 *   create() 返回的实例里。同一个页面上同时开两个实例不会互相串（虽然现在只有一个）。
 * ⚠ 滚轮【不在这里挂】—— 二级的滚轮归 ui.html 统一管（它要用现成的"冻结到真停手"
 *   规则，另挂一套必然打架）。这里只暴露 flipPage / stepGallery 给它调。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7RecordsCard = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ⚠⚠ 工厂内部【拿不到外层那个 root】（外层 IIFE 的参数不会自动进到工厂的作用域里，
  //   浏览器里 `root` 更不是全局 —— 它是参数名而已）。2026-09-30 栽过：
  //   cssEscape 里写了 `root.css.escape`，看图时才走到，直接抛 ReferenceError
  //   —— 而且是"平时不报、一进某个分支才炸"的那种。这里自己抓一份全局对象，别再依赖外层。
  var GLOBAL = (typeof window !== 'undefined' && window) || (typeof globalThis !== 'undefined' && globalThis) || {};

  var CORE = (typeof window !== 'undefined' ? window.V7RecordsCore : null) || (typeof require === 'function' ? safeRequire() : null);
  function safeRequire() { try { return require('./records-core.js'); } catch (_) { return null; } }
  function core() {
    if (CORE) return CORE;
    if (typeof window !== 'undefined' && window.V7RecordsCore) { CORE = window.V7RecordsCore; return CORE; }
    return null;
  }

  var SHRINK = 200 / 416;   // 缩小时任务整块的缩放比（416 → 200）
  var PAGE = 8;             // 一页 8 张（2 列 × 4 行）
  var DAY = 86400000;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var DAY_MS = 86400000;

  // 图标走宿主注入的 icon(name, size) —— ui.html 里是 ICON.render。
  // ⚠ 拿不到就退化成空字符串，不要吐图标名当文字（那种"看起来正常其实是坏的"最难查）。
  function icon(name, size) {
    var fn = icon.renderer;
    if (typeof fn !== 'function') return '';
    try { return fn(name, size) || ''; } catch (_) { return ''; }
  }
  icon.setRenderer = function (fn) { icon.renderer = fn; };

  var PATHS = {
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3v4l4 5 4-5V3M8 21v-4l4-5 4 5v4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    folder: '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    ps: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 16V9h2.5a1.8 1.8 0 0 1 0 3.6H9"/>',
    check: '<path d="m5 13 4 4 10-10"/>',
    pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    upload: '<path d="M12 19V6"/><path d="m6 11 6-6 6 6"/>'
  };
  function svg(name, size, width) {
    var d = PATHS[name];
    if (!d) return icon(name, size);
    return '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (width || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  function create(options) {
    options = options || {};
    // ⚠⚠ 回调可以平铺传（{zone, load, onFace, ...}），也可以收在 options.host 里。
    //   2026-09-30 实装时栽过：宿主平铺传了一堆回调，这里只认 options.host，
    //   于是 host 是个空对象 —— load/onFace 全部"不存在"，界面一片空白且【不报任何错】。
    //   典型静默失效。两种形状都认，就再也不会因为"传的位置不对"整卡失灵。
    var host = options.host || options;
    var zone = options.zone;                 // #recordsZone 元素
    var $ = function (sel, scope) { return (scope || zone).querySelector(sel); };
    var $$ = function (sel, scope) { return Array.prototype.slice.call((scope || zone).querySelectorAll(sel)); };

    var state = {
      open: false,
      openedBy: null,
      used: false,
      project: null,        // 当前项目（缓存文件夹名）
      page: 0,
      mode: 'grid',         // 'grid' | 'gallery'
      galleryTask: null,    // 正在看的那一次计算
      picked: Object.create(null),   // 详情里勾选要传回的图（key=张号字符串）
      pickedTask: null,              // 上面那份勾选属于哪一次计算（换任务就清空）
      cp: 'rest',           // 'rest' | 'half' | 'full'
      cpHover: null,
      cpSel: null,
      cpScroll: 0,
      query: '',
      queryWords: [],
      results: null,        // 搜索结果（null = 没在搜）
      queryProject: null,   // 搜索时"只看这个项目"
      flipNotches: 2,
      switchNotches: 10
    };

    var data = { projects: [], rows: [], checkpoints: [] };
    var seq = 0;

    // ── 取数 ─────────────────────────────────────────────
    // 一次拿回全部，然后本地筛选。记录量大时（几千条）也能撑住，
    // 因为渲染永远是"当前这一页 8 张"。
    function reload() {
      if (typeof host.load !== 'function') return Promise.resolve(data);
      var mine = ++seq;
      // ⭐⭐ 2026-09-30 修：每次重读盘都把【负缓存】清掉。
      //   负缓存是“这个文件不存在，别再问”的结论，但它里面的东西是【后来才写出来】的：
      //   canvas_thumb.jpg / thumb_N.jpg 都是生成完成后才落盘的。
      //   卡面在「生成中」时就开着的话，它会把这两个名字记成“没有”，
      //   而 reload() 只重读目录、不清这张表 —— 于是等图真的落盘了，
      //   wantImage() 仍然直接 return ''：用户看到的就是“记录有、时间轴有、就是没图”。
      //   ⚠ 只清「确认没有」，不碰 pending（在路上的请求）和已到货的 URL。
      //   清完不在这里立刻重画 —— render() 自己会重画，而 repaintImages 又有 60ms 合并。
      imageMissing = Object.create(null);
      return Promise.resolve(host.load()).then(function (next) {
        if (mine !== seq || !next) return data;
        data = { projects: next.projects || [], rows: next.rows || [], checkpoints: next.checkpoints || [] };
        render();
        return data;
      }).catch(function (error) {
        if (mine === seq && typeof host.onError === 'function') host.onError(error);
        return data;
      });
    }

    var projectsById = function () {
      var map = new Map();
      data.projects.forEach(function (p) { map.set(p.project, p); });
      return map;
    };

    // 搜索结果 → 命中的行（按项目的分组已经在 core 里做过）
    function searchState() {
      var c = core();
      if (!c || !state.query) return null;
      if (state.results) return state.results;
      state.results = c.searchGroups(data.projects, state.query);
      state.queryWords = c.buildMatcher(state.query).words;
      return state.results;
    }
    function currentProjects() {
      var found = searchState();
      return found || data.projects;
    }
    function currentProject() {
      return projectsById().get(state.project) || null;
    }
    // 当前要铺的任务（搜索时是命中的行；否则是当前项目的行）
    function currentRows() {
      var c = core();
      var found = searchState();
      if (found) {
        var rows = [];
        found.forEach(function (g) {
          var p = projectsById().get(g.project);
          g.rows.forEach(function (r) { rows.push({ row: r, project: p }); });
        });
        if (state.queryProject) rows = rows.filter(function (x) { return x.project && x.project.project === state.queryProject; });
        rows.sort(function (a, b) { return c.startedAt(b.row.meta) - c.startedAt(a.row.meta); });
        return rows;
      }
      var p = currentProject();
      return p ? p.rows.map(function (r) { return { row: r, project: p }; }) : [];
    }
    function pageCount() { return Math.max(1, Math.ceil(currentRows().length / PAGE)); }

    // ── 高亮（搜索命中）────────────────────────────────
    function hl(text) {
      var c = core();
      var words = state.queryWords || [];
      if (!c || !words.length) return esc(text);
      var lower = String(text || '').toLowerCase(), marks = [];
      words.forEach(function (w) {
        var lw = String(w || '').toLowerCase(), i = 0;
        if (!lw) return;
        while ((i = lower.indexOf(lw, i)) >= 0) { marks.push([i, i + lw.length]); i += lw.length; }
      });
      if (!marks.length) return esc(text);
      marks.sort(function (a, b) { return a[0] - b[0]; });
      var merged = [];
      marks.forEach(function (m) {
        var last = merged[merged.length - 1];
        if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
        else merged.push(m.slice());
      });
      var out = '', p = 0;
      merged.forEach(function (m) {
        out += esc(String(text).slice(p, m[0])) + '<mark>' + esc(String(text).slice(m[0], m[1])) + '</mark>';
        p = m[1];
      });
      return out + esc(String(text).slice(p));
    }

    // ── 状态 → 文字 ────────────────────────────────────
    function statusOf(row) {
      var c = core(), meta = (row && row.meta) || {}, status = String(meta.status || '');
      var counts = c ? c.shotCounts(meta) : { ok: 0, fail: 0, sent: 0, total: 1 };
      if (status === 'queued' || status === 'preparing') return { cls: 'run', label: '准备中' };
      if (status === 'running') return { cls: 'run', label: '生成中 ' + (counts.ok + counts.fail) + '/' + counts.total };
      if (status === 'failed') return { cls: 'err', label: '失败' };
      if (status === 'cancelled') return { cls: 'mute', label: '已取消' };
      if (counts.ok > 0 && counts.ok < counts.total) return { cls: 'run', label: '完成 ' + counts.ok + '/' + counts.total };
      return { cls: 'ok', label: '已完成' };
    }
    function isLive(row) {
      var c = core();
      return c ? c.isLiveStatus(String((row && row.meta && row.meta.status) || '')) : false;
    }
    function costOf(meta) { var c = core(); return c ? c.taskCost(meta) : { usd: 0 }; }
    function costHtml(meta) {
      var c = core(), cost = costOf(meta);
      if (cost.free) return '<span class="tc-cost free">本机</span>';
      if (cost.status === 'live') return '<span class="tc-cost free">计费中</span>';
      if (cost.pendingBilling) return '<span class="tc-cost pend">以账单为准</span>';
      if (!cost.usd) return '<span class="tc-cost free">未扣费</span>';
      return '<span class="tc-cost">' + c.formatUsd(cost.usd) + '</span>';
    }

    // 任务缩略图：算完用第一张结果，没算完 / 失败的用整画布封面。
    //
    // ⚠⚠ 取图是【异步】的（宿主走 readFile 拿字节再转 blob URL —— 桌面壳根本没有
    //    "给我个文件 URL" 这种同步接口）。所以这里先用同步的 peek 拿到"已经有了的"，
    //    没有就丢一条请求，等图到货再重画一次。
    //   ⚠ 不这么做只有两条路：要么全白（图永远不显示），要么同步阻塞等 IPC（滚一下卡一下）。
    var imageUrls = Object.create(null);   // key: project/runId/name → blob url
    var imagePending = Object.create(null);
    // ⭐⭐ 负缓存：记下"这个文件不存在"(2026-09-30 性能审阅)。
    //   ⚠⚠ 原来只缓存成功、不缓存失败 —— 于是每重画一次就重新去问一遍不存在的文件。
    //   实测（6 项目 × 12 次计算）：252 次 readFile 里 72 次是白问的（浪费 29%），
    //   全是 canvas_thumb.jpg（问 108 次、只有 36 次真有）。
    //   每次白问都是一趟 IPC + 一次空字节返回，重画又触发新一轮 → 卡顿的主要来源之一。
    var imageMissing = Object.create(null);
    var imageEpoch = 0;

    function imageKey(project, runId, name) { return project + '\u0000' + runId + '\u0000' + name; }
    function peekImage(project, runId, name) {
      return imageUrls[imageKey(project, runId, name)] || '';
    }
    // 'have' 已到货 / 'pending' 在路上 / 'missing' 确认没有 / 'idle' 还没问过
    function imageState(project, runId, name) {
      var key = imageKey(project, runId, name);
      if (imageUrls[key]) return 'have';
      if (imageMissing[key]) return 'missing';
      if (imagePending[key]) return 'pending';
      return 'idle';
    }
    function wantImage(project, runId, name) {
      var key = imageKey(project, runId, name);
      var have = imageUrls[key];
      if (have) return have;
      if (imageMissing[key]) return '';      // ⭐ 问过、没有 —— 别再问
      if (imagePending[key] || typeof host.loadImage !== 'function') return '';
      imagePending[key] = true;
      var mine = imageEpoch;
      Promise.resolve(host.loadImage(project, runId, name)).then(function (url) {
        delete imagePending[key];
        if (mine !== imageEpoch) return;
        // ⭐ 记下来，之后一律不再发请求。
        // ⚠⚠ 问空了【也要排一次重画】：pickImage 一次只问一个候选，
        //   不重画就没人去问下一个 → 没有 canvas_thumb 的项目封面永远是空的（改完实测抓到的）。
        if (!url) { imageMissing[key] = true; repaintImages(); return; }
        imageUrls[key] = url;
        // 到货 → 只重画当前这一页，不动别的状态
        repaintImages();
      }).catch(function () { delete imagePending[key]; imageMissing[key] = true; });
      return '';
    }
    // ⭐ 在一串候选里挑一张，避免"一次性把候选全发出去"。
    //   ⚠⚠ 这是上一条浪费的第二个来源（2026-09-30）：thumbUrl() 里
    //     `A() || B() || C()` 这种写法，在 A 还在路上时 A 返回 ''，于是立刻又去问 B、C ——
    //     一张卡一次重画就发出 4 个请求，而它其实只需要 1 个。
    //   现在的规矩：① 有到货的就用；② 否则只要有人在路上就【等它】；
    //   ③ 全都还没问过时，只发起【第一个候选】，剩下的等它失败再说。
    function pickImage(candidates) {
      var i, c;
      for (i = 0; i < candidates.length; i++) {
        c = candidates[i];
        if (imageState(c[0], c[1], c[2]) === 'have') return imageUrls[imageKey(c[0], c[1], c[2])];
      }
      for (i = 0; i < candidates.length; i++) {
        c = candidates[i];
        if (imageState(c[0], c[1], c[2]) === 'pending') return '';   // 等它，别急着问下一个
      }
      for (i = 0; i < candidates.length; i++) {
        c = candidates[i];
        if (imageState(c[0], c[1], c[2]) === 'idle') { wantImage(c[0], c[1], c[2]); return ''; }
      }
      return '';
    }
    function releaseImages() {
      imageEpoch++;
      if (typeof host.releaseImage === 'function') {
        Object.keys(imageUrls).forEach(function (key) {
          try { host.releaseImage(imageUrls[key]); } catch (_) {}
        });
      }
      imageUrls = Object.create(null);
      imagePending = Object.create(null);
      imageMissing = Object.create(null);   // ⭐ 跟正缓存一起清，否则换了账号还在用旧结论
    }
    var repaintTimer = 0;
    function repaintImages() {
      // 合并同一批到货的图，一次重画（一次 200 张的相册会连续通知十几次）
      if (repaintTimer) return;
      repaintTimer = setTimeout(function () {
        repaintTimer = 0;
        if (!zone) return;
        // ⭐ 一级卡面的项目封面也靠这里更新（原来只重画二级，封面要等别的事件碰巧触发才出来）
        renderMainFace();
        if (!state.open) return;
        // ⭐ 看图时【就地换图】，不整页重画（重画会打断飞行动画、清掉 hover，还会闪）。
        //   ⚠ 原来这里直接 return —— 于是详情一打开时缩略图还没到，格子显示的是项目封面，
        //     到货后也永远换不过来（用户看到的就是"图不对/后来又变了"那种感觉）。
        if (state.mode === 'gallery') { patchGalleryImages(); return; }
        // ⭐ 2026-10-13：网格模式也改成就地换图（理由见 patchGridImages 的注释）。
        //   ⚠ 只有【这一页一张图都没换到】时才退回整页重画 —— 那种情况是"当前页的缩略图
        //     全都没有、需要顺位问下一个候选"，得让 cardHtml 重跑一次才会去问（老行为）。
        if (patchGridImages()) return;
        renderPage(0);
      }, 60);
    }

    function thumbUrl(item) {
      var meta = item.row.meta, project = item.row.project, runId = item.row.runId;
      var counts = core().shotCounts(meta);
      var cands = [];
      if (!isLive(item.row) && meta.status !== 'failed' && counts.ok > 0) {
        var shot = (meta.shots || []).findIndex(function (s) { return s && s.done && s.hasImage; });
        cands.push([project, runId, 'thumb_' + ((shot >= 0 ? shot : 0) + 1) + '.jpg']);
      }
      cands.push([project, runId, 'canvas_thumb.jpg']);
      cands.push([project, runId, 'input_thumb.jpg']);
      cands.push([project, runId, 'thumb_1.jpg']);
      return pickImage(cands);
    }
    function projectCoverUrl(project) {
      var rows = project.rows || [], cands = [], i;
      // ⚠ 顺序不能反：先问 canvas_thumb（整画布，最准），再退 input，最后才 thumb_1。
      //   反过来会让"点下计算那一刻"显示成上一张结果，和用户要的"整张画布立刻出现"对不上。
      // ⚠⚠ 但【别用 for 循环 + wantImage 一路问下去】(2026-09-30 性能审阅)：
      //   那样一个 12 次计算的项目会一次并发发出 12→24→36 个 readFile，
      //   5 个项目条叠起来就是上百个并发 IPC —— 打开卡那一下的卡顿主要来自这里。
      //   现在交给 pickImage：挑一张、只发一个请求，其余等它失败再顺位。
      for (i = 0; i < rows.length; i++) cands.push([project.project, rows[i].runId, 'canvas_thumb.jpg']);
      for (i = 0; i < rows.length; i++) cands.push([project.project, rows[i].runId, 'input_thumb.jpg']);
      for (i = 0; i < rows.length; i++) cands.push([project.project, rows[i].runId, 'thumb_1.jpg']);
      return pickImage(cands);
    }

    // 一次计算的标题 / 副标题
    function titleText(meta) {
      var c = core();
      return c ? c.taskLabel(meta) : String(meta.label || '');
    }
    function metaLine(item) {
      var c = core(), meta = item.row.meta;
      var counts = c.shotCounts(meta);
      var when = c.whenLabel(c.startedAt(meta));
      if (state.results) return hl(item.project ? item.project.label : '') + ' · ' + when;
      var isLocal = c.isLocalToolKind(String(meta.kind || '')) || c.isLocalCompute(meta);
      // ⭐ 2026-10-02 融合方案-C01 R9（用户：「历史记录的那个卡片也要做对应的改动」）：
      //   这一单带没带参考图、带了几张。数字来自缓存元数据 referenceCount（R4 落盘时记的）。
      //   ⚠ 没带就【不显示】—— 不写「参考图 0」，那一行本来就挤。老记录没有这个字段，也按没带处理。
      var refs = Number(meta.referenceCount) || 0;
      return (isLocal ? '本机' : counts.total + ' 张') + (refs > 0 ? ' · 参考图 ' + refs : '') + ' · ' + when;
    }
    // 搜索命中的词只在提示词里（标题上看不到）→ 多露一行
    function snipHtml(meta) {
      if (!state.results || !state.queryWords.length) return '';
      var label = String(meta.label || ''), prompt = String(meta.prompt || '');
      if (!prompt) return '';
      var ll = label.toLowerCase(), lp = prompt.toLowerCase();
      var word = state.queryWords.find(function (w) { return lp.indexOf(String(w).toLowerCase()) >= 0 && ll.indexOf(String(w).toLowerCase()) < 0; });
      if (!word) return '';
      var at = Math.max(0, lp.indexOf(String(word).toLowerCase()) - 4);
      return '<div class="tc-snip">…' + hl(prompt.slice(at, at + 16)) + '…</div>';
    }

    function reuseHint(meta) {
      var kind = String(meta.kind || 'generation');
      if (kind === 'generation' && meta.workflowPresetId) return '复用这个工作流（这次的参数一起带上）';
      if (kind === 'glow' || kind === 'dlss') return '用这次的参数再开一次';
      if (String(meta.prompt || '').trim()) return '把这段提示词填回输入框';
      return '打开同一个工具';
    }

    // ══ 一级卡面（在 ui.html 里单独挂，不在这里画）════════
    // 这里只算它要的数字，画法交给宿主。

    // ══ 二级：任务卡 ═══════════════════════════════════
    function cardHtml(item, index, total) {
      var c = core(), meta = item.row.meta;
      var col = index < 4 ? 0 : 1, row = index % 4;
      var last = col === 0 ? Math.min(total, 4) - 1 : total - 5;
      var st = statusOf(item.row), live = isLive(item.row);
      var bad = meta.status === 'failed' || (meta.status === 'cancelled' && c.shotCounts(meta).ok === 0);
      var snip = snipHtml(meta);
      var counts = c.shotCounts(meta);
      var img = thumbUrl(item);
      var bar = (meta.status === 'running' || (counts.ok > 0 && counts.ok < counts.total))
        ? '<div class="tc-bar' + (meta.status === 'running' ? ' sweep' : '') + '">'
          + '<i class="ok" style="width:' + (counts.ok / counts.total * 100) + '%"></i>'
          + '<i class="err" style="width:' + (counts.fail / counts.total * 100) + '%"></i></div>'
        : '';
      var time = c.clockLabel(c.startedAt(meta));
      return '<div class="tcard zcard' + (row === 0 ? ' row-top' : '') + (row === last ? ' row-bottom' : '') + (bad ? ' gray' : '') + (snip ? ' tall' : '') + '" data-row="' + esc(item.row.runId) + '" data-project="' + esc(item.row.project) + '">'
        + '<div class="tc-img" data-bg="' + esc(img) + '" style="background-image:url(' + esc(img) + ')"></div>'
        + '<div class="tc-scrim"></div><div class="z-glow"></div><div class="z-bright"></div><div class="z-selglow"></div>'
        + (live ? '<div class="tc-hg">' + svg('hourglass', 20) + '</div>' : '')
        + (meta.status === 'failed' ? '<div class="tc-x">' + svg('x', 24, 2.6) + '</div>' : '')
        + '<div class="tc-top"><span class="st ' + st.cls + '">' + esc(st.label) + '</span>'
        + '<span class="tc-shield" title="已在这个检查点里">' + svg('shield', 12, 2.4) + '</span>'
        + '<button class="tc-reuse" data-act="reuse-task" title="' + esc(reuseHint(meta)) + '">' + svg('restore', 12, 2.2) + '复用</button></div>'
        + '<div class="tc-bottom"><div class="tc-text" title="' + esc(titleText(meta)) + '">'
        + '<div class="tc-title' + (String(meta.label || '') === '自定义提示词' ? ' custom' : '') + '">' + hl(titleText(meta)) + '</div>'
        + snip + '<div class="tc-meta">' + metaLine(item) + '</div></div>' + costHtml(meta) + '</div>'
        + '<div class="tc-big">' + esc(time) + '</div><div class="tc-bigshield">' + svg('shield', 24, 2.4) + '</div>' + bar
        + '<div class="gate-edge top"></div><div class="gate-edge bottom"></div></div>';
    }
    function gridHtml(page) {
      var pg = page == null ? state.page : page;
      var items = currentRows().slice(pg * PAGE, pg * PAGE + PAGE);
      if (!items.length) {
        return '<div class="rc-grid"><div class="rc-empty"><div>' + (state.results ? '没有匹配的任务' : '这个项目还没有任务') + '</div><small>' + (state.results ? '试试：修脸 · 海边 · 昨天 · 09-28' : '点一次计算，这里就会出现整张画布') + '</small></div></div>';
      }
      return '<div class="rc-grid">' + items.map(function (item, i) { return cardHtml(item, i, items.length); }).join('') + '</div>';
    }

    // ══ 二级：点一次计算 → 全部图平铺 ═══════════════════
    function shotsOf(meta) {
      var c = core(), counts = c.shotCounts(meta), total = counts.total, out = [];
      var pending = isLive({ meta: meta });
      for (var i = 0; i < total; i++) {
        out.push({
          index: i,
          state: i < counts.ok ? 'ok' : i < counts.ok + counts.fail ? 'fail' : pending ? 'wait' : 'cancel',
          hasImage: !!(meta.shots && meta.shots[i] && meta.shots[i].hasImage)
        });
      }
      return out;
    }
    function galleryHtml() {
      var c = core(), item = currentRows().find(function (x) { return x.row.runId === state.galleryTask; });
      if (!item) return '';
      var meta = item.row.meta, shots = shotsOf(meta), n = shots.length;
      var cols = n <= 1 ? [1, 1] : n === 2 ? [2, 1] : n <= 4 ? [2, 2] : n <= 6 ? [3, 2] : [4, 2];
      var cost = costOf(meta);
      var tiles = shots.map(function (s) {
        // ⚠ 走 wantImage（异步取图的同步入口）。改名前这里还叫 imageUrl，
        //   改名时漏了这两处 → 一看图就抛 ReferenceError（2026-09-30 截图抓到的）。
        // ⚠⚠ 原来这里【无条件】再请求一次 output_N.png（原图，几 MB 的 PNG）——
        //   缩略图到了也照拉不误，9 张图就是 9 张原图变成 blob 挂在内存里（2026-09-30 性能审阅）。
        //   现在交给 pickImage：先缩略图，只有缩略图真的不存在时才退到原图。
        var cands = [[item.row.project, item.row.runId, 'thumb_' + (s.index + 1) + '.jpg']];
        if (s.state === 'ok') cands.push([item.row.project, item.row.runId, 'output_' + (s.index + 1) + '.png']);
        var bg = pickImage(cands) || projectCoverUrl(item.project);
        var tag = s.state === 'fail' ? '<div class="tag">' + svg('x', 22, 2.4) + '<span>这张失败了</span></div>'
          : s.state === 'cancel' ? '<div class="tag" style="color:var(--tx2)">' + svg('x', 22, 2.4) + '<span>已取消</span></div>'
            : s.state === 'wait' ? '<div class="tag">' + svg('hourglass', 22) + '<span>还在算</span></div>'
              // ⚠⚠ 这两个按钮【必须只放图标，不能放文字】(2026-09-30 用户实测"文字出框了")：
              //   9 张图时格子只有 92px 宽、按钮各自 34px，而「看大图」四个字在 34px 里
              //   被折成【3 行】、纵向溢出 +26px（比按钮本身 24px 还高）→ 字直接冒到框外。
              //   图标没有这个问题，任何格子宽度都稳。文字靠 title 提示（鼠标悬停能看到）。
              // ⭐ 2026-10-04 用户定案：删掉「看大图」按钮 —— 看大图直接在预览框里看。
              //   ⚠ 保留 data-act="big" 的处理分支（下面那处），因为别的入口可能还在用；
              //     这里只是不再给按钮。少一个按钮，格子在窄的时候也松快。
              : '<div class="acts">'
              + '<button data-act="send" title="只传回这一张">' + svg('upload', 14) + '</button>'
              + '</div>';
        // ⭐ 右上角多选框（用户 2026-09-30 定：每张图右上角一个小 ✓ 就能多选传回）
        //   ⚠ 只有【真的有图】的格子才给勾选框 —— 失败/在算/已取消的勾了也传不回去。
        var pickable = s.state === 'ok' && s.hasImage;
        var box = pickable
          ? '<button class="pick" data-act="pick" title="勾选这张（可多选后一起传回）" aria-pressed="' + (isPicked(s.index) ? 'true' : 'false') + '">'
          + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4 10-10"/></svg></button>'
          : '';
        return '<div class="gtile' + (s.state === 'ok' ? '' : s.state === 'wait' ? ' wait' : ' fail')
          + (pickable ? ' pickable' : '') + (isPicked(s.index) ? ' picked' : '')
          + '" data-shot="' + s.index + '">'
          + '<div class="bgblur" style="background-image:url(' + esc(bg) + ')"></div>'
          + '<div class="fg" style="background-image:url(' + esc(bg) + ')"></div>'
          + '<span class="idx">' + (s.index + 1) + '</span>' + box + tag + '</div>';
      }).join('');
      var m = cost.free ? '本机' : cost.status === 'live' ? '计费中' : cost.pendingBilling ? '以账单为准' : c.formatUsd(cost.usd);
      var picked = pickedIndexes();
      // 勾了图 → 胶囊条上多出一条「传回选中 N 张」；没勾就不占地方
      var sendPicked = picked.length
        ? '<button class="send-picked" data-act="send-picked" title="把勾选的 ' + picked.length + ' 张一起传回 PS">'
        + svg('upload', 13) + '<span>传回 ' + picked.length + ' 张</span></button>'
        : '';
      return '<div class="gal"><div class="gal-grid" style="grid-template-columns:repeat(' + cols[0] + ',1fr);grid-template-rows:repeat(' + cols[1] + ',1fr)">' + tiles + '</div>'
        + '<div class="gal-bar"><button data-act="back" title="返回（Esc）">' + svg('back', 15) + '</button>'
        + '<span class="t">' + esc(titleText(meta)) + '</span><span class="m">' + esc(n + ' 张 · ' + m) + '</span>'
        + sendPicked
        + '<button data-act="restore" title="恢复到任务栏">' + svg('restore', 14) + '</button>'
        // ⭐ 2026-10-06 用户要的：打开这次计算的缓存文件夹（跟"恢复"并排）
        + '<button data-act="folder" title="打开这次计算的缓存文件夹">' + svg('folder', 14) + '</button>'
        + (String(meta.prompt || '') ? '<button data-act="reuse" title="只用提示词">' + svg('pencil', 14) + '</button>' : '')
        + '</div></div>';
    }
    // 详情格子就地换图：只改 .bgblur / .fg 的背景，不动 DOM 结构（勾选、hover、按钮都不受影响）
    function patchGalleryImages() {
      var item = currentRows().find(function (x) { return x.row.runId === state.galleryTask; });
      if (!item) return;
      $$('.gtile[data-shot]').forEach(function (tile) {
        var i = Number(tile.dataset.shot);
        var cands = [[item.row.project, item.row.runId, 'thumb_' + (i + 1) + '.jpg']];
        if (!tile.classList.contains('fail') && !tile.classList.contains('wait')) cands.push([item.row.project, item.row.runId, 'output_' + (i + 1) + '.png']);
        var bg = pickImage(cands);
        if (!bg || tile.dataset.bg === bg) return;
        tile.dataset.bg = bg;
        var css = 'url(' + bg + ')';
        var blur = tile.querySelector('.bgblur'), fg = tile.querySelector('.fg');
        if (blur) blur.style.backgroundImage = css;
        if (fg) fg.style.backgroundImage = css;
      });
    }
    // ⭐ 2026-10-13：网格模式的【就地换图】—— 补齐 patchGalleryImages 缺的那一半。
    //   ⚠⚠ 原来网格模式走 renderPage(0)（整页 innerHTML 重建）：每张缩略图到货就把整页
    //     4 张卡全部销毁重建、background-image 重新解码。用户 2026-10-04 报的
    //     「项目 → 多次计算 → 点开某一次，非常严重的卡顿和不跟手」根因主要就在这里：
    //     一页 4 张卡 × 每张的图各到一次 = 最多 4 次整页重建，全砸在点开那一下。
    //   ⚠ 只换图，别的什么都不动：不清 hover、不打断飞行动画、不重排、不重建 DOM。
    //   ⚠ 走 thumbUrl（内部是 pickImage 的"挑一张、等它、失败再顺位"），所以
    //     "问空了要接着问下一个候选"那条老行为照旧成立。
    //   返回 true = 至少换掉一张图（调用方就不用再整页重画了）。
    function patchGridImages() {
      var rows = currentRows(), changed = false, byKey = Object.create(null), i;
      for (i = 0; i < rows.length; i++) byKey[rows[i].row.project + '\u0000' + rows[i].row.runId] = rows[i];
      $$('.tcard[data-row]', zone).forEach(function (el) {
        var item = byKey[el.dataset.project + '\u0000' + el.dataset.row];
        if (!item) return;
        var holder = el.querySelector('.tc-img');
        if (!holder) return;
        var bg = thumbUrl(item);
        if (!bg || holder.dataset.bg === bg) return;
        holder.dataset.bg = bg;
        holder.style.backgroundImage = 'url(' + bg + ')';
        changed = true;
      });
      return changed;
    }
    // ══ 多选（勾选要传回的图）══════════════════════════════
    // ⚠ 选中状态【按任务分开存】（key = runId），切到别的一次计算不该继承上一个的勾选。
    //   而且它只是"待传回清单"，不写进缓存、不跨会话 —— 关掉二级就清。
    function pickedSet() {
      if (!state.pickedTask || state.pickedTask !== state.galleryTask) {
        state.pickedTask = state.galleryTask;
        state.picked = Object.create(null);
      }
      return state.picked;
    }
    function isPicked(index) { return !!pickedSet()[String(index)]; }
    function pickedIndexes() {
      var set = pickedSet(), out = [];
      Object.keys(set).forEach(function (k) { if (set[k]) out.push(Number(k)); });
      return out.sort(function (a, b) { return a - b; });
    }
    function togglePick(index) {
      var set = pickedSet();
      var key = String(index);
      if (set[key]) delete set[key]; else set[key] = true;
    }
    function clearPicks() { state.pickedTask = null; state.picked = Object.create(null); }
    // 只更新胶囊条上那个"传回 N 张"按钮，不重画整个详情。
    // ⚠ 勾选是高频操作（用户会连点好几张），整页重画会让每一下都闪一次、还会打断 hover。
    function refreshPickedButton() {
      var bar = $('.gal-bar');
      if (!bar) return;
      var btn = bar.querySelector('[data-act="send-picked"]');
      var picked = pickedIndexes();
      if (!picked.length) { if (btn) btn.remove(); return; }
      var label = '传回 ' + picked.length + ' 张';
      if (btn) {
        var span = btn.querySelector('span');
        if (span) span.textContent = label;
        btn.title = '把勾选的 ' + picked.length + ' 张一起传回 PS';
        return;
      }
      // 还没有这个按钮 → 插在"张数·金额"和"恢复"之间
      btn = document.createElement('button');
      btn.className = 'send-picked';
      btn.dataset.act = 'send-picked';
      btn.title = '把勾选的 ' + picked.length + ' 张一起传回 PS';
      btn.innerHTML = svg('upload', 13) + '<span>' + label + '</span>';
      var anchor = bar.querySelector('[data-act="restore"]');
      if (anchor) bar.insertBefore(btn, anchor); else bar.appendChild(btn);
    }

    // ══ 二级：右侧检查点时间轴 ═════════════════════════
    function railProject() {
      var c = core();
      if (state.mode === 'gallery' && state.galleryTask) {
        var item = currentRows().find(function (x) { return x.row.runId === state.galleryTask; });
        return item ? item.project : null;
      }
      if (state.results) return state.queryProject ? projectsById().get(state.queryProject) || null : null;
      return currentProject();
    }
    function sortedCps(project) {
      var c = core();
      if (!project) return [];
      return c.checkpointsForProject(data.checkpoints, project.project);
    }
    function renderRail() {
      var box = $('.rail-in');
      if (!box) return;
      var c = core(), project = railProject(), head, body;
      if (!project) {
        var n = state.results ? currentRows().length : 0;
        var named = 0;
        if (state.results) state.results.forEach(function (g) {
          g.rows.forEach(function () { named++; });
        });
        head = '<div class="rail-head">搜索<small>' + n + '</small></div>';
        body = '<div class="rail-search"><div><b>' + named + '</b>条结果</div>'
          + '<div class="rail-note">点开左边任一结果，这里就换成那个项目的检查点。</div></div>';
      } else {
        var list = sortedCps(project);
        var enabled = typeof host.checkpointEnabled === 'function' ? !!host.checkpointEnabled() : true;
        var interval = typeof host.checkpointIntervalMin === 'function' ? Number(host.checkpointIntervalMin()) || 5 : 5;
        if (!enabled || !list.length) {
          head = '<div class="rail-head">检查点<small>0</small></div>';
          body = '<div class="rail-empty"><div class="re-track"></div><div class="re-fly"></div><div class="re-zz">z z</div>'
            + '<div class="re-text">' + (enabled ? '还没有检查点' : '检查点没开') + '<small>'
            + (enabled ? '下次生成前<br>会自动存一次' : '开了以后每 ' + interval + ' 分钟<br>自动存一次整张画布') + '</small></div>'
            + (enabled ? '' : '<button class="re-btn" data-act="cp-enable">去开启</button>') + '</div>';
        } else {
          var last = null, nodes = '';
          list.forEach(function (cp) {
            var dl = c.dayLabel(cp.time);
            if (dl !== last) { nodes += '<div class="rail-day">' + esc(dl) + '</div>'; last = dl; }
            nodes += '<div class="cpn" data-cp="' + esc(cp.raw.cacheRef || cp.time) + '" title="' + esc(c.whenLabel(cp.time) + ' 的整张画布') + '"><i></i><span>' + esc(c.clockLabel(cp.time)) + '</span></div>';
          });
          head = '<div class="rail-head">检查点<small>' + list.length + '</small></div>';
          body = '<div class="rail-list"><div class="rail-nodes">' + nodes + '</div></div>';
        }
      }
      box.innerHTML = head + body + '<div class="rail-foot"></div>';
      renderRailFoot();
      syncRail();
    }
    function renderRailFoot() {
      var f = $('.rail-foot');
      if (!f) return;
      // ⭐ 2026-09-30 用户定案：时间轴列表是【检查点】时，底部那排页码整块不显示。
      //   检查点一多，一页放不下，那排「N / M 页 + 小圆点」既没用又占地方
      //   （用户原话："检查点最底下的页码消失掉"）。
      //   ⚠ 只对检查点列表生效；画廊（第 N/M 次）和下面那条页码保持原样。
      if (state.mode === 'gallery') {
        var list = currentRows(), i = list.findIndex(function (x) { return x.row.runId === state.galleryTask; });
        f.innerHTML = '<span>第 ' + (i + 1) + '/' + list.length + ' 次</span>';
        return;
      }
      var proj = railProject();
      var showingCheckpoints = !state.results && proj && sortedCps(proj).length > 0;
      if (showingCheckpoints) { f.innerHTML = ''; f.hidden = true; return; }
      f.hidden = false;
      var n = pageCount(), dots = '';
      if (n <= 8) for (var i = 0; i < n; i++) dots += '<i' + (i === state.page ? ' class="on"' : '') + '></i>';
      f.innerHTML = '<span>' + (state.page + 1) + ' / ' + n + ' 页</span><span class="pg-dots">' + dots + '</span>';
    }
    function syncRail() {
      $$('.cpn').forEach(function (node) {
        node.classList.toggle('hover', node.dataset.cp === state.cpHover);
        node.classList.toggle('sel', node.dataset.cp === state.cpSel);
      });
    }

    // ══ 检查点：rest 不动 / half 悬停预览 / full 点下固定 ══
    function cpIndex(id) {
      var project = railProject();
      if (!project) return -1;
      return sortedCps(project).findIndex(function (cp) { return (cp.raw.cacheRef || cp.time) === id; });
    }
    function cpById(id) {
      var project = railProject();
      if (!project) return null;
      return sortedCps(project).find(function (cp) { return (cp.raw.cacheRef || cp.time) === id; }) || null;
    }
    function setCp(next, id, dir) {
      var prev = state.cp, prevId = state.cpSel || state.cpHover;
      state.cp = next;
      if (next === 'rest') { state.cpHover = null; state.cpSel = null; }
      else if (next === 'half') { state.cpHover = id; state.cpSel = null; }
      else { state.cpSel = id; state.cpHover = null; }
      var main = $('.rc-main'), pages = $('.rc-pages');
      if (!main || !pages) return;
      main.classList.toggle('cp', next !== 'rest');
      main.classList.toggle('pinned', next === 'full');
      if (next === 'rest') {
        state.cpScroll = 0;
        pages.classList.remove('shrunk');
        $$('.rc-extra', pages).forEach(function (el) { el.classList.add('leaving'); setTimeout(function () { el.remove(); }, 140); });
      } else {
        var detail = $('.rc-detail'), html = detailHtml(id, next), slide = detail.querySelector('.cpd-slide');
        if (prev === 'rest' || !slide) detail.innerHTML = '<div class="cpd zcard"><div class="cpd-slide">' + html + '</div></div>';
        else if (prevId !== id) swapInto(slide, html, dir || (cpIndex(id) > cpIndex(prevId) ? 1 : -1));
        else slide.innerHTML = html;
        pages.classList.add('shrunk');
        renderExtras(next === 'full');
        if (next === 'full') scrollToBoundary(id); else state.cpScroll = 0;
      }
      applyShrink();
      applyLinked();
      syncRail();
    }
    function applyShrink(fast) {
      var pages = $('.rc-pages');
      if (!pages) return;
      pages.style.transition = fast ? 'transform .12s linear' : '';
      pages.style.transform = state.cp === 'rest' ? '' : 'translateY(' + (-state.cpScroll) + 'px) scale(' + SHRINK + ')';
    }
    // 悬停：只续上下一页；固定：这个项目的每一页都铺出来
    function renderExtras(all) {
      var pages = $('.rc-pages');
      if (!pages) return;
      var n = pageCount(), want = [];
      for (var k = 0; k < n; k++) if (k !== state.page && (all || k === state.page + 1)) want.push(k);
      $$('.rc-extra', pages).forEach(function (el) {
        if (want.indexOf(Number(el.dataset.page)) < 0 || el.classList.contains('leaving')) el.remove();
      });
      var have = new Set($$('.rc-extra', pages).map(function (el) { return Number(el.dataset.page); }));
      want.forEach(function (k) {
        if (have.has(k)) return;
        var el = document.createElement('div');
        el.className = 'rc-extra';
        el.dataset.page = String(k);
        el.style.top = ((k - state.page) * 416) + 'px';
        el.innerHTML = gridHtml(k);
        pages.appendChild(el);
      });
    }
    function cpScrollRange() {
      var n = pageCount();
      return [-state.page * 416 * SHRINK, Math.max(0, ((n - state.page) * 416 - 16) * SHRINK - 400)];
    }
    // 固定时自动滚到「之前 / 之后」的交界
    function scrollToBoundary(id) {
      var cp = cpById(id);
      if (!cp) { state.cpScroll = 0; return; }
      var rows = currentRows();
      var at = rows.findIndex(function (x) { return core().completedAt(x.row.meta) <= cp.time; });
      if (at < 0) { state.cpScroll = 0; return; }
      var page = Math.floor(at / PAGE), row = (at % PAGE) % 4;
      var y = ((page - state.page) * 416 + row * 104) * SHRINK;
      var range = cpScrollRange();
      state.cpScroll = Math.max(range[0], Math.min(range[1], y - 150));
    }
    function detailHtml(id, mode) {
      var c = core(), cp = cpById(id), project = railProject();
      if (!cp || !project) return '';
      var raw = cp.raw, cover = projectCoverUrl(project);
      var rows = project.rows || [];
      var before = rows.filter(function (r) { return c.completedAt(r.meta) <= cp.time; }).length;
      var after = rows.length - before;
      var size = Number(raw.sizeBytes) || 0;
      var secs = (Number(raw.durationMs) || 0) / 1000;
      return '<div class="cpd-in"><div class="cpd-img"><div class="bgblur" style="background-image:url(' + esc(cover) + ')"></div><div class="fg" style="background-image:url(' + esc(cover) + ')"></div></div>'
        + '<div class="cpd-time">' + esc(c.whenLabel(cp.time)) + '</div>'
        + '<div class="cpd-doc">' + esc(project.docName || project.label) + '</div>'
        + '<div class="cpd-rows"><span>画布</span><b>' + (Number(raw.width) || '—') + ' × ' + (Number(raw.height) || '—') + '</b>'
        + '<span>文件</span><b>PNG' + (size ? ' · ' + (size / 1048576).toFixed(1) + ' MB' : '') + '</b>'
        + '<span>保存用时</span><b>' + (secs ? secs.toFixed(1) + ' 秒' : '—') + '</b></div>'
        + '<div class="cpd-stats"><span class="in"><i></i>之前 <b>' + before + '</b> 次</span><span class="out"><i></i>之后 <b>' + after + '</b> 次</span></div>'
        // ⭐ 2026-09-30 用户定案：这两个按钮【常驻】。
        //   以前只有点下去固定(full)才出，悬停预览(half)显示的是"点一下节点 · 固定并操作"的提示。
        //   用户的原话：「我选中哪个卡片，哪个卡片下面就有那两个按钮」——
        //   沿时间轴上下移动切卡片时，按钮就跟着那张卡一起出来，不用再点一下。
        //   ⚠ 「收起（Esc）」那颗按钮【去掉】：退出改成点左边空白处，或按 Esc（见 bindZone）。
        //   ⚠⚠ 「在 PS 中打开」那颗也【去掉了】（2026-09-30 用户定案）。
        //     用户的理由：会用到时间轴恢复的场面，就是【项目已经炸了】的时候；
        //     项目炸了就不可能还有个好的 PS 项目在那等着被“打开”。
        //     所以这里只留「打开所在文件夹」，让用户自己拿文件。
        //     ⚠ 它现在是唯一的动作 → 改成 primary（不然详情页底下会只剩一颗灏按钮，看着像没启用）。
        + '<div class="cpd-acts"><button class="cpd-btn primary" data-act="cp-folder">' + svg('folder', 14) + '打开所在文件夹</button></div>'
        + '</div>';
    }
    // 联动：检查点之前算完的 = 已备份（紫框+盾牌）；之后的 = 变灰；交界那张顶上紫线
    function applyLinked() {
      var c = core(), id = state.cpSel || state.cpHover, cp = id ? cpById(id) : null, first = null, firstTime = 0;
      $$('.tcard[data-row]', zone).forEach(function (el) {
        var found = currentRows().find(function (x) { return x.row.runId === el.dataset.row && x.row.project === el.dataset.project; });
        if (!found) { el.classList.remove('cp-covered', 'cp-after', 'cp-first'); return; }
        var on = !!cp && found.row.project === cp.project;
        var inside = on && c.completedAt(found.row.meta) <= cp.time;
        el.classList.toggle('cp-covered', inside);
        el.classList.toggle('cp-after', on && !inside);
        el.classList.remove('cp-first');
        if (inside) {
          var t = c.completedAt(found.row.meta);
          if (!first || t > firstTime) { first = el; firstTime = t; }
        }
      });
      if (first) first.classList.add('cp-first');
    }
    // 反向联动：鼠标停在一次计算上 → 时间轴上"第一个包含它的检查点"闪一下
    function coveringCp(meta) {
      var c = core(), project = railProject();
      if (!project) return null;
      var at = c.completedAt(meta);
      return sortedCps(project).filter(function (cp) { return cp.time >= at; })
        .sort(function (a, b) { return a.time - b.time; })[0] || null;
    }
    function linkNode(runId) {
      $$('.cpn.linked').forEach(function (n) { n.classList.remove('linked'); });
      if (!runId || state.cp !== 'rest') return;
      var found = currentRows().find(function (x) { return x.row.runId === runId; });
      var cp = found && coveringCp(found.row.meta);
      var node = cp && $('.cpn[data-cp="' + cssEscape(String(cp.raw.cacheRef || cp.time)) + '"]');
      if (node) node.classList.add('linked');
    }
    // ⭐ 时间轴按鼠标位置自动滑动（2026-09-30 用户定案）。
    //   speed>0 向下、<0 向上、0 = 停。用 rAF 连续跑，跟屏幕刷新同步。
    //   ⚠ 停的时候必须真的停：把 rafId 置 0，不然鼠标移开后它还在空转滚。
    var railRaf = 0, railSpeed = 0;
    function railAutoScroll(speed) {
      railSpeed = speed || 0;
      if (!railSpeed) {
        if (railRaf) { GLOBAL.cancelAnimationFrame ? GLOBAL.cancelAnimationFrame(railRaf) : clearTimeout(railRaf); railRaf = 0; }
        return;
      }
      if (railRaf) return;                       // 已经在跑，只改速度
      var step = function () {
        railRaf = 0;
        var list = $('.rail-list');
        if (!list || !railSpeed) return;
        var before = list.scrollTop;
        list.scrollTop = before + railSpeed;
        var moved = list.scrollTop !== before;
        // 滚到顶/底还没停手 → 停掉，别让人以为"坏了但一直在算"
        if (!moved) { railSpeed = 0; return; }
        railRaf = GLOBAL.requestAnimationFrame ? GLOBAL.requestAnimationFrame(step) : setTimeout(step, 16);
      };
      railRaf = GLOBAL.requestAnimationFrame ? GLOBAL.requestAnimationFrame(step) : setTimeout(step, 16);
    }
    function cssEscape(value) {
      // ⚠ 用 GLOBAL（工厂内部自己抓的），不是外层那个 root —— 那个在工厂作用域里根本不存在。
      if (GLOBAL.css && typeof GLOBAL.css.escape === 'function') return GLOBAL.css.escape(String(value));
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    // ══ 换内容 = 整体上下滑 ═════════════════════════════
    function slideEl() {
      var host = $('.rc-pages');
      if (!host) return null;
      var el = host.querySelector('.rc-slide');
      if (!el) { el = document.createElement('div'); el.className = 'rc-slide'; host.appendChild(el); }
      return el;
    }
    function renderPage(dir) {
      var el = slideEl();
      if (!el) return;
      swapInto(el, state.mode === 'gallery' ? galleryHtml() : gridHtml(), dir, applyLinked);
    }
    function swapInto(el, html, dir, after) {
      if (!el) return;
      var mine = (el._seq = (el._seq || 0) + 1);
      var T = 'transform .2s var(--ease-out), opacity .18s var(--ease-soft)';
      if (!dir) {
        el.innerHTML = html; el.style.transition = 'none'; el.style.transform = 'none'; el.style.opacity = '1';
        if (after) after();
        return;
      }
      if (dir === 'fade') {
        el.style.transition = 'opacity .12s var(--ease-soft)'; el.style.opacity = '.35';
        setTimeout(function () {
          if (mine !== el._seq) return;
          el.innerHTML = html; if (after) after(); el.style.opacity = '1';
        }, 120);
        return;
      }
      var out = dir > 0 ? -56 : 56;
      el.style.transition = T; el.style.transform = 'translateY(' + out + 'px)'; el.style.opacity = '0';
      setTimeout(function () {
        if (mine !== el._seq) return;
        el.innerHTML = html; if (after) after();
        el.style.transition = 'none'; el.style.transform = 'translateY(' + (-out) + 'px)'; el.getBoundingClientRect();
        el.style.transition = T; el.style.transform = 'translateY(0)'; el.style.opacity = '1';
      }, 190);
    }
    function bump(dir) {
      var el = slideEl();
      if (!el) return;
      el.classList.remove('bump-down', 'bump-up');
      void el.offsetWidth;
      el.classList.add(dir > 0 ? 'bump-down' : 'bump-up');
    }
    var pillTimer = 0;
    function showPill(text) {
      var pill = $('.pg-pill');
      if (!pill) return;
      pill.textContent = String(text);
      pill.classList.add('show');
      clearTimeout(pillTimer);
      pillTimer = setTimeout(function () { pill.classList.remove('show'); }, 700);
    }
    // ⚠ 翻页【不切主卡】：这是用户定死的规矩（二级滚到底只顶一下）。
    function flipPage(dir) {
      var n = pageCount(), next = state.page + dir;
      if (next < 0 || next >= n) {
        bump(dir);
        showPill(next < 0 ? '已经是第一页' : '已经是最后一页');
        return false;
      }
      state.page = next;
      setCp('rest');
      renderPage(dir);
      renderRailFoot();
      showPill((next + 1) + ' / ' + n);
      return true;
    }

    // ══ 点小卡 → 全部图平铺（卡原地飞成第一张大图）══════
    var EASE = 'cubic-bezier(.22,.9,.32,1)';
    function M() { return (GLOBAL.V7Motion && GLOBAL.V7Motion.MS) || { fast: 120, base: 200, slow: 340 }; }   // 三档时长（motion-tokens.js）
    var galBusy = false;
    function rectIn(r, m) {
      return { left: (r.left - m.left) + 'px', top: (r.top - m.top) + 'px', width: r.width + 'px', height: r.height + 'px' };
    }
    // ⭐⭐ 飞行图 = 两层叠在一起（2026-09-30 用户实测"点进详情图片会抽动一次"）：
    //   任务卡上是【裁满】(cover，横向构图裁掉上下)，详情格子里是【完整显示 + 两边模糊补底】(contain)。
    //   原来飞行图只有 cover 一层，落地瞬间撤掉、露出 contain 的格子 → 构图突然一变，就是那一下抽动。
    //   现在：cover 层 + fit 层同时在飞，途中交叉淡化，落地时 fit 层已经 100%，
    //   跟底下的格子像素级一致，再撤掉飞行图就看不出任何变化。
    //   start='cover'（打开时）或 'fit'（关闭时反着飞）。
    function makeFlyer(bgImage, start) {
      var fly = document.createElement('div');
      fly.className = 'flyer';
      var bg = bgImage || '';
      fly.innerHTML = '<div class="fl-fit"><div class="bgblur"></div><div class="fg"></div></div><div class="fl-cover"></div>';
      fly.querySelector('.fl-cover').style.backgroundImage = bg;
      fly.querySelector('.fl-fit .bgblur').style.backgroundImage = bg;
      fly.querySelector('.fl-fit .fg').style.backgroundImage = bg;
      fly.querySelector('.fl-cover').style.opacity = start === 'fit' ? '0' : '1';
      return fly;
    }
    function morphFlyer(fly, to, duration) {
      var cover = fly.querySelector('.fl-cover');
      if (!cover) return;
      var frames = to === 'toFit' ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }];
      cover.animate(frames, { duration: duration, easing: 'cubic-bezier(.3,.75,.3,1)', fill: 'forwards' });
    }
    function openGallery(runId, card) {
      if (galBusy || state.mode === 'gallery') return;
      var main = $('.rc-main'), el = slideEl();
      if (!main || !el) return;
      galBusy = true; state.used = true;
      var mr = main.getBoundingClientRect(), r0 = card.getBoundingClientRect();
      setCp('rest'); state.mode = 'gallery'; state.galleryTask = runId;
      var img = card.querySelector('.tc-img');
      var fly = makeFlyer(img ? img.style.backgroundImage : '');
      Object.assign(fly.style, rectIn(r0, mr), { borderRadius: '20px' });
      main.appendChild(fly);
      card.style.visibility = 'hidden';
      el.style.transition = 'none';
      el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-18px) scale(.985)' }], { duration: M().base, easing: 'cubic-bezier(.3,.75,.3,1)', fill: 'forwards' });
      setTimeout(function () {
        el.getAnimations().forEach(function (a) { a.cancel(); });
        el.innerHTML = galleryHtml();
        el.style.transform = 'none'; el.style.opacity = '0';
        var first = el.querySelector('.gtile');
        if (!first) { fly.remove(); galBusy = false; renderRail(); return; }
        var r1 = first.getBoundingClientRect();
        first.style.visibility = 'hidden';
        // ⭐ 飞行途中"裁满 → 完整+模糊补底"同步渐变，落地时和格子长得一模一样
        morphFlyer(fly, 'toFit', M().slow);
        fly.animate([rectIn(r0, mr), rectIn(r1, mr)], { duration: M().slow, easing: EASE, fill: 'forwards' }).finished
          .then(function () { first.style.visibility = ''; return fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: M().fast, fill: 'forwards' }).finished; })
          .then(function () { fly.remove(); galBusy = false; });
        el.style.opacity = '';
        el.animate([{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }], { duration: M().base, delay: 90, easing: EASE, fill: 'backwards' });
        renderRail();
      }, M().base - 10);   // 等上面那段退场（base）快播完
    }
    function closeGallery() {
      if (galBusy || state.mode !== 'gallery') return;
      var main = $('.rc-main'), el = slideEl();
      if (!main || !el) { state.mode = 'grid'; state.galleryTask = null; return; }
      galBusy = true;
      var runId = state.galleryTask;
      var mr = main.getBoundingClientRect();
      var first = el.querySelector('.gtile'), r1 = first ? first.getBoundingClientRect() : null;
      var rows = currentRows(), idx = rows.findIndex(function (x) { return x.row.runId === runId; });
      if (idx >= 0) state.page = Math.floor(idx / PAGE);
      state.mode = 'grid'; state.galleryTask = null;
      clearPicks();   // ⚠ 退出详情就清空勾选 —— 否则下次回来还挂着上次的 ✓，容易误传
      var fly = null;
      if (r1 && first) {
        // 反向：从"完整+模糊补底"起飞，途中渐变回任务卡那种"裁满"
        fly = makeFlyer(first.querySelector('.fg') ? first.querySelector('.fg').style.backgroundImage : '', 'fit');
        Object.assign(fly.style, rectIn(r1, mr), { borderRadius: '20px' });
        main.appendChild(fly);
        first.style.visibility = 'hidden';
      }
      el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(18px)' }], { duration: M().fast, easing: 'cubic-bezier(.3,.75,.3,1)', fill: 'forwards' });
      setTimeout(function () {
        el.getAnimations().forEach(function (a) { a.cancel(); });
        el.innerHTML = gridHtml(); applyLinked();
        var card = el.querySelector('.tcard[data-row="' + cssEscape(String(runId)) + '"]');
        var r0 = card ? card.getBoundingClientRect() : null;
        if (card) card.style.visibility = 'hidden';
        el.animate([{ opacity: 0, transform: 'translateX(-18px)' }, { opacity: 1, transform: 'none' }], { duration: M().base, easing: EASE, fill: 'backwards' });
        var done = function () { if (card) card.style.visibility = ''; if (fly) fly.remove(); galBusy = false; };
        if (fly && r0) {
          morphFlyer(fly, 'toCover', M().slow);
          fly.animate([rectIn(r1, mr), rectIn(r0, mr)], { duration: M().slow, easing: EASE, fill: 'forwards' }).finished.then(done);
        }
        else done();
        renderRail(); renderRailFoot();
      }, M().fast + 10);   // 等上面那段退场（fast）播完
    }
    // 看图时滚轮 = 上/下一次计算
    function stepGallery(dir) {
      var rows = currentRows(), i = rows.findIndex(function (x) { return x.row.runId === state.galleryTask; });
      var j = i + dir;
      if (j < 0 || j >= rows.length) {
        bump(dir);
        showPill(j < 0 ? '已经是最新一次' : '已经是最早一次');
        return false;
      }
      state.galleryTask = rows[j].row.runId;
      state.page = Math.floor(j / PAGE);
      setCp('rest');
      renderPage(dir);
      renderRail();
      showPill('第 ' + (j + 1) + ' / ' + rows.length + ' 次');
      return true;
    }

    // ══ 开 / 关二级 / 换项目 ════════════════════════════
    function popGlow() {
      $$('.z-glow,.z-bright', zone).forEach(function (el) {
        el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
      });
    }
    function openProject(projectId, how) {
      if (!zone) return;
      if (state.results) {
        if (how === 'hover' && state.queryProject === projectId) return;
        state.queryProject = (how === 'click' && state.queryProject === projectId) ? null : projectId;
        state.page = 0; state.mode = 'grid'; state.galleryTask = null; state.used = true;
        setCp('rest');
        renderMainFace();
        renderPage('fade');
        renderRail();
        return;
      }
      if (state.open && state.project === projectId) { if (how === 'click') state.used = true; return; }
      var order = currentProjects().map(function (p) { return p.project; });
      var was = state.open;
      var dir = 0;
      if (was && state.project) dir = order.indexOf(projectId) > order.indexOf(state.project) ? 1 : -1;
      state.project = projectId; state.page = 0; state.mode = 'grid'; state.galleryTask = null;
      setCp('rest');
      if (!was) {
        state.open = true; state.openedBy = how; state.used = how === 'click';
        renderPage(0); renderRail();
        zone.classList.add('show');
        popGlow();
      } else {
        if (how === 'click') state.used = true;
        renderPage(dir); renderRail();
      }
      renderMainFace();
    }
    function close() {
      if (!state.open) return;
      state.open = false; state.used = false; state.openedBy = null;
      state.mode = 'grid'; state.galleryTask = null;
      clearPicks();
      setCp('rest');
      if (zone) zone.classList.remove('show');
    }
    // 搜索 → 一边筛选一边开着二级（样机的行为）
    function runSearch(raw) {
      var query = String(raw == null ? '' : raw).trim();
      if (query === state.query) return;
      if (!query) { clearSearch(true); return; }
      var first = !state.results;
      state.query = query;
      state.results = null;
      state.queryProject = null;
      state.page = 0; state.mode = 'grid'; state.galleryTask = null;
      searchState();
      renderMainFace();
      if (!state.open) { state.open = true; state.openedBy = 'search'; state.used = true; setCp('rest'); renderPage(0); renderRail(); zone.classList.add('show'); popGlow(); }
      else { setCp('rest'); renderPage(first ? 1 : 'fade'); renderRail(); }
    }
    function clearSearch(keepInput) {
      var had = !!state.results;
      state.query = ''; state.queryWords = []; state.results = null; state.queryProject = null;
      renderMainFace();
      if (had && state.open) {
        if (state.openedBy === 'search' || !state.project) close();
        else { state.page = 0; state.mode = 'grid'; setCp('rest'); renderPage(-1); renderRail(); }
      }
    }

    // ══ 一级卡面：项目列表（宿主把它画在自己的卡里）════
    function projectList() { return currentProjects(); }
    function footprint() {
      var c = core(), list = data.projects, usd = 0, pending = 0;
      list.forEach(function (p) {
        usd += p.cost.usd;
        pending += p.cost.pending;
      });
      return { count: list.length, usd: usd, pending: pending, text: list.length + ' 个项目 · 共 ' + c.formatUsd(usd) + (pending ? ' · ' + pending + ' 项以账单为准' : '') };
    }
    function projectTileData(project) {
      var c = core();
      return {
        project: project.project,
        label: project.docName || project.label,
        cover: projectCoverUrl(project),
        cost: project.cost,
        count: project.count,
        // 搜索时这一条命中了几行 —— 卡面上那个「N 个匹配」角标用它
        matches: state.results ? (project.rows || []).length : 0,
        live: project.live,
        lastAt: project.lastAt,
        selected: !!state.open && state.project === project.project
      };
    }

    // ══ 总渲染 ═════════════════════════════════════════
    function mount() {
      if (!zone) return;
      zone.innerHTML = '<div class="rc-main"><div class="rc-left"><div class="rc-pages"></div></div><div class="rc-detail"></div><div class="pg-pill"></div></div>'
        + '<div class="rc-rail zcard"><div class="z-glow"></div><div class="z-bright"></div><div class="rail-in"></div></div>';
      bindZone();
      render();
    }
    function render() {
      if (!zone) return;
      if (state.open) {
        // 项目没了（比如缓存被清）→ 自动退回
        if (!state.results && state.project && !projectsById().has(state.project)) {
          state.project = (data.projects[0] && data.projects[0].project) || null;
          if (!state.project) { close(); }
        }
        if (state.page >= pageCount()) state.page = Math.max(0, pageCount() - 1);
        var sl = slideEl();
        if (sl) sl.removeAttribute('data-empty');   // ⚠ 离开空状态必须清标记，否则以后有记录了也画不出来
        renderPage(0);
        renderRail();
      } else if (zoneVisible()) {
        // ⚠⚠ 2026-10-07 修（用户实测报的）：面板已经露出来了，里面却一个字都没有。
        //   真因：右滑那条路只在【有项目】时才调 openProject()，而这里只在 state.open 为真时画内容
        //     ⇒ 一条记录都没有时（新用户第一次右滑），外框在了、里面是空的。
        //   ⚠ 为什么在这里补而不是改右滑那个分支：宿主 zoneOpen 与卡片 state.open 是【两个真源】，
        //     这个项目为它栽过不止一次（见 ui.html:7373 / :7404 两段注释）。
        //     在这里补 = 谁把面板露出来都成立，不用再去追每一条入口。
        renderEmpty();
      }
      renderMainFace();
    }
    // 「面板露出来了吗」——⚠⚠ 这个判据踩过一次坑，看清楚再改：
    //   `.show` 类加在【父容器 #zones】上，不是加在记录卡这个 zone 自己身上
    //   （实测：右滑打开时 zones.classList 有 show、recordsZone.classList 没有）。
    //   第一版写成 zone.classList.contains('show') ⇒ 永远为假 ⇒ 空状态永远不画。
    function zoneVisible() {
      if (!zone) return false;
      if (zone.classList.contains('show')) return true;              // 万一以后改成加在自己身上，也认
      var parent = zone.parentElement;
      return !!(parent && parent.classList.contains('show'));
    }
    // 面板可见但没打开（空记录 / 还没选项目）时，画面里放一句人话，别留一块空白。
    function renderEmpty() {
      var el = slideEl();
      if (!el) return;
      if (el.getAttribute('data-empty') === '1') return;   // 已经是空状态就别反复重写（防闪）
      var html = '';
      try { html = typeof host.emptyHtml === 'function' ? String(host.emptyHtml() || '') : ''; } catch (_) { html = ''; }
      if (!html) {
        html = '<div class="rec-empty">还没有进行任何生图和修图操作' +
               '<br><small>做一次生成或修图，这里就会出现整张画布</small></div>';
      }
      swapInto(el, html, 0, null);
      el.setAttribute('data-empty', '1');
    }
    function renderMainFace() {
      if (typeof host.onFace === 'function') host.onFace({ footprint: footprint(), projects: currentProjects().map(projectTileData), query: state.query });
    }

    // ══ 事件 ════════════════════════════════════════════
    function bindZone() {
      var pages = $('.rc-pages');
      if (pages) {
        pages.addEventListener('click', function (event) {
          state.used = true;
          var act = event.target.closest && event.target.closest('[data-act]');
          if (act) { handleAction(act, event); return; }
          var card = event.target.closest && event.target.closest('.tcard[data-row]');
          if (card && state.mode === 'grid') { openGallery(card.dataset.row, card); return; }
          // ⭐ 2026-09-30 用户定案：检查点开着时，点左边【空白处】= 退出检查点。
          //   原来只能点卡片底下那颗「收起（Esc）」按钮 —— 用户不要那颗按钮了，
          //   改成"点空白就走"，跟看大图/点外关闭是同一套习惯。
          if (state.cp !== 'rest') setCp('rest');
        });
        pages.addEventListener('mouseover', function (event) {
          var card = event.target.closest && event.target.closest('.tcard[data-row]');
          linkNode(card ? card.dataset.row : null);
        });
        pages.addEventListener('mouseleave', function () { linkNode(null); });
      }
      // ⭐⭐ 2026-10-06 用户定案：鼠标移出「时间轴 + 详情面板」这块区域 → 自动缩回去。
      //   原来 half（悬停预览）没有 mouseleave 复位，移开还钉着，像"退不出去"。
      //   ⚠ 两旗标 + 260ms 宽限：从时间轴滑到详情面板（两块中间有缝）不会误收；
      //     两边都不在了才 setCp('rest')。
      var overRail = false, overDetail = false, cpLeaveTimer = 0;
      var cancelCpLeave = function () { if (cpLeaveTimer) { clearTimeout(cpLeaveTimer); cpLeaveTimer = 0; } };
      var scheduleCpLeave = function () {
        cancelCpLeave();
        if (state.cp === 'rest') return;
        cpLeaveTimer = setTimeout(function () {
          cpLeaveTimer = 0;
          if (overRail || overDetail) return;
          if (state.cp !== 'rest') setCp('rest');
        }, 260);
      };
      var rail = $('.rc-rail');
      if (rail) {
        rail.addEventListener('mouseenter', function () { overRail = true; cancelCpLeave(); });
        // ⭐⭐ 2026-09-30 用户定案：检查点一多，一页时间轴放不下 ——
        //   鼠标放到【上方区域】就朝上滑、放到【下方区域】就朝下滑（连续、跟位置走）。
        //   原来是只能用滚轮，用户要的是"放上去自己滑"。
        //   ⚠ 用 requestAnimationFrame 连续滑，不是定时器 —— 跟屏幕刷新同步，不抖。
        //   ⚠ 速度跟"离边多近"走：越贴边越快，最多 9px/帧（够快但不会一下就飞过去）。
        rail.addEventListener('mousemove', function (event) {
          var list = $('.rail-list');
          if (!list) { railAutoScroll(0); return; }
          if (list.scrollHeight <= list.clientHeight + 1) { railAutoScroll(0); return; }   // 装得下就别滑
          var r = list.getBoundingClientRect();
          var y = event.clientY - r.top;
          var zone = Math.min(64, r.height * 0.3);        // 上下各留 30%（最多 64px）当触发区
          if (zone <= 0) { railAutoScroll(0); return; }
          var speed = 0;
          if (y < zone) speed = -(1 - y / zone) * 9;                       // 上方 → 向上滑
          else if (y > r.height - zone) speed = (1 - (r.height - y) / zone) * 9;  // 下方 → 向下滑
          railAutoScroll(speed);
        });
        rail.addEventListener('mouseleave', function () { overRail = false; railAutoScroll(0); scheduleCpLeave(); });
        // ⭐ 2026-10-22（docs/263 第 7 条）：第一次要停 120ms 才展开预览（划过时间轴不闪一下）；
        //   已经在预览（half）时沿着时间轴往下划，照旧立刻换 —— 浏览一串检查点不会觉得慢。
        var cpHoverT = 0;
        rail.addEventListener('mouseover', function (event) {
          var node = event.target.closest && event.target.closest('.cpn');
          if (!node || state.cp === 'full') return;
          if (state.cpHover === node.dataset.cp) return;
          if (cpHoverT) { clearTimeout(cpHoverT); cpHoverT = 0; }
          if (state.cp === 'half') { setCp('half', node.dataset.cp); return; }
          var id = node.dataset.cp;
          cpHoverT = setTimeout(function () {
            cpHoverT = 0;
            if (state.cp === 'full' || !node.isConnected || !node.matches(':hover')) return;
            if (state.cpHover !== id) setCp('half', id);
          }, 120);
        });
        rail.addEventListener('click', function (event) {
          state.used = true;
          if (event.target.closest && event.target.closest('[data-act="cp-enable"]')) {
            if (typeof host.openCheckpointSettings === 'function') host.openCheckpointSettings();
            return;
          }
          var node = event.target.closest && event.target.closest('.cpn');
          if (!node) return;
          if (state.cp === 'full' && state.cpSel === node.dataset.cp) { setCp('rest'); return; }
          setCp('full', node.dataset.cp);
        });
      }
      var detail = $('.rc-detail');
      if (detail) {
        detail.addEventListener('mouseenter', function () { overDetail = true; cancelCpLeave(); });
        detail.addEventListener('mouseleave', function () { overDetail = false; scheduleCpLeave(); });
        detail.addEventListener('click', function (event) {
          state.used = true;
          var act = event.target.closest && event.target.closest('[data-act]');
          if (!act) return;
          var cp = cpById(state.cpSel || state.cpHover);
          if (act.dataset.act === 'cp-close') setCp('rest');
          // ⚠ 没有 'cp-open' 分支了：「在 PS 中打开」按钮已去掉（见 detailHtml 里的理由）。
          //   host.openCheckpoint 暂时留着不动 —— 历史库（history-library.js）还在用同名能力。
          else if (act.dataset.act === 'cp-folder' && cp && typeof host.revealCheckpoint === 'function') host.revealCheckpoint(cp.raw);
        });
      }
    }
    function handleAction(button, event) {
      var act = button.dataset.act;
      var card = button.closest('.tcard');
      var item = card && currentRows().find(function (x) { return x.row.runId === card.dataset.row && x.row.project === card.dataset.project; });
      // ⚠⚠【详情页里没有 .tcard】(2026-09-30 验证多选传回时抓到的老 bug)：
      //   详情的格子是 .gtile、胶囊条是 .gal-bar，它们都不在任何 .tcard 里 ——
      //   于是上面那句 card 恒为 null、item 恒为 undefined，下面凡是写了 `&& item` / `&& meta`
      //   的分支【全部静默不执行】：看大图、单张传回、恢复到任务栏、只用提示词，从实装起就一直是哑的，
      //   一条错都不报（docs/94 第 7 节"复用没在真软件里点过"指的就是这里）。
      //   详情模式下"是哪一次计算"由 state.galleryTask 决定，从那里取。
      if (!item && state.mode === 'gallery' && state.galleryTask) {
        item = currentRows().find(function (x) { return x.row.runId === state.galleryTask; });
      }
      var meta = item && item.row.meta;
      if (act === 'back') closeGallery();
      else if (act === 'reuse-task' && meta) {
        if (typeof host.reuseTask === 'function') host.reuseTask(meta, item.row);
        button.classList.add('done');
        button.innerHTML = svg('check', 12, 2.6) + (String(meta.workflowPresetId || '') || String(meta.kind || '') !== 'generation' ? '已打开' : '已填入');
        setTimeout(function () {
          if (button.isConnected) { button.classList.remove('done'); button.innerHTML = svg('restore', 12, 2.2) + '复用'; }
        }, 1300);
      } else if (act === 'restore' && meta) {
        if (typeof host.restoreTask === 'function') host.restoreTask(meta, item.row);
      } else if (act === 'folder' && item) {
        // ⭐ 打开这次计算的缓存文件夹（宿主走现成的 cache.openFolder，不新增宿主 API）
        if (typeof host.revealTask === 'function') host.revealTask(item.row);
      } else if (act === 'reuse' && meta) {
        if (typeof host.reusePrompt === 'function') host.reusePrompt(meta, item.row);
      } else if (act === 'big' && item) {
        if (typeof host.viewImage === 'function') host.viewImage(item.row, Number(button.closest('.gtile').dataset.shot));
      } else if (act === 'send' && item) {
        if (typeof host.sendShot === 'function') host.sendShot(item.row, Number(button.closest('.gtile').dataset.shot));
      } else if (act === 'pick') {
        // 勾/去勾一张图。⚠ 只重画详情，不整页重排 —— 只改这一个格子和胶囊条上的计数。
        var shot = Number(button.closest('.gtile').dataset.shot);
        togglePick(shot);
        var tileEl = button.closest('.gtile');
        if (tileEl) {
          tileEl.classList.toggle('picked', isPicked(shot));
          button.setAttribute('aria-pressed', isPicked(shot) ? 'true' : 'false');
        }
        refreshPickedButton();
      } else if (act === 'send-picked' && item) {
        var picked = pickedIndexes();
        if (!picked.length) return;
        if (typeof host.sendShots === 'function') host.sendShots(item.row, picked);
        else if (typeof host.sendShot === 'function') picked.forEach(function (i) { host.sendShot(item.row, i); });
      }
    }

    // 往右推：推到哪个项目条上就弹哪个项目（ui.html 用这个）
    function hoverProject(projectId) { openProject(projectId, 'hover'); }
    function clickProject(projectId) { openProject(projectId, 'click'); }

    // 滚轮挂载点（ui.html 调用）
    function onWheel(dir, delta) {
      if (state.mode === 'gallery') return stepGallery(dir);
      return flipPage(dir);
    }
    function cpScrollBy(delta) {
      if (state.cp !== 'full') return;
      var range = cpScrollRange();
      state.cpScroll = Math.max(range[0], Math.min(range[1], state.cpScroll + delta * .5));
      applyShrink(true);
    }
    function collapseCheckpoint() {
      if (state.cp === 'rest') return false;
      setCp('rest');
      return true;
    }

    return {
      mount: mount, reload: reload, render: render,
      open: openProject, openProject: openProject, close: close, closeGallery: closeGallery,
      isOpen: function () { return state.open; },
      openedBy: function () { return state.openedBy; },
      used: function () { return state.used; },
      markUsed: function () { state.used = true; },
      mode: function () { return state.mode; },
      project: function () { return state.project; },
      checkpointState: function () { return state.cp; },
      query: function () { return state.query; },
      runSearch: runSearch, clearSearch: clearSearch,
      projectList: projectList, projectTileData: projectTileData, footprint: footprint,
      hoverProject: hoverProject, clickProject: clickProject,
      flipPage: flipPage, stepGallery: stepGallery, onWheel: onWheel,
      cpScrollBy: cpScrollBy, collapseCheckpoint: collapseCheckpoint,
      setCp: setCp, linkNode: linkNode,
      bump: bump, showPill: showPill,
      state: state
    };
  }

  return { create: create, setIconRenderer: function (fn) { icon.setRenderer(fn); }, svg: svg, esc: esc, SHRINK: SHRINK, PAGE: PAGE };
});
