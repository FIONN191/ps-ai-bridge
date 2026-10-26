// ═══ ui-main/06-cache-preview-viewer.js —— 主界面主程序第 6 / 21 段 ═══
//   管什么：移除任务 · 生成缓存 · 预览弹层 · 大图查看器
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ── 移除任务(向下滑出) ──
// ═══ 生成缓存 ═══
// 结构: <缓存根>/<PS项目名>/<每次计算>/{meta.json, input.png, output_N.png, thumb_N.jpg, prompt.txt}
// 目的: 算过的任务重启后还在，测界面不用再花钱调一次真实接口。
//
// ⚠ 缓存根现在写死在项目文件夹下，**正式发布前必须改成用户自选目录**(docs/10)。
const CACHE_META_VERSION = 1;
function cacheAvailable(){ return !!(window.uiwin && window.uiwin.cache); }
function cacheNamespaceId(){
  return window.WHEELCHAIR_STORAGE
    ? window.WHEELCHAIR_STORAGE.namespaceId() : 'legacy';
}
function cacheScopedProject(project){
  const value=String(project||'');
  if(window.WHEELCHAIR_STORAGE && window.WHEELCHAIR_STORAGE.ownsCacheProject(value)) return value;
  return window.WHEELCHAIR_STORAGE
    ? window.WHEELCHAIR_STORAGE.cacheProject(value) : value;
}
function cacheOwnsEntry(entry){
  if(!entry || !entry.meta) return false;
  if(window.WHEELCHAIR_STORAGE && !window.WHEELCHAIR_STORAGE.ownsCacheProject(entry.project)) return false;
  return entry.meta.namespaceId===cacheNamespaceId();
}

// 文件夹名清洗: Windows 非法字符、结尾空格、开头的点都要处理，否则建不出目录。
function cacheSafeSegment(name){
  const cleaned = String(name||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[\s.]+$/,'').replace(/^\.+/,'').slice(0,80).trim();
  return cleaned || '未命名';
}
// PS 项目名。⚠ 未保存的文档都叫"未标题-1"，必须带上 docId，
//   否则几个不同的未保存项目会全挤进同一个文件夹。
// 任务是否已经知道自己来自哪个 PS 文档（有文档名或 docId）。判断口径与 cacheProjectName 一致。
function cacheTaskHasSource(task){
  const snap = task && task.captureSnapshot;
  const name = String((task && task.sourceDocName) || (snap && snap.docName) || '').trim();
  const id = (task && task.sourceDocId != null) ? task.sourceDocId : (snap && snap.docId);
  return !!name || id != null;
}
function cacheProjectName(task){
  const snap = task && task.captureSnapshot;
  const name = String((task && task.sourceDocName) || (snap && snap.docName) || '').trim();
  const id = (task && task.sourceDocId != null) ? task.sourceDocId : (snap && snap.docId);
  if(name) return cacheSafeSegment(name);
  return cacheSafeSegment('未保存文档-' + (id == null ? '未知' : id));
}
function cacheStamp(ms){
  const d = new Date(Number(ms)||Date.now()), p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
}
// 传回只需要文档、选区这些小字段。⚠ 绝不把 inputImageBase64/sourceImageBase64 写进
//   meta.json —— 那是几十 MB 的字符串，写进去等于把 docs/21 的教训再犯一遍。
function cacheSlimSnapshot(snap){
  if(!snap) return null;
  return {docId:snap.docId, docName:snap.docName, selection:aiClonePlain(snap.selection),
          antiMode:snap.antiMode, capturedAt:snap.capturedAt, captureId:snap.captureId,
          width:snap.width, height:snap.height, mime:snap.mime};
}
function cacheMetaFromTask(task, project, runId, inTaskbar){
  return {
    version:CACHE_META_VERSION, savedAt:Date.now(), project:project, runId:runId,
    repository:'cache.v1', namespaceId:cacheNamespaceId(),
    projectId:task.productProjectId||undefined,
    migration:task.migration?aiClonePlain(task.migration):undefined,
    inTaskbar:!!inTaskbar,
    taskId:String(task.taskId||''), kind:task.kind, label:task.label, icon:task.icon,
    colorToolRunId:String(task.colorToolRunId||''),preserveGeneratedAppearance:task.preserveGeneratedAppearance===true,
    toolParams:['glow','dlss'].includes(task.kind)?aiClonePlain(task.toolParams):undefined,
    provider:task.provider, model:task.model, size:task.size, aspectRatio:task.aspectRatio,
    // ⭐ 记录与恢复卡（2026-09-30）：算力通道 + 金额快照。
    //   connectionSlot 区分 grs 和自定义服务商（provider 只有 aji/momo/other，不够用）。
    //   cost 在【完成那一刻】写死：以后改价目表不动旧账，这是用户定的规矩。
    //   ⚠ 只在任务真到终态时才写 cost —— 半路的记录卡要显示「生成中」，不是金额。
    computeSource:task.computeSource||undefined,
    connectionSlot:task.connectionSlot||undefined,
    channelLabel:task.channelLabel||undefined,
    cost:(function(){
      if(!window.V7RecordsCore||typeof V7RecordsCore.costSnapshot!=='function') return undefined;
      if(!(taskIsDone(task.status)||task.status==='failed'||task.status==='cancelled')) return undefined;
      try{ return V7RecordsCore.costSnapshot(task); }catch(_){ return undefined; }
    })(),
    batch:task.batch, prompt:task.prompt, antiMode:Number(task.antiMode)||0,
    workflowParameters:aiPersistentParameters(task.workflowParameters,task),workflowPresetId:String(task.workflowPresetId||''),
    presetId:task.presetId,presetTitle:task.presetTitle,presetVersion:task.presetVersion,protocol:task.protocol,
    status:task.status, pct:Number(task.pct)||0, sub:task.sub, startedAt:task.startedAt,
    // ⭐ 2026-10-19（docs/250 第 20 条）：失败在哪一步。重启恢复回来的任务 errorInfo 是空的，「重跑」按钮靠它判断给不给。
    failedStage:task.status==='failed'?(String(task.errorInfo&&task.errorInfo.stage||task.failedStage||'')||undefined):undefined,
    completedAt:task.completedAt||undefined,
    sourceDocId:task.sourceDocId, sourceDocName:task.sourceDocName,
    sourceSelection:task.sourceSelection?aiClonePlain(task.sourceSelection):undefined,
    mattingTierName:task.mattingTierName||undefined, mattingSize:task.mattingSize||undefined,
    captureSnapshot:cacheSlimSnapshot(task.captureSnapshot),
    // Photoshop 图层信息。⚠ 必须存: 重启后恢复的任务要靠它继续做 hover 联动，
    //   否则恢复回来的卡片划上去没反应。图层可能已经不在了，用的时候静默降级。
    psLayerIds:Array.isArray(task.psLayerIds)?task.psLayerIds:[],
    // ⚠ 对照表必须一起存，否则重启后恢复的任务 hover 会错位(或干脆没反应)
    psLayerByShot:task.psLayerByShot||{},
    psGroupId:task.psGroupId!=null?task.psGroupId:null,
    psGroupName:task.psGroupName||'',
    psDocId:task.psDocId!=null?task.psDocId:null,
    // ⭐ 盖印判定基线（2026-09-14）。⚠ 必须存：不存的话重启后恢复的任务没有基线，
    //   「盖印后自动收起」对它就完全不生效（eligible() 会直接排除）。
    //   ⚠ 只在真有基线时才写这个字段 —— 写成空数组会让判定退化成误判制造机。
    stampBaseline:Array.isArray(task.stampBaseline)?task.stampBaseline:undefined,
    hasInput:!!task.sourceImgId,
    // ⭐⭐ 2026-10-05（docs/143 §五）：任务级「显示哪一版」。
    //   ⚠ 必须存进 meta.json：不存的话重启后小眼睛回到默认（校色版），
    //     而用户明明切到了底版 —— 他会以为"切了没用/软件记不住"。
    //   ⚠ 存在任务级（不是每张 shot 上）—— 用户拍板"整个任务卡一个开关"。
    colorVersion:taskColorVersion(task),
    // C01 R4/R9：这一单带了几张参考图（缓存里是 ref_1..N）。恢复回来的任务没有 referenceAssets，沿用上次记的数。
    referenceCount:Array.isArray(task.referenceAssets)?task.referenceAssets.length:(Number(task.referenceCount)||0),
    shots:(task.shots||[]).map((s,i)=>({
      index:i, done:!!(s&&s.done), error:(s&&s.error)||'',
      restoreState:(s&&s.restoreState)||'', hasImage:!!(s&&s.imgId),
      // B01 第 1 步：这一张有没有存校色前的 AI 原图（raw_N.png）。没校色/没对齐的那张没有，读的人别去找。
      hasRaw:!!(s&&s.rawSaved),
      // ⭐⭐ 2026-10-05（docs/143 §二-2.2）：这一张有没有存【底版】base_N.png
      //   （掰正过、没校色）。老任务没有 → 小眼睛置灰、点了弹"缺少文件"。
      //   ⚠ 跟 hasRaw 分开记：两者来源不同（raw 来自 AI 原样，base 来自引擎掰正后），
      //     合成一个字段的话「有 raw 没 base」这种既有任务会被误判成"能切版本"。
      hasBase:!!(s&&s.baseSaved),
      // ⭐ 2026-10-18：生成时实际用的那种校色（切版本靠它认「自动那一种」=output_N.png）。不存的话重启后又全当成混合
      autoVersion:(s&&s.autoVersion)||'',
      // ⭐ 细节补偿的档位和它贴出来的图层 ID（2026-09-12）。
      //   不存的话重启后角标会消失、换档时也删不掉旧的那层 —— 会越叠越多。
      detailTier:(s&&s.detailTier)||'',
      detailLayerId:(s&&s.detailLayerId!=null)?s.detailLayerId:null,
      // ⭐ 2026-10-05：「应用」贴出来的那层（嵌在底座上）。不存的话重启后再点「应用」删不掉旧的，会越叠越多。
      tweenLayerId:(s&&s.tweenLayerId!=null)?s.tweenLayerId:null,
      tweenStrength:(s&&s.tweenStrength!=null)?s.tweenStrength:null
    }))
  };
}

// 把一次计算落盘。
// ⚠⚠ 2026-09-13 改成【可以补存】（用户实测的 bug）：
//   老写法是"只在任务到终态时调一次"，配合 updateGenerationTask 里那个 cacheSaved 布尔闸门。
//   后果：「提前结束」时传回成功会把任务写成终态并落一次盘，闸门一关，
//   后台【算完的那几张永远写不进缓存】—— 重载后只剩前半批。
//   现在允许反复调用，靠 task._cachedFiles 记住"哪些图已经写过"来避免重复 I/O：
//     · 已经写过的原图/缩略图直接跳过（这是几百 MB 的那部分）
//     · meta.json 每次都重写（几 KB，它要带上最新的 shots / 图层对照表）
//   ⚠ 再加一把在途锁：两个写手同时改同一个 meta.json 会互相盖，
//     所以正在写的时候只记一个"待补写"的标记，写完再补一次。
async function cacheSaveTask(task){
  if(!cacheAvailable() || !task || !['generation','glow','dlss','matting','segment','sam2'].includes(task.kind)) return;
  const currentNamespace=()=>typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy';
  const saveNamespace=currentNamespace();
  const saveEpoch=typeof sourceImageEpoch==='number'?sourceImageEpoch:0;
  if(task.storageNamespaceId && task.storageNamespaceId!==saveNamespace) return;
  task.storageNamespaceId=saveNamespace;
  const assertNamespace=()=>{ if(saveNamespace!==currentNamespace() || saveEpoch!==(typeof sourceImageEpoch==='number'?sourceImageEpoch:0)) throw new Error('存储账号已切换，放弃旧任务写入'); };
  if(task._cacheWriting){ task._cacheDirty = true; return; }
  task._cacheWriting = true;
  if(!task._cachedFiles) task._cachedFiles = new Set();
  const written = task._cachedFiles;
  try{
    const persist=async()=>{
    assertNamespace();
    const project = cacheScopedProject(task.cacheProject || cacheProjectName(task));
    task.cacheProject = project;
    const runId = task.cacheRunId || (task.cacheRunId = cacheStamp(task.startedAt)+'-'+task.id);
    const cache = window.uiwin.cache;
    const enc = new TextEncoder();
    // Cache adapters return a result object instead of throwing for filesystem
    // failures. Treat every non-ok result as a real failure so the task does
    // not claim a file was persisted when it was only attempted.
    const writeChecked = async (operation, label) => {
      assertNamespace();
      const result = await operation();
      assertNamespace();
      if(!result || result.ok !== true) {
        const detail = result && result.error ? ': '+String(result.error) : '';
        throw Object.assign(new Error(String(label || '缓存写入失败') + detail),{cacheKind:result&&result.kind||'',cachePath:result&&result.path||''});
      }
      return result;
    };
    // 输入图(任务卡背景那张)。它是"用户看到的正常原图"，不是抗截断偏移后的输入。
    if(task.sourceImgId && window.IMG.has(task.sourceImgId) && !written.has('input:'+task.sourceImgId)){
      const thumb=new Uint8Array(await window.IMG.thumbBytes(task.sourceImgId));
      await writeChecked(()=>cache.writeFile(project, runId, 'input_thumb.jpg', thumb), '输入图缩略图写入失败');
      const full=new Uint8Array(await window.IMG.fullBytes(task.sourceImgId));
      await writeChecked(()=>cache.writeFile(project, runId, 'input.png', full), '输入图写入失败');
      written.add('input:'+task.sourceImgId);
      // ⭐ 2026-10-16：磁盘上有了 ⇒ 内存紧时这张原图可以放掉、要用再读（image-store.js 的 trimFull，治开久了面板卡死）
      window.IMG.attachLoader?.(task.sourceImgId, ()=>cache.readFile(project, runId, 'input.png'));
    }
    // 每张结果: 原图 + 缩略图都写。
    // ⚠ 缩略图必须一起写: 重启时直接读它，不用把每张 4K 原图重新解码一遍(启动会卡死)。
    // ⚠ key 里带 imgId —— 万一同一格换了图(重试)，imgId 会变，就该重新写一遍。
    for(let i=0;i<(task.shots||[]).length;i++){
      assertNamespace();
      const shot = task.shots[i];
      if(!shot) continue;
      // ⭐⭐⭐ 2026-10-08 修 BUG（docs/170 §一-①、§4.3 不变量 8）——
      //   【这是那个丢数据 bug 的正主】
      //
      //   改之前：这里用的是 `shot.imgId`（= 当前显示的那张）。
      //     而 toggleTaskColorVersion() 切到底版时会把 shot.imgId 换成底版那张，
      //     于是"切到底版之后的下一次保存"就把【底版】写进了 output_N.png ——
      //     校色版从磁盘上消失，重启后切回"校色"读到的也是底版。
      //     实测：meta.colorVersion='base' 的 27 张里【24 张】两个文件字节完全相同；
      //           'colormatched' 的 83 张里只有 9 张（7.2%）—— 相关 12 倍。
      //     缩略图判定佐证：那 24 张里 11 张的缩略图与现在的 output 对不上
      //     （缩略图是保存当时从 output 做的）⇒ output 事后被换过。
      //
      //   改之后：写盘一律认 `autoImgId` —— 它是【生成时自动方式那一张】的证件号。
      //     切版本【只改 shot.imgId（显示用），不碰 autoImgId（存档用）】。
      //
      //   ⚠ 取图的 id 和去重 key 里的 id【必须是同一个】（不变量 8）：
      //     只换取图、不换 key 的话，每切一次版本 key 就变一次 ⇒
      //     每次保存都把同一份内容重写一遍（4K 约 8MB/张，白写、磨硬盘）。
      //   ⚠ 兜底 `||shot.imgId`：老任务 / 中间态可能还没有 autoImgId。
      //     有兜底最坏退回旧行为，不会"一张都不写"（静默失效是这个项目最忌的形态）。
      // ⚠ 自愈兜底（docs/170 §4.3 不变量 8）：autoImgId 为空时补上。
      //   走到这里说明还没写过盘、或者是升级前的老任务。
      //   ⚠ 这只是【最后一道保险】—— 真正第一道在 toggleTaskColorVersion 里（切之前就补）。
      if(!shot.autoImgId && shot.imgId) shot.autoImgId = shot.imgId;
      const autoId = shot.autoImgId || shot.imgId;
      if(!autoId || !window.IMG.has(autoId)) continue;
      const key = 'shot:'+i+':'+autoId;
      if(written.has(key)) continue;
      const n = i+1;
      const full=new Uint8Array(await window.IMG.fullBytes(autoId));
      await writeChecked(()=>cache.writeFile(project, runId, 'output_'+n+'.png', full), '第 '+n+' 张结果写入失败');
      window.IMG.attachLoader?.(autoId, ()=>cache.readFile(project, runId, 'output_'+n+'.png'));   // 同上：能从磁盘读回来了，内存紧时可放
      const thumb=new Uint8Array(await window.IMG.thumbBytes(autoId));
      await writeChecked(()=>cache.writeFile(project, runId, 'thumb_'+n+'.jpg', thumb), '第 '+n+' 张缩略图写入失败');
      written.add(key);
    }
    // ⭐ 2026-10-02 B01 第 1 步：校色/对齐之前的 AI 原图 → raw_N.png（只有真改过的那张才有）。
    //   output_N.png 仍然是校色后的（所见即所得，传回 PS、记录卡都照旧读它，一个字不变）。
    //   ⚠ 写完就从内存释放 —— 它只是给事后对比/补校色用的，留在内存里一批 18 张 4K 就是双倍占用。
    //   ⚠ 单独一圈循环、单独的 key（raw:），跟上面的 output 互不影响：
    //     原图写失败不会让结果图被判成没写，反过来也一样。
    for(let i=0;i<(task.shots||[]).length;i++){
      assertNamespace();
      const shot = task.shots[i];
      if(!shot || !shot.rawImgId || !window.IMG.has(shot.rawImgId)) continue;
      const key = 'raw:'+i+':'+shot.rawImgId;
      if(written.has(key)) continue;
      const raw=new Uint8Array(await window.IMG.fullBytes(shot.rawImgId));
      await writeChecked(()=>cache.writeFile(project, runId, 'raw_'+(i+1)+'.png', raw), '第 '+(i+1)+' 张 AI 原图写入失败');
      written.add(key);
      shot.rawSaved=true;
      window.IMG.release(shot.rawImgId);
    }
    // ⭐⭐ 2026-10-05（docs/143 §二-2.2）：底版 → base_N.png。
    //   底版 = 【掰正过、没校色】的那一张（不是 AI 原样，那个是 raw_N.png）。
    //   ⚠ 两个都要留，别合并：
    //     · raw_N.png  = AI 原样（没掰正、没校色）→ 事后复盘"鬼影是校色造的还是 AI 造的"用
    //     · base_N.png = 掰正过、没校色        → 历史卡显示它、小眼睛切到它
    //     前者位置可能是歪的，后者位置是对的 —— 用户看到的"生成出来的样子"是后者。
    //   ⚠ 单独一圈循环 + 单独的 key（base:），跟 output / raw 互不影响：
    //     底版写失败不该让成品被判成没写（反过来也一样）。
    //   ⚠ 语义：output_N.png 【一个字都不改】（记录卡、传回、历史都读它）——
    //     本次只是【加】一个新文件。docs/143 第十一节最后一条。
    for(let i=0;i<(task.shots||[]).length;i++){
      assertNamespace();
      const shot = task.shots[i];
      if(!shot || !shot.baseImgId || !window.IMG.has(shot.baseImgId)) continue;
      const key = 'base:'+i+':'+shot.baseImgId;
      if(written.has(key)) continue;
      const base=new Uint8Array(await window.IMG.fullBytes(shot.baseImgId));
      await writeChecked(()=>cache.writeFile(project, runId, 'base_'+(i+1)+'.png', base), '第 '+(i+1)+' 张底版写入失败');
      written.add(key);
      shot.baseSaved=true;
      window.IMG.release(shot.baseImgId);
    }
    // ⭐⭐⭐ 2026-10-08（docs/170 §4.3 不变量 2 · 第 2 步）：各版本 → color_<版本>_<n>.png
    //   ⚠ 自动方式那一种【不在这里写】—— 它就是 output_N.png（不变量 2：不重复存）。
    //   ⚠ 单独一圈循环 + 单独的 key：某一版写失败不该让别的版被判成没写。
    //   ⚠ 去重 key 里带 imgId：同一版重算之后 id 会变，就该重写一遍（照 shot: 那条的做法）。
    for(let i=0;i<(task.shots||[]).length;i++){
      assertNamespace();
      const shot = task.shots[i];
      if(!shot || !shot.versions) continue;
      const autoV = shotAutoVersion(task, shot);
      for(const ver of COLOR_VERSIONS){
        if(ver === 'base' || ver === autoV) continue;      // base 与自动方式各有自己的文件名
        const vid = shot.versions[ver];
        if(!vid || !window.IMG.has(vid)) continue;
        const vkey = 'ver:'+ver+':'+i+':'+vid;
        if(written.has(vkey)) continue;
        const bytes = new Uint8Array(await window.IMG.fullBytes(vid));
        await writeChecked(
          ()=>cache.writeFile(project, runId, colorVersionExtraFile(ver, i), bytes),
          '第 '+(i+1)+' 张的'+COLOR_VERSION_LABEL[ver]+'版写入失败');
        written.add(vkey);
        if(!shot.versionSaved) shot.versionSaved = {};
        shot.versionSaved[ver] = true;
      }
    }
    // ⭐ 2026-10-02 融合方案-C01 R4（用户 2026-10-01）：「没点计算 → 临时参考图不落盘；点了计算 → 落盘进缓存」。
    //   这一单带走的参考图原样写成 ref_N.<原格式>（原始字节，不重新编码）。
    //   ⚠ 这里是「点了计算」之后才会走到的地方，所以 R2「关软件不留」和 R4 不冲突：
    //     弹窗里加了没生成的图从来不进这里。
    //   ⚠ 张数记进元数据 referenceCount —— R9「历史卡显示带了几张参考图」要用。
    const refAssets=Array.isArray(task.referenceAssets)?task.referenceAssets:[];
    for(let i=0;i<refAssets.length;i++){
      assertNamespace();
      const asset=refAssets[i];
      if(!asset||!(asset.full instanceof Blob))continue;
      const key='ref:'+i+':'+String(asset.assetId||asset.name||'');
      if(written.has(key))continue;
      const ext=/jpe?g/i.test(asset.mime||'')?'jpg':/webp/i.test(asset.mime||'')?'webp':'png';
      // ⚠ 2026-10-18 深夜（线上 459 次 CACHE_WRITE_FAILED）：参考图读不出来（老版本留下的磁盘文件引用、原文件已被挪走）
      //   只跳过这一张 —— 原来是整个存缓存一起失败，提示词、记录都没写成，而且每更新一次就再失败一次。
      let bytes;
      try{ bytes=new Uint8Array(await asset.full.arrayBuffer()); }
      catch(error){ written.add(key); logRecordsDiag('第 '+(i+1)+' 张参考图读不出来（原文件可能被挪走或改过），这张不存进缓存：'+String(error&&error.message||error)); continue; }
      await writeChecked(()=>cache.writeFile(project, runId, 'ref_'+(i+1)+'.'+ext, bytes), '第 '+(i+1)+' 张参考图写入失败');
      written.add(key);
    }
    if(!written.has('prompt')){
      assertNamespace();
      await writeChecked(()=>cache.writeFile(project, runId, 'prompt.txt', enc.encode(String(task.prompt||''))), '提示词写入失败');
      written.add('prompt');
    }
    await writeChecked(()=>cache.writeMeta(project, runId, cacheMetaFromTask(task, project, runId, true)), '缓存元数据写入失败');
    task.cacheSaved = true;
    // 历史中心是可选模块。隔离渲染、恢复模式或旧版页面没有它时，
    // 不能让已经成功写入的缓存被误报成失败。
    if(typeof historyRecordTask==='function') historyRecordTask(task);
    };
    if(typeof checkpointRuntime!=='undefined'&&checkpointRuntime&&checkpointRuntime.withCacheCapacity){
      let incoming=16384+String(task.prompt||'').length*3;
      const images=[];
      if(task.sourceImgId&&!written.has('input:'+task.sourceImgId))images.push(task.sourceImgId);
      (task.shots||[]).forEach((shot,i)=>{if(shot&&shot.imgId&&!written.has('shot:'+i+':'+shot.imgId))images.push(shot.imgId);});
      // B01：校色前原图也要算进容量（不然「先问够不够地方」就漏算了一半）
      (task.shots||[]).forEach((shot,i)=>{if(shot&&shot.rawImgId&&window.IMG.has(shot.rawImgId)&&!written.has('raw:'+i+':'+shot.rawImgId))images.push(shot.rawImgId);});
      // ⭐ 143：底版（base_N.png）也要算 —— 它跟成品同样大小（都是 4K PNG），
      //   漏算的话「先问够不够地方」会少算一倍，"空间不够"永远问不出来。
      (task.shots||[]).forEach((shot,i)=>{if(shot&&shot.baseImgId&&window.IMG.has(shot.baseImgId)&&!written.has('base:'+i+':'+shot.baseImgId))images.push(shot.baseImgId);});
      // C01 R4：这一单带的参考图（原始 Blob，不在图片管家里，按 Blob 大小直接算）
      (Array.isArray(task.referenceAssets)?task.referenceAssets:[]).forEach((asset,i)=>{if(asset&&asset.full instanceof Blob&&!written.has('ref:'+i+':'+String(asset.assetId||asset.name||'')))incoming+=asset.full.size;});
      if(window.IMG.byteSizes)images.forEach(id=>{const bytes=window.IMG.byteSizes(id);incoming+=bytes.fullBytes+bytes.thumbBytes;});
      await checkpointRuntime.withCacheCapacity(incoming,persist);
    }else await persist();
  }catch(e){
    // 缓存失败不能影响生成本身，只记一笔日志。
    if(/^CHECKPOINT_CAPACITY_/.test(e.code||''))ERR.report(e.code,{message:String(e&&e.message||e)});
    else if(ERR.cacheFailure)ERR.cacheFailure('CACHE_WRITE_FAILED',{kind:e&&e.cacheKind,path:e&&e.cachePath,code:e&&e.code,error:String(e&&e.message||e)});
    else ERR.report('CACHE_WRITE_FAILED',{message:String(e&&e.message||e)});
  }finally{
    task._cacheWriting = false;
    if(task._cacheDirty){
      task._cacheDirty = false;
      if(saveNamespace===currentNamespace()&&saveEpoch===(typeof sourceImageEpoch==='number'?sourceImageEpoch:0)) cacheSaveTask(task).catch(()=>{});
    }
  }
}

// 传回 / 编组之后把最新状态写进缓存。两条路分开走：
//   · 从缓存恢复的历史任务 → 只更新 meta（图片本来就在盘上，重写是白花 I/O）
//   · 本次新算的任务 → 走 cacheSaveTask（它自己跳过已经写过的图）
function cachePersistTask(task){
  if(!cacheAvailable() || !task || !['generation','glow','dlss','matting','segment','sam2'].includes(task.kind)) return;
  if(task.restoredFromCache){ cacheSetTaskbar(task, true).catch(()=>{}); return; }
  cacheSaveTask(task).catch(()=>{});
}

// 只更新"是否还在任务栏"，不重写图片。点 X 和恢复时用。
async function cacheSetTaskbar(task, inTaskbar){
  if(!cacheAvailable() || !task || !task.cacheRunId || !task.cacheProject) return;
  const currentNamespace=typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy';
  if(task.storageNamespaceId && task.storageNamespaceId!==currentNamespace) return;
  try{
    const result = await window.uiwin.cache.writeMeta(task.cacheProject, task.cacheRunId,
      cacheMetaFromTask(task, task.cacheProject, task.cacheRunId, inTaskbar));
    if(!result || result.ok!==true) throw new Error(result?.error || '任务栏状态未写入缓存');
  }catch(e){
    // ⚠ 别静默: 写失败的话，点了 X 的任务下次启动还会自己冒出来，
    //   用户会以为"X 按钮坏了"，而真实原因是这里写盘失败。
    ERR.report('TASKBAR_UPDATE_FAILED',{message:String(e&&e.message||e)});
  }
}

// 启动时把上次还留在任务栏里的任务拉回来。
// ⚠ 只读 meta.json + 缩略图，原图【不加载】—— 看大图或传回时才按需从磁盘拉。
//   否则一开机就把几百 MB 原图全读进内存，等于什么都没优化。
async function cacheRestoreTasks(){
  if(!cacheAvailable()) return;
  const startedNamespace=typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy';
  const stillCurrent=()=>startedNamespace===(typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy');
  let list;
  try{
    list = await window.uiwin.cache.list();
    if(!list || list.ok!==true || !Array.isArray(list.runs)) throw new Error(list?.error || '缓存目录返回的数据不完整');
  }catch(e){ if(stillCurrent()) ERR.report('CACHE_RESTORE_FAILED',{message:String(e&&e.message||e),stage:'list'}); return; }
  if(!stillCurrent()) return;
  // ⭐⭐ 2026-10-06（用户实测：记录卡里有任务永远"生成中"）：僵尸清扫。
  //   启动这一刻不可能有任务真在跑 —— 凡是磁盘 meta 里还写着 运行中/排队/准备中 的，
  //   都是"上次没跑完"（进程被杀/崩，没等到终态落盘）。
  //   ⚠ 以前只在内存恢复里归一化（cacheRestoreOne 的 6497-6510），【不回写磁盘】；
  //     而记录卡只读磁盘 meta → 那些任务永远显示"生成中 X/Y"。
  //   ⇒ 这里按【同一套口径】把 meta 归一化并写回：done/failed + "上次没跑完 · 存下了 X/Y 张"。
  //     规则不另立第二套，免得两处口径漂（这是本项目的硬规矩）。
  //   ⚠ 只扫本账号拥有的记录；写失败不挡启动。
  try{
    const isLive = (window.V7RecordsCore && typeof V7RecordsCore.isLiveStatus==='function')
      ? s=>V7RecordsCore.isLiveStatus(String(s||''))
      : s=>['running','queued','pending','preparing'].indexOf(String(s||''))>=0;
    const liveRuns = list.runs.filter(r=>r && r.meta && cacheOwnsEntry(r)
      && Number(r.meta.version)===CACHE_META_VERSION && r.meta.repository==='cache.v1'
      && String(r.meta.kind||'')!=='checkpoint' && isLive(r.meta.status));
    for(const entry of liveRuns){
      const m = entry.meta;
      const shots = Array.isArray(m.shots) ? m.shots : [];
      const okCount = shots.filter(s=>s && (s.hasImage || s.done)).length;
      const next = Object.assign({}, m, {
        status: okCount ? 'done' : 'failed',
        sub: '上次没跑完 · 存下了 ' + okCount + '/' + shots.length + ' 张',
        completedAt: m.completedAt || m.savedAt || Date.now()
      });
      try{ await uiwin.cache.writeMeta(entry.project, entry.runId, next); }catch(_){ /* 写不回不挡启动 */ }
    }
  }catch(_){ /* 清扫失败不挡启动 */ }
  const wanted = list.runs
    .filter(r=>r && r.meta && r.meta.inTaskbar && Number(r.meta.version)===CACHE_META_VERSION && r.meta.repository==='cache.v1' && cacheOwnsEntry(r))
    .sort((a,b)=>Number(a.meta.startedAt||0)-Number(b.meta.startedAt||0));   // 旧的先加，新的最后 → 堆顶是最新
  let restored=0;
  for(const entry of wanted){
    if(!stillCurrent()) return;
    try{ const result=await cacheRestoreOne(entry); if(stillCurrent() && result!==false) restored++; }
    catch(e){ ERR.report('CACHE_RESTORE_FAILED',{message:String(e&&e.message||e)}); }
  }
  if(!stillCurrent()) return;
  if(restored) aiAddLog('已从缓存恢复 '+restored+' 个任务','info');
  // ⭐ 恢复回来的任务如果带着盖印基线，也要参与「盖印后自动收起」。
  //   ⚠ 不在这里叫的话，重启后那些卡就再也不会自动收起了 ——
  //   而 recordStampBaseline 只在【新编组】时才跑，恢复路径根本不经过它。
  //   ⚠ 没有可看的任务时 tick 第一轮就会自己停表，不会空转。
  try{ if(typeof stampWatch!=='undefined') stampWatch.ensure(); }catch(_){ }
  // ⚠ 启动时刷一次记录卡（原来这里是白扫整个缓存目录，现在只广播事件）。
  broadcastRecordsChanged();
}

async function cacheRestoreOne(entry){
  const startedNamespace=typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy';
  const stillCurrent=()=>startedNamespace===(typeof cacheNamespaceId==='function'?cacheNamespaceId():'legacy');
  const m = entry.meta, cache = window.uiwin.cache;
  const project = entry.project, runId = entry.runId;
  const readFull = name => () => cache.readFile(project, runId, name);
  const shots = [];
  let sourceImgId = '';
  let attached=false;
  try{
  for(const s of (m.shots||[])){
    const n = Number(s.index)+1;
    if(s.hasImage){
      const thumb = await cache.readFile(project, runId, 'thumb_'+n+'.jpg');
      if(!stillCurrent()) return false;
      if(thumb && thumb.length){
        // ⭐⭐ 2026-10-05（docs/143 §三）：恢复时把 raw / base 的登记【一起重建】。
        //
        //   ⚠ 以前只重建 output_N.png，raw_N.png 只在磁盘上躺着、内存里没有登记 ——
        //     于是"刚开软件好使、重启后不好使"（本项目最难受的那类 bug）。
        //   ⚠ 为什么要补上 base：小眼睛切版本要【换 shot.imgId】、
        //     底版那一版得能当场读到图。没有登记就只能去读磁盘，
        //     而读磁盘是同步 I/O、在渲染路径里做会卡 —— 所以按一等公民登记。
        //   ⚠ 登记底版用读盘函数（readFull）而不是路径字符串：
        //     IMG.putFromCache(thumb, mime, fullReader) 的第三个参数是【懒加载】——
        //     不点开就不读磁盘。这正是 docs/21 要的那套（原图不进 DOM、按需读）。
        const fullOf=(name)=>readFull(name);
        const rec={done:true, error:'', errorInfo:null, restoreState:'done',
                    detailTier:s.detailTier||'',
                    detailLayerId:(s.detailLayerId!=null)?s.detailLayerId:null,
                    tweenLayerId:(s.tweenLayerId!=null)?s.tweenLayerId:null, tweenStrength:(s.tweenStrength!=null)?s.tweenStrength:null,
                    rawSaved:!!s.hasRaw,   // B01：这张有没有 raw_N.png（不恢复的话，元数据一重写就记成没有）
                    baseSaved:!!s.hasBase, // 143：这张有没有 base_N.png（同上，不恢复就会被误记成没有）
                    // ⭐ 2026-10-18：生成时实际用的那种校色。⚠ 只认四个合法值，乱的 / 老数据（没有）一律空 ⇒ 照老规矩当混合
                    //   ⚠ 四个值就地写死、不引用 COLOR_VERSIONS：这段恢复代码会被测试单独切出来跑（那里没有那个常量），
                    //     引用它 = 整段恢复抛错（全量测试抓到 4 条，记忆「V7 测试按源码切片跑」那个坑）。
                    autoVersion:(['base','global','precise','hybrid'].indexOf(String(s.autoVersion||''))>=0)?String(s.autoVersion):'',
                    imgId:window.IMG.putFromCache(thumb, 'image/png', fullOf('output_'+n+'.png')),
                    // ⭐⭐ 2026-10-08（docs/170 §4.3 不变量 8）：**自动方式那张的证件号**。
                    //   ⚠⚠ 为什么必须有：`output_N.png` 是【生成时自动方式的结果】，切版本【永远不改它】。
                    //     可写 output 的那个循环原来用的是 `shot.imgId`（= 当前显示的那张）——
                    //     于是"切到底版"之后再保存一次，就把**底版写进了 output_N.png**，
                    //     校色版从磁盘上彻底消失。实测：切过底版的 27 张里 24 张两个文件字节相同。
                    //   ⇒ 从这一版起：写 output / thumb 一律用 `autoImgId`，不用 `imgId`。
                    //   ⚠ 恢复出来的这张，盘上的 output_N.png 就是自动方式的结果（它从没被切换改过），
                    //     所以 autoImgId 与 imgId 指向同一张 —— 只 putFromCache 一次，别生成两个 id
                    //     （生成两个会各占一份图，内存白白翻倍）。
                    autoImgId:null};
                    // ⚠ 上一步那个对象字面量结束之后单独赋值：autoImgId 和 imgId 指向同一个 id。
                    rec.autoImgId=rec.imgId;
        // ⚠ raw / base 的 registration 失败【不算恢复失败】—— 它们是"事后能做的事"，
        //   为了它们把整张成品丢掉是本末倒置。所以各自 try 住、拿不到就当没有。
        if(s.hasRaw){
          try{ rec.rawImgId=window.IMG.putFromCache(thumb, 'image/png', fullOf('raw_'+n+'.png')); }catch(_){}
        }
        if(s.hasBase){
          try{ rec.baseImgId=window.IMG.putFromCache(thumb, 'image/png', fullOf('base_'+n+'.png')); }catch(_){}
        }
        shots.push(rec);
        continue;
      }
    }
    shots.push({done:false, error:s.error||'', errorInfo:s.error?taskErrorInfo(s.error,'generate','AI_IMAGE_FAILED'):null,
                imgId:'', restoreState:s.restoreState||'failed'});
  }
  if(m.hasInput){
    const thumb = await cache.readFile(project, runId, 'input_thumb.jpg');
    if(!stillCurrent()) return false;
    if(thumb && thumb.length) sourceImgId = window.IMG.putFromCache(thumb, 'image/png', readFull('input.png'));
  }
  // ⚠⚠ 2026-09-13 新增的归一化：恢复回来的任务【一定不在跑了】——
  //   界面重启过，主进程那边的生成早就断了，不可能再有进度回来。
  //   所以存盘时是什么状态都得归到终态，否则会出现一张"停在 40% 的僵尸卡"：
  //   进度条不动、还挂着「提前结束」按钮、点了什么也不会发生。
  //   ⚠ 这道归一化从这一版起是【必须的】：现在传回成功就会落一次盘，
  //     而「提前结束」时落的那一份，状态正是 running。
  const savedStatus=String(m.status||'done');
  const wasRunning=['done','success','completed','failed','cancelled'].indexOf(savedStatus)<0;
  const okCount=shots.filter(s=>s&&s.imgId).length;
  const restoredStatus=wasRunning?(okCount?'done':'failed'):savedStatus;
  // 上次没跑完的要明说少了几张，不然用户会以为图丢了（图确实没出来，但不是这里丢的）
  const restoredSub=wasRunning
    ? ('上次没跑完 · 存下了 '+okCount+'/'+shots.length+' 张')
    : (m.sub||'');
  const task = {
    id:++taskSeq, kind:['generation','glow','dlss','matting','segment','sam2'].includes(m.kind)?m.kind:'generation', taskId:String(m.taskId||''),
    toolParams:['glow','dlss'].includes(m.kind)?m.toolParams:undefined,
    colorToolRunId:String(m.colorToolRunId||''),preserveGeneratedAppearance:m.preserveGeneratedAppearance===true,
    antiMode:Number(m.antiMode)||0, standard:GENERATION_TASK_STANDARD.version,
    label:m.label||'生成任务', icon:m.icon||'check', shots:shots,
    // ⚠ 状态/文字走上面归一化后的值，不直接用 meta 里的原值（见那段注释）
    pct:wasRunning?100:(Number(m.pct)||0), status:restoredStatus, sub:restoredSub,
    page:0, sourceImg:sourceImgId?window.IMG.thumb(sourceImgId):placeholderSVG((m.startedAt||0)%360),
    sourceImgId:sourceImgId, errorInfo:null, life:0, startedAt:Number(m.startedAt)||Date.now(),
    completedAt:m.completedAt||undefined,
    migration:m.migration?aiClonePlain(m.migration):undefined,
    captureSnapshot:m.migration?.returnBlocked?null:m.captureSnapshot||null,
    productProjectId:m.projectId||'',
    // ⚠ outputs 决定"能不能传回"。恢复的任务必须能传回 —— 这正是缓存最大的价值:
    //   不用重新花钱生成，就能反复测传回。
    outputs:shots.map((s,i)=>({index:i, imgId:s.imgId, restoreState:'done'})).filter(s=>s.imgId),
    errors:[],
    sourceDocId:m.migration?.returnBlocked?null:m.sourceDocId, sourceDocName:m.sourceDocName,
    sourceSelection:m.migration?.returnBlocked?null:(m.sourceSelection||m.captureSnapshot&&m.captureSnapshot.selection),
    mattingTierName:m.mattingTierName||'', mattingSize:m.mattingSize||'',
    // ⭐ 2026-10-05（docs/143 §五）：把用户上次选的"显示哪一版"读回来。
    //   ⚠ 缺省是校色版；老 meta.json 里没这个字段 → 读成 undefined → taskColorVersion
    //     自己会兜成 'colormatched'，不用在这里写 ||'colormatched'（两处写就两处会漂）。
    colorVersion:m.colorVersion==='base'?'base':'colormatched',
    provider:m.provider, model:m.model, size:m.size, aspectRatio:m.aspectRatio, channelLabel:String(m.channelLabel||''),
    // ⚠ 2026-10-19 补：算力通道 / 算力来源 / 完成那一刻写死的金额，原来恢复时没带回来 ——
    //   恢复的任务一点 ✕ 或一传回，元数据整份重写，这三样就丢了（记录卡把 grs 当成自定义服务商、旧账按现在的价目表重算）。
    computeSource:m.computeSource||undefined, connectionSlot:m.connectionSlot||undefined, cost:m.cost||undefined,
    failedStage:String(m.failedStage||''),
    presetId:m.presetId,presetTitle:m.presetTitle,presetVersion:m.presetVersion,protocol:m.protocol,
    batch:Number(m.batch)||shots.length, prompt:m.prompt||'',
    workflowParameters:aiClonePlain(m.workflowParameters||{}),workflowPresetId:String(m.workflowPresetId||''),
    cancelRequested:false, returnState:'idle',
    // 恢复 Photoshop 图层信息，让恢复回来的任务也能做 hover 联动。
    // ⚠ 图层可能已经被删/文档已关，调用时静默降级，不在这里预先校验
    //   (校验要发一轮桥指令，为了一个不一定用到的功能不值当)。
    psLayerIds:Array.isArray(m.psLayerIds)?m.psLayerIds:[],
    psLayerByShot:m.psLayerByShot||{},
    psGroupId:m.psGroupId!=null?m.psGroupId:null,
    psGroupName:m.psGroupName||'',
    psDocId:m.psDocId!=null?m.psDocId:null,
    // ⚠ 2026-10-02：参考图张数（C01 R4）要恢复回来 —— 不恢复的话，恢复的任务一传回、元数据重写，张数就被记成 0。
    referenceCount:Number(m.referenceCount)||0,
    // ⚠ 恢复基线。没有就【不给这个字段】(不是给空数组) —— 见 recordStampBaseline 的注释。
    stampBaseline:Array.isArray(m.stampBaseline)?m.stampBaseline.map(Number):undefined,
    cacheProject:project, cacheRunId:runId, cacheSaved:true, restoredFromCache:true,
    storageNamespaceId:m.namespaceId||cacheNamespaceId()
  };
  addTask(task);
  attached=true;
  return true;
  }finally{
    if(!attached) window.IMG.releaseMany([sourceImgId,...shots.map(s=>s.imgId)].filter(Boolean));
  }
}

// 任务用到的所有图片 id。释放时一个都不能漏。
function taskImageIds(task){
  const ids=[];
  if(!task) return ids;
  if(task.sourceImgId) ids.push(task.sourceImgId);
  (task.shots||[]).forEach(s=>{ if(s&&s.imgId) ids.push(s.imgId); if(s&&s.rawImgId) ids.push(s.rawImgId); });   // rawImgId：B01 校色前原图，正常写完缓存就释放了，这里兜底
  (task.outputs||[]).forEach(o=>{ if(o&&o.imgId) ids.push(o.imgId); });
  return ids.filter((x,i,a)=>a.indexOf(x)===i);   // shots 和 outputs 指的是同一批图, 去重
}
function removeTask(id){
  const idx = taskList.findIndex(t => t.id === id);
  if (idx < 0) return;
  const task = taskList[idx];
  if (task.timer) clearTimeout(task.timer);
  // ⚠ 谁创建谁释放。不 revoke 的 Blob 会一直占着内存，而且它不在 JS 堆里，
  //   用常规内存分析根本看不出来 —— 比 base64 泄漏更难查。见 docs/21 铁律 4。
  if(window.IMG) window.IMG.releaseMany(taskImageIds(task));
  // ⭐⭐⭐ 2026-10-08（docs/170 §10.1 H2）：插帧帧也要一起放掉。
  //   ⚠ 改之前【没有任何地方调 V7Tween.dropTask】——
  //     任务删了，那十几帧（1463×1463 一张 4.61 MB，一组 ≈83 MB）和它们的 blob URL
  //     就一直挂在内存里，一句错都不报。
  //   ⚠ 第 3 步改成"只放内存"之后，这一步变得更要紧：
  //     以前帧还能靠落盘重现，现在【内存里那份就是唯一一份】，
  //     不收就是实打实的泄漏。
  //   ⚠ 收的是【任务对象】（dropTask 要用 task.shots 和 sourceImgId 算键），
  //     传 id 进去推不出端点，等于白收。
  if(window.V7Tween && typeof window.V7Tween.dropTask === 'function'){
    try{ window.V7Tween.dropTask(task); }catch(_){}
  }
  const el = tasksEl.querySelector('.task[data-task="' + id + '"]');
  taskList.splice(idx, 1);

  if (!el) { setTasks(); return; }
  // 离场前先把预览收掉, 免得悬空
  const pv = el.querySelector('.task-preview.show');
  if (pv) pv.classList.remove('show');
  el.classList.add('leaving');
  el.addEventListener('animationend', () => {
    el.remove();
    const n = tasksEl.querySelectorAll('.task').length;
    if (tcur >= n) tcur = Math.max(0, n - 1);
    setTasks();
    // ⚠ 任务从任务栏移除了，记录卡里"在不在任务栏"的状态要跟着变（广播，不再白扫缓存目录）。
    broadcastRecordsChanged();
  }, { once: true });
}

// ⭐ 细节补偿的两个档位。⚠ 必须定义在 buildPreview 【之前】——
//   它在缩略图上画按钮和角标时要读这张表，而 const 有暂时性死区：
//   定义在后面的话，这里一读就抛错，整个脚本从这里死掉，
//   后面所有绑定都不会跑（铁律 17 里那个"窗口不能滚动/折叠/拖拽"就是这么来的）。
//   完整的实现（applyDetailTier 等）在文件靠后的"细节补偿档位"一节。
// ⚠⚠ 2026-10-05（docs/143 §八-4）：【只剩「替换」一档】。
//   「增益」(mode:'gain') 已按用户拍板砍掉 —— 引擎侧那条分支还留着
//   （老缓存里记着 detailTier:'gain' 的图重启后还要能识别），
//   但界面上不再给出这个入口。
//   ⚠ 别把 gain 整个从引擎删掉：删了之后老任务恢复时 detailTier 读成未知值，
//     那个"换档时删掉旧层"的逻辑会找不到层 —— 静默留下一层擦不掉的旧补丁。
const DETAIL_TIERS={
  replace:{label:'替换',title:'细节还原',mode:'replace'}
};

// ── 预览弹层: 整行翻页 ──
// ⭐⭐ 2026-10-09（docs/191，用户要求）：「刚被用户主动收起，短时间内别再自动弹」。
//   用户原话：「点一下这个界面它能开，那咋关呢？总不可能把鼠标移走关吧？
//             那肯定是再点一下再关啊」。
//   ⚠ 为什么光"再点一下收掉"不够：收掉那一刻**鼠标还停在缩略图上**，
//     同一次交互里"悬停就开"立刻又把框弹回来 ⇒ 表现成"点了关不掉"。
//     （真窗口实测：点第 2 下确实收了，归属立刻又变回原样。）
//   ⚠ 所以主动收起要记一个时间戳，下面两处自动弹的路在 1.5 秒内不干活。
//     「1.5 秒」的取法：够长到挡住同一次交互的余波，又短到用户"再点一下又能开"
//     （实测点第 3 下能正常开）。
//   ⚠ 只在【用户主动收起】时记 —— 别在 hideBox 里记，那会把
//     "鼠标移开自动收"也算进去，然后正常的悬停就弹不出来了。
//   ⚠⚠ 而且【点击打开时一定要清掉它】（见下面 hideBoxIfTask 里的说明）——
//     否则"点一下收、再点一下开"会被自己刚设的闸挡住，变成"只能关不能开"。
//     （2026-10-09 实测栽过：点第 1、3 下都没开。）
let boxDeliberatelyClosedAt = 0;
const BOX_REOPEN_SUPPRESS_MS = 1500;
function boxAutoOpenSuppressed(){
  return (Date.now() - boxDeliberatelyClosedAt) < BOX_REOPEN_SUPPRESS_MS;
}
// 点击打开前调它：用户主动要开，闸立刻失效。
// ⚠ 不写成 hideBoxIfTask 内部的行为，是因为那是个"通用收框"函数，
//   以后别的地方调它也会顺手清闸 —— 语义容易看错。这里显式一点。
function clearBoxAutoOpenSuppression(){ boxDeliberatelyClosedAt = 0; }

// ⭐⭐ 2026-10-09（docs/191，用户反馈）：「收起行为会收起我们的任务卡片右滑打开的窗口，
//   我其实只希望收起展开的大图就好了」。
//   ⚠ hideBox() 收完框会通知 onBoxClosed（见文件末尾那个 setBoxClosedHandler），
//     那个回调的本职是"框走了，条也别留着"—— 对"鼠标移开自动收"是对的，
//     但对【用户自己点一下收掉大图】就过了：他只是想收大图，条还要接着用。
//   ⇒ 用这个标记区分两种收起：点它一下收大图时置 true，回调看到就不收条。
//   ⚠ 必须用 try/finally 复位：中间抛错的话标记会一直挂着，
//     表现成"以后框没了条也不收"，很难查。
//   ⚠⚠⚠ 必须挂在 window 上，**不能只用顶层 let**：
//     那个回调在【另一个 <script> 块】里（文件末尾 setBoxClosedHandler 那段），
//     跨块访问顶层 let 不保证有效 —— 2026-10-09 实测栽过：
//     标记写成 let 时，回调里那个 `if(boxCloseImageOnly) return;` 读不到值，
//     表现成"点一下收大图，条也跟着没了"（就是用户报的那个毛病，改完还在）。
//     挂 window 之后跨块一定可见。
//
//   ⚠⚠⚠ 2026-10-09 第二次修（用户报「缩略图卡片有时候收不回去了」）：
//     **这个意图不能是布尔标记、也不能是时间窗，必须是【一次性令牌】。**
//     第一版：布尔标记（置 true → try/finally 复位）—— 实测"点完收大图后移开鼠标，
//             条still 1、永远不收"。
//     第二版：800ms 时间窗 —— 还有洞：**用户点完收大图后若在 800ms 内就移开鼠标，
//             那次"移开"引起的收起也会被当成"只收大图" ⇒ 条又赖住。**
//             这正是"有时候收不回去"（取决于手多快 ⇒ 间歇性）。
//     ⇒ 现在：点击收大图时放一个【一次性令牌】，回调消费掉就没了。
//       "之后那次"（用户真移开鼠标）拿不到令牌，照旧收条。
//       ⚠ 谁先来谁用掉 —— 不会误伤之后任何一次收起。
window.boxCloseImageOnlyToken = false;
// ⚠ 挂 window：那个回调在另一个 <script> 块里，跨块读函数声明/顶层 let 都不保险
//   （同一形状的坑 2026-10-09 栽过一次，见上一段）。
window.boxCloseConsumeImageOnly = function(){
  if (!window.boxCloseImageOnlyToken) return false;
  window.boxCloseImageOnlyToken = false;   // 用掉即失效
  return true;
};

function buildPreview(taskEl, task){
  const pv = taskEl.querySelector('.task-preview');
  if (!pv || !task) return;
  const orderedShots = (task.shots||[]).map((shot,index)=>Object.assign({index},shot||{})).sort((a,b)=>{
    const rank=shot=>shot.error?1:((task.kind==='generation' ? shot.restoreState==='done' : shot.done) && shot.imgId ? 0 : 2);
    return rank(a)-rank(b)||a.index-b.index;
  });
  const total = orderedShots.length;
  const pages = Math.max(1, Math.ceil(total / PER));
  const multiPage = total > PER;        // >4 张才启用预览区滚轮分页
  task.page = Math.max(0, Math.min(pages - 1, Number(task.page) || 0));
  function errorTip(){
    let tip=document.getElementById('pv-error-tip');
    if(!tip){tip=document.createElement('div');tip.id='pv-error-tip';tip.className='pv-error-tip';document.body.appendChild(tip);}
    return tip;
  }

  function draw(dir){
    const oldTip=document.getElementById('pv-error-tip');
    if(oldTip) oldTip.classList.remove('show');
    const start = task.page * PER, slice = orderedShots.slice(start, start + PER);
    // ⚠ 宽度规则: ≤4 张 → 按实际张数(自然宽); >4 张 → 每页补齐到 4 格,
    //   保证右侧点状分页条和预览条宽度稳定。
    let cells = '';
    // 采样步数只画在【下一张还没回来】的那一格（一张一张算，正在算的就是它）
    const nextPending = orderedShots.find(s => !s.error && !((task.kind==='generation' ? s.restoreState==='done' : s.done) && s.imgId));
    const stepsAt = nextPending ? nextPending.index : -1;
    slice.forEach((im, i) => {
      const gi = start + i + 1;
      if (im.error){
        cells += '<div class="pv-cell pv-error" data-shot-index="'+im.index+'" data-error="'+escapeHtml(im.error)+'"><div class="pv-media"><span class="pv-idx">' + gi + '</span>' +
                 '<div class="pv-error-icon">×</div></div></div>';
      } else if ((task.kind==='generation' ? im.restoreState==='done' : im.done) && im.imgId){
        // ⚠ 只挂缩略图，且 DOM 里只放 imgId 不放图片数据。
        //   以前这里 src 和 data-big 各塞一份完整 base64，8 张图每次重绘要拼 ~170MB 字符串
        //   —— 这就是进度刷新时"不跟手"的真凶。现在这行只有几十字节。
        const thumb = window.IMG.thumb(im.imgId) || placeholderSVG(gi * 48);
        // ⭐ 细节补偿档位（2026-09-12）：两个按钮 + 一个角标。
        //   ⚠ 状态【只用角标表达，不换缩略图】—— 120px 的缩略图里
        //     1~2 像素的锐度差异物理上就看不出来，换了也是白换，
        //     还要多付"换 imgId + 释放旧 Blob"的代价。要看效果去 PS 里点眼睛。
        const dt = String(im.detailTier||'');
        // ⭐⭐ 提升纹理的按钮【只在这一张已经传回 PS 之后才出现】（2026-09-13 用户定案）。
        //   补细节是往"那张 AI 图的图层上方"嵌一层，没传回就没有图层可嵌 ——
        //   以前按钮一直显示，点了必然撞到 DETAIL_NO_TARGET 那道阀。
        //   现在从源头堵住：没传回就不给按钮，用户不会点到一个注定失败的东西。
        //   ⚠ 判据用 psLayerByShot（传回成功才写），不是 task.status。
        const layerMap = task.psLayerByShot || {};
        const placedInPS = layerMap[im.index] != null;
        // ⭐⭐ 2026-10-05 用户定：右上角那个位置改成「应用」按钮。
        //   原来右上角是 .pv-badge —— 一个【只读角标】，印的是"这张补过哪一档细节"
        //   （补了"替换"档就印「替换」），跟底部两个按钮的 .on 高亮是重复信息，用户说它是残留。
        //   现在它的意思是：**用滑条/滚轮调好的强度，换掉 PS 里原来那一层**。
        //   ⚠⚠ 底部「替换 / 增益」是【另一个功能】（用原图纹理补细节），一个字都不许动。
        //   ⚠ 只在【已经传回过 PS】时出现（S-Q2）；没传回过那一格底部是「传回」。
        //   ⚠ 用户原话为什么放这里不放大框："预览窗口是完全穿透的…鼠标移到预览窗口才能传回
        //     会拉长用户的操作路径"（推翻了 docs/136 S5 "只放大框里"）。
        const badge = (task.kind==='generation' && !task.migration?.returnBlocked && placedInPS)
          ? '<button type="button" class="pv-apply" data-apply-shot="'+im.index+'"'
            +' title="把调好的强度换进 Photoshop 那一层（只换这一张）">应用</button>' : '';
        const btn=(k)=>'<button type="button" class="pv-dt'+(dt===k?' on':'')+'"'
          +' data-detail-tier="'+k+'" data-shot="'+im.index+'"'
          +' title="'+escapeHtml(DETAIL_TIERS[k].title+'：在这张图上方嵌一层补过细节的图（可随时删掉）')+'">'
          +escapeHtml(DETAIL_TIERS[k].label)+'</button>';
        // ⭐ 没传回的给「传回」按钮（2026-09-13 用户定案：只能手动一张一张传）；
        //   传回之后那一格才换成「替换 / 增益」两个提升纹理的按钮。
        //   —— 同一个位置，按状态切换，用户不会同时看到两组按钮。
        // ⚠ 这一排按钮【只对生成任务成立】：抠像是当场就贴回 PS 的，没有"传回"这一步，
        //   "替换/增益"更是生成专用（往 AI 图上方嵌补细节层）。
        //   不关掉的话抠像任务卡上会挂两三个点了必然失败的按钮。
        const dtbar = task.kind!=='generation'||task.migration?.returnBlocked ? '' : (placedInPS
          ? '<div class="pv-dtbar one">' + btn('replace') + '</div>'
          : '<div class="pv-dtbar one"><button type="button" class="pv-dt send"'
            + ' data-send-shot="' + im.index + '"'
            + ' title="把这一张贴进 Photoshop（贴完才能提升纹理）">传回</button></div>');
        // ⚠ 2026-10-11 a11y：给结果图加 alt。
        //   这几张是任务结果图，给一个"能说清是哪一张"的名字（第几张）；
        //   不留空是因为它不是装饰 —— 用户就是靠它认结果的，且 alt 带序号能区分多张。
        //   ⚠ 注释必须写在【语句外面】：我第一版把 // 插在字符串拼接的换行中间，
        //     下一行还在继续拼 `+ ...`，于是被注释掉、语法直接坏掉。
        cells += '<div class="pv-cell pv-ready" data-shot-index="'+im.index+'"><div class="pv-media"><span class="pv-idx">' + gi + '</span>' +
                 '<img src="' + thumb + '" alt="生成结果第 ' + gi + ' 张" data-img-id="' + escapeHtml(im.imgId) + '" data-idx="' + gi + '" data-original-idx="' + (im.index+1) + '"/>' +
                 badge + dtbar + '</div></div>';
      } else {
        cells += '<div class="pv-cell" data-shot-index="'+im.index+'"><div class="pv-media"><span class="pv-idx">' + gi + '</span>' +
                 '<div class="pv-hourglass">'+(window.ICON?ICON.render('hourglass',30):'')+'</div>' + (im.index===stepsAt ? taskStepsHtml(task) : '') + '</div></div>';
      }
    });
    // ⭐⭐ 2026-10-04 用户定案（原话）：
    //   「统一的变为就是四个缩略图加上有滚动条…四个项目以内的话，剩下的地方就留空吧，
    //     然后滚动条就从一个点就行了。」
    //   ⇒ 预览条【永远】按 4 格宽出，不足 4 张的格子留空（.pv-empty 是透明的，占位不画东西）。
    //   ⇒ 右侧分页条【永远】在：只有 1 页时它就显示一个点。
    //   ⚠ 为什么要这样：以前 ≤4 张走"自然宽"，3 张就 3 张宽、5 张就 4 张宽，
    //     于是**同一个预览框的宽度会随图片张数变来变去**，用户滚动调强度时框忽宽忽窄，很难受。
    //   ⚠ 只影响【显示宽度】。真正翻页的判据仍然是 multiPage（>4 张），没动。
    for (let k = slice.length; k < PER; k++) cells += '<div class="pv-cell pv-empty"></div>';
    let rail = '<div class="pv-rail" aria-label="任务图片分页">' +
      Array.from({length:pages},(_,i)=>'<i class="pv-dot'+(i===task.page?' active':'')+'" data-page="'+i+'"></i>').join('') +
      '</div>';
    // pv-paged: 锁成固定总宽，让右缘和上方三级详情卡的右缘对齐（算式见 CSS）。
    let html = '<div class="pv-strip pv-paged"><div class="pv-track">' + cells + '</div>' + rail + '</div>';
    pv.innerHTML = html;
    // ⭐ 2026-10-19：重画完把每张的状态小标补回去（innerHTML 一刷就没了）
    if (typeof jobView !== 'undefined' && jobView) pv.querySelectorAll('.pv-cell[data-shot-index]').forEach(cell => jobView.paintCell(cell, task));

    // ⭐ 细节补偿按钮。⚠ stopPropagation 必须有 —— 这两个按钮坐在缩略图上，
    //   不拦的话会连带触发缩略图自己的点击（放大看图）和任务卡的拖拽。
    pv.querySelectorAll('[data-detail-tier]').forEach(btn=>{
      btn.addEventListener('mousedown',e=>e.stopPropagation());
      btn.addEventListener('click',e=>{
        e.preventDefault(); e.stopPropagation();
        applyDetailTier(task, Number(btn.dataset.shot)||0, btn.dataset.detailTier);
      });
    });
    // ⭐ 右上角「应用」（2026-10-05）：用调好的强度换掉 PS 那一层。
    //   ⚠ stopPropagation 同上：坐在缩略图上，不拦会连带触发缩略图点击（开大框）和拖拽。
    //   ⚠ 用 taskById 取最新那份 —— 闭包里的 task 是这次渲染时的快照。
    pv.querySelectorAll('[data-apply-shot]').forEach(btn=>{
      btn.addEventListener('mousedown',e=>e.stopPropagation());
      btn.addEventListener('click',e=>{
        e.preventDefault(); e.stopPropagation();
        if(window.V7Tween&&typeof V7Tween.applyShot==='function')
          V7Tween.applyShot(taskById(task.id)||task, Number(btn.dataset.applyShot)||0, btn);
      });
    });
    // 单张传回（2026-09-13）
    pv.querySelectorAll('[data-send-shot]').forEach(btn=>{
      btn.addEventListener('mousedown',e=>e.stopPropagation());
      btn.addEventListener('click',e=>{
        e.preventDefault(); e.stopPropagation();
        aiTransfer(task, [Number(btn.dataset.sendShot)||0]);
      });
    });

    const tip=errorTip();
    pv.querySelectorAll('.pv-cell.pv-error').forEach(cell=>{
      const owner=String(task.id)+'/'+String(cell.dataset.error||'');
      const move=e=>{
        const x=Math.min(Math.max(8,e.clientX+14),Math.max(8,window.innerWidth-228));
        const y=Math.min(Math.max(8,e.clientY+14),Math.max(8,window.innerHeight-88));
        tip.textContent=cell.dataset.error||'任务失败';
        tip.dataset.owner=owner;
        tip.style.left=x+'px'; tip.style.top=y+'px';
      };
      // ⭐ 2026-10-22（docs/263 第 7 条）：停 120ms 才弹，划过一排失败格不闪（hover-delay.js；没加载就照旧立刻弹）
      const hd=tip._hd||(tip._hd=window.V7HoverDelay?V7HoverDelay.create():null);
      cell.addEventListener('mouseenter',e=>{move(e);if(hd)hd.show(()=>{if(cell.isConnected&&tip.dataset.owner===owner)tip.classList.add('show');});else tip.classList.add('show');});
      cell.addEventListener('mousemove',move);
      cell.addEventListener('mouseleave',()=>{const off=()=>{if(tip.dataset.owner===owner)tip.classList.remove('show');};if(hd)hd.hide(off);else off();});
    });

    // ⭐ 2026-10-04：鼠标浮到某一格 → 上方大预览框显示那一张（放大）。
    //   ⚠ 只在框已经开着（= 鼠标在这张任务卡这条链上）时才换图 ——
    //     不然会凭空弹出大框（用户只是路过缩略图）。
    pv.querySelectorAll('.pv-cell.pv-ready').forEach(cell=>{
      const shotImg=cell.querySelector('img[data-img-id]');
      if(!shotImg) return;
      cell.addEventListener('mouseenter',()=>{
        if(!window.V7Tween) return;
        const shot=(task.shots||[])[parseInt(shotImg.dataset.originalIdx,10)-1];
        if(shot) window.V7Tween.hoverThumb(cell,task,shot);
      });
    });

    // 翻页动画: 只让 .pv-track(图格区)上下滑入
    if (dir){
      const strip = pv.querySelector('.pv-strip');
      if (strip){
        strip.classList.add('pv-animating');
        clearTimeout(pv._animTimer);
        pv._animTimer = setTimeout(()=>strip.classList.remove('pv-animating'), 340);
      }
      const track = pv.querySelector('.pv-track');
      if (track){
        const from = dir > 0 ? 40 : -40;         // 下一页从下方进入, 上一页从上方进入
        track.style.transition = 'none';
        track.style.transform = 'translateY(' + from + 'px)';
        track.style.opacity = '0';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            track.style.transition = 'transform .26s var(--ease-out), opacity .2s var(--ease-soft)';
            track.style.transform = 'translateY(0)';
            track.style.opacity = '1';
          });
        });
      }
    }

    // X = 从任务栏收起。缓存留在硬盘上，以后"生成记录"还能翻到。
    // ⚠ stopPropagation: 不加会连带触发任务卡自己的点击/拖拽。
    const closeBtn = taskEl.querySelector('[data-task-close]');
    if (closeBtn && !closeBtn._bound){
      closeBtn._bound = true;
      closeBtn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        cacheSetTaskbar(task, false);
        removeTask(task.id);
      });
    }
    // ⚠⚠ 2026-09-13：「提前结束 / 传回」的绑定【搬去 syncTaskActions 了】，这里不能再绑。
    //   原因：那一行现在会跟着状态重画，重画出来的是新元素，
    //   两边都绑 = 同一个按钮被绑两次 → 点一下发两次传回（用户实测的"多次传回"之一）。
    pv.querySelectorAll('.pv-cell img').forEach(img => {
      // 划到哪张 → PS 里单独显示哪张。
      // ⚠ 用 data-original-idx(图在 shots 里的真实序号)，不能用 data-idx ——
      //   预览是排过序的(成功的排前面)，用显示序号会对错图层。
      const soloThis = () => {
        const originalIdx = parseInt(img.dataset.originalIdx);
        if (Number.isFinite(originalIdx)) generationSoloLayer(task, originalIdx - 1);
      };
      // ⭐ 2026-10-19（docs/250 第 4 条，用户同意）：只认【鼠标真的移过来】的那一下。
      //   滚轮翻任务卡时鼠标没动、是卡片从鼠标底下滑过去 —— 浏览器照样发 mouseenter，原来这样就会把 PS 里藏着的旧图层点亮。
      //   现在那种「滑过来」先不算（记成待定），鼠标在这张图上真动一下再算；判法见 hover-intent.js。双击跳过去不受影响。
      img.addEventListener('mouseenter', e => {
        if (typeof thumbHover !== 'undefined' && thumbHover && !thumbHover.enter(e)) return;
        soloThis();
      });
      img.addEventListener('mousemove', e => {
        if (typeof thumbHover !== 'undefined' && thumbHover && thumbHover.moveOn(e)) soloThis();
      });
      img.addEventListener('mouseleave', () => {
        if (typeof thumbHover !== 'undefined' && thumbHover) thumbHover.leave(img);
      });
      // ⭐⭐ 2026-10-14（用户定）：【双击缩略图】= 跳过去 + 缩放到填满。
      //   原来这是设置里一个开关（soloFocusRegion "联动时聚焦图层位置"）——
      //   用户说"它并不应该是开关，它其实更多可以融入到缩略图的机制当中"，
      //   "双击一下缩略图，它就直接联动过去了……操作成本非常低"。
      //   ⚠ forceFocus=true 走的是同一条 soloOwned 链路，只是把 focusRegion 置真。
      //
      //   ⚠⚠⚠ 双击必须【防抖】—— 用户实测报的：
      //     "双击部分没有做防抖处理，它会让我们的点按出大图，打开之后再收回才能跳转到对应的地方"
      //     真因：click 在第一次按下就派发、立刻开了大预览框；dblclick 要等第二次按下才来。
      //     所以光在 dblclick 里 stopPropagation 没用 —— 那时框已经开出来了。
      //   ⇒ 做法：click 的处理【延后 DBL_MS 再执行】，dblclick 一到就取消那次待执行的 click。
      //     这样双击全程只走"跳过去"这一条路，永远不开大图。
      //   ⚠ 单击因此晚 DBL_MS 才开框（约 220ms）—— 这是"区分单击与双击"的固有代价，
      //     和系统双击判定同一个数量级，用户感觉不到。
      let pendingClick = null;
      const runClick = fn => {
        if (pendingClick) clearTimeout(pendingClick);
        pendingClick = setTimeout(() => { pendingClick = null; fn(); }, DBL_MS);
      };
      img.addEventListener('dblclick', e => {
        e.stopPropagation(); e.preventDefault();
        if (pendingClick) { clearTimeout(pendingClick); pendingClick = null; }
        const originalIdx = parseInt(img.dataset.originalIdx);
        if (Number.isFinite(originalIdx)) generationSoloLayer(task, originalIdx - 1, true);
      });
      img.addEventListener('click', e => {
        e.stopPropagation();
        // ⚠⚠ 整个处理体延后 DBL_MS 执行 —— 见上面 dblclick 那段注释。
        //   双击时第二下会先取消这个待执行的 click，所以双击全程不开大图。
        runClick(() => {
        // ⭐ 2026-10-04 用户定案（docs/132 §三）：不再开独立大图窗口，
        //   改在【上方大预览框】里看（缩放/平移/双击复位都在那儿）。
        //   ⚠ 原来这里读 img.dataset.big 会当场复制一份 21MB 的完整 base64 ——
        //     点开大图卡顿的第一刀砍在这，现在这条路整个没了。
        const shot = (task.shots||[])[parseInt(img.dataset.originalIdx,10)-1];
        // ⚠⚠ 2026-10-05 改（用户实测：「点击缩略图还是会出现一个歪的大图框」「应用按钮没出现」）。
        //   原来这里调的是 attachTo(格子) + showImage(…, 格子) —— 那是【记录卡/参考图】的
        //   "独立看图"：框按被点的格子摆（= 歪），而且框从此不认这个任务（= 没有「应用」、调不了强度）。
        //   ⇒ 任务卡里一律走 openShot：位置只由任务卡 + 预览条决定，跟悬停弹出来的是同一个框。
        //   ⚠ 用 taskById 取【最新】那份：传回 PS 后对照表写在新对象上，闭包里这份是旧的。
        const taskEl = img.closest('.task');
        const liveTask = taskById(task.id) || task;
        const liveShot = (liveTask.shots||[])[parseInt(img.dataset.originalIdx,10)-1] || shot;
        // ⭐⭐ 2026-10-09（docs/191，用户要求）：「再点一下关」。
        //   用户原话：「你刚才那个逻辑忘记补了，就是点一下这个界面它能开，那咋关呢？
        //             总不可能把鼠标移走关吧？那肯定是再点一下再关啊」。
        //
        //   ⚠ 为什么需要它：开关关掉之后，"悬停离开自动收框"那条路也没了
        //     （hoverThumb/悬停那套不再参与）⇒ 用点击开出来的框【没有别的方式收掉】。
        //     所以点击必须是【开/关切换】。
        //
        //   ⚠⚠ 只在【开关关掉时】才切换：
        //     开着的时候保持原样（点一下永远是"打开并切到这一张"），
        //     否则会踩坏用户已经习惯的手感 —— 而他只是没改设置。
        //
        //   ⚠ 判据用 boxState()：框开着**且就是这个任务**才收。
        //     开给别的任务时不能收（那会变成"点 A 收掉 B"，看着像坏了）——
        //     这种情况按原样走 openShot 切过去。
        const clickOnly = (typeof settingsRuntime==='object' && settingsRuntime.hoverOpensPreview===false);
        if (clickOnly && window.V7Tween && typeof V7Tween.boxState==='function'
            && typeof V7Tween.hideBox==='function') {
          const own = V7Tween.boxState();
          if (own && own.open && String(own.taskId) === String(liveTask.id)) {
            // ⭐ 用户只是想【收起大图】—— 预览条要留着（用户 2026-10-09 反馈）。
            //   ⚠ 用时间窗（不是布尔标记）：只让【这一次点击】引起的收起不收条。
            //     写成布尔标记会连"用户之后移开鼠标"那次也一起放过 ⇒ 条再也收不掉
            //     （2026-10-09 实测复现：点两下收大图 → 移开鼠标 → 条still 1、永远不收）。
            window.boxCloseImageOnlyToken = true;   // 一次性：下面那次 hideBox 的回调用掉它
            try {
              V7Tween.hideBox();
            } finally {
              // 立刻收回时间窗？不行 —— 回调是同步跑的，但为了稳妥留一点余量，
              // 由 boxCloseIsImageOnly() 的时间判断自然过期。
            }
            // ⚠⚠ 关键：记一下"刚被用户主动收起"。
            //   不收这个的话，鼠标还停在缩略图上 → 同一次交互里
            //   "悬停就开"立刻又把框弹回来 ⇒ 表现成"点了关不掉"。
            //   （2026-10-09 真窗口实测：点第 2 下确实收了，归属立刻又变回原样。）
            boxDeliberatelyClosedAt = Date.now();
            return;
          }
        }
        if (window.V7Tween && typeof V7Tween.openShot === 'function' && taskEl && liveShot) {
          // ⭐ 用户主动点开 —— 立刻解除"刚收起别自动弹"的闸。
          //   ⚠ 必须在这里清：否则"点一下收、再点一下开"会被自己刚设的闸挡住，
          //     表现成"只能关不能开"（2026-10-09 实测栽过）。
          clearBoxAutoOpenSuppression();
          if (V7Tween.openShot(taskEl, liveTask, liveShot)) return;
          // ⭐⭐ 10-25（用户：三块屏、软件卡了一下以后，预览框之外还在另一块屏上弹出一个独立大图框）：
          //   卡顿时点击排队、晚处理，任务卡已经刷新过 ⇒ 按序号取到的那张对不上最新数据，openShot 认不出返回 false，
          //   原来这里就退回去开【老的独立大图窗口】（盖满一整块屏、永远置顶，落在哪块屏由 Windows 挑）——
          //   10-04 用户就定了任务卡里看图一律走预览框（docs/132 §三）。⇒ 按图片编号在最新数据里再找一次
          const byId = (liveTask.shots||[]).find(s => s && s.imgId && s.imgId === img.dataset.imgId);
          if (byId && V7Tween.openShot(taskEl, liveTask, byId)) return;
        }
        // 还对不上：只在预览框里显示这一张（不认任务，没有「应用」条），也不开老窗口
        if (window.V7Tween && typeof V7Tween.showImage === 'function' && img.dataset.imgId && window.IMG) {
          Promise.resolve(window.IMG.fullBytes(img.dataset.imgId)).then(buf => {
            const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
            V7Tween.showImage(bytes);
          }).catch(err => { try { aiAddLog('[预览] 这张图读不出来：' + String(err && err.message || err), 'warn'); } catch (_) {} });
          return;
        }
        // 只剩「预览框模块整个没加载起来」这一种情况才用老窗口（总比点了没反应强）
        openBig(img.dataset.imgId, task, parseInt(img.dataset.idx), parseInt(img.dataset.originalIdx));
        });   // ← runClick 收尾（延迟执行的那个处理体）
      });
    });
  }
  draw(0);
  // 只有右侧点状分页条消费滚轮；图片区滚轮继续冒泡到全局任务切换逻辑。
  // 使用属性转发到最新 buildPreview 闭包，避免重建内容后监听器引用旧任务状态。
  pv._pageWheelHandler = e => {
    const target = e.target;
    // ⭐ 2026-10-04 新增分支：落在缩略图(.pv-cell)上 → 调改动强度（docs/132 §四）。
    //   ⚠⚠ 必须挂在【这个已有的监听】里，不许另挂一个 wheel 监听 ——
    //     铁律 29：滚轮监听别挂会隐藏的元素；另挂必踩"动一下鼠标才好"那种陈旧命中测试，
    //     而且会跟这里的分页逻辑打架。
    //   ⚠ 落点判定顺序：先判 .pv-cell（它可能在 .pv-strip 里，不在 .pv-rail 里），
    //     分页条那条路一个字不改。
    const cell = target && target.closest ? target.closest('.pv-cell') : null;
    if (cell && pv.contains(cell) && window.V7Tween) {
      const shotImg = cell.querySelector('img[data-img-id]');
      if (shotImg && window.V7Tween.wheelOnCell(cell, e, task, pv)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const rail = target && target.closest ? target.closest('.pv-rail') : null;
    if (!rail || !pv.contains(rail)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!multiPage || pv._pageWheelBusy) return;
    pv._pageWheelDelta = (pv._pageWheelDelta || 0) + e.deltaY;
    if (Math.abs(pv._pageWheelDelta) < 40) return;
    const dir = pv._pageWheelDelta > 0 ? 1 : -1;
    pv._pageWheelDelta = 0;
    const next = Math.max(0, Math.min(pages - 1, task.page + dir));
    if (next === task.page) return;
    task.page = next;
    pv._pageWheelBusy = true;
    draw(dir);
    window.setTimeout(() => { pv._pageWheelBusy = false; }, 280);
  };
  if (!pv._pageWheelBound){
    pv.addEventListener('wheel', e => {
      if (typeof pv._pageWheelHandler === 'function') pv._pageWheelHandler(e);
    }, {passive:false});
    pv._pageWheelBound = true;
  }
}

// 按 id 找任务数据
function taskById(id){ return taskList.find(t => String(t.id)===String(id) || String(t.taskId||'')===String(id)); }

// 测试期的虚拟任务入口已移除；正式任务通过业务调度接口调用 addTask()。
setTasks();

// 初始化: 应用已存的卡片背景(每张卡独立背景)
if(window.BG){
  window.BG.applyAll();
  updateZoneBg(cur);
  updateDetailBg();          // 三级绑定 detail-{主卡}-{分区}(HTML 里写死的 "detail" 要立刻换掉)
  // 背景管理由正式主题入口按需挂载，不在启动时重建详情内容。
}
// 给每个二级卡注入选中光带层(左右向内光带, 无边框锯齿)
document.querySelectorAll('#zones .zone').forEach(z=>{
  if(!z.querySelector('.z-selglow')){
    const g=document.createElement('div'); g.className='z-selglow';
    z.appendChild(g);
  }
  // 注入左缘弹出光(与 .z-selglow 同机制: 真实元素, append 在 .z-body 之后, 不被盖)
  if(!z.querySelector('.zone-glow')){
    const g=document.createElement('div'); g.className='zone-glow';
    z.appendChild(g);
  }
  // 注入亮边线(独立, 不跟光带绑). 默认隐藏, 弹二级时跟光带一起亮/灭.
  if(!z.querySelector('.zone-bright')){
    const b=document.createElement('div'); b.className='zone-bright';
    z.appendChild(b);
  }
  // 注入二级预告光(照一级 edgehint): 鼠标在卡上往右移时右缘实时渐亮, 预告"能拉出三级"
  if(!z.querySelector('.zone-edgehint')){
    const eh=document.createElement('div'); eh.className='zone-edgehint';
    z.appendChild(eh);
  }
});

// 给三级卡注入弹出光(跟二级同机制: 真实元素, 放 .dc-scroll 之后防被合成层盖)
const detailEl=document.getElementById('detail');
if(detailEl){
  if(!detailEl.querySelector('.detail-glow')){
    const g=document.createElement('div'); g.className='detail-glow';
    detailEl.appendChild(g);
  }
  if(!detailEl.querySelector('.detail-bright')){
    const b=document.createElement('div'); b.className='detail-bright';
    detailEl.appendChild(b);
  }
  // ⚠ 标记三级"被真的用过": 点按 / 内部滚动 都算(滚轮在全局 wheel 里另外标记)。
  //   用途见 detailUsed 声明处 —— 没用过就往右移出 → 二级三级一起收。
  detailEl.addEventListener('mousedown', ()=>{ detailUsed=true; });
  // ⭐ 2026-10-21（docs/261 U1）：在框里真的打了字才算「正在编辑」—— 打字的提示词框去 PS 画个选区不收（没打过字的照旧失焦就收）
  detailEl.addEventListener('input', ()=>{ detailUsed=true; detailEditing=true; });
  const dsc = detailEl.querySelector('.dc-scroll');
  if(dsc) dsc.addEventListener('scroll', ()=>{ detailUsed=true; });
}

// ═══ 大图查看器: 滚轮切上下张 / Ctrl+滚轮缩放 / 拖拽移动 / 双击复位 / 适配全屏 ═══
// 大图已经搬进独立的显示器级冻结窗口(viewer-window.html)。
// 主窗口是死的 1020×1100，窗口内的 position:fixed 铺不满屏幕，做不到真全屏冻结，
// 所以照 L4 的做法另开一个盖住整个显示器的窗口。详见 docs/12 六点九节。
//
// 这里只留【业务判断】：哪张能看、跳过没生成完/失败的图、张数怎么排。
// 缩放/拖拽/双击复位那些纯交互留在大图窗口里，不跨进程来传回。
let bigTask=null, bigIdx=1, bigOrder=[]; // 当前大图所属任务 + 预览排序序号(1基)
let viewerOpen=false;                    // 大图窗口是否开着(滚轮/穿透/失焦判断都看它)
let pvPrevFocus=null;                    // 打开大图前的焦点，关闭后还原
// 看完大图回来后，任务预览保持展开，直到鼠标真的放上去才解除。
// 大图是独立窗口，关掉时鼠标停在屏幕中央，不保持的话预览会立刻被收走。
let pvKeepOpen=false;
let pvKeepTaskId=null;                   // 保持的是哪张任务卡的预览

function bigTotal(){
  if(!bigTask) return 0;
  return bigOrder.length||bigTask.shots.length;
}
function bigShotAt(idx){
  if(!bigTask) return null;
  const pos=bigOrder[idx-1];
  return bigTask.shots[pos===undefined?idx-1:pos]||null;
}
// 把原图【二进制】送进大图窗口。
// ⚠ 不传 base64：传 base64 等于在另一个进程里再复制一份 21MB 字符串，
//   还要在那头再解一次码。传 ArrayBuffer 大约只有 8MB，且不用解码。
//   这是"点开大图有滞后"的主要来源。
let bigSendSeq=0;
function bigSendImage(imgId, num, total, reset){
  if(!(window.uiwin&&window.uiwin.viewer)) return;
  const token=++bigSendSeq;
  return Promise.resolve().then(()=>window.IMG.fullBytes(imgId)).then(async buf=>{
    // 用户可能已经连滚了好几张：过期的那次直接丢掉，不然会出现"图乱跳"。
    if(token!==bigSendSeq||!viewerOpen) return;
    const sz=window.IMG.size(imgId);
    const bytes=ArrayBuffer.isView(buf)?new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength):new Uint8Array(buf);
    const payload={bytes:bytes, mime:'image/png', num:num, total:total, reset:!!reset, w:sz.w, h:sz.h};
    const result=await (reset?window.uiwin.viewer.open(payload):window.uiwin.viewer.update(payload));
    if(token!==bigSendSeq||!viewerOpen) return;
    if(result&&result.ok===false) throw new Error(result.error||'大图窗口打开失败');
    return result;
  }).catch(err=>{
    // 旧请求即使在新窗口成功后才报错，也不能复位新窗口或弹出过期错误。
    if(token!==bigSendSeq||!viewerOpen) return;
    // ⚠ 首次打开就失败时必须把状态放回去。否则 viewerOpen 卡在 true，
    //   窗口又没开，主窗口的滚轮和点击穿透会一起失灵(用户表现为"面板死了")。
    if(reset){ viewerOpen=false; bigTask=null; pvKeepTaskId=null; }
    const why=(err&&err.message)||String(err||'未知原因');
    console.error('[大图] 打开失败:', err);
    ERR.report('VIEWER_OPEN_FAILED',{message:String(why)});
    if(window.UI&&window.UI.toast) window.UI.toast('大图打不开：'+why,'err',4200);
  });
}
// 载入指定序号的图(1基)。只在该图已完成时才有 src。
// ⚠ 切上下张【保留】当前缩放和位移 —— 不带 reset 标记，
//   大图窗口那边的 scale/位移就不会动(用户要求连续看多张不打断视角)。
function loadBigByIdx(idx){
  if(!bigTask) return;
  const total=bigTotal();
  if(idx<1||idx>total) return;
  const shot=bigShotAt(idx);
  if(!shot || !shot.done || !shot.imgId) return;   // 未回真实图片的项不可打开
  bigIdx=idx;
  bigSendImage(shot.imgId, idx, total, false);     // 换图不复位缩放/位移
}
function openBig(imgId, task, idx, originalIdx){
  if(!(window.uiwin&&window.uiwin.viewer)){
    console.warn('[大图] 独立查看窗口接口不可用');
    return;
  }
  pvPrevFocus=document.activeElement;
  // 记住是从哪张任务卡点开的：关掉大图后要保证这张卡的预览还开着。
  pvKeepTaskId=(task&&task.id)||null;
  bigTask=task||null;
  bigOrder=bigTask ? bigTask.shots.map((shot,index)=>({shot,index})).sort((a,b)=>{const rank=x=>x.shot&&x.shot.error?1:(x.shot&&x.shot.done&&x.shot.imgId?0:2);return rank(a)-rank(b)||a.index-b.index;}).map(x=>x.index) : [];
  bigIdx=idx||1;
  viewerOpen=true;
  // reset:true 只在首次打开时带，让新图从 1 倍、居中开始。
  bigSendImage(imgId, bigTask?bigIdx:0, bigTotal(), true);
}
function closeBig(){
  if(!viewerOpen) return;
  if(window.uiwin&&window.uiwin.viewer) window.uiwin.viewer.close();
  // 状态复位统一在 onClosed 里做：不管是这里关的还是用户按 Esc 关的，走同一条路。
}
// 大图窗口没了(Esc / 点空白 / 关闭按钮 / 主窗口销毁) → 复位主窗口状态。
// ⚠ 必须由主进程回调触发，不能只在 closeBig 里复位，
//   否则用户按 Esc 关掉后 viewerOpen 卡在 true，滚轮和点击穿透跟着一起坏。
if(window.uiwin&&window.uiwin.viewer){
  window.uiwin.viewer.onClosed(()=>{
    viewerOpen=false;
    bigTask=null;
    // 预览保持展开，直到鼠标放上去。顺带把它重新点亮：
    // 万一大图开着的这段时间预览被别的路径收掉了，回来也得是开着的。
    if(pvKeepTaskId){
      const pv=document.querySelector('.task-preview[data-preview="'+pvKeepTaskId+'"]');
      if(pv){
        pvKeepOpen=true;
        if(!pv.classList.contains('show')){ pv.classList.add('show'); window.__pv=pv; }
      }
    }
    pvKeepTaskId=null;
    if(pvPrevFocus && typeof pvPrevFocus.focus==='function'){
      try{ pvPrevFocus.focus({preventScroll:true}); }catch(_){ try{ pvPrevFocus.focus(); }catch(__){} }
    }
    pvPrevFocus=null;
  });
  // 大图窗口报"想切上下张"，这里算跳过未完成/失败图之后到底是第几张。
  window.uiwin.viewer.onNav(delta=>{
    if(!viewerOpen||!bigTask) return;
    const dir=Number(delta)>0?1:-1;
    const total=bigTotal();
    let ni=bigIdx+dir;
    while(ni>=1 && ni<=total){const shot=bigShotAt(ni);if(shot&&shot.done&&shot.imgId)break;ni+=dir;}
    if(ni>=1 && ni<=total) loadBigByIdx(ni);
  });
}

// 明确要收预览时(折叠面板 / 滚轮切到别的任务 / 开另一张卡的预览)，
// 顺手解除"看完大图的保持"，否则那个保持会赖在新的预览上。
function clearPreview(){ pvKeepOpen=false; document.querySelectorAll('.task-preview.show').forEach(p=>p.classList.remove('show')); }

