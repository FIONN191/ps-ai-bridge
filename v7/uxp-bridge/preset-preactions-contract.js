(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7PresetPreActionContract = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var TOOLS = {
    paintbrushTool: '画笔', pencilTool: '铅笔', eraserTool: '橡皮擦',
    rectangleTool: '矩形形状', ellipseTool: '椭圆形状', lineTool: '直线 / 箭头',
    customShapeTool: '自定形状', patternStampTool: '图案图章',
    marqueeRectTool: '矩形选框', moveTool: '移动'
  };
  function fail(message) { throw Object.assign(new Error(message), {code: 'PREACTION_INVALID'}); }
  function normalize(value) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('预设前置动作必须是对象');
    var allowed = ['version', 'enabled', 'trigger', 'tool', 'toolPreset', 'foreground', 'background', 'packIds'];
    Object.keys(value).forEach(function (key) { if (allowed.indexOf(key) < 0) fail('前置动作包含不支持的字段：' + key); });
    if (value.version !== 1 || ['select', 'manual', 'beforeGenerate'].indexOf(value.trigger) < 0) fail('前置动作版本或触发时机无效');
    if (value.enabled != null && typeof value.enabled !== 'boolean') fail('前置动作启用值无效');
    var result = {version: 1, enabled: value.enabled !== false, trigger: value.trigger};
    if (value.tool) {
      if (!Object.prototype.hasOwnProperty.call(TOOLS, value.tool)) fail('前置动作使用了未支持的 Photoshop 工具');
      result.tool = value.tool;
    }
    if (value.toolPreset) {
      if (typeof value.toolPreset !== 'string' || !value.toolPreset.trim() || value.toolPreset.trim().length > 160 || /[\u0000-\u001f]/.test(value.toolPreset)) fail('Photoshop 工具预设名称无效');
      if (!result.tool) fail('选择形状或图案工具预设时，还需要指定对应工具');
      result.toolPreset = value.toolPreset.trim();
    }
    ['foreground', 'background'].forEach(function (key) {
      if (value[key] == null || value[key] === '') return;
      if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) fail('前景色 / 背景色必须是六位颜色值');
      result[key] = value[key].toLowerCase();
    });
    if (value.packIds != null) {
      if (!Array.isArray(value.packIds) || value.packIds.length > 8) fail('每个预设最多依赖八个图形包');
      result.packIds = Array.from(new Set(value.packIds.map(function (id) {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail('图形包编号无效');
        return id;
      })));
    }
    if (result.enabled && !result.tool && !result.foreground && !result.background) fail('启用前置动作时至少选择一种工具或颜色');
    return result;
  }
  function rgb(hex) { return {red: parseInt(hex.slice(1, 3), 16), grain: parseInt(hex.slice(3, 5), 16), blue: parseInt(hex.slice(5, 7), 16)}; }
  function colorDescriptor(slot, hex) { return {_obj: 'set', _target: [{_ref: 'color', _property: slot + 'Color'}], to: Object.assign({_obj: 'RGBColor'}, rgb(hex))}; }
  function commands(value) {
    var config = normalize(value), out = [];
    if (!config || !config.enabled) return out;
    if (config.tool) out.push({_obj: 'select', _target: [{_ref: config.tool}], dontRecord: true, forceNotify: true});
    if (config.toolPreset) out.push({_obj: 'select', _target: [{_ref: 'toolPreset', _name: config.toolPreset}]});
    if (config.foreground) out.push(colorDescriptor('foreground', config.foreground));
    if (config.background) out.push(colorDescriptor('background', config.background));
    return out;
  }
  return {TOOLS: TOOLS, normalize: normalize, commands: commands, colorDescriptor: colorDescriptor};
});
