// ═══ 外挂模型 · 引擎调度层 ═══════════════════════════════════
//
// ⚠⚠ 文件名还叫 matting-engine.js、全局名还叫 MATTINGENGINE，但它现在管【三种能力】：
//     抠像(matting) / 人体解析(segment) / SAM2 点选抠图(sam2)。
//     2026-09-14 深夜没改文件名是【有意的】——改名要同时动 ui.html 的 script 标签、
//     两个壳的适配层和几十处调用点，漏一处【不会报错、只会安静地少一个功能】
//     （铁律 14/17，2026-09-08 已经栽过两次）。宁可名字旧一点。
//
// 照着 match-engine.js 那套写的（探活带缓存 / 按能力选档 / 失败有回音）。
// ⚠ 但有一处【根本不同】，动这个文件之前必须知道：
//
//   校色：档 1 是纯 JS 本地算法，永远可用 → 引擎没装可以【静默回落】
//   这三个：没有本地兜底 → 没模型就是【做不了】
//
//   所以这里【不许静默】。用户点了但用不了，必须明确告诉他
//   缺什么、去哪补（docs/40 规矩 5：用户主动点的动作失败必须有回音）。
//   "我点了它没反应"是本项目最忌讳的故障形态。
//
// ⚠ 档位含义（和引擎侧 MODELS 表一一对应，改一边要改两边 —— docs/40 第三节）：
//   档 0  用不了（没装依赖 / 这一类一个模型都没有）
//   抠像  1 轻量 / 2 标准(1024) / 3 高精(2048，⚠ 热身后仍要 8-9 秒，界面必须明说)
//   分割  1 SegFormer(快) / 2 SCHP(准，主力)
//   SAM2  1 tiny / 2 base+ / 3 large
//
// ⚠⚠ 每一类的档位是【各算各的】。以前只有一个 state.tier，
//   现在是 state.tiers = {matting, segment, sam2}。
//   所有按档位办事的函数都多收一个 kind 参数，默认 'matting'（保住抠像老调用）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MATTINGENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ⚠ 端口别撞：37889 UXP 桥 / 37893 校色引擎 / 7879 DLSS。登记在 docs/40 第四节。
  const ENGINE_PORT = 37894;
  const ENGINE_BASE = 'http://127.0.0.1:' + ENGINE_PORT;

  const state = {
    probed: false,
    probing: false,     // 探活请求在途（面板据此显示"正在检查"，而不是瞎说"没启动"）
    available: false,
    tier: 0,            // 0 = 用不了。⚠ 这是【抠像】的档位，等于 tiers.matting（老调用还在读它）
    // ⭐ 三类能力各自的最高档（2026-09-14 深夜）。引擎 /health 里的 tiers 字段。
    //   ⚠ 老的 matting_server.py 只回一个 tier、没有 tiers —— 下面 probeNow 做了兼容，
    //     老服务器在跑时 segment/sam2 会是 0（"没装"），而不是崩掉。
    tiers: { matting: 0, segment: 0, sam2: 0 },
    // ⚠ 引擎到底是不是【会三样活】的那个新版本。
    //   判据是 /health 里有没有 tiers 字段，不是看 version 字符串（版本号会变，字段不会）。
    //   有了它才能把"引擎旧"和"模型没下"分开说 —— 说错了用户会跑去下一个已经下好的模型。
    multiCapable: false,
    vramGB: 0,
    device: '',
    // ⭐ 2026-10-02：ONNX 实际用的推理后端（CPUExecutionProvider / CUDA… / Dml…）和选它的原因。
    //   外挂卡要据此明说「现在用 CPU 算」—— 以前只在引擎日志里喊，用户根本看不到（docs/114 第 3 件）。
    provider: '',
    providerWhy: '',
    version: '',
    caps: {},
    models: {},         // key → {state:'ok'|'broken'|'missing', ...}
    modelsDir: '',
    loaded: null,       // 当前加载着哪个模型（null = 已释放）
    lastError: '',
    probedAt: 0
  };

  // ── 探活 ────────────────────────────────────────────────
  // ⚠ 超时 3 秒：引擎刚启动那几秒还在 import onnxruntime（比 numpy 慢得多）。
  //   1.5 秒踩过坑（docs/33 第 8 个坑），别改回去。
  // ⚠ 缓存 60 秒 —— 但【模型库界面】要用 force=true 拿实时的，
  //   否则用户刚把文件拖进文件夹，界面还显示"未安装"。
  // ⚠⚠ 探活【在途】时的状态要老实（2026-09-14 晚，用户截图抓到的）：
  //   以前一进门就把 probed=true 写上、再去发请求。面板紧接着同步读状态，
  //   读到"探测过了 + available=false"，就把"结果还没回来"说成了"引擎没启动"——这是假话。
  //   现在 probed 只在请求【回来之后】才置 true；在途期间 probing=true，
  //   unusableReason() 会说"正在检查"。同时把在途的 Promise 存起来，
  //   面板和开始计算同时探活时共用一次请求，不重复打。
  let inflight = null;
  async function probe(force) {
    // ⚠⚠⚠ 2026-10-17（用户 10-16 点抠像、10-17 点人体解析，整个面板假死，内存涨到 4 GB）：
    //   【在途的请求必须先返回】，再查缓存。原来先查缓存 ——
    //   别人的探活还在路上时（probing=true，probedAt 在 probeNow 开头已被改成"现在"），这里拿旧结果立刻返回，
    //   probing 却还是 true ⇒ preset-ui 的 probeAndRedraw 以为"真发出了请求"、挂上重画 ⇒
    //   重画→probe→立刻返回→重画…… 全在微任务里转，主线程一刻不让出，在途那个请求的回音永远处理不了，
    //   probing 永远是 true ⇒ 死循环。引擎睡着时探活要一两秒，最容易撞上（真机按这个条件复现：一秒重建面板 4000 次）。
    if (inflight) return inflight;
    const now = Date.now();
    if (!force && state.probed && (now - state.probedAt) < 60000) return state;
    state.probing = true;
    inflight = (async () => {
      try { await probeNow(now); }
      finally { state.probing = false; inflight = null; }
      return state;
    })();
    return inflight;
  }
  async function probeNow(now) {
    state.probedAt = now;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(ENGINE_BASE + '/health', { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      state.available = d.ok === true;
      // ⚠ 新引擎回 tiers:{matting,segment,sam2}；老引擎只回 tier（就是抠像那一个数）。
      //   两种都要认 —— 用户机器上可能还跑着老的 matting_server.py。
      if (d.tiers && typeof d.tiers === 'object') {
        state.multiCapable = true;
        state.tiers = {
          matting: Number(d.tiers.matting) || 0,
          segment: Number(d.tiers.segment) || 0,
          sam2:    Number(d.tiers.sam2)    || 0,
          // ⭐ 2026-10-04：补 sam3 / matte / tween。
          //   ⚠⚠ 漏了这三个键的后果：别处读 tiers.tween 永远是 0，
          //   于是"调强度"第一步就被判成"引擎没装"挡掉（典型静默失效）。
          //   引擎 /health 早就在报这三个键了，是这里一直没接。
          sam3:    Number(d.tiers.sam3)    || 0,
          matte:   Number(d.tiers.matte)   || 0,
          tween:   Number(d.tiers.tween)   || 0
        };
      } else {
        state.multiCapable = false;
        // ⚠⚠ 2026-10-03 晚：必须写全 6 个键。以前这里只写 3 个（matting/segment/sam2），
        //   sam3/matte/tween 直接【不存在】→ 别处读 tiers.tween 永远是 0，
        //   表现是"引擎明明开着却说没装过渡帧"（用户 18:32 实测那张常驻报错卡）。
        //   同 docs/134 那批坑：漏一个键不报错，只是静默变成 0。
        state.tiers = {
          matting: Number(d.tier) || 0, segment: 0, sam2: 0,
          sam3: 0, matte: 0, tween: 0
        };
      }
      state.tier = state.tiers.matting;
      state.vramGB = Number(d.vramGB) || 0;
      state.device = String(d.device || '');
      state.provider = String(d.provider || '');
      state.providerWhy = String(d.providerWhy || '');
      state.version = String(d.version || '');
      state.caps = d.caps || {};
      state.models = d.models || {};
      state.modelsDir = String(d.modelsDir || '');
      state.loaded = d.loaded || null;
      state.lastError = '';
    } catch (e) {
      state.available = false;
      state.tier = 0;
      // ⚠⚠ 2026-10-03 晚：同上，必须写全 6 个键。
      //   ⚠ 顺带说明这个分支的风险：探活【一次超时】就会把 tiers 全清成 0，
      //     而探活结果要缓存 60 秒 → 接下来一分钟里读 tiers.tween 都是 0，
      //     滚轮就会弹"引擎没起来"。引擎其实开着。
      //     这个"清零点"跟返回 0 是两回事，但用户看到的表现一样，所以键必须写全。
      //   ⚠ 没改成"保留上次的档位"是有意的：探不到就不该假装还装着，
      //     否则真掉线时界面会一直显示"有"（那是更坏的静默撒谎）。
      state.tiers = { matting: 0, segment: 0, sam2: 0, sam3: 0, matte: 0, tween: 0 };
      state.lastError = (e && e.name === 'AbortError') ? '引擎没响应（超时）' : String(e && e.message || e);
    }
    state.probed = true;      // ⚠ 只在这里置 true —— 请求回来了才算"探测过"
    return state;
  }

  // ── 三类能力的名字和它在引擎 MODELS 表里的 kind ──────────
  // ⚠ 界面这边叫 'sam2'，引擎那边 encoder 的 kind 是 'sam2-enc'（decoder 单独一类）。
  //   这层换算只在这儿做一次，外面统一用 'sam2'。
  const KINDS = {
    matting: { label: '抠像',     modelKind: 'matting'  },
    segment: { label: '人体解析', modelKind: 'segment'  },
    sam2:    { label: 'SAM2 抠图', modelKind: 'sam2-enc' }
  };
  // ── 把各种写法归一成内部那三个名字 ──────────────────────
  // ⭐⭐⭐ 2026-10-09（审计查出的第 2 条）：
  //   这个模块对外只认 'matting' / 'segment' / 'sam2' 三个名字，
  //   但【外部传进来的写法有四种】：
  //     ① 'matting' / 'segment' / 'sam2'          —— ui.html 执行链
  //     ② 'tool-matting' / 'tool-segment' / ...   —— tool-silhouettes 的剪影工具表
  //     ③ undefined / null                        —— ui.html:8719、13830 的老调用
  //     ④ 拼错的字符串（'dlow'、'tool' …）
  //   原来只有 tierOf 做了归一，kindInfo（→modelsOfKind / whyText / kindLabel）
  //   【没做】⇒ `modelsOfKind('tool-segment')` 返回的是【抠像的三个模型】。
  //   后果：引擎掉线时，人体解析面板会按抠像的模型状态报原因（指错方向，用户会去重下抠像）。
  //   ⇒ 收口到这一个函数，别在别处各判各的（本项目的老规矩：一套换算只写一处）。
  const KIND_ALIAS = {
    'tool-matting': 'matting',
    'tool-segment': 'segment',
    'tool-sam2':    'sam2',
    'tool-glow':    'matting',   // 辉光不走这三个能力，但当抠像问时别崩
  };
  function normalizeKind(kind) {
    if (kind == null) return 'matting';
    const k = String(kind);
    if (Object.prototype.hasOwnProperty.call(KINDS, k)) return k;
    if (Object.prototype.hasOwnProperty.call(KIND_ALIAS, k)) return KIND_ALIAS[k];
    return 'matting';            // ⚠ 认不出的一律当抠像 —— 跟 preset-ui 的 toolKindOf 同一约定
  }

  function kindInfo(kind) { return KINDS[normalizeKind(kind)]; }


  // 某一类能力下、引擎报上来的模型列表。
  // ⚠ 老的 matting_server.py 报的模型【没有 kind 字段】—— 缺 kind 一律当抠像，
  //   否则老服务器在跑时抠像会变成"一个模型都没有"。
  function modelsOfKind(kind) {
    const want = kindInfo(kind).modelKind;
    const ms = state.models || {};
    const out = {};
    for (const k of Object.keys(ms)) {
      const mk = ms[k] && ms[k].kind ? String(ms[k].kind) : 'matting';
      if (mk === want) out[k] = ms[k];
    }
    return out;
  }

  // ⚠⚠⚠ 2026-10-09 修（同一个 bug 的另一半）。
  //   这里原来是 `Number(t[kind === 'sam2' ? 'sam2' : kind]) || 0`。
  //   映射那一半是【对的、必须留】—— 界面叫 'sam2'，但
  //     · 模型分类（KINDS.modelKind）叫 'sam2-enc'
  //     · 引擎 /health 的 tiers 键名又叫 'sam2'
  //   两套命名不一样，所以这里不能直接用 modelKind 去查（那样 sam2 会永远 0）。
  //   ⚠ 我第一版就差点这么改，靠核对 KINDS 表才发现 —— 记在这儿免得下一个人再踩。
  //
  //   缺的那一半是【回退】：kind 不是那三个键时，这里原来算出 0，
  //   而 kindInfo/whyText 那一路是回退到抠像的 ⇒ 就会出现
  //   "用抠像的模型列表判出模型装了，再用 0 个档位说一档跑不了"这种自相矛盾的报错
  //   （真因详见 unusableReason 上面那段）。
  //   ⇒ 认不出的 kind 一律当抠像，跟 kindInfo 保持一致。
  function tierOf(kind) {
    const t = state.tiers || {};
    const k = normalizeKind(kind);
    // ⚠ 'sam2' 这条映射【必须留】：界面叫 sam2、模型分类叫 sam2-enc，
    //   而引擎 /health 的 tiers 键名又叫 sam2 —— 三套名字（详见上面 KINDS 那段）。
    const key = (k === 'sam2') ? 'sam2' : k;
    return Number(t[key]) || 0;
  }

  // ── 为什么用不了：给用户看的人话 ────────────────────────
  // ⚠ 这个函数是本文件存在的重点之一。
  //   "抠图失败"是废话；"缺 onnxruntime，去设置里按提示装"才是有用的报错（铁律 15）。
  //   ⚠ 返回空串 = 能用。
  // ⚠ kind 不给默认 'matting' —— 抠像那些老调用一个字都不用改。
  //
  // ⚠⚠ 2026-10-05：`state.lastError` 是【原始英文】（多半是 `Failed to fetch`）——
  //   用户报"还是留了大量的专有名词"，探针扫到界面上就印着它。
  //   现在过一层 whyText() 翻成人话；原始值仍然进 state，排查时拿得到。
  function whyText(raw) {
    const s = String(raw || '').trim();
    if (!s) return '没有响应';
    if (/failed to fetch|networkerror|econnrefused|connection refused/i.test(s)) return '没连上它';
    if (/timeout|timed out|etimedout/i.test(s)) return '响应超时，可能正在启动中';
    if (/enoent|not found|no such file/i.test(s)) return '还没装好';
    if (/permission|eacces|access is denied/i.test(s)) return '没有权限启动';
    if (/onnxruntime|no module|modulenotfound/i.test(s)) return '缺一个组件';
    return s.split(/[\r\n]+/)[0].slice(0, 40);
  }
  // ⚠⚠⚠ 2026-10-09 修（用户实测报错台 MATTING_UNUSABLE · 阶段 检查引擎）：
  //   原来这里写的是「kind 不给默认 'matting' —— 抠像那些老调用一个字都不用改」。
  //   ⚠ 那个判断【是错的】，它跟 kindInfo() 的兜底【对不上】：
  //       kindInfo(kind) → `KINDS[kind] || KINDS.matting`   ← 全部回退到抠像
  //       tierOf(kind)   → `state.tiers[kind]`              ← 【不回退】，undefined → 0
  //   后果（实测复现，确定性的、不是偶发）：
  //     `unusableReason()` 不传参数时，前半段拿"抠像"的模型列表
  //       （3 个都 ok ⇒ okn=3 ⇒ 说"模型装了"），
  //     后半段 `tierOf(undefined) === 0` ⇒ 说"一档都跑不了"，
  //     两句拼成一句自相矛盾的报错 —— 而引擎【完全正常】（实测 tiers.matting=3、8ms 响应）。
  //   ⚠ 全仓有三处就是这么调的：ui.html:8719（抠像主路径！）、
  //     ui.html:13830、preset-ui.js:1917。
  //   ⇒ 补默认值，跟 kindInfo 对齐。**别删**（删了那三处又会误报）。
  function unusableReason(kind) {
    if (kind == null) kind = 'matting';
    const K = kindInfo(kind);
    if (state.probing && !state.probed) return '正在检查' + K.label + '引擎…';
    if (!state.probed) return '还没探测过引擎';
    if (!state.available) {
      return K.label + '引擎没启动（' + whyText(state.lastError) + '）——'
           + '去 外挂能力卡 · 配置信息 点「启动」';
    }
    const c = state.caps || {};
    if (!c.onnx) return '引擎起来了，但缺 onnxruntime —— 没有它跑不了模型。去外挂能力卡 · 配置信息点「安装」';
    if (!c.numpy) return '引擎起来了，但缺 numpy。去外挂能力卡 · 配置信息点「安装」';
    if (!c.pil && !c.cv2) return '引擎起来了，但缺 Pillow 和 opencv（要有一个才能读写图片）';
    const list = Object.values(modelsOfKind(kind));
    const okn = list.filter(m => m.state === 'ok').length;
    if (okn === 0) {
      const broken = list.filter(m => m.state === 'broken');
      if (broken.length) {
        return K.label + '的模型文件有问题：' + broken.map(m => m.name + '（' + m.reason + '）').join('；')
             + '。重新下载一遍';
      }
      // ⚠ 这句必须分两种情况说，否则用户会跑去下一个【已经下好的】模型：
      //   ① 引擎还是老版本，压根没有这一类功能
      //   ② 引擎是新的，只是这一类的模型文件没下
      if (!state.multiCapable && kind !== 'matting') {
        return '现在跑着的是旧版引擎，它只会抠像，没有' + K.label + '。'
             + '去 外挂能力卡 · 配置信息 用「重启」换上新版引擎';
      }
      return '还没装' + K.label + '的模型。去 外挂能力卡 · 配置信息，在「模型文件」里装';
    }
    // 模型装了、但这一类档位是 0 —— 多半是显存不够被全过滤掉了
    if (tierOf(kind) <= 0) {
      const needy = list.filter(m => m.state === 'ok' && m.vramGB && state.vramGB && state.vramGB < m.vramGB);
      if (needy.length) {
        return K.label + '的模型装了，但这台机器显存不够（要 '
             + Math.min.apply(null, needy.map(m => m.vramGB)) + 'G，这台是 ' + state.vramGB + 'G）';
      }
      return K.label + '的模型装了，但引擎说一档都跑不了。把引擎重启一次试试';
    }
    return '';
  }

  // ── 选档 ────────────────────────────────────────────────
  // ⚠ 两边取严：引擎能给的 ∩ 用户在设置里允许的（docs/40 第三节）。
  //   ⚠ 用户把上限调低是【他的选择】，不算"少干活"，不用报警告；
  //     但引擎给不了他要的那档，就得说（规矩 4）。
  // 档位 → 中文名。⚠ 同样从引擎报的数据里取，不写死。
  function tierName(t, kind) {
    const k = keyForTier(t, kind);
    const m = k && (state.models || {})[k];
    return m ? m.name : ('档' + t);
  }

  function pickTier(wantMax, notes, kind) {
    const engine = tierOf(kind || 'matting');
    // ⚠ 'auto' 不再写死成 3 —— 取【引擎实际能给的最高档】。
    //   写死数字的话，档位一调整（2026-09-14 停用过档3）就会一直提示"降档了"。
    const want = (wantMax == null || wantMax === 'auto') ? engine : Number(wantMax);
    const use = Math.min(engine, want);
    if (notes && want > engine && engine > 0) {
      const k = keyForTier(want, kind);
      const m = k && (state.models || {})[k];
      let why = '没装' + tierName(want, kind);
      // 显存不够是最常见的原因，单独说清楚 —— 否则用户会一直找"为什么装了却用不了"
      if (m && m.state === 'ok' && m.vramGB && state.vramGB && state.vramGB < m.vramGB) {
        why = '显存不够（要 ' + m.vramGB + 'G，这台是 ' + state.vramGB + 'G）';
      }
      notes.push('用的是' + tierName(use, kind) + '，不是' + tierName(want, kind) + ' —— ' + why);
    }
    return use;
  }

  // 档位 → 模型 key。
  // ⚠ 从【引擎报上来的 models】里反查，不写死映射 ——
  //   档位一调整写死的那套就会对不上，而且不报错。
  // ⚠⚠ 必须先按 kind 过滤再比档位：三类能力的档位号是重复的
  //   （抠像档2 和 分割档2 是两个完全不同的模型）。不过滤的话会串台，
  //   而且串得【不报错】—— 只是抠图时悄悄加载了人体解析模型。
  function keyForTier(t, kind) {
    const ms = modelsOfKind(kind);
    for (const k of Object.keys(ms)) {
      if (Number(ms[k].tier) === Number(t)) return k;
    }
    return '';
  }

  // ── 模型库（给设置界面用）────────────────────────────────
  // Explicit file checks can load large ONNX graphs on CPU; ordinary probes remain lightweight.
  async function listModels(deep) {
    let timer;
    try {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), deep ? 600000 : 5000);
      const r = await fetch(ENGINE_BASE + '/models' + (deep ? '?deep=1' : ''), { signal: ctl.signal });
      const d = await r.json();
      if (d && d.ok) {
        state.models = d.models || {};
        state.modelsDir = String(d.modelsDir || '');
        // ⚠⚠ 只在引擎【真的报了】档位时才覆盖，不能写成 `Number(d.tier)||0`。
        //   新引擎的 /models 路由不回 tier（档位只在 /health 里给），
        //   照老写法会把已经探到的档位【一路清成 0】—— 表现成"打开一次模型库，
        //   抠像就说自己用不了了"，而且一句错都没有（铁律 17 的静默失效）。
        if (d.tiers && typeof d.tiers === 'object') {
          state.tiers = {
            matting: Number(d.tiers.matting) || 0,
            segment: Number(d.tiers.segment) || 0,
            sam2:    Number(d.tiers.sam2)    || 0,
            // ⚠⚠ 2026-10-04：这里也漏了 sam3/matte/tween。
            //   后果比上面那处更隐蔽：打开一次「模型库」（走 /models 路由）
            //   就会把 tween 覆盖成 0 → 再滚轮就说"引擎没装"。
            //   ⚠ 两处都要补，只补一处 = 时好时坏。
            sam3:    Number(d.tiers.sam3)    || 0,
            matte:   Number(d.tiers.matte)   || 0,
            tween:   Number(d.tiers.tween)   || 0
          };
          state.tier = state.tiers.matting;
        } else if (d.tier !== undefined) {
          state.tier = Number(d.tier) || 0;
          state.tiers = Object.assign({}, state.tiers, { matting: state.tier });
        }
      }
      return d;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // 手动释放显存
  async function unload() {
    try {
      const r = await fetch(ENGINE_BASE + '/unload');
      const d = await r.json();
      if (d && d.ok) state.loaded = null;
      return d;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function snapshot() { return Object.assign({}, state); }

  return {
    probe, snapshot, unusableReason, pickTier, keyForTier,
    // ⚠ tierName 必须导出：任务卡和报错卡要显示"这次用的是哪一档"。
    //   以前只在本文件内部用，外面拿不到，只能写"档2"这种用户看不懂的字。
    tierName,
    // ⭐ 三类能力（2026-09-14 深夜）：tierOf('segment') / modelsOfKind('sam2') 等
    tierOf, modelsOfKind, kindLabel: (k) => kindInfo(k).label,
    listModels, unload,
    get port() { return ENGINE_PORT; },
    get base() { return ENGINE_BASE; }
  };
});
