/* 参考图 · 各模型能收几张（兜底表）（融合方案-C01 §3.1 / §6 D1·D2）
 *
 * 等后台的 /v1/models 给每个模型带上这两个字段之后，这张表就退位成兜底：
 *     supportsReference: true/false
 *     maxReferences:     Number      ⚠ 不含主图（跟 reference-limits.js 口径一致）
 *   ⚠ 字段名是 C01 §6 定死的，后台那边必须叫这两个名字 —— 名字对不上不报错，只是永远读到 undefined。
 *
 * 这张表只记【比产品上限（5 张）还低】的模型。没列出来的 = 按产品上限走。
 *   ⚠ 只记有出处的数字。查不到的（gpt-image-2 系列可能是中转商起的名字）不瞎填，按产品上限走（C01 §9.1）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7ReferenceCapability = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var TABLE = Object.freeze({
    // Nano Banana 原版：官方最多 3 张参考图（Runway 文档，C01 §9.1）
    'gemini-2.5-flash-image': { supportsReference: true, maxReferences: 3, source: 'Runway 文档' }
  });

  // 后台给的覆盖（宿主拉到 /v1/models 后调 setRemote）。模型 id → {supportsReference,maxReferences}
  var remote = Object.create(null);

  function setRemote(rows) {
    remote = Object.create(null);
    (Array.isArray(rows) ? rows : []).forEach(function (m) {
      if (!m || !m.id) return;
      var row = {};
      if (typeof m.supportsReference === 'boolean') row.supportsReference = m.supportsReference;
      if (Number.isFinite(Number(m.maxReferences)) && m.maxReferences !== null && m.maxReferences !== '') row.maxReferences = Math.max(0, Math.floor(Number(m.maxReferences)));
      if (Object.keys(row).length) remote[String(m.id)] = row;
    });
  }

  // 返回 { supportsReference, maxReferences|null, from: 'remote'|'table'|'' }
  //   maxReferences = null 表示「这个模型自己没限制」，交给产品上限。
  function forModel(model) {
    var id = String(model || '');
    var r = remote[id], t = TABLE[id];
    if (r) return { supportsReference: r.supportsReference !== false, maxReferences: r.maxReferences != null ? r.maxReferences : (t ? t.maxReferences : null), from: 'remote' };
    if (t) return { supportsReference: t.supportsReference !== false, maxReferences: t.maxReferences, from: 'table' };
    return { supportsReference: true, maxReferences: null, from: '' };
  }

  return { forModel: forModel, setRemote: setRemote, TABLE: TABLE };
});
