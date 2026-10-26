/* ══════════════════════════════════════════════════════════════════════════
 * 社区卡（community-card.js）· 2026-10-20
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：「我现在想把社区单独做一个卡片…社区卡片就显示一下今天社区有多热闹，比如说现在有多少人在陪你修图，
 *           今天这个修图排行榜是多少…用户可以从社区卡片那边进到我们的这个社区网页」
 *           「排行榜就排今天谁修图修的最多」「社区的预设要能一键加到我的预设」
 *
 * 这个文件只管【内容】：卡面（renderFace）+ 大二级的一列（renderPage）。
 *   开 / 关 / 右滑 / 滚轮 / 路由这些宿主胶水在 ui.html（搜 communityCardMount），跟问题反馈卡同一套。
 *
 * 数据全是后台现成的接口（不用改后台）：
 *   · 在线人数 /v1/community/summary 的 activeUsers（⚠ 只数【自己开了「公开在线状态」】的人，见后台 community_activity）
 *   · 排行榜 /v1/community/leaderboard?period=day|week|month（按出图张数；没开「排行榜显示名字」的人是匿名）
 *   · 热门分享 /v1/community/prompts（已上架的提示词 / 预设）
 * 一键加到我的预设：预设帖 = 网页「下载预设文件」那一条（同样的去字段规矩、同样的固定 id，重复加会自动跳过）；
 *   提示词帖 = 包成一条普通提示词预设。都走 PRESETUI.importItems（跟预设卡「导入」按钮同一条路）。
 *
 * 安全：后台来的字（标题、名字、提示词）一律走 textContent，绝不拼进 innerHTML。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var REFRESH_MS = 60 * 1000;
  var HOT_SHOW = 12;
  var PERIODS = [['day', '今天'], ['week', '本周'], ['month', '本月']];
  // 跟网页 community.js 的 DROP_FIELDS 同一份：别人的本机字段（排序、收藏、分类、参考图）不带进来
  var DROP_FIELDS = ['id', 'category', 'subCategory', 'refImages', '_isFactory', 'starred', 'order', 'importedAt',
    'createdAt', 'updatedAt', 'sourceRelativePath', 'sourceHash', 'sourceCategory', 'sourceKind', 'legacyId',
    'communityPostId', 'v6OriginalTitle', 'migrationState', 'needsReview'];
  var SECRET_KEY = /(^|_|-)(api[-_]?key|apikey|secret|token|password|passwd|authorization|cookie|session)($|_|-)/i;

  var TABS = [
    { id: 'rank', name: '修图排行榜', sub: '按出图张数排。下面两个开关管「我」：算不算进在线人数、榜上显不显示名字', group: '热闹' },
    { id: 'hot', name: '热门分享', sub: '大家分享的提示词和预设，按点赞排。复制，或者一键加到我的预设', group: '分享' },
    // ⭐ 2026-10-24 晚（V7待办/16，用户：「预设同步放到社区功能里」；设置卡原来那个按钮挪过来）
    { id: 'cloud', name: '云端预设', sub: '官方预设放在云端：登录时自动同步，后台下发给你的半小时内也会到。你改过的不覆盖，删掉的不再回来', group: '分享' },
    { id: 'web', name: '进社区网页', sub: '看全部、点赞、收藏、评选（投稿暂未开放）', group: '分享' }
  ];

  var cfg = { navigate: null, login: null, openWeb: null, importItems: null, report: null };
  var state = {
    summary: null, period: 'day', boards: {}, posts: null,
    loading: false, error: '', loadedAt: 0, status: '', statusKind: '', added: {}
  };
  var faces = new Set();
  var pages = new Set();
  var timer = 0;
  var epoch = 0;

  function el(tag, cls, text) {
    var n = root.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function backend() { return root.V7Backend || null; }
  function signedIn() {
    try { var B = backend(); return !!(B && B.state && B.state().signedIn); } catch (_) { return false; }
  }
  function myId() {
    try { var a = backend().state().account; return String(a && (a.id || a.accountId) || ''); } catch (_) { return ''; }
  }
  function report(error) {
    try { if (typeof cfg.report === 'function') cfg.report(error); } catch (_) {}
  }
  function setStatus(text, kind) { state.status = text || ''; state.statusKind = kind || ''; paintAll(); }

  // ══ 拉数据 ══════════════════════════════════════════════
  async function refresh(force) {
    if (!signedIn()) { state.summary = null; state.boards = {}; state.posts = null; state.error = ''; paintAll(); return; }
    if (state.loading) return;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < REFRESH_MS / 2) return;
    var B = backend();
    var my = ++epoch;
    state.loading = true; paintAll();
    try {
      var period = state.period;
      var res = await Promise.all([
        B.communitySummary().catch(function (e) { return { _error: e }; }),
        B.leaderboard(period).catch(function (e) { return { _error: e }; }),
        pages.size ? B.communityPrompts('', 'approved').catch(function (e) { return { _error: e }; }) : Promise.resolve(null)
      ]);
      if (my !== epoch) return;
      var errs = res.filter(function (r) { return r && r._error; });
      if (!res[0]._error) state.summary = res[0];
      if (!res[1]._error) state.boards[period] = Array.isArray(res[1].entries) ? res[1].entries : [];
      if (res[2] && !res[2]._error) state.posts = (Array.isArray(res[2].prompts) ? res[2].prompts : []).map(toPost);
      state.error = errs.length ? ('社区数据没拉全：' + String(errs[0]._error && errs[0]._error.message || errs[0]._error).slice(0, 80)) : '';
      state.loadedAt = Date.now();
    } catch (e) {
      if (my === epoch) state.error = '社区数据没拉到：' + String(e && e.message || e).slice(0, 80);
    } finally {
      if (my === epoch) { state.loading = false; paintAll(); }
    }
  }
  function startTimer() {
    if (timer) return;
    timer = setInterval(function () {
      var live = false;
      faces.forEach(function (n) { if (n.isConnected) live = true; else faces.delete(n); });
      if (!live && !pages.size) return;
      if (root.document && root.document.visibilityState === 'hidden') return;
      refresh(true);
    }, REFRESH_MS);
  }

  // 后台帖子 → 卡片用的样子（字段对着网页 community-api.js 的 toPost）
  function toPost(raw) {
    raw = raw || {};
    var meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    var kind = meta.kind === 'preset' ? 'preset' : 'prompt';
    return {
      id: String(raw.id || ''),
      kind: kind,
      title: String(raw.title || '').trim() || '（没有标题）',
      text: kind === 'prompt' ? String(raw.prompt || '') : '',
      category: String(meta.category || '其他'),
      preset: kind === 'preset' && meta.preset && typeof meta.preset === 'object' ? meta.preset : null,
      version: Math.max(1, parseInt(meta.version, 10) || 1),
      author: String(raw.display_name || '').trim() || '匿名',
      likes: Number(raw.likes || 0)
    };
  }
  function scrub(value, depth) {
    depth = depth || 0;
    if (depth > 16) return undefined;
    if (Array.isArray(value)) return value.slice(0, 5000).map(function (v) { return scrub(v, depth + 1); }).filter(function (v) { return v !== undefined; });
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        if (SECRET_KEY.test(k)) return;
        var v = scrub(value[k], depth + 1);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return undefined;
  }
  /** 帖子 → 一条能导进预设库的预设（预设帖跟网页「下载预设文件」那条一模一样；提示词帖包成普通提示词预设） */
  function presetItemOf(post) {
    var item;
    if (post.kind === 'preset') {
      if (!post.preset) return null;
      item = scrub(post.preset) || {};
      DROP_FIELDS.forEach(function (k) { delete item[k]; });
      item.title = String(post.preset.title || post.title).slice(0, 60);
      item.kind = item.kind || 'prompt';
    } else {
      if (!post.text.trim()) return null;
      item = { title: post.title.slice(0, 60), kind: 'prompt', content: post.text };
    }
    item.id = 'community_' + post.id;      // 固定 id：同一帖重复加，预设库认得出、自动跳过
    item.author = post.author;
    item.source = 'community';
    item.version = post.version;
    item.communityPostId = post.id;
    return item;
  }

  async function addToPresets(post) {
    var item = presetItemOf(post);
    if (!item) { setStatus('这条分享里没有能加的内容', 'warn'); return; }
    if (typeof cfg.importItems !== 'function') { setStatus('这个版本还不能直接加预设（缺导入接口）', 'err'); return; }
    try {
      var r = await cfg.importItems([item]);
      if (r && r.added) { state.added[post.id] = true; setStatus('已加到「我的预设」：' + item.title + '（在剪影预设卡上直接打字就能搜到）', 'ok'); }
      else if (r && r.skipped) { state.added[post.id] = true; setStatus('「' + item.title + '」已经在你的预设里了，没有重复加', ''); }
      else setStatus('没加进去：' + String(r && r.message || '预设库没接受这一条'), 'warn');
    } catch (e) {
      report(e);
      setStatus('没加进去：' + String(e && e.message || e).slice(0, 100), 'err');
    }
  }
  async function copyText(text) {
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) await root.navigator.clipboard.writeText(text);
      else throw new Error('没有剪贴板');
      setStatus('已复制提示词', 'ok');
    } catch (_) {
      setStatus('复制没成功：这台电脑不让软件写剪贴板', 'warn');
    }
  }
  async function openWeb() {
    if (typeof cfg.openWeb !== 'function') { setStatus('这个版本还不能从这里进社区', 'err'); return; }
    setStatus('正在打开浏览器…', '');
    try {
      var r = await cfg.openWeb();
      setStatus(r && r.message || '', r && r.ok ? 'ok' : 'warn');
    } catch (e) { setStatus('没打开：' + String(e && e.message || e).slice(0, 80), 'err'); }
  }
  function openCard(section) {
    if (typeof cfg.navigate === 'function') { try { return cfg.navigate(section || 'rank'); } catch (e) { report(e); } }
    return null;
  }

  // ══ 画 ══════════════════════════════════════════════════
  function paintAll() {
    faces.forEach(function (n) { if (n.isConnected) paintFace(n); else faces.delete(n); });
    pages.forEach(function (p) { if (p.root.isConnected) p.paint(); else pages.delete(p); });
  }
  function rankRows(list, limit) {
    var me = myId();
    var ol = el('ol', 'cc-rank');
    (list || []).slice(0, limit).forEach(function (row) {
      var li = el('li', 'cc-rank-row' + (me && String(row.accountId) === me ? ' me' : ''));
      li.append(el('span', 'cc-rk', row.rank), el('span', 'cc-nm', String(row.displayName || '匿名') + (me && String(row.accountId) === me ? '（我）' : '')), el('span', 'cc-ct', (Number(row.imageCount) || 0) + ' 张'));
      ol.append(li);
    });
    return ol;
  }

  // 卡面（一级）：⚠ 卡面不放输入框、不放列表滚动（主卡上滚轮 = 翻卡）
  function renderFace(node) {
    if (!node) return;
    faces.add(node);
    node.textContent = '';
    var wrap = el('div', 'cc-face');
    var live = el('div', 'cc-live');
    live.append(el('b', 'cc-live-n', '—'), el('span', 'cc-live-t', '人正在陪你修图'));
    var sub = el('div', 'cc-face-sub', '今天谁修得最多');
    var top = el('div', 'cc-face-top');
    var btns = el('div', 'cc-face-btns');
    var go = el('button', 'ai-btn primary', '进社区');
    go.type = 'button'; go.setAttribute('data-cc-web', '');
    go.addEventListener('click', function (e) { e.stopPropagation(); openWeb(); });
    var more = el('button', 'ai-btn', '排行榜 · 热门分享');
    more.type = 'button'; more.setAttribute('data-cc-open', '');
    more.addEventListener('click', function (e) { e.stopPropagation(); openCard('rank'); });
    btns.append(go, more);
    var status = el('p', 'cc-status'); status.setAttribute('role', 'status');
    wrap.append(live, sub, top, btns, status);
    node.append(wrap);
    paintFace(node);
    startTimer();
    refresh(false);
  }
  function paintFace(node) {
    var n = node.querySelector('.cc-live-n'), top = node.querySelector('.cc-face-top'), status = node.querySelector('.cc-status');
    var sub = node.querySelector('.cc-face-sub');
    var go = node.querySelector('[data-cc-web]'), more = node.querySelector('[data-cc-open]');
    if (!n || !top) return;
    top.textContent = '';
    if (!signedIn()) {
      n.textContent = '—';
      sub.textContent = '登录后就能看到社区有多热闹';
      if (go) { go.textContent = '去登录'; go.onclick = function (e) { e.stopPropagation(); if (typeof cfg.login === 'function') cfg.login(); }; }
      if (more) more.hidden = true;
      if (status) { status.textContent = ''; status.removeAttribute('data-kind'); }
      return;
    }
    if (go) { go.textContent = '进社区'; go.onclick = null; }
    if (more) more.hidden = false;
    var s = state.summary;
    n.textContent = s && s.activeUsers != null ? String(s.activeUsers) : (state.loading ? '…' : '—');
    n.title = '最近 ' + (s && s.activityWindowMinutes || 5) + ' 分钟在用软件、而且自己愿意公开在线状态的人';
    sub.textContent = '今天谁修得最多';
    var day = state.boards.day;
    if (day && day.length) top.append(rankRows(day, 3));
    else top.append(el('p', 'cc-empty', day ? '今天还没人上榜 —— 修一张图就是第一' : (state.loading ? '正在看今天的排行…' : '')));
    if (status) {
      var msg = state.status || state.error;
      status.textContent = msg;
      if (msg) status.setAttribute('data-kind', state.status ? state.statusKind : 'warn'); else status.removeAttribute('data-kind');
    }
  }

  // 大二级的一列
  function renderPage(body) {
    if (!body) return null;
    body.textContent = '';
    var rootEl = el('div', 'settings-panel sc-flat cc-page');
    rootEl.setAttribute('data-community-page', '');
    function sec(id) {
      var t = TABS.filter(function (x) { return x.id === id; })[0];
      var s = el('section', 'settings-section');
      s.setAttribute('data-sec-anchor', id);
      s.append(el('h3', 'settings-section-title', t.name), el('p', 'sec-sub', t.sub));
      rootEl.append(s);
      return s;
    }
    var status = el('p', 'cc-status'); status.setAttribute('role', 'status');
    rootEl.append(status);

    var r = sec('rank');
    var periods = el('div', 'cc-periods'); periods.setAttribute('role', 'radiogroup'); periods.setAttribute('aria-label', '排行榜时间');
    PERIODS.forEach(function (p) {
      var b = el('button', 'cc-period', p[1]); b.type = 'button'; b.dataset.period = p[0]; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () {
        if (state.period === p[0]) return;
        state.period = p[0];
        paintAll();
        if (!state.boards[p[0]]) refresh(true);
      });
      periods.append(b);
    });
    var board = el('div', 'cc-board');
    // ⭐ 2026-10-20（用户：「这个公开在线状态是在哪开启呢？」）：原来只在社区网页「我的」里能开（网页还没开放 ⇒ 实际谁都开不了，
    //   在线人数一直是 0）。软件里 10-09 砍掉的社区中心以前有这两个开关，这里补回来。都是默认关、只管自己。
    var privacy = el('div', 'cc-privacy');
    function privacySwitch(key, field, label, note) {
      var row = el('label', 'settings-switch cc-switch');
      var text = el('span', null, label);
      var box = el('input'); box.type = 'checkbox'; box.setAttribute('data-cc-privacy', key);
      box.addEventListener('change', async function () {
        var want = box.checked, B = backend();
        box.disabled = true;
        try {
          if (!B || typeof B.communityPrivacy !== 'function') throw new Error('这个版本没有隐私设置接口');
          var body = {}; body[key] = want;
          await B.communityPrivacy(body);
          setStatus(want ? note[0] : note[1], 'ok');
          refresh(true);
        } catch (e) {
          box.checked = !want;
          setStatus('没改成：' + String(e && e.message || e).slice(0, 80), 'err');
        } finally { box.disabled = false; }
      });
      row.append(text, box);
      row.dataset.field = field;
      return row;
    }
    privacy.append(
      privacySwitch('shareActivity', 'share_activity', '把我算进「正在陪你修图」的人数',
        ['已打开：你在用软件的时候会算进在线人数（只报「在用」，不发图片、提示词、项目名）', '已关闭：不再算你']),
      privacySwitch('showRankName', 'show_rank_name', '排行榜上显示我的名字（没审核过的昵称照样匿名）',
        ['已打开：排行榜上显示你审核过的昵称', '已关闭：排行榜上你是匿名']),
      el('p', 'cc-note', '都是默认关闭，只影响你自己；改了马上生效，随时能关。'));
    r.append(periods, board, privacy);

    var h = sec('hot');
    var hot = el('div', 'cc-hot');
    h.append(hot);

    // ── 云端预设（cloud-presets.js 管同步；这里只是入口 + 上次结果）──
    var cl = sec('cloud');
    var clInfo = el('p', 'cc-note');
    var clBtn = el('button', 'ai-btn primary', '立即同步');
    clBtn.type = 'button';
    clBtn.setAttribute('data-cloud-presets-sync', '');           // 点击由 cloud-presets.js 统一接（document 上那个监听）
    var clActions = el('div', 'ai-actions');
    clActions.append(clBtn);
    cl.append(clActions, clInfo);
    var paintCloud = function () {
      var C = root.V7CloudPresets, last = C && typeof C.last === 'function' ? C.last() : null;
      var n = root.PRESETS && typeof root.PRESETS.cloudLibraryCount === 'function' ? root.PRESETS.cloudLibraryCount() : 0;
      if (!signedIn()) { clInfo.textContent = '登录后自动同步。'; clBtn.disabled = true; return; }
      clBtn.disabled = false;
      if (!last) { clInfo.textContent = '本机有 ' + n + ' 条云端预设 · 这次打开还没同步过'; return; }
      var mins = Math.max(0, Math.round((Date.now() - last.at) / 60000));
      var L = last.library || {}, bits = [];
      if (L.added) bits.push('新增 ' + L.added); if (L.updated) bits.push('更新 ' + L.updated);
      if (L.claimed) bits.push('认出 ' + L.claimed + ' 条你本来就有的'); if (L.keptYours) bits.push(L.keptYours + ' 条你改过没覆盖');
      clInfo.textContent = '本机有 ' + n + ' 条云端预设 · 上次同步 ' + (mins ? mins + ' 分钟前' : '刚刚') + (bits.length ? ' · ' + bits.join(' · ') : ' · 没有变化');
    };
    if (root.addEventListener) root.addEventListener('wheelchair:cloud-presets-synced', paintCloud);

    var w = sec('web');
    var open = el('button', 'ai-btn primary', '在浏览器里打开社区');
    open.type = 'button';
    open.addEventListener('click', function () { openWeb(); });
    w.append(open, el('p', 'cc-note', '社区网页只认从软件点进去（每次点会带一张 60 秒有效的进门条子）。关掉网页后要回软件再点一次。'));
    body.append(rootEl);

    var showAll = false;
    var page = {
      root: rootEl,
      paint: function () {
        status.textContent = state.status || state.error;
        if (state.status || state.error) status.setAttribute('data-kind', state.status ? state.statusKind : 'warn'); else status.removeAttribute('data-kind');
        periods.querySelectorAll('[data-period]').forEach(function (b) {
          var on = b.dataset.period === state.period;
          b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        board.textContent = '';
        hot.textContent = '';
        privacy.hidden = !signedIn();
        paintCloud();
        var acct = null;
        try { acct = backend().state().account || null; } catch (_) { acct = null; }
        privacy.querySelectorAll('[data-cc-privacy]').forEach(function (box) {
          var field = box.closest('label') && box.closest('label').dataset.field;
          if (!box.disabled) box.checked = !!(acct && field && (acct[field] === true || acct[field] === 1));
        });
        if (!signedIn()) {
          board.append(el('p', 'cc-empty', '登录后才能看排行榜和大家的分享。'));
          var login = el('button', 'ai-btn', '去登录'); login.type = 'button';
          login.addEventListener('click', function () { if (typeof cfg.login === 'function') cfg.login(); });
          board.append(login);
          return;
        }
        var list = state.boards[state.period];
        // ⭐ 2026-10-22（docs/263 第 2 条）：加载时画灰色占位行，不再一句「正在拉…」
        var skel = function (n) { var d = document.createElement('div'); d.innerHTML = root.V7Format.skeletonHtml(n); return d.firstChild; };
        if (list && list.length) board.append(rankRows(list, 10));
        else if (!list && state.loading && root.V7Format) board.append(skel(4));
        else board.append(el('p', 'cc-empty', list ? '这段时间还没人上榜' : (state.loading ? '正在拉排行榜…' : '还没拉到排行榜')));

        var posts = (state.posts || []).slice().sort(function (a, b) { return b.likes - a.likes; });
        if (!state.posts && state.loading && root.V7Format) { hot.append(skel(3)); return; }
        if (!state.posts) { hot.append(el('p', 'cc-empty', state.loading ? '正在拉大家的分享…' : '还没拉到分享')); return; }
        if (!posts.length) { hot.append(el('p', 'cc-empty', '还没有人分享。去社区网页发第一条吧。')); return; }
        posts.slice(0, showAll ? posts.length : HOT_SHOW).forEach(function (post) {
          var row = el('div', 'cc-post');
          row.dataset.postId = post.id;
          var head = el('div', 'cc-post-head');
          head.append(el('span', 'cc-kind cc-kind-' + post.kind, post.kind === 'preset' ? '预设' : '提示词'), el('span', 'cc-post-title', post.title));
          var meta = el('div', 'cc-post-meta', post.category + ' · ' + post.author + ' · ' + post.likes + ' 赞' + (post.version > 1 ? ' · 第 ' + post.version + ' 版' : ''));
          row.append(head, meta);
          if (post.text) row.append(el('div', 'cc-post-text', post.text.length > 140 ? post.text.slice(0, 140) + '…' : post.text));
          var acts = el('div', 'cc-post-acts');
          if (post.kind === 'prompt' && post.text) {
            var copy = el('button', 'ai-btn', '复制'); copy.type = 'button';
            copy.addEventListener('click', function () { copyText(post.text); });
            acts.append(copy);
          }
          var canAdd = !!presetItemOf(post);
          var add = el('button', 'ai-btn' + (state.added[post.id] ? '' : ' primary'), state.added[post.id] ? '已在我的预设里' : '加到我的预设');
          add.type = 'button'; add.setAttribute('data-cc-add', post.id);
          add.disabled = !canAdd || !!state.added[post.id];
          add.addEventListener('click', function () { add.disabled = true; addToPresets(post); });
          acts.append(add);
          row.append(acts);
          hot.append(row);
        });
        if (posts.length > HOT_SHOW) {
          var tg = el('button', 'cc-more', showAll ? '收起' : '再看 ' + (posts.length - HOT_SHOW) + ' 条'); tg.type = 'button';
          tg.addEventListener('click', function () { showAll = !showAll; page.paint(); });
          hot.append(tg);
        }
      }
    };
    pages.add(page);
    page.paint();
    startTimer();
    refresh(!state.posts);
    return page;
  }

  // 换账号：上个账号的数据全部作废（排行里的「我」、加过的标记都跟账号走）
  var lastAccount = myId();
  try {
    if (root.V7Backend && typeof root.V7Backend.onChange === 'function') root.V7Backend.onChange(function () {
      var now = signedIn() ? myId() : '';
      if (now === lastAccount) { paintAll(); return; }   // 同一个账号只是资料变了（比如刚改了隐私开关）：重画就行
      lastAccount = now;
      epoch++;
      state.summary = null; state.boards = {}; state.posts = null; state.added = {}; state.loadedAt = 0; state.loading = false; state.error = ''; state.status = '';
      paintAll();
      if (signedIn()) refresh(true);
    });
  } catch (_) {}

  root.V7Community = {
    TABS: TABS,
    configure: function (o) { Object.assign(cfg, o || {}); },
    renderFace: renderFace,
    renderPage: renderPage,
    refresh: refresh,
    presetItemOf: presetItemOf,
    _toPost: toPost,
    state: function () { return { summary: state.summary, period: state.period, boards: state.boards, posts: state.posts, error: state.error, status: state.status }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
