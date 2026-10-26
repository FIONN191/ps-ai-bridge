// ============================================================
// storage-namespace.js - local persistence boundary
//
// The desktop shell can set window.__WHEELCHAIR_CONTEXT__ before loading
// ui.html.  Every persistent client store then derives a key from the same
// account/device/profile tuple.  Anonymous sessions remain isolated from
// named accounts instead of falling back to one global bucket.
// ============================================================
(function (root) {
  'use strict';

  var MAX_PART = 64;

  function clean(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    text = text.replace(/[^a-zA-Z0-9._~-]/g, '_').slice(0, MAX_PART);
    text = text.replace(/\.\.+/g, '_');
    return text || fallback;
  }

  function queryContext() {
    try {
      var params = new URLSearchParams(root.location && root.location.search || '');
      return {
        accountId: params.get('accountId') || params.get('account') || '',
        deviceId: params.get('deviceId') || params.get('device') || '',
        profileId: params.get('profileId') || params.get('profile') || ''
      };
    } catch (_) {
      return {};
    }
  }

  function normalize(input) {
    var source = input && typeof input === 'object' ? input : {};
    var query = queryContext();
    return Object.freeze({
      accountId: clean(source.accountId || source.account || query.accountId, 'anonymous'),
      deviceId: clean(source.deviceId || source.device || query.deviceId, 'local-device'),
      profileId: clean(source.profileId || source.profile || query.profileId, 'default')
    });
  }

  var context = normalize(root.__WHEELCHAIR_CONTEXT__ || root.WHEELCHAIR_CONTEXT || {});

  function namespaceId() {
    return 'a-' + context.accountId + '~d-' + context.deviceId + '~p-' + context.profileId;
  }

  function key(name) {
    return 'wheelchair.' + namespaceId() + '.' + clean(name, 'value');
  }

  // ⭐ 2026-10-19（docs/250 第 18、19 条，用户定「跟电脑走」）：不带账号的键 —— 快捷键、自由摆放位置这类「这台电脑的设置」。
  //   原来它们跟账号存：登录过期掉回 anonymous / 换账号 / 开机自动登录慢一步，就换成另一份（快捷键空了、位置像没记住）。
  //   ⚠ 一定要带 profileId：新手教程用 profile=tutorial 隔离，不带的话教程会改到用户真实的快捷键 / 布局。
  //   ⚠ 不带 deviceId：开机早期它可能还是 local-device、后来才变，键会跟着跳。
  function localKey(name) {
    return 'wheelchair.local~p-' + context.profileId + '.' + clean(name, 'value');
  }

  function dbName(name) {
    return 'wheelchair.' + namespaceId() + '.' + clean(name, 'store');
  }

  // ⭐ 2026-10-21（用户定：主题 / 背景图 / 卡片排布「跟电脑走」）：不带账号的数据库名，规矩同 localKey（带 profile、不带账号和 deviceId）。
  function localDbName(name) {
    return 'wheelchair.local~p-' + context.profileId + '.' + clean(name, 'store');
  }

  // 现在是不是站在一个真账号里（没登录 / 登录过期时是 anonymous）。
  //   「跟电脑走」的东西第一次从账号那份接过来时用：anonymous 那格是空的，不能拿它当真。
  function isSignedInContext() {
    return context.accountId !== 'anonymous';
  }

  function cacheProject(project) {
    return namespaceId() + '__' + clean(project, '未命名');
  }

  function ownsCacheProject(project) {
    return String(project || '').indexOf(namespaceId() + '__') === 0;
  }

  function setContext(next) {
    var previous = namespaceId(), previousAccountId = context.accountId;
    context = normalize(next);
    if (previous === namespaceId()) return getContext();
    try {
      // previousAccountId：从哪个账号换过来的（2026-10-21 掉登录提示要用：真账号 → anonymous 才提示）
      root.dispatchEvent(new CustomEvent('wheelchair:storage-context', {
        detail: Object.assign(getContext(), { previousAccountId: previousAccountId })
      }));
    } catch (_) {}
    return getContext();
  }

  function getContext() {
    return {
      accountId: context.accountId,
      deviceId: context.deviceId,
      profileId: context.profileId,
      namespaceId: namespaceId()
    };
  }

  root.WHEELCHAIR_STORAGE = Object.freeze({
    key: key,
    localKey: localKey,
    dbName: dbName,
    localDbName: localDbName,
    isSignedInContext: isSignedInContext,
    namespaceId: namespaceId,
    cacheProject: cacheProject,
    ownsCacheProject: ownsCacheProject,
    getContext: getContext,
    setContext: setContext
  });
})(window);
