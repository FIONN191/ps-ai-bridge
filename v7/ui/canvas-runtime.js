(function(root){
  'use strict';
  const failure=(code,message)=>Object.assign(new Error(message),{code});
  const copy=value=>JSON.parse(JSON.stringify(value));
  function create({graph,store,host,onChange}){
    const running=new Map();let closed=false,sequence=0,walking=false;
    const kind=node=>String(node.type||'').replace('wheelchair/','');
    const textual=node=>['prompt','promptcat'].includes(kind(node));
    function parentOf(input){const link=graph.links[input.link];return link&&graph.getNodeById(link.origin_id);}
    function checkCycles(node,seen=new Set()){
      if(seen.has(node.id))throw failure('CANVAS_CYCLE','节点连接形成循环，请断开循环连接');
      seen.add(node.id);for(const input of node.inputs||[]){const parent=parentOf(input);if(parent)checkCycles(parent,new Set(seen));}
    }
    function changed(){if(onChange)onChange();graph.setDirtyCanvas(true,true);}
    function invalidate(node,seen=new Set()){
      if(!node||seen.has(node.id))return;seen.add(node.id);
      node.properties.revision=(Number(node.properties.revision)||0)+1;
      if(node.type!=='wheelchair/image'){node.properties.selectedAssetId='';node.properties.textResult='';node.properties.status='idle';node.properties.error='';}
      for(const output of node.outputs||[])for(const id of output.links||[]){const link=graph.links[id];if(link)invalidate(graph.getNodeById(link.target_id),seen);}
      changed();
    }
    function inputAssets(node,seen=new Set()){
      if(seen.has(node.id))throw failure('CANVAS_CYCLE','节点连接形成循环，请断开循环连接');seen.add(node.id);
      return (node.inputs||[]).filter(input=>input.type!=='prompt'&&!(input.optional&&input.link==null)).map(input=>{
        const link=graph.links[input.link];const parent=link&&graph.getNodeById(link.origin_id);
        if(!parent)throw failure('CANVAS_INPUT_REQUIRED','请先把图片节点连接到当前节点');
        if(parent.type==='wheelchair/image'){if(!parent.properties.assetId)throw failure('CANVAS_INPUT_REQUIRED','来源节点没有图片');return parent.properties.assetId;}
        checkCycles(parent,new Set(seen));
        if(!parent.properties.selectedAssetId)throw failure('CANVAS_SELECTION_REQUIRED','请先在上一步结果中手动选择一张图片');
        return parent.properties.selectedAssetId;
      });
    }
    function promptValue(node,seen=new Set()){
      if(seen.has(node.id))throw failure('CANVAS_CYCLE','节点连接形成循环，请断开循环连接');seen.add(node.id);
      if(kind(node)==='prompt')return String(node.properties.text||'');
      if(kind(node)!=='promptcat')throw failure('CANVAS_GRAPH_INVALID','提示词接口只能连接提示词节点');
      const parts=(node.inputs||[]).filter(input=>input.link!=null).map(input=>{const parent=parentOf(input);if(!parent)throw failure('CANVAS_INPUT_REQUIRED','拼词节点的来源已不存在');return promptValue(parent,new Set(seen)).trim();}).filter(Boolean);
      return parts.join(node.properties.sep??', ');
    }
    async function transform(id,properties,type){
      const asset=await store.asset(id),bitmap=await createImageBitmap(asset.full);
      try{
        let width=bitmap.width,height=bitmap.height,sx=0,sy=0,sw=width,sh=height,dx=0,dy=0,dw=width,dh=height;
        if(type==='crop'){
          const r=properties.rect||{x:0,y:0,w:1,h:1};
          if(!['x','y','w','h'].every(key=>Number.isFinite(Number(r[key])))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x>=1||r.y>=1)throw failure('CANVAS_GRAPH_INVALID','裁剪范围无效，请使用 0 至 100% 的比例');
          sx=Math.min(width-1,Math.round(Number(r.x)*width));sy=Math.min(height-1,Math.round(Number(r.y)*height));sw=Math.max(1,Math.min(width-sx,Math.round(Number(r.w)*width)));sh=Math.max(1,Math.min(height-sy,Math.round(Number(r.h)*height)));width=dw=sw;height=dh=sh;
        }else if(type==='resize'){
          const edge=Number(properties.longEdge||1024);if(!Number.isSafeInteger(edge)||edge<1||edge>8192)throw failure('CANVAS_IMAGE_INVALID','缩放长边须为 1 至 8192 像素');
          const scale=edge/Math.max(width,height);width=dw=Math.max(1,Math.round(width*scale));height=dh=Math.max(1,Math.round(height*scale));
        }else{
          const ratio=String(properties.padRatio||'1:1').split(':').map(Number);if(ratio.length!==2||!ratio.every(n=>Number.isFinite(n)&&n>0))throw failure('CANVAS_GRAPH_INVALID','扩边比例无效，例如 16:9');
          const aspect=ratio[0]/ratio[1];if(width/height<aspect)width=Math.ceil(height*aspect);else height=Math.ceil(width/aspect);
          dx=Math.round((width-dw)/2);dy=Math.round((height-dh)/2);
        }
        if(width>8192||height>8192||width*height>33554432)throw failure('CANVAS_IMAGE_INVALID','处理后的图片过大，请先缩放或调整比例（最长边 8192，最多 3200 万像素）');
        const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';
        if(type==='pad'&&['white','black'].includes(properties.padColor)){ctx.fillStyle=properties.padColor;ctx.fillRect(0,0,width,height);}
        ctx.drawImage(bitmap,sx,sy,sw,sh,dx,dy,dw,dh);
        return [await store.importBlob(await canvas.convertToBlob({type:'image/png'}),{kind:type,name:properties.title||type})];
      }finally{bitmap.close();}
    }
    async function composite(ids,properties){
      const assets=await Promise.all(ids.map(id=>store.asset(id))),bitmaps=await Promise.all(assets.map(asset=>createImageBitmap(asset.full)));
      try{
        const [a,b]=bitmaps,mode=properties.layout||'horizontal';let width,height;
        if(mode==='horizontal'){height=Math.max(...bitmaps.map(x=>x.height));width=Math.round(bitmaps.reduce((sum,x)=>sum+x.width*height/x.height,0));}
        else if(mode==='vertical'){width=Math.max(...bitmaps.map(x=>x.width));height=Math.round(bitmaps.reduce((sum,x)=>sum+x.height*width/x.width,0));}
        else if(mode==='grid'){width=1024;height=Math.ceil(bitmaps.length/2)*512;}
        else{width=a.width;height=a.height;}
        const scale=Math.min(1,8192/Math.max(width,height));width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));
        const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
        if(mode==='horizontal'){let x=0;for(const bitmap of bitmaps){const w=bitmap.width*height/bitmap.height;ctx.drawImage(bitmap,x,0,w,height);x+=w;}}
        else if(mode==='vertical'){let y=0;for(const bitmap of bitmaps){const h=bitmap.height*width/bitmap.width;ctx.drawImage(bitmap,0,y,width,h);y+=h;}}
        else if(mode==='grid'){const cell=width/2;bitmaps.forEach((bitmap,i)=>{const ratio=Math.min(cell/bitmap.width,cell/bitmap.height),w=bitmap.width*ratio,h=bitmap.height*ratio;ctx.drawImage(bitmap,(i%2)*cell+(cell-w)/2,Math.floor(i/2)*cell+(cell-h)/2,w,h);});}
        else{ctx.drawImage(a,0,0,width,height);ctx.globalAlpha=Math.max(0,Math.min(1,Number(properties.opacity??0.5)));for(const bitmap of bitmaps.slice(1)){const ratio=Math.min(width/bitmap.width,height/bitmap.height);ctx.drawImage(bitmap,(width-bitmap.width*ratio)/2,(height-bitmap.height*ratio)/2,bitmap.width*ratio,bitmap.height*ratio);}}
        return [await store.importBlob(await canvas.convertToBlob({type:'image/png'}),{kind:'compose',name:properties.title||'拼接'})];
      }finally{bitmaps.forEach(bitmap=>bitmap.close());}
    }
    async function run(node){
      if(closed)throw failure('CANVAS_CLOSED','幕布已关闭');
      if(!node||node.type==='wheelchair/image')throw failure('CANVAS_NODE_REQUIRED','请选择生成、拼接或输出节点');
      if(running.has(node.id))throw failure('CANVAS_BUSY','当前节点正在运行');
      checkCycles(node);
      const ids=inputAssets(node),properties=copy(node.properties),revision=Number(properties.revision)||0,token=store.uid('canvas-run');
      running.set(node.id,{token});node.properties.status='running';node.properties.error='';node.properties.selectedAssetId='';
      // Preserve the graph-owned array identity. Besides reducing reactive UI
      // churn, this keeps host/test graph objects from receiving a foreign VM
      // array when a stale result is discarded.
      if (Array.isArray(node.properties.resultAssetIds)) node.properties.resultAssetIds.length=0;
      else node.properties.resultAssetIds=[];
      changed();
      try{
        let assets=[],textResult;
        if(textual(node))textResult=promptValue(node);
        else if(['pscapture','psregion'].includes(kind(node)))assets=[await host.captureNode(properties,kind(node))];
        else if(['crop','pad','resize'].includes(kind(node)))assets=await transform(ids[0],properties,kind(node));
        else if(node.type==='wheelchair/compose')assets=await composite(ids,properties);
        else if(node.type==='wheelchair/output'){
          assets=[await store.asset(ids[0])];
          if(properties.destination==='photoshop')await host.transfer(assets[0]);
          else if(properties.destination==='file')await host.saveImage(assets[0],node.title);
        }
        else{
          if(!properties.presetId)throw failure('CANVAS_PRESET_REQUIRED','请为生成节点选择预设');
          const promptInput=(node.inputs||[]).find(input=>input.type==='prompt'&&input.link!=null),prompt=promptInput?promptValue(parentOf(promptInput)):properties.prompt;
          const request=await host.generate({nodeId:node.id,runId:token,presetId:properties.presetId,prompt,parameters:properties.parameters||{},batch:properties.batch||1,model:properties.model||'',channel:properties.channel||'',inputAsset:ids.length?await store.asset(ids[0]):null,referenceAssets:await Promise.all(ids.slice(1).map(id=>store.asset(id))),setTaskId:id=>{const active=running.get(node.id);if(active&&active.token===token)active.taskId=id;}});
          if(!request||!request.images||!request.images.length)throw failure('CANVAS_NO_RESULT','本次没有可用结果，请查看任务错误');
          assets=[];for(const item of request.images)assets.push(await store.importImageId(item.imgId,{kind:'generation',name:properties.presetId},item.mime||'image/png'));
          properties.executionParameters=request.parameters||properties.parameters;
        }
        if(closed||running.get(node.id)?.token!==token||!graph.getNodeById(node.id)||Number(node.properties.revision||0)!==revision){
          // The graph changed while the provider was running. Clear the
          // transient running marker, but never write the late output.
          if(graph.getNodeById(node.id) && node.properties.status==='running') node.properties.status='idle';
          return {discarded:true};
        }
        const resultIds=assets.map(asset=>asset.id);
        if(Array.isArray(node.properties.resultAssetIds)){node.properties.resultAssetIds.length=0;resultIds.forEach(id=>node.properties.resultAssetIds.push(id));}
        else node.properties.resultAssetIds=resultIds;
        node.properties.status=node.type==='wheelchair/generate'?'select':'done';
        if(node.type!=='wheelchair/generate')node.properties.selectedAssetId=assets[0]?.id||'';
        if(textResult!==undefined)node.properties.textResult=textResult;
        node.properties.executionParameters=properties.executionParameters||{};
        node.properties.lastRun={id:token,inputAssetIds:ids,finishedAt:Date.now()};changed();return {assets,status:node.properties.status};
      }catch(error){
        if(!closed&&running.get(node.id)?.token===token&&graph.getNodeById(node.id)&&Number(node.properties.revision||0)===revision){node.properties.status='failed';node.properties.error=String(error.message||error);changed();}
        throw error;
      }finally{if(running.get(node.id)?.token===token)running.delete(node.id);if(!closed)changed();}
    }
    async function walk(targets,force){
      if(walking||running.size)throw failure('CANVAS_BUSY','幕布正在执行，请先等待或停止');
      for(const node of targets)checkCycles(node);
      const epoch=sequence,visited=new Set();walking=true;
      async function visit(node){
        if(closed||epoch!==sequence)throw failure('CANVAS_CLOSED','本次幕布执行已停止');
        if(visited.has(node.id))return;visited.add(node.id);
        for(const input of node.inputs||[]){const parent=parentOf(input);if(parent)await visit(parent);}
        if(node.type==='wheelchair/image'){if(!node.properties.assetId)throw failure('CANVAS_INPUT_REQUIRED','来源节点没有图片');return;}
        if(node.properties.status==='select'&&!node.properties.selectedAssetId)throw Object.assign(failure('CANVAS_SELECTION_REQUIRED','请在「'+node.title+'」选择一张结果，再继续运行'),{nodeId:node.id});
        if(node.properties.status!=='done'||force===node.id){const result=await run(node);if(result?.discarded)throw failure('CANVAS_CLOSED','节点已修改，本次执行已停止');}
        if(node.properties.status==='select')throw Object.assign(failure('CANVAS_SELECTION_REQUIRED','请在「'+node.title+'」选择一张结果，再继续运行'),{nodeId:node.id});
      }
      try{for(const node of targets)await visit(node);return {complete:true,count:visited.size};}
      catch(error){if(error.code==='CANVAS_SELECTION_REQUIRED')return {awaitingSelection:true,nodeId:error.nodeId};throw error;}
      finally{walking=false;changed();}
    }
    function select(node,id){
      if(!(node.properties.resultAssetIds||[]).includes(id))throw failure('CANVAS_SELECTION_REQUIRED','请选择当前节点返回的结果');
      invalidate(node);node.properties.selectedAssetId=id;node.properties.status='done';changed();
    }
    async function cancel(node){const active=running.get(node.id);if(!active)return;running.delete(node.id);if(active.taskId&&host.cancel)await host.cancel(active.taskId);node.properties.status='interrupted';node.properties.error='已停止等待';changed();}
    async function stop(){sequence++;await Promise.allSettled(Array.from(running.keys()).map(id=>{const node=graph.getNodeById(id);return node?cancel(node):null;}));}
    async function close(){closed=true;await stop();}
    return {run,runTo:node=>walk([node],node.id),runAll:()=>walk(graph._nodes||Array.from(graph._nodes_by_id?Object.values(graph._nodes_by_id):[])),select,invalidate,cancel,stop,close,inputAssets,promptValue,isRunning:node=>running.has(node.id),isBusy:()=>walking||running.size>0};
  }
  root.V7CanvasRuntime={create};
  // Keep the browser global and the VM/test global aligned. In a real window
  // these are the same object; isolated contract tests provide a separate
  // `window` object and still need to exercise the exported runtime.
  if (typeof globalThis !== 'undefined' && globalThis !== root) globalThis.V7CanvasRuntime = root.V7CanvasRuntime;
})(window);
