// 预设库：出厂预设（helper/presets/factory，来自夏三七「修图轮椅 V6」，GPLv3）+ 用户预设（数据目录里的 presets，见 paths.mjs）。
// 预设格式沿用 V6：{ id, title, category, content, refImages[], starred }，content 里的 "@param:名": 数值 会在面板里变成滑杆，
// 【填空:名=默认值】 会变成输入框。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import { ROOT } from './config.mjs';
import { DATA_DIR } from './paths.mjs';
import { atomicJson } from './store.mjs';

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
  return { ...summary(p), content: p.content, params: parseParams(p.content), fills: parseFills(p.content), refImages: p.refImages };
}

const clean = p => ({ schemaVersion: 1, id: p.id, title: p.title, category: p.category,
  content: p.content, refImages: p.refImages || [], starred: Boolean(p.starred),
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

export function savePreset({ id, title, category, content, refImages, expectedRevision, kind }) {
  if (typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !content.trim()) throw new Error('预设要有名字和内容');
  if (title.length > 200 || content.length > 1024 * 1024) throw new Error('预设名字或内容过长');
  if (refImages !== undefined && (!Array.isArray(refImages) || refImages.some(x => typeof x !== 'string'))) throw new Error('参考图格式错误');
  const existing = id ? load().get(id) : null;
  if (id && !existing) throw new Error('预设已删除，请另存副本');
  if (expectedRevision != null && existing && Number(expectedRevision) !== (existing.revision || 1)) throw new Error('预设已被其他窗口修改，请重新打开后再编辑');
  const own = existing && !existing.factory;
  if (own) atomicJson(path.join(revisionDir(id), `${existing.revision || 1}.json`), clean(existing));
  const p = { ...(own ? existing : {}), id: own ? id : `u_${crypto.randomUUID()}`,
    title: title.trim(), category: CAT_IDS.has(category) ? category : existing?.category || 'other', content,
    refImages: refImages ?? existing?.refImages ?? [], starred: own ? existing.starred : false,
    kind: kind || existing?.kind || 'prompt', factory: false,
    revision: own ? (existing.revision || 1) + 1 : 1, updatedAt: Date.now() };
  writeUser(p);
  return getPreset(p.id);
}

export function setStar(id, starred) {
  const p = load().get(id);
  if (!p) throw new Error('没有这个预设');
  if (p.factory) {
    const stars = readJson(STARS_FILE, {});
    stars[id] = Boolean(starred);
    atomicJson(STARS_FILE, stars); cache = null;
  } else writeUser({ ...p, starred: Boolean(starred) });
}

export function deletePreset(id) {
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
  return { format: 'ps-ai-bridge-presets', schemaVersion: 1, exportedAt: Date.now(), presets: ids.map(id => {
    const p = load().get(id); if (!p) throw new Error(`找不到预设：${id}`); return clean(p);
  }) };
}

export function previewImport(raw) {
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
  for (const r of report) if (!r.duplicate && !r.errors.length) {
    const { id, ...p } = items[r.index];
    added.push(savePreset({ ...p, id: undefined }).id);
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
