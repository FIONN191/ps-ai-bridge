'use strict';
// Agent 读文件：只读 V7 自己的界面与文档目录（v7/ui），挡住缓存、密钥、用户图片。
// 改文件 / 回滚这一组需要「修改软件」档位，这一版不开放，统一回 AGENT_TIER_UNSUPPORTED。
const fs = require('node:fs');
const path = require('node:path');

const MAX_READ = 512 * 1024;
const TEXT = /\.(js|cjs|mjs|json|css|html|md|txt)$/i;

function registerAgentIpc(ipcMain, { governance, projectRoot, isMainSender, confirmAccess }) {
  const base = path.resolve(projectRoot, 'ui');
  const resolveInside = (rel) => {
    const p = path.resolve(base, String(rel || '.'));
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error('AGENT_PATH_OUTSIDE');
    if (/[\\/](vendor|assets)[\\/]/.test(p.slice(base.length))) throw new Error('AGENT_PATH_DENIED');
    return p;
  };
  const handle = (name, fn) => ipcMain.handle(`agent:${name}`, async (event, ...args) => {
    if (isMainSender && !isMainSender(event.sender)) return { ok: false, error: 'AGENT_CALLER_DENIED' };
    try { return await fn(event, ...args); } catch (error) { return { ok: false, error: error.message || String(error) }; }
  });

  handle('tierInfo', () => governance.tierInfo());
  handle('requestAccess', async (event, tier) => {
    if (tier !== 'preset_editor') return { ok: false, error: 'AGENT_TIER_UNSUPPORTED' };
    if (!(await confirmAccess(event.sender, tier))) return { ok: false, cancelled: true, error: 'AGENT_ACCESS_DECLINED' };
    return governance.grant(tier);
  });
  handle('readFile', (_e, request = {}) => {
    const file = resolveInside(request.path);
    if (!TEXT.test(file)) return { ok: false, error: 'AGENT_FILE_TYPE_DENIED' };
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, path: path.relative(base, file), size: stat.size, truncated: text.length > MAX_READ, text: text.slice(0, MAX_READ) };
  });
  handle('listFiles', (_e, request = {}) => {
    const dir = resolveInside(request.path || '.');
    const items = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.relative(base, path.join(dir, e.name)), type: e.isDirectory() ? 'dir' : 'file' }));
    return { ok: true, path: path.relative(base, dir) || '.', items };
  });
  for (const name of ['authorize', 'applyChanges', 'diff', 'rollback']) handle(name, () => ({ ok: false, error: 'AGENT_TIER_UNSUPPORTED' }));
  handle('listBackups', () => ({ ok: true, backups: [] }));
  handle('upgradeStatus', () => ({ ok: true, available: false, pending: false }));
  return { governance };
}

module.exports = { registerAgentIpc };
