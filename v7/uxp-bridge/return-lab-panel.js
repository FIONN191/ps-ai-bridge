(function(){
  'use strict';
  const get=id=>document.getElementById('return-probe-'+id);
  let target=null,report=null,busy=false;
  function refresh(){
    get('bind').disabled=busy;get('run').disabled=busy||!target;get('read').disabled=busy||!target;get('save').disabled=busy||!report;
    ['strategy','image','target','layer'].forEach(id=>{get(id).disabled=busy;});
    get('doc').textContent=target?target.name+' · 文档 '+target.docId:'未绑定文档';
    get('report').value=report?JSON.stringify(report,null,2):'';
  }
  function selected(id,values){const index=get(id).selectedIndex;return values[index>=0?index:0];}
  async function execute(kind){
    if(busy)return;busy=true;refresh();get('status').textContent='正在执行，请勿重复回图…';
    try{
      const params=kind==='bind'?{}:{docId:target.docId};
      if(kind==='run')Object.assign(params,{
        strategy:selected('strategy',['legacy','restore','anchor']),
        imageKind:selected('image',['transparent-frame','corner-marks','opaque-reference']),
        target:selected('target',['canvas','selection']),layerType:selected('layer',['smartObject','pixel'])
      });
      const result=await window.V7ReturnProbeInvoke(kind==='run'?'ps.returnProbe.run':'ps.returnProbe.snapshot',params);
      if(kind==='bind'){target={docId:result.docId,name:result.document?.name||'Photoshop 文档'};report=result;}
      else if(kind==='read'&&report?.before)report={...report,manualAfter:result};
      else report=result;
      if(kind==='run'){
        const changes=result.changes;
        const count=changes?['removed','visibilityChanged','effectiveVisibilityChanged','parentChanged','ancestorChanged'].reduce((n,key)=>n+(changes[key]?.length||0),0):null;
        get('status').textContent=(result.ok?'实验动作完成':'实验未完成：'+(result.error?.message||'查看报告'))+'；原有图层变化 '+(count===null?'无法确认':count)+' 项。'+
          (result.targetDrift?'调用等待期间目标区域发生变化。':'')+
          (result.baselineSource==='modal-entry'?'已在 modal 入口建立基线。':'未取得 modal 入口基线，阶段归因需人工谨慎解释。')+
          (result.firstChangedStage?'首次变化：'+result.firstChangedStage+'。':'')+
          '请核对图层眼睛和透明中心，状态未变仍需人工确认视觉。'+
          (result.receipt?.historyGrouped?'在 PS 历史面板撤销“V7 回图对照实验”后再换方案。':'在 PS 历史面板核对实验步骤并撤销后再换方案。');
      }else get('status').textContent='图层状态已读取。'+(kind==='bind'?'后续回图固定到此文档。':'结果保留在报告的 manualAfter 中。');
    }catch(error){const issue={code:error.code,message:String(error.message||error),receipt:error.returnReceipt||null};if(kind==='read'&&report?.before)report={...report,manualAfterError:issue};else report={ok:false,error:issue,receipt:error.returnReceipt||null};get('status').textContent='操作未完成：'+issue.message+'。已有实验报告已保留；图片可能已经置入，请先检查 PSD，勿直接重复回图。';}
    finally{busy=false;refresh();}
  }
  for(const kind of ['bind','run','read'])get(kind).addEventListener('click',()=>execute(kind));
  get('save').addEventListener('click',async()=>{
    if(busy||!report)return;
    busy=true;refresh();
    try{
      const fs=require('uxp').storage.localFileSystem;
      const file=await fs.getFileForSaving('V7-return-probe-'+Date.now()+'.json',{types:['json']});
      if(file){await file.write(JSON.stringify(report,null,2));get('status').textContent='报告已导出。请同时记录透明中心是否显示原图、眼睛状态和 PS 版本。';}
    }catch(error){get('status').textContent='报告导出失败：'+String(error.message||error);}
    finally{busy=false;refresh();}
  });
  refresh();
})();
