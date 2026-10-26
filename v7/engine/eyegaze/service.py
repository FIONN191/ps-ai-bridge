# -*- coding: utf-8 -*-
"""
眼神调整（眼珠随动）· 引擎这一半（2026-10-25，docs/290）

引擎路由 POST /eyegaze/prepare 调这里：一张人像 → 每只眼一组图层（PNG base64），界面拿去实时叠图。
  body  = 图片字节（PNG / JPEG）
  query = up=1|2|3（先放大再算，小眼睛更稳）· ov={"R":[x,y,r],"L":[x,y,r]}（手动调好的眼珠圈，处理后坐标）

⚠ 跟原型 tools/eyegaze/server.py 的 save_session 一个意思，区别只有两处：
  · 不落盘，图层直接塞进回包（每只眼一小块，几十 KB）；
  · 底图不回整张：只回两只眼那块（base / orig 各按 crop 裁）—— 整张原图界面手里本来就有，传回 PS 也只贴眼部。
⚠ MediaPipe 的检测器不保证多线程安全：一次只跑一张（_LOCK，原型同款）。
⚠ mediapipe 不在用户的运行库里，跟着安装包放在 pydeps/（1.9.21 起，见下面 PYDEPS）。import 放在调用时：缺了引擎照样能起，只是这条路由报「缺组件」。
"""
import os
import sys
import time
import json
import base64
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
# ⭐ 1.9.21：mediapipe 跟着安装包走（engine/eyegaze/pydeps/，tools/build-eyegaze-pydeps.py 生成）—— 用户的运行库里没有它。
#   只带 mediapipe 本体（62MB），不带 matplotlib / sounddevice / fonttools 等十几个声称要的依赖（实测眼神调整用不上）；
#   加在最后：运行库自己装了的包（开发机）优先，不被这里盖住
PYDEPS = os.path.join(HERE, "pydeps")
if os.path.isdir(PYDEPS) and PYDEPS not in sys.path:
    sys.path.append(PYDEPS)


def _stub_matplotlib():
    """mediapipe 的 vision 包一导入就 import matplotlib.pyplot（只有画 3D 关键点图的函数用），组件包里不带它 ⇒ 没装就塞个空壳。"""
    import importlib.util
    import types
    if "matplotlib" in sys.modules or importlib.util.find_spec("matplotlib") is not None:
        return
    mpl, plt = types.ModuleType("matplotlib"), types.ModuleType("matplotlib.pyplot")
    mpl.pyplot = plt
    sys.modules["matplotlib"], sys.modules["matplotlib.pyplot"] = mpl, plt

_LOCK = threading.Lock()
MAX_UP = 3.0
RNG_SEED = 20261025
WORK_MAX = 4096          # 放大后长边上限（原型同款，兜住内存和速度）


class EyeGazeError(Exception):
    """给用户看的错（找不到脸、图读不出来…）：回 422，不打堆栈。"""
    code = "EYEGAZE_UNUSABLE"


def available(has_landmarks=False):
    """这台机器能不能跑：mediapipe 在（运行库里或 pydeps/）+ 模型文件在。只查不 import（import mediapipe 要一两秒）。

    1.9.21 起：界面传来 landmarks 时（has_landmarks=True），不再要求 mediapipe（界面已跑网页版 MediaPipe）；只检查模型文件。
    """
    import importlib.util
    if not has_landmarks and importlib.util.find_spec("mediapipe") is None:
        return False, "软件少了人脸识别组件（engine/eyegaze/pydeps），眼神调整用不了。重新安装最新版软件后再试。"
    if not os.path.isfile(os.path.join(HERE, "face_landmarker.task")):
        return False, "引擎少了人脸关键点模型（engine/eyegaze/face_landmarker.task），重新安装软件后再试。"
    return True, ""


def _png_b64(arr):
    import cv2
    ok, buf = cv2.imencode(".png", arr)
    if not ok:
        raise IOError("PNG 编码失败")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def prepare(raw, up=1.0, overrides=None, landmarks=None):
    """准备眼神调整图层（1.9.21 起可选 landmarks：界面传来的归一化关键点 [[x,y], ...]，不再在引擎里跑 mediapipe）"""
    import numpy as np
    import cv2
    import eyelib
    if landmarks is None:
        # 旧路线（1.9.20 及之前）：引擎里跑 mediapipe，需要空壳顶上
        _stub_matplotlib()

    def u8(a):
        return np.clip(np.asarray(a, np.float32) * 255 + 0.5, 0, 255).astype(np.uint8)

    # 照 eyelib.load_image：长边 > 2048 先等比缩小（功能限定 2048 以内）。自己解码是为了留住送进来的原尺寸
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise EyeGazeError("图片读不出来")
    h0, w0 = img.shape[:2]
    s = 2048.0 / float(max(h0, w0))
    if s < 1.0:
        img = cv2.resize(img, (int(round(w0 * s)), int(round(h0 * s))), interpolation=cv2.INTER_AREA)
    up = float(up or 1.0)
    if up > 1.01:
        hh, ww = img.shape[:2]
        up = min(up, MAX_UP, WORK_MAX / float(max(hh, ww)))
        if up > 1.01:
            img = cv2.resize(img, (int(round(ww * up)), int(round(hh * up))), interpolation=cv2.INTER_LANCZOS4)
    t0 = time.time()
    with _LOCK:
        # ⚠ eyelib 里的 GrabCut 有随机初始化：不定种子的话，同一张图连跑两次「复原误差」都会差零点几（10-25 实测 s04 左眼 3.30 / 3.49）。
        #   定死种子 ⇒ 同一张图、同一组参数，每次结果一样（手动调圈重做时也不会因为随机数换个样子）
        cv2.setRNGSeed(RNG_SEED)
        try:
            meta, base_full = eyelib.prepare(img, overrides, landmarks_normalized=landmarks)
        except ValueError as e:
            raise EyeGazeError(str(e))
    dt = time.time() - t0
    H, W = img.shape[:2]
    eyes = []
    for e in meta["eyes"]:
        L = e.pop("_layers")
        x0, y0, cw, ch = [int(v) for v in e["crop"]]
        sdf = np.clip(128 + L["sd"] * eyelib.SDF_SCALE + 0.5, 0, 255).astype(np.uint8)
        ta = u8(L["tex_a"])
        # ⚠ 和原型一样：多张单通道图塞进一张不透明 RGB（带透明通道的 PNG 浏览器会预乘、吃精度）。cv2 写的是 BGR，所以 RGB 要倒过来塞
        e["layers"] = {
            "base": _png_b64(base_full[y0:y0 + ch, x0:x0 + cw]),
            "orig": _png_b64(img[y0:y0 + ch, x0:x0 + cw]),
            "maps1": _png_b64(np.dstack([u8(L["white"]), sdf, u8(L["S"])])),
            "maps2": _png_b64(np.dstack([np.zeros_like(sdf), u8(L["catch_a"]), u8(L["lash_a"])])),
            "tex_raw": _png_b64(u8(L["tex_raw"])),      # eyelib 里本来就是 BGR，直接写
            "tex_flat": _png_b64(u8(L["tex_flat"])),
            "tex_a": _png_b64(np.dstack([ta, ta, ta])),
        }
        for k in ("poly0",):
            e.pop(k, None)
        eyes.append(_jsonable(e))
    # scale = 处理用的图 / 送进来的图（界面拿它把眼部那块换算回 PS 坐标）
    return {"ok": True, "w": W, "h": H, "inW": w0, "inH": h0, "scale": (W / float(w0)) if w0 else 1.0,
            "faces": meta.get("faces", 0), "seconds": round(dt, 2), "sdfScale": eyelib.SDF_SCALE, "eyes": eyes}


def _jsonable(v):
    import numpy as np
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def parse_overrides(text):
    """?ov= 的 JSON → {"R": [x,y,r], "L": [...]}；不合法的条目丢掉（原型同款判据）。"""
    if not text:
        return None
    raw = json.loads(text)
    out = {k: [float(v[0]), float(v[1]), float(v[2])] for k, v in raw.items()
           if k in ("R", "L") and isinstance(v, list) and len(v) == 3 and float(v[2]) > 1}
    return out or None
