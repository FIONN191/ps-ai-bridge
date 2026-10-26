/* Original-pixel local fidelity and abrupt loss analysis. No reference image is used. */
(function(root,factory){const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;root.PrecisionDetector=api;})(typeof self!=='undefined'?self:globalThis,function(){
'use strict';
const DEFAULTS={cellSize:16,windowSize:32,halo:24,channels:4};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round=v=>Math.round(v*1000)/1000;
function analyzeTile(tile,options){
 const o=Object.assign({},DEFAULTS,options||{}),w=tile.width|0,h=tile.height|0,ch=tile.channels||o.channels;
 if(!tile.data||tile.data.length<w*h*ch||w<1||h<1)throw Error('Invalid tile pixels');
 const ox=tile.originX|0,oy=tile.originY|0,W=o.imageWidth||w,H=o.imageHeight||h,s=Math.max(8,o.cellSize|0),radius=Math.max(8,(o.windowSize||32)/2);
 const coreX=o.coreX??ox,coreY=o.coreY??oy,coreRight=Math.min(W,coreX+(o.coreWidth??w)),coreBottom=Math.min(H,coreY+(o.coreHeight??h));
 const lum=new Float32Array(w*h);for(let i=0,j=0;i<lum.length;i++,j+=ch)lum[i]=ch===1?tile.data[j]:.2126*tile.data[j]+.7152*tile.data[j+1]+.0722*tile.data[j+2];
 const at=(x,y)=>lum[clamp(y-oy,0,h-1)*w+clamp(x-ox,0,w-1)];
 const cells=[];
 for(let gy=Math.ceil(coreY/s)*s;gy<coreBottom;gy+=s)for(let gx=Math.ceil(coreX/s)*s;gx<coreRight;gx+=s){
  const cw=Math.min(s,W-gx),cheight=Math.min(s,H-gy),cx=gx+Math.floor(cw/2),cy=gy+Math.floor(cheight/2);
  // Statistics overlap neighboring cells; only the owned grid geometry is emitted.
  const x0=Math.max(0,cx-radius),x1=Math.min(W,cx+radius),y0=Math.max(0,cy-radius),y1=Math.min(H,cy+radius);
  let e1=0,e2=0,e4=0,g1=0,g4=0,sum=0,sum2=0,n=0;const hist=new Uint16Array(64);
  for(let by=y0;by<y1;by+=2)for(let bx=x0;bx<x1;bx+=2){
   const x=Math.min(bx+((bx>>1)&1),x1-1),y=Math.min(by+((by>>1)&1),y1-1);
   const v=at(x,y);sum+=v;sum2+=v*v;
   // Diagonal high-pass rejects planar illumination and measures grain at 1/2/4 px.
   const q1=Math.abs(v-at(x+1,y)-at(x,y+1)+at(x+1,y+1))*.5;
   const q2=Math.abs(v-at(x+2,y)-at(x,y+2)+at(x+2,y+2))*.5;
   const q4=Math.abs(v-at(x+4,y)-at(x,y+4)+at(x+4,y+4))*.5;
   e1+=q1;e2+=q2;e4+=q4;hist[Math.min(63,Math.floor(q1*4))]++;
   g1+=(Math.abs(at(x+1,y)-at(x-1,y))+Math.abs(at(x,y+1)-at(x,y-1)))*.25;
   g4+=(Math.abs(at(x+4,y)-at(x-4,y))+Math.abs(at(x,y+4)-at(x,y-4)))*.0625;n++;
  }
  e1/=n;e2/=n;e4/=n;g1/=n;g4/=n;const mean=sum/n,texture=Math.sqrt(Math.max(0,sum2/n-mean*mean));
  let cumulative=0,p30=0;for(let i=0;i<64;i++){cumulative+=hist[i];if(cumulative>=n*.3){p30=(i+.5)/4;break;}}
  const noiseSigma=p30/0.385,ratio=(e1+.035)/(e4+.035),ratio2=(e2+.035)/(e4+.035);
  const grain=clamp(Math.max(Math.sqrt((e4+.02)/(e1+.02)),4/((g1+.025)/(g4+.025)+.1)),1,8);
  const gradientRatio=(g1+.025)/(g4+.025);
  const sharpness=.45*clamp((Math.log2(Math.max(.063,ratio))+4)/4,0,1)+.55*clamp(Math.log2(Math.max(1,gradientRatio))/1.65,0,1);
  const energy=clamp(Math.log2(1+e1*3)/4,0,1),support=clamp(Math.log2(1+e4)/3,0,1);
  const score=Math.round(100*clamp(sharpness*.70+energy*.30,0,1)*clamp(Math.max(e4,e2,e1,g1)/.35,0,1));
  const confidence=clamp(.12+support*.6+clamp(texture/20,0,1)*.28,0,1);
  cells.push({x:gx,y:gy,width:cw,height:cheight,score,confidence:round(confidence),detail:round(e1),texture:round(texture),coarse:round(e4),noise:round(noiseSigma),noiseSigma:round(noiseSigma),grain:round(grain),sharpness:round(sharpness),fineRatio:round(ratio),midRatio:round(ratio2),gradientRatio:round(gradientRatio),gradient:round(g1),gradientCoarse:round(g4),luminance:round(mean),risk:0,dropScore:0});
 }
 return{originX:ox,originY:oy,width:w,height:h,imageWidth:W,imageHeight:H,cellSize:s,cells};
}
function finalize(cells,width,height,cellSize=16){
 if(typeof width==='object'){const o=width;width=o.width||o.imageWidth;height=o.height||o.imageHeight;cellSize=o.cellSize||16;}
 const cols=Math.ceil(width/cellSize),rows=Math.ceil(height/cellSize),grid=new Array(cols*rows);
 for(const c of cells)grid[Math.floor(c.y/cellSize)*cols+Math.floor(c.x/cellSize)]=c;
 const raw=new Float32Array(grid.length);const distances=[3,6,12,24];
 // Estimate the surviving camera grain from comparable brightness bands.
 // This reference is learned only from the current image. If the whole frame
 // is smooth/blurred there is no surviving grain baseline and no loss evidence.
 const bands=Array.from({length:16},()=>[]);
 for(const c of cells)bands[clamp(Math.floor(c.luminance/16),0,15)].push(c.noiseSigma);
 const noiseReference=bands.map((_,k)=>{let a=[];for(let j=Math.max(0,k-1);j<=Math.min(15,k+1);j++)for(const value of bands[j])a.push(value);a.sort((a,b)=>a-b);return a.length?a[Math.floor(a.length*.55)]:0;});
 for(let i=0;i<grid.length;i++){
  const c=grid[i];if(!c)continue;const x=i%cols,y=Math.floor(i/cols);let best=0,near=0;
  for(const d of distances){let strongest=0,second=0;
   for(const [dx,dy] of [[d,0],[-d,0],[0,d],[0,-d],[d,d],[-d,d],[d,-d],[-d,-d]]){
    const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=cols||yy>=rows)continue;const r=grid[yy*cols+xx];if(!r)continue;
    // Fine/coarse spectrum and grain change must agree. Brightness alone is irrelevant.
    const spectral=Math.max(Math.log2((r.fineRatio+.02)/(c.fineRatio+.02)),Math.log2((r.gradientRatio+.05)/(c.gradientRatio+.05))*1.3);
    const amplitude=Math.log2((r.detail+.10)/(c.detail+.10));
    const textureSimilarity=Math.exp(-Math.abs(Math.log((r.coarse+.3)/(c.coarse+.3)))*.22);
    const signal=clamp((r.coarse-.14)/.65,0,1)*clamp((c.coarse-.06)/.34,0,1);
    const evidence=clamp((spectral-.35)/1.5,0,1)*clamp((amplitude-.25)/1.6,0,1)*textureSimilarity*signal;
    if(evidence>strongest){second=strongest;strongest=evidence;}else if(evidence>second)second=evidence;
   }
   const value=(strongest*.65+second*.35);if(d<=6)near=Math.max(near,value);best=Math.max(best,value*(d===24?.82:1));
  }
  const reference=noiseReference[clamp(Math.floor(c.luminance/16),0,15)];
  const noiseLoss=clamp((Math.log2((reference+.08)/(c.noiseSigma+.08))-.8)/1.2,0,1);
  const coarseGrain=clamp((1.85-c.gradientRatio)/.65,0,1);
  const noiseEvidence=noiseLoss*coarseGrain*clamp((reference-.6)/.65,0,1);
  raw[i]=Math.max(best,noiseEvidence)*100;c.nearDrop=round(near*100);c.noiseLoss=round(noiseLoss);c.noiseReference=round(reference);
 }
 // Remove isolated spectral outliers. Keep thin boundaries and irregular connected patches.
 const risk=new Float32Array(grid.length);
 for(let i=0;i<grid.length;i++){if(!grid[i])continue;const x=i%cols,y=Math.floor(i/cols);let sum=0,n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<cols&&yy>=0&&yy<rows){sum+=raw[yy*cols+xx];n++;}}risk[i]=raw[i]*.35+sum/n*.65;grid[i].risk=grid[i].dropScore=Math.round(risk[i]);}
 const seen=new Uint8Array(grid.length),candidates=[];
 for(let i=0;i<grid.length;i++)if(!seen[i]&&risk[i]>=48){let queue=[i],head=0,count=0,sum=0,max=0,x0=cols,y0=rows,x1=0,y1=0;seen[i]=1;
  while(head<queue.length){const j=queue[head++],x=j%cols,y=Math.floor(j/cols);count++;sum+=risk[j];max=Math.max(max,risk[j]);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
   for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]){const xx=x+dx,yy=y+dy,k=yy*cols+xx;if(xx>=0&&xx<cols&&yy>=0&&yy<rows&&!seen[k]&&risk[k]>=42){seen[k]=1;queue.push(k);}}
  }
  if(count>=32&&max>=58)candidates.push({x:x0*cellSize,y:y0*cellSize,width:Math.min(width,(x1+1)*cellSize)-x0*cellSize,height:Math.min(height,(y1+1)*cellSize)-y0*cellSize,score:Math.round(sum/count),peak:Math.round(max),cellCount:count,kind:'local-spectrum-drop'});
 }
 candidates.sort((a,b)=>b.cellCount*b.score-a.cellCount*a.score);
 // Keep one review box for a connected affected region, including islands
 // enclosed by its larger box; per-cell risks remain unmodified.
 for(let i=0;i<candidates.length;i++)for(let j=candidates.length-1;j>i;j--){
  const a=candidates[i],b=candidates[j],intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  if(intersection>=b.width*b.height*.9)candidates.splice(j,1);
 }
 const stats={cells:cells.length,expectedCells:cols*rows,missingCells:grid.length-cells.length,candidates:candidates.length,meanScore:round(cells.reduce((s,c)=>s+c.score,0)/Math.max(1,cells.length)),meanRisk:round(cells.reduce((s,c)=>s+c.risk,0)/Math.max(1,cells.length))};
 return{cells,candidates,regions:candidates,stats,version:2};
}
return{DEFAULTS,analyzeTile,analyzeRegion:analyzeTile,finalize};
});
