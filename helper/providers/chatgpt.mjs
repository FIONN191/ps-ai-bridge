// ChatGPT 网页（GPT Image）：在专用项目「PS AI Bridge」里开新对话 → 上传原图 → 发「生成一张图片，比例 x：提示词」→ 取最后一张生成图。
// 临时对话用不了生图工具，所以用普通对话；放在项目里，不混进「最近聊天」。
// 思考强度是账号偏好，改了会影响用户平时用，这里不动它。
import fs from 'node:fs';
import path from 'node:path';
import { newPage, closePage, isChromeUp } from '../lib/chrome.mjs';
import { getPrefs } from '../lib/prefs.mjs';
import { imageSize, extFromMime } from '../lib/image.mjs';
import { readState, writeState } from '../lib/state.mjs';

export const CHATGPT_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
const PROJECT_NAME = 'PS AI Bridge';
const GENERATED = /Generated image|已生成图像|生成的图片/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openProject(log) {
  const saved = readState().chatgptProjectUrl;
  const page = await newPage(saved || 'https://chatgpt.com/');
  await page.locator('form').first().waitFor({ timeout: 45000 });
  if (await page.getByRole('button', { name: /^Log in$|^登录$/ }).count()) {
    throw new Error('专用 Chrome 里还没登录 ChatGPT，请先在那个窗口登录 chatgpt.com');
  }
  if (saved && /\/project/.test(page.url())) return page;

  log(`新建 ChatGPT 项目「${PROJECT_NAME}」`);
  await page.getByRole('button', { name: 'Add new project' }).dispatchEvent('click');
  const dlg = page.getByRole('dialog', { name: 'Create project' });
  await dlg.getByRole('textbox', { name: 'Project name' }).fill(PROJECT_NAME);
  await dlg.getByRole('button', { name: 'Create project' }).click({ force: true });
  await page.waitForURL(/\/project/, { timeout: 30000 });
  writeState({ chatgptProjectUrl: page.url().split('?')[0] });
  await page.locator('form').first().waitFor({ timeout: 45000 });
  return page;
}

const pageState = (page) => page.evaluate((src) => {
  const re = new RegExp(src);
  const generated = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 400 && re.test(i.alt));
  const running = Boolean(document.querySelector('[data-testid="stop-button"]'))
    || [...document.querySelectorAll('button')].some((b) => /^(Stop|停止)/i.test(b.getAttribute('aria-label') || ''));
  const turns = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const lastText = turns.length ? turns[turns.length - 1].innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { images: generated.length, last: generated.length ? generated[generated.length - 1].src : null, running, lastText, inChat: /\/c\//.test(location.pathname) };
}, GENERATED.source);

export const chatgpt = {
  label: 'GPT Image · ChatGPT 网页',
  async status() {
    return { available: true, chrome: await isChromeUp() };
  },
  async run(job, { log, signal }) {
    if (!CHATGPT_ASPECTS.includes(job.aspect)) throw new Error(`ChatGPT 不支持比例 ${job.aspect}`);

    log('打开 ChatGPT 项目');
    const page = await openProject(log);
    let ok = false;
    try {
      const form = page.locator('form').first();

      const files = [job.inputPath, ...(job.refPaths || [])].filter(Boolean);
      if (files.length) {
        log(files.length > 1 ? `上传原图和 ${files.length - 1} 张参考图` : '上传原图');
        // 用任务 id 做文件名，方便在对话里认出来；顺序就是图1、图2…
        const named = files.map((f, i) => {
          const p = path.join(job.dir, `${job.id}-${i + 1}${path.extname(f)}`);
          fs.copyFileSync(f, p);
          return p;
        });
        await form.locator('input[type=file][accept="image/*"][multiple]').first().setInputFiles(named);
        for (const p of named) await form.getByRole('button', { name: path.basename(p), exact: true }).waitFor({ timeout: 30000 });
        // 上传没完成就点发送会被忽略
        for (let i = 0; i < 120 && (await form.getByRole('progressbar').count()); i++) await sleep(500);
      }

      await form.getByRole('textbox').first().click({ force: true });
      await page.keyboard.insertText(`生成一张图片，比例 ${job.aspect}：${job.prompt}`);
      const send = form.getByRole('button', { name: /^(Send|发送)/ }).first();
      for (let i = 0; i < 40 && (!(await send.count()) || (await send.isDisabled())); i++) await sleep(500);
      if (!(await send.count()) || (await send.isDisabled())) throw new Error('ChatGPT 的发送按钮一直不能点');
      await send.click({ force: true });
      log('生成中…（GPT Image 一般 1 分钟左右）');

      const t0 = Date.now();
      let st;
      let started = false;
      let stableSince = 0;
      while (true) {
        if (signal.aborted) throw new Error('已取消');
        await sleep(3000);
        st = await pageState(page);
        if (st.running || st.inChat) started = true;
        const secs = Math.round((Date.now() - t0) / 1000);
        if (secs % 15 < 3) log(`生成中… ${secs}s`);
        if (!started && Date.now() - t0 > 30000) throw new Error('消息没有发出去');
        if (started && !st.running) {
          if (st.images) {
            // 生成图会先出模糊预览再换成成品，停下来后再等一轮确认
            if (!stableSince) stableSince = Date.now();
            else if (Date.now() - stableSince > 3000) break;
          } else if (Date.now() - t0 > 15000) {
            throw new Error(`ChatGPT 没有出图：${st.lastText || '未知原因'}`);
          }
        } else stableSince = 0;
        if (Date.now() - t0 > 6 * 60 * 1000) throw new Error('等了 6 分钟还没出图');
      }

      log('取回结果');
      const img = await page.evaluate(async (src) => {
        const re = new RegExp(src);
        const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 400 && re.test(i.alt));
        const el = imgs[imgs.length - 1];
        const blob = await fetch(el.src).then((r) => r.blob());
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return { type: blob.type, b64: btoa(s) };
      }, GENERATED.source);
      const out = path.join(job.dir, `result-chatgpt.${extFromMime(img.type)}`);
      fs.writeFileSync(out, Buffer.from(img.b64, 'base64'));
      ok = true;
      return { path: out, ...(await imageSize(out)), source: 'ChatGPT 网页 · GPT Image' };
    } finally {
      // 出图成功后按设置决定关不关（默认留着）；失败的标签页留着方便看卡在哪
      if (ok && getPrefs().closeTabsAfterDone) await closePage(page);
    }
  },
};
