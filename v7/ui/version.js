/* 软件版本号（2026-10-16 用户：「设置里面加上一个关于软件 … 写上现在的版本号 … 最好是前端后端都同步，包括那个UXP端全部同步」）
 *
 *   ⚠ 别手改这个文件：版本号一共 6 处（这里 / tauri.conf.json / Cargo.toml / UXP manifest.json / UXP index.js / backend/version.py），
 *     一律用 `node scripts/sync-version.cjs 1.8.1` 一起改；`node scripts/sync-version.cjs --check` 查有没有对不上
 *     （tests/version-sync.test.js 也会查）。
 *   channel：测试版 / 正式版 —— 显示在「设置 → 关于软件」，报问题时一起复制给客服。
 *   date：这一版包是哪天打的。同一个版本号重打补丁包时（比如 10-17 修面板假死，不想让测试的人整包重下）只改它，
 *     分卷文件名不变、只有带 exe 的那一卷变；关于软件里看日期就分得清新旧。
 */
(function (root) {
  'use strict';
  root.V7_VERSION = Object.freeze({ app: '1.9.22', channel: '测试版', date: '2026-10-21' });
})(typeof window !== 'undefined' ? window : globalThis);
