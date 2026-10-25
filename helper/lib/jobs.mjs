// 任务队列：每个平台一条队列，按平台限制同时跑几个（Flow 只能一个：同一项目里并发会认错图块）。
// 任务的 job.json 写在结果文件夹里，helper 重启后会读回来，相当于「检查点」：PS 崩了也能找回结果再贴。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';
import { atomicJson } from './store.mjs';
import { alignOutput, makeVariant, thumbnail, CC_MODES, CC_VERSION, TEX_VERSION } from './post.mjs';

const jobs = new Map();
const operations = new Map(); // In-flight selection/recovery; never serialized.
export const CANDIDATE_LIMITS = Object.freeze({ count: 16, imageBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, pixels: 64 * 1024 * 1024 });
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
export function useUpload(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null;
  const file = uploads.get(id) || ['png', 'jpg'].map(ext => path.join(config.outputDir, '_uploads', `${id}.${ext}`)).find(fs.existsSync);
  return file && fs.existsSync(file) ? file : null;
}

export function publicJob(job) {
  const { abort, ...rest } = job;
  // Older RH checkpoints included signed download URLs. Do not expose or re-persist them.
  if (rest.upstream?.kind === 'runninghub' && rest.upstream.outputs) {
    rest.upstream = { ...rest.upstream, outputs: rest.upstream.outputs.map(({ nodeId, fileType }) => ({ nodeId, fileType })) };
  }
  return rest;
}

export function listJobs(limit = 200) {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(publicJob);
}

export function getJob(id) {
  return jobs.get(id);
}

export function persist(job) {
  atomicJson(path.join(job.dir, 'job.json'), publicJob(job));
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'done' || job.status === 'error') return false;
  job.abort?.abort();
  job.cancelledAt = Date.now();
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
        if (!j.id || jobs.has(j.id)) continue;
        if (j.createdAt < cutoff && !['queued', 'running', 'submitting', 'processing', 'recovering', 'awaiting-selection'].includes(j.status) && !(j.status === 'error' && j.upstream)) continue;
        if (['queued', 'running', 'submitting', 'processing', 'recovering'].includes(j.status)) {
          if (j.candidatesReady && j.candidates?.length > 1 && !j.cancelledAt) {
            j.status = 'awaiting-selection'; j.result = null;
            j.stage = j.selectedCandidateId ? '已保存选择，请继续处理所选图片' : '请选择候选图';
          } else {
            j.status = 'error';
            j.error = j.upstream ? 'helper 重启；请恢复已有任务或按上游记录人工核对，未重新提交' : 'helper 重启，任务中断';
          }
          j.finishedAt = null;
        }
        j.abort = new AbortController();
        j.log = j.log || [];
        jobs.set(j.id, j);
        persist(j);
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

// Result-specific system sounds, controlled by the existing per-job sound toggle.
const ding = (kind = 'done') => {
  const sounds = {done:['Glass','Asterisk'],error:['Basso','Hand'],review:['Tink','Exclamation']};
  const [mac,win] = sounds[kind] || sounds.done;
  if (process.platform === 'darwin') execFile('/usr/bin/afplay', [`/System/Library/Sounds/${mac}.aiff`], () => {});
  else if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `[System.Media.SystemSounds]::${win}.Play()`], {windowsHide:true}, () => {});
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
  providers[params.provider].prepare?.(job);
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
  while (q.length && (running.get(provider) || 0) < (Number.isInteger(providers[provider]?.concurrency) ? Math.max(1,Math.min(4,providers[provider].concurrency)) : (CONCURRENCY[provider] || 1))) {
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
    await acceptOutput(job, out, log);
  } catch (e) {
    const msg = e?.message || String(e);
    // 失败自动换平台：只换到支持同一比例的平台，否则贴回位置会对不上
    const next = !job.abort.signal.aborted && !job.upstream && job.fallbacks.find((p) => (capabilities[p]?.aspects || []).includes(job.aspect));
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
    if(job.sound && !job.abort.signal.aborted)ding('error');
  } finally {
    if (['done', 'error'].includes(job.status)) job.finishedAt = Date.now();
    persist(job);
  }
}

// Read streams with both declared and actual byte limits (including chunked responses).
export async function boundedImageBody(response, signal, remaining = CANDIDATE_LIMITS.imageBytes) {
  const limit = Math.min(CANDIDATE_LIMITS.imageBytes, remaining);
  if (!response.ok) { await response.body?.cancel(); throw new Error('候选图下载失败，请恢复已有任务'); }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new Error('候选图下载超过大小限制');
  }
  if (!response.body) throw new Error('候选图没有内容');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  const stop = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('候选图下载超过大小限制');
      chunks.push(value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, bytes);
  } finally { signal.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// The provider supplies descriptors in stable upstream order. URLs stay only in memory.
export async function downloadCandidates(job, descriptors, fetchImage, { signal, source }) {
  if (!descriptors.length) throw new Error('指定输出节点没有图像');
  const selected = descriptors.slice(0, CANDIDATE_LIMITS.count);
  job.candidates ||= [];
  job.candidateCount = descriptors.length;
  job.candidateLimit = CANDIDATE_LIMITS.count;
  job.candidatesTruncated = descriptors.length > selected.length;
  job.candidatesReady = false;
  let total = 0;
  for (const [index, descriptor] of selected.entries()) {
    signal.throwIfAborted();
    const id = `candidate-${index + 1}`;
    const existing = job.candidates.find(c => c.id === id);
    if (existing && fs.existsSync(existing.path)) {
      total += Math.max(existing.downloadBytes || 0, existing.bytes || 0);
      if (total > CANDIDATE_LIMITS.totalBytes) throw new Error('候选图总大小超过限制');
      continue;
    }
    const buffer = await boundedImageBody(await fetchImage(descriptor), signal, CANDIDATE_LIMITS.totalBytes - total);
    const output = path.join(job.dir, `${id}.png`), temporary = `${output}.partial`;
    try {
      const info = await sharp(buffer, { limitInputPixels: CANDIDATE_LIMITS.pixels }).png().toFile(temporary);
      signal.throwIfAborted();
      if (info.size > CANDIDATE_LIMITS.imageBytes || total + Math.max(info.size, buffer.length) > CANDIDATE_LIMITS.totalBytes) throw new Error('候选图解码后超过大小限制');
      fs.renameSync(temporary, output);
      const candidate = { id, index, path: output, width: info.width, height: info.height, bytes: info.size, downloadBytes: buffer.length, source, provider: job.provider };
      job.candidates = [...job.candidates.filter(c => c.id !== id), candidate].sort((a, b) => a.index - b.index);
      total += Math.max(info.size, buffer.length);
      persist(job); // Each fully written image is independently recoverable.
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  signal.throwIfAborted();
  job.candidates = job.candidates.filter(c => c.index < selected.length);
  job.candidatesReady = true;
  job.upstream.state = 'downloaded';
  persist(job);
  return descriptors.length > 1 ? { candidates: job.candidates } : job.candidates[0];
}

async function acceptOutput(job, out, log) {
  job.abort.signal.throwIfAborted();
  if (out.candidates) {
    if (out.candidates.length < 2) throw new Error('候选结果不完整');
    job.result = null;
    job.candidates = out.candidates;
    job.candidatesReady = true;
    job.status = 'awaiting-selection';
    job.finishedAt = null;
    log(`已下载 ${out.candidates.length} 张候选图，请明确选择后继续`);
    if(job.sound)ding('review');
    persist(job);
    return;
  }
  await finishOutput(job, out, log);
}

async function finishOutput(job, out, log) {
  job.abort.signal.throwIfAborted();
  job.result = { path: out.path, width: out.width, height: out.height, bytes: fs.statSync(out.path).size, source: out.source || job.provider, provider: job.provider, ...(job.selectedCandidateId ? { candidateId: job.selectedCandidateId } : {}) };
  await postProcess(job, log);
  job.abort.signal.throwIfAborted(); // Cancellation during post-processing must not become done/auto-PS.
  job.status = 'done'; job.error = null; job.finishedAt = Date.now();
  log(`完成：${out.width}×${out.height}`);
  persist(job);
  if (job.sound) ding();
}

const operationLog = job => message => {
  job.stage = message;
  (job.log ||= []).push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`);
};

export function selectCandidate(id, candidateId) {
  const job = getJob(id);
  if (!job) return Promise.reject(new Error('任务不存在'));
  if (job.selectedCandidateId && job.selectedCandidateId !== candidateId) return Promise.reject(new Error('此任务已选择其他候选图，不能更换'));
  if (operations.has(id)) {
    if (operations.get(id).kind === 'selection' && job.selectedCandidateId === candidateId) return operations.get(id).promise;
    return Promise.reject(new Error('任务正在恢复，请稍后选择'));
  }
  if (job.status === 'done' && job.selectedCandidateId === candidateId) return Promise.resolve(publicJob(job));
  if (job.status !== 'awaiting-selection' || !job.candidatesReady || job.cancelledAt) return Promise.reject(new Error('任务当前不能选择候选图'));
  const candidate = job.candidates.find(c => c.id === candidateId);
  if (!candidate || !fs.existsSync(candidate.path)) return Promise.reject(new Error('候选图不存在'));
  job.selectedCandidateId = candidateId;
  job.selectionAt ||= Date.now();
  job.status = 'running'; job.error = null; job.stage = '处理已选候选图';
  persist(job); // Commit selection before post-processing or downstream visibility.
  const promise = finishOutput(job, candidate, operationLog(job)).then(() => publicJob(job)).catch(e => {
    job.status = job.abort.signal.aborted ? 'error' : 'awaiting-selection';
    job.result = null; job.error = job.abort.signal.aborted ? '已取消' : '所选图片处理失败，请继续处理';
    persist(job); throw new Error(job.error);
  }).finally(() => operations.delete(id));
  operations.set(id, { kind: 'selection', promise });
  return promise;
}

export function canRecoverJob(job, providers) {
  return job?.status === 'error' && ['comfyui', 'runninghub'].includes(job.provider) &&
    job.upstream?.kind === job.provider && typeof job.upstream.taskId === 'string' &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(job.upstream.taskId) && (!providers || typeof providers[job.provider]?.resume === 'function');
}

export function recoverJob(id, providers) {
  const job = getJob(id);
  if (!job) throw new Error('任务不存在');
  if (operations.has(id)) return publicJob(job); // Duplicate clicks cannot start another poller.
  if (job.status === 'done' || job.status === 'awaiting-selection') return publicJob(job);
  if (!canRecoverJob(job, providers)) throw new Error('没有可恢复的已确认任务 ID；请在上游服务人工核对，不能重新提交');
  job.abort = new AbortController(); job.status = 'running'; job.error = null; job.finishedAt = null;
  delete job.cancelledAt;
  const log = operationLog(job); log('恢复已有任务：只查询和下载，不重新提交'); persist(job);
  const promise = Promise.resolve().then(() => providers[job.provider].resume(job, { signal: job.abort.signal, log }))
    .then(out => acceptOutput(job, out, log)).catch(() => {
      job.status = 'error'; job.error = job.abort.signal.aborted ? '已停止本地恢复；未取消上游任务' : '恢复失败，请核对连接及已有任务；未重新提交';
      job.finishedAt = Date.now(); log(job.error);
    }).finally(() => { persist(job); operations.delete(id); });
  operations.set(id, { kind: 'recovery', promise });
  return publicJob(job);
}

export async function candidateFile(job, candidateId, thumb = true) {
  if (typeof candidateId !== 'string' || !/^candidate-[1-9][0-9]*$/.test(candidateId)) throw new Error('候选图 ID 无效');
  const candidate = job?.candidates?.find(c => c.id === candidateId);
  if (!candidate || !fs.existsSync(candidate.path)) throw new Error('候选图不存在');
  const root = fs.realpathSync(job.dir) + path.sep;
  if (!fs.realpathSync(candidate.path).startsWith(root)) throw new Error('候选图路径无效');
  if (!thumb) return { file: candidate.path, contentType: 'image/png' };
  const target = path.join(job.dir, `${candidate.id}-thumb.jpg`);
  if (!fs.existsSync(target)) await thumbnail(candidate.path, target);
  return { file: target, contentType: 'image/jpeg' };
}

// Parent server handles auth/body limits and streams { file, contentType } responses.
export async function candidateRoutes(method, parts, body = {}, providers = {}) {
  if (parts[0] !== 'candidates') return undefined;
  if (method === 'GET' && parts.length === 1) return { jobs: listJobs(100000)
    .filter(j => j.status === 'awaiting-selection' || (j.upstream && j.status === 'error') || operations.has(j.id))
    .map(j => ({ ...j, canRecover: canRecoverJob(j, providers) })) };
  const job = getJob(parts[1]); if (!job) throw new Error('任务不存在');
  if (method === 'GET' && parts.length === 2) return { job: publicJob(job), canRecover: canRecoverJob(job, providers) };
  if (method === 'GET' && parts.length === 4 && ['thumb', 'image'].includes(parts[3])) return candidateFile(job, parts[2], parts[3] === 'thumb');
  if (method === 'POST' && parts.length === 3 && parts[2] === 'select') return { job: await selectCandidate(job.id, body.candidateId) };
  if (method === 'POST' && parts.length === 3 && parts[2] === 'recover') return { job: recoverJob(job.id, providers) };
  throw new Error('未知候选图操作');
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
  const key = `${cc}${CC_VERSION[cc] ? `${CC_VERSION[cc]}` : ''}${tex ? `-tex${TEX_VERSION}` : ''}${t < 1 ? `-t${Math.round(t * 100)}` : ''}`;
  if (r.variants[key] && fs.existsSync(r.variants[key])) return r.variants[key];
  const out = await makeVariant({ inputPath: job.inputPath, basePath: base, cc, tex, t, outPath: path.join(job.dir, `v-${key}.png`) });
  r.variants[key] = out;
  persist(job);
  return out;
}

// One shared record for the image actually placed by Photoshop. Preview requests never change it.
export function appliedVariant(job) {
  return job.applied?.variant || { cc: job.post?.cc || 'none', tex: false, t: 1 };
}

export function normalizeVariant(value = {}) {
  const cc = value.cc ?? 'none';
  if (!CC_MODES.includes(cc)) throw new Error('校色参数无效');
  const t = Number(value.t ?? 1);
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('强度必须在 0 到 1 之间');
  return { cc, tex: value.tex === true, t: Math.round(t * 20) / 20 };
}

export async function recordPlacement(job, body) {
  if (job.status !== 'done') throw new Error('任务还没有完成');
  const variant = normalizeVariant(body.variant);
  const file = await variantPath(job, variant);
  const placement = { id: crypto.randomUUID(), variant, path: file, at: Date.now(),
    document: { id: Number(body.docId) || null, name: String(body.docName || '').slice(0, 250) },
    layerId: Number(body.layerId) || null, groupId: String(body.groupId || '').slice(0, 100) };
  job.placements = [...(job.placements || []), placement].slice(-100);
  job.applied = placement;
  persist(job);
  return placement;
}

export async function createLocalResult({ sourcePath, buffer, title, parameters }) {
  const id = `${stamp()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(config.outputDir, id.slice(0, 8), id);
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, 'output.png'), input = path.join(dir, `input${path.extname(sourcePath)}`);
  fs.copyFileSync(sourcePath, input); fs.writeFileSync(output, buffer);
  const { imageSize } = await import('./image.mjs');
  const size = await imageSize(output);
  const j = { id, groupId: id, schemaVersion: 1, dir, provider: 'local-tool', prompt: title, model: parameters?.model || 'sharp',
    inputPath: input, refPaths: [], status: 'done', createdAt: Date.now(), finishedAt: Date.now(),
    post: { align: false, cc: 'none' }, meta: { origin: 'tools', title, parameters }, log: [],
    result: { path: output, base: output, bytes: buffer.length, ...size, source: parameters?.model ? `本地模型 · ${parameters.model}` : '本地调整', variants: {} }, abort: new AbortController() };
  jobs.set(id, j); persist(j); await ensureThumb(j);
  return publicJob(j);
}
