# PS AI Bridge：AI 生图贴回

在 Photoshop 里画个选区（或选中一个图层），写提示词，点一下：插件把这块画面送到 AI Studio / Google Flow（Nano Banana）或 ChatGPT（GPT Image）生成，出图后自动作为**智能对象**贴回原位置，并用原选区做蒙版。中间不用导出、开浏览器、下载、再拖回 PS。

```
Photoshop 面板（plugin/）  ──图 + 参数──▶  本机 helper（helper/，127.0.0.1:47811）
        ▲                                        │
        └──────── 结果图 ◀────────────────────────┤
                                                 ├─ AI Studio / Flow / ChatGPT 网页：遥控一个专用 Chrome 窗口（你登录过的账号）
                                                 ├─ Codex CLI / agy：复用 agent-imagen-skill 的 gen.sh
                                                 └─ Gemini API / OpenAI API：填了 Key 才启用
```

## 第一次安装

### 用桌面端（推荐）

桌面端「PS AI Bridge」自带本机 helper，不用装 Node，也不用开终端；关掉窗口后它留在菜单栏 / 托盘里继续运行。

1. **安装桌面端**
   - macOS：打开 `PS-AI-Bridge-版本-mac-arm64.dmg`（Intel Mac 用 `x64`），把 PS AI Bridge 拖进「应用程序」。安装包没有 Apple 开发者签名，第一次打开会提示「无法验证开发者」：到 系统设置 → 隐私与安全性 → 最下面点「仍要打开」。
   - Windows：运行 `PS-AI-Bridge-版本-win-x64-setup.exe`，装完自动打开。没有代码签名，SmartScreen 拦的时候点「更多信息 → 仍要运行」。
2. **一键安装插件**：在桌面端点「一键安装插件」。插件会被复制进每个 Photoshop 2024（25.0）以上版本的 `Plug-ins` 文件夹（`Plug-ins/PS-AI-Bridge`），这个文件夹归管理员所有，所以 macOS 会要求输一次密码，Windows 会弹 UAC。macOS 装好后文件夹改归你自己，以后更新不用再输密码。
   - 不需要 Creative Cloud，也不用开开发者模式。修图轮椅、像素起子、Overlord 的手动安装也是这么做的，不过 Adobe 没把这种方式写进文档。
   - 装好并重启后 Photoshop 里还是没有面板：点「改用 Creative Cloud 安装」。桌面端会先删掉 Plug-ins 里那份，再把 `.ccx` 安装包交给 Creative Cloud（需要装着 Creative Cloud 桌面程序），按它的提示确认。默认不走这条路，是因为测试时 Adobe 的插件安装器（UnifiedPluginInstallerAgent）识别不到 Photoshop (Beta)。
   - Photoshop 开着的话，装完要退出再重新打开，菜单 增效工具 → AI 生图贴回 才会出现。
   - 之前用 UXP Developer Tools 加载过开发版，先在 UDT 里 Unload，同一个插件 ID 两份同时在会冲突。
   - Photoshop 装在别的位置：点「手动添加 Photoshop…」，选它的安装文件夹。
3. **登录账号**：第一次打开桌面端会弹出「使用说明」（之后点顶栏的「使用说明」再打开）。点「用 Google 账号登录」「用 ChatGPT 账号登录」，在弹出的专用 Chrome 窗口里登录，登录一次即可；桌面端会显示每个账号是否已登录（设置页「账号登录」），工作台里选了没登录的平台会提示。没有账号可以点里面的购买链接。
   - **使用须知**：使用无需 API 的生图服务（AI Studio、Google Flow、ChatGPT 网页）需要自备魔法，专用 Chrome 要能正常打开 Google 和 ChatGPT。
   - Google 不允许在桌面端的内置窗口里登录（会提示「此浏览器或应用可能不安全」），所以登录放在专用 Chrome 里。
   - 这个 Chrome 用单独的配置目录（数据文件夹里的 `chrome-profile`），和你平时的 Chrome 互不影响。Windows 上没装 Chrome 时用系统自带的 Edge。
   - 建议**不要**在这个窗口里开 Chrome 同步。同步会把你平时的扩展带进来，有的扩展会盖住页面按钮。

数据文件夹：macOS 是 `~/Library/Application Support/ps-ai-bridge/`，Windows 是 `%APPDATA%\ps-ai-bridge\`（桌面端「数据文件夹」按钮直接打开）。下文写的 `~/Library/Application Support/ps-ai-bridge/` 在 Windows 上都对应这里。

**Windows 现状**：桌面端、插件安装、网页平台、官方 API、对齐/校色在代码上都适配了 Windows，但还没有在 Windows 实机上跑过。快捷键桥接没有 Windows 版；Codex CLI / agy 通道依赖 bash 脚本，只能在 macOS 用。

### 用源码（开发）

1. 双击项目里的 `启动 helper.command`（需要 Node 18 以上），第一次会自动安装依赖。终端窗口要一直开着。桌面端开着时它会直接用这个 helper，关掉终端后桌面端自动接管。
2. Photoshop → 设置 → 增效工具 → 勾选「启用开发者模式」，**重启 Photoshop**；打开 Adobe UXP Developer Tools → Add Plugin → 选 `plugin/manifest.json` → Load。UDT 加载的插件在 PS 重启后要再点一次 Load。
3. 桌面端开发：`cd desktop && npm install && npm start`（用仓库里的 `helper/` 和 `plugin/`）。

## 使用

1. 打开图，用任何选区工具框出要改的地方（异形选区也行）。不画选区时，用当前图层的范围。
2. 在「预设」里点剪影上的部位（或搜名字 / 拼音首字母，如 `tf` 搜头发）选一个预设；有参数的预设会出现滑杆和填空框，拖动后提示词里的数值跟着改。也可以直接写提示词，或点「AI 帮写提示词」让本机 Codex 看着选区写一份结构化提示词（约半分钟）。
3. 选平台、张数（1–4）、比例、分辨率，点「生成并贴回」。提交后可以接着修图，也可以连续提交好几组。
4. 出图后放进一个「AI 生成组」：几张备选都在组里，蒙版（按原选区收缩 + 羽化）加在组上，只显示一张。

在面板的生成组卡片里：

| 操作 | 说明 |
|---|---|
| 单击缩略图 | 换用这一张（关了「自动传回」时，单击才把它传回 PS） |
| 双击缩略图 | 切到这一组所在的文档，并选中这张的图层 |
| 强度 | 0 = 原图，100% = AI 图。不是调透明度：helper 按块匹配算出原图到 AI 图的位移，中间的强度是「插帧」出来的，没有重影 |
| 校色 | 不校色 / 全局（整图亮度颜色匹配，适合去杂物）/ 精准（逐像素把原图的颜色还回来，适合修脸这类几乎不变形的修改）/ 混合（和原图接近的地方校正，新加的东西、去掉的杂物和它们周围一圈不动；0.4.1 修掉了以前在去掉的杂物边缘留下淡淡轮廓的问题） |
| 替换纹理 | 把原图的噪点、颗粒叠回 AI 图，补回原片质感；和原图差别大的地方不叠 |
| 应用 | 强度、校色、替换纹理改完要点「应用」才生效（按钮变成「已应用」）；没点应用之前 PS 里的图不变 |
| 贴回失败 | 图已经生成好、只是放进 PS 时出错：卡片上会写原因，缩略图显示「点击重试」，单击就再贴一次 |

这些调整都是在本机算的（不上传），智能对象直接替换内容，位置和蒙版不动。

面板里的下拉框和滑杆不响应滚轮，滚动面板时鼠标划过它们不会误改设置。

新的生成组放在原图层上方、同一层级；原图层上方已经有之前的 AI 生成组时，放到它们最上面。生成时选中的是上一次贴回的图层也没关系，不会套进那个组里。

| 面板选项 | 说明 |
|---|---|
| 参考图 | 最多 4 张：「上传图片」选本地文件，或把图片从访达 / 资源管理器拖进参考图区域（拖放需要 Photoshop 2026 以上）；「PS 选区加参考」抓当前选区，「截图加参考」拖框截屏幕上任何地方（浏览器、微信都行）。提示词前会自动加一句「图1是原图，图2起是参考图」 |
| 要求模型保持构图 | 在提示词后面加一段"构图、取景、比例不变"的要求。贴回能不能对齐主要看这一条，建议一直开着 |
| 比例 | 「自动」会挑平台支持的比例里最接近选区的那个，再把选区向外补成这个比例 |
| 失败自动换平台 | 某个平台失败时换到下一个支持同一比例的平台重试。换过的组，卡片标题显示实际出图的平台，比如「GPT Image · Codex CLI（Nano Banana · AI Studio 网页 失败后换的）」；鼠标停在缩略图上也能看到这张是哪个平台出的 |
| 蒙版收缩 / 边缘羽化 | 按选区短边的百分比收缩蒙版、再高斯模糊，接缝更自然 |
| 快速对齐 | 先整体对齐（缩放 + 平移），再把画面切成 10×10 块，选区外那圈对不上的块各自微调，保证接缝对得上；选区里真正修改的地方不动 |
| 传回为 | 智能对象（默认，能反复换校色/强度）或普通图层 |
| 生成组颜色 | 生成组在图层面板里的颜色标签 |
| 检查点 | 开着时，生成时离上次超过设定时间就把整张画布存一张无损 PNG 到 `~/Pictures/AI生图/ps-ai-bridge/_checkpoints/`，PS 崩了能找回。总量超过 20 GB 从最旧的删（配置文件里的 `checkpointMaxGB` 可改） |
| 历史 | 面板右上角「历史」：helper 存的所有结果（最近 14 天），可以贴到当前选区，贴进来也是一个生成组 |

**快捷键（v0.3.1，macOS）**：面板底部「生成并贴回快捷键」默认 `Cmd+G`。输入如 `Cmd+Shift+G` 或 `Ctrl+Alt+G`，点击「保存快捷键」即可更改；取消「启用」再保存可关闭。支持字母、数字、F1–F12，至少包含 Cmd / Ctrl / Alt 一个修饰键。

快捷键由 helper 的本机组件注册，仅 Photoshop 位于前台、插件会话在线时生效。每次启动 PS 后先打开一次面板，之后可收起面板回到画布使用。停止 helper 或插件会话断开超过 2 秒会释放绑定。默认 ⌘G 生效时会优先用于生图；关闭后恢复 PS 本来的快捷键行为。设定保存在 `~/Library/Application Support/ps-ai-bridge/shortcuts.json`。Windows 的系统快捷键桥接尚未实现。

插件还保留「生成并贴回、选区加参考图、截图加参考图、换下一个平台」四个菜单命令。PS 28.0.1 实测不能在内置快捷键列表中直接找到这些 UXP 命令，因此不再依赖该方式。

送出去的图会转成 8 位 sRGB 的 JPEG（长边最多 2048，选 4K 时最多 3072），原文档的 16 位和色彩空间不受影响。

### 在桌面端生图、看图（工作台）

桌面端的「工作台」页和 PS 面板用同一个 helper、同一套平台和预设，生成照样在后台的专用 Chrome 里跑。

- **原图**三选一：
  - **PS 选区**：桌面端让 PS 面板导出当前选区（没有选区用当前图层），出图后自动贴回。羽化、对齐、校色、贴回方式用 PS 面板里的设置。需要 PS 里开着面板，顶栏会显示「Photoshop · 文档名」。
  - **本地图片**：拖进来、选择或粘贴，不开 PS 也能出图。
  - **不用原图**：只按提示词和参考图生成。
- 参考图（最多 4 张，可以拖进来）、预设（搜名字或拼音首字母，滑杆和填空直接改提示词）、平台、比例、分辨率、张数，都和面板里一样。
- **生成记录**：所有任务（包括 PS 面板里提交的）按组列出，带进度；可以搜提示词、按来源筛选、取消、重新生成（沿用原图和参考图，新开一组）。
- **看大图**：单击缩略图打开，有三个版本：
  - 贴回版本：对齐、校色后贴回 PS 的那张。
  - 网页原图：网页上生成的原样文件。
  - 送去的原图：从 PS 导出、送去生图的那块。

  可以选「原图 ↔ 贴回版本」「网页原图 ↔ 贴回版本」拖白线对比；滚轮缩放、拖动平移、双击复原，← → 换同组的下一张。下面的按钮：贴到 PS 当前选区、用这张继续改、复制图片、在文件夹中显示、复制提示词。

出图后专用 Chrome 里的标签页默认留着，可以直接在网页上看生成的样子；标签页多了嫌乱，在设置页「账号登录」里勾上「出图后自动关闭专用 Chrome 里的标签页」（立即生效，存在数据文件夹的 `prefs.json`）。网页上的原图也留在任务文件夹里（`result-平台…`），在大图里切到「网页原图」就能看。

**控制台**：浏览器打开 http://127.0.0.1:47811 ，可以看所有任务的进度、送出去的原图和结果。
**结果文件**：都留在 `~/Pictures/AI生图/ps-ai-bridge/日期/任务ID/` 里（`input.jpg`、`result-*`、`aligned.png`、各种校色/强度版本、`job.json`）。helper 重启后会读回最近 14 天的任务。

### 预设

- 出厂预设 121 个，来自夏三七「修图轮椅 V6」（GPLv3），在 `helper/presets/factory/`。
- 你的预设在 `~/Library/Application Support/ps-ai-bridge/presets/`。已经从 V6 导出的「轮椅664美式优化v2/presets」搬过来 96 个。别的 V6 预设文件夹也能搬：

  ```bash
  curl -X POST -H 'x-ps-ai-bridge: 1' -H 'content-type: application/json' -d '{"dir":"/V6预设文件夹路径"}' http://127.0.0.1:47811/presets/import
  ```
- 「存为预设」保存当前提示词；删除的预设挪进预设文件夹里的 `.trash`，能找回。

## 平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Nano Banana · AI Studio 网页 | ✅ 在 PS 里实测 | 免费网页额度（不选 API Key）。1K / 2K / 4K，2K + 最高思考约 50 秒。偶发的 "Failed to generate content"、"does not have permission" 会等 8 秒重试一次；还失败多半是免费额度暂时用完，开了「失败自动换平台」会换到别的平台 |
| Nano Banana · Google Flow | ✅ 在 PS 里实测 | 2K 约 1 分 10 秒（1K 原图 + Flow 自带的 2K 高清重塑）。4K 要更高档的 Google One 会员，你的账号是灰的，所以面板里只有 1K / 2K |
| GPT Image · ChatGPT 网页 | ✅ 在 PS 里实测 | 约 1.5–2 分钟，约 1.6K（2:3 出 1024×1536，3:4 出 1086×1448）。思考强度沿用你账号当前的设置 |
| GPT Image · Codex CLI | ✅ 接口实测 | 复用 agent-imagen-skill 的 `gen.sh -e gpt`，3:4 出 1086×1448，约 1 分 40 秒，用 ChatGPT 账号额度 |
| Nano Banana 2 · agy | ✅ 接口实测 | 复用 `gen.sh -e nb`，3:4 出 896×1200，约 1 分 40 秒 |
| Gemini API / OpenAI API | 已写，未实测 | 在配置文件里填 Key 才会启用，见下面 |

三个网页平台都用同一个专用 Chrome，第一次用前在里面登录对应账号（Google 账号管 AI Studio 和 Flow，ChatGPT 单独登录）。

**生成记录会留在你的账号里**：
- ChatGPT：所有生图对话放在 ChatGPT 项目「PS AI Bridge」里，不会混进「最近聊天」。ChatGPT 的临时对话不能生图，所以没法用临时对话。
- Flow：上传的原图和生成结果都在 Flow 项目「PS AI Bridge」里，攒多了可以在 Flow 里批量删。
- 两个项目的地址记在 `~/Library/Application Support/ps-ai-bridge/state.json`。项目被删了，helper 下次会自动新建。

### 官方 API 备选通道

在桌面端点「配置文件（API Key）」，打开的是数据文件夹里的 `config.json`，填上 `geminiApiKey` 或 `openaiApiKey`，保存后点「重启服务」。源码版也可以把 `helper/config.example.json` 复制成 `helper/config.json` 再填（这个文件优先），或者用环境变量 `GEMINI_API_KEY` / `OPENAI_API_KEY`。没写的项沿用 `config.example.json` 的默认值。API 按量计费，Key 只存在本机这个文件里。模型名在同一个文件里改（`geminiModel`、`openaiModel`）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 面板显示「helper 没有运行」 | 打开桌面端 PS AI Bridge，看「本机服务」是不是运行中；出错时点「查看日志」。源码版双击 `启动 helper.command`，终端提示端口被占用说明已经有一个在跑 |
| 一键安装后 Photoshop 里没有面板 | 退出并重新打开 Photoshop。还没有的话，看 Photoshop 的 `Plug-ins` 里有没有 `PS-AI-Bridge` 文件夹，桌面端插件列表里是不是「已安装」 |
| 插件列表提示还有一份同样的插件 | 以前手动放进 `Plug-ins` 的旧版本，删掉那个文件夹，只留 `PS-AI-Bridge` |
| UDT 里 Load 失败（源码版） | 确认开了开发者模式并且**重启过** Photoshop。日志在 `~/Library/Logs/Adobe/Adobe Photoshop (Beta)/UXPLogs_*.log` |
| 任务报「还没登录 Google」或「还没登录 ChatGPT」 | 在专用 Chrome 窗口里登录对应网站 |
| 任务报「AI Studio 可能改版了」或一直不出图 | 网页结构变了，自动化需要更新。AI Studio 失败时会把当时的页面截图存成任务文件夹里的 `fail-aistudio-1.png`（重试的是 `-2`），然后关掉标签页，不在专用 Chrome 里堆积；只有「还没登录」时标签页留着，直接在里面登录。Flow / ChatGPT 失败的标签页仍然留着 |
| 贴回的图和原图有错位 | 模型没有严格保持构图。确认勾了「要求模型保持构图」，提示词里也可以再强调一次 |
| 贴回后有明显方框边 | 调大「边缘羽化」或「选区外扩」，再在蒙版上擦一擦 |
| 「AI 帮写提示词」报没找到 Codex | 装 ChatGPT 桌面版（自带 Codex CLI），或 `npm i -g @openai/codex` 后 `codex login` |
| 「截图加参考」没反应 | 第一次用时 macOS 会要求开「屏幕录制」权限（系统设置 → 隐私与安全性），给 PS AI Bridge（源码版是「终端」）。Windows 调起的是系统截图（Win+Shift+S 那个），截完的图从剪贴板取 |
| 面板提示一闪就看不到 | 面板顶部也会显示同一条提示；helper 终端里有 `[插件]` 开头的完整记录 |

## 风险

- 网页自动化依赖各网站当前的页面结构，改版后可能失效，需要更新 `helper/providers/` 里对应的文件（`aistudio.mjs`、`flow.mjs`、`chatgpt.mjs`）。
- 自动化操作的是你自己的账号，频繁大量生成有被风控的可能。要稳定、大批量，用官方 API 通道。
- 专用 Chrome 以后台方式启动，生成时不会跳到 Photoshop 前面；它的窗口可以最小化，但不要关掉正在生成的标签页。
- 桌面端没有 Apple 开发者签名和 Windows 代码签名，第一次打开要手动放行（见「第一次安装」）。要去掉这一步需要买 Apple Developer ID（并公证）和 Windows 代码签名证书。
- 插件的网络权限写的是 `"domains": "all"`：Photoshop 28 对 `http://127.0.0.1:端口` 这种写法匹配不上（实测报 Manifest entry not found），和你装的 ComfyUI 插件一样只能这么写。插件代码只访问本机 helper。

## 和修图轮椅 V7 的对照

照着夏三七 V7 的教学视频和直播做了这些：剪影预设 + 参数滑杆 + 拼音搜索 + V6 预设搬家、一次多张进生成组、插帧式强度、四档校色、替换纹理、快速对齐（分块）、边缘羽化、参考图（含屏幕截图）、自动传回开关、传回为智能对象/普通图层、组颜色、检查点、完成提示音、快捷键命令、AI 帮写提示词、失败换平台。

没有做的：
- 依赖他们自家后台的：账号与积分、云端 4090D、开源模型（ComfyUI / Qwen）云端工作流、社区、余额与账单、自助咨询。
- 「抗截断」：它的作用是绕过平台的内容审核，不做。
- 助手「夏三六」替你操作软件、批量处理多张图：这里只做了帮写提示词。
- 桌面端的卡片自由摆放、一键收起、置顶等界面功能。这里的桌面端只负责托管 helper、装插件、登录专用浏览器、开机自启，主界面仍是 PS 里的面板。

## 许可

插件里的预设库（`helper/presets/factory/`）、预设格式、`@param` 参数与【填空】处理、剪影分区、贴回羽化等做法来自夏三七「修图轮椅 V6」，V6 以 GNU GPL v3 发布（Copyright (C) 2026 xiasanqi）。因此本项目整体也按 GPL v3 发布，见 `LICENSE`。自己用没有任何限制；如果把它分发给别人，需要同样以 GPL v3 开源并保留这些署名。

## 目录

```
ps-ai-bridge/
├── 启动 helper.command        双击启动 helper（源码版）
├── desktop/                   桌面端（Electron）：托管 helper、一键装插件、托盘
│   ├── src/                   main.mjs（主进程）、helper-process.mjs、plugin-installer.mjs、renderer/（窗口界面）
│   ├── assets/                图标（scripts/make-icons.mjs 生成）
│   └── scripts/build.mjs      打包：npm run dist:mac / dist:win，产物在 desktop/dist
├── plugin/                    Photoshop UXP 插件（manifest.json、index.html、index.js、style.css）
└── helper/                    本机服务
    ├── server.mjs             HTTP 接口：/health /uploads /jobs /presets /assist /screenshot /checkpoints
    ├── lib/                   配置、任务队列、专用 Chrome、预设库、对齐/校色/插帧（post.mjs）、AI 帮写（assist.mjs）
    ├── presets/factory/       出厂预设（来自 V6，GPLv3）
    ├── providers/             aistudio.mjs / flow.mjs / chatgpt.mjs（网页自动化）、cli.mjs（gen.sh）、api.mjs（官方 API）
    └── public/index.html      控制台页面
```
