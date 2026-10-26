# v7/foundation

修图轮椅 V7 的 Electron 主程序（`v7/ui/main.js`，夏三七原作）会 `require('../foundation/...')` 一批共享模块。
这批模块没有随 V7 安装包发布，这里是 PS AI Bridge 按 V7 界面实际使用的接口补写的版本，Mac / Windows 都能跑。

- `scripts/import-v7.mjs` 导入新版 V7 时只替换 `v7/ui`、`v7/uxp-bridge`、`v7/eagle-bridge`、`v7/engine`，不动这里。
- 需要用到 PS AI Bridge 自己能力的地方（插件安装、托盘），通过主进程放在 `globalThis.__PSAI_V7_HOST__` 上的对象取用。

| 模块 | 提供给界面的接口 |
|---|---|
| `safe-output.js` | 终端被关掉时 stdout 写入不让主进程崩 |
| `security/secret-vault.js` | `secrets:get/set/remove/list`，用系统钥匙串加密（Electron safeStorage） |
| `cache/cache-lifecycle.js` | `cache:*`：生成缓存 `<根>/<项目>/<任务>/`、回收站、检查点、用量 |
| `planner/electron-resident.js` | `planner:request`、日程提醒、窗口常驻 |
| `photoshop/photoshop-launcher.js` | 找 Photoshop、启动 Photoshop |
| `photoshop/uxp-installer.js` | 把 V7 桥接插件装进 Photoshop 的 Plug-ins（检查 / 安装 / 恢复备份） |
| `browser/browser-host.js` | 幕布里的内置网页（`browser:request`） |
| `agent/*` | Agent 的只读文件访问与预设权限；改软件文件的高档位不开放 |
