/* V6 Forge preset → V7 cloud template + parameter values.
 *
 * One rule set, used in three places:
 *   - the software, when importing V6 presets (v6-migration.js) and when
 *     upgrading old "待验证" Forge presets (preset-store.js);
 *   - scripts/build-cloud-catalog-20261015.cjs, which builds the 15 built-in presets.
 *
 * It reproduces what V6 actually sent to Forge (V6 tiles/tile-forge.js +
 * tile-forge.host.js img2img), not what the preset file looks like:
 *   prompt      = positivePrompt + " <lora:NAME:W>"  (W = parseFloat(loraWeight) || 1)
 *   sampler     = selectedName, scheduler never sent → Forge "Automatic"
 *   cfg         = not in presets → 7;  seed = -1;  batch = imageCount
 *   denoise     = redrawAmount || 0.35;  steps = step || 20;  resolution || 768
 *   ControlNet  = only when a model is chosen; module/model/weight (weight || 1)
 * A preset that cannot run faithfully is never guessed: it comes back with
 * `reasons` (shown to the user) and stays "待验证". Clamping to the platform
 * range is not blocking and comes back as `warnings`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V7ForgeConvert = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A1111/Forge sampler display name → ComfyUI sampler.
  const SAMPLER_NAMES = {
    'euler a': 'euler_ancestral', 'euler': 'euler', 'lms': 'lms', 'heun': 'heun', 'dpm2': 'dpm_2', 'dpm2 a': 'dpm_2_ancestral',
    'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde',
    'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive', 'ddim': 'ddim', 'unipc': 'uni_pc', 'lcm': 'lcm'
  };
  const SCHEDULER_NAMES = { 'automatic': '', 'karras': 'karras', 'exponential': 'exponential', 'uniform': 'normal', 'normal': 'normal',
    'sgm uniform': 'sgm_uniform', 'simple': 'simple', 'ddim': 'ddim_uniform', 'beta': 'beta', 'kl optimal': 'kl_optimal' };
  const NOISY_SAMPLERS = ['euler_ancestral', 'dpm_2_ancestral', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'dpm_fast', 'dpm_adaptive', 'lcm'];
  const CONTROLNET_MODULES = { 'lineart_realistic': 'lineart_realistic', 'lineart': 'lineart_realistic', 'canny': 'canny' };
  const BASE_TEMPLATE = 'forge-img2img';
  const LORA_TAG = /<(lora|lyco):([^:>]+)(?::([^:>]*))?(?::[^>]*)?>/gi;
  const OTHER_NETWORK = /<(hypernet|hypernetwork):[^>]*>/i;

  const str = value => value === undefined || value === null ? '' : String(value).trim();
  const clone = value => JSON.parse(JSON.stringify(value));

  // Forge automatic scheduler = the sampler's own default (A1111 samplers_k_diffusion options).
  function automaticScheduler(sampler) {
    if (['dpmpp_2m', 'dpmpp_sde', 'dpmpp_2s_ancestral', 'dpm_2', 'dpm_2_ancestral'].includes(sampler)) return 'karras';
    if (['dpmpp_2m_sde', 'dpmpp_3m_sde'].includes(sampler)) return 'exponential';
    if (sampler === 'ddim') return 'ddim_uniform';
    return 'normal';
  }

  function samplerOf(name, scheduler) {
    let key = str(name).toLowerCase().replace(/\s+/g, ' ');
    let schedulerKey = str(scheduler).toLowerCase().replace(/[_-]+/g, ' ');
    // WebUI <1.9 names carried the schedule: "DPM++ 2M Karras", "DPM++ SDE Exponential".
    const combined = /^(.*) (karras|exponential)$/.exec(key);
    if (combined && SAMPLER_NAMES[combined[1]]) { key = combined[1]; if (!schedulerKey || schedulerKey === 'automatic') schedulerKey = combined[2]; }
    const sampler = SAMPLER_NAMES[key] || '';
    const mapped = Object.prototype.hasOwnProperty.call(SCHEDULER_NAMES, schedulerKey || 'automatic') ? SCHEDULER_NAMES[schedulerKey || 'automatic'] : null;
    return { sampler, scheduler: mapped === '' ? (sampler ? automaticScheduler(sampler) : '') : mapped, unknownScheduler: mapped === null };
  }

  function assetKey(value) {
    return str(value).replace(/\\/g, '/').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\.(?:safetensors|ckpt|pt|pth|bin)$/i, '').toLowerCase();
  }
  function assetName(value) { return str(value).replace(/\s*\[[^\]]*\]\s*$/, ''); }

  // Match a Forge resource name to what the cloud really has: exact, then without
  // hash/extension, then by unique basename. Ambiguous → null (never guess).
  function resolveOption(name, options) {
    const want = assetKey(name);
    if (!want || !Array.isArray(options)) return null;
    const exact = options.filter(option => assetKey(option) === want);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const base = want.split('/').pop();
    const byBase = options.filter(option => assetKey(option).split('/').pop() === base);
    return byBase.length === 1 ? byBase[0] : null;
  }

  // A1111 removes extra-network tags from the prompt text and applies them as networks.
  function parseLoraTags(text) {
    const loras = [];
    const clean = String(text == null ? '' : text).replace(LORA_TAG, (_, kind, name, weight) => {
      const number = weight === undefined || str(weight) === '' ? 1 : Number(weight);
      loras.push({ name: str(name), weight: Number.isFinite(number) ? number : 1 });
      return '';
    });
    return { text: clean.replace(/\s+$/, ''), loras };
  }

  function bindingOf(template, key) {
    return (template.parameterBindings || []).find(binding => binding.key === key) || null;
  }
  function loraSlots(template) {
    let count = 0;
    while (bindingOf(template, 'lora' + (count + 1))) count += 1;
    return count;
  }
  function defaultsOf(template) {
    const out = {};
    for (const binding of template.parameterBindings || []) if (binding.default !== undefined) out[binding.key] = binding.default;
    return out;
  }

  function convert(source, catalog) {
    const d = source && typeof source === 'object' ? (source.data && typeof source.data === 'object' ? source.data : source) : {};
    const templates = catalog && catalog.templates || {};
    const reasons = [], warnings = [];
    const cnModelRaw = str(d.controlNetModel);
    const cnOn = !!cnModelRaw && cnModelRaw.toLowerCase() !== 'none';
    const rawModule = str(d.selectedControlNetModule).toLowerCase();
    const module = cnOn ? (CONTROLNET_MODULES[rawModule] || rawModule) : '';
    const templateId = cnOn ? BASE_TEMPLATE + '-cn-' + module : BASE_TEMPLATE;
    const template = templates[templateId] || null;
    const positive = parseLoraTags(d.positivePrompt != null ? d.positivePrompt : d.prompt);
    const negative = parseLoraTags(d.negativePrompt);
    const result = { ok: false, templateId, template, parameters: {}, content: positive.text, negativePrompt: negative.text, reasons, warnings };
    if (!template) {
      reasons.push(cnOn ? 'ControlNet 预处理「' + (rawModule || '未填') + '」云端还不支持' : '云端缺少 Forge 通用模板');
      return result;
    }
    const values = result.parameters;
    const options = key => (bindingOf(template, key) || {}).options || [];

    function number(key, raw, fallback, label, falsyFallback) {
      const binding = bindingOf(template, key);
      if (!binding) return;
      let value = str(raw) === '' ? fallback : Number(raw);
      if (!Number.isFinite(value)) { warnings.push(label + '「' + str(raw) + '」不是数字，已用 ' + fallback); value = fallback; }
      if (falsyFallback && !value) value = fallback;   // V6 used `x || default`
      if (binding.integer || binding.step === 1) value = Math.round(value);
      if (value < binding.min || value > binding.max) {
        const clamped = Math.min(binding.max, Math.max(binding.min, value));
        warnings.push(label + ' ' + value + ' 超出平台范围 ' + binding.min + '~' + binding.max + '，已按 ' + clamped);
        value = clamped;
      }
      values[key] = value;
    }
    number('steps', d.step != null ? d.step : d.steps, 20, '步数', true);
    number('redrawAmount', d.redrawAmount != null ? d.redrawAmount : d.denoise, 0.35, '重绘幅度', true);
    number('cfg', d.cfg != null ? d.cfg : d.cfg_scale, 7, 'CFG', true);
    number('resolution', d.resolution, 768, '分辨率', true);
    number('imageCount', d.imageCount, 1, '张数', true);
    if (bindingOf(template, 'seed')) {
      const seed = Number(d.seed);
      values.seed = str(d.seed) !== '' && Number.isSafeInteger(seed) && seed >= -1 ? seed : -1;
    }

    if (!str(d.model)) reasons.push('预设里没写模型');
    else {
      const model = resolveOption(d.model, options('model'));
      if (model) values.model = model;
      else reasons.push('云端没有这个模型：' + assetName(d.model));
    }

    const sampling = samplerOf(d.selectedName || d.sampler || 'Euler a', d.selectedScheduler || d.scheduler);
    if (!sampling.sampler || !options('sampler').includes(sampling.sampler)) reasons.push('采样器「' + str(d.selectedName || d.sampler) + '」云端没有对应');
    else values.sampler = sampling.sampler;
    if (sampling.unknownScheduler || !options('scheduler').includes(sampling.scheduler)) {
      if (sampling.sampler) reasons.push('调度器「' + str(d.selectedScheduler || d.scheduler) + '」云端没有对应');
    } else values.scheduler = sampling.scheduler;
    if (NOISY_SAMPLERS.includes(sampling.sampler)) warnings.push('这个采样器每一步都会加随机噪声，云端和原 Forge 出图构图风格一致，但不会逐像素相同');

    const loras = [];
    if (str(d.lora)) {
      const weight = parseFloat(d.loraWeight);
      loras.push({ name: str(d.lora), weight: weight || 1 });   // V6: parseFloat(w) || 1
    }
    loras.push(...positive.loras);
    const merged = [];
    for (const lora of loras) {
      const same = merged.find(item => assetKey(item.name) === assetKey(lora.name));
      if (same) same.weight += lora.weight;    // A1111 applies a repeated network twice
      else merged.push({ ...lora });
    }
    if (negative.loras.length) warnings.push('负向提示词里的 LoRA 标签已去掉（Forge 只认正向里的）');
    if (OTHER_NETWORK.test(String(d.positivePrompt || ''))) reasons.push('提示词里有 hypernetwork，云端不支持');
    const slots = loraSlots(template);
    if (merged.length > slots) reasons.push('用了 ' + merged.length + ' 个 LoRA，云端模板最多 ' + slots + ' 个');
    merged.slice(0, slots).forEach((lora, index) => {
      const slot = 'lora' + (index + 1);
      const name = resolveOption(lora.name, options(slot));
      if (!name) { reasons.push('云端没有这个 LoRA：' + assetName(lora.name)); return; }
      values[slot] = name;
      number(slot + 'Weight', lora.weight, 1, 'LoRA「' + assetName(lora.name) + '」权重', false);
    });
    for (let index = merged.length; index < slots; index += 1) values['lora' + (index + 1) + 'Weight'] = 0;

    if (cnOn) {
      const cnModel = resolveOption(cnModelRaw, options('controlNetModel'));
      if (cnModel) values.controlNetModel = cnModel;
      else reasons.push('云端没有这个 ControlNet 模型：' + assetName(cnModelRaw));
      number('controlNetWeight', d.controlNetWeight, 1, 'ControlNet 权重', true);   // V6: parseFloat(w) || 1
    }
    values.negativePrompt = negative.text;
    result.ok = reasons.length === 0;
    return result;
  }

  // Build the V7 preset record. Keeps the original V6 data so a later catalog
  // (more models installed) can convert it again.
  function toPreset(result, base, catalog) {
    const legacy = clone((base && base.legacyForgeParameters) || {});
    const out = Object.assign({}, base, {
      provider: 'comfyui', sourceKind: 'forge', legacyForgeParameters: legacy,
      content: result.content, negativePrompt: result.negativePrompt,
      needsReview: !result.ok, reviewReasons: result.reasons.slice(), conversionWarnings: result.warnings.slice(),
      migrationState: result.ok ? 'comfyui-converted' : 'forge-comfyui-review',
      forgeConversion: { catalogVersion: Number(catalog && catalog.version) || 0, templateId: result.templateId }
    });
    if (result.template) {
      const template = result.template;
      Object.assign(out, {
        platformPresetId: result.templateId, workflow: clone(template.workflow),
        inputNodeIds: (template.inputNodeIds || []).slice(), referenceNodeIds: (template.referenceNodeIds || []).slice(),
        outputNodeIds: (template.outputNodeIds || []).slice(), promptBindings: [],
        parameterBindings: clone(template.parameterBindings || []), batchBinding: template.batchBinding ? clone(template.batchBinding) : null,
        parameters: Object.assign(defaultsOf(template), result.parameters)
      });
      // The visible prompt box (content) is the single source of the positive prompt.
      delete out.parameters.positivePrompt;
    }
    return out;
  }

  return { convert, toPreset, parseLoraTags, samplerOf, resolveOption, assetKey, BASE_TEMPLATE };
});
