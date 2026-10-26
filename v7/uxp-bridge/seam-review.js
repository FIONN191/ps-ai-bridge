'use strict';
// Photoshop-only operations. Detection runs in the desktop Web Worker.
const {createRegionCapture}=require('./region-capture');
// New visible product name; keep the legacy prefix in the visibility guard so
// old PSDs with an existing annotation layer are still detected and protected.
const PREFIX='AI修图痕迹检测标注';
const LEGACY_PREFIX='接缝检查标注';
const fail=(code,message,raw)=>Object.assign(new Error(message),{code,raw});
function list(collection){const rows=[];for(let i=0;collection&&i<collection.length;i++)rows.push(collection[i]);return rows;}
function layers(doc,constants){
  const rows=[];function walk(items){for(const layer of list(items)){rows.push(layer);if(layer.kind===constants.LayerKind.GROUP||String(layer.kind).toLowerCase()==='group')walk(layer.layers);}}
  walk(doc.layers);return rows;
}
function validateBoxes(boxes,width,height){
  if(!Array.isArray(boxes)||boxes.length>48)throw fail('SEAM_INVALID','标注框数量无效');
  return boxes.map(box=>{
    if(!box||![box.left,box.top,box.right,box.bottom,box.thickness].every(Number.isSafeInteger)||box.left<0||box.top<0||box.right>width||box.bottom>height||box.right<=box.left||box.bottom<=box.top||box.thickness<1||box.thickness>8||!Array.isArray(box.color)||box.color.length!==4||!box.color.every(x=>Number.isInteger(x)&&x>=0&&x<=255)||box.color[3]<1)throw fail('SEAM_INVALID','标注坐标超出画布或参数无效');
    // label / itemIndex 只用来给图层起名、让桌面端把图层对回列表里的候选；不参与画线。
    const label=typeof box.label==='string'?box.label.replace(/[\u0000-\u001f]/g,'').trim().slice(0,24):'';
    const itemIndex=Number.isSafeInteger(box.itemIndex)&&box.itemIndex>=0?box.itemIndex:null;
    return {...box,color:box.color.slice(),label,itemIndex};
  });
}
// 痕迹图层 / 组的名字。⚠ 组名必须以 PREFIX 开头 —— capture() 靠它认出"上次的标注还开着"。
function traceName(box,index){return '痕迹 '+String(index+1).padStart(2,'0')+(box.label?' · '+box.label:'');}
function groupName(count){return PREFIX+'（'+count+' 处，需人工确认）';}
// Four narrow strips: empty interiors and surrounding canvas stay transparent.
function stripsFor(box){
  const w=box.right-box.left,h=box.bottom-box.top,t=Math.min(box.thickness,w,h);
  const rects=[{left:box.left,top:box.top,width:w,height:t}];
  if(h>t)rects.push({left:box.left,top:box.bottom-t,width:w,height:t});
  if(h>2*t){rects.push({left:box.left,top:box.top+t,width:t,height:h-2*t});if(w>t)rects.push({left:box.right-t,top:box.top+t,width:t,height:h-2*t});}
  return rects.map(r=>{const data=new Uint8Array(r.width*r.height*4);for(let i=0;i<data.length;i+=4)data.set(box.color,i);return {...r,data};});
}
function createSeamReview({app,core,imaging,constants,now=Date.now}){
  const captures=new Map();let serial=0;
  function live(token){const saved=captures.get(token);if(!saved||now()>saved.expires)throw fail('SEAM_EXPIRED','本次画布快照已过期，请重新检查');return saved;}
  function deadline(params){if(!Number.isFinite(params.expiresAt)||params.expiresAt<now())throw fail('SEAM_EXPIRED','请求已过期，已阻止迟到的回传');}
  function target(saved){
    // Photoshop UXP exposes Documents as an array-like collection.  Its
    // public contract guarantees `length` and indexed access, but does not
    // guarantee Array.prototype.find.  Keep the lookup compatible with the
    // real host instead of relying on the Node test fixture's Array methods.
    let doc=null;
    const documents=app&&app.documents;
    for(let index=0;documents&&index<Number(documents.length||0);index++){
      const candidate=documents[index];
      if(candidate&&Number(candidate.id)===saved.docId){doc=candidate;break;}
    }
    if(!doc)throw fail('SOURCE_DOCUMENT_CLOSED','原 Photoshop 文档已关闭，请重新检查');
    if(Number(app.activeDocument?.id)!==saved.docId)throw fail('SEAM_STALE','已切换 Photoshop 文档，请返回原文档后重新检查');
    if(Number(doc.width)!==saved.width||Number(doc.height)!==saved.height||String(doc.name)!==saved.name)throw fail('SEAM_STALE','画布尺寸或名称已变化，请重新检查');
    const history=Number(doc.activeHistoryState?.id);if(saved.history!=null&&history!==saved.history)throw fail('SEAM_STALE','检查期间画布已经修改，请重新检查最新画面');
    return doc;
  }
  async function capture(params={}){
    deadline(params);
    const doc=app.activeDocument;if(!doc)throw fail('NO_DOCUMENT','请先在 Photoshop 打开需要检查的项目');
    if(!imaging?.putPixels||!imaging?.createImageDataFromBuffer)throw fail('SEAM_UNSUPPORTED','当前 Photoshop 不支持透明像素回传，请更新 Photoshop 和联动插件');
    if(Math.max(Number(doc.width),Number(doc.height))>30000)throw fail('SEAM_LIMIT','当前画布超过 30000 像素长边，请在缩小的副本中检查');
    if(layers(doc,constants).some(l=>l.visible&&[PREFIX,LEGACY_PREFIX].some(prefix=>String(l.name).startsWith(prefix))))throw fail('SEAM_PREVIOUS_VISIBLE','请先在 Photoshop 隐藏上次的 AI 修图痕迹检测标注层，再检测，避免把标注线当成新的候选');
    const width=Number(doc.width),height=Number(doc.height),history=Number(doc.activeHistoryState?.id);
    if(!Number.isSafeInteger(history))throw fail('SEAM_HISTORY_UNAVAILABLE','无法确认 Photoshop 文档版本，请更新联动插件后重试');
    const snapshot={docId:Number(doc.id),name:String(doc.name),width,height,history};
    // Photoshop pixel capture requires a modal scope; desktop analysis runs after it exits.
    const result=await core.executeAsModal(async()=>{
      deadline(params);target(snapshot);
      return await createRegionCapture({app,imaging})({selection:{left:0,top:0,right:width,bottom:height},maxEdge:3200});
    },{commandName:'读取 AI 修图痕迹检测画布',timeOut:5});
    target(snapshot);
    for(const [key,item] of captures)if(item.expires<now())captures.delete(key);
    if(captures.size>=16)captures.delete(captures.keys().next().value);
    const token='seam-'+now().toString(36)+'-'+(++serial)+'-'+Math.random().toString(36).slice(2);
    captures.set(token,{...snapshot,expires:now()+240000,requestKey:params.requestKey,used:false});
    return {...result,token,historyId:history,hasSelection:false,selectionChanged:false};
  }
  async function apply(params={}){
    deadline(params);const saved=live(params.token);
    if(saved.requestKey!==params.requestKey||saved.used)throw fail('SEAM_DUPLICATE','此快照已回传或正在回传，请先检查 Photoshop 图层面板');
    const boxes=validateBoxes(params.boxes,saved.width,saved.height);
    if(!boxes.length)return {ok:true,placed:false,candidateCount:0};
    target(saved);saved.used=true;
    const receipt={strategy:'restore',placementAttempted:false,placementOccurred:false,visibilityRestored:false,layerId:null,groupId:null,layerIds:[]};
    try{return await core.executeAsModal(async context=>{
      deadline(params);const doc=target(saved),before=layers(doc,constants).map(layer=>({layer,id:layer.id,visible:layer.visible}));
      let historyId=null,group=null,failure=null;const created=[];
      try{
        if(!context?.hostControl?.suspendHistory)throw fail('SEAM_UNSUPPORTED','Photoshop 无法建立安全的撤销记录，请更新后重试');
        historyId=await context.hostControl.suspendHistory({documentID:saved.docId,name:'添加 AI 修图痕迹检测透明标注'});
        receipt.placementAttempted=true;
        // ⭐ 2026-09-29 用户定案：每个痕迹【单独一个图层】，最后装进同一个组。
        //   这样桌面端列表点一条，就能用「组内只显示这一个 + 按屏幕大小缩放图层」跳到那一处
        //   （ps.group.soloOwned 的 focusRegion，悬停聚焦同一套，已在真 PS 验证）。
        //   ⚠ 以前是所有框画在同一个图层上 —— 那样 fitLayersOnScreen 只会框住全部痕迹，跳不到单个。
        for(const [index,box] of boxes.entries()){
          if(context.isCancelled)throw fail('SEAM_CANCELLED','Photoshop 已取消标注写入');
          const layer=await doc.createLayer({name:traceName(box,index),opacity:100});
          created.push(layer);receipt.layerIds.push(Number(layer.id));receipt.placementOccurred=true;
          const top=doc.layers[0];if(top&&Number(top.id)!==Number(layer.id))await layer.move(top,constants.ElementPlacement.PLACEBEFORE);
          layer.visible=true;
          let count=0;   // 每个图层的第一条边 replace，其余叠加
          for(const strip of stripsFor(box)){
            if(context.isCancelled)throw fail('SEAM_CANCELLED','Photoshop 已取消标注写入');
            let image;try{
              image=await imaging.createImageDataFromBuffer(strip.data,{width:strip.width,height:strip.height,components:4,chunky:true,colorSpace:'RGB',colorProfile:'sRGB IEC61966-2.1'});
              await imaging.putPixels({documentID:saved.docId,layerID:layer.id,imageData:image,replace:count++===0,targetBounds:{left:strip.left,top:strip.top}});
            }finally{if(image)image.dispose();}
          }
        }
        group=await groupTraces(doc,receipt.layerIds,groupName(boxes.length));
        receipt.groupId=Number(group.id);receipt.layerId=receipt.groupId;
      }catch(error){failure=error;}finally{
        try{for(const old of before)if(old.layer.visible!==old.visible)old.layer.visible=old.visible;receipt.visibilityRestored=before.every(old=>old.layer.visible===old.visible);if(!receipt.visibilityRestored)throw Error('原图层显隐恢复失败');}catch(error){failure=failure||error;}
        if(historyId!=null){try{await context.hostControl.resumeHistory(historyId,!failure);if(failure){receipt.rolledBack=true;receipt.placementOccurred=false;}}catch(error){failure=failure||error;receipt.uncertain=true;}}
      }
      if(failure)throw failure;
      // layerId 保留给旧调用方（现在指向组）；layerIds 与 boxes 同序，boxIndexes 告诉桌面端每层对应哪条候选
      return {ok:true,placed:true,layerId:receipt.groupId,groupId:receipt.groupId,layerIds:receipt.layerIds.slice(),
        boxIndexes:boxes.map(box=>box.itemIndex),docId:saved.docId,candidateCount:boxes.length,
        historyId:Number(doc.activeHistoryState && doc.activeHistoryState.id) || null,receipt};
    },{commandName:'添加 AI 修图痕迹检测透明标注',timeOut:5000});}catch(error){throw fail(error.code||'SEAM_APPLY_FAILED',String(error.message||error)+(receipt.placementAttempted?'；请先检查 Photoshop 图层面板，勿连续重试':''),{receipt});}
  }
  // batchPlay 失败多半不抛异常，而是回 {_obj:'error'} —— 这里统一变成异常，交给外层整体回滚。
  async function play(descriptors){
    const result=await app.batchPlay(descriptors,{});
    const bad=Array.isArray(result)&&result.find(row=>row&&row._obj==='error');
    if(bad)throw fail('SEAM_GROUP_FAILED','痕迹图层没能编组：'+String(bad.message||bad.result||'Photoshop 拒绝了编组命令'));
    return result;
  }
  // 把刚建的痕迹图层装进一个新组，放到图层最顶上。
  // 写法照抄 V6 ps-io 的 createGroupAndMask（真 PS 27.x 验证过）：选中 → 从选中项建组 → 再显式改一次名；
  // 「移到最前」改成按需（组已在顶层就不动，见函数末尾的说明）。
  async function groupTraces(doc,ids,name){
    await play([{_obj:'select',_target:ids.map(id=>({_ref:'layer',_id:id})),selectionModifier:{_enum:'selectionModifierType',_value:'replaceSelection'},makeVisible:false}]);
    await play([{_obj:'make',_target:[{_ref:'layerSection'}],from:{_ref:'layer',_enum:'ordinal',_value:'targetEnum'},name}]);
    // ⚠ PS 27.x 会无视 make 里的 name，组名落成默认「组 1」—— 建完必须再改一次（V6 双保险同款）
    await play([{_obj:'set',_target:[{_ref:'layer',_enum:'ordinal',_value:'targetEnum'}],to:{_obj:'layer',name}}]);
    // 建完组选中的就是新组；再核对它确实装着我们的图层，核对不上就按名字找（组名唯一性靠数量+前缀，再用成员兜底）
    const owns=layer=>layer&&layer.layers&&list(layer.layers).some(child=>ids.includes(Number(child.id)));
    let group=list(doc.activeLayers)[0];
    if(!owns(group))group=layers(doc,constants).find(layer=>String(layer.name)===name&&owns(layer))||null;
    if(!group)throw fail('SEAM_GROUP_FAILED','痕迹图层已写入，但没找到装它们的组，已撤销本次标注');
    // ⚠ 2026-09-29 真 PS 报「命令"移动"当前不可用」，整次标注被撤销：这里原来无条件 batchPlay「置为顶层」(move → front)，
    //   但痕迹图层建的时候就已经挪到文档最顶上了（apply 里 layer.move(top, PLACEBEFORE)），编出来的组本来就在最顶层，
    //   PS 对「已在顶层的图层再置顶」会把命令置灰并报错。改成：只有组不在最顶层时才挪（DOM move，和挪痕迹图层同一个写法）。
    //   测试里的假 PS 以前对 move 一律回成功，所以没抓到；现在已改成和真 PS 一样会拒绝。
    const top=doc.layers[0];
    if(top&&Number(top.id)!==Number(group.id))await group.move(top,constants.ElementPlacement.PLACEBEFORE);
    return group;
  }
  return {capture,apply};
}
module.exports={createSeamReview,validateBoxes,stripsFor,traceName,groupName};
