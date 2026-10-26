/* 界面缩放（ui-scale.js）· 2026-10-18 深夜（docs/248）
 *
 * 用户原话：「现在的软件是跟随系统缩放来走的。默认打开的时候是系统缩放，但是用户可以自行改变缩放，
 *           就让整个软件整体缩放，因为有些笔记本用户现在已经要炸了」
 * 拍板：默认 = 跟系统（100%）；设置 → 外观 →「界面大小」70%～150%；整个界面 + 窗口一起缩。
 *
 * 真正干活的是外壳（src-tauri/src/ui_scale.rs：WebView 缩放 + 主窗口按比例改尺寸，存在外壳配置里，开软件时页面加载前就用上）。
 * 这里只管：① 设置里那一节（滑条 + 几个常用档 + 恢复跟随系统）；② 记住当前比例给别处用（window.__v7Zoom，
 *   tauri-adapter.js 把屏幕坐标换成页面坐标时要再除以它）；③ 关于软件 / 诊断信息里写一句现在是多少。
 * ⚠ 这是【这台电脑】的设置，不跟账号走（换账号不变；不进云备份）。
 */
(function (root) {
  'use strict';

  var MIN = 70, MAX = 150, STEP = 5;
  var PRESETS = [80, 90, 100, 110, 125];
  var state = { scale: 1, wanted: 1, fitMax: null, supported: false, busy: false, error: '' };
  // ⭐ 2026-10-21（docs/261 B5）：屏幕放不下时外壳自动用放得下的最大一档 —— scale = 真正用上的，wanted = 用户要的
  function remember(r, fallback) {
    state.scale = Number(r.scale) > 0 ? Number(r.scale) : fallback;
    state.wanted = Number(r.wanted) > 0 ? Number(r.wanted) : state.scale;
    state.fitMax = Number(r.fitMax) > 0 ? Number(r.fitMax) : null;
  }
  function capped() { return pct(state.wanted) > pct(state.scale); }
  function capNote() { return '这块屏放不下 ' + pct(state.wanted) + '%，自动用了放得下的最大 ' + pct(state.scale) + '%'; }
  var listeners = [];

  function api() { return root.uiwin && root.uiwin.uiScale; }
  function pct(s) { return Math.round(s * 100); }
  function publish() {
    root.__v7Zoom = state.scale;
    listeners.slice().forEach(function (fn) { try { fn(state.scale); } catch (_) {} });
  }

  function boot() {
    var a = api();
    if (!a || typeof a.get !== 'function') { state.supported = false; publish(); return Promise.resolve(state.scale); }
    state.supported = true;
    return Promise.resolve(a.get()).then(function (r) {
      if (r && r.ok && Number(r.scale) > 0) remember(r, state.scale);
      publish();
      // 开软件时被自动压过一档：说一次（不然用户以为自己调的大小没记住）
      if (capped() && root.UI && typeof root.UI.toast === 'function') {
        root.setTimeout(function () { try { root.UI.toast(capNote(), 'info', 6000); } catch (_) {} }, 2500);
      }
      return state.scale;
    }, function () { publish(); return state.scale; });
  }

  function set(percent) {
    var a = api();
    var p = Math.max(MIN, Math.min(MAX, Math.round(Number(percent) / STEP) * STEP));
    if (!a || typeof a.set !== 'function') return Promise.resolve({ ok: false, error: '这一份软件不能调界面大小' });
    if (state.busy) return Promise.resolve({ ok: false, error: '正在调，稍等' });
    state.busy = true; state.error = '';
    return Promise.resolve(a.set(p / 100)).then(function (r) {
      state.busy = false;
      if (r && r.ok) { remember(r, p / 100); if (r.saved === false) state.error = r.error || ''; publish(); }
      else state.error = (r && r.error) || '没调成';
      return r || { ok: false };
    }, function (error) {
      state.busy = false; state.error = String(error && error.message || error);
      return { ok: false, error: state.error };
    });
  }

  function describe() {
    var p = pct(state.scale);
    return p === 100 ? '跟随系统（100%）' : p + '%（在系统缩放基础上）';
  }

  // ── 设置里那一节 ──
  function mountSettings(el) {
    if (!el) return null;
    el.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'v7-uiscale';
    wrap.setAttribute('data-ui-scale', '');
    var top = document.createElement('div'); top.className = 'v7-uiscale-top';
    var label = document.createElement('b'); label.className = 'v7-uiscale-value'; label.setAttribute('data-ui-scale-value', '');
    var range = document.createElement('input');
    range.type = 'range'; range.min = String(MIN); range.max = String(MAX); range.step = String(STEP);
    range.setAttribute('aria-label', '界面大小'); range.setAttribute('data-ui-scale-range', '');
    top.append(range, label);
    var chips = document.createElement('div'); chips.className = 'v7-uiscale-chips';
    PRESETS.forEach(function (p) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'settings-btn'; b.dataset.uiScalePreset = String(p);
      b.textContent = p === 100 ? '跟随系统（100%）' : p + '%';
      b.addEventListener('click', function () { apply(p); });
      chips.append(b);
    });
    var status = document.createElement('p'); status.className = 'settings-status-line'; status.setAttribute('role', 'status');
    var tip = document.createElement('p'); tip.className = 'settings-status-line';
    tip.textContent = '整个软件（卡片、文字、按钮、窗口）一起放大缩小。笔记本屏幕放不下就调小；松开滑条就生效，下次打开还是这个大小。只影响这台电脑。';
    wrap.append(top, chips, status, tip);
    el.append(wrap);

    function paint() {
      var p = pct(state.scale);
      if (document.activeElement !== range) range.value = String(p);
      label.textContent = (document.activeElement === range ? range.value : p) + '%';
      chips.querySelectorAll('[data-ui-scale-preset]').forEach(function (b) { b.classList.toggle('settings-btn-primary', Number(b.dataset.uiScalePreset) === p); });
      range.disabled = !state.supported || state.busy;
      if (!state.supported) status.textContent = '这一份软件不能调界面大小（只有正式软件里能调）。';
      else if (state.error) status.textContent = state.error;
      else status.textContent = '现在：' + describe() + (capped() ? '。' + capNote() + '（换到大屏上会回到 ' + pct(state.wanted) + '%）' : (state.fitMax && pct(state.scale) > pct(state.fitMax) ? '。这个大小比这块屏还大，窗口已经铺满屏幕，边上一截可能看不全，看不全就调小一点' : ''));
    }
    function apply(p) {
      status.textContent = '正在调到 ' + p + '%…';
      set(p).then(function () { paint(); });
    }
    range.addEventListener('input', function () { label.textContent = range.value + '%'; });
    range.addEventListener('change', function (event) {
      // 只认用户真的拖了滑条（isTrusted）—— 防止哪段代码改了 value 再派个假事件，把比例悄悄改掉
      if (event && event.isTrusted === false) return;
      apply(Number(range.value));
    });
    listeners.push(paint);
    paint();
    if (!state.supported) boot().then(paint);
    return function () { listeners = listeners.filter(function (fn) { return fn !== paint; }); };
  }

  root.V7UiScale = { MIN: MIN, MAX: MAX, boot: boot, set: set, describe: describe, current: function () { return state.scale; }, mountSettings: mountSettings };
  boot();
})(typeof window !== 'undefined' ? window : globalThis);
