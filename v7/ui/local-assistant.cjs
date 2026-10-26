'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const BASE_URL = 'http://127.0.0.1:11434';
const DOWNLOAD_URL = 'https://ollama.com/download';
const LIBRARY_URL = 'https://ollama.com/library';
function failure(message, code = 'LOCAL_ASSISTANT_FAILED') { return Object.assign(new Error(message), { code }); }
function modelName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(name) || name.includes('..') || /(?:^|[:_-])cloud(?:$|[:_-])/i.test(name)) {
    throw failure('请选择本机聊天模型；不接受云模型、路径或下载网址。', 'LOCAL_ASSISTANT_MODEL_INVALID');
  }
  return name;
}
function localModels(value) {
  if (!Array.isArray(value?.models)) throw failure('11434 端口没有返回有效的 Ollama 模型列表。');
  return value.models.filter(row => !row.remote_host && !row.remote_model).flatMap(row => {
    try { return [{ name: modelName(row.name || row.model), size: Number(row.size) || 0, parameters: String(row.details?.parameter_size || '') }]; }
    catch (_) { return []; }
  });
}
function executablePaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe'), env.ProgramFiles && path.join(env.ProgramFiles, 'Ollama/ollama.exe')].filter(Boolean);
  if (platform === 'darwin') return ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'];
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}
function requestJson(route, body, { signal, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    let connected = false, size = 0;
    const req = http.request(BASE_URL + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, signal }, response => {
      connected = true; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(failure('本机运行时响应过大。')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || data.error) throw failure(String(data.error || '本机运行时返回 HTTP ' + response.statusCode).slice(0, 500));
          resolve(data);
        } catch (error) { error.reachable = true; reject(error); }
      });
      response.on('error', error => { error.reachable = true; reject(error); });
    });
    req.on('socket', socket => socket.on('connect', () => { connected = true; }));
    req.on('error', error => { error.reachable = connected; reject(error); });
    req.setTimeout(timeoutMs, () => req.destroy(failure('本机运行时请求超时，请检查运行状态和可用内存。')));
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}
function createLocalAssistant(options = {}) {
  const request = options.request || requestJson, launch = options.spawn || spawn;
  const exists = options.isFile || (name => { try { return fs.statSync(name).isFile(); } catch (_) { return false; } });
  const paths = options.paths || executablePaths();
  const now = options.now || Date.now, sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const pending = new Map();
  function cancel(session) { const controller = pending.get(session); if (controller) { controller.abort(); pending.delete(session); } }
  async function inspect(signal) {
    const executable = paths.find(exists) || '';
    let reachable = false;
    try {
      const version = await request('/api/version', null, { signal });
      reachable = true;
      if (typeof version.version !== 'string' || !version.version) throw Object.assign(failure('11434 端口不是可识别的 Ollama 运行时。'), { reachable: true });
      const models = localModels(await request('/api/tags', null, { signal }));
      return { ok: true, installed: !!executable, running: true, version: version.version, models, executable, baseUrl: BASE_URL + '/v1' };
    } catch (error) {
      if (signal.aborted) throw failure('本地助手准备已停止。', 'LOCAL_ASSISTANT_CANCELLED');
      return { ok: true, installed: !!executable, running: false, occupied: reachable || !!error.reachable, models: [], executable,
        message: reachable || error.reachable ? '11434 端口响应异常：' + error.message : executable ? 'Ollama 已安装，尚未运行。' : '未检测到 Ollama。本地聊天助手暂不可用，可安装后重新检测或跳过。' };
    }
  }
  async function execute(action, payload, signal, current) {
    const check = () => { if (signal.aborted || !current()) throw failure('本地助手准备已停止。', 'LOCAL_ASSISTANT_CANCELLED'); };
    check();
    if (action === 'download-runtime' || action === 'model-library') { await options.openExternal(action === 'download-runtime' ? DOWNLOAD_URL : LIBRARY_URL); return { ok: true }; }
    if (action === 'detect') return inspect(signal);
    if (!['start', 'pull', 'test'].includes(action)) throw failure('本地助手操作无效。');
    const model = action === 'start' ? '' : modelName(payload.model);
    const status = await inspect(signal); check();
    if (action === 'start') {
      if (status.running) return status;
      if (status.occupied) throw failure(status.message);
      if (!status.executable) throw failure('请先安装官方 Ollama，再重新检测。');
      const child = launch(status.executable, ['serve'], { windowsHide: true, shell: false, stdio: 'ignore', cwd: path.dirname(status.executable), env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } });
      let startError = null; child.once('error', error => { startError = error; });
      try {
        const until = now() + 20000;
        while (now() < until) {
          check(); if (startError || child.exitCode != null) throw failure(startError?.message || 'Ollama 在就绪前退出。');
          const ready = await inspect(signal); check(); if (ready.running) { child.unref(); return ready; }
          await sleep(200);
        }
        throw failure('Ollama 20 秒内未就绪，请检查运行时和本机资源后重试。');
      } catch (error) { try { child.kill(); } catch (_) {} throw error; }
    }
    if (!status.running) throw failure(status.message);
    if (action === 'pull') {
      const approved = await options.confirm(model); check();
      if (!approved) return { ok: true, cancelled: true };
      const result = await request('/api/pull', { model, stream: false }, { signal, timeoutMs: 1800000 }); check();
      if (result.status !== 'success') throw failure('模型下载没有完成：' + String(result.status || '没有成功回执'));
      return inspect(signal);
    }
    if (!status.models.some(row => row.name === model)) throw failure('该模型不在已安装的本机模型列表中。', 'LOCAL_ASSISTANT_MODEL_INVALID');
    const info = await request('/api/show', { model }, { signal }); check();
    if (info.remote_host || info.remote_model) throw failure('该条目指向云模型，不能作为本地聊天助手。', 'LOCAL_ASSISTANT_MODEL_INVALID');
    const reply = await request('/api/chat', { model, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, think: false, options: { num_predict: 8 }, keep_alive: 0 }, { signal, timeoutMs: 120000 }); check();
    if (reply.done !== true || typeof reply.message?.content !== 'string' || !reply.message.content.trim()) throw failure('模型没有返回有效的聊天答复，暂不能启用本地助手。');
    return { ok: true, tested: true, config: { baseUrl: BASE_URL + '/v1', protocol: 'openai', model, apiKey: '' } };
  }
  async function run(action, payload, current = () => true) {
    const session = payload.session;
    if (pending.has(session)) return { ok: false, error: '本地助手准备仍在进行。' };
    const controller = new AbortController(); pending.set(session, controller);
    try { return await execute(action, payload, controller.signal, current); }
    catch (error) { return { ok: false, cancelled: controller.signal.aborted, error: error.message, code: error.code || 'LOCAL_ASSISTANT_FAILED' }; }
    finally { if (pending.get(session) === controller) pending.delete(session); }
  }
  return { run, cancel };
}
module.exports = { createLocalAssistant, modelName, localModels, executablePaths, BASE_URL, DOWNLOAD_URL, LIBRARY_URL };
