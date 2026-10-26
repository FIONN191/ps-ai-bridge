# MediaPipe Tasks Vision 1.1.1（网页版）

眼神调整（`ui-pure/eyegaze-worker.js`）在软件里找人脸关键点用的，2026-10-26 加（用户：眼神调整要能不装 Python 就用）。

- 来源：npm `@mediapipe/tasks-vision@1.1.1`（Google，Apache-2.0），跟引擎里 Python 版 `mediapipe==1.1.1` 同一个版本。
- 只拷了要用的：`vision_bundle.js`（原包里叫 `vision_bundle.cjs`，改后缀是因为有的壳按后缀给 MIME，`.cjs` 不算脚本、importScripts 会拒）、`wasm/vision_wasm_internal.js` + `.wasm`（带 SIMD 那套；WebView2 都支持 SIMD，没拷不带 SIMD 的那套）。
- `face_landmarker.task`：人脸关键点模型，跟 `engine/eyegaze/face_landmarker.task` 是同一个文件（sha256 开头 64184e229b263107）。
- 别手改；升级就整个目录换掉，然后跑 `tmp/run1026/eg_parity.cjs` 那套对照（关键点 + 图层都要跟 Python 版对上）。
