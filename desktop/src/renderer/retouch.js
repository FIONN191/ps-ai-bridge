(()=>{
 const card=document.createElement('article');card.className='studio-card';card.innerHTML=`<h3>独立修图与变化检查</h3><p class="mute">先预览，再保存独立结果。颜色匹配只改变颜色；变化检查是建议，不能判定 AI 修改是否正确。</p><div class="row"><button id="rtSource">选择待调整图</button><button id="rtCurrent">使用最近查看结果</button><button id="rtReference">选择参考原图</button></div><div class="retouch-images"><figure><canvas id="rtSourceCanvas" width="360" height="240"></canvas><figcaption id="rtSourceLabel">待调整图（拖框采样）</figcaption></figure><figure><canvas id="rtRefCanvas" width="360" height="240"></canvas><figcaption id="rtRefLabel">参考图（拖框采样）</figcaption></figure></div><label class="field">工具<select id="rtMode"><option value="match">双区颜色匹配</option><option value="variant">独立对齐 / 校色 / 强度</option><option value="glow">阈值辉光与独立光效层</option><option value="inspect">变化 / 痕迹检查建议</option></select></label><label id="rtStrengthField" class="field">强度<input id="rtStrength" type="range" min="0" max="1" step=".05" value="1"></label><div id="rtVariant"><label class="check"><input id="rtAlign" type="checkbox">快速对齐</label><label class="field">校色<select id="rtCC"><option value="none">不校色</option><option value="global">全局</option><option value="precise">精准（保护变化区）</option><option value="mixed">混合（保护变化区）</option></select></label><label class="check"><input id="rtTexture" type="checkbox">纹理补偿</label></div><div id="rtGlow"><label class="field">亮度阈值 / 检查阈值<input id="rtThreshold" type="range" min="0" max="1" step=".01" value=".7"></label><label id="rtRadiusField" class="field">模糊半径<input id="rtRadius" type="number" min=".3" max="100" value="12" step=".1"></label><label id="rtBlendField" class="field">混合<select id="rtBlend"><option value="screen">滤色</option><option value="add">线性减淡（添加）</option><option value="soft-light">柔光</option></select></label></div><div class="row"><button id="rtPreview">计算预览</button><button id="rtSave" disabled>保存结果</button><button id="rtSaveLayer" disabled>保存独立光效层</button></div><p id="rtStatus" class="mute"></p><img id="rtOutput" class="tool-preview" hidden><div id="rtLocateControls" hidden><p class="mute">点候选可高亮源图。定位 PS 仅适用于源图对应完整画布、且像素尺寸相同的文档；不会生成或贴回图片。定位会更改所选文档的选区。</p><div class="row"><button id="rtDocuments">读取 PS 文档</button><label class="field">明确选择定位目标<select id="rtTarget"><option value="">仅高亮源图（未选择 PS 文档）</option></select></label></div><p id="rtLocateStatus" class="mute" role="status"></p></div><div id="rtReport"></div>`;
 $('tab-studio').querySelector('.studio-grid').append(card);
 let source=null,reference=null,preview=null,version=0,viewed=null,highlighted=-1,documents=[],locating=false,saving=false;
 const rois={source:{x:0,y:0,w:1,h:1},reference:{x:0,y:0,w:1,h:1}},images={},imageVersions={source:0,reference:0};
 const guard=fn=>async(...args)=>{try{await fn(...args);}catch(e){$('rtStatus').textContent=reason(e);toast(reason(e),true);}};
 const canvas=kind=>$(kind==='source'?'rtSourceCanvas':'rtRefCanvas');
 function selectedTarget(){const i=$('rtTarget').value;return i===''?null:documents[Number(i)];}
 function matchingTarget(){const t=selectedTarget();return !!(t&&preview&&t.width===preview.width&&t.height===preview.height);}
 function draw(kind){
  const c=canvas(kind),ctx=c.getContext('2d'),im=images[kind];ctx.clearRect(0,0,c.width,c.height);if(!im)return;
  ctx.drawImage(im,0,0,c.width,c.height);
  if(kind==='source'&&preview?.report){
   for(const [i,r]of preview.report.regions.entries()){
    const x=r.left/preview.width*c.width,y=r.top/preview.height*c.height,w=(r.right-r.left)/preview.width*c.width,h=(r.bottom-r.top)/preview.height*c.height;
    ctx.strokeStyle=i===highlighted?'#ffdc60':'#ff786e';ctx.lineWidth=i===highlighted?4:1;ctx.strokeRect(x,y,w,h);
    if(i===highlighted){ctx.fillStyle='rgba(255,220,96,.18)';ctx.fillRect(x,y,w,h);ctx.fillStyle='#ffdc60';ctx.font='14px sans-serif';ctx.fillText(String(i+1),x+4,y+16);}
   }
  }else{const r=rois[kind];ctx.strokeStyle='#bba5ff';ctx.lineWidth=3;ctx.strokeRect(r.x*c.width,r.y*c.height,r.w*c.width,r.h*c.height);}
 }
 function renderReport(){
  const report=preview?.report;$('rtLocateControls').hidden=!report;
  if(!report){$('rtReport').textContent='';return;}
  $('rtReport').innerHTML=`<p>${report.regions.length} 个变化候选 · ${esc(report.algorithm)}</p>`+report.regions.map((r,i)=>`<div class="row"><button data-highlight="${i}" aria-pressed="${i===highlighted}">${i===highlighted?'▶ ':''}候选 ${i+1} · ${r.score.toFixed(3)} · (${r.left}, ${r.top})–(${r.right}, ${r.bottom})</button><button data-locate="${i}" ${!matchingTarget()||locating?'disabled':''}>在所选 PS 文档定位</button></div>`).join('');
 }
 function invalidate(){
  version++;preview=null;highlighted=-1;$('rtSave').disabled=true;$('rtSaveLayer').disabled=true;$('rtOutput').hidden=true;$('rtLocateStatus').textContent='';renderReport();draw('source');
 }
 async function loadImage(kind,path){
  const serial=++imageVersions[kind],im=new Image();
  await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=()=>reject(new Error('图片读取失败，请重新选择'));im.src=url(path);});
  if(serial!==imageVersions[kind])return;
  const c=canvas(kind);const scale=Math.min(360/im.width,420/im.height);c.width=Math.max(1,Math.round(im.width*scale));c.height=Math.max(1,Math.round(im.height*scale));images[kind]=im;draw(kind);
 }
 async function load(kind,r){
  if(kind==='source'){source=r;$('rtTarget').value='';}else reference=r;
  rois[kind]={x:0,y:0,w:1,h:1};invalidate();delete images[kind];draw(kind);
  await loadImage(kind,r.jobId?`/jobs/${encodeURIComponent(r.jobId)}/result`:`/uploads/${encodeURIComponent(r.uploadId)}`);
  $(kind==='source'?'rtSourceLabel':'rtRefLabel').textContent=`${r.name||r.jobId||'图片'} · 拖框选取匹配区域`;
 }
 function highlight(index){
  if(!preview?.report?.regions[index])throw new Error('预览已改变，请重新计算');
  highlighted=index;draw('source');renderReport();
  const r=preview.report.regions[index];$('rtLocateStatus').textContent=`源图已高亮候选 ${index+1}：(${r.left}, ${r.top})–(${r.right}, ${r.bottom})。这些是变化建议。`;
 }
 for(const kind of ['source','reference']){
  const c=canvas(kind);let start=null;
  const point=e=>{const b=c.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};};
  c.onpointerdown=guard(async e=>{
   if(!images[kind]||locating)return;
   if(kind==='source'&&preview?.report){const p=point(e),x=p.x*preview.width,y=p.y*preview.height;const i=preview.report.regions.findIndex(r=>x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom);if(i>=0)highlight(i);return;}
   start=point(e);c.setPointerCapture(e.pointerId);
  });
  c.onpointermove=e=>{if(!start)return;const p=point(e);rois[kind]={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};draw(kind);};
  c.onpointerup=c.onpointercancel=()=>{if(start){const r=rois[kind];if(r.w<.005||r.h<.005)rois[kind]={x:0,y:0,w:1,h:1};start=null;invalidate();draw(kind);}};
 }
 $('rtSource').onclick=guard(async()=>{const[r]=await window.bridge.pickImages('original',false);if(r)await load('source',r);});
 $('rtReference').onclick=guard(async()=>{const[r]=await window.bridge.pickImages('original',false);if(r)await load('reference',r);});
 $('rtCurrent').onclick=guard(async()=>{const id=work.viewer?.jobId||viewed;if(!id)throw new Error('先在工作台查看一张结果');await load('source',{jobId:id});});
 new MutationObserver(()=>{if(work.viewer?.jobId)viewed=work.viewer.jobId;}).observe($('vMeta'),{childList:true});
 function modeVisibility(){
  const mode=$('rtMode').value;$('rtVariant').hidden=mode!=='variant';$('rtGlow').hidden=!['glow','inspect'].includes(mode);
  $('rtRadiusField').hidden=mode!=='glow';$('rtBlendField').hidden=mode!=='glow';$('rtStrengthField').hidden=mode==='inspect';
 }
 for(const id of ['rtStrength','rtAlign','rtCC','rtTexture','rtThreshold','rtRadius','rtBlend'])$(id).oninput=invalidate;
 $('rtMode').onchange=()=>{invalidate();modeVisibility();if(['glow','inspect'].includes($('rtMode').value))$('rtThreshold').value=$('rtMode').value==='inspect'?.18:.7;};modeVisibility();
 $('rtPreview').onclick=guard(async()=>{
  if(!source)throw new Error('先选择待调整图');const mode=$('rtMode').value;if(mode!=='glow'&&!reference)throw new Error('此工具需要参考原图');
  invalidate();const rev=version;$('rtPreview').disabled=true;$('rtStatus').textContent='正在计算…';
  try{
   const r=await api('POST',`/retouch/${mode}`,{source,reference,sourceROI:rois.source,referenceROI:rois.reference,strength:Number($('rtStrength').value),align:$('rtAlign').checked,cc:$('rtCC').value,texture:$('rtTexture').checked,threshold:Number($('rtThreshold').value),radius:Number($('rtRadius').value),blend:$('rtBlend').value});
   if(rev!==version)return;
   if(r.sourceUploadId)await loadImage('source',`/uploads/${encodeURIComponent(r.sourceUploadId)}`);
   if(rev!==version)return;
   preview=r;$('rtOutput').src=url(`/uploads/${r.uploadId}`);$('rtOutput').hidden=false;$('rtSave').disabled=false;$('rtSaveLayer').disabled=!r.layerUploadId;
   const alignment=r.parameters?.alignment;
   $('rtStatus').textContent=r.report?.notice||`预览完成，保存会使用这一份像素结果${r.parameters?.align?alignment?.applied?' · 对齐已应用':' · 未发现可靠位移，未应用对齐':''}`;
   $('rtSourceLabel').textContent=r.report?`源图 ${r.width}×${r.height} · 点击候选矩形高亮`:`待调整图 ${r.width}×${r.height} · 拖框采样`;
   draw('source');renderReport();
  }finally{$('rtPreview').disabled=false;}
 });
 $('rtDocuments').onclick=guard(async()=>{
  const r=await api('POST','/bridge/ps',{type:'documents'});if(!Array.isArray(r.documents))throw new Error('PS 未返回文档列表');
  documents=r.documents.map(d=>{const t=d.target||d;return {session:t.session,docId:t.docId,width:t.width,height:t.height,name:t.name};});
  $('rtTarget').innerHTML='<option value="">仅高亮源图（请选择完整画布对应文档）</option>'+documents.map((d,i)=>`<option value="${i}" ${d.width!==preview?.width||d.height!==preview?.height?'disabled':''}>${esc(d.name)} · #${d.docId} · ${d.width}×${d.height}${d.width!==preview?.width||d.height!==preview?.height?'（尺寸不匹配）':''}</option>`).join('');
  $('rtTarget').value='';renderReport();
 });
 $('rtTarget').onchange=()=>{renderReport();const t=selectedTarget();$('rtLocateStatus').textContent=t?`定位目标：${t.name} · 文档 ${t.docId} · 会话 ${t.session}。请确认源图对应此文档完整画布。`:'仅高亮源图；未选择 PS 文档。';};
 $('rtReport').onclick=guard(async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.highlight!==undefined)highlight(Number(b.dataset.highlight));
  if(b.dataset.locate!==undefined){
   if(locating||!matchingTarget())throw new Error('先明确选择与源图完整画布同尺寸的 PS 文档');
   const index=Number(b.dataset.locate),p=preview,target={...selectedTarget()};highlight(index);locating=true;renderReport();
   const controls=[...card.querySelectorAll('input,select,button')],disabled=controls.map(c=>c.disabled);controls.forEach(c=>{c.disabled=true;});
   $('rtLocateStatus').textContent='正在核对目标并捕获候选区域，然后定位选区…';
   try{const result=await api('POST','/retouch/locate',{id:p.id,index,target});if(preview===p)$('rtLocateStatus').textContent=`已定位「${result.target.name}」文档 #${result.target.docId} · 候选 ${index+1}。没有生成或贴回图片。`;}
   catch(e){$('rtLocateStatus').textContent=`PS 定位未确认：${reason(e)}。源图高亮仍可查看。`;throw e;}
   finally{locating=false;controls.forEach((c,i)=>{c.disabled=disabled[i];});renderReport();}
  }
 });
 async function save(layer){
  if(!preview)throw new Error('参数已变，请重新预览');if(saving)return;const p=preview;saving=true;$('rtSave').disabled=true;$('rtSaveLayer').disabled=true;
  try{const r=await api('POST','/retouch/save',{id:p.id,layer});await refreshJobs();const j=work.jobs.find(j=>j.id===r.jobId);if(j)openViewer(j.groupId,j.id);toast(layer?'光效层已保存。贴回后可在 PS 调整混合模式。':'独立结果已保存');}
  finally{saving=false;$('rtSave').disabled=!preview;$('rtSaveLayer').disabled=!preview?.layerUploadId;}
 }
 $('rtSave').onclick=guard(()=>save(false));$('rtSaveLayer').onclick=guard(()=>save(true));
})();
