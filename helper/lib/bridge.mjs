// 桌面端 → Photoshop 面板的指令通道。桌面端不能直接操作 PS，所以把指令放在这里排队，
// 面板每 300 ms 轮询一次快捷键（/shortcuts/poll）时顺带取走一条，做完再把结果 POST 回来（/bridge/result）。
import crypto from 'node:crypto';

const ONLINE_MS = 2000;
const pending = []; // 还没被面板取走的指令
const waiting = new Map(); // id -> { resolve, reject, timer }
let lastSeen = 0;
let doc = null;
let capable = false;

// 面板每次轮询时调用：记下在线状态、当前文档、能不能接指令，返回一条待办指令（没有就是 null）。
// 0.4.1 之前的面板也会轮询，但不认识指令，不能把指令交给它
export function take(activeDoc, supportsCommands) {
  lastSeen = Date.now();
  doc = activeDoc || null;
  capable = Boolean(supportsCommands);
  return capable ? pending.shift() || null : null;
}

export function status() {
  const online = Date.now() - lastSeen < ONLINE_MS;
  return { psOnline: online, doc: online ? doc : null, commands: online && capable };
}

// 桌面端发指令，等面板做完。面板不在线时立刻报错，不排队干等
export function request(cmd, timeoutMs = 120000) {
  const s = status();
  if (!s.psOnline) return Promise.reject(new Error('Photoshop 面板没有连上：打开 Photoshop，在「增效工具 → AI 生图贴回」里打开面板'));
  if (!s.commands) return Promise.reject(new Error('Photoshop 里的插件是旧版本，接不了桌面端的指令：到「设置」页点「更新插件」，然后重启 Photoshop'));
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      const i = pending.findIndex((c) => c.id === id);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('Photoshop 没有响应（可能有对话框开着，或正在执行别的操作）'));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    pending.push({ ...cmd, id, expiresAt: Date.now()+timeoutMs });
  });
}

export function settle({ id, ok, result, error }) {
  const w = waiting.get(id);
  if (!w) return false;
  waiting.delete(id);
  clearTimeout(w.timer);
  if (ok) w.resolve(result ?? {});
  else w.reject(new Error(error || 'Photoshop 里执行失败'));
  return true;
}
