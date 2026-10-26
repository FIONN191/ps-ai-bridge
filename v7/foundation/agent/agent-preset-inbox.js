'use strict';
// 外部 Agent 预设收件箱：外部 Agent 往固定目录写 JSON，界面扫描后进入专用预设列表。
// 目录：<appData>/PS AI Bridge/v7-agent-presets/<scope>/inbox，处理过的文件挪到 done。
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 2 * 1024 * 1024;

function registerAgentPresetInbox(ipcMain, { appData, isMainSender, openPath, confirm }) {
  let enabled = null; // { scope, dir }
  const rootDir = path.join(appData, 'PS AI Bridge', 'v7-agent-presets');
  const handle = (name, fn) => ipcMain.handle(`agentPresets:${name}`, async (event, ...args) => {
    if (isMainSender && !isMainSender(event.sender)) return { ok: false, error: 'AGENT_PRESET_CALLER_DENIED' };
    try { return await fn(...args); } catch (error) { return { ok: false, error: error.message || String(error) }; }
  });
  const info = () => ({ ok: true, enabled: !!enabled, scope: enabled ? enabled.scope : null, inbox: enabled ? path.join(enabled.dir, 'inbox') : null });

  handle('enable', async (request = {}) => {
    const scope = String(request.scope || request.namespaceId || 'anonymous');
    if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(scope)) return { ok: false, error: 'AGENT_PRESET_SCOPE_INVALID' };
    if (!(await confirm())) return { ok: false, cancelled: true };
    const dir = path.join(rootDir, scope.replace(/:/g, '_'));
    for (const sub of ['inbox', 'done']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    enabled = { scope, dir };
    return info();
  });
  handle('disable', () => { enabled = null; return info(); });
  handle('info', () => info());
  handle('scan', () => {
    if (!enabled) return { ok: false, error: 'AGENT_PRESET_INBOX_DISABLED' };
    const inbox = path.join(enabled.dir, 'inbox');
    const items = [];
    for (const name of fs.readdirSync(inbox)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(inbox, name);
      try {
        if (fs.statSync(file).size > MAX_FILE) { items.push({ file: name, error: 'AGENT_PRESET_TOO_LARGE' }); continue; }
        items.push({ file: name, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
      } catch (error) { items.push({ file: name, error: 'AGENT_PRESET_JSON_INVALID' }); }
    }
    return { ok: true, items };
  });
  handle('ack', (request = {}) => {
    if (!enabled) return { ok: false, error: 'AGENT_PRESET_INBOX_DISABLED' };
    for (const name of Array.isArray(request.files) ? request.files : [request.file]) {
      if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || !name.endsWith('.json')) continue;
      const from = path.join(enabled.dir, 'inbox', name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(enabled.dir, 'done', `${Date.now()}-${name}`));
    }
    return { ok: true };
  });
  handle('openFolder', async () => {
    if (!enabled) return { ok: false, error: 'AGENT_PRESET_INBOX_DISABLED' };
    const error = await openPath(path.join(enabled.dir, 'inbox'));
    return error ? { ok: false, error } : { ok: true };
  });
}

module.exports = { registerAgentPresetInbox };
