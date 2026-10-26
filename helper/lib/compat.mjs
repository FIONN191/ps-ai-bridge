// 给修图轮椅 V7 用的「Gemini 兼容接口」：V7 设置 → 图像服务 → Others · 其他，
// 地址填 http://127.0.0.1:47811/compat、协议选 Gemini、Key 随便填，就能用本机的免 API 平台出图
// （AI Studio / Google Flow / ChatGPT 网页 / Codex CLI / agy，走专用 Chrome 里登录的账号）。
//   GET  /compat/v1beta/models                         → { models: [{ name, displayName }] }
//   POST /compat/v1beta/models/<模型>:generateContent  → Gemini 格式的图片回包
// 模型名 = web-<平台>[-<平台里的模型>]，比如 web-aistudio-nano-banana-2.1、web-flow-nano-banana-pro、web-chatgpt。
// V7 自己做对齐和校色，所以这里出原图（不贴齐、不校色）。
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createJob, getJob, cancelJob, saveUpload } from './jobs.mjs';

const WEB = ['aistudio', 'flow', 'chatgpt', 'codex', 'agy'];
const POLL_MS = 1000;
const MAX_WAIT_MS = 60 * 60 * 1000;

export function compatModels(providers, capabilities) {
  const models = [];
  for (const provider of WEB) {
    const cap = capabilities[provider] && { ...capabilities[provider], label: providers[provider]?.label || provider };
    if (!cap) continue;
    const list = cap.models?.length ? cap.models : [''];
    for (const model of list) {
      const id = model ? `web-${provider}-${model}` : `web-${provider}`;
      models.push({ name: `models/${id}`, displayName: `免 API · ${cap.label}${model ? ` · ${model}` : ''}`, supportedGenerationMethods: ['generateContent'] });
    }
  }
  return { models };
}

function parseModel(raw, capabilities) {
  const id = decodeURIComponent(String(raw || '')).replace(/^models\//, '');
  const m = /^web-([a-z]+)(?:-(.+))?$/.exec(id);
  if (!m || !WEB.includes(m[1]) || !capabilities[m[1]]) throw Object.assign(new Error(`不认识的模型：${id}。请在「读取模型列表」里选 web- 开头的模型`), { status: 404 });
  const cap = capabilities[m[1]];
  if (m[2] && cap.models?.length && !cap.models.includes(m[2])) throw Object.assign(new Error(`${m[1]} 没有模型 ${m[2]}`), { status: 404 });
  return { provider: m[1], model: m[2] || '', cap };
}

const ratio = (a) => { const [w, h] = String(a).split(':').map(Number); return w / h; };
function pickAspect(cap, wanted, size) {
  const aspects = cap.aspects || ['1:1'];
  if (wanted && aspects.includes(wanted)) return wanted;
  const target = wanted && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(wanted) ? ratio(wanted) : size ? size.width / size.height : 1;
  return aspects.reduce((best, a) => (Math.abs(Math.log(ratio(a) / target)) < Math.abs(Math.log(ratio(best) / target)) ? a : best), aspects[0]);
}
function pickResolution(cap, wanted) {
  const list = cap.resolutions;
  if (!list?.length) return undefined;
  if (list.includes(wanted)) return wanted;
  const rank = { '1K': 1, '2K': 2, '4K': 4 };
  return list.filter((r) => rank[r] <= (rank[wanted] || 2)).pop() || list[0];
}

const imageParts = (body) => (body?.contents || []).flatMap((c) => c?.parts || []).filter((p) => p?.inlineData?.data);
const promptText = (body) => (body?.contents || []).flatMap((c) => c?.parts || []).map((p) => p?.text || '').join('\n').trim();

export async function compatGenerate(rawModel, body, { providers, capabilities, signal }) {
  const { provider, model, cap } = parseModel(rawModel, capabilities);
  const status = await providers[provider].status().catch((e) => ({ available: false, note: e.message }));
  if (status.available === false) throw Object.assign(new Error(`${providers[provider].label} 暂不可用：${status.note || '请先在 PS AI Bridge 里登录账号'}`), { status: 503 });
  const prompt = promptText(body);
  if (!prompt) throw Object.assign(new Error('提示词不能为空'), { status: 400 });
  const inline = imageParts(body);
  const images = inline.map((p) => Buffer.from(p.inlineData.data, 'base64'));
  const uploads = images.map((buf, i) => saveUpload(buf, inline[i].inlineData.mimeType || 'image/png'));
  const firstSize = images[0] ? await sharp(images[0]).metadata() : null;
  const cfg = body?.generationConfig?.imageConfig || {};
  const job = createJob({
    provider,
    model,
    prompt,
    aspect: pickAspect(cap, cfg.aspectRatio, firstSize),
    resolution: pickResolution(cap, cfg.imageSize),
    uploadId: uploads[0],
    refUploadIds: uploads.slice(1),
    post: { align: false, cc: 'none' },
    meta: { source: 'v7-compat' },
  }, providers, capabilities);

  const started = Date.now();
  for (;;) {
    if (signal?.aborted) { cancelJob(job.id); throw Object.assign(new Error('已取消'), { status: 499 }); }
    const j = getJob(job.id);
    if (j.status === 'done') return reply([j.result.path]);
    if (j.status === 'awaiting-selection') return reply(j.candidates.map((c) => c.path));
    if (j.status === 'error') throw Object.assign(new Error(j.error || '生成失败'), { status: 502 });
    if (Date.now() - started > MAX_WAIT_MS) { cancelJob(job.id); throw Object.assign(new Error('等结果超时（1 小时）'), { status: 504 }); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
function reply(paths) {
  const parts = paths.filter((p) => p && fs.existsSync(p)).map((p) => ({ inlineData: { mimeType: MIME[path.extname(p).toLowerCase()] || 'image/png', data: fs.readFileSync(p).toString('base64') } }));
  if (!parts.length) throw Object.assign(new Error('平台没有返回图片'), { status: 502 });
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
}
