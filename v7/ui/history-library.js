(function(root){
  'use strict';
  let disposeCurrent=()=>{};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // 历史中心显示的是“计算任务”，不只是生成图片。工具任务也会写入
  // cache.v1，因此必须有明确的中文标签，避免在时间线里退化成“任务”。
  const types={generation:'生图',glow:'辉光',dlss:'DLSS',matting:'抠像',segment:'人体分割',sam2:'智能选区'};
  const statuses={done:'已完成',completed:'已完成',failed:'失败',cancelled:'已取消',running:'进行中',queued:'排队中'};
  const costHelp='本机任务记录未保存真实扣费金额。平台积分以账号账单为准；自有 API 和 RH 费用以对应服务商账单为准。报价、失败状态和本地任务均不换算为实际费用。';
  const views=new Map();
  const validTime=value=>{
    const time=Number.isFinite(value)?value:(typeof value==='string'&&value.trim()?Date.parse(value):NaN);
    return Number.isFinite(time)&&time>0?time:null;
  };
  const startedTime=meta=>validTime(meta?.startedAt)||validTime(meta?.createdAt)||validTime(meta?.savedAt);
  const completedTime=meta=>validTime(meta?.completedAt)||validTime(meta?.finishedAt);
  const shotFileIndex=shot=>{
    const index=Number(shot?.index);
    return Number.isInteger(index)&&index>=0?index:null;
  };
  const localDayKey=time=>{
    if(!time)return 'unknown';
    const date=new Date(time);
    return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  };
  const localDayLabel=(key,time)=>{
    if(key==='unknown')return '时间未知';
    const date=new Date(time),now=new Date();
    const today=localDayKey(now.getTime());
    const yesterday=localDayKey(new Date(now.getFullYear(),now.getMonth(),now.getDate()-1).getTime());
    if(key===today)return '今天';
    if(key===yesterday)return '昨天';
    return date.getFullYear()+'年'+(date.getMonth()+1)+'月'+date.getDate()+'日';
  };
  // ⭐ 2026-10-22（docs/263 第 16 条）：返回带完整时间悬停的「3 分钟前」HTML（V7Format），调用处不要再 esc
  const dateText=time=>window.V7Format?window.V7Format.agoHtml(time,'时间未知'):(time?esc(new Date(time).toLocaleString()):'时间未知');
  const statusText=meta=>statuses[meta?.status]||meta?.status||'状态未知';
  const firstValue=(...values)=>values.find(value=>value!==undefined&&value!==null&&String(value).trim()!=='');
  const metadataOf=row=>row?.meta&&typeof row.meta==='object'?row.meta:{};
  const namespaceOf=row=>String(firstValue(metadataOf(row).namespaceId,'unknown'));
  // Keep a stable document identity when two PSDs have the same visible name.
  // The cache project remains the compatibility fallback for old records.
  const projectIdentity=row=>{
    const meta=metadataOf(row),snapshot=meta.captureSnapshot||{};
    const documentId=firstValue(meta.sourceDocId,snapshot.docId,meta.sessionId);
    const base=documentId!==undefined?['document',String(documentId)].join(':'):['cache',String(firstValue(row?.project,meta.project,meta.sourceDocName,'unknown'))].join(':');
    return namespaceOf(row)+'|'+(meta.projectId?'project:'+String(meta.projectId)+'|':'')+base;
  };
  const projectLabel=row=>{
    const meta=metadataOf(row),snapshot=meta.captureSnapshot||{};
    return String(firstValue(meta.sourceDocName,snapshot.docName,meta.projectName,row?.project,'未命名项目'));
  };
  const taskIdentity=(row,index)=>{
    const meta=metadataOf(row),runId=firstValue(row?.runId,meta.runId),taskId=firstValue(meta.taskId,meta.historyId);
    return projectIdentity(row)+'|'+(runId!==undefined?'run:'+String(runId):taskId!==undefined?'task:'+String(taskId):'row:'+String(index));
  };
  const isCheckpoint=row=>{
    const meta=metadataOf(row);
    return meta.checkpoint===true||meta.isCheckpoint===true||meta.recordType==='checkpoint'||meta.kind==='checkpoint';
  };
  const taskGroups=rows=>{
    const projects=[],projectMap=new Map();
    (Array.isArray(rows)?rows:[]).forEach(([row,index])=>{
      if(isCheckpoint(row))return;
      const projectKey=projectIdentity(row),taskKey=taskIdentity(row,index);
      let project=projectMap.get(projectKey);
      if(!project){project={key:projectKey,label:projectLabel(row),rows:[],tasks:[]};projectMap.set(projectKey,project);projects.push(project);}
      let task=project.tasks.find(item=>item.key===taskKey);
      if(!task){task={key:taskKey,projectKey,taskId:firstValue(metadataOf(row).taskId,metadataOf(row).historyId),runId:firstValue(row?.runId,metadataOf(row).runId),time:startedTime(metadataOf(row)),rows:[]};project.tasks.push(task);}
      project.rows.push([row,index]);task.rows.push([row,index]);
    });
    return projects;
  };
  const matchesProject=(row,context)=>{
    const meta=metadataOf(row);
    return !!context?.id&&!!context?.scope&&String(meta.namespaceId||'')===String(context.scope)&&String(meta.projectId||'')===String(context.id);
  };
  const summarize=(rows,context,now=Date.now())=>{
    const unique=new Map();
    (Array.isArray(rows)?rows:[]).forEach((row,index)=>{
      if(isCheckpoint(row))return;
      const key=taskIdentity(row,index),previous=unique.get(key);
      const completed=completedTime(metadataOf(row));
      if(!previous){unique.set(key,{row,completed});return;}
      if(startedTime(metadataOf(row))>startedTime(metadataOf(previous.row)))previous.row=row;
      if(completed&&(previous.completed===null||completed<previous.completed))previous.completed=completed;
    });
    const tasks=[...unique.values()],today=localDayKey(now);
    return {all:tasks.length,today:tasks.filter(item=>item.completed&&localDayKey(item.completed)===today).length,
      project:tasks.filter(item=>matchesProject(item.row,context)).length,
      latest:tasks.reduce((latest,item)=>!latest||startedTime(item.row.meta)>startedTime(latest.meta)?item.row:latest,null)};
  };
  const paginateTasks=(rows,page,size=20)=>{
    const source=Array.isArray(rows)?rows:[],keys=[],seen=new Set();
    source.forEach((row,index)=>{if(isCheckpoint(row))return;const key=taskIdentity(row,index);if(!seen.has(key)){seen.add(key);keys.push(key);}});
    const pages=Math.max(1,Math.ceil(keys.length/size)),selectedPage=Math.max(0,Math.min(Number(page)||0,pages-1));
    const selected=new Set(keys.slice(selectedPage*size,(selectedPage+1)*size));
    return {rows:source.filter((row,index)=>!isCheckpoint(row)&&selected.has(taskIdentity(row,index))),page:selectedPage,pages,total:keys.length};
  };
  function mount(container,host){
    if(!host.recordsEmbedded)disposeCurrent();
    if(!host.recordsEmbedded&&container.id==='dcBody'&&['checkpoints','costs'].includes(host.view)&&root.V7CardArchitecture?.records){
      const cleanup=root.V7CardArchitecture.records(container,host);disposeCurrent=cleanup;return cleanup;
    }
    const view=['checkpoints','costs','current','recent'].includes(host.view)?host.view:'all',scope=host.scope();
    if(!views.has(scope))views.set(scope,new Map());
    const scopedViews=views.get(scope),state=scopedViews.get(view)||{query:'',project:'',kind:'',status:'',page:0,layout:view==='costs'?'list':'timeline'};scopedViews.set(view,state);
    if(typeof host.initialQuery==='string')Object.assign(state,{query:host.initialQuery,project:'',kind:'',status:'',page:0});
    let closed=false,revision=0,entries=[],observer=null,urls=new Set(),migrationDispose=()=>{};
    const current=()=>!closed&&container.isConnected&&host.scope()===scope&&host.active();
    const release=()=>{observer?.disconnect();for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
    const dispose=()=>{closed=true;revision++;release();migrationDispose();};if(!host.recordsEmbedded)disposeCurrent=dispose;
    function fail(error){if(current())root.ERR?.report('HISTORY_OPERATION_FAILED',{message:String(error.message||error)});}
    function checkpoints(){
      const items=host.checkpoints(),cp=container.querySelector('[data-library-checkpoints]');
      cp.innerHTML='<div class="settings-section-title">完整画布检查点 · '+items.length+'</div>'+(items.length?items.map((item,index)=>'<div class="history-item"><div class="history-item-title">'+esc(item.docName||'Photoshop 画布')+'</div><div class="history-item-info">'+dateText(item.createdAt)+' · '+Number(item.width)+' × '+Number(item.height)+'</div><button class="settings-btn" data-checkpoint-open="'+index+'">打开缓存文件夹</button></div>').join(''):(window.V7Format?window.V7Format.emptyHtml({title:'还没有完整画布检查点',hint:'生成前会自动给整张画布存一份；间隔在设置里调'}):'<p class="history-library-empty">暂无完整画布检查点</p>'));
      cp.onclick=async event=>{const button=event.target.closest('[data-checkpoint-open]');if(!button||button.disabled||!current())return;event.preventDefault();event.stopPropagation();button.disabled=true;try{await host.openCheckpoint(items[Number(button.dataset.checkpointOpen)]);}catch(error){fail(error);}finally{if(button.isConnected)button.disabled=false;}};
    }
    if(view==='checkpoints'){
      container.innerHTML='<div class="history-library" data-library-mode="checkpoints"><div data-library-checkpoints></div></div>';
      checkpoints();return dispose;
    }
    container.innerHTML='<div class="history-library" data-library-mode="'+view+'">'+(view==='current'?'<div class="history-library-context" data-library-context></div>':'')+'<div class="settings-grid"><label class="settings-field"><span>关键词</span><input data-library-search></label><label class="settings-field"><span>照片</span><select data-library-project><option value="">全部照片</option></select></label><label class="settings-field"><span>任务类型</span><select data-library-kind><option value="">全部类型</option>'+Object.entries(types).map(([id,label])=>'<option value="'+id+'">'+label+'</option>').join('')+'</select></label><label class="settings-field"><span>结果状态</span><select data-library-status><option value="">全部状态</option><option value="success">有结果</option><option value="empty">无结果</option></select></label></div><div class="history-library-summary"><span data-library-count role="status">正在读取历史</span>'+(view==='costs'?'<button type="button" class="v7-help history-library-help" aria-label="费用记录说明：'+esc(costHelp)+'" data-help-text="'+esc(costHelp)+'">?</button>'+(host.openBilling?'<button type="button" class="settings-btn" data-library-billing>打开账单与兑换</button>':''):'')+'</div>'+(view!=='costs'?'<div class="history-library-layout" role="group" aria-label="历史呈现方式"><span>呈现</span><button type="button" class="settings-btn" data-library-layout="timeline" aria-pressed="'+String(state.layout==='timeline')+'">时间线</button><button type="button" class="settings-btn" data-library-layout="list" aria-pressed="'+String(state.layout==='list')+'">列表</button></div>':'')+'<div class="history-list" data-library-list></div><div class="settings-actions history-library-pagination"><button class="settings-btn" data-library-prev aria-label="上一页">'+root.ICON.render('arrowLeft',16)+'</button><span data-library-page></span><button class="settings-btn" data-library-next aria-label="下一页">'+root.ICON.render('arrowRight',16)+'</button></div></div>';
    if(view==='all'&&root.V7V6HistoryMigration){
      container.querySelector('.history-library').insertAdjacentHTML('afterbegin','<div data-library-migrate></div>');
      migrationDispose=root.V7V6HistoryMigration.mount(container.querySelector('[data-library-migrate]'),{...host,active:current,changed:host.refresh});
    }
    const list=container.querySelector('[data-library-list]');
    async function thumbnail(image,row,run){
      const bytes=await host.cache.readFile(row.project,row.runId,image.dataset.file);
      if(!current()||run!==revision||!image.isConnected)return;
      if(!bytes?.length){image.remove();return;}
      const blob=new Blob([new Uint8Array(bytes)],{type:'image/jpeg'});
      if(blob.size>1024*1024)throw new Error('历史缩略图超出预览大小，请打开缓存文件夹检查该记录。');
      const url=URL.createObjectURL(blob);urls.add(url);image.src=url;
    }
    function render(){
      if(!current())return;
      const run=++revision;release();
      const query=state.query.toLowerCase();
      const projectContext=host.projectContext?.();
      const contextNode=container.querySelector('[data-library-context]');
      if(contextNode)contextNode.textContent=projectContext?projectContext.name+' · '+(projectContext.documents.map(doc=>doc.name).filter(Boolean).join(' / ')||'尚未绑定 PSD'):'尚未选择项目；可在项目卡新建并绑定 PSD';
      const recentCutoff=Date.now()-7*24*60*60*1000;
      const filtered=entries.filter(row=>(view!=='current'||matchesProject(row,projectContext))&&(view!=='recent'||(startedTime(row.meta)||0)>=recentCutoff)&&(!state.project||row.project===state.project)&&(!state.kind||row.meta.kind===state.kind)&&(!state.status||(state.status==='success')===row.meta.shots.some(s=>s.hasImage))&&(!query||[row.meta.prompt,row.meta.label,row.meta.sourceDocName,row.meta.presetTitle,row.meta.model,row.meta.provider,row.meta.taskId].join(' ').toLowerCase().includes(query)));
      const pageResult=paginateTasks(filtered,state.page);state.page=pageResult.page;
      const {rows,pages}=pageResult;
      container.querySelector('[data-library-count]').textContent=pageResult.total+' 条任务';
      container.querySelector('[data-library-page]').textContent=(state.page+1)+' / '+pages;
      container.querySelector('[data-library-prev]').disabled=state.page===0;
      container.querySelector('[data-library-next]').disabled=state.page>=pages-1;
      const renderRow=(row,index)=>{
        const m=row.meta,shots=m.shots.filter(s=>s.hasImage),first=shots[0];
        if(view==='costs'){
          // cache.v1 and imported V6 metadata contain no actual charge receipt.
          return '<article class="history-item history-cost-item" data-library-index="'+index+'"><div class="history-item-title">'+esc(m.label||m.presetTitle||types[m.kind]||'任务')+'</div><div class="history-item-info">'+esc(m.sourceDocName||'未命名照片')+' · '+dateText(startedTime(m))+'</div><dl class="history-cost-fields"><div><dt>服务商</dt><dd>'+esc(m.provider||'未记录')+'</dd></div><div><dt>模型</dt><dd>'+esc(m.model||'未记录')+'</dd></div><div><dt>任务状态</dt><dd>'+esc(statusText(m))+'</dd></div><div><dt>生成结果</dt><dd>'+shots.length+' / '+m.shots.length+' 张</dd></div><div><dt>实际费用</dt><dd data-library-cost>费用未知</dd></div><div><dt>任务编号</dt><dd>'+esc(m.taskId||row.runId)+'</dd></div></dl><div class="settings-actions"><button class="settings-btn" data-library-open>缓存文件夹</button></div></article>';
        }
        const firstIndex=shotFileIndex(first);
        // ⭐⭐ 2026-10-05（docs/143 §七）：历史卡的缩略图也走【底版】。
        //   ⚠ 缓存里【没有 base 的缩略图】—— base_N.png 是原图，缩略图只有 thumb_N.jpg
        //     （它是跟着 output 那个版本走的）。为了给历史做一张"底版的缩略图"，
        //     要么多存一份 thumb、要么现场缩一张 —— 两条都要动缓存写入，属于新增成本。
        //   ⇒ 这一轮的做法：缩略图照旧读 thumb_N.jpg（它就是生成出来的样子，
        //     跟底版的差别只有校色那一点，120px 里看不出来），
        //     【点开看大图】那条路才读 base_N.png（下面 data-library-view）。
        //   ⚠ 这条要跟用户确认：docs/143 §七 明确写了"本文按 base 实现，
        //     施工时要跟用户再确认一次"。缩略图这一档我先按"不动"做，理由写在这里。
        const thumb=firstIndex!==null?'thumb_'+(firstIndex+1)+'.jpg':m.hasInput?'input_thumb.jpg':'';
        const started=startedTime(m),completed=completedTime(m);
        return '<article class="history-item" data-library-index="'+index+'"><div class="history-library-row'+(!thumb?' history-library-row-text':'')+'">'+(thumb?'<button class="history-library-thumb" data-library-view '+(!first?'disabled':'')+' aria-label="查看结果"><img loading="lazy" data-row="'+index+'" data-file="'+thumb+'" alt="任务缩略图"></button>':'')+'<div><div class="history-item-title">'+esc(m.label||m.presetTitle||types[m.kind]||'任务')+'</div><div class="history-item-info">'+esc(m.sourceDocName||'未命名照片')+' · '+esc(m.model||'模型未记录')+'</div><div class="history-item-info">'+dateText(started)+' · '+shots.length+'/'+m.shots.length+' 张 · '+esc(statusText(m))+'</div>'+(m.prompt?'<div class="history-timeline-prompt">'+esc(m.prompt)+'</div>':'')+(completed?'<div class="history-item-info history-item-completed">完成：'+dateText(completed)+'</div>':'')+'</div></div><div class="settings-actions">'+(shots.length>1?'<select data-library-shot aria-label="结果图片">'+shots.map(s=>'<option value="'+s.index+'">第 '+(Number(s.index)+1)+' 张</option>').join('')+'</select>':'')+'<button class="settings-btn" data-library-open>缓存文件夹</button><button class="settings-btn" data-library-restore '+(host.inTaskbar(row)?'disabled':'')+'>'+(host.inTaskbar(row)?'已在任务栏':'恢复到任务栏')+'</button></div></article>';
      };
      if(view!=='costs'&&state.layout==='timeline'){
        const groups=root.V7HistoryLibrary.timeline.group(rows);
        list.innerHTML=groups.map(group=>'<section class="history-timeline-group" data-timeline-day="'+esc(group.key)+'"><h3>'+esc(localDayLabel(group.key,group.time))+'</h3><div class="history-timeline-track">'+group.projects.map(project=>'<div class="history-timeline-project" data-project-key="'+esc(project.key)+'"><div class="history-timeline-project-title">'+esc(project.label)+'</div>'+project.tasks.map(task=>'<div class="history-timeline-task" data-task-key="'+esc(task.key)+'">'+task.rows.map(([row,index])=>renderRow(row,index)).join('')+'</div>').join('')+'</div>').join('')+'</div></section>').join('')||'<p class="history-library-empty">没有匹配的任务记录</p>';
      }else{
        list.innerHTML=rows.map(renderRow).join('')||'<p class="history-library-empty">没有匹配的任务记录</p>';
      }
      for(const element of view!=='costs'?list.querySelectorAll('[data-library-index]'):[]){
        const meta=rows[Number(element.dataset.libraryIndex)].meta;
        if(meta.prompt||meta.migration?.entries?.some(entry=>entry.prompt)){
          const button=document.createElement('button');button.className='settings-btn';button.dataset.libraryReuse='prompt';button.textContent='仅用提示词';
          element.querySelector('.settings-actions').prepend(button);
        }
      }
      if(view!=='costs'){
        observer=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){observer.unobserve(item.target);thumbnail(item.target,rows[Number(item.target.dataset.row)],run).catch(fail);}},{root:null,rootMargin:'120px'});
        list.querySelectorAll('img').forEach(image=>observer.observe(image));
      }
      list.onclick=async event=>{
        const element=event.target.closest('[data-library-index]'),button=event.target.closest('button');
        if(!element||!button||button.disabled||!current())return;
        event.preventDefault();event.stopPropagation();const row=rows[Number(element.dataset.libraryIndex)];button.disabled=true;
        try{
          if(button.hasAttribute('data-library-reuse')){
            const index=Number(element.querySelector('[data-library-shot]')?.value??row.meta.shots.find(s=>s.hasImage)?.index??0);
            const record=row.meta.migration?.entries?.[index]||row.meta;
            if(!record.prompt||record.promptProtected)throw new Error('该条历史没有可复用的提示词。');
            if(!root.V7HistoryPrompts?.apply)throw new Error('历史复用接口未连接。');
            await root.V7HistoryPrompts.apply({prompt:record.prompt},{check:()=>{if(!current()||run!==revision)throw Object.assign(new Error('历史选择已变化'),{code:'HISTORY_CONTEXT_CHANGED'});}});
          }
          else if(button.hasAttribute('data-library-open')){const result=await host.cache.openFolder(row.project,row.runId);if(result?.ok===false)throw new Error(result.error||'文件夹未打开');}
          else if(button.hasAttribute('data-library-restore')){const result=await host.restore(row);if(!current())return;if(result===false)throw new Error('恢复未完成，请重新读取历史。');render();}
          else if(button.hasAttribute('data-library-view')){
            const index=Number(element.querySelector('[data-library-shot]')?.value??row.meta.shots.find(s=>s.hasImage)?.index);
            if(!Number.isInteger(index)||index<0)throw new Error('该条历史缺少有效的结果图片编号，请打开缓存文件夹检查。');
            // ⭐⭐ 2026-10-05（docs/143 §七）：历史卡只显示【没校色的原图】。
            //   ⚠ 为什么不是 output_N.png：它是"当前版本"，用户切到底版之后
            //     历史就不是"没校色的"了。历史要的是【稳定的、生成出来的那个样子】。
            //   ⚠ 底版(base_N.png) vs AI原样(raw_N.png)：选 base ——
            //     base 是掰正过的（位置对），raw 是 AI 原样（位置可能偏）。
            //     用户要的是"生成出来的样子"，不是"AI 吐出来的歪的那张"。
            //   ⚠ 老任务没有 base → 退到 raw，再退到 output（三级兜底，不报错）。
            //   ⭐ 2026-10-19（docs/251 第 7 条③）：生成时就没校色的那张（autoVersion 'base'，默认设置）output_N.png 本身就是底版，
            //     不再另存 base_N.png ⇒ 直接读 output，别退到 raw（raw 是 AI 原样、没掰正）。
            const shot=(row.meta.shots||[])[index]||{};
            const name=shot.autoVersion==='base'?('output_'+(index+1)+'.png')
                      :shot.hasBase?('base_'+(index+1)+'.png')
                      :shot.hasRaw?('raw_'+(index+1)+'.png')
                      :('output_'+(index+1)+'.png');
            const bytes=await host.cache.readFile(row.project,row.runId,name);
            if(!current()||run!==revision)return;if(!bytes?.length)throw new Error('缓存图片已不存在，请核对缓存文件夹。');
            await host.preview(new Uint8Array(bytes),index+1,row.meta.shots.length);
          }
        }catch(error){fail(error);}finally{if(button.isConnected)button.disabled=false;}
      };
    }
    for(const key of ['query','project','kind','status']){
      const control=container.querySelector('[data-library-'+(key==='query'?'search':key)+']');control.value=state[key];
      control.addEventListener(key==='query'?'input':'change',()=>{state[key]=control.value;state.page=0;render();});
    }
    for(const [name,delta] of [['prev',-1],['next',1]])container.querySelector('[data-library-'+name+']').onclick=()=>{state.page+=delta;render();};
    if(view!=='costs'){
      container.querySelectorAll('[data-library-layout]').forEach(button=>button.addEventListener('click',()=>{
        state.layout=button.dataset.libraryLayout==='timeline'?'timeline':'list';
        container.querySelectorAll('[data-library-layout]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
        render();
      }));
    }
    if(view==='costs'&&host.openBilling)container.querySelector('[data-library-billing]').onclick=()=>host.openBilling();
    if(typeof host.cache?.list!=='function'){
      container.querySelector('[data-library-count]').textContent='本机缓存接口未连接';
      list.innerHTML='<p class="history-library-empty">请在桌面软件中查看本机任务文件。积分账单和账号备份可从上方分区进入。</p>';
      return dispose;
    }
    // ⭐ 2026-10-22（docs/263 第 2 / 17 条）：读的时候先画灰色占位（以前一片空白）；读不出来给出错状态 + 重试（以前只在角落写一句）
    if(root.V7Format)list.innerHTML=root.V7Format.skeletonHtml(4,{thumb:view!=='costs'});
    host.cache.list().then(value=>{
      if(!current())return;
      if(!value?.ok||!Array.isArray(value.runs))throw new Error('缓存目录读取失败，请检查缓存位置是否可用。');
      entries=value.runs.filter(row=>host.owns(row)&&!isCheckpoint(row)).map(row=>({...row,meta:{...row.meta,shots:Array.isArray(row.meta.shots)?row.meta.shots:[]}})).sort((a,b)=>(startedTime(b.meta)||0)-(startedTime(a.meta)||0));
      const select=container.querySelector('[data-library-project]'),projects=new Map(entries.map(row=>[row.project,row.meta.sourceDocName||row.project]));
      for(const [id,name] of projects)select.add(new Option(name,id));select.value=state.project;render();
    }).catch(error=>{
      if(current()){
        container.querySelector('[data-library-count]').textContent='历史读取未完成';
        if(root.V7Format){
          list.innerHTML=root.V7Format.errorHtml({title:'历史记录没读出来',hint:String(error&&error.message||'缓存目录读取失败'),action:{label:'重新读取',attrs:'data-library-retry'}});
          const again=list.querySelector('[data-library-retry]');
          if(again)again.onclick=()=>{dispose();mount(container,host);};
        }
      }
      fail(error);
    });
    return dispose;
  }
  root.addEventListener('wheelchair:storage-context',()=>disposeCurrent());
  root.V7HistoryLibrary={mount,dispose:()=>disposeCurrent(),timeline:{
    startedTime,completedTime,shotFileIndex,dayKey:localDayKey,dayLabel:localDayLabel,
    projectIdentity,projectLabel,taskIdentity,isCheckpoint,matchesProject,summarize,paginateTasks,
    groupTasks(rows){return taskGroups((Array.isArray(rows)?rows:[]).map((row,index)=>[row,index]));},
    group(rows){
      const groups=[],byDay=new Map();
      rows.forEach((row,index)=>{const time=startedTime(row?.meta),key=localDayKey(time);let group=byDay.get(key);if(!group){group={key,time,rows:[]};byDay.set(key,group);groups.push(group);}group.rows.push([row,index]);});
      groups.forEach(group=>{group.projects=taskGroups(group.rows);group.tasks=group.projects.flatMap(project=>project.tasks);});
      return groups;
    }
  }};
})(window);
