(function(root){
  'use strict';
  let host={},current=null,hooked=false,scopeEpoch=0;
  const preferenceKey=()=>root.WHEELCHAIR_STORAGE?.key('image-scopes.v1')||'wheelchair.image-scopes.v1';
  function analyze(width,height,pixels){
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>4194304||pixels.length!==width*height*4)throw new Error('示波器图像尺寸或像素数据无效');
    const histogram=Array.from({length:4},()=>new Uint32Array(256)),luma=new Uint32Array(65536),rgb=new Uint32Array(3*65536),vectors=new Uint32Array(65536);let count=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const offset=(y*width+x)*4;if(!pixels[offset+3])continue;count++;
      const r=pixels[offset],g=pixels[offset+1],b=pixels[offset+2],value=Math.round(.2126*r+.7152*g+.0722*b),column=Math.min(255,Math.floor(x/width*256));
      histogram[0][r]++;histogram[1][g]++;histogram[2][b]++;histogram[3][value]++;luma[(255-value)*256+column]++;
      for(const [index,v]of [r,g,b].entries())rgb[index*65536+(255-v)*256+column]++;
      const cb=Math.max(0,Math.min(255,Math.round(128-.114572*r-.385428*g+.5*b))),cr=Math.max(0,Math.min(255,Math.round(128+.5*r-.454153*g-.045847*b)));vectors[(255-cr)*256+cb]++;
    }
    return {histogram,luma,rgb,vectors,count,width,height};
  }
  function density(ctx,values,offset,width,height,color,range,gain=1){
    let maximum=0;for(let i=offset;i<offset+65536;i++)maximum=Math.max(maximum,values[i]);
    ctx.fillStyle=color;if(!maximum)return;
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){
      const value=values[offset+y*256+x];if(!value)continue;
      const px=(x-128)*gain+128,py=range?(range.high-(255-y))/(range.high-range.low)*255:(y-128)*gain+128;
      if(px<0||px>=256||py<0||py>=256)continue;
      ctx.globalAlpha=Math.max(.18,Math.log1p(value)/Math.log1p(maximum));ctx.fillRect(px/256*width,py/256*height,Math.max(1,width/256),Math.max(1,height/256));
    }ctx.globalAlpha=1;
  }
  function paint(canvas,type,result,prefs){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    ctx.fillStyle='#10131a';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#394150';ctx.lineWidth=1;
    // ⭐ 2026-09-29 用户要求：矢量示波器是【正圆】。以前圆和色度点都按画布宽高分别拉伸，画布不是正方形就成了椭圆。
    //   现在矢量图只画在居中的正方形里（边长 = 短边），圆、十字线、肤色线、色度点都按同一个边长算；
    //   没有结果时也画出刻度圆，一眼看得出是矢量图。其余三种图的横线网格不变。
    if(type==='vector'){
      const s=Math.min(w,h),ox=(w-s)/2,oy=(h-s)/2,cx=w/2,cy=h/2,r=s*.42;
      if(result){ctx.save();ctx.translate(ox,oy);density(ctx,result.vectors,0,s,s,'#a8d6b2',null,prefs.gain);ctx.restore();}
      ctx.strokeStyle='#8a94a8';ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.stroke();
      if(result&&prefs.skin){ctx.strokeStyle='#c4a57e';ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx-Math.cos(Math.PI/3)*r,cy-Math.sin(Math.PI/3)*r);ctx.stroke();}
      return;
    }
    for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(0,h*i/4);ctx.lineTo(w,h*i/4);ctx.stroke();}
    if(!result)return;
    const range={full:{low:0,high:255},broadcast:{low:16,high:235},extended:{low:0,high:281}}[prefs.range];
    if(type==='luma')density(ctx,result.luma,0,w,h,'#d7e8dd',range);
    if(type==='rgb')for(const [i,color]of ['#ff7373','#6de099','#6aa7ff'].entries()){ctx.save();ctx.translate(i*w/3,0);density(ctx,result.rgb,i*65536,w/3,h,color,range);ctx.restore();}
    if(type==='histogram'){
      const scale=v=>prefs.log?Math.log1p(v):v;let maximum=1;for(const values of result.histogram)for(const value of values)maximum=Math.max(maximum,scale(value));
      for(const [i,color]of ['#ff7373','#6de099','#6aa7ff','#d7e8dd'].entries()){
        ctx.strokeStyle=color;ctx.beginPath();for(let x=0;x<256;x++){const px=x/255*w,py=h-scale(result.histogram[i][x])/maximum*(h-4);if(x)ctx.lineTo(px,py);else ctx.moveTo(px,py);}ctx.stroke();
      }
    }
  }
  function create(container,options={}){
    if(current?.handle.dialog.isConnected)return current.handle;
    if(!hooked&&root.uiwin?.link?.onEvent){hooked=true;root.uiwin.link.onEvent(event=>{if(current?.prefs.auto&&event?.type==='project:document'&&['changed','exported'].includes(event.kind)){clearTimeout(current.timer);current.timer=setTimeout(()=>refresh(),300);}});}
    const render=handle=>{
      const defaults={quality:512,range:'full',gain:1,log:true,skin:true,auto:true};let saved={};try{saved=JSON.parse(localStorage.getItem(preferenceKey())||'{}');}catch(_){}
      const prefs={...defaults,...saved};if(![128,256,512,1024,2048].includes(prefs.quality))prefs.quality=512;if(!['full','broadcast','extended'].includes(prefs.range))prefs.range='full';if(![1,2,4,8].includes(prefs.gain))prefs.gain=1;
      const controls=document.createElement('div');controls.className='scope-controls';controls.innerHTML='<label>采样长边<select data-scope-option="quality">'+[128,256,512,1024,2048].map(v=>'<option>'+v+'</option>').join('')+'</select></label><label>亮度范围<select data-scope-option="range"><option value="full">0–255</option><option value="broadcast">16–235</option><option value="extended">0–110%</option></select></label><label>色度倍率<select data-scope-option="gain">'+[1,2,4,8].map(v=>'<option value="'+v+'">'+v+'×</option>').join('')+'</select></label><label><input type="checkbox" data-scope-option="log">对数直方图</label><label><input type="checkbox" data-scope-option="skin">肤色参考线</label><label><input type="checkbox" data-scope-option="auto">文档变化时刷新</label>';
      const grid=document.createElement('div');grid.className='scope-grid';for(const [type,title]of [['luma','亮度波形'],['rgb','RGB 分量'],['vector','色度矢量'],['histogram','RGB / 亮度直方图']]){const figure=document.createElement('figure'),label=document.createElement('figcaption'),canvas=document.createElement('canvas');label.textContent=title;canvas.width=512;canvas.height=256;canvas.dataset.scope=type;canvas.setAttribute('aria-label',title);figure.append(label,canvas);grid.append(figure);}
      const note=document.createElement('p');note.className='settings-note';note.textContent='按 8 位 RGB 采样计算，亮度使用 Rec.709 系数；广播范围仅为参考显示，不是视频合法化检测。肤色参考线不能判断肤色是否正确。';
      const button=document.createElement('button');button.className='settings-btn';button.textContent='刷新整图';button.dataset.scopeRefresh='';button.onclick=refresh;
      handle.body.append(controls,grid,note);handle.footer.append(button);
      const state=current={handle,prefs,button,result:null,closed:false,busy:false,timer:null,key:preferenceKey(),epoch:scopeEpoch};
      controls.querySelectorAll('[data-scope-option]').forEach(input=>{const key=input.dataset.scopeOption;if(input.type==='checkbox')input.checked=!!prefs[key];else input.value=prefs[key];input.onchange=()=>{if(!isCurrent(state))return;prefs[key]=input.type==='checkbox'?input.checked:['gain','quality'].includes(key)?Number(input.value):input.value;try{localStorage.setItem(state.key,JSON.stringify(prefs));}catch(error){root.ERR?.report('IMAGE_SCOPES_FAILED',{message:error.message});}if(key==='quality')refresh();else draw();};});
      draw();refresh();
      return ()=>{state.closed=true;clearTimeout(state.timer);state.worker?.terminate();state.cancel?.();state.result=null;if(current===state)current=null;};
    };
    const args=['scopes','图像示波器','整张 Photoshop 文档的采样分析；不改变图层、选区或颜色。',render];
    return container?root.V7Workspaces.mount(container,...args,options):root.V7Workspaces.open(...args);
  }
  function isCurrent(state){return current===state&&!state.closed&&state.epoch===scopeEpoch&&state.key===preferenceKey();}
  function draw(){if(current)current.handle.body.querySelectorAll('canvas[data-scope]').forEach(canvas=>paint(canvas,canvas.dataset.scope,current.result,current.prefs));}
  async function refresh(){const state=current;if(!state||!isCurrent(state))return;if(state.busy){state.refreshQueued=true;return;}state.busy=true;state.button.disabled=true;state.handle.state.textContent='正在读取整张文档…';
    try{
      const capture=await host.capture(state.prefs.quality);if(!isCurrent(state))return;
      const bitmap=await createImageBitmap(capture.blob);
      try{
        if(!isCurrent(state))return;
        const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height);
        const result=await new Promise((resolve,reject)=>{
          const worker=state.worker=new Worker('image-scopes-worker.js');state.cancel=()=>reject(new Error('示波器已关闭'));
          const finish=()=>{worker.terminate();state.worker=null;state.cancel=null;};
          worker.onmessage=event=>{finish();event.data.ok?resolve(event.data.result):reject(new Error(event.data.error));};
          worker.onerror=()=>{finish();reject(new Error('采样计算中断，请降低采样长边后重试'));};
          worker.postMessage({width:bitmap.width,height:bitmap.height,pixels:pixels.data},[pixels.data.buffer]);
        });
        if(!isCurrent(state))return;state.result=result;
      }finally{bitmap.close();}
      if(!isCurrent(state))return;draw();state.handle.state.textContent=capture.name+' · '+state.result.width+' × '+state.result.height+' · '+new Date().toLocaleTimeString('zh-CN');
    }
    catch(error){if(isCurrent(state)){state.result=null;draw();state.handle.state.textContent='读取失败：'+error.message;root.ERR?.report('IMAGE_SCOPES_FAILED',{message:error.message});}}
    finally{state.busy=false;if(isCurrent(state)){state.button.disabled=false;if(state.refreshQueued){state.refreshQueued=false;refresh();}}}
  }
  // ⭐ 给工具大卡用（2026-09-29）：读整张文档 + 后台线程采样，把结果交给调用方自己用 paint 画。
  //   不开任何窗口（用户定案：老弹窗全部收掉，大卡是唯一入口）。只读，不改图层、选区或颜色。
  //   options.doc = 刚用 probe() 问到的文档信息（实时轮询时传进来，省一次往返）。
  async function sample(options={}){
    const quality=[128,256,512,1024,2048].includes(Number(options.quality))?Number(options.quality):512;
    if(typeof host.capture!=='function')throw new Error('示波器没有接好 Photoshop 读取，请重新打开软件');
    const epoch=scopeEpoch,capture=await host.capture(quality,options.doc);
    if(epoch!==scopeEpoch)throw new Error('账号已切换，本次采样作废');
    const bitmap=await createImageBitmap(capture.blob);
    try{
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
      const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height);
      const result=await new Promise((resolve,reject)=>{
        const worker=new Worker('image-scopes-worker.js');
        worker.onmessage=event=>{worker.terminate();event.data.ok?resolve(event.data.result):reject(new Error(event.data.error));};
        worker.onerror=()=>{worker.terminate();reject(new Error('采样计算中断，请降低采样长边后重试'));};
        worker.postMessage({width:bitmap.width,height:bitmap.height,pixels:pixels.data},[pixels.data.buffer]);
      });
      if(epoch!==scopeEpoch)throw new Error('账号已切换，本次采样作废');
      return {result,name:capture.name||''};
    }finally{bitmap.close();}
  }
  // ⭐ 实时轮询用（2026-09-29）：只读当前文档信息（含 historyStateId），不读像素。
  //   大卡每秒问一次，历史记录编号变了（画一笔 / 撤销 / 改显隐 / 换文档）才调 sample() 真读画布。
  async function probe(){
    if(typeof host.docInfo!=='function')throw new Error('示波器没有接好 Photoshop 读取，请重新打开软件');
    const epoch=scopeEpoch,info=await host.docInfo();
    if(epoch!==scopeEpoch)throw new Error('账号已切换，本次采样作废');
    return info;
  }
  root.addEventListener?.('wheelchair:storage-context',()=>{scopeEpoch++;if(current)(current.handle.forceClose||current.handle.close)();});
  root.V7ImageScopes={configure:value=>{host=value||{};},open:options=>create(null,options),mount:(container,options)=>create(container,options),sample,probe,analyze,paint};
})(typeof window!=='undefined'?window:globalThis);
