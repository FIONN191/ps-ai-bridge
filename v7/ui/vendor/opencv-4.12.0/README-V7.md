# OpenCV.js 4.12.0（网页版 OpenCV）

眼神调整（`ui-pure/eyegaze-prep.js`）在软件里算图层用的，2026-10-26 加（用户：眼神调整要能不装 Python 就用）。

- 来源：npm `@techstark/opencv-js@4.12.0-release.1`（OpenCV 官方 opencv.js 的打包，Apache-2.0，见同目录 LICENSE）。WASM 内嵌在 opencv.js 里。
- ⚠ 改过两处：embind 里两个 `new Function` 换成普通闭包（软件 CSP 不开 unsafe-eval），脚本 `tools/eyegaze/patch-opencv-noeval.py`，升级后要重跑。
- ⚠ 它没带 IPP：`distanceTransform` 是 16 位定点，跟 Python 的 cv2（带 IPP、浮点）差 0.0002 ⇒ eyegaze-prep.js 里自己写了浮点版（chamfer5），没用这里的。
- 别手改；升级后跑 `tools/eyegaze/parity/eg_parity.cjs`（跟 Python 版逐层对照）。
