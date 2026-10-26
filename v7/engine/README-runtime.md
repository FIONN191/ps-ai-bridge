# 本地图像引擎

主软件、预设管理和基础校色不依赖 Python。本地图像引擎是可选组件；启动检查通过前不会显示启动成功。

在软件设置中选择“准备独立环境”。需要从 <https://www.python.org/downloads/> 安装 Python 3.10 或更高版本；建议 3.11 或 3.12。系统 Python 只负责创建 V7 专用的虚拟环境，依赖不会装进系统 Python、ComfyUI 或已有 DirectML 环境。

宿主指定独立环境目录，管理器在该目录的 `environments/env-<唯一编号>` 中创建环境，安装随包 `requirements.txt` 的固定依赖清单。安装需要联网访问 PyPI，至少需要 3 GiB 可用空间，限时 40 分钟。基础依赖仅接受二进制 wheel；不支持当前 Python/平台的依赖会明确失败，可安装建议版本后重试。

开启加速档（设置 → 环境那一行的「开启加速」）会在同一个环境里【追加】两层，不动 `requirements.txt`：

- **PyTorch + CUDA**（从 `download.pytorch.org` 下载 CUDA 版 torch，约 2.8 GB，解包后约 4.2 GB）。版本不写死：先问官方源有哪些版本，再逐个 `pip --dry-run` 确认本机装得上，装完必须真验证 `torch.cuda.is_available()`。
- **ONNX 显卡后端**：把 `onnxruntime`（只有 CPU provider）换成 `onnxruntime-directml`（首选，Windows 自带、A 卡/核显/N 卡都能用）或 `onnxruntime-gpu`（需要系统里装 CUDA 13 + cuDNN 9）。⚠ 换包必须【先卸 CPU 版】—— 三个包名不同却是同一个 import 名，共存会让引擎连 import 都失败。验证方式是**真建一个 ONNX 会话**看它落到哪个 provider，"provider 在可用列表里"不等于能用。

加速层需要额外约 4.2 GiB 空间，开始下载前会先检查。加速层装失败【不会】影响核心环境（只记状态，界面显示"未装 + 原因"）。「关闭加速」会把这两层拆掉并把 ONNX 装回 CPU 版；⚠ 引擎在跑时必须先停它（它占着 `onnxruntime\capi\*.dll`，否则 pip 会 `WinError 5`）。

全部依赖的 `numpy`、`PIL`、`cv2`、`onnxruntime` 导入检查和 `pip check` 通过后才启用新环境。环境目录不搬移；更新失败或取消保留原来已启用的环境。设置可重新准备或卸载；卸载只处理 V7 所有权标记对应的环境，保留用户模型。引擎运行时宿主拒绝准备和卸载。安装日志位于独立环境目录的 `logs`。

维护脚本接口如下，参数必须是宿主控制的绝对路径；`status` 不创建环境：

```powershell
py -3 -I "C:/V7/engine/managed_environment.py" --root "C:/V7-test/managed-python" --requirements "C:/V7/engine/requirements.txt" --action status
```

管理器支持 `status`、`prepare`、`remove`、`cancel` 和 `removeaccel`（关闭加速），标准输出仅一个 JSON 状态。`prepare` 可带 `--accel cuda` 要求顺带装加速层，默认 `off`（只装核心依赖，行为和以前一致）。宿主为每次准备/卸载传入 `--operation` 唯一标识，取消必须使用同一标识；同根目录跨软件实例互斥。Windows 安装子进程被限制在本次 Job 中，取消只终止本次安装；卸载由基础 Python 执行，避免删除正在运行的解释器。脚本不会关闭外部引擎服务（`removeaccel` 例外：宿主会先停本软件启动的引擎，因为不占着 .dll 就换不了 ONNX 后端）。

基础依赖使用 ONNX CPU 运行时。DirectML/CUDA/PyTorch 是按硬件及模型单独配置的可选加速能力，不因有独显就承诺已启用。实际能力由设置中的引擎探测结果显示。

开发版模型目录是开发副本的 `engine/models`。安装版和绿色包使用 Windows `%LOCALAPPDATA%/修图轮椅/models`、macOS `~/Library/Application Support/修图轮椅/models`。缓存迁移不改变模型位置。设置中的“打开模型文件夹”和引擎启动使用同一路径。

大模型不在基础软件包内，按需配置；绿色包的“免安装”指桌面程序免安装，不承诺免 Python、模型或 WebView2 运行依赖。Windows 安装器会处理 WebView2，引导启动绿色包前需装好 Microsoft Edge WebView2 Runtime。

正常桌面启动仅使用已准备的独立环境。维护时独立运行脚本默认读取脚本旁的 `models`；其它位置必须显式传参，并使用管理器 `status` 返回的解释器路径：

```powershell
& "C:/V7-test/managed-python/environments/env-实际编号/Scripts/python.exe" "C:/V7/engine/multi_engine_server.py" --models "D:/V7-models"
```

校色引擎仅监听 127.0.0.1:37893，多功能引擎仅监听 127.0.0.1:37894。同端口已有其它副本时，软件会明确拒绝代替启动，不关闭该进程。缺依赖、缺模型、版本不符、启动超时均给出失败说明；本次启动日志保存在应用数据目录的 `engine-logs`，开发版在开发副本 `tmp/engine-logs`。日志只记引擎启动诊断，不记录生成图片或 API Key。
