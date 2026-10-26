(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.V7ToolSilhouettes=api;
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  // One ordinary silhouette asset owns one category. Stable IDs only seed missing
  // entries; users' names, visibility, placement and saved presets remain theirs.
  //
  // ⚠⚠ slot = 这个工具【固定的】出厂座位号（2026-09-29）。出厂摆放位置、以及「用户没动过」的判定
  //   （isFactoryAsset）都按 slot 算，不按它在这张表里排第几。
  //   以前按表里的序号算：删掉海报那一行，后面 7 个工具的序号全部前移一位，老用户库里按旧序号存的
  //   出厂位置全对不上 → 被当成「用户挪过的」直接盖到人像上，「出厂工具改回隐藏」的一次性迁移也会漏掉它们
  //   （AI 修图痕迹检测出厂是显示的，漏掉 = 突然冒出来）。无头测试用的是全新账号，抓不到这个。
  //   规矩：用过的 slot 永不复用（5 = 海报，已删）；新工具往后接着编号。
  const definitions=[
    {slot:0,key:'partition',group:'region',kind:'region-partition',title:'全局分区',module:'V7RegionWorkbench',mode:'partition',description:'读取当前 Photoshop 画布，划分区域并分别安排生成，再预览和传回结果。',path:'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 10h18M10 10v11M15 3v7'},
    {slot:1,key:'tiles',group:'region',kind:'region-tiles',title:'分块增强',module:'V7RegionWorkbench',mode:'tiles',description:'将画布拆成带重叠的网格块，逐块增强并检查拼接边缘。',path:'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6ZM12 2v2M12 20v2M2 12h2M20 12h2'},
    {slot:2,key:'stitch',group:'region',kind:'region-stitch',title:'多区拼接',module:'V7RegionWorkbench',mode:'stitch',description:'建立多个处理区域，分别生成后按原画布位置组合预览与传回。',path:'M3 5h8v14H3ZM13 5h8v14h-8M8 9l4 3-4 3M16 9l-4 3 4 3'},
    {slot:3,key:'dlss',group:'region',kind:'dlss',title:'DLSS',module:'V7DLSS',description:'抓取 Photoshop 选区，调整原尺寸画质增强参数，比较结果并传回图层。',path:'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6M8 16l8-8M10 8h6v6'},
    {slot:4,key:'scene',group:'creative',kind:'scene-pack',title:'场景',module:'V7CreativeTools',mode:'scene',description:'选择场景包、元素与摄影条件，结合当前画布和参考图生成场景。',path:'M3 6h18v14H3ZM3 16l5-5 4 4 3-3 6 6M17 9h.01M7 3h10'},
    {slot:6,key:'hemisynth',group:'creative',kind:'hemisynth',title:'半合成',module:'V7CreativeTools',mode:'hemisynth',description:'围绕人物设置体块、垂悬元素和参考素材，填写结构化描述进行半合成。',path:'M12 3l8 5v8l-8 5-8-5V8ZM12 3v18M4 8l8 5 8-5M7 6l10 13'},
    {slot:7,key:'kao',group:'creative',kind:'kao',title:'尻特效',module:'V7CreativeTools',mode:'kao',description:'抓取 Photoshop 中标注的区域，设置粒子、光学与运动参数生成特效。',path:'M13 3l-2 7 5-2-2 6 5-1-8 8 1-7-5 2 2-6-4 1ZM4 4l1 1M20 6l-1 1M4 19l1-1'},
    {slot:8,key:'color-match',group:'quality',kind:'color-match',title:'双区颜色匹配',module:'V7ColorTools',mode:'match',description:'分别抓取目标区与颜色参考区，调整匹配参数并检查结果后传回。',path:'M3 5h7v14H3ZM14 5h7v14h-7M7 9h10M15 7l2 2-2 2M17 15H7M9 13l-2 2 2 2'},
    {slot:9,key:'color-grade',group:'quality',kind:'color-grade',title:'AI 调色',module:'V7ColorTools',mode:'grade',description:'抓取当前图像，填写调色要求，生成并比较颜色调整结果。',path:'M5 4v16M12 4v16M19 4v16M3 9h4M10 15h4M17 7h4'},
    {slot:10,key:'image-scopes',group:'quality',kind:'image-scopes',title:'图像示波器',module:'V7ImageScopes',description:'读取当前画布，以直方图、波形和矢量视图检查亮度与颜色分布。',path:'M3 4v16h18M6 15l3-8 3 10 3-6 3 3 3-9'},
    {slot:11,key:'batch-queue',group:'manage',kind:'batch-queue',title:'照片批处理',module:'V7BatchQueue',description:'查看并管理本机照片队列，为每项保留图片、区域与参数，按顺序执行。',path:'M7 3h13v14M4 7h12v14H4ZM7 11h6M7 15h6M7 18h3M18 19l2 2 2-2'},
    {slot:12,key:'seam-review',group:'quality',kind:'seam-review',title:'AI 修图痕迹检测',module:'V7SeamReview',description:'抓取当前 Photoshop 文档整张画布，在本机检测疑似 AI 修图痕迹，每处痕迹传回成一个标注图层（装在一个组里）供人工复查。',path:'M3 5h18v14H3ZM7 5v14M17 5v14M3 10h18M3 14h18'},
    // ⭐ 2026-09-29 用户定案：「基础工具」里的 4 件拆成独立工具。入口在 preset-ui.js 的 V7BaseTools：
    //   点它 = 选中那条出厂预设（__matting_default__ 等），三级卡直接出原来那套真参数面板，
    //   ▶ 走的还是 startMatting / startSegment / startSAM2 / startGlow，一条执行链都没新写。
    //   ⚠ kind 必须用 tool-xxx，绝不能用老的 matting / segment / sam2 / glow：
    //     preset-ui 的 fillToolDetail 只要认出是剪影工具就画「工具工作面」启动卡（真参数面板被截胡），
    //     toolDefaultsOf 还会把默认参数清成 {}。
    {slot:13,key:'matting',group:'region',kind:'tool-matting',title:'抠像',module:'V7BaseTools',mode:'matting',description:'抓取 Photoshop 选区，用本机引擎把主体抠出来，传回带蒙版的图层。',path:'M12 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6ZM6 20a6 6 0 0 1 12 0M3 7V3h4M21 7V3h-4M3 17v4h4M21 17v4h-4'},
    {slot:14,key:'segment',group:'region',kind:'tool-segment',title:'人体解析',module:'V7BaseTools',mode:'segment',description:'抓取 Photoshop 选区，本机认出头发、脸、衣服、手臂等部位，每个部位传回成一个带蒙版的图层。',path:'M12 3a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5ZM8 10h8l-1 6H9ZM9 16l-1 5M15 16l1 5M8 10l-3 5M16 10l3 5M8.5 13h7'},
    {slot:15,key:'sam2',group:'region',kind:'tool-sam2',title:'指哪抠哪',module:'V7BaseTools',mode:'sam2',description:'用 Photoshop 选区当框，本机引擎给出几个候选，挑一个传回成蒙版。',path:'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M10 10l8 3.5-3.5 1-1 3.5Z'},
    {slot:16,key:'glow',group:'region',kind:'tool-glow',title:'辉光',module:'V7BaseTools',mode:'glow',description:'抓取 Photoshop 选区，在本机预览里调整辉光，确认后按原尺寸计算并传回。全程本地计算。',path:'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2'},
    // ⭐ 2026-09-29 用户定案：「相机与灯光」其实是 V6 的两个功能（3D 镜头 + 💡 灯光）合在一起了 → 拆回两个工具。
    //   背后还是同一个 V7CameraLight 工作区，按 mode 只露出对应的模式（camera-light.js 的 open(mode)）。
    //   ⚠ kind 同理不能用 'camera-light'：那是用户存过的相机灯光预设的 kind，注册进来会被截胡成启动卡。
    {slot:17,key:'camera',group:'creative',kind:'tool-camera',title:'3D 镜头',module:'V7CameraLight',mode:'camera',description:'抓取当前画面，在 3D 预览里调整机位方向、仰角和距离，按新视角重新生成。',path:'M3 8h4l2-3h6l2 3h4v12H3ZM12 10a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z'},
    {slot:18,key:'light',group:'creative',kind:'tool-light',title:'灯光',module:'V7CameraLight',mode:'light',description:'抓取当前画面，手绘或在 3D 里摆放灯光，也可以自动拆出现有光源，按新布光重新照亮。',path:'M9 18h6M10 21h4M12 3a6 6 0 0 1 3.5 10.9c-.9.7-1.5 1.7-1.5 2.8V17h-4v-.3c0-1.1-.6-2.1-1.5-2.8A6 6 0 0 1 12 3Z'},
    // ⭐ 2026-10-25 用户定：「眼珠随动直接放到工具箱里面去，取名叫眼神调整」（docs/290）。本机引擎算，不收积分
    {slot:19,key:'eyegaze',group:'region',kind:'tool-eyegaze',title:'眼神调整',module:'V7EyeGaze',description:'抓取 Photoshop 选区里的人脸，改眼神方向、挪眼珠、调眼珠和瞳孔大小，拖滑块实时看，确认后把两只眼传回成一个新图层。全程本机计算。',path:'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12ZM12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8ZM13.3 10.6h.01'}
  ].map(row=>Object.freeze({...row,assetId:'__tool_'+row.key+'__',presetId:'__tool_'+row.key+'_default__'}));
  const groups=Object.freeze([
    Object.freeze({key:'region',title:'区域与增强',description:'分块、拼接、画质增强，以及抠像、人体解析、指哪抠哪、辉光和眼神调整。'}),
    Object.freeze({key:'creative',title:'创作与灯光',description:'幕布、场景、半合成、特效、3D 镜头和灯光。'}),
    Object.freeze({key:'quality',title:'颜色与检查',description:'校色、示波器和 AI 修图痕迹检测。'}),
    Object.freeze({key:'manage',title:'批处理与助手',description:'照片批处理、Agent 收件箱和低频资料入口。'})
  ]);
  const groupByKey=new Map(groups.map(row=>[row.key,row]));
  // This is a normal, editable silhouette asset: its opaque pixels are the
  // clickable region. Do not replace it with a fixed corner button.
  const hub=Object.freeze({assetId:'__tool_hub__',title:'工具与功能',x:.025,y:.24,w:.18,h:.12,z:1100,
    path:'M24 6h16a6 6 0 0 1 6 6v6h9a5 5 0 0 1 5 5v13H38v-5H26v5H4V23a5 5 0 0 1 5-5h9v-6a6 6 0 0 1 6-6Zm0 6v6h16v-6ZM4 40h22v5h12v-5h22v12a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6Z'});
  function hubIcon(size=64,color='currentColor',mask=false){
    const pixels=Math.max(12,Math.min(256,Number(size)||64));
    const ink=['currentColor','#ffffff','rgba(235,240,250,.92)'].includes(color)?color:'currentColor';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="'+pixels+'" height="'+pixels+'" fill="'+(mask?ink:'none')+'" stroke="'+ink+'" stroke-width="'+(mask?1:3)+'" stroke-linejoin="round" fill-rule="evenodd" aria-hidden="true"><path d="'+hub.path+'"/></svg>';
  }
  function hubAsset(){
    return {id:hub.assetId,name:hub.title,icon:'',x:hub.x,y:hub.y,w:hub.w,h:hub.h,z:hub.z,hidden:false,builtin:true,
      display:new Blob([hubIcon(256,'rgba(235,240,250,.92)')],{type:'image/svg+xml'}),
      mask:new Blob([hubIcon(256,'#ffffff',true)],{type:'image/svg+xml'})};
  }
  async function ensureHub({assets,putAsset,check=()=>{}}){
    check();
    if(!assets||assets.some(item=>item.id===hub.assetId))return;
    const value=hubAsset();await putAsset(value);check();assets.push(value);
  }
  const byKind=new Map(definitions.map(row=>[row.kind,row]));
  const byId=new Map(definitions.flatMap(row=>[[row.key,row],[row.assetId,row],[row.presetId,row]]));
  const get=value=>byKind.get(value)||byId.get(value)||null;
  const getPreset=preset=>preset&&byKind.get(preset.kind)||null;
  function icon(value,size=24,color='currentColor',mask=false){
    const row=get(value);if(!row)return '';
    const pixels=Math.max(12,Math.min(256,Number(size)||24));
    const ink=['currentColor','#ffffff','rgba(235,240,250,.92)'].includes(color)?color:'currentColor';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="'+pixels+'" height="'+pixels+'" fill="none" stroke="'+ink+'" stroke-width="'+(mask?3:1.75)+'" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+row.path+'"/></svg>';
  }
  // ⭐ 2026-09-29：工具剪影出厂一律隐藏。用户在剪影编辑页把某个工具设成显示，它才钉到主卡剪影上。
  //   （以前 AI 修图痕迹检测出厂是显示的，但被「工具箱」一刀切过滤藏住了，用户看到的一直是全隐藏。）
  // 出厂座位：只看 slot（见 definitions 上方的说明）。index 参数留着兼容老调用，不再参与计算。
  function seedOf(row){
    const slot=row.slot;
    return {x:.04+(slot%2)*.78,y:Math.min(.88,.06+Math.floor(slot/2)*.15),w:.14,h:.094,z:1000+slot};
  }
  function asset(row,index){
    return {id:row.assetId,name:row.title,icon:'',...seedOf(row),hidden:true,builtin:true,
      display:new Blob([icon(row.key,256,'rgba(235,240,250,.92)')],{type:'image/svg+xml'}),
      mask:new Blob([icon(row.key,256,'#ffffff',true)],{type:'image/svg+xml'})};
  }
  function isFactoryAsset(value){
    const row=get(value?.id);
    if(!row||!definitions.includes(row)||value.name!==row.title)return false;
    const seed=seedOf(row);
    if(!Object.keys(seed).every(key=>Number.isFinite(Number(value[key]))&&Math.abs(Number(value[key])-seed[key])<1e-6))return false;
    // Ordinary image replacements do not acquire factory presentation merely
    // because their saved position survived the edit.
    return [['display',icon(row.key,256,'rgba(235,240,250,.92)')],['mask',icon(row.key,256,'#ffffff',true)]]
      .every(([key,svg])=>value[key]?.type==='image/svg+xml'&&value[key].size===svg.length);
  }
  function previewLayout(assets,frame,obstacles=[]){
    const out=new Map(),{width,height,canvasWidth,canvasHeight,canvasLeft,canvasTop}=frame||{};
    if(![width,height,canvasWidth,canvasHeight].every(value=>Number.isFinite(value)&&value>0))return out;
    if(![canvasLeft,canvasTop].every(Number.isFinite))return out;
    const size=24,gap=4,edge=2,inset=12;
    const overlaps=(a,b,pad=0)=>a.x<b.x+b.w+pad&&a.x+a.w>b.x-pad&&a.y<b.y+b.h+pad&&a.y+a.h>b.y-pad;
    // Only spare cells around the unchanged, aspect-correct canvas are
    // available. Never shrink or reflow the person's picture to make room.
    const occupied=[{x:canvasLeft,y:canvasTop,w:canvasWidth,h:canvasHeight},...obstacles];
    for(const a of assets)if(!a.hidden&&!isFactoryAsset(a))occupied.push({x:canvasLeft+a.x*canvasWidth,y:canvasTop+a.y*canvasHeight,w:a.w*canvasWidth,h:a.h*canvasHeight});
    const slots=[];
    const offer=(x,y)=>{
      const rect={x,y,w:size,h:size};
      if(x<edge||y<edge||x+size>width-edge||y+size>height-edge)return;
      if(occupied.some(item=>overlaps(rect,item,edge))||slots.some(item=>overlaps(rect,item,gap)))return;
      slots.push(rect);
    };
    // Row-major pairs keep the existing tool order, with room below the right
    // rail for the card's camera, canvas, inbox and editor controls.
    for(let y=inset;y+size<=height-inset;y+=size+gap){offer(edge,y);offer(width-edge-size,y);}
    for(let x=inset;x+size<=width-inset;x+=size+gap){offer(x,edge);offer(x,height-edge-size);}
    const factory=definitions.map(row=>assets.find(a=>a.id===row.assetId)).filter(a=>a&&!a.hidden&&isFactoryAsset(a));
    factory.forEach((a,index)=>{const slot=slots[index];if(slot)out.set(a.id,{x:(slot.x-canvasLeft)/canvasWidth,y:(slot.y-canvasTop)/canvasHeight,w:slot.w/canvasWidth,h:slot.h/canvasHeight});});
    // A custom aspect can leave no margins. Its saved placement remains the
    // fallback; the ordinary all-presets list always retains every tool entry.
    return out;
  }
  function previewAsset(value,layout){const rect=value&&layout?.get(value.id);return rect?{...value,...rect}:value;}
  function previewHitTest(assets,layout,ux,uy){
    for(let index=assets.length-1;index>=0;index--){
      const source=assets[index];if(source.hidden)continue;
      const a=previewAsset(source,layout);
      if(!(a.w>0&&a.h>0)||ux<a.x||uy<a.y||ux>=a.x+a.w||uy>=a.y+a.h)continue;
      // Rail icons have a full 24px target. Other silhouettes retain their
      // original alpha-mask hit test, including user-edited tool artwork.
      if(layout?.has(a.id))return source;
      if(!a._hit)continue;
      const x=Math.floor((ux-a.x)/a.w*a._hit.w),y=Math.floor((uy-a.y)/a.h*a._hit.h);
      if(x>=0&&y>=0&&x<a._hit.w&&y<a._hit.h&&a._hit.data[y*a._hit.w+x])return source;
    }
    return null;
  }
  function preset(row,parameters={}){
    // These are workflow launchers, not a replacement of the user's persisted
    // project. Saved creative parameter presets continue to pass their content.
    return {id:row.presetId,title:row.title,kind:row.kind,category:row.assetId,content:JSON.stringify(parameters),_isFactory:true,toolLauncher:row.key,source:'builtin-tool'};
  }
  async function ensure({assets,presets,putAsset,putPreset,normalize=value=>value,defaults=()=>({}),check=()=>{}}){
    for(const [index,row] of definitions.entries()){
      check();
      if(assets&&!assets.some(item=>item.id===row.assetId)){const value=asset(row,index);await putAsset(value);check();assets.push(value);}
      if(presets&&!presets.some(item=>item.id===row.presetId)){const value=normalize(preset(row,defaults(row)));await putPreset(value);check();presets.push(value);}
    }
  }
  function available(root,preset){const row=getPreset(preset);return !!row&&typeof root[row.module]?.open==='function';}
  async function open(root,preset){
    const row=getPreset(preset);if(!row)throw new Error('这条预设没有对应的工具工作面');
    // ⭐ 2026-09-29 用户定案「老弹窗全部收掉，大卡是唯一入口」：三级卡的「打开」、全局快捷键 / ▶ 都走到这里，
    //   有大卡就开大卡（和工具列表、剪影上钉的工具同一个落点）。
    //   ⚠ 例外：用户自己存过参数的创作预设（场景/半合成/尻特效）暂时还给老编辑器 —— 那三块大卡还没接真参数，
    //     用大卡打开会把外壳字段写进用户的预设。接好后再去掉这个例外。
    const launcher=preset.id===row.presetId&&preset.toolLauncher===row.key;
    const TW=root.V7ToolWorkbench;
    if(TW&&typeof TW.has==='function'&&TW.has(row.key)&&TW.canOpen?.()&&(launcher||row.module!=='V7CreativeTools'))return TW.open(row.key,preset);
    const api=root[row.module];if(typeof api?.open!=='function')throw new Error(row.title+'工具未加载，请重新打开软件');
    if(row.module==='V7CreativeTools')return api.open(row.mode,preset.id===row.presetId&&preset.toolLauncher===row.key?undefined:preset);
    if(row.mode)return api.open(row.mode);
    return api.open();
  }
  return {definitions:Object.freeze(definitions),groups,group:key=>groupByKey.get(key)||null,hub,hubIcon,hubAsset,ensureHub,get,getPreset,icon,asset,preset,ensure,available,open,isFactoryAsset,previewLayout,previewAsset,previewHitTest};
});
