(function (root) {
  'use strict';
  const C = root.V7AgentPresetContract, PREFIX = 'agent.preset.', BACKUPS = PREFIX + 'backups';
  let timer = null, scanning = false, epoch = 0;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const scope = () => root.WHEELCHAIR_STORAGE ? root.WHEELCHAIR_STORAGE.dbName('presets') : 'v8.presets';
  const host = () => root.uiwin && root.uiwin.agentPresets;
  const clone = x => JSON.parse(JSON.stringify(x));
  const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
  const signature = list => C.stable(list.slice().sort((a, b) => a.id.localeCompare(b.id)));
  async function requireGrant() {
    if (!root.uiwin || !root.uiwin.agent || !root.uiwin.agent.tierInfo) fail('AGENT_PRESET_ACCESS_REQUIRED');
    const access = await root.uiwin.agent.tierInfo();
    if (!access.ok || !['preset_editor', 'software_developer', 'administrator'].includes(access.name || access.tier)) fail('AGENT_PRESET_ACCESS_REQUIRED');
  }
  function refresh() { if (root.PRESETUI) { root.PRESETUI.fillZone(); root.PRESETUI.renderCrumb(); } root.dispatchEvent(new CustomEvent('wheelchair:agent-presets')); }
  function transact(operation) {
    const namespace = scope();
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(namespace, 1);
      open.onupgradeneeded = () => { for (const s of ['presets', 'assets', 'meta']) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (namespace !== scope()) { db.close(); reject(new Error('AGENT_PRESET_ACCOUNT_CHANGED')); return; }
        const t = db.transaction(['presets', 'meta'], 'readwrite'), presets = t.objectStore('presets'), meta = t.objectStore('meta');
        let current, values, keys, result, failure, count = 3;
        const ready = () => {
          if (--count) return;
          try { if (namespace !== scope()) fail('AGENT_PRESET_ACCOUNT_CHANGED'); result = operation({ current, metadata: new Map(keys.map((k, i) => [k, values[i]])), presets, meta }); }
          catch (e) { failure = e; t.abort(); }
        };
        const a = presets.getAll(); a.onsuccess = () => { current = a.result; ready(); };
        const b = meta.getAll(); b.onsuccess = () => { values = b.result; ready(); };
        const c = meta.getAllKeys(); c.onsuccess = () => { keys = c.result; ready(); };
        t.onabort = () => { db.close(); reject(failure || t.error || new Error('AGENT_PRESET_WRITE_ABORTED')); };
        t.onerror = () => { failure = failure || t.error; };
        t.oncomplete = () => {
          db.close();
          if (namespace !== scope()) { reject(new Error('AGENT_PRESET_ACCOUNT_CHANGED_AFTER_COMMIT')); return; }
          if (result.next && root.PRESETS) root.PRESETS.mem.presets = result.next;
          if (result.next) refresh();
          resolve(result.response);
        };
      };
    });
  }
  function checkpoint(ctx, next, action, details) {
    const backupId = 'apb-' + crypto.randomUUID(), createdAt = new Date().toISOString();
    const ids = ctx.metadata.get(BACKUPS) || [];
    const backup = { backupId, createdAt, action, details, before: ctx.current, after: signature(next), status: 'available' };
    // Preserve up to twenty full preset restore nodes; pruning is transactionally tied to the new node.
    const keep = ids.concat(backupId).slice(-20);
    for (const old of ids.filter(x => !keep.includes(x))) ctx.meta.delete(PREFIX + old);
    ctx.meta.put(backup, PREFIX + backupId); ctx.meta.put(keep, BACKUPS);
    return backupId;
  }
  async function guarded(fn) { try { return await fn(); } catch (e) { return { ok: false, error: String(e.code || e.message || 'AGENT_PRESET_FAILED') }; } }
  async function importPreset(input, fromConfirmedInbox = false) {
    return guarded(async () => {
      const namespace = scope(), generation = epoch;
      const envelope = C.validate(input), hash = await digest(C.stable(envelope));
      if (!fromConfirmedInbox) await requireGrant();
      if (namespace !== scope() || generation !== epoch) fail('AGENT_PRESET_ACCOUNT_CHANGED');
      return transact(ctx => {
        const receiptKey = PREFIX + 'receipt.' + hash, prior = ctx.metadata.get(receiptKey);
        if (prior) return { response: { ok: true, skipped: true, reason: prior.status === 'rolled-back' ? 'ROLLED_BACK_RECEIPT' : 'ALREADY_IMPORTED', presetId: prior.presetId, backupId: prior.backupId } };
        const version = root.V6Migration.versionTitle(envelope.name, new Set(ctx.current.map(p => p.title)));
        const now = new Date().toISOString();
        const p = root.PRESETS.normalizePreset({ ...envelope.preset, id: 'agent-' + hash, title: version.title, version: version.version,
          category: C.CATEGORY, author: envelope.author, createdAt: envelope.createdAt, importedAt: now, updatedAt: now,
          source: 'agent', _isFactory: false, agentReceipt: hash });
        const next = ctx.current.concat(p), backupId = checkpoint(ctx, next, 'import', { presetId: p.id, name: p.title, author: p.author, receipt: hash });
        ctx.presets.add(p, p.id); ctx.meta.put({ presetId: p.id, backupId, status: 'imported' }, receiptKey);
        return { next, response: { ok: true, imported: true, presetId: p.id, preset: clone(p), backupId } };
      });
    });
  }
  async function move(presetId, category) {
    return guarded(async () => { const namespace = scope(), generation = epoch; await requireGrant(); if (namespace !== scope() || generation !== epoch) fail('AGENT_PRESET_ACCOUNT_CHANGED'); return transact(ctx => {
      if (category === C.CATEGORY || !root.PRESETS.assets().some(a => a.id === category)) fail('AGENT_PRESET_CATEGORY_INVALID');
      const p = ctx.current.find(p => p.id === presetId);
      if (!p || p.category !== C.CATEGORY) fail('AGENT_PRESET_NOT_IN_INBOX');
      const moved = { ...p, category, updatedAt: new Date().toISOString() }, next = ctx.current.map(x => x.id === presetId ? moved : x);
      const backupId = checkpoint(ctx, next, 'move', { presetId, category });
      ctx.presets.put(moved, presetId);
      return { next, response: { ok: true, preset: clone(moved), backupId } };
    }); });
  }
  async function listBackups() {
    return guarded(() => transact(ctx => ({ response: { ok: true, backups: (ctx.metadata.get(BACKUPS) || []).slice().reverse().map(id => ctx.metadata.get(PREFIX + id)).filter(Boolean).map(({ before, after, ...b }) => b) } })));
  }
  async function rollback(request) {
    return guarded(async () => { const namespace = scope(), generation = epoch; await requireGrant(); if (namespace !== scope() || generation !== epoch) fail('AGENT_PRESET_ACCOUNT_CHANGED'); return transact(ctx => {
      if (!request || request.confirm !== true) fail('AGENT_PRESET_CONFIRMATION_REQUIRED');
      const b = ctx.metadata.get(PREFIX + String(request.backupId));
      if (!b || b.status !== 'available' || !Array.isArray(b.before)) fail('AGENT_PRESET_BACKUP_INVALID');
      if (signature(ctx.current) !== b.after) fail('AGENT_PRESET_HAS_NEW_CHANGES');
      const beforeBackupId = checkpoint(ctx, b.before, 'rollback', { restoredBackupId: b.backupId });
      ctx.presets.clear(); b.before.forEach(p => ctx.presets.put(p, p.id));
      ctx.meta.put({ ...b, status: 'restored' }, PREFIX + b.backupId);
      if (b.details.receipt) ctx.meta.put({ presetId: b.details.presetId, backupId: b.backupId, status: 'rolled-back' }, PREFIX + 'receipt.' + b.details.receipt);
      return { next: b.before, response: { ok: true, backupId: b.backupId, beforeBackupId } };
    }); });
  }
  async function poll() {
    if (scanning || !host()) return;
    scanning = true; const generation = epoch, namespace = scope();
    try {
      const result = await host().scan();
      if (!result.ok) { stop(false); root.ERR && root.ERR.report('AGENT_PRESET_INBOX_FAILED', { message: result.error }); return; }
      for (const file of result.files || []) {
        if (generation !== epoch || namespace !== scope()) break;
        let receipt;
        if (file.error) receipt = { ok: false, error: file.error };
        else { let value; try { value = JSON.parse(file.text); } catch (_) { receipt = { ok: false, error: 'AGENT_PRESET_JSON_INVALID' }; } if (!receipt) receipt = await importPreset(value, true); }
        if (generation !== epoch || namespace !== scope()) break;
        const ack = await host().ack({ name: file.name, hash: file.hash, status: receipt.ok ? (receipt.skipped ? 'skipped' : 'imported') : 'rejected', error: receipt.error || '', presetId: receipt.presetId || '', backupId: receipt.backupId || '' });
        if (!ack.ok) fail(ack.error || 'AGENT_PRESET_RECEIPT_WRITE_FAILED');
        if (!receipt.ok && root.ERR) root.ERR.report('AGENT_PRESET_IMPORT_FAILED', { message: receipt.error, file: file.name });
      }
    } finally { scanning = false; }
  }
  function stop(notifyHost = true) { epoch++; if (timer) clearInterval(timer); timer = null; if (notifyHost && host()) host().disable().catch(() => {}); }
  async function enableInbox() {
    return guarded(async () => {
      if (!host()) fail('AGENT_PRESET_HOST_UNAVAILABLE');
      const namespace = scope(), generation = epoch;
      const result = await host().enable({ scope: namespace });
      if (namespace !== scope() || generation !== epoch) fail('AGENT_PRESET_ACCOUNT_CHANGED');
      if (result.ok) { stop(false); timer = setInterval(() => poll().catch(e => { stop(); if (root.ERR) root.ERR.report('AGENT_PRESET_INBOX_FAILED', { message: e.code || e.message }); }), 2000); await poll(); }
      return result;
    });
  }
  root.addEventListener('wheelchair:storage-context', () => stop());
  root.V7AgentPresets = Object.freeze({ import: input => importPreset(input), move, listBackups, rollback, enableInbox, disableInbox: async () => { stop(); return { ok: true }; },
    inboxInfo: async () => host() ? host().info() : { ok: false, error: 'AGENT_PRESET_HOST_UNAVAILABLE' },
    openInbox: async () => host() ? host().openFolder() : { ok: false, error: 'AGENT_PRESET_HOST_UNAVAILABLE' },
    list: () => root.PRESETS.presets().filter(p => p.category === C.CATEGORY).map(clone), CATEGORY: C.CATEGORY });
})(window);
