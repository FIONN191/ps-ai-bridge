/* ══════════════════════════════════════════════════════════════════════════
 * 平台公告（ui-pure/announce.js）
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐⭐ 2026-10-15 用户重新定的规矩（推翻了 10-14 那版，原话）：
 *   「我希望用户在联网的时候，直接不用登录就能拉取到我们的公告」
 *   「公告需要能在后端去调整，可以加上表情和各种各样的文字，可以调整文字大小」
 *   「让这个报错卡片每一次都去弹一下公告，并且这个公告是在报错卡片的最顶层的，
 *     每次打开软件的时候都会弹一下」
 *   「我没有说不联网也要获取公告，而是说联网了一定要获取公告，
 *     如果没联网就报一个失败，让用户知道他现在没有办法连接上服务器」
 *   「每次登录之后就拉取一次，因为这个也其实是一个服务器状态验证」
 *   「冗余的状态和公告合并好」「刷新页面…尽量静默刷新，或者改为触发式的自动刷新」
 *
 * ⇒ 这一版的行为：
 *   · 启动拉一次 /v1/public/announcement（不登录也能拉）。
 *       拉到且有正文 → 公告卡钉在报错堆最顶上。
 *       拉不到       → 「连不上 V7 服务器」卡钉在最顶上（带"重试"）。⚠ 不再拿旧缓存冒充。
 *   · 正文是【分段富文本】（blocks）：每段 字号/颜色/加粗/居中 几档固定样式。
 *       ⚠ 只用 textContent 画字，绝不 innerHTML 正文 —— 公告是公开接口，
 *         后台账号被盗也不能往所有人的软件里塞脚本。档位表跟后端
 *         admin_extras.normalize_announcement_blocks、后台 app.js 预览三处一套。
 *   · 服务状态（哪个服务在维护）跟公告是同一个接口回来的，同一块里显示 —— 不再分两节。
 *   · 设置卡那一节没有"刷新"按钮：打开时如果上次拉取已经旧了（或上次失败）就自动重拉。
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // ⚠ 老版本的离线缓存键。新版不再用它显示（用户明确不要"离线显示旧公告"），
  //   拉成功时顺手清掉，免得留一份永远不会被读的旧公告。
  var CACHE_KEY = 'wheelchair.v7.announcement.cache.v1';
  var ENDPOINT = '/v1/public/announcement';
  var TIMEOUT_MS = 12000;
  var EVENT = 'wheelchair:announce-updated';

  var SIZES = { s: 1, m: 1, l: 1, xl: 1 };
  var COLORS = { 'default': 1, accent: 1, red: 1, orange: 1, green: 1, muted: 1 };
  var SERVICE_NAMES = { banana: 'Banana 生图', forge: 'Forge', comfyui: 'ComfyUI 云算力', dlss: 'DLSS', account: '账号服务' };
  var SERVICE_STATES = {
    operational: ['运行正常', 'ok'], degraded: ['部分受影响', 'warn'],
    maintenance: ['维护中', 'warn'], unavailable: ['不可用', 'err']
  };

  // status: idle（还没拉过）/ loading / ok / fail
  var state = { status: 'idle', blocks: [], content: '', services: [], links: [], updatedAt: '', at: 0, error: '', url: '', debug: '' };
  var inflight = null;

  function backendUrl() {
    // ⚠ 从 V7Backend 读（权威来源），不要读 settingsRuntime —— 启动那一刻它还是 undefined
    //   （2026-10-14 实测踩过：拼出坏 URL，公告永远拉不到且不报错）。
    try {
      var st = root.V7Backend && root.V7Backend.state && root.V7Backend.state();
      if (st && st.baseUrl) return String(st.baseUrl).replace(/\/+$/, '');
    } catch (_) { /* 落到默认值 */ }
    return 'https://www.xiasanqi.com';
  }

  /* ⚠ 网络请求一律走宿主桥 uiwin.http.fetch（浏览器 fetch 在两个壳里会 Failed to fetch，
     2026-10-14 真机实测）。浏览器 fetch 只给"没有桥"的测试环境兜底。 */
  async function httpGet(url, timeoutMs) {
    var bridge = root.uiwin && root.uiwin.http && root.uiwin.http.fetch;
    if (bridge) {
      var r = await root.uiwin.http.fetch({ url: url, method: 'GET', headers: { 'Accept': 'application/json' }, timeoutMs: timeoutMs });
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status != null ? r.status : '无响应') + (r && r.error ? '：' + r.error : ''));
      return typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    try {
      var resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 后端已经洗过一遍；这里再按同一张档位表洗一次（老后端只给 content、或字段异常时也不出错）
  function cleanBlocks(data) {
    var list = data && Array.isArray(data.blocks) ? data.blocks : null;
    if (!list || !list.length) {
      var text = String((data && data.content) || '');
      return text.trim() ? [{ text: text, size: 'm', color: 'default', bold: false, align: 'left' }] : [];
    }
    var out = [];
    list.forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      var text = String(b.text == null ? '' : b.text);
      if (!text.trim()) return;
      out.push({
        text: text,
        size: SIZES[b.size] ? b.size : 'm',
        color: COLORS[b.color] ? b.color : 'default',
        bold: b.bold === true,
        align: b.align === 'center' ? 'center' : 'left'
      });
    });
    return out;
  }

  function cleanServices(data) {
    var list = data && Array.isArray(data.services) ? data.services : [];
    return list.filter(function (s) { return s && SERVICE_NAMES[s.id] && SERVICE_STATES[s.status]; })
      .map(function (s) { return { id: s.id, status: s.status }; });
  }

  function emit() { try { root.dispatchEvent(new Event(EVENT)); } catch (_) { } }

  /* 拉一次。成功失败都不抛 —— 结果写进 state，由调用方看 status 决定弹什么。
     ⚠ 同时只跑一次：启动那次还没回来时设置页又要拉，就等同一个请求。 */
  function fetchOnce() {
    if (inflight) return inflight;
    var url = backendUrl() + ENDPOINT;
    state.status = 'loading';
    state.url = url;
    state.debug = 'bridge=' + !!(root.uiwin && root.uiwin.http && root.uiwin.http.fetch);
    inflight = (async function () {
      try {
        var data = await httpGet(url, TIMEOUT_MS);
        state.blocks = cleanBlocks(data);
        state.content = state.blocks.map(function (b) { return b.text; }).join('\n');
        state.services = cleanServices(data);
        state.links = (data && Array.isArray(data.links)) ? data.links.filter(function (l) { return l && l.url; }) : [];
        state.updatedAt = String((data && data.updatedAt) || '');
        state.status = 'ok';
        state.error = '';
        try { root.localStorage.removeItem(CACHE_KEY); } catch (_) { }
      } catch (error) {
        // ⚠ 失败就是失败：清空正文，不拿旧东西冒充（用户 10-15 明确要求）
        state.status = 'fail';
        state.error = String((error && error.message) || error).slice(0, 200);
        state.blocks = [];
        state.content = '';
        state.services = [];
        state.links = [];
      }
      state.at = Date.now();
      inflight = null;
      emit();
      return snapshot();
    })();
    emit();   // 让界面先显示"正在连接…"
    return inflight;
  }

  /* 触发式刷新：上次失败、或者成功但已经超过 maxAgeMs，就悄悄重拉一次。
     给设置卡用（打开那一节时调），代替以前那个"刷新当前页"按钮。 */
  function refreshIfStale(maxAgeMs) {
    var age = Date.now() - (state.at || 0);
    if (state.status === 'loading') return inflight;
    if (state.status === 'fail' || state.status === 'idle' || age > (maxAgeMs == null ? 60000 : maxAgeMs)) return fetchOnce();
    return Promise.resolve(snapshot());
  }

  function snapshot() {
    return {
      status: state.status, blocks: state.blocks.map(function (b) { return Object.assign({}, b); }),
      content: state.content, services: state.services.slice(), links: state.links.slice(),
      updatedAt: state.updatedAt, at: state.at, error: state.error, url: state.url, debug: state.debug,
      // 兼容 10-14 版的调用方：它们按 source 判断（live/none）
      source: state.status === 'ok' ? 'live' : 'none'
    };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clock(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  }

  /* 把分段正文画进 container（先清空）。⚠ 只用 textContent。 */
  function renderBlocks(container, blocks) {
    if (!container) return container;
    container.replaceChildren();
    (blocks || []).forEach(function (b) {
      var p = el('p', 'ann-b ann-s-' + b.size + ' ann-c-' + b.color + (b.bold ? ' ann-bold' : '') + (b.align === 'center' ? ' ann-center' : ''), b.text);
      container.append(p);
    });
    return container;
  }

  function renderServices(container, services) {
    container.replaceChildren();
    (services || []).forEach(function (s) {
      var st = SERVICE_STATES[s.status];
      var chip = el('span', 'ann-svc ann-svc-' + st[1]);
      chip.append(el('i'), el('span', null, SERVICE_NAMES[s.id] + ' · ' + st[0]));
      container.append(chip);
    });
    container.hidden = !services || !services.length;
    return container;
  }

  /* 设置卡「公告与状态」那一节的整节内容（标题 + 连接状态 + 公告框 + 服务状态 + 链接）。
     ⚠ 返回 DOM 节点，由调用方整段替换那一节（标题也换掉，避免两个标题）。 */
  function panelNode() {
    var s = snapshot();
    var frag = document.createDocumentFragment();
    var head = el('div', 'ann-head');
    head.append(el('h3', 'settings-section-title', '平台公告'));
    var pill = el('span', 'ann-conn ann-conn-' + s.status);
    pill.setAttribute('role', 'status');
    pill.append(el('i'), el('span', null,
      s.status === 'ok' ? '已连上服务器' + (s.at ? ' · ' + clock(s.at) : '')
        : s.status === 'fail' ? '连不上服务器' + (s.at ? ' · ' + clock(s.at) + ' 试过' : '')
          : '正在连接服务器…'));
    if (s.status === 'fail') pill.title = '原因：' + (s.error || '未知') + '\n地址：' + (s.url || backendUrl() + ENDPOINT) + '\n再次打开这一页会自动重试。';
    head.append(pill);
    frag.append(head);

    var box = el('div', 'announce-box');
    box.setAttribute('data-announce-box', '');
    if (s.status === 'ok' && s.blocks.length) {
      renderBlocks(box, s.blocks);
    } else if (s.status === 'ok') {
      box.append(el('p', 'announce-empty', '平台现在没有公告。'));
    } else if (s.status === 'fail') {
      box.append(el('p', 'announce-empty', '没拉到公告：现在连不上 V7 服务器。账号、积分、平台算力暂时用不了；本机生成、修图、抠像、调色不受影响。'));
    } else {
      box.append(el('p', 'announce-empty', '正在读取平台公告…'));
    }
    frag.append(box);

    var svc = el('div', 'ann-services');
    svc.setAttribute('data-announce-services', '');
    frag.append(renderServices(svc, s.services));

    if (s.links.length) {
      var links = el('div', 'announce-links');
      s.links.forEach(function (l) {
        var a = el('a', 'account-link', l.title || l.label || l.url);
        a.href = l.url; a.target = '_blank'; a.rel = 'noopener';
        links.append(a);
      });
      frag.append(links);
    }
    var wrap = el('div');
    wrap.append(frag);
    return wrap;
  }

  // 兼容 10-14 版调用方（它们拿字符串 replace 整节）。内容全是 textContent 建出来的，安全。
  function panelHtml() { return panelNode().innerHTML; }

  /* 报错卡里用的公告正文节点（卡片宽 300，最多显示几行，超出在卡内滚动）。 */
  function cardBodyNode(snap) {
    var box = el('div', 'ann-card-body');
    renderBlocks(box, (snap || state).blocks);
    return box;
  }

  root.V7Announce = Object.freeze({
    fetch: fetchOnce,
    refreshIfStale: refreshIfStale,
    state: snapshot,
    // 兼容：10-14 版的离线缓存读取。新版不再显示缓存，这里恒返回 null。
    cached: function () { return null; },
    renderBlocks: renderBlocks,
    panelNode: panelNode,
    panelHtml: panelHtml,
    cardBodyNode: cardBodyNode,
    endpoint: ENDPOINT,
    event: EVENT,
    key: CACHE_KEY,
    __test: { cleanBlocks: cleanBlocks, cleanServices: cleanServices, reset: function () { state.status = 'idle'; state.at = 0; inflight = null; } }
  });
})(window);
