// Photo glow only: identical pixel pipeline for worker previews and full output.
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.GLOW_CORE=factory();
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const DEFAULTS=Object.freeze({threshold:70,radius:1.5,strength:45,blend:'softLight',copyHighlights:true});
  const MODES=['softLight','linearDodge','overlay'];
  const clamp=(v,l,h)=>Math.max(l,Math.min(h,v));
  function params(raw){
    const p=raw||{}, num=(key,min,max)=>Number.isFinite(Number(p[key]))?clamp(Number(p[key]),min,max):DEFAULTS[key];
    return {threshold:num('threshold',0,100),radius:num('radius',0,10),strength:num('strength',0,200),
      blend:MODES.includes(p.blend)?p.blend:DEFAULTS.blend,copyHighlights:p.copyHighlights===undefined?true:!!p.copyHighlights};
  }
  function highlight(luminance,threshold){
    const t=threshold/100;
    if(t>=1) return luminance>=1?1:0;
    const x=clamp((luminance-t)/Math.min(0.1,1-t),0,1);
    return x*x*(3-2*x);
  }
  function blend(base,light,mode){
    if(mode==='linearDodge') return Math.min(1,base+light);
    if(mode==='overlay') return base<=0.5?2*base*light:1-2*(1-base)*(1-light);
    const d=base<=0.25?((16*base-12)*base+4)*base:Math.sqrt(base);
    return light<=0.5?base-(1-2*light)*base*(1-base):base+(2*light-1)*(d-base);
  }
  // O(pixels), independent of radius. Replicated boundary samples keep constants stable.
  function blurPlane(data,scratch,w,h,radius){
    const r=Math.max(0,Math.round(radius));
    if(!r) return data;
    const diameter=2*r+1;
    for(let pass=0;pass<3;pass++){
      for(let y=0;y<h;y++){
        const row=y*w; let sum=data[row]*(r+1);
        for(let x=1;x<=r;x++) sum+=data[row+Math.min(w-1,x)];
        for(let x=0;x<w;x++){
          scratch[row+x]=sum/diameter;
          sum+=data[row+Math.min(w-1,x+r+1)]-data[row+Math.max(0,x-r)];
        }
      }
      for(let x=0;x<w;x++){
        let sum=scratch[x]*(r+1);
        for(let y=1;y<=r;y++) sum+=scratch[Math.min(h-1,y)*w+x];
        for(let y=0;y<h;y++){
          data[y*w+x]=sum/diameter;
          sum+=scratch[Math.min(h-1,y+r+1)*w+x]-scratch[Math.max(0,y-r)*w+x];
        }
      }
    }
    return data;
  }
  function render(input,raw){
    const w=Number(input&&input.width),h=Number(input&&input.height),src=input&&input.data;
    if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||!src||src.length!==w*h*4) throw new Error('辉光图像尺寸无效');
    if(w*h>32000000) throw new Error('辉光区域超过 3200 万像素，请缩小 Photoshop 选区后重试');
    const p=params(raw),n=w*h,out=new Uint8ClampedArray(src);
    if(p.strength===0) return {data:out,width:w,height:h};
    const mask=new Float32Array(n),scratch=new Float32Array(n),channel=new Float32Array(n);
    const weight=i=>highlight((0.2126*src[i]+0.7152*src[i+1]+0.0722*src[i+2])/255,p.threshold)*(src[i+3]/255);
    for(let j=0;j<n;j++) mask[j]=weight(j*4);
    // Radius is a percentage of the source's long edge, preserving framing on a scaled preview.
    const radius=Math.round(Math.max(w,h)*p.radius/100/Math.sqrt(3));
    blurPlane(mask,scratch,w,h,radius);
    const strength=p.strength/100;
    for(let c=0;c<3;c++){
      for(let j=0;j<n;j++) channel[j]=(src[j*4+c]/255)*weight(j*4);
      blurPlane(channel,scratch,w,h,radius);
      for(let j=0;j<n;j++){
        const i=j*4,base=src[i+c]/255;
        if(!src[i+3]) continue;
        const a=clamp(mask[j]*strength,0,1),light=mask[j]>1e-7?clamp(channel[j]/mask[j],0,1):0;
        let value=base+(blend(base,light,p.blend)-base)*a;
        if(p.copyHighlights){
          const copy=clamp(weight(i)*strength,0,1);
          value+=(blend(value,base,p.blend)-value)*copy;
        }
        out[i+c]=Math.round(clamp(value,0,1)*255);
      }
    }
    return {data:out,width:w,height:h};
  }
  return {DEFAULTS,MODES,params,highlight,blend,blurPlane,render};
});
