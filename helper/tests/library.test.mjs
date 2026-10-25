import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-library-'));
process.env.PS_AI_BRIDGE_DATA_DIR = dir;
const { config } = await import('../lib/config.mjs');
config.outputDir = path.join(dir, 'outputs');
const { saveUpload, useUpload } = await import('../lib/jobs.mjs');
const p = await import('../lib/presets.mjs');
const { libraryRoutes } = await import('../lib/library.mjs');
const call = (method, route = '', body) => libraryRoutes(method, ['library', ...route.split('/').filter(Boolean)], body);
const snapshot = () => call('GET');
const mutate = async (route, body) => call('POST', route, { expectedRevision: (await snapshot()).revision, ...body });
const picture = async color => sharp({ create: { width: 12, height: 8, channels: 4, background: color } }).png().toBuffer();
const add = async (color, extra = {}) => mutate('add', { uploadId: saveUpload(await picture(color), 'image/png'), name: '参考照片', source: { kind: 'file', name: 'original.png' }, ...extra });
const restart = source => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
  cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PS_AI_BRIDGE_DATA_DIR: dir }, encoding: 'utf8',
}));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a reference survives removal of the upload and a fresh helper process, including source and pixels', async () => {
  const bytes = await picture('#e03080'), uploadId = saveUpload(bytes, 'image/png');
  const added = await mutate('add', { uploadId, name: '裁切参考', source: { kind: 'photoshop', documentName: 'portrait.psd', docId: 42, session: 'ps-session', note: '局部选区' } });
  const ref = added.references.at(-1);
  fs.unlinkSync(useUpload(uploadId));
  const fresh = restart(`const {libraryRoutes:r}=await import('./lib/library.mjs'); const s=await r('GET',['library']); const f=await r('GET',['library','images',${JSON.stringify(ref.imageId)}]); console.log(JSON.stringify({s,base64:f.buffer.toString('base64'),type:f.type}));`);
  assert.equal(fresh.type, 'image/png');
  assert.equal(fresh.s.references.at(-1).source.documentName, 'portrait.psd');
  assert.equal(fresh.s.references.at(-1).source.docId, 42);
  const pixels = await sharp(Buffer.from(fresh.base64, 'base64')).raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 4)], [224, 48, 128, 255]);
  const upload = await mutate('uploads', { ids: [ref.id] });
  assert.ok(fs.existsSync(useUpload(upload.uploads[0].uploadId)));
});

test('invalid, truncated and vector uploads never create a library record', async () => {
  const before = await snapshot();
  for (const bytes of [Buffer.from('not an image'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), (await picture('red')).subarray(0, 40)]) {
    await assert.rejects(mutate('add', { uploadId: saveUpload(bytes, 'image/png'), source: { kind: 'file' } }));
  }
  await assert.rejects(mutate('add', { uploadId: '../../outside', source: { kind: 'file' } }), /失效/);
  assert.deepEqual(await snapshot(), before);
});

test('concurrent additions reject the stale writer instead of overwriting a decoded image', async () => {
  const revision = (await snapshot()).revision;
  const uploads = await Promise.all(['blue', 'green'].map(async c => saveUpload(await picture(c), 'image/png')));
  const result = await Promise.allSettled(uploads.map(uploadId => call('POST', 'add', { uploadId, source: { kind: 'clipboard' }, expectedRevision: revision })));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter(r => r.status === 'rejected').length, 1);
  assert.match(result.find(r => r.status === 'rejected').reason.message, /其他窗口/);
  assert.equal((await snapshot()).revision, revision + 1);
});

test('reordering persists exact order, rejects omissions/duplicates and source edits do not erase provenance', async () => {
  await add('yellow');
  const before = await snapshot(), ids = before.references.map(r => r.id).reverse();
  const reordered = await mutate('reorder', { ids });
  assert.deepEqual(reordered.references.map(r => r.id), ids);
  assert.deepEqual(restart("const {libraryRoutes:r}=await import('./lib/library.mjs');console.log(JSON.stringify((await r('GET',['library'])).references.map(x=>x.id)));"), ids);
  await assert.rejects(mutate('reorder', { ids: ids.slice(1) }), /全部/);
  await assert.rejects(mutate('reorder', { ids: ids.map(() => ids[0]) }), /不同/);
  const ref = reordered.references.find(r => r.source.kind === 'photoshop');
  const updated = await mutate('update', { id: ref.id, name: '来源照片', source: { ...ref.source, url: 'https://example.com/reference', note: '颜色参考' } });
  assert.equal(updated.references.find(r => r.id === ref.id).source.docId, 42);
  await assert.rejects(call('POST', 'delete', { ids: [ref.id], expectedRevision: before.revision }), /其他窗口/);
  assert.equal((await snapshot()).references.length, ids.length);
});

test('custom categories survive restart and existing /presets exports remain live', async () => {
  const c = await call('GET', 'categories');
  const created = await call('POST', 'categories', { name: '活动服饰', expectedRevision: c.revision });
  assert.ok(p.CATEGORIES.some(c => c.id === created.category.id));
  const a = p.savePreset({ title: '服饰细节', content: '织物细节', category: created.category.id });
  assert.equal(a.category, created.category.id);
  const fresh = restart(`const p=await import('./lib/presets.mjs');console.log(JSON.stringify({c:p.listCategories(),p:p.getPreset(${JSON.stringify(a.id)})}));`);
  assert.equal(fresh.p.category, created.category.id);
  assert.ok(fresh.c.categories.some(c => c.name === '活动服饰'));
  await assert.rejects(call('POST', 'categories', { name: '旧窗口', expectedRevision: c.revision }), /其他窗口/);
  await call('POST', 'categories', { id: created.category.id, name: '布料与服饰', expectedRevision: created.revision });
  assert.equal(p.getPreset(a.id).category, created.category.id);
  await assert.rejects(call('POST', 'categories', { id: 'head', name: '不能改', expectedRevision: created.revision + 1 }), /自定义/);
});

test('bulk move validates the entire selection before moving, preserves legacy siblings, and makes restorable revisions', async () => {
  const file = path.join(dir, 'presets', 'legacy-library.json');
  fs.writeFileSync(file, JSON.stringify({ origin: 'legacy-pack', presets: [
    { id: 'legacy-a', title: 'A', content: 'first', category: 'head', revision: 1 },
    { id: 'legacy-b', title: 'B', content: 'second', category: 'hair', revision: 1 },
    { id: 'legacy-c', title: 'C', content: 'untouched', category: 'other', revision: 1, custom: true },
  ] }));
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => p.bulkMovePresets({ ids: ['legacy-a', 'legacy-b'], category: 'clothing', expectedRevisions: { 'legacy-a': 1, 'legacy-b': 0 } }), /其他窗口/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const moved = p.bulkMovePresets({ ids: ['legacy-a', 'legacy-b'], category: 'clothing', expectedRevisions: { 'legacy-a': 1, 'legacy-b': 1 } });
  assert.deepEqual(moved.presets.map(p => p.category), ['clothing', 'clothing']);
  assert.equal(moved.presets[0].revision, 2);
  const disk = JSON.parse(fs.readFileSync(file));
  assert.equal(disk.origin, 'legacy-pack'); assert.equal(disk.presets[2].custom, true);
  assert.equal(p.restoreRevision('legacy-a', 1).category, 'head');
  assert.equal(p.getPreset('legacy-b').category, 'clothing');
});

test('exporting a custom category can be imported into an empty data directory', () => {
  const category = p.listCategories().categories.find(c => !c.builtin);
  const preset = p.savePreset({ title: '移机分类', content: 'keep category name', category: category.id });
  const pack = p.exportPresets([preset.id]);
  const migrated = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const p=await import('./lib/presets.mjs');const result=p.importPack(${JSON.stringify(pack)});console.log(JSON.stringify({p:p.getPreset(result.ids[0]),c:p.listCategories()}));
  `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PS_AI_BRIDGE_DATA_DIR: path.join(dir, 'fresh-install') }, encoding: 'utf8' }));
  assert.equal(migrated.c.categories.find(c => c.id === migrated.p.category).name, category.name);
  assert.equal(migrated.p.content, preset.content);
});

test('interrupted multi-file moves recover on restart before serving any preset', () => {
  const a = p.savePreset({ title: 'Recover A', content: 'original A', category: 'head' });
  const b = p.savePreset({ title: 'Recover B', content: 'original B', category: 'hair' });
  const result = restart(`
    import fs from 'node:fs';
    const p=await import('./lib/presets.mjs'); const rename=fs.renameSync; let failed=false;
    fs.renameSync=(src,dest)=>{ if(!failed && dest.endsWith('.json') && !dest.includes('.revisions') && !dest.endsWith('.move-transaction.json')) { failed=true; throw new Error('simulated power loss'); } return rename(src,dest); };
    try { p.bulkMovePresets({ids:${JSON.stringify([a.id, b.id])},category:'lighting',expectedRevisions:${JSON.stringify({ [a.id]: 1, [b.id]: 1 })}}); } catch(e) { console.log(JSON.stringify({message:e.message})); }
  `);
  assert.match(result.message, /power loss/);
  const recovered = restart(`const p=await import('./lib/presets.mjs');console.log(JSON.stringify(${JSON.stringify([a.id, b.id])}.map(id=>p.getPreset(id))));`);
  assert.deepEqual(recovered.map(x => x.category), ['lighting', 'lighting']);
  assert.deepEqual(recovered.map(x => x.revision), [2, 2]);
  assert.deepEqual(recovered.map(x => x.content), ['original A', 'original B']);
});

test('field history preserves literal replacement text, ranges, and survives preset content changes', async () => {
  let a = p.savePreset({ title: 'Fields', content: '"@param:曝光":-1e0,"@param:曝光_range":[-5,5],"@param:曝光_step":0.1; 【填空:材质=丝绸】 / 【填空:材质=丝绸】' });
  const result = await call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 0, params: { 曝光: 1.2 }, fills: { 材质: '$& $1 铜' } });
  assert.match(result.content, /"@param:曝光":1.2,/);
  assert.equal(result.content.split('【填空:材质=$& $1 铜】').length, 3);
  assert.equal(result.modified, true); assert.equal(p.getPreset(a.id).content, a.content);
  await assert.rejects(call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 1, params: { 曝光: 6 } }), /范围/);
  await assert.rejects(call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 1, params: { 曝光: 1.25 } }), /步长/);
  await assert.rejects(call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 1, fills: { 未声明: 'text' } }), /无效/);
  await assert.rejects(call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 0, fills: { 材质: 'new' } }), /历史/);
  a = p.savePreset({ ...a, expectedRevision: 1, title: 'Renamed' });
  const history = restart(`const p=await import('./lib/presets.mjs');console.log(JSON.stringify(p.getFieldHistory(${JSON.stringify(a.id)})));`);
  assert.equal(history.entries[0].fills.材质, '$& $1 铜');
  await assert.rejects(call('POST', 'fields', { id: a.id, expectedPresetRevision: 1, expectedRevision: 1 }), /其他窗口/);
  for (let i = 0; i < 35; i++) await call('POST', 'fields', { id: a.id, expectedPresetRevision: a.revision, expectedRevision: p.getFieldHistory(a.id).revision, fills: { 材质: `cloth ${i}` } });
  assert.equal(p.getFieldHistory(a.id).entries.length, 30);
  await call('POST', 'fields', { id: a.id, expectedPresetRevision: a.revision, expectedRevision: p.getFieldHistory(a.id).revision, fills: { 材质: 'cloth 34' } });
  assert.equal(p.getFieldHistory(a.id).entries.length, 30);
});

test('reference attachment retains order and embeds portable images and sources', async () => {
  const before = await snapshot(), refs = before.references.slice(0, 2);
  const preset = p.savePreset({ title: 'Portable refs', content: '参考纹理' });
  const attached = await mutate('attach-preset', { presetId: preset.id, expectedPresetRevision: preset.revision, ids: refs.map(r => r.id) });
  assert.deepEqual(attached.preset.referenceSources.map(r => r.libraryId), refs.map(r => r.id));
  const pack = p.exportPresets([preset.id]);
  await mutate('delete', { ids: refs.map(r => r.id) });
  p.deletePreset(preset.id);
  const imported = p.importPack(pack), restored = p.getPreset(imported.ids[0]);
  assert.deepEqual(restored.refImages, attached.preset.refImages);
  assert.deepEqual(restored.referenceSources, attached.preset.referenceSources);
  assert.equal((await sharp(Buffer.from(restored.refImages[0], 'base64')).metadata()).width, 12);
});

test('hotspot geometry, visibility, layers and custom image survive reload; invalid layouts do not replace them', async () => {
  const s = await add('purple'), r = s.references.at(-1);
  const board = { imageId: r.imageId, hotspots: [
    { id: 'head-zone', category: 'head', x: .2, y: .1, width: .3, height: .2, z: 4, visible: true },
    { id: 'hair-zone', category: 'hair', x: .25, y: .08, width: .25, height: .1, z: 8, visible: false },
  ] };
  const saved = await mutate('board', { board });
  const fresh = restart("const {libraryRoutes:r}=await import('./lib/library.mjs');console.log(JSON.stringify(await r('GET',['library'])));");
  assert.deepEqual(fresh.board.hotspots, board.hotspots); assert.equal(fresh.board.imageId, r.imageId);
  await assert.rejects(mutate('board', { board: { ...board, hotspots: [{ ...board.hotspots[0], x: .95 }] } }), /位置/);
  await assert.rejects(mutate('board', { board: { ...board, hotspots: [{ ...board.hotspots[0], category: 'missing' }] } }), /分类/);
  await assert.rejects(mutate('board', { board: { imageId: '../secret', hotspots: [] } }), /上传/);
  assert.equal((await snapshot()).revision, saved.revision);
  // Removing a reference must not break the background that shares its pixels.
  await mutate('delete', { ids: [r.id] });
  assert.equal((await call('GET', `images/${r.imageId}`)).type, 'image/png');
});

test('unknown routes and missing images are not mistaken for a successful library listing', async () => {
  assert.equal(await call('GET', 'not-a-route'), null);
  assert.equal(await call('POST', 'not-a-route', {}), null);
  assert.equal(await libraryRoutes('GET', ['other']), null);
  assert.equal(await call('GET', 'images/../../secret'), null);
  await assert.rejects(libraryRoutes('GET', ['library', 'images', '../../secret']), /不存在/);
  await assert.rejects(call('GET', `images/${'0'.repeat(64)}`), /不存在/);
});

test('corrupt library storage fails closed without overwriting it', async () => {
  const file = path.join(dir, 'library', 'library.json'), previous = fs.readFileSync(file);
  fs.writeFileSync(file, '{damaged');
  try {
    await assert.rejects(snapshot());
    await assert.rejects(call('POST', 'delete', { expectedRevision: 0, ids: ['anything'] }));
    assert.equal(fs.readFileSync(file, 'utf8'), '{damaged');
  } finally { fs.writeFileSync(file, previous); }
});

test('renderer loads its dynamic tab, saves a dragged layout, groups presets and recalls field history', { skip: !fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }, async () => {
  const { chromium } = await import('playwright-core');
  const http = await import('node:http');
  const renderer = path.resolve(import.meta.dirname, '../../desktop/src/renderer');
  const uiPreset = p.savePreset({ title: 'UI movable', content: '"@param:光":0.5,"@param:光_range":[0,1,0.1] 【填空:颜色=白色】', category: 'other' });
  await add('cyan');
  let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Electron file selection and IPC are the boundary stubs; renderer code and
  // persistence routes are real. No generation or external service is invoked.
  html = html.replace('</head>', '<link rel="stylesheet" href="library.css"></head>');
  const fixtureBridge = `window.bridge={api:async(method,path,body)=>{const r=await fetch(path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error);return d;}};`;
  html = html.replace('</body>', '<script src="fixture-bridge.js"></script><script src="common.js"></script><script src="workspace.js"></script><script src="fixture-work.js"></script><script src="preset-manager.js"></script><script src="library.js"></script></body>');
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname, parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(html); }
      if (pathname === '/fixture-bridge.js' || pathname === '/fixture-work.js') { res.setHeader('content-type', 'text/javascript'); return res.end(pathname === '/fixture-bridge.js' ? fixtureBridge : 'work.base=location.origin;'); }
      if (/^\/[\w-]+\.(js|css)$/.test(pathname)) { res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css'); return res.end(fs.readFileSync(path.join(renderer, pathname.slice(1)))); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      let data;
      if (parts[0] === 'library') data = await libraryRoutes(req.method, parts, body);
      else if (pathname === '/presets') data = { presets: p.listPresets(), categories: p.listCategories().categories };
      else if (parts[0] === 'presets' && parts[2] === 'revisions') data = { revisions: p.listRevisions(parts[1]) };
      else if (parts[0] === 'presets') data = p.getPreset(parts[1]);
      else if (pathname === '/jobs') data = { jobs: [] };
      else { res.statusCode = 404; data = { error: 'not found' }; }
      if (data?.buffer) { res.setHeader('content-type', data.type); return res.end(data.buffer); }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
    } catch (e) { res.statusCode = e.statusCode || 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-tab="library"]').click();
    await page.waitForFunction(() => document.querySelector('#libStatus').textContent === '已加载 / 已保存', null, { timeout: 5000 }).catch(async e => { throw new Error(`${e.message}; ${await page.locator('#libStatus').textContent()}; ${errors.join('; ')}`); });
    assert.equal(await page.locator('#tab-library').isVisible(), true);
    assert.ok(await page.locator('.library-ref').count() > 0);
    const [x, y] = await page.locator('[data-hotspot="head-zone"]').evaluate(el => [parseFloat(el.style.left), parseFloat(el.style.top)]);
    await page.locator('#libEditBoard').check();
    const hot = page.locator('[data-hotspot="head-zone"]');
    const bounds = await hot.boundingBox();
    await page.mouse.move(bounds.x + 8, bounds.y + 8); await page.mouse.down();
    await page.mouse.move(bounds.x + 30, bounds.y + 28, { steps: 4 }); await page.mouse.up();
    await page.locator('#libBoardSave').click();
    await page.waitForFunction(() => document.querySelector('#libStatus').textContent === '已加载 / 已保存');
    const saved = (await snapshot()).board.hotspots.find(h => h.id === 'head-zone');
    assert.ok(saved.x > x / 100 && saved.y > y / 100);
    await page.locator('#libEditBoard').uncheck();
    await page.locator('#libSearch').fill('UI movable');
    // Exercise the actual dataTransfer handlers against the route, not a direct
    // invocation of an internal renderer function.
    await page.locator(`[data-preset="${uiPreset.id}"]`).dragTo(page.locator('[data-hotspot="head-zone"]'));
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '分类已保存');
    assert.equal(p.getPreset(uiPreset.id).category, 'head');
    await page.locator('[data-tab="presets"]').click();
    await page.locator(`[data-edit="${uiPreset.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#pmFieldStatus').textContent.includes('当前为预设默认值'));
    await page.locator('#pmFieldPanel').evaluate(el => { el.open = true; });
    await page.locator('[data-pm-fill="0"]').fill('青色 $&');
    await page.locator('[data-pm-param="0"]').fill('0.7');
    await page.locator('#pmUse').click();
    await page.waitForFunction(() => !document.querySelector('#tab-work').hidden);
    assert.match(await page.locator('#genPrompt').inputValue(), /青色 \$&/);
    assert.equal(p.getFieldHistory(uiPreset.id).entries[0].params.光, .7);
    assert.equal(p.getPreset(uiPreset.id).content, uiPreset.content);
    await page.reload(); await page.locator('[data-tab="presets"]').click();
    await page.locator(`[data-edit="${uiPreset.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#pmFieldHistory').options.length > 1);
    await page.locator('#pmFieldPanel').evaluate(el => { el.open = true; });
    await page.locator('#pmFieldHistory').selectOption({ index: 1 }); await page.locator('#pmFieldRestore').click();
    assert.equal(await page.locator('[data-pm-fill="0"]').inputValue(), '青色 $&');
    assert.equal(await page.locator('[data-pm-param="0"]').inputValue(), '0.7');
    await page.locator('#pmUse').click();
    await page.waitForFunction(() => !document.querySelector('#tab-work').hidden);
    await page.locator('#fillList [data-fill="0"]').fill('绿色 $&');
    await page.locator('#fillList [data-fill="0"]').press('Tab');
    await page.waitForFunction(() => document.querySelector('#workFieldHistoryStatus').textContent === '字段历史已保存');
    assert.equal(p.getFieldHistory(uiPreset.id).entries[0].fills.颜色, '绿色 $&');
    assert.match(await page.locator('#genPrompt').inputValue(), /【填空:颜色=绿色 \$&】/);
    await page.locator('#genPrompt').fill('手动提示词草稿');
    await page.locator('#workFieldHistory').evaluate(el => { el.open = true; });
    await page.locator('#workFieldHistorySelect').selectOption({ index: 1 });
    await page.locator('#workFieldHistoryRestore').click();
    assert.equal(await page.locator('#genPrompt').inputValue(), '手动提示词草稿');
    const referenceLimits = await page.evaluate(async () => {
      $('provider').innerHTML = '<option value="fixture">fixture</option>';
      work.health = { providers: { fixture: { maxReferences: 5 } } };
      work.refs = [];
      await addRefs(Array.from({ length: 5 }, (_, i) => ({ uploadId: `fixture-${i}`, name: `参考 ${i}` })));
      const count = work.refs.length;
      let error = '';
      try { await addRefs([{ uploadId: 'overflow' }]); } catch (e) { error = e.message; }
      return { count, after: work.refs.length, error };
    });
    assert.equal(referenceLimits.count, 5); assert.equal(referenceLimits.after, 5); assert.match(referenceLimits.error, /最多支持 5/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
