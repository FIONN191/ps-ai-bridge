// 预设库：出厂预设（helper/presets/factory，来自夏三七「修图轮椅 V6」，GPLv3）+ 用户预设（数据目录里的 presets，见 paths.mjs）。
// 预设格式沿用 V6：{ id, title, category, content, refImages[], starred }，content 里的 "@param:名": 数值 会在面板里变成滑杆，
// 【填空:名=默认值】 会变成输入框。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import { ROOT } from './config.mjs';
import { DATA_DIR } from './paths.mjs';
import { atomicJson, readJson as readStrictJson } from './store.mjs';

// 分类沿用 V6 的人体剪影分区
export const CATEGORIES = [
  { id: 'head', name: '头部面部' },
  { id: 'hair', name: '头发' },
  { id: 'neck', name: '颈部' },
  { id: 'torso', name: '躯干腰腹' },
  { id: 'arms', name: '手臂' },
  { id: 'hands', name: '手部' },
  { id: 'legs', name: '腿部' },
  { id: 'feet', name: '脚部' },
  { id: 'clothing', name: '服装' },
  { id: 'accessory', name: '配饰' },
  { id: 'fullbody', name: '全身' },
  { id: 'lighting', name: '光影' },
  { id: 'background', name: '背景' },
  { id: 'weapon', name: '武器' },
  { id: 'cleanup', name: '去杂物' },
  { id: 'effects', name: '特效' },
  { id: 'other', name: '其他' },
];
const CAT_IDS = new Set(CATEGORIES.map((c) => c.id));

const FACTORY_DIR = path.join(ROOT, 'presets', 'factory');
export const USER_DIR = path.join(DATA_DIR, 'presets');
const TRASH_DIR = path.join(USER_DIR, '.trash');
const STARS_FILE = path.join(USER_DIR, '_stars.json');
const CATEGORIES_FILE = path.join(USER_DIR, '_categories.json');
const MOVE_JOURNAL = path.join(USER_DIR, '.move-transaction.json');
const BUILTIN_CATEGORIES = CATEGORIES.map(c => ({ ...c }));

// Keep the exported array live for the existing /presets response and PS panel.
export function listCategories() {
  const state = readStrictJson(CATEGORIES_FILE, { revision: 0, categories: [] });
  if (!Number.isInteger(state.revision) || !Array.isArray(state.categories)) throw new Error('分类文件损坏');
  CATEGORIES.splice(0, CATEGORIES.length, ...BUILTIN_CATEGORIES, ...state.categories);
  CAT_IDS.clear(); CATEGORIES.forEach(c => CAT_IDS.add(c.id));
  return { revision: state.revision, categories: CATEGORIES.map(c => ({ ...c, builtin: BUILTIN_CATEGORIES.some(b => b.id === c.id) })) };
}

export function saveCategory({ id, name, expectedRevision }) {
  const state = listCategories();
  if (expectedRevision !== state.revision) throw new Error('分类已被其他窗口修改，请刷新');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('分类名称应为 1–80 字');
  if (id && !state.categories.some(c => c.id === id && !c.builtin)) throw new Error('只能改名已有的自定义分类');
  if (state.categories.some(c => c.id !== id && c.name === name.trim())) throw new Error('分类名称已存在');
  const custom = state.categories.filter(c => !c.builtin).map(({ id, name }) => ({ id, name }));
  const category = { id: id || `cat_${crypto.randomUUID()}`, name: name.trim() };
  const i = custom.findIndex(c => c.id === id);
  if (i < 0) custom.push(category); else custom[i] = category;
  atomicJson(CATEGORIES_FILE, { schemaVersion: 1, revision: state.revision + 1, categories: custom });
  cache = null;
  return { ...listCategories(), category };
}

// A committed journal is rolled forward before any preset read. This makes a
// multi-file bulk move recoverable even if the helper stops between renames.
function recoverMove() {
  const tx = readStrictJson(MOVE_JOURNAL, null);
  if (!tx) return;
  if (!Array.isArray(tx.writes)) throw new Error('预设移动事务损坏');
  for (const { file, value } of tx.writes) {
    const target = path.resolve(USER_DIR, file);
    if (!target.startsWith(`${path.resolve(USER_DIR)}${path.sep}`)) throw new Error('预设移动路径无效');
    atomicJson(target, value);
  }
  fs.unlinkSync(MOVE_JOURNAL); cache = null;
}

let cache = null;

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

function searchKeys(title) {
  const full = pinyin(title, { toneType: 'none', type: 'array' }).join('');
  const initials = pinyin(title, { pattern: 'first', toneType: 'none', type: 'array' }).join('');
  return `${title.toLowerCase()} ${full.toLowerCase()} ${initials.toLowerCase()}`;
}

export function parseParams(content) {
  const params = [];
  const re = /"?@param:([^"]+)"\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi;
  let m;
  while ((m = re.exec(content))) {
    const name = m[1];
    if (/_(desc|label|note|range|step)$/.test(name) || params.some(p => p.name === name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const field = suffix => new RegExp(`"?@param:${escaped}_${suffix}"\\s*:\\s*(\\[[^\\]]+\\]|"[^" ]*"|-?[\\d.]+)`);
    const rangeText = field('range').exec(content)?.[1];
    let range;
    try { range = JSON.parse(rangeText); } catch {}
    if (typeof range === 'string') range = range.split(/[,~:]/).map(Number);
    const value = Number(m[2]);
    const hasRange = Array.isArray(range) && range.length >= 2 && range.slice(0, 2).every(Number.isFinite) && range[1] > range[0];
    const min = hasRange ? range[0] : Math.min(0, value);
    const max = hasRange ? range[1] : Math.max(1, value);
    const candidateStep = Number(field('step').exec(content)?.[1] || (hasRange && range[2]));
    const step = candidateStep > 0 && Number.isFinite(candidateStep) ? candidateStep : Number(((max - min) / 100).toPrecision(3));
    const desc = new RegExp(`"?@param:${escaped}_desc"\\s*:\\s*"([^"]*)"`).exec(content)?.[1] || '';
    params.push({ name, value, min, max, step, desc });
  }
  return params;
}

export function parseFills(content) {
  const fills = [];
  const re = /【填空:([^=】]+?)(?:=([^】]*))?】/g;
  let m;
  while ((m = re.exec(content))) {
    if (!fills.some((f) => f.name === m[1])) fills.push({ name: m[1], value: m[2] || '' });
  }
  return fills;
}

// 一个文件可能是单个预设、预设数组，或直接是 .md/.txt 提示词
function normalizeFile(file, factory) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).replace(/\.(json|md|txt|josn\.txt)$/i, '');
  const out = [];
  if (ext === '.json') {
    const raw = readJson(file, null);
    if (!raw) return out;
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.presets) ? raw.presets : [raw];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      // 极少数文件本身就是提示词 JSON（没有 title/content 外壳）
      const content = typeof it.content === 'string' ? it.content : JSON.stringify(it, null, 2);
      out.push({
        id: String(it.id || `${factory ? 'f' : 'u'}_${crypto.createHash('md5').update(file + content).digest('hex').slice(0, 10)}`),
        title: String(it.title || base),
        category: CAT_IDS.has(it.category) ? it.category : 'other',
        content,
        refImages: Array.isArray(it.refImages) ? it.refImages.filter((r) => typeof r === 'string' && r.length > 100) : [],
        referenceSources: Array.isArray(it.referenceSources) ? it.referenceSources : [],
        starred: Boolean(it.starred),
        revision: Number(it.revision) || 1,
        updatedAt: Number(it.updatedAt) || 0,
        kind: typeof it.kind === 'string' ? it.kind : 'prompt',
      });
    }
  } else if (ext === '.md' || ext === '.txt') {
    const content = fs.readFileSync(file, 'utf8');
    out.push({ id: `u_${crypto.createHash('md5').update(file).digest('hex').slice(0, 10)}`, title: base, category: 'other', content, refImages: [], starred: false });
  }
  return out.map((p) => ({ ...p, factory, file }));
}

function load() {
  recoverMove();
  listCategories();
  if (cache) return cache;
  fs.mkdirSync(USER_DIR, { recursive: true });
  const stars = readJson(STARS_FILE, {});
  const all = new Map();
  const scan = (dir, factory) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.startsWith('.') || f.startsWith('_')) continue;
      if (!fs.statSync(path.join(dir, f)).isFile()) continue;
      for (const p of normalizeFile(path.join(dir, f), factory)) {
        if (factory && p.id in stars) p.starred = stars[p.id];
        if (!all.has(p.id)) all.set(p.id, p);
      }
    }
  };
  scan(USER_DIR, false);
  scan(FACTORY_DIR, true);
  for (const p of all.values()) p.keys = searchKeys(p.title);
  cache = all;
  return all;
}

const summary = (p) => {
  const params = parseParams(p.content);
  return {
    id: p.id, title: p.title, category: p.category, starred: p.starred, factory: p.factory, keys: p.keys,
    revision: p.revision || 1, updatedAt: p.updatedAt || 0, kind: p.kind || 'prompt',
    paramCount: params.length, fillCount: parseFills(p.content).length, refCount: p.refImages.length,
  };
};

export function listPresets() {
  return [...load().values()].map(summary).sort((a, b) => (b.starred - a.starred) || (a.factory - b.factory) || a.title.localeCompare(b.title, 'zh'));
}

export function getPreset(id) {
  const p = load().get(id);
  if (!p) return null;
  return { ...summary(p), content: p.content, params: parseParams(p.content), fills: parseFills(p.content), refImages: p.refImages, referenceSources: p.referenceSources || [] };
}

const clean = p => ({ schemaVersion: 1, id: p.id, title: p.title, category: p.category,
  content: p.content, refImages: p.refImages || [], referenceSources: p.referenceSources || [], starred: Boolean(p.starred),
  kind: p.kind || 'prompt', revision: p.revision || 1, updatedAt: p.updatedAt || Date.now() });
const slug = id => crypto.createHash('sha256').update(String(id)).digest('hex');
const revisionDir = id => path.join(USER_DIR, '.revisions', slug(id));

// Legacy user files can contain several presets. Update just this record; keep siblings.
function writeUser(p) {
  const file = p.file && !p.factory && p.file.endsWith('.json') ? p.file : path.join(USER_DIR, `${slug(p.id)}.json`);
  const old = fs.existsSync(file) ? readJson(file, null) : null;
  if (fs.existsSync(file) && old === null) throw new Error('预设文件损坏，保留原文件，未覆盖');
  const records = Array.isArray(old) ? old : old && Array.isArray(old.presets) ? old.presets : null;
  const value = clean(p);
  if (records) {
    const normalized = normalizeFile(file, false);
    const index = normalized.findIndex(x => x.id === p.id);
    if (index < 0) records.push(value); else records[index] = value;
    atomicJson(file, Array.isArray(old) ? records : { ...old, presets: records });
  } else atomicJson(file, value);
  cache = null;
}

export function savePreset({ id, title, category, content, refImages, referenceSources, expectedRevision, kind }) {
  cache = null; // Compare revisions with disk, including writes by another window.
  if (typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !content.trim()) throw new Error('预设要有名字和内容');
  if (title.length > 200 || content.length > 1024 * 1024) throw new Error('预设名字或内容过长');
  if (refImages !== undefined && (!Array.isArray(refImages) || refImages.some(x => typeof x !== 'string'))) throw new Error('参考图格式错误');
  if (referenceSources !== undefined && (!Array.isArray(referenceSources) || referenceSources.some(x => !x || typeof x !== 'object') || JSON.stringify(referenceSources).length > 128 * 1024)) throw new Error('参考图来源格式错误');
  const existing = id ? load().get(id) : null;
  if (id && !existing) throw new Error('预设已删除，请另存副本');
  if (expectedRevision != null && existing && Number(expectedRevision) !== (existing.revision || 1)) throw new Error('预设已被其他窗口修改，请重新打开后再编辑');
  const own = existing && !existing.factory;
  if (own) atomicJson(path.join(revisionDir(id), `${existing.revision || 1}.json`), clean(existing));
  const p = { ...(own ? existing : {}), id: own ? id : `u_${crypto.randomUUID()}`,
    title: title.trim(), category: CAT_IDS.has(category) ? category : existing?.category || 'other', content,
    refImages: refImages ?? existing?.refImages ?? [], starred: own ? existing.starred : false,
    referenceSources: referenceSources ?? (refImages === undefined ? existing?.referenceSources || [] : []),
    kind: kind || existing?.kind || 'prompt', factory: false,
    revision: own ? (existing.revision || 1) + 1 : 1, updatedAt: Date.now() };
  writeUser(p);
  return getPreset(p.id);
}

export function setStar(id, starred) {
  cache = null;
  const p = load().get(id);
  if (!p) throw new Error('没有这个预设');
  if (p.factory) {
    const stars = readJson(STARS_FILE, {});
    stars[id] = Boolean(starred);
    atomicJson(STARS_FILE, stars); cache = null;
  } else {
    atomicJson(path.join(revisionDir(id), `${p.revision || 1}.json`), clean(p));
    writeUser({ ...p, starred: Boolean(starred), revision: (p.revision || 1) + 1, updatedAt: Date.now() });
  }
}

export function deletePreset(id) {
  cache = null;
  const p = load().get(id);
  if (!p) throw new Error('没有这个预设');
  if (p.factory) throw new Error('出厂预设不能删，可以复制后编辑');
  const entry = { ...clean(p), trashId: crypto.randomUUID(), deletedAt: Date.now() };
  atomicJson(path.join(TRASH_DIR, `${entry.trashId}.json`), entry);
  const all = normalizeFile(p.file, false).filter(x => x.id !== id);
  if (all.length) atomicJson(p.file, all.map(clean));
  else fs.unlinkSync(p.file);
  cache = null;
}

export function listTrash() {
  if (!fs.existsSync(TRASH_DIR)) return [];
  return fs.readdirSync(TRASH_DIR).filter(f => f.endsWith('.json')).flatMap(f => {
    const value = readJson(path.join(TRASH_DIR, f), null);
    return value?.trashId ? [{ ...value, content: undefined, refImages: undefined }] : [];
  }).sort((a,b) => b.deletedAt - a.deletedAt);
}

export function restorePreset(trashId) {
  if (!/^[a-f0-9-]{36}$/.test(trashId)) throw new Error('回收记录无效');
  const file = path.join(TRASH_DIR, `${trashId}.json`);
  const p = readJson(file, null);
  if (!p) throw new Error('回收记录不存在');
  const id = load().has(p.id) ? `u_${crypto.randomUUID()}` : p.id;
  writeUser({ ...p, id, file: null });
  fs.unlinkSync(file);
  return getPreset(id);
}

export function listRevisions(id) {
  const dir = revisionDir(id);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => readJson(path.join(dir, f), null)).filter(Boolean).sort((a,b) => b.revision - a.revision) : [];
}

export function restoreRevision(id, revision) {
  const p = listRevisions(id).find(x => x.revision === Number(revision));
  if (!p) throw new Error('版本不存在');
  return savePreset({ ...p, id });
}

export function exportPresets(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('先选择要导出的预设');
  const presets = ids.map(id => {
    const p = load().get(id); if (!p) throw new Error(`找不到预设：${id}`); return clean(p);
  });
  const used = new Set(presets.map(p => p.category));
  return { format: 'ps-ai-bridge-presets', schemaVersion: 1, exportedAt: Date.now(), presets,
    categories: listCategories().categories.filter(c => !c.builtin && used.has(c.id)).map(({ id, name }) => ({ id, name })) };
}

export function previewImport(raw) {
  if (raw?.categories !== undefined && (!Array.isArray(raw.categories) || raw.categories.length > 500 || raw.categories.some(c => !c || typeof c.id !== 'string' || !/^[\w-]{1,100}$/.test(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) || new Set(raw.categories.map(c => c.id)).size !== raw.categories.length)) throw new Error('预设包分类格式错误');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [raw];
  if (items.length > 5000) throw new Error('一次最多导入 5000 个预设');
  const have = [...load().values()];
  return items.map((p, index) => {
    const errors = [];
    if (!p || typeof p.title !== 'string' || !p.title.trim() || typeof p.content !== 'string' || !p.content.trim()) errors.push('缺少名称或提示词内容');
    if (p?.kind && p.kind !== 'prompt') errors.push(`工具类型 ${p.kind} 需要对应工具导入，不能当普通提示词`);
    if (p?.workflow || p?.workflowId || p?.nodes) errors.push('包含工作流，请通过工作流导入');
    if (p?.refImages && (!Array.isArray(p.refImages) || p.refImages.some(x => typeof x !== 'string'))) errors.push('参考图格式错误');
    const duplicate = have.some(x => x.title === p?.title && x.content === p?.content && JSON.stringify(x.refImages || []) === JSON.stringify(p?.refImages || []));
    return { index, title: p?.title || `第 ${index + 1} 项`, duplicate, conflict: have.some(x => x.title === p?.title) && !duplicate, errors };
  });
}

export function importPack(raw, preview = false) {
  const report = previewImport(raw);
  if (preview) return { report };
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [raw];
  const added = [];
  const categories = new Map();
  const needed = new Set(report.filter(r => !r.duplicate && !r.errors.length).map(r => items[r.index].category));
  for (const c of raw?.categories || []) if (needed.has(c.id)) {
    const current = listCategories();
    const match = current.categories.find(x => x.name === c.name.trim());
    const category = match || saveCategory({ name: c.name, expectedRevision: current.revision }).category;
    categories.set(c.id, category.id);
  }
  for (const r of report) if (!r.duplicate && !r.errors.length) {
    const { id, ...p } = items[r.index];
    added.push(savePreset({ ...p, id: undefined, category: categories.get(p.category) || p.category }).id);
  }
  return { added: added.length, ids: added, skipped: report.filter(r => r.duplicate).length, rejected: report.filter(r => r.errors.length).length, report };
}

export function importFolder(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`文件夹不存在：${dir}`);
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.') || !fs.statSync(path.join(dir, f)).isFile()) continue;
    for (const p of normalizeFile(path.join(dir, f), false)) items.push(clean(p));
  }
  return importPack(items);
}

// Caller must supply every selected record's revision; factory records are never
// silently copied or mutated by a bulk move.
export function bulkMovePresets({ ids, category, expectedRevisions }) {
  cache = null;
  const all = load();
  if (!CAT_IDS.has(category)) throw new Error('目标分类不存在');
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || new Set(ids).size !== ids.length) throw new Error('请选择不同的个人预设');
  const records = ids.map(id => {
    const p = all.get(id);
    if (!p || p.factory) throw new Error('批量移动只支持已有个人预设，请先复制出厂预设');
    if (expectedRevisions?.[id] !== (p.revision || 1)) throw new Error('预设已被其他窗口修改，请刷新');
    return p;
  });
  // Validate all records before creating the transaction or writing any data.
  const files = new Map(), writes = [], now = Date.now();
  for (const p of records) {
    if (!p.file.endsWith('.json')) throw new Error('请先保存文本预设为个人 JSON 预设，再批量移动');
    if (!files.has(p.file)) {
      const raw = readStrictJson(p.file, null);
      if (!raw) throw new Error('预设文件损坏');
      files.set(p.file, { raw, normalized: normalizeFile(p.file, false) });
    }
    const file = files.get(p.file), next = clean({ ...p, category, revision: (p.revision || 1) + 1, updatedAt: now });
    const siblings = Array.isArray(file.raw) ? file.raw : Array.isArray(file.raw.presets) ? file.raw.presets : null;
    if (siblings) siblings[file.normalized.findIndex(x => x.id === p.id)] = next;
    else file.raw = next;
    writes.push({ file: path.relative(USER_DIR, path.join(revisionDir(p.id), `${p.revision || 1}.json`)), value: clean(p) });
  }
  for (const [file, { raw }] of files) writes.push({ file: path.relative(USER_DIR, file), value: raw });
  atomicJson(MOVE_JOURNAL, { schemaVersion: 1, writes });
  recoverMove();
  return { presets: ids.map(getPreset) };
}

const fieldFile = id => path.join(USER_DIR, '.field-history', `${slug(id)}.json`);
export function getFieldHistory(id) {
  if (!getPreset(id)) throw new Error('预设不存在');
  return readStrictJson(fieldFile(id), { schemaVersion: 1, revision: 0, entries: [] });
}

// Histories are separate from content revisions: using a preset does not edit it.
// Values are keyed by the declared field name, never by the current UI index.
export function recordFieldHistory({ id, expectedRevision, expectedPresetRevision, params = {}, fills = {} }) {
  cache = null;
  const p = getPreset(id);
  if (!p) throw new Error('预设不存在');
  if (expectedPresetRevision !== p.revision) throw new Error('预设已被其他窗口修改，请重新打开');
  const history = getFieldHistory(id);
  if (expectedRevision !== history.revision) throw new Error('字段历史已被其他窗口修改，请刷新');
  if (!params || typeof params !== 'object' || Array.isArray(params) || !fills || typeof fills !== 'object' || Array.isArray(fills)) throw new Error('字段格式错误');
  const numeric = Object.create(null), text = Object.create(null);
  for (const [name, value] of Object.entries(params)) {
    const field = p.params.find(f => f.name === name);
    if (!field || typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`参数超出范围：${name}`);
    const steps = (value - field.min) / field.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6 && value !== field.value) throw new Error(`参数步长不符：${name}`);
    numeric[name] = value;
  }
  for (const [name, value] of Object.entries(fills)) {
    if (!p.fills.some(f => f.name === name) || typeof value !== 'string' || value.length > 4000 || /】/.test(value)) throw new Error(`填空内容无效：${name}`);
    text[name] = value;
  }
  const entry = { id: crypto.randomUUID(), usedAt: Date.now(), presetRevision: p.revision, params: numeric, fills: text };
  const signature = x => JSON.stringify([Object.entries(x.params).sort(), Object.entries(x.fills).sort()]);
  history.entries = [entry, ...history.entries.filter(x => signature(x) !== signature(entry))].slice(0, 30);
  history.revision++;
  atomicJson(fieldFile(id), history);
  return history;
}

// Resolve by callback so replacement values such as "$&" remain literal text.
export function applyPresetFields(id, { params = {}, fills = {} } = {}) {
  const p = getPreset(id);
  if (!p) throw new Error('预设不存在');
  let content = p.content;
  for (const [name, value] of Object.entries(params)) {
    const field = p.params.find(f => f.name === name);
    if (!field || typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`参数超出范围：${name}`);
    const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(`("?@param:${key}"\\s*:\\s*)-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?`, 'gi'), (_, prefix) => prefix + value);
  }
  content = content.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (match, name) => {
    if (!Object.hasOwn(fills, name)) return match;
    const value = fills[name];
    if (typeof value !== 'string' || value.length > 4000 || /】/.test(value)) throw new Error(`填空内容无效：${name}`);
    return `【填空:${name}=${value}】`;
  });
  return { content, modified: content !== p.content };
}
