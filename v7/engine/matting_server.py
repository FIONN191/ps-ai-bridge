#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抠像引擎（三档）· 修图轮椅 V8

这是【可选组件】。不装它，桌面板照常工作 —— 只是没有"一键抠图"这个功能。

⚠⚠ 和校色引擎有一处【根本不同】，改这个文件之前必须知道：
    校色引擎有【档 1 纯 JS 兜底】，没装引擎也能校色，所以可以静默降级。
    **抠图没有兜底** —— 没有模型 = 这件事就是做不了。
    所以按 docs/40 规矩 5：用户点了抠图但模型没装，
    **必须弹卡说清楚 + 给"去装"的入口**，不能静默什么都不发生。

────────────────────────────────────────────────────────────
 怎么启动
────────────────────────────────────────────────────────────
    python matting_server.py

    监听 127.0.0.1:37894，只接受本机连接。
    ⚠ 端口和校色引擎(37893)分开，是【两个独立进程】：
      抠图模型吃显存，崩了不该把校色一起拖下水；
      而且两边依赖不同（onnxruntime vs opencv），混在一起装不上的概率更大。

────────────────────────────────────────────────────────────
 三档模型（都是 MIT，可商用）
────────────────────────────────────────────────────────────
    档 1  BiRefNet_lite         小、快，边缘一般
    档 2  BiRefNet-matting      1024 推理，发丝不错
    档 3  BiRefNet_HR-matting   2048 推理，最锐利的发丝
                                ⚠ 显存峰值约 18G，16G 的机器跑不动 → 自动退档 2

    ⚠ 模型【不打进安装包】(用户 2026-09-14 定)：
      用户从网盘下到模型文件夹，在设置里点启用。
      理由：单个模型 400~500MB，全打进去会顶爆"安装包 1GB 以内"那条线，
      而服务器 2核2G 也发不了模型。

────────────────────────────────────────────────────────────
 依赖
────────────────────────────────────────────────────────────
    必需  : numpy + onnxruntime          → 能跑（CPU）
    推荐  : onnxruntime-gpu              → 快很多
    必需  : Pillow 或 opencv-python      → 图片编解码（有一个就行）

    ⚠ 少装哪层就少哪层能力，服务照样起得来。
      /health 如实报告当前能做什么，桌面板按它决定给不给用。
"""

import base64
import hashlib
import io
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import quote

PORT = 37894
VERSION = "1.0.0"

# ── 能力探测：装了什么就报什么 ──────────────────────────────
CAPS = {"numpy": False, "onnx": False, "onnx_gpu": False,
        "onnx_dml": False, "onnx_cuda": False, "pil": False, "cv2": False}

try:
    import numpy as np
    CAPS["numpy"] = True
except ImportError:
    np = None

try:
    import onnxruntime as ort
    CAPS["onnx"] = True
    # ⚠⚠ "在可用列表里" ≠ "真的能用"（2026-09-14 实测撞到，这是本文件最贵的一条）：
    #   onnxruntime-gpu 1.29 把 CUDAExecutionProvider 列在 get_available_providers() 里，
    #   但创建会话时因为 cublasLt64_13.dll 缺失【静默回落到 CPU】，一句警告都没有。
    #   （真因：ORT 1.29 要 CUDA 13，而机器上 torch 自带的是 CUDA 12.8，文件名都对不上）
    #   所以这里【只记录候选】，能不能用要等真正建会话时才知道 —— 见 _pick_provider()。
    try:
        _AVAIL = list(ort.get_available_providers())
    except Exception:
        _AVAIL = []
    CAPS["onnx_dml"] = "DmlExecutionProvider" in _AVAIL
    CAPS["onnx_cuda"] = "CUDAExecutionProvider" in _AVAIL
    CAPS["onnx_gpu"] = CAPS["onnx_dml"] or CAPS["onnx_cuda"]   # 兼容旧字段名
except ImportError:
    ort = None
    _AVAIL = []

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


# ═══════════════════════════════════════════════════════════
#  模型登记表
#
#  ⚠ 这张表是【唯一事实源】：界面上的模型库、校验、档位判断全读它。
#    加新模型只改这里 —— 别在别处再写一份清单（本项目栽过太多次了）。
#
#  ⚠ size 和 sha256 是给【完整性校验】用的。
#    "下了一半的模型比没有更糟" —— 加载时崩，而且报错完全看不出是文件坏了。
#    ⬜ 待填：等实际下载到文件之后把真实值补进来（现在填 None = 只查存在和大小下限）。
# ═══════════════════════════════════════════════════════════
MODELS = {
    "lite": {
        "tier": 1,
        "file": "BiRefNet_lite.onnx",
        "name": "轻量版",
        "desc": "小、快，边缘一般。低配机器也能跑",
        "input": 1024,
        "minBytes": 40 * 1024 * 1024,     # 下限保护：明显小于这个就是没下完
        "sha256": None,                    # ⬜ 待填
        "vramGB": 0,                       # CPU 也能跑
        "url": "",                         # ⬜ 待填：网盘链接
    },
    "std": {
        "tier": 2,
        "file": "BiRefNet-matting.onnx",
        "name": "标准版",
        "desc": "1024 推理，发丝不错。日常够用",
        "input": 1024,
        "minBytes": 300 * 1024 * 1024,
        "sha256": None,
        "vramGB": 6,
        "url": "",
    },
    # ⚠⚠ 档 3 目前【停用】(2026-09-14 实测后决定)。
    #
    #   原计划：BiRefNet_HR-matting，2048 训练，发丝最锐利 —— 那是个真档位。
    #   实际情况：官方只出了 .safetensors，没有 ONNX。下到的是【通用版的 fp32】，
    #            和档 2 是同一个模型、同样 1024 输入，只是精度不同。
    #
    #   实测（900×1200，DirectML，RTX 5090）：
    #     档2 fp16  推理  605ms
    #     档3 fp32  推理 8812ms     ← 慢 14 倍，输出几乎没差别
    #
    #   → 这是个【名不副实的档位】：用户选了"最高档"，多等 8 秒，什么也没多得到。
    #     正是 docs/40 规矩 2 说的那种静默失效（"报了个名头，实际没那个能力"）。
    #     所以宁可只有两档，也不留这个。
    #
    #   ⬜ 什么时候恢复：拿到真正的 HR 权重 ONNX（自己转要处理 deform_conv2d 算子），
    #      或者找到别的真有独占能力的模型。判据和 docs/33 第八节一样：
    #      要有"实际用下来不够好"的真实样本，不是凭想象堆档位。
    "hr": {
        "tier": 0,                          # ⚠ 0 = 不参与档位计算，扫描时也不显示
        "enabled": False,
        "file": "BiRefNet_HR-matting.onnx",
        "name": "高精版（暂不可用）",
        "desc": "fp32 全精度。实测比标准版慢 14 倍而效果几乎一样，暂时停用",
        # ⚠⚠ 输入尺寸是 1024，不是 2048（2026-09-14 实测：喂 2048 直接 INVALID_ARGUMENT）。
        #   我一开始按"HR 版 = 2048 训练"填了 2048，但【实际下到的不是 HR 版】——
        #   官方 BiRefNet_HR-matting 只出了 .safetensors 没有 ONNX，
        #   这里用的是通用版 BiRefNet 的 fp32，和标准版同一个模型、只是精度不同，
        #   所以输入尺寸也是固定 1024。
        #   ⭐ 教训：模型的输入尺寸要【从 ONNX 里读】，不能按模型名字或论文说法填。
        "input": 1024,
        "minBytes": 300 * 1024 * 1024,
        "sha256": None,
        # 同理显存也没那么夸张了（1024 输入，fp32 大约 2~3G 够用）
        "vramGB": 4,
        "url": "",
    },
}


# ═══════════════════════════════════════════════════════════
#  模型目录
#
#  ⚠ 跟 cache_root() 一个路数（docs/34 已经为开发机硬编码路径修过一轮）：
#    · 开发时  → 项目目录 engine/models/
#    · 打包后  → %LOCALAPPDATA%\修图轮椅\models\
#  用户也可以在设置里指定自己的目录（放 D 盘之类），走 --models 参数传进来。
# ═══════════════════════════════════════════════════════════
def default_models_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    # 打包后这个脚本在 resources/engine/ 下，旁边不该堆几百 MB 的模型
    local = os.environ.get("LOCALAPPDATA")
    if local and not os.path.isdir(os.path.join(here, "..", ".git")):
        return os.path.join(local, "修图轮椅", "models")
    return os.path.join(here, "models")


_MODELS_DIR = default_models_dir()
for _i, _a in enumerate(sys.argv):
    if _a == "--models" and _i + 1 < len(sys.argv):
        _MODELS_DIR = sys.argv[_i + 1]


def models_dir():
    return _MODELS_DIR


# ── 硬件探测：启动时跑一次，之后全走缓存 ────────────────────
# ⚠⚠ docs/33 第 8 个坑：/health 每次都去查显存，CUDA 首次初始化要好几秒，
#    探活只等 1.5 秒 → 每次都超时，表现成"端口在听但一直不回数据"。
#    所以硬件信息【只在启动时查一次】。探活是高频调用，里面绝不能放重活。
_HW = {"vram": 0, "device": "CPU", "ready": False}


def _probe_hardware():
    """启动时跑一次。⚠ 每一步都兜住异常 —— 查显卡失败不该让整个服务起不来。"""
    # ⚠ 先实测 provider。用【最小的那个模型】试 —— 它加载最快（109MB / 3.5 秒），
    #   用 928MB 的去试会让启动慢到离谱。
    if CAPS["onnx"]:
        try:
            small = None
            for k in ("lite", "std", "hr"):          # 按体积从小到大找一个存在的
                p = os.path.join(models_dir(), MODELS[k]["file"])
                if os.path.isfile(p):
                    small = p
                    break
            _pick_provider(small)
        except Exception:
            pass
    vram = 0
    dev = "CPU"
    # ⚠ 设备名必须反映【实测选中的那个 provider】，不能按"装了什么包"猜。
    #   否则又会出现"显示 GPU 加速、实际跑 CPU"那种假信息。
    picked = _PICKED["provider"] or ""
    gpu = picked in ("DmlExecutionProvider", "CUDAExecutionProvider")
    if gpu:
        # 显卡型号和显存优先问 torch（它报得最准）。没装 torch 就只报 provider。
        try:
            import torch
            if torch.cuda.is_available():
                vram = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)
                dev = torch.cuda.get_device_name(0)
        except Exception:
            pass
        tag = "DirectML" if picked == "DmlExecutionProvider" else "CUDA"
        if vram:
            dev = "%s (%s)" % (dev, tag)
        else:
            # ⚠ 问不出显存就【报 0，不猜】。档 3 会因此不开 ——
            #   宁可少给一档能力，也不给一个名不副实的名头（docs/40 规矩 2）。
            dev = "%s (显存未知)" % tag
    elif CAPS["onnx"]:
        dev = "CPU (onnxruntime)"
    _HW["vram"] = vram
    _HW["device"] = dev
    _HW["ready"] = True


def vram_gb():
    return _HW["vram"]


def device_name():
    return _HW["device"]


# ── 模型扫描与校验 ──────────────────────────────────────────
def _sha256(path, limit_mb=None):
    """
    算文件哈希。⚠ 几百 MB 全读一遍要几秒，所以：
      · 校验完整性时只在【用户主动点校验】时全量算
      · 平时扫描只看大小（够快，也能挡住"下了一半"这种最常见的情况）
    """
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
            n += len(b)
            if limit_mb and n >= limit_mb * 1024 * 1024:
                break
    return h.hexdigest()


def scan_models(deep=False):
    """
    扫模型文件夹，返回每个模型的安装状态。

    ⚠ 状态要分清三种，别合并成"有/没有"：
      missing  文件不在        → 界面显示"未安装 [去下载]"
      broken   在但明显不对    → 界面必须【明说文件可能没下完】，
                                 否则用户看到"已安装"却用不了，会以为是软件坏了
      ok       可用
    """
    d = models_dir()
    out = {}
    for key, m in MODELS.items():
        # ⚠ 停用的档位不进列表 —— 界面上多一个"暂不可用"只会让人困惑，
        #   而且用户已经下载的文件还在硬盘上，不删（万一以后恢复）。
        if m.get("enabled") is False:
            continue
        p = os.path.join(d, m["file"])
        item = {
            "key": key, "name": m["name"], "desc": m["desc"], "tier": m["tier"],
            "file": m["file"], "vramGB": m["vramGB"], "url": m["url"],
            "state": "missing", "bytes": 0, "reason": "",
        }
        if os.path.isfile(p):
            try:
                sz = os.path.getsize(p)
                item["bytes"] = sz
                if sz < m["minBytes"]:
                    item["state"] = "broken"
                    item["reason"] = "文件只有 %.0f MB，明显比正常的小 —— 多半没下完" % (sz / 1024 / 1024)
                elif deep and m["sha256"]:
                    got = _sha256(p)
                    if got.lower() != m["sha256"].lower():
                        item["state"] = "broken"
                        item["reason"] = "文件校验不通过，可能下载过程中损坏了"
                    else:
                        item["state"] = "ok"
                else:
                    item["state"] = "ok"
            except Exception as e:
                item["state"] = "broken"
                item["reason"] = "读不了这个文件：%s" % e
        out[key] = item
    return out


def max_tier(installed=None):
    """
    当前环境最高能跑到第几档。

    ⚠⚠ 按【能力】算，不按硬件算（docs/40 规矩 2，那是 docs/33 第 2 个坑换来的）。
       判据是"能做成哪几件事"：
         · 没有 onnxruntime 或 numpy → 0，什么都做不了
         · 装了哪个模型才有哪一档 —— 光有显卡没有模型文件，一档都开不了
         · 档 3 还要显存够（2048 推理峰值约 18G）

    ⚠ 返回 0 是【正常状态】，不是错误：用户还没下模型而已。
      界面要显示"去下载"，不是报错。
    """
    if not (CAPS["numpy"] and CAPS["onnx"]):
        return 0
    inst = installed if installed is not None else scan_models()
    tier = 0
    for key, m in MODELS.items():
        if m.get("enabled") is False:          # 停用的档位不算数
            continue
        if inst.get(key, {}).get("state") != "ok":
            continue
        t = m["tier"]
        if t <= 0:
            continue
        # 显存不够就不给这个名头（宁可少给一档，不给错的 —— docs/40 规矩 2）
        if m.get("vramGB") and vram_gb() and vram_gb() < m["vramGB"]:
            continue
        tier = max(tier, t)
    return tier


# ═══════════════════════════════════════════════════════════
#  模型加载 + 空闲释放
#
#  ⭐ 用户 2026-09-14 要求："不用的时候释放"。
#    抠图模型吃显存（档 3 峰值约 18G），一直占着会影响用户在 PS 里干别的活。
#
#  ⚠ 代价要明说：释放之后下次首用要重新加载，有几秒等待。
#    所以界面上必须显示"正在加载模型"，不能让人以为卡死了（规矩 5 的同类）。
# ═══════════════════════════════════════════════════════════
_SESS = {"key": None, "sess": None, "last": 0.0}
_SESS_LOCK = threading.Lock()
IDLE_UNLOAD_SEC = 300      # 5 分钟没请求就卸载。0 = 不自动卸载


# ⚠⚠ 实际能用的 provider —— 【实测出来的，不是查表查出来的】。
#   2026-09-14 血的教训：get_available_providers() 说 CUDA 可用，
#   建会话时却静默回落 CPU（缺 CUDA 13 的 DLL）。用户看到"GPU 加速 ✓"，
#   实际在跑 CPU —— 4.93 秒/张 vs 0.23 秒/张，21 倍差距，而且一声不吭。
#   这正是 docs/40 规矩 2 说的"按能力报，不按名头报"。
#
#   所以：启动时【真的建一次会话】试试，谁成了用谁。
#   代价是启动慢几秒 —— 换来的是报出去的能力是真的。
_PICKED = {"provider": None, "why": "", "probed": False}

# 候选顺序：DirectML 优先。
# ⚠ 为什么不是 CUDA 优先（虽然 CUDA 更快）：
#   DirectML 走 DirectX 12，Win10/11 自带、零额外依赖、N卡A卡Intel都能跑；
#   CUDA 要装对版本的运行库，正是今天卡住的那个坑。
#   对抠图这种"点一下等一下"的操作，DirectML 的 0.23 秒完全够用，
#   不值得为那点速度把用户拖进版本地狱。
_CANDIDATES = ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]


def _pick_provider(probe_model=None):
    """
    实测挑一个能用的 provider。启动时跑一次，结果缓存。

    ⚠ probe_model 给 None 时【只按可用列表排序、不实测】——
      因为没有模型文件就没法建会话。这时报出去的是"候选"，
      等第一次真加载模型时会自动修正（load_model 里会回填）。
    """
    if _PICKED["probed"]:
        return _PICKED["provider"]
    avail = [p for p in _CANDIDATES if p in _AVAIL]
    if not avail:
        avail = ["CPUExecutionProvider"]
    if not probe_model or not os.path.isfile(probe_model):
        # 没模型可试 —— 先记个候选，别标记成已探测（留给以后修正）
        _PICKED["provider"] = avail[0]
        _PICKED["why"] = "还没有模型文件，没法实测；这是按可用列表排的候选"
        return avail[0]
    so = ort.SessionOptions()
    so.log_severity_level = 4          # 实测阶段不刷日志
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
            # ⚠ 建会话没报错但 provider 变了 = 静默回落。记下来，这是最坑的情况
            _PICKED["why"] = "%s 静默回落到 %s" % (p, got)
        except Exception as e:
            _PICKED["why"] = "%s 建会话失败: %s" % (p, str(e)[:80])
    _PICKED["provider"] = "CPUExecutionProvider"
    _PICKED["probed"] = True
    return _PICKED["provider"]


def _providers():
    p = _PICKED["provider"] or "CPUExecutionProvider"
    # 永远把 CPU 垫底 —— 万一选中的那个临时抽风，至少还能出结果
    return [p, "CPUExecutionProvider"] if p != "CPUExecutionProvider" else ["CPUExecutionProvider"]


def load_model(key):
    """
    加载模型。已经加载着同一个就直接复用。
    ⚠ 换模型时【先释放旧的再加载新的】—— 两个几百 MB 的模型同时在显存里，
      16G 的机器直接爆。
    """
    with _SESS_LOCK:
        if _SESS["key"] == key and _SESS["sess"] is not None:
            _SESS["last"] = time.time()
            return _SESS["sess"]
        _unload_locked()
        m = MODELS.get(key)
        if not m:
            raise ValueError("没有这个模型：%s" % key)
        p = os.path.join(models_dir(), m["file"])
        if not os.path.isfile(p):
            raise FileNotFoundError("模型文件不在：%s" % p)
        so = ort.SessionOptions()
        so.log_severity_level = 3            # 只报错误，不刷 warning
        _SESS["sess"] = ort.InferenceSession(p, sess_options=so, providers=_providers())
        _SESS["key"] = key
        _SESS["last"] = time.time()
        return _SESS["sess"]


def _unload_locked():
    """⚠ 必须在持锁状态下调用。"""
    if _SESS["sess"] is not None:
        _SESS["sess"] = None
        _SESS["key"] = None
        # onnxruntime 的显存靠 GC 回收，主动催一下
        try:
            import gc
            gc.collect()
        except Exception:
            pass


def unload():
    with _SESS_LOCK:
        _unload_locked()


# ═══════════════════════════════════════════════════════════
#  图片编解码（照抄 match_server.py 那套，两边行为保持一致）
# ═══════════════════════════════════════════════════════════
def decode_bytes(raw):
    """原始图片字节 → RGB uint8 数组。"""
    if CAPS["pil"]:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img)
    if CAPS["cv2"]:
        arr = np.frombuffer(raw, np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    raise RuntimeError("需要 pillow 或 opencv-python 才能解码图片")


def encode_rgba(rgb, alpha):
    """
    RGB + alpha → PNG 字节（带透明通道）。

    ⚠ 必须输出 RGBA 的 PNG，不能只给一张灰度 mask ——
      贴回 Photoshop 时要的是"能直接用的透明图层"，
      让界面再去合成一次既慢又容易错（那是 docs/21 治理过的图片开销问题）。
    """
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
    raise RuntimeError("需要 pillow 或 opencv-python 才能编码图片")


def _resize(arr, w, h):
    """缩放。⚠ 两条路的插值方式要一致，否则换个依赖结果就变了。"""
    if CAPS["pil"]:
        return np.asarray(Image.fromarray(arr).resize((w, h), Image.BILINEAR))
    if CAPS["cv2"]:
        return cv2.resize(arr, (w, h), interpolation=cv2.INTER_LINEAR)
    raise RuntimeError("需要 pillow 或 opencv-python")


# ═══════════════════════════════════════════════════════════
#  抠图推理
# ═══════════════════════════════════════════════════════════
# BiRefNet 的输入归一化参数（ImageNet 标准值）。
# ⚠ 这三个数写错了不会报错，只会让 mask 质量变差 —— 属于"静默失效"，
#   所以单独拎出来当常量，别散在代码里。
_MEAN = None
_STD = None


def _norm_consts():
    global _MEAN, _STD
    if _MEAN is None:
        _MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
        _STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)
    return _MEAN, _STD


# ═══════════════════════════════════════════════════════════
#  alpha 后处理
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


class MattingEmpty(Exception):
    """
    模型在这块区域里什么都没找到（alpha 全是 0）。

    ⚠ 单独开一个异常，不跟"引擎炸了"混在一起 —— 这两件事用户的下一步完全不同：
      引擎炸了 → 去看依赖/显存；什么都没找到 → 换档位或者重新框选区。
      混成一句"抠像失败"就是那种查不下去的报错（铁律 15）。
    """
    code = "MATTING_EMPTY"


def run_matting(raw, model_key, feather=0, params=None):
    """
    抠图。返回 (png_bytes, info)。

    ⚠ 全程记录耗时分段（加载/预处理/推理/后处理）——
      用户说"慢"的时候，得知道慢在哪一段，不能只有一个总数。
    """
    t0 = time.time()
    m = MODELS.get(model_key)
    if not m:
        raise ValueError("没有这个模型：%s" % model_key)

    rgb = decode_bytes(raw)
    H, W = rgb.shape[:2]
    t_dec = time.time()

    # ⚠⚠ 输入尺寸【从模型自己身上读】，不用 MODELS 表里手填的那个。
    #   2026-09-14 栽过：按"HR 版是 2048 训练"填了 2048，
    #   而实际下到的 ONNX 是固定 1024 的 —— 直接 INVALID_ARGUMENT。
    #   表里的 input 只当回退值（模型没声明固定尺寸时才用）。
    sess = load_model(model_key)
    shp = sess.get_inputs()[0].shape          # 形如 [1,3,1024,1024]，动态维会是字符串
    size = int(m["input"])
    try:
        h, w = shp[2], shp[3]
        if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
            size = int(h)                     # 固定尺寸的模型必须喂这个数
    except Exception:
        pass
    t_load = time.time()

    # 预处理：缩到模型输入尺寸 → 归一化 → NCHW
    small = _resize(rgb, size, size).astype(np.float32) / 255.0
    mean, std = _norm_consts()
    x = ((small - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    t_pre = time.time()

    name = sess.get_inputs()[0].name
    out = sess.run(None, {name: x})[0]
    t_run = time.time()

    # 后处理：取单通道 → sigmoid 已在模型里做过 → 缩回原尺寸
    # ⚠ BiRefNet 的输出已经是 0~1 的概率图，不要再套一次 sigmoid（会把对比度压平）
    pred = np.asarray(out)
    while pred.ndim > 2:
        pred = pred[0]
    pred = np.clip(pred, 0.0, 1.0)
    # ⚠ 全程用 0~1 的浮点算，最后才转 0~255。
    #   中途转 uint8 会在每一步都截断一次，过渡带（发丝）损失最大。
    alpha = _resize((pred * 255.0).astype(np.uint8), W, H).astype(np.float32) / 255.0

    # ── 后处理链（顺序是有讲究的，别随便调）──
    #   ① 精修：先把边缘吸附回真实轮廓，后面几步才有准确的边可依
    #   ② 阈值/对比：在准确的边上做取舍
    #   ③ 收缩扩张：整体挪边界
    #   ④ 去碎片：前面几步可能制造出新的小块，放最后清
    #   ⑤ 羽化：最后一步，不然后面的形态学会把羽化的软边又切硬
    P = params or {}
    applied = []
    if P.get("refine", True) and CAPS["cv2"]:
        gray = (rgb.astype(np.float32).mean(axis=2)) / 255.0
        alpha = _guided_alpha(alpha, gray)
        applied.append("refine")
    th = int(P.get("threshold", 0) or 0)
    ct = int(P.get("contrast", 0) or 0)
    if th or ct:
        alpha = _remap(alpha, th, ct)
        applied.append("remap")
    sk = int(P.get("shrink", 0) or 0)
    if sk:
        alpha = _shrink(alpha, sk)
        applied.append("shrink")
    dsp = int(P.get("despeckle", 0) or 0)
    if dsp:
        alpha = _despeckle(alpha, dsp)
        applied.append("despeckle")
    fe = int(P.get("feather", feather) or 0)
    if fe and CAPS["cv2"]:
        k = fe * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (k, k), 0)
        applied.append("feather")

    # ⚠ 用户开了某一项但这台机器做不了 → 必须说，不能静默跳过（docs/40 规矩 4）
    skipped = []
    if not CAPS["cv2"]:
        for k2 in ("refine", "shrink", "despeckle", "feather"):
            if P.get(k2):
                skipped.append(k2)

    # ═══ 裁到主体那一块再回去（2026-09-14 下半场，修"回图比例错误"）═══
    #
    # ⚠⚠ 这一步不是为了省流量，是为了【贴回 Photoshop 时不被拉变形】。动之前读完：
    #
    #   界面那边贴回的做法是"量一下贴进去的图层多大，再拉伸到目标框那么大"。
    #   对不透明的图没问题 —— 图层大小就是整张图。
    #   但抠出来的图是透明的，Photoshop 报的图层大小是【只框住主体那一块】。
    #   于是"主体那一小块"被硬拉成"整个选区那么大" —— 比例扭了、还被放大好几倍。
    #
    #   裁到主体之后"图层大小 == 整张图"重新成立，界面再按 bbox 把目标框也缩到
    #   对应的那一小块，两边就对上了。
    #   ⭐ 这个做法不依赖"Photoshop 到底怎么量图层大小" —— 两种量法结果都对。
    #
    # ⚠ 用 any(axis=) 求边界，不要 np.nonzero：4K 图上 nonzero 会一口气吐出
    #   几百万个下标（几十 MB），而我们只要四个数。
    alpha_u8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    cols = np.any(alpha_u8, axis=0)
    rows = np.any(alpha_u8, axis=1)
    if not cols.any():
        # ⚠ 这【不是】故障，是模型在这张图里什么都没找到。必须说清楚，
        #   不然用户会去查引擎/显卡（docs/40 规矩 5：用户主动点的动作失败要有回音）。
        raise MattingEmpty("模型在这块区域里没找到主体。换一档模型，或者把选区框得更贴近主体")
    x0 = int(np.argmax(cols))
    x1 = int(len(cols) - np.argmax(cols[::-1]))       # 右开区间
    y0 = int(np.argmax(rows))
    y1 = int(len(rows) - np.argmax(rows[::-1]))
    png = encode_rgba(rgb[y0:y1, x0:x1], alpha_u8[y0:y1, x0:x1])
    t_end = time.time()

    return png, {
        "model": model_key,
        "tier": m["tier"],
        # ⚠ size 是【收到的那张图】的尺寸，不是回去那张。界面靠 size + bbox
        #   把"图片像素"换算成"Photoshop 文档像素"，两个都不能少。
        "size": [int(W), int(H)],
        # 主体在收到的那张图里的位置，[左, 上, 右, 下]，右下是开区间。
        "bbox": [x0, y0, x1, y1],
        # 实际回去的图有多大（= bbox 的宽高）。用户看"抠出来多大"就看这个。
        "out": [x1 - x0, y1 - y0],
        "input": int(size),          # ⚠ 实际喂进模型的尺寸（从 ONNX 读的），不是表里填的
        "provider": _PICKED["provider"],
        "applied": applied,          # 真正做了哪几步 —— 用户说"没效果"时靠它对账
        # ⚠ 开了但做不了的，必须报上去让界面说出来（docs/40 规矩 4）
        "skipped": skipped,
        # ⚠ 顺序是：解码 → 加载模型 → 预处理 → 推理 → 后处理
        #   （加载在预处理【之前】，因为要先从模型读出输入尺寸才知道缩到多大）
        "ms": {
            "decode": round((t_dec - t0) * 1000),
            "load": round((t_load - t_dec) * 1000),
            "pre": round((t_pre - t_load) * 1000),
            "infer": round((t_run - t_pre) * 1000),
            "post": round((t_end - t_run) * 1000),
            "total": round((t_end - t0) * 1000),
        },
    }


def _idle_watch():
    """空闲看门狗。⚠ daemon 线程 —— 主进程退出时不要它拖着。"""
    while True:
        time.sleep(20)
        if IDLE_UNLOAD_SEC <= 0:
            continue
        with _SESS_LOCK:
            if _SESS["sess"] is not None and (time.time() - _SESS["last"]) > IDLE_UNLOAD_SEC:
                _unload_locked()


# ═══════════════════════════════════════════════════════════
#  HTTP
# ═══════════════════════════════════════════════════════════
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass   # 不往终端刷请求日志，太吵

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        path = self.path.split("?")[0]

        # ── 探活。⚠ 必须快（1 秒内）：这是高频调用，硬件信息走启动时的缓存 ──
        if path == "/health":
            inst = scan_models()
            self._send(200, {
                "ok": True,
                "version": VERSION,
                "kind": "matting",
                "tier": max_tier(inst),
                "device": device_name(),
                "vramGB": vram_gb(),
                "caps": CAPS,
                "modelsDir": models_dir(),
                "models": inst,
                "loaded": _SESS["key"],
                "provider": _PICKED["provider"],
                "providerWhy": _PICKED["why"],
                "idleUnloadSec": IDLE_UNLOAD_SEC,
            })
            return

        # ── 模型库：扫描（deep=1 时连哈希一起校验，慢但准）──
        if path == "/models":
            deep = "deep=1" in self.path
            inst = scan_models(deep=deep)
            self._send(200, {
                "ok": True, "modelsDir": models_dir(),
                "models": inst, "tier": max_tier(inst), "deep": deep,
            })
            return

        # ── 手动释放显存（界面上给个按钮，也给排查用）──
        if path == "/unload":
            unload()
            self._send(200, {"ok": True, "loaded": None})
            return

        self._send(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/matting":
            # ⚠ 图片走【二进制 body】，不走 base64 ——
            #   base64 会让 4K 图多出 33% 体积，还要多一次编解码。
            #   这是 docs/21 治过的账，别走回头路。
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except Exception:
                n = 0
            if n <= 0:
                self._send(400, {"ok": False, "error": "没收到图片数据"})
                return
            raw = self.rfile.read(n)

            # 参数走 query（body 让给图片）
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            key = (q.get("model") or [""])[0]
            try:
                feather = int((q.get("feather") or ["0"])[0])
            except Exception:
                feather = 0

            # 没指定模型 → 用当前能跑的最高档
            if not key:
                inst = scan_models()
                t = max_tier(inst)
                # ⚠ 从 MODELS 表反查，不要写死 {3:'hr',2:'std'} 那种映射 ——
                #   档位一调整（比如这次停用了档3）就会对不上，而且不报错。
                key = ""
                for k, mm in MODELS.items():
                    if mm.get("enabled") is not False and mm["tier"] == t:
                        key = k
                        break
            if not key:
                # ⚠ 这条要说清楚，不能只说"失败"（docs/40 规矩 5、铁律 15）
                self._send(400, {"ok": False,
                                 "error": "还没有可用的模型。去 设置 → 外挂能力 → 抠像 下载"})
                return
            # ⚠ 参数走 header 的 JSON（body 让给图片，query 放不下这么多项）。
            #   解析失败就用默认值，不让一个参数错误毁掉整次抠图。
            params = None
            try:
                from urllib.parse import unquote
                hp = self.headers.get("X-Matting-Params")
                if hp:
                    params = json.loads(unquote(hp))
            except Exception:
                params = None
            try:
                png, info = run_matting(raw, key, feather, params)
            except MattingEmpty as e:
                # ⚠ 422 不是 500：这不是服务出错，是"这张图里没东西可抠"。
                #   带上 code，界面才能弹那张说人话的卡而不是通用的"抠像没跑成"。
                self._send(422, {"ok": False, "error": str(e), "code": MattingEmpty.code})
                return
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"ok": False, "error": str(e)})
                return
            # 回二进制 PNG（带透明通道），诊断信息放 header
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("X-Matting-Info", quote(json.dumps(info, ensure_ascii=False)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "X-Matting-Info")
            self.end_headers()
            self.wfile.write(png)
            return
        self._send(404, {"ok": False, "error": "Not found"})


def main():
    # ⚠⚠ Windows 终端默认 GBK，打印 ⚠ · —— 这类符号会直接抛 UnicodeEncodeError，
    #   而且是在【启动阶段】抛 —— 服务压根起不来，端口也不监听。
    #   2026-09-14 实测撞到：中文能出（GBK 里有），但 ⚠ 没有。
    #   两道保险：① 这里把 stdout 强制成 UTF-8 且遇到打不出的字符就替换
    #            ② 下面的启动日志一律只用 ASCII 符号（见那几行注释）
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    _probe_hardware()
    d = models_dir()
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    inst = scan_models()
    tier = max_tier(inst)

    # ⚠ 启动自检要【一眼看出能不能用】，不能只说"已启动"（铁律 17 同类）。
    okn = sum(1 for v in inst.values() if v["state"] == "ok")
    badn = sum(1 for v in inst.values() if v["state"] == "broken")
    miss = [v["name"] for v in inst.values() if v["state"] == "missing"]
    # ⚠ 下面这几行【只用 ASCII 符号】(| - [!])，不要用 · —— ⚠ 这类。
    #   Windows 终端 GBK 打不出它们，会在启动阶段抛异常、服务直接起不来。
    print("[抠像] 引擎 %s | 127.0.0.1:%d" % (VERSION, PORT))
    print("[抠像] 依赖: " + " ".join(
        ("%s=%s" % (k, "有" if v else "无")) for k, v in CAPS.items()))
    print("[抠像] 算力: %s%s" % (_PICKED["provider"] or "?", ("  (" + _PICKED["why"] + ")") if _PICKED["why"] else ""))
    print("[抠像] 设备: %s%s" % (device_name(), (" %.1fG" % vram_gb()) if vram_gb() else ""))
    print("[抠像] 模型目录: %s" % d)
    print("[抠像] 模型: 可用 %d / 损坏 %d / 未安装 %d%s"
          % (okn, badn, len(miss), ("（" + "、".join(miss) + "）") if miss else ""))
    if tier == 0:
        if not (CAPS["numpy"] and CAPS["onnx"]):
            print("[抠像] [!] 当前档位 0 - 缺 numpy 或 onnxruntime，装了才能用")
        else:
            print("[抠像] [!] 当前档位 0 - 依赖齐了，但一个模型都没装。去设置里下载")
    else:
        print("[抠像] 当前档位 %d" % tier)

    threading.Thread(target=_idle_watch, daemon=True).start()
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
