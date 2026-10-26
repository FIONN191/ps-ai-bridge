(function(root){
  'use strict';const M=root.V7CreativeMedia,C=root.V7BatchCore,secrets=new Map();
  root.addEventListener('wheelchair:storage-context',()=>secrets.clear());
  root.V7BatchQueue.configure({
    queue:()=>aiRuntime.queue,setQueue:value=>{aiRuntime.queue=value;},refresh:()=>aiRefreshInPlace(),
    presets:()=>PRESETS.presets().filter(p=>!p.hidden&&(!PRESETS.visible||PRESETS.visible(p))&&(!p.kind||p.kind==='prompt'||p.workflow||p.forgeWorkflow)).map(p=>({id:p.id,title:p.title})),
    async freeze(presetId){aiReadFields(document);let preset=presetId?PRESETS.presetById(presetId):null;if(presetId&&!preset)throw C.fail('所选预设已不存在');const config={...aiRuntime,...aiWorkflowSnapshot(),presetTitle:presetTitleNow(),autoReturn:!!aiRuntime.autoReturn,layerType:settingsRuntime.layerType};const capturedSecrets={apiKey:config.apiKey||'',comfyKey:config.comfyKey||'',runninghubKey:config.runninghubKey||''};let refs;
      if(preset){Object.assign(config,{presetId:preset.id,presetTitle:preset.title,prompt:preset.content||'',workflowPreset:preset.workflow||preset.forgeWorkflow?aiClonePlain(preset):null,preActionPreset:aiClonePlain(preset),workflowPresetId:preset.id,workflowParameters:aiClonePlain(preset.parameters||{}),fieldHistorySnapshot:null});refs=await PRESETS.resolveReferenceImages(preset);}
      else refs=root.V7PresetReferences?await V7PresetReferences.capture():[];
      return {config:C.configuration(config),references:refs,secrets:capturedSecrets};
    },
    remember:(id,value)=>secrets.set(id,value),forget:id=>secrets.delete(id),
    async capture(config,guard){guard();if(config.preActionPreset&&root.V7PresetPreActions){await V7PresetPreActions.beforeGenerate(config.preActionPreset,null);guard();}return new Promise((resolve,reject)=>aiCapture(data=>{try{guard();resolve({...aiCaptureSnapshot(data,config.antiMode),docWidth:data.docWidth,docHeight:data.docHeight});}catch(error){reject(error);}},config.antiMode,result=>reject(C.fail(linkResultMessage(result))),{allowFullCanvas:!!config.autoFullCanvas}));},
    async credentials(item){let value=secrets.get(item.id);if(!value){const c=item.config,current={...aiRuntime,...aiWorkflowSnapshot()};for(const field of ['baseUrl','endpoint','comfyUrl','runninghubUrl'])if(String(c[field]||'')!==String(current[field]||''))throw C.fail('此条目的服务地址与当前连接不同，请先恢复对应连接或更新条目配置');value={apiKey:current.apiKey||'',comfyKey:current.comfyKey||'',runninghubKey:current.runninghubKey||''};}return value;},
    taskId:()=>aiNewTaskId('batch'),registerSecret:(id,value)=>aiSessionSecrets.set(id,value.apiKey||''),
    run:options=>aiRunQueue(options),cancel:id=>aiCancel(id),
    confirm:(title,body,detail)=>new Promise(resolve=>UI.dialog({title,body,detail,confirm:'确认',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
    requireTerms:()=>!root.V7FirstRun||V7FirstRun.isComplete()?Promise.resolve(true):V7FirstRun.require(),
    openTask:id=>{const task=taskById(id);if(!task)throw C.fail('此任务未在当前任务栏恢复，请到结果历史中查找');const at=taskList.indexOf(task);if(at>=0){tcur=at;setTasks();}},
    base64:M.base64
  });
})(window);
