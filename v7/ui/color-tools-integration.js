(function(root){
  'use strict';
  const C=root.V7ColorCore,M=root.V7CreativeMedia;
  async function bridge(action,params){const result=await linkOnce(action,params);if(!result?.ok)throw Object.assign(new Error(result?.error||linkResultMessage(result)),{code:result?.code||'COLOR_TOOL_FAILED'});return result.data;}
  root.V7ColorTools.configure({
    defaults:()=>({autoReturn:settingsRuntime.autoReturn===true}),
    confirm:(title,body)=>new Promise(resolve=>UI.dialog({title,body,confirm:'确认',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})),
    async capture({allowFullCanvas}){const cap=await bridge('ps.selection.capture',{allowFullCanvas,maxResolution:999999}),target=C.target({...aiCaptureSnapshot(cap,0),docWidth:cap.docWidth,docHeight:cap.docHeight});return {target,blob:await(await fetch('data:'+(cap.mime||'image/png')+';base64,'+(cap.imageBase64||cap.inputImageBase64))).blob()};},
    async generate({job,input,reference,check,setTaskId,outside}){
      check();if(root.V7FirstRun&&!root.V7FirstRun.isComplete()){const accepted=await outside(()=>root.V7FirstRun.require());check();if(!accepted)throw C.fail('需要先同意使用条款');}
      const imageBase64=await M.base64(input.full);check();const refImages=reference?[{imageBase64:await M.base64(reference.full),mime:reference.mime,label:'调色参考 A'}]:[];check();const taskId=aiNewTaskId('colorgrade');await setTaskId(taskId);check();
      const snapshot=Object.assign({},aiRuntime,aiWorkflowSnapshot(),{taskId,colorToolRunId:job.id,presetTitle:'AI 调色',prompt:C.gradePrompt(job.prompt),batch:1,aspectRatio:'1:1',antiMode:0,autoReturn:false,refImages,preserveGeneratedAppearance:true,capture:null,captureSnapshot:{...job.b.target,width:input.width,height:input.height,mime:input.mime,imageBase64,inputImageBase64:imageBase64,sourceImageBase64:imageBase64}});
      const result=await aiGenerateNow(snapshot,{autoReturn:false,confirm:estimate=>outside(()=>new Promise(resolve=>UI.dialog({title:'确认 AI 调色',body:'使用当前生成模型 · 1 张 · '+estimate.points+' 积分',detail:'提交即扣本次费用，失败不自动退款；结果以工作面指定的混合模式传回。',confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)})))});check();const task=taskById(taskId);if(task)historyRecordTask(task);if(!task?.outputs?.length)throw C.fail(result?.error||'没有返回调色图像');const outputs=[];for(const image of task.outputs){outputs.push({full:new Blob([await IMG.fullBytes(image.imgId)],{type:image.mime||'image/png'})});check();}return outputs;
    },
    cancel:taskId=>taskId?aiCancel(taskId):Promise.resolve(),
    async validateTarget(target){const result=await bridge('ps.doc.listOpen',{}),doc=(result.documents||[]).find(d=>Number(d.id)===target.docId);if(!doc||target.docName&&doc.name!==target.docName||target.docWidth&&Number(doc.width)!==target.docWidth||target.docHeight&&Number(doc.height)!==target.docHeight)throw C.fail('原 Photoshop 文档已关闭、更名或改变尺寸，请核对原文档后再传回');},
    async place(asset,target,check){const imageBase64=await M.base64(asset.full);check();return bridge('ps.layer.place',{imageBase64,targetDocId:target.docId,targetSelection:structuredClone(target.selection),strictTarget:true,antiMode:0,layerType:settingsRuntime.layerType||'smartObject'});},
    properties:(receipt,changes)=>bridge('ps.layer.properties',{...receipt,...changes}),
    transferred(taskId,receipt,index){const task=taskId&&taskById(taskId);if(!task)return;task.psLayerByShot=task.psLayerByShot||{};task.psLayerByShot[index]=receipt.layerId;task.psLayerIds=[...new Set([...(task.psLayerIds||[]),receipt.layerId])];task.psDocId=receipt.docId;task.returnState='done';updateTask(task.id,{psLayerByShot:task.psLayerByShot,psLayerIds:task.psLayerIds,psDocId:task.psDocId,returnState:task.returnState});cacheSaveTask(task).catch(error=>ERR.report('COLOR_TOOL_FAILED',{message:String(error.message||error)}));}
  });
})(window);
