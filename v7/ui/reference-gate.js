/* 参考图 · 统一闸门（融合方案-C01 §1 / §4）
 *
 * 为什么要有：以前「能加几张参考图」在三层各判各的（本机预设 12 / 工作流 12 / 传输层），
 *   每加一种新工作流就要改一次界面判断，必然漏。现在所有地方都只问这一个函数。
 *   新工作流只需要 registerWorkflowAdapter / registerRule 注册一条，不用改界面。
 *
 * ── 契约（C01 §4.3，写死，别人依赖它）──
 *   check(input) → verdict
 *   input  = { protocol, model, modelName, workflow, hasMain, count, bytes, adding, addingBytes }
 *            protocol  'gemini' | 'openai' | 'comfyui' | ...
 *            workflow  '' = 普通生图；非空 = 走工作流（ComfyUI 之类）
 *            count / bytes        = 现有的参考图张数 / 字节（⚠ 不含主图）
 *            adding / addingBytes = 这次想再加的张数 / 字节（只问能不能加时可以不传）
 *   verdict = { allowed, max, remaining, formats, onExceed, reason, blockedBy }
 *            max / remaining ⚠ 都是【参考图】张数，不含主图（C01 §4.4）
 *            onExceed  恒为 'reject'（超了就拒，不偷偷截掉）
 *            reason    '' 或【人话】原因，界面直接显示
 *            blockedBy '模型' | '工作流' | '总量' | '本机上限' | '' —— 谁定的这个上限
 *   （C01 文档里契约是用中文字段写的说明，代码里用上面这组英文名，一一对应。）
 *
 * ⚠ 纯逻辑：不碰 DOM、不碰存储。数字从 reference-limits.js 来，模型能力从 reference-capability.js 来。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7ReferenceGate = api;
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  function limits() {
    return (root && root.V7ReferenceLimits) || (typeof require === 'function' ? require('./reference-limits.js') : null);
  }
  function capability() {
    return (root && root.V7ReferenceCapability) || (typeof require === 'function' ? require('./reference-capability.js') : null);
  }

  var rules = [];              // [{name, fn}]
  var workflowAdapters = {};   // workflow 名 → fn(input) → {max, reason}
  var contextProvider = null;  // 宿主告诉闸门「现在是什么模型/协议/工作流」

  function mb(bytes) { return Math.round(bytes / 1024 / 1024); }

  function check(input) {
    var L = limits();
    var i = Object.assign({}, contextProvider ? safe(contextProvider) : {}, input || {});
    var count = Math.max(0, Number(i.count) || 0);
    var adding = Math.max(0, Number(i.adding) || 0);
    var bytes = Math.max(0, Number(i.bytes) || 0) + Math.max(0, Number(i.addingBytes) || 0);
    var name = String(i.modelName || i.model || '当前模型');
    var max = L.REFS_MAX, blockedBy = '总量', reason = '';

    if (i.workflow) {
      // ⭐ R6（用户原话）：「有多张输入的话，就直接去按照 ComfyUI 的映射来，留个钩子就行了」
      //   → 工作流【不受 5 张限制】。有适配器就听适配器的；没有就按工作流那条路原本的上限（12）。
      var adapter = workflowAdapters[String(i.workflow)] || workflowAdapters['*'];
      var answer = adapter ? safe(function () { return adapter(i); }) : null;
      max = answer && Number.isFinite(Number(answer.max)) ? Math.max(0, Number(answer.max)) : L.STORED_MAX;
      blockedBy = '工作流';
      if (answer && answer.reason) reason = String(answer.reason);
    } else {
      var cap = capability().forModel(i.model);
      if (!cap.supportsReference) { max = 0; blockedBy = '模型'; reason = name + ' 不支持参考图'; }
      else if (cap.maxReferences != null && cap.maxReferences < max) { max = cap.maxReferences; blockedBy = '模型'; }
    }

    // 注册进来的额外规则：只能把上限往下压，不能往上抬（抬了就绕过了产品上限）
    for (var k = 0; k < rules.length; k++) {
      var extra = safe(function () { return rules[k].fn(i, { max: max, blockedBy: blockedBy }); });
      if (extra && Number.isFinite(Number(extra.max)) && Number(extra.max) < max) {
        max = Math.max(0, Number(extra.max)); blockedBy = String(extra.blockedBy || rules[k].name); reason = String(extra.reason || '');
      }
    }

    var allowed = count + adding <= max;
    if (!allowed && !reason) {
      reason = blockedBy === '模型'
        ? name + ' 最多 ' + max + ' 张参考图，你已经加了 ' + count + ' 张'
        : blockedBy === '工作流'
          ? '这个工作流最多 ' + max + ' 张参考图，你已经加了 ' + count + ' 张'
          : '参考图最多 ' + max + ' 张（加原图共 ' + (max + 1) + ' 张），你已经加了 ' + count + ' 张';
    }
    if (allowed && bytes > L.BYTES_MAX) {
      allowed = false; blockedBy = '本机上限';
      reason = '参考图加起来太大了（' + mb(bytes) + ' MB，最多 ' + mb(L.BYTES_MAX) + ' MB）';
    }
    return {
      allowed: allowed,
      max: max,
      remaining: Math.max(0, max - count),
      formats: L.FORMATS.slice(),
      onExceed: 'reject',
      reason: allowed ? '' : reason,
      blockedBy: blockedBy
    };
  }

  function safe(fn) { try { return fn(); } catch (_) { return null; } }

  function registerRule(name, fn) {
    if (typeof fn !== 'function') return;
    rules = rules.filter(function (r) { return r.name !== name; }).concat([{ name: String(name), fn: fn }]);
  }
  // ⭐ 给 ComfyUI 留的钩子（R6）。现在没人注册 = 按工作流原有上限走。
  function registerWorkflowAdapter(name, fn) {
    if (typeof fn === 'function') workflowAdapters[String(name)] = fn; else delete workflowAdapters[String(name)];
  }
  function setContext(fn) { contextProvider = typeof fn === 'function' ? fn : null; }

  return { check: check, registerRule: registerRule, registerWorkflowAdapter: registerWorkflowAdapter, setContext: setContext };
});
