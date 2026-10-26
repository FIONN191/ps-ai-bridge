(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.V7ProviderCatalog=factory(root.V7ProviderConnections);})(typeof window==='undefined'?null:window,function(C){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function create(host){
    let rows=[],status='尚未刷新推荐信息',busy=false,revision=0,loadedContext='',element=null;
    const context=()=>String(host.context());
    function guard(token){if(token.revision!==revision||token.context!==context())throw C.fail('账号或后台地址已变化，请刷新推荐信息后重试');}
    function state(){return {providers:rows.map(C.publicItem),status,busy,stale:loadedContext!==context()};}
    function render(){if(element?.isConnected){element.innerHTML=html();bind();element.ownerDocument?.defaultView?.V7CardArchitecture?.helpify(element);}host.changed?.(state());}
    function html(){const stale=loadedContext!==context();return '<div class="provider-catalog" data-provider-catalog><div class="settings-section-title">推荐服务商</div><p class="settings-note">展开时自动读取后台公开的推荐信息（不用登录）。采用地址前会确认变更；API Key 由你自行填写。</p>'+(/失败/.test(status)?'<div class="settings-actions"><button class="settings-btn" type="button" data-provider-refresh '+(busy?'disabled':'')+'>重新读取</button></div>':'<button class="settings-btn" type="button" data-provider-refresh hidden>刷新推荐信息</button>')+'<p class="settings-note" role="status">'+escape(stale&&rows.length?'后台地址或账号已变化，请重新刷新':status)+'</p><div class="provider-catalog-items">'+rows.map(row=>'<article class="provider-catalog-item"><strong>'+escape(row.name)+'</strong><p>'+escape(row.description||'后台尚未发布推荐说明')+'</p><dl><dt>API 地址</dt><dd>'+escape(row.apiUrl||'尚未发布')+'</dd><dt>联系方式</dt><dd>'+escape(row.contact||'尚未发布')+'</dd><dt>参考价格</dt><dd>'+(row.price.amount===null?'未公布，请向服务商确认':escape(row.price.amount+' '+row.price.currency+' / '+row.price.unit)+'<br>来源：'+escape(row.price.source)+'<br>价格更新：'+escape(row.price.updatedAt))+'</dd></dl>'+(row.priceNotes?'<p class="settings-note">'+escape(row.priceNotes)+'</p>':'')+'<p class="settings-note">资料更新：'+escape(row.updatedAt||'未知')+'</p><button class="settings-btn" type="button" data-provider-adopt="'+escape(row.id)+'" '+(!row.apiUrl||stale||busy?'disabled':'')+'>采用此地址</button></article>').join('')+'</div></div>';}
    async function refresh(){if(busy)throw C.fail('推荐信息正在处理');busy=true;const token={context:context(),revision:++revision};status='正在读取后台推荐信息…';render();try{const result=await host.fetch();guard(token);rows=C.catalog(result);loadedContext=token.context;status=rows.length?'已刷新推荐信息；现有连接未自动更改':'后台尚未发布推荐信息';return state();}catch(error){if(token.revision===revision){status='推荐信息读取失败，请检查后台连接后重试';loadedContext='';}throw error;}finally{if(token.revision===revision){busy=false;render();}}}
    async function adopt(id){if(busy)throw C.fail('推荐信息正在处理');if(loadedContext!==context())throw C.fail('请先刷新当前后台的推荐信息');const row=rows.find(item=>item.id===id);if(!row)throw C.fail('推荐信息已变化，请重新刷新');const before=host.settings(),plan=C.adoption(before,row),identity=JSON.stringify([before.provider,before.otherConnection,before[row.id+'Url'],before[row.id+'Key'],before[row.id+'Protocol'],before[row.id+'AuthMode']]),token={context:context(),revision};busy=true;render();try{
        const accepted=await host.confirm({title:'采用 '+row.name+' 的推荐地址',body:'当前地址：'+(plan.previousUrl||'未设置')+'\n新地址：'+plan.nextUrl,detail:plan.clearsKey?'更改地址会清除此连接已有的 Key，请填写新服务对应的 Key。':'确认后切换到此连接。价格是后台参考信息，实际费用以服务商为准。'});guard(token);if(!accepted)return false;
        const current=host.settings();if(identity!==JSON.stringify([current.provider,current.otherConnection,current[row.id+'Url'],current[row.id+'Key'],current[row.id+'Protocol'],current[row.id+'AuthMode']]))throw C.fail('确认期间连接已改变，请重新采用以核对最新配置');
        await host.apply(plan.patch);guard(token);status='已采用 '+row.name+' 的地址；请填写 Key 并测试连接';return true;
      }finally{if(token.revision===revision){busy=false;render();}}}
    function report(error){host.report?.(error);}
    function bind(){element.querySelector('[data-provider-refresh]')?.addEventListener('click',()=>refresh().catch(report));for(const button of element.querySelectorAll('[data-provider-adopt]'))button.addEventListener('click',()=>adopt(button.dataset.providerAdopt).catch(report));}
    function mount(target){element=target;render();}
    function invalidate(){revision++;rows=[];loadedContext='';busy=false;status='连接环境已变化，请刷新推荐信息';render();}
    // ⭐ 2026-10-15「刷新改成触发式」：没读过 / 换了账号或后台地址 → 悄悄读一次；读过且没变就什么都不做。
    //   ⚠ 只在失败时才露「重新读取」按钮（平时那颗按钮藏着，节点保留给老代码）。
    function ensure(){const st=state();if(st.busy||!st.stale)return Promise.resolve(st);return refresh().catch(()=>state());}   // 自动读失败不弹卡：面板里的状态行会写"读取失败"，并露出「重新读取」
    return {state,html,mount,refresh,adopt,invalidate,ensure};
  }
  return {create};
});
