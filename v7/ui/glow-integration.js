(function(root){
  'use strict';
  function assertNativeCapture(width,height,selection){
    if(!selection||Math.abs(Number(width)-Math.round(selection.width))>1||Math.abs(Number(height)-Math.round(selection.height))>1)
      throw new Error('Photoshop 桥返回了缩小后的图片，已停止辉光以避免降低画质。请将选区缩小到 2000 万像素以内后重试。');
  }
  function createRunner(host){
    let busy=false;
    return async function run(preset,params){
      if(busy){host.busy();return false;}
      busy=true;const namespace=host.namespace();let task=null;
      const current=()=>host.namespace()===namespace;
      const assertCurrent=()=>{if(!current())throw new Error('账号已切换，已停止原账号的辉光操作');};
      try{
        task=host.begin(preset,params);const captured=await host.capture(task);assertCurrent();
        const result=await host.edit(captured,params,async loaded=>{assertCurrent();await host.source(task,captured,loaded);});
        assertCurrent();
        if(!result||!host.exists(task)){host.cancel(task);return true;}
        await host.savePreset(preset,result.params);assertCurrent();
        await host.complete(task,captured,result);assertCurrent();
        if(host.autoReturn())await host.transfer(task);
        return true;
      }catch(error){if(task&&current())host.fail(task,error);return false;}
      finally{busy=false;}
    };
  }
  if(typeof module==='object'&&module.exports){module.exports={createRunner,assertNativeCapture};return;}
  root.GLOW_INTEGRATION={createRunner,assertNativeCapture};
  root.startGlow=createRunner({
    namespace:()=>cacheNamespaceId(),
    busy:()=>ERR.report('GLOW_BUSY'),
    begin:(preset,params)=>{
      const task=makeToolTask('glow',{taskId:aiNewTaskId('glow'),label:preset&&preset.title||'辉光'},1);
      Object.assign(task,{storageNamespaceId:cacheNamespaceId(),antiMode:0,toolParams:GLOW_CORE.params(params),provider:'本地工具',model:'辉光',batch:1});
      addTask(task);updateGenerationTask(task.id,{status:'running',sub:'准备抓取辉光区域',pct:5});return task;
    },
    capture:async task=>{
      const captured=await toolCaptureSelection(task.id,{res:0},{}),cap=captured.cap;
      const selection=mattingClampSelection(cap.selection,cap.docWidth,cap.docHeight)||cap.selection;
      if(cap.docId==null||!selection)throw new Error('没有完整的 Photoshop 来源信息，请重新建立选区后抓取');
      assertNativeCapture(captured.capW,captured.capH,selection);
      const blob=await fetch(String(captured.b64).startsWith('data:')?captured.b64:'data:'+(cap.mime||'image/png')+';base64,'+captured.b64).then(r=>r.blob());
      if(task.storageNamespaceId!==cacheNamespaceId())throw new Error('账号已切换，已停止原账号的辉光操作');
      const snapshot=aiCaptureSnapshot({docId:cap.docId,docName:cap.docName,selection,
        width:captured.capW,height:captured.capH,mime:cap.mime,hasSelection:cap.hasSelection,capturedAt:Date.now()},0);
      updateTask(task.id,{sourceDocId:cap.docId,sourceDocName:cap.docName||'',sourceSelection:selection,captureSnapshot:snapshot,mattingSize:captured.capW+'×'+captured.capH});
      updateGenerationTask(task.id,{sub:'调整辉光预览，完成后计算',pct:25});
      return {blob,width:captured.capW,height:captured.capH};
    },
    edit:(captured,params,onLoaded)=>GLOW_TOOL.open({blob:captured.blob,params,onLoaded,onError:error=>ERR.report('GLOW_PREVIEW_FAILED',{message:error.message,stage:'glow'})}),
    source:async(task,captured,loaded)=>{
      const imgId=IMG.putEncoded(captured.blob,loaded.thumb,captured.width,captured.height);
      if(!taskById(task.id)){IMG.release(imgId);return;}
      updateTask(task.id,{sourceImgId:imgId,sourceImg:IMG.thumb(imgId)});
    },
    exists:task=>!!taskById(task.id),
    savePreset:async(preset,params)=>{
      const live=preset&&PRESETS.presetById(preset.id);
      if(live&&live.kind==='glow'){
        await PRESETS.savePreset({...live,content:JSON.stringify(params)});
        if(root.PRESETUI&&root.PRESETUI.refreshToolParams)root.PRESETUI.refreshToolParams(live.id);
      }
    },
    complete:async(task,captured,result)=>{
      if(result.width!==captured.width||result.height!==captured.height)throw new Error('辉光结果尺寸和抓取区域不一致，已阻止传回');
      const imgId=IMG.putEncoded(result.blob,result.thumb,result.width,result.height);
      const output={index:0,imgId,restoreState:'done'};
      updateGenerationTask(task.id,{status:'done',pct:100,toolParams:result.params,
        shots:[{done:true,imgId,restoreState:'done'}],outputs:[output],
        sub:result.width+'×'+result.height+' · 辉光完成'+(settingsRuntime.autoReturn?' · 准备传回':' · 可手动传回')});
      aiAddLog('[辉光] 原尺寸计算完成 · '+result.width+'×'+result.height,'success');
    },
    autoReturn:()=>settingsRuntime.autoReturn===true,
    transfer:task=>aiTransfer(taskById(task.id)||task),
    cancel:task=>{if(taskById(task.id))updateGenerationTask(task.id,{status:'cancelled',sub:'已取消辉光预览',shots:[]});},
    fail:(task,error)=>updateGenerationTask(task.id,{status:'failed',stage:'glow',errorCode:'GLOW_RUN_FAILED',error:String(error&&error.message||error)})
  });
})(typeof window!=='undefined'?window:globalThis);
