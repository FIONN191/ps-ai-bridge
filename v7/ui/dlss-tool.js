(function(root){
  'use strict';
  let host={},panel=null,backdrop=null,runner=null,source=null,epoch=0,previewUrl='',localTask=null,resultId='',originalId='',correctedId='',placedLayer=null,correctedLayer=null,transferBusy=false;
  const parameters={...root.V7DLSSRuntime.defaults};
  let autoReturn=true,sessionKey=null,unsubscribe=null,captureBusy=false,placementPending=false,correctionPending=false,originalOwned=false,restored=false;
  // ⭐ 工具大卡订阅用（2026-09-29 用户定案「老弹窗全部收掉，大卡是唯一入口」）：状态 / 进度 / 预览一变就推快照。
  const listeners=new Set();let lastStatus='原尺寸增强 · 1 通用积分',lastPreview=null;
  function snapshot(){
    const run=runner&&runner.state(),busy=!!(captureBusy||runner&&runner.busy()),active=!!run&&!run.cancelled&&run.stage!=='已完成';
    const signed=!!root.V7Backend?.state?.().signedIn;
    return {signedIn:signed,busy,transferBusy,stage:run?run.stage:'',progress:run&&run.progress||0,paid:!!run?.paid,status:lastStatus,
      source:source?{docName:source.docName,width:source.selection.width,height:source.selection.height,full:source.selection.left===0&&source.selection.top===0&&source.selection.width===source.docWidth&&source.selection.height===source.docHeight}:null,
      hasResult:!!resultId,placed:!!placedLayer,parameters:{...parameters},autoReturn,preview:lastPreview,
      canCapture:!busy&&!active,canRun:!busy&&!resultId&&!!source&&!(run&&!run.cancelled),canResume:!busy&&active,canCancel:active,
      canTransfer:!busy&&!transferBusy&&!!resultId&&!(placedLayer&&(!parameters.colorMatch||!!correctedLayer)),paramsLocked:busy||!!resultId||!!run&&!run.cancelled};
  }
  function notify(){if(!listeners.size)return;const value=snapshot();for(const fn of listeners){try{fn(value);}catch(_){}}}
  const error=message=>Object.assign(new Error(message),{code:'DLSS_FAILED'});
  const check=version=>{if(version!==epoch)throw error('账号已切换，原账号的 DLSS 操作已停止');};
  function status(message){lastStatus=String(message);if(panel)panel.querySelector('[data-status]').textContent=message;notify();}
  async function confirm(options){const dialog=panel,shade=backdrop;if(dialog)dialog.style.visibility='hidden';if(shade)shade.style.visibility='hidden';try{return await host.confirm(options);}finally{if(dialog?.isConnected)dialog.style.visibility='';if(shade?.isConnected)shade.style.visibility='';}}
  async function persist(version){
    check(version);if(!localTask)return;const task=taskById(localTask.id);if(!task)throw error('本次任务已移除，已停止操作');
    task.toolParams={parameters:{...parameters},source:{...source},placementPending,correctionPending,correctedLayer};
    if(!cacheAvailable())return;
    if(task.restoredFromCache){const result=await root.uiwin.cache.writeMeta(task.cacheProject,task.cacheRunId,cacheMetaFromTask(task,task.cacheProject,task.cacheRunId,true));check(version);if(result?.ok!==true)throw error('DLSS 传回状态保存失败，已停止后续传回');return;}
    while(task._cacheWriting){await new Promise(resolve=>setTimeout(resolve,20));check(version);}
    task.cacheSaved=false;await cacheSaveTask(task);check(version);if(!task.cacheSaved)throw error('DLSS 本机缓存保存失败，服务器结果暂未确认删除，请恢复传输重试');
  }
  function report(reason){status(reason.message||String(reason));if(!reason.dlssReported)root.ERR&&root.ERR.report('DLSS_FAILED',{message:reason.message||String(reason),detail:reason.code||''});paint();}
  const b64=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
  function revoke(){if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';}
  function preview(blob,label){lastPreview={blob,label};if(panel){revoke();previewUrl=URL.createObjectURL(blob);panel.querySelector('img').src=previewUrl;panel.querySelector('figcaption').textContent=label;}notify();}
  async function pixels(blob){const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);bitmap.close();return context.getImageData(0,0,canvas.width,canvas.height);}
  async function complete(run){
    const version=epoch;check(version);
    if(!resultId){const id=await IMG.putFromBase64(await b64(run.result),'image/png');try{check(version);}catch(failure){IMG.release(id);throw failure;}resultId=id;}
    if(run.original&&!originalId){const id=await IMG.putFromBase64(await b64(run.original),'image/png');try{check(version);}catch(failure){IMG.release(id);throw failure;}originalId=id;}
    const width=run.source.selection.width,height=run.source.selection.height;
    if(originalId){updateTask(localTask.id,{sourceImgId:originalId,sourceImg:IMG.thumb(originalId)});originalOwned=true;}
    updateGenerationTask(localTask.id,{status:'done',pct:100,outputs:[{index:0,imgId:resultId,restoreState:'done'}],shots:[{done:true,imgId:resultId,restoreState:'done'}],sub:'DLSS 原尺寸增强完成 · '+width+' × '+height,platformTaskId:run.taskId});
    await persist(version);check(version);
    if(run.result)preview(run.result,'增强结果 · '+width+' × '+height);
    historyRecordTask(taskById(localTask.id)||localTask);
  }
  function paint(){
    notify();
    if(!panel)return;const run=runner&&runner.state(),busy=captureBusy||runner&&runner.busy();
    panel.querySelector('[data-capture]').disabled=busy||!!run&&!run.cancelled&&run.stage!=='已完成';
    panel.querySelector('[data-run]').disabled=busy||!!resultId||!source||!!run&&!run.cancelled;
    panel.querySelector('[data-resume]').disabled=busy||!run||run.cancelled||run.stage==='已完成';
    panel.querySelector('[data-cancel]').disabled=!run||run.cancelled||run.stage==='已完成';
    panel.querySelector('[data-transfer]').disabled=busy||transferBusy||!resultId||!!placedLayer&&(!parameters.colorMatch||!!correctedLayer);
    panel.querySelectorAll('[data-param]').forEach(input=>input.disabled=busy||!!resultId||!!run&&!run.cancelled);
    panel.querySelector('progress').value=run&&run.progress||0;
  }
  function createRunner(){
    runner=root.V7DLSSRuntime.create({backend:root.V7Backend,
      capture:(captured,selection)=>host.bridge('ps.regions.capture',{docId:captured.docId,selection,expected:{name:captured.docName,width:captured.docWidth,height:captured.docHeight},maxEdge:2048}),
      confirm:estimate=>confirm({title:'确认 DLSS 增强',body:'原尺寸增强 · '+Number(estimate.points||0).toLocaleString('zh-CN')+' 通用积分',detail:'提交后扣费；失败、取消或未收到结果不自动退款。'}),
      started:run=>{resultId='';originalId='';originalOwned=false;correctedId='';placedLayer=null;correctedLayer=null;restored=false;localTask=makeToolTask('dlss',{taskId:aiNewTaskId('dlss'),label:'DLSS 画质增强'},1);Object.assign(localTask,{storageNamespaceId:cacheNamespaceId(),antiMode:0,provider:'平台 DLSS',model:'原尺寸增强',batch:1,sourceDocId:run.source.docId,sourceDocName:run.source.docName,sourceSelection:run.source.selection,captureSnapshot:aiCaptureSnapshot({...run.source,width:run.source.selection.width,height:run.source.selection.height,hasSelection:true,antiMode:0},0)});addTask(localTask);},
      changed:run=>{status(run.stage+(run.paid?' · 已扣 1 通用积分':''));if(localTask&&run.stage!=='已完成'&&!run.saved)updateGenerationTask(localTask.id,{status:'running',sub:run.stage,pct:run.progress});paint();},
      failed:(run,reason)=>{if(localTask){const task=updateGenerationTask(localTask.id,{status:run.saved?'done':'failed',errorCode:'DLSS_FAILED',error:reason.message,sub:reason.message});if(!run.saved&&task?._errorReported)reason.dlssReported=true;}},
      cancelled:()=>{if(localTask)updateGenerationTask(localTask.id,{status:'cancelled',sub:'DLSS 已取消；已扣费用不自动退回'});status('已取消');paint();},complete
    });
  }
  async function capture(){
    if(captureBusy)return;captureBusy=true;paint();const version=epoch;
    try{status('正在读取 Photoshop 选区');const captured=await host.bridge('ps.regions.capture',{maxEdge:256});check(version);
    const blob=await(await fetch('data:image/png;base64,'+captured.imageBase64)).blob();check(version);
    source={docId:captured.docId,docName:captured.docName,docWidth:captured.docWidth,docHeight:captured.docHeight,selection:captured.selection};
    if(originalId&&!originalOwned)IMG.release(originalId);if(correctedId)IMG.release(correctedId);originalId='';originalOwned=false;correctedId='';resultId='';localTask=null;placedLayer=null;correctedLayer=null;
    placementPending=false;correctionPending=false;restored=false;runner.invalidate();preview(blob,source.docName+' · '+source.selection.width+' × '+source.selection.height);status('选区已就绪');
    }finally{if(version===epoch){captureBusy=false;paint();}}
  }
  // ⭐ 整张画布（2026-09-29，大卡页面定的「算完整画布，不抓选区」）：
  //   source 的选区 = 整张文档。真正增强时运行时仍按服务器块大小逐块按原尺寸抓取、分片上传（不会整张大图一次走 base64）。
  async function captureCanvas(){
    if(captureBusy)return;captureBusy=true;paint();const version=epoch;
    try{status('正在读取 Photoshop 整张画布');
      const doc=await host.bridge('ps.doc.info',{});check(version);
      const W=Number(doc&&doc.width),H=Number(doc&&doc.height);
      if(!doc||!(W>0&&H>0))throw error('Photoshop 里没有打开的文档');
      const selection={left:0,top:0,right:W,bottom:H,width:W,height:H};
      const captured=await host.bridge('ps.regions.capture',{docId:doc.id,expected:{id:doc.id,name:doc.name,width:W,height:H},selection,maxEdge:256});check(version);
      const blob=await(await fetch('data:image/png;base64,'+captured.imageBase64)).blob();check(version);
      source={docId:captured.docId??doc.id,docName:captured.docName||doc.name,docWidth:captured.docWidth||W,docHeight:captured.docHeight||H,selection};
      if(originalId&&!originalOwned)IMG.release(originalId);if(correctedId)IMG.release(correctedId);originalId='';originalOwned=false;correctedId='';resultId='';localTask=null;placedLayer=null;correctedLayer=null;
      placementPending=false;correctionPending=false;restored=false;runner.invalidate();preview(blob,source.docName+' · 整张画布 '+W+' × '+H);status('整张画布已就绪 · '+W+' × '+H);
    }finally{if(version===epoch){captureBusy=false;paint();}}
  }
  async function transfer(){
    if(transferBusy||!resultId||!source)return;transferBusy=true;paint();const version=epoch;
    try{
      if(restored){if(!await confirm({title:'确认来源文档',body:'此结果来自本机历史：'+source.docName,detail:'请确认当前同名、同尺寸文档就是原始文档，确认后再传回。',confirm:'确认来源文档'}))return;check(version);restored=false;}
      const documents=await host.bridge('ps.doc.listOpen',{});check(version);
      const doc=documents.documents.find(item=>String(item.id)===String(source.docId));
      if(!doc||doc.name!==source.docName||Number(doc.width)!==source.docWidth||Number(doc.height)!==source.docHeight)throw error('来源文档已关闭、更名或改变尺寸，已阻止传回');
      if(!placedLayer){
        if(placementPending){if(!await confirm({title:'确认是否重新传回',body:'上次传回没有完整回执，Photoshop 中可能已经有增强图层。',detail:'请先检查来源文档。确认重新传回会再创建一个图层，不会重新生成或扣费。',confirm:'重新传回'}))return;check(version);}
        const imageBase64=await IMG.base64(resultId);check(version);
        placementPending=true;await persist(version);check(version);
        const placed=await host.bridge('ps.layer.place',{imageBase64,targetDocId:source.docId,targetSelection:source.selection,strictTarget:true,layerType:host.layerType()});check(version);
        if(!placed?.layerId)throw error('Photoshop 未返回图层编号，请检查后再操作，避免重复传回');placedLayer=placed.layerId;placementPending=false;
        if(localTask){const task=taskById(localTask.id);if(task){updateTask(task.id,{psLayerByShot:{...task.psLayerByShot,0:placedLayer},returnState:'done'});}}await persist(version);check(version);
      }
      if(parameters.colorMatch&&!correctedLayer){
        // ⚠ 2026-10-05：文案跟着算法改 —— 主链路只有【混合判据】了，
        //   再写"精准校色"就是铁律 16 那条假开关（说一套做一套）。
        status('正在本机校色（混合判据）');
        if(!originalId)throw error('本机校色原图已不可用，增强图层已经保留');
        if(!correctedId){
          const input=await pixels(new Blob([await IMG.fullBytes(originalId)],{type:'image/png'})),output=await pixels(new Blob([await IMG.fullBytes(resultId)],{type:'image/png'}));check(version);
          const matched=await MATCHENGINE.process(output,input,{align:false,color:true,detailBoost:false,method:'hybrid',tier:3,fromBlob:pixels});check(version);
          if(!matched?.img)throw error('本机校色未返回结果，增强图层已经保留');
          const canvas=document.createElement('canvas');canvas.width=matched.img.width;canvas.height=matched.img.height;canvas.getContext('2d').putImageData(new ImageData(matched.img.data,matched.img.width,matched.img.height),0,0);
          const id=await IMG.putFromCanvas(canvas,'image/png');try{check(version);}catch(failure){IMG.release(id);throw failure;}correctedId=id;
          if(matched.notes?.length)aiAddLog('[DLSS 校色] '+matched.notes.join('；'),'info');
        }
        const imageBase64=await IMG.base64(correctedId);check(version);
        if(correctionPending){if(!await confirm({title:'确认是否重新传回校色层',body:'上次校色层传回没有完整回执。',detail:'请先检查增强图层上方是否已有校色层。确认后会再创建一个图层。',confirm:'重新传回校色层'}))return;check(version);}
        correctionPending=true;await persist(version);check(version);
        const clipped=await host.bridge('ps.layer.placeClipped',{imageBase64,targetDocId:source.docId,targetLayerId:placedLayer,targetSelection:source.selection,layerType:host.layerType(),name:'DLSS 精准校色'});check(version);
        if(clipped?.layerId){correctedLayer=clipped.layerId;correctionPending=false;await persist(version);check(version);}
        if(!clipped?.layerId||!clipped.moved||!clipped.clipped)throw error('校色图层未能正确剪贴，请检查 Photoshop；已保留实际生成的图层，避免重复贴回');
      }
      status('已传回 Photoshop'+(correctedLayer?' · 精准校色层已剪贴':''));if(localTask)historyRecordTask(taskById(localTask.id)||localTask);
    }finally{transferBusy=false;paint();}
  }
  async function run(action){try{await action();}catch(reason){report(reason);}finally{paint();}}
  async function execute(resume){if(localTask)localTask._errorReported=false;await (resume?runner.resume():runner.start(source,{...parameters}));if(runner.state()?.stage==='已完成'&&autoReturn)await transfer();}
  function close(){if(runner?.busy()||captureBusy||transferBusy){status('传输仍在进行，可取消后关闭');return;}panel?.remove();backdrop?.remove();panel=null;backdrop=null;revoke();}
  function invalidate(){epoch++;runner?.invalidate();source=null;localTask=null;resultId='';if(originalId&&!originalOwned)IMG.release(originalId);if(correctedId)IMG.release(correctedId);originalId='';originalOwned=false;correctedId='';placedLayer=null;correctedLayer=null;transferBusy=false;captureBusy=false;placementPending=false;correctionPending=false;restored=false;panel?.remove();backdrop?.remove();panel=null;backdrop=null;revoke();lastPreview=null;lastStatus='原尺寸增强 · 1 通用积分';notify();}
  function openTask(task){
    if(task.storageNamespaceId!==cacheNamespaceId()){report(error('任务属于其他账号，无法读取'));return;}
    if(localTask===task){open();return;}
    if(runner?.busy()||captureBusy||transferBusy||runner?.state()&&runner.state().stage!=='已完成'&&!runner.state().cancelled){report(error('请先完成或取消当前 DLSS 任务'));return;}
    const info=task.toolParams;if(!info?.source||!task.outputs?.[0]?.imgId){report(error('此任务没有可恢复的本机结果；未完成的传输仅能在原登录会话中继续'));return;}
    invalidate();createRunner();localTask=task;source=info.source;resultId=task.outputs[0].imgId;originalId=task.sourceImgId||'';originalOwned=!!originalId;Object.assign(parameters,root.V7DLSSRuntime.defaults,info.parameters);placedLayer=task.psLayerByShot?.[0]||null;correctedLayer=info.correctedLayer||null;placementPending=!!info.placementPending;correctionPending=!!info.correctionPending;restored=!!task.restoredFromCache;
    // 任务卡上点 DLSS 任务：有大卡就开大卡（老弹窗已收掉），结果预览从本机缓存读
    const TW=root.V7ToolWorkbench;
    if(TW&&TW.has?.('dlss')&&TW.canOpen?.()){TW.open('dlss');IMG.fullBytes(resultId).then(bytes=>preview(new Blob([bytes],{type:'image/png'}),'本机增强结果')).catch(()=>{});}
    else open();
    status('本机增强结果');paint();
  }
  // ⭐ 给工具大卡用：不开弹窗的 DLSS 会话。按钮直接调本模块的抓取 / 开始 / 恢复 / 取消 / 传回，订阅拿实时快照。
  const PARAM_RANGE={intensity:[0,1],localTone:[0,1],localStruct:[0,1],skin:[0,2],smoothProtect:[0,1],style:[0,2]};
  function attach(){
    if(!runner)createRunner();
    return {
      snapshot,
      subscribe(fn){listeners.add(fn);try{fn(snapshot());}catch(_){}return()=>listeners.delete(fn);},
      setParam(key,value){const range=PARAM_RANGE[key];if(!range)return;const run=runner&&runner.state();if(captureBusy||runner?.busy()||resultId||run&&!run.cancelled)return;const v=Math.max(range[0],Math.min(range[1],Number(value)));if(Number.isFinite(v)){parameters[key]=key==='style'?Math.round(v):v;notify();}},
      setAutoReturn(value){autoReturn=!!value;notify();},
      capture:()=>run(captureCanvas),
      start:()=>run(()=>execute(false)),
      resume:()=>run(()=>execute(true)),
      cancel:()=>run(()=>runner.cancel()),
      transfer:()=>run(transfer)
    };
  }
  function open(){
    if(panel)return;if(!runner)createRunner();backdrop=document.createElement('div');backdrop.className='dlss-backdrop';backdrop.dataset.uiOverlay='true';panel=document.createElement('section');panel.className='dlss-tool';panel.dataset.uiOverlay='true';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','DLSS 画质增强');
    panel.innerHTML='<header class="dlss-head"><h2>DLSS 画质增强</h2><button class="dlss-close" data-close title="关闭" aria-label="关闭">'+(root.ICON?ICON.render('close',18):'&#215;')+'</button></header><div class="dlss-body"><figure class="dlss-preview"><img alt="DLSS 选区预览"><figcaption>尚未抓取选区</figcaption></figure><div class="dlss-fields"></div></div><footer><progress class="dlss-progress" max="100" value="0"></progress><div class="dlss-actions"><span class="dlss-status" data-status role="status">原尺寸增强 · 1 通用积分</span><button data-capture>抓取选区</button><button data-run>开始增强</button><button data-resume>恢复传输</button><button data-cancel>取消任务</button><button data-transfer>传回 Photoshop</button></div></footer>';
    const fields=panel.querySelector('.dlss-fields');
    for(const [key,title,maximum] of [['intensity','处理强度',1],['localTone','本地色调',1],['localStruct','本地结构',1],['skin','皮肤质感',2],['smoothProtect','平滑区保护',1]]){
      const label=document.createElement('label');label.className='dlss-field';label.innerHTML='<span>'+title+'</span><output>'+parameters[key].toFixed(2)+'</output><input data-param="'+key+'" type="range" min="0" max="'+maximum+'" step="0.01" value="'+parameters[key]+'" aria-label="'+title+'">';label.querySelector('input').oninput=event=>{parameters[key]=Number(event.target.value);label.querySelector('output').value=parameters[key].toFixed(2);};fields.append(label);
    }
    const style=document.createElement('label');style.className='dlss-field';style.innerHTML='<span>渲染风格</span><select data-param="style" aria-label="渲染风格"><option value="0">默认</option><option value="1">自然</option><option value="2">电影</option></select>';style.querySelector('select').value=parameters.style;style.querySelector('select').onchange=event=>parameters.style=Number(event.target.value);fields.append(style);
    for(const [key,title] of [['uiCorrection','文字/UI 矫正'],['colorMatch','精准校色图层']]){const label=document.createElement('label');label.className='dlss-field';label.innerHTML='<span>'+title+'</span><input data-param="'+key+'" type="checkbox" aria-label="'+title+'">';label.querySelector('input').checked=!!parameters[key];label.querySelector('input').onchange=event=>parameters[key]=key==='uiCorrection'?Number(event.target.checked):event.target.checked;fields.append(label);}
    const automatic=document.createElement('label');automatic.className='dlss-field';automatic.innerHTML='<span>完成后传回</span><input type="checkbox" aria-label="完成后传回">';automatic.querySelector('input').checked=autoReturn;automatic.querySelector('input').onchange=event=>autoReturn=event.target.checked;fields.append(automatic);
    panel.querySelector('[data-close]').onclick=close;panel.querySelector('[data-capture]').onclick=()=>run(capture);panel.querySelector('[data-run]').onclick=()=>run(()=>execute(false));panel.querySelector('[data-resume]').onclick=()=>run(()=>execute(true));panel.querySelector('[data-cancel]').onclick=()=>run(()=>runner.cancel());panel.querySelector('[data-transfer]').onclick=()=>run(transfer);
    document.body.append(backdrop,panel);const state=runner.state();if(state)status(state.stage);if(resultId)run(async()=>preview(new Blob([await IMG.fullBytes(resultId)],{type:'image/png'}),'增强结果'));paint();
  }
  root.V7DLSS={configure:value=>{host=value;autoReturn=host.autoReturn?host.autoReturn():true;if(unsubscribe)unsubscribe();const initial=root.V7Backend.state();sessionKey=initial.account?.id+':'+initial.deviceId+':'+initial.sessionVersion;unsubscribe=root.V7Backend.onChange(state=>{const key=state.account?.id+':'+state.deviceId+':'+state.sessionVersion;if(key!==sessionKey)invalidate();sessionKey=key;notify();});},open,openTask,attach,close,state:()=>runner&&runner.state()};
  root.addEventListener('wheelchair:storage-context',invalidate);
})(window);
