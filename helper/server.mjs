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
import { accountStatus, openLogin } from './lib/accounts.mjs';
import { getPrefs, updatePrefs } from './lib/prefs.mjs';
import { createJob, getJob, listJobs, cancelJob, publicJob, saveUpload, loadHistory, variantPath, ensureThumb } from './lib/jobs.mjs';
import { CATEGORIES, listPresets, getPreset, savePreset, setStar, deletePreset, importFolder } from './lib/presets.mjs';
import { CC_MODES } from './lib/post.mjs';
import { assist } from './lib/assist.mjs';
import { showChrome } from './lib/chrome.mjs';
import { aistudio, AISTUDIO_MODELS, AISTUDIO_ASPECTS } from './providers/aistudio.mjs';
import { codex, agy } from './providers/cli.mjs';
import { geminiApi, openaiApi } from './providers/api.mjs';
import { flow, FLOW_MODELS, FLOW_ASPECTS } from './providers/flow.mjs';
import { chatgpt, CHATGPT_ASPECTS } from './providers/chatgpt.mjs';

const VERSION = '0.5.2';
const shortcuts = createShortcuts();
process.on('exit', () => shortcuts.stop());
// 桌面端托管时带 IPC 通道：桌面端退出（包括崩溃、被强退）就跟着退出
if (process.send) process.on('disconnect', () => process.exit(0));

const providers = { aistudio, codex, agy, 'gemini-api': geminiApi, 'openai-api': openaiApi, chatgpt, flow };

// 给插件的平台能力表：比例「自动」时插件按这里的列表挑最接近选区的比例
const GPT_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
const capabilities = {
  aistudio: { models: Object.keys(AISTUDIO_MODELS), aspects: AISTUDIO_ASPECTS, resolutions: ['1K', '2K', '4K'], thinking: ['Minimal', 'Medium', 'High'] },
  codex: { aspects: GPT_ASPECTS },
  agy: { aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'] },
  'gemini-api': { aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'], resolutions: ['1K', '2K', '4K'] },
  'openai-api': { aspects: ['1:1', '2:3', '3:2'] },
  chatgpt: { aspects: CHATGPT_ASPECTS },
  flow: { models: Object.keys(FLOW_MODELS), aspects: FLOW_ASPECTS, resolutions: ['1K', '2K'] },
};

function pruneCheckpoints(root) {
  const max = (Number(config.checkpointMaxGB) || 20) * 1024 ** 3;
  const files = [];
  for (const day of fs.readdirSync(root)) {
    const dir = path.join(root, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      files.push({ p, size: st.size, t: st.mtimeMs });
    }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= max) break;
    fs.unlinkSync(f.p);
    total -= f.size;
  }
}

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
    if (req.method !== 'GET' && req.headers['x-ps-ai-bridge'] !== '1') return send(res, 403, { error: 'missing x-ps-ai-bridge header' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);

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
      if (!['generate', 'paste'].includes(cmd.type)) return send(res, 400, { error: `未知指令：${cmd.type}` });
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
      const chrome = { path: config.chrome.app, found: fs.existsSync(config.chrome.app) };
      return send(res, 200, { ok: true, version: VERSION, outputDir: config.outputDir, dataDir: DATA_DIR, chrome, providers: list });
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

    // ---- 检查点：插件生成时存的整张画布 PNG，超过容量上限从最旧的删 ----
    if (parts[0] === 'checkpoints') {
      const root = path.join(config.outputDir, '_checkpoints');
      if (req.method === 'POST') {
        const buf = await readBody(req, 512 * 1024 * 1024);
        const doc = (url.searchParams.get('doc') || 'untitled').replace(/[\/:*?"<>|]/g, '_').slice(0, 80);
        const d = new Date();
        const day = d.toISOString().slice(0, 10).replace(/-/g, '');
        fs.mkdirSync(path.join(root, day), { recursive: true });
        const file = path.join(root, day, `${doc}-${d.toTimeString().slice(0, 8).replace(/:/g, '')}.png`);
        fs.writeFileSync(file, buf);
        pruneCheckpoints(root);
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
      return send(res, 200, { prompt: await assist({ text: String(text), imagePath }) });
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
      const src = job ? (job.result?.base && fs.existsSync(job.result.base) ? job.result.base : job.result?.path) : file;
      if (!src || !fs.existsSync(src)) return send(res, 404, { error: '找不到这张图' });
      const img = await normalizeImage(src, Math.min(Number(maxSide) || 2048, 4096)).catch(() => { throw new Error('这个格式读不了，先转成 JPG 或 PNG'); });
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
      if (req.method === 'GET' && parts[2] === 'result') {
        if (job.status !== 'done') return send(res, 409, { error: '还没生成完' });
        const cc = url.searchParams.get('cc') || job.post?.cc || 'none';
        if (!CC_MODES.includes(cc)) return send(res, 400, { error: `没有这种校色：${cc}` });
        const tex = url.searchParams.get('tex') === '1';
        const t = url.searchParams.has('t') ? Number(url.searchParams.get('t')) : 1;
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
    send(res, 400, { error: e?.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${config.port} 已被占用：helper 可能已经在运行了。`);
  else console.error(e);
  process.exit(1);
});

const restored = loadHistory();

server.listen(config.port, '127.0.0.1', () => {
  if (restored) console.log(`已读回 ${restored} 个历史任务（检查点）`);
  console.log(`ps-ai-bridge helper ${VERSION} 已启动：http://127.0.0.1:${config.port}`);
  console.log(`结果保存在：${config.outputDir}`);
  // 桌面端托管时没有终端窗口
  if (!process.env.PS_AI_BRIDGE_DESKTOP) console.log('保持这个窗口开着；关掉窗口 helper 就停了。');
});
