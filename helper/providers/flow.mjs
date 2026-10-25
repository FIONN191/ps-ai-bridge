// Google Flow（flow.google.com）：在一个专用项目「PS AI Bridge」里生图。
// 流程：开项目 → 设置（图片 / 比例 / 模型 / x1）→ 上传原图到提示框 → 开始生成 → 等新图块 → 用图块菜单「下载 → 1K / 2K」取图。
import fs from 'node:fs';
import path from 'node:path';
import { newPage, closePage, isChromeUp } from '../lib/chrome.mjs';
import { getPrefs } from '../lib/prefs.mjs';
import { imageSize } from '../lib/image.mjs';
import { readState, writeState } from '../lib/state.mjs';

export const FLOW_MODELS = { 'nano-banana-2.1': 'Nano Banana 2.1', 'nano-banana-pro': 'Nano Banana Pro', 'nano-banana-2-lite': 'Nano Banana 2 Lite' };
export const FLOW_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
// 4K 要更高档的 Google One 会员，当前账号是灰的
const DOWNLOAD_LABEL = { '1K': '1K 原始尺寸', '2K': '2K 已高清重塑' };
const PROJECT_NAME = 'PS AI Bridge';
const HOME = 'https://flow.google.com/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openProject(log) {
  const saved = readState().flowProjectUrl;
  if (saved) {
    const page = await newPage(saved);
    await page.getByRole('textbox', { name: '您希望创作什么？' }).waitFor({ timeout: 45000 }).catch(() => {});
    if (page.url().startsWith(saved)) return page;
    await closePage(page);
  }
  log(`新建 Flow 项目「${PROJECT_NAME}」`);
  const page = await newPage(HOME);
  if (/accounts\.google\.com/.test(page.url())) throw new Error('专用 Chrome 里还没登录 Google，请先在那个窗口登录 Flow');
  await page.getByText('新建项目').first().waitFor({ timeout: 45000 });
  await page.getByText('新建项目').first().dispatchEvent('click');
  await page.waitForURL(/\/project\//, { timeout: 45000 });
  await page.getByRole('textbox', { name: '您希望创作什么？' }).waitFor({ timeout: 45000 });
  const title = page.getByRole('textbox', { name: '可编辑文本' });
  await title.click({ force: true }).catch(() => {});
  await title.fill(PROJECT_NAME).catch(() => {});
  await title.press('Enter').catch(() => {});
  writeState({ flowProjectUrl: page.url().split('?')[0] });
  return page;
}

async function openSettings(page) {
  for (let i = 0; i < 4; i++) {
    if (await page.getByRole('radio', { name: 'x1' }).count()) return;
    await page.getByRole('button', { name: '设置触发器' }).click({ force: true });
    await sleep(800);
  }
  throw new Error('打不开 Flow 的生成设置，页面可能改版了');
}

async function chooseRadio(page, name) {
  const r = page.getByRole('radio', { name, exact: true });
  if (!(await r.count())) throw new Error(`Flow 设置里没有「${name}」`);
  if ((await r.getAttribute('aria-checked')) !== 'true') await r.click({ force: true });
}

// 图块：每张图是一个 role=group 的 flow-grid-tile-container，用图片地址里的 id 区分新旧
const tileIds = (page) => page.evaluate(() => [...document.querySelectorAll('flow-grid-tile-container')].map((t) => {
  const img = t.querySelector('img');
  const m = img && /flow-content\.google\/image\/([\w-]+)/.exec(img.src);
  return { id: m ? m[1] : null, label: t.getAttribute('aria-label') || '', loaded: Boolean(img && img.naturalWidth > 0) };
}));

const progressTexts = (page) => page.evaluate(() => [...document.querySelectorAll('main *')]
  .filter((e) => e.childElementCount === 0 && /^\d{1,2}%$/.test(e.textContent.trim())).map((e) => e.textContent.trim()));

export const flow = {
  label: 'Nano Banana · Google Flow',
  async status() {
    return { available: true, chrome: await isChromeUp() };
  },
  async run(job, { log, signal }) {
    const model = FLOW_MODELS[job.model || 'nano-banana-2.1'];
    if (!model) throw new Error(`Flow 没有模型 ${job.model}`);
    if (!FLOW_ASPECTS.includes(job.aspect)) throw new Error(`Flow 不支持比例 ${job.aspect}`);
    const dlLabel = DOWNLOAD_LABEL[job.resolution];
    if (!dlLabel) throw new Error(`Flow 只能下载 1K / 2K（选的是 ${job.resolution}）`);

    log('打开 Flow 项目');
    const page = await openProject(log);
    let ok = false;
    try {
      const box = page.getByRole('textbox', { name: '您希望创作什么？' });
      await box.waitFor({ timeout: 45000 });

      log(`设置参数：${job.aspect} · ${model} · x1`);
      await openSettings(page);
      await chooseRadio(page, '图片');
      await chooseRadio(page, job.aspect);
      await chooseRadio(page, 'x1');
      const modelBtn = page.getByRole('button', { name: '选择模型系列' });
      if (!(await modelBtn.innerText()).includes(model)) {
        await modelBtn.click({ force: true });
        const item = page.getByRole('menuitem', { name: new RegExp(`${model}$`) });
        await item.first().waitFor({ timeout: 8000 });
        await item.first().click({ force: true });
        await sleep(500);
      }
      const cost = await page.getByText(/生成将消耗/).first().locator('..').innerText().catch(() => '');
      if (cost) log(cost.replace(/\s+/g, ' '));
      await page.keyboard.press('Escape');
      await sleep(300);
      const trigger = (await page.getByRole('button', { name: '设置触发器' }).innerText()).replace(/\s+/g, ' ');
      if (!trigger.includes(model) || !/x1/.test(trigger)) throw new Error(`Flow 设置没生效：${trigger}`);

      // 先清空上次留下的提示和素材，再挂参考图、写提示词
      const clear = page.getByRole('button', { name: '清除提示' });
      if (await clear.count()) await clear.click({ force: true });

      const uploadNames = [];
      const files = [job.inputPath, ...(job.refPaths || [])].filter(Boolean);
      if (files.length) {
        log(files.length > 1 ? `上传原图和 ${files.length - 1} 张参考图` : '上传原图');
        await page.getByRole('button', { name: '在提示框中添加素材' }).click({ force: true });
        const uploadBtn = page.getByRole('button', { name: '上传媒体内容' });
        await uploadBtn.waitFor({ timeout: 10000 });
        // 用任务 id 做文件名，方便在素材库和图库里认出这次上传的图
        const named = files.map((f, i) => {
          const name = `${job.id}-${i + 1}${path.extname(f)}`;
          fs.copyFileSync(f, path.join(job.dir, name));
          uploadNames.push(name);
          return path.join(job.dir, name);
        });
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), uploadBtn.click({ force: true })]);
        await chooser.setFiles(named);
        // 上传完只是进了素材库；要逐张选中再点「添加到提示」，参考图才会挂到提示框上
        const list = page.getByRole('listbox', { name: '资源列表' });
        for (const name of uploadNames) {
          const option = list.getByRole('option').filter({ hasText: name }).first();
          await option.waitFor({ timeout: 60000 });
          for (let i = 0; i < 90 && /正在上传/.test(await option.innerText()); i++) await sleep(1000);
        }
        for (const name of uploadNames) {
          const option = list.getByRole('option').filter({ hasText: name }).first();
          if ((await option.getAttribute('aria-selected')) !== 'true') await option.click({ force: true, modifiers: uploadNames.length > 1 ? ['Meta'] : [] });
          await sleep(300);
        }
        const add = page.getByRole('button', { name: '添加到提示' });
        for (let i = 0; i < 20 && (await add.isDisabled()); i++) await sleep(500);
        await add.click({ force: true });
        await page.getByRole('button', { name: '素材', exact: true }).first().waitFor({ timeout: 15000 })
          .catch(() => { throw new Error('参考图没能挂到 Flow 的提示框上'); });
        const attached = await page.getByRole('button', { name: '素材', exact: true }).count();
        if (attached < files.length) log(`注意：Flow 提示框上只挂上了 ${attached} 张图`);
      }

      await box.click({ force: true });
      await page.keyboard.insertText(job.prompt);
      await sleep(300);

      const before = new Set((await tileIds(page)).map((t) => t.id));
      const go = page.getByRole('button', { name: '开始生成' });
      if (await go.isDisabled()) throw new Error('「开始生成」按钮不能点');
      await go.click({ force: true });
      log('生成中…');

      const t0 = Date.now();
      let fresh = null;
      while (!fresh) {
        if (signal.aborted) throw new Error('已取消');
        await sleep(2000);
        const tiles = await tileIds(page);
        const prog = await progressTexts(page);
        const secs = Math.round((Date.now() - t0) / 1000);
        if (secs % 10 === 0) log(`生成中… ${secs}s${prog.length ? ' ' + prog.join(' ') : ''}`);
        fresh = tiles.find((t) => t.id && !before.has(t.id) && !uploadNames.includes(t.label) && t.loaded && !prog.length) || null;
        if (!fresh && Date.now() - t0 > 30000 && !prog.length) {
          const err = await page.evaluate(() => [...document.querySelectorAll('flow-grid-tile-container, [role=alert], mat-snack-bar-container')]
            .map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter((s) => /失败|错误|无法|政策|error|fail/i.test(s)).slice(0, 2).join(' / '));
          if (err) throw new Error(`Flow 没有出图：${err}`);
        }
        if (Date.now() - t0 > 5 * 60 * 1000) throw new Error('等了 5 分钟还没出图');
      }

      log(`下载 ${dlLabel}`);
      const tile = page.locator('flow-grid-tile-container').filter({ has: page.locator(`img[src*="${fresh.id}"]`) }).first();
      for (let i = 0; i < 4 && !(await page.getByRole('menuitem', { name: '下载' }).count()); i++) {
        await tile.hover({ force: true });
        await tile.getByRole('button', { name: '更多选项' }).click({ force: true });
        await sleep(1000);
      }
      await page.getByRole('menuitem', { name: '下载' }).click({ force: true });
      const item = page.getByRole('menuitem', { name: dlLabel });
      await item.waitFor({ timeout: 8000 });
      if (await item.isDisabled()) throw new Error(`Flow 的「${dlLabel}」不可用（可能需要更高档会员）`);
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), item.click({ force: true })]);
      const ext = path.extname(download.suggestedFilename()) || '.jpg';
      const out = path.join(job.dir, `result-flow-${job.resolution}${ext}`);
      await download.saveAs(out);
      ok = true;
      return { path: out, ...(await imageSize(out)), source: `Flow · ${model}` };
    } finally {
      // 出图成功后按设置决定关不关（默认留着）；失败的标签页留着方便看卡在哪
      if (ok && getPrefs().closeTabsAfterDone) await closePage(page);
    }
  },
};
