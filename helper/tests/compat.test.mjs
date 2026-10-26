import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-compat-'));
process.env.PS_AI_BRIDGE_DATA_DIR = dir;
const { config } = await import('../lib/config.mjs'); config.outputDir = path.join(dir, 'outputs');
const { compatModels, compatGenerate } = await import('../lib/compat.mjs');

const png = (colour, width = 30, height = 40) => sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();
const seen = [];
let available = true, multi = false;
const providers = { aistudio: {
  label: 'AI Studio',
  async status() { return available ? { available: true } : { available: false, note: '未登录' }; },
  async run(job) {
    seen.push({ model: job.model, aspect: job.aspect, resolution: job.resolution, post: job.post, refs: job.refPaths.length, input: !!job.inputPath });
    if (multi) {
      const candidates = [];
      for (const [i, c] of ['red', 'blue'].entries()) { const f = path.join(job.dir, `c${i}.png`); fs.writeFileSync(f, await png(c)); candidates.push({ id: `candidate-${i + 1}`, path: f, width: 30, height: 40 }); }
      return { candidates };
    }
    const out = path.join(job.dir, 'out.png'); fs.writeFileSync(out, await png('green'));
    return { path: out, width: 30, height: 40 };
  },
} };
const capabilities = { aistudio: { models: ['nano-banana-2.1'], aspects: ['1:1', '3:4', '16:9'], resolutions: ['1K', '2K'] } };
const body = async (extra = {}) => ({
  contents: [{ role: 'user', parts: [{ text: '把背景换成海边' }, { inlineData: { mimeType: 'image/png', data: (await png('white')).toString('base64') } }, { inlineData: { mimeType: 'image/png', data: (await png('black')).toString('base64') } }] }],
  generationConfig: { imageConfig: { imageSize: '4K', ...extra } },
});

test('lists only web platforms as Gemini models', () => {
  const { models } = compatModels(providers, capabilities);
  assert.deepEqual(models.map((m) => m.name), ['models/web-aistudio-nano-banana-2.1']);
});

test('generates raw output with matched aspect, capped resolution and references', async () => {
  const r = await compatGenerate(encodeURIComponent('models/web-aistudio-nano-banana-2.1'), await body(), { providers, capabilities });
  const parts = r.candidates[0].content.parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.deepEqual(seen.at(-1), { model: 'nano-banana-2.1', aspect: '3:4', resolution: '2K', post: { align: false, cc: 'none' }, refs: 1, input: true });
});

test('returns every candidate when the platform gives several', async () => {
  multi = true;
  const r = await compatGenerate('web-aistudio-nano-banana-2.1', await body({ aspectRatio: '16:9' }), { providers, capabilities });
  multi = false;
  assert.equal(r.candidates[0].content.parts.length, 2);
  assert.equal(seen.at(-1).aspect, '16:9');
});

test('rejects unknown models and unavailable platforms before creating a job', async () => {
  const before = seen.length;
  await assert.rejects(compatGenerate('web-aistudio-gpt', await body(), { providers, capabilities }), { status: 404 });
  available = false;
  await assert.rejects(compatGenerate('web-aistudio-nano-banana-2.1', await body(), { providers, capabilities }), { status: 503 });
  available = true;
  assert.equal(seen.length, before);
});
