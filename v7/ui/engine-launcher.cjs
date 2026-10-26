'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ENGINES = Object.freeze({
  match: { script: 'match_server.py', port: 37893, version: '1.0.0' },
  matting: { script: 'multi_engine_server.py', port: 37894, version: '2.1.0-multi' }
});
const pending = new Map();
const owned = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => {
  let result = path.resolve(String(value || ''));
  try { result = fs.realpathSync(result); } catch (_) {}
  return process.platform === 'win32' ? result.toLowerCase() : result;
};

/**
 * 请引擎「正常关闭」（它会带走自己的子进程、把显存还掉）。
 * 返回 true = 引擎接受了请求；false = 没接受（调用方自己决定要不要 kill）。
 *
 * ⚠ 为什么用内置 http 而不是 fetch：这个文件在 Electron 主进程和纯 node 测试里都跑，
 *   不假设有全局 fetch。
 * ⚠ 超时给短（1.5 秒）：这是退出流程上的一步，卡住会让用户觉得"关不掉"。
 */
function politelyStop(port, token) {
  return new Promise(resolve => {
    if (!token) return resolve(false);
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      const request = http.request({
        host: '127.0.0.1', port, path: '/shutdown', method: 'GET', timeout: 1500,
        headers: { 'X-Engine-Token': token }
      }, response => {
        response.resume();
        done(response.statusCode === 200);
      });
      request.on('timeout', () => { try { request.destroy(); } catch (_) {} done(false); });
      request.on('error', () => done(false));
      request.end();
    } catch (_) { done(false); }
  });
}

function validateIdentity(which, health, script, models, launchId, pid) {
  const spec = ENGINES[which];
  if (!health || health.ok !== true || health.engine !== which || health.version !== spec.version ||
      !health.script || canonical(health.script) !== canonical(script) ||
      (launchId && health.launchId !== launchId) || (pid !== undefined && health.pid !== pid)) {
    return '端口上的服务不属于本软件版本或本次启动；请检查设置中的引擎与端口，不会自动关闭其它程序。';
  }
  if (which === 'matting' && (!health.modelsDir || canonical(health.modelsDir) !== canonical(models))) {
    return '运行中的引擎使用了不同模型目录；请关闭该引擎后，从本软件重新启动。';
  }
  return null;
}

function validateHealth(which, health, script, models, launchId) {
  const identity = validateIdentity(which, health, script, models, launchId);
  if (identity) return identity;
  if (!health.caps?.numpy || !(health.caps.pil || health.caps.cv2)) {
    return '引擎缺少 numpy 或图像解码依赖；请按随包 engine/README-runtime.md 安装后重试。';
  }
  if (which === 'match' ? !(health.tier >= 2) : !Object.values(health.tiers || {}).some(tier => tier > 0)) {
    return '引擎没有可用能力；请检查模型文件、配套解码器和运行依赖，再从设置重新启动。';
  }
  return null;
}

function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(600, () => finish(true));
  });
}

function healthAt(port) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1200, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 262144) request.destroy();
      });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch (_) { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function pythonInterpreter() {
  for (const launcher of ['py', 'python', 'python3']) {
    try {
      const args = [...(launcher === 'py' ? ['-3'] : []), '-c', 'import sys; print(sys.executable)'];
      const { stdout } = await execute(launcher, args, { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
      const executable = stdout.trim();
      if (path.isAbsolute(executable) && fs.statSync(executable).isFile()) return { executable, launcher };
    } catch (_) {}
  }
  throw new Error('没找到可用的 Python 3；请按随包 engine/README-runtime.md 安装 Python 和可选引擎依赖。');
}

async function launch(which, options) {
  const spec = ENGINES[which];
  if (!spec) return { ok: false, error: '不认识的引擎: ' + which };
  const script = path.join(options.resourceRoot, 'engine', spec.script);
  const models = options.modelsDir;
  let child;
  let logFile;
  try {
    if (!fs.statSync(script).isFile()) throw new Error('找不到引擎脚本: ' + script);
    if (await portOccupied(spec.port)) {
      const health = await healthAt(spec.port);
      const error = validateHealth(which, health, script, models);
      return error ? { ok: false, error } : { ok: true, alreadyRunning: true, pid: health.pid, health };
    }
    let interpreter;
    if (options.python !== undefined) {
      if (typeof options.python !== 'string' || !path.isAbsolute(options.python) || !fs.statSync(options.python).isFile()) {
        throw new Error('独立图像环境的 Python 不可用，请重新准备环境。');
      }
      interpreter = { executable: options.python, launcher: 'managed' };
    } else interpreter = await pythonInterpreter();
    const { executable, launcher } = interpreter;
    fs.mkdirSync(options.logsDir, { recursive: true });
    logFile = path.join(options.logsDir, which + '-startup.log');
    // ⚠⚠⚠ 2026-10-11 审计补（现场：tmp/engine-logs/matting-startup.log 长到 1.37 GB）：
    //   这个日志原来是【每次启动都 'w' 截断】，听着像有上限 —— 其实没有：
    //   引擎一旦活着，它往这个文件里写的东西【没人管】。
    //   实测：一个活着的引擎被探活断开上百万次之后，把文件刷到 1.37 GB，
    //   结果【真正有用的启动信息（设备/模型/档位）被埋在开头，文件大到打不开】。
    //   最直接的后果：出问题时我让用户"把日志发我"，这条路直接废了。
    //   ⇒ 启动前先轮转：超过 MAX_LOG_BYTES 就改名成 .1（只留一份上一轮），再开新的。
    //   ⚠ 为什么留一份而不是直接删：上一次的启动信息（可能正是崩溃现场）还得能看。
    const MAX_LOG_BYTES = 8 * 1024 * 1024;
    try {
      const st = fs.statSync(logFile);
      if (st.size > MAX_LOG_BYTES) {
        const prev = logFile + '.1';
        try { fs.rmSync(prev, { force: true }); } catch (_) {}
        fs.renameSync(logFile, prev);
      }
    } catch (_) { /* 文件不存在 = 第一次跑，正常 */ }
    const log = fs.openSync(logFile, 'w');
    const launchId = crypto.randomUUID();
    // ⭐⭐ 2026-10-10（修"关掉软件引擎还在、白占显存"）：
    //   给引擎三样东西，让它在软件没了的时候能自己走、在软件正常退出时能被干净地关掉。
    //
    //   ⚠ 为什么必须传【父进程启动时间】而不只是 PID：
    //     Windows 会复用 PID。只查"这个号还在不在"的话，
    //     爹死了、系统把这个号给了别的进程 ⇒ 引擎以为爹还活着，永远不退。
    //     两个一起对，才敢说"是我原来那个爹"。
    //   ⚠ 口令：/shutdown 那个口在本机，谁都够得着。没口令 = 随便谁都能踢掉用户的引擎。
    //     随机生成、走环境变量传（不落盘、不进日志、不出现在命令行里）。
    const engineToken = crypto.randomBytes(24).toString('hex');
    let parentStarted = '';
    try {
      // process.pid 就是引擎的爹。uptime() 是 Node 进程自己的存活秒数 ⇒ 反推启动时刻。
      parentStarted = String(Date.now() / 1000 - process.uptime());
    } catch (_) { parentStarted = ''; }
    const args = [...(options.python !== undefined ? ['-E', '-s', '-X', 'utf8'] : []), '-u', script, ...(which === 'matting' ? ['--models', models] : [])];
    try {
      child = spawn(executable, args, {
        cwd: options.resourceRoot, windowsHide: true, detached: true,
        env: {
          ...process.env, PYTHONUTF8: '1', WHEELCHAIR_ENGINE_LAUNCH_ID: launchId,
          WHEELCHAIR_ENGINE_PARENT_PID: String(process.pid),
          WHEELCHAIR_ENGINE_PARENT_STARTED: parentStarted,
          WHEELCHAIR_ENGINE_TOKEN: engineToken
        },
        stdio: ['ignore', log, log]
      });
    } finally { fs.closeSync(log); }
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + (options.timeoutMs || 45000);
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('引擎在就绪前退出，请检查启动日志中的依赖或模型错误。');
      const health = await healthAt(spec.port);
      if (health) {
        const error = validateHealth(which, health, script, models, launchId);
        if (error) throw new Error(error);
        owned.set(options.resourceRoot + ':' + which, { child, script, models, launchId, logFile, engineToken });
        child.unref();
        return { ok: true, launcher, pid: health.pid, health, logFile };
      }
      await wait(200);
    }
    throw new Error('引擎在 45 秒内未就绪；请检查启动日志、Python 依赖和模型文件后重试。');
  } catch (error) {
    // Only the process created by this call may be stopped on failed startup.
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      child.kill();
      await Promise.race([exited, wait(2000)]);
    }
    return { ok: false, error: String(error.message || error) + (logFile ? ' 启动日志: ' + logFile : ''), ...(logFile ? { logFile } : {}) };
  }
}

function startEngine(which, options) {
  which = String(which || 'match');
  const key = options.resourceRoot + ':' + which;
  if (!pending.has(key)) pending.set(key, launch(which, options).finally(() => pending.delete(key)));
  return pending.get(key);
}

async function stopEngine(which, options) {
  which = String(which || 'match');
  const spec = ENGINES[which];
  if (!spec) return { ok: false, error: '不认识的引擎: ' + which };
  const key = options.resourceRoot + ':' + which;
  if (pending.has(key)) return { ok: false, error: '图像引擎仍在启动，请等待启动检查完成。' };
  const owner = owned.get(key);
  if (!owner) {
    const health = await healthAt(spec.port);
    return { ok: false, pid: health?.pid || null, logFile: path.join(options.logsDir, which + '-startup.log'),
      error: '本次软件未创建该引擎进程，不能代为停止。请手动退出之前或其它程序启动的引擎后重试。' };
  }
  const { child, script, models, launchId, logFile, engineToken } = owner;
  if (child.exitCode !== null || child.signalCode !== null) {
    owned.delete(key);
    return { ok: true, alreadyStopped: true, pid: child.pid, logFile };
  }
  const health = await healthAt(spec.port);
  const identity = validateIdentity(which, health, script, models, launchId, child.pid);
  if (identity) return { ok: false, pid: child.pid, logFile, error: identity + ' 未能核实本次进程，未发送停止信号。' };
  // ⭐⭐ 2026-10-10：先走【正常关闭】，再兜底 kill。
  //
  //   ⚠ 为什么不能只用 kill：引擎是 detached 起来的，它自己又 spawn 了
  //     torch_worker（抱着最多 9.6GB 显存）。
  //     kill 引擎本体之后，那个子进程【会变成孤儿继续活着】——
  //     实测就是这么来的：主程序早关了，引擎和 torch_worker 跑了 42 小时。
  //     正常关闭这条路会让引擎把子进程一起带走、顺带还显存。
  const stopped = await new Promise(resolve => {
    const finish = value => { clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); resolve(value); };
    const exited = () => finish(true);
    const failed = () => finish(false);
    const timer = setTimeout(() => finish(false), 6000);
    child.once('exit', exited); child.once('error', failed);
    politelyStop(spec.port, engineToken).then(accepted => {
      // 口令不对/引擎太老/没起来 ⇒ 退回原来那招（至少把引擎本体停掉）
      if (accepted) return;
      try { if (!child.kill()) finish(false); } catch (_) { finish(false); }
    });
  });
  if (!stopped) return { ok: false, pid: child.pid, logFile, error: '未能确认本次引擎已退出，请检查该进程后重试。' };
  owned.delete(key);
  return { ok: true, stopped: true, pid: child.pid, logFile };
}

module.exports = { ENGINES, validateIdentity, validateHealth, startEngine, stopEngine, healthAt, portOccupied };
