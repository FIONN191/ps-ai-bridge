'use strict';
importScripts('glow-core.js');
let source=null, preview=null;
async function canvasFromBlob(blob,maxEdge){
  const bitmap=await createImageBitmap(blob);
  const scale=maxEdge?Math.min(1,maxEdge/Math.max(bitmap.width,bitmap.height)):1;
  if(!maxEdge&&bitmap.width*bitmap.height>32000000){bitmap.close();throw new Error('辉光区域超过 3200 万像素，请缩小 Photoshop 选区后重试');}
  const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return {canvas,ctx};
}
async function encoded(image,full){
  const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');
  ctx.putImageData(new ImageData(image.data,image.width,image.height),0,0);
  const blob=await canvas.convertToBlob({type:full?'image/png':'image/jpeg',quality:0.90});
  if(!full) return {blob};
  const scale=Math.min(1,512/Math.max(image.width,image.height));
  const thumbCanvas=new OffscreenCanvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
  thumbCanvas.getContext('2d').drawImage(canvas,0,0,thumbCanvas.width,thumbCanvas.height);
  return {blob,thumb:await thumbCanvas.convertToBlob({type:'image/jpeg',quality:0.78}),width:image.width,height:image.height};
}
// Requests are serialised, so a final render cannot overtake initial capture.
let chain=Promise.resolve();
self.onmessage=({data:m})=>{chain=chain.then(async()=>{
  if(m.type==='load'){
    source=m.blob;
    const {canvas,ctx}=await canvasFromBlob(source,900);
    preview=ctx.getImageData(0,0,canvas.width,canvas.height);
    const original=await canvas.convertToBlob({type:'image/jpeg',quality:0.90});
    const scale=Math.min(1,512/Math.max(canvas.width,canvas.height));
    const small=new OffscreenCanvas(Math.max(1,Math.round(canvas.width*scale)),Math.max(1,Math.round(canvas.height*scale)));
    small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);
    return {original,thumb:await small.convertToBlob({type:'image/jpeg',quality:0.78})};
  }
  if(!source||!preview) throw new Error('请先从 Photoshop 抓取图片');
  if(m.type==='preview') return encoded(GLOW_CORE.render(preview,m.params),false);
  if(m.type==='render'){
    const {canvas,ctx}=await canvasFromBlob(source,0);
    return encoded(GLOW_CORE.render(ctx.getImageData(0,0,canvas.width,canvas.height),m.params),true);
  }
  throw new Error('不支持的辉光操作');
}).then(result=>self.postMessage({id:m.id,ok:true,...result}),error=>self.postMessage({id:m.id,ok:false,error:String(error&&error.message||error)}));};
