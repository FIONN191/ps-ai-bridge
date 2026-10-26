(function(root){
  'use strict';
  const escape=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scope=()=>root.WHEELCHAIR_STORAGE?root.WHEELCHAIR_STORAGE.namespaceId():'anonymous';
  const data=()=>root.V7ProductData;
  let dialog=null,tab='projects',projectId='',scheduleItems=[],editing=null,initialized=false,epoch=0,selectionEpoch=0,navigate=null,viewEpoch=0;
  let badge=null,manager=null;
  let stateQueued=false,lastStateJson='';
  function setProjectId(next){if(projectId!==next){projectId=next;selectionEpoch++;}}
  // ⚠ 2026-10-15：状态跟上一次广播的一模一样就不再广播。
  //   收这个事件的 main-card-shortcuts 会让「记录与恢复」卡整张重读重画（缩略图光效重播、点到一半的缩略图被换掉）；
  //   PS 里改正在跟踪的图时项目数据会变（文档历史编号），但项目数、图片张数、待确认、待办都没变，卡上没东西要更新。
  function notifyState(){
    if(stateQueued)return;stateQueued=true;
    queueMicrotask(()=>{stateQueued=false;let state;try{state=quickState();}catch(error){report(error);return;}
      const json=JSON.stringify(state);if(json===lastStateJson)return;lastStateJson=json;
      root.dispatchEvent(new CustomEvent('wheelchair:project-state',{detail:state}));});
  }
  function quickState(){
    const projects=data()?.projects()||[];
    if(!projects.some(project=>project.id===projectId))setProjectId(projects[0]?.id||'');
    return {scope:scope(),projectId,projects:projects.map(project=>({id:project.id,name:project.name,itemCount:project.items.length})),pendingCount:manager?manager.pendingEvents().length:0,dueCount:scheduleItems.filter(item=>!item.completed&&item.dueAt<=Date.now()).length};
  }
  async function projectIdForCapture(capture,expectedProjectId){
    init();
    const selected=quickState().projectId,before=scope(),generation=epoch,selection=selectionEpoch;
    if(!selected||selected!==expectedProjectId||!Number.isSafeInteger(capture?.docId))return '';
    const result=await bridge('ps.doc.listOpen');
    if(before!==scope()||generation!==epoch||quickState().projectId!==selected||selection!==selectionEpoch)return '';
    return root.V7ProjectManagerCore.projectIdForCapture(data().projects(),selected,capture,result?.documents);
  }
  function selectProject(id){
    init();const generation=epoch,before=scope(),value=String(id||'');
    if(value&&!data().getProject(value))throw new Error('项目不存在，请刷新项目列表');
    if(generation!==epoch||before!==scope())throw Object.assign(new Error('账号已切换，请重新选择项目'),{code:'PROJECT_ACCOUNT_CHANGED'});
    setProjectId(value);if(dialog&&tab==='projects')paint();notifyState();return quickState();
  }
  function createProject(name){
    init();const generation=epoch,before=scope(),title=String(name||'').trim();
    if(!title)throw new Error('请填写项目名称');
    if(generation!==epoch||before!==scope())throw Object.assign(new Error('账号已切换，请重新新建项目'),{code:'PROJECT_ACCOUNT_CHANGED'});
    const project=data().createProject(title);setProjectId(project.id);
    if(dialog&&tab==='projects')paint();notifyState();return project;
  }
  function openNewSchedule(){init();editing=null;return open('schedule');}
  const bridge=(action,params)=>new Promise((resolve,reject)=>{
    linkQueue(action,params||{},{after:resolve,afterError:r=>reject(new Error(linkResultMessage(r)))}).then(r=>{if(r&&r.ok===false)reject(new Error(linkResultMessage(r)));}).catch(reject);
  });
  function report(error){if(root.ERR)root.ERR.report(error.code||'PROJECT_PLANNER_FAILED',{detail:error.message,scene:{area:'项目与日程'}});const status=dialog&&dialog.querySelector('.planner-status');if(status)status.textContent=error.message;}
  async function request(op,extra={}){
    if(!root.uiwin||!root.uiwin.planner)throw new Error('日程需要在正式桌面软件中使用');
    const before=scope(),generation=epoch,result=await root.uiwin.planner.request({op,scope:before,...extra});
    if(scope()!==before||generation!==epoch)throw Object.assign(new Error('账号已切换，请在当前账号重新操作'),{code:'PROJECT_ACCOUNT_CHANGED'});
    if(!result||result.ok===false)throw Object.assign(new Error(result&&result.error||'日程操作没有返回结果'),{code:result&&result.code});
    if(result.items){if(!Array.isArray(result.items))throw new Error('日程列表无效，请重新读取');scheduleItems=result.items;}
    return result;
  }
  function attention(){
    if(!badge){badge=document.createElement('button');badge.className='planner-attention';badge.hidden=true;document.body.append(badge);badge.onclick=()=>Promise.resolve().then(()=>open(manager.pendingEvents().length?'projects':'schedule')).catch(report);}
    const count=manager.pendingEvents().length,due=scheduleItems.filter(r=>!r.completed&&r.dueAt<=Date.now()).length;
    badge.hidden=!count&&!due;badge.textContent=[count?count+' 张图片状态待确认':'',due?due+' 项日程已到时间':''].filter(Boolean).join(' · ');notifyState();
  }
  function changed(){attention();if(dialog&&tab==='projects'&&!dialog.contains(document.activeElement))paint();}
  async function refreshDocuments(){
    const generation=epoch,result=await bridge('ps.doc.listOpen');if(generation!==epoch)return;
    manager.observe({type:'project:snapshot',documents:result.documents});paint();
  }
  function timeInput(value){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  function statusOptions(value){return Object.entries(manager.statuses).map(([k,v])=>'<option value="'+k+'"'+(value===k?' selected':'')+'>'+v+'</option>').join('');}
  function projectMarkup(){
    const projects=data().projects();if(!projects.some(p=>p.id===projectId))setProjectId(projects[0]&&projects[0].id||'');
    const project=data().getProject(projectId),pending=manager.pendingEvents(),first=pending[0];
    let out='<p>手动把一批 Photoshop 图片加入项目，逐张记录进度。项目记录和图片内容均不上传账号备份。关闭、导出只询问未标注图片；选好状态后不再反复提醒。已完成图片再次编辑时，可自行确认是否返工。</p>';
    if(first){const name=escape(first.documentName),kind=first.kind==='closed'?'已关闭，是弃用还是保留？':first.kind==='exported'?'检测到导出，这张已经完成了吗？':'已完成的图片发生了新的历史操作，要改为返工中吗？';out+='<section class="planner-queue" data-event-id="'+escape(first.id)+'"><strong>'+name+'</strong><p>'+kind+'（'+pending.length+' 张待确认，可在下方手动标记）</p><div class="planner-actions">'+(first.kind==='changed'?'<button data-decision="reworking">改为返工中</button>':'<button data-decision="completed">已完成</button><button data-decision="abandoned">已弃用</button><button data-decision="exported">只标记已导出</button>')+'<button data-decision="'+(first.kind==='changed'?'keep':'later')+'">'+(first.kind==='changed'?'保持已完成':'稍后继续（暂不再提醒）')+'</button></div></section>';}
    out+='<div class="planner-actions"><select aria-label="选择项目" data-project-select><option value="">请选择项目</option>'+projects.map(p=>'<option value="'+escape(p.id)+'"'+(p.id===projectId?' selected':'')+'>'+escape(p.name)+'</option>').join('')+'</select><button data-create-project>新建项目</button><button data-refresh-docs>读取已打开图片</button></div>';
    if(!project)return out+'<div class="planner-empty">新建项目后，勾选需要记录的图片。</div>';
    out+='<div class="planner-actions"><button data-rename-project>修改项目名称</button><button class="danger" data-delete-project>删除本机项目记录</button></div><p class="planner-danger-note">删除只影响本机项目索引和进度记录，Photoshop 文档、图片文件与 Eagle 内容不会删除。</p>';
    const docs=manager.openDocuments();out+='<details><summary>从 Photoshop 选入图片（当前 '+docs.length+' 张）</summary>'+docs.map((d,i)=>'<label class="planner-check"><input type="checkbox" data-open-document="'+i+'">'+escape(d.name)+' · '+d.width+' × '+d.height+'</label>').join('')+'<button data-add-selected>将勾选图片加入此项目</button></details>';
    for(const item of project.items){const doc=item.document||{};out+='<article class="planner-row" data-project-item="'+escape(item.sourceRef)+'"><h3>'+escape(doc.name||item.sourceRef)+'</h3><small>'+(doc.open?'在 Photoshop 中打开':'当前未打开')+' · '+escape(doc.path||'未保存图片：重新打开后请手动关联')+'</small><div class="planner-actions"><select aria-label="图片状态" data-item-status>'+statusOptions(manager.displayStatus(item))+'</select><button class="secondary" data-remove-item>移出项目记录</button></div><label>工作备注<input data-item-note maxlength="2000" value="'+escape(item.note)+'"></label><div class="planner-actions"><select aria-label="重新关联 Photoshop 图片" data-rebind-select><option value="">手动重新关联图片…</option>'+docs.map((d,i)=>'<option value="'+i+'">'+escape(d.name)+' · 文档 '+d.id+'</option>').join('')+'</select><button data-rebind>关联选中的图片</button></div><label>Eagle 条目 ID（可在归档页查找）<input data-eagle-id maxlength="128" value="'+escape(item.eagleId||'')+'"></label></article>';}
    return out;
  }
  function scheduleMarkup(){
    const value=editing||{title:'',note:'',dueAt:Date.now()+3600000,completed:false};
    let out='<p>关掉主窗口后软件留在托盘，日程继续提醒。提醒不自动切换窗口、不抢占正在输入的内容。选择「退出软件并停止提醒」后，本次运行结束。</p><form data-schedule-form><div class="planner-fields"><label>提醒标题<input name="title" maxlength="160" required value="'+escape(value.title)+'"></label><label>提醒时间<input name="dueAt" type="datetime-local" required value="'+timeInput(value.dueAt)+'"></label><label class="wide">备注<textarea name="note" maxlength="2000">'+escape(value.note)+'</textarea></label></div><div class="planner-actions"><button class="primary" type="submit">'+(editing&&editing.id?'保存修改':'添加日程')+'</button><button type="button" data-clear-schedule>清空表单</button><button type="button" data-refresh-schedule>刷新提醒列表</button></div></form>';
    out+=scheduleItems.map(row=>'<article class="planner-row" data-schedule-id="'+escape(row.id)+'" data-due="'+(!row.completed&&row.dueAt<=Date.now())+'"><h3>'+escape(row.title)+'</h3><small>'+new Date(row.dueAt).toLocaleString()+' · '+(row.completed?'已完成':row.dueAt<=Date.now()?'已到时间，等待处理':'待提醒')+(row.delivery==='failed'||row.delivery==='unavailable'?' · 系统通知不可用，请检查操作系统通知权限':'')+'</small><p>'+escape(row.note)+'</p><div class="planner-actions"><button data-schedule-edit>编辑</button><button data-schedule-done>'+(row.completed?'重新设为待办':'标记完成')+'</button>'+(!row.completed?'<button class="secondary" data-schedule-snooze>十分钟后提醒</button>':'')+'<button class="danger" data-schedule-remove>删除</button></div></article>').join('');
    return out+'<div class="planner-divider"></div><button class="danger" data-explicit-quit>退出软件并停止提醒</button>';
  }
  function paint(){
    if(!dialog?.isConnected)return;
    dialog.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===tab)));
    const area=dialog.querySelector('[data-planner-body]');area.innerHTML=tab==='projects'?projectMarkup():tab==='schedule'?scheduleMarkup():root.V7EagleUI?root.V7EagleUI.markup():'<p>Eagle 归档模块未加载。</p>';
    if(tab==='eagle'){if(root.V7EagleUI)root.V7EagleUI.mount(area,{projectId});return;}
    const generation=epoch,mountedView=viewEpoch;
    const on=(selector,event,fn)=>area.querySelectorAll(selector).forEach(el=>el.addEventListener(event,e=>{
      if(event==='submit')e.preventDefault();
      Promise.resolve().then(()=>{if(generation===epoch&&mountedView===viewEpoch&&el.isConnected)return fn(el,e);}).catch(report);
    }));
    on('[data-project-select]','change',el=>selectProject(el.value));
    on('[data-refresh-docs]','click',refreshDocuments);
    on('[data-create-project]','click',async()=>{const before=scope(),version=epoch,name=await askText('新建项目','项目名称','');if(name&&before===scope()&&version===epoch)createProject(name);});
    on('[data-rename-project]','click',async()=>{const name=await askText('修改项目名称','项目名称',data().getProject(projectId).name);if(name){data().updateProject(projectId,{name});paint();notifyState();}});
    // ⭐ 2026-10-22（docs/263 第 6 条，用户拍板）：这三处删除都只删本机记录、放得回去 —— 不再弹确认框，改成先删 + 弹窗底部「撤销」
    //   ⚠ 撤销条挂在 dialog 上（弹窗开着时外面是 inert 的，报错堆里的撤销点不到；area 会被 paint 整块重画，不能挂那）
    const undo=(title,fn)=>{if(root.V7Undo)root.V7Undo.offer(title,()=>{try{fn();paint();attention();}catch(error){report(error);}},{host:dialog});};
    on('[data-delete-project]','click',async()=>{const id=projectId,r=data().removeProject(id,true);paint();attention();if(r&&r.removed&&data().restoreProject)undo('已删除项目「'+r.removed.name+'」',()=>{data().restoreProject(r.removed,r.index);selectProject(id);});});
    on('[data-add-selected]','click',()=>{const docs=manager.openDocuments(),selected=[...area.querySelectorAll('[data-open-document]:checked')].map(el=>docs[Number(el.dataset.openDocument)]);manager.register(projectId,selected);paint();});
    on('[data-decision]','click',el=>{manager.decide(el.closest('[data-event-id]').dataset.eventId,el.dataset.decision);paint();});
    const ref=el=>el.closest('[data-project-item]').dataset.projectItem;
    on('[data-item-status]','change',el=>{manager.mark(projectId,ref(el),el.value);paint();});
    on('[data-item-note]','change',el=>data().setProjectItem(projectId,ref(el),{note:el.value}));
    on('[data-eagle-id]','change',el=>data().setProjectItem(projectId,ref(el),{eagleId:el.value}));
    on('[data-remove-item]','click',async el=>{const pid=projectId,r=data().removeProjectItem(pid,ref(el),true);paint();attention();if(r&&r.removed&&data().restoreProjectItem)undo('已移出 1 条项目记录',()=>data().restoreProjectItem(pid,r.removed,r.index));});
    on('[data-rebind]','click',async el=>{const select=el.closest('[data-project-item]').querySelector('[data-rebind-select]');if(!select.value)throw new Error('请先选择要重新关联的 Photoshop 图片');const doc=manager.openDocuments()[Number(select.value)];if(await confirm('确认重新关联','将此记录关联到「'+doc.name+'」，原状态和备注保留。')){manager.rebind(projectId,ref(el),doc);paint();}});
    on('[data-schedule-form]','submit',async(el,e)=>{e.preventDefault();const form=new FormData(el);await request('save',{item:{...(editing||{}),title:form.get('title'),note:form.get('note'),dueAt:new Date(form.get('dueAt')).getTime()}});editing=null;paint();attention();});
    on('[data-clear-schedule]','click',()=>{editing=null;paint();});on('[data-refresh-schedule]','click',async()=>{await request('list');paint();attention();});
    const row=el=>scheduleItems.find(r=>r.id===el.closest('[data-schedule-id]').dataset.scheduleId);
    on('[data-schedule-edit]','click',el=>{editing={...row(el)};paint();});
    on('[data-schedule-done]','click',async el=>{const item=row(el);await request('save',{item:{...item,completed:!item.completed}});paint();attention();});
    on('[data-schedule-snooze]','click',async el=>{await request('save',{item:{...row(el),dueAt:Date.now()+600000}});paint();attention();});
    // 日程删了能撤销：放回 = 把原来那条去掉编号、当新日程再存一次（提醒会重新排上）
    //   ⚠ 必须去掉 id：planner.rs 的 save 收到「带 id 但已经不存在」会报「日程已不存在」
    on('[data-schedule-remove]','click',async el=>{const item={...row(el)};await request('remove',{id:item.id,confirm:true});paint();attention();
      const {id:_oldId,...again}=item;
      if(root.V7Undo)root.V7Undo.offer('已删除日程「'+item.title+'」',()=>{request('save',{item:again}).then(()=>{paint();attention();}).catch(report);},{host:dialog});});
    on('[data-explicit-quit]','click',async()=>{if(await confirm('退出软件','退出后停止日程提醒；未完成的生图任务可能中断。'))await request('quit');});
  }
  function close(){viewEpoch++;if(childCancel)childCancel();if(dialog){if(root.UISelect&&dialog.contains(root.UISelect.panelEl()))root.UISelect.close();dialog.remove();}dialog=null;}
  async function open(nextTab){
    if(navigate)return navigate(nextTab||'projects');
    init();tab=nextTab||'projects';if(!dialog){dialog=document.createElement('dialog');dialog.className='project-schedule';dialog.innerHTML='<header><h2>项目与日程</h2><button data-close>关闭</button></header><nav><button data-tab="projects">项目进度</button><button data-tab="schedule">日程提醒</button><button data-tab="eagle">Eagle 归档</button></nav><div data-planner-body></div><output class="planner-status" role="status"></output>';document.body.append(dialog);dialog.querySelector('[data-close]').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{try{tab=button.dataset.tab;paint();}catch(error){report(error);}});dialog.showModal();}
    paint();try{await request('list');if(tab==='schedule')paint();}catch(error){report(error);}
  }
  function mount(container,nextTab='projects'){
    init();close();tab=['projects','schedule','eagle'].includes(nextTab)?nextTab:'projects';
    const target=document.createElement('section');target.className='project-schedule project-schedule-embedded';target.dataset.plannerSection=tab;
    target.setAttribute('aria-label',{projects:'项目进度',schedule:'日程提醒',eagle:'Eagle 归档'}[tab]);
    target.innerHTML='<div data-planner-body></div><output class="planner-status" role="status"></output>';
    dialog=target;container.replaceChildren(target);try{paint();}catch(error){report(error);}
    if(tab==='schedule')request('list').then(()=>{if(dialog===target&&target.isConnected)paint();}).catch(error=>{if(dialog===target&&target.isConnected)report(error);});
    return ()=>{if(dialog===target)close();else target.remove();};
  }
  let childCancel=null;
  function choice(title,text,input){
    if(childCancel)return Promise.reject(new Error('请先完成当前确认'));
    const child=document.createElement('dialog');child.className='project-schedule';child.innerHTML='<h2>'+escape(title)+'</h2><p>'+escape(text)+'</p>'+(input?'<input aria-label="'+escape(text)+'" value="'+escape(input.value)+'" maxlength="256">':'')+'<div class="planner-actions"><button data-cancel>取消</button><button class="primary" data-accept>确认</button></div>';document.body.append(child);child.showModal();
    return new Promise(resolve=>{const finish=value=>{child.remove();childCancel=null;resolve(value);};childCancel=()=>finish(null);child.querySelector('[data-cancel]').onclick=()=>finish(null);child.addEventListener('cancel',e=>{e.preventDefault();finish(null);});child.querySelector('[data-accept]').onclick=()=>finish(input?child.querySelector('input').value.trim():true);});
  }
  const confirm=(title,text)=>choice(title,text,null),askText=(title,text,value)=>choice(title,text,{value});
  function init(){
    if(initialized)return;initialized=true;
    manager=root.V7ProjectManagerCore.createManager({data:data(),onChange:changed});
    if(root.uiwin&&root.uiwin.link)root.uiwin.link.onEvent(event=>{try{manager.observe(event);}catch(error){report(error);}});
    if(root.uiwin&&root.uiwin.planner){root.uiwin.planner.onReminder(payload=>{if(payload.scope&&payload.scope!==scope())return;if(payload.error){report(new Error(payload.error));return;}request('list').then(()=>{attention();if(dialog&&tab==='schedule'&&!dialog.contains(document.activeElement))paint();}).catch(report);});request('activate').then(attention).catch(report);}
    root.addEventListener('wheelchair:storage-context',()=>{epoch++;close();if(childCancel)childCancel();editing=null;setProjectId('');scheduleItems=[];manager=root.V7ProjectManagerCore.createManager({data:data(),onChange:changed});try{attention();}catch(error){report(error);}request('activate').then(attention).catch(report);});
    document.addEventListener('click',event=>{const button=event.target.closest('[data-project-schedule]');if(button)open(button.dataset.projectSchedule).catch(report);});
    try{attention();}catch(error){report(error);}
  }
  root.V7ProjectSchedule={open,close,mount,confirm,init,quickState,selectProject,createProject,projectIdForCapture,openNewSchedule,quickRefreshDocuments:()=>{init();return refreshDocuments();},configure:options=>{navigate=typeof options?.navigate==='function'?options.navigate:null;},
    markup:()=>'<div class="settings-section"><div class="settings-section-title">项目与日程</div><div class="ai-actions"><button class="ai-btn" data-project-schedule="projects">项目进度</button><button class="ai-btn" data-project-schedule="schedule">日程提醒</button><button class="ai-btn" data-project-schedule="eagle">Eagle 归档</button></div><div class="settings-note">本机记录进度和提醒；关闭主窗口后继续驻留，明确退出后停止。</div></div>',
    async proposeSchedule(input){const dueAt=Number(input.dueAt);if(!Number.isSafeInteger(dueAt)||dueAt<946684800000||dueAt>4102444800000)throw new Error('请提供准确的提醒日期和时间');editing={title:String(input.title||'').slice(0,160),note:String(input.note||'').slice(0,2000),dueAt,completed:false};await open('schedule');return {status:'awaiting_user_save',message:'已打开可编辑的日程草稿；用户点击添加日程后才会保存和提醒。'};}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
