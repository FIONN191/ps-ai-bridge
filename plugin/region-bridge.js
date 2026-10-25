// Photoshop 25+ DOM + Imaging API: selection.save/load and single-component mask data.
// https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging
// https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/selection
module.exports = function createRegionBridge({app,core,action,constants,imaging,formats,HELPER,HEADERS,post,tempFile,uploadBytes,pasteHistory}) {
  const session=`ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let serial=0;
  const seen=new Set(),epochs=new Map(),pendingChannels=new Map();
  const unique=prefix=>`${prefix} ${Date.now().toString(36)}-${++serial}`;
  function closed(id){if(seen.delete(id))epochs.set(id,(epochs.get(id)||0)+1);}
  function observe(){const live=new Set([...app.documents].map(d=>d.id));for(const id of seen)if(!live.has(id))closed(id);for(const id of live)seen.add(id);}
  const documentSession=id=>epochs.has(id)?`${session}-${id}-${epochs.get(id)}`:session;
  // A close/reopen may reuse a numeric ID. Invalidate its prior generation, even if
  // both events happen between UI refreshes. No Photoshop writes in the listener.
  const onClose=(_event,descriptor)=>{
    const id=descriptor?.documentID??descriptor?._target?.find(t=>t._ref==='document')?._id;
    if(Number.isInteger(id))closed(id);else observe();
  };
  observe();
  const listenerReady=action.addNotificationListener?Promise.resolve(action.addNotificationListener(['close'],onClose)):Promise.resolve();
  // Attach a rejection handler immediately; execute still reports registration failure.
  listenerReady.catch(()=>{});
  const bp=async d=>{const result=await action.batchPlay(Array.isArray(d)?d:[d],{});const error=result.find(r=>r?._obj==='error');if(error)throw new Error(error.message||`Photoshop 操作失败 (${error.result})`);return result;};
  const target=doc=>({session:documentSession(doc.id),docId:doc.id,name:doc.title,width:Math.round(doc.width),height:Math.round(doc.height)});
  function bound(t){observe();const d=t&&app.documents.find(d=>d.id===t.docId);if(!d||t.session!==documentSession(d.id))throw new Error('原文档会话已结束，请在区域列表重新绑定文档');if(d.width!==t.width||d.height!==t.height)throw new Error('文档画布尺寸已改变，请重新捕获区域');return d;}
  function rectOf(r,d){r=r||{left:0,top:0,right:d.width,bottom:d.height};if(!['left','top','right','bottom'].every(k=>Number.isSafeInteger(r[k]))||r.left<0||r.top<0||r.right>d.width||r.bottom>d.height||r.right<=r.left||r.bottom<=r.top||(r.right-r.left)*(r.bottom-r.top)>40000000)throw new Error('捕获区域超出文档或超过 4000 万像素');return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};}
  function intersection(a,b){const r={left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)};if(r.right<=r.left||r.bottom<=r.top)throw new Error('选区与捕获区域没有交集');return r;}
  async function json(response){const r=await response.json();if(!response.ok)throw new Error(r.error||'本地服务失败');return r;}
  async function keepSelection(d,fn){
    const previousChannels=d.activeChannels?[...d.activeChannels]:null;let backup,result,error;
    if(d.selection.bounds){const name=unique('__AI区域恢复');await d.selection.save(name);backup=d.channels.find(c=>c.name===name);if(!backup)throw new Error('无法备份当前选区，未修改选区');}
    try{result=await fn();}catch(e){error=e;}
    try{if(backup)await d.selection.load(backup);else await d.selection.deselect();if(backup)await backup.remove();}
    catch(e){error=new Error(`${error?`${error.message}；`:''}恢复原选区失败：${e.message}；请保留恢复通道`);}
    try{if(previousChannels)d.activeChannels=previousChannels;}catch(e){error=error||e;}
    if(error)throw error;return result;
  }
  async function capture(cmd){
    bound(cmd.target);let captured;
    await core.executeAsModal(async ctl=>{
      const d=bound(cmd.target),original=app.activeDocument;app.activeDocument=d;
      let tmp,file,selection,error;
      try{
        const raw=cmd.useSelection!==false?d.selection.bounds:null;
        const sr=raw?{left:Math.floor(raw.left),top:Math.floor(raw.top),right:Math.ceil(raw.right),bottom:Math.ceil(raw.bottom)}:null;
        const canvas={left:0,top:0,right:d.width,bottom:d.height};
        const rect=rectOf(cmd.rect||(sr?intersection(sr,canvas):canvas),d);
        captured={target:target(d),rect,title:cmd.title||d.title};
        if(sr){
          const requested=intersection(sr,rect);selection=await imaging.getSelection({documentID:d.id,sourceBounds:requested});
          const image=selection.imageData;if(!image)throw new Error('Photoshop 未返回选区像素，未丢弃蒙版继续捕获');
          const b=selection.sourceBounds;if(!b)throw new Error('Photoshop 未返回选区坐标');
          const bounds=rectOf({left:b.left,top:b.top,right:b.right??b.left+image.width,bottom:b.bottom??b.top+image.height},d);
          if(bounds.left<requested.left||bounds.top<requested.top||bounds.right>requested.right||bounds.bottom>requested.bottom||bounds.right-bounds.left!==image.width||bounds.bottom-bounds.top!==image.height||image.components!==1)throw new Error('Photoshop 选区像素与坐标不一致');
          const pixels=await image.getData({chunky:true,fullRange:false});
          if(pixels.length!==image.width*image.height||![8,16,32].includes(image.componentSize))throw new Error('Photoshop 选区像素格式无效');
          const scale=image.componentSize===16?255/32768:image.componentSize===32?255:1;
          captured.maskBytes=Uint8Array.from(pixels,v=>Math.max(0,Math.min(255,Math.round(v*scale))));captured.maskBounds=bounds;
        }
        tmp=await d.duplicate(unique('AI 区域捕获'),true);
        await ctl?.hostControl?.registerAutoCloseDocument(tmp.id);
        await tmp.selection.deselect();await tmp.crop(rect);
        if(tmp.mode!==constants.DocumentMode.RGB)await tmp.changeMode(constants.ChangeMode.RGB);
        if(tmp.bitsPerChannel!==constants.BitsPerChannelType.EIGHT)tmp.bitsPerChannel=constants.BitsPerChannelType.EIGHT;
        await tmp.convertProfile('sRGB IEC61966-2.1',constants.Intent.RELATIVECOLORIMETRIC,true,false);
        file=await tempFile(`${unique('region')}.png`);await tmp.saveAs.png(file,{},true);
        captured.bytes=await file.read({format:formats.binary});
      }catch(e){error=e;}
      finally{
        try{selection?.imageData?.dispose();}catch(e){error=error||e;}
        try{if(tmp){await tmp.closeWithoutSaving();await ctl?.hostControl?.unregisterAutoCloseDocument(tmp.id);}}catch(e){error=error||e;}
        try{if(file)await file.delete();}catch{}
        try{if(original&&app.documents.find(x=>x.id===original.id))app.activeDocument=original;}catch(e){error=error||e;}
      }
      if(error)throw error;
    },{commandName:'AI：保存文档区域与选区'});
    // Upload after leaving Photoshop's modal scope; no network wait locks the document.
    const {bytes,maskBytes,...record}=captured;
    if(maskBytes){const b=record.maskBounds;const r=await fetch(`${HELPER}/masks/raw?width=${b.right-b.left}&height=${b.bottom-b.top}`,{method:'POST',headers:{...HEADERS,'content-type':'application/octet-stream'},body:maskBytes});record.maskUploadId=(await json(r)).uploadId;}
    record.uploadId=await uploadBytes(bytes,'image/png');return json(await post('/regions/capture',record));
  }
  async function maskData(bytes,b,d){
    b=rectOf(b,d);const width=b.right-b.left,height=b.bottom-b.top;
    if(bytes.byteLength!==width*height)throw new Error('灰度蒙版字节数与区域尺寸不一致');
    return imaging.createImageDataFromBuffer(new Uint8Array(bytes),{width,height,components:1,colorSpace:'Grayscale',colorProfile:'Gray Gamma 2.2'});
  }
  async function loadMask(captureId,d,rect){
    const r=await fetch(`${HELPER}/regions/${encodeURIComponent(captureId)}/mask-raw`,{headers:HEADERS});if(!r.ok)throw new Error('原选区蒙版不可用');
    let b;try{b=JSON.parse(r.headers.get('x-mask-bounds'));}catch{throw new Error('选区蒙版坐标无效');}
    b=rectOf(b,d);if(b.left<rect.left||b.top<rect.top||b.right>rect.right||b.bottom>rect.bottom)throw new Error('保存的选区超出捕获区域，请重新捕获');
    const data=await maskData(await r.arrayBuffer(),b,d);return {data,b};
  }
  async function context(cmd){
    const d=bound(cmd.target),rect=rectOf(cmd.rect,d),mask=cmd.mask?await loadMask(cmd.captureId,d,rect):null;
    try{return await core.executeAsModal(async()=>{
      bound(cmd.target);app.activeDocument=d;let chanName=null;
      const key=JSON.stringify([cmd.captureId,cmd.jobId,cmd.target.session,d.id]);
      if(mask){
        chanName=pendingChannels.get(key);
        if(!chanName||!d.channels.find(c=>c.name===chanName)){
          chanName=unique('AI区域');
          await keepSelection(d,async()=>{await imaging.putSelection({documentID:d.id,imageData:mask.data,targetBounds:{left:mask.b.left,top:mask.b.top},replace:true});await d.selection.save(chanName);});
          pendingChannels.set(key,chanName);
        }
      }
      return {captureId:cmd.captureId,docId:d.id,docName:d.title,session:cmd.target.session,docWidth:d.width,docHeight:d.height,rect,layerId:d.activeLayers[0]?.id||null,chanName,selShort:Math.min(rect.right-rect.left,rect.bottom-rect.top),regionChannelKey:key};
    },{commandName:'AI：读取绑定区域'});}finally{mask?.data.dispose();}
  }
  async function execute(cmd){
    await listenerReady;
    if(cmd.type==='documents'){observe();return {session,documents:[...app.documents].map(d=>({...target(d),activeLayerId:d.activeLayers[0]?.id||null})),activeId:app.activeDocument?.id||null};}
    if(cmd.type==='capture-region')return capture(cmd);
    if(cmd.type==='paste-bound'){
      const ctx=await context(cmd);await pasteHistory(cmd.jobId,ctx);
      // Parent may return early for an already-placed result. Remove the newly restored
      // temporary channel on success too. On failure retain it for parent's queued retry.
      if(ctx.chanName)await core.executeAsModal(async()=>{const d=bound(cmd.target);app.activeDocument=d;const c=d.channels.find(c=>c.name===ctx.chanName);if(c)await c.remove();pendingChannels.delete(ctx.regionChannelKey);},{commandName:'AI：清理区域通道'});
      return {docId:ctx.docId,captureId:cmd.captureId,jobId:cmd.jobId};
    }
    if(cmd.type==='apply-mask'){
      const d=bound(cmd.target),rect=rectOf(cmd.rect,d),width=rect.right-rect.left,height=rect.bottom-rect.top;
      const output=cmd.output||'selection',mode=cmd.mode||'alpha';if(!['mask','selection','channel'].includes(output)||!['alpha','luma'].includes(mode))throw new Error('未知蒙版输出或像素模式');
      const r=await fetch(`${HELPER}/jobs/${encodeURIComponent(cmd.jobId)}/mask-raw?width=${width}&height=${height}&mode=${mode}`,{headers:HEADERS});if(!r.ok)throw new Error((await r.json()).error||'读取蒙版失败');
      const imageData=await maskData(await r.arrayBuffer(),rect,d);
      try{return await core.executeAsModal(async()=>{bound(cmd.target);app.activeDocument=d;
        const options={documentID:d.id,imageData,targetBounds:{left:rect.left,top:rect.top},replace:true};
        if(output==='mask'){
          if(!Number.isInteger(cmd.layerId)||!d.layers.some(function find(l){return l.id===cmd.layerId||(l.layers&&l.layers.some(find));}))throw new Error('目标图层不存在，请重新选择');
          await imaging.putLayerMask({...options,kind:'user',layerID:cmd.layerId,commandName:'AI：应用灰度蒙版'});
        }else if(output==='channel')await keepSelection(d,async()=>{await imaging.putSelection(options);await d.selection.save(String(cmd.name||'AI 选区').slice(0,80));});
        else await imaging.putSelection(options);
        return {docId:d.id,output};
      },{commandName:'AI：应用蒙版或选区'});}finally{imageData.dispose();}
    }
    if(cmd.type==='select-subject'||cmd.type==='locate-region')return core.executeAsModal(async()=>{const d=bound(cmd.target);app.activeDocument=d;
      if(cmd.type==='select-subject')await bp({_obj:'autoCutout',sampleAllLayers:true});
      else await d.selection.selectRectangle(rectOf(cmd.rect,d));
      return {docId:d.id};
    },{commandName:cmd.type==='select-subject'?'AI：Photoshop 选择主体':'AI：定位区域'});
    throw new Error('未知文档操作');
  }
  return {execute,session,bound};
};
