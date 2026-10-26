'use strict';
// Local-only analysis. Never runs on the Photoshop or UI thread.
// The original seam detector remains the source of straight-boundary evidence.
// The desktop detector added a second, independent signal for local detail/noise
// drops. Keep both modules separate so old seam callers and result fields stay
// compatible while this worker can return the fused review boxes.
importScripts('seam-detector.js','precision-detector.js','fusion-detector.js');
self.onmessage = async function(event) {
  let bitmap;
  try {
    const c=event.data;
    if(!c||!Number.isSafeInteger(c.width)||!Number.isSafeInteger(c.height)||c.width<1||c.height<1||Math.max(c.width,c.height)>3200||typeof c.imageBase64!=='string'||c.imageBase64.length>60000000)throw Error('抓图尺寸或内容无效');
    if(![c.docWidth,c.docHeight].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=30000))throw Error('原画布尺寸无效');
    const raw=atob(c.imageBase64),bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    if(bitmap.width!==c.width||bitmap.height!==c.height)throw Error('抓图像素与画布信息不一致');
    const canvas=new OffscreenCanvas(c.width,c.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0);
    const imageData=ctx.getImageData(0,0,c.width,c.height);

    // Analyze in captured-pixel coordinates. The capture may be downscaled to
    // the worker's 3200-pixel budget, while docWidth/docHeight remain the PSD's
    // original dimensions. Mapping only after fusion avoids sampling the last
    // captured row repeatedly when the PSD is larger than the preview.
    const seamCandidates=SeamDetector.scanSeams(imageData,c.width,c.height,8);
    const tile=PrecisionDetector.analyzeTile({
      data:imageData.data,width:c.width,height:c.height,channels:4,
      originX:0,originY:0,imageWidth:c.width,imageHeight:c.height
    });
    const precision=PrecisionDetector.finalize(tile.cells,c.width,c.height,tile.cellSize);
    const reviewItems=FusionDetector.combine(precision.candidates,seamCandidates,precision.cells,c.width,c.height,tile.cellSize);
    const sx=c.docWidth/c.width,sy=c.docHeight/c.height;
    const mapBox=box=>({x:box.x*sx,y:box.y*sy,width:box.width*sx,height:box.height*sy});
    const mapPrecision=candidate=>({...candidate,x:candidate.x*sx,y:candidate.y*sy,width:candidate.width*sx,height:candidate.height*sy});
    const mappedPrecisionCandidates=precision.candidates.map(mapPrecision);
    const mappedSeamCandidates=seamCandidates.map(row=>({...row,x0:row.x0*sx,y0:row.y0*sy,x1:row.x1*sx,y1:row.y1*sy,scanPosition:row.scanPosition*(row.axis==='vertical'?sx:sy)}));
    const mapReview=item=>{
      const mapped={...item};
      if(Number.isFinite(item.x))mapped.x=item.x*sx;
      if(Number.isFinite(item.y))mapped.y=item.y*sy;
      if(Number.isFinite(item.width))mapped.width=item.width*sx;
      if(Number.isFinite(item.height))mapped.height=item.height*sy;
      if(item.precisionBox)mapped.precisionBox=mapBox(item.precisionBox);
      if(item.line)mapped.line={x0:item.line.x0*sx,y0:item.line.y0*sy,x1:item.line.x1*sx,y1:item.line.y1*sy};
      if(Array.isArray(item.seamLines))mapped.seamLines=item.seamLines.map(line=>({...line,x0:line.x0*sx,y0:line.y0*sy,x1:line.x1*sx,y1:line.y1*sy}));
      return mapped;
    };
    const mappedItems=reviewItems.map(mapReview);
    const pad=Math.max(4,Math.round(Math.max(c.docWidth,c.docHeight)/500));
    // itemIndex：这个框来自 reviewItems 的第几条（= 候选列表的 index-1）。
    //   PS 那边每个框单独建一个图层，桌面端靠它把图层对回列表里的那一条；下面的 filter 会丢掉退化框，所以不能靠数组下标对。
    const boxes=mappedItems.slice(0,48).map((item,itemIndex)=>{
      const b=item.precisionBox||{x:item.x,y:item.y,width:item.width,height:item.height};
      const seamOnly=item.type==='seam-only'&&item.line;
      const source=seamOnly?item.line:b;
      const left=seamOnly?source.x0-(item.axis==='vertical'?pad:0):source.x;
      const top=seamOnly?source.y0-(item.axis==='horizontal'?pad:0):source.y;
      const right=seamOnly?source.x1+(item.axis==='vertical'?pad:0):source.x+source.width;
      const bottom=seamOnly?source.y1+(item.axis==='horizontal'?pad:0):source.y+source.height;
      const color=item.type==='joint'?[255,82,100,232]:item.type==='precision-only'?[255,154,58,232]:item.line?.profile==='long'?[206,104,255,232]:item.line?.profile==='strong'?[255,154,58,232]:[70,224,211,232];
      return {left:Math.max(0,Math.floor(left)),top:Math.max(0,Math.floor(top)),right:Math.min(c.docWidth,Math.ceil(right)+1),bottom:Math.min(c.docHeight,Math.ceil(bottom)+1),color,thickness:Math.max(2,Math.min(8,Math.round(Math.max(c.docWidth,c.docHeight)/1600))),itemIndex,label:String(item.label||'').slice(0,24)};
    }).filter(box=>box.right>box.left&&box.bottom>box.top);
    self.postMessage({ok:true,boxes,candidateCount:boxes.length,precisionCandidates:mappedPrecisionCandidates,seamCandidates:mappedSeamCandidates,reviewItems:mappedItems,stats:precision.stats});
  }catch(error){self.postMessage({ok:false,error:String(error.message||error)});}finally{if(bitmap)bitmap.close();}
};
