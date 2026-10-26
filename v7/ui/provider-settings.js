(function(root){
  'use strict';let host,controller,probe,balance,probeToken=null;
  /* ═══════════════════════════════════════════════════════════════════════
     provider-settings.js —— 「服务商与连接」这一块的接线

     ⚠⚠ 2026-10-07 大改（用户要求）：原来只做"检查连接 = 拉模型列表"，
       现在一次做完三件：拉模型 + 查余额 + 把模型名单交给生成卡。

     用户原话（决定了下面每一条的行为）：
       ·「输入完成之后，你点一下检查连接，点检查连接之后，它的余额就自动的出现了」
       ·「那个出现的余额应该是一个框框，然后你再点余额就会刷新余额」
       ·「在用户输入完这个 URL 之后，你那个地方需要有一个表示现在我们还没有检查这个状态，
           URL 暂时不知道可不可用类似的表述，然后引导用户去点一下那个按钮」
       ·「每一次开机的时候自动的去选一遍模型」「切换过去的时候自动查一次」
       ·「余额的间隔……十分钟吧」
       ·「自定义的就不要给余额了」
       ·「有模型消失了或者有新增模型，要提醒一下用户（不要弹窗打断）」

     ⚠⚠ 三条不许越界的规矩：
       1. 余额框【点了才刷】；除了"开机 / 切槽 / 每 10 分钟"这三种时机，不许自己乱打接口
          —— 这是计费类接口，打太勤会被中转站限流。
       2. 查余额失败【不覆盖上次成功的数字】，只标注失败 + 保留时间（用户定："报错，加上上次时间"）。
       3. 任何一处拿不到数据都【不许编数字】：显示"—"或"未接入"，不显示猜测值。
     ═══════════════════════════════════════════════════════════════════════ */

  const BALANCE_TICK_MS = 10 * 60 * 1000;   // 用户定：10 分钟
  const BALANCE_STORE = 'v7.providerBalance.v1';

  let balanceTimer = 0;
  let balanceCache = {};        // 槽 → {unit, amount, at, unlimited, expiresAt, source, stale?}
  let modelNote = {};           // 槽 → {gone:[], added:[], at}  模型变化提示
  let lowWarned = {};           // 槽 → 是否已经就"低于阈值"提醒过（避免每 10 分钟弹一次）

  const context=()=>root.WHEELCHAIR_STORAGE?.namespaceId?.()+'|'+String(root.V7Backend?.state().baseUrl||'');
  const report=error=>{if(error.code==='PROVIDER_TEST_CANCELLED'||error.code==='PROVIDER_BALANCE_CANCELLED')return;root.ERR?.report(error.code||'PROVIDER_CATALOG_INVALID',{message:String(error.message||error)});};
  function fingerprint(value){return JSON.stringify([context(),value.provider,value.connectionSlot,value.baseUrl,value.apiKey,value.protocol,value.authMode,value.endpoint]);}
  const slot=()=>String(host?.runtime()?.connectionSlot||host?.settings()?.provider||'aji');

  // ── 余额的本地缓存：关掉再开先显示旧的，再刷新（用户定"要缓存记住"）──
  function loadBalance(){
    try{const raw=localStorage.getItem(BALANCE_STORE);const d=raw?JSON.parse(raw):null;
      if(d&&typeof d==='object'&&!Array.isArray(d))balanceCache=d;}catch(_){}
  }
  function saveBalance(){ try{localStorage.setItem(BALANCE_STORE,JSON.stringify(balanceCache));}catch(_){} }

  // ⚠ 单位由【余额模块】给（GRS=pts、阿吉/陌陌=usd），这里不许自己猜：
  //   同一个框里两种钱，猜错就是把积分当美元显示。
  function moneyText(unit,amount){
    if(unit==='pts')return Math.round(Number(amount)||0).toLocaleString()+' pts';
    if(unit!=='usd')return '—';
    // ⭐ 2026-10-24（用户定）：阿吉 / 墨墨的余额和单价一律显示「¥」——【只换符号，不换算汇率】，数字跟中转站后台一样。
    return '¥'+(Number(amount)||0).toFixed(2);
  }

  function syncFields(){const settings=host.settings();for(const el of document.querySelectorAll('[data-provider-connections] [data-setting]'))if(Object.hasOwn(settings,el.dataset.setting))el.value=settings[el.dataset.setting];visibility();paintBalance();paintModelNote();}
  function visibility(){if(!host)return;const connection=root.V7ProviderConnections.connection(host.settings());for(const el of document.querySelectorAll('[data-provider-connection-slot]'))el.hidden=el.dataset.providerConnectionSlot!==connection.slot;for(const el of document.querySelectorAll('[data-provider-other-choice]'))el.hidden=connection.provider!=='other';}

  // ⚠⚠⚠ 2026-10-07 修掉的真 bug：这两个画函数原来用 querySelector（只找【第一个】）。
  //   而设置卡有两处宿主 —— 详情层 #dcBody 和工作区（fillSettingsDetail 的 workspaceBody），
  //   同一时刻可能存在【两份】余额框。只画第一个 ⇒ 另一份永远停在"尚未检查"，
  //   而且用户点的是没被画的那一份时，会以为功能坏了（还不报错）。
  //   ⇒ 一律 querySelectorAll 全画。
  const 所有 = sel => [...document.querySelectorAll(sel)];

  // ── 余额框：只画，不请求 ──
  //   ⚠ 没查过的时候必须说清楚"还没检查"，并引导用户去点按钮（用户特意要求的）
  function paintBalance(){
    const 框们=所有('[data-provider-balance]');
    if(!框们.length)return;
    const s=slot();
    const can=balance?balance.canQuery(s):false;
    const rec=balanceCache[s];
    for(const box of 框们){
      box.dataset.slot=s;
      box.dataset.can=can?'1':'0';
      if(!can){
        box.dataset.state='none';
        box.innerHTML='<span class="pb-label">余额</span><span class="pb-value pb-dim">这个连接不提供余额查询</span>';
        box.removeAttribute('title');
        continue;
      }
      if(!rec||rec.amount==null){
        box.dataset.state='unknown';
        box.innerHTML='<span class="pb-label">余额</span><span class="pb-value pb-dim">尚未检查 —— 地址暂时不知道可不可用，点「检查连接」看一眼</span>';
        box.title='还没查过这个地址的余额';
        continue;
      }
      const 金额=moneyText(rec.unit,rec.amount);
      const 时间=rec.at?new Date(rec.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'—';
      const 额外=[];
      if(rec.unlimited)额外.push('不限量');
      if(rec.expiresAt)额外.push('到期 '+String(rec.expiresAt).slice(0,10));
      if(rec.stale)额外.push('上次 '+new Date(rec.staleAt||rec.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}));
      box.dataset.state='known';
      box.innerHTML='<span class="pb-label">余额</span><span class="pb-value">'+金额+'</span>'
        +(额外.length?'<span class="pb-extra">'+额外.join(' · ')+'</span>':'')
        +'<span class="pb-at">'+时间+'</span><span class="pb-hint">点一下刷新</span>';
      box.title='点一下刷新余额（上次查询 '+(rec.at?new Date(rec.at).toLocaleString('zh-CN'):'—')+'）';
    }
  }

  // ── 模型变化提示：只写在状态行里，不弹窗（用户定"不要弹窗打断"）──
  function paintModelNote(){
    const n=modelNote[slot()];
    const 该说的话=(!n||(!n.gone.length&&!n.added.length))?'':(function(){
      const 句子=[];
      if(n.added.length)句子.push('新增 '+n.added.length+' 个（'+n.added.slice(0,3).join('、')+(n.added.length>3?'…':'')+'）');
      if(n.gone.length)句子.push('消失 '+n.gone.length+' 个（'+n.gone.slice(0,3).join('、')+(n.gone.length>3?'…':'')+'）');
      return '模型名单有变化：'+句子.join('；')+'（'+(n.at?new Date(n.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'')+'）';
    })();
    for(const el of 所有('[data-provider-modelnote]')){
      el.hidden=!该说的话; el.textContent=该说的话;
    }
  }

  // ── 查余额（点了才跑 / 定时跑 / 开机跑）──
  //   ⚠ 失败时【不覆盖】上次成功的数字，只加 stale 标记（用户定："报错，加上上次时间"）
  //   ⚠⚠ 2026-10-07 修：`quiet` 参数。开机的自动检查【绝不能弹报错卡】——
  //     开机时用户还没填地址/Key，余额模块会抛"请先填写服务地址"，
  //     结果屏幕上弹出一张"出了点问题：请先填写服务地址"的红卡（实拍抓到的）。
  //     那是正常的"还没配好"，不是错误。⇒ 自动触发的那几路一律 quiet。
  async function refreshBalance(reason, quiet){
    if(!host||!balance)return null;
    const s=slot();
    if(!balance.canQuery(s))return null;
    if(balance.busy())return null;
    const before=balanceCache[s];
    // 自动那几路：没地址/没 Key 就【连试都不试】，直接安静退出（省一次无意义的报错）
    if(quiet){
      const r=host.runtime();
      if(!String(r&&r.baseUrl||'').trim()||!String(r&&r.apiKey||'').trim())return null;
    }
    try{
      const snapshot={...host.runtime()};
      const result=await balance.check(snapshot,()=>{});
      balanceCache[s]={unit:result.unit,amount:result.amount,at:result.checkedAt,
        unlimited:!!result.unlimited,expiresAt:result.expiresAt||'',source:result.source||''};
      saveBalance();
      checkLowBalance(s,balanceCache[s]);
      paintBalance();
      // ⚠ 通知生成卡：余额变了，"约能生成 N 张"要跟着更新（不通知就一直是旧数字，还不报错）
      try{root.dispatchEvent(new CustomEvent('wheelchair:provider-balance',{detail:{slot:s}}));}catch(_){}
      return result;
    }catch(error){
      if(error&&error.code==='PROVIDER_BALANCE_CANCELLED')return null;
      if(before&&before.amount!=null){
        // 保留旧数字 + 标注"上次"（用户定）——清掉它反而让人以为额度没了
        balanceCache[s]={...before,stale:true,staleAt:before.at};
      }else{
        balanceCache[s]={unit:'usd',amount:null,at:null,failed:true,error:String(error&&error.message||error)};
      }
      saveBalance();paintBalance();
      // ⚠ 自动那几路【不写状态行、不报错卡】——用户没点任何东西，弹错就是打扰
      if(!quiet){
        for(const el of 所有('[data-provider-test-status]'))el.textContent='余额查询没成功：'+String(error&&error.message||error)+(before&&before.amount!=null?'（上面显示的是上次的结果）':'');
        // 限流（429）不弹报错卡：状态行已经说清楚了，过一会儿再点就好（10-25 反馈 #48 #55：用户以为 Key 不认，连点 11 次）
        if((!before||before.amount==null)&&!(error&&error.code==='PROVIDER_BALANCE_RATE_LIMITED'))report(error);
      }
      return null;
    }
  }

  // ── 余额不足提醒（阈值用户自己填美元数字）──
  //   ⚠ 只在【跌破阈值那一下】提醒一次；回升后再跌破会再提醒（否则 10 分钟弹一次，没法用）
  function checkLowBalance(s,rec){
    const limit=Number(host?.settings()?.lowBalanceUSD);
    if(!isFinite(limit)||limit<=0)return;
    if(!rec||rec.amount==null||rec.unit!=='usd')return;
    const below=rec.amount<limit;
    if(below&&!lowWarned[s]){
      lowWarned[s]=true;
      try{root.UI?.notice?.({title:'余额不足提醒',level:'warn',
        body:'当前余额 '+moneyText(rec.unit,rec.amount)+'，已经低于你设的提醒线 ¥'+limit.toFixed(2)+'。',
        detail:'这个提醒只在【余额掉到线下】时出现一次；充值回升、再跌破时会再提醒。\n地址与 Key 在设置卡 →「服务商与连接」，点余额框可以随时刷新。'});}catch(_){}
    }
    if(!below)lowWarned[s]=false;
  }

  // ── 定时器：只在设置卡第 0 页开着、页面可见时才跑 ──
  function tick(){
    const panel=document.querySelector('.settings-panel[data-settings-zone="0"]');
    const 开着=panel&&panel.offsetParent!==null;
    if(!开着||document.hidden)return;
    refreshBalance('timer',true);   // ⚠ 自动那几路一律 quiet=true（不弹报错卡、不写状态行）
  }
  function startTimer(){ if(balanceTimer)return; balanceTimer=setInterval(tick,BALANCE_TICK_MS); }
  function stopTimer(){ if(balanceTimer){clearInterval(balanceTimer);balanceTimer=0;} }

  function changed(){if(!host)return;visibility();paintBalance();paintModelNote();for(const sl of document.querySelectorAll('[data-provider-connection-slot]')){const protocol=sl.querySelector('[data-setting$="Protocol"]'),auth=sl.querySelector('[data-setting$="AuthMode"]');if(auth){const native=auth.querySelector('option[value="x-goog-api-key"]');if(native)native.disabled=protocol?.value!=='gemini';if(protocol?.value!=='gemini'&&auth.value==='x-goog-api-key'){auth.value='bearer';const key=auth.dataset.setting;if(key)host.settings()[key]='bearer';}}}if(probeToken&&probeToken.fingerprint!==fingerprint(host.runtime())){probeToken=null;probe?.cancel().catch(()=>{});}for(const el of document.querySelectorAll('[data-provider-test-status]')){if(el.dataset.fingerprint!==fingerprint(host.runtime())){el.textContent='尚未测试当前连接';el.dataset.fingerprint='';}}}

  /* ── 一次完整的「检查连接」：拉模型 + 查余额 + 记名单 ──
     ⚠ 两件事【各自成败互不牵连】：模型拉到了但余额查不到，也要把模型留下（反之亦然）。
        把它们串在同一个 try 里是最容易犯的错 —— 一样失败会把另一样的结果一起丢掉。 */
  async function runCheck(button,statusEl,cancelEl){
    if(!host)return;
    // ⚠ 先"读一遍设置卡里的字段"再取快照 —— 不读的话用户刚输入的地址/Key 进不了 runtime，
    //   于是会发出"请先填写服务地址"这种莫名其妙的报错（我第一版探针就撞在这上面）。
    try{ host.read(document); }catch(_){}
    if(!statusEl)statusEl=所有('[data-provider-test-status]')[0]||null;
    // ⭐ 2026-10-24（V7待办/02 竞速选线）：阿吉 / 墨墨是自动选线 ⇒ 先测一轮线路，再拿选中的那条做检查
    try{
      const s0=slot(),conn=host.settings&&root.V7ProviderConnections?root.V7ProviderConnections.connection(host.settings()):null;
      if((s0==='aji'||s0==='momo')&&conn&&conn.lineMode==='auto'&&String(conn.apiKey||'').trim()&&typeof host.raceLines==='function'){
        if(statusEl)statusEl.textContent='正在测速：每条线路查一次余额，挑又快又有余额的那条（最多 12 秒）…';
        await host.raceLines();
      }
    }catch(_){ /* 测速失败不挡检查：照旧拿现在的地址检查 */ }
    const snapshot={...host.runtime()};
    if(!cancelEl)cancelEl=所有('[data-provider-test-cancel]')[0]||null;
    if(!button)button=所有('[data-provider-test]')[0]||null;
    // ⚠⚠⚠ 2026-10-07 修：**没填地址/Key 时【一个请求都不发】**，只在状态行说清楚。
    //   原来直接往下走 ⇒ 探针和余额模块各抛一次"请先填写服务地址"，其中余额那一路
    //   会 report() ⇒ 屏幕弹出"出了点问题 / 请先填写服务地址"的红卡。
    //   那是"你还没填"，不是错误 —— 弹卡就是打扰（用户实拍抓到过）。
    const 地址=String(snapshot&&snapshot.baseUrl||'').trim();
    const 钥匙=String(snapshot&&snapshot.apiKey||'').trim();
    if(!地址||!钥匙){
      if(statusEl)statusEl.textContent=(!地址?'请先填写服务地址':'请先填写当前服务商的 API Key')+'，然后再点「检查连接」。';
      return;
    }
    const token={fingerprint:fingerprint(snapshot)};
    probeToken=token;
    // 2026-10-24（V7待办/02）：顺手拉一次供应商在后台配的模型目录（拉不到不要紧，变了会自己通知生成卡）
    try{ if(root.V7SupplierModels&&(slot()==='aji'||slot()==='momo'))root.V7SupplierModels.refresh(slot()); }catch(_){}
    if(button)button.disabled=true;
    if(cancelEl)cancelEl.hidden=false;
    const s=slot();
    const 片段=[];
    // ① 拉模型列表
    try{
      if(statusEl)statusEl.textContent='正在请求当前服务商的模型列表…';
      const result=await probe.test(snapshot,()=>{if(probeToken!==token||token.fingerprint!==fingerprint(host.runtime()))throw root.V7ProviderConnections.fail('账号或连接已变化，旧测试结果已丢弃');});
      if(statusEl){statusEl.textContent=result.message;statusEl.dataset.fingerprint=token.fingerprint;}
      // ⚠ 名单交出去：筛选 + 按槽存 + 变化检测（用户要"消失/新增要提醒"）
      if(root.V7ProviderModels&&Array.isArray(result.models)){
        const diff=root.V7ProviderModels.save(s,result.models);
        const g=root.V7ProviderModels.group(result.models);
        modelNote[s]={gone:diff.gone,added:diff.added,at:new Date().toISOString()};
        paintModelNote();
        片段.push('生图模型 '+g.imageCount+' 个（另有 '+g.otherCount+' 个疑似，灰色可点选）');
        // 通知生成卡：名单变了，下拉框要重建
        try{root.dispatchEvent(new CustomEvent('wheelchair:provider-models',{detail:{slot:s}}));}catch(_){}
      }
    }catch(error){
      if(statusEl&&probeToken===token)statusEl.textContent=error.code==='PROVIDER_TEST_CANCELLED'?'测试已取消':'测试未通过：'+error.message;
      // ⚠⚠ 2026-10-07 修：**"你还没填"不是错误，不该弹报错卡**。
      //   用户没填地址就点「检查连接」时，探针抛的是"请先填写完整的服务地址"，
      //   原来无条件 report() ⇒ 屏幕弹一张"出了点问题"的红卡（实拍抓到的）。
      //   ⇒ 这两类只在【状态行】里说清楚，不弹卡：
      //     · 还没填地址 / Key / 协议不合法（属于"配置没完成"）
      //     · 用户自己取消
      //   ⚠ 但"连不上 / 鉴权失败 / 返回格式不对"这些【必须】照旧报错 —— 那是真出问题了。
      const 是配置问题=/请先填写|请选择|鉴权方式|服务地址不得包含/.test(String(error&&error.message||''));
      if(error.code!=='PROVIDER_TEST_CANCELLED'&&error.code!=='PROVIDER_BALANCE_CANCELLED'&&!是配置问题)report(error);
    }
    // ② 查余额（自定义槽不给余额 —— 用户明确定的）
    if(balance&&balance.canQuery(s)){
      if(statusEl&&片段.length)statusEl.textContent=statusEl.textContent+' · 正在查余额…';
      // ⚠ quiet=true：走到这里地址/Key 一定都有（上面那道闸拦过了），"配置类"失败
      //   已经在 ① 里进过状态行了，这里不要再弹一次报错卡。
      const r=await refreshBalance('check',true);
      if(r){片段.push('余额 '+moneyText(r.unit,r.amount));}
      else if(statusEl)片段.push('余额没查到（看上面状态行的说明）');
    }
    if(statusEl&&片段.length)statusEl.textContent=片段.join(' · ')+'　（模型列表正常不代表生图已验证）';
    if(probeToken===token)probeToken=null;
    if(button)button.disabled=false;
    if(cancelEl)cancelEl.hidden=true;
  }

  // ⚠⚠⚠ 2026-10-07 重构：原来这里给按钮【直接 addEventListener】，而且
  //   `if(!button||…||已经绑过)return;` 写在 startTimer() 【前面】——
  //   两个毛病：
  //     ① 设置卡的 DOM 是"切到那一页才渲染"的。第一次 mount 时按钮还不存在，
  //        于是 return 掉 ⇒ 之后再渲染出来也没人绑 ⇒ 用户点了没反应，还不报错（静默失效）。
  //     ② 那句 return 之后的 startTimer() 永远轮不到 ⇒ 10 分钟自动刷新也不会跑。
  //   ⇒ 改成【事件委托】：绑在 document 上，谁来谁算，不再管渲染时机。
  //     一次绑定、永久有效（用 dataset 标记防重复）。
  //   ⚠ 别改回"给按钮直接绑" —— 那等于又回到"面板必须先渲染好"的时序依赖上。
  function bindDelegates(){
    if(document.documentElement.dataset.providerDelegated==='1')return;
    document.documentElement.dataset.providerDelegated='1';
    document.addEventListener('click',ev=>{
      const t=ev.target;
      if(!t||!t.closest)return;
      // 「检查连接」
      const 检查=t.closest('[data-provider-test]');
      if(检查){
        ev.preventDefault();ev.stopPropagation();
        if(probe.busy()||(balance&&balance.busy()))return;
        runCheck(检查,所有('[data-provider-test-status]')[0]||null,所有('[data-provider-test-cancel]')[0]||null);
        return;
      }
      // 「取消测试」
      if(t.closest('[data-provider-test-cancel]')){
        ev.preventDefault();ev.stopPropagation();
        probe.cancel().catch(report);if(balance)balance.cancel().catch(report);
        return;
      }
      // 余额框（本身是个按钮：点一下刷新 —— 用户定）
      const 框=t.closest('[data-provider-balance]');
      if(框){
        ev.preventDefault();ev.stopPropagation();
        if(框.dataset.can!=='1')return;
        if(balance&&balance.busy())return;
        const st=所有('[data-provider-test-status]');
        for(const el of st)el.textContent='正在刷新余额…';
        refreshBalance('click').then(r=>{if(r)for(const el of st)el.textContent='余额已刷新：'+moneyText(r.unit,r.amount);});
        return;
      }
    },true);
    // ⚠ 余额框是 role=button + tabindex=0，键盘也得能用（Enter / 空格）。
    //   只做鼠标不做键盘 = 键盘用户按不动它，而它又是"刷新余额"的唯一入口。
    document.addEventListener('keydown',ev=>{
      if(ev.key!=='Enter'&&ev.key!==' ')return;
      const 框=ev.target&&ev.target.closest?ev.target.closest('[data-provider-balance]'):null;
      if(!框)return;
      ev.preventDefault();ev.stopPropagation();
      if(框.dataset.can!=='1')return;
      if(balance&&balance.busy())return;
      refreshBalance('click').then(r=>{const st=所有('[data-provider-test-status]');if(r)for(const el of st)el.textContent='余额已刷新：'+moneyText(r.unit,r.amount);});
    },true);
  }

  function mount(container){
    if(!host)return;
    const catalog=container&&container.querySelector?container.querySelector('[data-provider-catalog-host]'):null;
    if(catalog&&controller)controller.mount(catalog);
    visibility();paintBalance();paintModelNote();
    bindDelegates();
    // ⚠ 定时器必须在"按钮存在与否"之外启动（原来排在 if(!button)return 后面，永远轮不到）
    startTimer();
  }

  function configure(options){
    host=options;
    controller=root.V7ProviderCatalog.create({context,settings:host.settings,fetch:()=>root.V7Backend.providerRecommendations(),confirm:spec=>root.V7FocusScope?.outsideModal?root.V7FocusScope.outsideModal(()=>host.confirm(spec)):host.confirm(spec),apply:async patch=>{await host.apply(patch);syncFields();},report});
    // ⚠ 2026-10-17 夜：拼地址用生图自己那份（provider-probe.js endpoint，10-17 之前的规则），不再借语言模型的 V7AssistantRuntime.endpoint
    //   —— 语言模型为了连中转站改过规则，借着用会把生图连带改掉（用户：「生图就直连就好了，按照之前的规则呀」）
    //   ⭐ 2026-10-17 夜：检查连接 / 查余额也 direct（不走系统代理），跟出图走同一条路 —— 不然会出现「检查说不通、出图能通」或者反过来
    const bridge={http:{fetch:args=>{if(!root.uiwin?.http?.fetch)throw new Error('HTTP bridge unavailable');return root.uiwin.http.fetch({...args,direct:true});},cancel:id=>root.uiwin?.http?.cancel?.(id)},endpoint:root.V7ProviderProbe.endpoint};
    probe=root.V7ProviderProbe.create(bridge);
    balance=root.V7ProviderBalance?root.V7ProviderBalance.create(bridge):null;
    loadBalance();
    // ⚠ 挂一次委托就够（谁渲染出来都算数），不用等面板
    bindDelegates();
    try{ syncFields(); }catch(_){}
    for(const panel of document.querySelectorAll('.settings-panel[data-settings-zone="0"]'))mount(panel);
    // ⚠ 开机自动查一次当前槽（用户定："每次启动程序就对当前选中槽自动查一次"）
    //   延后一拍：此刻 settingsRuntime/aiRuntime 可能还没就位（铁律 17 那类暂时性死区）。
    //   另外开局没有地址/Key 时余额模块会抛"请先填写服务地址" —— 那是正常的，
    //   这里吞掉即可（不能因为没填就把界面报成错误）。
    setTimeout(()=>{ refreshBalance('boot',true).catch(()=>{}); },1500);
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden)tick(); });
  }

  root.addEventListener('wheelchair:storage-context',()=>{probeToken=null;lowWarned={};probe?.cancel().catch(()=>{});controller?.invalidate();});
  root.V7ProviderSettings={configure,mount,changed,report,syncFields,
    // 给生成卡/别处用：当前槽的模型名单 + 余额（只读）
    modelsFor:slotId=>root.V7ProviderModels?root.V7ProviderModels.modelsFor(slotId==null?slot():slotId):[],
    balanceFor:slotId=>balanceCache[slotId==null?slot():slotId]||null,
    refreshBalance,canQueryBalance:slotId=>balance?balance.canQuery(slotId==null?slot():slotId):false,
    // ⭐ 2026-10-15：推荐服务商"展开才读"（设置卡那个折叠打开时调）
    ensureCatalog:()=>controller&&typeof controller.ensure==="function"?controller.ensure():Promise.resolve(null)};
})(window);
