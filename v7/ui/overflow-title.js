'use strict';
// ════════════════════════════════════════════════════════════════════
// overflow-title.js —— 被截断的文字，鼠标停上去能看到全文（docs/263 2.5「截断无退路」）
//
//   现在全项目 88 处 text-overflow:ellipsis / line-clamp，只有 252 个元素写了 title，
//   而被截掉的文字（预设名、模型名、报错摘要、文件名）恰恰是最需要看全文的地方。
//
//   做法：不挨个改 88 处，而是在 document 上挂一个 pointerover，鼠标停到哪个元素上，
//   就地量一下「文字比框宽吗」——宽了就把它自己的文字设进 title。
//   · 只有真被截断才设，没截断的不设（不然每行都有个多余的提示框）
//   · 元素自己已有 title 的不动（手写的提示更准）
//   · 量一次记一次（WeakSet），内容变了（MutationObserver 太贵）下次悬停会重新量：
//     每次悬停都重量，代价是读一次 scrollWidth，可接受
//   · 只认「单行截断」和「多行 -webkit-line-clamp」两种，其它情况不碰
//
//   ⚠ 弹气泡由浏览器原生 title 负责，和 hover-delay.js 那套（自己画的气泡）不是一回事：
//     原生 title 自带约 1 秒延迟，不会闪。
// ════════════════════════════════════════════════════════════════════
(function (root) {
  if (!root || !root.document) return;
  const SKIP = /^(html|body|main|section|article)$/i;

  // ⭐ 2026-10-22 修：原来只比 scrollWidth/clientWidth，滚动列表、卡片容器、设置面板也算「被截断」，
  //   往上 4 层一路把整张卡的 textContent 塞进 title → 到处闪巨型原生提示框。
  //   现在必须是真写了省略号（overflow 非 visible + text-overflow:ellipsis）或 line-clamp 的元素才算。
  function clipped(el) {
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible') return false;
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) return true;   // 单行省略号
    const clamp = cs.webkitLineClamp;
    return !!clamp && clamp !== 'none' && el.scrollHeight > el.clientHeight + 1;              // 多行 line-clamp
  }

  const ours = new WeakSet();   // 我们自动设的 title（手写的不动）

  function onOver(e) {
    let el = e.target;
    for (let depth = 0; el && depth < 4; depth++) {
      if (el.nodeType === 1 && !SKIP.test(el.tagName) && (ours.has(el) || !el.getAttribute('title'))) {
        const text = (el.textContent || '').trim();
        if (clipped(el) && text.length > 4) { el.setAttribute('title', text); ours.add(el); }
        else if (ours.has(el)) { el.removeAttribute('title'); ours.delete(el); }
      }
      el = el.parentElement;
    }
  }

  // 捕获阶段听：不会被卡片自己的 stopPropagation 拦掉
  root.document.addEventListener('pointerover', onOver, true);
})(typeof self !== 'undefined' ? self : this);
