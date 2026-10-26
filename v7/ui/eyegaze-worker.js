/* global FilesetResolver, FaceLandmarker */
// 眼神调整 Worker：跑人脸关键点检测（MediaPipe Tasks Vision 1.1.1）。
// 主线程 postMessage({ id, cmd: 'warm' | 'prepare', bytes?, up?, ov?, key?, wantLandmarks? })
// → Worker postMessage({ id, ok, error?, progress?, landmarks?, layer? })
importScripts('/ui-pure/vendor/mediapipe-tasks-vision-1.1.1/vision_bundle.js');

let landmarker = null;
let warmError = null;

async function ensure() {
  if (landmarker) return landmarker;
  if (warmError) throw warmError;
  try {
    const wasmDir = '/ui-pure/vendor/mediapipe-tasks-vision-1.1.1/wasm';
    const wasm = await FilesetResolver.forVisionTasks(wasmDir);
    landmarker = await FaceLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: '/ui-pure/vendor/mediapipe-tasks-vision-1.1.1/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 4,
      minFaceDetectionConfidence: 0.3,
      minFacePresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    });
    return landmarker;
  } catch (e) {
    warmError = e;
    throw e;
  }
}

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  try {
    if (cmd === 'warm') {
      await ensure();
      self.postMessage({ id, ok: true });
    } else if (cmd === 'prepare') {
      const { bytes, up, ov, key, wantLandmarks } = ev.data;
      const lm = await ensure();

      // 从 ArrayBuffer 造 ImageBitmap
      const blob = new Blob([bytes], { type: 'image/png' });
      const bmp = await self.createImageBitmap(blob);

      // 检测人脸（478 个归一化坐标 × N 张脸）
      const res = lm.detect(bmp);
      bmp.close();

      if (!res.faceLandmarks || res.faceLandmarks.length === 0) {
        self.postMessage({ id, ok: false, error: '没找到人脸' });
        return;
      }

      // 取最大那张脸的 478 个点 {x, y, z}，只要 x/y（归一化 0-1）
      const faces = res.faceLandmarks.map((lms, i) => {
        const pts = lms.map(p => [p.x, p.y]);
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        return { pts, size: Math.max(w, h), idx: i };
      });
      faces.sort((a, b) => b.size - a.size);
      const landmarks = faces[0].pts;  // [[x, y], ...] × 478

      if (wantLandmarks) {
        // 只返回关键点（测试用）
        self.postMessage({ id, ok: true, landmarks });
        return;
      }

      // 调引擎 /eyegaze/prepare 算图层（传 landmarks 过去）
      self.postMessage({ id, ok: false, error: '引擎接口还没改' });
    } else {
      self.postMessage({ id, ok: false, error: '未知命令：' + cmd });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e.message || e) });
  }
};
