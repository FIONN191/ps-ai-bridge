(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.V7AgentPresetContract = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const MAX_BYTES = 512 * 1024, CATEGORY = '__agent_inbox__';
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
  function stable(x) { if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']'; if (plain(x)) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}'; return JSON.stringify(x); }
  function scan(value, depth = 0) {
    if (depth > 32) fail('AGENT_PRESET_TOO_DEEP');
    if (typeof value === 'string') {
      if (/\b(?:Bearer\s+[\w.\-]{8,}|sk-[A-Za-z0-9_-]{16,})|(?:api[_-]?key|access[_-]?token|authorization|password)\s*[=:]\s*[^\s,}\]]+|https?:\/\/[^/\s]+:[^/\s]+@/i.test(value)) fail('AGENT_PRESET_CREDENTIALS');
      if (/^\s*[\[{]/.test(value)) { let parsed; try { parsed = JSON.parse(value); } catch (_) {} if (parsed) scan(parsed, depth + 1); }
      if (/^data:image\//i.test(value)) fail('AGENT_PRESET_INLINE_IMAGE');
      return;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (Array.isArray(value)) { value.forEach(v => scan(v, depth + 1)); return; }
    if (!plain(value)) fail('AGENT_PRESET_INVALID_VALUE');
    for (const key of Object.keys(value)) {
      if (/^(?:__proto__|prototype|constructor)$/.test(key)) fail('AGENT_PRESET_INVALID_KEY');
      if (/(?:api.?key|access.?token|refresh.?token|password|secret|authorization|cookie|credential|private.?key)/i.test(key)) fail('AGENT_PRESET_CREDENTIALS');
      scan(value[key], depth + 1);
    }
  }
  function validate(input) {
    if (!plain(input)) fail('AGENT_PRESET_INVALID_ENVELOPE');
    let encoded; try { encoded = JSON.stringify(input); } catch (_) { fail('AGENT_PRESET_INVALID_VALUE'); }
    if (new TextEncoder().encode(encoded).length > MAX_BYTES) fail('AGENT_PRESET_TOO_LARGE');
    scan(input);
    if (Object.keys(input).some(k => !['schema', 'version', 'name', 'createdAt', 'author', 'preset'].includes(k))) fail('AGENT_PRESET_INVALID_ENVELOPE');
    if (input.schema !== undefined && input.schema !== 'wheelchair-agent-preset') fail('AGENT_PRESET_SCHEMA');
    if (input.version !== undefined && input.version !== 1) fail('AGENT_PRESET_SCHEMA');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const author = typeof input.author === 'string' ? input.author.trim() : '';
    if (!name || name.length > 120 || !author || author.length > 120 || /[\x00-\x1f]/.test(name + author)) fail('AGENT_PRESET_IDENTITY_REQUIRED');
    if (typeof input.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) fail('AGENT_PRESET_TIME_REQUIRED');
    if (!plain(input.preset)) fail('AGENT_PRESET_INVALID_PRESET');
    const p = JSON.parse(JSON.stringify(input.preset)), kind = p.kind || 'prompt';
    if (!['prompt', 'matting', 'segment', 'sam2', 'glow'].includes(kind)) fail('AGENT_PRESET_KIND_UNSUPPORTED');
    if (typeof p.content !== 'string') fail('AGENT_PRESET_CONTENT_REQUIRED');
    if (kind !== 'prompt') { let params; try { params = JSON.parse(p.content); } catch (_) { fail('AGENT_PRESET_PARAMS_INVALID'); } if (!plain(params)) fail('AGENT_PRESET_PARAMS_INVALID'); }
    if (p.provider !== undefined && !['comfyui', 'runninghub', 'openai', 'gemini', 'aji', 'momo', 'grs', 'others'].includes(p.provider)) fail('AGENT_PRESET_PROVIDER_UNSUPPORTED');
    if (p.refImages && p.refImages.length) fail('AGENT_PRESET_RESOURCE_IMPORT_REQUIRED');
    // Identity/category are owned by the receiver, never a file's requested ID.
    ['id', 'title', 'author', 'createdAt', 'updatedAt', 'importedAt', 'category', 'source', '_isFactory', 'agentReceipt'].forEach(k => delete p[k]);
    return { schema: 'wheelchair-agent-preset', version: 1, name, author, createdAt: new Date(input.createdAt).toISOString(), preset: { ...p, kind } };
  }
  return Object.freeze({ MAX_BYTES, CATEGORY, validate, stable });
});
