// ps-ai-bridge helper：只监听 127.0.0.1。Photoshop 插件把图和参数发过来，这里排队调用各平台生图，插件轮询结果后取回贴进 PS。
import http from 'node:http';
import { createShortcuts } from './lib/shortcuts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './lib/config.mjs';
import os from 'node:os';
import { DATA_DIR } from './lib/paths.mjs';
import { captureRegion } from './lib/screenshot.mjs';
import { normalizeImage } from './lib/image.mjs';
import * as bridge from './lib/bridge.mjs';
import sharp from 'sharp';
import {storageRoutes,storageRequestGuard,assertStorageQuota} from './lib/storage.mjs';
import {createOrganizer} from './lib/organizer.mjs';
import {createCreative} from './lib/creative.mjs';
import {createAssistantWorkbench} from './lib/assistant-workbench.mjs';
import {libraryRoutes} from './lib/library.mjs';
import {forge,forgeRoutes,modelTools,modelToolsRoutes} from './providers/forge.mjs';
import {candidateRoutes} from './lib/jobs.mjs';
import {retouchRoutes} from './lib/retouch.mjs';
import {sharedSettings} from './lib/shared-settings.mjs';
import {regionRoutes,regionFile,regionRecord} from './lib/regions.mjs';
import { accountStatus, openLogin } from './lib/accounts.mjs';
import { getPrefs, updatePrefs } from './lib/prefs.mjs';
import { createJob, getJob, listJobs, cancelJob, publicJob, saveUpload, loadHistory, variantPath, ensureThumb, appliedVariant, recordPlacement, useUpload } from './lib/jobs.mjs';
import { CATEGORIES, listPresets, getPreset, savePreset, setStar, deletePreset, importFolder, listTrash, restorePreset, listRevisions, restoreRevision, exportPresets, importPack } from './lib/presets.mjs';
import { CC_MODES } from './lib/post.mjs';
import { assist } from './lib/assist.mjs';
import { registerChannels, channelRoutes, channelAssist } from './providers/channels.mjs';
import { engineRoutes } from './lib/engines.mjs';
import { compatModels, compatGenerate } from './lib/compat.mjs';
import { createWorkbench } from './lib/workbench.mjs';
import { createRuns } from './lib/runs.mjs';
import { showChrome } from './lib/chrome.mjs';
import { aistudio, AISTUDIO_MODELS, AISTUDIO_ASPECTS } from './providers/aistudio.mjs';
import { codex, agy } from './providers/cli.mjs';
import { geminiApi, openaiApi } from './providers/api.mjs';
import { flow, FLOW_MODELS, FLOW_ASPECTS } from './providers/flow.mjs';
import { runninghub, runninghubRoutes } from './providers/runninghub.mjs';
import { comfyui, comfyRoutes } from './providers/comfyui.mjs';
import { chatgpt, CHATGPT_ASPECTS } from './providers/chatgpt.mjs';

const VERSION = '0.8.1';
// 和 helper 一起分发的插件版本（桌面端里在 resources/plugin，源码版是仓库里的 plugin/）。PS 面板拿它和自己的版本比，旧了就提示更新
const BUNDLED_PLUGIN = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'plugin', 'manifest.json'), 'utf8')).version; } catch { return null; }
})();
const shortcuts = createShortcuts();
process.on('exit', () => shortcuts.stop());
// 桌面端托管时带 IPC 通道：桌面端退出（包括崩溃、被强退）就跟着退出
if (process.send) process.on('disconnect', () => process.exit(0));

const providers = { aistudio, codex, agy, 'gemini-api': geminiApi, 'openai-api': openaiApi, chatgpt, flow, comfyui, runninghub, forge, 'model-tools':modelTools };

// 给插件的平台能力表：比例「自动」时插件按这里的列表挑最接近选区的比例
const GPT_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
const capabilities = {
  forge: {aspects:['1:1','2:3','3:2','3:4','4:3','9:16','16:9']},
  'model-tools': {aspects:['1:1','2:3','3:2','3:4','4:3','9:16','16:9']},
  runninghub: { aspects: ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'], resolutions: ['1K', '2K', '4K'] },
  comfyui: { aspects: ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'], resolutions: ['1K', '2K', '4K'] },
  aistudio: { models: Object.keys(AISTUDIO_MODELS), aspects: AISTUDIO_ASPECTS, resolutions: ['1K', '2K', '4K'], thinking: ['Minimal', 'Medium', 'High'] },
  codex: { aspects: GPT_ASPECTS },
  agy: { aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'] },
  'gemini-api': { aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'], resolutions: ['1K', '2K', '4K'] },
  'openai-api': { aspects: ['1:1', '2:3', '3:2'] },
  chatgpt: { aspects: CHATGPT_ASPECTS },
  flow: { models: Object.keys(FLOW_MODELS), aspects: FLOW_ASPECTS, resolutions: ['1K', '2K'] },
};

registerChannels(providers, capabilities);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求太大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    if (process.env.DEBUG) console.log(req.method, req.url, JSON.stringify(req.headers));
    // 防 DNS rebinding / 网页跨站调用：只认本机 Host；写操作必须带自定义头（浏览器跨站发不出来）
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
    // 修图轮椅 V7 的「Others」连接走 /compat（Gemini 兼容）。它从主进程发请求，带不了自定义头；
    // 改为拦住所有带 Origin 的请求（网页发的都有）并要求 JSON，浏览器跨站发 JSON 必须先预检，这里不应答预检
    if (req.url.startsWith('/compat/')) {
      if (req.headers.origin) return send(res, 403, { error: { message: 'compat 接口只给本机程序用' } });
      const m = /^\/compat\/v1beta\/models(?:\/([^/?]+):generateContent)?(?:\?.*)?$/.exec(req.url);
      if (!m) return send(res, 404, { error: { message: '没有这个接口' } });
      if (!m[1]) return send(res, 200, compatModels(providers, capabilities));
      if (req.method !== 'POST' || !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: { message: '请用 POST + application/json' } });
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return send(res, 200, await compatGenerate(m[1], body, { providers, capabilities, signal: abort.signal }));
      } catch (e) {
        return send(res, e.status || 500, { error: { code: e.status || 500, message: e.message || String(e) } });
      }
    }
    if (req.method !== 'GET' && req.headers['x-ps-ai-bridge'] !== '1') return send(res, 403, { error: 'missing x-ps-ai-bridge header' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const releaseStorage=storageRequestGuard(req.method,parts);res.once('finish',releaseStorage);res.once('close',releaseStorage);

    const extraRoutes={storage:storageRoutes,library:libraryRoutes,forge:forgeRoutes,'model-tools':modelToolsRoutes,candidates:(m,p,b)=>candidateRoutes(m,p,b,providers),organizer:(m,p,b)=>organizer.route(m,p,b,url.searchParams),creative:creative.route,'assistant-workbench':assistantWorkbench.route};
    if(extraRoutes[parts[0]]) {
      const result=await extraRoutes[parts[0]](req.method,parts,req.method==='GET'?{}:JSON.parse((await readBody(req)).toString()||'{}'));
      if(result?.buffer && result.type)return send(res,200,result.buffer,result.type);
      if(result?.file && result.contentType)return send(res,200,fs.readFileSync(result.file),result.contentType);
      return send(res,200,result);
    }
    if (req.method==='GET' && parts[0]==='jobs' && parts[2]==='mask-raw') {
      const j=getJob(parts[1]);if(!j?.result)throw new Error('结果不存在');
      const width=Number(url.searchParams.get('width')),height=Number(url.searchParams.get('height'));
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>40000000)throw new Error('蒙版目标尺寸无效');
      const file=await variantPath(j,appliedVariant(j)),meta=await sharp(file).metadata();
      let image=sharp(file).resize(width,height,{fit:'fill'});
      if(url.searchParams.get('mode')==='luma')image=image.removeAlpha().greyscale();else {if(!meta.hasAlpha)throw new Error('该结果没有透明通道，请明确选择灰度模式');image=image.extractChannel('alpha');}
      return send(res,200,await image.raw().toBuffer(),'application/octet-stream');
    }
    if(parts[0]==='retouch')return send(res,200,await retouchRoutes(req.method,parts,JSON.parse((await readBody(req)).toString()||'{}')));
    if(url.pathname==='/shared-settings')return send(res,200,sharedSettings(req.method,req.method==='GET'?{}:JSON.parse((await readBody(req,16384)).toString()||'{}')));
    if (parts[0] === 'regions') {
      if (req.method === 'GET' && parts.length === 3) { const r=await regionFile(parts[1],parts[2]); if(r.bounds)res.setHeader('x-mask-bounds',JSON.stringify(r.bounds)); return send(res,200,r.buffer,r.type); }
      return send(res,200,await regionRoutes(req.method,parts,req.method==='GET'?{}:JSON.parse((await readBody(req)).toString()||'{}')));
    }
    if (url.pathname === '/masks/raw' && req.method === 'POST') {
      const width=Number(url.searchParams.get('width')),height=Number(url.searchParams.get('height'));
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>40000000)throw new Error('蒙版尺寸无效');
      const buffer=await readBody(req,40000000);if(buffer.length!==width*height)throw new Error('蒙版像素数量不一致');
      const png=await sharp(buffer,{raw:{width,height,channels:1}}).png().toBuffer();return send(res,200,{uploadId:saveUpload(png,'image/png')});
    }
    if (parts[0] === 'runs') return send(res, 200, await runs.route(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}')));

    if (parts[0] === 'api-channels') return send(res, 200, await channelRoutes(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}')));
    if (parts[0] === 'engine') return send(res, 200, await engineRoutes(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req, 16384)).toString() || '{}')));
    if (parts[0] === 'runninghub') return send(res, 200, await runninghubRoutes(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}')));
    if (parts[0] === 'comfyui') return send(res, 200, await comfyRoutes(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}')));
    if (['batches', 'projects', 'tools'].includes(parts[0])) {
      const result = await workbench.route(req.method, parts, req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}'));
      if (result !== undefined) return send(res, 200, result);
    }

    if (url.pathname === '/shortcuts' && req.method === 'GET') return send(res, 200, shortcuts.status());
    if (url.pathname === '/shortcuts' && req.method === 'POST') return send(res, 200, shortcuts.update(JSON.parse((await readBody(req, 2048)).toString())));
    if (url.pathname === '/shortcuts/poll' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString());
      const state = shortcuts.poll(body.session);
      // 顺带交给面板一条桌面端发来的指令（见 lib/bridge.mjs）
      return send(res, 200, { ...state, command: bridge.take(typeof body.doc === 'string' ? body.doc.slice(0, 200) : null, body.bridge === 1) });
    }

    // ---- 桌面端 ↔ Photoshop 面板 ----
    if (url.pathname === '/bridge/status' && req.method === 'GET') return send(res, 200, bridge.status());
    if (url.pathname === '/bridge/result' && req.method === 'POST') return send(res, 200, { ok: bridge.settle(JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}')) });
    if (url.pathname === '/bridge/ps' && req.method === 'POST') {
      const cmd = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      if (!['generate', 'paste','documents','capture-region','paste-bound','apply-mask','select-subject','locate-region'].includes(cmd.type)) return send(res, 400, { error: `未知指令：${cmd.type}` });
      if (['paste-bound','locate-region'].includes(cmd.type)) { const c=regionRecord(cmd.captureId); if(c.kind!=='capture')throw new Error('目标不是原始捕获'); cmd.target=c.target; cmd.rect=c.rect; cmd.mask=c.mask; }
      return send(res, 200, await bridge.request(cmd));
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const list = {};
      for (const [key, p] of Object.entries(providers)) {
        list[key] = { label: p.label, ...(await p.status().catch((e) => ({ available: false, note: e.message }))), ...capabilities[key] };
      }
      for (const key of Object.keys(list)) if (list[key].hidden) delete list[key];
      const chrome = { path: config.chrome.app, found: fs.existsSync(config.chrome.app) };
      return send(res, 200, { ok: true, version: VERSION, plugin: { latest: BUNDLED_PLUGIN }, outputDir: config.outputDir, dataDir: DATA_DIR, chrome, providers: list });
    }

    // ---- 运行中可改的设置（出图后是否关掉标签页等） ----
    if (url.pathname === '/prefs' && req.method === 'GET') return send(res, 200, getPrefs());
    if (url.pathname === '/prefs' && req.method === 'POST') return send(res, 200, updatePrefs(JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}')));

    // ---- 平台账号：登录状态、在专用 Chrome 里打开登录页 ----
    if (req.method === 'GET' && url.pathname === '/accounts') return send(res, 200, await accountStatus());
    if (req.method === 'POST' && url.pathname === '/accounts/login') {
      const { site } = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}');
      await openLogin(site);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/chrome/open') {
      await showChrome('https://aistudio.google.com/prompts/new_chat');
      return send(res, 200, { ok: true });
    }

    // ---- 预设库 ----
    if (parts[0] === 'presets') {
      if (req.method === 'GET' && parts.length === 1) return send(res, 200, { categories: CATEGORIES, presets: listPresets() });
      if (req.method === 'POST' && parts[1] === 'reference-data') {
        const { uploadIds } = JSON.parse((await readBody(req, 4096)).toString());
        if (!Array.isArray(uploadIds) || uploadIds.length > 4) throw new Error('最多 4 张参考图');
        return send(res, 200, { refImages: uploadIds.map(id => { const src = useUpload(id); if (!src) throw new Error('参考图已失效'); return fs.readFileSync(src).toString('base64'); }) });
      }
      if (req.method === 'GET' && parts[1] === 'trash') return send(res, 200, { presets: listTrash() });
      if (req.method === 'POST' && parts[1] === 'restore') {
        const body = JSON.parse((await readBody(req)).toString());
        return send(res, 200, restorePreset(body.trashId));
      }
      if (req.method === 'POST' && parts[1] === 'export') {
        const body = JSON.parse((await readBody(req)).toString());
        return send(res, 200, exportPresets(body.ids));
      }
      if (req.method === 'POST' && parts[1] === 'import-pack') {
        const body = JSON.parse((await readBody(req)).toString());
        return send(res, 200, importPack(body.pack, body.preview === true));
      }
      if (req.method === 'POST' && parts[1] === 'import') {
        const { dir } = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        return send(res, 200, importFolder(String(dir || '').replace(/^~/, os.homedir())));
      }
      if (req.method === 'POST' && parts.length === 1) {
        const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}');
        return send(res, 200, savePreset(body));
      }
      const id = decodeURIComponent(parts[1] || '');
      if (req.method === 'GET' && parts.length === 2) {
        const p = getPreset(id);
        return p ? send(res, 200, p) : send(res, 404, { error: '没有这个预设' });
      }
      if (req.method === 'GET' && parts[2] === 'revisions') return send(res, 200, { revisions: listRevisions(id) });
      if (req.method === 'POST' && parts[2] === 'restore-revision') {
        const body = JSON.parse((await readBody(req)).toString());
        return send(res, 200, restoreRevision(id, body.revision));
      }
      if (req.method === 'POST' && parts[2] === 'refs') {
        // 预设自带的参考图（V6 存成 base64 PNG）转成 uploadId 给插件用
        const p = getPreset(id);
        if (!p) return send(res, 404, { error: '没有这个预设' });
        return send(res, 200, { uploadIds: p.refImages.map((b64) => saveUpload(Buffer.from(b64, 'base64'), 'image/png')) });
      }
      if (req.method === 'POST' && parts[2] === 'star') {
        const { starred } = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}');
        setStar(id, starred);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[2] === 'delete') {
        deletePreset(id);
        return send(res, 200, { ok: true });
      }
    }

    // 检查点保留原文件；超过配额时停止新增，由用户明确整理。
    if (parts[0] === 'checkpoints') {
      const root = path.join(config.outputDir, '_checkpoints');
      if (req.method === 'POST') {
        const buf = await readBody(req, 512 * 1024 * 1024);
        const doc = (url.searchParams.get('doc') || 'untitled').replace(/[\/:*?"<>|]/g, '_').slice(0, 80);
        const d = new Date();
        const day = d.toISOString().slice(0, 10).replace(/-/g, '');
        fs.mkdirSync(path.join(root, day), { recursive: true });
        const file = path.join(root, day, `${doc}-${d.toTimeString().slice(0, 8).replace(/:/g, '')}.png`);
        assertStorageQuota('checkpoint',buf.length);
        fs.writeFileSync(file, buf);
        return send(res, 200, { path: file });
      }
      const list = [];
      if (fs.existsSync(root)) for (const day of fs.readdirSync(root).sort().reverse()) {
        if (!/^\d{8}$/.test(day)) continue;
        for (const f of fs.readdirSync(path.join(root, day)).sort().reverse()) list.push({ path: path.join(root, day, f), bytes: fs.statSync(path.join(root, day, f)).size });
      }
      return send(res, 200, { checkpoints: list.slice(0, 200) });
    }

    // ---- 插件日志：面板提示和报错同步写进 helper 终端，方便排查 ----
    if (req.method === 'POST' && url.pathname === '/log') {
      const { level, msg } = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      console.log(`[插件${level === 'error' ? '报错' : ''}] ${String(msg).slice(0, 2000)}`);
      return send(res, 200, { ok: true });
    }

    // ---- AI 帮写提示词 ----
    if (req.method === 'POST' && url.pathname === '/assist') {
      const { text, uploadId } = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
      if (!text || !String(text).trim()) return send(res, 400, { error: '先写一句想怎么改' });
      const dir = path.join(config.outputDir, '_uploads');
      const imagePath = uploadId ? ['jpg', 'png'].map((e) => path.join(dir, `${String(uploadId).replace(/[^a-f0-9]/g, '')}.${e}`)).find((p) => fs.existsSync(p)) : null;
      return send(res, 200, { prompt: (await channelAssist({ text: String(text), imagePath })) ?? await assist({ text: String(text), imagePath }) });
    }

    // ---- 截图当参考图：系统自带的框选截图，拖一个框，Esc 取消 ----
    if (req.method === 'POST' && url.pathname === '/screenshot') {
      const file = await captureRegion();
      if (!file) return send(res, 200, { cancelled: true });
      const uploadId = saveUpload(fs.readFileSync(file), 'image/png');
      fs.unlinkSync(file);
      return send(res, 200, { uploadId });
    }
    if (req.method === 'GET' && parts[0] === 'uploads' && parts[1]) {
      const dir = path.join(config.outputDir, '_uploads');
      const f = ['png', 'jpg'].map((e) => path.join(dir, `${parts[1].replace(/[^a-f0-9]/g, '')}.${e}`)).find((p) => fs.existsSync(p));
      if (!f) return send(res, 404, { error: '没有这张图' });
      res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'image/jpeg' });
      return fs.createReadStream(f).pipe(res);
    }

    // 桌面端：本地图片（path）或某个任务的结果（jobId，用贴回版本）转成上传图
    if (req.method === 'POST' && url.pathname === '/uploads/from-file') {
      const { path: file, jobId, maxSide } = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const job = jobId ? getJob(jobId) : null;
      const src = job ? await variantPath(job, appliedVariant(job)) : file;
      if (!src || !fs.existsSync(src)) return send(res, 404, { error: '找不到这张图' });
      const img = await normalizeImage(src, maxSide === 'original' ? 0 : Math.min(Number(maxSide) || 2048, 4096));
      return send(res, 200, { uploadId: saveUpload(img.buffer, img.mime), width: img.width, height: img.height, name: path.basename(src) });
    }

    if (req.method === 'POST' && url.pathname === '/uploads') {
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { error: '空文件' });
      return send(res, 200, { uploadId: saveUpload(buf, req.headers['content-type']) });
    }

    if (parts[0] === 'jobs') {
      if (req.method === 'GET' && parts.length === 1) return send(res, 200, { jobs: listJobs() });
      if (req.method === 'POST' && parts.length === 1) {
        const params = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
        const job = createJob(params, providers, capabilities);
        return send(res, 200, publicJob(job));
      }
      const job = getJob(parts[1]);
      if (!job) return send(res, 404, { error: '没有这个任务' });
      if (req.method === 'GET' && parts.length === 2) return send(res, 200, publicJob(job));
      if (req.method === 'POST' && parts[2] === 'placement') return send(res, 200, await recordPlacement(job, JSON.parse((await readBody(req, 16384)).toString())));
      if (req.method === 'GET' && parts[2] === 'result') {
        if (job.status !== 'done') return send(res, 409, { error: '还没生成完' });
        const selected = appliedVariant(job);
        const cc = url.searchParams.get('cc') || selected.cc;
        if (!CC_MODES.includes(cc)) return send(res, 400, { error: `没有这种校色：${cc}` });
        const tex = url.searchParams.has('tex') ? url.searchParams.get('tex') === '1' : selected.tex;
        const t = url.searchParams.has('t') ? Number(url.searchParams.get('t')) : selected.t;
        // raw=1：网页上生成的原图（没对齐、没校色），用来和贴回 PS 的版本对比
        const file = url.searchParams.get('raw') === '1' ? job.result.path : await variantPath(job, { cc, tex, t: Number.isFinite(t) ? t : 1 });
        const ext = path.extname(file).slice(1).toLowerCase();
        res.writeHead(200, { 'content-type': ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', 'x-result-ext': ext, 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && parts[2] === 'thumb') {
        const file = await ensureThumb(job).catch(() => null);
        if (!file) return send(res, 404, { error: '没有缩略图' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && parts[2] === 'input') {
        if (!job.inputPath) return send(res, 404, { error: '没有原图' });
        res.writeHead(200, { 'content-type': job.inputPath.endsWith('.png') ? 'image/png' : 'image/jpeg' });
        return fs.createReadStream(job.inputPath).pipe(res);
      }
      if (req.method === 'POST' && parts[2] === 'cancel') return send(res, 200, { ok: cancelJob(job.id) });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 400, { error: e?.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${config.port} 已被占用：helper 可能已经在运行了。`);
  else console.error(e);
  process.exit(1);
});

const restored = loadHistory();
const workbench = createWorkbench({ providers, capabilities });
const runs = createRuns({ providers, capabilities });
const organizer=createOrganizer({bridge});
const creative=createCreative({providers,capabilities,runs});
const assistantWorkbench=createAssistantWorkbench({providers,capabilities,bridge});

server.listen(config.port, '127.0.0.1', () => {
  if (restored) console.log(`已读回 ${restored} 个历史任务（检查点）`);
  console.log(`ps-ai-bridge helper ${VERSION} 已启动：http://127.0.0.1:${config.port}`);
  console.log(`结果保存在：${config.outputDir}`);
  // 桌面端托管时没有终端窗口
  if (!process.env.PS_AI_BRIDGE_DESKTOP) console.log('保持这个窗口开着；关掉窗口 helper 就停了。');
});
