(function (root) {
  'use strict';
  let dialog = null, origin = null, tab = 'billing', sequence = 0, timer = null, activeSession = '';
  let ledger = null, tickets = null, notices = null, offset = 0, pool = '', pending = null, navigate = null;
  // ⭐ 2026-10-15：账单默认收起（用户：「账单的话呢，可以收起来让人来看账单」）。
  //   点开过就记住（模块每次刷新都整块重画，不记的话一刷新就自己收回去了）。
  let ledgerOpen = false, onlineHandler = null;
  const pageSize = 20;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = () => root.V7Backend;
  const state = () => api()?.state() || {};
  const session = () => { const s = state(); return s.signedIn ? [s.baseUrl,s.account?.id,s.sessionVersion].join('|') : ''; };
  const current = token => dialog?.isConnected && token.sequence === sequence && token.session === session();
  const stamp = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', {hour12:false}) : '—'; };
  // ⭐ 2026-10-22（docs/263 第 16 条）：账单 / 工单 / 公告里「过去的事」统一写「3 分钟前」，悬停看完整时间
  const when = value => window.V7Format ? window.V7Format.agoHtml(value, '—') : '<time>' + esc(stamp(value)) + '</time>';
  const poolName = value => ({common:'通用积分',banana:'Banana 积分'}[value] || value);
  function thresholdKey() { const s=state(); return 'wheelchair.account-threshold.v1:' + encodeURIComponent(s.baseUrl || '') + ':' + encodeURIComponent(s.account?.id || 'anonymous'); }
  function thresholds() { try { const v=JSON.parse(root.localStorage.getItem(thresholdKey()) || '{}'); return {common:Math.max(0, Number(v.common)||0),banana:Math.max(0, Number(v.banana)||0)}; } catch (_) { return {common:0,banana:0}; } }
  function message(text, error=false) { const el=dialog?.querySelector('[data-account-message]'); if(el) {el.textContent=text;el.dataset.error=String(error);} }
  function fail(error) { message(String(error?.message || error), true); root.ERR?.report('ACCOUNT_CENTER_FAILED',{message:String(error?.message || error),context:{code:error?.code || '',tab}}); }
  const balance = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  function warning() { const values=thresholds(); return ['common','banana'].filter(p=>values[p]>0 && balance(ledger?.balances?.[p])!=='—' && ledger.balances[p]<values[p]).map(p=>poolName(p)+'余额低于 '+values[p]+'，请检查账单或兑换卡密。').join(' '); }
  function billingMarkup() {
    const b=ledger?.balances || {}, limits=thresholds(), rows=ledger?.ledger || [], total=ledger?.total || 0;
    // ⭐⭐ 2026-10-15 重排（用户：设置页「太散」「太长」；兑换卡密是低频操作，点了再展开；账单收起来）：
    //   余额 → （兑换卡密：默认收起，设置卡标题行的「兑换卡密」按钮控制，CSS 管显隐）
    //   → 账单（折叠，默认收）→ 余额提醒（折叠，低频）。
    //   ⚠ 数据钩子一个没改（data-account-redeem-form / data-account-ledger / data-account-pool…），只改了摆放。
    return '<section class="account-summary" aria-label="积分余额"><div><span>通用积分</span><strong>'+balance(b.common)+'</strong></div><div><span>Banana 积分</span><strong>'+balance(b.banana)+'</strong></div></section>'+
      '<p class="account-warning" data-account-warning '+(warning()?'':'hidden')+'>'+esc(warning())+'</p>'+
      (ledger?.allocation?.message?'<p class="account-warning" role="status" data-allocation-status>'+esc(ledger.allocation.message)+'</p>':'')+
      '<div class="account-redeem-panel" data-account-redeem-panel><div class="arp-in"><form data-account-redeem-form class="account-inline"><label>卡密<input type="password" autocomplete="off" maxlength="256" data-account-redeem required placeholder="输入尚未使用的卡密"></label><button type="submit">兑换积分</button></form><p class="account-note">兑换后积分立刻到账，余额和账单会自动刷新。</p></div></div>'+
      '<details class="account-fold" data-account-ledger-fold'+(ledgerOpen?' open':'')+'><summary>积分账单 · 共 '+total+' 条</summary>'+
      '<div class="account-section-head"><label>积分类型<select data-account-pool><option value="" '+(!pool?'selected':'')+'>全部</option><option value="common" '+(pool==='common'?'selected':'')+'>通用积分</option><option value="banana" '+(pool==='banana'?'selected':'')+'>Banana 积分</option></select></label></div><div class="account-ledger">'+(rows.length?rows.map(r=>'<article><div><strong>'+esc({consume:'任务扣费',recharge:'卡密充值',admin_adjust:'人工调整',refund:'退款'}[r.kind]||r.kind)+'</strong><span class="account-amount">'+(Number(r.delta)>0?'+':'')+Number(r.delta).toLocaleString('zh-CN')+' '+esc(poolName(r.pool))+'</span></div>'+when(r.created_at)+''+(r.task_id?'<small>任务 '+esc(r.task_id)+'</small>':'')+'</article>').join(''):(window.V7Format?window.V7Format.emptyHtml({title:'还没有积分记录',hint:'兑换卡密、用平台算力生成之后，每一笔都会记在这里'}):'<p class="account-empty">暂无积分流水。</p>'))+'</div><div class="account-pagination"><button data-account-prev '+(offset===0?'disabled':'')+'>上一页</button><span>共 '+total+' 条 · 第 '+(Math.floor(offset/pageSize)+1)+' 页</span><button data-account-next '+(offset+pageSize>=total?'disabled':'')+'>下一页</button></div><p class="account-note">平台积分以服务器账单为准；自己的 API / RH 费用请到对应服务商查看。失败和取消不会自动退款。</p></details>'+
      '<details class="account-fold" data-account-threshold-fold><summary>余额提醒（低于多少提醒你）</summary><form data-account-threshold-form class="account-inline"><label>通用积分阈值<input type="number" min="0" max="100000000" step="1" value="'+limits.common+'" data-threshold="common" required></label><label>Banana 积分阈值<input type="number" min="0" max="100000000" step="1" value="'+limits.banana+'" data-threshold="banana" required></label><button type="submit">保存提醒</button></form><p class="account-note">设为 0 关闭提醒。阈值只存在本机当前账号；每分钟自动刷新一次余额，不会自动充值。</p></details>';
  }
  function supportMarkup() {
    return '<section class="account-section"><h3>登记新工单</h3><form data-account-ticket-form><label>主题<input data-ticket-subject required maxlength="120" placeholder="简述遇到的问题"></label><label>问题说明<textarea data-ticket-body required maxlength="5000" rows="3" placeholder="请说明操作步骤和错误；不要填写密码、Key 或验证码。"></textarea></label><button type="submit">登记工单</button></form><p class="account-note">人工工作时间：北京时间 12:00–20:00。仅显示本人记录。</p></section><section class="account-section"><h3>我的工单与回复</h3>'+(tickets.length?tickets.map(t=>'<details class="account-ticket"><summary><strong>'+esc(t.subject)+'</strong><span>'+esc({open:'待处理',in_progress:'处理中',resolved:'已解决',closed:'已关闭'}[t.status]||t.status)+'</span>'+when(t.updated_at)+'</summary><p class="account-pre">'+esc(t.body)+'</p><div class="account-replies">'+(t.replies||[]).map(r=>'<article><strong>'+(r.is_staff?'客服回复':'我的补充')+'</strong>'+when(r.created_at)+'<p class="account-pre">'+esc(r.body)+'</p></article>').join('')+'</div><form data-account-reply-form data-ticket-id="'+esc(t.id)+'"><label>补充说明<textarea data-reply-body rows="2" required maxlength="5000"></textarea></label><button type="submit">发送补充</button></form></details>').join(''):'<p class="account-empty">尚未登记工单。</p>')+'</section>';
  }
  function serviceMarkup() {
    const states={operational:'运行正常',degraded:'部分受影响',maintenance:'维护中',unavailable:'不可用',unconfigured:'未配置'}, names={banana:'Banana',forge:'Forge',comfyui:'ComfyUI',dlss:'DLSS',account:'账号服务'};
    return '<section class="account-section"><h3>平台服务公告状态</h3><p class="account-note">由平台发布的服务状态，更新时间：'+esc(stamp(notices?.serviceUpdatedAt))+'。不代表当前机器已完成真实服务调用。</p>'+(notices?.servicesConfigured?'<ul class="account-services">'+notices.services.map(s=>'<li><strong>'+esc(names[s.id]||s.id)+'</strong><span>'+esc(states[s.status]||'未配置')+'</span></li>').join('')+'</ul>':'<p class="account-empty">平台尚未配置服务状态。</p>')+'</section><section class="account-section"><h3>公告</h3>'+(notices?.announcements?.length?notices.announcements.map(n=>'<article class="account-announcement"><h4>'+esc(n.title)+'</h4>'+when(n.publishedAt)+'<p class="account-pre">'+esc(n.body)+'</p></article>').join(''):'<p class="account-empty">'+(notices?.announcementsConfigured?'现在没有公告。':'公告服务尚未配置。')+'</p>')+'</section>';
  }
  function render() {
    if(!dialog)return;
    dialog.querySelectorAll('[data-account-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.accountTab===tab));});
    const body=dialog.querySelector('[data-account-content]');
    if(!state().signedIn){body.innerHTML='<p class="account-empty">请先登录，再查看本人的账单、客服记录和服务公告。</p><button type="button" data-account-login-route>登录账号</button>';body.querySelector('button').onclick=()=>root.V7RouteRegistry?.open('settings/account')||navigate?.('account');return;}
    // ⭐ 2026-10-22（docs/263 第 2 条）：读的时候画灰色占位（跟账单列表一样的行高），不再一句「正在读取…」
    if((tab==='billing'&&!ledger)||(tab==='support'&&!tickets)||(tab==='service'&&!notices)){body.innerHTML=root.V7Format?root.V7Format.skeletonHtml(5):'<p class="account-empty">正在读取当前账号数据…</p>';return;}
    body.innerHTML=tab==='billing'?billingMarkup():tab==='support'?supportMarkup():serviceMarkup();
  }
  async function load(quiet=false) {
    if(!dialog||!session()||pending)return;
    const token={sequence:++sequence,session:session()},selected=tab;
    dialog.querySelectorAll('[data-account-prev],[data-account-next],[data-account-refresh]').forEach(button=>button.disabled=true);
    if(!quiet)message('正在刷新…');
    try {
      const result=selected==='billing'?await api().pointLedger({offset,limit:pageSize,pool}):selected==='support'?await api().supportTickets():await api().accountNotices();
      if(!current(token)||tab!==selected)return;
      if(selected==='billing')ledger=result;else if(selected==='support')tickets=result.tickets||[];else notices=result;
      if(quiet&&dialog.querySelector('form:focus-within')){if(selected==='billing'){const el=dialog.querySelector('[data-account-warning]');if(el){el.textContent=warning();el.hidden=!warning();}}return;}
      render();if(!quiet)message('已更新 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));
    }catch(error){if(current(token)){fail(error);if((selected==='billing'&&!ledger)||(selected==='support'&&!tickets)||(selected==='service'&&!notices))dialog.querySelector('[data-account-content]').innerHTML='<p class="account-empty">'+(dialog.classList.contains('account-center-embedded')?'未能读取数据。网络恢复后会自动重读（每分钟也会自己再试一次）。':'未能读取数据，请检查连接后点击“刷新当前页”。')+'</p>';}}
    finally{if(current(token)){const refresh=dialog.querySelector('[data-account-refresh]');if(refresh)refresh.disabled=false;const prev=dialog.querySelector('[data-account-prev]'),next=dialog.querySelector('[data-account-next]');if(prev)prev.disabled=offset===0;if(next)next.disabled=offset+pageSize>=(ledger?.total||0);}}
  }
  async function mutate(form,action,done) {
    if(pending)return;
    const token={sequence:++sequence,session:session()}; if(!token.session)return;
    pending=token;form.querySelectorAll('button').forEach(b=>b.disabled=true);message('正在提交…');
    try {const result=await action();if(current(token)){pending=null;const reload={sequence:sequence+1,session:token.session};await load();if(current(reload))message(result?.allocation?.message || done);}}catch(error){if(current(token))fail(error);}finally{if(pending===token)pending=null;if(form.isConnected)form.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  function dispose(target) { if(dialog!==target){target.remove();return;}sequence++;clearInterval(timer);timer=null;if(onlineHandler){root.removeEventListener('online',onlineHandler);onlineHandler=null;}dialog=null;pending=null;ledger=null;tickets=null;notices=null;target.remove();if(origin?.isConnected)origin.focus();origin=null; }
  function close() { const target=dialog;if(target){if(target.open)target.close();dispose(target);} }
  function open(initial='billing') {
    if(initial==='billing'&&root.V7RouteRegistry?.open)return root.V7RouteRegistry.open('records/billing');
    if(navigate)return navigate(initial);
    if(dialog){if(['billing','support','service'].includes(initial)){tab=initial;render();load();}dialog.focus();return dialog;}
    origin=document.activeElement;tab=['billing','support','service'].includes(initial)?initial:'billing';activeSession=session();
    dialog=document.createElement('dialog');dialog.className='account-center';dialog.dataset.uiOverlay='true';dialog.setAttribute('aria-labelledby','account-center-title');dialog.setAttribute('aria-modal','true');
    dialog.innerHTML='<header><div><h2 id="account-center-title">账号与服务</h2><p>查看积分、处理问题、了解平台公告</p></div><button data-account-close aria-label="关闭账号与服务">关闭</button></header><nav aria-label="账号服务分区"><button data-account-tab="billing">积分与账单</button><button data-account-tab="support">我的客服工单</button><button data-account-tab="service">服务与公告</button></nav><div class="account-scroll" data-account-content></div><footer><span role="status" aria-live="polite" data-account-message></span><button data-account-refresh>刷新当前页</button></footer>';
    document.body.append(dialog);dialog.showModal();bind();render();load();
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    const target=dialog;dialog.addEventListener('close',()=>{if(!target.hasAttribute('data-v7-modal-suspended'))dispose(target);});
    dialog.querySelector('[data-account-close]').focus();return dialog;
  }
  function bind(){
    dialog.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.hasAttribute('data-account-close')){close();return;}if(pending)return;if(b.hasAttribute('data-account-refresh'))load();else if(b.dataset.accountTab){tab=b.dataset.accountTab;sequence++;render();load();}else if(b.hasAttribute('data-account-prev')){offset=Math.max(0,offset-pageSize);load();}else if(b.hasAttribute('data-account-next')){offset+=pageSize;load();}});
    dialog.addEventListener('change',event=>{if(pending)return;if(event.target.hasAttribute('data-account-pool')){pool=event.target.value;offset=0;load();}});
    dialog.addEventListener('submit',event=>{event.preventDefault();if(pending)return;const form=event.target;if(form.hasAttribute('data-account-threshold-form')){try{const value={};for(const p of ['common','banana']){const n=Number(form.querySelector('[data-threshold="'+p+'"]').value);if(!Number.isInteger(n)||n<0||n>100000000)throw new Error('提醒阈值必须为 0 至 100000000 的整数');value[p]=n;}root.localStorage.setItem(thresholdKey(),JSON.stringify(value));render();message('余额提醒已保存');}catch(error){fail(error);}}else if(form.hasAttribute('data-account-redeem-form')){const input=form.querySelector('[data-account-redeem]'),code=input.value.trim();if(!code)return;input.value='';mutate(form,()=>api().redeemPoints(code),'兑换成功，余额和账单已刷新');}else if(form.hasAttribute('data-account-ticket-form')){const subject=form.querySelector('[data-ticket-subject]').value.trim(),body=form.querySelector('[data-ticket-body]').value.trim();if(subject&&body)mutate(form,()=>api().submitSupportTicket(subject,body),'工单已登记');}else if(form.hasAttribute('data-account-reply-form')){const body=form.querySelector('[data-reply-body]').value.trim();if(body)mutate(form,()=>api().replySupportTicket(form.dataset.ticketId,body),'补充已发送');}});
    // ⭐ 2026-10-15「刷新改成触发式」：嵌在设置卡里时没有"刷新当前页"按钮 ——
    //   打开就读；账单和客服记录每分钟悄悄读一次；断网恢复时立刻读一次；兑换/登记后 mutate 自己会读。
    //   ⚠ 账单折叠的开合记下来（toggle 事件不冒泡，所以用捕获阶段）。
    dialog.addEventListener('toggle',event=>{if(event.target.hasAttribute?.('data-account-ledger-fold'))ledgerOpen=event.target.open;},true);
    timer=setInterval(()=>{if((tab==='billing'||tab==='support')&&!pending)load(true);},60000);
    if(onlineHandler)root.removeEventListener('online',onlineHandler);
    onlineHandler=()=>{if(!pending)load(true);};
    root.addEventListener('online',onlineHandler);
  }
  function mount(container,initial='billing'){
    close();tab=['billing','support','service'].includes(initial)?initial:'billing';activeSession=session();
    const target=document.createElement('section');target.className='account-center account-center-embedded';
    target.dataset.accountSection=tab;target.setAttribute('aria-label',{billing:'积分与账单',support:'我的客服工单',service:'服务与公告'}[tab]);
    // ⚠ 嵌入式不再【显示】「刷新当前页」（用户：不知道它到底刷新哪儿）—— 见上面 bind() 里的自动刷新。
    //   按钮节点留着、藏起来（契约：钩子藏不删；老测试会程序化点它）。独立弹窗（open()）那一版照常显示。
    target.innerHTML='<div class="account-scroll" data-account-content></div><footer><span role="status" aria-live="polite" data-account-message></span><button data-account-refresh hidden>刷新当前页</button></footer>';
    dialog=target;container.replaceChildren(target);bind();render();load();
    return ()=>{if(dialog===target)close();else target.remove();};
  }
  api()?.onChange?.(()=>{const next=session();if(next===activeSession)return;activeSession=next;sequence++;pending=null;ledger=null;tickets=null;notices=null;offset=0;pool='';if(dialog){render();message('');load();}});
  root.V7AccountCenter={open,close,mount,configure:options=>{navigate=typeof options?.navigate==='function'?options.navigate:null;},refresh:()=>load()};
})(window);
