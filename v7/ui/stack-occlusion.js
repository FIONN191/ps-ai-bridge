/* Ordinary stack paint geometry. Loaded after the main UI to avoid coupling
   settings/bootstrap to lexical declarations in the main inline script. */
(function () {
  'use strict';
  const root=document.documentElement,stack=document.getElementById('stack');
  if(!stack)return;
  let frame=0,deadline=0;
  const ordinaryProperty='--stack-occlusion-clip',ordinaryMask='--stack-occlusion-mask';
  const freeProperty='--free-stack-occlusion-clip',freeMask='--free-stack-occlusion-mask';
  const ordinaryEnabled=()=>root.dataset.stackOpacityReveal==='1' &&
    !document.body.matches('.free-mode,.free-mode-switching');
  const freeEnabled=()=>root.dataset.stackOpacityReveal==='1' &&
    document.body.matches('.free-mode')&&!document.body.matches('.free-mode-switching,.ui-collapsed');
  const enabled=()=>ordinaryEnabled()||freeEnabled();
  const cards=()=>Array.from(stack.querySelectorAll('.block-card'));
  const reset=card=>{
    card.style.removeProperty(ordinaryProperty);card.style.removeProperty(ordinaryMask);
    card.style.removeProperty(freeProperty);card.style.removeProperty(freeMask);
  };
  const clear=()=>cards().forEach(reset);
  const n=value=>Math.round(value*1000)/1000;
  function contour(width,height,radius,coveredBottom,coverRadius){
    // Cards share a left edge and width. The union of the higher cards has
    // the lowest bottom edge; only the area below its rounded outline shows.
    if(coveredBottom>=height-.001)return 'path("M0 0Z")';
    if(coveredBottom<=0)return 'none';
    const w=n(width),h=n(height),r=n(radius),y=n(coveredBottom),q=n(coverRadius);
    return `path("M0 ${n(y-q)} A${q} ${q} 0 0 0 ${q} ${y} H${n(w-q)} A${q} ${q} 0 0 0 ${w} ${n(y-q)} V${n(h-r)} A${r} ${r} 0 0 1 ${n(w-r)} ${h} H${r} A${r} ${r} 0 0 1 0 ${n(h-r)} Z")`;
  }
  function motionMask(row,higher){
    // The island expands from 44px, while lower cards scale from .96.
    // These boxes do not share an outline. Subtract the union of every
    // higher rounded box in this card's local coordinates. The SVG's inner
    // luminance mask turns black shapes into holes; its output is an alpha
    // image for the CSS mask (black in a plain alpha mask would NOT cut out).
    const {rect,width,height,sx,sy}=row;
    const holes=higher.map(c=>`<rect x="${n((c.rect.left-rect.left)/sx)}" y="${n((c.rect.top-rect.top)/sy)}" width="${n(c.rect.width/sx)}" height="${n(c.rect.height/sy)}" rx="${n(c.radius*c.sx/sx)}" ry="${n(c.radius*c.sy/sy)}" fill="black"/>`).join('');
    const box=`x="0" y="0" width="${n(width)}" height="${n(height)}"`;
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}"><defs><mask id="cut" ${box} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect ${box} fill="white"/>${holes}</mask></defs><rect ${box} fill="white" mask="url(#cut)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  function sameEnvelope(row,higher){
    return higher.every(c=>Math.abs(c.rect.left-row.rect.left)<.01&&Math.abs(c.rect.right-row.rect.right)<.01&&
      Math.abs(c.rect.height-row.rect.height)<.01&&Math.abs(c.radius*c.sy-row.radius*row.sy)<.01&&c.rect.top<=row.rect.top+.001);
  }
  function paintGroup(rows,property,maskProperty,ordinary=false){
    let cover=null;const higher=[];
    for(const row of rows){
      const {card,rect,width,height,radius}=row;
      if(!cover||(ordinary&&card.classList.contains('is-current'))||(!ordinary&&!row.layered)){reset(card);}
      else if(sameEnvelope(row,higher)){
        const clip=contour(width,height,radius,(cover.rect.bottom-rect.top)/row.sy,cover.radius*cover.sy/row.sy);
        card.style.removeProperty(maskProperty);
        if(card.style.getPropertyValue(property)!==clip)card.style.setProperty(property,clip);
      }else{
        const mask=motionMask(row,higher);
        card.style.setProperty(property,'none');
        if(card.style.getPropertyValue(maskProperty)!==mask)card.style.setProperty(maskProperty,mask);
      }
      if(!cover||rect.bottom>cover.rect.bottom)cover=row;
      higher.push(row);
    }
  }
  function layoutRows(){
    return cards().filter(c=>!c.hidden&&!c.classList.contains('stack-overflow-hidden')&&!c.classList.contains('free-pile-buried')&&!c.classList.contains('free-group-hidden')).map(card=>{
      const css=getComputedStyle(card),rect=card.getBoundingClientRect();
      const width=parseFloat(css.width)||card.offsetWidth,height=parseFloat(css.height)||card.offsetHeight;
      const radius=Math.max(0,Math.min(parseFloat(css.borderBottomLeftRadius)||0,width/2,height/2));
      return {card,rect,width,height,radius,sx:rect.width/width,sy:rect.height/height,z:Number(css.zIndex)||0,
        group:card.dataset.freeGroup||'',layered:card.classList.contains('free-pile-layered')};
    }).filter(r=>r.sx>0&&r.sy>0);
  }
  function paint(){
    frame=0;
    if(!ordinaryEnabled()&&!freeEnabled()){clear();return;}
    const rows=layoutRows();
    if(ordinaryEnabled())paintGroup(rows.sort((a,b)=>b.z-a.z),ordinaryProperty,ordinaryMask,true);
    else{
      const groups=new Map();for(const row of rows){if(!groups.has(row.group))groups.set(row.group,[]);groups.get(row.group).push(row);}
      for(const group of groups.values())paintGroup(group.sort((a,b)=>b.z-a.z),freeProperty,freeMask);
    }
    // Follow only active card motion; no permanent animation loop or timer.
    if(performance.now()<deadline&&rows.some(c=>c.card.getAnimations().some(a=>a.playState==='running')))
      frame=requestAnimationFrame(paint);
  }
  function schedule(){
    if(frame)cancelAnimationFrame(frame);
    deadline=performance.now()+1000;
    if(!enabled()){frame=0;clear();return;}
    frame=requestAnimationFrame(paint);
  }
  // setStack/settings call only this optional scheduling hook after this
  // module has loaded. No settings -> setStack re-entry or startup dependency.
  window.V7StackOcclusion={sync:schedule};
  // Observe mode changes, never our own paint-variable writes.
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['class']});
  for(const name of ['transitionrun','transitionend','transitioncancel'])stack.addEventListener(name,event=>{
    if(event.target.matches('.block-card')&&['transform','height'].includes(event.propertyName))schedule();
  });
  new ResizeObserver(schedule).observe(stack);
  addEventListener('resize',schedule);
  schedule();
})();
