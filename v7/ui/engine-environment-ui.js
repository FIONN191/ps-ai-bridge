/* ══════════════════════════════════════════════════════════════════════════
 * V7EngineEnvironment · 环境行（docs/150 Phase B 重构 + 2026-10-08 加速档落地）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 目标形态：
 *   核心：已就绪 / 未准备    加速档：已就绪 / 未装 / —    [安装]（或 [检查并修复]）
 *   ⭐ 2026-10-08 新增：加速档那一格旁边一个 [开启加速] / [关闭加速]，
 *      下面一行「☐ 下次自动开」+ 一条实时进度。
 *
 * 为什么要有这两颗：用户原话
 *   「为什么之前我能用，现在用不了了？…我要用户到手就能用，然后他们能够自己配置
 *     PyTorch 和 CUDA，然后启动的时候能选择直接启动当前配置支持的最高的那一档。」
 *   查下来整条链只有一个缺口：隔离环境里没装 torch ⇒ 引擎 caps.torch/cuda 都是 false
 *   ⇒ 4 个要显卡的模型（人体解析 / 细边 / 文字选区 / 过渡帧）全被标 broken ⇒ 档位全掉 0。
 *   ⇒ 所以"开启加速"这一颗按钮要一次把环境 → 加速包 → 引擎都办完，
 *     而不是让用户自己去猜该点哪个、该装哪个（用户原话："你不觉得这样引导用户用
 *     软件非常的蹩脚吗？就入口太多，启动的东西太多"）。
 *
 * 变化：
 *   ① 数据源 = V7EngineStatus.snapshot().env（单一出口，不再自己存一份）。
 *   ② 只留一个动作按钮（docs/150 §二：按钮词只有 安装 / 导入 / 启动 / 重启 / 停止 / 重新扫描；
 *      环境这一格是"安装"，已就绪时是"检查并修复"）。准备中变成 [取消]。
 *      加速档那颗是"开启加速 / 关闭加速"，属于同一套词。
 *   ③ 底层仍然走现有 uiwin.engine.environment 的 status/prepare/cancel/removeaccel ——
 *      不新增宿主 API（docs/150 §三）；第二个参数 accel 是这一层唯一的新东西。
 *   ④ 用户主动操作失败才进报错堆（ENGINE_ENVIRONMENT_FAILED）；缺环境只是状态文字。
 *   ⑤ ⭐ 「下次自动开」= 记住用户的选择（界面侧 localStorage，不进宿主存储），
 *      下次开机由 ui.html 的 tryAutoAccel() 自动跑一次"开启加速"。
 */

(function (root) {
  'use strict';
  let pending = '', revision = 0, subscribed = false;
  // ⭐ 活进度：谁在跑、跑到哪一步。这里是【唯一】存放处，卡片/状态条都从这里读。
  let live = null;
  const AUTO_KEY = 'v7.engine.autoAccel';
  const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = () => root.uiwin && root.uiwin.engine && root.uiwin.engine.environment;
  const store = () => root.V7EngineStatus || null;
  function snapOf() {
    const S = store();
    if (!S || typeof S.snapshot !== 'function') return null;
    try { return S.snapshot(); } catch (_) { return null; }
  }
  function markup() { return '<div data-engine-env aria-live="polite"></div>'; }

  // ── 「下次自动开」的读写。localStorage 不可用（隐私模式/配额）时一律当"没勾"，
  //    绝不让一个存储异常把整行渲染搞崩。
  function autoOn() {
    try { return root.localStorage && root.localStorage.getItem(AUTO_KEY) === '1'; } catch (_) { return false; }
  }
  function setAuto(on) {
    try { if (root.localStorage) root.localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (_) { /* 存不了就不存 */ }
  }

  function envOf(snap) {
    const empty = { core: 'missing', accel: 'n/a', text: '还没有环境状态', accelText: '', accelState: '', accelAvailable: null, accelDevice: '', accelOnnxProvider: '', accelOnnxPackage: '', accelOnnxNote: '', vramGB: 0 };
    return (snap && snap.env) || empty;
  }

  // 加速档那一格的文字（三种状态，词只在这里出现一次）
  function accelChip(env) {
    if (env.accel === 'ready') return '已就绪';
    if (env.accel === 'missing') return '未装';
    return '—';
  }

  function render() {
    const snap = snapOf();
    const env = envOf(snap);
    const ready = env.core === 'ready';
    document.querySelectorAll('[data-engine-env]').forEach(box => {
      const available = typeof api() === 'function';
      const busy = !!pending;
      const canAccel = env.accelAvailable !== false;       // 这台机器有没有能用的 N 卡
      const installed = env.accelState === 'installed';
      // ⭐ 动作按钮：环境本身没就绪时，主按钮是「安装」（顺带把加速一起办，见 host.startAccel）；
      //   环境就绪之后主按钮变「检查并修复」，加速档自己那格给 [开启加速] / [关闭加速]。
      let main = '';
      if (!available) main = '<em class="envnote">当前版本未提供环境管理</em>';
      else if (busy) main = '<button class="eng-btn" data-engine-env-action="cancel"' + (pending === 'cancel' ? ' disabled' : '') + '>取消</button>';
      else main = '<button class="eng-btn" data-engine-env-action="prepare">' + (ready ? '检查并修复' : '安装') + '</button>';

      let accelBtn = '';
      if (available && !busy && ready && canAccel) {
        accelBtn = installed
          ? '<button class="eng-btn" data-engine-env-action="removeaccel">关闭加速</button>'
          : '<button class="eng-btn pri" data-engine-env-action="accel" title="装 CUDA 版 PyTorch（约 3GB），装完细边 / 文字选区 / 过渡帧 / 人体解析就能用">开启加速</button>';
      } else if (available && !busy && !ready && canAccel) {
        // 环境都没就绪时，主按钮「安装」会连加速一起装（省掉用户点两次）
        accelBtn = '<em class="envnote">点「安装」会一起把加速办完</em>';
      }

      const check = (available && ready && canAccel)
        ? '<label class="envcheck"><input type="checkbox" data-engine-auto-accel' + (autoOn() ? ' checked' : '') + '>'
          + '<span>下次自动开</span></label>'
        : '';

      box.innerHTML = '<div class="envrow">'
        + '<span class="envcell"><span class="ek">核心</span><span class="ev' + (ready ? ' ok' : '') + '">' + escape(ready ? '已就绪' : '未准备') + '</span></span>'
        + '<span class="envcell"><span class="ek">加速档</span><span class="ev' + (env.accel === 'ready' ? ' ok' : '') + '">' + escape(accelChip(env)) + '</span></span>'
        + '<span class="envact">' + main + '</span>'
        + '</div>'
        + (accelBtn || check
          ? '<div class="envrow envrow-accel"><span class="envact">' + accelBtn + '</span>' + check + '</div>'
          : '')
        // ⭐ 一条实时进度线：只有真在跑的时候才出现（平时这一页是干净的）
        + (live ? '<div class="envlive"><i class="envdot-live"></i><span>' + escape(live.text) + '</span></div>' : '')
        // 状态说明：核心没就绪说核心，核心好了就说加速
        + (!ready && env.text ? '<div class="ai-note">' + escape(env.text) + '</div>' : '')
        + (ready && env.accelText ? '<div class="ai-note">' + escape(env.accelText) + '</div>' : '');

      box.querySelectorAll('[data-engine-env-action]').forEach(button => {
        button.addEventListener('click', event => { event.stopPropagation(); act(button.dataset.engineEnvAction); });
      });
      const checkBox = box.querySelector('[data-engine-auto-accel]');
      if (checkBox) {
        checkBox.addEventListener('change', event => {
          event.stopPropagation();
          setAuto(!!checkBox.checked);
          try { if (root.UI && typeof root.UI.toast === 'function') root.UI.toast(checkBox.checked ? '下次打开软件会自动开启加速' : '下次不再自动开启加速'); } catch (_) { }
        });
        checkBox.addEventListener('click', event => event.stopPropagation());
      }
    });
  }

  // 进度线：由 ui.html 的 startAccel 一步一步推。⚠ 它是唯一写 live 的地方。
  // ⚠ 带超时兜底：万一某条路把 progress 忘了收尾，90 秒后自己消失 ——
  //   绝不让界面卡在一句"正在…"上骗人（本项目最忌讳的故障形态）。
  let liveTimer = 0;
  function progress(text) {
    if (text === null || text === undefined || text === '') { live = null; }
    else { live = { text: String(text), at: Date.now() }; }
    clearTimeout(liveTimer);
    if (live) {
      liveTimer = setTimeout(() => {
        if (live && Date.now() - live.at >= 89000) { live = null; render(); }
      }, 90000);
    }
    render();
  }

  async function act(action) {
    if (action === 'cancel') {
      if (typeof api() !== 'function' || pending === 'cancel') return;
      // ⚠ 取消也是一次"状态变更"：bump revision，让在途的 prepare 结果回来时被丢弃
      //   （不然它回来还会把 pending 清掉、再刷一次，和取消的结果打架）。
      const token = ++revision;
      pending = 'cancel'; render();
      try { await api()('cancel'); } catch (_) { /* 取消失败不报错：接着等原操作收尾 */ }
      if (token === revision) { pending = ''; await refresh(); }
      return;
    }
    if (action === 'removeaccel') {
      if (typeof api() !== 'function' || pending) return;
      const token = ++revision;
      pending = 'removeaccel'; progress('正在拆掉加速包…'); render();
      let result = null;
      try { result = await api()('removeaccel'); }
      catch (error) { result = { ok: false, error: String(error && error.message || error) }; }
      if (token === revision) {
        pending = ''; progress(null);
        if (result && result.ok === false && !result.cancelled && root.ERR) {
          root.ERR.report('ENGINE_ENVIRONMENT_FAILED', {
            message: result.error || '关闭加速没完成',
            context: result.logFile ? { '日志': result.logFile } : {}
          });
        }
        await refresh();
      }
      return;
    }
    // ⭐ 开启加速：交给宿主一条龙去办（环境 → 加速包 → 引擎），这里只显示进度。
    //   ⚠ 故意【不】在这里自己串三步 —— 那样"一处能起一处起不来"迟早出现，
    //     而且宿主那条链还要处理端口占用、确认框这些界面管不了的事。
    if (action === 'accel') {
      if (typeof api() !== 'function' || pending) return;
      const token = ++revision;
      pending = 'accel'; progress('正在准备…'); render();
      let result = null;
      try {
        result = (typeof root.V7EngineAccel === 'function')
          ? await root.V7EngineAccel(progress)
          : { ok: false, error: '这个版本还没有一键开启加速的入口' };
      } catch (error) { result = { ok: false, error: String(error && error.message || error) }; }
      if (token === revision) {
        pending = ''; progress(null);
        if (result && result.ok === false && !result.cancelled && root.ERR) {
          root.ERR.report('ENGINE_ACCEL_FAILED', {
            message: result.error || '开启加速没完成',
            context: result.step ? { '卡在哪一步': String(result.step) } : {}
          });
        }
        await refresh();
      }
      return;
    }
    if (typeof api() !== 'function' || pending) return;
    const token = ++revision;
    pending = action; render();
    try {
      const result = await api()(action);
      if (token === revision && result && result.ok === false && !result.cancelled && root.ERR) {
        root.ERR.report('ENGINE_ENVIRONMENT_FAILED', {
          message: result.error || '环境管理未完成',
          context: result.logFile ? { '日志': result.logFile } : {}
        });
      }
    } catch (error) {
      if (token === revision && root.ERR) root.ERR.report('ENGINE_ENVIRONMENT_FAILED', { message: String(error && error.message || error) });
    } finally {
      if (token === revision) { pending = ''; await refresh(); }
    }
  }

  async function refresh() {
    const S = store();
    if (S && typeof S.refresh === 'function') {
      try { await S.refresh({ force: true, models: false }); } catch (_) { /* 状态出口自己容错 */ }
    }
    render();
  }

  function mount() {
    render();
    const S = store();
    if (S && typeof S.subscribe === 'function' && !subscribed) {
      subscribed = true;
      S.subscribe(() => render());
    }
  }

  root.V7EngineEnvironment = { markup, mount, refresh, progress };
})(window);
