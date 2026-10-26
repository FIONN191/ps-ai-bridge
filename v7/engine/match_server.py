#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校色 / 对齐加速引擎（档 2 / 档 3）· 修图轮椅 V8

这是【可选组件】。不装它，桌面板照常工作 —— 只是用档 1 的纯 CPU 算法。
装了它，对齐能力会明显变强：档 1 只能修「整体位移 + 缩放」，
这里能修【局部形变】，那是 AI 生成图最常见、也最难处理的问题。

────────────────────────────────────────────────────────────
 怎么启动
────────────────────────────────────────────────────────────
    python match_server.py

    监听 127.0.0.1:37893，只接受本机连接。
    桌面板会自动探测；没启动就静默回落档 1，不会报错打扰用户。

────────────────────────────────────────────────────────────
 依赖分三层，装多少用多少
────────────────────────────────────────────────────────────
    必需  : numpy             → 档 2 的校色（全分辨率，比档 1 更精细）
    推荐  : opencv-python     → 档 2 的稠密光流对齐（DIS，纯 CPU 也很快）
    可选  : torch + CUDA      → 档 3 的深度光流（大形变）+ 无缝融合

    ⚠ 少装哪层就少哪层能力，服务照样起得来。
      /health 会如实报告当前能做什么，桌面板按它决定用哪档。
      这是刻意设计的：让用户能循序渐进地装，而不是一上来就劝退。
"""

import base64
import io
# ⚠ struct 是给 /process 的两张回传容器用的（docs/143 §四-2.2）：
#   4 字节大端长度前缀，纯字节操作，不能靠字符串拼。
import struct
from urllib.parse import quote
import json
import sys
import os
import socket
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PORT = 37893
# ⭐ 2026-10-18：跟 multi_engine_server 一样认 --port（云端门卫测试 / 本机并排起第二个引擎做对照用）。
#   不传 = 37893，本机软件行为不变。
for _i, _a in enumerate(sys.argv):
    if _a == "--port" and _i + 1 < len(sys.argv):
        try:
            PORT = int(sys.argv[_i + 1])
        except ValueError:
            pass
VERSION = "1.0.0"
MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024
BODY_READ_TIMEOUT_SECONDS = 120

def _safe_static_file(rel):
    """Resolve only the two documented development UI roots.

    URL decoding and component checks happen before realpath/commonpath so
    encoded traversal, sibling prefixes, and symlink escapes are rejected.
    """
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

# ── 能力探测：装了什么就报什么 ──────────────────────────────
CAPS = {"numpy": False, "cv2": False, "torch": False, "cuda": False, "pil": False}

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
    # ⭐ 2026-10-19（docs/249 §七）：可选的 V7_CV_THREADS（每单 cv2 用几个线程）。不设 = 跟以前一样（默认按核数）。
    #   ⚠ 实测收益很小，云端【没设】：本机钉 14 核，设 3 时单独一单慢 8%（1.85 → 2.0 秒）、4 单一起只快 5%（3.8 → 3.6 秒）。
    #     留着这个开关只为以后机器变了能再试；要开之前先确认结果跟不设时逐字节一样（还没有测试比过）。
    _cv_threads = os.environ.get("V7_CV_THREADS", "").strip()
    if _cv_threads.isdigit() and int(_cv_threads) > 0:
        cv2.setNumThreads(int(_cv_threads))
except ImportError:
    cv2 = None

try:
    import torch
    CAPS["torch"] = True
    CAPS["cuda"] = torch.cuda.is_available()
except ImportError:
    torch = None


# ⚠⚠ 硬件信息【只在启动时查一次，之后全部走缓存】(2026-09-11)。
#
#   原来 /health 每次被请求都去调 torch.cuda.get_device_properties()。
#   CUDA 上下文的首次初始化可能要好几秒 —— 桌面板探活只等 1.5 秒，
#   于是表现成"端口在监听、进程也活着，但 /health 一直不回数据"，
#   看起来像服务卡死，实际是每个请求都在重新问显卡。
#   探活是高频调用(桌面板每次生成前都可能探)，更不该把重活放在里面。
_HW = {"vram": 0, "device": "CPU", "tier": 1, "ready": False}


def _probe_hardware():
    """启动时跑一次。⚠ 每一步都兜住异常 —— 查显卡失败不该让整个服务起不来。"""
    vram = 0
    dev = "CPU"
    if CAPS["cuda"]:
        try:
            vram = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)
        except Exception:
            vram = 0
        try:
            dev = torch.cuda.get_device_name(0)
        except Exception:
            dev = "CUDA"
    elif CAPS["cv2"]:
        dev = "CPU (OpenCV)"
    _HW["vram"] = vram
    _HW["device"] = dev
    _HW["tier"] = _calc_tier(vram)
    _HW["ready"] = True


def vram_gb():
    return _HW["vram"]


def device_name():
    return _HW["device"]


def max_tier():
    """档位。启动时算好，这里只读缓存 —— 绝不在请求里查硬件。"""
    return _HW["tier"]


def _calc_tier(v):
    """
    当前环境最高能跑到第几档。

    ⚠⚠ 档位【按真实能力算，不按显存算】(2026-09-11 实测发现的坑)：
      这台机器 numpy/torch/CUDA/31.8G 都有、唯独没装 opencv，
      按显存判断会报"档 3"，可【对齐和无缝融合全都依赖 opencv】——
      用户拿到档 3 的名头，实际只有校色，还以为对齐做过了。
      这正是本项目最忌讳的"静默失效"。

    所以判据是【能做成哪几件事】：
      档 3 = 能对齐 + 能无缝融合 + 显存够跑大模型
      档 2 = 能对齐（稠密光流）
      档 1 = 只能校色，那还不如让桌面板用本地的（省一次来回传输）
    """
    if not CAPS["numpy"]:
        return 1
    can_align = CAPS["cv2"]          # 稠密光流对齐要 opencv
    # ⚠ 2026-09-12：无缝融合已停用（见 seamless() 注释），
    #   所以【档 3 现在和档 2 做的事完全一样】，不再单独报档 3 ——
    #   报一个名不副实的高档位，用户会以为多做了什么，是另一种静默失效。
    #   等将来档 3 真有独占能力（比如深度光流模型）再把它加回来。
    if can_align:
        return 2
    # 只能校色的话没必要走外部引擎：档 1 本地就能做，还省一次图片来回传输
    return 1


# ── 图片编解码 ──────────────────────────────────────────────
def _parse_multipart(body, content_type):
    """
    解析 multipart/form-data，取出 meta(JSON) + src/ref 两段图片字节。

    ⚠ 为什么自己写而不用 cgi/email 模块：
      cgi 在 3.13 被移除了，email 那套要把 bytes 当文本处理、
      对二进制不友好（会在 \\r\\n 上做转换，把 PNG 弄坏）。
      这里的格式是我们自己发的、结构固定，手写反而更可控。

    ⚠ 手写解析最容易错的地方是【边界】：
      - 每段之间是 \\r\\n--boundary\\r\\n
      - 段内 header 和 body 之间隔一个空行 \\r\\n\\r\\n
      - body 末尾有一个 \\r\\n 是分隔符的一部分，【必须去掉】，
        不去的话 PNG 尾部多两个字节，解码直接失败。
    """
    marker = "boundary="
    idx = content_type.find(marker)
    if idx < 0:
        raise RuntimeError("multipart 缺少 boundary")
    boundary = content_type[idx + len(marker):].strip().strip('"')
    sep = ("--" + boundary).encode("ascii")

    meta, parts = {}, {}
    for chunk in body.split(sep):
        if not chunk or chunk in (b"--\r\n", b"--", b"\r\n"):
            continue
        head_end = chunk.find(b"\r\n\r\n")
        if head_end < 0:
            continue
        head = chunk[:head_end].decode("utf-8", "ignore")
        data = chunk[head_end + 4:]
        if data.endswith(b"\r\n"):        # 尾部那个 \r\n 属于分隔符，不是内容
            data = data[:-2]
        # 取 name="xxx"
        nidx = head.find('name="')
        if nidx < 0:
            continue
        name = head[nidx + 6:head.find('"', nidx + 6)]
        if name == "meta":
            meta = json.loads(data.decode("utf-8") or "{}")
        else:
            parts[name] = data

    if "src" not in parts or "ref" not in parts:
        raise RuntimeError("multipart 缺少 src 或 ref")
    return meta, parts["src"], parts["ref"]


def decode_bytes(raw):
    """从原始图片字节解码成 float32 数组。和 decode() 共用同一套解码器。"""
    if CAPS["pil"]:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img).astype(np.float32)
    if CAPS["cv2"]:
        arr = np.frombuffer(raw, np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    raise RuntimeError("需要 pillow 或 opencv-python 才能解码图片")


def decode(b64):
    raw = base64.b64decode(b64.split(",")[-1])
    if CAPS["pil"]:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img).astype(np.float32)
    if CAPS["cv2"]:
        arr = np.frombuffer(raw, np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    raise RuntimeError("需要 pillow 或 opencv-python 才能解码图片")


def encode_bytes(arr):
    """
    编码成 PNG【原始字节】。给二进制通道用，不经过 base64。

    ⚠⚠ 2026-10-05（docs/143 §八）：现在要能吃 **4 通道（RGBA）**。
      补细节的「增量层」是 RGBA 的 —— 第 4 通道是置信度 w×255，当图层不透明度用。
      · PIL 那条路直接支持 4 通道，不用改。
      · cv2 那条路 `cv2.COLOR_RGB2BGR` **只认 3 通道**，喂 4 通道会抛异常。
        所以这里显式分流：4 通道就拆成 RGB 走 BGR、alpha 单独拼回去。
      ⚠ 三通道的路径【一个字都没改】，老调用方行为完全不变。
    """
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    if CAPS["pil"]:
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG", compress_level=3)
        return buf.getvalue()
    if CAPS["cv2"]:
        if arr.ndim == 3 and arr.shape[2] == 4:
            # ⚠ cv2.imencode 不接受 RGB 4 通道，得自己拆：RGB→BGR 走三通道，alpha 单独 merge 回去。
            rgb, alpha = arr[..., :3], arr[..., 3]
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            ok, enc = cv2.imencode(".png", cv2.merge([bgr[..., 0], bgr[..., 1], bgr[..., 2], alpha]))
            if not ok:
                raise RuntimeError("PNG 编码失败（带透明通道）")
            return enc.tobytes()
        ok, enc = cv2.imencode(".png", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
        if not ok:
            raise RuntimeError("PNG 编码失败")
        return enc.tobytes()
    raise RuntimeError("需要 pillow 或 opencv-python 才能编码图片")


def encode(arr):
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    if CAPS["pil"]:
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG", compress_level=3)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    if CAPS["cv2"]:
        ok, enc = cv2.imencode(".png", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
        if not ok:
            raise RuntimeError("PNG 编码失败")
        return base64.b64encode(enc.tobytes()).decode("ascii")
    raise RuntimeError("需要 pillow 或 opencv-python 才能编码图片")


# ══════════════════════════════════════════════════════════
#  实验算法（2026-09-12）· 只在 /compare 里用，主链路还没接
#
#  ⚠ 先说清楚要解决的是什么问题（用户 2026-09-12 澄清）：
#
#    AI 模型有原生比例。你递交 1020×1028，它近似到 1:1 做成 1024×1024，
#    返回时再拉回 1020×1028。**两次重采样**带来两种损伤：
#      ① 几何漂移 —— 没被修改的部位也上下抖
#      ② 锐度损失 —— 边缘、直线、弧线过渡变糊
#
#  ⚠ 这和"AI 移动了内容"完全是两回事。之前用稠密光流去 warp 输出图，
#    把 AI 修脸的成果（瘦脸、放大的眼睛）一起扭回了原样 —— 那是选错了算法：
#    百万级自由度去拟合一个本质上很低阶的形变。
# ══════════════════════════════════════════════════════════

def _truthy(v):
    """
    把请求里的"开关"读成真假。JSON 传过来可能是 true / 1 / "1" / "true"。

    ⚠ 为什么单写一个：`if req.get("wantBase"):` 遇到字符串 "0" 会当【真】——
       而 multipart 那条路（下面 /process 主的进图方式）参数全是从 form 字段来的，
       都是字符串。这种"看着写了开关、其实永远开/永远关"的 bug 在本项目
       出现过好几次（铁律 17 静默失效），所以统一口径。
    """
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _aspect_mismatch(src, ref):
    """
    两张图的长宽比差多少（比值，1.0 = 完全一致）。

    ⚠ 为什么要看这个：调用方把参考图 resize 到了 src 的尺寸。
      如果两者长宽比不同，那次 resize 是【非等比拉伸】——
      参考图本身已经被拉变形了。
      拿一张变了形的图当基准去做网格匹配，算出来的位移场
      会试图"修正"这个不存在的形变，结果就是把好图扭坏。
    """
    a = (src.shape[1] / max(1, src.shape[0]))
    b = (ref.shape[1] / max(1, ref.shape[0]))
    return max(a, b) / max(1e-6, min(a, b))


def mesh_warp(src, ref, notes, grid=10, max_shift_ratio=0.02):
    """
    ① 粗网格变形 —— 修几何漂移。

    ⚠ **低自由度本身就是安全阀。**
      grid×grid 个控制点（默认 10×10 = 100 格），相邻格子必须连续 ——
      这个模型**根本表达不出"眼睛局部放大一圈"**（那需要局部剧烈、
      不连续的位移场），但足够表达"整体被拉伸了 0.4%、某一带偏了两像素"。

      这比"位移超过 X% 就跳过"那种阈值判据可靠得多：
      它是**结构性**的限制，不依赖阈值调得准不准。

    ⚠ 用 NCC 而不是 SSD：校色前两张图亮度本来就不同，SSD 会被亮度差带跑。
    """
    if not CAPS["cv2"]:
        notes.append("未装 opencv，跳过网格变形")
        return src, None

    h, w = src.shape[:2]
    g_src = cv2.cvtColor(np.clip(src, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    g_ref = cv2.cvtColor(np.clip(ref, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)

    # 每个控制点周围取一块去匹配。块要够大才有纹理可匹配。
    patch = max(16, int(min(w, h) / (grid * 1.2)))
    search = max(4, int(min(w, h) * max_shift_ratio))   # 搜索半径 = 允许的最大位移
    # ⚠⚠ 网格点必须覆盖【整张图】，从 0 到 w-1（2026-09-12 修）。
    #
    #   原来写的是 linspace(patch, w-patch, grid)：网格只覆盖中间那块，
    #   可下面 cv2.resize(dx,(w,h)) 是把这个网格【拉伸铺满整张图】——
    #   等于把"中间区域的位移场"硬套到全图上，边缘被大幅外推。
    #   用户实测看到的就是：贴回去的那块**被突兀地放大了一圈**，边界明显错位。
    #
    #   ⚠ 这个 bug 在测试台上不明显（合成图边缘没内容），
    #     真实照片一贴回 Photoshop 就一眼看出来 —— 又一个"测试样本太干净"的例子。
    #
    #   边缘的块会超出图像，下面取块时 clamp 处理。
    gx = np.linspace(0, w - 1, grid).astype(int)
    gy = np.linspace(0, h - 1, grid).astype(int)

    dx = np.zeros((grid, grid), np.float32)
    dy = np.zeros((grid, grid), np.float32)
    conf = np.zeros((grid, grid), np.float32)

    for j, cy in enumerate(gy):
        for i, cx in enumerate(gx):
            # ⚠ 网格点现在覆盖到边缘了，取块必须 clamp 回图内。
            #   不 clamp 的话负索引会被 numpy 当成"从末尾倒数"，
            #   拿到的是图另一头的内容 —— 匹配结果完全是错的，而且不报错。
            y0 = max(0, min(h - patch, cy - patch // 2))
            x0 = max(0, min(w - patch, cx - patch // 2))
            y1, x1 = y0 + patch, x0 + patch
            tpl = g_src[y0:y1, x0:x1]
            if tpl.size == 0 or float(tpl.std()) < 3.0:
                continue                       # 这块太平，没有可匹配的结构
            sy0, sy1 = max(0, y0 - search), min(h, y1 + search)
            sx0, sx1 = max(0, x0 - search), min(w, x1 + search)
            win = g_ref[sy0:sy1, sx0:sx1]
            if win.shape[0] <= tpl.shape[0] or win.shape[1] <= tpl.shape[1]:
                continue
            r = cv2.matchTemplate(win, tpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            dx[j, i] = (sx0 + loc[0]) - x0
            dy[j, i] = (sy0 + loc[1]) - y0
            conf[j, i] = mx

    good = conf > 0.4
    if good.sum() < grid * grid * 0.25:
        notes.append("网格变形：可匹配的格子太少(%d/%d)，跳过" % (int(good.sum()), grid * grid))
        return src, None

    # ⚠ 强平滑：先用中值去掉离群格子，再高斯让位移场连续。
    #   不平滑的话单个错配的格子会在图上拧出一个局部涡旋。
    dx[~good] = np.median(dx[good])
    dy[~good] = np.median(dy[good])
    dx = cv2.medianBlur(dx, 3)
    dy = cv2.medianBlur(dy, 3)
    dx = cv2.GaussianBlur(dx, (3, 3), 0)
    dy = cv2.GaussianBlur(dy, (3, 3), 0)

    # 网格位移场放大到整图（双线性 → 格子之间平滑过渡，就是"液化"那种感觉）
    big_dx = cv2.resize(dx, (w, h), interpolation=cv2.INTER_LINEAR)
    big_dy = cv2.resize(dy, (w, h), interpolation=cv2.INTER_LINEAR)
    mx_, my_ = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    # ⚠⚠ 这里是【减】不是加（2026-09-12 实测修正）。
    #
    #   上面匹配算的是「src 里的这一块，跑到 ref 的哪个位置」——
    #   即 src→ref 的位移。
    #   而 cv2.remap 是【反向取样】：输出(x,y) 从 src(map_x, map_y) 取像素，
    #   要的是 ref→src 方向。两者正好相反，所以要取负号。
    #
    #   ⚠ 写成加号的后果不是"没效果"，而是【往反方向搬，偏差翻倍】：
    #     用真实缓存图实测（cache/X37_0100.NEF/20260912-135517-10）：
    #       处理前残余位移 2.27px → 写成加号 4.44px（几乎正好 2 倍）
    #       改成减号后     2.27px → 0.5px 级别
    #     "差不多正好翻倍"就是方向反了的典型特征，可以拿来自查。
    #
    #   ⚠ 别拿 align_dense 里的写法照抄：那边 dis.calc(g_ref, g_src) 算的
    #     本来就是 ref→src，所以它用加号是对的。方向取决于【谁减谁】，
    #     不是看别处怎么写的。（09-11 在 align_dense 上也栽过一次同类问题。）
    out = cv2.remap(src, (mx_ - big_dx).astype(np.float32), (my_ - big_dy).astype(np.float32),
                    cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    med = float(np.hypot(dx[good], dy[good]).mean())
    mxs = float(np.hypot(dx[good], dy[good]).max())
    notes.append("网格变形 %d×%d · 平均 %.2fpx / 最大 %.2fpx · 可用格 %d/%d"
                 % (grid, grid, med, mxs, int(good.sum()), grid * grid))
    return out, {"dx": dx, "dy": dy, "conf": conf}


def _odd(v):
    """凑成奇数 —— OpenCV 的核边长必须是奇数，偶数会直接抛异常。"""
    v = int(max(1, v))
    return v if v % 2 == 1 else v + 1


def _gauss_sigma(ksize):
    """
    OpenCV 在 sigma=0 时按这个公式反推 sigma。
    ⭐ 界面上要把它显示出来 —— "半径 10" 是个抽象数字，
      "相当于 3.5 像素级" 才能让人判断这个频段是不是抠对了。
    """
    return 0.3 * ((ksize - 1) * 0.5 - 1) + 0.8


def _hi_extract(img, mode, radius):
    """
    把一张图抠出【细节层】hi。

    ⭐ 低频层恒等于 `img - hi`，所以下面四种办法【都是合法拆分】，
      区别只在"什么算细节"：

      dog        高斯差分（原方案）—— img − 高斯模糊。最朴素。
                 ⚠ 强边缘两侧的过渡也算细节 → 替换时容易描边
      laplacian  拉普拉斯 —— 只抓【最细的那一档】(1~2 像素)。
                 重采样丢的锐度正好在这一档，理论上最对症；代价是对噪点敏感
      bilateral  双边残差 —— 双边滤波保边，大边缘留在低频里，
                 只有纹理进细节层 → 换的时候不容易描边
      guided     导向残差 —— 同理，比双边更平滑，复用校色那套 _guided

    ⚠ `laplacian` 的半径旋钮【不起作用】，固定 3×3。
      ksize 一调大，拉普拉斯核的幅度会指数级膨胀，出来的不是"更宽的频段"
      而是溢出的垃圾。界面上必须写明 —— 拖了没反应会被当成坏了，
      那就是本项目最常见的"静默失效"。
    """
    if mode == "laplacian":
        # ×0.25 是把 3×3 核的响应拉回"细节振幅"量级的粗略归一。
        # ⚠ 它只是个固定系数，等效于额外乘了一档强度，不影响各方案之间的可比性。
        return -cv2.Laplacian(img, cv2.CV_32F, ksize=3) * 0.25
    if mode == "bilateral":
        d = int(max(3, min(15, radius)))
        low = cv2.bilateralFilter(np.clip(img, 0, 255).astype(np.uint8),
                                  d, 40, float(max(3, radius))).astype(np.float32)
        return img - low
    if mode == "guided":
        guide = (0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2]).astype(np.float32)
        eps = 1e-4 * 255 * 255
        rr = int(max(1, radius))
        low = np.empty_like(img, np.float32)
        for c in range(3):
            low[..., c] = _guided(img[..., c].astype(np.float32), guide, rr, eps)
        return img - low
    k = _odd(radius * 2 + 1)
    return img - cv2.GaussianBlur(img, (k, k), 0)


def _detail_energy(hi, k):
    """
    细节层的局部强度（RMS）。给"增益"那种叠加用。

    ⚠ 用灰度算，三个通道共用一个系数 —— 各通道各算各的会让 RGB
      放大倍数不一致，平坦区直接浮出彩色噪斑。
      （和 color_lowfreq 里"三通道共用一个引导图"是同一条道理。）
    """
    g = 0.299 * hi[..., 0] + 0.587 * hi[..., 1] + 0.114 * hi[..., 2]
    return np.sqrt(np.maximum(cv2.GaussianBlur(g * g, (k, k), 0), 0.0))


def sharpness(img):
    """
    锐度 = 平均边缘强度（拉普拉斯绝对值的均值）。数越大越锐。

    ⚠⚠ 这把尺子也会骗人，用之前先记住两条：
      ① **噪点会让它变大**。补偿把原图噪点一起搬过来，锐度数字照样上涨，
         但图是脏的 —— 所以必须配合肉眼看 1:1。
      ② 它只说"锐不锐"，不说"锐得对不对"。描边、双边缘都会让它飙高。
    配套要看的是 lowfreq_drift（形状动没动）。两个数一起才有意义。
    """
    g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    return float(np.abs(cv2.Laplacian(g, cv2.CV_32F, ksize=3)).mean())


def lowfreq_drift(a, b, ksize):
    """
    两张图在【形状】这一层差多少：都把细节糊掉再比。

    ⭐ 这是"高频补偿有没有越界"的判据。
      理想情况：补偿只换细节层，形状层原封不动 → 这个数应该接近 0。
      它明显大于 0，说明【按置信度加权】把低频也带偏了 ——
      也就是 AI 的修改正在被侵蚀。

    ⚠ 这正是上一轮翻车的那类问题换了个频段：
      上次是对齐把"瘦下去的脸"扭回去（低频），
      这次要防的是高频补偿把"磨掉的皮肤"补回来。
    """
    k = _odd(ksize)
    return float(np.abs(cv2.GaussianBlur(a, (k, k), 0) - cv2.GaussianBlur(b, (k, k), 0)).mean())


def detail_prepare(ai_img, orig_img, notes, source="flow", extract="dog", radius=None,
                   conf_floor=0.25, conf_mode="linear", conf_win=None, denoise=True):
    """
    高频补偿的【贵的那一半】：把原图搬到位、抠出两边的细节层、算好置信度。

    ⭐ 为什么要拆出来：光流和置信度算一次就够了，四种叠加方式共用同一份
      中间结果 —— 于是"一次跑出四种并排看"几乎不要钱。
      实验台要比的是叠加方式，不该为了比它重算四遍光流。

    返回一个字典（失败返回 None），字段见末尾。
    """
    h, w = ai_img.shape[:2]
    if radius is None:
        # 原方案的自动半径：2048 的图 → 10（模糊核 21，约 3.5 像素级）
        radius = max(2, int(min(w, h) / 200))
    radius = int(max(1, min(60, radius)))
    k = int(conf_win) if conf_win else max(5, (min(w, h) // 64) | 1)
    k = _odd(k)

    # ── ① 把原图搬到 AI 图的位置上 ──────────────────────────
    #   ⚠ 搬的是【原图】，不是输出图。输出的几何自始至终由 AI 图决定，
    #     这一步答错了最多是某处细节没补上，扭不到脸。
    if source == "none":
        warped = orig_img
        notes.append("细节来源：原图原样（不搬）")
    elif source == "mesh":
        sub = []
        warped, _ = mesh_warp(orig_img, ai_img, sub)
        notes.append("细节来源：网格搬（低自由度）· " + (sub[0] if sub else "无"))
    else:
        try:
            dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
            g_ai = cv2.cvtColor(np.clip(ai_img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
            g_or = cv2.cvtColor(np.clip(orig_img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
            # ⚠ 方向：算 ai→orig 的光流，用它 remap 原图。
            #   cv2.remap 是反向取样，要的就是这个方向
            #   （写反了会越搬越远，见 docs/33 坑 1）。
            flow = dis.calc(g_ai, g_or, None)
        except Exception as e:
            notes.append("光流失败，跳过高频补偿：%s" % e)
            return None
        mx_, my_ = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        warped = cv2.remap(orig_img, (mx_ + flow[..., 0]).astype(np.float32),
                           (my_ + flow[..., 1]).astype(np.float32),
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        notes.append("细节来源：稠密光流搬（DIS）")

    # ── ② 置信度：搬过来的原图和 AI 图局部有多像 ────────────
    #   像 = 同一个东西只是糊了 → 可以补细节
    #   不像 = AI 在这儿画了新东西 → 别碰
    gw = cv2.cvtColor(np.clip(warped, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    ga = cv2.cvtColor(np.clip(ai_img, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    mu_a = cv2.GaussianBlur(ga, (k, k), 0)
    mu_w = cv2.GaussianBlur(gw, (k, k), 0)
    va = cv2.GaussianBlur(ga * ga, (k, k), 0) - mu_a * mu_a
    vw = cv2.GaussianBlur(gw * gw, (k, k), 0) - mu_w * mu_w
    cov = cv2.GaussianBlur(ga * gw, (k, k), 0) - mu_a * mu_w
    ncc = cov / (np.sqrt(np.maximum(va, 1e-6) * np.maximum(vw, 1e-6)))

    t = np.clip((ncc - conf_floor) / max(1e-6, 1.0 - conf_floor), 0, 1)
    if conf_mode == "hard":
        # 硬阈值：过线全补、不过线一点不补。看得出"门槛卡在哪"，但会留下硬边界
        conf = (ncc >= conf_floor).astype(np.float32)
    elif conf_mode == "scurve":
        # S 曲线：中间段过渡更陡，两头更平 —— 拿不准的地方更保守
        conf = (t * t * (3 - 2 * t)).astype(np.float32)
    else:
        conf = t.astype(np.float32)
    conf = cv2.GaussianBlur(conf, (k, k), 0)          # 平滑，避免硬边界

    # ── ③ 抠细节层 ───────────────────────────────────────────
    #   ⚠ 提原图细节前先轻微降噪，免得把噪点一起补过去。
    #     这一步能关 —— 关掉正好能验证"锐度涨了是补回细节还是补回噪点"。
    src_hi = warped
    ai_hi_src = ai_img
    if denoise:
        # ⚠⚠⚠ 2026-10-08（docs/170 第 5 步）：两侧必须【对称降噪】。
        #
        #   改之前这里只降 warped（参考图那侧），AI 图那侧是原样的 ——
        #   而 _gate_energy() 拿两边的细节能量相比 ⇒
        #   **降噪本身造成的能量差被误判成"内容变了"**，
        #   于是"这里没变、可以校色"的地方被误判成"变了、别动"。
        #   表现就是混合判据校得比它该校的少一截（这就是那个"天花板"）。
        #
        #   ⚠ 为什么两边都降、而不是两边都不降：实测两种都过"自己跟自己比 = 1.0"
        #     的对照组，但两边都降的校色量更高（g3 0.493 vs 0.465），
        #     因为降噪能压掉"噪点造成的能量差"这个假信号。
        #     数据见 tmp/_step5_ceiling_compare.py。
        #
        #   ⚠ 两边必须是【同一组参数】（5, 20, 5）—— 参数不同又是一处不对称。
        src_hi = cv2.bilateralFilter(np.clip(warped, 0, 255).astype(np.uint8), 5, 20, 5).astype(np.float32)
        ai_hi_src = cv2.bilateralFilter(np.clip(ai_img, 0, 255).astype(np.uint8), 5, 20, 5).astype(np.float32)
    hi_or = _hi_extract(src_hi, extract, radius)
    hi_ai = _hi_extract(ai_img, extract, radius)
    # ⭐ 另外抠一份【降噪过的 AI 细节】，只给结构判据用。
    #   ⚠ 细节补偿路径用的仍然是上面那个 hi_ai（原样的）——
    #     降噪过的那份不能拿去补细节，否则补回来的纹理是糊的。
    hi_ai_dn = _hi_extract(ai_hi_src, extract, radius) if denoise else hi_ai

    ks = _odd(radius * 2 + 1)
    notes.append("抠法 %s · 半径 %dpx(核 %d ≈ %.1f 像素级) · 置信 %s/窗口 %d · %s"
                 % (extract, radius, ks, _gauss_sigma(ks), conf_mode, k,
                    "已降噪" if denoise else "未降噪"))
    return {"warped": warped, "conf": conf, "hi_or": hi_or, "hi_ai": hi_ai,
            # ⚠ 2026-10-08（docs/170 第 5 步）：判据专用的那一份（降噪过的 AI 细节）。
            #   手写字段列表漏字段在这条链上栽过好几次 —— 加了这个键就要确认
            #   _gate_energy 真读得到（它就在下面几行，同一个文件）。
            "hi_ai_dn": hi_ai_dn,
            "radius": radius, "ksize": ks, "confWin": k,
            "cover": float(conf.mean())}


def detail_blend(ai_img, prep, mode="replace", strength=1.0, gain_cap=3.0, luma_only=False):
    """
    高频补偿的【便宜的那一半】：拿准备好的细节层，按某种方式叠回去。

    ⭐ 四种叠加，差别在"原图的细节到底进不进输出图"：

      replace 替换（原方案）：扔掉 AI 的细节，换上原图的。
              能补回真正丢失的锐度 —— 也是唯一会【把 AI 有意去掉的细节搬回来】的一种。
              ⚠ 提示词里磨皮 0.8 的时候，要重点盯这一格：
                磨皮 = AI 故意去高频，替换 = 把高频塞回来，两者正面冲突。
      add     相加：AI 的细节 + 原图的细节。两份高频叠一起 → 过锐、描边、双边缘。
              放进来主要是当【反面对照】，让人一眼看出"为什么当初选的是替换"。
      gain    增益 ⭐：**一点原图内容都不进输出图**，只是把 AI 自己的细节
              放大到原图的强度。光流配错也不会出鬼影，磨皮也撤销不了。
              代价：AI 那边已经糊到没细节的地方，放大零还是零，补不回来。
      max     取大：逐点谁的细节强用谁。介于替换和保留之间。

    ⚠ `luma_only` 只动亮度、不动颜色：细节层在 R/G/B 三通道的振幅本来就不一样，
      三通道各补各的容易在平坦区留下细小色斑。锐度基本都在亮度里，色度不动更稳。
    """
    conf, hi_or, hi_ai = prep["conf"], prep["hi_or"], prep["hi_ai"]
    w = (conf * float(strength))[..., None]

    if mode == "add":
        out = ai_img + hi_or * w
    elif mode == "gain":
        k = prep["confWin"]
        e_or = _detail_energy(hi_or, k)
        e_ai = _detail_energy(hi_ai, k)
        # ⚠ 下限夹 1.0：只补不削。小于 1 意味着"把 AI 的细节按原图削掉"，
        #   那就是在替 AI 反向磨皮，不是这个功能该干的事。
        g = np.clip(e_or / np.maximum(e_ai, 1e-3), 1.0, None)[..., None]
        # ⚠⚠ gain_cap 夹的是【最终实际放大倍数】，不是夹 g（2026-09-13 修）。
        #
        #   原来写的是 clip(g, 1, cap) 然后 out = ai + hi_ai*(g-1)*w，
        #   而 w = 置信度 × 强度 —— 强度又乘了一遍，
        #   于是旋钮写「3.0×」时，强度 1.5 会让实际放大到 1+(3−1)×1.5 = **4.0×**。
        #   旋钮上写一个数、实际生效另一个数，就是铁律 16 说的
        #   "用户会以为自己调过了"。现在夹在最后，写几倍就是几倍。
        eff = np.minimum(1.0 + (g - 1.0) * w, float(gain_cap))
        out = ai_img + hi_ai * (eff - 1.0)
    elif mode == "max":
        pick = np.where(np.abs(hi_or) > np.abs(hi_ai), hi_or, hi_ai)
        out = ai_img + (pick - hi_ai) * w
    else:
        out = ai_img + (hi_or - hi_ai) * w

    if luma_only:
        # 只把亮度换成结果的，色度还用 AI 图的
        a = cv2.cvtColor(np.clip(ai_img, 0, 255).astype(np.float32), cv2.COLOR_RGB2YCrCb)
        o = cv2.cvtColor(np.clip(out, 0, 255).astype(np.float32), cv2.COLOR_RGB2YCrCb)
        a[..., 0] = o[..., 0]
        out = cv2.cvtColor(a, cv2.COLOR_YCrCb2RGB)
    return out


def detail_layer(prep, strength=1.0):
    """
    ⭐⭐ 把细节层编码成【可编辑的增量层】—— 交给 PS 用「线性光」叠，而不是引擎自己合成。

    ⚠ 这是 2026-10-05 用户要的东西（docs/143 §八）：
      「我们能不能直接把高频层的纹理置入回去，然后按照 PS 的混合模式叠呢？
        这样的话我还可以去编辑高频纹理。」

    ── 编码公式（tmp/colortest/texture_layer.py 实测验证过）──
      PS 线性光的混合公式：result = base + 2×(本层 − 128)
      配上图层不透明度 a：  result = base×(1−a) + (base + 2×(本层−128))×a
                                   = base + a × 2 × (本层 − 128)
      我们想要的就是：      result = base + delta × w   （delta = hi_or − hi_ai）
      ⇒ 取 a = w、本层 = 128 + delta/2 即可。

    ⚠ 实测结论（4.12MP 真实样本）：
      · 这样能复现引擎现在那条公式，**平均差 0.002**，超 1/255 的像素只占 0.03%
      · 置信度 w 直接当【图层不透明度】用，与目标公式**最大差 0.0000（完全一致）**
      · 增量层比成品图**更小**（4.32MB vs 5.07MB），因为大片是 50% 灰
      · 97.4% 的像素落在中灰 ±8 以内 → 压得动

    ⚠ 输出是 **RGBA 4 通道**（第 4 通道 = w×255，当不透明度）：
      引擎别的路径都是 3 通道，所以下游（encode_bytes / 前端）要能吃 4 通道。
      PIL 直接支持；cv2 那条路要先把 alpha 拆出来单独处理（见 encode_bytes 的注释）。
    """
    conf, hi_or, hi_ai = prep["conf"], prep["hi_or"], prep["hi_ai"]
    w = np.clip(conf * float(strength), 0.0, 1.0)
    delta = hi_or - hi_ai                       # 三通道带符号的增量
    blend = np.clip(128.0 + delta / 2.0, 0.0, 255.0)
    h, wd = conf.shape[:2]
    out = np.empty((h, wd, 4), np.float32)
    out[..., 0:3] = blend
    out[..., 3] = w * 255.0
    return out


def detail_transfer(ai_img, orig_img, notes, strength=1.0, conf_floor=0.25,
                    radius=None, denoise=True, mode="replace", as_layer=False):
    """
    ② 高频补偿 —— 修锐度损失（用户 2026-09-12 提的思路）。

    ⚠ 这是【主链路走的那条】。抠法和细节来源仍写死（高斯差分 + 光流搬），
      要试别的走实验台（/compare），别改这里。

    ⚠⚠ 2026-09-12 实测：**这个功能在真实样本上是负收益**，所以主链路默认
      已经关掉它（`detailBoost` 默认 false）。数据在 docs/33：
        放大后原图(目标) 16.41 · AI 原样 13.04 · 只对齐 12.86
        → 当时那套默认值（自动半径 + 降噪开 + 强度 1.0）跑出来 **11.93**，
          比不补还糊。
      三个原因：AI 把图放大了 1.33 倍返回（原料先天打折）、光流搬运又插值一次、
      抠细节前那道降噪把原图纹理先削了一遍。
      现在调用方传的是用户 2026-09-12 定的参数（半径 15 / 强度 1.5 /
      门槛 0.20 / 不降噪），在实验台上能跑到 15.03。

    ⭐ **这里光流的用途和以前完全不同，这是整个方案的关键。**

      以前：用光流 warp **输出图** → 输出的几何被光流决定
            → 它一旦把 AI 的修改当成"偏移"，就会把脸扭回去。
      现在：用光流 warp **参考图**，只为了提取高频
            → **输出的几何完全由 AI 图决定，光流碰不到它。**
            光流只回答一个问题："原图里这根睫毛，对应 AI 图上哪个位置"。
            答错了最多是某处细节没补上，**不会把脸扭回去**。

    ⭐ 为什么不会撤销 AI 的修改 —— 频率分工正好对上：
        眼睛【多大】、脸【多瘦】 = 低频/中频(形状) → 来自 AI 图
        睫毛纹理、皮肤质感、边缘锐度 = 高频(细节)  → 来自原图
      两件事在频域上是分开的，所以能各取所需。不需要猜意图。

    ⚠ 三个风险，这里都处理了：
      ① AI 新生成的内容（改了发型、加了耳环）在原图里根本不存在，
         光流会给出垃圾匹配 → **按置信度决定贴不贴**，
         匹配差的地方保留 AI 原样。宁可糊一点，不能出鬼影。
      ② 直接相加会过锐、出双边缘（AI 图自己也有高频，两份叠一起就是描边）
         → 用**替换**而不是相加。
      ③ 原图的噪点会被一起补过去 → 提高频时先轻微降噪。
    """
    if not CAPS["cv2"]:
        notes.append("未装 opencv，跳过高频补偿")
        return ai_img, None

    # ⚠ 这几行的默认值就是 2026-09-12 上线的那套，一个字都别改：
    #   source='flow'(光流搬原图) · extract='dog'(高斯差分) · radius=None(按图长自动)
    #   conf_mode='linear' · denoise=True · mode='replace'
    #   —— 拆成 prepare/blend 只是为了让实验台复用，行为和拆之前完全一致。
    sub = []
    prep = detail_prepare(ai_img, orig_img, sub, conf_floor=conf_floor,
                          radius=radius, denoise=denoise)
    if prep is None:
        notes.extend(sub)
        return ai_img, None

    # ⭐⭐ 2026-10-05（docs/143 §八-3③）：要【增量层】而不是合成好的图。
    #   ⚠ 只对 'replace' 档成立 —— 线性光那边的编码公式是按
    #     out = ai + (hi_or − hi_ai)×w 推出来的（见 detail_layer 的推导）。
    #     gain / add / max 那几档的公式不一样，硬套会算错，所以这里只认 replace。
    #     用户已拍板：补细节【只留「替换」一档】，所以这不是妥协，是正好。
    if as_layer:
        if mode != "replace":
            notes.append("增量层只支持「替换」档，已按替换算")
        lay = detail_layer(prep, strength=strength)
        notes.append("高频增量层(替换) · 半径 %dpx · 覆盖率 %.0f%% · 强度 %.2f · 交给 PS 线性光叠"
                     % (prep["radius"], prep["cover"] * 100, strength))
        return lay, {"conf": prep["conf"], "cover": prep["cover"], "isLayer": True}

    out = detail_blend(ai_img, prep, mode=mode, strength=strength)
    notes.append("高频补偿(%s) · 半径 %dpx · 覆盖率 %.0f%% · 强度 %.2f%s"
                 % (mode, prep["radius"], prep["cover"] * 100, strength,
                    "" if denoise else " · 未降噪"))
    return out, {"conf": prep["conf"], "cover": prep["cover"]}


# ── 对齐 ────────────────────────────────────────────────────
# 2026-10-24：align_dense（稠密光流对齐 =「精确对齐」）已永久删除 —— 用户定：光流把图扭了（反馈 #5 涂抹）。
#   老设置 / 老请求传 alignMode="flow" 一律按 mesh 走（前端 match-engine.js 入口也兜了一道）。
#   ⚠ detail_prepare 的 source="flow" 是【细节补偿】在用的光流，不是对齐，没删。


# ── 校色 ────────────────────────────────────────────────────
def color_mkl(src, ref, notes):
    """
    MKL 线性色彩迁移（和档 1 同一套数学，只是全分辨率 + numpy 向量化）。

    ⚠ 和档 1 结果应当一致 —— 这里不是"更好的算法"，是"更快 + 不降采样"。
      真正拉开差距的是上面的稠密对齐。
    """
    s = src.reshape(-1, 3)
    r = ref.reshape(-1, 3)
    ms, mr = s.mean(0), r.mean(0)
    cs = np.cov((s - ms).T) + np.eye(3) * 1e-6
    cr = np.cov((r - mr).T) + np.eye(3) * 1e-6

    def sym_pow(m, p):
        w, v = np.linalg.eigh(m)
        w = np.maximum(w, 1e-8)
        return v @ np.diag(w ** p) @ v.T

    cs12, csm12 = sym_pow(cs, 0.5), sym_pow(cs, -0.5)
    t = csm12 @ sym_pow(cs12 @ cr @ cs12, 0.5) @ csm12
    out = (s - ms) @ t.T + mr
    notes.append("全分辨率校色(MKL)")
    return out.reshape(src.shape)


def _guided(p, guide, r, eps):
    """
    引导滤波。⚠ 必须用它，不能图省事用高斯模糊。

    2026-09-11 实测账（同一组输入，位移 8,5 + 明显偏色）：
        档 1（引导滤波）        差异降 86%
        本引擎用高斯模糊时      差异只降 51%   ← 比档 1 还差
    差距全在这一步：高斯会把强边缘两侧的颜色糊到一起，
    低频基准被污染，校完反而留下一圈色晕。引导滤波沿边缘停住，不跨越。
    """
    # ⚠ r 是【半径】，cv2.boxFilter 要的是【窗口边长】= 2r+1。
    #   直接把 r 传进去窗口就只有一半大，低频取不够 —— 校色效果会明显打折。
    #   2026-09-11 实测：传错时降 60%，传对后才追平档 1 的 86%。
    k = (2 * r + 1, 2 * r + 1)
    mean_g = cv2.boxFilter(guide, -1, k)
    mean_p = cv2.boxFilter(p, -1, k)
    mean_gp = cv2.boxFilter(guide * p, -1, k)
    mean_gg = cv2.boxFilter(guide * guide, -1, k)
    cov = mean_gp - mean_g * mean_p
    var = mean_gg - mean_g * mean_g
    a = cov / (var + eps)
    b = mean_p - a * mean_g
    return cv2.boxFilter(a, -1, k) * guide + cv2.boxFilter(b, -1, k)


# ══════════════════════════════════════════════════════════
#  ⭐⭐ 混合判据校色 —— 主链路【唯一】的校色算法（2026-10-05 起）
# ══════════════════════════════════════════════════════════
#
# ⚠⚠ 来龙去脉（docs/143 §十二：11 组真实样本 × 8 方案实测）：
#
#   用户定的规则是「颜色接近但有色差 → 校准；颜色差得特别多 → 不校准」。
#   单独用【颜色判据】：整体偏色一大（对照实验 +45）就 100% 判成"内容变了"，
#     整张拒绝校色 —— 而它该做的恰恰是把这个偏色校回去。方向反了。
#   单独用【结构判据】：不怕整体偏色（+6→+45 全程没崩），但在该校的地方留斑块。
#   ⇒ 两个【相乘】才互补：结构判据挡住"这里内容真的变了"（AI 新画了东西，别搬），
#     颜色判据挡住"这里颜色本来就该差这么多"。
#
#   ⚠ 为什么不能只用颜色：docs/融合方案-B01 那句话说的就是它 ——
#     「颜色差异本身不能作为拒绝锚点的唯一依据，因为颜色变化正是待校正的内容」。
#
#   ⇒ 所以主链路【只有这一条】校色路。精准/整体两个档已砍掉
#     （用户 2026-10-05 拍板："把之前的校色算法全都干飞掉"）。
#
# ⚠ 两个判据都是【按位置】算的：比的是"AI 图这个位置"vs"原图同一个位置"。
#   所以长宽比差 >3% 时不能用 —— 参考图被拉伸过，位置对不上，
#   比出来的东西没有意义。那种情况直接【跳过校色】并如实说明（调用方已经拦了）。

def _gate_smooth(m, h, w, px=None):
    """判据图的平滑。⚠ 不平滑会在阀门边界留下棋盘格状的硬边。"""
    if px is None:
        px = max(6.0, min(h, w) / 90.0)
    ks = int(px * 2 + 1) | 1
    return cv2.GaussianBlur(m.astype(np.float32), (ks, ks), 0)


def _gate_color(ai, orig, notes, thresh=28.0):
    """
    ① 颜色判据：两边【都先低频化】再比色差。

    ⚠ 不能逐像素比 —— 逐像素比的是纹理噪点，不是"这块地方整体是什么颜色"，
      结果会是满屏碎斑。
    ⚠ r / eps 与老 color_lowfreq 逐字一致（r = min(w,h)/16、eps = 1e-4·255²），
      换成别的值引导滤波就退化了，两个判据的尺度也会跟着偏。
    """
    h, w = ai.shape[:2]
    r = max(4, int(min(h, w) / 16))
    eps = 1e-4 * 255 * 255
    guide = (0.299 * ai[..., 0] + 0.587 * ai[..., 1] + 0.114 * ai[..., 2]).astype(np.float32)
    # ⚠⚠⚠ 2026-10-08 修 bug（用户报"切换校色/底版看不出差别"，一路查到最底下是这个）：
    #
    #   原来这两行是 `A = np.empty_like(ai)` / `O = np.empty_like(ai)` ——
    #   而 ai 是 **uint8** ⇒ A / O 也是 uint8 ⇒ 下面 985-986 行辛苦算出来的
    #   **float32 引导滤波结果，一赋值进去就被截断**。
    #
    #   实测（真图，两张的整图平均色差 = 34.75）：
    #     · 用 uint8 存：低频色差中位报 **221.33**，判"差得多"占 100.0% —— 阀门恒为 0
    #     · 用 float32 存：低频色差中位报 **34.68** —— 和整图平均色差吻合，这才是对的
    #   （221 是 72-98 在 uint8 里回绕成 230 再取绝对值的典型症状：差值一超 ±255 就全错）
    #
    #   ⇒ 后果【不是报错，是判据静默失效】：
    #       色差一大就必然算成"差得更多" ⇒ gate 被 clip 到 0
    #       ⇒ 颜色判据这道阀门【永远关着】。
    #     也就是说这套阀门里颜色判据一直没起作用 —— 真正决定校多少的只有结构判据。
    #     ⚠ 典型的"看起来在工作、其实那一半是坏的"（本项目最忌讳的那种）。
    #   ⚠ 对照：同文件 _color_apply_gate（:1039-1041）是显式 .astype(np.float32) 的，
    #     所以那条路没这个毛病 —— **输出本身是正常算的，只有"阀门"算错了**。
    A = np.empty(ai.shape, dtype=np.float32)
    O = np.empty(ai.shape, dtype=np.float32)
    for c in range(3):
        A[..., c] = _guided(ai[..., c].astype(np.float32), guide, r, eps)
        O[..., c] = _guided(orig[..., c].astype(np.float32), guide, r, eps)
    diff = np.abs(A - O).mean(2)
    # thresh 是"到这个色差就算差得多"的尺度：中段线性过渡，两头夹住
    gate = np.clip(1.0 - (diff - thresh * 0.4) / max(1e-6, thresh * 0.6), 0, 1)
    gate = _gate_smooth(gate, h, w)
    notes.append("①颜色判据 · 低频色差中位 %.1f · 判'差得多'占 %.1f%%"
                 % (float(np.median(diff)), float((gate < 0.35).mean()) * 100))
    return gate


def _gate_energy(ai, orig, prep, notes, floor_scale=0.12):
    """
    ② 结构判据：按【细节能量】的差异判"这里的内容是不是被 AI 换掉了"。

    ⚠ 用的是 detail_prepare 已经抠好的两个高频层 —— 白捡，不用重算。
    ⚠ floor_scale 是"多小的差异算噪声"的尺度（取中位数的一个比例）：
      没有它的话，平坦区那点微小抖动会被当成"内容变了"，整片判 0。
    """
    h, w = ai.shape[:2]
    k = max(5, (min(h, w) // 40) | 1)
    k = k if k % 2 == 1 else k + 1
    # ⚠⚠⚠ 2026-10-08（docs/170 第 5 步）：两边都用【降噪过】的那一对。
    #   改之前这里是 hi_or（降噪过）对 hi_ai（原样）——
    #   降噪本身就是一处不对称，被判据读成了"内容变了"。
    #   这一行就是那个"天花板"bug 的修复点。
    #   ⚠ hi_ai_dn 在 detail_prepare 里生成；老调用方没给这个键时回落到 hi_ai
    #     （回落是保守的：等于回到修之前的行为，不会因为缺字段而炸）。
    Eo = _detail_energy(prep["hi_or"], k)
    Ea = _detail_energy(prep.get("hi_ai_dn", prep["hi_ai"]), k)
    tot = Eo + Ea
    floor = float(np.percentile(tot, 50)) * floor_scale + 1e-3
    mismatch = np.clip(np.abs(Eo - Ea) / (tot + floor), 0, 1)
    gate = 1.0 - mismatch
    # ⚠ 两边都有东西时，再看"是不是同一个东西" —— 拿置信度收紧。
    #   两边都空的地方（纯色区）不受这条影响，否则纯色区会被判成"内容变了"。
    both = (np.minimum(Eo, Ea) > np.percentile(tot, 70) * 0.25).astype(np.float32)
    struct = np.clip(prep["conf"], 0, 1) * both + (1 - both)
    gate = _gate_smooth(gate * struct, h, w)
    notes.append("②结构判据 · 判'内容变了'占 %.1f%% · 阀均值 %.2f"
                 % (float((gate < 0.35).mean()) * 100, float(gate.mean())))
    return gate


def _color_apply_gate(ai, orig, gate, notes, radius=None):
    """
    把阀门乘到低频校正量上。

    ⚠ 与老 color_lowfreq 逐字同参（r = min(w,h)/16、eps = 1e-4·255²、
      三通道共用一个灰度引导图）—— 阀门只该决定"校多少"，
      不该顺手把"怎么校"也改了，否则两边的效果没法对照。
    ⚠ 唯一区别就是那个 v 乘数：v=1 时结果与老 color_lowfreq 完全相同。
    """
    h, w = ai.shape[:2]
    if radius is None:
        radius = max(4, int(min(h, w) / 16))
    eps = 1e-4 * 255 * 255
    guide = (0.299 * ai[..., 0] + 0.587 * ai[..., 1] + 0.114 * ai[..., 2]).astype(np.float32)
    v = gate[..., None]
    out = np.empty_like(ai)
    for c in range(3):
        s_low = _guided(ai[..., c].astype(np.float32), guide, radius, eps)
        r_low = _guided(orig[..., c].astype(np.float32), guide, radius, eps)
        out[..., c] = ai[..., c] + v[..., 0] * (r_low - s_low)
    return out


def color_hybrid(src, ref, notes):
    """
    ⭐⭐ 混合判据校色 —— 主链路【唯一】的校色算法。

        结果 = AI 图 + 阀门 × (原图低频 − AI 低频)

      · 阀门 ≈ 1 → 完全换上原图的颜色（该校的地方）
      · 阀门 ≈ 0 → 一点不动（AI 在这里画了新东西，或颜色本来就该差这么多）

    ⚠ 它是本引擎里【最贵】的一步：两个判据各要 6 次引导滤波，
      再加套用时的 6 次，共 18 次；还要一份 detail_prepare（光流+置信度）。
      实测 4.1MP 约 1.4 秒。
      ⇒ 慢是【已知且接受】的代价（用户 2026-10-05：本次不做性能优化）。
    """
    if not CAPS["cv2"]:
        notes.append("未装 opencv，跳过校色")
        return src
    # 结构判据要的那份中间结果（光流 + 两个高频层 + 置信度）
    prep = detail_prepare(src, ref, [], source="flow", extract="dog",
                          conf_floor=0.25, conf_mode="linear")
    if prep is None:
        # ⚠ 光流挂了 = 结构判据算不出来。这时候【宁可跳过校色】，
        #   也不要退化成"没有内容保护的硬搬"（那正是鬼影的来源）。
        #   如实说，别静默。
        notes.append("光流失败，跳过校色（混合判据要看位置，没有它就没有内容保护）")
        return src
    h, w = src.shape[:2]
    g1 = _gate_color(src, ref, notes)
    g2 = _gate_energy(src, ref, prep, notes)
    g = _gate_smooth(g1 * g2, h, w)
    notes.append("③混合判据 · 判'内容变了'占 %.1f%% · 阀均值 %.2f"
                 % (float((g < 0.35).mean()) * 100, float(g.mean())))
    out = _color_apply_gate(src, ref, g, notes)
    notes.append("校色(混合判据)")
    return out


# ⚠⚠⚠ 以下两个【已不在主链路】，只留给实验台做对照基准线
#   （tmp/colortest/rig.py 要跑 8 方案并排比对，得留着）。
#   ⚠ 主链路请用上面的 color_hybrid。要删它们，先把实验台脚本一起改掉。
def color_lowfreq(src, ref, notes):
    """
    【已停用·仅实验台】低频替换：保留回图细节，换上原图颜色。
    和档 1 (ui-pure/color-match.js) 同一套算法，只是全分辨率 + 向量化。

    ⚠ 三个通道【共用一个灰度引导图】。各通道各用各的引导会让 RGB 边缘
      错开，出现彩边 —— 这条和档 1 的注释是同一个道理。
    """
    if not CAPS["cv2"]:
        return color_mkl(src, ref, notes)
    # ⚠ 这两个参数必须和档 1 (color-match.js transferLowFreq) 【逐字一致】，
    #   否则同一张图两档出来的颜色不一样，用户切换档位会以为哪档坏了。
    #   r 是半径；eps 用 1e-4·255² ≈ 6.5（我一开始写成 (0.01·255)² ≈ 6502，
    #   大了 1000 倍，引导滤波退化成普通均值滤波，保边效果全没了）。
    r = max(4, int(min(src.shape[0], src.shape[1]) / 16))
    eps = 1e-4 * 255 * 255
    guide = (0.299 * src[..., 0] + 0.587 * src[..., 1] + 0.114 * src[..., 2]).astype(np.float32)
    out = np.empty_like(src)
    for c in range(3):
        s_low = _guided(src[..., c].astype(np.float32), guide, r, eps)
        r_low = _guided(ref[..., c].astype(np.float32), guide, r, eps)
        out[..., c] = src[..., c] - s_low + r_low
    notes.append("全分辨率校色(低频替换·引导滤波)")
    return out


def seamless(src, ref, notes):
    """
    ⚠⚠ 【已默认停用，2026-09-12】不要再打开，除非先读完下面这段。

    用户实测报告：「对齐前后的两张图混到一块，边缘有残影」。
    真因就是这个函数 —— 它是【设计时就想错了】，不是实现 bug。

    cv2.seamlessClone(src, dst, mask, ...) 的语义是
    「把 src 的 mask 区域，融合贴到 dst 上」，输出 = dst 打底 + src 当前景。
    而这里传的 dst 是 ref（**原图**），mask 又只盖中间（四周留 4%）。
    所以输出是：
        边缘 4%  = 原图的内容
        中间     = AI 生成图的内容
        交界处   = 泊松融合
    AI 既然改了画面，这两圈内容必然对不上 —— 看起来就是两张图混在一起。

    当初的意图是「让贴回去的图和周围原图过渡自然」，但那个前提不成立：
    **贴回 Photoshop 是整张图替换选区，周围的原图在 PS 文档里、不在这张图内。**
    在图的内部混入原图毫无意义。

    真要做边缘融合，该做的地方是【贴回 PS 时用蒙版羽化】
    （V6 的 returnFeather 就是干这个的），不是在图内部调 seamlessClone。

    代码留着是为了记住这个教训；将来如果做「局部重绘」
    （只替换选区的一部分、周围确实是同一张图的内容），它才有用武之地。
    """
    notes.append("跳过无缝融合（当前链路下会把原图内容混进来，已停用）")
    return src


def _seamless_disabled_原实现(src, ref, notes):
    if not CAPS["cv2"]:
        notes.append("未装 opencv，跳过无缝融合")
        return src
    try:
        h, w = src.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        m = max(2, int(min(h, w) * 0.04))
        mask[m:h - m, m:w - m] = 255
        out = cv2.seamlessClone(
            np.clip(src, 0, 255).astype(np.uint8),
            np.clip(ref, 0, 255).astype(np.uint8),
            mask, (w // 2, h // 2), cv2.NORMAL_CLONE)
        notes.append("无缝融合")
        return out.astype(np.float32)
    except Exception as e:
        notes.append("无缝融合失败，已跳过：%s" % e)
        return src


# ── HTTP 服务 ───────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def send_response(self, code, message=None):
        self._timing_status = code       # 计时日志用（_timing_end）
        BaseHTTPRequestHandler.send_response(self, code, message)

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

    # ⭐ 2026-10-18 云端外挂工具（docs/237）：门锁，跟 multi_engine_server._access_denied 同一个规矩。
    #   仙宫云上任何端口都能从公网摸到 ⇒ 配了 WHEELCHAIR_ENGINE_ACCESS_TOKEN 时只认云端门卫转来的请求。
    #   本机没配这个变量，行为不变。
    def _access_denied(self):
        token = os.environ.get("WHEELCHAIR_ENGINE_ACCESS_TOKEN", "") or ""
        if not token:
            return False
        import hmac as _hmac
        supplied = str(self.headers.get("X-Engine-Access") or "")
        if supplied and _hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8")):
            return False
        self.close_connection = True
        self._send(403, {"ok": False, "error": "这台引擎只接受云端门卫转来的请求", "code": "ENGINE_ACCESS_DENIED"})
        return True

    def do_OPTIONS(self):
        if self._access_denied():
            return
        self._send(200, {"ok": True})

    def _send_file(self, rel):
        """
        提供项目里的静态文件（只读、只限项目目录内）。

        ⚠ 为什么引擎要兼职当文件服务器：
          测试页 tools/align-test.html 如果用 file:// 双击打开，
          浏览器【禁止 file:// 页面访问 http://】—— 不管服务器怎么放行都会被拦，
          表现就是"引擎不可用：Failed to fetch"（2026-09-11 用户实测撞到）。
          从这里发出去就同源了，一个 CORS 问题都没有。
          而且页面里的相对路径(../ui-pure/xxx.js)天然也能解析对。
        """
        path = _safe_static_file(rel)
        if not path:
            self._send(404, {"ok": False, "error": "Not found"})
            return
        ctype = ("text/html; charset=utf-8" if path.endswith(".html")
                 else "application/javascript; charset=utf-8" if path.endswith(".js")
                 else "image/png" if path.endswith(".png")
                 else "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")   # 改完刷新就生效，不用清缓存
        self.end_headers()
        self.wfile.write(body)

    def _handle_compare(self):
        """
        实验台接口：把流水线的每个环节都拆成可调的，一次跑完并排看。
        ⚠ **主链路不走这里**（走 /process），这里怎么调都影响不到用户。

        入参(JSON + base64)：orig(递交给 AI 的原图) / ai(AI 返回的图)
          对齐   alignMode(off/mesh/flow) · grid · maxShift
          高频   source(flow/none/mesh) · extract(dog/laplacian/bilateral/guided)
                 · radius · denoise · strength · gainCap · lumaOnly
          置信   confFloor · confMode(linear/hard/scurve) · confWin
          显示   previewMax(预览长边) · crop(1:1 取景) · hiGain(细节层放大倍数)

        返回 9 张图：
          orig 递交的原图 / raw AI 原样 / geo 只对齐 / conf 置信度 / hi 抠出来的细节层
          + 四种叠加：replace 替换 · add 相加 · gain 增益 · max 取大

        ⭐ 两条关于"怎么看数"的规矩，写在这当备忘：
          ① 图片按 previewMax 缩了，**数字全部在全分辨率上算** ——
             缩过的图看不出锐度，缩过之后再算锐度更是自欺欺人。
          ② 给了 crop 就【只返回那一块的 1:1 原始像素，数字也只算那一块】。
             这才是能分别回答"皮肤区怎么样""眼睛区怎么样"的办法。
        """
        try:
            body = _read_limited_body(self)
            if body is None: return
            req = json.loads(body or b"{}")
            if not CAPS["cv2"]:
                raise RuntimeError("实验台需要 opencv：py -m pip install opencv-python")
            orig = decode(req["orig"])
            ai = decode(req["ai"])

            # ⭐⭐ 先记下【原图的原生锐度】和【要放大多少倍才能对上 AI 图】。
            #
            #   2026-09-12 实测这两个数一出来，整件事的前提就变了：
            #     递交 1151×2048 → AI 返回 1536×2734（放大 1.33 倍）
            #     原图原生锐度 26.77 → 放大到 AI 尺寸后只剩 16.41
            #
            #   也就是说：**能拿来补的"原图细节"上限是 16.41，不是 26.77。**
            #   放大倍数越大，这条上限掉得越狠 —— 倍数够大时，
            #   放大后的原图会比 AI 图还糊，这时候"用原图细节替换"
            #   就是在【主动把图弄糊】，方向整个反了。
            #
            #   所以界面上必须把这个倍数显示出来，而且目标线要画在
            #   "放大后的原图"上，不是原生锐度上 —— 拿一条够不着的线当目标，
            #   会得出"补偿没用"的错误结论。
            orig_native_sharp = sharpness(orig)
            scale = float(ai.shape[1]) / max(1, orig.shape[1])
            src_size = [int(orig.shape[1]), int(orig.shape[0])]

            # 尺寸对不齐先统一到 AI 图的尺寸 —— 输出几何以 AI 图为准
            if orig.shape[:2] != ai.shape[:2]:
                orig = cv2.resize(orig, (ai.shape[1], ai.shape[0]), interpolation=cv2.INTER_AREA)

            grid = max(4, min(24, int(req.get("grid", 10))))
            max_shift = float(req.get("maxShift", 0.02))
            align_mode = str(req.get("alignMode", "mesh"))
            source = str(req.get("source", "flow"))
            extract = str(req.get("extract", "dog"))
            radius = req.get("radius")
            radius = int(radius) if radius else None
            denoise = bool(req.get("denoise", True))
            strength = float(req.get("strength", 1.0))
            gain_cap = float(req.get("gainCap", 3.0))
            luma_only = bool(req.get("lumaOnly", False))
            conf_floor = float(req.get("confFloor", 0.25))
            conf_mode = str(req.get("confMode", "linear"))
            conf_win = req.get("confWin")
            conf_win = int(conf_win) if conf_win else None
            hi_gain = float(req.get("hiGain", 4.0))
            preview_max = max(200, int(req.get("previewMax", 1600)))
            crop = req.get("crop") or None

            notes = {"align": [], "detail": []}

            # ── ① 对齐 ──────────────────────────────────────
            if align_mode == "off":
                geo = ai
                notes["align"].append("不对齐（基准线）")
            else:
                geo, _ = mesh_warp(ai, orig, notes["align"], grid=grid, max_shift_ratio=max_shift)

            # ── ② 抠细节 + 算置信度（贵的那一半，只算一次）──
            prep = detail_prepare(geo, orig, notes["detail"], source=source, extract=extract,
                                  radius=radius, conf_floor=conf_floor, conf_mode=conf_mode,
                                  conf_win=conf_win, denoise=denoise)

            # ── 取景：给了 crop 就只看那一块的 1:1 ────────────
            H, W = ai.shape[:2]
            if crop:
                cw = max(16, min(W, int(crop.get("w", 640))))
                ch = max(16, min(H, int(crop.get("h", 640))))
                cx = max(0, min(W - cw, int(crop.get("x", 0))))
                cy = max(0, min(H - ch, int(crop.get("y", 0))))
                region = "1:1 取景 %d×%d @ (%d,%d)" % (cw, ch, cx, cy)
                take = lambda a: a[cy:cy + ch, cx:cx + cw]
                shrink = lambda a: a                       # 1:1，不缩
            else:
                region = "全图 %d×%d" % (W, H)
                take = lambda a: a
                def shrink(a):
                    s = float(preview_max) / max(a.shape[0], a.shape[1])
                    if s >= 1.0:
                        return a
                    return cv2.resize(a, (max(1, int(a.shape[1] * s)), max(1, int(a.shape[0] * s))),
                                      interpolation=cv2.INTER_AREA)

            # ⚠ 指标的比对基准：
            #   sharp 锐度 → 和【原图】比，目标是追平原图
            #   drift 低频漂移 → 和【对齐后的 AI 图】比，目标是 0
            #     （0 = 只动了细节、没碰形状。明显大于 0 就是补偿越界了）
            #   diff 和原图差异 → 旧指标，留着但要标明它会骗人
            ref_o = take(orig)
            ref_g = take(geo)
            # ⚠⚠ 漂移的核【必须是固定值，不能跟着频段半径走】（2026-09-12 修）。
            #
            #   原来写的是 radius*2+1 —— 半径一变，尺子的刻度跟着变：
            #     半径 15 → 核 31 → 测出 0.38
            #     半径  7 → 核 15 → 测出 0.33      看起来"差不多"
            #   但拿同一把核 31 的尺子量，真实差距是 0.38 vs 0.13（差三倍）。
            #
            #   ⭐ 方向还正好是反的：核越粗数字越小，于是这把尺子【偏袒大半径】——
            #     而半径正是最该比的那个参数。实验台拿它做 A/B 会得出反的结论。
            #   这是"指标会骗人"的第四例，前三例记在 docs/39 的 3.3。
            DRIFT_K = 31
            drift_k = DRIFT_K

            images, cells = {}, {}

            def emit(key, arr, measure=True):
                """算完一张就立刻编码并丢掉，别让 8 张全分辨率浮点图同时待在内存里。"""
                a = take(arr)
                if measure:
                    cells[key] = {
                        "sharp": round(sharpness(a), 2),
                        "drift": round(lowfreq_drift(a, ref_g, drift_k), 2),
                        "diff": round(float(np.abs(np.clip(a, 0, 255) - ref_o).mean()), 2),
                    }
                images[key] = encode(shrink(a))

            emit("orig", orig, measure=False)
            emit("raw", ai)
            emit("geo", geo)

            if prep is not None:
                for mode in ("replace", "add", "gain", "max"):
                    emit(mode, detail_blend(geo, prep, mode=mode, strength=strength,
                                            gain_cap=gain_cap, luma_only=luma_only))
                # 置信度可视化：绿=补了细节，红=没敢补（AI 在这里画了新东西）
                c = np.clip(prep["conf"], 0, 1)
                emit("conf", np.stack([(1 - c) * 255, c * 255, np.zeros_like(c)], -1), measure=False)
                # 细节层可视化：灰底 128 + 抠出来的细节 × 放大倍数。
                # ⭐ 直接看"抠法"抠出来的是什么：应该是纹理，如果大边缘全是白轮廓，
                #   说明这个抠法把结构也算进细节了，替换的时候就会描边。
                emit("hi", np.clip(128.0 + prep["hi_or"] * hi_gain, 0, 255), measure=False)

            self._send(200, {
                "ok": True,
                "images": images,
                "notes": notes,
                "metrics": {
                    "region": region,
                    # ⚠ 目标线 = 放大后原图的锐度。这是补偿【够得着的上限】
                    "origSharp": round(sharpness(ref_o), 2),
                    # 原图没被放大之前的锐度。两个数差多少 = 尺寸这一步吃掉了多少
                    "origNativeSharp": round(orig_native_sharp, 2),
                    "scale": round(scale, 3),
                    "srcSize": src_size,
                    "cover": round(prep["cover"] * 100, 1) if prep else 0,
                    "cells": cells,
                },
                "params": {
                    "alignMode": align_mode, "grid": grid, "maxShift": max_shift,
                    "source": source, "extract": extract,
                    "radius": prep["radius"] if prep else 0,
                    "ksize": prep["ksize"] if prep else 0,
                    "sigma": round(_gauss_sigma(prep["ksize"]), 2) if prep else 0,
                    "confWin": prep["confWin"] if prep else 0,
                    "denoise": denoise, "strength": strength, "gainCap": gain_cap,
                    "lumaOnly": luma_only, "confFloor": conf_floor, "confMode": conf_mode,
                    "full": [W, H],
                },
            })
        except Exception as e:
            traceback.print_exc()
            self._send(200, {"ok": False, "error": str(e)})

    def do_GET(self):
        if self._access_denied():
            return
        if self.path.startswith("/health"):
            self._send(200, {
                "ok": True, "version": VERSION,
                "engine": "match", "script": os.path.realpath(__file__),
                "pid": os.getpid(),
                "launchId": os.environ.get("WHEELCHAIR_ENGINE_LAUNCH_ID", ""),
                "tier": max_tier(), "vramGB": vram_gb(),
                "device": device_name(), "caps": CAPS,
            })
        elif self.path in ("/", "/test"):
            self._send_file("tools/align-test.html")
        elif self.path.startswith("/compare"):
            self._send_file("tools/compare-test.html")
        elif self.path.startswith("/tools/") or self.path.startswith("/ui-pure/"):
            self._send_file(self.path.split("?")[0])
        else:
            self._send(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self._access_denied():
            return
        _t = _timing_begin()
        try:
            return self._do_post_work()
        finally:
            _timing_end(self, _t, "校色")

    def _do_post_work(self):
        # ── 对比台：一次跑完所有方案，并排看差别（2026-09-12）──
        #   ⚠ 这是【实验入口】，主链路不走这里。
        #     参数还没定下来（网格密度、位移上限、高频强度、置信度门槛），
        #     得拿真实的修脸样本看过才知道定多少 ——
        #     凭想象定阈值是之前那个"把脸扭回去"的 bug 的根源。
        if self.path.startswith("/compare"):
            self._handle_compare()
            return
        if not self.path.startswith("/process"):
            self._send(404, {"ok": False, "error": "Not found"})
            return
        try:
            body = _read_limited_body(self)
            if body is None: return

            # ⭐ 两种进图方式（2026-09-12 加二进制版）：
            #
            #   ① multipart 二进制（新，默认走这条）
            #      图片原样是 PNG 字节，不转 base64。
            #      ⚠ 为什么要改：base64 会让体积涨 1/3，而且在【浏览器那一侧】
            #        是 JS 字符串 —— UTF-16 存储再翻一倍。
            #        一张 4K 图：16MB PNG → 21MB base64 → 内存里 42MB。
            #        一批 18 张来回各一次，峰值很可观（docs/21 立的规矩就是
            #        "别把图片变成长字符串搬来搬去"）。
            #
            #   ② JSON + base64（旧，保留兼容）
            #      测试脚本和手工调试还在用，别删。
            ctype = str(self.headers.get("Content-Type") or "")
            if ctype.startswith("multipart/"):
                req, src_bytes, ref_bytes = _parse_multipart(body, ctype)
                src = decode_bytes(src_bytes)
                ref = decode_bytes(ref_bytes)
            else:
                req = json.loads(body or b"{}")
                src = decode(req["src"])
                ref = decode(req["ref"])

            # 尺寸对不齐就把参考图缩过来 —— 抓取和生成的尺寸经常不同
            #
            # ⚠⚠ 但要先记下【长宽比差多少】，因为这次 resize 可能是非等比拉伸。
            #   比例差太多时参考图已经被拉变形，再拿它当基准做几何对齐，
            #   算出来的位移场会去"修正"一个不存在的形变 —— 把好图扭坏。
            #   （2026-09-12 用户实测：贴回去的那块被突兀放大一圈。
            #     主因是网格坐标映射错了，但比例不一致会让它更严重。）
            # ⚠⚠ 优先用【调用方传进来的】比例差（2026-09-12 修）。
            #
            #   自己算的那个在主链路上【永远是 1.000】：ui.html 的
            #   aiColorMatchCanvas 在送进来之前，已经用 drawImage(ref,0,0,w,h)
            #   把参考图非等比拉伸成和回图一样大了。两张图尺寸一致 →
            #   _aspect_mismatch 恒等于 1 → 下面那道 3% 护栏
            #   **从上线到 2026-09-12 一次都没触发过**。
            #   真实比例只有界面那一层知道，所以由它算好传过来。
            #   自己算的那个留作兜底：给测试脚本和手工调试用（它们传的是原始尺寸）。
            aspect_off = float(req.get("aspectOff") or 0) or (
                _aspect_mismatch(src, ref) if CAPS["numpy"] else 1.0)
            if src.shape[:2] != ref.shape[:2]:
                if CAPS["cv2"]:
                    ref = cv2.resize(ref, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_AREA)
                else:
                    raise RuntimeError("两张图尺寸不同，需要 opencv 才能缩放")

            tier = min(int(req.get("tier", 2)), max_tier())
            notes = []
            cur = src

            # ⭐⭐ 2026-10-05（docs/143 §四）：调用方可以要【两张】回来 ——
            #   成品 + 底版（掰正了、没校色）。
            #   ⚠ 为什么要底版：历史卡要显示"没校色的原图"，用户还要能在
            #     「校色版 ↔ 底版」之间切（任务卡那个小眼睛）。缓存里以前只有校色过的，
            #     想回到原样都没数据。
            #   ⚠ 兼容规矩（docs/40 规矩 1）：不传 wantBase 就是老行为，回一张。
            #     测试脚本、手工调试、旧客户端全都不受影响。
            want_base = _truthy(req.get("wantBase"))
            base = None          # 底版：掰正过、没校色

            # ── 对齐（2026-09-12 起默认走网格变形，不再是稠密光流）──
            #
            # ⚠⚠ 为什么默认换成 mesh：
            #   稠密光流每个像素一个位移，**分不清"重采样漂移"和"AI 的有意修改"**。
            #   用户 2026-09-12 实测：AI 修脸时瘦下去的脸、放大的眼睛被全部扭回原样。
            #   网格变形只有 10×10 个控制点且必须连续 —— 它【扭不动】局部改动，
            #   低自由度本身就是安全阀，比任何阈值判据都可靠。
            #
            #   2026-10-24：flow（精确对齐）已删，传 flow 也按 mesh 走。
            # ⭐ 比例差超过 3% = 参考图不是可信的【位置】基准。
            #   所有"看位置"的算法都要关掉，不是只有对齐。
            geo_trust = aspect_off <= 1.03
            align_mode = str(req.get("alignMode", "mesh"))
            if req.get("align", True) and align_mode != "off":
                if not geo_trust:
                    notes.append("跳过对齐 · 两张图长宽比差 %.1f%%，参考图已被拉伸，不是可信基准"
                                 % ((aspect_off - 1) * 100))
                else:
                    cur, _ = mesh_warp(cur, ref, notes)

            # ⭐⭐ 底版就是这里 —— 【对齐做完、校色还没做】的那个瞬间（docs/143 §二 §四）。
            #
            #   ⚠⚠ 必须是 .copy()，不能只赋值：下面 color_lowfreq / detail_transfer
            #     的返回都是新数组（看着安全），但这一条是【结构性】保险 ——
            #     只要有一处是就地改的，底版就被校色污染了，而且是静默的
            #     （用户拿到的"底版"其实已经校过色，他还以为能切回原样）。
            #     代价是多一份 4K float32 ≈ 96MB，只在请求了 wantBase 时才付。
            #   ⚠ 三种情况（docs/143 §二-2.2）：
            #     ① 正常掰正过 → base = 掰正后的图
            #     ② 跳过对齐（比例差 >3%）→ base = 原样（跟 cur 此刻相同，如实存）
            #     ③ 没校色（color=false）→ base 和成品一样，但两张都回，元数据如实标
            if want_base:
                base = cur.copy()

            # ── 细节补偿：用原图高频补回重采样损失的锐度 ──
            # ⚠ 必须排在校色【之前】：它换的是高频，校色换的是低频，
            #   先补高频再换低频两者互不干扰；反过来高频叠加会把刚校准的颜色带偏。
            # ⚠⚠ 默认 **False**（2026-09-12 改）。以前默认 True。
            #   实测它在真实样本上让锐度从 12.86 掉到 11.93 —— 比不补还糊。
            #   调用方（match-engine.js）不传就是不做，这是刻意的：
            #   宁可少做一步，也不能默认帮倒忙。
            if req.get("detailBoost", False):
                # ⚠ 细节补偿也是【看位置】的（它用光流把原图搬到对应位置再取高频）。
                #   基准图被非等比拉伸之后，搬过去的细节落在错的地方 → 鬼影。
                #   所以和对齐一样，比例对不上就别做。
                if not geo_trust:
                    notes.append("跳过细节补偿 · 长宽比差太多，原图不是可信的位置基准")
                else:
                    # ⭐⭐ 2026-10-05（docs/143 §八-3③）：要【增量层】还是【合成好的图】。
                    #   ⚠ 不传就是老行为（合成好的一张），老客户端/测试脚本不受影响（docs/40 规矩 1）。
                    #   ⚠ 要增量层时 cur 变成 4 通道 RGBA —— 所以下面那步【必须跳过校色】
                    #     （color_lowfreq 只认 3 通道，喂 4 通道会炸）。
                    #     逻辑上也成立：增量层是叠在【已经校过色的成品】上方的，
                    #     它自己不需要再被校色。前端那条路本来就传 color=false。
                    as_layer = _truthy(req.get("detailLayer"))
                    cur, _ = detail_transfer(
                        cur, ref, notes,
                        strength=float(req.get("detailStrength", 1.0)),
                        conf_floor=float(req.get("detailConfFloor", 0.20)),
                        radius=(int(req["detailRadius"]) if req.get("detailRadius") else None),
                        denoise=bool(req.get("detailDenoise", False)),
                        # 'replace' 细节还原档 / 'gain' 轻微增强档（用户定的两个档位）
                        mode=str(req.get("detailMode", "replace")),
                        as_layer=as_layer)
                    if as_layer and req.get("color", True):
                        notes.append("要增量层，已跳过校色（增量层叠在成品上方，不需要再校色）")
                        req = dict(req); req["color"] = False
            if req.get("color", True):
                # ⭐⭐ 2026-10-05（docs/143 §十二）：主链路【只走混合判据】。
                #   精准(lowfreq) / 整体(MKL) 两档已砍掉 —— 用户原话
                #   "把之前的校色算法全都干飞掉"。
                #
                #   ⚠ 为什么比例对不上时不再降级到 MKL：
                #     混合判据【两个判据都是按位置算的】，参考图被拉伸就没有可信位置。
                #     这时候降级到 MKL 等于"用一种没法判断内容有没有变的方法硬搬颜色"，
                #     正是鬼影的来源。⇒ 直接【跳过校色】并如实说明。
                #     （用户 2026-09-12 复现过：选区 16:9 + 生图比例 1:1 → 整张发雾。）
                # ⭐⭐⭐ 2026-10-08（docs/170 §4.6）：重新读 method，分发三种校色方式。
                #   · 'global'  → color_mkl      （全局：整张图按颜色统计配平，【不看位置】）
                #   · 'precise' → color_lowfreq  （精准：按位置搬原图的大块颜色）
                #   · 'hybrid'  → color_hybrid   （混合：精准 + 两道阀门）
                #   ⚠ 不传就按 'hybrid' —— 兼容老前端（05 之后前端一直在传，但引擎没读）。
                #   ⚠ 三种的函数都【早就在文件里】（两个标了"已停用·仅实验台"），
                #     本次只是把主链路的分发改回来，算法一行没动。
                method = str(req.get("method") or "hybrid").strip().lower()
                if method not in ("global", "precise", "hybrid"):
                    notes.append("认不出校色方式「%s」，按混合判据算" % method)
                    method = "hybrid"
                # ⚠ 比例不符时：全局【照跑】，精准/混合【跳过】。
                #   依据 docs/33 §10.3 那张对照表：
                #     对齐 / 细节补偿 / 精准校色 —— 都【看位置】⇒ 拉伸时致命
                #     整体校色(MKL)             —— 【不看位置】⇒ 免疫
                #   9-12 用户实测那次"整张发白雾、十张全坏"，真因就是"看位置"的精准校色
                #   在拉伸过的基准上搬颜色（额头颜色盖到眼睛上）。当年的修法原文就是
                #   "精准校色自动降级成整体校色"（docs/33 §10.4）。
                if not geo_trust and method != "global":
                    notes.append("跳过校色 · 长宽比差 %.1f%%，参考图已被拉伸，"
                                 "位置对不上（%s按位置判内容有没有变）"
                                 % ((aspect_off - 1) * 100,
                                    "混合判据" if method == "hybrid" else "精准校色"))
                else:
                    if not geo_trust and method == "global":
                        notes.append("比例对不上，已改用整体校色（它不看位置，对拉伸免疫）")
                    if method == "global":
                        cur = color_mkl(cur, ref, notes)
                    elif method == "precise":
                        cur = color_lowfreq(cur, ref, notes)
                    else:
                        cur = color_hybrid(cur, ref, notes)
            # ⚠ 默认【不做】无缝融合（2026-09-12 停用，原因见 seamless() 的注释）。
            #   默认值从 True 改成 False —— 调用方不传就是不做。
            if tier >= 3 and req.get("seamless", False):
                cur = seamless(cur, ref, notes)

            # ⭐ 回图也走二进制（2026-09-12）。只改进不改出等于只省了一半。
            #   结果元数据(档位/notes)放 HTTP 头，图片本体是 PNG 原始字节。
            #   ⚠ 头里不能直接塞中文 —— HTTP 头是 latin-1，中文会抛异常。
            #     先 JSON 再 URL 编码，前端 decodeURIComponent 还原。
            if ctype.startswith("multipart/"):
                if want_base and base is not None:
                    # ⭐⭐ 两张一起回（docs/143 §四-2.2）。容器格式【长度前缀】：
                    #
                    #     [4 字节大端] 第一张(成品) PNG 长度 L1
                    #     [L1 字节]    成品 PNG
                    #     [剩余全部]   底版 PNG
                    #
                    #   ⚠ 为什么不用 multipart 响应：引擎是 http.server，默认 HTTP/1.0
                    #     没有 chunked，响应体必须一次写完 + 准确的 Content-Length。
                    #     multipart 要靠边界串自己拼，客户端还得流式解析 —— 自找麻烦。
                    #   ⚠ 为什么不用 base64 塞进 JSON：docs/21 立的规矩，
                    #     4K 图 base64 之后 JS 侧内存翻倍（字符串是 UTF-16）。
                    png = encode_bytes(cur)
                    png_base = encode_bytes(base)
                    # ⚠ 两张先都编码好再算长度 —— HTTP/1.0 必须给出准确的总长度。
                    #   代价：这两份 PNG 字节同时在内存里（4K 约 10MB 量级），
                    #   比下面那个 float32 数组小得多，可以先放 float 那两份。
                    del base
                    head = struct.pack(">I", len(png))
                    body = head + png + png_base
                    meta_json = json.dumps(
                        {"ok": True, "tier": tier, "notes": notes, "hasBase": True},
                        ensure_ascii=False)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("X-Match-Meta", quote(meta_json))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "X-Match-Meta")
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    png = encode_bytes(cur)
                    meta_json = json.dumps(
                        {"ok": True, "tier": tier, "notes": notes, "hasBase": False},
                        ensure_ascii=False)
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(png)))
                    self.send_header("X-Match-Meta", quote(meta_json))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "X-Match-Meta")
                    self.end_headers()
                    self.wfile.write(png)
            else:
                out = {"ok": True, "tier": tier, "notes": notes, "image": encode(cur)}
                if want_base and base is not None:
                    # ⚠ JSON 通道也带上底版 —— 测试脚本/手工调试走的就是这条，
                    #   不让它成为"两条通道行为不一致"的坑（本项目栽过好几次）。
                    out["baseImage"] = encode(base)
                    out["hasBase"] = True
                self._send(200, out)
        except Exception as e:
            traceback.print_exc()
            # ⚠ 失败也要给结构化回复：桌面板靠它决定"回落档 1"，
            #   给个 500 空 body 的话那边只能猜。
            self._send(200, {"ok": False, "error": str(e)})


def main():
    # ⚠ 顺序：先把硬件信息查好，再开始监听。
    #   反过来的话，第一个请求会撞上 CUDA 初始化那几秒，探活直接超时。
    _probe_hardware()
    t = max_tier()
    print("=" * 56)
    print(" 修图轮椅 · 校色/对齐引擎  v%s" % VERSION)
    print("=" * 56)
    print(" 设备      : %s" % device_name())
    if vram_gb():
        print(" 显存      : %s GB" % vram_gb())
    print(" 已装组件  : %s" % ", ".join(k for k, v in CAPS.items() if v) or "(无)")
    print(" 可用档位  : 档 %d" % t)
    if t < 3:
        print("")
        print(" 想要更强：")
        if not CAPS["numpy"]:
            print("   pip install numpy pillow          → 开启档 2 校色")
        if not CAPS["cv2"]:
            print("   pip install opencv-python         → 开启稠密对齐（强烈推荐）")
        if not CAPS["cuda"]:
            print("   装 CUDA 版 torch + 20G 以上显存   → 开启档 3 无缝融合")
    print("")
    print(" 监听      : http://127.0.0.1:%d  (仅本机)" % PORT)
    print("")
    print(" 测试台    : http://127.0.0.1:%d/test" % PORT)
    print("             ! 要从这个地址打开，别去双击 align-test.html --")
    print("               双击走的是 file:// 协议，浏览器会禁止它访问本引擎，")
    print("               页面上会显示「引擎不可用：Failed to fetch」。")
    print("")
    print(" 关掉这个窗口即可停止；不启动它，桌面板会自动用档 1。")
    print("=" * 56)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止。")
        sys.exit(0)
