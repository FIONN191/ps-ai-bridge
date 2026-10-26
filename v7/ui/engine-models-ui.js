/* ══════════════════════════════════════════════════════════════════════════
 * V7EngineModels · 模型文件列表（docs/150 Phase B 重构）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 变化（相对 Phase A 之前）：
 *   ① 数据源 = V7EngineStatus（【唯一状态出口】，docs/150 §4.1/§9.2）。
 *      本模块不再自己存一份 catalog 再各处判状态 —— 那正是"同一个模型四个结论"的来源。
 *   ② 新增 request(action, modelKey)：ui.html 里三条断掉的调用（enginesLoadCatalog /
 *      enginesStartInstall）改走它；底层就是 uiwin.engine.models(action, key)。
 *   ③ 只画【列表 + 行内动作】，不画标题/位置：容器由外挂卡配置页在
 *      模型行折叠体里给（永远只有一份，docs/150 §5.2"只移动不复制"）。
 *   ④ mount() 只渲染 + 订阅 store，【不主动刷新】——
 *      刷新时机由宿主控制：卡打开 / 手动重新扫描 / 操作完成（docs/150 §4.1）。
 *   ⑤ 按钮词表统一：安装 / 导入 / 重新扫描 / 取消（docs/150 §二）。
 */
(function (root) {
  'use strict';
  let pending = null, revision = 0, reportedInterruption = null, subscribed = false;
  const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = () => root.uiwin && root.uiwin.engine && root.uiwin.engine.models;
  const store = () => root.V7EngineStatus || null;
  function snapOf() {
    const S = store();
    if (!S || typeof S.snapshot !== 'function') return null;
    try { return S.snapshot(); } catch (_) { return null; }
  }
  function lineOf(model) {
    const S = store();
    if (S && typeof S.modelLine === 'function') { try { return S.modelLine(model); } catch (_) { /* fallthrough */ } }
    return { text: String(model && model.state || ''), tone: '' };
  }
  function markup() { return '<div data-engine-models aria-live="polite"></div>'; }

  function render() {
    const snap = snapOf();
    const models = (snap && Array.isArray(snap.models)) ? snap.models : [];
    const busy = !!pending;
    document.querySelectorAll('[data-engine-models]').forEach(box => {
      const available = typeof api() === 'function';
      box.innerHTML = '<div class="settings-section-title">模型文件</div>'
        + (!available ? '<div class="ai-note">当前版本未提供模型管理</div>' : '')
        + (available && snap && snap.catalogOk === false
            ? '<div class="ai-note">拿不到模型清单 —— 这不代表没有模型，点「重新扫描」再试一次。</div>' : '')
        + (available && (!snap || !models.length)
            ? '<div class="ai-note">还没读到模型清单。点「重新扫描」，或等引擎起来再看。</div>' : '')
        + '<div class="mdl-list">' + models.map(model => {
          const ln = lineOf(model);
          const ok = model.state === 'ok', bad = model.state === 'broken';
          return '<div class="mdl-row' + (ok ? ' on' : bad ? ' bad' : '') + '">'
            + '<div class="mdl-main"><div class="mdl-name">' + escape(model.name || model.key)
              + (model.tier > 0 ? '<span class="mdl-tier">档 ' + escape(model.tier) + '</span>' : '') + '</div>'
            + '<div class="mdl-desc">' + escape(ln.text) + '</div>'
            + (bad && model.reason ? '<div class="mdl-bad">' + escape(model.reason) + '</div>' : '')
            + (model.note ? '<div class="mdl-desc">' + escape(model.note) + '</div>' : '')
            + (model.path ? '<div class="mdl-desc" style="overflow-wrap:anywhere">' + escape(model.path) + '</div>' : '')
            + '<div class="eng-acts">'
            + '<button class="eng-btn" data-model-action="import" data-model-key="' + escape(model.key) + '"' + (busy ? ' disabled' : '') + '>导入</button>'
            + '<button class="eng-btn" data-model-action="download" data-model-key="' + escape(model.key) + '"' + (busy || !model.downloadable ? ' disabled' : '') + '>安装</button>'
            + '</div></div></div>';
        }).join('') + '</div>'
        + '<div class="eng-acts"><button class="eng-btn" data-model-action="catalog"' + (busy ? ' disabled' : '') + '>重新扫描</button>'
        + (busy ? '<button class="eng-btn" data-model-action="cancel"' + (pending.action === 'cancel' ? ' disabled' : '') + '>取消</button>' : '')
        + '</div>'
        + (busy ? '<div class="ai-note">' + (pending.action === 'cancel' ? '正在取消…' : '正在处理模型文件…') + '</div>' : '');
      box.querySelectorAll('[data-model-action]').forEach(button => {
        button.addEventListener('click', event => { event.stopPropagation(); act(button.dataset.modelAction, button.dataset.modelKey); });
      });
    });
  }

  function report(result) {
    if (!result) return;
    if (result.operation && result.operation.status === 'interrupted' && result.operation.token !== reportedInterruption && root.ERR) {
      reportedInterruption = result.operation.token;
      root.ERR.report('ENGINE_MODEL_FAILED', { message: '上次模型操作已中断，请重试；软件会先检查原模型和未完成的提交。' });
    }
    if (result.ok === false && !result.cancelled && !['CANCELLED', 'MODEL_CANCELLED'].includes(result.code) && root.ERR) {
      root.ERR.report('ENGINE_MODEL_FAILED', { message: result.error || '模型文件操作未完成' });
    }
  }

  // 唯一传输口：ui.html 里那三条断链现在改走它（docs/150 §5.4）。
  function request(action, modelKey) {
    const fn = api();
    if (typeof fn !== 'function') return Promise.resolve({ ok: false, error: '当前版本未提供模型管理' });
    return fn(action, modelKey);
  }

  async function act(action, model) {
    if (action === 'catalog') return refresh();
    if (typeof api() !== 'function' || (pending && action !== 'cancel')) return;
    const token = ++revision;
    pending = { action, model }; render();
    let result;
    try { result = await request(action, model); }
    catch (error) { result = { ok: false, error: String(error && error.message || error) }; }
    if (token !== revision) return;
    report(result);
    pending = null;
    await refresh();     // 操作完成 → 重新读一次状态（docs/150 §4.1 的刷新时机）
  }

  async function refresh() {
    const S = store();
    if (S && typeof S.refresh === 'function') {
      try { await S.refresh({ force: true, environment: false }); } catch (_) { /* 状态出口自己容错 */ }
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

  root.V7EngineModels = { markup, mount, refresh, request };
})(window);
