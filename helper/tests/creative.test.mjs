import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-creative-'));
process.env.PS_AI_BRIDGE_DATA_DIR = dir;
const { config } = await import('../lib/config.mjs'); config.outputDir = path.join(dir, 'outputs');
const jobs = await import('../lib/jobs.mjs');
const { createCreative, validateGraph, composeCreative, stitchImages, normalizeRig, validateCreativeProposal } = await import('../lib/creative.mjs');
const png = (colour, width = 20, height = 12) => sharp({ create: { width, height, channels: 4, background: colour } }).png().toBuffer();
const source = await png({ r: 120, g: 60, b: 30, alpha: .5 });
const submitted = [];
let failNext = false, prepareFails = false, nativeNext = false;
const ctx = {
  providers: { fake: {
    prepare() { if (prepareFails) { prepareFails = false; throw new Error('uncertain prepare'); } },
    async run(j) {
      submitted.push({ id: j.id, prompt: j.prompt, meta: structuredClone(j.meta), input: j.inputPath ? fs.readFileSync(j.inputPath) : null, references: j.refPaths.map(p => fs.readFileSync(p)) });
      if (failNext) { failNext = false; throw new Error('test upstream failure'); }
      if (nativeNext || j.prompt === 'native-multi') {
        nativeNext = false; const candidates = [];
        for (const [index, colour] of ['red', 'blue'].entries()) {
          const file = path.join(j.dir, `native-${index}.png`); fs.writeFileSync(file, await png(colour));
          candidates.push({ id: `candidate-${index + 1}`, index, path: file, width: 20, height: 12, source: 'fake' });
        }
        return { candidates };
      }
      const out = path.join(j.dir, 'generated.png');
      await sharp(j.prompt === 'blue' ? await png('blue') : j.inputPath || source).png().toFile(out);
      const m = await sharp(out).metadata(); return { path: out, width: m.width, height: m.height };
    }
  } },
  capabilities: { fake: { aspects: ['1:1', '3:4'], resolutions: ['2K'], maxReferences: 2 } },
  runs: { async route() { return { runs: runResults }; } }
};
let runResults = [], creative = createCreative(ctx);
const post = (route, body = {}) => creative.route('POST', route.split('/'), body);
const get = route => creative.route('GET', route.split('/'));
const node = (id, type, inputs = [], cfg = {}) => ({ id, type, title: id, inputs, config: cfg, position: { x: 40, y: 50 } });
const upload = () => jobs.saveUpload(source, 'image/png');
const generator = (id, inputs, prompt = 'blue', count = 1) => node(id, 'generate', inputs, { provider: 'fake', prompt, aspect: '1:1', resolution: '2K', count });
const graph = (count = 1) => ({ nodes: [node('image', 'image', [], { uploadId: upload() }), generator('gen', ['image'], 'blue', count), node('pick', 'candidate', ['gen']), node('out', 'output', ['pick'])] });
async function start(c) { const r = await post(`canvases/${c.id}/review`); return post(`canvases/${c.id}/start`, { token: r.token, reviewed: true }); }
async function settle() { for (let i = 0; i < 400 && jobs.listJobs().some(j => ['queued', 'running'].includes(j.status)); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(jobs.listJobs().every(j => !['queued', 'running'].includes(j.status)), 'mock jobs settled'); }
async function drive(id, until = 'awaiting-selection') {
  for (let i = 0; i < 25; i++) { await creative.tick(); await settle(); const e = await get(`executions/${id}`); if (e.status === until || ['needs-attention', 'done'].includes(e.status)) return e; }
  throw new Error('execution did not settle');
}
const executionFile = id => path.join(dir, 'workbench', 'creative', 'executions', `${id}.json`);
const selected = async (e, pick = 'pick', gen = 'gen', index = 0) => post(`executions/${e.id}/select`, { nodeId: pick, jobId: e.nodes[gen].slots[index].jobId });

const posterSource = '展览公告\n2026年10月26日\n地点：悉尼';
const lightProposal = () => ({ kind: 'lights', summary: '根据左侧亮面估计主光', lights: [{ name: '估计左侧主光', x: -3, y: 2, z: 4, intensity: 1.4, temperature: 4800, color: '#ffeedd', fixture: 'softbox', evidence: '主体左侧较亮，右侧阴影；无法确定实际灯具', confidence: .55 }], uncertainties: ['灯位和色温仅为估计，无法恢复物理参数'] });
const pageProposal = () => ({ kind: 'pages', summary: '按原文组织活动信息', pages: [{ headline: '展览公告', subtitle: '2026年10月26日', body: '地点：悉尼', sourceQuotes: [posterSource] }], uncertainties: ['原文没有票价'] });
function mockAssistant(respond = request => request.messages[0].content.includes('"kind":"lights"') ? lightProposal() : pageProposal()) {
  const settingsFile = path.join(dir, 'api-channels.json'), old = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null, originalFetch = globalThis.fetch, calls = [];
  fs.writeFileSync(settingsFile, JSON.stringify({ schema: 1, revision: 1, assistId: 'test-assist', profiles: [{ id: 'test-assist', title: 'Mock vision', enabled: true, url: 'https://creative-assistant.invalid', key: 'fake-test-key', textModel: 'fake-vision' }] }));
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://creative-assistant.invalid/v1/chat/completions', 'no real network in assistant test');
    const request = JSON.parse(options.body); calls.push(request);
    const result = await respond(request, options.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] }) };
  };
  return { calls, restore() { globalThis.fetch = originalFetch; if (old) fs.writeFileSync(settingsFile, old); else fs.rmSync(settingsFile, { force: true }); } };
}
test('analysis proposal schemas reject actions, unsupported keys, coerced numbers and ungrounded poster facts', () => {
  assert.equal(validateCreativeProposal(JSON.stringify(lightProposal()), 'lights').lights.length, 1);
  assert.equal(validateCreativeProposal(pageProposal(), 'pages', posterSource).pages.length, 1);
  assert.throws(() => validateCreativeProposal('```json\n{}\n```', 'lights'), /JSON/);
  assert.throws(() => validateCreativeProposal({ ...lightProposal(), action: 'start' }, 'lights'), /字段/);
  const wrong = lightProposal(); wrong.lights[0].x = '3'; assert.throws(() => validateCreativeProposal(wrong, 'lights'), /数值/);
  wrong.lights[0].x = 33; assert.throws(() => validateCreativeProposal(wrong, 'lights'), /范围/);
  const invented = pageProposal(); invented.pages[0].body = '免费入场'; assert.throws(() => validateCreativeProposal(invented, 'pages', posterSource), /原文摘录/);
  invented.pages[0].sourceQuotes = ['免费入场']; assert.throws(() => validateCreativeProposal(invented, 'pages', posterSource), /原文中/);
  const unsafe = lightProposal(); unsafe.lights[0].provider = 'paid-model'; assert.throws(() => validateCreativeProposal(unsafe, 'lights'), /字段/);
});
test('vision proposals use real channelChat image serialization, durable preview and explicit draft-only apply', async () => {
  const mock = mockAssistant();
  try {
    const asset = await post('assets', { uploadId: upload() }), count = jobs.listJobs().length;
    const body = { kind: 'lights', backend: 'channel', assetId: asset.assetId, requestId: 'lights-test' };
    let p = await post('proposals', body);
    assert.equal(p.status, 'ready'); assert.equal(jobs.listJobs().length, count);
    const content = mock.calls[0].messages[1].content;
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal((await post('proposals', body)).id, p.id); assert.equal(mock.calls.length, 1);
    await assert.rejects(() => post(`proposals/${p.id}/apply`, { approved: false, revision: p.revision }), /明确应用/);
    await assert.rejects(() => post(`proposals/${p.id}/apply`, { approved: true, revision: 'stale' }), /版本/);
    await creative.close(); creative = createCreative(ctx); p = await get(`proposals/${p.id}`);
    const applied = await post(`proposals/${p.id}/apply`, { approved: true, revision: p.revision });
    assert.equal(applied.patch.lights[0].temperature, 4800); assert.equal(applied.patch.pages, undefined); assert.equal(jobs.listJobs().length, count);
    const pp = await post('proposals', { kind: 'pages', backend: 'channel', sourceText: posterSource, requestId: 'pages-test' });
    const patch = await post(`proposals/${pp.id}/apply`, { approved: true, revision: pp.revision }); assert.equal(patch.patch.pages[0].body, '地点：悉尼');
    await assert.rejects(() => post('proposals', { kind: 'pages', backend: 'channel', sourceText: 'changed', requestId: 'pages-test' }), /其他资料/);
    assert.equal(jobs.listJobs().length, count);
  } finally { mock.restore(); }
});
test('missing credentials and invalid model JSON fail cleanly without fallback or generation', async () => {
  const count = jobs.listJobs().length;
  await assert.rejects(() => post('proposals', { kind: 'pages', backend: 'channel', sourceText: posterSource, requestId: 'not-configured' }), /没有配置助手渠道/);
  assert.equal((await get('proposals/not-configured')).status, 'error');
  const mock = mockAssistant(() => ({ ...pageProposal(), command: 'createJob' }));
  try {
    await assert.rejects(() => post('proposals', { kind: 'pages', backend: 'channel', sourceText: posterSource, requestId: 'bad-json' }), /字段/);
    assert.equal((await get('proposals/bad-json')).proposal, null);
    assert.equal(jobs.listJobs().length, count);
  } finally { mock.restore(); }
});
test('assistant waiting never holds canvas execution mutex or prevents pause', async () => {
  let release, entered;
  const received = new Promise(resolve => { entered = resolve; });
  const mock = mockAssistant(async () => { entered(); return new Promise(resolve => { release = () => resolve(pageProposal()); }); });
  try {
    const c = await post('canvases', { graph: graph() }), e = await start(c);
    const task = post('proposals', { kind: 'pages', backend: 'channel', sourceText: posterSource, requestId: 'slow-assist' });
    await received;
    const paused = await Promise.race([post(`executions/${e.id}/pause`), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('pause blocked by assistant')), 1000); t.unref(); })]);
    assert.equal(paused.status, 'paused'); release(); await task; await post(`executions/${e.id}/cancel`);
  } finally { release?.(); mock.restore(); }
});

test('graph boundaries reject cycles, duplicate/dangling IDs, invalid types and unreviewed candidates', () => {
  const g = graph(); assert.deepEqual(validateGraph(g).order, ['image', 'gen', 'pick', 'out']);
  const duplicate = structuredClone(g); duplicate.nodes.push(duplicate.nodes[0]); assert.throws(() => validateGraph(duplicate), /重复/);
  const dangling = structuredClone(g); dangling.nodes[1].inputs = ['missing']; assert.throws(() => validateGraph(dangling), /不存在/);
  const cycle = { nodes: [node('a', 'stitch', ['b']), node('b', 'stitch', ['a']), node('o', 'output', ['a'])] }; assert.throws(() => validateGraph(cycle), /循环/);
  const bypass = structuredClone(g); bypass.nodes[3].inputs = ['gen']; assert.throws(() => validateGraph(bypass), /候选/);
  const orphan = structuredClone(g); orphan.nodes.push(node('orphan', 'image', [], { uploadId: upload() })); assert.throws(() => validateGraph(orphan), /连接到输出/);
  const bad = structuredClone(g); bad.nodes[1].config.count = 99; assert.throws(() => validateGraph(bad), /范围/);
  const traversal = structuredClone(g); traversal.nodes[0].id = '../escape'; assert.throws(() => validateGraph(traversal), /ID/);
  assert.throws(() => validateGraph({ nodes: [node('x', 'execute-shell')] }), /未知/);
});

test('save pins uploads; revisions survive reopen with undo/redo and optimistic conflict checks', async () => {
  const draft = graph(), originalUpload = draft.nodes[0].config.uploadId;
  let c = await post('creative/canvases', { title: 'durable', graph: draft });
  assert.equal(submitted.length, 0); assert.ok(c.graph.nodes[0].config.assetId);
  fs.unlinkSync(jobs.useUpload(originalUpload));
  const revised = structuredClone(c.graph); revised.nodes[1].config.prompt = 'new prompt'; revised.nodes[0].position.x = 260;
  const first = c.revision; c = await post(`canvases/${c.id}/save`, { revision: first, graph: revised });
  await assert.rejects(() => post(`canvases/${c.id}/save`, { revision: first, graph: revised }), /冲突/);
  await creative.close(); creative = createCreative(ctx);
  c = await get(`canvases/${c.id}`); assert.equal(c.graph.nodes[0].position.x, 260);
  c = await post(`canvases/${c.id}/undo`, { revision: c.revision }); assert.equal(c.graph.nodes[1].config.prompt, 'blue');
  const asset = await get(`assets/${c.graph.nodes[0].config.assetId}`); assert.ok(jobs.useUpload(asset.uploadId));
  c = await post(`canvases/${c.id}/redo`, { revision: c.revision }); assert.equal(c.graph.nodes[1].config.prompt, 'new prompt');
  assert.equal(c.revisions.length, 2);
  await assert.rejects(() => get('canvases/../escape'), /ID/);
});

test('review gates execution, capabilities, reference limits, and stale review tokens', async () => {
  const c = await post('canvases', { graph: graph() }), review = await post(`canvases/${c.id}/review`);
  assert.equal(review.submissions, 1); assert.equal(submitted.length, 0);
  await assert.rejects(() => post(`canvases/${c.id}/start`, { token: review.token }), /审阅/);
  await assert.rejects(() => post(`canvases/${c.id}/start`, { token: 'old', reviewed: true }), /审阅/);
  const g = structuredClone(c.graph); g.nodes[1].config.aspect = '21:9';
  const next = await post(`canvases/${c.id}/save`, { revision: c.revision, graph: g });
  await assert.rejects(() => post(`canvases/${c.id}/start`, { token: review.token, reviewed: true }), /审阅/);
  assert.ok((await post(`canvases/${next.id}/review`)).errors.some(x => x.includes('aspect')));
  const refs = graph();
  for (let i = 0; i < 3; i++) { refs.nodes.unshift(node(`ref-${i}`, 'image', [], { uploadId: upload() })); refs.nodes.find(n => n.id === 'gen').inputs.push(`ref-${i}`); }
  const rc = await post('canvases', { graph: refs }); assert.ok((await post(`canvases/${rc.id}/review`)).errors.some(x => x.includes('参考图')));
});

test('restart and repeated start keep completed submissions, candidate choice pins exact pixels', async () => {
  const c = await post('canvases', { graph: graph(2) }); const initial = submitted.length;
  const e = await start(c); await creative.tick(); await settle();
  await creative.close(); creative = createCreative(ctx);
  assert.equal((await get(`executions/${e.id}`)).status, 'paused');
  const [a, b] = await Promise.all([start(c), start(c)]); assert.equal(a.id, e.id); assert.equal(b.id, e.id);
  const waiting = await drive(e.id); assert.equal(waiting.status, 'awaiting-selection'); assert.equal(submitted.length - initial, 2);
  await assert.rejects(() => post(`executions/${e.id}/select`, { nodeId: 'pick', jobId: 'unrelated' }), /不属于/);
  await assert.rejects(() => post(`canvases/${c.id}/save`, { revision: c.revision, graph: c.graph }), /未结束/);
  await selected(waiting);
  const chosen = jobs.getJob(waiting.nodes.gen.slots[0].jobId); // A later variant mutation must not change downstream input.
  await sharp(await png('red')).png().toFile(chosen.result.path);
  await post(`executions/${e.id}/resume`); const done = await drive(e.id, 'done');
  assert.equal(done.status, 'done'); const out = jobs.getJob(done.nodes.out.jobId);
  const pixels = await sharp(out.result.path).raw().toBuffer(); assert.deepEqual([...pixels.subarray(0, 3)], [0, 0, 255]);
  const count = jobs.listJobs().length; await creative.tick(); await start(c); assert.equal(jobs.listJobs().length, count);
  assert.equal(submitted.length - initial, 2); assert.equal(out.meta.parameters.blend, 'normal');
  // Editing then undoing reconnects the completed execution, so undo cannot implicitly bill again.
  const edited = structuredClone(c.graph); edited.nodes[1].config.prompt = 'another';
  let changed = await post(`canvases/${c.id}/save`, { revision: c.revision, graph: edited });
  changed = await post(`canvases/${c.id}/undo`, { revision: changed.revision }); assert.equal(changed.execution.id, e.id); assert.equal((await start(changed)).status, 'done');
});

test('pause interleaves with tick, no later candidates submit until resumed; cancel never resubmits', async () => {
  const c = await post('canvases', { graph: graph(3) }), e = await start(c), count = submitted.length;
  await Promise.all([creative.tick(), post(`executions/${e.id}/pause`)]); await settle();
  await creative.tick(); assert.equal(submitted.length - count, 1);
  assert.equal((await get(`executions/${e.id}`)).status, 'paused');
  await post(`executions/${e.id}/cancel`); await creative.tick();
  await assert.rejects(() => post(`executions/${e.id}/resume`), /结束/); assert.equal((await start(c)).status, 'cancelled'); assert.equal(submitted.length - count, 1);
});

test('unknown submission intent survives restart and requires explicit inspection, never auto-retries', async () => {
  const c = await post('canvases', { graph: graph() }), e = await start(c), before = submitted.length;
  prepareFails = true; await creative.tick();
  let saved = await get(`executions/${e.id}`); assert.equal(saved.nodes.gen.slots[0].status, 'uncertain');
  await creative.close(); creative = createCreative(ctx);
  await post(`executions/${e.id}/resume`); await creative.tick(); assert.equal(submitted.length, before);
  await assert.rejects(() => post(`executions/${e.id}/retry`, { nodeId: 'gen', slot: 0 }), /核对/);
  await assert.rejects(() => post(`executions/${e.id}/retry`, { nodeId: 'gen', slot: 0, verified: true }), /确认/);
  await post(`executions/${e.id}/retry`, { nodeId: 'gen', slot: 0, verified: true, confirmNoResult: true });
  await post(`executions/${e.id}/resume`); saved = await drive(e.id);
  assert.equal(submitted.length - before, 1); assert.equal(saved.nodes.gen.slots[0].attempt, 2);
  await post(`executions/${e.id}/cancel`);
});

test('crash after persisted job but before saved jobId recovers by immutable execution/slot identity', async () => {
  const c = await post('canvases', { graph: graph() }), e = await start(c), before = submitted.length;
  await creative.tick(); await settle(); await creative.close();
  const record = JSON.parse(fs.readFileSync(executionFile(e.id))); delete record.nodes.gen.slots[0].jobId; record.nodes.gen.slots[0].status = 'submitting'; fs.writeFileSync(executionFile(e.id), JSON.stringify(record));
  creative = createCreative(ctx); await post(`executions/${e.id}/resume`);
  const waiting = await drive(e.id); assert.equal(waiting.status, 'awaiting-selection'); assert.equal(submitted.length - before, 1);
  await post(`executions/${e.id}/cancel`);
});

test('failed candidate retries only itself and existing completed jobs cannot be retried', async () => {
  const c = await post('canvases', { graph: graph(2) }), e = await start(c), before = submitted.length;
  await creative.tick(); await settle(); failNext = true;
  let failed = await drive(e.id); assert.equal(failed.status, 'needs-attention');
  assert.equal(failed.nodes.gen.slots[0].status, 'done'); assert.equal(failed.nodes.gen.slots[1].status, 'error');
  await post(`executions/${e.id}/retry`, { nodeId: 'gen', slot: 1, verified: true, confirmNoResult: true });
  await post(`executions/${e.id}/resume`); const waiting = await drive(e.id); assert.equal(submitted.length - before, 3);
  await assert.rejects(() => post(`executions/${e.id}/retry`, { nodeId: 'gen', slot: 0, verified: true, confirmNoResult: true }), /不需要/);
  await selected(waiting); await post(`executions/${e.id}/resume`); await drive(e.id, 'done');
});

test('provider native candidate IDs pause separately, persist and use candidateRoutes before DAG selection', async () => {
  const g = graph(); g.nodes[1].config.prompt = 'native-multi';
  const c = await post('canvases', { graph: g }), e = await start(c), before = submitted.length;
  let waiting = await drive(e.id);
  assert.equal(waiting.nodes.gen.slots[0].status, 'awaiting-selection', waiting.note);
  assert.deepEqual(waiting.nodes.gen.slots[0].candidates.map(c => c.id), ['candidate-1', 'candidate-2']);
  assert.equal(waiting.nodes.pick.status, 'pending');
  await creative.close(); creative = createCreative(ctx);
  await assert.rejects(() => post(`executions/${e.id}/job-select`, { nodeId: 'gen', slot: 0, candidateId: 'candidate-99' }), /不属于/);
  await post(`executions/${e.id}/job-select`, { nodeId: 'gen', slot: 0, candidateId: 'candidate-2' });
  const jid = waiting.nodes.gen.slots[0].jobId;
  assert.equal(jobs.getJob(jid).selectedCandidateId, 'candidate-2');
  await post(`executions/${e.id}/resume`); waiting = await drive(e.id);
  assert.equal(waiting.nodes.pick.status, 'awaiting-selection');
  await selected(waiting); await post(`executions/${e.id}/resume`); const done = await drive(e.id, 'done');
  const pixel = await sharp(jobs.getJob(done.nodes.out.jobId).result.path).raw().toBuffer(); assert.deepEqual([...pixel.subarray(0, 3)], [0, 0, 255]);
  assert.equal(submitted.length - before, 1);
});

test('recover-job polls confirmed upstream ID through candidateRoutes without a new submission', async () => {
  let starts = 0, resumes = 0;
  ctx.providers.comfyui = {
    async run(j) { starts++; j.upstream = { kind: 'comfyui', taskId: 'confirmed-task' }; throw new Error('interrupted download'); },
    async resume(j) { resumes++; const file = path.join(j.dir, 'recovered.png'); fs.writeFileSync(file, source); return { path: file, width: 20, height: 12 }; }
  };
  const g = graph(); g.nodes[1].config.provider = 'comfyui';
  const c = await post('canvases', { graph: g }), e = await start(c);
  const failed = await drive(e.id); assert.equal(failed.nodes.gen.slots[0].canRecover, true);
  await post(`executions/${e.id}/recover-job`, { nodeId: 'gen', slot: 0 }); await settle();
  await post(`executions/${e.id}/resume`); const waiting = await drive(e.id);
  assert.equal(waiting.status, 'awaiting-selection'); assert.equal(starts, 1); assert.equal(resumes, 1);
  await post(`executions/${e.id}/cancel`); delete ctx.providers.comfyui;
});

test('real stitch preserves alpha, mapping, screen arithmetic and rejects off-canvas layers', async () => {
  const red = path.join(dir, 'red.png'), blue = path.join(dir, 'blue.png'); fs.writeFileSync(red, await png({ r: 255, g: 0, b: 0, alpha: .5 }, 4, 4)); fs.writeFileSync(blue, await png('blue', 4, 4));
  const horizontal = await stitchImages([red, blue], { mode: 'horizontal', gap: 1 }); const h = await sharp(horizontal).metadata(); assert.equal(h.width, 9); assert.equal(h.height, 4);
  const px = await sharp(horizontal).raw().toBuffer(); assert.equal(px[3], 128); assert.equal(px[4 * 4 + 3], 0); assert.deepEqual([...px.subarray(5 * 4, 5 * 4 + 4)], [0, 0, 255, 255]);
  const layer = { x: 0, y: 0, width: 4, height: 4, opacity: 1 };
  const screen = await stitchImages([red, blue], { mode: 'screen', width: 4, height: 4, layers: [layer, layer] });
  const sp = await sharp(screen).raw().toBuffer(); assert.ok(sp[0] >= 127 && sp[0] <= 128); assert.equal(sp[2], 255);
  await assert.rejects(() => stitchImages([red], { mode: 'overlay', width: 4, height: 4, layers: [{ ...layer, x: 1 }] }), /超出/);
  await assert.rejects(() => stitchImages([red, blue], { cellWidth: 8192, cellHeight: 8192 }), /超过/);
});

test('local DAG composition publishes once, output sizing pins alpha and blend contract', async () => {
  const g = { nodes: [node('a', 'image', [], { uploadId: upload() }), node('b', 'image', [], { uploadId: upload() }), node('stitch', 'stitch', ['a', 'b'], { mode: 'horizontal' }), node('out', 'output', ['stitch'], { width: 80, height: 40, blendMode: 'screen', captureId: 'capture-test' })] };
  const c = await post('canvases', { graph: g }), e = await start(c), count = submitted.length;
  const done = await drive(e.id, 'done'), j = jobs.getJob(done.nodes.out.jobId);
  assert.equal(submitted.length, count); assert.equal(j.result.width, 80); assert.equal(j.result.height, 40); assert.equal(j.meta.parameters.blend, 'screen'); assert.equal(j.meta.parameters.captureId, 'capture-test');
  const alpha = await sharp(j.result.path).extractChannel('alpha').raw().toBuffer(); assert.equal(alpha[0], 0); assert.ok(alpha.some(v => v === 128));
  const total = jobs.listJobs().length;
  await creative.close(); const r = JSON.parse(fs.readFileSync(executionFile(e.id))); r.status = 'running'; r.nodes.out = { status: 'pending' }; fs.writeFileSync(executionFile(e.id), JSON.stringify(r));
  creative = createCreative(ctx); await post(`executions/${e.id}/resume`); const again = await drive(e.id, 'done'); assert.equal(again.nodes.out.jobId, j.id); assert.equal(jobs.listJobs().length, total);
});

test('tools produce original poster page specs, explicit scene roles and black light contribution jobs', async () => {
  const settings = { tool: 'decompose', captureId: 'capture-test', materials: [{ uploadId: upload(), role: 'subject', name: 'person' }], options: { provider: 'fake', aspect: '1:1', resolution: '2K' }, rig: { lights: [{ name: 'key', x: -2, y: 3, z: 4, intensity: 2, temperature: 3200, color: '#ffaabb', enabled: true }, { name: 'disabled', enabled: false }] } };
  const spec = composeCreative(settings), g = spec.graph;
  assert.equal(g.nodes.filter(n => n.type === 'generate').length, 1); assert.match(g.nodes.find(n => n.type === 'generate').config.prompt, /Pure BLACK/); assert.match(g.nodes.find(n => n.type === 'generate').config.prompt, /3200K/);
  assert.equal(g.nodes.at(-1).config.blendMode, 'screen'); assert.equal(g.nodes.at(-1).config.captureId, 'capture-test');
  const count = submitted.length, c = await post('compose', settings); assert.equal(submitted.length, count); const e = await start(c), waiting = await drive(e.id);
  await selected(waiting, 'candidate-0', 'generate-0'); await post(`executions/${e.id}/resume`); const done = await drive(e.id, 'done'); assert.equal(jobs.getJob(done.nodes['output-0'].jobId).meta.parameters.blend, 'screen');
  const poster = composeCreative({ ...settings, tool: 'poster', templateId: 'editorial', width: 900, height: 1200, pages: [{ headline: 'Page A' }, { headline: 'Page B', body: 'literal facts' }] });
  assert.equal(poster.graph.nodes.filter(n => n.type === 'output').length, 2); assert.ok(poster.graph.nodes.filter(n => n.type === 'output').every(n => n.config.width === 900 && !n.config.captureId));
  assert.match(poster.graph.nodes.find(n => n.id === 'generate-1').config.prompt, /Page B/);
  assert.throws(() => composeCreative({ ...settings, tool: 'poster', templateId: 'thirdparty', pages: [{}] }), /自有/);
  const scene = composeCreative({ ...settings, tool: 'scene', materials: [...settings.materials, { uploadId: upload(), role: 'background', name: 'venue' }] });
  assert.match(scene.graph.nodes.find(n => n.type === 'generate').config.prompt, /2=background \(venue\)/);
  assert.throws(() => normalizeRig({ camera: { distance: -1 } }), /范围/);
});

test('saved tool presets pin materials across upload expiry; completed runs can feed image inputs', async () => {
  const id = upload();
  const preset = await post('presets', { title: 'scene preset', settings: { tool: 'scene', options: { provider: 'fake' }, materials: [{ uploadId: id, role: 'subject', name: 'original' }] } });
  fs.unlinkSync(jobs.useUpload(id)); await creative.close(); creative = createCreative(ctx);
  const reopened = await get(`presets/${preset.id}`); assert.ok(reopened.settings.materials[0].assetId); assert.equal(reopened.settings.materials[0].uploadId, undefined);
  const c = await post('compose', reopened.settings); assert.ok(c.graph.nodes[0].config.assetId);
  const result = jobs.listJobs().find(j => j.status === 'done'); runResults = [{ id: 'run-1', status: 'done', resultJobId: result.id }];
  const fromRun = await post('canvases', { graph: { nodes: [node('image', 'image', [], { runId: 'run-1' }), node('out', 'output', ['image'])] } }); assert.ok(fromRun.graph.nodes[0].config.assetId);
  runResults[0].status = 'paused'; await assert.rejects(() => post('assets', { runId: 'run-1' }), /完成/);
  await post(`presets/${preset.id}/delete`); assert.ok(!(await get('presets')).presets.some(p => p.id === preset.id));
});

test.after(async () => { await creative.close(); await settle(); fs.rmSync(dir, { recursive: true, force: true }); });

// Optional isolated browser contract test. It serves ONLY fixtures and the two owned renderer files;
// no Electron app, installed helper, real provider, Photoshop document or shared entrypoint is touched.
test('renderer installs dynamic tab, edits lighting and graph, reviews and selects a mocked result under app CSP', { skip: process.env.PS_AI_CREATIVE_BROWSER_TEST !== '1', timeout: 30000 }, async () => {
  const { createServer } = await import('node:http');
  const { chromium } = await import('playwright-core');
  const chrome = process.env.PS_AI_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const fixtureUpload = upload(), assistantMock = mockAssistant();
  const fixture = `const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); const reason=e=>e.message||String(e); function toast(s){document.getElementById('toast').textContent=s;} const work={base:location.origin,input:{uploadId:'${fixtureUpload}',name:'Fixture source'},jobs:[]}; const url=p=>work.base+p; async function api(method,path,body){const r=await fetch(path,{method,headers:{'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body||{})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;} function showTab(name){document.querySelectorAll('.tab').forEach(p=>p.hidden=p.id!=='tab-'+name);document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.dispatchEvent(new CustomEvent('workspace-tab',{detail:name}));} window.bridge={api,pickImages:async()=>[],copyText:async()=>{},revealJob:async()=>{}}; async function refreshJobs(){} function openViewer(){};`;
  const server = createServer(async (req, res) => {
    try {
      const request = new URL(req.url, 'http://localhost'), p = request.pathname;
      if (p === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data: http://127.0.0.1:*; script-src 'self'"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/organizer.css"><div class="tabs"><button class="tab-btn" data-tab="work">work</button></div><div id="tab-work" class="tab"><select id="provider"><option>fake</option></select><input id="model"><input id="aspect" value="1:1"><input id="resolution" value="2K"><input id="thinking" value="High"><textarea id="genPrompt">blue</textarea></div><div id="toast"></div><script src="/fixtures.js"></script><script src="/creative.js"></script>`); return; }
      if (p === '/fixtures.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(fixture); return; }
      if (['/creative.js', '/creative.css', '/style.css', '/organizer.css'].includes(p)) { res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css'); res.end(fs.readFileSync(new URL(`../../desktop/src/renderer${p}`, import.meta.url))); return; }
      if (p.startsWith('/uploads/')) { const f = jobs.useUpload(p.split('/')[2]); if (!f) throw new Error('missing upload'); res.setHeader('content-type', 'image/png'); res.end(fs.readFileSync(f)); return; }
      if (p.startsWith('/creative/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
        const result = await creative.route(req.method, p.slice(1).split('/'), body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return;
      }
      res.statusCode = 404; res.end('{}');
    } catch (e) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('[data-tab="creative"]').click();
    await page.waitForFunction(() => !!document.getElementById('cr-board'));
    await page.waitForFunction(() => document.querySelectorAll('#cr-library option').length > 1);
    await page.locator('[data-cr-page="lighting"]').click();
    await page.locator('#cr-material-work').click();
    await page.waitForFunction(() => document.querySelectorAll('.cr-materials article').length === 1);
    await page.locator('#cr-request-proposal').click();
    await page.waitForSelector('#cr-proposal-approved');
    assert.equal(await page.locator('[data-light-value="temperature"]').inputValue(), '5600');
    assert.match(await page.locator('#cr-proposal-preview').innerText(), /可见依据/);
    await page.locator('#cr-apply-proposal').click();
    assert.match(await page.locator('#cr-message').innerText(), /勾选/);
    await page.locator('[data-light-value="temperature"]').fill('5700');
    await page.locator('#cr-proposal-approved').check(); await page.locator('#cr-apply-proposal').click();
    assert.match(await page.locator('#cr-message').innerText(), /草稿已改变/);
    assert.equal(await page.locator('[data-light-value="temperature"]').inputValue(), '5700');
    await page.locator('#cr-request-proposal').click();
    await page.waitForFunction(() => document.getElementById('cr-request-proposal').disabled === false);
    await page.locator('#cr-proposal-approved').check(); await page.locator('#cr-apply-proposal').click();
    await page.waitForFunction(() => document.querySelector('[data-light-value="temperature"]').value === '4800');
    assert.equal(await page.locator('.cr-node').count(), 0, 'analysis/apply creates no graph');
    const before = await page.locator('#cr-light-preview').evaluate(c => c.toDataURL());
    await page.locator('[data-light-value="intensity"]').fill('4');
    const after = await page.locator('#cr-light-preview').evaluate(c => c.toDataURL()); assert.notEqual(before, after, 'light intensity changes actual rendered pixels');
    await page.locator('#cr-mode-2d').click();
    const top = await page.locator('#cr-light-preview').evaluate(c => c.toDataURL()); assert.notEqual(after, top, '2D and 3D differ');
    await page.locator('#cr-tool-title').fill('Browser smoke light');
    await page.locator('#cr-make-decomposition').click();
    await page.waitForFunction(() => document.querySelectorAll('.cr-node').length === 4);
    assert.equal(await page.locator('[data-node="generate-0"]').evaluate(n => getComputedStyle(n).left), '330px');
    const handle = page.locator('[data-handle="image-0"]'), box = await handle.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 15); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 55); await page.mouse.up();
    assert.equal(await page.locator('[data-node="image-0"]').evaluate(n => getComputedStyle(n).left), '110px');
    await page.locator('#cr-review-run').click();
    await page.waitForFunction(() => !document.getElementById('cr-review').hidden);
    assert.match(await page.locator('#cr-review').innerText(), /Pure BLACK/);
    await page.locator('#cr-reviewed').check(); nativeNext = true; await page.locator('#cr-start-reviewed').click();
    await page.waitForFunction(() => !!document.getElementById('cr-inspect-execution'));
    const c = (await get('canvases')).canvases.find(c => c.title === 'Browser smoke light');
    const saved = await get(`canvases/${c.id}`); await drive(saved.execution.id);
    await page.locator('#cr-inspect-execution').click();
    await page.waitForSelector('[data-candidate-id="candidate-2"]');
    await page.locator('[data-candidate-id="candidate-2"]').click();
    await page.waitForFunction(() => document.getElementById('cr-execution').textContent.includes('已有任务已选择'));
    await page.locator('#cr-resume').click(); await drive(saved.execution.id);
    await page.locator('#cr-inspect-execution').click();
    await page.waitForSelector('[data-choose-node="candidate-0"]');
    await page.locator('[data-choose-node="candidate-0"]').click();
    await page.waitForFunction(() => document.getElementById('cr-execution').textContent.includes('候选已锁定'));
    await page.locator('#cr-resume').click(); await drive(saved.execution.id, 'done');
    await page.locator('#cr-inspect-execution').click(); await page.waitForSelector('.cr-output');
    assert.match(await page.locator('#cr-execution').innerText(), /Screen/);
    await page.locator('[data-cr-page="poster"]').click();
    await page.getByText('从文字资料填入页面', { exact: true }).click();
    await page.locator('#cr-page-source').fill(posterSource);
    const jobsBeforeProposal = jobs.listJobs().length;
    await page.locator('#cr-request-proposal').click(); await page.waitForSelector('#cr-proposal-approved');
    assert.equal(await page.locator('[data-page-key="headline"]').inputValue(), '');
    await page.locator('#cr-proposal-approved').check(); await page.locator('#cr-apply-proposal').click();
    await page.waitForFunction(() => document.querySelector('[data-page-key="headline"]').value === '展览公告');
    assert.equal(jobs.listJobs().length, jobsBeforeProposal, 'poster apply does not submit');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.orgTheme = theme; }, theme);
      await page.locator('[data-cr-page="canvas"]').click();
      const contrasts = await page.evaluate(() => {
        const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = s => rgb(s).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const bg = luminance(getComputedStyle(document.getElementById('tab-creative')).backgroundColor);
        return ['.cr-header h2', '.cr-header p', '.cr-toolbar > span', '#cr-message'].map(selector => { const fg = luminance(getComputedStyle(document.querySelector(selector)).color); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05); });
      });
      assert.ok(contrasts.every(r => r >= 4.5), `${theme} outer text contrast: ${contrasts.join(', ')}`);
    }
    assert.deepEqual(errors, []);
  } finally { assistantMock.restore(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
