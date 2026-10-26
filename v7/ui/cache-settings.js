'use strict';

// 可嵌入设置页的缓存管理器。文件操作仍由主进程完成，界面只负责
// 显示当前根目录、确认危险动作和刷新回收站列表。
(function (global) {
  function text(value) {
    return String(value == null ? '' : value);
  }
  function defaultNamespace() {
    try {
      return global.WHEELCHAIR_STORAGE && typeof global.WHEELCHAIR_STORAGE.namespaceId === 'function'
        ? global.WHEELCHAIR_STORAGE.namespaceId() : '';
    } catch (_) { return ''; }
  }
  function create(options) {
    options = options || {};
    const cache = options.cache || (global.uiwin && global.uiwin.cache) ||
      (global.desktopBridge && global.desktopBridge.cache) ||
      (global.electronAPI && global.electronAPI.cache) || null;
    const getNamespaceId = options.getNamespaceId || defaultNamespace;
    const canMigrate = options.canMigrate || function () { return true; };
    const afterChanged = options.afterChanged || function () {};
    // ⚠⚠ 2026-10-18 深夜（线上遥测 42 台机器报「plugin:dialog|confirm not allowed by ACL」）：
    //   Tauri 的对话框插件把 window.confirm 换成了【异步】的（返回 Promise），而且没给权限 ——
    //   原来这里同步写 `if (!confirm(...))`：Promise 永远是「真」⇒ 彻底清理 / 删掉这天【不问就直接删了】。
    //   ⇒ 下面一律 await；宿主（ui.html）传的是软件自己的确认卡（UI.dialog），不再用 window.confirm。
    const confirm = options.confirm || function (message) { return Promise.resolve(global.confirm(message)); };
    if (!cache) throw new Error('CACHE_SETTINGS_UNAVAILABLE');

    async function chooseRoot() {
      if (!(await canMigrate())) return { ok: false, error: 'CACHE_BUSY' };
      if (!(await confirm('更改缓存位置前会完整复制并校验现有缓存，旧目录会保留。继续吗？'))) return { ok: false, cancelled: true };
      const result = await cache.chooseRoot();
      if (result && result.ok) await afterChanged(result);
      return result;
    }
    async function listDeleted() {
      return cache.listDeleted(text(await getNamespaceId()));
    }
    async function restore(item) {
      if (!item || !item.recoveryId) return { ok: false, error: 'CACHE_RECOVERY_INVALID' };
      if (!(await confirm('恢复这条缓存记录？同名文件冲突时会停止恢复。'))) return { ok: false, cancelled: true };
      const result = await cache.restoreDeleted({ recoveryId: item.recoveryId, namespaceId: text(await getNamespaceId()) });
      if (result && result.ok) await afterChanged(result);
      return result;
    }
    async function purge(item) {
      if (!item || !item.recoveryId) return { ok: false, error: 'CACHE_RECOVERY_INVALID' };
      if (!(await confirm('彻底清理后无法恢复，且只会删除这条缓存。继续吗？'))) return { ok: false, cancelled: true };
      const result = await cache.purgeDeleted({ recoveryId: item.recoveryId, namespaceId: text(await getNamespaceId()) });
      if (result && result.ok) await afterChanged(result);
      return result;
    }

    // 用量统计（docs/128 §三-4）：按项目、按日期各占多少。
    // ⚠ 拿不到就返回空结构，不抛 —— 老壳没实现这个接口时，
    //   设置页该照常显示"缓存位置 + 回收站"，不能因为少个统计就整页白掉。
    async function usage() {
      if (typeof cache.usageReport !== 'function') return { ok: false, error: 'CACHE_USAGE_UNAVAILABLE' };
      try {
        return await cache.usageReport({ namespaceId: text(await getNamespaceId()) });
      } catch (error) {
        return { ok: false, error: text(error && error.message || error) };
      }
    }

    // 那一天的 run 列表（删之前要先知道删哪些）。
    // ⚠ 按日期删 = 逐条走【现成的】deleteRun，不新写一条"批量删"的底层命令 ——
    //   逐条删会自动进回收站、可恢复，跟用户手动删一条是同一条路。
    async function runsOnDate(date) {
      const listed = await cache.list();
      const runs = (listed && listed.runs) || [];
      const ns = text(await getNamespaceId());
      return runs.filter(function (row) {
        const project = text(row.project);
        if (!project.startsWith(ns + '__')) return false;
        const meta = row.meta || {};
        return runDateOf(row.runId, meta) === date;
      }).map(function (row) { return { project: row.project, runId: row.runId }; });
    }

    async function removeRuns(rows) {
      let done = 0, failed = 0;
      for (const row of rows) {
        try {
          const result = await cache.deleteRun({ namespaceId: text(await getNamespaceId()), project: row.project, runId: row.runId });
          if (result && result.ok) done++; else failed++;
        } catch (_) { failed++; }
      }
      if (done) await afterChanged({ removed: done });
      return { ok: failed === 0, removed: done, failed: failed };
    }

    return { chooseRoot, listDeleted, restore, purge, usage, runsOnDate, removeRuns,
             confirm, root: () => cache.root(), canMigrate, afterChanged };
  }

  // 一个 run 属于哪一天。和主进程 / Rust 侧同一套规则：
  // 先看目录名的日期前缀（20260930-011319-2），看不出来才回落到 meta 的时间戳。
  // ⚠ 兜底顺序不能反 —— "删完重新生成"会让 meta 时间晚于目录名，用户认的是目录名那天。
  function runDateOf(runId, meta) {
    const head = text(runId).slice(0, 8);
    if (/^\d{8}$/.test(head)) return head.slice(0, 4) + '-' + head.slice(4, 6) + '-' + head.slice(6, 8);
    const source = meta || {};
    for (const key of ['completedAt', 'createdAt']) {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value > 0) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
      }
    }
    return '未知日期';
  }

  // 人话的体积。用户没代码概念，别给他看 7270221。
  function humanBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function mount(container, options) {
    if (!container) throw new Error('CACHE_SETTINGS_CONTAINER_REQUIRED');
    const manager = create(options);
    container.textContent = '';
    const section = document.createElement('section');
    section.className = 'cache-settings';
    section.innerHTML = '<div class="cache-settings-title">缓存与回收站</div>' +
      '<div class="cache-settings-root"><span class="cache-settings-root-label">缓存位置</span><code data-cache-root></code><button type="button" data-cache-change>更改位置</button><button type="button" data-cache-open>打开文件夹</button></div>' +
      // 用量总览 + 按日期（用户原话："生图的缓存到几号有多少、怎么删"）
      '<div class="cache-settings-usage"><div class="cache-settings-trash-title">占用情况</div>' +
      '<div class="cache-settings-total" data-cache-total>读取中…</div>' +
      '<div class="cache-settings-dates" data-cache-dates></div></div>' +
      '<div class="cache-settings-trash"><div class="cache-settings-trash-title">可恢复记录</div><div data-cache-items></div></div>' +
      '<div class="cache-settings-status" data-cache-status role="status"></div>';
    container.appendChild(section);
    const rootNode = section.querySelector('[data-cache-root]');
    const itemsNode = section.querySelector('[data-cache-items]');
    const statusNode = section.querySelector('[data-cache-status]');
    const totalNode = section.querySelector('[data-cache-total]');
    const datesNode = section.querySelector('[data-cache-dates]');
    function status(message) { statusNode.textContent = text(message); }

    async function refreshUsage() {
      const result = await manager.usage();
      if (!result || !result.ok) {
        // ⚠ 统计拿不到【不算错】—— 可能只是这个壳还没实现这个接口。
        //   如实说明，但别把整页弄成红的。
        totalNode.textContent = '这台机器上还读不到占用统计';
        datesNode.textContent = '';
        return;
      }
      const total = result.total || {};
      totalNode.textContent = '一共 ' + humanBytes(total.bytes) + ' · ' + text(total.runs) + ' 次生成';
      datesNode.textContent = '';
      const dates = result.byDate || [];
      if (!dates.length) {
        // 2026-10-22（docs/263 第 1 条）：空的时候说清楚「怎么才会有」
        if (window.V7Format) datesNode.innerHTML = window.V7Format.emptyHtml({ title: '还没有生成缓存', hint: '生成过的图会按天存在这里，删掉的也能在下面找回' });
        else datesNode.textContent = '还没有生成缓存';
        return;
      }
      dates.forEach(function (row) {
        const line = document.createElement('div'); line.className = 'cache-settings-item';
        const label = document.createElement('span');
        label.textContent = text(row.date) + ' · ' + text(row.runs) + ' 张 · ' + humanBytes(row.bytes);
        const del = document.createElement('button'); del.type = 'button'; del.textContent = '删掉这天';
        del.addEventListener('click', async function () {
          const runs = await manager.runsOnDate(row.date);
          if (!runs.length) { status('这一天没有可删的记录'); return; }
          // ⚠ 不可逆操作：必须二次确认 + 说清"要删多少"。
          //   只给一个按钮、不说数量的删除，用户点完不知道自己删掉了什么。
          //   manager.confirm 一定有值（create() 里回落成 global.confirm）。
          const ok = await manager.confirm('要删掉 ' + row.date + ' 这天的 ' + runs.length
            + ' 条缓存吗？\n删掉之后可以在下面的「可恢复记录」里找回来。');
          if (!ok) { status('已取消，什么都没删'); return; }
          const r = await manager.removeRuns(runs);
          status(r.ok ? '已删掉 ' + r.removed + ' 条' : ('删了 ' + r.removed + ' 条，' + r.failed + ' 条没删成'));
          await refreshUsage(); await refresh();
        });
        line.append(label, del); datesNode.appendChild(line);
      });
    }

    async function refresh() {
      rootNode.textContent = text(await manager.root());
      const result = await manager.listDeleted();
      itemsNode.textContent = '';
      if (!result || !result.ok || !result.items || !result.items.length) {
        itemsNode.textContent = '回收站为空';
      } else {
        result.items.forEach(function (item) {
          const row = document.createElement('div'); row.className = 'cache-settings-item';
          const label = document.createElement('span');
          label.textContent = text(item.project) + ' / ' + text(item.runId) + (item.kind === 'output' ? ' / 第' + (Number(item.outputIndex) + 1) + '张' : '');
          const restoreButton = document.createElement('button'); restoreButton.type = 'button'; restoreButton.textContent = '恢复';
          const purgeButton = document.createElement('button'); purgeButton.type = 'button'; purgeButton.textContent = '彻底清理';
          restoreButton.addEventListener('click', async function () { const r = await manager.restore(item); status(r && r.ok ? '已恢复' : text(r && r.error)); await refresh(); });
          purgeButton.addEventListener('click', async function () { const r = await manager.purge(item); status(r && r.ok ? '已彻底清理' : text(r && r.error)); await refresh(); });
          row.append(label, restoreButton, purgeButton); itemsNode.appendChild(row);
        });
      }
      await refreshUsage();
    }
    section.querySelector('[data-cache-change]').addEventListener('click', async function () { const r = await manager.chooseRoot(); status(r && r.ok ? '缓存位置已更新' : text(r && r.error)); await refresh(); });
    // 「打开文件夹」：复用主进程/壳现成的 openFolder（传空 project/runId = 打开缓存根）
    const openButton = section.querySelector('[data-cache-open]');
    if (openButton) openButton.addEventListener('click', async function () {
      const cache = options.cache || (global.uiwin && global.uiwin.cache);
      if (!cache || typeof cache.openFolder !== 'function') { status('这个环境打不开文件夹'); return; }
      try {
        const r = await cache.openFolder('', '');
        status(r && r.ok === false ? text(r.error) : '已打开缓存文件夹');
      } catch (error) { status(text(error && error.message || error)); }
    });
    refresh().catch(error => status(error.message || String(error)));
    return { manager, refresh, element: section };
  }

  const api = { create, mount };
  global.V7CacheSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
