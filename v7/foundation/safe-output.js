'use strict';
// 从 Finder / 开机启动打开的 App 没有终端，stdout 管道随时可能被关掉；往关掉的管道写会抛 EPIPE 并带崩主进程。
function installSafeOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || stream.__psaiSafe) continue;
    stream.__psaiSafe = true;
    stream.on('error', (error) => { if (error && error.code !== 'EPIPE') try { process.emitWarning(error); } catch (_) {} });
  }
}
module.exports = { installSafeOutput };
