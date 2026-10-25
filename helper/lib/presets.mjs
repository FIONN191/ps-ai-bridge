// 预设库：出厂预设（helper/presets/factory，来自夏三七「修图轮椅 V6」，GPLv3）+ 用户预设（数据目录里的 presets，见 paths.mjs）。
// 预设格式沿用 V6：{ id, title, category, content, refImages[], starred }，content 里的 "@param:名": 数值 会在面板里变成滑杆，
// 【填空:名=默认值】 会变成输入框。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import { ROOT } from './config.mjs';
import { DATA_DIR } from './paths.mjs';

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
  const re = /"@param:([^"]+)"\s*:\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(content))) {
    const name = m[1];
    if (/_(desc|label|note|range)$/.test(name)) continue;
    if (params.some((p) => p.name === name)) continue;
    const desc = new RegExp(`"@param:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_desc"\\s*:\\s*"([^"]*)"`).exec(content);
    params.push({ name, value: Number(m[2]), desc: desc ? desc[1] : '' });
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
    const items = Array.isArray(raw) ? raw : [raw];
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

function writeUser(p) {
  const file = p.file && !p.factory && p.file.endsWith('.json') ? p.file : path.join(USER_DIR, `${p.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: p.id, title: p.title, category: p.category, content: p.content, refImages: p.refImages || [], starred: Boolean(p.starred), _isFactory: false }, null, 2));
  cache = null;
}

// 改出厂预设时另存成一份用户预设，出厂文件不动
export function savePreset({ id, title, category, content, refImages }) {
  if (!title || !content) throw new Error('预设要有名字和内容');
  const existing = id ? load().get(id) : null;
  const p = existing && !existing.factory
    ? { ...existing, title, category: CAT_IDS.has(category) ? category : existing.category, content, refImages: refImages ?? existing.refImages }
    : { id: `u_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, title, category: CAT_IDS.has(category) ? category : 'other', content, refImages: refImages || [], starred: false, factory: false };
  writeUser(p);
  return getPreset(p.id);
}

export function setStar(id, starred) {
  const p = load().get(id);
  if (!p) throw new Error('没有这个预设');
  if (p.factory) {
    const stars = readJson(STARS_FILE, {});
    stars[id] = Boolean(starred);
    fs.writeFileSync(STARS_FILE, JSON.stringify(stars, null, 2));
    cache = null;
  } else {
    writeUser({ ...p, starred: Boolean(starred) });
  }
}

// 删除只是挪进 .trash，后悔了能从文件夹里拿回来
export function deletePreset(id) {
  const p = load().get(id);
  if (!p) throw new Error('没有这个预设');
  if (p.factory) throw new Error('出厂预设不能删，可以不收藏它');
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.renameSync(p.file, path.join(TRASH_DIR, `${Date.now()}_${path.basename(p.file)}`));
  cache = null;
}

// V6 搬家：把 V6 导出的预设文件夹整个导进来，同名同内容的跳过
export function importFolder(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`文件夹不存在：${dir}`);
  const have = new Set([...load().values()].map((p) => crypto.createHash('md5').update(p.title + p.content).digest('hex')));
  let added = 0;
  let skipped = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    for (const p of normalizeFile(path.join(dir, f), false)) {
      const h = crypto.createHash('md5').update(p.title + p.content).digest('hex');
      if (have.has(h)) { skipped++; continue; }
      have.add(h);
      const id = load().has(p.id) ? `u_${Date.now()}_${crypto.randomBytes(3).toString('hex')}` : p.id;
      writeUser({ ...p, id, file: null });
      added++;
    }
  }
  cache = null;
  return { added, skipped };
}
