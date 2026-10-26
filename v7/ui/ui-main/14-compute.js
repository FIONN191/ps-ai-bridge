// ═══ ui-main/14-compute.js —— 主界面主程序第 14 / 21 段 ═══
//   管什么：细节补偿档位 · 校色方式标签 · 「开始计算」总入口
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 细节补偿档位（2026-09-12 用户定案）═══════════════════
//
// ⭐⭐ 核心设计：**AI 那张图一个像素都不动。**
//   补过细节的图作为【独立图层】贴到 AI 图层正上方，再建剪切蒙版嵌进去。
//   —— 用户在 PS 里点一下眼睛就能对比补偿前后；不想要就删掉那一层；
//      换档位就是"删掉旧的那层、贴一层新的"。全程可逆。
//   做法照抄 V6 `tiles/tile-colormatch.host.js` 的 placeColormatchItems。
//
// ⚠ 为什么不做成"生成时就补好"：
//   实测老默认值是负收益（只对齐 12.86 → 补完 11.93，比不补还糊，见 docs/33 第九节），
//   所以主链路的 detailBoost 默认关了。这里是【用户挑中满意的那张之后】
//   才按需补一次 —— 大部分人只会补一两张，不会整批补。
//
// ⚠ 不给剪切层单独羽化：剪切蒙版天生受下面那层的形状和蒙版约束，
//   AI 图层贴回时已经羽化过了，再羽化一次等于把边缘缩两遍。
// ⚠ DETAIL_TIERS 不在这里 —— 它被 buildPreview(靠前得多)用到，
//   留在这儿会撞 const 的暂时性死区（铁律 17 那条"脚本抛错死掉、后面绑定全没跑"）。
//   定义挪到了 buildPreview 上方，搜 "DETAIL_TIERS" 找得到。
const detailBusy=new Set();                       // 阀①：同一张正在跑就不重复受理
const detailKey=(task,i)=>String(task.taskId||task.id)+':'+i;

// 读一张已存图片的像素。⚠ 走 blob URL，不经过 base64（docs/21）
function detailPixels(imgId){
  return window.IMG.fullUrl(imgId).then(url=>new Promise((res,rej)=>{
    const im=new Image();
    im.onload=()=>{
      const w=im.naturalWidth||im.width, h=im.naturalHeight||im.height;
      if(!w||!h){rej(new Error('图片尺寸无效'));return;}
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      const cx=cv.getContext('2d',{willReadFrequently:true});
      cx.drawImage(im,0,0);
      res({data:cx.getImageData(0,0,w,h).data,width:w,height:h});
    };
    im.onerror=()=>rej(new Error('图片解码失败'));
    // ⚠ 这个 URL 归 IMG 管，用完【不要】revoke —— 它还要给别处用
    im.src=url;
  }));
}
// 像素 → base64（只在递给桥的那一刻存在，不留在任何对象里）
function detailToBase64(img){
  const cv=document.createElement('canvas'); cv.width=img.width; cv.height=img.height;
  cv.getContext('2d').putImageData(new ImageData(img.data,img.width,img.height),0,0);
  return new Promise((res,rej)=>cv.toBlob(b=>{
    if(!b){rej(new Error('图片编码失败'));return;}
    const fr=new FileReader();
    fr.onload=()=>res(String(fr.result).split(',')[1]);
    fr.onerror=()=>rej(new Error('图片编码失败'));
    fr.readAsDataURL(b);
  },'image/png'));
}
// 发一条桥命令并等真回执。⚠ linkQueue 的回调和 then 都可能先到，要有 settled 闸
function linkOnce(action,params){
  return new Promise(resolve=>{
    let settled=false;
    const done=v=>{ if(!settled){ settled=true; resolve(v); } };
    linkQueue(action,params,{
      after:data=>done({ok:true,data}),
      afterError:result=>done({ok:false,error:linkResultMessage(result)})
    }).then(reply=>{ if(reply&&!reply.ok) done({ok:false,error:reply.error||'入队失败'}); })
      .catch(e=>done({ok:false,error:(e&&e.message)||String(e)}));
  });
}

async function applyDetailTier(task, shotIndex, tier, transferGuard){
  const T=DETAIL_TIERS[tier];
  if(!T||!task) return;
  if(transferGuard&&!transferGuard()) return aiDetachedTransfer(false);
  const taskId=task.taskId||task.id;
  // ⚠⚠ 必须重新取【最新的】任务对象（2026-09-13 修）。
  //   按钮是在 buildPreview 里绑的，闭包里捕获的是【那次渲染时】的快照。
  //   补完一次之后如果没重绘，闭包里的 shot.detailTier / detailLayerId 还是旧的：
  //     · 幂等阀会失效 → 同一档能连点两次，PS 里叠出两层
  //     · 删旧层时拿到过期的图层 ID → 删错人或者删不掉
  task=taskById(taskId)||task;
  const ownsTask=aiTaskContextGuard(task);
  const ownsDetail=()=>ownsTask()&&(!transferGuard||transferGuard());
  if(!ownsDetail()) return aiDetachedTransfer(false);
  const key=detailKey(task,shotIndex);
  if(detailBusy.has(key)) return;                                   // 阀①
  const shots=Array.isArray(task.shots)?task.shots:[];
  const shot=shots[shotIndex];
  if(!shot||!shot.imgId||shot.restoreState!=='done'){
    aiAddLog('第 '+(shotIndex+1)+' 张还没准备好，不能补细节','warn'); aiRefreshInPlace(); return;
  }
  // 阀②：幂等。已经是这一档就什么都不做，不能贴出第二层
  if(String(shot.detailTier||'')===tier){
    aiAddLog('第 '+(shotIndex+1)+' 张已经是「'+T.label+'」档了','info'); aiRefreshInPlace(); return;
  }
  // 阀③：没有"递交给 AI 的原图"就没有原料。老任务/清过缓存的会撞到这里，
  //   必须说清楚为什么，不能点了没反应。
  if(!task.sourceImgId||!window.IMG.has(task.sourceImgId)){
    if(window.ERR) ERR.report('DETAIL_NO_SOURCE',{message:'这个任务没有留下递交给 AI 的原图',
      context:{'为什么补不了':'细节要从原图上抠，没有原图就没有原料',
               '什么情况会这样':'很早以前的任务，或者缓存被清理过'}});
    return;
  }
  // 阀④：得知道贴在 PS 的哪一层上。没传回过 PS 的、太老的任务没有这张对照表。
  const c=aiCaptureSnapshot(task.captureSnapshot||task,0)||{};
  const map=task.psLayerByShot||{};
  const targetLayerId=(map&&map[shotIndex]!=null)?map[shotIndex]:null;
  if(c.docId===null||c.docId===undefined||!c.selection||targetLayerId===null||targetLayerId===undefined){
    // ⚠⚠ 2026-09-13：这道阀有【三个不同的病因】，以前三种都报同一句话 ——
    //   用户拿到报错卡也查不出到底缺哪一样（铁律 15：报错必须带现场）。
    //   现在把缺的那一项直接写进标题和现场里，下次一眼就知道该往哪查。
    const missing=[];
    if(c.docId===null||c.docId===undefined) missing.push('没有目标文档 ID');
    if(!c.selection) missing.push('没有选区快照');
    if(targetLayerId===null||targetLayerId===undefined) missing.push('对照表里没有第 '+(shotIndex+1)+' 张的图层');
    const known=Object.keys(map);
    if(window.ERR) ERR.report('DETAIL_NO_TARGET',{
      message:'找不到这张图贴在 Photoshop 的哪一层（缺：'+missing.join(' / ')+'）',
      context:{'缺的是什么':missing.join(' / '),
               '先做什么':'先把这一张传回 Photoshop，再来补细节（补好的图是盖在那张 AI 图上方的）',
               '这个任务已登记的图层':known.length?('第 '+known.map(k=>Number(k)+1).sort((a,b)=>a-b).join('、')+' 张'):'一张都没有',
               '另一种可能':'这是很早以前的任务，当时还没有记图层对照表'}});
    return;
  }
  // 阀⑤：细节补偿【只有加速引擎（档 2）能做】，本机算法没有这个能力。
  //   这里必须强制弹卡（force=true）—— 用户是主动点的按钮，不能悄悄不干活。
  let st=null;
  try{ st=await MATCHENGINE.probe(); }catch(_){ st=null; }
  if(!ownsDetail()) return aiDetachedTransfer(false);
  if(!st||!st.available||Number(st.tier)<2){
    notifyEngineOffline('细节补偿需要加速引擎（档 2）才能做',true);
    aiAddLog('补细节失败：加速引擎没连上','warn'); aiRefreshInPlace(); return;
  }

  if(detailBusy.has(key)) return;
  detailBusy.add(key);
  updateGenerationTask(taskId,{sub:'第 '+(shotIndex+1)+' 张 · 正在补细节（'+T.label+'）…'});
  aiRefreshInPlace();
  const t0=performance.now();
  let submitted=false;
  try{
    const [cur,ref]=await Promise.all([detailPixels(shot.imgId),detailPixels(task.sourceImgId)]);
    if(!ownsDetail()) return aiDetachedTransfer(submitted);
    // ⚠⚠ 阀⑥：长宽比对不上就不能补（2026-09-13 补）。
    //   细节补偿是【看位置】的（光流把原图搬到对应位置再取高频），
    //   原图被非等比拉伸之后细节会落在错的地方 → 鬼影。
    //   ⚠ 不能指望引擎自己发现：match-engine.js 不传 aspectOff 时会送 1 过去，
    //     引擎就当比例是对的。所以这里必须自己算、自己拦。
    const ra=cur.width/Math.max(1,cur.height), rb=ref.width/Math.max(1,ref.height);
    const aspectOff=Math.max(ra,rb)/Math.max(1e-6,Math.min(ra,rb));
    if(aspectOff>ASPECT_TOLERANCE){
      throw new Error('这张图和原图的长宽比差 '+Math.round((aspectOff-1)*100)
        +'%（生成时的宽高比设置和选区对不上），补细节会出鬼影，已阻止。'
        +'把「宽高比」改成 Auto 重新生成就能用');
    }
    const toBlob=im=>new Promise((res,rej)=>{
      const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
      cv.getContext('2d').putImageData(new ImageData(im.data,im.width,im.height),0,0);
      cv.toBlob(b=>b?res(b):rej(new Error('图片编码失败')),'image/png');
    });
    const fromBlob=blob=>createImageBitmap(blob).then(bmp=>{
      const cv=document.createElement('canvas'); cv.width=bmp.width; cv.height=bmp.height;
      const cc=cv.getContext('2d',{willReadFrequently:true});
      cc.drawImage(bmp,0,0);
      if(bmp.close) bmp.close();
      return {data:cc.getImageData(0,0,cv.width,cv.height).data,width:cv.width,height:cv.height};
    });
    // ⚠⚠ align 和 color 必须【关掉】：这张图在生成时已经对齐并校过色了，
    //   这里只补细节。再对齐一次等于拿对齐后的图再对一次，纯属折腾。
    // ⭐⭐ 2026-10-05（docs/143 §八）：改成要【增量层】—— 引擎不再自己合成，
    //   而是回一张 RGBA 的纹理层（RGB=128+delta/2，A=置信度 w），
    //   由 PS 用「线性光」叠上去：result = base + 2×(本层 − 128) = base + delta×w。
    //   用户要的就是这个 —— **传回去的是一层可编辑的纹理，能自己再调**。
    //   ⚠ detailLayer 只有「替换」档支持（线性光那套公式是按替换推的）；
    //     gain 档已按用户要求砍掉，所以现在界面上一档，正好。
    const r=await MATCHENGINE.process(cur,ref,{
      tier:Number(settingsRuntime.matchTier||3),
      align:false, color:false,
      detailBoost:true, detailMode:T.mode, detailLayer:true,
      detailStrength:Math.max(0,Math.min(1.5,(Number(settingsRuntime.detailStrength)||150)/100)),
      aspectOff:aspectOff,          // ⚠ 上面已经拦过了，这里再传一次当双保险
      toBlob, fromBlob,
      // ⭐ 2026-10-19：用户点的（替换增强）—— 优先级 0，插到排着的生成校色前面；状态标在这张缩略图上
      job:{kind:'detail',priority:0,taskId:String(taskId),shot:shotIndex,label:T.label}
    });
    if(!ownsDetail()) return aiDetachedTransfer(submitted);
    if(Number(r.tier)<2) throw new Error('回落到了本机算法，本机算法没有细节补偿');
    const b64=await detailToBase64(r.img);
    if(!ownsDetail()) return aiDetachedTransfer(submitted);

    // ⭐ 先贴新的、成功了再删旧的。反过来的话贴失败就把用户的图弄没了。
    submitted=true;
    const placed=await linkOnce('ps.layer.placeClipped',{
      targetDocId:c.docId, targetSelection:aiClonePlain(c.selection),
      targetLayerId:targetLayerId, imageBase64:b64,
      name:'纹理·'+T.label,
      // ⭐⭐ 三件事（docs/143 §八-3①②）：
      //   ① layerType:'pixel' —— 【不要智能对象】，直接可编辑的像素层。
      //      ⚠ 值的名字是 'pixel'，不是 'raster'（桥里的白名单是 ['smartObject','pixel']，
      //        传别的会被 return-lab 的校验挡下并抛 RETURN_LAB_PARAMS —— 143 原文写错了，已改）。
      //      ⚠ ps-io 的判据是"!== 'smartObject' 就走栅格化"，所以传 'pixel' 正好。
      //   ② blendMode:'linearLight' —— 线性光，增量层靠它复现引擎公式。
      //      ⚠ PS 到底吃不吃这个枚举值【还没真机验过】（docs/143 §十三-1）。
      //        不吃的话下面会拿 blendApplied:false，我们会明说。
      //   ③ 图层带 alpha（置信度当不透明度），所以视觉上只有置信度高的地方被改。
      layerType:'pixel', blendMode:'linearLight'
    });
    if(!ownsDetail()) return aiDetachedTransfer(submitted,placed);
    if(!placed.ok) throw new Error(placed.error||'贴回失败');
    const newLayerId=placed.data&&placed.data.layerId;
    if(placed.data&&placed.data.clipped===false){
      // 没嵌成剪切蒙版 = 它现在是一张盖在上面的普通图层。必须说，别让用户以为正常。
      aiAddLog('第 '+(shotIndex+1)+' 张：图层贴上了，但没能嵌成剪切蒙版 —— 它现在是独立一层，需要的话可以手动删掉'+(placed.data.modalError?'（PS 当时在忙：'+placed.data.modalError+'）':''),'warn');
    }
    // ⚠ 混合模式没设上【必须说】—— 不然用户看到的是一张灰糊糊的图盖在上面（增量层本来是 50% 灰），
    //   会以为功能坏了。这正是 docs/143 §十三-1 那个"PS 吃不吃 linearLight"的未验证项。
    if(placed.data&&placed.data.blendApplied===false){
      aiAddLog('第 '+(shotIndex+1)+' 张：纹理层贴上了，但 PS 没接受「线性光」混合模式 —— '
        +'现在它盖在上面是灰的。请把这一层的混合模式手动改成「线性光」，并把情况告诉我。','warn');
      if(window.ERR) ERR.report('DETAIL_BLEND_UNSUPPORTED',{severity:'L2',stage:'detail',
        message:'PS 拒绝了 linearLight 混合模式（贴上了，但模式没设上）。'});
    }
    // 旧的那层删掉（换档位时）。⚠ 删失败不算整件事失败：新的已经在上面了。
    const oldId=shot.detailLayerId;
    if(oldId!=null&&oldId!==newLayerId){
      const del=await linkOnce('ps.layer.delete',{layerId:oldId});
      if(!ownsDetail()) return aiDetachedTransfer(submitted,del);
      if(!del.ok) aiAddLog('上一层细节补偿没删掉（可能已被手动删除），PS 里可能叠了两层','warn');
    }

    const live=taskById(taskId)||task;
    const next=(live.shots||shots).slice();
    next[shotIndex]=Object.assign({},next[shotIndex],{detailTier:tier,detailLayerId:newLayerId});
    updateGenerationTask(taskId,{shots:next,
      sub:'第 '+(shotIndex+1)+' 张 · 已补细节（'+T.label+'）'});
    aiAddLog('第 '+(shotIndex+1)+' 张已补细节：'+T.title+'（'+T.label+'）· '
      +Math.round(performance.now()-t0)+'ms · '+(r.notes||[]).join(' · '),'success');
    // 写回缓存，重启后恢复的任务才知道自己是哪一档
    try{ await cacheSetTaskbar(taskById(taskId)||live, true); }catch(_){ }
  }catch(e){
    if(!ownsDetail()) return aiDetachedTransfer(submitted);
    const msg=(e&&e.message)||String(e);
    if(window.ERR) ERR.report('DETAIL_FAILED',{message:msg,
      context:{'第几张':String(shotIndex+1),'档位':T.label,
               '下一步':'确认加速引擎在线、那张 AI 图还在 Photoshop 里，然后再点一次'}});
    updateGenerationTask(taskId,{sub:'第 '+(shotIndex+1)+' 张补细节失败'});
  }finally{
    detailBusy.delete(key);
    if(ownsDetail()) aiRefreshInPlace();
  }
}

// ⭐⭐ 2026-10-05：「应用」——把滚出来的那一帧【换掉 Photoshop 里那一层】。
//
//   用户定案（docs/136 §二）：
//     · S4：找一个地方加个按钮，把滚出来的结果直接替换掉（放【大框】里）
//     · S-Q2：只在已经传回过的时候出现
//     · S-Q3：一次只换一张
//     · S2：滚轮调整期间【绝对不碰 PS】（所以只有按下这个按钮才发 PS 调用）
//
//   ⚠⚠⚠ 2026-10-05 改（用户实测："调整强度之后传过去的图层没有相关的蒙版"）。
//   第一版的做法是：placeClipped 剪切到原图层上 → 然后【删掉原图层】。错在第二步：
//     ① 羽化蒙版长在【原图层】上（第一次传回时 placeBatch 按界面羽化参数加的）——
//        删了它，蒙版就跟着没了 = 用户看到的"没有蒙版"
//     ② 更糟：新那层是【剪切蒙版】，底座就是被删的原图层。底座一没，
//        PS 会把它改剪到【下面随便哪一层】上 —— 显示可能完全错乱
//   ⇒ 现在跟「细节补偿」完全一样（docs 里那套已经跑通的做法）：
//     · 原图层【永远不动】—— 它是底座，带着第一次传回的羽化蒙版
//     · 调好强度的图【剪切】在它上面 —— PS 里剪切图层自动受底座蒙版约束，
//       所以羽化【自动联动】，而且跟第一次传回用的是【同一张蒙版】，不会两次不一样
//     · 再点一次「应用」→ 只删【上一次应用贴的那层】（shot.tweenLayerId），底座不碰
//   ⚠ 不改 UXP 插件那边（不用重载插件）：placeClipped / delete 都是现成动作。
//   ⚠ psLayerByShot【不许改】：它记的是底座，「替换/增益」补细节也嵌在它上面。
window.applyTweenToPS=async function applyTweenToPS(task,shotIndex,bytes,strengthPct){
  // ⚠⚠ 这里【不能】用 Array.isArray 判空：tween-preview 传进来的是 Uint8Array，
  //   Array.isArray(new Uint8Array(n)) 恒为 false —— 第一版就这么写的，
  //   结果每次点「应用」都会当场抛"没有可应用的图"（一次都发不出去的静默失效）。
  if(!task||!bytes||!bytes.length) throw new Error('没有可应用的图');
  const taskId=task.taskId||task.id;
  const live=taskById(taskId)||task;
  const owns=aiTaskContextGuard(live);
  const shots=Array.isArray(live.shots)?live.shots:[];
  const shot=shots[shotIndex];
  if(!shot||!shot.imgId||shot.restoreState!=='done') throw new Error('这一张还没准备好');
  // ⚠ 阀：得知道贴到 PS 的哪一层上（跟细节补偿同一套判据）
  const c=aiCaptureSnapshot(live.captureSnapshot||live,0)||{};
  const map=live.psLayerByShot||{};
  const targetLayerId=(map&&map[shotIndex]!=null)?map[shotIndex]:null;
  if(c.docId===null||c.docId===undefined||targetLayerId===null||targetLayerId===undefined){
    if(window.ERR) ERR.report('TWEEN_APPLY_NO_TARGET',{
      message:'找不到这张图贴在 Photoshop 的哪一层',
      context:{'先做什么':'先把这一张传回 Photoshop，再回来调强度',
               '另一种可能':'这是很早以前的任务，当时还没有记图层对照表'}});
    throw new Error('没有可替换的图层');
  }
  if(!owns()) throw new Error('任务已经变了，这次应用没有发出');

  const b64=bytesToBase64(bytes instanceof Uint8Array?bytes:new Uint8Array(bytes));
  const placed=await linkOnce('ps.layer.placeClipped',{
    targetDocId:c.docId, targetSelection:aiClonePlain(c.selection),
    targetLayerId:targetLayerId, imageBase64:b64,
    name:'强度'+Math.round(Number(strengthPct)||0)+'%', layerType:'smartObject'
  });
  if(!placed.ok) throw new Error(placed.error||'贴回 Photoshop 失败');
  const newLayerId=placed.data&&placed.data.layerId;
  if(placed.data&&placed.data.clipped===false){
    // ⚠ 没嵌成剪切蒙版 = 它是独立一层，【不受底座的羽化蒙版约束】—— 边缘会是硬的。必须说出来。
    aiAddLog('第 '+(shotIndex+1)+' 张：贴上了，但没能嵌成剪切蒙版 —— 它是独立一层、不带羽化，可以手动删'+(placed.data.modalError?'（PS 当时在忙：'+placed.data.modalError+'）':''),'warn');
  }
  // 上一次「应用」贴的那层删掉（不是底座！）。⚠ 先贴后删：贴失败就不会把用户的图弄没。
  const oldId=shot.tweenLayerId;
  if(oldId!=null&&oldId!==newLayerId&&oldId!==targetLayerId){
    const del=await linkOnce('ps.layer.delete',{layerId:oldId});
    if(!del.ok) aiAddLog('上一次应用的那层没删掉（可能已被手动删除），PS 里可能叠了两层','warn');
  }
  // 记下这一层，下次「应用」才知道删哪层。⚠ 底座 psLayerByShot 不动。
  const now=taskById(taskId)||live;
  const next=(now.shots||shots).slice();
  next[shotIndex]=Object.assign({},next[shotIndex],{tweenLayerId:newLayerId,tweenStrength:Math.round(Number(strengthPct)||0)});
  updateGenerationTask(taskId,{shots:next});
  aiAddLog('第 '+(shotIndex+1)+' 张已应用强度 '+Math.round(Number(strengthPct)||0)+'%（嵌在原图层上，沿用它的羽化蒙版）','success');
  try{ await cacheSetTaskbar(taskById(taskId)||live,true); }catch(_){ }
  return true;
};

// 自动档：传回成功后按设置自动给每张补一次。
// ⚠ 默认关。开着的话 18 张要排队跑十几秒，所以【串行】跑并且一路报进度 ——
//   并发打引擎只会互相拖慢，而且日志会乱成一团。
async function autoDetailAfterTransfer(task, sentOutputs, ownsTransfer){
  ownsTransfer=ownsTransfer||aiTaskContextGuard(task);
  if(!ownsTransfer()) return;
  const tier=String(settingsRuntime.autoDetailTier||'off');
  if(tier==='off'||!DETAIL_TIERS[tier]||!task||task.kind!=='generation') return;
  const live=taskById(task.taskId||task.id)||task;
  const map=live.psLayerByShot||{};
  // ⚠⚠ 2026-09-13 修（用户实测："回图正常但弹 DETAIL_NO_TARGET"）：
  //   只补【这一批刚传回的】，而且只补【对照表里真有图层】的那几张。
  //   老写法是对"所有有图的张数"无条件重跑，两个后果：
  //     ① 单张传回 / 提前结束时，其它张还没传回 PS，没有图层可嵌
  //        → 每一张都撞 阀④ → 一次弹一堆报错卡（补细节是往那张 AI 图层【上方】嵌一层，
  //          没有那一层就无处可嵌，这是注定失败的调用，不该发出去）
  //     ② 前面那批已经补过的会被白补一遍（贴新层再删旧层），纯浪费引擎时间
  const want=Array.isArray(sentOutputs)&&sentOutputs.length
    ? new Set(sentOutputs.map(o=>Number(o&&o.index)).filter(n=>Number.isFinite(n)))
    : null;
  const list=(live.shots||[]).map((s,i)=>({s,i}))
    .filter(x=>x.s&&x.s.imgId&&x.s.restoreState==='done')
    .filter(x=>!want||want.has(x.i))      // 只管这一批
    .filter(x=>map[x.i]!=null);           // 没图层可嵌的绝不送进去
  if(!list.length) return;
  aiAddLog('自动补细节（'+DETAIL_TIERS[tier].label+'）· 共 '+list.length+' 张','info');
  for(const x of list){
    if(!ownsTransfer()) break;
    const cur=taskById(task.taskId||task.id);
    if(!cur||cur.cancelRequested) break;              // 用户中途取消就停
    await applyDetailTier(cur,x.i,tier,ownsTransfer);
  }
}

// 传回的实际发送。拆出来是因为取原图 base64 变成异步了，
// 不拆的话整个 aiTransfer 要改成 async，牵动的调用点太多。
function aiTransferSend(items,task,c,setStatus,sentOutputs,ownsTransfer,feather){
  ownsTransfer=ownsTransfer||aiTaskContextGuard(task);
  if(!ownsTransfer()) return Promise.resolve(aiDetachedTransfer(false));
  setStatus('批量传回 Photoshop');aiRefreshInPlace();
  // ⭐ 记录与恢复卡（2026-09-30）：传回期间挂一条 L1 提示「正在传回图像…」，
  //   拿到回执（成功/失败）就关掉。⚠ 出错走原来的报错卡，这条只管"正在传"这口气，
  //   别让它把真报错盖住 —— 所以失败分支只关提示，不自己弹卡。
  //   ⚠⚠ 必须走本地包的 say()，不能直接调 recordsToast：
  //     aiTransferSend 会被测试【截取出来在裸 VM 里单独跑】
  //     （tests/ai-transfer-account-guard.test.js 按源码片段切片），
  //     recordsToast 定义在本文件靠后的地方、不在那段切片里 ——
  //     直接调就是 ReferenceError，而且是在 enqueue 之前抛，
  //     测试看到的是"命令一条都没发"（这一版第一轮就栽了 5 条）。
  //     typeof 判断只能护住取函数那一下，护不住后面每一处调用，所以包成函数。
  //     进程内正常时它一定在，这里只影响"片段被单独执行"的场景。
  const say=(title,level,durationMs)=>typeof recordsToast==='function'?recordsToast(title,level,durationMs):{close:()=>{}};
  const transferToast=say('正在传回图像…','info');
  // 等待 UXP 真正回执，而不是只等待“命令入队”回执；这样并发任务的活动状态准确。
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;resolve(value);};
    // ⭐ 边缘羽化按次传参（2026-09-13）。⚠ 不能靠桥那边的常驻 settings ——
    //   桥没有"界面同步设置过来"的通道，靠它就成了"界面上调了没反应"的假开关。
    feather=feather||{
      enabled:settingsRuntime.returnFeather===true,
      shrinkPercent:Math.max(0,Math.min(50,Number(settingsRuntime.returnFeatherShrink)||0)),
      blurPercent:Math.max(0,Math.min(50,Number(settingsRuntime.returnFeatherBlur)||0))
    };
    linkQueue('ps.layer.placeBatch',{targetDocId:c.docId,items,strictTarget:true,feather},{after:data=>{
      transferToast.close();
      say('传回完毕','ok',2600);
      if(!ownsTransfer()){finish(aiDetachedTransfer(true,{ok:true,data}));return;}
      const msg='已批量传回 '+((data&&data.layerIds&&data.layerIds.length)||items.length)+' 张';setStatus(msg);aiAddLog(msg,'success');if(task){
        // ⚠⚠ 2026-09-13 修（用户实测确诊）：这里【绝不许】无条件写 status:'done'。
        //   「提前结束」是在任务【还在跑】的时候调传回的。一旦被写成终态，三件事连锁塌：
        //     ① aiHandleProgress 的准入条件里有 aiTaskIsTerminal(current)
        //        → 后台每算好一张的进度事件【全部被静默丢弃】
        //     ② updateGenerationTask 判定终态 → 立刻落盘并把闸门锁死
        //        → 后面算出来的图【永远写不进缓存】
        //        用户现象：重载之后只剩提前结束之前那几张，后台算的图和预览全没了
        //     ③ pct 被写满 100，而实际还没跑完
        //   交接文档 7247 行那段注释特意写了"不能让 status 进终态"——「提前结束」自己守住了，
        //   而这句成功回调从背后把它破了。典型的静默失效（铁律 17）。
        //   判据：还有【既没成也没失败】的张数就说明还在跑 —— 保持原状态，连 pct 都不动。
        const live=taskById(task.taskId||task.id)||task;
        const stillPending=(live.shots||[]).some(s=>s&&!s.done&&!s.error);
        const patch={sub:msg};
        if(!stillPending){ patch.status='done'; patch.pct=100; }
        updateGenerationTask(task.taskId||task.id,patch);
      }aiRefreshInPlace();
      // 传回成功后自动编组，并记住图层 ID —— 这是"划到哪张就在 PS 里显示哪张"的前置。
      // ⚠ 必须把"实际发过去的那批 outputs"传进去 —— 图层 ID 是按发送顺序回来的，
      //   只有对着这个数组才能还原出"第几张图 → 哪个图层"。
      if(task) autoGroupAfterTransfer(task, data, c.docId, sentOutputs, ownsTransfer);
      // 完成音效：这一次传回结束就响（10-25 起不再挂在编组成功上）。⚠ 截源码跑的测试里可能没有这个函数
      if(task&&typeof playTaskResultSound==='function'){
        const ids=data&&Array.isArray(data.layerIds)?data.layerIds:null;
        playTaskResultSound(task, ownsTransfer, ids?{total:items.length,ok:ids.filter(x=>x!=null).length}:null);
      }
      // ⭐ 2026-09-13：传回成功就落盘一次（分几次传也能各存一次，重载后不会丢）。
      // ⚠ 必须排在 autoGroupAfterTransfer 【之后】—— 图层对照表是它写进任务的，
      //   排在前面存下来的就是一份旧表，重载后 hover 联动照样对不上。
      // ⚠ cacheSaveTask 内部跳过已经写过的图，所以这一步只多一次几 KB 的 meta 写入，
      //   不会重写几百 MB 原图。
      if(task) cachePersistTask(taskById(task.taskId||task.id)||task);
      // ⚠ 自动补细节排在编组【之后】：补细节要用 psLayerByShot 对照表，
      //   而那张表正是 autoGroupAfterTransfer 写进去的。顺序反了会全部落到阀④。
      //   ⚠ 它是异步的，不 await —— 传回本身已经成功了，不能让补细节拖着回执不返回。
      //   ⚠ 必须把"这一批实际发过去的"传进去：分批传 / 单张传时，别的张还没有图层可嵌，
      //     不传这个参数它会对全部张数重跑，每一张都弹一张报错卡（2026-09-13 用户实测）。
      if(task) Promise.resolve().then(()=>autoDetailAfterTransfer(task, sentOutputs, ownsTransfer)).catch(()=>{});
      finish({ok:true,data});},afterError:result=>{
        // ⚠ 出错只关"正在传回"那条胶囊，真报错照旧走下面的报错卡 —— 别让过程提示把报错顶掉。
        transferToast.close();
        if(!ownsTransfer()){finish(aiDetachedTransfer(true,result));return;}
        const msg='批量传回失败：'+linkResultMessage(result);setStatus(msg);aiAddLog(msg,'error');if(task)updateGenerationTask(task.taskId||task.id,{status:'failed',stage:'transfer',errorCode:(result&&result.error&&result.error.code)||'AI_TRANSFER_FAILED',error:msg,sub:msg});aiRefreshInPlace();
        if(task&&typeof playTaskResultSound==='function') playTaskResultSound(task, ownsTransfer, {total:items.length||1, ok:0});   // 传回失败也要响「全部失败」
        finish({ok:false,error:msg,result});
      }}).then(reply=>{if(reply&&!reply.ok)finish(ownsTransfer()?reply:aiDetachedTransfer(true,reply));})
        .catch(error=>{transferToast.close();finish(ownsTransfer()?{ok:false,error:error.message||String(error)}:aiDetachedTransfer(true));});
  });
}
function aiCompute(){aiRuntime.lastPlan=aiPlan();aiRuntime.status='抗截断计算完成';aiAddLog('抗截断计算：'+aiRuntime.lastPlan.source+' → '+aiRuntime.lastPlan.target+' · '+aiRuntime.lastPlan.mode,'info');aiRefreshInPlace();}
function aiRestore(){const task=aiSelectedTask();const outputs=task&&Array.isArray(task.outputs)?task.outputs:aiRuntime.outputs;if(!outputs||!outputs.length){aiRuntime.status='没有可恢复的结果';aiAddLog(aiRuntime.status,'warn');aiRefreshInPlace();return;}aiAddLog('按保存的文档、选区和抗截断元数据恢复结果','info');aiTransfer(task||null);}
async function aiEnqueue(){
  if(window.V7BatchQueue)return V7BatchQueue.enqueueCurrent().catch(error=>{ERR.report('BATCH_QUEUE_FAILED',{message:error.message});});
  aiReadFields(document);
  const snap=aiCaptureSnapshot(aiRuntime.capture,aiRuntime.antiMode);
  if(!snap||snap.docId===null||snap.docId===undefined||!snap.selection){aiRuntime.status='加入队列前请先加载 Photoshop 图片';aiAddLog(aiRuntime.status,'warn');aiRefreshInPlace();return;}
  const qid='q-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6);
   // ⭐ 加入队列时也把预设名【现取】存进去（2026-09-13）：
   //   队列可能过很久才跑，那时用户早就换别的预设了 —— 存的是"加进来那一刻"的来源才对。
   aiSessionSecrets.set(qid,String(aiRuntime.apiKey||''));
   const item={id:qid,taskId:qid,presetTitle:presetTitleNow(),prompt:aiRuntime.prompt,protocol:aiRuntime.protocol,provider:aiRuntime.provider,baseUrl:aiRuntime.baseUrl,endpoint:aiRuntime.endpoint,authMode:aiRuntime.authMode,model:aiRuntime.model,size:aiRuntime.size,aspectRatio:aiRuntime.aspectRatio,batch:aiRuntime.batch,antiMode:aiRuntime.antiMode,autoReturn:!!aiRuntime.autoReturn,refImages:aiClonePlain(aiRuntime.refImages||[]),captureSnapshot:snap,capture:null,status:'queued'};
  Object.assign(item,aiWorkflowSnapshot());
  if(window.V7PresetReferences){try{item.referenceAssets=await V7PresetReferences.capture();item.refImages=[];}catch(error){V7PresetReferences.report(error);return;}}
  aiRuntime.queue.push(item);aiRuntime.status='已加入队列';aiAddLog('已加入生成队列 · '+item.prompt.slice(0,30)+' · '+(snap.docName||'文档 '+snap.docId),'info');aiRefreshInPlace();
}
async function aiRunQueue(){
  const options=arguments[0]||{};
  if(window.V7BatchQueue&&!options.managed)return V7BatchQueue.run().catch(error=>{ERR.report('BATCH_QUEUE_FAILED',{message:error.message});});
  const queue=aiRuntime.queue,ownsSession=aiTaskContextGuard(null);
  const ownsQueue=()=>ownsSession()&&aiRuntime.queue===queue;
  const runnable=queue.filter(item=>item.status==='queued'||(!options.sequential&&item.status==='failed'));
  if(!runnable.length){aiRuntime.status=queue.length?'队列中没有待运行项目':'队列为空，请先加入任务';aiAddLog(aiRuntime.status,'warn');aiRefreshInPlace();return;}
  aiRuntime.status='已启动 '+runnable.length+' 个队列任务';aiAddLog(aiRuntime.status,'info');aiRefreshInPlace();
  const results=[];
  const execute=async item=>{
    const ownsItem=()=>ownsQueue()&&queue.includes(item);
    const guard=()=>{if(!ownsItem()||options.shouldStop&&options.shouldStop())throw Object.assign(new Error('批处理已停止，未执行项目仍保留'),{code:'BATCH_STOPPED'});};
    if(!ownsItem()||options.shouldStop&&options.shouldStop())return null;
    item.status='running';aiRefreshInPlace();
    let result;
    try{
      if(options.onChange)await options.onChange(item);
      const snapshot=options.prepare?await options.prepare(item):item;guard();
      aiMarkActive(snapshot.taskId||snapshot.id,'generate');
      result=await aiGenerateNow(snapshot,{autoReturn:!!item.autoReturn,guard,confirm:options.confirm?estimate=>options.confirm(item,estimate):undefined});
    }catch(error){result={ok:false,cancelled:error.code==='BATCH_STOPPED',error:String(error.message||error)};}
    if(!ownsItem())return result;
    item.status=result&&result.ok?'success':result&&result.cancelled?'cancelled':'failed';
    item.error=result&&result.ok?'':String(result&&result.error||'生成未完成，请先核对任务历史');
    if(options.onChange)await options.onChange(item,result);
    aiRefreshInPlace();return result;
  };
  if(options.sequential){for(const item of runnable){if(!ownsQueue()||options.shouldStop&&options.shouldStop())break;const result=await execute(item);if(result)results.push(result);if(result&&!result.ok&&options.stopOnFailure!==false)break;}}
  else results.push(...await Promise.all(runnable.map(execute)));
  if(!ownsQueue()||runnable.some(item=>!queue.includes(item)))return;
  aiRuntime.status='队列执行完成 · '+results.filter(r=>r&&r.ok).length+'/'+runnable.length+' 成功';aiRefreshInPlace();
  return {results,remaining:queue.filter(item=>item.status==='queued').length};
}
// ⭐⭐ 转后台（软中断，2026-09-13）—— 对应今日清单第 15 项。
//
//   做法照抄 V6 `host/stop-control-handlers.js` 的 softMode 语义：
//   **UI 释放，但请求不 abort，继续跑到结果归档。**
//   V8 比 V6 简单得多 —— V6 的结果要进回收站，V8 的生成结果本来就写
//   cache/<项目>/<runId>/ 并回到任务栏，所以【什么都不用改，只要别掐断】。
//
// ⚠⚠ 三个不能碰的东西（碰了结果会被丢掉）：
//   ① 不能设 cancelRequested
//   ② 不能调 aiMarkInactive
//   ③ 不能让 status 进终态（done/failed/cancelled）
//   因为结果回调那两道准入条件是：
//     `if(!current || !aiRuntime.activeTasks[id] || current.cancelRequested
//        || aiTaskIsTerminal(current)) return;`
//   任意一条命中，出的图就被静默丢弃了。
// ⭐⭐「提前结束」（2026-09-13 用户定案）—— 对应今日清单第 14、15 项。
//
//   用户原话：「**把当前完成的图先传回，剩下的在任务详情里慢慢算**」。
//
//   所以它【不是取消】，是两件事合在一起：
//     ① 把已经出好的图【立刻传回 Photoshop】——不用干等整批跑完
//     ② 剩下的【继续在后台算】，算完了任务卡上会出现「传回 N」按钮
//
//   ⚠ 没做「真取消」。理由：aji 是【发送即扣】，已经发出去的钱退不回来，
//     真掐断省下的只有"还没发出去"那部分，而代价是用户要理解两个按钮的差别。
//     用户 2026-09-13 明确要一个按钮。要加真取消的话回来看这段注释再决定。
async function aiFinishEarly(taskOrId){
  const task=(taskOrId&&taskOrId.taskId)?taskOrId:taskById(String(taskOrId||''));
  if(!task){aiRuntime.status='没有可提前结束的任务';aiRefreshInPlace();return;}
  const ownsEarly=aiTaskContextGuard(task);
  if(!ownsEarly()) return;
  const taskId=String(task.taskId||task.id||'');
  if(aiTaskIsTerminal(task)){aiAddLog('这个任务已经结束了','info');aiRefreshInPlace();return;}

  const pending=taskPendingTransfer(task);

  // ⚠⚠ 2026-09-13 修（用户实测"关了自动传回，后台算完还是自己传回去了"）：
  //   **必须先挂"转后台"的牌子，再传回** —— 老写法是反的。
  //   传回要等 Photoshop 的真回执，少则一两秒。老写法在这几秒里牌子还没挂上，
  //   如果整批正好在这期间算完，aiGenerateNow 那句
  //     willReturn = ... && !task.backgrounded && ... && opts.autoReturn
  //   读到的 backgrounded 还是 false → 【整批又被自动传回一次】，
  //   把用户刚才挑着传的那批作废，还在文档里塞一堆没要的图层。
  const early=taskById(taskId);
  if(early && !aiTaskIsTerminal(early)){
    updateGenerationTask(taskId,{backgrounded:true,
      sub:pending>0?('先传回 '+pending+' 张 · 剩下的在后台算'):'剩下的在后台算 · 算完这里会出现「传回」'});
  }

  // 牌子挂好了，再把已经出好的传回去
  if(pending>0){
    aiAddLog('提前结束：先把已完成的 '+pending+' 张传回 Photoshop','info');
    try{ await aiTransfer(task); }
    catch(e){ if(ownsEarly())aiAddLog('提前结束时传回失败：'+((e&&e.message)||e)+'（剩下的仍会继续算）','warn'); }
  }else{
    aiAddLog('提前结束：现在还没有出好的图，剩下的会继续在后台算','info');
  }

  // ⚠⚠ 剩下的【继续跑】—— 这里三个东西碰了就会把后面出的图弄丢：
  //   ① 不能设 cancelRequested  ② 不能调 aiMarkInactive  ③ 不能让 status 进终态
  //   因为结果回调的准入条件是：
  //     `if(!current || !aiRuntime.activeTasks[id] || current.cancelRequested
  //        || aiTaskIsTerminal(current)) return;`
  //   任意一条命中，后面出的图就被【静默丢弃】了。
  if(!ownsEarly()) return;
  const live=taskById(taskId);
  if(live && !aiTaskIsTerminal(live)){
    updateGenerationTask(taskId,{backgrounded:true,
      sub:'剩下的在后台算 · 算完这里会出现「传回」'});
  }
  // 前台焦点让出来，好接着干别的
  if(String(aiRuntime.currentTaskId||'')===taskId){
    aiRuntime.currentTaskId='';
    aiRuntime.status='已提前结束，剩下的在后台算';
  }
  aiRefreshInPlace();
}

function aiCancel(taskOrId){
  const task=(taskOrId&&taskOrId.taskId)?taskOrId:(taskOrId?taskById(String(taskOrId)):aiSelectedTask());
  if(!task){aiRuntime.status='没有可取消的任务';aiRefreshInPlace();return;}
  const taskId=String(task.taskId||task.id||'');
  // ⚠ 钱的事必须说：aji 是【发送即扣，成败都记】。已经发出去的那几张，
  //   放弃了钱也已经花了 —— 不说的话用户会以为"取消了就不扣钱"，那是坑人。
  //   （计费规则见记忆 reference_billing_rules：aji 发送即扣 / grs+momo 成功才扣）
  const shots=Array.isArray(task.shots)?task.shots:[];
  const sent=shots.filter(s=>s&&!s.error).length;
  if(String(task.provider||'')==='aji'&&sent>0){
    aiAddLog('已放弃。⚠ 已经发出去的 '+sent+' 张，积分是发送时就扣掉的，放弃不退','warn');
  }
  task.cancelRequested=true;
  if(window.V7Workflows)V7Workflows.cancel(taskId).catch(e=>aiAddLog('工作流取消失败：'+String(e&&e.message||e),'warn'));
  if(window.V7QwenMode)V7QwenMode.cancel(taskId).catch(()=>{});
  if(window.uiwin&&window.uiwin.ai&&window.uiwin.ai.cancel&&taskId)window.uiwin.ai.cancel(taskId);
  if(task.platformBilling&&task.platformBilling.taskId&&window.V7Backend&&window.V7Backend.state().signedIn){
    window.V7Backend.cancelTask(task.platformBilling.taskId).catch(e=>aiAddLog('平台任务取消同步失败：'+String(e&&e.message||e),'warn'));
  }
  updateGenerationTask(taskId,{status:'cancelled',sub:'已取消',error:'',errorInfo:null});
  aiMarkInactive(taskId);
  if(String(aiRuntime.currentTaskId||'')===taskId)aiRuntime.status='已取消';
  aiAddLog('已取消任务 '+taskId,'info');
  aiRefreshInPlace();
}
function aiRetry(){if(aiRuntime.errors.length){aiRuntime.batch=Math.max(1,aiRuntime.errors.length);aiRuntime.status='重试失败项';aiGenerate();}else if(aiRuntime.outputs.length){aiRuntime.status='重新生成当前批次';aiGenerate();}}
function aiClear(){aiRuntime.outputs=[];aiRuntime.errors=[];aiRuntime.status='结果已清空';aiAddLog('已清空本次生成结果','info');aiRefreshInPlace();}
function bindAiDetail(root){
  bindReferenceControls(root);
  bindNumControls(root);   // 调试面板里的张数也是拖拽条，数字要跟着滚
  root.querySelectorAll('[data-ai-field]').forEach(el=>el.addEventListener('input',()=>{const k=el.dataset.aiField;aiRuntime[k]=el.type==='checkbox'?!!el.checked:el.value;aiSaveTempCache();}));
  root.querySelectorAll('[data-ai-field]').forEach(el=>el.addEventListener('change',()=>{const k=el.dataset.aiField;aiRuntime[k]=el.type==='checkbox'?!!el.checked:el.value;aiSaveTempCache();if(k==='antiMode'||k==='size'||k==='aspectRatio')aiRefreshInPlace();}));
  const q=root.querySelector('[data-ai-action="capture"]');if(q)q.addEventListener('click',e=>{e.stopPropagation();aiCapture();});
  const g=root.querySelector('[data-ai-action="generate"]');if(g)g.addEventListener('click',e=>{e.stopPropagation();aiGenerate();});
  const p=root.querySelector('[data-ai-action="place"]');if(p)p.addEventListener('click',e=>{e.stopPropagation();aiTransfer();});
  const full=root.querySelector('[data-ai-action="full"]');if(full)full.addEventListener('click',e=>{e.stopPropagation();aiFull();});
  const calc=root.querySelector('[data-ai-action="compute"]');if(calc)calc.addEventListener('click',e=>{e.stopPropagation();aiCompute();});
  const restore=root.querySelector('[data-ai-action="restore"]');if(restore)restore.addEventListener('click',e=>{e.stopPropagation();aiRestore();});
  const enq=root.querySelector('[data-ai-action="enqueue"]');if(enq)enq.addEventListener('click',e=>{e.stopPropagation();aiEnqueue();});
  const runq=root.querySelector('[data-ai-action="runqueue"]');if(runq)runq.addEventListener('click',e=>{e.stopPropagation();aiRunQueue();});
  const cancel=root.querySelector('[data-ai-action="cancel"]');if(cancel)cancel.addEventListener('click',e=>{e.stopPropagation();aiCancel();});
  const retry=root.querySelector('[data-ai-action="retry"]');if(retry)retry.addEventListener('click',e=>{e.stopPropagation();aiRetry();});
  const clear=root.querySelector('[data-ai-action="clear"]');if(clear)clear.addEventListener('click',e=>{e.stopPropagation();aiClear();});
  const clearCache=root.querySelector('[data-ai-action="clear-cache"]');if(clearCache)clearCache.addEventListener('click',e=>{e.stopPropagation();aiClearTempCache();});
  const test=root.querySelector('[data-ai-action="test-url"]');if(test)test.addEventListener('click',e=>{e.stopPropagation();try{const ep=String(aiRuntime.endpoint||'').trim();if(ep&&!/^https?:\/\//i.test(ep)&&!String(aiRuntime.baseUrl||'').trim())throw new Error('相对 Endpoint 需要 API URL');if(ep&&/^https?:\/\//i.test(ep))new URL(ep);else new URL(String(aiRuntime.baseUrl||''));aiRuntime.status='URL 格式有效';aiAddLog('URL 格式验证通过','success');}catch(_){aiRuntime.status='URL 格式无效';aiAddLog(aiRuntime.status,'error');}aiRefreshInPlace();});
  // 2026-10-18：「追加当前选区」(capture-ref) 那个按钮跟旧参考图弹窗一起删了 —— 抓选区当参考图现在在参考图卡上（那个「+」）。
}
function aiHelp(what,requires,params){return '<div class="ai-help"><b>做什么：</b>'+escapeHtml(what)+'<br><b>前置：</b>'+escapeHtml(requires)+'<br><b>参数：</b>'+escapeHtml(params)+'</div>';}
// ⚠ 2026-10-07：第三列是可选的"标记"（'image' = 确定生图 / 'other' = 疑似非生图）。
//   它【不写进 option 的文本】—— 因为 ui-select 把 o.textContent 同时用在"收起状态那一行的标签"上，
//   加前缀会让收起时也显示标记。改成 data-v7tier 属性传给自绘面板，让面板把疑似项画成灰色。
// ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：校色方式的【卡面短标签】和【悬停长说明】。
//
//  ⚠ 为什么要分两套写法：
//    卡面格子净宽只有约 110px（同文件上面那两条注释记着），标签最多 4 字，
//    写成「全局 —— 整张图按颜色配平，不看位置」会被切成「全局 —…」。
//    ⇒ 卡面只写 2 个字的效果名；每种「什么时候不好」放 title，悬停能看全。
//  ⚠ 措辞规矩（docs/141 §二）：只写【效果名】，不许出现实现词
//    （光流 / LUT / 引导滤波 一律不许出现）。
const COLOR_MODE_SHORT_OPTIONS = [
  ['off','不校色'],
  ['global','全局'],
  ['precise','精准'],
  ['hybrid','混合'],
];
// ⚠ 这里要跟设置卡那一份【说同一件事】。两份文案不一致 = 用户以为选的是两个东西。
const COLOR_MODE_TIP = [
  '校色方式（把 AI 图的颜色套回原图色调）：',
  '· 不校色 —— 保持 AI 原本的颜色',
  '· 全局 —— 整张图按颜色配平，不看位置（AI 大改内容时整体颜色会被带偏）',
  '· 精准 —— 按位置把原图颜色换回来（AI 改过的地方会出鬼影）',
  '· 混合 —— 只校内容没变的地方（偏保守，但最不容易出鬼影）',
].join('\n');

// x = [值, 显示的字, 档位标记(可空), 禁用(可空)] —— 禁用的照样列出来、灰掉点不了（10-25：开源模型 2K 额度用完）
function aiSelectOptions(list,current){return list.map(x=>'<option value="'+escapeHtml(x[0])+'" '+(x[0]===current?'selected':'')+(x[2]?' data-v7tier="'+escapeHtml(String(x[2]))+'"':'')+(x[3]?' disabled':'')+'>'+escapeHtml(x[1])+'</option>').join('');}

// 正式生成卡：用户只需填提示词和选基本参数，底层仍调用已通过的 aiBeginImmediate/aiTransfer。
// 调试用的 URL、Endpoint、鉴权、抗截断和队列操作仍在 fillAiDetail 里，但不再由当前主卡进入。
function generationPanelForZone(zone){return document.querySelector('#dcBody .generation-panel[data-generation-zone="'+String(zone)+'"]');}
function aiSetRefImages(list,mime,guard){
  return V7PresetReferences.append((list||[]).filter(Boolean).map(row=>typeof row==='string'?{imageBase64:row,mime:mime||'image/png'}:row),guard);
}
// ⭐ 2026-10-18 旧参考图弹窗（reference-dialog.js）删了（用户：新参考图卡已经能用，旧代码删掉）。
//   这一行摘要原来借弹窗的 summaryHtml，现在直接读 V7PresetReferences；增删、排序、看大图都在参考图卡里。
//   名字保留 —— 二级页那行 html 和 aiRefreshInPlace 都按名字调它。
function generationReferencePreview(){
  const r=window.V7PresetReferences;if(!r)return '';
  const s=r.state();
  if(s.loading)return '<div class="ai-note">正在读取参考图</div>';
  if(s.error)return '<div class="ai-note">'+escapeHtml(s.error)+'</div>';
  const n=s.fixed.length+s.temporary.length;
  const line=n?('这次会带 '+n+' 张参考图'+(s.fixed.length?'（预设自带 '+s.fixed.length+' 张）':'')):'暂无参考图';
  return '<div class="ai-note ref-summary">'+escapeHtml(line+' · 参考图最多 '+s.limit+' 张（加原图共 '+(s.limit+1)+' 张）')
    +(s.blocked&&n>s.limit?'<br><b class="ref-warn">'+escapeHtml(s.reason)+'</b>':'')+'</div>';
}
// ⚠⚠ 名字【不许改】（融合方案-C01 §5.4 ②）：bindAiDetail 第一句就按这个名字调它，
//   改名 = 生成卡详情的绑定全废，而且不报错（铁律 17 静默失效）。只改里面。
function bindReferenceControls(root){
  if(root.dataset.referenceBound)return;root.dataset.referenceBound='1';
  root.addEventListener('click',async event=>{
    const button=event.target.closest('[data-reference-remove],[data-reference-view],[data-reference-add],[data-reference-save],[data-reference-map]');
    if(!button||!root.contains(button))return;event.stopPropagation();
    try{
      // 2026-10-18：「打开参考图」(data-reference-open) 跟旧弹窗一起删了。下面几个老按钮的处理先留着，别处还有可能用到。
      if(button.hasAttribute('data-reference-remove')){
        // ⭐ 2026-10-22（docs/263 第 6 条）：删了能撤销（同参考图卡）
        const token=await V7PresetReferences.remove(button.dataset.referenceRemove,Number(button.dataset.referenceIndex));
        if(token&&window.V7Undo&&typeof V7PresetReferences.restore==='function')V7Undo.offer('已删除 1 张参考图',()=>{V7PresetReferences.restore(token).catch(error=>V7PresetReferences.report(error));});
      }
      else if(button.hasAttribute('data-reference-map'))PRESETUI.editReferenceMapping();
      else if(button.hasAttribute('data-reference-save')){await V7PresetReferences.saveFixed();UI.toast('参考图已保存到预设','ok');}
      else if(button.hasAttribute('data-reference-add')){
        const guard=V7PresetReferences.context(),input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.multiple=true;
        input.addEventListener('change',()=>V7PresetReferences.append(Array.from(input.files||[]),guard).catch(V7PresetReferences.report),{once:true});input.click();
      }else await referenceOpenView(button.dataset.referenceView,button.dataset.referenceIndex);
    }catch(error){V7PresetReferences.report(error);}
  });
}
// ⚠ 2026-10-02：下面两个辅助函数【必须】放在 bindReferenceControls 和 gateFirstRun 之间。
//   tests/viewer-frontend-lifecycle.test.js 按「从 bindReferenceControls 切到 gateFirstRun」把源码抠出来跑，
//   第一版放在 bindReferenceControls 前面 → 沙箱里没有 referenceOpenView → 3 条红 + 进程挂住不退出（全量测试卡死）。
// 从 PS 当前选区抓一张当临时参考图（参考图弹窗「追加当前选区」用）。
//   ⚠ 包成 Promise、失败也要 reject：弹窗按它来结束「正在抓取…」的忙碌状态，不 reject 就会一直转圈。
//   ⚠ 「能不能再加」由 V7PresetReferences.append 里的闸门判（最多 5 张等），这里不另判 —— 两处判同一件事会漂。
// ⭐ 2026-10-24（用户定）：参考图快捷键 —— Photoshop 在前台（或者正在点轮椅自己）⇒ 照旧抓 PS 选区；
//   别的软件在前台 ⇒ 全屏截图框选（外壳 snip.rs；截完「确认 / 重截」，确认了才加）。Mac / Electron 开发壳没有截图 ⇒ 照旧抓选区。
let referenceSnipGuard=null;
async function referenceHotkey(guard){
  let fg=null;
  try{fg=await window.uiwin?.snip?.foreground?.();}catch(_){fg=null;}
  if(fg&&fg.kind==='other'&&fg.supported&&typeof window.uiwin.snip.start==='function'){
    referenceSnipGuard=guard;
    const r=await window.uiwin.snip.start().catch(error=>({ok:false,error:String(error&&error.message||error)}));
    if(r&&r.ok)return true;
    referenceSnipGuard=null;
    if(r&&r.error&&r.error!=='UNSUPPORTED'&&window.ERR)ERR.report('SNIP_FAILED',{message:String(r.error)});
  }
  return referenceCaptureSelection(guard);
}
function referenceSnipDone(result){
  const guard=referenceSnipGuard;referenceSnipGuard=null;
  if(!result||!result.ok){
    if(result&&!result.cancelled&&window.ERR)ERR.report('SNIP_FAILED',{message:String(result.error||'截图没成功')});
    return;
  }
  aiSetRefImages([{imageBase64:result.imageBase64,mime:result.mime||'image/png'}],guard).then(()=>{
    aiRuntime.status='已加入 1 张截图参考图（'+result.width+'×'+result.height+'）';aiRefreshInPlace();
    try{UI.toast('截图已加为参考图','ok');}catch(_){}
  }).catch(error=>{if(window.V7PresetReferences)V7PresetReferences.report(error);});
}
function referenceCaptureSelection(guard){
  return new Promise((resolve,reject)=>{
    // ⭐ 2026-10-24（用户定）：参考图永远不带抗截断 —— 第二个参数固定 0。
    //   原来传 undefined = 跟着生成卡的抗截断走，开着时加进去的是色相翻转 / 上下翻转过的图。
    aiCapture(data=>{aiSetRefImages([data.imageBase64],data.mime,guard).then(()=>{aiRuntime.status='已加入 1 张临时参考图';aiRefreshInPlace();resolve(true);},reject);},
      0,result=>reject(Object.assign(new Error(linkResultMessage(result)),{code:'PRESET_REFERENCE_FAILED'})));
  });
}
// 看参考图大图。⭐ 2026-10-02 从 bindReferenceControls 里抽出来：生成卡二级页和参考图弹窗（reference-dialog.js）共用这一份。
// ⭐ 2026-10-04 用户定案（docs/132 §三）：改走【内置预览框】，不再开独立大图窗口。
// 2026-10-14：参考图卡传整卡归属和右划面板，复用任务卡的大图位置与收起逻辑。
// 旧弹窗仍可只传 (kind,index)，保留其独立看图行为。
let referencePreviewSeq=0;
let referenceLeaveTimer=0;
function referenceHoldPreview(anchorEl){
  clearTimeout(referenceLeaveTimer);
  window.V7Tween?.holdImage(anchorEl);
}
function referenceLeavePreview(anchorEl,force){
  clearTimeout(referenceLeaveTimer);
  if(force) ++referencePreviewSeq;
  else referenceLeaveTimer=setTimeout(()=>{
    if(!window.V7Tween?.imageChainHit(anchorEl)) ++referencePreviewSeq;
  },160); // 卡→菜单→大图的正常移动不应取消正在读取的图片。
  window.V7Tween?.leaveImage(anchorEl,force);
}
async function referenceOpenView(kind,index,anchorEl,geometry){
  const guard=V7PresetReferences.context(),url=V7PresetReferences.view(kind,Number(index));if(!url)return;
  const token=++bigSendSeq,referenceToken=++referencePreviewSeq;
  try{
    const bytes=new Uint8Array(await(await fetch(url)).arrayBuffer());
    if(token!==bigSendSeq||referenceToken!==referencePreviewSeq)return;
    guard.check(true);
    if(window.V7Tween){ window.V7Tween.showImage(bytes,anchorEl||null,geometry); return; }
    // 兜底：预览框模块没加载时退回老窗口（不至于"点了没反应"）
    viewerOpen=true;bigTask=null;
    const result=await uiwin.viewer.open({bytes,mime:'image/png',num:1,total:1,reset:true});
    if(token!==bigSendSeq||!viewerOpen)return;
    if(result?.ok===false)throw new Error(result.error||'大图窗口打开失败');
  }catch(error){if(token!==bigSendSeq||referenceToken!==referencePreviewSeq)return;viewerOpen=false;throw error;}
}
function gateFirstRun(action){
  if(!window.V7FirstRun||V7FirstRun.isComplete())return false;
  if(window.__v7FirstRunContinuation)return true;
  window.__v7FirstRunContinuation=true;
  V7FirstRun.require().then(ok=>{
    window.__v7FirstRunContinuation=false;
    if(ok&&typeof action==='function')action();
  });
  return true;
}
// 「开始生成」的唯一入口：按钮和快捷键都走这里，不存在两套逻辑。
//
// ⚠ 关键：这里绝不能去找 DOM 上的「开始生成」按钮再模拟点击。
//   窗口失焦时 window.blur → closeAll() 会把生成详情卡整个拆掉，
//   用户切到 Photoshop 之后那个按钮根本不存在，找按钮必然点不到
//   —— 这就是之前快捷键在 PS 前台完全没反应的原因。
//   表单每敲一个字都通过 bindAiDetail 的 input 事件同步进 aiRuntime，
//   所以即使详情卡已经关闭，运行时参数依然是最新的，可以直接开工。
function generationRunNow(root){
  if(window.V7CreativeTools&&V7CreativeTools.isOpen()){V7CreativeTools.run();return true;}
  if(window.V7CameraLight&&V7CameraLight.isOpen()){V7CameraLight.run();return true;}
  if(window.V7CanvasWorkbench&&V7CanvasWorkbench.isOpen()){V7CanvasWorkbench.runSelected();return true;}
  if(window.V7FirstRun&&!V7FirstRun.isComplete()){
    gateFirstRun(()=>generationRunNow(root));
    return false;
  }
  const active=document.activeElement;
  // 正在设置里录快捷键时只记组合键，不启动生成。
  if(active&&active.matches&&active.dataset&&SHORTCUT_SETTING_KEYS.has(active.dataset.setting))return false;
  // 详情卡还开着就先把当前表单值收一遍（覆盖 input 事件可能漏掉的情况）。
  const scope=root||generationPanelForZone(0);
  if(scope)aiReadFields(scope);
  // ⭐⭐ Phase F（用户 2026-10-06 定）：引擎不再自启 → 校色引擎没开时给【非阻断】一行提示。
  //   为什么值得提示：底版只有校色引擎参与时才生成；没开的话这一单点了"小眼睛"会缺文件。
  //   ⚠ 不是报错、不挡生成 —— 档 1 本机算法照常出图（对齐用快速版、细节还原不可用）。
  try{
    const me=window.MATCHENGINE&&typeof MATCHENGINE.status==='function'?MATCHENGINE.status():null;
    const matchOff=!(window.MATCHENGINE&&me&&me.available===true)&&String(settingsRuntime.matchTier||'3')!=='1';
    if(aiRuntime)aiRuntime.noMatchEngineHint=matchOff;
    if(matchOff){
      try{UI.toast('校色引擎没开：这单不存底版，对齐用快速版','warn',4200);}catch(_){}
      try{aiAddLog('[校色] 引擎没开：这单不存底版、对齐用快速版，细节还原不可用','warn');}catch(_){}
    }
  }catch(_){ if(aiRuntime)aiRuntime.noMatchEngineHint=false; }
  // 自动传回由当前设置/生成页开关决定，不再强制进入旧的“完整链路测试”。
  aiBeginImmediate({autoReturn:!!aiRuntime.autoReturn});
  return true;
}

// ═══ 「开始计算」的总入口（2026-09-14 下半场）═══════════════
//
//  ⭐ 按【当前选中的是哪条预设】分流：
//      选着抠像这类工具预设 → 跑抠像
//      其它（文字预设 / 手打提示词）→ 照旧跑生成
//
//  ⚠⚠ 为什么要有这一层：用户要的是"抠像和文字预设一样，选中了就能用快捷键开始"。
//    原来抠像只有自己面板上那个按钮，选中它之后按快捷键跑的还是上一条 banana 预设
//    —— 那就是他报的"和 banana 文本预设打架"。
//  ⚠ 快捷键、预设面板上的 ▶、以后再加的任何入口，全部走这一个函数。
//    多开一个入口 = 多一份会跟这儿跑偏的逻辑（项目里那条老规矩）。
//  ⚠ 生成主卡上那个「开始生成」按钮【不走这里】，它明写着是生成，
//    按了就该生成，不该因为预设选了抠像就变成抠像。
function runNow(root){
  if(document.activeElement?.closest?.('.v7-agent-dock'))return false;
  if(window.V7CreativeTools&&V7CreativeTools.isOpen()){V7CreativeTools.run();return true;}
  if(window.V7CameraLight&&V7CameraLight.isOpen()){V7CameraLight.run();return true;}
  if(window.V7CanvasWorkbench&&V7CanvasWorkbench.isOpen()){V7CanvasWorkbench.runSelected();return true;}
  if(window.V7FirstRun&&!V7FirstRun.isComplete()){
    gateFirstRun(()=>runNow(root));
    return false;
  }
  try{
    const PU=window.PRESETUI;
    const tool=PU&&typeof PU.getToolPreset==='function'?PU.getToolPreset():null;
    if(tool){
      if(PU.canOpenToolPreset?.(tool)){PU.openToolPreset(tool).catch(error=>ERR.report(error.code||'CREATIVE_TOOL_FAILED',{message:error.message}));return true;}
      // ⭐⭐ 按 kind 分流的【唯一入口】（2026-09-14 深夜）。
      //   面板上的 ▶、快捷键、以后再加的任何入口全走这里，
      //   所以分流只写这一处 —— 不存在"按钮和快捷键行为不一样"那种事。
      // ⚠ 三条都是异步的，这里【不等】—— 任务卡已经建起来了，状态在卡上看。
      const P=window.PRESETS||{};
      const params=PU.getToolParams?PU.getToolParams():null;
      switch(tool.kind){
        case (P.KIND_SEGMENT||'segment'): startSegment(tool, params); break;
        case (P.KIND_SAM2||'sam2'):       startSAM2(tool, params);    break;
        case (P.KIND_GLOW||'glow'):       startGlow(tool, params);    break;
        case 'camera-light': V7CameraLight.open(tool).catch(error=>ERR.report(error.code||'LIGHTING_FAILED',{message:error.message}));break;
        case 'scene-pack': case 'hemisynth': case 'kao': V7CreativeTools.open(tool.kind==='scene-pack'?'scene':tool.kind,tool).catch(error=>ERR.report(error.code||'CREATIVE_TOOL_FAILED',{message:error.message}));break;
        // ⚠ default 走抠像：老数据里 kind 可能是 'matting'，也可能因为某次升级
        //   变成别的没见过的值。落到抠像至少是个能用的行为，
        //   总比"点了没反应"强（本项目最忌讳的故障形态）。
        default:                          startMatting(tool, params); break;
      }
      return true;
    }
  }catch(e){
    ERR.report('MATTING_RUN_FAILED',{message:'分流到抠像时出错：'+String(e&&e.message||e),raw:e&&e.stack});
    return true;
  }
  return generationRunNow(root);
}

function bindGenerationDetail(root){
  // 共用动作绑定：抓取、参考图、传回和结果更新都与已通过的 AI 运行时保持一致。
  bindAiDetail(root);
  root.querySelectorAll('[data-generation-run]').forEach(btn=>btn.addEventListener('click',e=>{
    e.preventDefault();e.stopPropagation();
    generationRunNow(root);
  }));
}
// 兜底：只有主进程全局快捷键注册失败时才用页面监听。
// 注册成功时 Windows 会把组合键直接交给主进程，页面根本收不到 keydown，
// 所以这层平时是静默的，不会和主进程重复触发。
if(!window.__generationShortcutFallbackBound){
  window.__generationShortcutFallbackBound=true;
  window.addEventListener('keydown',e=>{
    // ⭐ 2026-10-17 夜：一键收起 / 展开的兜底 —— 看它自己的全局键注册成没成（跟生成键各算各的），所以排在生成键那道「注册成功就不管」前面
    if(!shortcutCollapseGlobalOk&&!e.target.closest?.('.v7-agent-dock')&&!v7OverlayOpen()&&shortcutMatchesEvent(e,'collapseShortcut')){
      if(toggleCollapseByShortcut()){e.preventDefault();e.stopPropagation();}
      return;
    }
    // 2026-10-21：换下一家渠道的兜底（同上：看它自己的全局键注册成没成）
    if(!shortcutProviderGlobalOk&&!e.target.closest?.('.v7-agent-dock')&&!v7OverlayOpen()&&shortcutMatchesEvent(e,'providerShortcut')){
      if(providerCycleByShortcut()){e.preventDefault();e.stopPropagation();}
      return;
    }
    if(shortcutGlobalOk)return;
    if(e.target.closest?.('.v7-agent-dock'))return;
    if(v7OverlayOpen())return;
    if(shortcutMatchesEvent(e)){e.preventDefault();e.stopPropagation();runNow();return;}
    // ⭐ 2026-10-14：参考图键的兜底（同一个监听里判，不新挂一个）。
    //   ⚠ 顺序在生成之后：万一两个键意外配成一样，生成优先（那是主操作）。
    if(shortcutMatchesEvent(e,'referenceShortcut')){
      e.preventDefault();e.stopPropagation();
      referenceCaptureSelection(V7PresetReferences.context()).catch(V7PresetReferences.report);
    }
  },true);
}
// ⭐⭐ 2026-10-07 卡片拆分（docs/155）：生成卡【档位 0~2】的渲染从这里搬出去。
//   为什么以前搬不动：这段逻辑写在 fillGenerationDetail 内部的 writeAll 闭包里，
//   而 fillGenerationDetail 自己就是分发器 —— 从卡片文件回调它会【成环】。
//   现在抽成独立函数 renderGenerationPanel(body, zone)，卡片文件直接调它，
//   不再经过分发器。fillGenerationDetail 只剩"什么时候填"这件事。
//
//   ⚠ zone 参数化：原闭包直接读全局 zoneSel，抽出来后必须由调用方传进来。
//     抄这段代码改别处时，别再把 zoneSel 硬塞回去 —— 那样卡片就又被绑死在这个作用域了。
function renderGenerationPanel(body, zone){
  const z=Number(zone)||0;
  let html='<div class="generation-panel" data-generation-zone="'+z+'">';
  if(z===0){
    html+='<div class="ai-help"><b>生成图片</b><br>填写你想要的画面，然后点击生成。当前任务会自动保存 Photoshop 文档和选区，传回时会回到原位。</div>';
    // ⚠ 模型/分辨率/宽高比/张数/抗截断/自动传回【已搬到一级卡面上】(2026-09-11 用户定案)，
    //   这里不再重复出现 —— 同一个参数两个入口，用户会不知道该调哪个，
    //   而且两份 DOM 都带 data-ai-field，aiReadFields 是全页扫的，后出现的会盖掉先出现的。
    //   提示词也不在这里: 那是预设系统的地盘(剪影卡右滑的提示词框)。
    //   卡面渲染见 renderGenerationCardFields()。
    // aria-keyshortcuts 必须跟着当前设置走：之前写死 Control+Enter，用户改成别的键后
    // 无障碍朗读和提示就和真实按键对不上了。
    html+='<div class="ai-actions"><button class="ai-btn" data-ai-action="capture">加载当前选区</button><button class="ai-btn primary" data-generation-run aria-keyshortcuts="'+escapeHtml(ariaShortcutValue(settingsRuntime.generationShortcut||''))+'" title="'+escapeHtml(shortcutTitle('开始生成',settingsRuntime.generationShortcut))+'">开始生成</button></div>';
    html+='<div class="ai-status"><strong data-ai-status>'+escapeHtml(aiRuntime.status)+'</strong><span data-ai-progress-text>'+aiRuntime.progress+'%</span></div><div class="ai-progress"><i data-ai-progress style="width:'+aiRuntime.progress+'%"></i></div>';
    html+='<div class="ai-plan"><span>输入图：<b data-ai-source>'+aiPlan().source+'</b></span><span>目标尺寸：<b data-ai-target>'+aiPlan().target+'</b></span></div><div data-ai-output-area>'+aiResultsHtml()+'</div>';
  }else if(z===1){
    html+='<div class="ai-help"><b>参考图片</b><br>从 Photoshop 的当前文档和选区加载参考图。快照会和本次任务绑定，切换文档不会改写已开始的任务。</div>';
    html+='<div class="ai-actions"><button class="ai-btn" data-reference-map>图片节点</button></div><div data-generation-ref>'+generationReferencePreview()+'</div>';
    html+='<div class="ai-plan"><span>当前来源：<b data-ai-source>'+aiPlan().source+'</b></span><span>模式：<b data-ai-mode>'+aiPlan().mode+'</b></span></div>';
  }else if(z===2){
    html+='<div class="ai-help"><b>生成结果</b><br>只会显示已完成的图片。传回按钮会使用该任务自己的文档、选区和快照。</div>';
    html+='<div class="ai-actions"><button class="ai-btn primary" data-ai-action="place" data-ai-place>传回到 Photoshop</button></div><div data-ai-output-area>'+aiResultsHtml()+'</div>';
    html+='<div class="ai-status"><strong data-ai-status>'+escapeHtml(aiRuntime.status)+'</strong><span data-ai-count>'+(aiRuntime.outputs||[]).length+'张</span></div>';
  }else{
    html+='<div class="ai-help"><b>使用说明</b><br>每次点击“开始生成”都会新建一个任务，并在开始时锁定文档、选区和输入图。生成期间可以切换 Photoshop 文档；任务完成后仍回到原来位置。</div>';
    html+='<div class="settings-section"><div class="settings-section-title"><span>状态说明</span></div><div class="settings-note">① 参考图片来自当前选区。<br>② 任务之间互不覆盖。<br>③ 原文档关闭时会明确提示，不会误贴到当前文档。</div></div>';
  }
  html+='</div>';
  body.innerHTML=html;
  bindGenerationDetail(body);
  aiRefreshInPlace();
  V7CardArchitecture.helpify(body);
}
