// 由 PS AI Bridge 主进程在修图轮椅面板（ui.html）加载完后注入，不改 V7 自己的文件。
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
    if (firstTime) {
      const hasPaidKey = ['aji', 'momo', 'grs'].some((slot) => String(settingsRuntime[`${slot}Key`] || '').trim());
      if (!hasPaidKey) Object.assign(settingsRuntime, { provider: 'other', otherConnection: 'custom' });
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
    for (const m of rows) {
      const id = m.id || String(m.name || '').replace(/^models\//, '');
      const label = String(m.displayName || '').replace(/^免 API · /, '').replace(/^(Nano Banana|GPT Image) · /, '');
      if (id && label && !slot.names[id]) { slot.names[id] = label.slice(0, 40); renamed = true; }
    }
    if (renamed) { settingsRuntime.computeModelPrefs = prefs; settingsSave(); }
    if (window.V7ProviderModels) {
      window.V7ProviderModels.save('other', models);
      window.dispatchEvent(new CustomEvent('wheelchair:provider-models', { detail: { slot: 'other' } }));
    }
  }

  const run = () => { running = (running || Promise.resolve()).then(seed).catch((e) => console.warn('[免 API]', e && e.message || e)); };
  // V7 换账号时先读新设置、再读密钥；等一会儿再填，免得被它读回来的值盖掉
  window.addEventListener('wheelchair:storage-context', () => setTimeout(run, 1500));
  run();
})();
