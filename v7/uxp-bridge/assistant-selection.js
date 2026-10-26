'use strict';
const { documentById } = require('./assistant-capture');
function failure(code,message){return Object.assign(new Error(message),{code});}
function normalizeRect(value,width,height){
  const r=value||{},numbers=['left','top','right','bottom'].map(k=>Number(r[k]));
  if(!numbers.every(Number.isFinite)||numbers[2]<=numbers[0]||numbers[3]<=numbers[1])throw failure('SEMANTIC_SELECTION_INVALID','人物部位选区坐标无效，请重新识别');
  const [left,top,right,bottom]=[Math.floor(numbers[0]),Math.floor(numbers[1]),Math.ceil(numbers[2]),Math.ceil(numbers[3])];
  if(left<0||top<0||right>width||bottom>height)throw failure('SEMANTIC_SELECTION_INVALID','人物部位选区超出原画布，请重新识别');
  return {left,top,right,bottom,width:right-left,height:bottom-top};
}
function createApplySelection({app,core,now=()=>Date.now()}){
  return async function apply(params={}){
    if(params.confirmed!==true)throw failure('SEMANTIC_CONFIRM_REQUIRED','必须先在本机确认要选择的人物或部位');
    if(!Number.isFinite(Number(params.expiresAt))||Number(params.expiresAt)<=now())throw failure('SEMANTIC_SELECTION_EXPIRED','这次识别已过期，请重新识别当前画面');
    const doc=documentById(app,params.docId);
    if(!doc)throw failure('SOURCE_DOCUMENT_CLOSED','原始 Photoshop 文档已经关闭，请重新识别');
    const validate=()=>{
      if(Number(doc.width)!==Number(params.docWidth)||Number(doc.height)!==Number(params.docHeight)||String(doc.name||'')!==String(params.docName||''))
        throw failure('SEMANTIC_DOCUMENT_CHANGED','原画布的尺寸或名称已经变化，请重新识别以免框错位置');
      return normalizeRect(params.rect,Number(doc.width),Number(doc.height));
    };
    let selection=validate();
    await core.executeAsModal(async()=>{
      if(Number(params.expiresAt)<=now())throw failure('SEMANTIC_SELECTION_EXPIRED','这次识别已过期，请重新识别当前画面');
      selection=validate();
      const checked=async descriptors=>{
        const result=await app.batchPlay(descriptors,{});
        if(!Array.isArray(result)||result.some(r=>r&&r._obj==='error'))throw failure('SEMANTIC_APPLY_FAILED','Photoshop 没有成功执行建立选区，请检查文档状态');
        return result;
      };
      await checked([{_obj:'select',_target:[{_ref:'document',_id:doc.id}]}]);
      await checked([{_obj:'set',_target:[{_ref:'channel',_property:'selection'}],to:{_obj:'rectangle',
        left:{_unit:'pixelsUnit',_value:selection.left},top:{_unit:'pixelsUnit',_value:selection.top},
        right:{_unit:'pixelsUnit',_value:selection.right},bottom:{_unit:'pixelsUnit',_value:selection.bottom}}}]);
    },{commandName:'确认助手识别的部位选区'});
    return {applied:true,docId:doc.id,selection,candidateId:String(params.candidateId||'')};
  };
}

// ⭐ 2026-10-17（用户：「我要求我们的Agent能够把图片拉出来计算出坐标」「给Agent的权限没给够」）
//   夏三六按自己量出的原图坐标建选区（矩形 / 椭圆；多个框合并成一个选区）。
//   跟上面 createApplySelection 的区别：那条是「SAM 3 候选 + 用户在本机预览里点确认」；
//   这条只建选区 —— 不动像素、不动图层、不花钱，Ctrl+Z 能撤 —— 所以不弹确认（用户嫌权限不够，这步不拦）。
//   ⚠ batchPlay 写法不对时 PS 也可能回「成功」但什么都没做（记忆：UXP 静默失效）
//     ⇒ 建完必须回读选区外框，对不上就报错，不让夏三六说「建好了」。读不回来就如实标 verified:false。
const SHAPE_DESCRIPTOR={rect:'rectangle',ellipse:'ellipse'};
const px=value=>({_unit:'pixelsUnit',_value:value});
function boundsOf(value){
  if(!value)return null;
  const n=k=>Number(value[k]&&typeof value[k]==='object'&&value[k]._value!==undefined?value[k]._value:value[k]);
  const r={left:n('left'),top:n('top'),right:n('right'),bottom:n('bottom')};
  return Object.values(r).every(Number.isFinite)&&r.right>r.left&&r.bottom>r.top?r:null;
}
async function readSelection(doc,app){
  try{if(doc.selection&&'bounds' in doc.selection)return {readable:true,bounds:boundsOf(doc.selection.bounds)};}catch(_){/* 老版本 PS 走下面的描述符 */}
  try{
    const result=await app.batchPlay([{_obj:'get',_target:[{_property:'selection'},{_ref:'document',_id:doc.id}]}],{synchronousExecution:false});
    if(Array.isArray(result)&&result[0]&&result[0]._obj!=='error')return {readable:true,bounds:boundsOf(result[0].selection)};
  }catch(_){/* 读不回来就如实说读不回来 */}
  return {readable:false,bounds:null};
}
function clipShape(value,width,height){
  const r=value||{},n=['left','top','right','bottom'].map(k=>Number(r[k]));
  if(!n.every(Number.isFinite)||n[2]<=n[0]||n[3]<=n[1])throw failure('ASSISTANT_SELECT_INVALID','框的坐标无效：要给原图像素坐标，并且 left < right、top < bottom');
  const left=Math.max(0,Math.floor(n[0])),top=Math.max(0,Math.floor(n[1])),right=Math.min(width,Math.ceil(n[2])),bottom=Math.min(height,Math.ceil(n[3]));
  const asked=(n[2]-n[0])*(n[3]-n[1]),kept=Math.max(0,right-left)*Math.max(0,bottom-top);
  // 超出画布一点点就裁掉；大半在外面 = 坐标多半量错了（比如按缩小图的像素报的），不替它猜
  if(right-left<2||bottom-top<2||kept<asked*.5)throw failure('ASSISTANT_SELECT_OUTSIDE','框有一大半在画布外面（画布 '+width+'×'+height+'），坐标可能量错了，请重新看图');
  return {left,top,right,bottom,width:right-left,height:bottom-top,shape:SHAPE_DESCRIPTOR[r.shape]?r.shape:'rect',clipped:kept<asked};
}
const boxText=b=>b.left+','+b.top+'～'+b.right+','+b.bottom;
function createSelectShapes({app,core,now=()=>Date.now()}){
  return async function select(params={}){
    if(!Number.isFinite(Number(params.expiresAt))||Number(params.expiresAt)<=now())throw failure('ASSISTANT_SELECT_EXPIRED','坐标是按之前看到的那张图量的，已经过期，请重新看图再定位置');
    const doc=documentById(app,params.docId);
    if(!doc)throw failure('SOURCE_DOCUMENT_CLOSED','量坐标时的那张图已经关掉了');
    if(!Array.isArray(params.shapes)||!params.shapes.length||params.shapes.length>10)throw failure('ASSISTANT_SELECT_INVALID','一次给 1～10 个框');
    const mode=params.mode==='add'?'add':'replace';
    const validate=()=>{
      if(Number(doc.width)!==Number(params.docWidth)||Number(doc.height)!==Number(params.docHeight)||String(doc.name||'')!==String(params.docName||''))
        throw failure('SEMANTIC_DOCUMENT_CHANGED','这张图的尺寸或名字变了，之前量的坐标可能对不上，请重新看图');
      return params.shapes.map(s=>clipShape(s,Number(doc.width),Number(doc.height)));
    };
    let shapes=validate(),after={readable:false,bounds:null};
    await core.executeAsModal(async()=>{
      if(Number(params.expiresAt)<=now())throw failure('ASSISTANT_SELECT_EXPIRED','坐标是按之前看到的那张图量的，已经过期，请重新看图再定位置');
      shapes=validate();
      const checked=async descriptors=>{
        const result=await app.batchPlay(descriptors,{});
        if(!Array.isArray(result)||result.some(r=>r&&r._obj==='error'))throw failure('ASSISTANT_SELECT_FAILED','Photoshop 没有成功建立选区，请检查文档状态（比如是不是正在用别的工具、开着对话框）');
        return result;
      };
      await checked([{_obj:'select',_target:[{_ref:'document',_id:doc.id}]}]);
      for(let i=0;i<shapes.length;i++){
        const s=shapes[i];
        await checked([{_obj:i===0&&mode==='replace'?'set':'addTo',_target:[{_ref:'channel',_property:'selection'}],
          to:{_obj:SHAPE_DESCRIPTOR[s.shape],left:px(s.left),top:px(s.top),right:px(s.right),bottom:px(s.bottom)},
          ...(s.shape==='ellipse'?{antiAlias:true}:{})}]);
      }
      after=await readSelection(doc,app);
    },{commandName:'夏三六按坐标建选区'});
    const union={left:Math.min(...shapes.map(s=>s.left)),top:Math.min(...shapes.map(s=>s.top)),right:Math.max(...shapes.map(s=>s.right)),bottom:Math.max(...shapes.map(s=>s.bottom))};
    const b=after.bounds,tol=2;
    if(after.readable){
      const ok=!!b&&(mode==='replace'
        ?Math.abs(b.left-union.left)<=tol&&Math.abs(b.top-union.top)<=tol&&Math.abs(b.right-union.right)<=tol&&Math.abs(b.bottom-union.bottom)<=tol
        :b.left<=union.left+tol&&b.top<=union.top+tol&&b.right>=union.right-tol&&b.bottom>=union.bottom-tol);
      if(!ok)throw failure('ASSISTANT_SELECT_NOT_APPLIED','Photoshop 回报成功，但回读的选区对不上：要的外框 '+boxText(union)+'，实际'+(b?' '+boxText(b):'没有选区')+'。选区没建好，不能当成做完了');
    }
    return {applied:true,verified:after.readable,docId:doc.id,docName:String(doc.name||''),mode,
      shapes:shapes.map(({left,top,right,bottom,shape,clipped})=>({left,top,right,bottom,shape,...(clipped?{clipped:true}:{})})),
      bounds:b?{...b,width:b.right-b.left,height:b.bottom-b.top}:null,
      ...(after.readable?{}:{note:'这台 Photoshop 读不回选区范围，没法核对选区是不是真的建好了，请用户看一眼'})};
  };
}
module.exports={normalizeRect,createApplySelection,createSelectShapes,clipShape};
