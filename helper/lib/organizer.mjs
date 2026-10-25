// P6 integration: createOrganizer({ bridge }).route(method, parts, body, query).
// Mount at /organizer; parts may include the prefix. Pass URL.searchParams as query.
// No timers, provider submissions, native IPC, or changes to source images.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from './paths.mjs';
import { config } from './config.mjs';
import { atomicJson, readJson, recordId } from './store.mjs';
import { parseShortcut } from './shortcuts.mjs';
import { CATEGORIES } from './presets.mjs';
import { listJobs, getJob, createLocalResult, persist, normalizeVariant, variantPath, appliedVariant } from './jobs.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_PACK = 40 * 1024 * 1024; // serialized JSON, including base64 and manifest overhead
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const DEFAULT_LAYOUT = { schemaVersion: 1, mode: 'full', theme: 'dark', zoom: 1, opacity: 1 };
const HELP = [
  ['history', '历史与版本', '按项目、原图和提示词筛选全部本地历史。选择原始生成、已应用或已存版本，再复制提示词、归档或恢复为新结果。费用没有提供方来源时显示未记录。'],
  ['checkpoints', '检查点恢复', '检查点来自 Photoshop 整张画布 PNG。浏览后恢复会创建新的本地结果，不覆盖文件，不自动贴回当前文档。'],
  ['projects', '项目与日程', '项目复用工具页的数据。关联历史任务及文档、设置日期、延后及完成状态；提醒需要桌面端通知接口与权限。'],
  ['backup', '备份与回滚', '备份包含用户预设、项目、布局、书签及历史关联；排除登录、浏览器、密钥、连接配置及生成图。先预检文件与 SHA-256，再确认导入。导入失败自动回滚，成功后可手动回滚；预设及快捷键缓存需在任务空闲后重启本机服务刷新。'],
  ['cache', '预览回收站', '仅回收工具预览，不回收生成原图、结果、检查点或运行任务引用的文件。清理前重新检查活动引用；回收站可恢复，未提供永久删除。'],
  ['eagle', 'Eagle 归档', '先启动 Eagle，检测官方本地 API。预览所选结果及标签后明确归档。原文件保留。网络超时可能已经导入，请在 Eagle 核对后再操作。'],
  ['layout', '布局和快捷键', '布局由 helper 持久保存。应用前台且不在输入框时：Cmd/Ctrl+Shift+H 历史、P 项目、L 紧凑布局、F 搜索帮助。这些不是系统全局快捷键。'],
  ['diagnostics', '帮助与诊断', '连接失败先检查 helper、平台和 PS 面板。诊断只导出版本、计数、阶段类别与下一步，不导出原图、提示词、文件路径、原始错误、浏览器或凭证。'],
];

function relativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f:]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('路径无效');
  return value;
}
// The configured root is trusted. macOS aliases such as /var -> /private/var
// are resolved here; only components *inside* that root must be symlink-free.
function canonicalRoot(root) {
  let ancestor = path.resolve(root);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    // A dangling link is not a missing directory that we may create through.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('根目录符号链接无效'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('根目录不存在');
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}
export function safePath(root, relative, { missing = false } = {}) {
  relativeName(relative);
  let current = canonicalRoot(root);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('路径不允许符号链接'); }
    catch (e) { if (e.code !== 'ENOENT' || !missing) throw e; }
  }
  return current;
}
function walk(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const dir = prefix ? safePath(root, prefix) : root;
  if (fs.lstatSync(dir).isSymbolicLink()) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return walk(root, rel);
    return e.isFile() ? [rel] : [];
  });
}
const secretKey = /(?:^key$|^auth$|api.?key|secret|token|password|authorization|cookie|credential|session|chrome|browser|headers|private.?key)/i;
function redactString(value) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/(?:Bearer\s+)[\w.+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{15,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|client[_-]?secret|token|password|secret|authorization)["']?\s*[=:]\s*["']?)[^\s,;"'&]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/g, raw => { try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; } catch { return '[URL]'; } });
}
export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !secretKey.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k)).map(([k,v]) => [k, redact(v)]));
  return value;
}
function layout(value) {
  if (!value || !['full','compact'].includes(value.mode) || !['dark','light','system'].includes(value.theme) || !Number.isFinite(value.zoom) || value.zoom < .75 || value.zoom > 1.5 || !Number.isFinite(value.opacity) || value.opacity < .5 || value.opacity > 1) throw new Error('布局参数无效');
  return { schemaVersion: 1, mode: value.mode, theme: value.theme, zoom: value.zoom, opacity: value.opacity };
}
function httpsUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('书签只允许不含凭证的 HTTPS URL');
  return u.href;
}
function page(items, query) {
  const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 24);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页参数无效');
  return { items: items.slice(offset, offset + limit), offset, limit, total: items.length, hasMore: offset + limit < items.length };
}
function date(value) {
  if (!value) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) !== value) throw new Error('日期无效');
  return value;
}
function backupAllowed(name) {
  relativeName(name);
  if(name.startsWith('presets/.field-history/'))return /^presets\/\.field-history\/[a-f0-9]{64}\.json$/.test(name);
  if(name.startsWith('library/'))return /^library\/(?:library\.json|images\/[a-f0-9]{64}\.png)$/.test(name);
  // Explicit roots; runtime/config/browser state can never enter a pack.
  return /^(?:(?:prefs|shortcuts|shared-settings)\.json|organizer\/(?:layout|bookmarks|history-links)\.json|workbench\/projects\/[\w-]+\.json|presets\/(?:[\w.-]+\/)*[\w .\-\u0080-\uffff]+\.(?:json|md|txt))$/u.test(name)
    && !name.split('/').some(x => secretKey.test(x) || /^\.(?!revisions$|trash$)/.test(x));
}
function documentLinks(documents) {
  if(!Array.isArray(documents)||documents.length>100)throw new Error('项目文档关联格式无效');
  return documents.map(d=>{
    if(!d||typeof d.name!=='string'||d.name.length>250)throw new Error('文档名称无效');
    if(d.docId===undefined){if(typeof d.id!=='string'||d.id.length>100)throw new Error('旧文档关联无效');return {id:d.id,name:d.name};}
    if(!Number.isSafeInteger(d.docId)||d.docId<1||typeof d.session!=='string'||!/^ps-[\w-]{1,190}$/.test(d.session))throw new Error('文档会话或 ID 无效');
    return {id:String(d.docId),docId:d.docId,session:d.session,name:d.name};
  });
}
function sanitizeBackup(name,value){
  const clean=redact(value);
  // A Photoshop document session is a binding identifier, not an auth session.
  // Preserve only this narrowly typed location, never arbitrary session fields.
  const documentSession=value=>typeof value==='string'&&/^ps-[\w-]{1,190}$/.test(value);
  if(name==='library/library.json'&&Array.isArray(value?.references))for(let i=0;i<value.references.length;i++){
    const source=value.references[i]?.source;if(documentSession(source?.session)&&clean.references[i]?.source)clean.references[i].source.session=source.session;
  }
  if(name.startsWith('workbench/projects/')&&Array.isArray(value?.documents))for(let i=0;i<value.documents.length;i++)if(documentSession(value.documents[i]?.session))clean.documents[i].session=value.documents[i].session;
  return clean;
}
function objectKeys(value,allowed,message){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error(message);}
function validateFieldHistory(value){
  const bad='预设字段历史格式无效';objectKeys(value,['schemaVersion','revision','entries'],bad);
  if(value.schemaVersion!==1||!Number.isInteger(value.revision)||value.revision<0||!Array.isArray(value.entries)||value.entries.length>30)throw new Error(bad);
  const ids=new Set();for(const entry of value.entries){
    objectKeys(entry,['id','usedAt','presetRevision','params','fills'],bad);recordId(entry.id);if(ids.has(entry.id))throw new Error(bad);ids.add(entry.id);
    if(!Number.isFinite(entry.usedAt)||entry.usedAt<0||!Number.isInteger(entry.presetRevision)||entry.presetRevision<1)throw new Error(bad);
    for(const key of ['params','fills']){
      const fields=entry[key];if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).length>200)throw new Error(bad);
      for(const [name,value] of Object.entries(fields))if(!name||name.length>200||(key==='params'?!Number.isFinite(value):typeof value!=='string'||value.length>4000||value.includes('】')))throw new Error(bad);
    }
  }
}
async function validateLibraryPack(files){
  const images=new Map();
  for(const f of files.filter(f=>f.path.startsWith('library/images/'))){
    const id=path.basename(f.path,'.png');
    if(hash(f.buffer)!==id||f.buffer.length>32*1024*1024)throw new Error('图库 PNG 文件名与哈希不符');
    const input=sharp(f.buffer,{limitInputPixels:40_000_000,failOn:'warning'}),meta=await input.metadata();
    if(meta.format!=='png'||(meta.pages||1)!==1||meta.exif||meta.xmp||meta.iptc||meta.icc||meta.comments?.length)throw new Error('图库必须是无附加元数据的静态 PNG');
    // Full decode rejects truncated/corrupt pixel streams even if a manifest hash
    // was recomputed by a broken or malicious pack producer.
    await input.raw().toBuffer();images.set(id,{width:meta.width,height:meta.height,bytes:f.buffer.length});
  }
  const metadata=files.find(f=>f.path==='library/library.json');
  if(!metadata){if(images.size)throw new Error('图库图片缺少 library.json');return;}
  const value=JSON.parse(metadata.buffer),bad='图库备份结构无效';objectKeys(value,['schemaVersion','revision','references','board'],bad);
  if(value.schemaVersion!==1||!Number.isInteger(value.revision)||value.revision<0||!Array.isArray(value.references)||value.references.length>5000)throw new Error(bad);
  const ids=new Set();for(const r of value.references){
    objectKeys(r,['id','name','imageId','width','height','bytes','source','createdAt'],bad);recordId(r.id);
    if(ids.has(r.id)||typeof r.name!=='string'||r.name.length>200||!Number.isFinite(r.createdAt)||r.createdAt<0)throw new Error(bad);ids.add(r.id);
    const image=images.get(r.imageId);if(!image||image.width!==r.width||image.height!==r.height||image.bytes!==r.bytes)throw new Error('图库参考缺图或尺寸/字节不符');
    objectKeys(r.source,['kind','name','documentName','presetId','note','session','docId','url'],bad);
    if(!['file','clipboard','screenshot','photoshop','preset','workspace'].includes(r.source.kind))throw new Error(bad);
    for(const key of ['name','documentName','presetId','note','session'])if(r.source[key]!==undefined&&(typeof r.source[key]!=='string'||r.source[key].length>1000))throw new Error(bad);
    if(r.source.docId!==undefined&&!Number.isInteger(r.source.docId))throw new Error(bad);
    if(r.source.url!==undefined){const u=new URL(r.source.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||r.source.url.length>2000)throw new Error(bad);}
  }
  objectKeys(value.board,['imageId','hotspots'],bad);
  if(value.board.imageId!==null&&!images.has(value.board.imageId))throw new Error('图库分类背景图缺失');
  if(!Array.isArray(value.board.hotspots)||value.board.hotspots.length>200)throw new Error(bad);
  const categories=new Set(CATEGORIES.map(c=>c.id)),custom=files.find(f=>f.path==='presets/_categories.json');
  if(custom){const c=JSON.parse(custom.buffer);if(!Array.isArray(c.categories))throw new Error('分类备份无效');for(const x of c.categories){recordId(x.id);categories.add(x.id);}}
  const regions=new Set();for(const h of value.board.hotspots){
    objectKeys(h,['id','category','x','y','width','height','z','visible'],bad);recordId(h.id);
    if(regions.has(h.id)||!categories.has(h.category)||![h.x,h.y,h.width,h.height].every(Number.isFinite)||h.x<0||h.y<0||h.width<.02||h.height<.02||h.x+h.width>1.000001||h.y+h.height>1.000001||!Number.isInteger(h.z)||h.z<0||h.z>1000||typeof h.visible!=='boolean')throw new Error('图库区域数据无效');regions.add(h.id);
  }
}

async function decodePack(pack) {
  if (pack?.format !== 'ps-ai-bridge-user-state' || pack.schemaVersion !== 1 || !Array.isArray(pack.files) || pack.files.length > 10000) throw new Error('备份格式无效');
  if(Buffer.byteLength(JSON.stringify(pack))>MAX_PACK)throw new Error('备份超过 40 MB，未导入任何文件');
  const seen = new Set(); let total = 0;
  const files = pack.files.map(f => {
    if (!backupAllowed(f.path) || seen.has(f.path)) throw new Error('备份路径不允许或重复');
    seen.add(f.path);
    if (typeof f.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content)) throw new Error('备份编码损坏');
    total += Buffer.byteLength(f.content); if (total > MAX_PACK) throw new Error('备份过大');
    const bytes = Buffer.from(f.content, 'base64');
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) throw new Error('备份哈希校验失败');
    const text = bytes.toString('utf8');
    if (f.path.endsWith('.json')) {
      const data = JSON.parse(text);
      if (JSON.stringify(sanitizeBackup(f.path,data)) !== JSON.stringify(data)) throw new Error('备份含凭证或敏感连接信息');
      if (f.path === 'prefs.json' && (typeof data?.closeTabsAfterDone !== 'boolean' || Object.keys(data).some(k=>k!=='closeTabsAfterDone'))) throw new Error('偏好格式无效');
      if (f.path === 'shortcuts.json') { if(typeof data?.enabled !== 'boolean' || Object.keys(data).some(k=>!['enabled','shortcut'].includes(k)))throw new Error('快捷键设置无效');parseShortcut(data.shortcut); }
      if (f.path === 'shared-settings.json') {
        if(data?.schemaVersion!==1 || !Number.isInteger(data.revision) || !data.values || !Array.isArray(data.history))throw new Error('共享设置格式无效');
        const keys=['provider','model','aspect','resolution','thinking','returnAs','groupColor','cc','padding','count','shrink','blur','checkpointMin','keepComposition','fallback','align','sound','tex','autoReturn','maskWithSelection'];
        for(const values of [data.values,...data.history.map(h=>h.values)])if(!values || Object.entries(values).some(([k,v])=>!keys.includes(k)||!['string','boolean','number'].includes(typeof v)))throw new Error('共享设置字段无效');
      }
      if (f.path === 'organizer/layout.json') layout(data);
      if (f.path === 'organizer/bookmarks.json') {
        if (!Array.isArray(data)) throw new Error('书签格式无效');
        for (const b of data) { recordId(b.id); httpsUrl(b.url); }
      }
      if (f.path.startsWith('workbench/projects/')) {
        if (data.id !== path.basename(f.path, '.json') || !data.title || !['todo','working','done','rework','archived'].includes(data.state)) throw new Error('项目格式无效');
        date(data.due);if(data.documents)documentLinks(data.documents);
      }
      if(f.path.startsWith('presets/.field-history/'))validateFieldHistory(data);
      if (f.path === 'organizer/history-links.json' && (!data || Array.isArray(data) || typeof data !== 'object')) throw new Error('历史关联格式无效');
    } else if (!f.path.endsWith('.png') && redactString(text) !== text) throw new Error('备份含敏感文本');
    return { ...f, buffer: bytes };
  });
  const manifest = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  if (pack.manifestHash !== hash(JSON.stringify(manifest))) throw new Error('备份清单校验失败');
  await validateLibraryPack(files);
  return files;
}

export function createOrganizer({ bridge, dataDir = DATA_DIR, outputDir = config.outputDir, fetchImpl = globalThis.fetch, writeJson = atomicJson } = {}) {
  const configuredDataDir=path.resolve(dataDir), configuredOutputDir=path.resolve(outputDir);
  const remap=(file,from,to)=>file===from||file.startsWith(`${from}${path.sep}`)?path.join(to,path.relative(from,file)):file;
  dataDir = canonicalRoot(dataDir);
  outputDir = canonicalRoot(outputDir);
  const outputRelative=file=>path.relative(outputDir,remap(path.resolve(file),configuredOutputDir,outputDir)).split(path.sep).join('/');
  const root = path.join(dataDir, 'organizer');
  const at = (rel, missing = false) => safePath(dataDir, rel, { missing });
  const read = (rel, fallback) => readJson(at(rel, true), fallback);
  const write = (rel, value) => writeJson(at(rel, true), value);
  const tickets = new Map();
  const projects = () => walk(path.join(dataDir, 'workbench', 'projects')).filter(x => /^[\w-]+\.json$/.test(x)).map(x => read(`workbench/projects/${x}`));
  const links = () => read('organizer/history-links.json', {});
  function allJobs() {
    const map = new Map(); const issues = [];
    // Unlike jobs.loadHistory, this intentionally includes records older than 14 days.
    for (const rel of walk(outputDir).filter(x => /^\d{8}\/[\w-]+\/job\.json$/.test(x))) {
      try {
        const j = readJson(safePath(outputDir, rel)); recordId(j.id);
        if (path.basename(path.dirname(rel)) !== j.id) throw new Error('ID mismatch');
        j.dir = path.dirname(safePath(outputDir, rel)); map.set(j.id, j);
      } catch { issues.push({ record: hash(rel).slice(0,12), reason: 'unreadable-record' }); }
    }
    for (const j of listJobs(Number.MAX_SAFE_INTEGER)) { const rel=outputRelative(j.dir);if(rel && !rel.startsWith('../') && !path.isAbsolute(rel))map.set(j.id,j); }
    return { jobs: [...map.values()].sort((a,b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id)), issues };
  }
  const findJob = id => { recordId(id); const j = getJob(id) || allJobs().jobs.find(x => x.id === id); if (!j) throw new Error('任务不存在'); return j; };
  function imagePath(file) {
    if (typeof file !== 'string') throw new Error('图片路径不存在');
    const rel = outputRelative(file);
    const p = safePath(outputDir, rel);
    if (!fs.statSync(p).isFile() || !/\.(png|jpe?g|webp)$/i.test(p)) throw new Error('结果图片路径无效');
    return p;
  }
  async function selected(body) {
    const j = findJob(body.jobId); if (!j.result || !TERMINAL.has(j.status)) throw new Error('请选择已完成的结果');
    imagePath(j.result.path); if (j.result.base) imagePath(j.result.base); if (j.inputPath) imagePath(j.inputPath);
    const rel = outputRelative(j.dir); safePath(outputDir, rel);
    let file;
    if (body.variant === 'raw') file = j.result.path;
    else if (body.variant && body.variant !== 'applied') {
      if (!Object.hasOwn(j.result.variants || {}, body.variant)) throw new Error('结果版本不存在');
      file = j.result.variants[body.variant];
    } else {
      if (j.applied?.path) file = j.applied.path;
      else { for (const p of Object.values(j.result.variants || {})) imagePath(p); file = await variantPath(j, normalizeVariant(appliedVariant(j))); }
    }
    return { job: j, file: imagePath(file) };
  }
  const projectFor = (j, index, ps) => Object.hasOwn(index[j.id] || {}, 'projectId') ? index[j.id].projectId : ps.find(p => p.jobIds?.includes(j.id))?.id || j.meta?.projectId || '';
  function summaries(query) {
    const { jobs, issues } = allJobs(), index = links(), ps = projects();
    const rows = jobs.map(j => ({ id: j.id, groupId: j.groupId, createdAt: j.createdAt, status: j.status,
      title: j.meta?.title || j.prompt?.slice(0,100) || j.id, prompt: j.prompt || '', provider: j.provider, model: j.model,
      originalId: index[j.id]?.originalId || j.meta?.originalId || j.groupId || j.id, projectId: projectFor(j,index,ps),
      document: j.applied?.document || j.meta?.document || null, hasResult: Boolean(j.result), canReveal: Boolean(getJob(j.id)),
      versions: j.result ? ['applied', 'raw', ...Object.keys(j.result.variants || {})] : [],
      cost: j.cost?.source && Number.isFinite(j.cost.amount) ? { amount: j.cost.amount, currency: j.cost.currency || '', source: j.cost.source } : null,
    })).filter(j => (!query.projectId || j.projectId === query.projectId) && (!query.originalId || j.originalId === query.originalId) && (!query.q || `${j.title} ${j.prompt} ${j.id}`.toLowerCase().includes(String(query.q).toLowerCase())));
    return { ...page(rows,query), issues, originals: [...new Set(rows.map(x=>x.originalId))] };
  }
  function checkpoints() {
    const dir = path.join(outputDir, '_checkpoints');
    return walk(dir).filter(x=>/^\d{8}\/[^/]+\.png$/i.test(x)).map(id => {
      const stat = fs.statSync(safePath(dir,id)); return { id, name: path.basename(id), bytes: stat.size, createdAt: stat.mtimeMs };
    }).sort((a,b)=>b.createdAt-a.createdAt || a.id.localeCompare(b.id));
  }
  function checkpoint(id) {
    if (!checkpoints().some(x=>x.id===id)) throw new Error('检查点不存在或路径无效');
    return safePath(path.join(outputDir,'_checkpoints'), id);
  }
  async function previewImage(file) {
    if (fs.statSync(file).size > 8*1024*1024) { const buffer=await sharp(file).resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).png().toBuffer();return {dataUrl:`data:image/png;base64,${buffer.toString('base64')}`}; }
    const ext = path.extname(file).toLowerCase();
    return { dataUrl: `data:image/${ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}` };
  }
  async function backup() {
    const files = [];
    const names=['prefs.json','shortcuts.json','shared-settings.json'].filter(name=>fs.existsSync(at(name,true)));
    for (const dir of ['presets','workbench/projects','organizer','library']) {
      for (const rel of walk(path.join(dataDir,dir))) {
        const name = `${dir}/${rel}`; if (backupAllowed(name)) names.push(name);
      }
    }
    let encodedBytes=0;
    for (const name of names) {
        if(fs.statSync(at(name)).size>MAX_PACK)throw new Error('备份超过 40 MB，未导出部分备份');
        const raw=fs.readFileSync(at(name));
        const bytes=name.endsWith('.png')?raw:Buffer.from(name.endsWith('.json') ? JSON.stringify(sanitizeBackup(name,JSON.parse(raw.toString('utf8')))) : redactString(raw.toString('utf8')));
        encodedBytes+=4*Math.ceil(bytes.length/3);if(encodedBytes>MAX_PACK)throw new Error('备份超过 40 MB，未导出部分备份');
        files.push({ path:name, bytes:bytes.length, sha256:hash(bytes), content:bytes.toString('base64') });
    }
    files.sort((a,b)=>a.path.localeCompare(b.path));
    const pack = { format:'ps-ai-bridge-user-state', schemaVersion:1, createdAt:Date.now(), files,
      manifestHash:hash(JSON.stringify(files.map(({path,bytes,sha256})=>({path,bytes,sha256})))),
      excludes:['credentials','browser profiles','connections/config','generated images','checkpoints','runtime jobs'] };
    await decodePack(pack); return pack;
  }
  const fingerprint = file => fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
  async function preflight(pack) {
    const files = await decodePack(pack);
    const plan = files.map(f => ({ path:f.path, sha256:f.sha256, previous:fingerprint(at(f.path,true)), bytes:f.bytes }));
    const token = crypto.randomUUID(); tickets.set(token, { digest:hash(JSON.stringify(pack)), plan, expires:Date.now()+10*60*1000 });
    for (const [id,t] of tickets) if (t.expires < Date.now()) tickets.delete(id);
    return { token, files:plan, totalBytes:plan.reduce((n,x)=>n+x.bytes,0), excludes:pack.excludes, requiresReload:true,reloadScope:'helper-when-idle' };
  }
  function rollback(id, automatic = false) {
    recordId(id); const rel = `organizer/rollbacks/${id}.json`, journal = read(rel,null);
    if (!journal || !['applying','applied','rollback-failed'].includes(journal.status)) throw new Error('回滚记录不存在或已回滚');
    for (const f of journal.files) {
      if (!backupAllowed(f.path)) throw new Error('回滚路径无效');
      const current = fingerprint(at(f.path,true));
      if (current !== f.after && current !== f.beforeHash) throw new Error('导入后文件已修改，不能覆盖新修改');
    }
    // The journal is written before any import mutation, and survives process interruption.
    for (const f of journal.files) {
      const dest = at(f.path,true);
      if (f.before === null) { if (fs.existsSync(dest)) fs.unlinkSync(dest); }
      else atomicBytes(dest,Buffer.from(f.before,'base64'));
    }
    journal.status = automatic ? 'failed-rolled-back' : 'rolled-back'; journal.finishedAt=Date.now(); atomicJson(at(rel,true),journal);
    return { id, status:journal.status, requiresReload:true,reloadScope:'helper-when-idle' };
  }
  async function importBackup(body) {
    const files=await decodePack(body.pack), ticket=tickets.get(body.token);
    if (!ticket || ticket.expires<Date.now() || ticket.digest!==hash(JSON.stringify(body.pack))) throw new Error('请先重新预检此备份');
    for (const f of ticket.plan) if (fingerprint(at(f.path,true))!==f.previous) throw new Error('预检后文件已变化，请重新预检');
    tickets.delete(body.token);
    const id=crypto.randomUUID(), rel=`organizer/rollbacks/${id}.json`;
    const journal={ id, createdAt:Date.now(), status:'applying', files:files.map(f=>{ const dest=at(f.path,true); return {path:f.path, after:f.path.endsWith('.json')?hash(JSON.stringify(JSON.parse(f.buffer.toString('utf8')),null,2)):f.sha256, beforeHash:fingerprint(dest), before:fs.existsSync(dest)?fs.readFileSync(dest).toString('base64'):null}; }) };
    atomicJson(at(rel,true),journal);
    try {
      for(const f of files) {
        if(f.path.endsWith('.json')) writeJson(at(f.path,true),JSON.parse(f.buffer.toString('utf8')));
        else atomicBytes(at(f.path,true),f.buffer);
        // JSON pretty printing changes bytes: record the exact installed hash immediately.
        journal.files.find(x=>x.path===f.path).after=fingerprint(at(f.path)); atomicJson(at(rel,true),journal);
      }
      journal.status='applied'; atomicJson(at(rel,true),journal);
      return {id,status:'applied',files:files.length,requiresReload:true,reloadScope:'helper-when-idle'};
    } catch(e) {
      try { rollback(id,true); } catch(r) { journal.status='rollback-failed'; atomicJson(at(rel,true),journal); throw new Error(`导入失败且需要手动回滚 ${id}：${r.message}`); }
      throw new Error(`导入失败，已回滚：${e.message}`);
    }
  }
  function activeReferences() {
    const refs=new Set();
    function collect(value) { if(typeof value==='string')refs.add(path.isAbsolute(value)?remap(remap(path.resolve(value),configuredDataDir,dataDir),configuredOutputDir,outputDir):value); else if(value && typeof value==='object')for(const v of Object.values(value))collect(v); }
    for(const j of allJobs().jobs) if(!TERMINAL.has(j.status))collect(j);
    // Paused queues may resume. Their durable inputs are pinned too.
    for(const kind of ['workbench/batches','workbench/runs']) for(const rel of walk(path.join(dataDir,kind)).filter(x=>x.endsWith('.json'))) {
      const r=read(`${kind}/${rel}`,null); if(r && !TERMINAL.has(r.status))collect(r);
    }
    return refs;
  }
  function previewEntries() {
    const refs=activeReferences(), base='workbench/preview-assets';
    return walk(path.join(dataDir,base)).map(rel=> {
      const file=at(`${base}/${rel}`), stat=fs.statSync(file);
      return { id:rel, bytes:stat.size, modifiedAt:stat.mtimeMs, protected:[...refs].some(p=>p===rel.split('/')[0] || p===file || p===path.dirname(file) || p.startsWith(`${path.dirname(file)}${path.sep}`)) };
    });
  }
  function cacheUsage() {
    const previews=previewEntries();
    const bytes=dir=>walk(dir).reduce((n,rel)=>n+fs.statSync(safePath(dir,rel)).size,0);
    return {previews,previewBytes:previews.reduce((n,x)=>n+x.bytes,0),outputBytes:bytes(outputDir),trashBytes:bytes(path.join(root,'trash')),
      scope:'仅工具预览可清理；原图、结果、检查点、上传与队列输入保留'};
  }
  function trashPreview(body) {
    if(!Array.isArray(body.ids)||!body.ids.length)throw new Error('请选择预览文件');
    const entries=previewEntries(), selected=[...new Set(body.ids)].map(id=>{ relativeName(id);const e=entries.find(x=>x.id===id); if(!e||e.protected)throw new Error('预览不存在或被活动任务引用');return e; });
    const id=crypto.randomUUID(), rel=`organizer/trash/${id}/manifest.json`;
    const manifest={id,createdAt:Date.now(),status:'moving',entries:selected}; write(rel,manifest);
    try { for(const e of selected){const dest=at(`organizer/trash/${id}/files/${e.id}`,true);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(at(`workbench/preview-assets/${e.id}`),dest);} manifest.status='trashed';write(rel,manifest); }
    catch(e){manifest.status='interrupted';atomicJson(at(rel),manifest);throw new Error(`回收未完成，可用回收站 ${id} 恢复：${e.message}`);}
    return manifest;
  }
  function restoreTrash(id) {
    recordId(id);const rel=`organizer/trash/${id}/manifest.json`, m=read(rel,null);if(!m || m.status==='restored')throw new Error('回收记录不存在');
    const moving=m.entries.filter(e=>fs.existsSync(at(`organizer/trash/${id}/files/${relativeName(e.id)}`,true)));
    for(const e of moving)if(fs.existsSync(at(`workbench/preview-assets/${e.id}`,true)))throw new Error('原位置已存在新文件，未覆盖');
    for(const e of moving){const dest=at(`workbench/preview-assets/${e.id}`,true);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(at(`organizer/trash/${id}/files/${e.id}`),dest);}
    m.status='restored';write(rel,m);return m;
  }
  // Official primary docs: https://api.eagle.cool/application/info and /item/add-from-path
  async function eagleRequest(endpoint, body) {
    const response=await fetchImpl(`http://127.0.0.1:41595/api/${endpoint}`, { method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(6000),headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined });
    if(!response.ok)throw new Error(`Eagle HTTP ${response.status}`);
    const result=await response.json();if(result.status!=='success')throw new Error('Eagle 未确认成功');return result;
  }
  function projectSave(body) {
    const id=body.id?recordId(body.id):crypto.randomUUID(), old=read(`workbench/projects/${id}.json`,{});
    const next={...old,...body,id,schemaVersion:1,createdAt:old.createdAt||Date.now(),updatedAt:Date.now()};
    if(!String(next.title||'').trim()||!['todo','working','done','rework','archived'].includes(next.state||'todo'))throw new Error('项目名称或状态无效');
    const p={...old,id,schemaVersion:1,title:String(next.title).trim().slice(0,200),notes:String(next.notes||'').slice(0,100000),state:next.state||'todo',due:date(next.due),
      jobIds:[...new Set(next.jobIds||[])].map(recordId).slice(0,10000),documents:documentLinks(next.documents||[]),
      createdAt:next.createdAt,updatedAt:next.updatedAt,reminder:next.reminder===true};
    write(`workbench/projects/${id}.json`,p);return p;
  }
  function diagnostics() {
    const {jobs,issues}=allJobs(), counts={};for(const j of jobs)counts[TERMINAL.has(j.status)?j.status:'active']=(counts[TERMINAL.has(j.status)?j.status:'active']||0)+1;
    const version=rel=>{try{return readJson(new URL(rel,import.meta.url)).version;}catch{return null;}};
    let ps={psOnline:false,commands:false};try{const s=bridge?.status?.();ps={psOnline:!!s?.psOnline,commands:!!s?.commands};}catch{}
    return {schemaVersion:1,createdAt:Date.now(),versions:{helper:version('../package.json'),app:version('../../desktop/package.json'),plugin:version('../../plugin/manifest.json')},
      runtime:{platform:process.platform,arch:process.arch,node:process.versions.node},ps,jobs:counts,unreadableRecords:issues.length,
      failures:jobs.filter(j=>j.status==='error').slice(0,50).map(j=>({id:hash(j.id).slice(0,12),stage:j.result?'placement-or-postprocess':'generation',reason:'job-error',next:j.result?'先检查目标文档与 PS 面板，再单独重试贴回。':'查看本机任务详情及平台状态，核对上游结果后再重试。'})),
      redaction:'Allowlisted metadata only: no prompts, images, paths, document names, raw logs/errors, configuration, browser state, or credentials.'};
  }
  return {
    async route(method, parts, body = {}, query = {}) {
      if(typeof parts==='string') { const u=new URL(parts,'http://localhost');query=u.searchParams;parts=u.pathname.split('/').filter(Boolean); }
      parts=[...parts];if(parts[0]==='organizer')parts.shift();
      const q={...(query instanceof URLSearchParams?Object.fromEntries(query):query),...(method==='GET'?body:{})};
      const key=parts.join('/');
      if(!['GET','POST'].includes(method))throw new Error('不支持的请求方式');
      if(key==='history' && method==='GET')return summaries(q);
      if(key==='history/link' && method==='POST') {
        findJob(body.jobId);const index=links();if(body.projectId&&!projects().some(p=>p.id===body.projectId))throw new Error('项目不存在');
        index[body.jobId]={projectId:body.projectId?recordId(body.projectId):'',originalId:body.originalId?recordId(body.originalId):''};write('organizer/history-links.json',index);return index[body.jobId];
      }
      if(key==='history/preview' && method==='POST') {const {file}=await selected(body);return previewImage(file);}
      if(key==='history/restore' && method==='POST') {
        const {job,file}=await selected(body), j=await createLocalResult({sourcePath:job.inputPath?imagePath(job.inputPath):file,buffer:await sharp(file).png().toBuffer(),title:`恢复 · ${job.meta?.title||job.id}`,parameters:{restoredFrom:job.id,variant:body.variant||'applied'}});
        const live=getJob(j.id);live.meta={...live.meta,restoredFrom:job.id,originalId:links()[job.id]?.originalId||job.meta?.originalId||job.groupId||job.id,projectId:projectFor(job,links(),projects())};persist(live);return {jobId:j.id};
      }
      if(key==='checkpoints' && method==='GET')return page(checkpoints(),q);
      if(key==='checkpoints/preview' && method==='POST')return previewImage(checkpoint(body.id));
      if(key==='checkpoints/restore' && method==='POST'){const file=checkpoint(body.id);const j=await createLocalResult({sourcePath:file,buffer:fs.readFileSync(file),title:`检查点恢复 · ${path.basename(file)}`,parameters:{checkpointId:body.id}});return {jobId:j.id};}
      if(key==='projects' && method==='GET')return {projects:projects().sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'))};
      if(key==='projects' && method==='POST')return projectSave(body);
      if(key==='projects/delay' && method==='POST') {const p=projects().find(x=>x.id===recordId(body.id));if(!p)throw new Error('项目不存在');const days=Number(body.days);if(!Number.isInteger(days)||days<1||days>365)throw new Error('延后天数应为 1–365');const d=new Date(`${date(p.due||body.today)}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return projectSave({...p,due:d.toISOString().slice(0,10)});}
      if(key==='calendar' && method==='GET') {const today=date(q.today||new Date().toISOString().slice(0,10));return {items:projects().filter(p=>p.due&&!['done','archived'].includes(p.state)).map(p=>({...p,overdue:p.due<today,dueToday:p.due===today}))};}
      if(key==='layout') {if(method==='GET')return read('organizer/layout.json',DEFAULT_LAYOUT);const next=layout(body);write('organizer/layout.json',next);return next;}
      if(key==='bookmarks' && method==='GET')return {items:read('organizer/bookmarks.json',[])};
      if(key==='bookmarks' && method==='POST') {const items=read('organizer/bookmarks.json',[]),id=body.id?recordId(body.id):crypto.randomUUID(),entry={id,title:String(body.title||body.url).slice(0,200),url:httpsUrl(body.url)};const next=items.filter(x=>x.id!==id);next.push(entry);write('organizer/bookmarks.json',next);return entry;}
      if(key==='bookmarks/delete' && method==='POST'){const id=recordId(body.id);write('organizer/bookmarks.json',read('organizer/bookmarks.json',[]).filter(x=>x.id!==id));return {ok:true};}
      if(key==='backup/export' && method==='POST')return backup();
      if(key==='backup/preflight' && method==='POST')return preflight(body.pack);
      if(key==='backup/import' && method==='POST')return importBackup(body);
      if(key==='backup/rollback' && method==='POST')return rollback(body.id);
      if(key==='backup/rollbacks' && method==='GET')return {items:walk(path.join(root,'rollbacks')).filter(x=>/^[\w-]+\.json$/.test(x)).map(x=>{const r=read(`organizer/rollbacks/${x}`);return {id:r.id,status:r.status,createdAt:r.createdAt,files:r.files.length};})};
      if(key==='cache' && method==='GET')return cacheUsage();
      if(key==='cache/trash' && method==='POST')return trashPreview(body);
      if(key==='cache/restore' && method==='POST')return restoreTrash(body.id);
      if(key==='cache/trash' && method==='GET')return {items:walk(path.join(root,'trash')).filter(x=>/^[\w-]+\/manifest\.json$/.test(x)).map(x=>read(`organizer/trash/${x}`))};
      if(key==='eagle/detect' && method==='GET') {try{const r=await eagleRequest('application/info');return {available:true,version:String(r.data?.version||''),api:'official-v1',checkedAt:Date.now()};}catch{return {available:false,checkedAt:Date.now(),next:'启动 Eagle 后重试；检测只读取官方本地 API，不安装或启动应用。'};}}
      if(key==='eagle/archive' && method==='POST') {
        if(body.confirm!==true)throw new Error('请预览标签并明确确认归档');
        if(!Array.isArray(body.tags)||body.tags.length>50||body.tags.some(t=>typeof t!=='string'||t.length>100))throw new Error('标签无效');
        const {job,file}=await selected(body), before=hash(fs.readFileSync(file));
        let result;try{result=await eagleRequest('item/addFromPath',{path:file,name:String(body.name||job.meta?.title||job.id).slice(0,200),tags:[...new Set(body.tags.map(t=>t.trim()).filter(Boolean))]});}catch{throw new Error('Eagle 未确认归档结果；请先在 Eagle 核对，避免重复归档。');}
        return {status:result.status,jobId:job.id,originalPreserved:fs.existsSync(file)&&hash(fs.readFileSync(file))===before};
      }
      if(key==='help' && method==='GET')return {items:HELP.filter(row=>!q.q||row.join(' ').toLowerCase().includes(String(q.q).toLowerCase())).map(([id,title,text])=>({id,title,text}))};
      if(key==='diagnostics' && method==='GET')return diagnostics();
      return undefined;
    },
  };
}
function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=`${file}.${crypto.randomUUID()}.tmp`;
  try {fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
