(function(root){
  'use strict';
  const C=root.V7CameraLightCore,esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let host={},session=null,opening=null,epoch=0;
  const sourceBindings=new Set();
  function assetIds(data){const ids=new Set();if(!data)return [];if(data.capture?.assetId)ids.add(String(data.capture.assetId));for(const row of data.results||[])for(const key of ['id','thumbId'])if(row?.[key])ids.add(String(row[key]));for(const job of Object.values(data.jobs||{}))for(const row of job?.results||[])for(const key of ['id','thumbId'])if(row?.[key])ids.add(String(row[key]));return [...ids];}
  async function pruneAssets(s){check(s);if(s.store.prune)await s.store.prune(assetIds(s.data));check(s);}
  const statusNames={idle:'待运行',running:'生成中',placing:'传回中',done:'已完成',failed:'未完成',interrupted:'已中断'};
  const field=(label,control)=>'<label class="cl-field"><span>'+esc(label)+'</span>'+control+'</label>';
  const button=(icon,title,action)=>'<button class="cl-icon" title="'+title+'" aria-label="'+title+'" data-cl="'+action+'">'+root.ICON.render(icon==='camera'?'image':icon==='trash'?'close':icon,17)+'</button>';
  const select=(name,items,value)=>'<select data-cl-field="'+name+'">'+items.map(row=>{const [v,l]=Array.isArray(row)?row:[row,row];return '<option value="'+esc(v)+'" '+(String(v)===String(value)?'selected':'')+'>'+esc(l)+'</option>';}).join('')+'</select>';
  function report(error){root.ERR?.report(error.code||'LIGHTING_FAILED',{message:String(error.message||error)});if(session)status(String(error.message||error));}
  function status(value){if(session)session.el.querySelector('[data-cl-status]').textContent=value;}
  function check(s){if(session!==s||s.epoch!==epoch)throw Object.assign(new Error('账号或灯光项目已切换，操作已停止'),{code:'LIGHTING_ACCOUNT_CHANGED'});s.store.check();}
  function saving(s){check(s);const value=structuredClone(s.data);const write=()=>{check(s);return s.store.save(value);};s.saveTail=s.saveTail.then(write,write);return s.saveTail;}
  function changed(){const s=session;if(!s)return;s.data.config=C.config(s.data.config);s.scene.update(s.data.config,s.selected);const preview=s.el.querySelector('.cl-prompt');if(preview)try{preview.textContent=C.prompt(s.data.config);}catch(_){preview.textContent='';}clearTimeout(s.timer);s.timer=setTimeout(()=>saving(s).catch(report),300);}
  function range(name,label,value,min,max,step=1){return field(label,'<input data-cl-field="'+name+'" type="range" min="'+min+'" max="'+max+'" step="'+step+'" value="'+value+'"><output>'+value+'</output>');}
  const modeNotes={camera:'拖动画面调整镜头方向；距离和缩放在参数区调整。',light2d:'选中一盏灯，在画面上拖动位置；附件会跟随当前灯光。',light3d:'选中一盏灯，拖动画面调整方向和高度。',split:'先分析或手动添加光源，再逐个生成；已完成结果会保留。'};
  function group(id,title,body,open=false,note=''){return '<details class="cl-group" data-cl-group="'+esc(id)+'" '+(open?'open':'')+'><summary><span>'+esc(title)+'</span>'+(note?'<small>'+esc(note)+'</small>':'')+'</summary><div class="cl-group-body">'+body+'</div></details>';}
  function rememberView(s,panel){
    const mode=panel.dataset.mode;if(!mode)return;
    s.views[mode]={scroll:panel.scrollTop,groups:Object.fromEntries([...panel.querySelectorAll('[data-cl-group],[data-source]')].map(el=>[el.dataset.clGroup||'source:'+el.dataset.source,el.open]))};
  }
  function syncSceneControls(s){
    // Pointer movement must not replace the form: that used to jump its scroll
    // position, collapse groups, and discard a field being edited.
    for(const input of s.el.querySelectorAll('[data-cl-field]')){
      const [part,key]=input.dataset.clField.split('.'),c=s.data.config,target=part==='camera'?c.camera:part==='light'?c.lights.find(light=>light.id===s.selected):c;
      if(!target)continue;const value=target[key||part];if(input.type==='checkbox')input.checked=!!value;else input.value=value??'';
      if(input.nextElementSibling?.tagName==='OUTPUT')input.nextElementSibling.textContent=input.value;
    }
  }
  function controls(){const s=session;if(!s)return;const panel=s.el.querySelector('.cl-controls');rememberView(s,panel);const focused=panel.contains(document.activeElement)?document.activeElement?.dataset.clField:null;root.UISelect?.close();s.urls.forEach(URL.revokeObjectURL);s.urls=[];const c=s.data.config,item=c.lights.find(l=>l.id===s.selected);
    panel.dataset.mode=c.mode;s.el.dataset.mode=c.mode;
    const allowed=modesFor(s.only),header=s.el.querySelector('.cl-header');
    s.el.querySelectorAll('[data-cl-mode]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.clMode===c.mode));b.hidden=!allowed.includes(b.dataset.clMode);});
    // 只有一个模式（3D 镜头）就不显示模式栏；灯光 3 个模式按 3 列排（CSS 写死 4 列，会空一格）
    if(header){header.hidden=allowed.length<2;const bar=header.querySelector('nav');if(bar)bar.style.gridTemplateColumns='repeat('+allowed.length+',minmax(0,1fr))';}
    const source=s.el.querySelector('.cl-source');source.innerHTML='<div class="cl-source-copy"><strong>来源图像</strong><span>'+esc(s.data.capture?`${s.data.capture.docName} · ${s.data.capture.width} × ${s.data.capture.height}`:'先从 Photoshop 抓取图像，生成结果会回到原文档')+'</span></div><button type="button" data-cl="capture">'+root.ICON.render('image',16)+(s.data.capture?'重新抓取':'抓取图像')+'</button>'+(s.data.capture&&!sourceBindings.has(s.data.capture.assetId)?'<button type="button" data-cl="rebind">确认原文档</button>':'');
    s.el.querySelector('.cl-stage-note').textContent=modeNotes[c.mode];
    const runButton=s.el.querySelector('[data-cl="run"]');runButton.disabled=s.busy;runButton.innerHTML=root.ICON.render('play',16)+(s.busy?'正在处理…':c.mode==='split'?'运行未完成光源':'开始生成');s.el.querySelector('[data-cl="stop"]').hidden=!s.busy;
    let html='';
    if(c.mode==='camera')html+=group('camera','机位调整',range('camera.az','方位',c.camera.az,0,315)+range('camera.el','仰角',c.camera.el,-90,90)+range('camera.distance','距离',c.camera.distance,.6,4,.1)+range('camera.zoom','预览缩放',c.camera.zoom,.5,2,.05),true);
    if(c.mode==='light2d'||c.mode==='light3d'){
      let lighting='<div class="cl-light-list" aria-label="选择灯光">'+c.lights.map(l=>'<button type="button" data-light-id="'+esc(l.id)+'" aria-pressed="'+(s.selected===l.id)+'" title="'+esc(l.name+(l.enabled?' · 已启用':' · 未启用'))+'">'+esc(l.name)+(l.enabled?'':' · 关')+'</button>').join('')+'<button type="button" data-cl="add">'+root.ICON.render('plus',16)+'添加灯光</button></div>';
      if(item){lighting+=field('灯光名称','<input data-cl-field="light.name" value="'+esc(item.name)+'">')+field('启用这盏灯','<input data-cl-field="light.enabled" type="checkbox" '+(item.enabled?'checked':'')+'>');
        lighting+=c.mode==='light2d'?range('light.x','横向位置',item.x,0,1,.01)+range('light.y','纵向位置',item.y,0,1,.01)+range('light.scale','附件大小',item.scale,.05,.7,.01)+range('light.rotation','旋转',item.rotation,-180,180):range('light.az','方位',item.az,0,360)+range('light.el','仰角',item.el,-90,90)+range('light.distance','距离',item.distance,.6,4,.1);
        lighting+=range('light.intensity','光强',item.intensity,0,10,.1);
      }else lighting+='<p class="cl-empty">还没有灯光。点“添加灯光”，然后在预览中摆放。</p>';
      html+=group('lights','灯光与位置',lighting,true,c.lights.length+' 盏');
      if(item){html+=group('equipment','灯具与颜色',field('布光角色',select('light.role',C.roles,item.role))+field('光源类型',select('light.type',[['point','点光源'],['spot','聚光灯'],['area','面光源'],['directional','平行光']],item.type))+'<div class="cl-attachment-row">'+field('控光附件',select('light.attachment',C.attachments.map((l,i)=>[i,l]),item.attachment))+'<img class="cl-attachment" alt="'+esc(C.attachments[item.attachment])+'" src="assets/light-handdrawn/light_'+String(item.attachment+1).padStart(2,'0')+'.png"></div>'+field('颜色模式',select('light.colorMode',[['kelvin','色温'],['color','颜色']],item.colorMode))+(item.colorMode==='kelvin'?range('light.kelvin','色温 K',item.kelvin,2000,10000,100):field('颜色','<input type="color" data-cl-field="light.color" value="'+item.color+'">'))+'<div class="cl-row"><button type="button" data-cl="placeAttachment">'+root.ICON.render('upload',16)+'附件传入 Photoshop</button>'+button('trash','删除当前灯光','remove')+'</div>',false,C.attachments[item.attachment]);
      }
    }
    if(c.mode==='split'){
      let sources='<p class="cl-note">生成后的光源按原位置传回，默认隐藏；失败重试继续使用已有结果。</p><div class="cl-row"><button type="button" data-cl="analyze">'+root.ICON.render('sparkles',16)+'分析光源</button><button type="button" data-cl="addSource">'+root.ICON.render('plus',16)+'手动添加</button></div>';
      sources+=s.data.sources.map((source,i)=>{const job=s.data.jobs[source.id],locked=job?.results?.length||job?.status==='running';return '<details class="cl-job" data-source="'+esc(source.id)+'" '+(!job?'open':'')+'><summary>'+esc(source.type+' · '+(source.direction||('光源 '+(i+1)))+' · '+(statusNames[job?.status]||'待运行'))+'</summary>'+field('启用','<input data-source-field="enabled" type="checkbox" '+(source.enabled?'checked':'')+'>')+['type','direction','color','area','intensity','description'].map(key=>field(({type:'类别',direction:'方向',color:'颜色',area:'照射部位',intensity:'强度',description:'定位词'})[key],'<input data-source-field="'+key+'" value="'+esc(source[key])+'" '+(locked?'disabled':'')+'>')).join('')+(job?.error?'<div class="cl-warning">'+esc(job.error)+'</div>':'')+'</details>';}).join('');
      if(!s.data.sources.length)sources+='<p class="cl-empty">先分析图中的光源，也可以手动填写。</p>';
      html+=group('sources','光源列表',sources,true,s.data.sources.length+' 个');
    }
    let generation=field('图像服务',select('channel',[['','当前服务'],['aji','AJI'],['grs','GRS'],['other','其他']],c.channel))+field('模型',select('model',[['','当前模型'],...(host.models?.()||[])],c.model))+field('尺寸',select('size',['1K','2K','4K'],c.size))+field('比例',select('aspect',['Auto','1:1','2:3','3:2','9:16','16:9'],c.aspect));
    if(c.mode!=='split')generation+=field('张数','<input type="number" data-cl-field="batch" min="1" max="5" value="'+c.batch+'">');
    html+=group('generation','生成设置',generation,false,c.size+' · '+(c.mode==='split'?'逐光源':c.batch+' 张'));
    let preset=field('预设名称','<input data-cl-field="name" value="'+esc(c.name)+'">')+'<button type="button" data-cl="savePreset">'+root.ICON.render('save',16)+'保存为预设</button>';
    if(c.mode!=='split'){let prompt='';try{prompt=C.prompt(c);}catch(_){}preset+='<p class="cl-note">以下文字会随参数更新，并发送给图像服务。</p><div class="cl-prompt">'+esc(prompt)+'</div>';}
    html+=group('preset','预设与生成文字',preset);
    if(c.mode!=='split'||s.data.results.length)html+=group('results','生成结果','<p class="cl-note">点结果缩略图，传回锁定的原 Photoshop 文档。</p><div class="cl-results"></div>'+(!s.data.results.length?'<p class="cl-empty">生成完成后，结果会显示在这里。</p>':''),true,s.data.results.length+' 张');
    panel.innerHTML=html;
    const view=s.views[c.mode];if(view)for(const details of panel.querySelectorAll('[data-cl-group],[data-source]')){const key=details.dataset.clGroup||'source:'+details.dataset.source;if(Object.hasOwn(view.groups,key))details.open=view.groups[key];}
    for(const element of panel.querySelectorAll('[data-source]')){
      const job=s.data.jobs[element.dataset.source];
      if(!job||!Object.values(job.placed||{}).some(value=>value.pending))continue;
      const retry=document.createElement('button');retry.textContent='核对原文档后重新传回';retry.disabled=s.busy;
      retry.onclick=async()=>{try{if(!await host.confirm('确认重新传回未确认的光源','上次可能已经建立图层。请先检查原文档，重新传回可能产生重复图层；不会再次生图或扣生图费用。'))return;check(s);for(const [id,value] of Object.entries(job.placed))if(value.pending)delete job.placed[id];await saving(s);controls();}catch(error){report(error);}};
      element.appendChild(retry);
    }
    s.el.querySelectorAll('[data-cl-mode],.cl-source [data-cl],.cl-controls input,.cl-controls select,.cl-controls .uisel-trigger,.cl-controls [data-cl],.cl-controls [data-light-id]').forEach(el=>{if(s.busy)el.disabled=true;else if(!el.matches('[data-source-field]:disabled'))el.disabled=false;});
    for(const container of [panel,source])container.querySelectorAll('[data-cl]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.cl).catch(report)));
    panel.querySelectorAll('[data-light-id]').forEach(b=>b.addEventListener('click',()=>{s.selected=b.dataset.lightId;controls();changed();}));
    panel.querySelectorAll('[data-cl-field]').forEach(input=>input.addEventListener(input.type==='range'?'input':'change',()=>{if(s.busy)return;const [part,key]=input.dataset.clField.split('.'),live=s.data.config;const target=part==='camera'?live.camera:part==='light'?live.lights.find(l=>l.id===s.selected):live;const name=key||part;target[name]=input.type==='checkbox'?input.checked:input.type==='range'||input.type==='number'||name==='attachment'?Number(input.value):input.value;if(input.nextElementSibling?.tagName==='OUTPUT')input.nextElementSibling.textContent=input.value;changed();if(['mode','colorMode','attachment','enabled','name','batch','size'].includes(name))controls();}));
    panel.querySelectorAll('[data-source-field]').forEach(input=>input.addEventListener('change',()=>{if(s.busy)return;const source=s.data.sources.find(x=>x.id===input.closest('[data-source]').dataset.source),key=input.dataset.sourceField;source[key]=key==='enabled'?input.checked:input.value;changed();}));
    for(const [index,result] of (s.data.results||[]).entries()){const b=document.createElement('button');b.type='button';b.disabled=s.busy;b.title='结果 '+(index+1)+' · 传回原 Photoshop 文档';b.setAttribute('aria-label',b.title);const image=document.createElement('img');image.alt='生成结果 '+(index+1);b.appendChild(image);panel.querySelector('.cl-results').appendChild(b);s.store.asset(result.thumbId).then(blob=>{check(s);if(!image.isConnected)return;const url=URL.createObjectURL(blob);s.urls.push(url);image.src=url;}).catch(report);b.onclick=()=>ensureBound(s).then(()=>host.transfer(result,s.data.capture,s.store)).then(()=>status('已传回原文档')).catch(report);}
    if(focused)panel.querySelector('[data-cl-field="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});panel.scrollTop=view?.scroll||0;
  }
  async function ensureBound(s){check(s);if(!sourceBindings.has(s.data.capture?.assetId))throw new Error('请先确认原 Photoshop 文档，再继续生成或传回');}
  async function capture(){const s=session;check(s);if(s.busy)throw new Error('请先停止当前灯光任务');if(s.data.sources.length||s.data.results.length){if(!await host.confirm('重新抓取图像','将开始新的灯光项目；旧生成结果会在新项目保存后回收。'))return;check(s);}const oldIds=assetIds(s.data);const value=await host.capture();check(s);const assetId=await s.store.put(value.blob,{evict:oldIds});check(s);s.data.capture={...value.target,assetId};sourceBindings.add(assetId);s.data.sources=[];s.data.jobs={};s.data.results=[];await s.scene.setImage(value.blob);check(s);await saving(s);await pruneAssets(s);controls();status('已锁定来源文档和区域');}
  async function resultAssets(outputs,s){const rows=[];const oldIds=(s.data.results||[]).flatMap(row=>[row.id,row.thumbId]).filter(Boolean);for(const output of outputs){check(s);const bytes=await root.IMG.fullBytes(output.imgId);check(s);const id=await s.store.put(new Blob([bytes],{type:output.mime||'image/png'}),{evict:oldIds});const thumbId=await s.store.put(new Blob([await root.IMG.thumbBytes(output.imgId)],{type:'image/jpeg'}),{evict:oldIds});rows.push({id,thumbId,width:root.IMG.size(output.imgId).w,height:root.IMG.size(output.imgId).h});}return rows;}
  async function generate(source,s){await ensureBound(s);const c=C.config(s.data.config),blob=await s.store.asset(s.data.capture.assetId);check(s);const diagram=!source&&c.mode!=='camera'?await s.scene.blob():null;check(s);const outputs=await host.generate({config:c,capture:s.data.capture,blob,diagram,prompt:source?C.splitPrompt(source):C.prompt(c),batch:source?1:c.batch,title:source?'拆光 · '+source.type+' · '+source.direction:c.mode==='camera'?'3D 镜头':'灯光重构',setTaskId:id=>{s.taskId=id;}});check(s);return resultAssets(outputs,s);}
  async function run(){const s=session;check(s);if(s.busy)return;if(!s.data.capture)await capture();check(s);if(!s.data.capture)return;await ensureBound(s);s.busy=true;controls();try{if(s.data.config.mode==='split'){if(!s.data.sources.length)throw new Error('请先分析或添加光源');s.runner=C.runner({token:()=>s.epoch,check:()=>check(s),save:()=>saving(s),generate:source=>generate(source,s),place:(result,source)=>host.transfer(result,s.data.capture,s.store,{name:source.type+' · '+source.direction,blendMode:'screen',visible:false}),style:placed=>host.style(placed,s.data.capture),cancel:()=>host.cancel(s.taskId),report,changed:controls});await s.runner.run(s.data);await saving(s);await pruneAssets(s);status('拆光进度已保存');}else{s.data.results=await generate(null,s);await saving(s);await pruneAssets(s);status('生成完成，结果可传回原文档');}}finally{if(session===s){s.busy=false;s.runner=null;controls();}}}
  async function action(name){const s=session;check(s);if(name==='stop')return actionImpl(name);if(s.actionBusy)throw new Error('请先等待当前灯光操作完成');s.actionBusy=true;try{return await actionImpl(name);}finally{s.actionBusy=false;}}
  async function actionImpl(name){const s=session;check(s);if(name==='close')return close();if(name==='capture')return capture();if(name==='run')return run();if(name==='stop'){s.runner?.stop();await host.cancel(s.taskId);return;}
    if(s.busy)throw new Error('请先等待或停止当前任务');
    if(name==='rebind'){if(await host.rebind(s.data.capture)){check(s);sourceBindings.add(s.data.capture.assetId);}controls();return;}
    if(name==='add'){if(s.data.config.lights.length>=16)throw new Error('最多添加 16 盏灯');const l=C.light({},s.data.config.lights.length);s.data.config.lights.push(l);s.selected=l.id;}
    if(name==='remove'){s.data.config.lights=s.data.config.lights.filter(l=>l.id!==s.selected);s.selected=s.data.config.lights[0]?.id;}
    if(name==='addSource'){if(s.data.sources.length>=16)throw new Error('最多添加 16 个光源');s.data.sources.push(C.sources([{type:'主光',direction:'左前',color:'暖白',area:'主体',intensity:'中'}])[0]);}
    if(name==='analyze'){if(!s.data.capture)await capture();check(s);if(!s.data.capture)return;const blob=await s.store.asset(s.data.capture.assetId);check(s);const answer=await host.analyze(blob,C.analysisPrompt);check(s);if(answer?.cancelled)return;s.data.sources=C.sources(answer.text);s.data.jobs={};}
    if(name==='savePreset'){const value=await host.presetName(s.data.config.name);check(s);if(!value)return;await root.PRESETS.savePreset({title:value,category:root.PRESETS.TOOL_ID,kind:'camera-light',content:JSON.stringify(C.config({...s.data.config,name:value}))});check(s);status('已保存相机与灯光预设');}
    if(name==='placeAttachment'){if(!s.data.capture)await capture();check(s);if(!s.data.capture)return;const item=s.data.config.lights.find(l=>l.id===s.selected);if(!item)throw new Error('请先选择一盏灯');await host.attachment(item,s.data.capture);check(s);status('灯光附件已传入原文档');}
    controls();changed();await saving(s);
  }
  // ⭐ 2026-09-29 用户定案：「相机与灯光」拆回 V6 的两个工具 ——「3D 镜头」只有机位模式；「灯光」是手绘布光 / 3D 布光 / 自动拆光。
  //   两个工具共用这一个工作区和同一个本机项目（抓的图、结果都在），只是露出的模式不同。
  //   only = 'camera' | 'light'；不传（老入口、用户存过的相机灯光预设）= 四个模式都给，和以前一模一样。
  const MODE_SETS={camera:['camera'],light:['light2d','light3d','split']},TITLES={camera:'3D 镜头',light:'灯光'};
  const modesFor=only=>MODE_SETS[only]||['camera','light2d','light3d','split'];
  function applyOnly(s,only){s.only=MODE_SETS[only]?only:null;const allowed=modesFor(s.only);if(!allowed.includes(s.data.config.mode))s.data.config.mode=allowed[0];}
  async function openEditor(preset,only){if(session){if(!session.busy&&(preset||only)){if(preset){session.data.config=C.config(typeof preset.content==='string'?JSON.parse(preset.content):preset.content);session.selected=session.data.config.lights[0]?.id;}applyOnly(session,only);controls();changed();}return;}
    const store=root.V7CameraLightStore.create(),token=epoch,stored=await store.load();if(token!==epoch)throw new Error('账号已切换');const data=stored||{config:C.config(),capture:null,sources:[],jobs:{},results:[]};data.config=C.config(preset?JSON.parse(preset.content):data.config);for(const job of Object.values(data.jobs||{}))if(['running','placing'].includes(job.status)){job.status='interrupted';job.error='上次运行中断，已保留结果';}
    const el=document.createElement('section');el.className='camera-light';el.dataset.uiOverlay='false';el.setAttribute('aria-label','相机与灯光编辑区');el.innerHTML='<header class="cl-header"><nav aria-label="相机与灯光模式">'+[['camera','3D 镜头'],['light2d','手绘布光'],['light3d','3D 布光'],['split','自动拆光']].map(([mode,label])=>'<button type="button" data-cl-mode="'+mode+'">'+label+'</button>').join('')+'</nav></header><div class="cl-source"></div><div class="cl-body"><section class="cl-preview" aria-label="布光预览"><div class="cl-preview-title"><strong>画面预览</strong><span>拖动画面调整</span></div><div class="cl-stage"></div><p class="cl-stage-note"></p></section><aside class="cl-controls" aria-label="当前模式参数"></aside></div><footer class="cl-footer"><span data-cl-status role="status">本机项目自动保存 · 关闭后可继续</span><div class="cl-footer-actions"><button type="button" data-cl="stop" hidden>停止等待</button><button type="button" class="cl-run" data-cl="run"></button></div></footer>';session={el,store,data,epoch:token,saveTail:Promise.resolve(),urls:[],views:{},selected:data.config.lights[0]?.id,busy:false,initializing:true};const s=session;applyOnly(s,only);
    try{s.workspace=await root.V7Workspaces.adoptLegacy('camera-light',TITLES[s.only]||'相机与灯光',el,close,report);check(s);s.scene=root.V7CameraLightScene.create(el.querySelector('.cl-stage'),(value,id)=>{if(s.busy)return;const selectedChanged=s.selected!==id;s.data.config=value;s.selected=id;changed();if(selectedChanged)controls();else syncSceneControls(s);},report);s.scene.update(data.config,s.selected);if(data.capture){const blob=await store.asset(data.capture.assetId);check(s);if(!blob)throw new Error('来源图片已不存在，请重新抓取');await s.scene.setImage(blob);}check(s);s.initializing=false;controls();
      el.querySelectorAll('.cl-footer [data-cl]').forEach(b=>b.onclick=()=>action(b.dataset.cl).catch(report));el.querySelectorAll('[data-cl-mode]').forEach(b=>b.onclick=()=>{if(s.busy||!modesFor(s.only).includes(b.dataset.clMode))return;s.data.config.mode=b.dataset.clMode;controls();changed();});el.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close().catch(report);}event.stopPropagation();});for(const type of ['wheel','pointerdown','mousedown','click'])el.addEventListener(type,event=>event.stopPropagation());
    }catch(error){if(session===s)session=null;s.workspace?.forceClose();s.scene?.dispose();el.remove();await store.close();if(error.code==='WORKSPACE_OPEN_CANCELLED')return;throw error;}
  }
  // open(preset) 老用法不变；open('camera') / open('light') = 剪影工具「3D 镜头」「灯光」（tool-silhouettes 按 mode 传进来）。
  function open(preset){const only=typeof preset==='string'?preset:null;if(only)preset=undefined;if(opening)return opening;opening=openEditor(preset,only).finally(()=>{opening=null;});return opening;}
  async function close(fromWorkspace=false){const s=session;if(!s)return;if(!fromWorkspace&&s.workspace)return s.workspace.close();if(s.initializing)throw new Error('正在读取灯光项目，请稍后返回');if(s.busy){s.runner?.stop();await host.cancel(s.taskId);throw new Error('正在停止任务，请完成后关闭，结果会保留');}clearTimeout(s.timer);await saving(s);await pruneAssets(s);session=null;s.scene.dispose();s.urls.forEach(URL.revokeObjectURL);s.el.remove();await s.store.close();}
  root.addEventListener('wheelchair:storage-context',()=>{epoch++;sourceBindings.clear();const s=session;if(!s)return;session=null;clearTimeout(s.timer);s.runner?.stop();Promise.resolve(host.cancel?.(s.taskId)).catch(report);s.scene?.dispose();s.urls.forEach(URL.revokeObjectURL);s.el.remove();s.store.close().catch(report);});
  root.V7CameraLight={configure:value=>{host=value;},open,close,run:()=>action('run').catch(report),state:()=>session,isOpen:()=>!!session};
})(window);
