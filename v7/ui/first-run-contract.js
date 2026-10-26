/* First-use contract. The consent is local to this installation and is not
 * bundled into account backups or sent to the backend. The tutorial and terms
 * are first-use requirements; Photoshop, image providers and LLMs are optional
 * connections and must not lock unrelated parts of the application.
 */
(function (root) {
  'use strict';
  // 2026-10-18 教程（tutorial-host.js）里用教程专用的钥匙：教程自己写「已同意」，不能顺手把用户真的同意记录也写上
  var KEY = root.__V7_TUTORIAL__ ? 'wheelchair.v7.tutorial.first-use-consent.v1' : 'wheelchair.v7.first-use-consent.v1';
  var RECEIPT = root.__V7_TUTORIAL__ ? 'wheelchair.v7.tutorial.first-use-consent.receipt' : 'wheelchair.v7.first-use-consent.receipt';
  // ⭐ 2026-10-10：版本号从 '2026-09-v1' 提到 '2026-10-v2'。
  //   ⚠ 为什么必须提：同意书的内容改了（加了遥测那一段）。
  //     老用户手里存的是 v1 的同意记录 —— 内容变了还沿用旧记录，
  //     等于"用户没看过新条款就算他同意了"。提版本会让老用户再看一次。
  //   ⚠ 提版本的代价：所有老用户下次启动会多弹一次。这是对的代价。
  var VERSION = '2026-10-v2';
  // ⭐⭐ 2026-10-10（用户定）：「遥测默认开，首次使用软件时弹出告诉用户」
  //   ⇒ 把遥测写进这份首启同意书里。
  //   ⚠ 措辞必须跟【实际发的东西】对得上（铁律 15：不许假开关、不许空话）。
  //     实际发什么见 backend/telemetry_scrub.py 的清洗白名单 —— 这里只写人话摘要，
  //     细节在设置里能看（设置 → 工具与隐私 → 使用数据）。
  //   ⚠ 必须同时说清"怎么关"，不然"默认开"就变成了偷偷上报。
  var TELEMETRY = '使用数据（遥测）默认开启：会上报软件版本、功能用了多少次、耗时、失败的错误码，用来定位崩溃和改优先级。'
    + '发送前会做清洗：中文内容和可能的隐私片段会被去掉，手机号、邮箱、Key 这类东西一律不上报。'
    + '不上报你的图片、提示词原文和任何账号密码。'
    //   ⚠ 路径必须写对：我第一版写的是「设置 → 工具与隐私 → 使用数据」，
    //     但实际位置是「设置 → 工具与隐私 → 改进计划」那一节里的开关
    //     （ui.html 里标题是"改进计划"，开关文案"发送匿名使用与报错信息"）。
    //     路径写错的后果：用户按图索骥找不到那个开关 ⇒ 等于没有开关（铁律 15）。
    + '随时可以在「设置 → 工具与隐私 → 改进计划」里关掉那个「发送匿名使用与报错信息」开关，'
    + '关掉后立刻停止发送（连启动事件都不发），不影响任何功能。';
  var pending = null;
  function accepted() {
    try { return root.localStorage.getItem(KEY) === 'accepted'; } catch (_) { return false; }
  }
  function save() {
    try {
      root.localStorage.setItem(RECEIPT, JSON.stringify({ version: VERSION, acceptedAt: new Date().toISOString() }));
      root.localStorage.setItem(KEY, 'accepted');
      return true;
    } catch (_) { return false; }
  }
  function requireConsent() {
    if (root.V7Setup?.isBlocking?.()) { root.V7Setup.open().catch(() => {}); return Promise.resolve(false); }
    if (accepted()) return Promise.resolve(true);
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      var open = function () {
        if (!root.UI || typeof root.UI.dialog !== 'function') {
          pending = null;
          resolve(false);
          return;
        }
        root.UI.dialog({
          title: '首次使用说明与条款',
          body: '开始使用前，请确认你已了解：Photoshop 与 UXP 联动用于画布读取和结果传回；发送给第三方图像 API 或语言模型的内容由你选择并可能产生服务商费用；平台算力会在提交前显示预估并先扣积分，官方结果失败或退出后不自动退款；自己的 API Key 默认只保存在本机，云端同步必须单独同意；社区、在线状态和客服数据遵守各自的隐私设置。'
            // ⭐ 2026-10-10：遥测那一段（单独一行，免得被前面那坨淹掉）
            + '\n\n' + TELEMETRY,
          detail: 'Photoshop、图像 API 和语言助手可以在首次设置中按需配置，也可以进入软件后再设置。不同意时不会启动生图、修图或工具计算。之后可在“设置中的存储与隐私”查看访问边界和恢复规则。',
          confirm: '我知道了并同意',
          cancel: '暂不使用',
          onConfirm: function () {
            var saved = save(); pending = null; resolve(saved);
            if (!saved && root.ERR) root.ERR.report('FIRST_USE_SAVE_FAILED');
          },
          onCancel: function () {
            pending = null;
            if (root.UI && root.UI.notice) root.UI.notice({ title: '尚未同意使用条款', body: '本次修图已阻断。完成阅读并同意后，才能开始计算。', confirm: '知道了' });
            resolve(false);
          }
        });
      };
      if (root.UI && typeof root.UI.dialog === 'function') open();
      else setTimeout(open, 0);
    });
    return pending;
  }
  root.V7FirstRun = Object.freeze({ isComplete: accepted, require: requireConsent, key: KEY, version: VERSION,
    describe: function () { return { version: VERSION, title: '首次使用说明与条款', body: 'Photoshop 与 UXP 联动可启用画布读取和结果传回；未连接时，其他不依赖这些能力的功能仍可使用。第三方图像服务和语言模型由你自行配置，调用内容可能产生服务商费用。平台算力会在提交前显示预估并先扣积分，失败、取消、部分返回或退出后不自动退款。自己的 API Key 默认只保存在本机，云端同步必须单独同意。社区、在线状态和客服数据遵守各自的隐私设置。\n\n' + TELEMETRY, detail: 'Agent 默认为只读，修改软件前需单独授权、确认并建立备份。不同意条款时不会启动生图、修图或工具计算。Photoshop、图像 API 与语言助手可在首次设置中按需配置，也可进入软件后再设置；之后可在设置中的存储与隐私查看访问边界和恢复规则。' }; },
    accept: function (version) { return version === VERSION && save(); },
    receipt: function () { try { return JSON.parse(root.localStorage.getItem(RECEIPT) || 'null'); } catch (_) { return null; } }
  });
})(window);
