# 发布交付要求

用户要求每次更新同时完成本机安装与 GitHub 发布，不能将本地打包当成自动更新交付。

1. 更新 desktop/helper/plugin 版本与 CHANGELOG，完成相关验证。
2. 构建 macOS arm64、macOS x64、Windows x64 安装包。
3. 备份并安装当前桌面 App 与 Photoshop 插件；保留用户数据、生成任务和未保存文档，分别报告已安装与已加载状态。
4. 检查待提交内容，提交并推送对应源码；个人配置、密钥、用户图片、第三方安装包及本地分析材料不发布。
5. 在 desktop 运行 `npm run release`，上传三个安装包和含版本、插件版本、文件大小、SHA-256 的 update.json。
6. 验证 GitHub Latest Release 指向当前版本，并实际读取 `https://github.com/FIONN191/ps-ai-bridge/releases/latest/download/update.json`，核对平台文件、大小及摘要。
7. 发布完成后报告 release URL；网络或发布失败时明确说明自动更新尚未可用。
