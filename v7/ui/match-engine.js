// ═══ 校色/对齐 · 引擎调度层 ═══════════════════════════════════
//
// 三档共用一个入口，按「能用哪档就用哪档」自动降级：
//
//   档 3  外部引擎 · 高配(24G)   稠密光流对齐 + 无缝融合 + 全分辨率
//   档 2  外部引擎 · 标配(8G)    稠密光流对齐 + 全分辨率校色
//   档 1  本地 CPU（永远可用）    网格变形对齐 + 局部校色（2026-09-29 起，和引擎默认一致；以前只有整体位移/缩放）
//
// ⚠ 档 1 是【保底】，不是"低配才用"：
//   外部引擎没装、没启动、超时、报错 —— 一律回落档 1，绝不让生成链路断掉。
//   校色是锦上添花，它不该有能力让一次生成失败。
//
// ⚠ 为什么外部引擎走 HTTP 而不是嵌进来：
//   本项目已经有同款先例(DLSS 磁贴的 dlss_server.py)，那套跑通了很久 ——
//   Python 静默服务 + 本地 HTTP + 端口探活。照抄，不另起炉灶。
//
// ⚠ 用户【不装也能用】：档 2/3 的模型和环境是可选项，
//   界面里给下载链接和一条命令，装不装都不影响主链路。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MATCHENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 外部引擎约定端口。⚠ 别和已有的撞：37889 是 UXP 桥，7879 是 DLSS。
  const ENGINE_PORT = 37893;
  const ENGINE_BASE = 'http://127.0.0.1:' + ENGINE_PORT;

  const state = {
    probed: false,
    available: false,
    tier: 1,             // 实际可用的最高档
    vramGB: 0,
    device: '',
    version: '',
    lastError: '',
    probedAt: 0
  };

  // ── 探活 ────────────────────────────────────────────────
  //  ⚠ 超时必须短(1.5s)：引擎没装是常态，不能让每次生成都先卡一秒半。
  //  结果缓存 60 秒 —— 一批 18 张不该探 18 次。
  async function probe(force) {
    const now = Date.now();
    if (!force && state.probed && (now - state.probedAt) < 60000) return state;
    state.probedAt = now;
    state.probed = true;
    try {
      const ctl = new AbortController();
      // ⚠ 3 秒不是拍脑袋：引擎刚启动那几秒还在加载 numpy/cv2/torch，
      //   1.5 秒会把"正在起来"误判成"没装"（2026-09-11 实测撞到）。
      //   引擎没装时这个超时也只影响第一次探测，之后结果缓存 60 秒。
      const timer = setTimeout(() => ctl.abort(), 3000);
      let res;
      try {
        res = await fetch(ENGINE_BASE + '/health', { signal: ctl.signal, cache: 'no-store' });
      } finally { clearTimeout(timer); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json();
      state.available = true;
      state.vramGB = Number(info.vramGB) || 0;
      state.device = String(info.device || '');
      state.version = String(info.version || '');
      // ⚠⚠ 档位取【引擎报的】和【显存允许的】两者中的小者（2026-09-12 修）。
      //
      //   原来这里【完全忽略引擎报的 tier】，只按显存算。后果：
      //   2026-09-12 停用无缝融合后，引擎如实报档 2，
      //   而前端看到 31.8G 显存就一路显示"档 3" —— 界面吹了个它做不到的档位。
      //   这正是本项目最忌讳的静默失效（用户以为多做了什么，其实没有）。
      //
      //   为什么也不能只信引擎：引擎侧配置写错的话，
      //   可能报一个跑起来会 OOM 的高档位。所以两边取严。
      //     引擎报的  = 它【真的实现了】哪些能力
      //     显存算的  = 这台机器【扛得住】到哪一档
      const byVram = state.vramGB >= 20 ? 3 : (state.vramGB >= 7 ? 2 : 1);
      const byEngine = Math.max(1, Math.min(3, Number(info.tier) || 1));
      state.tier = Math.min(byVram, byEngine);
      state.lastError = '';
    } catch (e) {
      state.available = false;
      state.tier = 1;
      state.lastError = (e && e.name === 'AbortError') ? '引擎无响应' : String((e && e.message) || e);
    }
    return state;
  }

  function status() { return Object.assign({}, state); }

  // ── 主入口 ──────────────────────────────────────────────
  //  src / ref: {data:Uint8ClampedArray, width, height}
  //  返回 {img, tier, notes[]}；任何一步失败都会退到档 1，不会抛。
  async function process(src, ref, opts) {
    opts = opts || {};
    // ⭐ 2026-10-24（docs/273，用户定永久删除「精确对齐」）：稠密光流会把 AI 改过的形状扭回去 / 扭歪。
    //   入口这里兜底：谁传 'flow' 都按快速对齐（mesh）跑，本机 / 引擎 / 云端 / Worker 哪条路都到不了光流。
    if (opts.alignMode === 'flow') opts = Object.assign({}, opts, { alignMode: 'mesh' });
    const notes = [];
    const wantTier = Math.max(1, Math.min(3, Number(opts.tier) || 3));
    // ⭐ 2026-10-19（docs/249）：引擎档没成、改用本机简化算法时【必须让上层知道】（原来只写进 notes，界面一个字都不说）。
    //   fallback = 为什么没用上引擎；上层（ui.html）拿它给缩略图打「简」角标 + 弹一句提示。
    let fallback = '';

    // ⭐⭐ 2026-10-20 本机 CPU 校色排第一（用户：「校色上传到云端有点蠢…本机失败的话自动走云端」）。
    //   Rust 写进软件本体（src-tauri/v7-color），跟引擎是同一套算法（11 组真实样本对照过），不要 Python / 显卡 / 上传。
    //   顺序：本机 → 没成再走下面的云端 / 本机引擎 → 再不行才用档 1 简化版。
    //   ⚠ 细节补偿（detailBoost）本机没移植 ⇒ 这种照旧走下面；强制档 1（只对齐不校色）也照旧走 JS，那条本来就快。
    //   ⚠ Electron 测试壳没有 uiwin.match ⇒ 自动跳过。
    const G0 = (typeof self !== 'undefined' ? self : globalThis);
    const native = G0.uiwin && G0.uiwin.match && typeof G0.uiwin.match.process === 'function' ? G0.uiwin.match : null;
    if (wantTier > 1 && native && opts.detailBoost !== true) {
      try {
        const r = await native.process(src, ref, opts);
        if (opts.signal && opts.signal.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; throw e; }
        if (r && r.img) {
          notes.push('本机校色(CPU' + (r.ms ? ' · ' + r.ms + 'ms' : '') + ')');
          if (r.notes) notes.push.apply(notes, r.notes);
          return { img: r.img, base: r.base || null, tier: 2, notes, fallback: '', native: true };
        }
      } catch (e) {
        if (e && e.name === 'AbortError' && opts.signal && opts.signal.aborted) throw e;
        notes.push('本机校色没成，改走云端 / 引擎：' + String((e && e.message) || e));
      }
    }

    if (wantTier > 1) {
      const st = await probe();
      if (st.available && st.tier > 1) {
        try {
          const r = await runExternal(src, ref, Math.min(wantTier, st.tier), opts);
          if (r && r.img) {
            notes.push('引擎档 ' + r.tier + ' · ' + st.device + (st.vramGB ? (' ' + st.vramGB + 'G') : ''));
            if (r.notes) notes.push.apply(notes, r.notes);
            // ⚠⚠⚠ 2026-10-05 实测抓到的真凶：这里原来【只挑 img/tier/notes 三个字段】，
            //   把 runExternal 好不容易解出来的 r.base（底版）【静默丢掉了】。
            //   后果：引擎回了两张、下面也解出来了（探针数到 fromBlob 被调 2 次），
            //   但到 ui.html 手上 base 永远是 undefined → base_N.png 一张都写不出来 →
            //   小眼睛永远灰的、点了弹"没有底版"。**一句错都不报。**
            //   ⚠ 这是同一个坑的【第三次】：上游有、中间一层手写字段列表没带上。
            //     （前两次：aiRestoreImage 的 baseImgId 没往下传、两处 shot 字段列表漏了它。）
            //   ⇒ 以后凡是"函数返回一个对象、中间还要转一层"，都要问一句：
            //     我是不是漏了哪个字段？**加新字段时把这一层也过一眼。**
            return { img: r.img, base: r.base || null, tier: r.tier, notes, fallback: '' };
          }
        } catch (e) {
          // ⚠ 用户主动取消的（换账号 / 关掉了）不算降级，原样抛回去
          if (e && e.name === 'AbortError' && opts.signal && opts.signal.aborted) throw e;
          fallback = String((e && e.message) || e);
          notes.push('引擎不可用，已用本地算法：' + fallback);
        }
      } else if (st.lastError) {
        notes.push('未检测到加速引擎，使用本地算法');
      }
    }
    // 档 1：优先丢进 Worker（不占主线程 + 多核并行），建不起来就在主线程算。
    // ⚠ Worker 里出任何问题都要退回主线程 —— 这是保底路径，不能再往下掉了。
    if (opts.useWorker !== false && initPool()) {
      try {
        const r = await runInWorker(src, ref, opts);
        notes.push.apply(notes, r.notes || []);
        // ⭐⭐ 2026-10-08（docs/170 §10.1 H1）：**base 也要往下传**。
        //   ⚠ 这一行原来是 { img, tier, notes } —— 底版在这一层静默丢掉，
        //     于是档 1 的用户永远没有 base_N.png、小眼睛永远灰的。
        //   ⚠ 同一个坑在 :114（引擎档）已经栽过一次，这里的两行是它的下一次。
        //     凡是"函数返回对象、中间再转一层"，加字段时都要把这几处一起过一眼。
        return { img: r.img, base: r.base || null, tier: 1, notes, fallback };
      } catch (e) {
        notes.push('并行处理失败，改在主线程算：' + String((e && e.message) || e));
      }
    }
    // ⭐⭐ 2026-10-08（H1）：主线程保底路径同样要交出底版 ——
    //   ⚠ 两条路（Worker / 主线程）必须给同样形状的结果，
    //     不然"同一件事两条路两个结果"，是本项目最难查的一类问题。
    //   ⚠ runLocal 把 base 挂在返回的 img 对象上（见那边的注释，
    //     不改返回值形状是为了不惊动既有调用方）。
    const localImg = runLocal(src, ref, opts, notes);
    return { img: localImg, base: (localImg && localImg.base) || null, tier: 1, notes, fallback };
  }

  // ── 档 1 的 Worker 池 ───────────────────────────────────
  //  ⚠ 只是【把同样的算法挪到别的线程】，算法本身一个字没改。
  //    收益：① 不占主线程，算的时候界面照样跟手；② 多核并行。
  //
  //  ⚠ 建不起来就回落到主线程算 —— Worker 可能因为 CSP、
  //    file:// 协议、或者打包方式而创建失败。**绝不能因此不出图。**
  const pool = { workers: [], busy: [], queue: [], seq: 0, pending: new Map(), tried: false, ok: false };

  function poolSize() {
    const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // 留 2 个核给主线程和系统，最多 4 个 —— 再多收益递减，而每个 Worker
    // 都要自己加载一份算法代码。
    return Math.max(1, Math.min(4, n - 2));
  }

  function initPool() {
    if (pool.tried) return pool.ok;
    pool.tried = true;
    try {
      if (typeof Worker === 'undefined') return false;
      for (let i = 0; i < poolSize(); i++) {
        const w = new Worker('match-worker.js');
        w.onmessage = (e) => {
          const m = e.data || {};
          const job = pool.pending.get(m.id);
          if (!job) return;
          pool.pending.delete(m.id);
          pool.busy[i] = false;
          if (m.ok) {
            // ⭐⭐ 2026-10-08（docs/170 §10.1 H1）：收下底版（Worker 传回的那一份）。
            //   ⚠ 这里也是【手写字段列表】，是 H1 点名的"第二层"。
            const result = { img: { data: new Uint8ClampedArray(m.data), width: m.w, height: m.h },
                             notes: m.notes || [] };
            if (m.base) {
              result.base = { data: new Uint8ClampedArray(m.base), width: m.baseW, height: m.baseH };
            }
            job.resolve(result);
          }
          else job.reject(new Error(m.error || 'Worker 处理失败'));
          drain();
        };
        // ⚠ Worker 整个挂掉时，所有挂在它上面的任务都要被拒绝，
        //   否则那些 Promise 永远不 resolve，整批生成卡死。
        w.onerror = () => {
          pool.busy[i] = false;
          pool.pending.forEach((job, key) => { job.reject(new Error('Worker 异常退出')); pool.pending.delete(key); });
          drain();
        };
        pool.workers.push(w);
        pool.busy.push(false);
      }
      pool.ok = pool.workers.length > 0;
    } catch (_) {
      pool.ok = false;
    }
    return pool.ok;
  }

  function drain() {
    while (pool.queue.length) {
      const idx = pool.busy.indexOf(false);
      if (idx < 0) return;
      const item = pool.queue.shift();
      pool.busy[idx] = true;
      pool.pending.set(item.msg.id, item);
      // ⚠ 两个 buffer 用 Transferable 转移，不复制
      pool.workers[idx].postMessage(item.msg, [item.msg.src, item.msg.ref]);
    }
  }

  function runInWorker(src, ref, opts) {
    return new Promise((resolve, reject) => {
      const id = ++pool.seq;
      // ⚠ 必须 slice 出【独立副本】再转移：原数组可能还被调用方持有，
      //   直接转移会让对方手上的 buffer 变成空的（detached）。
      const msg = {
        id: id,
        src: src.data.slice().buffer,
        ref: ref.data.slice().buffer,
        w: src.width, h: src.height,
        // ⚠ 2026-09-29：对齐方式、长宽比、细节补偿都要传进去 —— 以前只传了 align/color/method，
        //   后台线程因此没有长宽比保护（参考图被拉伸时照样按位置对齐、精准校色）。
        opts: {
          align: opts.align !== false, alignMode: opts.alignMode || 'mesh', color: opts.color !== false,
          method: opts.method || 'hybrid', aspectOff: Number(opts.aspectOff) || 1, detailBoost: opts.detailBoost === true,
          // ⭐⭐ 2026-10-08（docs/170 §10.1 H1）：wantBase 也要传进 Worker。
          //   ⚠ 这个对象是【手写字段列表】—— 上面那段注释自己就写着
          //     "以前只传了 align/color/method，后台线程因此没有长宽比保护"，
          //     同一个形状这次又缺了 wantBase。
          //   ⚠ 缺了它的后果：Worker 那条路（默认走的那条）不产底版，
          //     而主线程保底路径产 → 两条路结果不一致，最难查。
          wantBase: opts.wantBase !== false
        }
      };
      pool.queue.push({ msg: msg, resolve: resolve, reject: reject });
      drain();
    });
  }

  // ── 档 1：本地 CPU ──────────────────────────────────────
  function runLocal(src, ref, opts, notes) {
    // ⚠ 浏览器里从 window 上取，Node 里才走 require。
    //   不要裸写 COLORMATCH —— 严格模式下取不到会直接抛 ReferenceError，
    //   而这里是【回落路径】，在这儿抛异常等于把最后的兜底也弄没了。
    const g = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : {});
    const CM = g.COLORMATCH || (typeof require === 'function' ? require('./color-match.js') : null);
    if (!CM) { notes.push('本地算法未加载'); return src; }
    // ⭐ 2026-09-29：整套判断（长宽比保护 / 对齐方式 / 校色方法 / 细节补偿提示）搬进 COLORMATCH.runTier1，
    //   后台线程（match-worker.js）和这里共用同一份，不会再各写各的、漏掉一边。
    //   对齐从「整体平移 + 缩放」换成从加速引擎搬来的网格变形（引擎 09-12 起的默认），不装 Python 也有。
    const r = CM.runTier1(src, ref, opts);
    notes.push.apply(notes, r.notes);
    // ⭐⭐ 2026-10-08（docs/170 §10.1 H1）：底版也要交出去 ——
    //   ⚠ 这里原来【只 return r.img】，于是保底路径算出来的底版直接丢掉。
    //     保底路径和 Worker 路径必须给出同样形状的结果，不然两条路不同行为
    //     （本项目最难查的一类问题就是"同一件事两条路两个结果"）。
    //   ⚠ 不改返回值形状（太多调用方读 .img），而是把 base 挂在同一个对象上。
    const out = r.img;
    if (r.base) { try { out.base = r.base; } catch (_) {} }
    return out;
  }

  // ── 档 2/3：外部引擎 ────────────────────────────────────
  //  ⭐ 图片走【二进制】不走 base64（2026-09-12 改）。
  //
  //    原来两张图都转成 base64 字符串塞进 JSON。代价：
  //    base64 体积涨 1/3，而且在浏览器这侧是 JS 字符串 —— UTF-16 再翻一倍。
  //    一张 4K 图：16MB PNG → 21MB base64 → 内存里 42MB。
  //    一批 18 张、来回各一次，峰值很可观。
  //    docs/21 立的规矩就是"别把图片变成长字符串搬来搬去"。
  //
  //    现在用 FormData 发 Blob：浏览器直接把字节写进请求体，全程不产生长字符串。
  //    回来的也是 PNG 字节。
  //
  //  ⚠ 超时要够长：稠密光流在 4K 上确实要几秒。
  async function runExternal(src, ref, tier, opts) {
    const toBlob = opts.toBlob;
    if (typeof toBlob !== 'function') throw new Error('缺少图片编码器');
    const fd = new FormData();
    fd.append('meta', JSON.stringify({
      tier: tier,
      align: opts.align !== false,
      color: opts.color !== false,
      // ⚠⚠ 2026-10-05：主链路只有混合判据一条路（engine/match_server.py 的
      //   color_hybrid）。'lowfreq'/'mkl' 两档已砍掉，引擎也不再看 method。
      method: opts.method || 'hybrid',
      // ⭐ 对齐方式(2026-09-12)：'mesh' 网格变形 / 'flow' 稠密光流 / 'off'
      //   ⚠ 默认 mesh。flow 会把 AI 的有意修改一起"修"掉（实测：修脸时
      //     瘦下去的脸、放大的眼睛被扭回原样）。
      alignMode: opts.alignMode || 'mesh',
      // ⭐ 真实长宽比差（2026-09-12）。⚠ 必须由调用方传，引擎自己算不出来 ——
      //   ui.html 在送进来之前已经把参考图非等比拉伸成和回图一样大了，
      //   引擎那边算出来恒等于 1.000（它那道 3% 护栏因此从没触发过）。
      aspectOff: Number(opts.aspectOff) || 1,
      // ⭐ 细节补偿：用原图高频补回重采样损失的锐度。只补细节不改形状。
      //
      // ⚠⚠ 2026-09-12 起【默认关】(settingsRuntime.detailBoost 默认 false)。
      //   实测那套老默认值是负收益：只对齐 12.86 → 补完 11.93，比不补还糊。
      //
      // ⭐ 下面四个是算法常量，不是用户设置 —— 故意【不做界面开关】：
      //   它们是 2026-09-12 在实验台(/compare)上用真实样本定下来的，
      //   普通用户没有判断依据，多给一个旋钮只会让人乱调。
      //   要重新定值就去 http://127.0.0.1:37893/compare 跑 A/B，定完改这里。
      //   ⚠ 改这几个数【必须连 docs/33 一起更新】，不然下一个人无从判断。
      detailBoost: opts.detailBoost === true,
      detailStrength: (opts.detailStrength == null ? 1.5 : opts.detailStrength),
      detailRadius: 15,        // 频段半径(px)。用户 2026-09-12 定
      detailConfFloor: 0.20,   // 置信度门槛。低于它的地方保留 AI 原样
      detailDenoise: false,    // ⚠ 抠细节前【不】降噪 —— 降噪会把原图纹理先削掉
      detailMode: 'replace',   // 'replace' 细节还原档 / 'gain' 轻微增强档
      // ⭐⭐ 2026-10-05（docs/143 §八）：要【增量层】还是【合成好的图】。
      //   true = 引擎回一张 RGBA 纹理层（RGB=128+delta/2，A=置信度），交给 PS 线性光叠 ——
      //         这样传回去的是【可编辑的纹理】，用户能自己再调。
      //   false/不传 = 老行为（引擎自己合成好一张），测试脚本和旧客户端不受影响。
      //
      //   ⚠⚠⚠ 这一行是【差点又漏掉】的一个字段：这个对象是【手写字段列表】，
      //      ui.html 那边传了 detailLayer:true，但不在这个列表里就等于没传 ——
      //      引擎收不到 → 照旧回合成图 → 用户看到"还是原来那样，根本没线性光"。
      //     同一个形状 2026-10-05 已经犯过三次（见 docs/144 §六点七）。
      //     ⇒ 以后往 opts 里加字段，**先来这里加一行**。
      detailLayer: opts.detailLayer === true,
      // ⚠ 无缝融合 2026-09-12 已停用（会把原图内容混进来，见 docs/33 第八节）。
      //   这里显式传 false，不依赖引擎侧的默认值 —— 两边都改过才算数。
      seamless: false,
      // ⭐⭐ 2026-10-05（docs/143 §四）：要引擎【连底版一起回】。
      //   底版 = 掰正过、没校色 —— 历史卡显示它、任务卡那个小眼睛切到它。
      //   ⚠ 不传就是老行为（回一张）。这里传 true 让老引擎也安全：
      //     老的 match_server 不认识这个字段，忽略掉、照旧回一张，
      //     而下面解析那段【按 hasBase 分流】，两边都不会出错。
      wantBase: opts.wantBase !== false
    }));
    fd.append('src', await toBlob(src), 'src.png');
    fd.append('ref', await toBlob(ref), 'ref.png');

    const ctl = new AbortController();
    // ⚠⚠ 2026-10-19（docs/249，线上实测）：原来不管本机还是云端都是【整单 60 秒】—— 云端一批图一起传时
    //   上传 + 排队 + 处理 + 接收加起来常超 60 秒，到点掐断、悄悄改用本机简化算法（线上 108 次）。
    //   云端那条路现在由云端任务队列按阶段盯（上传 / 接收 25 秒没进展才算卡住，排队只要在往前走就等），
    //   这里只留一个 30 分钟的兜底；本机引擎照旧 60 秒。
    const G = (typeof self !== 'undefined' ? self : globalThis);   // ⚠ 这个文件里没有 root（工厂函数在外层定义）
    const cloud = !!(G.V7CloudTools && typeof G.V7CloudTools.routing === 'function' && G.V7CloudTools.routing());
    const timer = setTimeout(() => ctl.abort(), Number(opts.timeoutMs) || (cloud ? 30 * 60 * 1000 : 60000));
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', () => ctl.abort()); }
    let res;
    try {
      // ⚠ 不要自己设 Content-Type —— FormData 的 boundary 必须由浏览器生成，
      //   手写 header 会把 boundary 丢掉，服务端解析不出来。
      // ⭐ __v7Job：告诉云端任务队列这一单是什么、多急、属于哪个任务的第几张（用来排序和画状态）
      res = await fetch(ENGINE_BASE + '/process', { method: 'POST', body: fd, signal: ctl.signal, __v7Job: opts.job });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (text ? ('：' + text.slice(0, 200)) : ''));
    }
    // 结果元数据在响应头里：HTTP 头是 latin-1，塞不下中文，所以经过 URL 编码
    let meta = {};
    try {
      const raw = res.headers.get('X-Match-Meta');
      if (raw) meta = JSON.parse(decodeURIComponent(raw));
    } catch (_) {}
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) throw new Error('引擎没有返回图片');

    // ⭐⭐ 2026-10-05（docs/143 §四-2.2）：引擎可能回了【两张】——
    //   容器格式是 [4 字节大端 L1][成品 PNG][底版 PNG]。
    //
    //   ⚠ 怎么知道回的是两张：看响应头的 hasBase。**不看 Content-Type** ——
    //     老引擎（没升级的那台）认不出 wantBase，照样回 image/png 一张，
    //     这时 hasBase 就是 false/没有。按元数据分流，新旧引擎都能跑。
    //   ⚠ 为什么按 4 字节大端切：引擎那边用 struct.pack(">I", L1) 写的，
    //     DataView 默认就是大端（第二参数不传 = false = big-endian），别写成 littleEndian。
    const hasBase = meta.hasBase === true;
    let blob = new Blob([buf], { type: 'image/png' });
    let baseBlob = null;
    if (hasBase) {
      if (buf.byteLength <= 4) throw new Error('引擎回的两张容器长度不对');
      const L1 = new DataView(buf).getUint32(0, false);
      if (L1 <= 0 || L1 > buf.byteLength - 4) throw new Error('引擎回的两张容器长度头不合法');
      blob = new Blob([new Uint8Array(buf, 4, L1)], { type: 'image/png' });
      baseBlob = new Blob([new Uint8Array(buf, 4 + L1)], { type: 'image/png' });
    }

    const img = await opts.fromBlob(blob);
    // ⚠ 底版解不出来【不算失败】：它只是给"历史卡 / 切版本"用的，
    //   为了它把整张成品丢掉是本末倒置。解不出来就返回 null，上层自己兜。
    let base = null;
    if (baseBlob && baseBlob.size) {
      try { base = await opts.fromBlob(baseBlob); } catch (_) { base = null; }
    }
    return { img: img, base: base, tier: meta.tier || tier, notes: meta.notes || [] };
  }

  return {
    process, probe, status,
    ENGINE_PORT, ENGINE_BASE,
    _state: state
  };
});
