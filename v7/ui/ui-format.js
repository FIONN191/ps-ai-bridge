'use strict';
// ════════════════════════════════════════════════════════════════════
// ui-format.js —— 全软件统一的「时间 / 数字」写法
// ⭐ 2026-10-22（docs/263 第 16 条，用户在对照台拍板「实装」）：
//   以前各处各写各的：有的 toLocaleString()（跟着系统区域走，长短不一），有的手拼
//   「2026-10-22 03:14:07」，只有预设卡写「3 分钟前」；数字 12500 / 1234567 要自己数位数。
//
// 规矩（照行业惯例）：
//   · 列表里「过去发生的事」→ ago()：刚刚 / N 分钟前 / N 小时前 / 昨天 14:03 / N 天前 / 10月3日 / 2025年10月3日；
//     鼠标停上去看完整时间（agoHtml 自带 title）。
//   · 「现在的状态」（已更新 · 14:32）照旧用钟点 —— 那是在说现在，不是在说多久以前。
//   · 「将来的时间」（日程提醒）照旧写完整日期。
//   · 数字一律千分位：num(12500) = "12,500"。
//
// agoHtml 生成的 <time data-ago> 每分钟自己刷新一次，不用调用方管。
// ════════════════════════════════════════════════════════════════════
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const DAY = 86400000;

  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v > 0 && v < 1e11 ? v * 1000 : v;   // 秒级时间戳也认
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    if (Number.isFinite(n) && /^\d+$/.test(String(v).trim())) return toMs(n);
    return Date.parse(String(v));
  }

  // 完整时间：2026-10-22 14:03
  function full(v) {
    const t = toMs(v);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function ago(v, now) {
    const t = toMs(v);
    if (!Number.isFinite(t)) return '';
    const n = Number.isFinite(now) ? now : Date.now();
    const d = new Date(t), today = new Date(n); today.setHours(0, 0, 0, 0);
    const s = Math.round((n - t) / 1000);
    if (s < -60) return full(t);                    // 将来的时间：不说「几分钟后」，直接写清楚
    if (s < 45) return '刚刚';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟前';
    if (t >= today.getTime()) return Math.floor(s / 3600) + ' 小时前';
    if (t >= today.getTime() - DAY) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (t >= today.getTime() - 6 * DAY) return Math.ceil((today.getTime() - t) / DAY) + ' 天前';
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 拼进 innerHTML 用：<time title="完整时间" data-ago="毫秒">3 分钟前</time>
  function agoHtml(v, fallback) {
    const t = toMs(v);
    if (!Number.isFinite(t)) return '<time>' + String(fallback || '时间未知') + '</time>';
    return '<time datetime="' + new Date(t).toISOString() + '" title="' + full(t) + '" data-ago="' + t + '">' + ago(t) + '</time>';
  }

  // 用 textContent 填的地方：顺手把完整时间挂到 title 上
  function setAgo(el, v) {
    if (!el) return;
    const t = toMs(v);
    el.textContent = ago(t) || '时间未知';
    if (Number.isFinite(t)) { el.title = full(t); el.dataset.ago = String(t); }
  }

  function num(v, digits) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('zh-CN', { maximumFractionDigits: Number.isFinite(digits) ? digits : 2 });
  }

  function refreshAll() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-ago]').forEach(el => {
      const text = ago(Number(el.dataset.ago));
      if (text && el.textContent !== text) el.textContent = text;
    });
  }
  if (typeof setInterval === 'function' && typeof document !== 'undefined') setInterval(refreshAll, 60000);

  // ── 空状态（docs/263 第 1 条，10-22 用户拍板「实装」）──
  //   以前各处只写一句「暂无 X」，不告诉人怎么才能有。统一成：说是什么 + 怎么才会有 + （有现成操作的）一个按钮。
  //   范本是记录卡的检查点空状态（records-card.js：「还没有检查点 · 下次生成前会自动存一次」/「去开启」）。
  //   o = { title, hint, action: { label, attrs: 'data-xxx' } }   attrs 是按钮上的属性（调用方自己的点击处理认它）
  function emptyHtml(o) {
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const a = o && o.action;
    return '<div class="v7-empty" role="status"><div class="v7-empty-t">' + esc(o && o.title) + '</div>'
      + (o && o.hint ? '<div class="v7-empty-h">' + esc(o.hint) + '</div>' : '')
      + (a && a.label ? '<button type="button" class="v7-empty-btn" ' + String(a.attrs || '') + '>' + esc(a.label) + '</button>' : '')
      + '</div>';
  }

  // ── 加载中：灰色占位行（docs/263 第 2 / 17 条）──
  //   以前加载时要么一片空白、要么一句「正在读取…」，内容一到整块砸下来、下面的东西被顶走。
  //   占位行的高度跟真实列表行差不多，内容到了原地换上。rows = 几行；thumb = 左边带不带方块（有缩略图的列表）
  function skeletonHtml(rows, opts) {
    const n = Math.max(1, Math.min(12, Number(rows) || 3)), thumb = !!(opts && opts.thumb);
    let html = '<div class="v7-skel" aria-busy="true" aria-label="正在读取">';
    for (let i = 0; i < n; i++) {
      html += '<div class="v7-skel-row">' + (thumb ? '<i class="v7-skel-box"></i>' : '')
        + '<span class="v7-skel-lines"><i class="v7-skel-bar" style="width:' + (52 + (i * 17) % 36) + '%"></i><i class="v7-skel-bar sm" style="width:' + (28 + (i * 11) % 24) + '%"></i></span></div>';
    }
    return html + '</div>';
  }

  // ── 出错：说清楚 + 重试按钮（docs/263 第 17 条：以前出错和「没有」长得一样，或者只在角落写一句）──
  function errorHtml(o) {
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const a = o && o.action;
    return '<div class="v7-empty v7-error" role="alert"><div class="v7-empty-t">' + esc((o && o.title) || '没读出来') + '</div>'
      + (o && o.hint ? '<div class="v7-empty-h">' + esc(o.hint) + '</div>' : '')
      + (a && a.label ? '<button type="button" class="v7-empty-btn" ' + String(a.attrs || '') + '>' + esc(a.label) + '</button>' : '')
      + '</div>';
  }

  const api = { full, ago, agoHtml, setAgo, num, refreshAll, toMs, emptyHtml, skeletonHtml, errorHtml };
  root.V7Format = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
