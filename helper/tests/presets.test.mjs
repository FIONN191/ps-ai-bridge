import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-presets-'));
process.env.PS_AI_BRIDGE_DATA_DIR = dir;
fs.mkdirSync(path.join(dir, 'presets'));
fs.writeFileSync(path.join(dir, 'presets', 'legacy.json'), JSON.stringify([
  { id: 'one', title: '第一个', content: 'first', category: 'hair' },
  { id: 'two', title: '第二个', content: 'second', category: 'head' },
]));
const p = await import('../lib/presets.mjs');
test('editing, starring and deleting a legacy array never removes siblings', () => {
  p.savePreset({ id: 'one', title: '改名', content: 'changed', expectedRevision: 1 });
  assert.equal(p.getPreset('two').content, 'second');
  p.setStar('one', true);
  assert.equal(p.getPreset('two').content, 'second');
  assert.throws(() => p.savePreset({ id: 'one', title: 'stale', content: 'lost', expectedRevision: 1 }), /其他窗口/);
  p.deletePreset('one');
  assert.equal(p.getPreset('one'), null);
  assert.equal(p.getPreset('two').content, 'second');
  const trash = p.listTrash().find(x => x.id === 'one');
  assert.equal(p.restorePreset(trash.trashId).content, 'changed');
  assert.equal(p.restoreRevision('one', 1).content, 'first');
});
test('export/import round trip preserves references and rejects unsupported workflows', () => {
  const ref = Buffer.alloc(110, 1).toString('base64');
  const a = p.savePreset({ title: 'reference', content: 'do this', refImages: [ref] });
  const pack = p.exportPresets([a.id]);
  p.deletePreset(a.id);
  const r = p.importPack(pack);
  assert.equal(r.added, 1);
  assert.deepEqual(p.getPreset(r.ids[0]).refImages, [ref]);
  assert.equal(p.importPack(pack).skipped, 1);
  assert.equal(p.importPack([{ title: 'bad', content: 'x', kind: 'workflow' }]).rejected, 1);
});
test('numeric parameter ranges are preserved, including signed and fractional bounds', () => {
  const a = p.parseParams('"@param:温度":6500,"@param:温度_range":[2000,10000,100],"@param:温度_desc":"灯光 色温"');
  assert.deepEqual(a, [{ name: '温度', value: 6500, min: 2000, max: 10000, step: 100, desc: '灯光 色温' }]);
  assert.equal(p.parseParams('"@param:曝光":-1,"@param:曝光_range":[-5,5],"@param:曝光_step":0.1')[0].step, 0.1);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
