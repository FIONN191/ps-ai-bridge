import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerCacheIpc } = require('../../v7/foundation/cache/cache-lifecycle.js');
const { registerSecretsIpc } = require('../../v7/foundation/security/secret-vault.js');
const { PATCHES } = await import('../../v7/patches.mjs');

const fakeIpc = () => {
  const handlers = new Map();
  return { handle: (name, fn) => handlers.set(name, fn), call: (name, ...args) => handlers.get(name)({ sender: {} }, ...args) };
};

test('V7 cache keeps runs, recycles deletions and refuses path escapes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-cache-'));
  const ipc = fakeIpc();
  registerCacheIpc(ipc, { defaultRoot: path.join(dir, 'cache'), configFile: path.join(dir, 'cfg.json'), openPath: async () => '', chooseDirectory: async () => null });
  assert.equal((await ipc.call('cache:writeFile', 'ns__doc', '20261027-1', 'output_1.png', new Uint8Array([1, 2, 3]))).ok, true);
  await ipc.call('cache:writeMeta', 'ns__doc', '20261027-1', { status: 'done', namespaceId: 'ns' });
  assert.deepEqual([...await ipc.call('cache:readFile', 'ns__doc', '20261027-1', 'output_1.png')], [1, 2, 3]);
  assert.equal((await ipc.call('cache:list')).runs.length, 1);
  assert.equal((await ipc.call('cache:writeFile', '../x', 'r', 'a.png', new Uint8Array(1))).ok, false);
  assert.equal((await ipc.call('cache:writeFile', 'p', 'r', '../a.png', new Uint8Array(1))).ok, false);
  assert.equal((await ipc.call('cache:deleteRun', { namespaceId: 'other', project: 'ns__doc', runId: '20261027-1' })).ok, false);
  const removed = await ipc.call('cache:deleteRun', { namespaceId: 'ns', project: 'ns__doc', runId: '20261027-1' });
  assert.equal((await ipc.call('cache:list')).runs.length, 0);
  assert.equal((await ipc.call('cache:listDeleted', 'ns')).items[0].recoveryId, removed.recoveryId);
  assert.equal((await ipc.call('cache:restoreDeleted', { namespaceId: 'ns', recoveryId: removed.recoveryId })).ok, true);
  assert.equal((await ipc.call('cache:usageReport', { namespaceId: 'ns' })).byDate[0].date, '2026-10-27');
});

test('V7 secrets are stored encrypted and read back per scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-secrets-'));
  const ipc = fakeIpc();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => b.toString().slice(4) };
  registerSecretsIpc(ipc, { directory: dir, safeStorage });
  await ipc.call('secrets:set', { name: 'llmKey', value: 'sk-1', scope: 'acct:1' });
  assert.equal((await ipc.call('secrets:get', 'llmKey', 'acct:1')).value, 'sk-1');
  assert.equal((await ipc.call('secrets:get', 'llmKey', 'other')).value, '');
  assert.ok(!fs.readFileSync(path.join(dir, 'acct_1.json'), 'utf8').includes('sk-1'));
});

test('every V7 patch is applied to the imported files', () => {
  for (const patch of PATCHES) {
    const text = fs.readFileSync(new URL(`../../v7/${patch.file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(patch.replace), `${patch.file}: ${patch.why}`);
  }
});
