/* 参考图 · 数字的【唯一出处】（融合方案-C01 §3.1 / §7 P1）
 *
 * 用户 2026-10-01 拍板（R1）：「参考图最多 5 张，加上主图一共最多 6 张」。
 *   ⚠ 这是【产品决策】不是技术限制 —— 官方 GPT 能收 16 张、Banana Pro 能收 14 张，
 *     用户知道，选择不要那么多（多张会明显降质）。别拿「官方支持更多」去推翻（C01 §2）。
 *
 * ⚠⚠ 口径（C01 §4.4，本项目「5 还是 6」的头号冲突点）：
 *   REFS_MAX  = 5  —— 【参考图】张数，不含主图（全项目代码里一律用这个口径）
 *   TOTAL_MAX = 6  —— 含主图，只给界面文案用（「加原图共 6 张」）
 *   「参考图」只指送进模型的【额外】图；PS 里抓的那张叫「原图 / 主图」，不是参考图（C01 §7 P4）。
 *
 * ⚠ 以后要改数字只改这里。别的地方（闸门、弹窗、存储）一律读这个文件，不许再各写一份。
 *   例外：preset-store.js 读【已存的】预设时仍按 12 放行 —— 降到 5 会让已经存了 6~12 张的老预设
 *   直接读不出来（2026-10-02 实装时查到的，见 docs/121）。新加的图由闸门卡在 5。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7ReferenceLimits = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var REFS_MAX = 5;
  return Object.freeze({
    REFS_MAX: REFS_MAX,
    TOTAL_MAX: REFS_MAX + 1,
    BYTES_MAX: 96 * 1024 * 1024,          // 值跟原来 preset-references.js 写死的一样，只是挪到这里
    // 老预设读取时的放行上限（见文件头「例外」）。不是给新加的图用的。
    STORED_MAX: 12,
    FORMATS: Object.freeze(['image/png', 'image/jpeg', 'image/webp'])
  });
});
