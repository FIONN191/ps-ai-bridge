/* 云端官方预设同步（2026-10-15 用户定）
 *
 *   「用户在连接上我们的云端的时候，就直接去把预设拉下来」「问要不要同步 / 给个按钮，放到报错栏里面就好了」：
 *     · 登录（或换账号）后自动拉一次，合进预设库（规则见 preset-store syncOfficialPresets：只加新的、
 *       只换没改过的提示词和下拉选项，用户自己的预设一律不碰）；
 *     · 有新增 / 更新才在报错栏冒一张绿卡说清楚，带「再同步一次」；没变化不打扰；
 *     · 拉失败（没网、云端在维护）冒一张黄卡说原因，带「重试」—— 不拿旧的冒充新的；
 *     · 预设列表顶上常驻一个「同步云端」按钮，随时手动拉（一次性提示要留常驻入口）。
 *   云端给的只有参数说明，不带工作流本体；这种预设只能用平台云算力跑（workflow-runtime 会拦本地）。
 */
(function (root) {
  'use strict';
  let running = null, lastAccount = null, lastResult = null, timer = 0;
  const EVERY_MS = 30 * 60 * 1000;   // 在线时每 30 分钟拉一次（后台下发的不用等下次登录）

  function presetsReady() {
    const P = root.PRESETS;
    if (!P) return Promise.reject(Object.assign(new Error('预设系统没加载'), { code: 'CLOUD_PRESETS_UNAVAILABLE' }));
    return typeof P.init === 'function' ? P.init() : Promise.resolve();
  }
  function noticeSynced(result, manual) {
    const parts = [];
    if (result.added) parts.push('新增 ' + result.added + ' 条');
    if (result.updated) parts.push('更新 ' + result.updated + ' 条');
    if (result.keptYours) parts.push(result.keptYours + ' 条你改过的没覆盖');
    const body = parts.length ? '云端预设：' + parts.join('、') + '。你自己改过的提示词和自己存的预设都没动。'
      : '云端预设都是最新的，没有要更新的。';
    if (!parts.length && !manual) return;              // 自动同步没变化：不打扰
    if (root.UI && typeof root.UI.notice === 'function') {
      // ⭐ 2026-10-18 深夜（用户：「同步完成了，他没有任何的取消入口，他只有再同步一次，你这不闹吗」）：
      //   主按钮改成「知道了」（点了就收）；「再同步一次」挪成旁边的普通按钮（按了不收卡，照旧同步）。
      root.UI.notice({ title: parts.length ? '云端预设已同步' : '云端预设已是最新', body, level: 'ok',
        confirm: '知道了',
        actions: [{ key: 'resync', label: '再同步一次', run: () => { sync({ manual: true }); } }] });
    }
  }
  function noticeFailed(error) {
    if (root.ERR && typeof root.ERR.report === 'function') {
      root.ERR.report('CLOUD_PRESETS_SYNC_FAILED', { message: String(error && error.message || error),
        confirm: '重试', onConfirm: () => { sync({ manual: true }); } });
    }
  }

  // manual：手动点的（没变化也要告诉一声）
  function sync(options) {
    const manual = !!(options && options.manual);
    if (running) return running;
    const backend = root.V7Backend;
    if (!backend || !backend.state || !backend.state().signedIn) {
      if (manual && root.ERR) root.ERR.report('CLOUD_PRESETS_LOGIN_REQUIRED', {});
      return Promise.resolve({ skipped: true, reason: 'signed-out' });
    }
    running = (async () => {
      await presetsReady();
      // ⭐ 2026-10-24 晚：两样各拉各的 —— 工作流官方预设（平台工作流服务没配好时会报错）坏了，不能把云端预设库也拖死（端到端模拟抓到的）。
      //   两样都失败才报「没拉下来」；只坏一样的，坏的那样下次再拉。
      let official = { added: 0, updated: 0 }, library = { added: 0, updated: 0, keptYours: 0, changed: 0 }, firstError = null;
      try { official = await root.PRESETS.syncOfficialPresets(await backend.officialPresets()); }
      catch (error) { if (error && error.code === 'BACKUP_ACCOUNT_CHANGED') throw error; firstError = error; }
      // 云端预设库（V7待办/16）。老后台没这个接口（404）⇒ 当没有，不算失败
      if (typeof backend.presetLibrary === 'function' && typeof root.PRESETS.syncCloudLibrary === 'function') {
        try {
          const lib = await backend.presetLibrary(await root.PRESETS.cloudLibraryCursor());
          library = await root.PRESETS.syncCloudLibrary(lib);
          firstError = null;   // 预设库拉到了 ⇒ 不弹「没拉下来」（工作流那份下次再说）
        } catch (error) {
          if (error && error.code === 'BACKUP_ACCOUNT_CHANGED') throw error;
          if (!(error && (error.status === 404 || error.code === 'NOT_FOUND'))) firstError = firstError || error;
        }
      }
      if (firstError) throw firstError;
      lastResult = { at: Date.now(), official, library, count: root.PRESETS.cloudLibraryCount ? root.PRESETS.cloudLibraryCount() : 0 };
      try { root.dispatchEvent(new CustomEvent('wheelchair:cloud-presets-synced', { detail: lastResult })); } catch (_) { }
      const result = { added: (official.added || 0) + (library.added || 0), updated: (official.updated || 0) + (library.updated || 0), keptYours: library.keptYours || 0 };
      if (result.added || result.updated || library.changed) {
        try { root.dispatchEvent(new CustomEvent('wheelchair:presets-changed', { detail: { source: 'cloud-official' } })); } catch (_) { }
        // 新加的预设马上出现在列表里、底栏条数跟着变（卡没打开时这两个是空操作）
        if (root.PRESETUI) { try { root.PRESETUI.renderCrumb(); root.PRESETUI.refreshListOnly(); } catch (_) { } }
      }
      noticeSynced(result, manual);
      return result;
    })().catch(error => {
      // 换账号中途打断的不报（新账号会重新同步一次）
      if (error && error.code === 'BACKUP_ACCOUNT_CHANGED') return { skipped: true, reason: 'account-changed' };
      noticeFailed(error);
      return { ok: false, error: String(error && error.message || error) };
    }).finally(() => { running = null; });
    return running;
  }

  if (root.ERR && typeof root.ERR.register === 'function') {
    root.ERR.register('CLOUD_PRESETS_SYNC_FAILED', { severity: 'L2', level: 'warn', title: '云端预设没拉下来',
      advice: '检查网络后点「重试」。已经在本机的预设照常能用。' });
    root.ERR.register('CLOUD_PRESETS_LOGIN_REQUIRED', { severity: 'L2', level: 'warn', title: '先登录再同步云端预设',
      advice: '云端预设要登录平台账号才能拉。' });
  }

  // 登录 / 换账号后自动拉一次
  function watch() {
    const backend = root.V7Backend;
    if (!backend || typeof backend.onChange !== 'function') return;
    const check = snapshot => {
      const account = snapshot && snapshot.signedIn && snapshot.account ? String(snapshot.account.id || snapshot.account.email || '') : '';
      if (account && account !== lastAccount) { lastAccount = account; setTimeout(() => { sync({ manual: false }); }, 1500); }
      if (!account) lastAccount = null;
      clearInterval(timer); timer = 0;
      if (account) timer = setInterval(() => { if (!root.document || !root.document.hidden) sync({ manual: false }); }, EVERY_MS);
    };
    backend.onChange(check);
    try { check(backend.state()); } catch (_) { }
  }
  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', watch);
  else setTimeout(watch, 0);

  // 设置卡里的常驻按钮（data-cloud-presets-sync）。监听挂在 document 上只挂一次，设置卡重画不影响
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('click', event => {
      // 设置卡里那个「去社区卡同步云端预设」（2026-10-24 晚：同步入口挪到社区卡）
      const go = event.target && event.target.closest && event.target.closest('[data-go-community-cloud]');
      if (go && typeof root.navigateCard === 'function') { event.preventDefault(); root.navigateCard('community', 0, { section: 'cloud' }).catch(() => {}); return; }
      const button = event.target && event.target.closest && event.target.closest('[data-cloud-presets-sync]');
      if (!button) return;
      event.preventDefault();
      button.disabled = true;
      sync({ manual: true }).finally(() => { button.disabled = false; });
    });
  }

  root.V7CloudPresets = { sync, last: () => lastResult, EVERY_MS };
})(typeof window !== 'undefined' ? window : globalThis);
