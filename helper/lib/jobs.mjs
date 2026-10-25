// 任务队列：每个平台一条队列，按平台限制同时跑几个（Flow 只能一个：同一项目里并发会认错图块）。
// 任务的 job.json 写在结果文件夹里，helper 重启后会读回来，相当于「检查点」：PS 崩了也能找回结果再贴。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';
import { alignOutput, makeVariant, thumbnail, CC_MODES, CC_VERSION } from './post.mjs';

const jobs = new Map();
const CONCURRENCY = { aistudio: 2, chatgpt: 2, flow: 1, codex: 2, agy: 2, 'gemini-api': 3, 'openai-api': 3 };
const running = new Map(); // provider -> count
const waiting = new Map(); // provider -> [job]

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 插件先把原图 / 参考图以二进制 POST 到 /uploads，再用返回的 uploadId 建任务
const uploads = new Map();
export function saveUpload(buffer, mime) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(config.outputDir, '_uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.${/png/.test(mime || '') ? 'png' : 'jpg'}`);
  fs.writeFileSync(file, buffer);
  uploads.set(id, file);
  return id;
}
// 同一张原图会被同一组的几个任务共用，所以这里复制而不是挪走；_uploads 里的旧文件启动时清理
function useUpload(id) {
  const file = uploads.get(id);
  return file && fs.existsSync(file) ? file : null;
}

export function publicJob(job) {
  const { abort, ...rest } = job;
  return rest;
}

export function listJobs(limit = 200) {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(publicJob);
}

export function getJob(id) {
  return jobs.get(id);
}

function persist(job) {
  try { fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(publicJob(job), null, 2)); } catch {}
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'done' || job.status === 'error') return false;
  job.abort.abort();
  job.status = 'error';
  job.error = '已取消';
  persist(job);
  return true;
}

// 启动时把最近 14 天的任务读回来（检查点）
export function loadHistory() {
  const root = config.outputDir;
  if (!fs.existsSync(root)) return 0;
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  let n = 0;
  for (const day of fs.readdirSync(root)) {
    if (!/^\d{8}$/.test(day)) continue;
    const dayDir = path.join(root, day);
    for (const id of fs.readdirSync(dayDir)) {
      const file = path.join(dayDir, id, 'job.json');
      if (!fs.existsSync(file)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!j.id || j.createdAt < cutoff || jobs.has(j.id)) continue;
        if (j.status === 'queued' || j.status === 'running') { j.status = 'error'; j.error = 'helper 重启，任务中断'; }
        j.abort = new AbortController();
        j.log = j.log || [];
        jobs.set(j.id, j);
        n++;
      } catch {}
    }
  }
  // _uploads 只是中转，超过一天的清掉
  const up = path.join(root, '_uploads');
  if (fs.existsSync(up)) for (const f of fs.readdirSync(up)) {
    const p = path.join(up, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p); } catch {}
  }
  return n;
}

// 完成提示音：macOS 用系统的 Glass，Windows 用系统通知音
const ding = () => {
  if (process.platform === 'darwin') execFile('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  else if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer "$env:WINDIR\\Media\\Windows Notify System Generic.wav").PlaySync()`], { windowsHide: true }, () => {});
};

/**
 * params: { provider, model, prompt, aspect, resolution, thinking, uploadId, refUploadIds[], fromJobId, fallbacks[], post: {align, cc}, sound, groupId, meta }
 * fromJobId：「重新生成」时沿用那个任务的原图和参考图
 */
export function createJob(params, providers, capabilities) {
  if (!providers[params.provider]) throw new Error(`未知平台：${params.provider}`);
  if (!params.prompt || !params.prompt.trim()) throw new Error('提示词不能为空');

  const id = `${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(config.outputDir, id.slice(0, 8), id);
  fs.mkdirSync(dir, { recursive: true });

  const from = params.fromJobId ? jobs.get(params.fromJobId) : null;
  if (params.fromJobId && !from) throw new Error('原任务找不到了');
  let inputPath = null;
  if (from?.inputPath && fs.existsSync(from.inputPath)) {
    inputPath = path.join(dir, path.basename(from.inputPath));
    fs.copyFileSync(from.inputPath, inputPath);
  } else if (params.uploadId) {
    const src = useUpload(params.uploadId);
    if (!src) throw new Error('上传的原图找不到了，请重新生成');
    inputPath = path.join(dir, `input${path.extname(src)}`);
    fs.copyFileSync(src, inputPath);
  }
  const refPaths = [];
  for (const p of from?.refPaths || []) {
    if (!fs.existsSync(p)) continue;
    const dest = path.join(dir, path.basename(p));
    fs.copyFileSync(p, dest);
    refPaths.push(dest);
  }
  for (const [i, rid] of (params.refUploadIds || []).entries()) {
    const src = useUpload(rid);
    if (!src) continue;
    const p = path.join(dir, `ref${i + 1}${path.extname(src)}`);
    fs.copyFileSync(src, p);
    refPaths.push(p);
  }

  const job = {
    id,
    groupId: params.groupId || id,
    provider: params.provider,
    model: params.model || '',
    prompt: params.prompt.trim(),
    aspect: params.aspect || '1:1',
    resolution: params.resolution || '2K',
    thinking: params.thinking || 'High',
    fallbacks: (params.fallbacks || []).filter((p) => p !== params.provider && providers[p]),
    post: { align: params.post?.align !== false, cc: CC_MODES.includes(params.post?.cc) ? params.post.cc : 'none' },
    sound: Boolean(params.sound),
    meta: params.meta || {},
    dir,
    inputPath,
    refPaths,
    status: 'queued',
    stage: '排队中',
    log: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    abort: new AbortController(),
  };
  jobs.set(id, job);
  persist(job);
  enqueue(job, providers, capabilities);
  return job;
}

function enqueue(job, providers, capabilities) {
  const q = waiting.get(job.provider) || [];
  q.push(job);
  waiting.set(job.provider, q);
  pump(job.provider, providers, capabilities);
}

function pump(provider, providers, capabilities) {
  const q = waiting.get(provider) || [];
  while (q.length && (running.get(provider) || 0) < (CONCURRENCY[provider] || 1)) {
    const job = q.shift();
    if (job.status === 'error') continue; // 排队时被取消
    running.set(provider, (running.get(provider) || 0) + 1);
    run(job, providers, capabilities).finally(() => {
      running.set(provider, running.get(provider) - 1);
      pump(provider, providers, capabilities);
    });
  }
}

async function run(job, providers, capabilities) {
  const log = (msg) => {
    job.stage = msg;
    job.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`);
    console.log(`[${job.id}] ${msg}`);
  };
  job.status = 'running';
  job.startedAt = Date.now();
  try {
    log(`开始：${job.provider}`);
    const out = await providers[job.provider].run(job, { log, signal: job.abort.signal });
    if (job.abort.signal.aborted) throw new Error('已取消');
    job.result = { path: out.path, width: out.width, height: out.height, bytes: fs.statSync(out.path).size, source: out.source || job.provider, provider: job.provider };
    await postProcess(job, log);
    job.status = 'done';
    log(`完成：${out.width}×${out.height}`);
    if (job.sound) ding();
  } catch (e) {
    const msg = e?.message || String(e);
    // 失败自动换平台：只换到支持同一比例的平台，否则贴回位置会对不上
    const next = !job.abort.signal.aborted && job.fallbacks.find((p) => (capabilities[p]?.aspects || []).includes(job.aspect));
    if (next) {
      log(`${job.provider} 失败（${msg.split('\n')[0]}），换到 ${next}`);
      job.fallbacks = job.fallbacks.filter((p) => p !== next);
      const res = capabilities[next]?.resolutions;
      if (res && !res.includes(job.resolution)) job.resolution = res[res.length - 1];
      job.provider = next;
      job.status = 'queued';
      persist(job);
      enqueue(job, providers, capabilities);
      return;
    }
    job.status = 'error';
    job.error = msg;
    log(`失败：${msg}`);
  } finally {
    if (job.status !== 'queued') job.finishedAt = Date.now();
    persist(job);
  }
}

async function postProcess(job, log) {
  const r = job.result;
  try { r.thumb = await thumbnail(r.path, path.join(job.dir, 'thumb.jpg')); } catch {}
  r.base = r.path;
  r.align = { applied: false };
  r.variants = {};
  if (!job.inputPath) return;
  if (job.post.align) {
    try {
      const a = await alignOutput(job.inputPath, r.path, job.meta.focus || null, path.join(job.dir, 'aligned.png'));
      r.align = { applied: a.applied, scale: a.scale, shift: a.shift, localTiles: a.localTiles };
      if (a.applied) {
        r.base = a.path;
        const parts = [];
        if (a.scale && (a.scale !== 1 || a.shift.x || a.shift.y)) parts.push(`整体缩放 ${(a.scale * 100).toFixed(1)}%，偏移 ${(a.shift.x * 100).toFixed(1)}% / ${(a.shift.y * 100).toFixed(1)}%`);
        if (a.localTiles) parts.push(`分块微调 ${a.localTiles} 块`);
        log(`快速对齐：${parts.join('，')}`);
      } else {
        log('快速对齐：回图本身就对齐，不用动');
      }
    } catch (e) { log(`对齐失败，按原图贴：${e.message}`); }
  }
  if (job.post.cc !== 'none') {
    try { await variantPath(job, { cc: job.post.cc, tex: false, t: 1 }); log(`校色：${CC_NAMES[job.post.cc]}`); } catch (e) { log(`校色失败：${e.message}`); }
  }
}

// 早期的任务没有缩略图：要的时候补做一张
export async function ensureThumb(job) {
  const r = job.result;
  if (!r) return null;
  if (r.thumb && fs.existsSync(r.thumb)) return r.thumb;
  if (!r.path || !fs.existsSync(r.path)) return null;
  r.thumb = await thumbnail(r.path, path.join(job.dir, 'thumb.jpg'));
  persist(job);
  return r.thumb;
}

export const CC_NAMES = { none: '不校色', global: '全局校色', precise: '精准校色', mixed: '混合校色' };

// 某个版本（校色 × 替换纹理 × 强度）按需算一次，缓存在任务文件夹里
export async function variantPath(job, { cc = 'none', tex = false, t = 1 }) {
  const r = job.result;
  if (!r) throw new Error('还没有结果');
  if (!CC_MODES.includes(cc)) throw new Error(`没有这种校色：${cc}`);
  const base = r.base && fs.existsSync(r.base) ? r.base : r.path;
  t = Math.round(Math.min(1, Math.max(0, t)) * 20) / 20; // 5% 一档
  if (!job.inputPath || (cc === 'none' && !tex && t === 1)) return base;
  r.variants = r.variants || {};
  const key = `${cc}${CC_VERSION[cc] ? `${CC_VERSION[cc]}` : ''}${tex ? '-tex' : ''}${t < 1 ? `-t${Math.round(t * 100)}` : ''}`;
  if (r.variants[key] && fs.existsSync(r.variants[key])) return r.variants[key];
  const out = await makeVariant({ inputPath: job.inputPath, basePath: base, cc, tex, t, outPath: path.join(job.dir, `v-${key}.png`) });
  r.variants[key] = out;
  persist(job);
  return out;
}
