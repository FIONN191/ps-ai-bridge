(function (root) {
  'use strict';
  const KEY = 'preset.field-history.v1', MAX_FIELDS = 500, MAX_VALUES = 20, MAX_VALUE = 4096, MAX_STORE = 600000;
  let epoch = 0;
  root.addEventListener('wheelchair:storage-context', () => { epoch++; });
  function storageKey() { return root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.key(KEY) : KEY; }
  function allowed(field) { return typeof field === 'string' && field.length > 0 && field.length <= 160 && !/(?:api.?key|token|password|secret|authorization|credential|密钥|密码|令牌|验证码)/i.test(field); }
  function clean(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    if (!text.trim() || text.length > MAX_VALUE || /(?:\bsk-[\w-]{12,}|\bBearer\s+\S+|-----BEGIN.*PRIVATE KEY)/i.test(text)) return null;
    return text;
  }
  function read() {
    try { const value = JSON.parse(root.localStorage.getItem(storageKey()) || '[]'); return Array.isArray(value) ? value.filter(row => row && typeof row.presetId === 'string' && allowed(row.field) && Array.isArray(row.values)).slice(0, MAX_FIELDS) : []; }
    catch (_) { return []; }
  }
  function persist(rows) {
    rows.sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    rows = rows.slice(0, MAX_FIELDS);
    while (rows.length && JSON.stringify(rows).length > MAX_STORE) rows.pop();
    root.localStorage.setItem(storageKey(), JSON.stringify(rows));
    root.dispatchEvent(new CustomEvent('wheelchair:field-history'));
  }
  function capture(presetId, fields) {
    if (typeof presetId !== 'string' || !presetId || presetId.length > 256) return null;
    return { presetId, storageKey: storageKey(), epoch, fields: (Array.isArray(fields) ? fields : []).filter(f => f && allowed(f.name) && !f.sensitive && clean(f.value) !== null).slice(0, 64).map(f => ({ name: f.name, value: clean(f.value) })) };
  }
  function record(snapshot) {
    if (!snapshot || snapshot.storageKey !== storageKey() || snapshot.epoch !== epoch) return { saved: 0, stale: !!snapshot };
    const checked = capture(snapshot.presetId, snapshot.fields);
    if (!checked?.fields.length) return { saved: 0 };
    const rows = read(), now = Date.now();
    for (const field of checked.fields) {
      let row = rows.find(r => r.presetId === checked.presetId && r.field === field.name);
      if (!row) { row = { presetId: checked.presetId, field: field.name, values: [] }; rows.push(row); }
      row.values = [{ value: field.value, savedAt: now }, ...row.values.filter(v => v && clean(v.value) !== null && v.value !== field.value)].slice(0, MAX_VALUES);
      row.updatedAt = now;
    }
    persist(rows); return { saved: checked.fields.length };
  }
  function list(presetId, field) {
    if (!allowed(field)) return [];
    const row = read().find(r => r.presetId === presetId && r.field === field);
    return (row?.values || []).filter(v => v && clean(v.value) !== null).slice(0, MAX_VALUES).map(v => ({ value: String(v.value), savedAt: v.savedAt }));
  }
  function remove(presetId, field, value) {
    let rows = read();
    for (const row of rows) if (row.presetId === presetId && row.field === field) row.values = value === undefined ? [] : row.values.filter(v => v.value !== value);
    rows = rows.filter(row => row.values.length); persist(rows);
  }
  root.V7PresetFieldHistory = Object.freeze({ capture, record, list, remove, allowed, limits: Object.freeze({fields:MAX_FIELDS,values:MAX_VALUES,value:MAX_VALUE}) });
})(window);
