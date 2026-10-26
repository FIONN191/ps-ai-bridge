/* One migration planner shared by the CLI and both desktop shells.
 * Planning is pure: it never reads/writes the V6 source or a target database.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.V6Migration = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|bearer)$/i;
  const str = value => value == null ? '' : String(value);
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    Object.keys(value).forEach(key => {
      if (SECRET_KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
      result[key] = clean(value[key]);
    });
    return result;
  }
  // ⭐ 2026-10-24（V7待办/16，用户定）：去重「标题 + 正文一样就算重复」，空格、换行、全半角的差别不算。
  //   ⚠ 只比下面白名单里的字段。原来是「没见过的字段全算进去」，V6 云同步打的 _cloudFile 一份有一份没有，
  //     同一条预设就被搬成「X」+「X V2」（本机实测 56 对）。部位不比：同标题同正文放在两个部位里几乎都是误操作。
  //   ⚠ 工作流相关字段照比：同一段提示词配不同工作流是两条不同的预设。
  //   搬家、预设库整理、以后的云端同步都用这一份，别在别处另写一套。
  const WORKFLOW_KEYS = ['provider', 'workflow', 'forgeWorkflow', 'parameters', 'parameterBindings', 'promptBindings',
    'inputNodeIds', 'referenceNodeIds', 'outputNodeIds', 'batchBinding', 'comfyuiParams', 'preActions', 'presetSet'];
  function normalizeText(value) {
    // 方括号里是看不见的字符：U+200B~U+200D 零宽空格 / 连接符、U+2060、U+FEFF（BOM）
    return str(value).normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
  }
  function normalizeTitle(value) {
    // 搬家加的「 V2」、复制加的「 副本」不算标题的一部分
    return normalizeText(value).replace(/(?: 副本)+$/, '').replace(/ V[1-9]\d*$/, '');
  }
  function signature(p) {
    const title = normalizeTitle(p.v6OriginalTitle || p.title || p.name || '');
    // A Forge preset converted to a cloud template gains workflow/parameter
    // fields and may lose <lora:> tags from its text; its identity is the
    // original V6 parameter set, so re-planning never duplicates it.
    if (p.sourceKind === 'forge' && p.legacyForgeParameters && typeof p.legacyForgeParameters === 'object') {
      return stable({ kind: 'forge', title, legacy: p.legacyForgeParameters });
    }
    const workflow = {};
    WORKFLOW_KEYS.forEach(key => { if (p[key] != null && p[key] !== '') workflow[key] = p[key]; });
    const refs = (Array.isArray(p.refImages) ? p.refImages : []).map(row => row && row.assetId ? row.assetId : stable(row)).sort();
    return stable({ kind: p.kind || 'prompt', title, content: normalizeText(p.content), negativePrompt: normalizeText(p.negativePrompt),
      refImages: refs, legacyForgeParameters: p.legacyForgeParameters || null, workflow });
  }
  // 不参加去重的：工具开关（抠像 / 辉光…）、Agent 收件箱、已被新版取代的旧条目
  function dedupable(p) {
    if (!p) return false;
    return (p.kind || 'prompt') === 'prompt' || !!(p.workflow || p.forgeWorkflow || p.legacyForgeParameters);
  }
  // 一组重复里留哪条：用户改过的 → 收藏的 → 有参考图的 → 有云端编号的 → 建得早的
  function keeperRank(p) {
    const edited = p.importedAt && p.updatedAt && String(p.updatedAt) > String(p.importedAt) ? 1 : 0;
    return [edited, p.starred ? 1 : 0, (p.refImages || []).length ? 1 : 0, p.cloudPresetId ? 1 : 0];
  }
  function pickKeeper(list) {
    return list.slice().sort((a, b) => {
      const ra = keeperRank(a), rb = keeperRank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
      const ca = str(a.createdAt), cb = str(b.createdAt);
      return ca !== cb ? (ca < cb ? -1 : 1) : str(a.id).localeCompare(str(b.id));
    })[0];
  }
  // 整理预设库：找出内容一样的组，每组留一条。纯计算，不读写任何存储。
  //   返回 { groups:[{ keep, drop:[...], patch }] }，patch 是留下那条要改的字段（合并收藏 / 接过参考图 / 「X V2」改回「X」）。
  function planDedupe(presets, options) {
    options = options || {};
    const skip = typeof options.skip === 'function' ? options.skip : () => false;
    const buckets = new Map();
    (presets || []).forEach(p => {
      if (!p || !p.id || p.supersededBy || skip(p) || !dedupable(p)) return;
      const key = signature(p);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    });
    const dropped = new Set();
    const groups = [];
    buckets.forEach(list => {
      if (list.length < 2) return;
      const keep = pickKeeper(list), drop = list.filter(p => p !== keep);
      drop.forEach(p => dropped.add(p.id));
      groups.push({ keep, drop, patch: {} });
    });
    const titles = new Set((presets || []).filter(p => p && !dropped.has(p.id)).map(p => str(p.title)));
    groups.forEach(group => {
      const { keep, drop, patch } = group;
      if (!keep.starred && drop.some(p => p.starred)) patch.starred = true;
      if (!(keep.refImages || []).length) { const donor = drop.find(p => (p.refImages || []).length); if (donor) patch.refImages = donor.refImages; }
      const base = /^(.*) V[1-9]\d*$/.exec(str(keep.title));
      if (base && !titles.has(base[1])) { titles.delete(keep.title); titles.add(base[1]); patch.title = base[1]; }
    });
    return { groups, dropCount: dropped.size };
  }
  function digest(value) {
    // Non-security identity hint; collisions are separately resolved against
    // known IDs, and content equality uses the full canonical signature.
    const data = stable(value); let a = 2166136261, b = 5381;
    for (let i = 0; i < data.length; i++) { a = Math.imul(a ^ data.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ data.charCodeAt(i); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function normalizePrompt(entry, importedAt) {
    const p = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload) ? clean(entry.payload) : {};
    delete p._cloudFile;   // V6 云同步的记账字段，V7 用不上
    const category = str(entry.category || p.category || '__unsorted');
    // ⚠ V6 的 _isFactory 改记成 v6Factory（V7待办/16）：V7 里 _isFactory = 「启动时自动建的工具预设」，见它就锁成「出厂·不能动」；
    //   V6 出厂提示词搬过来是用户自己的东西，要能挪、能改、能删。
    return Object.assign({}, p, { id: str(p.id || entry.id || ('v6-' + digest(entry))),
      title: str(entry.title || p.title || p.name || entry.sourceFile || '未命名').trim() || '未命名',
      category, sourceCategory: category, kind: 'prompt', subCategory: str(p.subCategory),
      content: p.content != null ? (typeof p.content === 'string' ? p.content : JSON.stringify(p.content)) : JSON.stringify(p),
      refImages: Array.isArray(p.refImages) ? p.refImages : [], _isFactory: false, v6Factory: !!p._isFactory, starred: !!p.starred,
      order: typeof p.order === 'number' ? p.order : undefined,
      author: str(p.author), createdAt: str(p.createdAt || importedAt), updatedAt: str(p.updatedAt || importedAt),
      source: 'v6', sourceKind: 'prompt', sourceRelativePath: str(entry.sourceRelativePath || entry.sourceFile),
      sourceHash: str(entry.sourceHash), importedAt: importedAt || new Date().toISOString(), migrationState: 'ready' });
  }
  function normalizeForge(entry, importedAt) {
    const p = entry.payload && typeof entry.payload === 'object' ? clean(entry.payload) : {};
    // V6 早期把 Forge 预设存进 presets 目录：_isForge + _forgeData（参数在 _forgeData 里）
    const d = p.data && typeof p.data === 'object' ? p.data : p._forgeData && typeof p._forgeData === 'object' ? p._forgeData : p;
    const item = normalizePrompt(entry, importedAt);
    return Object.assign(item, { provider: 'comfyui', sourceKind: 'forge',
      content: str(d.positivePrompt || d.prompt), negativePrompt: str(d.negativePrompt),
      comfyuiParams: { model: str(d.model), lora: str(d.lora), loraWeight: str(d.loraWeight), steps: str(d.step == null ? d.steps : d.step), resolution: str(d.resolution), imageCount: str(d.imageCount) },
      // Keep the original supported parameter set for the workflow mapping;
      // the compact comfyuiParams alone cannot reconstruct inpaint/ControlNet.
      legacyForgeParameters: clean(d), migrationState: 'forge-comfyui-review', needsReview: true });
  }
  function versionTitle(title, known) {
    const match = /^(.*) V([1-9]\d*)$/.exec(title);
    const base = match ? match[1] : title;
    let version = 0;
    known.forEach(name => {
      if (name === base) version = Math.max(version, 1);
      if (name.startsWith(base + ' V') && /^\d+$/.test(name.slice(base.length + 2))) version = Math.max(version, Number(name.slice(base.length + 2)));
    });
    if (!version) return { title, version: match ? Number(match[2]) : 1 };
    return { title: base + ' V' + (version + 1), version: version + 1 };
  }
  function planImport(manifest, existing, options) {
    if (!manifest || !Array.isArray(manifest.entries)) throw new Error('V6_MIGRATION_INVALID_MANIFEST');
    if (manifest.entries.length > 10000) throw new Error('V6_MIGRATION_TOO_MANY_ENTRIES');
    existing = existing || []; options = options || {};
    const importedAt = options.importedAt || new Date().toISOString();
    const kinds = new Set(options.includeKinds || ['prompt', 'forge']);
    const titles = new Set(existing.map(p => str(p.title)));
    const ids = new Set(existing.map(p => str(p.id)));
    const hashes = new Set(existing.map(p => str(p.sourceHash)).filter(Boolean));
    const signatures = new Set(existing.map(signature));
    // 已经搬过的 V6 原件（按 V6 原编号认）：用户搬完在 V7 里改过正文，再搬也不再进一份
    const v6Ids = new Set(existing.filter(p => p && p.source === 'v6').map(p => str(p.legacyId || p.id)).filter(Boolean));
    const categories = options.validCategories ? new Set(options.validCategories) : null;
    const records = [];
    manifest.entries.forEach((entry, index) => {
      const record = { index, sourceFile: str(entry && entry.sourceFile), sourceRelativePath: str(entry && entry.sourceRelativePath), action: 'skipped' };
      records.push(record);
      if (entry && entry.sourcePlanSkipped) { record.reason = 'SOURCE_PLAN_SKIPPED'; record.error = str(entry.sourcePlanSkipped); return; }
      if (!entry || entry.parseOk !== true || !entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) { record.reason = 'JSON_PARSE_FAILED'; record.error = str(entry && entry.parseError); return; }
      const kind = entry.kind || 'prompt';
      if (!['prompt', 'forge'].includes(kind)) { record.reason = 'UNSUPPORTED_KIND'; return; }
      if (!kinds.has(kind)) { record.reason = 'NOT_SELECTED'; return; }
      if (entry.sourceHash && hashes.has(entry.sourceHash)) { record.reason = 'SAME_SOURCE_HASH'; return; }
      if (entry.payload.id && v6Ids.has(str(entry.payload.id))) { record.reason = 'SAME_SOURCE_ID'; return; }
      const item = kind === 'forge' ? normalizeForge(entry, importedAt) : normalizePrompt(entry, importedAt);
      item.v6OriginalTitle = item.title;
      const itemSignature = signature(item);
      if (signatures.has(itemSignature)) { record.reason = 'SAME_CONTENT'; return; }
      const versioned = versionTitle(item.title, titles); item.title = versioned.title; item.version = versioned.version;
      const originalId = item.id;
      let idVersion = 1;
      while (ids.has(item.id)) item.id = originalId + '~v6~' + (++idVersion);
      if (item.id !== originalId) item.legacyId = originalId;
      if (categories && !categories.has(item.category)) item.category = '__unsorted';
      titles.add(item.title); ids.add(item.id); signatures.add(itemSignature); if (item.sourceHash) hashes.add(item.sourceHash);
      Object.assign(record, { action: 'add', id: item.id, title: item.title, originalTitle: item.v6OriginalTitle, needsReview: !!item.needsReview, item });
    });
    return { schema: 'wheelchair-v7-v6-import-plan', version: 1, createdAt: importedAt,
      sourceManifest: str(manifest.sourceRoot), counts: { add: records.filter(r => r.action === 'add').length,
        skipped: records.filter(r => r.action === 'skipped').length, forgeReview: records.filter(r => r.needsReview).length }, records };
  }
  function manifestFromFiles(files, sourceRoot, defaultKind) {
    const entries = (files || []).map(file => {
      let payload = null, parseError = str(file.error);
      try { if (!parseError) payload = JSON.parse(file.text); } catch (error) { parseError = error.message; }
      const valid = payload && typeof payload === 'object' && !Array.isArray(payload);
      const inferredForge = /(?:^|[\\/])(?:factory_)?forge_presets[\\/]?$/i.test(str(sourceRoot));
      return { parseOk: !!valid && !parseError, parseError,
        payload: valid ? payload : null, sourceFile: str(file.name), sourceRelativePath: str(file.name),
        // 文件原文的指纹：同一个文件不管从哪个目录读、读几次，都认得出来
        sourceHash: valid && !parseError ? digest(str(file.text)) : '',
        id: valid ? payload.id || null : null,
        title: valid ? payload.title || payload.name || payload.displayName || file.name : file.name,
        category: valid ? payload.category || null : null,
        kind: defaultKind === 'forge' || inferredForge || (valid && (payload.kind === 'forge' || payload.sourceKind === 'forge' || payload.provider === 'forge' || payload._isForge === true)) ? 'forge' : (defaultKind || 'prompt') };
    });
    return { schema: 'wheelchair-v7-v6-migration-manifest', schemaVersion: 1,
      sourceRoot: str(sourceRoot), generatedAt: new Date().toISOString(), entries };
  }
  function manifestFromPlan(plan) {
    if (!plan || plan.schema !== 'wheelchair-v7-v6-import-plan' || plan.version !== 1 || !Array.isArray(plan.records)) throw new Error('V6_MIGRATION_INVALID_PLAN');
    return { schema: 'wheelchair-v7-v6-migration-manifest', schemaVersion: 1, sourceRoot: str(plan.sourceManifest),
      entries: plan.records.map(record => {
        if (record.action !== 'add') return { sourceFile: record.sourceFile, sourcePlanSkipped: record.reason || 'SKIPPED' };
        if (!record.item || typeof record.item !== 'object') throw new Error('V6_MIGRATION_INVALID_PLAN_ITEM');
        const p = record.item, title = record.originalTitle || p.v6OriginalTitle || p.title;
        const payload = Object.assign({}, p, { id: p.legacyId || p.id, title, name: title });
        if (p.sourceKind === 'forge') payload.data = p.legacyForgeParameters || p.data || Object.assign({}, p.comfyuiParams, {
          positivePrompt: p.content, negativePrompt: p.negativePrompt, step: p.comfyuiParams && p.comfyuiParams.steps });
        return { parseOk: true, sourceFile: record.sourceFile, sourceRelativePath: p.sourceRelativePath, sourceHash: p.sourceHash,
          kind: p.sourceKind || 'prompt', title, category: p.sourceCategory || p.category, payload };
      }) };
  }
  // ⭐ 2026-10-24 晚（V7待办/16 云端预设库）：内容指纹 = sha256(signature)，小写十六进制 64 位。
  //   全项目只此一份：导入脚本（Node）、后台云端预设页（浏览器，backend/admin/v6-migration.js 是本文件的副本）、软件同步三处共用。
  //   后端不算，只存只比（backend/cloud_presets.py 的说明）。返回 Promise（浏览器的 crypto.subtle 只有异步）。
  async function contentHash(p) {
    const text = signature(Object.assign({ kind: 'prompt' }, p));
    if (typeof globalThis.crypto === 'object' && globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return { planImport, normalizePrompt, normalizeForge, signature, stable, versionTitle, manifestFromFiles, manifestFromPlan,
    normalizeText, normalizeTitle, planDedupe, contentHash };
});
