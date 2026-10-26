'use strict';
const { documentById } = require('./assistant-capture');
const fail = message => Object.assign(new Error(message), { code: 'LAYER_PROPERTIES_FAILED' });
function findLayer(layers, id) {
  for (const layer of layers || []) { if (Number(layer.id) === id) return layer; const child = findLayer(layer.layers, id); if (child) return child; }
  return null;
}
function createLayerProperties({ app, core }) {
  return async function properties(params = {}) {
    const docId = Number(params.docId), layerId = Number(params.layerId);
    if (!Number.isSafeInteger(docId) || docId < 1 || !Number.isSafeInteger(layerId) || layerId < 1) throw fail('必须指定原文档和结果图层编号');
    const changes = { _obj: 'layer' };
    if (params.name !== undefined) { if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 255 || /[\u0000-\u001f]/.test(params.name)) throw fail('图层名称无效'); changes.name = params.name; }
    if (params.visible !== undefined) { if (typeof params.visible !== 'boolean') throw fail('图层可见状态必须为布尔值'); changes.visible = params.visible; }
    // ⚠⚠ 2026-10-05（docs/143 §八-3①）：白名单加 'linearLight'（线性光）。
    //   用途：补细节改成"传一张可编辑的增量纹理层"，靠 PS 的线性光复现引擎公式
    //     out = 底图 + 2×(本层 − 128)
    //   实验台实测（tmp/colortest/texture_layer.py）：平均差 0.002，
    //   超 1/255 的像素只占 0.03% —— 数学上成立。
    //   ⚠ 但【PS 到底吃不吃这个枚举值】没验过（docs/143 §十三-1）：
    //     blendMode 的枚举名在各版本里叫法不完全一样。
    //     真机上如果 PS 拒绝，会走下面那句 throw —— 那时退「叠加(overlay)」近似，
    //     或者干脆退回现在的做法（引擎合成好直接传成品图）。
    //     ⇒ 这条【必须真机试】，试不通就退。
    if (params.blendMode !== undefined) { if (!['screen', 'normal', 'color', 'softLight', 'overlay', 'multiply', 'linearLight'].includes(params.blendMode)) throw fail('不支持此图层混合模式'); changes.mode = { _enum: 'blendMode', _value: params.blendMode }; }
    // ⭐⭐ 2026-10-11（用户要求："V6 传回的组在 PS 里带标注色，V7 也要，而且要能自定义"）
    //   图层/组的【标注颜色】（图层面板里名字右边那个小色块）。
    //
    //   ⚠ 只能在 9 个固定颜色里选 —— 这是 Photoshop 自己写死的，不是我们偷懒：
    //     UXP 的 DOM API【没有】这个属性（Adobe 论坛 2023 年确认过），只能走 batchPlay；
    //     而能取的值就是 ColorName 那 9 个。社区从 2020 年就在申请自定义色，Adobe 没做。
    //   ⚠⚠ 两个坑（都写在 Adobe 的类型定义注释里，是 Photoshop 内部字符码撞车留下的 bug）：
    //     · 黄色叫 'yellowColor'，【不是】'yellow'
    //     · 在 RGB 色空间里 'green' 反而叫 'grain' —— 但【标注色这里就是 green】，
    //       别把两个地方的坑搞混（grain 只影响 RGBColor 的绿通道字段名）
    //   ⚠ 写法照抄 V6 的 host/ps-io.js（轮椅 4.0 → 6.4.6 八个版本都在用同一句，
    //     实测有效；V6 写死 'yellowColor'，我们把它做成可选）。
    //   ⚠ 与 V6 的唯一差别：V6 用 { _ref:'layer', _enum:'ordinal', _value:'targetEnum' }
    //     打【当前选中项】；我们按 layerId 定位，更精确 ——
    //     组是刚建的、当前确实选中，但按 ID 定位不依赖"当前选中"这个隐含前提。
    if (params.color !== undefined) {
      const allowed = ['none', 'red', 'orange', 'yellowColor', 'green', 'blue', 'violet', 'gray', 'black'];
      if (typeof params.color !== 'string' || !allowed.includes(params.color)) throw fail('不支持的标注颜色');
      changes.color = { _enum: 'color', _value: params.color };
    }
    if (Object.keys(changes).length === 1) throw fail('没有要设置的图层属性');
    await core.executeAsModal(async () => {
      const doc = documentById(app, docId);
      if (!doc || !findLayer(doc.layers, layerId)) throw fail('原文档或结果图层已关闭、删除，已停止后处理');
      const result = await app.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _id: layerId }, { _ref: 'document', _id: docId }], to: changes }], {});
      if (!result || result.some(item => item && (item._obj === 'error' || Number(item.result) < 0))) throw fail('Photoshop 拒绝了图层属性设置');
    }, { commandName: '设置结果图层属性' });
    return { updated: true, docId, layerId, name: params.name, visible: params.visible, blendMode: params.blendMode, color: params.color };
  };
}
module.exports = { createLayerProperties, findLayer };
