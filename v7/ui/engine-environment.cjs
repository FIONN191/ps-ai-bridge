'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const OWNER = 'wheelchair-v7-managed-python';
const ACTIONS = new Set(['status', 'prepare', 'remove', 'cancel', 'removeaccel']);
const INSTALL_GUIDANCE = '未找到可用的 Python 3.10 或更高版本。请从 https://www.python.org/downloads/ 安装官方 Python 后重试；建议 3.11 或 3.12。';
const defaultExecute = promisify(execFile);

function safePath(filename) {
  const resolved = path.resolve(filename);
  for (let current = resolved; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('托管环境路径不能包含符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}

function managedCandidate(root) {
  try {
    const read = name => {
      const filename = safePath(name);
      if (fs.statSync(filename).size > 65536) throw new Error('Environment metadata too large');
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    };
    const owner = read(path.join(root, '.v7-python-owner.json'));
    if (owner.owner !== OWNER || owner.schema !== 1 || path.resolve(owner.root) !== root) return null;
    const active = read(path.join(root, 'active.json'));
    if (!/^env-[a-f0-9]{32}$/.test(active.environment)) return null;
    const directory = safePath(path.join(root, 'environments', active.environment));
    const marker = read(path.join(directory, '.v7-environment.json'));
    if (marker.owner !== OWNER || path.resolve(marker.root) !== root || marker.environment !== active.environment || !marker.verified) return null;
    const executable = safePath(path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
    return fs.statSync(executable).isFile() ? executable : null;
  } catch (_) { return null; }
}

async function findPython(options = {}) {
  const execute = options.execFile || defaultExecute;
  const owned = options.environmentRoot && managedCandidate(path.resolve(options.environmentRoot));
  const candidates = options.pythonCandidates || [
    ...(owned ? [[owned, []]] : []),
    ...(process.platform === 'win32' ? [['py', ['-3']]] : []),
    ['python3', []], ['python', []]
  ];
  for (const [command, prefix] of candidates) {
    try {
      const executable = options.useBase ? 'getattr(sys, "_base_executable", sys.executable)' : 'sys.executable';
      const reply = await execute(command, [...prefix, '-I', '-c', 'import json, sys; print(json.dumps({"python": ' + executable + ', "version": list(sys.version_info[:2])}))'], { timeout: 8000, windowsHide: true, shell: false, maxBuffer: 65536, encoding: 'utf8' });
      const data = JSON.parse(reply.stdout.trim());
      if (data.version?.[0] === 3 && data.version[1] >= 10 && path.isAbsolute(data.python) && fs.statSync(data.python).isFile()) return data.python;
    } catch (_) { /* Try the next installed interpreter without installing anything. */ }
  }
  throw new Error(INSTALL_GUIDANCE);
}

function createService(options = {}) {
  if (!path.isAbsolute(options.root || '') || !path.isAbsolute(options.resourceRoot || '')) throw new Error('环境目录和软件资源目录必须是宿主指定的绝对路径。');
  const root = path.resolve(options.root);
  const script = path.join(options.resourceRoot, 'engine/managed_environment.py');
  const requirements = path.join(options.resourceRoot, 'engine/requirements.txt');
  const execute = options.execFile || defaultExecute;
  const delay = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const newToken = options.operationId || (() => crypto.randomUUID().replaceAll('-', ''));
  const timeoutMs = options.timeoutMs || 21 * 60 * 1000;
  let active = null;
  let last = { ok: true, state: 'absent', ready: false, python: null, root };
  const failure = error => ({ ...last, ok: false, state: 'error', root, error: typeof error === 'string' ? error : error?.message === INSTALL_GUIDANCE ? INSTALL_GUIDANCE : '独立环境管理未完成，请检查安装日志或重新检测。', ...(error instanceof Error ? { detail: error.message } : {}) });

  async function bootstrap() {
    safePath(root); safePath(script); safePath(requirements);
    return findPython({ ...options, environmentRoot: root, useBase: true });
  }

  async function invoke(python, action, token, accel) {
    // ⚠ 加速层是【只增不改】的：--accel 只影响 prepare，绝不改 requirements.txt
    //   （动了它，所有已装好的用户环境都会判定为损坏、被迫重装）。
    //   跟 Rust 侧（engine_environment.rs 的 command()）逐字对齐，两边不许漂移。
    const mode = accel === 'cuda' ? 'cuda' : 'off';
    const args = ['-I', script, '--root', root, '--requirements', requirements, '--action', action, '--accel', mode];
    if (token) args.push('--operation', token);
    const slow = action === 'prepare' || action === 'remove' || action === 'removeaccel';
    // ⚠ 装加速包要多下约 3GB，21 分钟的上限不够 → 跟 Rust 侧一样放宽到 40 分钟。
    const limit = (action === 'removeaccel' || mode === 'cuda') ? 40 * 60 * 1000 : timeoutMs;
    const reply = await execute(python, args, { timeout: slow ? limit : 15000, windowsHide: true, shell: false, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const data = JSON.parse(reply.stdout.trim());
    if (typeof data.ok !== 'boolean' || typeof data.ready !== 'boolean' || typeof data.state !== 'string' || path.resolve(data.root || '') !== root || (data.ready && (!path.isAbsolute(data.python || '') || !data.python.startsWith(root + path.sep)))) {
      throw new Error('托管 Python 管理器返回了无效状态。');
    }
    return data;
  }

  async function request(action, accel) {
    if (!ACTIONS.has(action)) return failure('不支持的环境操作。');
    if (action === 'cancel') {
      if (!active) return { ...last, ok: true };
      active.cancelled = true;
      const busy = active.action === 'remove' ? 'removing' : 'preparing';
      return { ...last, ok: true, state: busy, pending: true };
    }
    if (action === 'status') {
      try { last = await invoke(await bootstrap(), action); return last; }
      catch (error) { return failure(error); }
    }
    if (active) return { ...last, ok: false, state: active.action === 'remove' ? 'removing' : 'preparing', error: '本软件的环境操作仍在进行。' };
    const operation = { token: newToken(), action, cancelled: false, done: false };
    active = operation;
    let cancellationLoop;
    try {
      const python = await bootstrap();
      if (operation.cancelled) return { ...last, ok: false, state: 'cancelled', cancelled: true, error: '环境操作已取消。' };
      const pending = invoke(python, action, operation.token, accel);
      cancellationLoop = (async () => {
        while (!operation.done) {
          if (operation.cancelled) {
            try { await invoke(python, 'cancel', operation.token); } catch (_) { /* A later tick retries until the owned operation exits. */ }
          }
          await delay(250);
        }
      })();
      try { last = await pending; }
      finally { operation.done = true; }
      return last;
    } catch (error) { return failure(error); }
    finally {
      operation.done = true;
      if (cancellationLoop) await cancellationLoop;
      if (active === operation) active = null;
    }
  }
  async function managedPython() {
    if (active) return null;
    const status = await request('status');
    return status.ok && status.ready && status.state === 'ready' ? status.python : null;
  }
  return { request, managedPython };
}

module.exports = { createService, findPython, INSTALL_GUIDANCE };
