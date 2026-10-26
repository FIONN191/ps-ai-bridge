(function(root){
  'use strict';
  const base='http://127.0.0.1:41596/v1';
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={items:[],folders:[],library:'',receipts:[],plan:null,connected:false,busy:false,message:''};
  let pairingKey='',epoch=0,view=0,area=null,projectId='';
  const fail=(code,message)=>Object.assign(new Error(message),{code});
  const current=(generation,target)=>generation===epoch&&(!target||target.isConnected);
  function report(error){state.message=error.message||'Eagle 归档失败';if(root.ERR)root.ERR.report(error.code==='EAGLE_ACCOUNT_CHANGED'?error.code:'EAGLE_ARCHIVE_FAILED',{detail:state.message,scene:{area:'Eagle归档'}});render();}
  async function request(path,body){
    if(!pairingKey)throw fail('EAGLE_PAIRING_REQUIRED','请先连接 Eagle 归档插件');
    const generation=epoch,http=root.uiwin&&root.uiwin.http;
    if(!http)throw fail('EAGLE_UNAVAILABLE','Eagle 归档需要桌面软件');
    const response=await http.fetch({url:base+path,method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+pairingKey},body:body?JSON.stringify(body):undefined,timeoutMs:180000});
    if(!current(generation))throw fail('EAGLE_ACCOUNT_CHANGED','账号或连接已切换，请重新连接 Eagle');
    let result;try{result=JSON.parse(response&&response.body||'{}');}catch(_){throw fail('EAGLE_RESPONSE_INVALID','Eagle 归档插件返回无效数据');}
    if(!response||response.ok===false||result.ok===false){const error=fail(result.code||'EAGLE_UNAVAILABLE',result.message||response&&response.error||'Eagle 没有确认操作结果');error.receipt=result.receipt;error.cancelled=result.cancelled;throw error;}
    return result;
  }
  async function connect(value){
    if(!/^[a-f0-9]{48}$/.test(value))throw fail('EAGLE_PAIRING_REQUIRED','连接码无效，请使用 Eagle 归档插件本次显示的连接码');
    disconnect();pairingKey=value;
    const result=await request('/status');
    if(result.protocol!==1||!Array.isArray(result.capabilities)||!result.capabilities.includes('move-folder'))throw fail('EAGLE_PROTOCOL_MISMATCH','Eagle 归档插件版本不兼容');
    state.connected=true;state.library=result.library;return load('');
  }
  function disconnect(){epoch++;pairingKey='';Object.assign(state,{items:[],folders:[],library:'',receipts:[],plan:null,connected:false,busy:false,message:''});}
  async function load(query=''){
    const result=await request('/catalog?query='+encodeURIComponent(String(query)));
    if(!Array.isArray(result.items)||!Array.isArray(result.folders))throw fail('EAGLE_RESPONSE_INVALID','Eagle 条目或分类列表无效');
    state.items=result.items;state.folders=result.folders;state.library=result.library;state.plan=null;
    state.message=result.truncated?'结果超过 100 项，请缩小关键词范围。':result.selection?'Eagle 当前选中 '+result.items.length+' 项':'找到 '+result.items.length+' 项';
    const history=await request('/receipts');if(!Array.isArray(history.receipts))throw fail('EAGLE_RESPONSE_INVALID','归档记录无效');state.receipts=history.receipts;
    render();return {library:state.library,items:state.items,folders:state.folders,truncated:!!result.truncated};
  }
  function markup(){return '<section><h3>Eagle 归档</h3><div class="planner-fields"><label>本次连接码<input data-eagle-key type="password" autocomplete="off" maxlength="48"></label><label>查找条目<input data-eagle-query maxlength="160" placeholder="留空读取 Eagle 当前选中项"></label></div><div class="planner-actions"><button data-eagle-connect>连接归档插件</button><button data-eagle-search>读取条目</button><button data-eagle-disconnect>断开</button></div><output data-eagle-status role="status"></output><div data-eagle-list></div><div data-eagle-plan></div><div data-eagle-receipts></div></section>';}
  const names=ids=>ids.map(id=>(state.folders.find(f=>f.id===id)||{}).name||id).join(', ')||'无';
  const options=()=>state.folders.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+' ['+esc(f.id)+']</option>').join('');
  function render(){
    if(!area||!area.isConnected)return;
    area.querySelector('[data-eagle-status]').textContent=(state.connected?'资料库：'+state.library+' · ':'')+state.message;
    const linked=root.V7ProductData&&root.V7ProductData.getProject(projectId);const ids=new Set(linked?linked.items.map(i=>i.eagleId).filter(Boolean):[]);
    area.querySelector('[data-eagle-list]').innerHTML=state.connected?'<div class="planner-fields"><label>新增标签<input data-eagle-tags maxlength="2000" placeholder="逗号分隔"></label><label>目标分类<select data-eagle-to><option value="">分类保持不变</option>'+options()+'</select></label><label>移出分类<select data-eagle-from><option value="">保留现有分类</option>'+options()+'</select></label></div>'+state.items.map(item=>'<label class="planner-check"><input type="checkbox" data-eagle-item="'+esc(item.id)+'"'+(ids.has(item.id)?' checked':'')+'><span>'+esc(item.name)+'<small> ['+esc(item.id)+'] · '+esc(names(item.folders||[]))+' · '+esc((item.tags||[]).join(', '))+'</small></span></label>').join('')+'<div class="planner-actions"><button data-eagle-prepare>查看所选条目清单</button></div>':'';
    const plan=state.plan;
    area.querySelector('[data-eagle-plan]').innerHTML=plan?'<section class="planner-queue"><h3>待确认：'+plan.rows.length+' 项</h3><p>资料库：'+esc(plan.library)+'<br>新增标签：'+esc(plan.addTags.join(', ')||'无')+'<br>目标分类：'+esc(plan.toFolder?plan.toFolder.name:'保持不变')+'<br>移出分类：'+esc(plan.fromFolder?plan.fromFolder.name:'保留现有分类')+'</p>'+plan.rows.map(row=>'<p>'+esc(row.before.name)+' ['+esc(row.id)+']<br>'+esc(names(row.before.folders))+' → '+esc(names(row.after.folders))+'</p>').join('')+'<div class="planner-actions"><button data-eagle-cancel>取消清单</button><button data-eagle-commit'+(state.busy?' disabled':'')+'>确认并提交 Eagle</button></div></section>':'';
    area.querySelector('[data-eagle-receipts]').innerHTML=state.receipts.length?'<h3>本机归档记录</h3>'+state.receipts.map(receipt=>'<article class="planner-row"><h3>'+(window.V7Format?window.V7Format.agoHtml(receipt.createdAt):new Date(receipt.createdAt).toLocaleString())+' · '+(receipt.status==='completed'?'已核对完成':'有未完成项')+'</h3>'+receipt.rows.map(row=>'<p>'+esc(row.before.name)+' ['+esc(row.id)+']：'+esc(({applied:'已核对',pending:'未执行',failed:'失败',uncertain:'结果待重新读取',conflict:'已被其它操作修改',unavailable:'无法读取',saving:'待核对'})[row.status]||row.status)+'</p>').join('')+(receipt.status!=='completed'?'<button data-eagle-retry="'+esc(receipt.id)+'">重新准备未完成项</button>':'')+'</article>').join(''):'';
  }
  async function prepare(input){const result=await request('/prepare',input);if(!result.plan||!Array.isArray(result.plan.rows))throw fail('EAGLE_RESPONSE_INVALID','归档清单无效');state.plan=result.plan;state.message='请核对条目、标签和分类';render();return {status:'awaiting_user_confirmation',count:result.plan.rows.length,library:result.plan.library};}
  function mount(target,options={}){
    area=target;projectId=options.projectId||'';const currentView=++view;area.innerHTML=markup();render();
    target.onclick=event=>{const button=event.target.closest('button');if(!button||!target.contains(button))return;
      const generation=epoch;
      const run=async()=>{
        if(currentView!==view||!current(generation,target)||state.busy)return;
        if(button.matches('[data-eagle-disconnect]')){disconnect();render();return;}
        if(button.matches('[data-eagle-connect]')){const value=target.querySelector('[data-eagle-key]').value.trim();target.querySelector('[data-eagle-key]').value='';await connect(value);return;}
        if(button.matches('[data-eagle-search]')){await load(target.querySelector('[data-eagle-query]').value);return;}
        if(button.matches('[data-eagle-cancel]')){state.plan=null;render();return;}
        if(button.matches('[data-eagle-prepare]')){await prepare({itemIds:[...target.querySelectorAll('[data-eagle-item]:checked')].map(el=>el.dataset.eagleItem),addTags:target.querySelector('[data-eagle-tags]').value.split(',').map(t=>t.trim()).filter(Boolean),fromFolderId:target.querySelector('[data-eagle-from]').value,toFolderId:target.querySelector('[data-eagle-to]').value});return;}
        if(button.matches('[data-eagle-retry]')){const receipt=state.receipts.find(r=>r.id===button.dataset.eagleRetry);if(receipt)await prepare({itemIds:receipt.rows.filter(r=>r.status!=='applied').map(r=>r.id),addTags:receipt.addTags||[],fromFolderId:receipt.fromFolder&&receipt.fromFolder.id||'',toFolderId:receipt.toFolder&&receipt.toFolder.id||''});return;}
        if(button.matches('[data-eagle-commit]')&&state.plan){
          const planId=state.plan.id;state.busy=true;state.message='等待 Eagle 确认及返回结果';render();
          try{const result=await request('/commit',{planId});state.plan=null;state.receipts=[result.receipt,...state.receipts.filter(r=>r.id!==result.receipt.id)];state.message='Eagle 已返回并核对 '+result.receipt.rows.length+' 项';}
          catch(error){if(current(generation)){if(error.receipt){state.receipts=[error.receipt,...state.receipts.filter(r=>r.id!==error.receipt.id)];state.plan=null;}if(error.cancelled){state.message='已取消，未写入';return;}throw error;}}
          finally{if(current(generation)){state.busy=false;render();}}
        }
      };
      Promise.resolve().then(run).catch(error=>{if(currentView===view&&target.isConnected)report(error);});
    };
  }
  root.addEventListener('wheelchair:storage-context',()=>{disconnect();area=null;view++;});
  root.V7EagleUI={markup,mount,load,catalog:load,disconnect,async propose(input){if(!state.connected)throw fail('EAGLE_PAIRING_REQUIRED','请先在 Eagle 归档页连接本次插件会话');const generation=epoch;await root.V7ProjectSchedule.open('eagle');if(!current(generation))throw fail('EAGLE_ACCOUNT_CHANGED','账号已切换');return prepare(input);}};
})(window);
