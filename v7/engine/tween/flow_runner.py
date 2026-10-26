# -*- coding: utf-8 -*-
"""过渡帧计算（tween）。

做什么：给两张【尺寸完全一样】的图（起点 A、终点 B），在它们之间算出一串过渡帧。
用处：界面上的滚轮调强度 —— 0% 看 A、100% 看 B，中间档位在已算好的帧里切，零延迟。

设计要点（都对着实测数字定的，见 docs/132 §七）：
  1. 模型只加载一次，缓存在显存里（加载一次 ~330ms，不能每请求重载）
  2. 批大小按分辨率选：1024² 用批 4（快 1.5×），2048² 用批 1（批 4 反而慢 8%）
  3. 可以只回传【原始像素】不编 PNG —— 预览这条路省掉编解码（~236ms）
"""
from __future__ import annotations

import os
import threading
import time

import numpy as np

_lock = threading.Lock()
# ⭐ 2026-10-26（云端调强度并发 4 → 8，用户：「调强度几乎是秒算，能不能做更大并发」）：上显卡那一步一次只算一单。
#   门卫放 8 单进来，原来是 8 个线程无锁共用一份模型同时往卡上推 —— 卡只有一张，并发不会更快，只会一起抢显存（同卡还跑着开源模型出图）。
#   ⚠ 等锁有上限：等不到就照老办法直接算（退回原来的并发），免得万一有一单卡死在卡上，后面所有单都跟着锁死。
_GPU_LOCK = threading.Lock()
_GPU_WAIT_S = float(os.environ.get("WHEELCHAIR_TWEEN_GPU_WAIT_S") or 20)
_MODEL = None
_MODEL_KEY = None
_MODEL_ERROR = ""

# ⚠ 显存不够时的兜底：批大小不能无脑往上加
_BATCH_BY_SIDE = (
    (1280, 4),      # ≤1280px 用批 4（实测 1024² 快 1.5×）
    (4096, 1),      # 再大用批 1（实测 2048² 批 4 反而慢 8%）
)


def pick_batch(side):
    """按最长边选批大小。实测依据见 docs/132 §7.1。"""
    for limit, batch in _BATCH_BY_SIDE:
        if side <= limit:
            return batch
    return 1


# ═══════════════════════════════════════════════════════════
#  设备 / 显存
# ═══════════════════════════════════════════════════════════
def _device(force_cpu=False):
    """本机可用计算设备。

    ⚠⚠⚠ 2026-10-08（docs/170 §13.1 R1）：**没显卡时必须走 CPU，而且精度必须跟着换**。
    这个函数原来只看 torch.cuda.is_available()，于是"有显卡但显存不够"的用户
    也会被选到显卡上跑（可能爆显存）。现在多一个 force_cpu，
    让调用方能在"显存不够"时明确要求走 CPU（docs/170 §13.1 R2 第 3 条）。
    """
    import torch
    if force_cpu:
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def default_dtype(dev=None):
    """按【设备】决定精度。

    ⚠⚠⚠ 2026-10-08（docs/170 §13.1 R1）：这是本次修的那个【崩溃级】bug。

      改之前：tween() 的 dtype 默认写死 "float16"。
        没显卡的机器上，float16 在 CPU 上跑这个网络会：
          · 256×256   → **访问冲突 / 段错误**（实测退出码 0xC0000005，复现多次）
          · 报 RuntimeWarning: invalid value encountered in cast（结果里有 NaN）
        段错误接不住 ⇒ 整个抠像引擎进程一起死（抠像、人体解析陪葬）。

      ⇒ 精度必须跟着设备走：cuda 用 float16（快、显存省），
        CPU 用 float32（CPU 上 float16 既慢又崩 —— 实测 512 尺寸 float16 直接段错误）。

    ⚠ 这个写法照的是同项目已有的先例：
      engine/multi_engine_server.py:754 与 :1336
        dtype = torch.float16 if dev == "cuda" else torch.float32
    """
    if dev is None:
        dev = _device()
    return "float16" if str(dev) == "cuda" else "float32"


def free_vram_gb():
    """返回 (free, total)，单位 GiB。没显卡返回 (0,0)。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return 0.0, 0.0
        free, total = torch.cuda.mem_get_info()
        return free / (1024 ** 3), total / (1024 ** 3)
    except Exception:
        return 0.0, 0.0


def unload():
    """清掉缓存的模型，把显存还回去。"""
    global _MODEL, _MODEL_KEY, _MODEL_ERROR
    with _lock:
        _MODEL = None
        _MODEL_KEY = None
        _MODEL_ERROR = ""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════
#  模型加载（只加载一次）
# ═══════════════════════════════════════════════════════════
# 支持的权重 -> 结构代号。新权重放进来只需在这里加一行。
_WEIGHT_LAYOUT = {
    "base": "d7",
}
DEFAULT_WEIGHT = "base"


def _weights_path(models_dir, weight):
    return os.path.join(models_dir, "tween", "%s.pth" % weight)


def load_flow(models_dir, weight=DEFAULT_WEIGHT, dtype=None, force_cpu=False):
    """加载并缓存模型。第二次调用直接返回缓存（省 ~330ms）。"""
    global _MODEL, _MODEL_KEY, _MODEL_ERROR
    import torch

    if dtype is None:
        dtype = default_dtype(_device(force_cpu))
    key = (weight, dtype, str(_device(force_cpu)))
    with _lock:
        if _MODEL is not None and _MODEL_KEY == key:
            return _MODEL

        path = _weights_path(models_dir, weight)
        if not os.path.isfile(path):
            _MODEL_ERROR = "缺少过渡帧权重：%s" % path
            raise RuntimeError(_MODEL_ERROR)

        # ⚠ 架构文件按【文件路径】加载，不走包 import ——
        #   包 import 会把它旁边的依赖一起拖进来，多一层不必要的耦合。
        import importlib.util as ilu
        arch = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flow_arch.py")
        spec = ilu.spec_from_file_location("_tween_arch", arch)
        mod = ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)

        layout = _WEIGHT_LAYOUT.get(weight)
        if not layout:
            raise RuntimeError("未知的过渡帧权重：%s" % weight)

        # ⚠ 认不出的 dtype 一律当 float32（保守）——
        #   原来回落 float16，那正是会崩的那个（R1）。
        dt = {"float16": torch.float16, "float32": torch.float32}.get(dtype, torch.float32)
        sd = torch.load(path, weights_only=False, map_location="cpu")
        model = mod.FlowNet(layout=layout)
        # ⚠ 用 strict=True：权重和结构对不上时必须【当场报错】，
        #   不许静默装成"加载成功但一半随机权重"（那就是铁律 17 说的静默失效）。
        model.load_state_dict(sd, strict=True)
        model = model.to(dt).eval().to(_device(force_cpu))

        _MODEL = model
        _MODEL_KEY = key
        _MODEL_ERROR = ""
        return model


def warmup(models_dir, weight=DEFAULT_WEIGHT):
    """预热：加载模型 + 跑一次小图，避开第一枪的固定开销。"""
    try:
        m = load_flow(models_dir, weight)
        import torch
        dt = next(m.parameters()).dtype
        a = torch.zeros(1, 3, 64, 64, dtype=dt, device=_device())
        ts = torch.tensor([0.5], dtype=dt, device=_device()).view(-1, 1, 1, 1)
        with torch.inference_mode():
            m(a, a, ts, [8, 4, 2, 1], True, True)
        return True, ""
    except Exception as e:
        return False, str(e)


# ═══════════════════════════════════════════════════════════
#  主计算
# ═══════════════════════════════════════════════════════════
def tween(arr_a, arr_b, steps=16, models_dir=None, weight=DEFAULT_WEIGHT,
          dtype=None, want_png=False, batch=None, progress=None, force_cpu=False, only=None):
    """算过渡帧。

    参数
      arr_a / arr_b : np.uint8，形状 (H,W,3)，两张必须尺寸一致
      steps         : 中间帧数量。steps=16 → 一共回 18 张（含首尾）
      want_png      : True 时把每帧也编成 PNG 字节（回传用）；
                      False 只回像素数组（预览用，省 ~236ms 编解码）
      batch         : 每批算几帧；None = 按分辨率自动选（实测依据见 docs/132 §7.1）
      only          : ⭐ 2026-10-19（docs/249）只要第几帧（0..steps+1）。只算【包含它的那一批】，
                      别的帧位置填 None。⚠ 为什么按批算而不是只算那一个时刻：批的分组跟全算时一模一样，
                      结果才能逐字节相同（单独算一个时刻，float16 下可能差最低位）。

    返回 dict：
      frames    : [np.uint8 (H,W,3)]，共 steps+2 张，第 0 张 = A、最后一张 = B（only 时没算的是 None）
      pngs      : [bytes]（want_png=True 才有）
      width/height/steps/batch/ms
    """
    import torch

    if models_dir is None:
        raise ValueError("没指定模型目录")
    a = np.ascontiguousarray(arr_a)
    b = np.ascontiguousarray(arr_b)
    if a.shape != b.shape:
        raise ValueError("两张图尺寸必须一致：收到 %s 和 %s" % (a.shape, b.shape))
    if a.ndim != 3 or a.shape[2] != 3:
        raise ValueError("要的是 (高,宽,3) 的 RGB 图，收到 %s" % (a.shape,))
    steps = int(steps)
    if steps < 1:
        raise ValueError("中间帧数量至少 1")
    if steps > 64:
        raise ValueError("中间帧数量最多 64")

    h, w = a.shape[:2]
    side = max(h, w)
    if batch is None:
        batch = pick_batch(side)

    t0 = time.time()
    # ⚠⚠⚠ 2026-10-08（docs/170 §13.1 R1）：dtype 不传时【按设备】定，不再写死 float16。
    #   写死 float16 会让没显卡的机器在 CPU 上跑到段错误（整进程崩）。
    if dtype is None:
        dtype = default_dtype(_device(force_cpu))
    model = load_flow(models_dir, weight, dtype, force_cpu=force_cpu)
    t_load = time.time()

    dt = next(model.parameters()).dtype
    dev = _device()

    def to_tensor(x):
        return torch.from_numpy(x.astype(np.float32) / 255.0).permute(2, 0, 1)[None].to(dt).to(dev)

    t_wait = time.time()
    locked = _GPU_LOCK.acquire(timeout=_GPU_WAIT_S)
    t_locked = time.time()
    try:
        out = _infer(torch, model, to_tensor(a), to_tensor(b), dt, dev, steps, batch, only, progress)
    finally:
        if locked:
            _GPU_LOCK.release()
    t_infer = time.time()

    frames = [a] + out + [b]

    pngs = None
    if want_png:
        from PIL import Image
        import io as _io
        pngs = []
        for f in frames:
            if f is None:
                pngs.append(None)
                continue
            buf = _io.BytesIO()
            Image.fromarray(f, mode="RGB").save(buf, format="PNG", compress_level=1)
            pngs.append(buf.getvalue())
    t_png = time.time()

    return {
        "frames": frames,
        "pngs": pngs,
        "width": w,
        "height": h,
        "steps": steps,
        "batch": batch,
        "ms": {
            "load": round((t_load - t0) * 1000),
            "infer": round((t_infer - t_load) * 1000),
            "png": round((t_png - t_infer) * 1000),
            "total": round((t_png - t0) * 1000),
            # 等显卡锁用了多久（算在 infer 里）；lockSkipped=1 = 等满 _GPU_WAIT_S 没等到、照老办法直接算了（说明前面有单子卡住）
            "gpuWait": round((t_locked - t_wait) * 1000),
            "lockSkipped": 0 if locked else 1,
        },
    }


def _infer(torch, model, ta, tb, dt, dev, steps, batch, only, progress):
    scale_list = [8, 4, 2, 1]
    out = []
    n_done = 0
    with torch.inference_mode():
        # ── 按批算：一批 batch 个时间点 ──
        ts_all = [i / float(steps + 1) for i in range(1, steps + 1)]
        for start in range(0, len(ts_all), batch):
            chunk = ts_all[start:start + batch]
            k = len(chunk)
            # ⭐ only：不包含要的那一帧的批【整批跳过】（帧号 = 批内序号 + 1，0 和 steps+1 是两张原图，不用算）
            if only is not None and not (start + 1 <= int(only) <= start + k):
                out.extend([None] * k)
                continue
            # 把同一对图复制 k 份，配 k 个不同时间点 → 一次前向出 k 帧
            aa = ta.expand(k, -1, -1, -1)
            bb = tb.expand(k, -1, -1, -1)
            tst = torch.tensor(chunk, dtype=dt, device=dev).view(-1, 1, 1, 1)
            res = model(aa, bb, tst, scale_list, True, True)
            res = res.clamp(0, 1)
            arr = (res.float().permute(0, 2, 3, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
            for i in range(k):
                out.append(arr[i])
                n_done += 1
                if progress:
                    progress(n_done, steps)
    return out
