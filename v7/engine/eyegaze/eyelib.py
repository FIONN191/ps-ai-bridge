# -*- coding: utf-8 -*-
"""
眼珠随动 · 核心算法 (eyelib.py)
————————————————————————————————
只算一次的"准备"都在这里：
  1. 找眼睛（MediaPipe 人脸关键点，自带眼珠点）
  2. 精修眼珠圆（Daugman 圆周积分，按"和眼白的颜色差"找边；两只眼一起定半径）
  3. 眼眶蒙版（关键点轮廓 → 平滑曲线 → 距离场，前端自己收缩/羽化）
  4. 抠眼珠 + 补全（极坐标展开，缺的角度用两边看得见的镜像抄过来）
  5. 摘眼神光（单独一层，前端按比例跟随）
  6. 挡在眼球前面的东西（睫毛、眼皮边、内眼角）单独一层，永远盖在最上面
  7. 眼白补洞 + 明暗图（只用眼白像素、横着取色，不会把眼皮的暗色抹进来）

前端只负责把这几层叠起来，所以拖滑块是实时的。
"""
import os
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
# ⚠ V7 引擎版（10-25 从 tools/eyegaze/eyelib.py 原样搬来，只改了这一行）：模型和代码放在同一个目录，跟着引擎脚本一起进安装包
MODEL_PATH = os.path.join(HERE, "face_landmarker.task")

# MediaPipe 478 点里的眼眶轮廓：从外眼角沿上眼皮到内眼角，再沿下眼皮回来
# ⚠ "右眼"指人物自己的右眼（在照片里是左边那只）
EYE_UPPER = {
    "R": [33, 246, 161, 160, 159, 158, 157, 173, 133],
    "L": [263, 466, 388, 387, 386, 385, 384, 398, 362],
}
EYE_LOWER = {
    "R": [133, 155, 154, 153, 145, 144, 163, 7, 33],
    "L": [362, 382, 381, 380, 374, 373, 390, 249, 263],
}
IRIS_GROUPS = [list(range(468, 473)), list(range(473, 478))]  # [圆心, 4个边点] × 2

SDF_SCALE = 8.0  # 距离场存成 8 位：128 + 距离×8 → ±16 像素，精度 1/8 像素

_landmarker = None


def _get_landmarker():
    global _landmarker
    if _landmarker is None:
        from mediapipe.tasks.python import vision, BaseOptions
        opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=4,
            min_face_detection_confidence=0.3,
            min_face_presence_confidence=0.3,
        )
        _landmarker = vision.FaceLandmarker.create_from_options(opts)
    return _landmarker


def load_image(path_or_bytes, max_side=2048):
    """读图 → BGR uint8，长边超过 max_side 就等比缩小（功能本来就限定 2048 以内）"""
    if isinstance(path_or_bytes, (bytes, bytearray)):
        arr = np.frombuffer(path_or_bytes, np.uint8)
    else:
        arr = np.fromfile(path_or_bytes, np.uint8)  # 路径里有中文时 cv2.imread 会失败
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("图片读不出来")
    h, w = img.shape[:2]
    s = max_side / float(max(h, w))
    if s < 1.0:
        img = cv2.resize(img, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    return img


def detect_faces(bgr, landmarks_normalized=None):
    """返回每张脸的两只眼：{side, upper, lower, iris_c, iris_r, corners}；按脸大小从大到小排

    landmarks_normalized: 可选，已经算好的归一化关键点 (N, 478, 2) 或 [(478, 2), ...]，跳过 mediapipe 检测（1.9.21 起界面里跑网页版 MediaPipe）
    """
    h, w = bgr.shape[:2]
    if landmarks_normalized is not None:
        # 界面传来的归一化坐标 → 像素坐标（1.9.21 起，界面里跑网页版 MediaPipe，不再依赖引擎的 mediapipe）
        lms_list = np.asarray(landmarks_normalized, np.float32)
        if lms_list.ndim == 2:
            lms_list = lms_list[None, :, :]  # (478, 2) → (1, 478, 2)
        faces = []
        for lms_norm in lms_list:
            if len(lms_norm) < 478:
                continue
            pts = lms_norm.copy()
            pts[:, 0] *= w
            pts[:, 1] *= h
            pts = pts.astype(np.float32)
            eyes = {}
            for side in ("R", "L"):
                up = pts[EYE_UPPER[side]]
                lo = pts[EYE_LOWER[side]]
                eyes[side] = {"side": side, "upper": up, "lower": lo,
                              "corners": np.array([up[0], up[-1]], np.float32)}
            # 眼珠点按离哪只眼近来分
            for g in IRIS_GROUPS:
                c = pts[g[0]]
                r = float(np.mean(np.linalg.norm(pts[g[1:]] - c, axis=1)))
                side = min(("R", "L"), key=lambda s: np.linalg.norm(
                    np.vstack([eyes[s]["upper"], eyes[s]["lower"]]).mean(0) - c))
                eyes[side]["iris_c"] = c.copy()
                eyes[side]["iris_r"] = r
            span = pts.max(0) - pts.min(0)
            faces.append({"eyes": [eyes["R"], eyes["L"]], "size": float(span.max()), "pts": pts})
        faces.sort(key=lambda f: -f["size"])
        return faces

    # 旧路线：引擎里跑 mediapipe（1.9.20 及之前）
    import mediapipe as mp
    rgb = np.ascontiguousarray(bgr[:, :, ::-1])
    res = _get_landmarker().detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    faces = []
    for lms in res.face_landmarks or []:
        pts = np.array([[p.x * w, p.y * h] for p in lms], np.float32)
        if len(pts) < 478:
            continue  # 没带眼珠点的旧模型
        eyes = {}
        for side in ("R", "L"):
            up = pts[EYE_UPPER[side]]
            lo = pts[EYE_LOWER[side]]
            eyes[side] = {"side": side, "upper": up, "lower": lo,
                          "corners": np.array([up[0], up[-1]], np.float32)}
        # 眼珠点按离哪只眼近来分（不去背"468 是哪只眼"）
        for g in IRIS_GROUPS:
            c = pts[g[0]]
            r = float(np.mean(np.linalg.norm(pts[g[1:]] - c, axis=1)))
            side = min(("R", "L"), key=lambda s: np.linalg.norm(
                np.vstack([eyes[s]["upper"], eyes[s]["lower"]]).mean(0) - c))
            eyes[side]["iris_c"] = c.copy()
            eyes[side]["iris_r"] = r
        span = pts.max(0) - pts.min(0)
        faces.append({"eyes": [eyes["R"], eyes["L"]], "size": float(span.max()), "pts": pts})
    faces.sort(key=lambda f: -f["size"])
    return faces


def eye_metrics(eye):
    """给挑测试图用：眼宽、睁眼程度（上下眼皮间距/眼宽）、眼珠半径"""
    up, lo = eye["upper"], eye["lower"]
    width = float(np.linalg.norm(up[0] - up[-1]))
    gap = float(np.mean(np.linalg.norm(up[3:6] - lo[3:6][::-1], axis=1)))
    return {"width": width, "open": gap / max(width, 1e-6), "iris_r": float(eye.get("iris_r", 0))}


# ═══════════════════════════════════════════════════════════════
#  小工具
# ═══════════════════════════════════════════════════════════════
def _lum(bgr):
    return bgr[..., 0] * 0.114 + bgr[..., 1] * 0.587 + bgr[..., 2] * 0.299


def _sat(bgr):
    mx = bgr.max(-1)
    return (mx - bgr.min(-1)) / np.maximum(mx, 1e-4)


def _sample(img, xs, ys, interp=cv2.INTER_LINEAR):
    return cv2.remap(img, np.asarray(xs, np.float32), np.asarray(ys, np.float32), interp,
                     borderMode=cv2.BORDER_REPLICATE)


def _catmull(pts, n=12):
    """穿过关键点的平滑曲线（关键点每只眼才 9 个，直接连会有棱角）"""
    pts = np.asarray(pts, np.float64)
    P = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
    t = np.linspace(0, 1, n, endpoint=False)[:, None]
    t2, t3 = t * t, t * t * t
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1:])
    return np.vstack(out).astype(np.float32)


def _opening_sdf(upper, lower, w, h, ss=4):
    """眼眶轮廓 → 有符号距离（像素，眼眶里为正）。4 倍超采样画多边形，边缘到亚像素。
    另外给一张"这个像素离上眼皮线更近"的图（精修时上下眼皮规则不一样）"""
    cu, cl = _catmull(upper), _catmull(lower)
    poly = np.vstack([cu, cl[1:-1]])
    hi = np.zeros((h * ss, w * ss), np.uint8)
    # 像素中心约定：原图坐标 X ↔ 超采样格 X*ss + (ss-1)/2；shift=4 表示 1/16 格精度
    pts = np.round((poly * ss + (ss - 1) / 2.0) * 16).astype(np.int32)
    cv2.fillPoly(hi, [pts], 255, lineType=cv2.LINE_8, shift=4)
    din = cv2.distanceTransform(hi, cv2.DIST_L2, 5)
    dout = cv2.distanceTransform(255 - hi, cv2.DIST_L2, 5)
    sd = cv2.resize((din - dout) / ss, (w, h), interpolation=cv2.INTER_AREA)
    dist = []
    for cur in (cu, cl[1:-1]):
        line = np.full((h, w), 255, np.uint8)
        cv2.polylines(line, [np.round(cur).astype(np.int32)], False, 0, 1)
        dist.append(cv2.distanceTransform(line, cv2.DIST_L2, 5))
    near_upper = dist[0] < dist[1]
    return sd.astype(np.float32), poly, near_upper


def _sdf_from_mask(soft, ss=4):
    """软蒙版(0~1) → 有符号距离 + 轮廓线。先 4 倍放大再取 0.5 等高线，边缘是平滑的不是锯齿"""
    h, w = soft.shape
    hi = (cv2.resize(soft, (w * ss, h * ss), interpolation=cv2.INTER_LINEAR) > 0.5).astype(np.uint8) * 255
    din = cv2.distanceTransform(hi, cv2.DIST_L2, 5)
    dout = cv2.distanceTransform(255 - hi, cv2.DIST_L2, 5)
    sd = cv2.resize((din - dout) / ss, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
    cnts, _ = cv2.findContours(hi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    poly = None
    if cnts:
        c = max(cnts, key=cv2.contourArea)[:, 0, :].astype(np.float32)
        poly = (c - (ss - 1) / 2.0) / ss
    return sd, poly


def _refine_opening(crop, sd, r0m, near_upper):
    """关键点给的眼眶线在 2048 图上常差 2~4 像素（s04 下眼眶偏高，露在线外的那截眼珠挪不走、留红点）。
    在线里外各 k 像素的"待定带"里用 GrabCut 按颜色重新分：眼球（眼白+眼珠） vs 眼皮/睫毛/皮肤。
    带子外面的结论不动，所以最多只改 k 像素，改不坏大形。
    ⚠ 上眼皮那条边只许往里收、最多往外 1 像素：GrabCut 分不清深棕眼珠和深色眼线/睫毛，
      放开了会把眼眶扩进上眼皮里（s03 实测，原位复原误差从 5 涨到 18）。下眼皮可以往外扩。"""
    h, w = sd.shape
    k = max(2.0, 0.2 * r0m)
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    mask[sd > 0] = cv2.GC_PR_FGD
    mask[sd > k] = cv2.GC_FGD
    mask[sd < -k] = cv2.GC_BGD
    mask[near_upper & (sd < -1.0)] = cv2.GC_BGD
    if (mask == cv2.GC_FGD).sum() < 20 or (mask == cv2.GC_BGD).sum() < 20:
        return sd, None, "眼睛太小，眼眶线没精修"
    img8 = np.clip(crop * 255 + 0.5, 0, 255).astype(np.uint8)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(img8, mask, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return sd, None, "眼眶线精修失败，用的关键点原线"
    fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if n <= 1:
        return sd, None, "眼眶线精修失败，用的关键点原线"
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    fg = (lab == big).astype(np.uint8)
    # 补掉里面的小洞（眼神光、瞳孔有时会被分成背景）
    inv = (1 - fg).astype(np.uint8)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    for i in range(1, n2):
        x, y, ww, hh, _a = st2[i]
        if x > 0 and y > 0 and x + ww < w and y + hh < h:
            fg[lab2 == i] = 1
    a0, a1 = float((sd > 0).sum()), float(fg.sum())
    if a1 < 0.65 * a0 or a1 > 1.35 * a0:
        return sd, None, "眼眶线精修结果离谱(面积变%.0f%%)，用的关键点原线" % (100 * (a1 / max(a0, 1) - 1))
    sd2, poly = _sdf_from_mask(cv2.GaussianBlur(fg.astype(np.float32), (0, 0), 1.0))
    return sd2, poly, None


def _norm_conv_fill(img, w, sigmas):
    """只用权重 w>0 的像素（眼白）去估整块的颜色：粗尺度打底，细尺度有把握的地方覆盖。
    sigmas 是 (横, 竖) 对：细尺度故意"横宽竖窄"，洞里每一行只从同一行左右两边的眼白取色，
    上眼皮投下的那种上暗下亮的渐变就能保住，也不会把眼皮的暗色抹进来。"""
    out = None
    fallback = (img * w[..., None]).sum((0, 1)) / max(float(w.sum()), 1e-6)
    for sx, sy in sorted(sigmas, key=lambda s: -s[0] * s[1]):
        ws = cv2.GaussianBlur(w, (0, 0), sigmaX=sx, sigmaY=sy)
        num = cv2.GaussianBlur(img * w[..., None], (0, 0), sigmaX=sx, sigmaY=sy)
        f = np.where(ws[..., None] > 1e-4, num / np.maximum(ws, 1e-6)[..., None], fallback)
        conf = np.clip(ws / 0.12, 0, 1)[..., None]
        out = f if out is None else conf * f + (1 - conf) * out
    return out.astype(np.float32)


def _fill_polar_rows(P, vis):
    """极坐标展开后逐圈补：每段看不见的角度，左半从左边镜像抄、右半从右边镜像抄，中间交叉淡化。
    眼珠花纹是放射状的，镜像过来接缝最不明显。P: (圈数, 角度数, 通道)"""
    P = P.copy()
    Nr, Nt = vis.shape
    have = np.zeros(Nr, bool)
    for i in range(Nr):
        v = vis[i]
        if v.all():
            have[i] = True
            continue
        vidx = np.nonzero(v)[0]
        M = len(vidx)
        if M < 3:
            continue
        have[i] = True
        inv = ~v
        starts = np.nonzero(inv & ~np.roll(inv, 1))[0]
        row = P[i].copy()
        for a in starts:
            n = 0
            while inv[(a + n) % Nt]:
                n += 1
            kl = int(np.searchsorted(vidx, (a - 1) % Nt))
            kr = int(np.searchsorted(vidx, (a + n) % Nt))
            ks = np.arange(n)
            li = vidx[(kl - ks) % M]
            ri = vidx[(kr + (n - 1 - ks)) % M]
            t = (ks + 1) / (n + 1.0)
            wgt = np.clip((t - 0.3) / 0.4, 0, 1)
            wgt = (wgt * wgt * (3 - 2 * wgt))[:, None]
            P[i, (a + ks) % Nt] = (1 - wgt) * row[li] + wgt * row[ri]
    # 一点都看不见的圈：抄最近的有内容的圈
    if not have.all() and have.any():
        idx = np.nonzero(have)[0]
        for i in np.nonzero(~have)[0]:
            P[i] = P[idx[np.argmin(np.abs(idx - i))]]
    # 补出来的地方沿半径方向轻轻糊一下，压掉逐圈独立补造成的细条纹
    sm = cv2.filter2D(P, -1, np.array([[0.25], [0.5], [0.25]], np.float32), borderType=cv2.BORDER_REPLICATE)
    return np.where(vis[..., None], P, sm), have


def _fill_nan_nearest(a):
    good = np.nonzero(~np.isnan(a))[0]
    if good.size == 0:
        return None
    out = a.copy()
    for k in np.nonzero(np.isnan(a))[0]:
        out[k] = a[good[np.argmin(np.abs(good - k))]]
    return out


# ═══════════════════════════════════════════════════════════════
#  第一段：裁眼、眼眶距离场、"和眼白差多少"图、找圆的打分表
# ═══════════════════════════════════════════════════════════════
def _stage1(img, eye, r0m, rs):
    H, W = img.shape[:2]
    up, lo = eye["upper"], eye["lower"]
    r0, c0 = float(eye["iris_r"]), eye["iris_c"]
    allp = np.vstack([up, lo])
    width = float(np.linalg.norm(up[0] - up[-1]))
    pad = max(r0m * 1.6, 0.15 * width, 6.0)
    x0 = int(np.floor(max(0, allp[:, 0].min() - pad)))
    y0 = int(np.floor(max(0, allp[:, 1].min() - pad)))
    x1 = int(np.ceil(min(W, allp[:, 0].max() + pad)))
    y1 = int(np.ceil(min(H, allp[:, 1].max() + pad)))
    crop = img[y0:y1, x0:x1].astype(np.float32) / 255.0
    h, w = crop.shape[:2]
    off = np.array([x0, y0], np.float32)
    c0c = c0 - off

    sd, poly, near_upper = _opening_sdf(up - off, lo - off, w, h)
    poly0, sd0 = poly, sd
    sd, poly_r, why = _refine_opening(crop, sd, r0m, near_upper)
    if poly_r is not None:
        poly = poly_r
    gray = _lum(crop)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    # 眼白参考色：眼眶里、关键点眼珠圈外，"亮且不饱和"的前 30%
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2Lab)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    pool = (sd > 1.5) & (np.hypot(xx - c0c[0], yy - c0c[1]) > 1.15 * r0)
    if pool.sum() < 8:
        pool = sd > 0.5
    sc = (lab[..., 0] - 1.5 * chroma)[pool]
    top = pool.copy()
    top[pool] = sc >= np.percentile(sc, 70)
    ref_lab = np.median(lab[top], axis=0)
    ref_gray = float(np.median(gray[top]))
    # "和眼白差多少"：眼珠不管深色、蓝色还是粉色美瞳，和眼白的颜色差都大
    Q = np.sqrt(((lab - ref_lab) ** 2).sum(-1)) / 100.0
    Qb = cv2.GaussianBlur(Q.astype(np.float32), (0, 0), 0.6)

    # Daugman：每个(圆心, 半径)只看露在眼眶里的弧段，"圈里差得多、圈外差得少"越明显分越高
    step = max(0.5, r0m / 25.0)
    offs = np.arange(-0.6 * r0m, 0.6 * r0m + 1e-6, step)
    GX, GY = np.meshgrid(c0c[0] + offs, c0c[1] + offs, indexing="ij")
    GX, GY = GX.reshape(-1), GY.reshape(-1)
    Nc, Nr = GX.size, rs.size
    CX = np.repeat(GX, Nr)[:, None]
    CY = np.repeat(GY, Nr)[:, None]
    RR = np.tile(rs, Nc)[:, None]
    ang = np.linspace(0, 2 * np.pi, 96, endpoint=False)[None]
    co, si = np.cos(ang), np.sin(ang)
    dl = np.maximum(1.0, 0.08 * RR)
    xin, yin = CX + (RR - dl) * co, CY + (RR - dl) * si
    xo, yo = CX + (RR + dl) * co, CY + (RR + dl) * si
    qin, qout = _sample(Qb, xin, yin), _sample(Qb, xo, yo)
    vis = (_sample(sd, xin, yin) > 1.5) & (_sample(sd, xo, yo) > 1.5)
    cnt = vis.sum(1)
    diff = np.where(vis, qin - qout, 0).sum(1) / np.maximum(cnt, 1)
    pen = 0.06 * np.hypot(CX[:, 0] - c0c[0], CY[:, 0] - c0c[1]) / r0m
    score = np.where(cnt >= 0.2 * ang.shape[1], diff - pen, -1e9).reshape(Nc, Nr)
    return {"eye": eye, "crop": [x0, y0, w, h], "off": off, "img": crop, "sd": sd, "poly": poly,
            "poly0": poly0, "notes0": [why] if why else [], "lab": lab, "refLab": ref_lab, "sd0": sd0,
            "nearUpper": near_upper,
            "gray": gray, "Q": Q, "refGray": ref_gray, "width": width, "r0": r0,
            "GX": GX, "GY": GY, "score": score,
            "diff": diff.reshape(Nc, Nr), "arc": (cnt / ang.shape[1]).reshape(Nc, Nr)}


def _choose_circles(stages, rs, fixed_r=None):
    """两只眼一起定半径（同一个人两只眼一样大），再各自在这个半径 ±5% 里挑最好的圆心。
    fixed_r：用户手动调过某只眼的圈时，另一只眼的半径就跟着它（别被认错的那只带偏）"""
    best_r = []
    for s in stages:
        b = s["score"].max(0)
        best_r.append(np.where(b < -1e8, -0.05, b))
    joint = np.sum(best_r, 0)
    j = int(np.argmin(np.abs(rs - fixed_r))) if fixed_r else int(np.argmax(joint))
    k = max(1, int(round(0.05 / ((rs[-1] - rs[0]) / rs[0] / max(1, rs.size - 1)))))
    lo, hi = max(0, j - k), min(rs.size, j + k + 1)
    out = []
    for s in stages:
        sub = s["score"][:, lo:hi]
        if sub.max() < -1e8:  # 这只眼眶里几乎看不到圆周 → 只能信关键点
            c = s["eye"]["iris_c"] - s["off"]
            out.append(((float(c[0]), float(c[1])), float(rs[j]), 0.0, 0.0))
            continue
        ci, ri = np.unravel_index(int(np.argmax(sub)), sub.shape)
        out.append(((float(s["GX"][ci]), float(s["GY"][ci])), float(rs[lo + ri]),
                    float(s["diff"][ci, lo + ri]), float(s["arc"][ci, lo + ri])))
    return out


# ═══════════════════════════════════════════════════════════════
#  第二段：圆定了以后，出前端要的全部图层
# ═══════════════════════════════════════════════════════════════
def _stage2(s, circle):
    (cx, cy), R, contrast, arc = circle
    crop, sd, gray = s["img"], s["sd"], s["gray"]
    h, w = gray.shape
    notes = list(s["notes0"])
    if contrast < 0.085:
        notes.append("⚠ 自动找的眼珠圈可能不准(边缘对比%.2f)，挪动后不对劲就点「手动调眼珠圈」" % contrast)
    inside = sd > 0
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rho = np.hypot(xx - cx, yy - cy)
    soft = max(1.0, 0.05 * R)
    vis_core = sd > 1.5
    refL = s["refGray"]

    # ① 每一圈的中位亮度（同心圈）→ 瞳孔大小 + 眼神光 + 盖在眼珠上的睫毛 都靠它
    nring = int(R) + 3
    ring = np.clip(rho.astype(np.int32), 0, nring - 1)
    ref = np.full(nring, np.nan, np.float32)
    for k in range(nring):
        sel = (ring == k) & vis_core & (rho < R)
        if sel.sum() >= 3:
            ref[k] = np.median(gray[sel])
    ref2 = _fill_nan_nearest(ref)
    if ref2 is None:
        ref2 = np.full(nring, float(np.median(gray[inside])) if inside.any() else 0.5, np.float32)
    ref = ref2
    excess = gray - ref[ring]
    sel = (rho < R) & vis_core
    mad = float(np.median(np.abs(excess[sel]))) if sel.any() else 0.02

    # 瞳孔：最暗的那圈往外，亮度回升到一半的位置
    pupil = 0.35
    rn = (np.arange(nring) + 0.5) / R
    inner = np.nonzero(rn <= 0.6)[0]
    outer = ref[(rn > 0.6) & (rn < 0.9)]
    if inner.size and outer.size:
        im = inner[np.argmin(ref[inner])]
        ctr = float(np.median(outer)) - float(ref[im])
        if ctr >= 0.04:
            above = np.nonzero((np.arange(nring) > im) & (ref > ref[im] + 0.5 * ctr))[0]
            if above.size:
                pupil = float(np.clip(rn[above[0]], 0.12, 0.7))
        else:
            notes.append("瞳孔不明显，瞳孔大小滑块按默认值估")

    # ② 眼神光：在眼珠里、比同一圈亮一大截、而且比眼白还亮（不然是把眼珠边上的眼白误认了）
    #   还得离眼眶边有点距离：贴着下眼皮水线的反光不是眼神光（s04 实测会被认成一个，挪动后飘在眼白上）
    core = ((excess > max(0.15, 4 * mad)) & (gray > max(0.45, 0.9 * refL)) | (excess > 0.35)) \
        & (rho < 0.95 * R) & (sd > 1.5)
    n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(core.astype(np.uint8), connectivity=8)
    keep = [i for i in range(1, n_lab) if stats[i, cv2.CC_STAT_AREA] >= 2]
    core = np.isin(lab, keep)
    catch_m = cv2.dilate(core.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))) > 0
    catch_a = np.clip(cv2.GaussianBlur(catch_m.astype(np.float32), (0, 0), 0.7) * 1.3, 0, 1)
    if keep:
        notes.append("眼神光 %d 处" % len(keep))

    # ③ 盖在眼珠上的睫毛：靠近上眼皮、在瞳孔外、是"细条状的暗线" → 放到最上层不跟眼珠走
    #   ⚠ 不能用"比同一圈暗"来认：眼珠上半部被眼皮挡出的阴影是一大片暗，会被误认成睫毛钉在原地，
    #     眼珠一挪就在原位置留一片碎黑点（10-17 实测）。黑帽运算只挑比核细的暗线，大片阴影不算。
    kz = max(3, int(round(0.25 * R)) | 1)
    bh = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kz, kz)))
    bsel = (rho < R) & vis_core
    bmad = float(np.median(bh[bsel])) if bsel.any() else 0.01
    #   ⚠ 只认上眼皮附近的（nearUpper）：只写"离眼眶边近"的话，美瞳下半圈印的暗纹也会被当睫毛钉在原地，
    #     挪走后原位置底下留一道红弧（s04 实测，逐层关掉才查出是这一层，不是挖洞的问题）
    lash_iris = (bh > max(0.06, 4 * bmad)) & (sd < 0.3 * R + 2) & s["nearUpper"] \
        & (rho > 1.3 * pupil * R) & (rho < R + 1)
    lash_iris = cv2.GaussianBlur(lash_iris.astype(np.float32), (0, 0), 0.5)

    # ③b 眼眶二次修正（圆定了、知道眼珠什么颜色了才做得了）：
    #   上边：比眼珠黑一大截的是眼线/睫毛根，不是眼球 → 从眼眶里去掉（关键点线常压在眼线上，s03 实测）
    #   下边：颜色像眼珠、和眼珠连着、在线外几个像素内 → 是露出来的眼珠，并进眼眶
    #         （s04 红美瞳实测：GrabCut 把它和粉红的下眼皮水线分成一类，挪走后原位置底下留红弧）
    lab = s["lab"]
    poly_out = s["poly"]
    lid_front = np.zeros((h, w), np.float32)  # 认出来的眼线：从眼眶里去掉，同时放进"挡在前面的层"
    ring_sel = (rho > 0.65 * R) & (rho < 0.95 * R) & vis_core & ~catch_m
    iris_lab = np.median(lab[ring_sel], axis=0) if ring_sel.sum() >= 5 else None
    if iris_lab is not None:
        d_iris = np.sqrt(((lab - iris_lab) ** 2).sum(-1))
        d_scl = np.sqrt(((lab - s["refLab"]) ** 2).sum(-1))
        iris_like_col = (d_iris < 0.7 * d_scl) & (np.abs(lab[..., 0] - iris_lab[0]) < 22)
        kk = max(2.0, 0.2 * R)
        nu = s["nearUpper"]
        open_m = sd > 0
        # 眼线比眼珠黑：深棕眼珠亮度才 27 左右，"再黑 18"根本凑不出来（s03 实测 0 个像素），改成按比例。
        # ⚠ 比例要严：被上眼皮阴影罩住的眼珠顶部也很暗（0.55~0.75 倍），0.65 会把它当眼线钉住，
        #   眼珠一挪就在眼皮下挂一块锯齿黑块（s03 实测）。只认不到一半亮的。
        lid_thr = 0.45 * iris_lab[0]
        lidlike = nu & (sd < kk) & (lab[..., 0] < lid_thr) & (rho > 1.2 * pupil * R)
        lid_front = cv2.GaussianBlur(lidlike.astype(np.float32), (0, 0), 0.6)
        low_iris = ~nu & (sd > -kk) & (sd <= 0) & iris_like_col & (rho < 1.3 * R)
        seed = (rho < R) & open_m
        conn = cv2.connectedComponents((seed | low_iris).astype(np.uint8), connectivity=8)[1]
        if seed.any():
            ci = int(np.bincount(conn[seed]).argmax())
            low_iris &= conn == ci
        new_m = (open_m & ~lidlike) | low_iris
        if (new_m != open_m).any():
            sd, poly2 = _sdf_from_mask(cv2.GaussianBlur(new_m.astype(np.float32), (0, 0), 0.7))
            inside, vis_core = sd > 0, sd > 1.5
            if poly2 is not None:
                poly_out = poly2

    # ④ 要挖掉的范围：圆再大一圈 + 圆外面"颜色像眼珠、又和眼珠连着"的像素
    #   美瞳边缘是虚的，实际比圆大一两个像素；只按圆挖，挪走后原位置底下会留一道红弧（s04 实测）
    margin = max(2.0, 0.12 * R)
    hole_r = R + margin
    hole_m = rho < hole_r
    if iris_lab is not None:
        # 要"明显像眼珠"：颜色更近眼珠、亮度也和眼珠差不多（深色眼线/睫毛比棕眼珠黑得多）；
        # 而且不能越过上眼皮的关键点原线（s03 实测：放开会把上眼皮阴影当眼珠挖掉）
        like_iris = iris_like_col & (rho < 1.4 * R) & (sd > -1.0) & ~(s["nearUpper"] & (s["sd0"] < 0.5))
        grown = cv2.dilate((like_iris | hole_m).astype(np.uint8), np.ones((3, 3), np.uint8))
        n_c, lab_c = cv2.connectedComponents(grown, connectivity=8)
        ci = lab_c[int(np.clip(round(cy), 0, h - 1)), int(np.clip(round(cx), 0, w - 1))]
        if ci > 0:
            extra = (lab_c == ci) & like_iris & ~hole_m
            if extra.sum() > 0.5 * np.pi * R * R:  # 长出来比半个眼珠还多 = 认错了，不要
                notes.append("眼珠外圈颜色和周围太像，按圆挖")
            else:
                hole_m = hole_m | cv2.dilate(extra.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    hole_soft = cv2.GaussianBlur(hole_m.astype(np.float32), (0, 0), 0.7)

    # ⑤ 眼白：只拿"亮、不太饱和、不在洞里"的像素来估颜色
    cand = (sd > 1.0) & (hole_soft < 0.05) & ~catch_m
    sat = _sat(crop)
    like = np.clip((gray - 0.45 * refL) / (0.25 * refL), 0, 1) * np.clip(1 - (sat - 0.3) / 0.25, 0, 1)
    wgt = (cand * like).astype(np.float32)
    if wgt.sum() < 5:
        notes.append("露出来的眼白太少，眼白颜色是猜的")
        wgt = cand.astype(np.float32) if cand.sum() >= 5 else inside.astype(np.float32)
    F = _norm_conv_fill(crop, wgt, [(1.6 * R, max(0.8, 0.12 * R)), (2.0 * R, 0.4 * R), (3.0 * R, 1.5 * R)])

    # ⑤b 上眼皮的影子：眼白越贴近上眼皮越暗。横着取色在眼皮拱顶下面取不到同一高度的眼白（那一行两边是眼皮），
    #   洞的顶上会补得太亮，眼珠挪走后眼线下面像被切了个白口子（s03 实测）。
    #   做法：从露出来的眼白量"离上眼皮 d 像素时有多亮"，洞里贴近上眼皮的部分按这条曲线压暗（只压不提）。
    D = max(3.0, 0.5 * R)
    prof_pool = (sd > 0) & s["nearUpper"] & (hole_soft < 0.05) & ~catch_m & (sat < 0.45)
    if prof_pool.sum() >= 12:
        nb = int(np.ceil(D)) + 1
        bins = np.clip(sd[prof_pool].astype(np.int32), 0, nb - 1)
        lv = _lum(crop)[prof_pool]
        prof = np.array([np.median(lv[bins == b]) if (bins == b).sum() >= 3 else np.nan for b in range(nb)])
        far = (sd >= D) & (hole_soft < 0.05) & ~catch_m & (sat < 0.45)
        p_far = float(np.median(_lum(crop)[far])) if far.sum() >= 5 else float(np.nanmax(prof))
        prof = _fill_nan_nearest(prof)
        if prof is not None:
            prof = np.minimum(np.maximum.accumulate(prof), p_far)  # 离眼皮越远只会越亮
            dd = np.clip(sd, 0, nb - 1)
            target = np.interp(dd, np.arange(nb), prof)
            LFo = _lum(F)
            k = np.clip(target / np.maximum(LFo, 1e-3), 0.3, 1.0)
            wz = (s["nearUpper"] & (sd < D) & (sd > -1)).astype(np.float32) * np.clip(1 - sd / D, 0, 1)
            wz = cv2.GaussianBlur(wz, (0, 0), 0.8)
            F = F * (1 - wz[..., None] + wz[..., None] * k[..., None])

    # ⑥ 挖掉原眼珠，洞里填眼白
    hole_a = np.maximum(hole_soft, catch_a) * np.clip(sd + 1.0, 0, 1)
    base = crop * (1 - hole_a[..., None]) + F * hole_a[..., None]

    # ⑦ 明暗图：眼白本身的亮度变化，眼珠挪到哪就按哪的明暗压暗
    LF = _lum(F)
    refW = float(np.percentile(LF[sd > 1], 95)) if (sd > 1).any() else float(LF.max())
    S = np.clip(LF / max(refW, 1e-3), 0.3, 1.0).astype(np.float32)

    # ⑧ 挡在眼球前面的东西单独一层；提亮范围 = 整个眼球去掉"挡在前面的"和内眼角粉肉
    Lb = _lum(base)
    dark = cv2.GaussianBlur(((LF - gray) / np.maximum(LF, 1e-3)).astype(np.float32), (0, 0), 0.6)
    # 眼珠外面紧挨着的一圈不算（那是原眼珠的边，算进来挪走后会留暗弧）
    band = np.clip((rho - (1.25 * R + 2)) / 1.0 + 0.5, 0, 1)
    # 门槛做成一段缓坡，不然皮肤纹理被切成一粒一粒的碎点
    lash_a = np.clip((dark - 0.10) / 0.30, 0, 1) * band * (1 - hole_soft)
    lash_a = np.maximum(np.maximum(lash_a, lash_iris), lid_front)
    # ⚠ 不能只提亮"亮的眼白"：眼皮影子里的暗眼白没被提亮，两边一比出硬边、像贴白纸（s00 暗照片实测）。
    #   提亮本身是按比例放大亮度，暗处放大后照样是暗的，所以整片眼球一起提亮就行。
    white = np.clip(1 - (_sat(base) - 0.3) / 0.25, 0, 1) * (1 - lash_a)
    white = cv2.GaussianBlur(white.astype(np.float32), (0, 0), 0.6) * np.clip(sd + 0.5, 0, 1)
    # 提亮基准：眼白里最亮那一档的亮度。前端按"亮度 ÷ 这个值"整体提亮（明暗纹理按比例保留），
    # 不是直接往纯白推（那样眼白会变成一块平涂的白漆，s03 实测）
    like_b = np.clip((Lb - 0.45 * refL) / (0.25 * refL), 0, 1) * np.clip(1 - (_sat(base) - 0.3) / 0.25, 0, 1)
    wsel = (like_b > 0.5) & (sd > 1)
    sclera_ref = float(np.percentile(Lb[wsel], 90)) if wsel.sum() >= 5 else refW

    # ⑨ 眼珠：极坐标展开 → 补全 → 卷回圆形
    Rmax = R * 1.12 + 1.0
    Nr = int(np.ceil(Rmax * 2)) + 1
    Nt = max(72, int(np.ceil(2 * np.pi * Rmax * 1.5 / 4)) * 4)
    rr = np.linspace(0, Rmax, Nr, dtype=np.float32)[:, None]
    tt = np.linspace(0, 2 * np.pi, Nt, endpoint=False, dtype=np.float32)[None, :]
    px, py = cx + rr * np.cos(tt), cy + rr * np.sin(tt)
    P_raw = _sample(crop, px, py)
    Sp = _sample(S, px, py)
    P_flat = np.clip(P_raw / Sp[..., None], 0, 1)  # 去掉原位置的明暗，换位置后再按新位置压暗
    blocked = np.maximum(catch_m.astype(np.float32), (lash_iris > 0.3).astype(np.float32))
    visp = (_sample(sd, px, py) > 1.5) & (_sample(blocked, px, py) < 0.3)
    vis_frac = float(visp[rr[:, 0] <= R].mean())
    if vis_frac < 0.15:
        notes.append("眼珠露出来太少(%.0f%%)，补出来的多半不像" % (vis_frac * 100))
    PP, _ = _fill_polar_rows(np.concatenate([P_raw, P_flat], -1), visp)

    T = 2 * int(np.ceil(Rmax)) + 1
    tc = (T - 1) / 2.0
    ti, tj = np.mgrid[0:T, 0:T].astype(np.float32)
    rt = np.hypot(tj - tc, ti - tc)
    th = np.mod(np.arctan2(ti - tc, tj - tc), 2 * np.pi)
    mr = rt / Rmax * (Nr - 1)
    mt = th / (2 * np.pi) * Nt
    PW = np.concatenate([PP, PP[:, :1]], 1)
    tex_raw = _sample(np.ascontiguousarray(PW[..., :3]), mt, mr)
    tex_flat = _sample(np.ascontiguousarray(PW[..., 3:]), mt, mr)
    tex_a = np.clip((R - rt) / soft + 0.5, 0, 1).astype(np.float32)

    # ⑩ 眼球几何：眼球中心先按两个眼角的中点，眼球半径按眼珠大小和眼宽各估一份取平均
    cor = s["eye"]["corners"] - s["off"]
    ball_mid = cor.mean(0)
    ball_r = 0.5 * (1.7 * s["r0"] + 0.35 * s["width"])

    return {
        "side": s["eye"]["side"], "crop": s["crop"],
        "iris": [cx, cy], "R": R, "R_landmark": s["r0"], "pupil": pupil, "soft": soft,
        "texSize": T, "ballMid": [float(ball_mid[0]), float(ball_mid[1])], "ballR": float(ball_r),
        "eyeWidth": s["width"], "contrast": contrast, "arcVisible": arc, "irisVisible": vis_frac,
        "scleraRef": max(0.05, sclera_ref),
        "poly": poly_out.tolist(), "poly0": s["poly0"].tolist(), "notes": notes,
        "_layers": {"orig": crop, "base": base, "S": S, "sd": sd, "white": white,
                    "lash_a": lash_a, "catch_a": catch_a, "tex_raw": tex_raw,
                    "tex_flat": tex_flat, "tex_a": tex_a, "Q": s["Q"]},
    }


def render_neutral(L, meta, shade_on=True, shift=(0.0, 0.0), catch_follow=0.4):
    """自检用：眼珠放回原位置叠一遍，应该和原图几乎一样（和前端同一套叠法）。
    shift≠0 时只平移眼珠（不压扁），给调试图看大概效果。"""
    h, w = L["base"].shape[:2]
    T = meta["texSize"]
    tc = (T - 1) / 2.0
    cx, cy = meta["iris"][0] + shift[0], meta["iris"][1] + shift[1]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    m = np.clip(L["sd"] / (2 * 0.6) + 0.5, 0, 1)[..., None]
    tx, ty = xx - cx + tc, yy - cy + tc
    tex = L["tex_flat"] if shade_on else L["tex_raw"]
    col = _sample(tex, tx, ty)
    if shade_on:
        col = col * L["S"][..., None]
    a = cv2.remap(L["tex_a"], tx, ty, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)[..., None] * m
    c = L["base"] * (1 - a) + col * a
    la = L["lash_a"][..., None]
    c = c * (1 - la) + L["orig"] * la
    fx, fy = xx - shift[0] * catch_follow, yy - shift[1] * catch_follow
    ca = _sample(L["catch_a"], fx, fy)[..., None] * m
    c = c * (1 - ca) + _sample(L["orig"], fx, fy) * ca
    return c


def prepare(img, overrides=None, landmarks_normalized=None):
    """整张图 → (meta, 去眼珠底图)；meta["eyes"][i]["_layers"] 是各层浮点图。
    overrides：{"R": [圆心x, 圆心y, 半径], "L": [...]}（整图坐标）—— 用户手动拖好的眼珠圈，给了就不自动找
    landmarks_normalized：1.9.21 起，界面传来的归一化关键点 [[x,y], ...]（478 × 2），跳过 mediapipe
    """
    overrides = overrides or {}
    faces = detect_faces(img, landmarks_normalized=landmarks_normalized)
    if not faces:
        raise ValueError("没找到人脸（要正脸或微侧脸、眼睛睁开）")
    face = faces[0]
    eyes_in = [e for e in face["eyes"] if "iris_c" in e]
    r0m = float(np.mean([e["iris_r"] for e in eyes_in]))
    # 半径搜到 1.7 倍：大号美瞳（s14 实测）比 MediaPipe 按真人眼珠估的大将近一倍
    rs = r0m * np.linspace(0.8, 1.7, 31)
    r_crop = max([r0m] + [float(v[2]) / 1.3 for v in overrides.values()])  # 手动圈大了，裁剪也得跟着放大
    stages = [_stage1(img, e, r_crop, rs) for e in eyes_in]
    fixed_r = float(np.mean([v[2] for v in overrides.values()])) if overrides else None
    circles = _choose_circles(stages, rs, fixed_r)
    for i, s in enumerate(stages):
        ov = overrides.get(s["eye"]["side"])
        if ov:
            circles[i] = ((float(ov[0]) - float(s["off"][0]), float(ov[1]) - float(s["off"][1])), float(ov[2]), 1.0, 1.0)
            s["notes0"].append("眼珠圈是手动调的")
    base_full = img.copy()
    eyes = []
    for s, c in zip(stages, circles):
        m = _stage2(s, c)
        x0, y0, w, h = m["crop"]
        base_full[y0:y0 + h, x0:x0 + w] = np.clip(m["_layers"]["base"] * 255 + 0.5, 0, 255).astype(np.uint8)
        L = m["_layers"]
        sel = L["sd"] > 0
        if sel.any():
            err = np.abs(render_neutral(L, m) - L["orig"]).mean(-1)[sel]
            m["neutralErr"] = float(err.mean() * 255)
        eyes.append(m)
    # 鼻子方向（往里转是哪边）：另一只眼在哪边就是哪边
    if len(eyes) == 2:
        for a, b in ((0, 1), (1, 0)):
            ca = eyes[a]["crop"][0] + eyes[a]["iris"][0]
            cb = eyes[b]["crop"][0] + eyes[b]["iris"][0]
            eyes[a]["nasal"] = 1.0 if cb > ca else -1.0
    return {"w": img.shape[1], "h": img.shape[0], "faces": len(faces), "eyes": eyes}, base_full
