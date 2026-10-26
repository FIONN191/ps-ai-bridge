'use strict';
const crypto = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function identity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('EAGLE_INPUT_INVALID', 'Invalid Eagle ID');
  return value;
}
function strings(value, limit, length) {
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== 'string' || !v.trim() || v.length > length)) throw fail('EAGLE_INPUT_INVALID', 'Invalid list');
  return [...new Set(value.map(v => v.trim()))];
}
function snapshot(item) {
  if (!item || item.isDeleted) throw fail('EAGLE_ITEM_MISSING', 'The Eagle item is missing or deleted');
  return { id: identity(item.id), name: String(item.name || ''), tags: strings(item.tags || [], 1000, 256), folders: strings(item.folders || [], 1000, 128), modifiedAt: Number(item.modifiedAt) || 0 };
}
function createArchiveService({ eagle, confirm, writeJournal, readJournals, now = Date.now }) {
  let epoch = 0, busy = false;
  const plans = new Map();
  const library = () => String(eagle.library.path || '');
  const assertContext = context => { if (context.epoch !== epoch || context.library !== library()) throw fail('EAGLE_LIBRARY_CHANGED', 'Eagle library changed; read the list again'); };
  function status() { return { protocol: 1, library: String(eagle.library.name || ''), capabilities: ['read', 'add-tags', 'move-folder'], busy }; }
  async function folders() {
    const list = await eagle.folder.getAll();
    if (!Array.isArray(list) || list.length > 10000) throw fail('EAGLE_RESPONSE_INVALID', 'Invalid folder list');
    const rows = [], seen = new Set();
    function add(list) { for (const folder of list) { if (!seen.has(folder.id)) { seen.add(folder.id); rows.push({ id: identity(folder.id), name: String(folder.name || folder.id) }); if (Array.isArray(folder.children)) add(folder.children); } } }
    add(list); return rows;
  }
  async function catalog(query = '') {
    const context = { epoch, library: library() };
    if (typeof query !== 'string' || query.length > 160) throw fail('EAGLE_INPUT_INVALID');
    const list = query.trim() ? await eagle.item.get({ keywords: [query.trim()], fields: ['id', 'name', 'tags', 'folders', 'modifiedAt', 'isDeleted'] }) : await eagle.item.getSelected();
    if (!Array.isArray(list)) throw fail('EAGLE_RESPONSE_INVALID');
    const folderRows = await folders(); assertContext(context);
    return { ...status(), folders: folderRows, items: list.filter(i => !i.isDeleted).slice(0, 100).map(snapshot), truncated: list.length > 100, selection: !query.trim() };
  }
  async function prepare(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['itemIds', 'addTags', 'fromFolderId', 'toFolderId'].includes(k))) throw fail('EAGLE_INPUT_INVALID', 'Only tag addition and folder moves are supported');
    const ids = strings(input.itemIds, 50, 128).map(identity), tags = strings(input.addTags || [], 50, 128);
    if (!ids.length || ids.length !== input.itemIds.length) throw fail('EAGLE_INPUT_INVALID', 'Select one to fifty distinct items');
    const from = input.fromFolderId ? identity(input.fromFolderId) : '', to = input.toFolderId ? identity(input.toFolderId) : '';
    if (from && (!to || from === to)) throw fail('EAGLE_INPUT_INVALID', 'Choose a different destination folder');
    if (!tags.length && !to) throw fail('EAGLE_INPUT_INVALID', 'Choose tags or a destination');
    const context = { epoch, library: library() }, folderRows = await folders();
    for (const id of [from, to].filter(Boolean)) if (!folderRows.some(f => f.id === id)) throw fail('EAGLE_FOLDER_MISSING', 'The selected folder no longer exists');
    const rows = [];
    for (const id of ids) {
      const before = snapshot(await eagle.item.getById(id)); assertContext(context);
      if (before.id !== id) throw fail('EAGLE_RESPONSE_INVALID', 'Eagle returned a different item');
      if (from && !before.folders.includes(from)) throw fail('EAGLE_FOLDER_CHANGED', 'An item is no longer in the selected source folder');
      const after = { ...before, tags: [...new Set([...before.tags, ...tags])], folders: to ? [...new Set([...before.folders.filter(id => id !== from), to])] : [...before.folders] };
      if (after.tags.length > 1000) throw fail('EAGLE_INPUT_INVALID', 'Too many tags');
      rows.push({ id, before, after, status: 'pending' });
    }
    const id = crypto.randomBytes(24).toString('hex'), expiresAt = now() + 300000;
    for (const [key, value] of plans) if (value.expiresAt <= now()) plans.delete(key);
    if (plans.size >= 32) throw fail('EAGLE_TOO_MANY_PLANS', 'Close old plans and try again');
    const plan = { id, ...context, libraryName: status().library, expiresAt, fromFolder: folderRows.find(f => f.id === from) || null, toFolder: folderRows.find(f => f.id === to) || null, addTags: tags, rows };
    plans.set(id, plan);
    return copy({ id, library: plan.libraryName, expiresAt, fromFolder: plan.fromFolder, toFolder: plan.toFolder, addTags: tags, rows });
  }
  async function commit(id) {
    if (busy) throw fail('EAGLE_BUSY', 'Another archive operation is in progress');
    const plan = plans.get(id);
    if (!plan || plan.expiresAt <= now()) throw fail('EAGLE_PLAN_EXPIRED', 'Read and confirm a new checklist');
    assertContext(plan); busy = true;
    try {
      if (!await confirm(copy({ library: plan.libraryName, fromFolder: plan.fromFolder, toFolder: plan.toFolder, addTags: plan.addTags, rows: plan.rows }))) return { ok: false, cancelled: true };
      assertContext(plan);
      if (plan.expiresAt <= now()) throw fail('EAGLE_PLAN_EXPIRED');
      plans.delete(id);
      const receipt = { id, library: plan.library, libraryName: plan.libraryName, createdAt: now(), status: 'running', addTags: plan.addTags, fromFolder: plan.fromFolder, toFolder: plan.toFolder, rows: copy(plan.rows) };
      await writeJournal(copy(receipt));
      for (const row of receipt.rows) {
        try {
          assertContext(plan);
          const item = await eagle.item.getById(row.id); assertContext(plan);
          if (!same(snapshot(item), row.before)) throw fail('EAGLE_ITEM_CHANGED', 'Item changed after the checklist; read it again');
          if (plan.toFolder && !await eagle.folder.getById(plan.toFolder.id)) throw fail('EAGLE_FOLDER_MISSING');
          assertContext(plan);
          row.status = 'saving'; await writeJournal(copy(receipt)); assertContext(plan);
          // Only these two documented Item properties are mutable in this bridge.
          item.tags = [...row.after.tags]; item.folders = [...row.after.folders];
          if (await item.save() !== true) throw fail('EAGLE_SAVE_FAILED', 'Eagle did not confirm the save');
          assertContext(plan);
          const actual = snapshot(await eagle.item.getById(row.id)); assertContext(plan);
          if (actual.name !== row.before.name || !same(actual.tags, row.after.tags) || !same(actual.folders, row.after.folders)) throw fail('EAGLE_VERIFY_FAILED', 'Saved metadata did not match the checklist');
          row.status = 'applied'; row.verifiedAt = now(); await writeJournal(copy(receipt));
        } catch (error) {
          row.status = row.status === 'saving' ? 'uncertain' : 'failed'; row.error = error.code || 'EAGLE_SAVE_FAILED';
          receipt.status = 'partial'; receipt.error = row.error;
          try { await writeJournal(copy(receipt)); } catch (_) { receipt.journalError = true; }
          return { ok: false, code: 'EAGLE_PARTIAL_FAILURE', message: 'Operation stopped. Re-read the receipt before retrying remaining items.', receipt: publicReceipt(receipt) };
        }
      }
      receipt.status = 'completed'; await writeJournal(copy(receipt));
      return { ok: true, receipt: publicReceipt(receipt) };
    } finally { busy = false; }
  }
  function publicReceipt(receipt) { const { library: privatePath, ...value } = receipt; return copy(value); }
  async function receipts() {
    const context = { epoch, library: library() }, rows = await readJournals();
    if (!Array.isArray(rows)) throw fail('EAGLE_JOURNAL_INVALID');
    const out = [];
    for (const receipt of rows.filter(r => r.library === context.library).slice(-30).reverse()) {
      for (const row of receipt.rows) {
        if (!['saving', 'uncertain'].includes(row.status)) continue;
        try {
          const current = snapshot(await eagle.item.getById(row.id)); assertContext(context);
          row.status = current.name === row.before.name && same(current.tags, row.after.tags) && same(current.folders, row.after.folders) ? 'applied' : same(current, row.before) ? 'pending' : 'conflict';
        } catch (error) { assertContext(context); row.status = 'unavailable'; row.error = error.code || 'EAGLE_READ_FAILED'; }
      }
      receipt.status = receipt.rows.every(r => r.status === 'applied') ? 'completed' : 'partial';
      out.push(publicReceipt(receipt));
    }
    assertContext(context); return out;
  }
  return { status, catalog, prepare, commit, receipts, invalidate() { epoch++; plans.clear(); } };
}
module.exports = { createArchiveService };
