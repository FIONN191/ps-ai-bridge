/* 设置卡 · 大二级（540×400：左 内容 + 右 导航）
 *
 * 2026-10-01 实装；⭐⭐⭐ 2026-10-14【整轮重排】。
 *
 * ── 2026-10-14 用户定的形态（照做，别改回去）─────────────────────────
 *   "把最右侧的导航栏…全都去重新打散，然后分成更多更细的导航栏。"
 *   "不分页，一列到底。"
 *   "每一个导航栏呢，都能看到，就是这个导航栏里面这一块是用来调什么的。"
 *   "傻子都能从右边的导航栏找得到对应的东西在哪。"
 *
 *   ⇒ 右边【不再是】"6 个页签 + 悬停弹出的子列表"那种两级结构，
 *     而是【一条平铺的长清单】：每一行 = 左边的一个小节，点一下滚过去。
 *     分组标题（.rail-group）只做视觉分段，不可点。
 *
 *   ⚠ 为什么把两级整个删掉：
 *     ① 第一级要点、第二级要悬停才出现 —— 两套交互叠一起，用户说不清该点哪层。
 *     ② 悬停浮层朝左盖在内容上，鼠标一走就收 —— 条目一多就手忙脚乱。
 *   ⇒ 现在只有一种交互：**点一下，滚过去**。没有悬停、没有浮层、没有两级。
 *
 * ── 必须保留的对外接口（十几处引用，少一个就是静默失效）─────────────
 *   方法：mount / open / close / isOpen / reload / invalidate / select / flip /
 *         currentTab / currentSection / tabs / iconRenderer
 *   DOM：.sc-main / .sc-pages / .sc-page / .sc-body[data-sc-body] /
 *        .sc-rail / .rail-in / .scn[data-tab]
 *   ⚠ zone.dataset.settingsTab 照旧写（值 = 当前小节 id），测试读它。
 *
 * ⚠ 滚轮【不在这里挂】—— 二级滚轮归 ui.html 统一管。
 * ⚠ 图标拿不到就退化成空字符串，别吐图标名当文字。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7SettingsCard = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(name, size) {
    var fn = icon.renderer;
    if (typeof fn !== 'function') return '';
    try { return fn(name, size) || ''; } catch (_) { return ''; }
  }

  function create(options) {
    options = options || {};
    var zone = options.zone;
    if (!zone) return null;

    // 平铺清单：[{id, name, sub, group}]
    var SECTIONS = (options.tabs || []).slice();
    var state = { open: false, anchor: SECTIONS.length ? SECTIONS[0].id : '', section: null, seq: 0, lockUntil: 0 };
    var host = options.host || options;

    var $ = function (sel, scope) { return (scope || zone).querySelector(sel); };
    var $$ = function (sel, scope) { return Array.prototype.slice.call((scope || zone).querySelectorAll(sel)); };

    function indexOfAnchor(id) {
      for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return i;
      return -1;
    }

    // ══ ⭐ 2026-10-20 顶上的搜索框（只有设置卡开：options.search）══════════════
    //   用户原话：「设置内容特别多，所以说设置界面顶部需要加一个搜索框……模糊的……近似搜索。
    //             然后搜索完之后呢，就有跳转有分类。」
    //   · 搜什么：每一节（名字 + 灰字说明 + 关键词 keys）+ 节里每一个设置项（标签 + 「?」说明 + 输入框提示 + 下拉框选项）
    //     ⚠ 「滚到这里才显示」的模块还没挂上时，节里的项搜不到 —— 所以每一节在 SETTINGS_TABS 里另配了一串 keys 兜底。
    //   · 怎么对：V7Fuzzy（fuzzy-search.js）—— 原文 / 汉字隔字 / 全拼 / 首字母 / 拼一半 都算。
    //   · 结果：按「分组 · 小节」分类列出来；点一条 = 滚到那一节 → 展开折叠 → 滚到那一项 → 闪一下（.route-highlight）。
    var search = options.search ? Object.assign({ placeholder: '搜设置：中文、拼音、首字母都行' }, options.search) : null;
    var fuzzy = function () { return (search && search.fuzzy) || (typeof window !== 'undefined' && window.V7Fuzzy) || null; };
    var srch = { q: '', rows: [], cur: -1, timer: null, goSeq: 0 };
    var ITEM_SEL = '.settings-field,.tgl,.settings-row,.nsl,.v7-check-row,.v7-setup-check,.settings-color,.settings-about-row,'
      + 'div.settings-section-title,summary,.settings-btn,.layout-section h4,.cache-settings-trash-title';
    // 这些里面的不是「设置项」（聊天记录、账单流水、公告正文、下拉菜单弹层）
    var SKIP_SEL = '.assistant-message,.assistant-conversation,.cache-settings-item,.announce-box,.account-ledger,[data-account-ledger],.uisel-menu,.scs-results';

    function searchMarkup() {
      return '<div class="sc-search" data-sc-search>'
        + '<span class="scs-ico" aria-hidden="true">' + icon('search', 12) + '</span>'
        + '<input type="text" class="scs-input" data-sc-search-input spellcheck="false" autocomplete="off" placeholder="' + esc(search.placeholder) + '" aria-label="搜索设置">'
        + '<button type="button" class="scs-clear" data-sc-search-clear hidden aria-label="清空搜索">×</button>'
        + '<div class="scs-results" data-sc-search-results role="listbox" hidden></div></div>';
    }
    // 一个元素「自己的字」：不算里面嵌着的别的设置项、「?」按钮、输入框、下拉框
    function ownText(el) {
      var out = '';
      (function walk(n) {
        for (var c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) out += c.nodeValue;
          else if (c.nodeType === 1) {
            if (c !== el && c.matches && (c.matches(ITEM_SEL) || c.matches('.v7-help,select,option,.uisel-trigger,.uisel-menu,input,textarea,svg'))) continue;
            walk(c);
          }
        }
      })(el);
      return out.replace(/\s+/g, ' ').trim();
    }
    function labelOf(el) {
      var pick = el.matches('.nsl') ? el.querySelector('.nsl-name')
        : el.matches('.settings-about-row') ? el.querySelector('.settings-about-key')
        : el.matches('.settings-color') ? el.querySelector('.sc-name') : null;
      var t = pick ? pick.textContent : ownText(el);
      return String(t || '').replace(/\s+/g, ' ').replace(/[?？]$/, '').trim();
    }
    function hintOf(el) {
      var parts = [];
      var help = el.querySelector('.v7-help[data-help-text]') || (el.nextElementSibling && el.nextElementSibling.matches && el.nextElementSibling.matches('.v7-help[data-help-text]') ? el.nextElementSibling : null);
      if (help) parts.push(help.getAttribute('data-help-text'));
      if (el.title) parts.push(el.title);
      Array.prototype.forEach.call(el.querySelectorAll('input[placeholder],textarea[placeholder]'), function (i) { parts.push(i.placeholder); });
      Array.prototype.forEach.call(el.querySelectorAll('option'), function (o) { parts.push(o.textContent); });
      return parts.join(' ').slice(0, 400);
    }
    function buildIndex() {
      var list = [];
      SECTIONS.forEach(function (s, order) {
        list.push({ kind: 'section', sec: s.id, order: order, label: s.name, hint: [s.sub, s.keys].filter(Boolean).join(' '), group: s.group || '' });
      });
      var body = $('[data-sc-body]');
      if (!body) return list;
      var seen = {};
      $$('[data-sec-anchor]', body).forEach(function (secEl) {
        var sid = secEl.dataset.secAnchor, si = indexOfAnchor(sid);
        if (si < 0) return;
        Array.prototype.forEach.call(secEl.querySelectorAll(ITEM_SEL), function (el) {
          if (el.closest(SKIP_SEL) || el.closest('[hidden]')) return;
          var label = labelOf(el);
          if (!label || label.length < 2 || label.length > 48) return;
          if (label === SECTIONS[si].name) return;           // 跟节名一样的（节标题）由上面那条代表
          var key = sid + '|' + label;
          if (seen[key]) return;
          seen[key] = 1;
          list.push({ kind: 'item', sec: sid, order: si, label: label, hint: hintOf(el), group: SECTIONS[si].group || '' });
        });
      });
      return list;
    }
    function runSearch() {
      var input = $('[data-sc-search-input]');
      var q = input ? input.value : '';
      var fz = fuzzy();
      srch.q = q;
      srch.rows = [];
      srch.cur = -1;
      if (!fz || !fz.norm(q)) { renderResults([]); return; }
      var hits = fz.search(q, buildIndex(), function (it) {
        // 节：名字最重要，说明 / 关键词 / 分组名次之；项：标签最重要，「?」说明里的字次之
        return it.kind === 'section'
          ? [[it.label, 1], [it.hint, 0.55], [it.group, 0.4]]
          : [[it.label, 1], [it.hint, 0.45]];
      }, 60);
      renderResults(hits);
    }
    function renderResults(hits) {
      var box = $('[data-sc-search-results]'), clear = $('[data-sc-search-clear]');
      if (clear) clear.hidden = !srch.q;
      if (!box) return;
      if (!srch.q || !fuzzy() || !fuzzy().norm(srch.q)) { box.hidden = true; box.innerHTML = ''; zone.classList.remove('sc-searching'); return; }
      // 按小节分类：哪一节里分最高的排前面；每节最多列 6 项，最多列 10 节
      var groups = [], map = {};
      hits.forEach(function (h) {
        var it = h.item, g = map[it.sec];
        if (!g) { g = map[it.sec] = { sec: it.sec, order: it.order, items: [] }; groups.push(g); }
        if (it.kind === 'item' && g.items.length < 6) g.items.push(it);
      });
      groups = groups.slice(0, 10);
      var html = '';
      groups.forEach(function (g) {
        var s = SECTIONS[g.order];
        srch.rows.push({ kind: 'section', sec: g.sec });
        html += '<div class="scs-row scs-sec" role="option" data-scs-i="' + (srch.rows.length - 1) + '">'
          + '<span class="scs-path">' + esc(s.group ? s.group + ' · ' : '') + '</span><b>' + esc(s.name) + '</b>'
          + (s.sub ? '<small>' + esc(s.sub) + '</small>' : '') + '</div>';
        g.items.forEach(function (it) {
          srch.rows.push({ kind: 'item', sec: g.sec, label: it.label });
          html += '<div class="scs-row scs-item" role="option" data-scs-i="' + (srch.rows.length - 1) + '"><span>' + esc(it.label) + '</span></div>';
        });
      });
      if (!groups.length) html = '<div class="scs-empty">没找到「' + esc(srch.q) + '」相关的设置 —— 换个说法试试，或者打拼音首字母（比如 zt = 主题）</div>';
      box.innerHTML = html;
      box.hidden = false;
      box.scrollTop = 0;
      zone.classList.add('sc-searching');
      if (srch.rows.length) setCur(0);
    }
    function setCur(i) {
      var box = $('[data-sc-search-results]');
      if (!box || !srch.rows.length) return;
      srch.cur = Math.max(0, Math.min(srch.rows.length - 1, i));
      $$('.scs-row', box).forEach(function (r) { r.classList.toggle('cur', Number(r.dataset.scsI) === srch.cur); });
      var node = box.querySelector('[data-scs-i="' + srch.cur + '"]');
      if (node) {
        var br = box.getBoundingClientRect(), nr = node.getBoundingClientRect();
        if (nr.top < br.top) box.scrollTop -= br.top - nr.top + 4;
        else if (nr.bottom > br.bottom) box.scrollTop += nr.bottom - br.bottom + 4;
      }
    }
    function hideResults() {
      var box = $('[data-sc-search-results]');
      if (box) { box.hidden = true; }
      zone.classList.remove('sc-searching');
    }
    // 在某一节里按标签找回那个设置项（模块重挂过节点会换，所以每次现找）
    function findItem(sec, label) {
      var body = $('[data-sc-body]');
      var secEl = body && body.querySelector('[data-sec-anchor="' + String(sec).replace(/"/g, '\\"') + '"]');
      if (!secEl) return null;
      var list = secEl.querySelectorAll(ITEM_SEL);
      for (var i = 0; i < list.length; i++) {
        if (list[i].closest(SKIP_SEL) || list[i].closest('[hidden]')) continue;
        if (labelOf(list[i]) === label) return list[i];
      }
      return null;
    }
    function flash(node) {
      if (!node) return;
      var target = (node.closest && node.closest('.settings-row,.settings-field,.tgl,.settings-section')) || node;
      if (node.matches && node.matches('.settings-section')) target = node.querySelector('.settings-section-title') || node;
      target.classList.remove('route-highlight'); void target.offsetWidth; target.classList.add('route-highlight');
      setTimeout(function () { target.classList.remove('route-highlight'); }, 3300);
    }
    function goResult(row) {
      if (!row) return;
      hideResults();
      var input = $('[data-sc-search-input]');
      if (input) input.blur();
      select(row.sec, 'search');
      var body = $('[data-sc-body]');
      if (row.kind !== 'item') {
        flash(body && body.querySelector('[data-sec-anchor="' + String(row.sec).replace(/"/g, '\\"') + '"]'));
        return;
      }
      // 「滚到这里才显示」的模块：要先滚到那一节它才挂上 —— 找不到就隔 0.1 秒再找（最多 3 秒）
      var tries = 0, seq = ++srch.goSeq;
      (function attempt() {
        if (seq !== srch.goSeq) return;
        var n = findItem(row.sec, row.label);
        if (!n) { if (++tries < 30) setTimeout(attempt, 100); return; }
        try { if (typeof host.expandAncestors === 'function') host.expandAncestors(n); } catch (_) {}
        scrollToNode(function () { return findItem(row.sec, row.label); }, true, 48);
        flash(n);
      })();
    }
    function bindSearch() {
      var input = $('[data-sc-search-input]'), box = $('[data-sc-search-results]'), clear = $('[data-sc-search-clear]');
      if (!input || !box) return;
      input.addEventListener('input', function () {
        if (srch.timer) clearTimeout(srch.timer);
        srch.timer = setTimeout(runSearch, 60);
      });
      input.addEventListener('focus', function () { if (srch.q) runSearch(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (box.hidden && srch.q) runSearch(); else setCur(srch.cur + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(srch.cur - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); if (srch.timer) { clearTimeout(srch.timer); runSearch(); } goResult(srch.rows[srch.cur < 0 ? 0 : srch.cur]); }
        else if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (input.value) { input.value = ''; runSearch(); } else input.blur();
        }
      });
      if (clear) clear.addEventListener('click', function () { input.value = ''; runSearch(); input.focus(); });
      box.addEventListener('pointerdown', function (e) { e.preventDefault(); });   // 点结果时输入框别先丢焦点把列表收掉
      box.addEventListener('click', function (e) {
        var r = e.target.closest && e.target.closest('.scs-row');
        if (r) goResult(srch.rows[Number(r.dataset.scsI)]);
      });
      box.addEventListener('pointermove', function (e) {
        var r = e.target.closest && e.target.closest('.scs-row');
        if (r && Number(r.dataset.scsI) !== srch.cur) setCur(Number(r.dataset.scsI));
      });
      // 点到搜索框外面：收起结果（字留着，再点回搜索框就又出来）
      if (typeof document !== 'undefined') document.addEventListener('pointerdown', function (e) {
        if (box.hidden) return;
        if (e.target && e.target.closest && e.target.closest('[data-sc-search]') && zone.contains(e.target)) return;
        hideResults();
      }, true);
    }

    // ══ 总渲染 ═════════════════════════════════════════
    function mount() {
      zone.innerHTML =
        '<div class="sc-main' + (search ? ' has-search' : '') + '">'
        + (search ? searchMarkup() : '')
        + '<div class="sc-pages"></div></div>'
        + '<div class="sc-rail"><div class="z-glow"></div><div class="z-bright"></div><div class="rail-in"></div></div>';
      renderRail();
      bindZone();
      if (search) bindSearch();
      bindPinCancel();
    }

    // ══ 右边导航：一列到底 ═══════════════════════════════
    //   ⚠ 条目比格子高是正常的（三十来项）——让它自己滚，绝不缩字号硬塞。
    function renderRail() {
      var box = $('.rail-in');
      if (!box) return;
      var rows = '';
      var lastGroup = null;
      SECTIONS.forEach(function (s) {
        if (s.group && s.group !== lastGroup) {
          lastGroup = s.group;
          rows += '<div class="rail-group">' + esc(s.group) + '</div>';
        }
        var isCur = s.id === state.anchor;
        rows += '<div class="scn' + (isCur ? ' sel' : '') + '" role="tab" tabindex="0"'
          + ' aria-selected="' + isCur + '" data-tab="' + esc(s.id) + '"'
          + ' title="' + esc(s.name + (s.sub ? '：' + s.sub : '')) + '">'
          + '<i></i><span class="tt">' + esc(s.name) + '</span></div>';
      });
      box.innerHTML = '<div class="rail-list"><div class="rail-nodes" role="tablist" aria-label="设置目录">' + rows + '</div></div>';
      markRailCurrent();
    }

    // 把当前那一项滚进导航的视野（长清单必须，否则高亮跑到看不见的地方）。
    // ⚠ 用 rect 差值算，不用 offsetTop（中间有定位容器，offsetTop 链会算偏）。
    function scrollRailIntoView(id) {
      var list = $('.rail-list');
      if (!list) return;
      var rows = $$('.scn'), node = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].dataset.tab === id) { node = rows[i]; break; }
      if (!node) return;
      var lr = list.getBoundingClientRect(), nr = node.getBoundingClientRect();
      var relTop = (nr.top - lr.top) + list.scrollTop;
      var relBottom = relTop + nr.height;
      if (relTop < list.scrollTop + 4) list.scrollTop = Math.max(0, relTop - 28);
      else if (relBottom > list.scrollTop + list.clientHeight - 4) list.scrollTop = relBottom - list.clientHeight + 28;
    }

    function markRailCurrent() {
      $$('.scn').forEach(function (el) {
        var on = el.dataset.tab === state.anchor;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', String(on));
      });
      scrollRailIntoView(state.anchor);
    }

    // ══ scroll-spy：内容滚到哪，右边就亮哪一行 ═════════════
    function bindSpy() {
      var body = $('[data-sc-body]');
      if (!body) return;
      body.addEventListener('scroll', function () { syncSpy(); }, { passive: true });
    }

    // 找"当前在视野最上方的那一节"。
    // ⚠ 点了导航正在平滑滚动的那段时间里【不跟】—— 否则滚动途中路过的每一节都会亮一下，
    //   而且到底部时最后几节短、永远到不了顶，点它们会被"跳回"上一节（lockUntil 解决）。
    function syncSpy() {
      if (Date.now() < state.lockUntil) return;
      var body = $('[data-sc-body]');
      if (!body) return;
      var secs = Array.prototype.slice.call(body.querySelectorAll('[data-sec-anchor]')).filter(function (n) {
        return indexOfAnchor(n.dataset.secAnchor) >= 0;
      });
      if (!secs.length) return;
      var bodyTop = body.getBoundingClientRect().top;
      var cur = secs[0].dataset.secAnchor;
      // 滚到底了：直接亮最后一节（短节永远顶不到上沿）
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) cur = secs[secs.length - 1].dataset.secAnchor;
      else for (var i = 0; i < secs.length; i++) {
        if (secs[i].getBoundingClientRect().top - bodyTop <= 24) cur = secs[i].dataset.secAnchor;
      }
      if (cur === state.anchor) return;
      state.anchor = cur;
      zone.dataset.settingsTab = cur;
      markRailCurrent();
      if (typeof host.onSelect === 'function') host.onSelect(cur, 'scroll');
    }

    // ══ 内容（只有一页，一列到底）═══════════════════════
    function renderPage() {
      var host_ = $('.sc-pages');
      if (!host_) return;
      host_.innerHTML = '<div class="sc-page"><div class="sc-body" data-sc-body></div></div>';
      bindPage();
    }

    var pageCleanup = null;
    function runPageCleanup() {
      if (!pageCleanup) return;
      try { pageCleanup(); } catch (error) { host.onError && host.onError(error); }
      pageCleanup = null;
    }

    function bindPage() {
      var body = $('[data-sc-body]');
      if (!body) return;
      runPageCleanup();
      if (typeof host.render === 'function') {
        var dispose = host.render(body, state.anchor, state.section) || null;
        if (typeof dispose === 'function') pageCleanup = dispose;
      }
      bindSpy();
    }

    // ══ 滚到某一节 ═════════════════════════════════════
    // ⭐⭐ 2026-10-20 修「点右边导航跳得不准」（用户报的；真软件里 50 次点击量出 2 次落偏 98px / 254px）：
    //   原来是【点下去那一刻】算好目标位置就平滑滚过去 —— 可滚的途中，上面的小节还在长高
    //   （「滚到这里就会显示」的模块是路过时才挂上的，账单 / 备份信息是异步读回来的），
    //   等滚到了，目标早就被挤走了。
    //   ⇒ 现在：滚完以后【盯住】目标，位置不对就再对一次，直到连着几帧不动（最多盯 2.5 秒）。
    //     用户自己一动滚轮 / 按下鼠标就立刻放手，不跟他抢。
    function scrollToAnchor(id, smooth) {
      var body = $('[data-sc-body]');
      if (!body) return false;
      var sel = '[data-sec-anchor="' + String(id).replace(/"/g, '\\"') + '"]';
      if (!body.querySelector(sel)) return false;
      return scrollToNode(function () { return body.querySelector(sel); }, smooth, 4);
    }
    // 把某个元素滚到内容区顶上 offset 像素处，并盯住它（见上）。getNode 每次重新找（模块重挂会换节点）。
    var pinSeq = 0;
    function scrollToNode(getNode, smooth, offset) {
      var body = $('[data-sc-body]');
      var node = getNode();
      if (!body || !node) return false;
      var off = offset == null ? 4 : offset;
      var want = function (n) {
        var delta = n.getBoundingClientRect().top - body.getBoundingClientRect().top - off;
        return Math.max(0, Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + delta));
      };
      var target = want(node);
      state.lockUntil = Date.now() + (smooth === false ? 200 : 700);
      try { body.scrollTo({ top: target, behavior: smooth === false ? 'auto' : 'smooth' }); }
      catch (_) { body.scrollTop = target; }
      var my = ++pinSeq, t0 = Date.now(), last = -1, still = 0, settled = false, expected = 0;
      // ⚠ 2026-10-21：直接跳过去（没有平滑滚动）的，跳完就已经到位了 ⇒ 立刻进入「盯着」，别人一动就放手。
      //   原来也要等「连着 3 帧不动」才算到位 —— 这几帧里别的代码 scrollIntoView 去找某个按钮，会被当成还在滚，
      //   等停下来再被拽回目标位置（悬浮条测试抓到：滚到「恢复默认」去点，按钮被拽走，点空）。
      if (smooth === false) { settled = true; expected = body.scrollTop; }
      var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
      var release = function () { state.lockUntil = Date.now() + 60; };
      var step = function () {
        if (my !== pinSeq) return;
        var b = $('[data-sc-body]'), n = getNode();
        if (!b || b !== body || !n) return;
        if (!settled) {
          if (body.scrollTop === last) still++; else { still = 0; last = body.scrollTop; }
          if (still >= 3 && (smooth === false || Date.now() - t0 > 150)) {   // 平滑滚动停下了：对一次准，开始盯
            settled = true;
            var w0 = want(n);
            if (Math.abs(w0 - body.scrollTop) > 2) body.scrollTop = w0;
            expected = body.scrollTop;
          }
        } else {
          // ⚠ 盯着的时候【别人】动了滚动（滚轮以外的：拖滚动条、键盘、别处代码 scrollIntoView 去找某个控件……）→ 马上放手，
          //   不然会把人家刚滚到的位置又拽回来（测试抓到：路由过来后滚到某个「?」按钮，被拽走，鼠标点空）。
          if (Math.abs(body.scrollTop - expected) > 1) { release(); return; }
          var w = want(n);
          if (Math.abs(w - body.scrollTop) > 2) { body.scrollTop = w; expected = body.scrollTop; }   // 上面又长高了：再对一次
          else if (Date.now() - t0 > 600) { release(); return; }   // 对准了，而且稳住了
        }
        if (Date.now() - t0 > 2500) { release(); return; }
        state.lockUntil = Date.now() + 200;                  // 盯着的时候导航高亮不跟着滚动乱跳
        raf(step);
      };
      raf(step);
      return true;
    }
    // 用户自己动了（滚轮 / 按住拖 / 键盘）：马上放手。⚠ 挂在 window 的捕获阶段：二级滚轮归 ui.html 统一管，事件可能到不了内容区
    function bindPinCancel() {
      if (typeof window === 'undefined' || !window.addEventListener) return;
      var cancel = function (e) {
        if (!pinSeq || !e || !e.target || !zone.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.sc-rail,.sc-search')) return;   // 点导航 / 搜索结果本身不算
        pinSeq++; state.lockUntil = 0;
      };
      window.addEventListener('wheel', cancel, { capture: true, passive: true });
      window.addEventListener('pointerdown', cancel, { capture: true, passive: true });
    }

    // ══ 切到某一节（唯一入口）════════════════════════════
    // ⚠ how 保留只为兼容老调用（click / flip / api）—— 现在都是"滚过去"。
    function select(id, how, section) {
      if (!id || indexOfAnchor(id) < 0) return;
      // ⚠⚠ 2026-10-14 修（同 open() 那处的自愈）：点右边导航时如果页面是空的，
      //   下面的 scrollToAnchor 会因为找不到 [data-sec-anchor] 而【静默 return】——
      //   表现就是"点导航没反应，面板还是空白"。所以先补画一次。
      //   实测（tmp/_decisive-test.js 第 ④ 步）：不补这一刀，点导航也救不回来。
      if (pageIsBlank()) { if (section !== undefined) state.section = section || null; state.anchor = id; renderPage(); renderRail(); }
      if (section !== undefined) state.section = section || null;
      // 导航一动，旧的「?」说明浮层就收掉（目标已在视野里时页面不滚，靠滚动收不掉）
      try { (typeof window !== 'undefined') && window.dispatchEvent(new Event('wheelchair:settings-navigate')); } catch (_) {}
      state.anchor = id;
      zone.dataset.settingsTab = id;
      markRailCurrent();
      if (typeof host.onSelect === 'function') host.onSelect(id, how);
      // 路由进来（api）直接落位，不平滑滚 —— 用户还没看过这一页
      scrollToAnchor(id, how !== 'api');
    }

    // ══ 导航交互：点一下滚过去 ══════════════════════════
    function bindZone() {
      var rail = $('.sc-rail');
      if (!rail) return;
      rail.addEventListener('click', function (event) {
        var node = event.target.closest && event.target.closest('.scn');
        if (!node || !node.dataset.tab) return;
        select(node.dataset.tab, 'click');
      });
      rail.addEventListener('keydown', function (event) {
        var node = event.target.closest && event.target.closest('.scn');
        if (!node) return;
        var items = $$('.scn'), index = items.indexOf(node), target = index;
        if (event.key === 'ArrowDown') target = (index + 1) % items.length;
        else if (event.key === 'ArrowUp') target = (index + items.length - 1) % items.length;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = items.length - 1;
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(node.dataset.tab, 'click');
          return;
        } else return;
        event.preventDefault();
        items[target].focus();
      });
    }

    // ══ 开 / 关 ════════════════════════════════════════
    function popGlow() {
      $$('.z-glow,.z-bright').forEach(function (el) {
        el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
      });
    }
    // ⚠⚠⚠ 2026-10-14 修（用户报的"设置卡二级用着用着变一片空白、只剩右边导航"）：
    //   原来是 `if (state.open) { if (anchor) select(anchor, 'api', section); return; }`
    //   ——【只要 state.open 还是 true 就直接返回，不再画内容】。
    //   而内容被清空的路径不止一条（invalidate() 就是干这个的：切账号时同步拆旧节点），
    //   只要有一次"清了但没补回来"，state.open 仍然是 true ⇒ 之后：
    //     · 再点主卡进设置 → 走这里的 early return，不画
    //     · 点右边导航     → select() 只滚不画（scrollToAnchor 找不到节点就静默 return）
    //     · 切走再切回     → 同上
    //   ⇒ 永久空白，右边导航还在。实测复现（tmp/_decisive-test.js）：
    //     清空 .sc-pages 后，②③④⑤ 四步全是"🔴 空白可见"，一步都救不回来。
    //   ⇒ 修法：early return 之前先看"页面是不是空的"，空的就补画一次（自愈）。
    //   ⚠ 只在【真的空了】的时候补画，正常切页签的行为一点没变。
    //   ⚠ 这里不认识"页签"这个概念 —— 页面是一列到底的，所以补画不用管 anchor。
    function pageIsBlank() {
      var host_ = $('.sc-pages');
      return !host_ || host_.children.length === 0 || host_.textContent.trim() === '';
    }
    function open(anchor, section) {
      if (state.open) {
        // ⭐ 自愈：面板空着就当没开过，重画一遍（否则会永久空白）
        if (pageIsBlank()) {
          if (anchor && indexOfAnchor(anchor) >= 0) state.anchor = anchor;
          if (section !== undefined) state.section = section || null;
          renderPage();
          renderRail();
          scrollToAnchor(state.anchor, false);
        } else if (anchor) select(anchor, 'api', section);
        return;
      }
      state.open = true;
      if (anchor && indexOfAnchor(anchor) >= 0) state.anchor = anchor;
      state.section = section || null;
      zone.dataset.settingsTab = state.anchor;
      renderPage();
      renderRail();
      popGlow();
      scrollToAnchor(state.anchor, false);
      if (typeof host.onOpen === 'function') host.onOpen(state.anchor);
    }
    function close() {
      if (!state.open) return;
      state.open = false;
      if (search) hideResults();
      runPageCleanup();
      if (typeof host.onClose === 'function') host.onClose();
    }
    function isOpen() { return state.open; }
    function currentTab() { return state.anchor; }
    function currentSection() { return state.section; }

    /* ⚠⚠ 账号隔离：切账号时旧表单节点（带着上个账号的 Key）必须立刻脱离文档。
       分两步：invalidate() 同步拆旧节点；reload() 延后一拍再画（数据才是新的）。 */
    function invalidate() {
      runPageCleanup();
      var pages = $('.sc-pages');
      if (pages) pages.innerHTML = '';
      state.seq++;
    }
    function reload() {
      // ⚠⚠ 2026-10-14 改：原来是 `if (!state.open) { runPageCleanup(); return; }`
      //   —— 卡片没 open 就【只清不画】。配合上面的 invalidate()（它会把 .sc-pages 清空），
      //   只要"清"和"画"之间卡片的状态对不上，就留下一个【开着但空白】的面板。
      //   ⇒ 现在：面板可见（有 .sc-pages 这个壳）就画回来；真的连壳都没有才只清。
      //   ⚠ 判断用"壳在不在"而不是 state.open —— 用户看到的是"面板在那儿但是空的"，
      //     那就该把它画回来，不该再依赖一个内部布尔值。
      var shell = $('.sc-pages');
      if (!state.open && !shell) { runPageCleanup(); return; }
      if (!state.open) state.open = true;
      var body = $('[data-sc-body]');
      var keep = body ? body.scrollTop : 0;
      invalidate();
      renderPage();
      renderRail();
      var nb = $('[data-sc-body]');
      if (nb) nb.scrollTop = keep;
    }
    function flip(dir) {
      var i = indexOfAnchor(state.anchor), j = i + (dir > 0 ? 1 : -1);
      if (j < 0 || j >= SECTIONS.length) return false;
      select(SECTIONS[j].id, 'flip');
      return true;
    }

    return {
      mount: mount, open: open, close: close, isOpen: isOpen, reload: reload, invalidate: invalidate,
      select: select, flip: flip, currentTab: currentTab, currentSection: currentSection,
      scrollToAnchor: scrollToAnchor,
      tabs: SECTIONS, iconRenderer: function (fn) { icon.renderer = fn; }
    };
  }

  return { create: create, setIconRenderer: function (fn) { icon.renderer = fn; } };
});
