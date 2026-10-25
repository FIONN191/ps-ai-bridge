// Durable references and category layout. No third-party UI or implementation.
// Router contract: await libraryRoutes(method, ['library', ...segments], body).
// JSON for normal routes; GET /library/images/:id returns {buffer, type} for the
// HTTP adapter to send as binary (never JSON). Unknown routes return null.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from './paths.mjs';
import { atomicJson, readJson } from './store.mjs';
import { useUpload, saveUpload } from './jobs.mjs';
import { listCategories, saveCategory, bulkMovePresets, getPreset, savePreset,
  getFieldHistory, recordFieldHistory, applyPresetFields } from './presets.mjs';

const ROOT = path.join(DATA_DIR, 'library');
const FILE = path.join(ROOT, 'library.json');
const imagePath = id => {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('图库图片 ID 无效');
  return path.join(ROOT, 'images', `${id}.png`);
};
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function initialBoard() {
  const regions = [
    ['hair', .39, .035, .22, .065], ['head', .4, .105, .2, .08], ['neck', .43, .19, .14, .05],
    ['torso', .39, .26, .22, .22], ['arms', .22, .28, .12, .2], ['hands', .2, .49, .12, .08],
    ['clothing', .64, .28, .24, .09], ['accessory', .65, .17, .28, .07],
    ['legs', .36, .59, .28, .24], ['feet', .34, .86, .32, .075],
    ['fullbody', .02, .58, .26, .07], ['lighting', .02, .69, .26, .07], ['background', .7, .58, .28, .07],
    ['weapon', .7, .69, .28, .07], ['cleanup', .02, .8, .26, .07], ['effects', .7, .8, .28, .07], ['other', .7, .91, .28, .07],
  ];
  return { imageId: null, hotspots: regions.map(([category, x, y, width, height]) => ({ id: `default-${category}`, category, x, y, width, height, z: 1, visible: true })) };
}
function read() {
  const state = readJson(FILE, { schemaVersion: 1, revision: 0, references: [], board: initialBoard() });
  if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || !Array.isArray(state.references) || !Array.isArray(state.board?.hotspots)) throw fail('图库数据损坏，保留原文件', 500);
  return state;
}
function checkRevision(state, expected) {
  if (!Number.isInteger(expected) || expected !== state.revision) throw fail('图库已被其他窗口修改，请刷新后重试', 409);
}
function write(state) {
  state.revision++;
  atomicJson(FILE, state);
  return view(state);
}
function view(state) {
  return { ...state, references: state.references.map(r => ({ ...r, imageUrl: `/library/images/${r.imageId}` })),
    board: { ...state.board, imageUrl: state.board.imageId ? `/library/images/${state.board.imageId}` : null } };
}
function label(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 200) throw fail('名称应为不超过 200 字的文本');
  return value.trim() || fallback;
}
function sourceInfo(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('来源格式错误');
  if (!['file', 'clipboard', 'screenshot', 'photoshop', 'preset', 'workspace'].includes(value.kind)) throw fail('请选择有效来源类型');
  const source = { kind: value.kind };
  for (const key of ['name', 'documentName', 'presetId', 'note', 'session']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 1000) throw fail('来源文字过长或格式错误');
      source[key] = value[key];
    }
  }
  if (value.docId !== undefined) {
    if (!Number.isInteger(value.docId)) throw fail('文档 ID 无效');
    source.docId = value.docId;
  }
  // A source URL is descriptive only: never fetched by the helper.
  if (value.url) {
    if (typeof value.url !== 'string' || value.url.length > 2000 || !/^https?:\/\//.test(value.url)) throw fail('来源链接必须为 HTTP(S)');
    source.url = value.url;
  }
  return source;
}
async function pin(uploadId) {
  const src = useUpload(uploadId);
  if (!src) throw fail('上传已失效，请重新选择图片');
  if (fs.statSync(src).size > 32 * 1024 * 1024) throw fail('单张图片不能超过 32 MB');
  // Decode all pixels, not merely the magic bytes; do not retain SVG, animation,
  // metadata or untrusted filename extensions. Library files are always PNG.
  const input = fs.readFileSync(src);
  const meta = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata();
  if (!['png', 'jpeg', 'webp', 'gif', 'tiff', 'avif', 'heif'].includes(meta.format) || (meta.pages || 1) > 1) throw fail('仅支持静态位图参考图');
  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' }).rotate().png().toBuffer({ resolveWithObject: true });
  const imageId = crypto.createHash('sha256').update(data).digest('hex'), file = imagePath(imageId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { imageId, width: info.width, height: info.height, bytes: data.length };
}
function selectedReferences(state, ids, max = 200) {
  if (!Array.isArray(ids) || !ids.length || ids.length > max || new Set(ids).size !== ids.length) throw fail(`请选择 1–${max} 张不同的参考图`);
  return ids.map(id => {
    const r = state.references.find(r => r.id === id);
    if (!r) throw fail('参考图不存在', 404);
    return r;
  });
}
function validBoard(board, state) {
  if (!board || !Array.isArray(board.hotspots) || board.hotspots.length > 200) throw fail('剪影最多支持 200 个区域');
  const imageId = board.imageId ?? null;
  if (imageId !== null && imageId !== state.board.imageId && !state.references.some(r => r.imageId === imageId)) throw fail('请先上传分类背景图');
  if (imageId !== null && !fs.existsSync(imagePath(imageId))) throw fail('分类背景图文件不存在');
  const cats = new Set(listCategories().categories.map(c => c.id)), ids = new Set();
  const hotspots = board.hotspots.map(h => {
    if (!h || typeof h.id !== 'string' || !/^[\w-]{1,100}$/.test(h.id) || ids.has(h.id)) throw fail('区域 ID 无效或重复');
    ids.add(h.id);
    if (!cats.has(h.category)) throw fail('区域分类不存在');
    const { x, y, width, height, z } = h;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < .02 || height < .02 || x + width > 1.000001 || y + height > 1.000001 || !Number.isInteger(z) || z < 0 || z > 1000) throw fail('区域位置、大小或层级无效');
    if (h.visible !== undefined && typeof h.visible !== 'boolean') throw fail('区域可见性无效');
    return { id: h.id, category: h.category, x, y, width, height, z, visible: h.visible !== false };
  });
  return { imageId, hotspots };
}

// Mutations serialize across asynchronous image decoding. The revision check is
// repeated inside this queue, so simultaneous uploads cannot lose each other.
let queue = Promise.resolve();
export function libraryRoutes(method, parts, body = {}) {
  if (!Array.isArray(parts) || parts[0] !== 'library') return Promise.resolve(null);
  const execute = () => route(method, parts, body);
  if (method !== 'POST') return execute();
  const result = queue.then(execute);
  queue = result.catch(() => {});
  return result;
}
export const routeLibrary = libraryRoutes;

async function route(method, parts, body) {
  const op = parts[1];
  if (method === 'GET') {
    if (parts.length === 1) return view(read());
    if (op === 'categories' && parts.length === 2) return listCategories();
    if (op === 'fields' && parts.length === 3) return getFieldHistory(parts[2]);
    if (op === 'images' && parts.length === 3) {
      const state = read(), id = parts[2];
      if (state.board.imageId !== id && !state.references.some(r => r.imageId === id)) throw fail('图库图片不存在', 404);
      return { buffer: fs.readFileSync(imagePath(id)), type: 'image/png' };
    }
    return null;
  }
  if (method !== 'POST' || parts.length !== 2) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求内容格式错误');
  if (op === 'categories') return saveCategory(body);
  if (op === 'move-presets') return bulkMovePresets(body);
  if (op === 'fields') {
    const applied = applyPresetFields(body.id, body);
    const history = recordFieldHistory(body);
    return { ...applied, history };
  }
  if (!['add', 'update', 'delete', 'reorder', 'board', 'uploads', 'attach-preset'].includes(op)) return null;
  const state = read();
  checkRevision(state, body.expectedRevision);
  if (op === 'add') {
    if (state.references.length >= 5000) throw fail('图库最多保存 5000 张参考图');
    const name = label(body.name, '参考图'), source = sourceInfo(body.source || { kind: 'file', name });
    const pinned = await pin(body.uploadId);
    // Files are durably written before the metadata points at them. If a write
    // fails, an unreferenced image may remain; referenced files are never lost.
    state.references.push({ id: crypto.randomUUID(), name, ...pinned, source, createdAt: Date.now() });
    return write(state);
  }
  if (op === 'update') {
    const [r] = selectedReferences(state, [body.id]);
    r.name = label(body.name, r.name);
    if (body.source !== undefined) r.source = sourceInfo(body.source);
    return write(state);
  }
  if (op === 'delete') {
    selectedReferences(state, body.ids);
    state.references = state.references.filter(r => !body.ids.includes(r.id));
    // Keep content-addressed bytes: the board, exported presets or an in-flight
    // reader may still use them. A later explicit storage cleanup can reclaim.
    return write(state);
  }
  if (op === 'reorder') {
    if (!Array.isArray(body.ids) || body.ids.length !== state.references.length) throw fail('重排必须包含图库全部图片');
    state.references = body.ids.length ? selectedReferences(state, body.ids, 5000) : [];
    return write(state);
  }
  if (op === 'board') { state.board = validBoard(body.board, state); return write(state); }
  if (op === 'uploads') {
    return { uploads: selectedReferences(state, body.ids).map(r => ({ uploadId: saveUpload(fs.readFileSync(imagePath(r.imageId)), 'image/png'), name: r.name, width: r.width, height: r.height, source: r.source, libraryId: r.id })) };
  }
  if (op === 'attach-preset') {
    const p = getPreset(body.presetId);
    if (!p || p.revision !== body.expectedPresetRevision) throw fail('预设已变化，请重新打开', 409);
    const refs = selectedReferences(state, body.ids);
    // Embed bytes for existing /presets/:id/refs and portable JSON export. The
    // library ID/source are supplementary; generation never needs library state.
    return { preset: savePreset({ ...p, expectedRevision: p.revision,
      refImages: refs.map(r => fs.readFileSync(imagePath(r.imageId)).toString('base64')),
      referenceSources: refs.map(r => ({ libraryId: r.id, imageId: r.imageId, name: r.name, source: r.source })) }) };
  }
}
