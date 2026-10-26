/* ⭐ 2026-10-18 在线更新 · 界面这一半（Rust 那一半在 src-tauri/src/app_update.rs，方案 docs/244）。
 *
 * 用户定的：
 *   「发版之后后台静默更新，他们直接点安装就可以了」
 *       → 开软件 20 秒后查一次，之后每 30 分钟查一次；有新版就在后台下载，下好了弹卡「现在安装 / 稍后」。
 *   「不更新就每次弹出要更新」
 *       → 每次打开软件，只要有下好的新版就再弹一次（同一次运行里，同一个版本只弹一次，不刷屏）。
 *   「要必须更新这一档」
 *       → 清单里标了必须更新：弹不能跳过的框，只有「现在更新」和「退出软件」。
 *       ⚠ 只在新版【下载好了】才拦；下载不下来（没网）时照常能用，不把人锁死在一个装不上的更新上。
 *
 * 只有 Tauri 正式壳有 uiwin.update；Electron 开发壳 / 网页测试里没有，整块不启用。
 * 开发版（cargo build 出来的）Rust 那边直接回 disabled，不会去装正式安装包。
 */
(function (root) {
  'use strict';
  var FIRST_CHECK_MS = 20000, EVERY_MS = 30 * 60 * 1000, POLL_MS = 3000;
  var last = null, offered = '', manualOffered = '', pollTimer = 0, checking = null;

  function api() { return root.uiwin && root.uiwin.update; }
  function report(code, opts) { if (root.ERR && root.ERR.report) root.ERR.report(code, opts); }
  function busyCount() {
    try { return typeof root.aiActiveCount === 'function' ? root.aiActiveCount() : 0; } catch (_) { return 0; }
  }

  // 「设置 → 关于软件」那一行
  function describe() {
    var s = last;
    if (!api()) return '这一份不支持在线更新（开发壳）';
    if (!s) return '还没检查';
    switch (s.phase) {
      case 'disabled': return '开发版不检查更新';
      case 'checking': return '正在检查…';
      case 'latest': return '已经是最新版';
      case 'downloading': return '正在后台下载 ' + s.version + (s.total ? '（' + Math.floor(s.received * 100 / s.total) + '%）' : '…');
      case 'ready': return '新版本 ' + s.version + ' 已经下载好了';
      case 'manual': return '有新版本 ' + s.version + '：这一份是解压版，请到官网下载安装包';
      case 'error': return s.error || '检查更新失败';
      default: return '还没检查';
    }
  }

  function offer(s) {
    if (!s) return;
    if (s.phase === 'ready' && offered !== s.version) {
      offered = s.version;
      var notes = s.notes ? '\n' + s.notes : '';
      var busy = busyCount();
      var warn = busy ? '\n⚠ 还有 ' + busy + ' 个任务在跑，现在安装会中断它们（已经出的图不会丢）。' : '';
      if (s.mandatory) {
        report('APP_UPDATE_REQUIRED', {
          message: '新版本 ' + s.version + ' 必须更新后才能继续使用。' + notes + warn,
          confirm: '现在更新', cancel: '退出软件', onConfirm: install, onCancel: quit,
          safeClear: 'none'   // 2026-10-18 深夜：垃圾桶一键清时只收起 —— 这张卡的「取消」是退出软件，不能替用户点
        });
      } else {
        // ⭐ 2026-10-24（用户：「更新通知需要置顶，且更新按钮不用右划就能看到」）：
        //   钉在报错堆最顶（pin:'top'，跟公告一样，只有要你做决定的 L3 卡排在它上面），按钮那一层直接摊开（expand）。
        report('APP_UPDATE_READY', {
          message: '新版本 ' + s.version + ' 已经下载好了。安装大约半分钟，装完自动重新打开。' + notes + warn,
          confirm: '现在安装', cancel: '稍后', onConfirm: install, pin: 'top', expand: true
        });
      }
    } else if (s.phase === 'manual' && manualOffered !== s.version) {
      manualOffered = s.version;
      report('APP_UPDATE_MANUAL', { message: '新版本 ' + s.version + ' 已发布。' + (s.notes ? '\n' + s.notes : ''), pin: 'top', expand: true });
    }
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      api().status().then(function (s) {
        last = s; offer(s);
        if (s && s.phase === 'downloading') poll();
      }).catch(function () {});
    }, POLL_MS);
  }

  // manual = 用户自己点「检查更新」：失败要说出来；后台定时检查失败只记在「关于软件」那一行，不弹卡打扰
  function check(manual) {
    var u = api();
    if (!u) return Promise.resolve({ ok: false, phase: 'unsupported' });
    if (checking) return checking;
    checking = u.check().then(function (s) {
      last = s; offer(s);
      if (s && s.phase === 'downloading') poll();
      if (manual && s && s.phase === 'error') report('APP_UPDATE_FAILED', { message: s.error });
      return s;
    }).catch(function (e) {
      last = { phase: 'error', error: '检查更新失败：' + ((e && e.message) || e) };
      if (manual) report('APP_UPDATE_FAILED', { message: last.error });
      return last;
    }).then(function (s) { checking = null; return s; });
    return checking;
  }

  function install() {
    var u = api();
    if (!u) return Promise.resolve();
    return u.install().then(function (r) {
      // 装成功的话软件已经退出、去跑安装包了，走不到这里；走到这里就是没装成
      if (r && r.ok === false) report('APP_UPDATE_FAILED', { message: String(r.error || '安装没开始') });
    }).catch(function (e) { report('APP_UPDATE_FAILED', { message: String((e && e.message) || e) }); });
  }
  function quit() {
    try { root.uiwin.planner.request({ op: 'quit' }); } catch (_) {}
  }

  root.V7AppUpdate = { check: check, install: install, describe: describe, status: function () { return last; } };
  if (api()) {
    setTimeout(function () { check(false); }, FIRST_CHECK_MS);
    setInterval(function () { check(false); }, EVERY_MS);
  }
})(window);
