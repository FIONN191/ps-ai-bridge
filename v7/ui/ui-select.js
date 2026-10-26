// ============================================================
//  ui-select.js — 标准下拉框 (window.UISelect)
//
//  为什么要有它: 原生 <select> 的选项面板是系统画的, 在透明置顶壳上是一块白纸,
//  跟毛玻璃卡片完全不搭(用户 2026-09-11 截图指出)。
//
//  做法: 【渐进增强】—— 不替换 <select>, 只把它藏起来当"值的载体",
//  在它旁边画一个同款样式的触发器 + 选项面板。
//    · 谁读 el.value / 谁监听 change —— 一个字不用改(设置/生成/预设对话框全兼容)
//    · 键盘: 上下选、回车确认、Esc 关
//    · 面板自动判断: 下方放不下就往上弹(用户定案)
//    · 面板 Portal 到 body(fixed): 不被卡片的 overflow:hidden 裁掉(记忆里的坑)
//
//  ⚠ 面板是一个新的全窗口浮层 → 必须在 overUI() 里登记, 否则点击穿透(2026-09-11 刚栽过)。
//    这里暴露 UISelect.isOpen() 给 overUI 用。
// ============================================================
(function () {
  'use strict';

  let openPanel = null;       // 当前打开的面板 {panel, select, trigger, items, idx}

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function labelOf(sel) {
    const o = sel.options[sel.selectedIndex];
    return o ? o.textContent : '';
  }

  function enhance(sel) {
    if (!sel || sel.tagName !== 'SELECT' || sel._uiSel) return;
    sel._uiSel = true;
    sel.classList.add('uisel-native');
    // ⭐⭐ 2026-10-15（跟「完成音效」点了设置二级左边整片空白是同一种病，见 ui.html .tgl 的注释）：
    //   藏起来的原生 select 是 position:absolute，参照物常在滚动框外面 —— 它的"隐身位置"
    //   不跟着滚动框走，一拿焦点浏览器就去滚外层不该滚的框，把整页内容推出视野。
    //   真正给人用的是下面那个 trigger 按钮，原生 select 根本不该拿焦点：
    //   ① 不进 Tab 顺序；② 点字段标题（label）时别把焦点交给它（文件底部那条全局拦截）。
    sel.tabIndex = -1;

    const trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'uisel-trigger';
    // 继承原 select 的 class(如 ps-dlg-input / settings-field 里的), 让原来的尺寸规则照常生效
    trig.setAttribute('data-uisel-for', '');
    // ⚠ 箭头图标：库没加载就回退成 ▾，不要留空 —— 那样看不出这是个下拉框
    const arrowIco = window.ICON ? window.ICON.render('chevronDown', 12) : '▾';
    trig.innerHTML = '<span class="uisel-label"></span><span class="uisel-arrow">' + arrowIco + '</span>';
    sel.insertAdjacentElement('afterend', trig);

    // ⚠⚠ 2026-10-08（用户定：模型名"就显示 id，只把截断做得体面些"）：
    //   下拉框收起时只显示当前那一项，窄格子里长名字会被 CSS 的省略号切掉
    //   （用户看到过"gemini-2.5-flash-…"这种）。
    //   ⇒ 把【全文】放进 title，鼠标悬停能看到完整 id。
    //   ⚠ title 挂在 trigger 的【内部 label】上而不是 button 上：
    //     挂在 button 上时，面板里的项也跟着弹同一个提示，看着乱。
    //   ⚠ 只在真的超长时才挂：短名字挂个跟自身一样的提示是噪音。
    const sync = () => {
      const label = trig.querySelector('.uisel-label');
      const 全文 = labelOf(sel);
      label.textContent = 全文;
      trig.disabled = !!sel.disabled;
      if (String(全文).length > 12) label.title = 全文;
      else label.removeAttribute('title');
    };
    sync();
    // 外部改了 select.value(比如恢复默认) → 触发器要跟
    sel.addEventListener('change', sync);
    const mo = new MutationObserver(sync);
    mo.observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled'] });

    trig.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); if (openPanel && openPanel.select === sel) close(); else open(sel, trig); });
    trig.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(sel, trig); }
    });
  }

  function open(sel, trig) {
    close();
    const panel = document.createElement('div');
    panel.className = 'uisel-panel';
    const items = [];
    [...sel.options].forEach((o, i) => {
      const it = document.createElement('div');
      it.className = 'uisel-item' + (i === sel.selectedIndex ? ' cur' : '') + (o.disabled ? ' off' : '');
      it.textContent = o.textContent;
      // ⚠ 2026-10-08：选项面板里也挂 title —— 面板虽然比 trigger 宽，
      //   但模型 id 动辄二三十个字符，照样会被切。悬停看全文。
      if (String(o.textContent).length > 16) it.title = o.textContent;
      // ⚠ 2026-10-07：把宿主的标记带进自绘面板（生成卡的模型名单纯用它区分
      //   "确定的生图模型（正常亮度）/ 疑似的（灰色但仍可点选）"）。
      //   ⚠ 只搬这一个属性，不做任何判断 —— 通用组件不该知道业务含义。
      //   ⚠ 不写进 textContent：那个文本同时被"收起状态那一行"用。
      if (o.dataset && o.dataset.v7tier) it.dataset.v7tier = o.dataset.v7tier;
      it.dataset.i = String(i);
      if (!o.disabled) {
        it.addEventListener('click', ev => { ev.stopPropagation(); commit(i); });
        it.addEventListener('mouseenter', () => setIdx(i));
      }
      panel.appendChild(it);
      items.push(it);
    });
    // ⚠ Portal 到 body: fixed 层被有 transform 的祖先困住会缩成一小块(记忆里的坑)
    // Modal dialogs occupy the top layer; a body portal would be inert underneath.
    (sel.closest('dialog[open]') || document.body).appendChild(panel);
    openPanel = { panel, select: sel, trigger: trig, items, idx: sel.selectedIndex };
    place();
    trig.classList.add('open');
    // 当前项滚到可见
    const cur = items[sel.selectedIndex];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    // 键盘接管
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  }

  // 位置: 贴在触发器下方; 下方放不下就翻到上方(用户定案)。面板最高 260。
  function place() {
    if (!openPanel) return;
    const { panel, trigger } = openPanel;
    const r = trigger.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const maxH = 260, gap = 4;
    panel.style.width = r.width + 'px';
    panel.style.left = Math.max(4, Math.min(r.left, vw - r.width - 4)) + 'px';
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const h = Math.min(maxH, panel.scrollHeight);
    if (below >= h || below >= above) {
      panel.style.maxHeight = Math.min(maxH, Math.max(80, below)) + 'px';
      panel.style.top = (r.bottom + gap) + 'px';
      panel.classList.remove('up');
    } else {
      panel.style.maxHeight = Math.min(maxH, Math.max(80, above)) + 'px';
      panel.style.top = (r.top - gap - Math.min(h, above)) + 'px';
      panel.classList.add('up');
    }
  }

  function setIdx(i) {
    if (!openPanel) return;
    openPanel.items.forEach((it, k) => it.classList.toggle('hover', k === i));
    openPanel.idx = i;
  }
  function commit(i) {
    if (!openPanel) return;
    const sel = openPanel.select;
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    close();
    // ⚠ 派发真的 change/input —— 所有现存监听靠这个拿值
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function onKey(ev) {
    if (!openPanel) return;
    const n = openPanel.items.length;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); let i = openPanel.idx; do { i = (i + 1) % n; } while (openPanel.items[i].classList.contains('off') && i !== openPanel.idx); setIdx(i); openPanel.items[i].scrollIntoView({ block: 'nearest' }); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); let i = openPanel.idx; do { i = (i - 1 + n) % n; } while (openPanel.items[i].classList.contains('off') && i !== openPanel.idx); setIdx(i); openPanel.items[i].scrollIntoView({ block: 'nearest' }); return; }
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); commit(openPanel.idx); return; }
  }
  function onOutside(ev) {
    if (!openPanel) return;
    if (openPanel.panel.contains(ev.target) || openPanel.trigger.contains(ev.target)) return;
    close();
  }
  function close(opts) {
    if (!openPanel) return;
    const { panel, trigger } = openPanel;
    trigger.classList.remove('open');
    panel.remove();
    openPanel = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    // ⭐ 2026-10-20（docs/256 T3，用户报「选完语言模型软件就卡死：拖不动、滚不动，但侧边栏还能呼出」）：
    //   把焦点还给下拉框时【不许滚动】—— 不加的话浏览器为了让它露出来，会去滚它外面那些 overflow:hidden 的框，
    //   整片界面错位、滚也滚不回来（跟下面点标签那段是同一个坑，那边早就加了 preventScroll，这里漏了）。
    if (!(opts && opts.focus === false)) { try { trigger.focus({ preventScroll: true }); } catch (_) { } }
  }

  // ⭐ 2026-10-15（用户报：鼠标移出去，二级卡收了，下拉面板还留在原地）：
  //   面板挂在 body 上，卡片收起时它不会自己走 ⇒ 卡片收起时调这个，把【它里面】那个下拉框的面板一起收掉。
  //   ⚠ 不把焦点还给 trigger：卡正在收，焦点塞回去会让浏览器去滚那张正在收的卡。
  function closeWithin(root) {
    if (!openPanel || !root) return false;
    if (!root.contains(openPanel.select) && !root.contains(openPanel.trigger)) return false;
    close({ focus: false });
    return true;
  }

  // 扫一遍容器里所有还没增强的 select。界面重画(innerHTML)后要再调一次。
  function enhanceAll(root) {
    (root || document).querySelectorAll('select:not(.uisel-native)').forEach(enhance);
  }

  // 自动: 任何地方塞进来新的 <select> 都自动增强 —— 这样各处画界面的代码一行不用改
  const mo = new MutationObserver(muts => {
    let need = false;
    for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { need = true; break; } }
    if (need) enhanceAll(document);
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
  enhanceAll(document);

  // 点字段标题（<label> 里的文字）时，浏览器默认会把焦点交给 label 里的原生 select
  //   → 就是上面 enhance 里说的"外层框被推走、整页空白"。改成把焦点交给看得见的 trigger，且不滚动。
  //   ⚠ 点在按钮/输入框等自己能响应的东西上时浏览器本来就不转交，这里也不管。
  document.addEventListener('click', ev => {
    const lab = ev.target && ev.target.closest ? ev.target.closest('label') : null;
    const c = lab && lab.control;
    if (!c || !c.classList || !c.classList.contains('uisel-native')) return;
    if (ev.target.closest('button,a,input,select,textarea')) return;
    ev.preventDefault();
    const t = c.nextElementSibling;
    if (t && t.classList.contains('uisel-trigger')) { try { t.focus({ preventScroll: true }); } catch (_) { } }
  }, true);

  window.UISelect = { enhance, enhanceAll, close, closeWithin, isOpen: () => !!openPanel, panelEl: () => openPanel && openPanel.panel };
})();
