'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createArchiveService } = require('./archive-service.cjs');
const { createBridgeServer } = require('./server.cjs');
let bridge;
eagle.onPluginCreate(async plugin => {
  const directory = path.join(plugin.path, 'archive-receipts');
  const status = document.querySelector('#status');
  const writeJournal = async receipt => {
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, receipt.id + '.json'), temporary = target + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
  };
  const readJournals = async () => {
    let names; try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const values = [];
    for (const name of names.filter(n => /^[a-f0-9]{48}\.json$/.test(n)).sort()) values.push(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')));
    return values.sort((a, b) => a.createdAt - b.createdAt);
  };
  const service = createArchiveService({ eagle, writeJournal, readJournals, confirm: async plan => {
    const details = plan.rows.map(r => r.before.name + ' [' + r.id + ']').join('\n') + '\n新增标签：' + (plan.addTags.join(', ') || '无') + '\n目标分类：' + (plan.toFolder ? plan.toFolder.name : '保持不变') + '\n移出分类：' + (plan.fromFolder ? plan.fromFolder.name : '保留现有分类');
    const result = await eagle.dialog.showMessageBox({ title: 'V7 Eagle 归档确认', message: '确认处理资料库「' + plan.library + '」的 ' + plan.rows.length + ' 个条目？', detail: details, buttons: ['取消', '确认新增标签/移动分类'], type: 'question' });
    return result.response === 1;
  } });
  eagle.onLibraryChanged(() => { service.invalidate(); document.querySelector('#library').textContent = eagle.library.name; });
  const stop = async () => { if (bridge) { await bridge.close(); bridge = null; } service.invalidate(); document.querySelector('#pairing').value = ''; status.textContent = '已断开'; };
  document.querySelector('#stop').onclick = () => stop().catch(error => { status.textContent = error.message; });
  eagle.onPluginBeforeExit(() => { service.invalidate(); if (bridge) bridge.server.close(); });
  try {
    bridge = createBridgeServer({ service }); await bridge.listen();
    document.querySelector('#library').textContent = eagle.library.name;
    document.querySelector('#pairing').value = bridge.token;
    status.textContent = '本机连接已开启。关闭此窗口或断开后，连接码失效。';
  } catch (error) { status.textContent = '连接未开启：' + error.message; }
});
