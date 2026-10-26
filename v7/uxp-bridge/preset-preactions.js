'use strict';
const contract = require('./preset-preactions-contract.js');
function fail(code, message, details) { return Object.assign(new Error(message), {code}, details || {}); }
function createPresetPreActions({app, core, fs, now = () => Date.now()}) {
  const REGISTRY = 'wheelchair-graphics-packs.json';
  async function registry() {
    const folder = await fs.getDataFolder();
    let file;
    try { file = await folder.getEntry(REGISTRY); }
    catch (_) { return {folder, packs: []}; }
    try {
      const data = JSON.parse(await file.read());
      if (!data || data.version !== 1 || !Array.isArray(data.packs)) throw new Error('invalid registry');
      return {folder, packs: data.packs};
    } catch (_) { throw fail('GRAPHICS_REGISTRY_INVALID', '图形包安装记录损坏，请保留文件并重新安装所需工具包'); }
  }
  async function checked(descriptors, code) {
    const result = await app.batchPlay(descriptors, {synchronousExecution: true});
    const bad = Array.isArray(result) && result.find(item => item && item._obj === 'error');
    if (!Array.isArray(result) || result.length !== descriptors.length || bad) throw fail(code || 'PREACTION_PS_FAILED', bad && bad.message || 'Photoshop 没有确认这次操作');
    return result;
  }
  function validateDocument(p) {
    if (!Number.isSafeInteger(p.docId) || p.docId < 1) throw fail('PREACTION_DOCUMENT_REQUIRED', '前置动作缺少目标文档，请重新选择预设');
    const doc = app.activeDocument;
    if (!doc || Number(doc.id) !== p.docId) throw fail('PREACTION_DOCUMENT_CHANGED', 'Photoshop 当前文档已经切换，未执行前置动作');
    if (p.docName !== undefined && String(doc.name) !== p.docName || p.docWidth !== undefined && Number(doc.width) !== p.docWidth || p.docHeight !== undefined && Number(doc.height) !== p.docHeight) throw fail('PREACTION_DOCUMENT_CHANGED', '目标文档的名称或尺寸已变化，请重新选择预设');
    if (!Number.isFinite(p.expiresAt) || p.expiresAt <= now()) throw fail('PREACTION_EXPIRED', '前置动作等待过久，已取消，请重新选择预设');
    return doc;
  }
  async function readState(config) {
    const properties = ['tool'];
    if (config.foreground) properties.push('foregroundColor');
    if (config.background) properties.push('backgroundColor');
    const result = await checked(properties.map(property => ({_obj: 'get', _target: [{_property: property}, {_ref: 'application', _enum: 'ordinal', _value: 'targetEnum'}]})));
    const state = {};
    properties.forEach((property, index) => { state[property] = result[index][property]; });
    return state;
  }
  function toolName(state) { return typeof state.tool === 'string' ? state.tool : state.tool && (state.tool._value || state.tool._ref); }
  function colorMatches(actual, hex) {
    if (!actual) return false;
    const expected = contract.colorDescriptor('foreground', hex).to;
    return [['red','red'], ['grain','grain'], ['blue','blue']].every(([key, expectedKey]) => {
      const value = key === 'grain' && actual.grain === undefined ? actual.green : actual[key];
      return Number.isFinite(Number(value)) && Math.abs(Number(value) - expected[expectedKey]) <= 1;
    });
  }
  async function prepare(params = {}) {
    const config = contract.normalize(params.preActions);
    if (!config || !config.enabled) return {applied: false, skipped: true};
    validateDocument(params);
    const requiredPacks = config.packIds || [];
    const installed = requiredPacks.length ? (await registry()).packs : [];
    const missing = requiredPacks.filter(id => !installed.some(pack => pack.id === id));
    if (missing.length) throw fail('GRAPHICS_PACK_MISSING', '需要先安装预设依赖的图形包：' + missing.join('、'));
    let appliedSteps = 0;
    let actual;
    try {
      await core.executeAsModal(async () => {
        validateDocument(params);
        // Readability is checked before changing a global PS tool or color.
        await readState(config);
        for (const descriptor of contract.commands(config)) {
          validateDocument(params);
          await checked([descriptor], descriptor._target[0]._ref === 'toolPreset' ? 'GRAPHICS_PRESET_UNAVAILABLE' : 'PREACTION_PS_FAILED');
          appliedSteps++;
        }
        actual = await readState(config);
        if (config.tool && toolName(actual) !== config.tool || config.foreground && !colorMatches(actual.foregroundColor, config.foreground) || config.background && !colorMatches(actual.backgroundColor, config.background)) throw fail('PREACTION_VERIFY_FAILED', 'Photoshop 回读的工具或颜色与预设不一致，请检查当前色彩模式或工具状态');
      }, {commandName: '准备预设标注工具'});
    } catch (error) {
      // Global tool options are not a document history state. Never promise
      // rollback of a partially applied Photoshop tool preset.
      error.appliedSteps = appliedSteps;
      error.partialApplied = appliedSteps > 0;
      if (typeof error.code !== 'string') error.code = Number(error.number) === 9 ? 'PREACTION_PS_BUSY' : 'PREACTION_PS_FAILED';
      if (appliedSteps) error.message += '（前 ' + appliedSteps + ' 项可能已经生效，请检查 Photoshop 工具和颜色）';
      throw error;
    }
    return {applied: true, docId: params.docId, presetId: String(params.presetId || ''), appliedSteps, state: actual};
  }
  async function installPack(params = {}) {
    if (params.confirmed !== true || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(params.packId || ''))) throw fail('GRAPHICS_INSTALL_CONFIRM_REQUIRED', '安装图形包前需要确认并填写有效编号');
    const current = await registry();
    if (current.packs.some(pack => pack.id === params.packId)) throw fail('GRAPHICS_PACK_ALREADY_INSTALLED', '这个图形包编号已经安装，请先检查 Photoshop 中是否存在对应工具预设');
    const file = await fs.getFileForOpening({types: ['tpl'], allowMultiple: false});
    if (!file) return {installed: false, cancelled: true};
    if (!/\.tpl$/i.test(file.name || '')) throw fail('GRAPHICS_PACK_INVALID', '请选择 Photoshop 导出的 .tpl 工具预设包');
    const metadata = await file.getMetadata();
    if (!(Number(metadata.size) > 0) || Number(metadata.size) > 32 * 1024 * 1024) throw fail('GRAPHICS_PACK_INVALID', '工具预设包为空或超过 32 MB');
    const token = await fs.createSessionToken(file);
    await core.executeAsModal(async () => {
      await checked([{_obj: 'set', _target: [{_property: 'toolPreset', _ref: 'property'}, {_enum: 'ordinal', _ref: 'application', _value: 'targetEnum'}], append: true, to: {_kind: 'local', _path: token}}], 'GRAPHICS_INSTALL_FAILED');
    }, {commandName: '安装预设图形包'});
    const entry = {id: params.packId, name: String(params.name || file.name).slice(0, 160), fileName: String(file.name), installedAt: new Date(now()).toISOString(), sizeBytes: Number(metadata.size)};
    current.packs.push(entry);
    try {
      const file = await current.folder.createFile(REGISTRY, {overwrite: true});
      await file.write(JSON.stringify({version: 1, packs: current.packs}));
    } catch (_) { throw fail('GRAPHICS_REGISTRY_WRITE_FAILED', 'Photoshop 已导入工具包，但安装记录保存失败，请检查插件资料目录；不要重复导入', {partialApplied: true}); }
    return {installed: true, pack: entry};
  }
  return {prepare, installPack, listPacks: async () => ({packs: (await registry()).packs})};
}
module.exports = {createPresetPreActions};
