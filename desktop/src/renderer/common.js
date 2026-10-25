// 设置页和工作台共用的小工具
const $ = (id) => document.getElementById(id);
// 与 PS 面板一致：Nano Banana 在前，GPT Image 在后；不改变自动换平台顺序。
const PROVIDER_DISPLAY_ORDER = ['aistudio', 'agy', 'gemini-api', 'flow', 'codex', 'openai-api', 'chatgpt'];
function displayProviders(providers) {
  const rank = (key) => {
    if (providers[key]?.family === 'banana') return 3.5;
    if (providers[key]?.family === 'gpt') return 6.5;
    const i = PROVIDER_DISPLAY_ORDER.indexOf(key);
    return i < 0 ? PROVIDER_DISPLAY_ORDER.length : i;
  };
  return Object.entries(providers || {}).sort(([a], [b]) => rank(a) - rank(b));
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// ipcRenderer.invoke 抛出的错误会带一串前缀，只留真正的原因
const reason = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const STATUS = {
  starting: ['run', '启动中…'],
  running: ['ok', '运行中'],
  external: ['ok', '运行中（外部启动）'],
  restarting: ['run', '重启中…'],
  error: ['bad', '出错'],
  stopped: ['bad', '已停止'],
};

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
