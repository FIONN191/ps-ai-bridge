'use strict';

// Read-only composite capture for assistant context. Never call the selection capture helper:
// that helper is allowed to select/deselect and operates on the selected crop.
const MAX_EDGE=1536;
// ⚠ app.documents 不是真数组：官方合同只有 length / 索引 / forEach / getByName，别用 .find（docs/03「UXP 集合兼容」；
//   10-20 图层集合用 .find 就栽过：一调就抛、被吞掉）。按 id 找文档一律走这个。
function documentById(app,id){
  const list=app&&app.documents,count=Number(list&&list.length)||0;
  for(let index=0;index<count;index++){const doc=list[index];if(doc&&String(doc.id)===String(id))return doc;}
  return null;
}
const {createAssistantViewState}=require('./assistant-view-state');
const depth=require('./pixel-depth');
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function number(value){return Number(value&&typeof value==='object'&&value._value!==undefined?value._value:value);}
function rect(value){
  if(!value)return null;
  const left=number(value.left),top=number(value.top),right=number(value.right),bottom=number(value.bottom);
  return [left,top,right,bottom].every(Number.isFinite)&&right>left&&bottom>top
    ? {left,top,right,bottom,width:right-left,height:bottom-top}:null;
}
function dimensions(width,height,maxEdge){
  const w=Math.round(number(width)),h=Math.round(number(height));
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1)throw fail('ASSISTANT_CAPTURE_DIMENSIONS','Photoshop 画布尺寸无效');
  const limit=maxEdge===undefined?MAX_EDGE:Number(maxEdge);
  if(!Number.isFinite(limit)||limit<1)throw fail('ASSISTANT_CAPTURE_PARAMS','助手看图尺寸必须为正数');
  const edge=Math.min(MAX_EDGE,Math.floor(limit)),scale=Math.min(1,edge/Math.max(w,h));
  return {docWidth:w,docHeight:h,width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale))};
}
// ⭐ 2026-10-17（用户：「我要求我们的Agent能够把图片拉出来计算出坐标」）：可选 region = 只读原图里这一块
//   （原图像素坐标），给夏三六放大看局部、量准坐标用。不给 region 时跟原来完全一样读整张。
//   超出画布的部分裁掉；只缩小不放大（放大交给界面画刻度时做）。
function regionOf(value,docWidth,docHeight,maxEdge){
  const n=['left','top','right','bottom'].map(k=>Number(value&&value[k]));
  if(!n.every(Number.isFinite))throw fail('ASSISTANT_CAPTURE_PARAMS','要看的区域坐标无效');
  const left=Math.max(0,Math.floor(n[0])),top=Math.max(0,Math.floor(n[1])),right=Math.min(docWidth,Math.ceil(n[2])),bottom=Math.min(docHeight,Math.ceil(n[3]));
  if(right-left<8||bottom-top<8)throw fail('ASSISTANT_CAPTURE_PARAMS','要看的区域太小或不在画布内（至少 8×8 像素）');
  const limit=maxEdge===undefined?MAX_EDGE:Number(maxEdge);
  if(!Number.isFinite(limit)||limit<1)throw fail('ASSISTANT_CAPTURE_PARAMS','助手看图尺寸必须为正数');
  const w=right-left,h=bottom-top,scale=Math.min(1,Math.min(MAX_EDGE,Math.floor(limit))/Math.max(w,h));
  return {src:{left,top,right,bottom,width:w,height:h},width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale))};
}

// Adobe returns sourceBounds in pyramid-level coordinates. Reconstruct the full
// requested canvas; transparent margins must not change composition for the LLM.
// src = 这次读的是原图哪一块（不给 = 整张，算法跟原来一样）
function coverage(pixelResult,size,src){
  const bounds=rect(pixelResult.sourceBounds),level=Number(pixelResult.level);
  if(!bounds||!Number.isInteger(level)||level<0||level>20)
    throw fail('ASSISTANT_CAPTURE_BOUNDS','Photoshop 未提供可靠的像素范围，已停止发送以免误判画面构图');
  const s=src||{left:0,top:0,right:size.docWidth,bottom:size.docHeight};
  const factor=Math.pow(2,level);
  const doc={left:Math.max(s.left,bounds.left*factor),top:Math.max(s.top,bounds.top*factor),
    right:Math.min(s.right,bounds.right*factor),bottom:Math.min(s.bottom,bounds.bottom*factor)};
  if(doc.right<=doc.left||doc.bottom<=doc.top)throw fail('ASSISTANT_CAPTURE_BOUNDS','Photoshop 返回的像素范围不在画布内');
  const x=size.width/(s.right-s.left),y=size.height/(s.bottom-s.top);
  return {documentBounds:{...doc,width:doc.right-doc.left,height:doc.bottom-doc.top},
    left:Math.round((doc.left-s.left)*x),top:Math.round((doc.top-s.top)*y),
    right:Math.round((doc.right-s.left)*x),bottom:Math.round((doc.bottom-s.top)*y)};
}
function padCanvas(raw,image,size,area){
  const w=Number(image.width),h=Number(image.height),c=Number(image.components);
  if(c!==3||Number(image.componentSize)!==8||!(raw instanceof Uint8Array)||raw.length!==w*h*c)
    throw fail('ASSISTANT_CAPTURE_PIXELS','Photoshop 返回了不支持的像素格式，请确认软件和桥接版本');
  const output=new Uint8Array(size.width*size.height*3);output.fill(255);
  const dw=area.right-area.left,dh=area.bottom-area.top;
  if(dw<1||dh<1)return output;
  // Bilinear resampling handles pyramid rounding without shifting the content rectangle.
  for(let y=0;y<dh;y++){
    const sy=Math.max(0,Math.min(h-1,(y+.5)*h/dh-.5)),y0=Math.floor(sy),y1=Math.min(h-1,y0+1),fy=sy-y0;
    for(let x=0;x<dw;x++){
      const sx=Math.max(0,Math.min(w-1,(x+.5)*w/dw-.5)),x0=Math.floor(sx),x1=Math.min(w-1,x0+1),fx=sx-x0;
      const dest=((y+area.top)*size.width+x+area.left)*3;
      for(let k=0;k<3;k++){
        const a=raw[(y0*w+x0)*3+k]*(1-fx)+raw[(y0*w+x1)*3+k]*fx;
        const b=raw[(y1*w+x0)*3+k]*(1-fx)+raw[(y1*w+x1)*3+k]*fx;
        output[dest+k]=Math.round(a*(1-fy)+b*fy);
      }
    }
  }
  return output;
}
async function selectionOf(doc,app){
  try{
    if(doc.selection&&'bounds' in doc.selection){
      const bounds=rect(doc.selection.bounds);return {status:bounds?'present':'none',bounds};
    }
  }catch(_){/* Older PS versions need the read-only descriptor fallback. */}
  try{
    const result=await app.batchPlay([{_obj:'get',_target:[{_property:'selection'},{_ref:'document',_id:doc.id}]}],{synchronousExecution:false});
    if(!result||!result[0]||result[0]._obj==='error')return {status:'unavailable',bounds:null};
    const bounds=rect(result[0].selection);return {status:bounds?'present':'none',bounds};
  }catch(_){return {status:'unavailable',bounds:null};}
}

function createAssistantCapture({app,imaging,now=()=>Date.now(),log=()=>{},viewState=createAssistantViewState({app,now})}){
  return async function capture(params={}){
    let image=null,padded=null;
    const startedAt=now();
    if(params.expiresAt!==undefined&&!Number.isFinite(Number(params.expiresAt)))throw fail('ASSISTANT_CAPTURE_PARAMS','助手看图请求的有效期无效');
    if(params.expiresAt!==undefined&&Number(params.expiresAt)<=startedAt)throw fail('ASSISTANT_CAPTURE_EXPIRED','助手看图请求已过期，请重新抓取');
    const doc=params.docId!=null?documentById(app,params.docId):app.activeDocument;
    if(!doc)throw fail(params.docId!=null?'SOURCE_DOCUMENT_CLOSED':'NO_DOCUMENT','没有可读取的 Photoshop 文档');
    if(!imaging||typeof imaging.getPixels!=='function'||typeof imaging.encodeImageData!=='function')
      throw fail('ASSISTANT_CAPTURE_UNSUPPORTED','当前 Photoshop 不支持助手只读看图，请升级 Photoshop 和联动插件');
    const whole=dimensions(doc.width,doc.height,params.maxEdge);
    const part=params.region!=null?regionOf(params.region,whole.docWidth,whole.docHeight,params.maxEdge):null;
    const size=part?{docWidth:whole.docWidth,docHeight:whole.docHeight,width:part.width,height:part.height}:whole;
    const src=part?part.src:{left:0,top:0,right:size.docWidth,bottom:size.docHeight,width:size.docWidth,height:size.docHeight};
    const selection=await selectionOf(doc,app);
    try{
      const result=await imaging.getPixels({documentID:doc.id,
        sourceBounds:{left:src.left,top:src.top,right:src.right,bottom:src.bottom},
        targetSize:{width:size.width,height:size.height},componentSize:8,colorSpace:'RGB',
        colorProfile:'sRGB IEC61966-2.1',applyAlpha:true});
      image=result&&result.imageData;
      if(!image||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1)
        throw fail('ASSISTANT_CAPTURE_EMPTY','当前画布没有可读取的合成图像');
      if(image.width*image.height>MAX_EDGE*MAX_EDGE*4)throw fail('ASSISTANT_CAPTURE_PIXELS','Photoshop 返回的图像超出助手预览预算');
      const area=coverage(result,size,src);
      // ⭐ 2026-10-21：16 位 / 32 位文档上 PS 可能不管 componentSize:8，照样回 16 位 / 浮点 ——
      //   原来直接报错说没有八位预览，16 位文档上助手就看不了图。现在降成 8 位 RGB 再用（pixel-depth.js，规则同主抓图 / V6）。
      const eightBit=Number(image.components)===3&&Number(image.componentSize)===8;
      let encodedImage=image;
      const full=area.left===0&&area.top===0&&area.right===size.width&&area.bottom===size.height
        &&image.width===size.width&&image.height===size.height;
      if(!full||!eightBit){
        if(typeof imaging.createImageDataFromBuffer!=='function')throw fail('ASSISTANT_CAPTURE_UNSUPPORTED','当前 Photoshop 无法补齐完整画布预览，请升级后重试');
        const raw=await image.getData({chunky:true});
        // 自称 8 位、实际回了两倍长度（16 位按字节）的也要转
        const plain=eightBit&&raw instanceof Uint8Array&&raw.length===Number(image.width)*Number(image.height)*3;
        const got=plain?{data:raw}:depth.toRgb8(raw,Number(image.width),Number(image.height),Number(image.components));
        if(!got)throw fail('ASSISTANT_CAPTURE_PIXELS','Photoshop 未能返回可识别的 RGB 预览，未发送图片');
        const rgb={width:image.width,height:image.height,components:3,componentSize:8};
        const canvas=full?got.data:padCanvas(got.data,rgb,size,area);
        padded=await imaging.createImageDataFromBuffer(canvas,{width:size.width,height:size.height,components:3,chunky:true,colorSpace:'RGB',colorProfile:'sRGB IEC61966-2.1'});
        encodedImage=padded;
      }
      const imageBase64=await imaging.encodeImageData({imageData:encodedImage,base64:true});
      if(typeof imageBase64!=='string'||!imageBase64.length)throw fail('ASSISTANT_CAPTURE_ENCODING','助手预览编码失败，请重新抓取');
      const viewport=await viewState({docId:doc.id,expiresAt:params.expiresAt});
      if(params.expiresAt!==undefined&&Number(params.expiresAt)<=now())throw fail('ASSISTANT_CAPTURE_EXPIRED','助手看图请求已过期，请重新抓取');
      const response={purpose:'assistant',imageBase64,mime:'image/jpeg',width:size.width,height:size.height,
        docId:doc.id,docName:String(doc.name||''),docWidth:size.docWidth,docHeight:size.docHeight,
        capturedAt:startedAt,durationMs:now()-startedAt,selection:selection.bounds,
        focus:{selection,viewport},
        contentBounds:area.documentBounds,colorProfile:'sRGB IEC61966-2.1',alphaBackground:'white',selectionChanged:false,layersChanged:false,
        // 这张图对应原图哪一块（原图像素坐标）；整张时就是整个画布
        region:{left:src.left,top:src.top,right:src.right,bottom:src.bottom,width:src.width,height:src.height}};
      log('[助手看图] 已读取'+(part?'局部 '+src.left+','+src.top+'～'+src.right+','+src.bottom:'完整画布 '+size.docWidth+'×'+size.docHeight)+' → '+size.width+'×'+size.height+'，未修改选区或图层','success');
      return response;
    }finally{
      for(const owned of [padded,image])if(owned&&typeof owned.dispose==='function'){
        try{owned.dispose();}catch(error){log('[助手看图] 释放预览像素失败：'+String(error&&error.message||error),'warn');}
      }
    }
  };
}
module.exports={MAX_EDGE,dimensions,regionOf,coverage,padCanvas,selectionOf,documentById,createAssistantCapture};
