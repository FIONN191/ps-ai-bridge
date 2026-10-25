// Google AI Studio 网页（Nano Banana）：在专用 Chrome 里开新标签页 → 选模型和参数 → 上传 → Run → 取最后一张图。
// 用户的 Chrome 里可能装了会盖住按钮的扩展，所以点击一律用 dispatchEvent，不靠鼠标坐标。
import fs from 'node:fs';
import path from 'node:path';
import { newPage, closePage, isChromeUp } from '../lib/chrome.mjs';
import { getPrefs } from '../lib/prefs.mjs';
import { imageSize, extFromMime } from '../lib/image.mjs';

export const AISTUDIO_MODELS = {
  'nano-banana-2.1': 'gemini-nano-banana-2.1',
  'nano-banana-pro': 'gemini-3-pro-image',
  'nano-banana-2-lite': 'gemini-3.1-flash-lite-image',
};
export const AISTUDIO_ASPECTS = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '4:1', '1:4', '8:1', '1:8'];
const RESOLUTIONS = ['1K', '2K', '4K'];
const THINKING = ['Minimal', 'Medium', 'High'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pick(page, name, value) {
  const cb = page.getByRole('combobox', { name });
  if (!(await cb.count())) throw new Error(`页面上找不到「${name}」设置，AI Studio 可能改版了`);
  if ((await cb.innerText()).trim() === value) return;
  await cb.dispatchEvent('click');
  const lb = page.getByRole('listbox', { name });
  await lb.waitFor({ timeout: 8000 });
  const opt = lb.getByRole('option', { name: value, exact: true });
  if (!(await opt.count())) {
    await page.keyboard.press('Escape');
    throw new Error(`「${name}」没有 ${value} 这个选项`);
  }
  await opt.dispatchEvent('click');
  await lb.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
  const now = (await cb.innerText()).trim();
  if (now !== value) throw new Error(`「${name}」没能设成 ${value}（现在是 ${now}）`);
}

// 页面状态：生成出的大图数量、主按钮是不是在 Stop 状态、错误提示
const pageState = (page) => page.evaluate(() => {
  const imgs = [...document.querySelectorAll('ms-chat-turn img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 256);
  const running = [...document.querySelectorAll('button.ms-button-primary')].some((b) => /^\s*(progress_activity\s*)?Stop\b/.test(b.innerText));
  const snack = [...document.querySelectorAll('mat-snack-bar-container, .mat-mdc-snack-bar-container')].map((s) => s.innerText.trim()).join(' / ');
  const turns = [...document.querySelectorAll('ms-chat-turn')];
  const lastText = turns.length ? turns[turns.length - 1].innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { images: imgs.length, running, snack, lastText };
});

// AI Studio 偶尔会返回 "Failed to generate content ... Please try again"，这类错误自动再跑一次
const TRANSIENT = /try again|Failed to generate|internal error|overloaded|does not have permission|Run 按钮一直不能点/i;

export const aistudio = {
  label: 'Nano Banana · AI Studio 网页',
  async status() {
    return { available: true, chrome: await isChromeUp() };
  },
  async run(job, ctx) {
    try {
      return await runOnce(job, ctx);
    } catch (e) {
      if (ctx.signal.aborted || !TRANSIENT.test(e.message)) throw e;
      ctx.log(`${e.message.split('\n')[0]}，等 8 秒自动重试一次`);
      await sleep(8000);
      try {
        return await runOnce(job, ctx);
      } catch (e2) {
        if (/does not have permission/i.test(e2.message)) throw new Error('AI Studio 拒绝生成（The caller does not have permission），通常是免费额度或频率限制，过一会儿再试');
        throw e2;
      }
    }
  },
};

async function runOnce(job, { log, signal }) {
  const modelId = AISTUDIO_MODELS[job.model || 'nano-banana-2.1'] || job.model;
  if (!AISTUDIO_ASPECTS.includes(job.aspect)) throw new Error(`AI Studio 不支持比例 ${job.aspect}`);
  if (!RESOLUTIONS.includes(job.resolution)) throw new Error(`AI Studio 不支持分辨率 ${job.resolution}`);
  const thinking = THINKING.includes(job.thinking) ? job.thinking : 'High';

  log('打开 AI Studio');
  const page = await newPage(`https://aistudio.google.com/prompts/new_chat?model=${modelId}`);
  let keep = false;
  let ok = false;
  try {
    if (/accounts\.google\.com/.test(page.url())) throw new Error('专用 Chrome 里还没登录 Google，请先在那个窗口登录 AI Studio');
    const box = page.getByRole('textbox', { name: 'Enter a prompt' });
    await box.waitFor({ timeout: 45000 });
    const modelCard = page.getByRole('button', { name: new RegExp(modelId.replace(/\./g, '\\.')) });
    if (!(await modelCard.count())) throw new Error(`AI Studio 没有切到模型 ${modelId}`);

    log(`设置参数：${job.aspect} · ${job.resolution} · 思考 ${thinking}`);
    await pick(page, 'Aspect ratio', job.aspect);
    await pick(page, 'Resolution', job.resolution);
    await pick(page, 'Thinking Level', thinking);

    const files = [job.inputPath, ...(job.refPaths || [])].filter(Boolean);
    if (files.length) {
      log(files.length > 1 ? `上传原图和 ${files.length - 1} 张参考图` : '上传原图');
      await page.locator('input.file-input').first().setInputFiles(files);
      for (const f of files) await page.getByRole('img', { name: path.basename(f) }).first().waitFor({ timeout: 60000 });
      await sleep(1500);
    }

    await box.fill(job.prompt);
    const before = (await pageState(page)).images;
    const run = page.locator('button.ms-button-primary', { hasText: 'Run' }).first();
    // 图片刚传上去时 Run 会灰一会儿（在算 token），大图要等久一点
    for (let i = 0; i < 60 && (await run.getAttribute('aria-disabled')) === 'true'; i++) await sleep(500);
    if ((await run.getAttribute('aria-disabled')) === 'true') {
      const why = await page.locator('main').innerText().catch(() => '');
      if (/paid API key/i.test(why)) throw new Error('这个模型在网页端需要付费 API Key，请换 Nano Banana 2.1');
      throw new Error('Run 按钮一直不能点');
    }
    await run.dispatchEvent('click');
    log('生成中…');

    const t0 = Date.now();
    let started = false;
    let st;
    while (true) {
      if (signal.aborted) throw new Error('已取消');
      await sleep(2000);
      st = await pageState(page);
      if (st.running) started = true;
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs % 10 === 0) log(`生成中… ${secs}s`);
      if (!st.running && (started || Date.now() - t0 > 15000) && st.images > before) break;
      if (!st.running && started && st.images <= before) {
        await sleep(3000); // 图片 blob 可能稍晚挂上
        st = await pageState(page);
        if (st.images > before) break;
        throw new Error(`AI Studio 没有出图：${st.snack || st.lastText || '未知原因'}`);
      }
      if (!started && Date.now() - t0 > 30000) throw new Error(`点了 Run 但没有开始生成：${st.snack || '未知原因'}`);
      if (Date.now() - t0 > 6 * 60 * 1000) throw new Error('等了 6 分钟还没出图');
    }

    // 一次回复里第一张是思考过程的预览，最后一张才是最终结果
    log('取回结果');
    const img = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('ms-chat-turn img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 256);
      const el = imgs[imgs.length - 1];
      const blob = await fetch(el.src).then((r) => r.blob());
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { type: blob.type, b64: btoa(s) };
    });
    const out = path.join(job.dir, `result-aistudio-${job.resolution}.${extFromMime(img.type)}`);
    fs.writeFileSync(out, Buffer.from(img.b64, 'base64'));
    ok = true;
    return { path: out, ...(await imageSize(out)), source: `AI Studio · ${modelId}` };
  } catch (e) {
    // 失败的标签页不留在专用 Chrome 里越堆越多：先把页面截图存进任务文件夹（方便看卡在哪一步）再关掉。
    // 只有要登录的时候留着，直接在那个标签页里登录
    keep = /还没登录/.test(e.message);
    if (!keep) {
      const n = fs.readdirSync(job.dir).filter((f) => f.startsWith('fail-aistudio-')).length + 1;
      const shot = path.join(job.dir, `fail-aistudio-${n}.png`);
      if (await page.screenshot({ path: shot, timeout: 8000 }).then(() => true, () => false)) log(`失败时的页面截图：${path.basename(shot)}`);
    }
    throw e;
  } finally {
    // 出图成功：按设置决定留不留标签页（默认留着，方便看网页上的结果）；失败的照旧关掉（已截图），要登录时留着
    if (ok ? getPrefs().closeTabsAfterDone : !keep) await closePage(page);
  }
}
