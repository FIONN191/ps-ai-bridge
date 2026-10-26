'use strict';
// 生成缓存：<缓存根>/<PS 项目>/<每次计算>/{meta.json, input.png, output_N.png, thumb_N.jpg, prompt.txt, ...}
// 检查点和生成任务同一套目录，只是写 checkpoint.json 不写 meta.json。
// 删除先进回收站 <缓存根>/.trash/<recoveryId>/，能恢复；彻底清理才真删。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TRASH = '.trash';

function fail(code) { return Object.assign(new Error(code), { code }); }
function safePart(value) {
  const text = String(value || '').trim();
  if (!text || text === '.' || /[\\/]|\.\.|[\u0000-\u001f]/.test(text) || text.startsWith('.')) throw fail('CACHE_PATH_INVALID');
  return text;
}
function safeName(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_\-][A-Za-z0-9_.\-]{0,159}$/.test(text) || text.includes('..')) throw fail('CACHE_NAME_INVALID');
  return text;
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function dirBytes(dir) {
  let total = 0;
  for (const e of safeReaddir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) try { total += fs.statSync(p).size; } catch (_) {}
  }
  return total;
}
function safeReaddir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }
// 一次计算属于哪一天：先看目录名的日期前缀（20260930-011319-2），看不出来才用 meta 的时间
function runDateOf(runId, meta) {
  const head = String(runId || '').slice(0, 8);
  if (/^\d{8}$/.test(head)) return `${head.slice(0, 4)}-${head.slice(4, 6)}-${head.slice(6, 8)}`;
  for (const key of ['completedAt', 'createdAt', 'savedAt']) {
    const v = meta && meta[key];
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    if (Number.isFinite(t) && t > 0) return new Date(t).toISOString().slice(0, 10);
  }
  return '';
}
const ownedBy = (namespaceId, project, meta) => !namespaceId
  || String(project).startsWith(`${namespaceId}__`) || (meta && meta.namespaceId === namespaceId);

function registerCacheIpc(ipcMain, { defaultRoot, configFile, isMainSender, openPath, chooseDirectory }) {
  const root = () => {
    const configured = readJson(configFile);
    return configured && typeof configured.root === 'string' && path.isAbsolute(configured.root) ? configured.root : defaultRoot;
  };
  const runDir = (project, runId) => path.join(root(), safePart(project), safePart(runId));

  function runs() {
    const out = [];
    for (const p of safeReaddir(root())) {
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      for (const r of safeReaddir(path.join(root(), p.name))) {
        if (!r.isDirectory() || r.name.startsWith('.')) continue;
        const dir = path.join(root(), p.name, r.name);
        const meta = readJson(path.join(dir, 'meta.json')) || readJson(path.join(dir, 'checkpoint.json'));
        out.push({ project: p.name, runId: r.name, meta, dir });
      }
    }
    return out;
  }

  const trashDir = () => path.join(root(), TRASH);
  function moveToTrash(info, files) {
    const recoveryId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const dest = path.join(trashDir(), recoveryId);
    fs.mkdirSync(path.join(dest, 'files'), { recursive: true });
    for (const [from, name] of files) fs.renameSync(from, path.join(dest, 'files', name));
    writeAtomic(path.join(dest, 'info.json'), JSON.stringify({ ...info, recoveryId, deletedAt: new Date().toISOString() }));
    return recoveryId;
  }
  function trashItems(namespaceId) {
    return safeReaddir(trashDir()).filter((e) => e.isDirectory())
      .map((e) => readJson(path.join(trashDir(), e.name, 'info.json')))
      .filter((info) => info && info.recoveryId && ownedBy(namespaceId, info.project, info));
  }

  const handlers = {
    root: () => root(),
    writeFile(project, runId, name, bytes) {
      const file = path.join(runDir(project, runId), safeName(name));
      const data = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
      writeAtomic(file, data);
      return { ok: true, path: file, bytes: data.length };
    },
    writeMeta(project, runId, meta) {
      writeAtomic(path.join(runDir(project, runId), 'meta.json'), JSON.stringify(meta || {}, null, 2));
      return { ok: true };
    },
    readFile(project, runId, name) {
      try { return fs.readFileSync(path.join(runDir(project, runId), safeName(name))); } catch (_) { return new Uint8Array(0); }
    },
    list: () => ({ ok: true, root: root(), runs: runs().map(({ project, runId, meta }) => ({ project, runId, meta })) }),
    async openFolder(project, runId) {
      const target = project && runId ? runDir(project, runId) : project ? path.join(root(), safePart(project)) : root();
      fs.mkdirSync(target, { recursive: true });
      const error = await openPath(target);
      return error ? { ok: false, error } : { ok: true, path: target };
    },
    deleteRun({ namespaceId, project, runId } = {}) {
      const dir = runDir(project, runId);
      if (!fs.existsSync(dir)) return { ok: false, error: 'CACHE_RUN_NOT_FOUND' };
      const meta = readJson(path.join(dir, 'meta.json'));
      if (!ownedBy(namespaceId, project, meta)) return { ok: false, error: 'CACHE_NAMESPACE_DENIED' };
      const recoveryId = moveToTrash({ kind: 'run', project, runId, namespaceId: namespaceId || '' }, [[dir, 'run']]);
      return { ok: true, recoveryId };
    },
    deleteOutput({ namespaceId, project, runId, index } = {}) {
      const dir = runDir(project, runId), n = Number(index) + 1;
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'CACHE_OUTPUT_INVALID' };
      const metaFile = path.join(dir, 'meta.json'), meta = readJson(metaFile);
      if (!ownedBy(namespaceId, project, meta)) return { ok: false, error: 'CACHE_NAMESPACE_DENIED' };
      const files = safeReaddir(dir).filter((e) => e.isFile() && new RegExp(`^(output|thumb|raw|base)_${n}(\\b|[._])`).test(e.name))
        .map((e) => [path.join(dir, e.name), e.name]);
      if (!files.length) return { ok: false, error: 'CACHE_OUTPUT_NOT_FOUND' };
      const recoveryId = moveToTrash({ kind: 'output', project, runId, outputIndex: n - 1, namespaceId: namespaceId || '' }, files);
      if (meta) {
        meta.deletedOutputs = [...new Set([...(meta.deletedOutputs || []), n - 1])];
        writeAtomic(metaFile, JSON.stringify(meta, null, 2));
      }
      return { ok: true, recoveryId };
    },
    purgeTweenFiles({ project, runId, batch } = {}) {
      const dir = runDir(project, runId), limit = Math.max(1, Math.min(2000, Number(batch) || 400));
      const matches = safeReaddir(dir).filter((e) => e.isFile() && /^tween_.*\.(png|json)$/i.test(e.name));
      let removed = 0, bytes = 0;
      for (const e of matches.slice(0, limit)) {
        const p = path.join(dir, e.name);
        try { bytes += fs.statSync(p).size; fs.rmSync(p); removed++; } catch (_) {}
      }
      return { ok: true, removed, bytes, remaining: Math.max(0, matches.length - removed) };
    },
    listDeleted: (namespaceId) => ({ ok: true, items: trashItems(namespaceId).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt))) }),
    restoreDeleted({ recoveryId, namespaceId } = {}) {
      const info = trashItems(namespaceId).find((i) => i.recoveryId === recoveryId);
      if (!info) return { ok: false, error: 'CACHE_RECOVERY_NOT_FOUND' };
      const src = path.join(trashDir(), recoveryId, 'files');
      const dir = runDir(info.project, info.runId);
      if (info.kind === 'run') {
        if (fs.existsSync(dir)) return { ok: false, error: 'CACHE_RESTORE_CONFLICT' };
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.renameSync(path.join(src, 'run'), dir);
      } else {
        const names = fs.readdirSync(src);
        if (names.some((n) => fs.existsSync(path.join(dir, n)))) return { ok: false, error: 'CACHE_RESTORE_CONFLICT' };
        fs.mkdirSync(dir, { recursive: true });
        for (const n of names) fs.renameSync(path.join(src, n), path.join(dir, n));
        const metaFile = path.join(dir, 'meta.json'), meta = readJson(metaFile);
        if (meta && Array.isArray(meta.deletedOutputs)) {
          meta.deletedOutputs = meta.deletedOutputs.filter((i) => i !== info.outputIndex);
          writeAtomic(metaFile, JSON.stringify(meta, null, 2));
        }
      }
      fs.rmSync(path.join(trashDir(), recoveryId), { recursive: true, force: true });
      return { ok: true, project: info.project, runId: info.runId };
    },
    purgeDeleted({ recoveryId, namespaceId } = {}) {
      const info = trashItems(namespaceId).find((i) => i.recoveryId === recoveryId);
      if (!info) return { ok: false, error: 'CACHE_RECOVERY_NOT_FOUND' };
      fs.rmSync(path.join(trashDir(), recoveryId), { recursive: true, force: true });
      return { ok: true };
    },
    checkpointInventory({ namespaceId } = {}) {
      const items = [], skipped = [];
      for (const run of runs()) {
        const cp = readJson(path.join(run.dir, 'checkpoint.json'));
        if (!cp || cp.kind !== 'checkpoint' || !ownedBy(namespaceId, run.project, cp)) continue;
        if (!fs.existsSync(path.join(run.dir, 'canvas.png'))) { skipped.push({ project: run.project, runId: run.runId, error: '缺少 canvas.png' }); continue; }
        items.push({ project: run.project, runId: run.runId, cacheRef: cp.cacheRef || `cache:${run.project}/${run.runId}/canvas.png`, createdAt: cp.createdAt, sizeBytes: dirBytes(run.dir) });
      }
      return { ok: true, items, skipped, totalBytes: items.reduce((n, i) => n + i.sizeBytes, 0) };
    },
    purgeCheckpoint({ namespaceId, project, runId } = {}) {
      const dir = runDir(project, runId), cp = readJson(path.join(dir, 'checkpoint.json'));
      if (!cp || cp.kind !== 'checkpoint') return { ok: false, error: 'CACHE_CHECKPOINT_NOT_FOUND' };
      if (!ownedBy(namespaceId, project, cp)) return { ok: false, error: 'CACHE_NAMESPACE_DENIED' };
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    },
    async chooseRoot() {
      const picked = await chooseDirectory();
      if (!picked) return { ok: false, cancelled: true };
      const from = root(), to = path.resolve(picked);
      if (to === from) return { ok: true, root: to, copied: 0 };
      if (to.startsWith(from + path.sep)) return { ok: false, error: 'CACHE_ROOT_INSIDE_OLD' };
      // 先完整复制并按大小核对，旧目录原样保留
      let copied = 0;
      if (fs.existsSync(from)) {
        fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
        if (dirBytes(to) < dirBytes(from)) return { ok: false, error: 'CACHE_COPY_INCOMPLETE' };
        copied = runs().length;
      }
      writeAtomic(configFile, JSON.stringify({ root: to }, null, 2));
      return { ok: true, root: to, previousRoot: from, copied };
    },
    usageReport({ namespaceId } = {}) {
      const byProject = new Map(), byDate = new Map(), total = { bytes: 0, runs: 0 };
      for (const run of runs()) {
        if (!run.meta || run.meta.kind === 'checkpoint' || !ownedBy(namespaceId, run.project, run.meta)) continue;
        const bytes = dirBytes(run.dir), date = runDateOf(run.runId, run.meta) || '未知日期';
        total.bytes += bytes; total.runs++;
        for (const [map, key, field] of [[byProject, run.project, 'project'], [byDate, date, 'date']]) {
          const row = map.get(key) || { [field]: key, bytes: 0, runs: 0 };
          row.bytes += bytes; row.runs++;
          map.set(key, row);
        }
      }
      return { ok: true, total, byProject: [...byProject.values()].sort((a, b) => b.bytes - a.bytes), byDate: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)) };
    },
  };

  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`cache:${name}`, async (event, ...args) => {
      if (isMainSender && !isMainSender(event.sender)) return { ok: false, error: 'CACHE_CALLER_DENIED' };
      try { return await fn(...args); } catch (error) {
        if (name === 'readFile') return new Uint8Array(0);
        if (name === 'root') return '';
        return { ok: false, error: error.code || error.message || String(error) };
      }
    });
  }
  return { root, runs };
}

module.exports = { registerCacheIpc, runDateOf };
