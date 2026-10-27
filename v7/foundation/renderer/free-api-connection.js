// PS AI Bridge 的「免 API 模式」，由 ui.html 在 V7 主脚本之前加载（v7/patches.mjs 加的那一行）。
// V7 的 other 槽位在整合版里叫「免 API 模式」（v7/patches.mjs），这里把它填成本机免 API 生图
// （helper 的 Gemini 兼容接口），排到渠道第一位，并读进可选模型、配上好认的名字：
//   · 槽位里已经是别的地址（以前自己配的中转站）就不动；
//   · 阿吉 / 墨墨 / GRS 都没填 Key 的，第一次直接切到免 API 模式，打开就能出图。
// V7 设置跟账号走：启动后登录态恢复、切换账号时会换一整套设置，所以每次 storage-context 变化都再填一次。
(() => {
  'use strict';
  const BASE = 'http://127.0.0.1:47811/compat';
  const SEEDED = 'psai.freeApiConnection.v1';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (ready, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
      try { if (ready()) return true; } catch (_) {}
    }
    return false;
  };
  const vaultReady = () => typeof settingsRuntime === 'object' && typeof settingsSave === 'function'
    && (typeof settingsVault === 'undefined' || !settingsVault || settingsVault.isLoaded('otherKey'));

  async function loadModels() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await window.uiwin.http.fetch({ url: `${BASE}/v1beta/models`, method: 'GET', timeoutMs: 10000 });
        if (r && r.ok) return JSON.parse(r.body || '{}').models || [];
      } catch (_) { /* 本机服务还在启动 */ }
      await sleep(3000);
    }
    console.warn('[免 API] 本机服务没有响应，模型列表稍后在设置里点「检查连接」再读');
    return [];
  }

  let running = null;
  async function seed() {
    if (!await wait(vaultReady)) return;
    const scope = typeof settingsStorageKey === 'function' ? settingsStorageKey() : '';
    const current = String(settingsRuntime.otherUrl || '').trim().replace(/\/+$/, '');
    if (current && current !== BASE) return;
    const seededKey = `${SEEDED}:${scope}`;
    const firstTime = !localStorage.getItem(seededKey);
    Object.assign(settingsRuntime, { otherUrl: BASE, otherProtocol: 'gemini', otherAuthMode: 'bearer' });
    if (!String(settingsRuntime.otherKey || '').trim()) {
      settingsRuntime.otherKey = 'local';
      if (typeof settingsVault !== 'undefined' && settingsVault) settingsVault.markEdited('otherKey');
    }
    // 出图要走「自有连接」才会到本机；选着「平台算力」的话请求发去夏三七的云端，免 API 根本收不到
    const routedKey = `${SEEDED}.route:${scope}`;
    if (settingsRuntime.provider === 'other' && settingsRuntime.imageComputeSource === 'platform' && !localStorage.getItem(routedKey)) {
      settingsRuntime.imageComputeSource = 'own';
      try { localStorage.setItem(routedKey, '1'); } catch (_) {}
    }
    if (firstTime) {
      const hasPaidKey = ['aji', 'momo', 'grs'].some((slot) => String(settingsRuntime[`${slot}Key`] || '').trim());
      if (!hasPaidKey) Object.assign(settingsRuntime, { provider: 'other', otherConnection: 'custom', imageComputeSource: 'own' });
      const order = window.V7ComputeSlots ? V7ComputeSlots.order(settingsRuntime.computeSlotOrder) : ['aji', 'momo', 'grs'];
      settingsRuntime.computeSlotOrder = ['other', ...order.filter((slot) => slot !== 'other')];
    }
    settingsSave();
    for (const key of ['otherUrl', 'otherKey', 'otherProtocol', 'otherAuthMode', 'provider']) try { syncSettingControl(key); } catch (_) {}
    try { localStorage.setItem(seededKey, new Date().toISOString()); } catch (_) {}

    const rows = await loadModels();
    if (!rows.length || (typeof settingsStorageKey === 'function' && settingsStorageKey() !== scope)) return;
    const models = rows.map((m) => m.id || String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    // 下拉框里显示「AI Studio 网页 · nano-banana-2.1」这种，用户自己改过的名字不覆盖
    const prefs = JSON.parse(JSON.stringify(settingsRuntime.computeModelPrefs || {}));
    const slot = prefs.other || (prefs.other = { hidden: [], names: {} });
    slot.names = slot.names || {};
    let renamed = false;
    for (const id of models) {
      const p = parse(id);
      if (!p) continue;
      const label = `${PLATFORMS[p.platform] || p.platform} · ${modelLabel(id)}`.slice(0, 40);
      const old = slot.names[id];
      // 没起过名，或者是之前版本自动起的（「平台 · 原始模型名」）⇒ 换成新名字；用户自己改的不动
      if (!old || /^(AI Studio 网页|Google Flow|ChatGPT 网页|Codex CLI|Nano Banana 2 · agy)( · |$)/.test(old)) {
        if (old !== label) { slot.names[id] = label; renamed = true; }
      }
    }
    if (renamed) { settingsRuntime.computeModelPrefs = prefs; settingsSave(); }
    if (window.V7ProviderModels) {
      window.V7ProviderModels.save('other', models);
      window.dispatchEvent(new CustomEvent('wheelchair:provider-models', { detail: { slot: 'other' } }));
    }
  }

  // ── 生成卡：先选生图平台，再选这个平台的模型（v7/patches.mjs 在卡片渲染里调这里） ──
  const PLATFORMS = { aistudio: 'AI Studio 网页', flow: 'Google Flow', chatgpt: 'ChatGPT 网页', codex: 'Codex CLI', agy: 'Antigravity（agy）' };
  const NO_MODEL = { chatgpt: 'GPT Image', codex: 'GPT Image', agy: 'Nano Banana 2' };
  const parse = (id) => { const m = /^web-([a-z]+)(?:-(.+))?$/.exec(String(id || '')); return m ? { platform: m[1], model: m[2] || '' } : null; };
  const modelLabel = (id) => {
    const p = parse(id);
    if (!p) return String(id || '');
    if (!p.model) return NO_MODEL[p.platform] || PLATFORMS[p.platform] || p.platform;
    return p.model.split('-').map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ids = () => (window.V7ProviderModels ? V7ProviderModels.modelsFor('other') : []).map(String).filter((id) => parse(id));
  const platformOf = () => {
    const list = ids(), current = parse(aiRuntime.model);
    return current && list.some((id) => parse(id).platform === current.platform) ? current.platform : (list[0] ? parse(list[0]).platform : '');
  };
  window.__PSAI_FREE_API__ = {
    active() {
      try { return aiModelSlot() === 'other' && String(settingsRuntime.otherUrl || '').replace(/\/+$/, '') === BASE && ids().length > 0; } catch (_) { return false; }
    },
    filter(rows) {
      const platform = platformOf();
      return (rows || []).filter((r) => parse(r[0])?.platform === platform).map((r) => [r[0], modelLabel(r[0])].concat(r.slice(2)));
    },
    platformRow() {
      const current = platformOf();
      const platforms = [...new Set(ids().map((id) => parse(id).platform))];
      return '<div class="gcf modelrow">生图平台<div class="modelrow-line"><select data-psai-platform aria-label="免 API 模式的生图平台">'
        + platforms.map((p) => `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(PLATFORMS[p] || p)}</option>`).join('')
        + '</select></div></div>';
    },
  };
  // ── 设置「你在用哪家生图」：先选 免 API 模式 / API 模式 ──
  //   免 API：不显示服务商、配置方案、地址、Key、检查连接，换成四个账号的登录状态和登录按钮；
  //   API：照原来选阿吉 / 墨墨 / GRS（列表里不再出现免 API 模式）。
  const HELPER = 'http://127.0.0.1:47811';
  const LAST_API = 'psai.lastApiProvider';
  const ACCOUNTS = [
    ['google', 'Google 账号', 'AI Studio 网页、Google Flow'],
    ['chatgpt', 'ChatGPT 账号', 'ChatGPT 网页（GPT Image）'],
    ['codex', 'Codex CLI', 'GPT Image（命令行）'],
    ['agy', 'Antigravity CLI（agy）', 'Nano Banana 2（命令行）'],
  ];
  const isFree = () => { try { return settingsRuntime.provider === 'other' && settingsRuntime.otherConnection !== 'grs'; } catch (_) { return false; } };
  const style = document.createElement('style');
  style.textContent = `
    html.psai-free .settings-field:has(> select[data-setting="provider"]),
    html.psai-free [data-provider-other-choice],
    html.psai-free [data-provider-connections],
    html.psai-free .settings-actions:has([data-provider-test]),
    html.psai-free [data-provider-test-status],
    html.psai-free [data-provider-test-status] + .settings-note,
    html.psai-free [data-provider-catalog-host],
    html.psai-free [data-provider-catalog-fold],
    html.psai-free .psai-api-only { display: none !important; }
    html:not(.psai-free) [data-psai-accounts] { display: none !important; }
    .psai-accounts { display: grid !important; grid-template-columns: 1fr !important; grid-column: 1 / -1; gap: 8px; width: 100%; }
    .psai-acc { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: rgba(127,127,127,.08); }
    .psai-acc small { display: block; opacity: .6; font-size: 11px; }
    .psai-acc [data-state] { font-size: 12px; opacity: .8; white-space: nowrap; }
    .psai-acc [data-state="ok"] { color: #4caf7d; opacity: 1; }
    .psai-acc button { white-space: nowrap; }`;
  document.head.appendChild(style);
  const syncMode = () => {
    document.documentElement.classList.toggle('psai-free', isFree());
    for (const sel of document.querySelectorAll('select[data-psai-mode]')) sel.value = isFree() ? 'free' : 'api';
    for (const o of document.querySelectorAll('select[data-setting="provider"] option[value="other"]')) o.hidden = true;
    // 只讲中转站地址 / Key / 检查连接的说明，免 API 模式下用不上
    for (const n of document.querySelectorAll('.settings-note:not(.psai-api-only)')) if (/^(AJI、MOMO 是中转站|「检查连接」会拉)/.test(n.textContent)) n.classList.add('psai-api-only');
  };
  // 面板一直在动画，合并到下一帧再处理
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (document.querySelector('[data-psai-accounts]:not([data-loaded])')) refreshAccounts();
      syncMode();
    });
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('wheelchair:settings-changed', syncMode);

  async function refreshAccounts() {
    for (const el of document.querySelectorAll('[data-psai-accounts]')) el.dataset.loaded = '1';
    let status = null;
    try { const r = await window.uiwin.http.fetch({ url: `${HELPER}/accounts`, method: 'GET', timeoutMs: 15000 }); status = r && r.ok ? JSON.parse(r.body) : null; } catch (_) {}
    for (const [id] of ACCOUNTS) {
      const cli = status && status.cli && status.cli[id];
      const ok = cli ? cli.loggedIn : status && status[id] === true;
      const text = !status ? '本机服务未连接' : cli && cli.note ? cli.note : cli && !cli.installed ? '未安装' : ok ? '已登录' : status[id] === null ? '状态未知' : '未登录';
      for (const row of document.querySelectorAll(`[data-psai-acc="${id}"]`)) {
        const state = row.querySelector('[data-state]');
        state.textContent = text; state.dataset.state = ok ? 'ok' : '';
        row.querySelector('button').textContent = cli && !cli.installed ? '去安装' : ok ? '重新登录' : '登录';
      }
    }
    return status;
  }

  Object.assign(window.__PSAI_FREE_API__, {
    settingsModeRow() {
      return '<label class="settings-field"><span>生图方式</span><select data-psai-mode aria-label="生图方式">'
        + `<option value="free"${isFree() ? ' selected' : ''}>免 API 模式（用自己的账号）</option>`
        + `<option value="api"${isFree() ? '' : ' selected'}>API 模式（中转站 Key）</option></select></label>`;
    },
    settingsAccounts() {
      return '<div class="psai-accounts" data-psai-accounts>'
        + ACCOUNTS.map(([id, name, use]) => `<div class="psai-acc" data-psai-acc="${id}"><div>${esc(name)}<small>${esc(use)}</small></div><span data-state>检查中…</span><button type="button" class="settings-btn" data-psai-login="${id}">登录</button></div>`).join('')
        + '<div class="settings-note">免 API 模式用你自己的账号出图，不扣积分、不用填地址和 Key。Google / ChatGPT 在单独的专用 Chrome 里登录一次即可；Codex CLI、agy 会打开「终端」跑它们自己的登录。使用这些服务需要自备魔法。</div></div>';
    },
  });

  function setProvider(value) {
    const select = document.querySelector('select[data-setting="provider"]');
    if (select) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }
    else { settingsRuntime.provider = value; settingsSave(); }
  }
  document.addEventListener('change', (event) => {
    const mode = event.target.closest && event.target.closest('select[data-psai-mode]');
    if (!mode) return;
    if (mode.value === 'free') {
      if (!isFree()) try { localStorage.setItem(LAST_API, settingsRuntime.provider); } catch (_) {}
      settingsRuntime.otherConnection = 'custom';
      setProvider('other');
    } else {
      let last = 'aji';
      try { last = localStorage.getItem(LAST_API) || 'aji'; } catch (_) {}
      setProvider(['aji', 'momo', 'grs'].includes(last) ? last : 'aji');
    }
    syncMode();
  }, true);
  document.addEventListener('click', async (event) => {
    const button = event.target.closest && event.target.closest('[data-psai-login]');
    if (!button) return;
    button.disabled = true;
    try {
      const r = await window.uiwin.http.fetch({ url: `${HELPER}/accounts/login`, method: 'POST', headers: { 'x-ps-ai-bridge': '1', 'content-type': 'application/json' }, body: JSON.stringify({ site: button.dataset.psaiLogin }), timeoutMs: 30000 });
      const reply = r && r.ok ? JSON.parse(r.body || '{}') : null;
      if (reply && reply.needInstall && reply.install) await window.uiwin.openExternalUrl(reply.install);
      // 登录在 Chrome / 终端里完成，回来后状态自己会变
      for (let i = 0; i < 40; i++) { await sleep(3000); const s = await refreshAccounts(); const id = button.dataset.psaiLogin; if (s && (s.cli && s.cli[id] ? s.cli[id].loggedIn : s[id] === true)) break; }
    } finally { button.disabled = false; }
  });

  // 换平台：把模型下拉换成这个平台的，选中第一个，再交给 V7 自己的「模型变了」处理（保存、重画）
  document.addEventListener('change', (event) => {
    const select = event.target.closest && event.target.closest('select[data-psai-platform]');
    if (!select) return;
    const first = ids().find((id) => parse(id).platform === select.value);
    const model = select.closest('.generation-compute, form, section, div')?.parentElement?.querySelector('select[data-ai-field="model"]') || document.querySelector('select[data-ai-field="model"]');
    if (!first || !model) return;
    model.innerHTML = ids().filter((id) => parse(id).platform === select.value).map((id) => `<option value="${esc(id)}">${esc(modelLabel(id))}</option>`).join('');
    model.value = first;
    model.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);

  // 在设置里把服务商换成「免 API 模式」时，算力来源一起换到本机（不然还会发去平台算力）
  let lastProvider = null;
  window.addEventListener('wheelchair:settings-changed', () => {
    try {
      const provider = settingsRuntime.provider;
      if (lastProvider !== null && provider === 'other' && lastProvider !== 'other' && settingsRuntime.imageComputeSource === 'platform') {
        settingsRuntime.imageComputeSource = 'own';
        settingsSave();
      }
      lastProvider = provider;
    } catch (_) {}
  });

  const run = () => { running = (running || Promise.resolve()).then(seed).catch((e) => console.warn('[免 API]', e && e.message || e)); };
  // V7 换账号时先读新设置、再读密钥；等一会儿再填，免得被它读回来的值盖掉
  window.addEventListener('wheelchair:storage-context', () => setTimeout(run, 1500));
  run();
})();
