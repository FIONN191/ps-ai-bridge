'use strict';
// 把 V7 的 Photoshop 桥接插件（v7/uxp-bridge）复制进所选 Photoshop 的 Plug-ins 文件夹。
// 复制、提权（macOS 密码框 / Windows UAC）沿用 PS AI Bridge 的一键安装（desktop/src/plugin-installer.mjs），
// 由主程序通过 globalThis.__PSAI_V7_HOST__.createInstaller 提供。安装前把旧版本备份一份，可以恢复。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isRunning } = require('./photoshop-launcher.js');

const FOLDER = 'Wheelchair-V7-Bridge';
const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return null; } };

function createUxpInstaller({ sourceDir, stateDir, authorize }) {
  const pkg = readManifest(sourceDir) || {};
  const backups = path.join(stateDir, 'v7-bridge-backups');
  let busy = false;

  const host = () => {
    const h = globalThis.__PSAI_V7_HOST__;
    if (!h || typeof h.createInstaller !== 'function') throw Object.assign(new Error('UXP_INSTALLER_UNAVAILABLE'), { code: 'UXP_INSTALLER_UNAVAILABLE' });
    return h;
  };
  const target = (candidate) => {
    const found = authorize(candidate);
    const pluginsDir = path.join(found.root, 'Plug-ins');
    return { found, pluginsDir, dest: path.join(pluginsDir, FOLDER) };
  };

  async function inspect(candidate) {
    const { found, pluginsDir, dest } = target(candidate);
    const installed = readManifest(dest);
    return {
      ok: true,
      target: dest,
      pluginsDir,
      hasPluginsDir: fs.existsSync(pluginsDir),
      installed: !!installed && installed.id === pkg.id,
      installedVersion: installed ? String(installed.version || '') : '',
      packageVersion: String(pkg.version || ''),
      running: isRunning(found),
    };
  }

  async function guarded(fn) {
    if (busy) throw Object.assign(new Error('UXP_INSTALL_BUSY'), { code: 'UXP_INSTALL_BUSY' });
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  async function install(candidate) {
    return guarded(async () => {
      const { found, pluginsDir, dest } = target(candidate);
      if (isRunning(found)) return { ok: false, error: 'UXP_PS_RUNNING' };
      let backupId = '';
      if (readManifest(dest)) {
        backupId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        fs.mkdirSync(backups, { recursive: true });
        fs.cpSync(dest, path.join(backups, backupId), { recursive: true });
      }
      const installer = host().createInstaller({ sourceDir, extras: host().pluginExtras || [], folder: FOLDER });
      await installer.install([pluginsDir]);
      return { ok: true, backupId, installedVersion: String(pkg.version || ''), target: dest };
    });
  }

  async function rollback(candidate, backupId) {
    return guarded(async () => {
      const { found, pluginsDir } = target(candidate);
      if (isRunning(found)) return { ok: false, error: 'UXP_PS_RUNNING' };
      const id = String(backupId || '');
      const dir = path.join(backups, id);
      if (!/^[a-z0-9-]+$/.test(id) || !readManifest(dir)) return { ok: false, error: 'UXP_BACKUP_NOT_FOUND' };
      const installer = host().createInstaller({ sourceDir: dir, folder: FOLDER });
      await installer.install([pluginsDir]);
      return { ok: true };
    });
  }

  return { inspect, install, rollback, folder: FOLDER };
}

module.exports = { createUxpInstaller, FOLDER };
