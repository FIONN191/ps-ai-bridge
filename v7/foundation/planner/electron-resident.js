'use strict';
// 常驻与日程：关掉面板窗口只是藏起来（托盘/菜单栏由 PS AI Bridge 主程序统一提供），日程到点发提醒。
// planner:request({op, scope, ...})：list / save({item}) / remove({id}) / activate / quit → {ok, items}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function installResident({ app, ipcMain, Notification, getWindow, isMainSender }) {
  const file = path.join(app.getPath('userData'), 'v7-planner.json');
  const host = globalThis.__PSAI_V7_HOST__ || {};
  let quitting = false;
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; } };
  const save = (data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
  const itemsOf = (scope) => (load()[scope || 'anonymous'] || []).sort((a, b) => a.dueAt - b.dueAt);
  const notified = new Set();

  function tick() {
    const data = load(), now = Date.now();
    for (const [scope, items] of Object.entries(data)) {
      for (const item of items) {
        const key = `${item.id}@${item.dueAt}`;
        if (item.completed || item.dueAt > now || notified.has(key)) continue;
        notified.add(key);
        try { new Notification({ title: '修图轮椅 · 日程到了', body: item.title || '' }).show(); } catch (_) {}
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('planner:reminder', { scope, id: item.id });
      }
    }
  }
  setInterval(tick, 30000).unref?.();

  // 「社区」等外链用系统浏览器打开，只放行 http/https
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    let u;
    try { u = new URL(String(url || '')); } catch (_) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    try { await require('electron').shell.openExternal(u.toString()); return true; } catch (_) { return false; }
  });

  ipcMain.handle('planner:request', (event, input = {}) => {
    if (isMainSender && !isMainSender(event.sender)) return { ok: false, error: 'PLANNER_CALLER_DENIED' };
    const scope = String(input.scope || 'anonymous');
    const data = load();
    const list = data[scope] || [];
    switch (input.op) {
      case 'list':
      case 'activate':
        tick();
        return { ok: true, items: itemsOf(scope) };
      case 'save': {
        const item = input.item || {};
        const title = String(item.title || '').trim().slice(0, 200);
        const dueAt = Number(item.dueAt);
        if (!title || !Number.isFinite(dueAt)) return { ok: false, error: '日程需要标题和时间' };
        const row = { id: item.id || crypto.randomUUID(), title, note: String(item.note || '').slice(0, 2000), dueAt, completed: !!item.completed, updatedAt: Date.now() };
        data[scope] = [...list.filter((r) => r.id !== row.id), row];
        save(data);
        return { ok: true, item: row, items: itemsOf(scope) };
      }
      case 'remove':
        data[scope] = list.filter((r) => r.id !== input.id);
        save(data);
        return { ok: true, items: itemsOf(scope) };
      case 'quit':
        quitting = true;
        setTimeout(() => app.quit(), 50);
        return { ok: true };
      default:
        return { ok: false, error: `不支持的日程操作：${input.op}` };
    }
  });

  const restore = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
  };
  host.showPanel = restore;

  return {
    restore,
    attach(win) {
      // 关面板 = 藏起来，本机链路和日程照常跑；真正退出走托盘菜单或「退出软件」
      win.on('close', (event) => {
        if (quitting || host.isQuitting?.()) return;
        event.preventDefault();
        win.hide();
      });
    },
  };
}

module.exports = { installResident };
