// ═══ 校色/对齐 · Worker（档 1 的并行执行器）═══════════════
//
// 为什么要有它（2026-09-12）：
//   一批最多 18 张，原来在主线程上【一张一张串行算】。
//   2048 的图单张约 156ms，18 张就是 2.8 秒 —— 而且这 2.8 秒里
//   主线程被占满，界面动画全卡住（用户看到的是"生成完了界面顿一下"）。
//
//   校色算法是【纯函数、不碰 DOM】，天生适合丢进 Worker：
//     ① 不再占用主线程 → 界面在算的时候照样跟手
//     ② 多个 Worker 并行 → 按核心数快 4~6 倍
//
// ⚠ 这里只跑【档 1】。档 2/3 是 HTTP 调外部引擎，
//   那本来就是异步的、不占主线程，没必要也搬进来。
//
// ⚠ 像素数据用 Transferable 传（postMessage 的第二个参数）——
//   不这么做的话每次通信都会把整个 ImageData 复制一份，
//   4K 图一来一回就是 134MB 的无谓拷贝，比省下来的还多。

importScripts('color-match.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  const id = msg.id;
  try {
    const src = { data: new Uint8ClampedArray(msg.src), width: msg.w, height: msg.h };
    const ref = { data: new Uint8ClampedArray(msg.ref), width: msg.w, height: msg.h };
    // ⭐ 2026-09-29：对齐 + 校色的整套判断都在 COLORMATCH.runTier1 里（主线程保底路径用的也是它）。
    //   以前这里自己写了一份，漏了长宽比保护、不认「对齐方式」设置；对齐也只有整体平移 + 缩放。
    //   现在默认是从加速引擎搬进来的网格变形（和引擎默认一致），不装 Python 也有。
    const r = COLORMATCH.runTier1(src, ref, msg.opts || { align: msg.align, color: msg.color, method: msg.method });
    const cur = r.img, notes = r.notes;

    // ⚠ 结果也用 Transferable 送回去，同样是为了避免整块拷贝。
    //   buffer 转移之后这边就不能再碰它了 —— 反正也用完了。
    const buf = cur.data.buffer;
    // ⭐⭐⭐ 2026-10-08（docs/170 §10.1 H1）：**底版也要送回去**。
    //   ⚠⚠ 这里原来是【手写字段列表】{id, ok, data, w, h, notes} ——
    //     上游算出了 base，但这一层没带上 ⇒ 底版在这一层就静默丢了。
    //     这条链上"手写字段列表漏字段"已经栽过三次，所以这里改了要跟着看下游。
    //   ⚠ 底版同样走 Transferable（第二个参数里带上它的 buffer），
    //     不然一份 4K 数据要整块拷贝一次（约 134MB 的无谓开销）。
    const transfer = [buf];
    const out = { id: id, ok: true, data: buf, w: cur.width, h: cur.height, notes: notes };
    if (r.base && r.base.data) {
      out.base = r.base.data.buffer;
      out.baseW = r.base.width;
      out.baseH = r.base.height;
      transfer.push(out.base);
    }
    self.postMessage(out, transfer);
  } catch (err) {
    // ⚠ Worker 里出错【必须报回去】。不报的话主线程那个 Promise 永远不 resolve，
    //   整批生成就卡死在这里 —— 比算错更糟。
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
  }
};
