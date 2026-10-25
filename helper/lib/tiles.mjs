import sharp from 'sharp';

export function planTiles(width, height, size = 1024, overlap = 128) {
  if (![width,height,size,overlap].every(Number.isInteger) || width<1 || height<1 || size<128 || size>4096 || overlap<0 || overlap>=size/2) throw new Error('分块尺寸或重叠参数无效');
  const axis=n=>{const points=[0];while(points.at(-1)+size<n)points.push(Math.min(points.at(-1)+size-overlap,n-size));return points;};
  const xs=axis(width),ys=axis(height);
  if(xs.length*ys.length>100 || width*height>40000000)throw new Error('最多 100 块、4000 万像素，请增大块尺寸或缩小原图');
  return ys.flatMap((top,row)=>xs.map((left,column)=>({left,top,width:Math.min(size,width),height:Math.min(size,height),row,column})));
}

// Blend weighted, premultiplied RGBA so transparent edges never become black seams.
export async function mergeTiles(width,height,tiles,overlap,outPath) {
  if(width*height>40000000)throw new Error('画布过大');
  const rgba=new Float32Array(width*height*4),weights=new Float32Array(width*height);
  for(const tile of tiles){
    const r=tile.region;
    const data=await sharp(tile.path).resize(r.width,r.height,{fit:'fill'}).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
      const ramp=(p,n,start,total)=>overlap?Math.min(1,start>0?(p+1)/(overlap+1):1,start+n<total?(n-p)/(overlap+1):1):1;
      const w=ramp(x,r.width,r.left,width)*ramp(y,r.height,r.top,height);
      const src=(y*r.width+x)*4,dst=(y+r.top)*width+x+r.left,a=data[src+3]/255;
      weights[dst]+=w;rgba[dst*4+3]+=a*w;
      for(let c=0;c<3;c++)rgba[dst*4+c]+=data[src+c]*a*w;
    }
  }
  const output=Buffer.alloc(width*height*4);
  for(let i=0;i<weights.length;i++){
    if(!weights[i])throw new Error('分块结果未覆盖完整画布，未生成合成图');
    const alpha=rgba[i*4+3];output[i*4+3]=Math.round(alpha/weights[i]*255);
    for(let c=0;c<3;c++)output[i*4+c]=alpha?Math.round(rgba[i*4+c]/alpha):0;
  }
  await sharp(output,{raw:{width,height,channels:4}}).png().toFile(outPath);return outPath;
}
