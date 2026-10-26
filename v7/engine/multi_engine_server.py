# -*- coding: utf-8 -*-
"""
多功能图像处理引擎服务器 (multi_engine_server.py)
——————————————————————————————————————————————————————
端口 37894（复用抠像那个，三条路由合到一个服务）

路由：
  GET  /health          探活（返回所有能力的档位）
  GET  /models          扫描模型文件夹
  GET  /unload          手动释放显存
  GET  /test /tools/* /ui-pure/*   实验台静态页（tools/seg-test.html）
  POST /matting         抠像（BiRefNet 系列，三档）
  POST /segment         人体解析（SCHP / SegFormer / ⭐Sapiens，三档）
  POST /sam2            框选/点选抠图（SAM2，三档 tiny/base/large）
  POST /sam3            ⭐文字选区（SAM 3：打一个英文词，所有符合的都分出来）
  POST /matte           ⭐细边（ViTMatte：把别人给的粗 mask 边缘重算成发丝级）

⚠⚠ 共同基础设施（会话缓存/provider选择/空闲释放/健康探活）
   全部复用 matting_server.py 那套，别重复造轮子。

⚠ 两种运行时并存：ONNX(DirectML) 跑老模型，PyTorch(CUDA) 跑 Sapiens/SAM3/ViTMatte。
  每条模型记录用 runtime 字段区分，默认 "onnx"。
"""
import os, sys, time, json, io, threading, traceback, base64, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, parse_qs, urlparse
from model_integrity import fingerprint, inspect_model
CAPS = {"onnx": False, "numpy": False, "pil": False, "cv2": False}
MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024
BODY_READ_TIMEOUT_SECONDS = 120

def _safe_static_file(rel):
    """Resolve only documented tools/ui-pure files under the project root."""
    project = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    value = unquote(str(rel or "")).replace("\\", "/")
    if value.startswith("/"):
        value = value[1:]
    parts = value.split("/")
    if len(parts) < 2 or parts[0] not in {"tools", "ui-pure"} or any(part in {"", ".", ".."} for part in parts):
        return None
    root = os.path.realpath(os.path.join(project, parts[0]))
    candidate = os.path.realpath(os.path.join(root, *parts[1:]))
    if os.path.commonpath([root, candidate]) != root or not os.path.isfile(candidate):
        return None
    cursor = root
    for part in parts[1:]:
        cursor = os.path.join(cursor, part)
        if os.path.islink(cursor):
            return None
    return candidate

# ⭐ 2026-10-26（云端整机变慢查不清：调强度 / 校色 / 抠像的单在同一秒一起算完）：每个 POST 记一行计时。
#   只在 WHEELCHAIR_ENGINE_TIMING=1 时打（云端 run-engine.sh / run-match.sh 设）；本机用户不刷日志。
#   看法：总时长 ≫ 本线程 CPU ⇒ 这单大部分时间在等（锁、显卡、别的进程抢 CPU）；收包长 ⇒ 门卫往引擎送图慢。
#   「号」= 门卫给的单号（X-Cloud-Req），跟门卫的 usage-*.jsonl 对得上；子进程也打一行，同一个号。
_TIMING = os.environ.get("WHEELCHAIR_ENGINE_TIMING") == "1"
_TIMING_ACTIVE = {"n": 0}
_TIMING_LOCK = threading.Lock()


def _timing_begin():
    with _TIMING_LOCK:
        _TIMING_ACTIVE["n"] += 1
        n = _TIMING_ACTIVE["n"]
    return (time.time(), time.thread_time(), time.process_time(), n)


def _timing_end(handler, t, role):
    with _TIMING_LOCK:
        _TIMING_ACTIVE["n"] -= 1
    if not _TIMING:
        return
    wall = time.time() - t[0]
    print("[计时] %s %s %s 号=%s | 总 %.2fs | 收包 %.2fs | 本线程CPU %.2fs | 整个进程占 %.1f 核 | 开始时同时在跑 %d 单" % (
        role, handler.path.split("?")[0], getattr(handler, "_timing_status", "-"),
        handler.headers.get("X-Cloud-Req") or "-", wall, getattr(handler, "_timing_body_s", 0.0),
        time.thread_time() - t[1], (time.process_time() - t[2]) / max(wall, 1e-6), t[3]), flush=True)


def _read_limited_body(handler):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        handler._send(400, {"ok": False, "error": "Content-Length 无效"})
        return None
    if length < 0:
        handler._send(400, {"ok": False, "error": "Content-Length 无效"})
        return None
    if length > MAX_REQUEST_BODY_BYTES:
        handler._send(413, {"ok": False, "error": "请求体超过 256MB 上限"})
        return None
    try:
        handler.connection.settimeout(BODY_READ_TIMEOUT_SECONDS)
        _t_read = time.time()
        body = handler.rfile.read(length) if length else b""
        handler._timing_body_s = time.time() - _t_read
    except socket.timeout:
        handler._send(408, {"ok": False, "error": "请求体读取超时"})
        return None
    if len(body) != length:
        handler._send(400, {"ok": False, "error": "请求体提前结束"})
        return None
    return body
try:
    import onnxruntime as ort
    CAPS["onnx"] = True
except ImportError:
    ort = None
try:
    import numpy as np
    CAPS["numpy"] = True
except ImportError:
    np = None
try:
    from PIL import Image
    CAPS["pil"] = True
except ImportError:
    Image = None
try:
    import cv2
    CAPS["cv2"] = True
except ImportError:
    cv2 = None

# ⚠⚠ torch 【不在这里 import】。
#   `import torch` 要 3~5 秒，放模块顶上会让引擎启动慢一大截，
#   而绝大多数动作（抠像/SAM2/老的人体解析）根本不需要它。
#   真正的探测放在 _probe_hardware()（启动时一次），而且只在
#   【真的装了 torch 版模型】时才去 import —— 没装的人不付这个代价。
#   这两个键先占位，/health 里照样报（docs/40 规矩 2：按能力报档）。
CAPS["torch"] = False
CAPS["cuda"] = False

PORT = 37894
# 2.1.0：接入 Sapiens 人体解析（PyTorch 运行时），老的 ONNX 模型一个没动
VERSION = "2.1.0-multi"

# 解析命令行参数
_NO_PARENT_WATCH = False
for _i, _a in enumerate(sys.argv):
    if _a == "--port" and _i + 1 < len(sys.argv):
        try:
            PORT = int(sys.argv[_i + 1])
        except ValueError:
            pass
    # ⚠ 测试/手动起引擎时用这个关掉父进程监视（不然它自己就退了）
    elif _a == "--no-parent-watch":
        _NO_PARENT_WATCH = True

# ⭐⭐ 2026-10-10 修（用户实测报的：「啥玩意、啥项目？吃了我显存那么多，显存快被吃满了」）
#   ── 引擎"爹没了还不走"，白占显存 ──
#
#   实测现场：主程序 10/10 14:13 才启动，而引擎是 10/08 19:49 起的、跑了 42 小时，
#   抱着 9.6GB 显存不放。用户看到的只是"显存快满了"，根本不知道是谁。
#
#   根因（三个叠在一起）：
#     ① engine-launcher.cjs:119 是 `detached: true` + 135 `child.unref()`
#        —— 故意让引擎脱离父进程（为了"软件重启不用重新加载模型"）；
#     ② 但**没有任何人告诉它父进程已经没了** ⇒ 它就一直活着；
#     ③ 内核里虽然有 IDLE_UNLOAD_SEC=300 的空闲卸载，但它只管 _SESS 里登记过的会话
#        （实测 /unload 回 {"loaded": []} 时它还占着 9.6GB ⇒ 有代码路径没登记）。
#
#   所以这里补两道：
#     A. **父进程监视**：爹没了就自己走（软件崩溃/被强杀时也管用，最可靠的一道）
#     B. **/shutdown 正常关闭**：软件正常退出时走这个（干净、能打日志）
#   ⚠ 为什么不干脆"每次关软件都杀引擎"：那会丢掉"下次开软件模型还在"的好处
#     （冷启动要重新加载 3~5 秒的模型）。A 只在【爹真没了】时才触发，不冲突。
_PARENT_WATCH_PID = 0
try:
    _PARENT_WATCH_PID = int(os.environ.get("WHEELCHAIR_ENGINE_PARENT_PID", "0") or 0)
except ValueError:
    _PARENT_WATCH_PID = 0

# 正常关闭用的口令：软件启动引擎时随机生成、通过环境变量传进来。
# ⚠ 为什么要口令：端口在本机，任何本机程序都能 POST /shutdown。
#   没口令 = 随便谁都能把用户的引擎踢掉（那是拒绝服务）。
_SHUTDOWN_TOKEN = os.environ.get("WHEELCHAIR_ENGINE_TOKEN", "") or ""
_SHUTDOWN = {"requested": False}

# ⭐ 2026-10-18 云端外挂工具（docs/237）：【整个引擎】的门锁。
#   ⚠ 为什么本机不用、云端必须有：仙宫云那台机器上【任何端口】都能从公网直接访问
#     （实测连只听 127.0.0.1 的端口也能摸到，记忆「仙宫云连只听127.0.0.1的端口都能从公网摸到」）。
#     不上锁 = 全世界都能白用我们的显卡、还能把模型卸掉。
#   ⇒ 配了 WHEELCHAIR_ENGINE_ACCESS_TOKEN 时，每个请求都要带 X-Engine-Access，对不上一律 403；
#     只有云端门卫（backend/cloud-tools-gateway.js）知道它，用户的软件永远不直接连引擎。
#   ⚠ 本机（没配这个变量）行为一个字节都不变。
#   ⚠ 引擎 ↔ PyTorch 子进程之间的请求也要带（子进程继承同一个环境变量），见 _worker_http / torch_worker。
_ACCESS_TOKEN = os.environ.get("WHEELCHAIR_ENGINE_ACCESS_TOKEN", "") or ""


def _access_headers(headers=None):
    out = dict(headers or {})
    if _ACCESS_TOKEN:
        out["X-Engine-Access"] = _ACCESS_TOKEN
    return out


def _access_denied(handler):
    """没配门锁 → 放行；配了且对得上 → 放行；否则回 403 并返回 True（调用方直接 return）。"""
    if not _ACCESS_TOKEN:
        return False
    import hmac as _hmac
    supplied = str(handler.headers.get("X-Engine-Access") or "")
    if supplied and _hmac.compare_digest(supplied.encode("utf-8"), _ACCESS_TOKEN.encode("utf-8")):
        return False
    handler.close_connection = True
    handler._send(403, {"ok": False, "error": "这台引擎只接受云端门卫转来的请求", "code": "ENGINE_ACCESS_DENIED"})
    return True

# ═══════════════════════════════════════════════════════════
#  模型登记表（三类功能的模型都登记在这）
#
#  kind: 'matting' | 'segment' | 'sam2-enc' | 'sam2-dec'
#  ⚠ SAM2 的 encoder/decoder 分开登记，因为档位是按 encoder 算的。
# ═══════════════════════════════════════════════════════════
MODELS = {
    # ────────── 抠像（BiRefNet 系列）──────────
    "matting-lite": {
        "kind": "matting",
        "tier": 1,
        "file": "matting/lite.onnx",
        "name": "轻量抠像",
        "desc": "1024 输入，快，边缘一般",
        "input": 1024,
        "minBytes": 40 * 1024 * 1024,
        "sha256": None,
        "vramGB": 0,
        "url": "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX",
    },
    "matting-std": {
        "kind": "matting",
        "tier": 2,
        "file": "matting/std.onnx",
        "name": "标准抠像",
        "desc": "1024 输入，发丝不错",
        "input": 1024,
        "minBytes": 300 * 1024 * 1024,
        "sha256": None,
        "vramGB": 6,
        "url": "https://huggingface.co/ZhengPeng7/BiRefNet-matting",
    },
    "matting-hr": {
        "kind": "matting",
        "tier": 3,
        "file": "matting/hr-fp16.onnx",
        "name": "高精抠像",
        "desc": "2048 输入，发丝/半透明边缘最锐利。⚠ 首次推理约 8 秒（热身后仍需 2-3 秒）",
        "input": 2048,
        "minBytes": 400 * 1024 * 1024,
        "sha256": None,
        "vramGB": 12,
        "url": "https://huggingface.co/PinkPixel/birefnet-hr-matting-onnx",
    },
    # ────────── 人体解析（SCHP / SegFormer）──────────
    "segment-schp-atr": {
        "kind": "segment",
        "tier": 2,
        "file": "segment/schp-atr.onnx",
        "name": "SCHP 人体解析(ATR)",
        "desc": "18 类部位（重衣服：上衣/裙/裤/连衣裙/腰带/围巾/包），512 输入",
        "input": 512,
        "labels": ["背景", "帽子", "头发", "太阳镜", "上衣", "裙子", "裤子", "连衣裙",
                   "腰带", "左鞋", "右鞋", "脸", "左腿", "右腿", "左臂", "右臂", "包", "围巾"],
        "normalize": {"mean": [0.406, 0.456, 0.485], "std": [0.225, 0.224, 0.229]},  # BGR 序
        "minBytes": 200 * 1024 * 1024,
        "sha256": None,
        "vramGB": 4,
        "url": "https://huggingface.co/Longcat2957/humanparsing-onnx",
    },
    "segment-schp-lip": {
        "kind": "segment",
        "tier": 2,
        "file": "segment/schp-lip.onnx",
        "name": "SCHP 人体解析(LIP)",
        "desc": "20 类部位（重身体：上下手臂分开/躯干/脖子），473 输入",
        "input": 473,
        "labels": ["背景", "帽子", "头发", "手套", "太阳镜", "上衣", "连衣裙", "外套",
                   "袜子", "裤子", "连体衣", "围巾", "裙子", "脸", "左臂", "右臂",
                   "左腿", "右腿", "左鞋", "右鞋"],
        "normalize": {"mean": [0.406, 0.456, 0.485], "std": [0.225, 0.224, 0.229]},
        "minBytes": 200 * 1024 * 1024,
        "sha256": None,
        "vramGB": 4,
        "url": "https://huggingface.co/Longcat2957/humanparsing-onnx",
    },
    # ────────── 人体解析 · Sapiens（Meta，PyTorch 运行时）──────────
    #
    # ⭐ 2026-09-15 接入。为什么值得单独开一条 PyTorch 的路：
    #   SCHP/SegFormer 喂进去 512，但【吐出来只有 128×128】——
    #   放到 2000 宽的图上，一个格子 15.6 像素，边界再怎么修也就那样了。
    #   Sapiens2 原生吐 1024×768，同一张图一格 2.6 像素，细 6 倍。
    #   实测（2000×1333，5090 fp16）：143ms / 显存峰值 3.3GB，
    #   认出了上装、脸颈、头发，**左手右手还是分开的两类**。
    #
    # ⚠ 它是 safetensors + transformers，不是 ONNX —— 所以这条记录带 runtime:"torch"。
    #   老的三条 ONNX 记录一个字没动，装不上 torch 的机器照样用 SCHP（docs/40 规矩 1）。
    # ⚠ 类别顺序是官方 SEG.md 的 29 类（按英文名字母序）。
    #   已经用实测对过账：3=脸颈 4=头发 6/15=左右手 23=上装，图上颜色全对得上。
    #   ⚠ 二代比一代多了 class 2「眼镜」，别照搬一代的 28 类表。
    "segment-sapiens": {
        "kind": "segment",
        "tier": 3,
        "runtime": "torch",
        "dir": "segment/sapiens2-0.8b",
        "file": "segment/sapiens2-0.8b/model.safetensors",
        "name": "Sapiens 人体解析(Meta)",
        "desc": "29 个部位，1024×768 原生分辨率（比 SCHP 细 6 倍），左右肢体分开。⚠ 要 PyTorch + 显卡",
        "input": [768, 1024],          # [宽, 高]，和别的模型的单个数字不一样，代码里要判断
        "labels": ["背景", "配饰", "眼镜", "脸和脖子", "头发", "左脚", "左手", "左小臂", "左小腿",
                   "左鞋", "左袜", "左大臂", "左大腿", "下装", "右脚", "右手", "右小臂", "右小腿",
                   "右鞋", "右袜", "右大臂", "右大腿", "躯干", "上装", "下唇", "上唇", "下牙",
                   "上牙", "舌头"],
        "normalize": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
        "minBytes": 3000 * 1024 * 1024,
        "sha256": None,
        "vramGB": 6,
        "url": "https://huggingface.co/facebook/sapiens2-seg-0.8b",
    },
    "segment-segformer": {
        "kind": "segment",
        "tier": 1,
        "file": "segment/segformer-clothes.onnx",
        "name": "SegFormer 人体解析",
        "desc": "18 类部位(ATR)，精度比 SCHP 稍差但更快，512 输入",
        "input": 512,
        "labels": ["背景", "帽子", "头发", "太阳镜", "上衣", "裙子", "裤子", "连衣裙",
                   "腰带", "左鞋", "右鞋", "脸", "左腿", "右腿", "左臂", "右臂", "包", "围巾"],
        "normalize": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},  # ImageNet 常规
        "minBytes": 80 * 1024 * 1024,
        "sha256": None,
        "vramGB": 2,
        "url": "https://huggingface.co/mattmdjaga/segformer_b2_clothes",
    },
    # ────────── SAM2（点选/框选抠图）──────────
    #
    # ⚠⚠⚠ 2026-09-14 深夜实测修正：**encoder 和 decoder 必须【配套】**。
    #   原来这张表写着"三个档位共用同一个 decoder"，代码也写死只用 tiny 那个。
    #   那句话是错的。同一张图、同一个框，实测：
    #       tiny  encoder + tiny decoder（配套）  iou = 0.285 / 0.904 / 0.908  ✅
    #       base+ encoder + tiny decoder（错配）  iou = 0.089 / 0.195 / 0.302  ✗
    #       large encoder + tiny decoder（错配）  iou = 0.112 / 0.526 / 0.625  ✗
    #         └ 最佳候选里【只有 82 个像素】是完全不透明的，整张全是稀疏碎块。
    #   最坑的地方：**档位越高结果越烂，而且一句错都不报**。
    #   用户选了"最强"，拿到的却是垃圾 —— 正是铁律 17 那种静默失效。
    #
    # ⚠ 所以每个 encoder 自带一个 "decoder" 字段指名道姓配哪个。
    #   配套的 decoder 文件不在 → 这一档【不算数】（见 max_tier_by_kind）。
    #   宁可少给一档，也绝不给一个名不副实的档（docs/40 规矩 2）。
    "sam2-tiny-enc": {
        "kind": "sam2-enc",
        "tier": 1,
        "file": "sam2/tiny-enc.onnx",
        "decoder": "sam2-tiny-dec",
        "name": "指哪抠哪·快速版",
        "desc": "最快，显卡上约 37ms。日常够用",
        "input": 1024,
        "minBytes": 100 * 1024 * 1024,
        "sha256": None,
        "vramGB": 2,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx",
    },
    "sam2-base-enc": {
        "kind": "sam2-enc",
        "tier": 2,
        "file": "sam2/base-enc.onnx",
        "decoder": "sam2-base-dec",
        "name": "指哪抠哪·均衡版",
        "desc": "显卡上约 60-80ms。⚠ 需要配套的 base+ 解码器，没下就这一档不开",
        "input": 1024,
        "minBytes": 300 * 1024 * 1024,
        "sha256": None,
        "vramGB": 4,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-base-plus-onnx",
    },
    "sam2-large-enc": {
        "kind": "sam2-enc",
        "tier": 3,
        "file": "sam2/large-enc.onnx",
        "decoder": "sam2-large-dec",
        "name": "指哪抠哪·最强版",
        "desc": "最准，显卡上约 100-150ms",
        "input": 1024,
        "minBytes": 800 * 1024 * 1024,
        "sha256": None,
        "vramGB": 8,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-large-onnx",
    },
    # ⚠ decoder 一律 tier 0：不参与档位计算、不进模型库列表，
    #   它们是"跟着 encoder 走"的配件，不是用户要挑的东西。
    "sam2-tiny-dec": {
        "kind": "sam2-dec", "tier": 0,
        "file": "sam2/tiny-dec.onnx",
        "name": "指哪抠哪·快速版解码器", "desc": "配 tiny encoder 用",
        "input": 0, "minBytes": 15 * 1024 * 1024, "sha256": None, "vramGB": 0,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx",
    },
    "sam2-base-dec": {
        "kind": "sam2-dec", "tier": 0,
        "file": "sam2/base-dec.onnx",
        "name": "指哪抠哪·均衡版解码器", "desc": "配 base+ encoder 用。⚠ 这个文件还没下",
        "input": 0, "minBytes": 15 * 1024 * 1024, "sha256": None, "vramGB": 0,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-base-plus-onnx",
    },
    "sam2-large-dec": {
        "kind": "sam2-dec", "tier": 0,
        "file": "sam2/large-dec.onnx",
        "name": "指哪抠哪·最强版解码器", "desc": "配 large encoder 用",
        "input": 0, "minBytes": 15 * 1024 * 1024, "sha256": None, "vramGB": 0,
        "url": "https://huggingface.co/SharpAI/sam2-hiera-large-onnx",
    },
    # ────────── 细边（ViTMatte，PyTorch 运行时）──────────
    #
    # 它不自己找东西，只干一件事：**把别人给的粗 mask 的边做细**。
    #   粗 mask（抠像/人体解析/文字选区都行）→ 收缩扩张出 trimap
    #   → ViTMatte 只在"不确定带"里重算 alpha。
    # 实测：Sapiens 的硬边头发 软边像素 0 → 12k；档1 抠像 + 它 ≈ 档3 抠像的边缘质量。
    #
    # ⚠⚠ 显存是硬约束，实测（fp32，一次整张喂）：
    #     512² 39ms/0.7G | 768² 51ms/1.3G | 1024² 95ms/3.1G
    #     1536² 3.2秒/13.2G | 2048² **499秒**/40.1G ← 超过 1024 就雪崩
    #   所以引擎【只裁不确定带、切成 ≤1024 的块跑】，绝不整张喂。
    "matte-vitmatte": {
        "kind": "matte",
        "tier": 1,
        "runtime": "torch",
        "dir": "matte/vitmatte-1k",
        "file": "matte/vitmatte-1k/pytorch_model.bin",
        "name": "细边 ViTMatte",
        "desc": "把粗选区的边做细（发丝/薄纱）。只算边缘那一圈，不动主体。⚠ 要 PyTorch + 显卡",
        "input": 1024,
        "minBytes": 300 * 1024 * 1024,
        "sha256": None,
        "vramGB": 4,
        "url": "https://huggingface.co/hustvl/vitmatte-base-composition-1k",
    },
    # ────────── 文字选区（SAM 3，Meta，PyTorch 运行时）──────────
    #
    # ⭐ 2026-09-15 接入。和上面 SAM2 的根本区别：
    #   SAM2 = "你指哪它抠哪"，只认框和点，**不知道那是什么东西**。
    #   SAM 3 = "你说哪它抠哪"：打一个英文词，把画面里【所有】符合的东西
    #           分别分出来，各自带把握度。不再被固定类别表锁死。
    #
    # 实测（2000×1333，5090 fp16，官方权重）：每个词约 88ms、显存 1.7GB
    #   person 0.98 / hair 0.97 / face 0.90 / suit 0.92 / necktie 0.93
    #   hand 0.96+0.97（左右手是两个独立实例）/ microphone 0.91
    #
    # ⚠⚠ 权重必须是 facebook/sam3 那份【transformers 格式】（键名 detector_model.*）。
    #   社区镜像那些是 Meta 原始格式或别的框架转的，装上去【不报错但结果全是垃圾】：
    #   同一张图问 "person"，官方权重 0.98，某个镜像 0.027。
    #   引擎在加载时会核对"缺了几个权重"，缺一个就拒绝跑（见 load_model）。
    "sam3-text": {
        "kind": "sam3",
        "tier": 1,
        "runtime": "torch",
        "dir": "sam3",
        "file": "sam3/model.safetensors",
        "name": "文字选区 SAM 3(Meta)",
        "desc": "打一个英文词（hair / necktie / gloves…），把画面里所有符合的都分出来。⚠ 要 PyTorch + 显卡",
        "input": 1008,
        "minBytes": 3000 * 1024 * 1024,
        "sha256": None,
        "vramGB": 6,
        "url": "https://huggingface.co/facebook/sam3",
    },
    # ────────── 过渡帧（tween，PyTorch 运行时）──────────
    #
    # 用途是【无极调强度】：任务卡往右滑 → 预览 → 滚轮调改动幅度 → 发送 → 传回 PS。
    # 做法是在「原图」和「AI 改好的图」之间算出一串过渡帧，
    # 滚轮往左 = 更接近原图（改动小），往右 = 更接近 AI 结果（改动大）。
    # ⭐ 2026-10-04 推理已并进本服务（不再是外部独立进程）。
    #
    # ⚠⚠ 提这条记录时【别写能反推算法的词】：
    #   代码标识 / 端点名 / 权重文件名 / 张量键名全部是中性词（docs/132 §五「重」档）。
    #   上游算法本身是公开的，藏不住；要藏的是"用它来做无极调强度"这个【用法】。
    #
    # ⚠ 权重是【本机改名后】的那一份（engine/models/tween/base.pth），不是上游原文件。
    #   摘要跟着本机这份算。
    "tween-base": {
        "kind": "tween",
        "tier": 1,
        "runtime": "torch",
        "file": "tween/base.pth",
        "name": "过渡帧",
        "desc": "在原图和修好的图之间算出一串过渡帧，用滚轮无极调改动幅度。⚠ 要 PyTorch（没显卡会用 CPU，慢一些）",
        "input": 2048,
        "minBytes": 20 * 1024 * 1024,
        # 本机这份的 sha256（改完张量键名后实算的，21,329,857 字节）
        "sha256": "0a2cbb31cd3a415f408e050ee43c55fa9cd26dabbbd59951dee0c9cbd906836e",
        "vramGB": 4,
        "url": "",
    },
}


def decoder_for(enc_key):
    """
    某个 SAM2 encoder 配套的 decoder key。没配套的返回 ''。
    ⚠ 绝不许"找不到就拿别的顶上" —— 顶上去不报错，只是结果悄悄变成垃圾（见上面实测）。
    """
    m = MODELS.get(enc_key) or {}
    dk = m.get("decoder") or ""
    return dk if dk in MODELS else ""


def decoder_ready(enc_key):
    """配套 decoder 的文件到底在不在。"""
    dk = decoder_for(enc_key)
    if not dk:
        return False
    p = os.path.join(models_dir(), MODELS[dk]["file"])
    try:
        return os.path.isfile(p) and os.path.getsize(p) >= MODELS[dk]["minBytes"]
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════
#  模型目录 + 硬件探测（复用 matting_server.py 那套）
# ═══════════════════════════════════════════════════════════
def default_models_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    # Standalone scripts use adjacent development resources. Both desktop shells
    # pass --models explicitly for development and installed builds.
    return os.path.join(here, "models")


_MODELS_DIR = default_models_dir()
for _i, _a in enumerate(sys.argv):
    if _a == "--models" and _i + 1 < len(sys.argv):
        _MODELS_DIR = os.path.abspath(sys.argv[_i + 1])


def models_dir():
    return _MODELS_DIR


# ⚠⚠ 启动时探测一次，之后全走缓存（显存/设备名不会变）
_HW = {"vram_gb": None, "device_name": None, "probed": False}


def _probe_hardware():
    """
    启动时跑一次。⚠ 每一步都兜住异常 —— 查显卡失败不该让整个服务起不来。

    ⚠⚠ 2026-09-14 深夜修的大坑：这个函数原来【从不调 _pick_provider】。
      于是 _PICKED["provider"] 一直是 None，_providers() 回落成 CPUExecutionProvider，
      **所有推理都安安静静地跑在 CPU 上**（标准抠像从 185ms 变成好几秒），
      而 /health 只是显示 provider: null，一句错都没有 —— 铁律 17 的典型静默失效。
      照 matting_server.py 那套原样修好。
    """
    if _HW["probed"]:
        return
    _HW["probed"] = True

    # ── PyTorch 运行时的能力探测（2026-09-15，为 Sapiens 加的）──
    # ⚠ 只有【真的装了 torch 版模型文件】才去 import torch：
    #   import 一次要 3~5 秒，没装这个模型的人不该跟着等（docs/40 规矩 3：探活要快）。
    # ⚠ 探到的结果存进 CAPS，/health 直接报 —— 不许在 /health 里现查（同规矩 3）。
    try:
        need_torch = any(
            m.get("runtime") == "torch" and os.path.isfile(os.path.join(models_dir(), m["file"]))
            for m in MODELS.values())
    except Exception:
        need_torch = False
    if need_torch:
        try:
            import torch
            CAPS["torch"] = True
            CAPS["cuda"] = bool(torch.cuda.is_available())
        except Exception as e:
            CAPS["torch"] = False
            CAPS["cuda"] = False
            print("[引擎] [!] 装了 PyTorch 版模型，但 torch 用不了：%s" % e)
    # ⚠ 先实测 provider。用【当前装着的最小那个模型】试 —— 它加载最快。
    #   拿 848MB 的 SAM2-large 去试会让启动慢到离谱。
    if CAPS["onnx"]:
        try:
            small = None
            best_sz = None
            for _k, _m in MODELS.items():
                _p = os.path.join(models_dir(), _m["file"])
                if not os.path.isfile(_p):
                    continue
                try:
                    _sz = os.path.getsize(_p)
                except Exception:
                    continue
                if best_sz is None or _sz < best_sz:
                    best_sz, small = _sz, _p
            _pick_provider(small)
        except Exception:
            pass

    vram = 0
    dev = "CPU"
    # ⚠ 设备名必须反映【实测选中的那个 provider】，不能按"装了什么包"猜。
    #   否则又会出现"显示 GPU 加速、实际跑 CPU"那种假信息（docs/40 规矩 2）。
    picked = _PICKED["provider"] or ""
    gpu = picked in ("DmlExecutionProvider", "CUDAExecutionProvider")
    if gpu:
        # 显卡型号和显存优先问 torch（它报得最准）。没装 torch 再退回 pynvml。
        try:
            import torch
            if torch.cuda.is_available():
                vram = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)
                dev = torch.cuda.get_device_name(0)
        except Exception:
            pass
        if not vram:
            try:
                import pynvml
                pynvml.nvmlInit()
                h = pynvml.nvmlDeviceGetHandleByIndex(0)
                vram = round(pynvml.nvmlDeviceGetMemoryInfo(h).total / (1024 ** 3), 1)
                _n = pynvml.nvmlDeviceGetName(h)
                # ⚠ 新版 pynvml 直接返回 str，老版返回 bytes —— 写死 .decode() 会抛异常，
                #   然后被 except 吞掉，表现成"显卡查不到"。两种都要接。
                dev = _n.decode("utf-8", "ignore") if isinstance(_n, bytes) else str(_n)
                pynvml.nvmlShutdown()
            except Exception:
                pass
        tag = "DirectML" if picked == "DmlExecutionProvider" else "CUDA"
        if vram:
            dev = "%s (%s)" % (dev, tag)
        else:
            # ⚠ 问不出显存就【报 0，不猜】。高档位会因此不开 ——
            #   宁可少给一档能力，也不给一个名不副实的名头（docs/40 规矩 2）。
            dev = "%s (显存未知)" % tag
    elif CAPS["onnx"]:
        dev = "CPU (onnxruntime)"
    _HW["vram_gb"] = vram or None
    _HW["device_name"] = dev


def vram_gb():
    return _HW.get("vram_gb")


def device_name():
    return _HW.get("device_name") or "CPU"


# ═══════════════════════════════════════════════════════════
#  模型扫描 + 档位计算（按 kind 分组）
# ═══════════════════════════════════════════════════════════
_MODEL_CHECKS = {}


def checked_model(path, model, deep):
    signature = (fingerprint(path), model.get("sha256"))
    previous = _MODEL_CHECKS.get(path)
    if not deep:
        return dict(previous[1]) if previous and previous[0] == signature else {"integrity": "not_checked", "validation": "not_checked"}
    try:
        result = inspect_model(path, model.get("sha256"))
    except Exception as error:
        result = {"integrity": "failed", "validation": "failed", "reason": "文件检查失败：%s" % error}
    _MODEL_CHECKS[path] = (signature, result)
    return dict(result)


_MODULE_PRESENT = {}

# ⭐ 2026-10-15：干活计数（空闲 10 分钟自动关引擎用）。服务器是多线程的 ⇒ 加锁。
_WORK = {"inflight": 0, "last": time.time()}
_WORK_LOCK = threading.Lock()


def _work_begin():
    with _WORK_LOCK:
        _WORK["inflight"] += 1
        _WORK["last"] = time.time()


def _work_end():
    with _WORK_LOCK:
        _WORK["inflight"] = max(0, _WORK["inflight"] - 1)
        _WORK["last"] = time.time()


def _idle_seconds():
    with _WORK_LOCK:
        return 0 if _WORK["inflight"] > 0 else int(time.time() - _WORK["last"])


# ⭐ 2026-10-15（用户定：空闲 10 分钟就关闭）：引擎自己看门 —— 没活干满 10 分钟就自己退出、放掉显存。
#   ⚠ 为什么不让界面去调「停止引擎」：两个壳的停止入口都【故意】弹一个确认框
#     （防止正在算图时被误停），界面每分钟调一次 = 每分钟弹一次框（用户 10-15 截图报的）。
#     引擎自己最清楚有没有在干活，自己退最干净；壳那边的启动逻辑是"端口空着就起新的"，
#     下次用到时界面的 toolEngineReady 会自动拉起（实测约 3 秒）。
#   ⚠ 正在干活（inflight>0）时 _idle_seconds() 恒为 0，不会半路退。
#   环境变量 WHEELCHAIR_ENGINE_IDLE_EXIT 可改秒数（测试用）；0 = 不自动退。
try:
    IDLE_EXIT_S = int(os.environ.get("WHEELCHAIR_ENGINE_IDLE_EXIT", "600"))
except ValueError:
    IDLE_EXIT_S = 600


def _idle_watchdog():
    step = max(1, min(15, IDLE_EXIT_S // 4 or 1))
    while True:
        time.sleep(step)
        if _idle_seconds() >= IDLE_EXIT_S:
            print("[引擎] 空闲 %d 秒，自动退出并放掉显存" % IDLE_EXIT_S, flush=True)
            _SHUTDOWN["requested"] = True
            _exit_now()
            return


def _has_module(name):
    """这个 Python 里装没装某个包（只查找、不导入：transformers 导入一次要好几秒）。结果缓存。"""
    if name not in _MODULE_PRESENT:
        try:
            import importlib.util
            _MODULE_PRESENT[name] = importlib.util.find_spec(name) is not None
        except Exception:
            _MODULE_PRESENT[name] = False
    return _MODULE_PRESENT[name]


def scan_models(deep=False):
    """
    扫模型文件夹，返回每个模型的安装状态。

    状态三种：missing / broken / ok
    ⚠ 停用的(enabled=False)和 tier=0 的不进列表。
    """
    d = models_dir()
    out = {}
    for key, m in MODELS.items():
        if m.get("enabled") is False or m["tier"] == 0:
            continue
        p = os.path.join(d, m["file"])
        item = {
            "key": key, "name": m["name"], "desc": m["desc"], "tier": m["tier"],
            "kind": m["kind"], "file": m["file"], "vramGB": m.get("vramGB", 0),
            "url": m.get("url", ""),
            "state": "missing", "bytes": 0, "reason": "",
        }
        # ⭐ 人体解析要把部位名单报给界面 —— 面板上那排"勾哪些部位"的复选框靠它。
        #   ⚠ 必须从引擎这张表来，界面不许自己写死一份当真身：
        #     ATR 是 18 类、LIP 是 20 类，写死一份必然有一边是错的，而且错了不报错。
        if m.get("labels"):
            item["labels"] = list(m["labels"])
        if os.path.isfile(p):
            try:
                sz = os.path.getsize(p)
                item["bytes"] = sz
                if sz < m["minBytes"]:
                    item["state"] = "broken"
                    item["reason"] = "文件只有 %.0f MB，明显比正常的小 —— 多半没下完" % (sz / 1024 / 1024)
                else:
                    item["state"] = "ok"
                    item.update(checked_model(p, m, deep))
                    if item["integrity"] == "failed":
                        item["state"] = "broken"
            except Exception as e:
                item["state"] = "broken"
                item["reason"] = "读不了这个文件：%s" % e
        # ⚠⚠ SAM2 的 encoder 光自己在不算数 —— 配套的 decoder 不在就是【用不了】。
        #   不这样标的话，模型库里会显示"已安装"、档位下拉里也能选，
        #   选了之后才报错（或者更糟：以前是不报错直接给一堆碎块）。
        # ⚠⚠ PyTorch 运行时的模型：文件在【不等于】能跑。
        #   这台机器没装 torch、或者 torch 摸不到显卡时，必须在模型库里明说，
        #   而不是让它显示"已安装"、选了才发现跑不动（docs/40 规矩 2/4）。
        #   0.8B 的模型纯 CPU 跑一次要几十秒 —— 那种体验等于坏了。
        if m.get("runtime") == "torch" and item["state"] == "ok":
            if not CAPS.get("torch"):
                item["state"] = "broken"
                item["reason"] = "模型下好了，但这台机器没装 PyTorch，跑不了它（老的人体解析不受影响）"
            elif not CAPS.get("cuda"):
                # ⭐⭐⭐ 2026-10-08（docs/170 §13.1 R2 第 1 条）：按 kind 分开放开。
                #   ⚠ 只放【过渡帧】：它是插帧网络，CPU 上算得动
                #     （实测 1463×1463 一组 16 帧约 12 秒，见 docs/170 §13.2）。
                #   ⚠⚠ 另外三档（人体解析 / 细边 / 文字选区）【绝不能放】：
                #     同文件上面那条注释写着「0.8B 的模型纯 CPU 跑一次要几十秒 ——
                #     那种体验等于坏了」。一刀切会把它们一起放进来。
                #   ⚠⚠⚠ 这里【不许】先无条件写 item["state"] = "broken"！
                #     我第一版就是那么写的 ⇒ tween 那条 reason 改对了、state 还是 broken
                #     ⇒ max_tier_by_kind 仍然返回 0，滚轮照样不能用，而且一句错都不报。
                #     是【真跑一遍 scan_models()】才抓出来的（光看代码会以为没问题）。
                if m["kind"] == "tween":
                    # 保持 state = "ok"（上面刚判过），只把原因说清楚
                    item["reason"] = ("这台机器摸不到显卡，本档会用 CPU 算（慢一些，但能用）。"
                                      "想要更快就装一张 N 卡。")
                else:
                    item["state"] = "broken"
                    item["reason"] = "装了 PyTorch 但摸不到显卡，这个模型只能跑 CPU（一次几十秒），先不给用"
        # ⭐⭐ 2026-10-15（工具箱复测实测，docs/222 P0）：Meta 系三个模型（SAM 3 文字选区 / Sapiens 人体解析 / ViTMatte 细边）
        #   还要 transformers + safetensors。引擎自带的 Python 里原来没有 ⇒ 一跑就报英文
        #   "No module named 'transformers'"，可这里照样报 state:ok（只看了文件在不在 = 假绿），
        #   人体解析的 auto 档还会【专门挑中】这个跑不了的 Sapiens（它是最高档）。
        #   ⇒ 组件缺了就标 broken，auto 选档自然跳到下一档；原因用中文写清楚。
        if m.get("runtime") == "torch" and item["state"] == "ok" and (m["kind"] in ("sam3", "matte") or m["kind"] == "segment"):
            lacking = [name for name in ("transformers", "safetensors") if not _has_module(name)]
            if lacking:
                item["state"] = "broken"
                item["reason"] = ("模型文件是好的，但引擎少了组件（%s），跑不了它。"
                                  "请在「外挂能力」卡重新准备引擎环境" % "、".join(lacking))
        if m["kind"] == "sam2-enc" and item["state"] == "ok" and not decoder_ready(key):
            dk = decoder_for(key)
            item["state"] = "broken"
            item["reason"] = ("配套的解码器还没下（%s）。SAM2 的编码器和解码器必须成对用，"
                              "配错了不会报错、只会抠出一堆碎块"
                              % (MODELS[dk]["file"] if dk else "未登记"))
        elif m["kind"] == "sam2-enc" and item["state"] == "ok":
            decoder = MODELS[decoder_for(key)]
            try:
                check = checked_model(os.path.join(d, decoder["file"]), decoder, deep)
                if check["integrity"] == "failed":
                    item.update(state="broken", reason="配套解码器" + check["reason"], integrity="failed")
            except Exception as error:
                item.update(state="broken", reason="无法检查配套解码器：%s" % error, integrity="failed")
        out[key] = item
    return out


def max_tier_by_kind(kind, installed=None):
    """当前环境某一类功能最高能跑到第几档。返回 0 = 没有可用模型。"""
    # ⚠ 这里原来是 `not (numpy and onnx) → 0`。加了 PyTorch 运行时之后不能这么一刀切：
    #   没有 onnxruntime 但有 torch 的机器，Sapiens 照样能跑。
    #   改成：numpy 是所有路径的共同底线，onnx/torch 按【每个模型自己的运行时】分别判。
    if not CAPS["numpy"]:
        return 0
    inst = installed if installed is not None else scan_models()
    tier = 0
    for key, m in MODELS.items():
        if m.get("enabled") is False or m["kind"] != kind or m["tier"] <= 0:
            continue
        rt = m.get("runtime", "onnx")
        if rt == "onnx" and not CAPS["onnx"]:
            continue
        # ⭐⭐⭐ 2026-10-08（docs/170 §13.1 R2 第 2 条）：**这里是第二道门槛**。
        #   只改上面 broken 标记那处是不够的 —— 这里还有一道「torch 且 cuda 才算数」，
        #   不放开的话插帧档位仍然是 0，滚轮照样不能用（而且一句错都不报）。
        #   ⚠ 只放【过渡帧】（CPU 上算得动）；其余 torch 三档照旧要求 cuda。
        if rt == "torch" and not CAPS.get("torch"):
            continue
        if rt == "torch" and not CAPS.get("cuda") and m["kind"] != "tween":
            continue
        if inst.get(key, {}).get("state") != "ok":
            continue
        if m.get("vramGB") and vram_gb() and vram_gb() < m["vramGB"]:
            continue
        # ⚠⚠ SAM2：配套的 decoder 没下，这一档就【不算数】。
        #   不拦的话会出现"选了最强档、结果全是碎块、还不报错"（见 MODELS 表里那段实测）。
        if m["kind"] == "sam2-enc" and not decoder_ready(key):
            continue
        tier = max(tier, m["tier"])
    return tier


# ═══════════════════════════════════════════════════════════
#  会话缓存 + provider 选择（复用 matting_server.py 那套）
#  ⚠ SAM2 需要同时缓存 encoder 和 decoder，所以改成字典缓存
# ═══════════════════════════════════════════════════════════
_SESS = {}  # key -> {"sess": sess, "last": time}
_SESS_LOCK = threading.Lock()
# ⭐ 2026-10-18：可用环境变量改（云端设 0 = 模型常驻不卸 —— 48G 显存够，卸了下一个人要等 SAM 3 加载 75 秒）。
#   本机默认照旧 300 秒（把显存还给 PS）。
try:
    IDLE_UNLOAD_SEC = int(os.environ.get("WHEELCHAIR_ENGINE_IDLE_UNLOAD", "300"))
except ValueError:
    IDLE_UNLOAD_SEC = 300

_PICKED = {"provider": None, "why": "", "probed": False}
_AVAIL = ort.get_available_providers() if ort else []
_CANDIDATES = ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]


def _pick_provider(probe_model=None):
    if _PICKED["probed"]:
        return _PICKED["provider"]
    avail = [p for p in _CANDIDATES if p in _AVAIL]
    if not avail:
        avail = ["CPUExecutionProvider"]
    if not probe_model or not os.path.isfile(probe_model):
        _PICKED["provider"] = avail[0]
        _PICKED["why"] = "还没有模型文件，没法实测；这是按可用列表排的候选"
        return avail[0]
    so = ort.SessionOptions()
    so.log_severity_level = 4
    for p in avail:
        try:
            s = ort.InferenceSession(probe_model, sess_options=so, providers=[p])
            got = s.get_providers()[0]
            del s
            if got == p:
                _PICKED["provider"] = p
                _PICKED["why"] = "实测可用"
                _PICKED["probed"] = True
                return p
            _PICKED["why"] = "%s 静默回落到 %s" % (p, got)
        except Exception as e:
            _PICKED["why"] = "%s 建会话失败: %s" % (p, str(e)[:80])
    _PICKED["provider"] = "CPUExecutionProvider"
    _PICKED["probed"] = True
    return _PICKED["provider"]


def _providers():
    p = _PICKED["provider"] or "CPUExecutionProvider"
    # ⭐ 2026-10-18 云端外挂（docs/237）：云端那张卡跟千问共用，ONNX 的显存池默认【按 2 的倍数往上翻、从不还】——
    #   实测几个大模型常驻后这个进程吃到 24 GB，整卡只剩 3.7 GB，千问出 2K 图有爆显存的风险。
    #   ⇒ 配了 WHEELCHAIR_ENGINE_CUDA_ARENA_GB 时：要多少给多少（kSameAsRequested）+ 每个模型封顶这么多 GB。
    #   本机（DirectML / 没配这个变量）一个字节不变。
    cap = os.environ.get("WHEELCHAIR_ENGINE_CUDA_ARENA_GB", "")
    if p == "CUDAExecutionProvider" and cap:
        try:
            limit = int(float(cap) * 1024 ** 3)
            # ⚠ 卷积默认会「借最大的临时工作区 + 挨个试最快算法」—— 抠像高精档光临时区就要好几 G（封顶 8G、12G 都还差，实测）。
            #   ⇒ 不借最大工作区、用经验挑算法（HEURISTIC）。速度影响见 docs/237 实测。
            return [("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested", "gpu_mem_limit": str(limit),
                                               "cudnn_conv_use_max_workspace": "0", "cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
        except ValueError:
            pass
    return [p, "CPUExecutionProvider"] if p != "CPUExecutionProvider" else ["CPUExecutionProvider"]


def _run_opts():
    """⭐ 2026-10-18 云端外挂：每跑完一次就把显存池里没在用的还回去（只在配了 WHEELCHAIR_ENGINE_CUDA_ARENA_GB 时）。
    ⚠ 为什么：抠像高精档算的那几秒要 14G 左右，池子默认【一直攥着峰值不放】—— 跟千问共用一张卡时，
      这 14G 就永远被占着。还回去之后只有【正在算】的那几秒占，平时只剩模型本身。本机不变（返回 None = 老行为）。"""
    if not ort or not os.environ.get("WHEELCHAIR_ENGINE_CUDA_ARENA_GB") or (_PICKED["provider"] != "CUDAExecutionProvider"):
        return None
    ro = ort.RunOptions()
    ro.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
    return ro


def load_model(key):
    """
    加载模型。已加载着同一个就复用。
    ⚠ 支持同时缓存多个模型（主要用于 SAM2 的 encoder + decoder），
      但大模型（matting/segment）只留一个，避免显存爆掉。
    """
    with _SESS_LOCK:
        if key in _SESS and _SESS[key]["sess"] is not None:
            _SESS[key]["last"] = time.time()
            return _SESS[key]["sess"]

        m = MODELS.get(key)
        if not m:
            raise ValueError("没有这个模型：%s" % key)

        # 大模型互斥：加载新的大模型时，释放旧的大模型
        # ⚠ sam3 也要进这张"大模型"名单：它 0.84B、显存 1.7GB，
        #   不互斥的话和 Sapiens、BiRefNet 叠在一起，显存会一路涨上去。
        # ⭐ 2026-10-18 云端外挂（docs/237）：云端 4090D 有 48G，配 WHEELCHAIR_ENGINE_KEEP_ALL=1 时【不互斥】、全部常驻。
        #   实测（tmp/cloud-feas/first-call-probe.cjs）：互斥时用户换一个工具就要重新加载 8~15 秒（抠像 load=8913ms），
        #   多人轮着用不同工具会一直互相踢。本机不配这个变量，照旧互斥（把显存留给 PS）。
        if m["kind"] in ("matting", "segment", "sam2-enc", "sam3") and os.environ.get("WHEELCHAIR_ENGINE_KEEP_ALL") != "1":
            for k in list(_SESS.keys()):
                old_m = MODELS.get(k)
                if old_m and old_m["kind"] in ("matting", "segment", "sam2-enc", "sam3"):
                    _unload_one_locked(k)

        p = os.path.join(models_dir(), m["file"])
        if not os.path.isfile(p):
            raise FileNotFoundError("模型文件不在：%s" % p)

        # ── PyTorch 运行时（Sapiens）──
        # ⚠ 缓存结构和 ONNX 那边共用（都是 _SESS[key]["sess"]），
        #   这样"大模型互斥""闲置 5 分钟卸载"两套现成逻辑一行都不用改。
        #   代价是 sess 这个名字对 torch 来说不太贴切 —— 但比另开一套缓存安全得多。
        if m.get("runtime") == "torch":
            if not CAPS.get("torch"):
                raise RuntimeError("这个模型要 PyTorch，但这台机器没装")
            import torch
            d = os.path.join(models_dir(), m["dir"])
            dev = "cuda" if CAPS.get("cuda") else "cpu"
            dtype = torch.float16 if dev == "cuda" else torch.float32

            if m["kind"] == "matte":
                from transformers import VitMatteForImageMatting
                mdl = VitMatteForImageMatting.from_pretrained(d).to(dev).eval()
                # ⚠ 这个用 float32：实测数据(1024² 95ms/3.1GB)是 fp32 量的，
                #   换 fp16 能省一半显存但没验过画质，别在没测的情况下换。
                _SESS[key] = {"sess": mdl, "last": time.time(), "runtime": "torch"}
                return mdl

            if m["kind"] == "sam3":
                # ⚠⚠ SAM 3 的权重文件里装着【图像检测器 + 视频追踪器】两套。
                #   我们只要图像检测器（detector_model.*）。整个 Sam3VideoModel 装不了 ——
                #   追踪器那部分在有些转换里形状对不上，直接抛错。
                # ⚠⚠ 装完必须核对"缺了几个"：缺了【不会报错】，只是那部分用随机权重，
                #   表现成"能跑、不报错、但什么都检测不出来"。2026-09-15 实测撞过：
                #   某个社区镜像缺 18 个，问它"画面里有没有人"把握度只有 0.027（官方 0.98）。
                from transformers import Sam3Model, Sam3Config, Sam3Processor
                from safetensors.torch import load_file
                cfg_all = json.load(open(os.path.join(d, "config.json"), encoding="utf-8"))
                mdl = Sam3Model(Sam3Config(**cfg_all["detector_config"]))
                sd = load_file(p)
                det = {k[len("detector_model."):]: v for k, v in sd.items()
                       if k.startswith("detector_model.")}
                miss, _extra = mdl.load_state_dict(det, strict=False)
                del sd, det
                if miss:
                    raise RuntimeError(
                        "这份 SAM 3 权重和引擎对不上：有 %d 个参数没装上（比如 %s）。"
                        "多半下的不是 facebook/sam3 那份 transformers 格式的权重。"
                        "硬跑的话不会报错，但什么都检测不出来 —— 所以这里直接拦住。"
                        % (len(miss), miss[0] if miss else "?"))
                mdl = mdl.to(dev, dtype).eval()
                proc = Sam3Processor.from_pretrained(d)
                # ⚠ 模型和它的 processor 必须一起缓存：processor 管着分词器和
                #   1008×1008 的预处理，换一个就对不上了。
                _SESS[key] = {"sess": {"model": mdl, "proc": proc}, "last": time.time(),
                              "runtime": "torch"}
                return _SESS[key]["sess"]

            from transformers import AutoModelForSemanticSegmentation
            mdl = AutoModelForSemanticSegmentation.from_pretrained(d, dtype=dtype).to(dev).eval()
            _SESS[key] = {"sess": mdl, "last": time.time(), "runtime": "torch"}
            return mdl

        so = ort.SessionOptions()
        so.log_severity_level = 3
        sess = ort.InferenceSession(p, sess_options=so, providers=_providers())
        _SESS[key] = {"sess": sess, "last": time.time(), "runtime": "onnx"}
        return sess


def _unload_one_locked(key):
    """释放某一个会话（必须在锁内调用）"""
    if key in _SESS:
        rt = _SESS[key].get("runtime")
        _SESS[key]["sess"] = None
        del _SESS[key]
        # ⚠ PyTorch 的显存不会因为 del 就还给系统，要显式清缓存。
        #   不清的话：换一次模型显存就涨一截，用户那边表现成"越用越卡"
        #   （DLSS 那边栽过同样的事，见记忆 project_dlss_tile 的"显存常驻待优化"）。
        if rt == "torch":
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass


def _unload_locked():
    """释放所有会话（必须在锁内调用）"""
    for key in list(_SESS.keys()):
        _unload_one_locked(key)
    try:
        import gc
        gc.collect()
    except Exception:
        pass


def unload():
    with _SESS_LOCK:
        _unload_locked()


def _idle_watch():
    while True:
        time.sleep(20)
        if IDLE_UNLOAD_SEC <= 0:
            continue
        with _SESS_LOCK:
            now = time.time()
            for key in list(_SESS.keys()):
                if _SESS[key]["sess"] is not None and (now - _SESS[key]["last"]) > IDLE_UNLOAD_SEC:
                    _unload_one_locked(key)


# ═══════════════════════════════════════════════════════════
#  生命周期：父进程监视 + 正常关闭（2026-10-10 加）
# ═══════════════════════════════════════════════════════════
# ⚠ 为什么需要（用户实测报的"显存被吃满"）：
#   引擎是 detached + unref 起来的（故意的，为了让软件重启时模型还在），
#   但以前**没人告诉它软件已经关了** ⇒ 它抱着 9.6GB 显存活 42 小时。
#
# ⚠⚠ 判"爹还在不在"用的是【先看进程活着没、再确认是不是同一个】：
#   只查 PID 存在是不够的 —— Windows 会复用 PID。
#   所以我们把爹的【启动时间】也一起传进来，两个都对得上才算"爹还活着"。
#   任何一步查不出来（权限不足等）⇒ 当成"爹还活着"，**绝不误杀**。
def _parent_alive(pid, started_at):
    if pid <= 0:
        return True                       # 没传 = 不监视，别乱判断
    try:
        import psutil                    # 引擎环境里有没有不一定，没有就走兜底
        try:
            proc = psutil.Process(pid)
            if not proc.is_running():
                return False
            if started_at and abs(proc.create_time() - started_at) > 1.0:
                return False             # PID 被复用了，不是原来那个爹
            return True
        except Exception:
            return False                 # psutil 说这个 pid 没了
    except Exception:
        pass
    # 兜底：只用 PID（拿不到启动时间也没关系，误判概率很低，而且只在爹真没了才有害）
    try:
        if os.name == "nt":
            import ctypes
            SYNCHRONIZE = 0x00100000
            k = ctypes.windll.kernel32
            h = k.OpenProcess(SYNCHRONIZE, False, int(pid))
            if not h:
                return False             # 打不开句柄 ⇒ 进程不在了
            try:
                # WAIT_TIMEOUT(0x102) = 还活着；WAIT_OBJECT_0(0) = 已退出
                return k.WaitForSingleObject(h, 0) == 0x102
            finally:
                k.CloseHandle(h)
        else:
            os.kill(int(pid), 0)
            return True
    except Exception:
        return False


def _parent_watch():
    """爹没了就自己走 —— 软件崩溃/被强杀时，这是唯一可靠的一道。"""
    pid = _PARENT_WATCH_PID
    started = 0.0
    try:
        started = float(os.environ.get("WHEELCHAIR_ENGINE_PARENT_STARTED", "0") or 0)
    except ValueError:
        started = 0.0
    print("[引擎] 父进程监视已开: pid=%d（它一没，我就退出并放掉显存）" % pid)
    misses = 0
    # ⚠ 节奏（2026-10-10）：5 秒一轮、连续 2 次（最坏约 15 秒）。
    #   原来是连续 3 次、10 秒一轮 ⇒ 最坏 30 秒，用户会觉得"关了软件显存还占着"。
    #   ⚠ 不改太激进（1 秒 1 次就走）的原因见 torch_worker 里那段注释。
    while True:
        time.sleep(5)
        if _SHUTDOWN["requested"]:
            return
        if _parent_alive(pid, started):
            misses = 0
            continue
        misses += 1
        if misses >= 2:
            print("[引擎] 父进程 %d 连续 %d 次查不到，自己退出（放掉显存）" % (pid, misses))
            _exit_now()


def _exit_now():
    """尽快退出：先尽力还显存，再硬退。"""
    try:
        unload()
    except Exception:
        pass
    try:
        _worker_http("/shutdown", timeout=5)     # 子进程也一起走，别留孤儿
    except Exception:
        pass
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass
    # ⚠ 用 os._exit 而不是 sys.exit：这是后台线程里调用的，
    #   sys.exit 只结束当前线程，进程照旧活着（那就白改了）。
    os._exit(0)


def _delayed_exit(delay=0.4):
    """回包之后稍微等一下再退 —— 让客户端先把响应读完。"""
    time.sleep(delay)
    _exit_now()


# ═══════════════════════════════════════════════════════════
#  图片编解码（复用 matting_server.py 那套）
# ═══════════════════════════════════════════════════════════
def decode_bytes(raw):
    if CAPS["pil"]:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img)
    if CAPS["cv2"]:
        arr = np.frombuffer(raw, np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    raise RuntimeError("需要 pillow 或 opencv-python 才能解码图片")


def encode_rgba(rgb, alpha):
    rgba = np.dstack([rgb.astype(np.uint8), alpha.astype(np.uint8)])
    if CAPS["pil"]:
        buf = io.BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", compress_level=3)
        return buf.getvalue()
    if CAPS["cv2"]:
        bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
        ok, enc = cv2.imencode(".png", bgra)
        if not ok:
            raise RuntimeError("PNG 编码失败")
        return enc.tobytes()
    raise RuntimeError("需要 pillow 或 opencv-python")


def encode_gray(gray_u8):
    """单通道灰度图 → PNG 字节。"""
    if CAPS["pil"]:
        buf = io.BytesIO()
        Image.fromarray(gray_u8, mode="L").save(buf, format="PNG", compress_level=3)
        return buf.getvalue()
    if CAPS["cv2"]:
        ok, enc = cv2.imencode(".png", gray_u8)
        if not ok:
            raise RuntimeError("PNG 编码失败")
        return enc.tobytes()
    raise RuntimeError("需要 pillow 或 opencv-python")


def _resize(arr, w, h):
    if CAPS["pil"]:
        return np.asarray(Image.fromarray(arr).resize((w, h), Image.BILINEAR))
    if CAPS["cv2"]:
        return cv2.resize(arr, (w, h), interpolation=cv2.INTER_LINEAR)
    raise RuntimeError("需要 pillow 或 opencv-python")


def _resize_f32(arr, w, h):
    """
    放大【浮点图】（logits / 概率），不是放大图片。

    ⚠ 为什么要单独一个函数、而且优先 cv2：
      _resize 走的是 PIL，float32 得用 'F' 模式，2000×1333 一张要十几毫秒；
      分割那边一次要放大十几二十张，用 cv2 是 3ms 一张，差一个数量级。
    ⚠ 一定要 float32 连续内存，否则 cv2 会拒收。
    """
    a = np.ascontiguousarray(arr, dtype=np.float32)
    if CAPS["cv2"]:
        return cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    if CAPS["pil"]:
        return np.asarray(Image.fromarray(a, mode="F").resize((w, h), Image.BILINEAR), dtype=np.float32)
    raise RuntimeError("需要 opencv-python 或 pillow")


def _shrink_to(im, w, h):
    """把一张 PIL 图缩到 (w,h)。只缩不放 —— 放大是凭空造像素，调用方自己保证 w/h 更小。"""
    if CAPS["cv2"]:
        import numpy as _n
        arr = _n.asarray(im.convert("RGB"))
        # INTER_AREA 是【专给缩小】的插值：按面积平均，不会像 LINEAR 那样带出摩尔纹
        return Image.fromarray(cv2.resize(arr, (w, h), interpolation=cv2.INTER_AREA))
    return im.convert("RGB").resize((w, h), Image.LANCZOS)


def align_pair_for_tween(im_a, im_b):
    """
    把两张尺寸不同的图对齐成同一个尺寸，供过渡帧用。

    ⚠⚠ 为什么必须有这个（2026-10-03 用户实测报的第三张卡）：
      过渡帧的端点是【逐像素】对齐的（光流要比每个点位移），所以引擎原来直接
      `if im_a.size != im_b.size: raise`。而现实里这两张图【天生就不一样大】：
        原图 = PS 选区抓来的（1055×963）
        成品 = 生图模型回来的（2174×1984）
      比例一样、分辨率不一样 —— 用户原话："PS内的画布和生图模型工作流回来的图
      比例一般是一致的，但是分辨率不一致"。
      → 这条 raise 等于把【所有人】都挡在门外，不是偶发。

    ⚠ 做法直接照抄【校色引擎】那条路（engine/match_server.py:1234）：
      尺寸不一样就 resize 对齐了再往下跑。它跑了几个月没出过事，
      这里是同一个问题，不该有两种解法。

    ⚠⚠ 对齐到【小的那一张】，只缩不放。两条理由，都要记住：
      ① 0% 端（原图）和 100% 端（成品）都必须是真东西。把原图放大 = 那一端
         变成插值糊出来的假图，用户滚到 0% 看到的不是他的原图，而是"猜出来的"。
      ② 缩小的插值（INTER_AREA）最干净 —— 它做的是面积平均，不发明像素。
     ⚠ 缩小还顺带省算力：本例像素少 76%，滚动更快。

    ⚠ 不判方向、自动取小的那张：原图比成品大的情况今天就可能有，
      写死"缩 b"过两天就撞上镜像版的同一个 bug。

    返回 (im_a2, im_b2, dev)：dev = 比例偏差（1.0 = 完全一致）。
    ⚠ dev 只是【报给前端】用的，这里【不拦】—— 拦了就是又一张死卡。
      真比例差很多（用户改过宽高比、构图都变了）时由前端提醒，
      但引擎照算：绷一个"能看但别当准"的预览，比直接失败有用得多。
    """
    if im_a.size == im_b.size:
        return im_a, im_b, 1.0
    wa, ha = im_a.size
    wb, hb = im_b.size
    ra = wa / float(max(1, ha))
    rb = wb / float(max(1, hb))
    dev = max(ra, rb) / max(1e-6, min(ra, rb))
    # 取面积小的那一个当基准（不是取宽度小的 —— 极端比例下两者会给出不同答案）
    if wa * ha <= wb * hb:
        return im_a, _shrink_to(im_b, wa, ha), dev
    return _shrink_to(im_a, wb, hb), im_b, dev


# ═══════════════════════════════════════════════════════════
#  边缘方式（分割 / 指哪抠哪共用）
#
#  ⚠⚠ 2026-09-15 修的头号质量问题：这两个功能的 mask 原来是
#    【在模型那个很小的格子上就切成非黑即白，然后才放大】——
#    SAM2 是 256×256（放到 2000 宽 = 一格 7.8px），
#    人体解析更小，只有 128×128（一格 15.6px）。
#    于是边界只能落在格线上，表现成 8~16 像素一级的台阶。
#    实测：SAM2 这一步让 33,749 个像素（占全图 1.27%）被判到了错误的一边。
#
#  正确顺序是【先把 logits 放大到原尺寸，再在原尺寸上切】：
#    零点会落在格子中间，边界精度提高到 1 像素，代价只有一次浮点放大（几毫秒）。
#    和坑68「类别编号图不能双线性放大」是同一类错误，只是方向相反 ——
#    那次是"离散的编号不能插值"，这次是"连续的分数不该提前离散化"。
#
#  三种方式（参数 edge）：
#    'grid'  老行为：小格子上切死再放大。留着是为了能一键对比/回退
#    'sharp' 先放大再切：边界准了，但是 1px 硬边，贴进 PS 有锯齿
#    'soft'  先放大再做软过渡（默认）：边界准 + 天然抗锯齿
#
#  ⚠ 这三种都【不会】凭空长出模型没看见的细节 —— 形状精度的天花板
#    还是那个 128²/256² 的格子。要发丝级的边只能靠抠像那条路（1024/2048 + 吸边）。
# ═══════════════════════════════════════════════════════════
EDGE_MODES = ("grid", "sharp", "soft")

# ⚠⚠ 全分辨率判断有内存代价，必须封顶。
#   人体解析要同时拿着"第一名分数/第二名分数/第一名是谁/当前这张"四张全尺寸图。
#   一张 8000×6000（面板的「抓图分辨率」默认是【原始尺寸】，PS 里框这么大很常见）
#   四张 float32 就是 768MB —— 用户机器上会明显卡一下甚至炸掉。
#   做法：判断在"封顶尺寸"上做，最后把【已经平滑的 alpha】再放大到原尺寸。
#   alpha 是连续的软图，再放大不会重新产生台阶（不像二值图那样）。
#   800 万像素时，8000 宽的图上一格 ≈ 2.4px —— 比原来的 15.6px 还是好一个数量级。
WORK_MAX_PIXELS = 8_000_000


def _work_size(W, H):
    """返回 (工作宽, 工作高, 是否缩过)。没超上限就原样返回。"""
    n = W * H
    if n <= WORK_MAX_PIXELS:
        return W, H, False
    k = (WORK_MAX_PIXELS / float(n)) ** 0.5
    return max(1, int(W * k)), max(1, int(H * k)), True


def _edge_alpha(logit_full, mode, soft_t):
    """把【已经放大到原尺寸】的分数图变成 0~1 的 alpha。"""
    if mode == "sharp":
        return (logit_full > 0).astype(np.float32)
    # soft：以 0 为界做线性过渡，soft_t 是过渡的半宽（分数单位，不是像素）
    t = max(1e-6, float(soft_t))
    return np.clip(0.5 + logit_full / (2.0 * t), 0.0, 1.0)


# ═══════════════════════════════════════════════════════════
#  归一化参数（两套：ImageNet 常规 / SCHP 的 BGR 序）
# ═══════════════════════════════════════════════════════════
_MEAN_IMAGENET = None
_STD_IMAGENET = None
_MEAN_SCHP = None
_STD_SCHP = None


def _norm_consts(kind="imagenet"):
    """
    返回 (mean, std) 两个 numpy 数组。
    kind: 'imagenet' (BiRefNet / SegFormer) | 'schp' (SCHP 人体解析)
    """
    global _MEAN_IMAGENET, _STD_IMAGENET, _MEAN_SCHP, _STD_SCHP
    if kind == "schp":
        if _MEAN_SCHP is None:
            _MEAN_SCHP = np.array([0.406, 0.456, 0.485], np.float32)
            _STD_SCHP = np.array([0.225, 0.224, 0.229], np.float32)
        return _MEAN_SCHP, _STD_SCHP
    else:
        if _MEAN_IMAGENET is None:
            _MEAN_IMAGENET = np.array([0.485, 0.456, 0.406], np.float32)
            _STD_IMAGENET = np.array([0.229, 0.224, 0.225], np.float32)
        return _MEAN_IMAGENET, _STD_IMAGENET


# ═══════════════════════════════════════════════════════════
#  后处理工具函数（从 matting_server.py 搬运，用于精修抠像结果）
#
#  ⚠ 这些是【修 mask】，不是"让模型抠得更准"。
#    模型判断错了（把背景里的人也抠进来）这些救不了 —— 那要靠指定抠什么。
#  ⚠ 每个函数都写清楚"治什么"，因为界面上的说明文字就是照这儿写的，
#    两边要对得上（说明和实际行为不一致比没说明更坏）。
# ═══════════════════════════════════════════════════════════
def _guided_alpha(alpha01, gray01, r=8, eps=1e-4):
    """
    引导滤波精修边缘：用原图的灰度当"引导"，把糊掉的 alpha 边缘吸附回真实轮廓。

    ⭐ 这是本文件质量提升最大的一项。原因：
      模型只在 1024 上算，贴回 4K 时 alpha 要放大近 4 倍 —— 边缘天然是糊的。
      引导滤波沿着原图的真实边缘停住，等于把精度"借"回来。

    ⚠ 必须用引导滤波，不能图省事用高斯模糊（match_server 的实测账：
      引导滤波降 86%，高斯只降 51%）。高斯会跨过边缘糊成一片，越糊越差。
    ⚠ r 是【半径】，boxFilter 要的是【窗口边长】= 2r+1。传错窗口只有一半大。
    """
    k = (2 * r + 1, 2 * r + 1)
    mean_g = cv2.boxFilter(gray01, -1, k)
    mean_p = cv2.boxFilter(alpha01, -1, k)
    mean_gp = cv2.boxFilter(gray01 * alpha01, -1, k)
    mean_gg = cv2.boxFilter(gray01 * gray01, -1, k)
    cov = mean_gp - mean_g * mean_p
    var = mean_gg - mean_g * mean_g
    a = cov / (var + eps)
    b = mean_p - a * mean_g
    return np.clip(cv2.boxFilter(a, -1, k) * gray01 + cv2.boxFilter(b, -1, k), 0.0, 1.0)


def _despeckle(alpha01, permille):
    """
    去碎片：丢掉面积小于 permille‰ 的独立小块。
    治"背景里误判出几个小点"。

    ⚠ 只处理【前景里的碎块】，不动主体 —— 按面积从大到小留，最大的那块一定保留。
    ⚠ 没有 opencv 就直接跳过（不是错误，只是这一项做不了）。
    """
    if not permille or not CAPS["cv2"]:
        return alpha01
    binm = (alpha01 > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(binm, 8)
    if n <= 2:                       # 只有背景+一块主体，没碎片
        return alpha01
    total = binm.shape[0] * binm.shape[1]
    keep = np.zeros(n, dtype=bool)
    keep[0] = False                  # 0 是背景
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        keep[i] = (i == biggest) or (area * 1000.0 / total >= permille)
    mask = keep[lab]
    return alpha01 * mask.astype(np.float32)


def _shrink(alpha01, px):
    """
    收缩(负) / 扩张(正)，单位像素。
    收缩治"边上带了一圈背景色"，扩张治"主体被吃掉一圈"。
    """
    if not px or not CAPS["cv2"]:
        return alpha01
    k = np.ones((abs(px) * 2 + 1, abs(px) * 2 + 1), np.uint8)
    if px < 0:
        return cv2.erode(alpha01, k)
    return cv2.dilate(alpha01, k)


def _remap(alpha01, threshold, contrast):
    """
    阈值 + 对比。两个都作用在【过渡带】上：
      threshold: 低于这个值的直接判成背景（治背景里的雾/光晕）
      contrast : 把半透明的一圈收紧，边缘更干脆

    ⚠ 都不做硬二值化 —— 硬二值会把发丝整条切掉，那正是抠图最值钱的部分。
      用平滑映射，用户调到最大也只是"很紧"，不是"全没了"。
    """
    a = alpha01
    if threshold:
        t = threshold / 100.0 * 0.5          # 0~100 → 0~0.5，再高就开始吃主体了
        a = np.clip((a - t) / max(1e-6, 1.0 - t), 0.0, 1.0)
    if contrast:
        # 以 0.5 为中心拉对比。k 越大过渡带越窄
        k = 1.0 + contrast / 100.0 * 8.0
        a = np.clip(0.5 + (a - 0.5) * k, 0.0, 1.0)
    return a


# ═══════════════════════════════════════════════════════════
#  抠像推理（BiRefNet 系列，复用 matting_server.py 验证过的逻辑）
# ═══════════════════════════════════════════════════════════
class MattingEmpty(Exception):
    """
    模型在这块区域里什么都没找到（alpha 全是 0）。

    ⚠ 单独开一个异常，不跟"引擎炸了"混在一起 —— 这两件事用户的下一步完全不同：
      引擎炸了 → 去看依赖/显存；什么都没找到 → 换档位或者重新框选区。
      混成一句"抠像失败"就是那种查不下去的报错（铁律 15）。
    """
    code = "MATTING_EMPTY"


def engine_error_reply(exc, raw=None):
    """
    引擎跑模型炸了 → 回给界面的 (error, code)。认出「显卡内存不够」单独说（10-25 用户审批 docs/286 B7）。

    ⚠ 中文 Windows 上 DirectML / onnxruntime 把系统报错「没有足够的存储空间…」(GBK) 当 UTF-8 交给 Python，
      解不开就变成 'utf-8' codec can't decode byte 0xd3 —— 用户只看到这句乱码，不知道是图太大、显存不够。
      0xd3 就是「有」字 GBK 的第一个字节（「没」两个字节碰巧能当 UTF-8 解过去）。
    """
    text = str(exc)
    low = text.lower()
    oom = isinstance(exc, UnicodeDecodeError) or "codec can't decode" in low or any(k in low for k in (
        "out of memory", "outofmemory", "not enough memory", "e_outofmemory", "insufficient memory",
        "failed to allocate", "bad allocation", "887a0005", "没有足够的存储空间", "内存不足"))
    if not oom:
        return text, None
    size = ""
    try:
        from PIL import Image
        w, h = Image.open(io.BytesIO(raw)).size
        size = "（这张 %d×%d）" % (w, h)
    except Exception:
        pass
    return ("显卡内存不够%s，这一档跑不动这么大的图。把选区框小一点、换低一档，或者打开云端外挂用云端算。" % size,
            "ENGINE_OUT_OF_MEMORY")


def run_matting(raw, model_key, params=None, out_mode="rgba"):
    """
    抠图。返回 (png_bytes, info)。

    out_mode: "rgba" (默认，裁到主体的RGBA) | "alpha" (整张图的纯黑RGB+alpha通道)
    """
    t0 = time.time()
    m = MODELS.get(model_key)
    if not m or m["kind"] != "matting":
        raise ValueError("没有这个抠像模型：%s" % model_key)
    rgb = decode_bytes(raw)
    H, W = rgb.shape[:2]
    t_dec = time.time()

    sess = load_model(model_key)
    shp = sess.get_inputs()[0].shape
    size = int(m["input"])
    try:
        h, w = shp[2], shp[3]
        if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
            size = int(h)
    except Exception:
        pass
    t_load = time.time()

    small = _resize(rgb, size, size).astype(np.float32) / 255.0
    mean, std = _norm_consts("imagenet")
    x = ((small - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    t_pre = time.time()

    name = sess.get_inputs()[0].name
    out = sess.run(None, {name: x}, _run_opts())[0]
    t_run = time.time()

    pred = np.asarray(out)
    while pred.ndim > 2:
        pred = pred[0]
    pred = np.clip(pred, 0.0, 1.0)
    alpha = _resize((pred * 255.0).astype(np.uint8), W, H).astype(np.float32) / 255.0

    # ── 后处理链（顺序是有讲究的，别随便调）──
    #   ① 精修：先把边缘吸附回真实轮廓，后面几步才有准确的边可依
    #   ② 阈值/对比：在准确的边上做取舍
    #   ③ 收缩扩张：整体挪边界
    #   ④ 去碎片：前面几步可能制造出新的小块，放最后清
    #   ⑤ 羽化：最后一步，不然后面的形态学会把羽化的软边又切硬
    P = params or {}
    applied = []
    skipped = []

    if P.get("refine", True) and CAPS["cv2"]:
        gray = (rgb.astype(np.float32).mean(axis=2)) / 255.0
        alpha = _guided_alpha(alpha, gray)
        applied.append("refine")
    elif P.get("refine", True):
        skipped.append("refine")

    th = int(P.get("threshold", 0) or 0)
    ct = int(P.get("contrast", 0) or 0)
    if th or ct:
        alpha = _remap(alpha, th, ct)
        applied.append("remap")

    sk = int(P.get("shrink", 0) or 0)
    if sk:
        if CAPS["cv2"]:
            alpha = _shrink(alpha, sk)
            applied.append("shrink")
        else:
            skipped.append("shrink")

    dsp = int(P.get("despeckle", 0) or 0)
    if dsp:
        if CAPS["cv2"]:
            alpha = _despeckle(alpha, dsp)
            applied.append("despeckle")
        else:
            skipped.append("despeckle")

    fe = int(P.get("feather", 0) or 0)
    if fe:
        if CAPS["cv2"]:
            k = fe * 2 + 1
            alpha = cv2.GaussianBlur(alpha, (k, k), 0)
            applied.append("feather")
        else:
            skipped.append("feather")

    alpha_u8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    cols = np.any(alpha_u8, axis=0)
    rows = np.any(alpha_u8, axis=1)
    if not cols.any():
        raise MattingEmpty("模型在这块区域里没找到主体。换一档模型，或者把选区框得更贴近主体")

    x0 = int(np.argmax(cols))
    x1 = int(len(cols) - np.argmax(cols[::-1]))
    y0 = int(np.argmax(rows))
    y1 = int(len(rows) - np.argmax(rows[::-1]))

    if out_mode == "alpha":
        # 返回整张图，RGB全黑，alpha通道是抠出来的
        black_rgb = np.zeros_like(rgb)
        png = encode_rgba(black_rgb, alpha_u8)
    else:
        # 默认模式：裁到主体
        png = encode_rgba(rgb[y0:y1, x0:x1], alpha_u8[y0:y1, x0:x1])

    t_end = time.time()

    return png, {
        "model": model_key, "tier": m["tier"],
        "size": [int(W), int(H)],
        "bbox": [x0, y0, x1, y1],
        "out": [x1 - x0, y1 - y0],
        "input": int(size),
        "provider": _PICKED["provider"],
        "applied": applied,
        "skipped": skipped,
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load": round((t_load - t_dec) * 1000),
            "pre": round((t_pre - t_load) * 1000),
            "infer": round((t_run - t_pre) * 1000),
            "post": round((t_end - t_run) * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }


# ═══════════════════════════════════════════════════════════
#  人体解析推理（SCHP / SegFormer）
# ═══════════════════════════════════════════════════════════
def run_segment(raw, model_key, params=None):
    """
    人体解析。返回 (结果JSON字节, info)。
    输出是【每个部位一个 mask】的 JSON，包含每个部位的 alphaB64。
    """
    t0 = time.time()
    m = MODELS.get(model_key)
    if not m or m["kind"] != "segment":
        raise ValueError("没有这个分割模型：%s" % model_key)
    rgb = decode_bytes(raw)
    H, W = rgb.shape[:2]
    t_dec = time.time()

    sess = load_model(model_key)
    runtime = m.get("runtime", "onnx")

    # ── 喂进去多大 ──
    # ⚠ 两种模型的 input 字段格式不一样：ONNX 那三条是一个数字(正方形)，
    #   Sapiens 是 [宽, 高]（768×1024 竖着的）。写死成一个数字会把 Sapiens 喂成正方形，
    #   不报错、只是结果变差 —— 又一个静默失效，所以这里显式判断类型。
    if isinstance(m["input"], (list, tuple)):
        size_w, size_h = int(m["input"][0]), int(m["input"][1])
    else:
        size_h = size_w = int(m["input"])
    if runtime == "onnx":
        try:
            shp = sess.get_inputs()[0].shape
            h, w = shp[2], shp[3]
            if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
                size_h, size_w = int(h), int(w)
        except Exception:
            pass
    t_load = time.time()

    small = _resize(rgb, size_w, size_h).astype(np.float32) / 255.0
    norm = m.get("normalize", {})
    mean = np.array(norm.get("mean", [0.485, 0.456, 0.406]), np.float32)
    std = np.array(norm.get("std", [0.229, 0.224, 0.225]), np.float32)
    x = ((small - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    t_pre = time.time()

    if runtime == "torch":
        # ⚠ 显卡上用 fp16（快一倍、省一半显存），但【算完立刻转回 float32】：
        #   后面整条后处理链（放大 logits / 比大小 / 引导滤波）都是 numpy float32 的，
        #   混着 fp16 会在某些环节悄悄丢精度。
        import torch
        dev = "cuda" if CAPS.get("cuda") else "cpu"
        dtype = torch.float16 if dev == "cuda" else torch.float32
        with torch.no_grad():
            t_in = torch.from_numpy(x).to(dev, dtype)
            out_t = sess(pixel_values=t_in)
        logits = out_t.logits[0].float().cpu().numpy()
        if dev == "cuda":
            torch.cuda.synchronize()
        del t_in, out_t
    else:
        name = sess.get_inputs()[0].name
        out = sess.run(None, {name: x}, _run_opts())
        logits = np.asarray(out[0])[0]  # [C, h, w]
    t_run = time.time()

    # ⚠ 修正 bug: 不能对 label 图直接双线性放大（会插出不存在的类别）
    # 正确做法：先在低分辨率按类别切出二值 mask，再双线性放大 mask
    labels_small = logits.argmax(0)  # [h, w] 低分辨率的类别图

    # 解析 params
    P = params or {}
    minPercent = float(P.get("minPercent", 0.3))
    want_parts = P.get("parts")  # None 或 [id, id, ...]
    want_masks = P.get("masks", True)
    edge = str(P.get("edge", "soft"))
    if edge not in EDGE_MODES:
        edge = "soft"
    soft_t = float(P.get("edgeSoft", 1.0) or 1.0)
    do_refine = bool(P.get("refine", False))

    label_list = m.get("labels", [])
    C = int(logits.shape[0])

    # ═══ 全分辨率 argmax（edge != 'grid' 时走这条）═══════════════
    #
    # ⚠⚠ 模型只在 128×128 上给分（放到 2000 宽 = 一格 15.6px）。
    #   老做法在这 128 格上就 argmax + 切二值，再放大 —— 边界被量化到 16px 的格线上。
    #   现在改成：先把【每个类别的分数图】放大到原尺寸，再逐像素比大小。
    #   形状精度的上限还是 128 格决定的，但边界位置能落在格子中间，台阶没了。
    #
    # ⚠ 不能把 18 张全分辨率 float 一次性摊开：18×2000×1333×4B = 192MB，
    #   在用户机器上会明显卡一下。用"跑动的第一名/第二名"两张数组就够（约 21MB）。
    #   第二名是给软边用的：两个类别分数打平的地方就是边界，alpha 给 0.5。
    ww, hh, capped = _work_size(W, H)
    best_val = best_id = second_val = None
    if edge != "grid":
        for c in range(C):
            up = _resize_f32(logits[c], ww, hh)
            if best_val is None:
                best_val = up
                best_id = np.zeros((hh, ww), np.uint8)
                second_val = np.full((hh, ww), -1e9, np.float32)
                continue
            better = up > best_val
            second_val = np.where(better, best_val, np.maximum(second_val, up))
            best_id = np.where(better, np.uint8(c), best_id)
            best_val = np.where(better, up, best_val)

    # 先统计一遍有哪些部位
    # ⚠ 统计要在【最终用的那张类别图】上做，否则名单和 mask 会对不上：
    #   低分辨率上占 0.31% 的小部位，放大后可能只剩 0.28%，
    #   于是名单里有它、mask 却是空的（静默不一致）。
    if edge != "grid":
        counts = np.bincount(best_id.ravel(), minlength=C)
        tot = float(hh * ww)
    else:
        counts = np.bincount(labels_small.ravel().astype(np.int64), minlength=C)
        tot = float(labels_small.size)
    candidates = []
    for c in range(C):
        pct = 100.0 * float(counts[c]) / tot
        if pct >= minPercent:
            candidates.append({
                "id": int(c),
                "name": label_list[c] if c < len(label_list) else "未知%d" % c,
            })

    # 过滤：只要 want_parts 里的
    if want_parts is not None:
        want_set = set(want_parts)
        candidates = [p for p in candidates if p["id"] in want_set]

    gray_full = None
    if do_refine and CAPS["cv2"]:
        gray_full = (rgb.astype(np.float32).mean(axis=2)) / 255.0
    applied_edge = edge if edge in EDGE_MODES else "soft"
    applied_refine = bool(do_refine and CAPS["cv2"])

    # 生成每个部位的 mask
    parts = []
    for p in candidates:
        c = p["id"]
        if edge == "grid":
            # 老行为：在低分辨率切出二值 mask，再双线性放大（边界量化在 128 格上）
            mask_small = (labels_small == c).astype(np.float32)
            mask_full = _resize((mask_small * 255.0).astype(np.uint8), W, H).astype(np.float32) / 255.0
        else:
            # ⚠ 这里必须再放大一次【这个类别自己的】分数图，不能只拿第一名/第二名的差。
            #   第二名的差只能告诉你"赢家赢了多少"，
            #   对一个排第五的类别，它应该是 0，而不是 0.5 减去点什么。
            up_c = _resize_f32(logits[c], ww, hh)
            rival = np.where(best_id == np.uint8(c), second_val, best_val)
            mask_full = _edge_alpha(up_c - rival, edge, soft_t)
            if capped:
                # 已经是平滑的 alpha 了，再放大不会重新产生台阶
                mask_full = _resize_f32(mask_full, W, H)
        if applied_refine:
            # 吸边：拿原图的灰度当引导，把边界吸到真实轮廓上（抠像的「边缘精修」同一套）
            mask_full = _guided_alpha(mask_full.astype(np.float32), gray_full)
        mask_u8 = np.clip(mask_full * 255.0, 0, 255).astype(np.uint8)

        cnt = int((mask_u8 > 127).sum())
        pct = 100.0 * cnt / (H * W)

        # 计算 bbox
        cols = np.any(mask_u8 > 127, axis=0)
        rows = np.any(mask_u8 > 127, axis=1)
        if cols.any():
            x0 = int(np.argmax(cols))
            x1 = int(len(cols) - np.argmax(cols[::-1]))
            y0 = int(np.argmax(rows))
            y1 = int(len(rows) - np.argmax(rows[::-1]))
            bbox = [x0, y0, x1, y1]
        else:
            bbox = None

        part = {
            "id": int(c),
            "name": p["name"],
            "pixels": cnt,
            "percent": round(pct, 2),
            "bbox": bbox,
        }

        # ⚠⚠ 背景(id 0)默认【不编码 mask】。
        #   界面那边根本不会把背景做成图层（用户要的是主体的部位），
        #   而它偏偏是占比最大的那一块 —— 实测一张 2000×1333 的图上，
        #   光背景这一张就 83.6KB，占整个响应体的 1/4。白传。
        #   ⚠ 但名单里【照样报】它的占比：那是有用的信息（能看出主体占多少画面）。
        #   ⚠ 用户真要背景的话，显式写 parts:[0] 就给 —— 不是一刀切禁掉。
        need_mask = want_masks and (int(c) != 0 or (want_parts is not None and 0 in set(want_parts)))
        if need_mask:
            # 编码成纯黑 RGB + alpha 通道的 RGBA PNG
            black_rgb = np.zeros((H, W, 3), dtype=np.uint8)
            png_bytes = encode_rgba(black_rgb, mask_u8)
            part["alphaB64"] = base64.b64encode(png_bytes).decode("ascii")
            del png_bytes, black_rgb, mask_u8, mask_full   # 立即释放
        else:
            del mask_u8, mask_full
        # ⚠ 这里原来还 del 了 mask_small，但 edge != 'grid' 时那个变量根本不存在
        #   —— 会直接 NameError 把整次请求炸掉。改动后必须连它一起改。

        parts.append(part)

    t_end = time.time()

    result = {
        "ok": True,
        "model": model_key,
        "tier": m["tier"],
        "size": [int(W), int(H)],
        "input": [size_w, size_h],
        # ⚠ 算力要报【这次真正用的那个】。Sapiens 走 PyTorch，报 ONNX 的 provider 是假信息
        #   —— 界面上会显示"DirectML"，实际跑的是 CUDA（docs/40 规矩 2：不许报名不副实的东西）。
        "runtime": runtime,
        "parts": parts,
        # ⚠ 把【实际用了哪种边缘方式】回给界面：用户开了"吸边"但这台机器没装 opencv 时
        #   必须看得出来没做（docs/40 规矩4：做不到要说，不许默默降级）。
        "edge": applied_edge,
        "refine": applied_refine,
        "edgeGrid": [int(logits.shape[-1]), int(logits.shape[-2])],   # 模型内部那个格子多大
        # 判断是在多大的图上做的（超过 800 万像素会封顶，见 WORK_MAX_PIXELS）。
        # ⚠ 封了顶就要说，不许瞒着 —— 用户得知道这张图是按缩过的尺寸判的。
        "workSize": [int(ww), int(hh)],
        "capped": bool(capped),
        "provider": ("PyTorch/" + ("CUDA" if CAPS.get("cuda") else "CPU")) if runtime == "torch"
                    else _PICKED["provider"],
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load": round((t_load - t_dec) * 1000),
            "pre": round((t_pre - t_load) * 1000),
            "infer": round((t_run - t_pre) * 1000),
            "post": round((t_end - t_run) * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }
    result_json = json.dumps(result, ensure_ascii=False).encode("utf-8")
    return result_json, result


# ═══════════════════════════════════════════════════════════
#  细边（ViTMatte）：把粗 mask 的边重算成发丝级 alpha
#
#  输入约定（和别的路由不一样，注意）：请求体是一张 **RGBA PNG**：
#     RGB = 原图，A = 粗 mask。
#  为什么这么设计：一次请求要带两张图，而 multipart 解析在这个裸 http 服务里
#  是纯负担；塞 header 又会超长（一张 2000×1333 的 mask base64 就 110KB）。
#  用 alpha 通道捎带，前端 canvas 一行就能拼出来。
#
#  ⚠⚠ 绝不整张图喂模型。实测 fp32：1024² 95ms/3.1GB，
#     1536² 就要 3.2 秒/13.2GB，2048² 是 **499 秒**/40.1GB（爆显存后疯狂换页）。
#     所以：只裁"不确定带"的外接框 → 再切成 ≤1024 的块 → 重叠融合。
# ═══════════════════════════════════════════════════════════
def _trimap_from(alpha_u8, erode_px, dilate_px):
    """
    粗 mask → trimap：往里缩 = 肯定是前景(255)，往外扩之外 = 肯定是背景(0)，中间 = 不确定(128)。
    ⚠ 往外扩要比往里缩宽：发丝是【伸到粗 mask 外面】去的，
      外圈太窄的话发丝落在"肯定是背景"里，再怎么算也救不回来。
    """
    b = (alpha_u8 > 127).astype(np.uint8)
    ke = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (erode_px * 2 + 1,) * 2)
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px * 2 + 1,) * 2)
    fg = cv2.erode(b, ke)
    bg = cv2.dilate(b, kd)
    tri = np.full(b.shape, 128, np.uint8)
    tri[fg > 0] = 255
    tri[bg == 0] = 0
    return tri


def run_matte(raw, model_key, params=None):
    """细边。返回 (png_bytes, info)。png 是整张图尺寸的 RGBA（RGB全黑 + 精修后的 alpha）。"""
    t0 = time.time()
    m = MODELS.get(model_key)
    if not m or m["kind"] != "matte":
        raise ValueError("没有这个细边模型：%s" % model_key)
    if not CAPS["cv2"]:
        raise RuntimeError("细边要 opencv（收缩扩张出 trimap 靠它），这台机器没装")

    P = params or {}
    erode_px = int(P.get("erode", 8) or 8)
    dilate_px = int(P.get("dilate", 24) or 24)
    tile = int(P.get("tile", 1024) or 1024)
    tile = max(256, min(1024, tile))        # ⚠ 上限焊死 1024：再大就是上面那条雪崩曲线
    overlap = int(P.get("overlap", 64) or 64)

    # ── 请求体：RGBA PNG（RGB=原图，A=粗 mask）──
    if not CAPS["pil"]:
        raise RuntimeError("需要 pillow")
    im = Image.open(io.BytesIO(raw))
    if im.mode != "RGBA":
        raise ValueError("细边要的是一张 RGBA 图：RGB 放原图、alpha 放粗选区。收到的是 %s" % im.mode)
    arr = np.asarray(im)
    rgb = arr[:, :, :3].astype(np.uint8)
    coarse = arr[:, :, 3].astype(np.uint8)
    H, W = coarse.shape
    t_dec = time.time()

    tri = _trimap_from(coarse, erode_px, dilate_px)
    unknown = tri == 128
    n_unknown = int(unknown.sum())
    if n_unknown == 0:
        # 没有不确定带 = 这张 mask 已经是纯 0/255 且收缩扩张后没剩下东西，原样退回
        png = encode_rgba(np.zeros_like(rgb), coarse)
        return png, {"model": model_key, "size": [W, H], "unknown": 0, "tiles": 0,
                     "note": "没有需要重算的边缘（粗 mask 太小或收缩扩张吃光了）",
                     "ms": {"total": round((time.time() - t0) * 1000)}}

    import torch
    mdl = load_model(model_key)
    t_load = time.time()

    # ── 只在"不确定带的外接框"里干活 ──
    ys, xs = np.nonzero(unknown)
    pad = 16
    rx0 = max(0, int(xs.min()) - pad); rx1 = min(W, int(xs.max()) + 1 + pad)
    ry0 = max(0, int(ys.min()) - pad); ry1 = min(H, int(ys.max()) + 1 + pad)
    rw, rh = rx1 - rx0, ry1 - ry0

    out_a = coarse.astype(np.float32) / 255.0          # 底子用粗 mask，只覆盖不确定带
    acc = np.zeros((rh, rw), np.float32)
    wsum = np.zeros((rh, rw), np.float32)

    step = max(64, tile - overlap)
    xs_list = list(range(0, max(1, rw - overlap), step)) or [0]
    ys_list = list(range(0, max(1, rh - overlap), step)) or [0]
    n_tiles = 0
    t_infer = 0.0
    for ty in ys_list:
        for tx in xs_list:
            x0 = min(tx, max(0, rw - tile)); y0 = min(ty, max(0, rh - tile))
            x1 = min(rw, x0 + tile); y1 = min(rh, y0 + tile)
            sub_tri = tri[ry0 + y0:ry0 + y1, rx0 + x0:rx0 + x1]
            if not (sub_tri == 128).any():
                continue                                # 这块里没有不确定带，跳过
            sub_rgb = rgb[ry0 + y0:ry0 + y1, rx0 + x0:rx0 + x1]
            hh, ww = sub_tri.shape
            # ⚠ ViT 要求边长是 32 的倍数，补边用 reflect（补黑边会在边界造出假轮廓）
            ph, pw = (32 - hh % 32) % 32, (32 - ww % 32) % 32
            xi = np.pad(sub_rgb.astype(np.float32) / 255.0, ((0, ph), (0, pw), (0, 0)), mode="reflect")
            xt = np.pad(sub_tri.astype(np.float32) / 255.0, ((0, ph), (0, pw)), mode="reflect")
            inp = np.concatenate([xi, xt[:, :, None]], axis=2).transpose(2, 0, 1)[None]
            tt = time.time()
            with torch.no_grad():
                o = mdl(pixel_values=torch.from_numpy(np.ascontiguousarray(inp)).to("cuda" if CAPS.get("cuda") else "cpu"))
            a = o.alphas[0, 0].float().cpu().numpy()[:hh, :ww]
            if CAPS.get("cuda"):
                torch.cuda.synchronize()
            t_infer += time.time() - tt
            n_tiles += 1
            # ⚠ 重叠处要渐变融合，不能硬贴。但【只在有邻块的那一侧】渐变 ——
            #   图像真实边界那一侧照样给满权重，否则整圈权重趋零，结果会发暗
            #   （DLSS 那边踩过这个坑：不重叠却加渐变 = 边缘变暗）。
            wgt = np.ones((hh, ww), np.float32)
            r = max(1, overlap)
            if x0 > 0:
                wgt[:, :r] *= np.linspace(0, 1, r, dtype=np.float32)[None, :]
            if x1 < rw:
                wgt[:, -r:] *= np.linspace(1, 0, r, dtype=np.float32)[None, :]
            if y0 > 0:
                wgt[:r, :] *= np.linspace(0, 1, r, dtype=np.float32)[:, None]
            if y1 < rh:
                wgt[-r:, :] *= np.linspace(1, 0, r, dtype=np.float32)[:, None]
            acc[y0:y1, x0:x1] += a * wgt
            wsum[y0:y1, x0:x1] += wgt

    got = wsum > 1e-6
    refined = np.zeros((rh, rw), np.float32)
    refined[got] = acc[got] / wsum[got]

    # ⚠ 只把【不确定带】换成新算的；肯定前景/肯定背景那两块保持原样。
    #   全覆盖的话模型会把主体内部也重算一遍，偶尔会在衣服中间开个洞。
    sub_unknown = unknown[ry0:ry1, rx0:rx1] & got
    region = out_a[ry0:ry1, rx0:rx1]
    region[sub_unknown] = refined[sub_unknown]
    out_a[ry0:ry1, rx0:rx1] = region

    alpha_u8 = np.clip(out_a * 255.0, 0, 255).astype(np.uint8)
    png = encode_rgba(np.zeros_like(rgb), alpha_u8)
    t_end = time.time()

    soft_before = int(((coarse > 5) & (coarse < 250)).sum())
    soft_after = int(((alpha_u8 > 5) & (alpha_u8 < 250)).sum())
    return png, {
        "model": model_key,
        "size": [int(W), int(H)],
        "roi": [rx0, ry0, rx1, ry1],
        "unknown": n_unknown,
        "unknownPercent": round(100.0 * n_unknown / (W * H), 2),
        "tiles": n_tiles,
        "tile": tile,
        "erode": erode_px,
        "dilate": dilate_px,
        # 软边像素变了多少 —— 这是"细边到底做了事没有"最直观的一个数
        "softBefore": soft_before,
        "softAfter": soft_after,
        "runtime": "torch",
        "provider": "PyTorch/" + ("CUDA" if CAPS.get("cuda") else "CPU"),
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load": round((t_load - t_dec) * 1000),
            "infer": round(t_infer * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }


# ═══════════════════════════════════════════════════════════
#  文字选区推理（SAM 3）
#
#  一句话：打一个英文词 → 画面里所有符合的东西，每个一张 mask。
#
#  ⚠⚠ 这里【照抄 transformers 自己的后处理逻辑】，但有意少做最后一步：
#    它的流程是 sigmoid(分数) → 按阈值筛 → sigmoid(mask) → 双线性放大 → **切成0/1**。
#    最后那一刀把算好的软边扔了。我们留着软边（贴进 PS 才没有锯齿），
#    其余每一步都和它一模一样 —— 所以不用自己实现筛选/NMS，也就不会和官方行为跑偏。
#    （它那版确实没有 NMS，是纯阈值筛，我读过源码确认过。）
# ═══════════════════════════════════════════════════════════
def run_sam3(raw, model_key, params=None):
    """文字选区。返回 (结果JSON字节, info)。"""
    t0 = time.time()
    m = MODELS.get(model_key)
    if not m or m["kind"] != "sam3":
        raise ValueError("没有这个文字选区模型：%s" % model_key)

    P = params or {}
    text = str(P.get("text") or "").strip()
    if not text:
        raise ValueError("没给词。文字选区要一个英文词，比如 hair / necktie / gloves")
    thr = float(P.get("threshold", 0.4) or 0.4)
    mask_thr = float(P.get("maskThreshold", 0.5) or 0.5)
    max_inst = int(P.get("maxInstances", 20) or 20)
    edge = str(P.get("edge", "soft"))
    if edge not in ("soft", "sharp"):
        edge = "soft"
    do_refine = bool(P.get("refine", False))
    applied_refine = bool(do_refine and CAPS["cv2"])

    rgb = decode_bytes(raw)
    H, W = rgb.shape[:2]
    t_dec = time.time()

    import torch
    bundle = load_model(model_key)
    mdl, proc = bundle["model"], bundle["proc"]
    dev = "cuda" if CAPS.get("cuda") else "cpu"
    t_load = time.time()

    inputs = proc(images=Image.fromarray(rgb), text=text, return_tensors="pt").to(dev)
    if "pixel_values" in inputs and dev == "cuda":
        inputs["pixel_values"] = inputs["pixel_values"].to(torch.float16)
    t_pre = time.time()

    with torch.no_grad():
        out = mdl(**inputs)
    if dev == "cuda":
        torch.cuda.synchronize()
    t_run = time.time()

    # ── 筛选（和 transformers 完全一致）──
    scores = out.pred_logits.sigmoid()                      # [1, 查询数]
    if getattr(out, "presence_logits", None) is not None:
        scores = scores * out.presence_logits.sigmoid()     # 「画面里到底有没有这东西」
    scores = scores[0].float().cpu().numpy()
    keep = np.nonzero(scores > thr)[0]
    # 把握度高的排前面，并且封顶 —— 一个词命中几十个实例时，
    # 全编码成 PNG 回传会把响应撑爆（一张 2000×1333 的 mask 约 80KB）。
    keep = keep[np.argsort(-scores[keep])][:max_inst]
    total_hit = int((scores > thr).sum())

    boxes = out.pred_boxes[0].float().cpu().numpy()          # xyxy，0~1 归一化
    ww, hh, capped = _work_size(W, H)
    gray_full = (rgb.astype(np.float32).mean(axis=2)) / 255.0 if applied_refine else None

    instances = []
    for rank, qi in enumerate(keep):
        # sigmoid → 放大到（封顶后的）工作尺寸。这两步和 transformers 一样，
        # 只是它接着切 0/1，我们把软的留着。
        mk = out.pred_masks[0, int(qi)].float()
        a = torch.nn.functional.interpolate(mk.sigmoid()[None, None], size=(hh, ww),
                                            mode="bilinear", align_corners=False)[0, 0]
        a01 = a.cpu().numpy().astype(np.float32)
        if capped:
            a01 = _resize_f32(a01, W, H)      # 已经是平滑的 alpha，再放大不会出台阶
        if edge == "sharp":
            a01 = (a01 > mask_thr).astype(np.float32)
        if applied_refine:
            a01 = _guided_alpha(a01, gray_full)
        alpha_u8 = np.clip(a01 * 255.0, 0, 255).astype(np.uint8)

        solid = alpha_u8 > 127
        if not solid.any():
            continue                          # 阈值以上但放大后没有实心像素 —— 丢掉，别给空图层
        cols = np.any(solid, axis=0)
        rows = np.any(solid, axis=1)
        x0 = int(np.argmax(cols)); x1 = int(len(cols) - np.argmax(cols[::-1]))
        y0 = int(np.argmax(rows)); y1 = int(len(rows) - np.argmax(rows[::-1]))
        px = int(solid.sum())

        black_rgb = np.zeros((H, W, 3), dtype=np.uint8)
        png_bytes = encode_rgba(black_rgb, alpha_u8)
        instances.append({
            "index": rank,
            "query": int(qi),
            "score": round(float(scores[qi]), 3),
            "bbox": [x0, y0, x1, y1],
            # 模型自己给的框（归一化 xyxy → 像素），和 mask 的外接框对照着看能发现异常
            "detBox": [round(float(boxes[qi][0]) * W), round(float(boxes[qi][1]) * H),
                       round(float(boxes[qi][2]) * W), round(float(boxes[qi][3]) * H)],
            "pixels": px,
            "percent": round(100.0 * px / (W * H), 2),
            "alphaB64": base64.b64encode(png_bytes).decode("ascii"),
        })
        del png_bytes, black_rgb, alpha_u8, a01, solid

    t_end = time.time()
    result = {
        "ok": True,
        "model": model_key,
        "text": text,
        "size": [int(W), int(H)],
        "instances": instances,
        # ⚠ 命中数和回传数要分开报：封顶丢掉的那些必须让用户知道，
        #   不然他以为"只有这么多"（docs/40 规矩 4：不许静默少给）。
        "count": len(instances),
        "hit": total_hit,
        "truncated": bool(total_hit > len(instances)),
        "threshold": thr,
        "edge": edge,
        "refine": applied_refine,
        "edgeGrid": [int(out.pred_masks.shape[-1]), int(out.pred_masks.shape[-2])],
        "workSize": [int(ww), int(hh)],
        "capped": bool(capped),
        "runtime": "torch",
        "provider": "PyTorch/" + ("CUDA" if CAPS.get("cuda") else "CPU"),
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load": round((t_load - t_dec) * 1000),
            "pre": round((t_pre - t_load) * 1000),
            "infer": round((t_run - t_pre) * 1000),
            "post": round((t_end - t_run) * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }
    return json.dumps(result, ensure_ascii=False).encode("utf-8"), result


# ═══════════════════════════════════════════════════════════
#  SAM2 推理（点选/框选抠图，encoder + decoder 两步）
# ═══════════════════════════════════════════════════════════
def run_sam2(raw, enc_key, params=None):
    """
    SAM2 点选/框选抠图。返回 (json_bytes, info)。
    ⚠ 返回 JSON（包含三个候选），不再是单张 PNG。
    """
    t0 = time.time()
    m_enc = MODELS.get(enc_key)
    if not m_enc or m_enc["kind"] != "sam2-enc":
        raise ValueError("没有这个 SAM2 encoder：%s" % enc_key)
    # ⚠⚠ 必须用【这个 encoder 配套的那个】decoder，不许拿别的顶上。
    #   拿错的顶上不会报错，只会让 mask 悄悄变成一堆碎块（实测见 MODELS 表那段注释）。
    dec_key = decoder_for(enc_key)
    m_dec = MODELS.get(dec_key) if dec_key else None
    if not m_dec:
        raise ValueError("%s 没有登记配套的解码器" % enc_key)
    if not decoder_ready(enc_key):
        raise ValueError("%s 配套的解码器文件不在（要 %s）。换一档，或者把这个文件下下来"
                         % (m_enc["name"], m_dec["file"]))

    rgb = decode_bytes(raw)
    H, W = rgb.shape[:2]
    t_dec = time.time()

    # ── Encoder ──
    sess_enc = load_model(enc_key)
    shp = sess_enc.get_inputs()[0].shape
    size = 1024
    try:
        h, w = shp[2], shp[3]
        if isinstance(h, int) and isinstance(w, int) and h > 0:
            size = int(h)
    except Exception:
        pass
    t_load_enc = time.time()

    small = _resize(rgb, size, size).astype(np.float32) / 255.0
    mean, std = _norm_consts("imagenet")
    x = ((small - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    t_pre = time.time()

    enc_out = sess_enc.run(None, {sess_enc.get_inputs()[0].name: x}, _run_opts())
    t_enc = time.time()

    emb = {o.name: v for o, v in zip(sess_enc.get_outputs(), enc_out)}

    # ── Decoder ──
    sess_dec = load_model(dec_key)
    t_load_dec = time.time()

    # 解析参数：mode = "box" | "point"
    P = params or {}
    mode = P.get("mode", "box")

    if mode == "box":
        box = P.get("box")
        if box:
            x0, y0, x1, y1 = box
            # 归一化到 encoder 的 1024×1024 空间
            coords = [[x0 * size / W, y0 * size / H], [x1 * size / W, y1 * size / H]]
            labels = [2, 3]  # 2=框左上，3=框右下
        else:
            # 默认：整张图当框
            coords = [[0, 0], [size, size]]
            labels = [2, 3]
    else:  # mode == "point"
        points = P.get("points", [[size // 2, size // 2]])
        point_labels = P.get("labels", [1])
        # 归一化坐标
        coords = [[pt[0] * size / W, pt[1] * size / H] for pt in points]
        labels = point_labels
        # 补齐到至少 2 个点
        while len(coords) < 2:
            coords.append([0, 0])
            labels.append(-1)

    feed = {
        "image_embed": emb["image_embed"],
        "high_res_feats_0": emb["high_res_feats_0"],
        "high_res_feats_1": emb["high_res_feats_1"],
        "point_coords": np.array([coords], np.float32),
        "point_labels": np.array([labels], np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), np.float32),
        "has_mask_input": np.array([0], np.float32),
    }
    dec_out = sess_dec.run(None, feed, _run_opts())
    t_dec_run = time.time()

    masks, iou = dec_out[0], dec_out[1]  # [1, 3, 256, 256], [1, 3]

    # 处理三个候选
    import base64
    # ── 边缘方式（2026-09-15）──
    #   ⚠⚠ 原来这里是 `_resize((mask_256 > 0) * 255, W, H)`：
    #     【先在 256 格上切死，再放大】。放到 2000 宽时一格 7.8px，
    #     边界只能落在格线上 → 8 像素一级的台阶。
    #     实测这一步让 33,749 个像素（占全图 1.27%）被判到了错误的一边。
    #   现在默认先把 logits 放大到原尺寸再切，代价是一次浮点放大（几毫秒）。
    edge = str(P.get("edge", "soft"))
    if edge not in EDGE_MODES:
        edge = "soft"
    soft_t = float(P.get("edgeSoft", 2.0) or 2.0)
    do_refine = bool(P.get("refine", False))
    applied_refine = bool(do_refine and CAPS["cv2"])
    gray_full = (rgb.astype(np.float32).mean(axis=2)) / 255.0 if applied_refine else None

    # 同样封顶：8000×6000 时一张全尺寸 float32 就是 192MB，这里一次要两张
    ww, hh, capped = _work_size(W, H)

    candidates = []
    for idx in range(3):
        mask_256 = masks[0][idx]  # [256, 256] —— 这是 logits（分数），不是 0/1
        if edge == "grid":
            a01 = _resize((mask_256 > 0).astype(np.uint8) * 255, W, H).astype(np.float32) / 255.0
        else:
            a01 = _edge_alpha(_resize_f32(mask_256, ww, hh), edge, soft_t)
            if capped:
                a01 = _resize_f32(a01, W, H)
        if applied_refine:
            a01 = _guided_alpha(a01.astype(np.float32), gray_full)
        alpha_u8 = np.clip(a01 * 255.0, 0, 255).astype(np.uint8)

        # 计算 bbox 和 pixels
        # ⚠ 判据从 >0 改成 >127（半透明以上才算数）。
        #   软边/吸边之后边界外会有一圈很淡的过渡，用 >0 的话
        #   bbox 会被这层淡雾撑到整张画布、pixels 也虚高 —— 数字一乱，
        #   界面上"最佳候选"就选错了。
        solid = alpha_u8 > 127
        cols = np.any(solid, axis=0)
        rows = np.any(solid, axis=1)
        if cols.any():
            x0 = int(np.argmax(cols))
            x1 = int(len(cols) - np.argmax(cols[::-1]))
            y0 = int(np.argmax(rows))
            y1 = int(len(rows) - np.argmax(rows[::-1]))
            bbox = [x0, y0, x1, y1]
            pixels = int(solid.sum())
        else:
            bbox = None
            pixels = 0

        # 编码成纯黑 RGB + alpha
        black_rgb = np.zeros((H, W, 3), dtype=np.uint8)
        png_bytes = encode_rgba(black_rgb, alpha_u8)
        alphaB64 = base64.b64encode(png_bytes).decode("ascii")

        candidates.append({
            "index": idx,
            "iou": round(float(iou[0][idx]), 3),
            "bbox": bbox,
            "pixels": pixels,
            "alphaB64": alphaB64,
        })
        # ⚠ 原来这里还 del 了 mask_full，改成 a01 之后那个名字没有了 —— 会 NameError。
        del png_bytes, black_rgb, alpha_u8, a01, solid

    best_idx = int(np.argmax(iou[0]))
    t_end = time.time()

    result = {
        "ok": True,
        "model": enc_key,
        "decoder": dec_key,
        "tier": m_enc["tier"],
        "size": [int(W), int(H)],
        "best": best_idx,
        "candidates": candidates,
        "input": int(size),
        # 实际用了哪种边缘方式 + 模型内部那个格子多大（界面要能一眼看出精度上限）
        "edge": edge,
        "refine": applied_refine,
        "edgeGrid": [int(masks.shape[-1]), int(masks.shape[-2])],
        "workSize": [int(ww), int(hh)],
        "capped": bool(capped),
        "provider": _PICKED["provider"],
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load_enc": round((t_load_enc - t_dec) * 1000),
            "pre": round((t_pre - t_load_enc) * 1000),
            "encoder": round((t_enc - t_pre) * 1000),
            "load_dec": round((t_load_dec - t_enc) * 1000),
            "decoder": round((t_dec_run - t_load_dec) * 1000),
            "post": round((t_end - t_dec_run) * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }
    result_json = json.dumps(result, ensure_ascii=False).encode("utf-8")
    return result_json, result


# ═══════════════════════════════════════════════════════════
#  HTTP 服务器（复用框架，三条路由分流）
# ═══════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════
#  PyTorch 子进程（方案 B · 2026-10-04）
#
#  为什么要把 torch 那几样拆出去（docs/133 有完整实测）：
#    同一个进程里【先建 DirectML 会话】再【把张量放显卡上】= 段错误，
#    整个引擎当场没，连 traceback 都没有。实测：
#      · 建了 DML 会话，哪怕立刻删掉，之后用 torch 显卡照样崩（雷埋下收不回）
#      · 主进程只跑 ONNX(DML)、子进程只跑 torch → 两边都活着 ✅
#    ⇒ 就把 torch 那几样（人体解析 Meta / 文字选区 / 细边 / 过渡帧）
#      交给一个独立子进程，主进程一个 torch 张量都不碰。
#
#  ⚠⚠ 主进程这边【绝不能】import torch 之外还去用它算东西。查型号可以
#     （实测安全），建张量不行（实测必崩）。
# ═══════════════════════════════════════════════════════════
_WORKER = {
    "proc": None, "ready": False, "err": "", "lock": threading.Lock(),
    "caps": {"torch": False, "cuda": False}, "device": "", "vram": None,
}


def worker_port():
    """子进程端口。跟着主进程走（主 37894 → 子 37895），换端口调试也不会撞。"""
    return PORT + 1


def worker_script():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "torch_worker.py")


def _worker_http(path, method="GET", body=None, headers=None, timeout=10):
    """往子进程发一个请求，返回 (status, headers_dict, body_bytes)。通了但没起 → None。"""
    import http.client
    try:
        c = http.client.HTTPConnection("127.0.0.1", worker_port(), timeout=timeout)
        c.request(method, path, body=body, headers=_access_headers(headers))
        r = c.getresponse()
        data = r.read()
        hs = {k.lower(): v for k, v in r.getheaders()}
        st = r.status
        c.close()
        return st, hs, data
    except Exception:
        return None


def _worker_health():
    got = _worker_http("/health", timeout=6)
    if not got:
        return None
    st, _hs, data = got
    if st != 200:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        return None


def _refresh_worker_caps():
    """把子进程的性能探测结果缓存过来 —— /health 要用，不能每次现问。"""
    h = _worker_health()
    if not h:
        _WORKER["ready"] = False
        return False
    caps = h.get("caps") or {}
    _WORKER["caps"] = {"torch": bool(caps.get("torch")), "cuda": bool(caps.get("cuda"))}
    _WORKER["device"] = h.get("device") or ""
    _WORKER["vram"] = h.get("vramGB")
    _WORKER["ready"] = True
    _WORKER["err"] = ""
    return True


def _spawn_worker():
    """拉起子进程。已经在跑就直接返回（别的副本占了端口也算跑着）。"""
    import subprocess
    with _WORKER["lock"]:
        if _refresh_worker_caps():
            return True
        p = _WORKER.get("proc")
        if p is not None and p.poll() is None:
            return False                    # 自己拉的那个还活着，只是还没准备好
        # ⚠ 诊断：子进程如果退了，要知道【怎么退的】。
        #   0xC0000005/3221225477 = 访问违例(段错误)，别的数字是另一回事。
        if p is not None:
            rc = p.poll()
            print("[引擎] [!] 上一次的子进程已经不在了，退出码 %s%s"
                  % (rc, "（访问违例/段错误）" if rc in (3221225477, -1073741819) else ""))
        script = worker_script()
        if not os.path.isfile(script):
            _WORKER["err"] = "找不到子进程脚本：%s" % script
            return False
        cmd = [sys.executable, "-X", "utf8", script,
               "--port", str(worker_port()),
               "--models", models_dir(),
               "--parent-port", str(PORT)]
        try:
            # ⚠ 不设 CREATE_NO_WINDOW：子进程的日志要跟主进程进同一个文件，
            #   不然出问题的时候两边日志对不上（这个项目的头号故障是静默失效，
            #   日志是唯一能对账的东西）。
            # ⚠⚠ 注入身份标记：子进程里 _needs_torch 看到它就【不转发】，
            #   否则子进程会去拉"子进程的子进程"，无限套娃。
            env = dict(os.environ)
            env["WHEELCHAIR_TORCH_WORKER"] = "1"
            _WORKER["proc"] = subprocess.Popen(
                cmd, cwd=os.path.dirname(os.path.abspath(__file__)), env=env)
            _WORKER["err"] = ""
            return True
        except Exception as e:
            _WORKER["err"] = "子进程拉不起来：%s" % e
            return False


def ensure_worker(timeout=90):
    """确保子进程可用。第一次要 import torch，实测 3~5 秒，给足时间。"""
    if _refresh_worker_caps():
        return True
    _spawn_worker()
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.5)
        if _refresh_worker_caps():
            print("[引擎] PyTorch 子进程就绪 | 设备 %s" % (_WORKER["device"] or "?"))
            return True
    _WORKER["err"] = _WORKER["err"] or "子进程 %ds 内没起来" % timeout
    print("[引擎] [!] PyTorch 子进程没起来：%s" % _WORKER["err"])
    return False


def _torch_worker_state_text():
    if _WORKER["ready"]:
        return "子进程就绪（%s）" % (_WORKER["device"] or "?")
    return "子进程没跑（第一次用到时自动拉起）"


def _boot_worker():
    """开机后台把子进程拉起来。放后台是为了不拖慢引擎启动。"""
    try:
        ensure_worker()
    except Exception as e:
        print("[引擎] [!] 子进程启动异常：%s" % e)


def _is_torch_model(model_key):
    m = MODELS.get(model_key) or {}
    return m.get("runtime") == "torch"


def _pick_default_model(kind, inst=None):
    """没指定模型时，挑这一类里当前能跑的最高档（跟各路由里那段逻辑一致）。"""
    inst = inst if inst is not None else scan_models()
    t = max_tier_by_kind(kind, inst)
    for k, mm in MODELS.items():
        if mm.get("enabled") is not False and mm["kind"] == kind and mm["tier"] == t:
            return k
    return ""


_EYEGAZE_MOD = None


def _eyegaze():
    """按文件路径加载 engine/eyegaze/service.py（同 tween 的做法：不靠「脚本目录在不在 sys.path」，-I 启动也能找到）。"""
    global _EYEGAZE_MOD
    if _EYEGAZE_MOD is None:
        import importlib.util
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eyegaze")
        spec = importlib.util.spec_from_file_location("v7_eyegaze_service", os.path.join(here, "service.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _EYEGAZE_MOD = mod
    return _EYEGAZE_MOD


def _eyegaze_status():
    try:
        ok, why = _eyegaze().available()
        return {"ok": ok, "error": why}
    except Exception as e:
        return {"ok": False, "error": "眼神调整模块加载失败：%s" % e}


def _needs_torch(path, q):
    """这条请求要不要交给子进程。判据是【这次实际会用的那个模型的运行时】。

    ⚠ 不能按路径一刀切：/segment 既能跑 ONNX 的 SCHP/SegFormer，
      也能跑 torch 的 Sapiens。按路径切会把 ONNX 那条也赶去子进程，
      白白丢掉显卡加速（子进程是不碰 DirectML 的）。
    """
    # ⚠⚠ 子进程自己【绝不转发】—— 转发就会去拉"子进程的子进程"，无限套娃。
    #   靠环境变量认身份（子进程由 _spawn_worker 拉起时注入），
    #   这样同一份代码在两种进程里都跑得对，不用维护两份。
    if os.environ.get("WHEELCHAIR_TORCH_WORKER") == "1":
        return False
    if path in ("/matte", "/sam3", "/tween"):
        return True                      # 这三条登记的模型全是 torch
    if path in ("/segment", "/matting"):
        model = (q.get("model") or [""])[0]
        if not model:
            model = _pick_default_model("segment" if path == "/segment" else "matting")
        return _is_torch_model(model)
    return False


def _proxy_to_worker(path, query, raw, in_headers):
    """把当前请求原样转给子进程，再把它的响应原样回给客户。

    ⚠ 请求头要透传：X-Params / X-Matting-Params（参数）、X-Head-Len（两张图的分界）。
    ⚠ 响应头也要透传：X-Matting-Info / X-Matte-Info 里装着 applied 那串诊断信息，
      不透传的话面板读不到"参数到底生效没" —— 2026-09-15 那个静默失效会复发。
    """
    if not ensure_worker():
        return None
    hdrs = {}
    for name in ("X-Params", "X-Matting-Params", "X-Head-Len", "Content-Type", "X-Cloud-Req"):
        v = in_headers.get(name)
        if v:
            hdrs[name] = v
    hdrs["Content-Type"] = hdrs.get("Content-Type") or "application/octet-stream"
    hdrs["Content-Length"] = str(len(raw or b""))
    full = path + (("?" + query) if query else "")
    return _worker_http(full, method="POST", body=raw or b"", headers=hdrs, timeout=1800)


class Handler(BaseHTTPRequestHandler):
    def send_response(self, code, message=None):
        self._timing_status = code       # 计时日志用（_timing_end）
        BaseHTTPRequestHandler.send_response(self, code, message)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        # ⚠⚠⚠ 2026-10-11 审计修（现场：tmp/engine-logs/matting-startup.log 被刷到 1.37 GB）：
        #   客户端【提前断开】时（探活超时、界面切走、进程退出），wfile.write 会抛
        #   ConnectionAbortedError / BrokenPipeError（WinError 10053 / 10054）。
        #   那是【正常现象】，不是引擎的错 —— 可原来它没被接住，
        #   于是每次断开都由 socketserver 打一整份堆栈（而且 stderr 同时被
        #   重定向到同一个文件 ⇒ 同一份堆栈打【两遍】）。
        #   实测后果：一个活着的引擎能把启动日志刷到 1.37 GB / 上百万行，
        #     把真正有用的启动信息（设备、模型、档位）淹掉，
        #     也让"用户发日志给我看"这条路彻底失效（文件打不开）。
        #   ⇒ 断开就当没这回事：静默 return。
        #     其余 OSError（比如真的写失败）仍然让它冒出去 —— 那些要看见。
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return

    def log_message(self, *args):
        pass

    def do_OPTIONS(self):
        # ⚠⚠ 2026-10-03 晚：这里原来只回 {"ok":true}，_send 只带了 Allow-Origin，
        #   于是【带自定义头的 POST 全部过不了浏览器预检】—— 表现是 fetch 抛
        #   TypeError、界面显示 "Failed to fetch"（用户 20:49 实测那张报错卡）。
        #   触发者正是 /tween：它用 Content-Type: application/octet-stream +
        #   自定义头 X-Head-Len，属于【非简单请求】，浏览器必先发 OPTIONS 预检。
        #   而 /matting /segment /sam2 用 image/png，本轮没被卡住 —— 但同样是自定义头，
        #   一并补齐，别只修看得见的那一条（铁律 17：改一处要想到同类处）。
        #
        #   做法：把浏览器在预检里【点名的】方法和头发回去（回显最省事也最不容易漏），
        #   拿不到就退回一套够用的兜底。Max-Age 让浏览器缓存预检结果 10 分钟，
        #   省掉每次滚轮的往返（预检一次几百毫秒，滚起来会卡）。
        if _access_denied(self):
            return
        want_methods = self.headers.get("Access-Control-Request-Method") or "POST, GET, OPTIONS"
        want_headers = self.headers.get("Access-Control-Request-Headers") or "content-type, x-head-len, x-params, x-matting-params"
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", want_methods)
        self.send_header("Access-Control-Allow-Headers", want_headers)
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, rel):

        """
        提供项目里的静态文件（只读、只限项目目录内）。
        ⚠ 整段照抄 match_server.py 的同名函数（那边 2026-09-11 起就在用，已验过）。

        ⚠ 为什么引擎要兼职当文件服务器：
          测试页 tools/seg-test.html 如果用 file:// 双击打开，
          浏览器【禁止 file:// 页面访问 http://】—— 不管服务器怎么放行都会被拦，
          表现就是"引擎不可用：Failed to fetch"（2026-09-11 用户在校色测试页上实测撞到）。
          从这里发出去就同源了，一个 CORS 问题都没有
          （连 X-Params 那个自定义头都不会触发预检）。
          而且页面里的相对路径(../ui-pure/xxx.js)天然也能解析对。

        ⚠ 这条路由【只读文件、不碰模型、不碰推理】，
          加它不会改变三条业务路由的任何行为。
        """
        path = _safe_static_file(rel)
        if not path:
            self._send(404, {"ok": False, "error": "Not found"})
            return
        ctype = ("text/html; charset=utf-8" if path.endswith(".html")
                 else "application/javascript; charset=utf-8" if path.endswith(".js")
                 else "text/css; charset=utf-8" if path.endswith(".css")
                 else "image/png" if path.endswith(".png")
                 else "image/jpeg" if (path.endswith(".jpg") or path.endswith(".jpeg"))
                 else "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")   # 改完刷新就生效，不用清缓存
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if _access_denied(self):
            return
        path = self.path.split("?")[0]
        # ── 测试台（只在开发时用，主链路不走这里）──
        if path in ("/", "/test"):
            self._send_file("tools/seg-test.html")
            return
        if path.startswith("/tools/") or path.startswith("/ui-pure/"):
            self._send_file(path)
            return
        if path == "/health":
            inst = scan_models()
            self._send(200, {
                "ok": True,
                "version": VERSION,
                "engine": "matting",
                "script": os.path.realpath(__file__),
                "pid": os.getpid(),
                "launchId": os.environ.get("WHEELCHAIR_ENGINE_LAUNCH_ID", ""),
                "tiers": {
                    "matting": max_tier_by_kind("matting", inst),
                    "segment": max_tier_by_kind("segment", inst),
                    "sam2": max_tier_by_kind("sam2-enc", inst),
                    # ⚠ 新键要往后加，别改老键 —— 前端调度层读的是键名，
                    #   老版面板读不到 sam3 时会当成 0（"没这个能力"），不会崩。
                    "sam3": max_tier_by_kind("sam3", inst),
                    "matte": max_tier_by_kind("matte", inst),
                    # ⭐ 2026-10-04 过渡帧。照上面的规矩往后加新键。
                    #   ⚠ 它跟 sam3 / matte 一样只有一个模型，所以永远是 0 或 1 ——
                    #     判"有没有"看的是在不在，不是 `< 3`（engines-core 的 installedMap 里同理）。
                    #   ⚠ 键名是中性词，别改回能反推算法的说法（见 MODELS 表那段注释）。
                    "tween": max_tier_by_kind("tween", inst),
                },
                "device": device_name(),
                "vramGB": vram_gb(),
                "caps": CAPS,
                "modelsDir": models_dir(),
                "models": inst,
                "loaded": list(_SESS.keys()),
                # ⭐ 2026-10-15：空闲多久了（界面"空闲 10 分钟自动关"靠它）。正在干活时为 0。
                "idleSeconds": _idle_seconds(),
                "inflight": _WORK["inflight"],
                "provider": _PICKED["provider"],
                "providerWhy": _PICKED["why"],
                # ⭐ 2026-10-04 方案 B：PyTorch 子进程的状态（docs/133）。
                #   面板靠 torchWorker.ready 判"过渡帧/人体解析(Meta) 到底能不能用"。
                # ⭐ 10-25 眼神调整：能不能用（只查装没装、模型在不在，不 import —— 体检要快）
                "eyegaze": _eyegaze_status(),
                "torchWorker": {
                    "port": worker_port(),
                    "ready": bool(_WORKER["ready"]),
                    "device": _WORKER["device"],
                    "vramGB": _WORKER["vram"],
                    "caps": _WORKER["caps"],
                    "error": _WORKER["err"],
                },
            })
            return
        if path == "/models":
            deep = parse_qs(urlparse(self.path).query).get("deep") == ["1"]
            inst = scan_models(deep=deep)
            self._send(200, {"ok": True, "modelsDir": models_dir(), "models": inst})
            return
        if path == "/unload":
            unload()
            # ⚠ 子进程的显存也要还（它可能正抱着人体解析/过渡帧不放）。
            #   不转发的话"卸载"只卸了一半，用户看到显存没降。
            _worker_http("/unload", timeout=10)
            _WORKER["ready"] = False
            self._send(200, {"ok": True, "loaded": []})
            return
        if path == "/shutdown":
            # ⭐⭐ 2026-10-10 加：让软件能【正常】关掉引擎（顺带把显存还掉）。
            #
            # ⚠⚠ 为什么要口令：这个口在本机 127.0.0.1 上，**任何本机程序都能请求它**。
            #   没口令的话，随便一个脚本、甚至网页里的一段 fetch（配合 DNS rebinding）
            #   就能把用户的引擎踢掉 —— 那是拒绝服务。
            #   ⚠ 口令由软件启动引擎时随机生成、走环境变量传进来（不落盘、不进日志）。
            #   ⚠ 没配口令时【拒绝关闭】而不是放行：宁可用 .kill() 兜底，
            #     也不留一个"谁都能关"的口子。
            supplied = str(self.headers.get("X-Engine-Token") or "")
            if not _SHUTDOWN_TOKEN or supplied != _SHUTDOWN_TOKEN:
                self._send(403, {"ok": False, "error": "关闭口令不对或服务端没配口令"})
                return
            print("[引擎] 收到正常关闭请求，退出并放掉显存")
            _SHUTDOWN["requested"] = True
            self._send(200, {"ok": True, "shuttingDown": True, "pid": os.getpid()})
            # ⚠ 先回包再退出：反过来的话，软件那边会看到"连接被重置"，
            #   分不清是"关成功了"还是"引擎崩了"。
            threading.Thread(target=_delayed_exit, daemon=True, name="shutdown").start()
            return
        self._send(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        # ⭐ 2026-10-15（用户定：空闲 10 分钟就关引擎）：每个干活的请求都记"开始/结束"，
        #   /health 报 idleSeconds（正在干活时为 0），界面据此判断该不该关。
        #   ⚠ 只记 POST（所有算图都是 POST）；界面定时探活的 GET /health 不算干活。
        if _access_denied(self):
            return
        _work_begin()
        _t = _timing_begin()
        try:
            return self._do_post_work()
        finally:
            _work_end()
            _timing_end(self, _t, "子进程" if os.environ.get("WHEELCHAIR_TORCH_WORKER") == "1" else "引擎")

    def _do_post_work(self):
        path = self.path.split("?")[0]
        # ⚠ 三条路由都走同一套"图片走 body / 参数走 query+header"的约定
        raw = _read_limited_body(self)
        if raw is None:
            return
        if not raw:
            self._send(400, {"ok": False, "error": "没收到图片数据"})
            return

        # 参数走 query 和 header（复用 matting_server.py 那套约定）
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        model = (q.get("model") or [""])[0]

        # 参数走 header 的 JSON
        #
        # ⚠⚠ 两个头名都要认，别只认一个（2026-09-15 实测挖出来的静默失效）：
        #   老引擎 matting_server.py:910 读的是 X-Matting-Params，
        #   面板的抠像 ui.html:6155 到今天还在发这个名字（分割/指哪抠哪发的是 X-Params）。
        #   这里原来只读 X-Params → 面板抠像的参数【一个都没送到】，
        #   引擎全程用默认值，applied 里只有 refine，而且一句错都不报 ——
        #   表现就是"面板上那 6 个滑块拉了没反应"。
        #   实测证据：同一张图同一组参数
        #     X-Params        → applied=['refine','remap','shrink','despeckle','feather']
        #     X-Matting-Params→ applied=['refine']
        #   修法取"两个都认"而不是"改面板"：面板一个字不用动，
        #   万一要退回老引擎那条路也照样能用（docs/49 2.2 留的那条退路）。
        params = None
        try:
            hp = self.headers.get("X-Params") or self.headers.get("X-Matting-Params")
            if hp:
                params = json.loads(unquote(hp))
        except Exception:
            params = None

        # ── 方案 B 分流：这次要用的模型是 PyTorch 的，就整条转给子进程 ──
        #
        # ⚠⚠ 主进程【一个 torch 张量都不许建】。实测（docs/133）：
        #   主进程建过 DirectML 会话之后，再往显卡上放张量 = 段错误，整个引擎没。
        #   所以这几条路由在主进程里【永远是转发】，不许"就近自己算"。
        # ⚠ 判据是"这次实际用的那个模型的运行时"，不是路径 ——
        #   /segment 既能跑 ONNX 也能跑 torch，按路径一刀切会白丢显卡加速。
        if _needs_torch(path, q):
            query = urlparse(self.path).query
            got = _proxy_to_worker(path, query, raw, self.headers)
            if got is None:
                self._send(503, {
                    "ok": False,
                    "error": ("这个功能要 PyTorch 子进程，但子进程没起来。"
                              + (_WORKER["err"] or "第一次用会自动拉起，稍等几秒再试一次。")),
                    "code": "WORKER_UNAVAILABLE",
                })
                return
            st, hs, data = got
            self.send_response(st)
            ctype = hs.get("content-type") or "application/octet-stream"
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            # ⚠ 这两个诊断头必须透传：面板靠它说"参数生效了哪几项"。
            #   不透传的话面板读不到 → 表现成"滑块拉了没反应"，查都查不出来。
            expose = []
            for hname, cname in (("x-matting-info", "X-Matting-Info"),
                                 ("x-matte-info", "X-Matte-Info")):
                if hname in hs:
                    self.send_header(cname, hs[hname])
                    expose.append(cname)
            if expose:
                self.send_header("Access-Control-Expose-Headers", ", ".join(expose))
            self.end_headers()
            self.wfile.write(data)
            return

        # ⭐ 10-25 眼神调整（眼珠随动，docs/290）：一张人像 → 每只眼一组图层，界面拿去实时叠图。
        #   纯 CPU（MediaPipe 关键点 + OpenCV），不碰显卡、不走子进程。代码在 engine/eyegaze/。
        #   ⚠ mediapipe 是额外依赖：没装的机器回 503 + 人话，引擎别的功能不受影响。
        if path == "/eyegaze/prepare":
            try:
                eyegaze_service = _eyegaze()
            except Exception as e:
                traceback.print_exc()
                self._send(503, {"ok": False, "error": "眼神调整模块加载失败：%s" % e, "code": "EYEGAZE_UNAVAILABLE"})
                return
            # 1.9.21 起：界面传来 landmarks 时不再要求 mediapipe（界面已跑网页版 MediaPipe）
            landmarks_raw = (q.get("landmarks") or [""])[0] or self.headers.get("X-Landmarks", "")
            has_landmarks = bool(landmarks_raw.strip())
            ok, why = eyegaze_service.available(has_landmarks=has_landmarks)
            if not ok:
                self._send(503, {"ok": False, "error": why, "code": "EYEGAZE_UNAVAILABLE"})
                return
            try:
                up = float((q.get("up") or ["1"])[0])
                ov = eyegaze_service.parse_overrides((q.get("ov") or [""])[0])
                landmarks = json.loads(landmarks_raw) if has_landmarks else None
            except (ValueError, TypeError) as e:
                self._send(400, {"ok": False, "error": "参数不对：%s" % e})
                return
            try:
                result = eyegaze_service.prepare(raw, up, ov, landmarks=landmarks)
            except eyegaze_service.EyeGazeError as e:
                self._send(422, {"ok": False, "error": str(e), "code": e.code})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self._send(200, result)
            return

        if path == "/matting":
            # 解析 out 参数
            out_mode = (q.get("out") or ["rgba"])[0]
            # 没指定模型 → 用当前能跑的最高档
            if not model:
                inst = scan_models()
                t = max_tier_by_kind("matting", inst)
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["kind"] == "matting" and mm["tier"] == t:
                        model = k
                        break
            if not model:
                self._send(400, {"ok": False, "error": "还没有可用的抠像模型"})
                return
            try:
                png, info = run_matting(raw, model, params, out_mode)
            except MattingEmpty as e:
                self._send(422, {"ok": False, "error": str(e), "code": MattingEmpty.code})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("X-Matting-Info", quote(json.dumps(info, ensure_ascii=False)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "X-Matting-Info")
            self.end_headers()
            self.wfile.write(png)
            return

        if path == "/segment":
            if not model:
                inst = scan_models()
                t = max_tier_by_kind("segment", inst)
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["kind"] == "segment" and mm["tier"] == t:
                        model = k
                        break
            if not model:
                self._send(400, {"ok": False, "error": "还没有可用的分割模型"})
                return
            try:
                result_json, info = run_segment(raw, model, params)
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(result_json)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(result_json)
            return

        if path == "/tween":
            # 过渡帧：给两张图，算出一串中间帧。
            #
            # 请求约定（对着 /matting 那套，图片走 body、参数走 query + header）：
            #   body    : 两张图的字节【首尾相接】= img_a + img_b
            #   header  : X-Head-Len = 前一张的字节数（没有就当成只有一张，两端相同）
            #   query   : steps 中间帧数（默认 16）、raw=1 时不返回 PNG 预览
            #
            # 返回：NDJSON，每行一个 JSON。第一行是元信息，之后每行一帧。
            #   {"ok":true,"width":..,"height":..,"count":N,"steps":..,"batch":..,"ms":{..}}
            #   {"i":0,"b64":"..."}   逐行回，前端拿一行画一行（不用等全部算完）
            #
            # ⚠ 为什么不用 multipart：那要多引一个解析器；这里两张图是纯二进制，
            #   给个长度就够了。
            # ⚠ 为什么不用一次性大 JSON：18 张 1024² 的 PNG 打包成一个大字符串，
            #   JS 那边 UTF-16 会翻倍（docs/124 铁律 15 的同类坑）。NDJSON 一行一张，峰值低。
            if not CAPS.get("torch"):
                self._send(503, {"ok": False, "error": "过渡帧要 PyTorch，这台机器没装（装完重启引擎就能用）"})
                return
            try:
                steps = int((q.get("steps") or ["16"])[0])
            except ValueError:
                self._send(400, {"ok": False, "error": "steps 要是整数"})
                return
            if steps < 1 or steps > 64:
                self._send(400, {"ok": False, "error": "中间帧数量要在 1 到 64 之间"})
                return
            # ⭐ 2026-10-18 云端外挂（docs/237，用户选「滚轮预览传压缩图、点应用再要一张无损的」）：
            #   fmt=jpg  → 每帧编成 JPEG（质量 92，只给滚轮预览看；1K 一组从 54 MB 降到约 6 MB）
            #   only=N   → 只回第 N 帧、PNG 无损（「应用」/ 传回 PS 用 —— 进 PS 的必须是无损图）
            #   都不带 = 老行为（每帧 PNG），本机软件一个字节不变。
            fmt = ((q.get("fmt") or ["png"])[0] or "png").lower()
            if fmt not in ("png", "jpg"):
                self._send(400, {"ok": False, "error": "fmt 只能是 png 或 jpg"})
                return
            only = None
            if (q.get("only") or [""])[0] != "":
                try:
                    only = int((q.get("only") or ["0"])[0])
                except ValueError:
                    self._send(400, {"ok": False, "error": "only 要是整数"})
                    return
                if only < 0 or only > steps + 1:
                    self._send(400, {"ok": False, "error": "only 超出帧的范围（0 到 %d）" % (steps + 1)})
                    return

            try:
                head_len = int((self.headers.get("X-Head-Len") or "0").strip() or "0")
            except ValueError:
                head_len = 0

            splitted = bool(head_len) and 0 < head_len < len(raw)
            if splitted:
                raw_a, raw_b = raw[:head_len], raw[head_len:]
            else:
                # 只给了一张：两端用同一张（等于"没有改动"）。界面拿它当预热/自检用。
                raw_a = raw_b = raw

            try:
                import numpy as _np
                im_a = Image.open(io.BytesIO(raw_a))
                im_b = Image.open(io.BytesIO(raw_b))
                # ⚠⚠ 2026-10-03 晚【第三颗雷，最根上的一个】。
                #   这里原来是一句 `raise ValueError("两张图尺寸必须一致")` ——
                #   而现实里这两张图【天生就不一样大】：
                #     原图 = PS 选区抓来的（用户那次是 1055×963）
                #     成品 = 生图模型回来的（2174×1984）
                #   比例一样（差 0.02%，就是四舍五入的零头）、分辨率差 4.2 倍。
                #   ⇒ 那句 raise 把【所有人】都挡在门外，不是偶发。
                #   改法：照抄校色引擎那条路（match_server.py:1234）——尺寸不一样就对齐了再跑。
                #   对齐到【小的那张、只缩不放】（理由写在 align_pair_for_tween 里）。
                im_a, im_b, dev = align_pair_for_tween(im_a, im_b)
                arr_a = _np.asarray(im_a.convert("RGB"))
                arr_b = _np.asarray(im_b.convert("RGB"))

                # ⚠ 模块按文件路径延迟导入：这个文件挂在引擎旁边，
                #   不是包，直接 import tween.flow_runner 在安装版里会找不到。
                sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tween"))
                import flow_runner as _fr

                # ⚠⚠⚠ 2026-10-08（docs/170 §13.1 R1）：**显式传 dtype**，不靠默认值。
                #   默认值是"看不见的契约"：改一处忘一处就是静默失效。
                #   精度按设备定（cuda→float16 / cpu→float32）——
                #   写死 float16 会让没显卡的机器在 CPU 上跑到【段错误】，整进程崩。
                #   ⚠ 另：显存不够时也该走 CPU（R2 第 3 条），force_cpu 由这里决定。
                _dev = _fr._device()
                _want_cpu = (str(_dev) != "cuda")
                res = _fr.tween(arr_a, arr_b, steps=steps, models_dir=models_dir(),
                                want_png=(fmt == "png" and only is None and not (q.get("raw") or [""])[0] == "1"),
                                dtype=_fr.default_dtype(_dev), force_cpu=_want_cpu,
                                # ⭐ 2026-10-19（docs/249）：「应用」只要一帧 —— 只算包含它的那一批（结果逐字节一样）
                                only=only)
            except ValueError as e:
                self._send(400, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return

            pngs = res["pngs"]
            frames = res["frames"]
            count = len(frames)
            # ⭐ 2026-10-19（docs/249）：bin=1 → 二进制回包（不转 base64，回传小约 25%，软件也省掉逐字节解码）。
            #   格式：[4 字节大端 头长度][头 JSON（跟老的第一行一样）]，然后每帧 [4 字节大端 帧号][4 字节大端 长度][图片字节]。
            #   不带 bin = 老的 NDJSON：每帧那几行逐字节不变；头那一行的 ms 里多一个 encode 用时（老软件不看这个字段）。
            want_bin = (q.get("bin") or [""])[0] == "1"

            def _encode(frame, kind):
                buf = io.BytesIO()
                if kind == "jpg":
                    Image.fromarray(frame, mode="RGB").save(buf, format="JPEG", quality=92)
                else:
                    Image.fromarray(frame, mode="RGB").save(buf, format="PNG", compress_level=1)
                return buf.getvalue()
            # ⚠⚠ 2026-10-04 栽过（docs/133）：这里原来用 Transfer-Encoding: chunked
            #   一行一行往外发，结果客户端一上来就 ConnectionReset。
            #   真因：这个 Handler 没设 protocol_version，默认是 HTTP/1.0，
            #   **1.0 不支持分块传输** —— 头发出去了，body 那边客户端根本不会按块解，
            #   直接当成"响应非法"把连接掐了。而且服务端一句错都不打，纯静默。
            #   改法：先全部拼好，带 Content-Length 一次发（1.0 的原生做法）。
            #   代价：前端要等全部算完才看到第一帧（1024² 约 0.4s，可接受）。
            #   ⚠ 将来若要改成"算一帧发一帧"，必须同时把 Handler 的 protocol_version
            #     升到 HTTP/1.1 —— 两件事必须一起做，只做一半就是这次这个坑。
            head_obj = {
                "ok": True, "width": res["width"], "height": res["height"],
                "count": count, "steps": steps, "batch": res["batch"], "ms": res["ms"],
                # ⭐ 两张原图的比例偏差（1.0 = 完全一致）。上面 align_pair_for_tween 填的。
                #   界面拿它决定要不要提一句"这张图的比例跟原图差得多，预览只能看个大概"。
                #   ⚠ 引擎【不因为】它拦请求 —— 拦住就是又一张死卡（用户明确反对）。
                "aspectOff": round(float(dev), 4),
                # ⭐ 2026-10-18：帧是什么格式（老客户端不看这两个字段，照旧当 PNG）
                "mime": "image/jpeg" if (fmt == "jpg" and only is None) else "image/png",
                "lossy": bool(fmt == "jpg" and only is None),
                "only": only,
            }
            # ⭐ 2026-10-19（docs/249）：要回的帧【并行编码】。PIL 编码时会放开 GIL，4 个线程一起编；
            #   每帧还是同一个编码器、同样的参数 ⇒ 字节跟一张张编完全一样，只是快。顺序按帧号排好再发。
            want_idx = [i for i in range(count) if (only is None or i == only)]

            def _payload(i):
                if only is not None:
                    return _encode(frames[i], "png")
                if fmt == "jpg":
                    return _encode(frames[i], "jpg")
                if pngs is not None:
                    return pngs[i]
                return None

            t_enc = time.time()
            from concurrent.futures import ThreadPoolExecutor as _TPE
            with _TPE(max_workers=max(1, min(4, len(want_idx)))) as _pool:
                encoded = list(_pool.map(_payload, want_idx))
            head_obj["ms"] = dict(head_obj["ms"], encode=round((time.time() - t_enc) * 1000))
            if _TIMING:
                print("[计时] 调强度细分 号=%s %dx%d 帧数 %d | %s" % (self.headers.get("X-Cloud-Req") or "-", res["width"], res["height"], count, head_obj["ms"]), flush=True)
            if want_bin:
                import struct as _struct
                head_bytes = json.dumps(head_obj, ensure_ascii=False).encode("utf-8")
                parts = [_struct.pack(">I", len(head_bytes)), head_bytes]
                for i, blob in zip(want_idx, encoded):
                    if blob is None:
                        blob = _np.ascontiguousarray(frames[i]).tobytes()
                    parts.append(_struct.pack(">II", i, len(blob)))
                    parts.append(blob)
                payload = b"".join(parts)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)
                return
            lines = [json.dumps(head_obj, ensure_ascii=False)]
            for i, blob in zip(want_idx, encoded):
                item = {"i": i}
                if blob is not None:
                    item["b64"] = base64.b64encode(blob).decode("ascii")
                else:
                    item["raw"] = base64.b64encode(
                        _np.ascontiguousarray(frames[i]).tobytes()).decode("ascii")
                lines.append(json.dumps(item))
            payload = ("\n".join(lines) + "\n").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
            return

        if path == "/matte":
            if not model:
                inst = scan_models()
                t = max_tier_by_kind("matte", inst)
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["kind"] == "matte" and mm["tier"] == t:
                        model = k
                        break
            if not model:
                self._send(400, {"ok": False, "error": "还没有可用的细边模型（ViTMatte）"})
                return
            try:
                png, info = run_matte(raw, model, params)
            except ValueError as e:
                self._send(400, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("X-Matte-Info", quote(json.dumps(info, ensure_ascii=False)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "X-Matte-Info")
            self.end_headers()
            self.wfile.write(png)
            return

        if path == "/sam3":
            if not model:
                inst = scan_models()
                t = max_tier_by_kind("sam3", inst)
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["kind"] == "sam3" and mm["tier"] == t:
                        model = k
                        break
            if not model:
                self._send(400, {"ok": False, "error": "还没有可用的文字选区模型（SAM 3）"})
                return
            try:
                result_json, info = run_sam3(raw, model, params)
            except ValueError as e:
                # 没给词 / 模型名不对 —— 这是用户那边的问题，不是引擎炸了
                self._send(400, {"ok": False, "error": str(e)})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(result_json)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(result_json)
            return

        if path == "/sam2":
            if not model:
                inst = scan_models()
                t = max_tier_by_kind("sam2-enc", inst)
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["kind"] == "sam2-enc" and mm["tier"] == t:
                        model = k
                        break
            if not model:
                self._send(400, {"ok": False, "error": "还没有可用的 SAM2 模型"})
                return
            try:
                result_json, info = run_sam2(raw, model, params)
            except MattingEmpty as e:
                self._send(422, {"ok": False, "error": str(e), "code": MattingEmpty.code})
                return
            except Exception as e:
                traceback.print_exc()
                msg, code = engine_error_reply(e, raw)   # 显存不够单独说（10-25 docs/286 B7）
                self._send(500, {"ok": False, "error": msg, **({"code": code} if code else {})})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(result_json)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(result_json)
            return

        self._send(404, {"ok": False, "error": "Not found"})


def main():
    _setup_stdio()
    _probe_hardware()
    d = models_dir()
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    inst = scan_models()

    # ⚠ 启动自检要【一眼看出能不能用】，不能只说"已启动"（铁律 17 同类）。
    okn = sum(1 for v in inst.values() if v["state"] == "ok")
    badn = sum(1 for v in inst.values() if v["state"] == "broken")
    miss = [v["name"] for v in inst.values() if v["state"] == "missing"]
    print("[引擎] 多功能图像引擎 %s | 127.0.0.1:%d" % (VERSION, PORT))
    print("[引擎] 依赖: " + " ".join(("%s=%s" % (k, "有" if v else "无")) for k, v in CAPS.items()))
    print("[引擎] 算力: %s%s" % (_PICKED["provider"] or "?",
                                ("  (" + _PICKED["why"] + ")") if _PICKED["why"] else ""))
    print("[引擎] 设备: %s%s" % (device_name(), (" %.1fG" % vram_gb()) if vram_gb() else ""))
    print("[引擎] 模型目录: %s" % d)
    print("[引擎] 模型: 可用 %d / 损坏 %d / 未安装 %d%s"
          % (okn, badn, len(miss), ("（" + "、".join(miss) + "）") if miss else ""))
    for kind, label in (("matting", "抠像"), ("segment", "人体解析"),
                        ("sam2-enc", "指哪抠哪"), ("sam3", "文字选区"),
                        ("matte", "细边")):
        tier = max_tier_by_kind(kind, inst)
        if tier == 0:
            print("[引擎] [!] %s 档位 0 - 用不了" % label)
        else:
            print("[引擎] %s 档位 %d" % (label, tier))
    # ⚠ 算力回落到 CPU 要明着喊 —— 它不是错误，但慢几十倍，
    #   不说的话用户只会觉得"这软件好卡"，永远查不到原因。
    if (_PICKED["provider"] or "CPUExecutionProvider") == "CPUExecutionProvider":
        print("[引擎] [!] 现在跑在 CPU 上，会比显卡慢很多。原因: %s" % (_PICKED["why"] or "没实测到可用的显卡 provider"))

    # ⭐ 2026-10-04 方案 B：torch 那几样交给独立子进程（docs/133）
    print("[引擎] 过渡帧/人体解析(Meta)等 PyTorch 功能: %s" % _torch_worker_state_text())
    # ⚠ 后台拉起，不阻塞监听 —— 子进程要 import torch（3~5 秒），
    #   卡在这儿会让"引擎启动"变慢，主机那边有启动超时判断。
    threading.Thread(target=_boot_worker, daemon=True, name="worker-boot").start()

    # 启动空闲看门狗
    t = threading.Thread(target=_idle_watch, daemon=True)
    t.start()
    # ⭐ 2026-10-10：父进程监视（爹没了就自己走，别白占显存）
    if _PARENT_WATCH_PID > 0 and not _NO_PARENT_WATCH:
        threading.Thread(target=_parent_watch, daemon=True, name="parent-watch").start()
    else:
        print("[引擎] 父进程监视: 关（%s）"
              % ("--no-parent-watch" if _NO_PARENT_WATCH else "没传 WHEELCHAIR_ENGINE_PARENT_PID"))
    print("[引擎] 正常关闭接口: %s"
          % ("已启用（POST/GET /shutdown 带口令）" if _SHUTDOWN_TOKEN else "未启用（没配 WHEELCHAIR_ENGINE_TOKEN）"))
    # ⭐ 2026-10-10：子进程（torch_worker）也拉起来。
    #
    #   ⚠⚠ 原来是【完全懒加载】的：只有第一次用到 PyTorch 功能才起。
    #     后果：软件关了、引擎关了，但子进程是之前某次任务留下的 ——
    #     它不归引擎的启动流程管，也不在引擎的会话表里，
    #     于是"关引擎"关不掉它，"空闲卸载"也碰不到它。
    #     实测就是这么来的：主程序关了 42 小时，它还抱着 9.6GB 显存。
    #   ⇒ 引擎一起来就把子进程拉起。子进程本身不占显存（只是 import torch），
    #     模型还是用到才加载 —— 所以提前起它没有额外显存代价，
    #     但它从此有了明确的爹（父引擎一关它就跟着走）。
    #   ⚠ 失败不影响引擎本体：子进程起不来时，那几样 PyTorch 功能报"不可用"，
    #     其余 ONNX 功能照常（这是原来的行为，别改坏）。
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.block_on_close = False
    print("[引擎] 监听 http://127.0.0.1:%d  (探活 /health)" % PORT)
    # ⚠ 测试台必须从这个地址打开。双击 tools/seg_test.html 走的是 file:// 协议，
    #   浏览器会禁止它访问引擎，页面只会显示 "Failed to fetch"。
    print("[引擎] 测试台 http://127.0.0.1:%d/test   -- 要从这个地址打开, 别去双击 seg-test.html --" % PORT)
    if IDLE_EXIT_S > 0:
        threading.Thread(target=_idle_watchdog, daemon=True, name="idle-exit").start()
        print("[引擎] 空闲 %d 秒自动退出（放掉显存；软件下次用到会自动再拉起）" % IDLE_EXIT_S)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[引擎] 关闭")


def _setup_stdio():
    # ⚠⚠ Windows 终端默认 GBK，打印 ⚠ · 这类符号会直接抛 UnicodeEncodeError，
    #   而且是在【启动阶段】抛 —— 服务压根起不来、端口也不监听。
    #   两道保险：① 这里把 stdout 强制成 UTF-8 且打不出的字符就替换
    #            ② 下面的启动日志一律只用 ASCII 符号（| - [!]）
    # ⚠⚠ line_buffering=True 是 2026-09-14 深夜补的：输出重定向到文件时
    #   Python 默认整块缓冲，日志文件会【一直是空的】—— 上一轮就是看着空日志
    #   以为"服务器起不来"，其实它好好的，只是没把字吐出来。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


if __name__ == "__main__":
    main()
