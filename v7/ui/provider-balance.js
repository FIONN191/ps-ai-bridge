(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.V7ProviderBalance=api;})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const fail=(code,message)=>Object.assign(new Error(message),{code});

  /* ═══════════════════════════════════════════════════════════════════════
     provider-balance.js —— 查"这家服务商我还有多少钱"

     ⚠⚠ 2026-10-07 新增。用户要求：「加上给 API key 查询余额的功能……阿吉和陌陌有标准预埋的
       可以查询 API key 的接口」。实现口径【完全照搬 V6】，接口和字段都是从 V6 抄的，
       来源（只读核对过，不再猜）：
         · V6 host/bootstrap-handlers.js:346,360,384,391
           —— 阿吉余额：GET {url}/api/usage/token → data.total_available ÷ 500000 = 美元
         · V6 tiles/tile-tasks.host.js:341,346,353,356,378,388,391-397
           —— quota_per_unit 倍率：GET {url}/api/status → data.quota_per_unit（缓存 10 分钟，失败退 500000）
           —— 陌陌余额：GET {url}/api/usage/token/ → owner_balance_usd 等（已是美元）
         · V6 tiles/tile-tasks.host.js:226,233
           —— GRS 积分：POST {url}/client/openapi/getAPIKeyCredits {apiKey} → data.credits（积分，不是钱）

     ⚠⚠ 三条边界（别越界，越了就出错数字）：
       1. 【阿吉和陌陌是"新的钱"（美元）】，GRS 是【积分 pts】——同一个余额框，两种单位，
          所以返回值里必须带 unit，界面按 unit 决定显示 "$12.34" 还是 "1234 pts"。
       2. 【自定义槽不查余额】——用户明确说"自定义的就不要给余额了"。
          别家的中转站不一定有 new-api 那套 /api/usage/token。
       3. 【查余额 ≠ 能出图】——余额查得到只说明额度在，不代表模型可用、也不代表价格。
          界面文案别把它说成"已验证"。
     ═══════════════════════════════════════════════════════════════════════ */

  const DEFAULT_QUOTA_PER_UNIT = 500000;   // new-api 默认：500000 quota = 1 美元（管理员可改）
  const QUOTA_CACHE_MS = 10 * 60 * 1000;   // V6 同款：倍率缓存 10 分钟

  function create(options){
    const http = options.http || {};
    let sequence = 0;
    let active = null;                       // {id, cancelled}
    let quotaCache = { value: DEFAULT_QUOTA_PER_UNIT, at: 0, base: '' };

    // 只认能查到余额的槽（用户定的：阿吉 / 陌陌 / 旧 GRS）
    function canQuery(slot){
      return ['aji','momo','grs'].includes(String(slot||''));
    }

    function cleanBase(raw){
      const v = String(raw||'').trim();
      if (!v) throw fail('PROVIDER_BALANCE_FAILED','请先填写服务地址');
      let url;
      try { url = new URL(v); } catch(_) { throw fail('PROVIDER_BALANCE_FAILED','服务地址格式无效，请填写完整地址'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw fail('PROVIDER_BALANCE_FAILED','服务地址不得包含账号、查询参数或片段');
      }
      return v.replace(/\/+$/,'');
    }

    function needKey(config){
      const key = String(config.apiKey||'').trim();
      if (!key) throw fail('PROVIDER_BALANCE_FAILED','请先填写当前服务商的 API Key');
      return key;
    }

    function nextId(prefix){ return prefix+'-'+Date.now()+'-'+(++sequence); }

    // 统一的请求描述：跟 provider-probe 用【同一个 http 桥】，形制也保持一致
    function describe(desc){
      return { url:desc.url, method:desc.method||'GET', headers:desc.headers||{},
               body:desc.body, timeoutMs:desc.timeoutMs||12000, requestId:desc.requestId };
    }

    async function fetchJson(desc, token, guard){
      if (token.cancelled) throw fail('PROVIDER_BALANCE_CANCELLED','余额查询已取消');
      // 竞速选线（probe）给每条线路单独限时（V6 同款单个 8 秒）
      const d = describe(token.timeoutMs ? Object.assign({}, desc, { timeoutMs: Math.min(desc.timeoutMs || 12000, token.timeoutMs) }) : desc);
      token.id = d.requestId;
      const res = await http.fetch(d);
      guard();
      if (token.cancelled) throw fail('PROVIDER_BALANCE_CANCELLED','余额查询已取消');
      // ⭐ 10-25（反馈 #48 #55）：429 是「查得太频繁、被服务商限流」，不是地址或 Key 不对 —— 原来一律写「请核对地址与 Key」，用户以为 Key 不认
      if (res && Number(res.status) === 429) throw fail('PROVIDER_BALANCE_RATE_LIMITED','查余额太频繁了，服务商暂时不让查（HTTP 429）。过半分钟再点；不影响出图');
      if (!res || !res.ok) throw fail('PROVIDER_BALANCE_FAILED','余额接口返回 HTTP '+((res&&res.status)||'未知')+'；请核对地址与 Key');
      let json = null;
      try { json = JSON.parse(res.body||''); } catch(_) { throw fail('PROVIDER_BALANCE_FAILED','余额接口返回了网页或无法识别的数据'); }
      return { json, status: res.status };
    }

    // ── new-api 的换算倍率（管理员可以改，所以要去问一句；问不到才退回默认）──
    // ⚠ 缓存 10 分钟（V6 同款）。按 base 分开缓存：换了地址不能沿用上一家的倍率。
    async function quotaPerUnit(base, token, guard){
      if (quotaCache.base === base && quotaCache.at && (Date.now() - quotaCache.at) < QUOTA_CACHE_MS) {
        return quotaCache.value;
      }
      try {
        const { json } = await fetchJson({
          url: base + '/api/status', method:'GET', headers:{ Accept:'application/json' },
          timeoutMs: 4000, requestId: nextId('provider-status')
        }, token, guard);
        const raw = json && json.data && json.data.quota_per_unit;
        const n = Number(raw);
        if (isFinite(n) && n > 0) {
          quotaCache = { value:n, at:Date.now(), base };
          return n;
        }
      } catch(_) { /* 问不到就用默认值 —— 不能因为倍率查不到就把余额整块废掉 */ }
      quotaCache = { value:DEFAULT_QUOTA_PER_UNIT, at:Date.now(), base };
      return DEFAULT_QUOTA_PER_UNIT;
    }

    // ── 阿吉：GET /api/usage/token → data.total_available ÷ 倍率 ──
    async function checkAji(config, token, guard){
      const base = cleanBase(config.baseUrl);
      needKey(config);
      const { json } = await fetchJson({
        url: base + '/api/usage/token', method:'GET',
        headers:{ Accept:'application/json', Authorization:'Bearer '+String(config.apiKey).trim() },
        requestId: nextId('provider-balance-aji')
      }, token, guard);
      const d = json && json.data;
      // ⚠ V6 的防串台判据：必须能拿到 total_available 才算阿吉的接口
      //   （防止某个地址返回 200、但内容是别家的 JSON —— 那样算出来的"余额"是错的）
      if (!d || d.total_available === undefined) throw fail('PROVIDER_BALANCE_FAILED','这个地址没有返回阿吉的余额格式');
      const per = await quotaPerUnit(base, token, guard);
      const usd = Number(d.total_available) / per;
      if (!isFinite(usd)) throw fail('PROVIDER_BALANCE_FAILED','余额数据无法换算');
      return { unit:'usd', amount:usd, raw:Number(d.total_available), quotaPerUnit:per, provider:'aji' };
    }

    // ── 陌陌：GET /api/usage/token/（注意尾斜杠）→ owner_balance_usd（已是美元）──
    async function checkMomo(config, token, guard){
      const base = cleanBase(config.baseUrl);
      needKey(config);
      const { json } = await fetchJson({
        url: base + '/api/usage/token/', method:'GET',
        headers:{ Accept:'application/json', Authorization:'Bearer '+String(config.apiKey).trim() },
        requestId: nextId('provider-balance-momo')
      }, token, guard);
      const d = (json && json.data) ? json.data : (json || {});
      // ⚠⚠ 2026-10-24 修（用户：「会查出逆天余额」，实测 api.momoapi.icu 一个 Key 查出 $922138）：
      //   这个接口回两套余额 ——
      //     · balance_usd / remain_quota        = 【这个 Key 自己】还能花多少（实测 197.23，= 98613191 ÷ 500000）
      //     · owner_balance_usd / owner_quota   = Key 背后【主账号】的总余额（实测 922138.36，墨墨那边的大账号）
      //   原来照 V6 先取 owner_balance_usd ⇒ 显示的是主账号的钱。
      //   现在：Key 有限额 ⇒ 用 Key 自己的；主账号的钱比 Key 剩的还少 ⇒ 取小的（主账号没钱了 Key 也花不出去）；
      //         Key 设成不限额 ⇒ 能花多少只看主账号。
      const num = v => (v === undefined || v === null || v === '') ? null : Number(v);
      const unlimited = d.unlimited_quota === true || d.unlimited_quota === 1;
      let perCache = null;
      const per = async () => (perCache === null ? (perCache = await quotaPerUnit(base, token, guard)) : perCache);
      let tokenAmount = num(d.balance_usd), tokenSource = 'balance_usd';
      if (tokenAmount === null && num(d.remain_quota) !== null) { tokenAmount = num(d.remain_quota) / await per(); tokenSource = 'remain_quota'; }
      let ownerAmount = num(d.owner_balance_usd);
      if (ownerAmount === null && num(d.owner_quota) !== null) ownerAmount = num(d.owner_quota) / await per();
      let amount = null, source = '';
      if (unlimited && ownerAmount !== null && isFinite(ownerAmount)) { amount = ownerAmount; source = 'owner(unlimited)'; }
      else if (tokenAmount !== null && isFinite(tokenAmount)) {
        amount = tokenAmount; source = tokenSource;
        if (ownerAmount !== null && isFinite(ownerAmount) && ownerAmount < tokenAmount) { amount = ownerAmount; source = 'owner(lower)'; }
      }
      else if (ownerAmount !== null) { amount = ownerAmount; source = 'owner_balance_usd'; }
      if (amount === null || !isFinite(amount)) throw fail('PROVIDER_BALANCE_FAILED','这个地址没有返回可识别的余额字段');
      return { unit:'usd', amount, raw:num(d.remain_quota) === null ? undefined : num(d.remain_quota),
               source, unlimited, ownerAmount: ownerAmount === null ? undefined : ownerAmount,
               expiresAt: d.expires_at || '', provider:'momo' };
    }

    // ── GRS：POST /client/openapi/getAPIKeyCredits → data.credits（积分，不是钱）──
    async function checkGrs(config, token, guard){
      const base = cleanBase(config.baseUrl);
      const key = needKey(config);
      const { json } = await fetchJson({
        url: base + '/client/openapi/getAPIKeyCredits', method:'POST',
        headers:{ Accept:'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify({ apiKey: key }),
        requestId: nextId('provider-balance-grs')
      }, token, guard);
      // ⚠ V6 的判据：code === 0 且 data 存在才算成功
      if (!json || Number(json.code) !== 0 || !json.data) {
        throw fail('PROVIDER_BALANCE_FAILED','积分查询返回异常'+(json && json.msg ? '：'+String(json.msg).slice(0,60) : ''));
      }
      const credits = Number(json.data.credits);
      if (!isFinite(credits)) throw fail('PROVIDER_BALANCE_FAILED','积分数据无法识别');
      return { unit:'pts', amount:credits, provider:'grs' };
    }

    // ── 陌陌的消费明细：GET /api/billing/token?period=daily|weekly|monthly ──
    async function billing(config, period){
      const base = cleanBase(config.baseUrl);
      needKey(config);
      const p = ['daily','weekly','monthly'].includes(String(period)) ? String(period) : 'daily';
      const token = { id:'', cancelled:false };
      const { json } = await fetchJson({
        url: base + '/api/billing/token?period='+encodeURIComponent(p), method:'GET',
        headers:{ Accept:'application/json', Authorization:'Bearer '+String(config.apiKey).trim() },
        requestId: nextId('provider-billing-momo')
      }, token, ()=>{});
      if (!json || json.success !== true || !json.data) {
        throw fail('PROVIDER_BALANCE_FAILED','消费明细返回异常'+(json && json.message ? '：'+String(json.message).slice(0,60) : ''));
      }
      return { period:p, data:json.data };
    }

    async function check(config, guard=()=>{}){
      if (active) throw fail('PROVIDER_BALANCE_FAILED','余额查询正在进行，请先等待或取消');
      const slot = String(config.connectionSlot || config.provider || '');
      if (!canQuery(slot)) throw fail('PROVIDER_BALANCE_FAILED','这个连接不提供余额查询');
      const token = { id:'', cancelled:false };
      active = token;
      try {
        guard();
        let out;
        if (slot === 'aji') out = await checkAji(config, token, guard);
        else if (slot === 'momo') out = await checkMomo(config, token, guard);
        else out = await checkGrs(config, token, guard);
        guard();
        if (token.cancelled) throw fail('PROVIDER_BALANCE_CANCELLED','余额查询已取消');
        return { ok:true, slot, checkedAt:new Date().toISOString(), ...out };
      } catch(error){
        if (token.cancelled) throw fail('PROVIDER_BALANCE_CANCELLED','余额查询已取消');
        if (['PROVIDER_BALANCE_FAILED','PROVIDER_BALANCE_CANCELLED','PROVIDER_BALANCE_RATE_LIMITED'].includes(error && error.code)) throw error;
        throw fail('PROVIDER_BALANCE_FAILED','余额查询未完成，请检查网络与服务地址后重试');
      } finally {
        if (active === token) active = null;
      }
    }

    // ⭐ 2026-10-24（V7待办/02 竞速选线，ui-pure/provider-lines.js）：同一个 Key 同时去问好几条线路的余额。
    //   ⚠ 跟 check() 的区别：【不上锁】（check 同一时间只许一个，给设置卡用）、不报错只回结果、带耗时。
    //   只认阿吉 / 墨墨（GRS 没有线路池）。
    async function probe(config, opts){
      const slot = String(config.connectionSlot || config.provider || '');
      const started = Date.now();
      const token = { id:'', cancelled:false, timeoutMs: Number(opts && opts.timeoutMs) || 8000 };
      try {
        if (slot !== 'aji' && slot !== 'momo') throw fail('PROVIDER_BALANCE_FAILED','这个连接没有线路竞速');
        const out = slot === 'aji' ? await checkAji(config, token, ()=>{}) : await checkMomo(config, token, ()=>{});
        return { ok:true, slot, url: cleanBase(config.baseUrl), latencyMs: Date.now() - started, ...out };
      } catch(error){
        // 限流（429）= 这条线路是通的、认这个 Key，只是查得太勤 —— 照样算参赛有效，余额不知道（选线时排在查到余额的后面）
        if (error && error.code === 'PROVIDER_BALANCE_RATE_LIMITED')
          return { ok:true, rateLimited:true, slot, url: cleanBase(config.baseUrl), latencyMs: Date.now() - started, amount:null };
        return { ok:false, slot, url: String(config.baseUrl||'').replace(/\/+$/,''), latencyMs: Date.now() - started,
                 error: String(error && error.message || error) };
      }
    }

    async function cancel(){
      if (!active) return;
      active.cancelled = true;
      if (active.id && http.cancel) { try { await http.cancel(active.id); } catch(_) {} }
    }

    return { canQuery, check, probe, billing, cancel, busy:()=>!!active, DEFAULT_QUOTA_PER_UNIT };
  }

  return { create, DEFAULT_QUOTA_PER_UNIT };
});
