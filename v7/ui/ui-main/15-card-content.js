// ═══ ui-main/15-card-content.js —— 主界面主程序第 15 / 21 段 ═══
//   管什么：生成卡大二级内容 · 历史卡详情 · 记录卡宿主 · 正式设置页 · 启动引擎 · 抠像模型库
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ⭐⭐ 2026-10-15 生成卡单张大二级的内容（用户定「二级换成和别的卡片一样的大卡片，三级不要了」）。
//   一列到底，四节，右边导航点哪滚到哪（同设置卡，组件是 V7SettingsCard）。
//   ⚠ 每节的按钮/状态【跟 renderGenerationPanel 用同一套 data-* 钩子】——
//     bindGenerationDetail / aiRefreshInPlace 认的就是这些名字，不另起一套（两套必漂）。
//   ⚠ 同一个钩子在页里只出现一次（状态、输出区只放一处），否则一次刷新改两份、看着像重复。
//   ⚠ 第四节不放任何设置控件 —— 10-14 用户定"生成卡二三级不该残留任何设置"，这里只放跳转。
const GENERATION_TABS=[
  {id:'run',name:'开始生成',sub:'抓选区、开始生成、看进度',group:'本次生成'},
  {id:'refs',name:'参考图',sub:'这次会带几张参考图；加图、删图、排序都在参考图卡上',group:'本次生成'},
  {id:'results',name:'生成结果',sub:'看这次出的图，传回到 Photoshop',group:'本次生成'},
  {id:'where',name:'相关设置',sub:'出图尺寸、传回、编组、羽化、校色在设置卡里调',group:'去设置'}
];
// 老路由的档位号 → 大二级里的节（0 生成图片 / 1 参考图片 / 2 生成结果 / 3 生成与传回设置）
const GENERATION_ZONE_SECTION=['run','refs','results','where'];
function renderGenerationPage(body){
  const sc=settingsRuntime.generationShortcut||'';
  const sec=(id,inner)=>{
    const t=GENERATION_TABS.find(x=>x.id===id)||{name:id,sub:''};
    return '<section class="settings-section" data-sec-anchor="'+id+'" id="gensec-'+id+'"><h3 class="settings-section-title">'+escapeHtml(t.name)+'</h3><p class="sec-sub">'+escapeHtml(t.sub)+'</p>'+inner+'</section>';
  };
  // ⚠ 'sc-flat' 必须带：设置卡那一列的紧凑排版（节标题 13px、灰字 10.5px、分隔线）全挂在它上面。
  let html='<div class="settings-panel sc-flat generation-page" data-generation-page>';
  // 2026-10-18（docs/238 盘点）：
  //   ·「加载当前选区」删了 —— 抓来的图只刷新「输入图」那行字，点「开始生成」会重新抓，白点一下；
  //   ·「追加当前选区 / 打开参考图」删了 —— 走的是旧参考图弹窗，参考图卡已取代；「图片节点」留着（工作流预设要用）；
  //   ·「模式：」看不出是什么，改成直接显示抗截断档位、悬停给说明；
  //   ·「共 X 张」带上 data-ai-count-line：helpify 会把不带 data- 属性的 .settings-note 变成「?」并删掉原节点，
  //     原来数字永远不显示（「?」里冻着「共 0 张」）。
  html+=sec('run',
    '<div class="ai-actions"><button class="ai-btn primary" data-generation-run aria-keyshortcuts="'+escapeHtml(ariaShortcutValue(sc))+'" title="'+escapeHtml(shortcutTitle('开始生成',sc))+'">开始生成</button></div>'
    +'<div class="ai-status"><strong data-ai-status>'+escapeHtml(aiRuntime.status)+'</strong><span data-ai-progress-text>'+aiRuntime.progress+'%</span></div><div class="ai-progress"><i data-ai-progress style="width:'+aiRuntime.progress+'%"></i></div>'
    +'<div class="ai-plan"><span>输入图：<b data-ai-source>'+aiPlan().source+'</b></span><span>目标尺寸：<b data-ai-target>'+aiPlan().target+'</b></span></div>'
    +'<p class="settings-note">模型、分辨率、张数在生成卡正面调；提示词在预设卡右滑的提示词框里写。每次点「开始生成」都会新建一个任务，锁定当时的文档和选区，生成期间可以切换文档。</p>');
  html+=sec('refs',
    '<div class="ai-actions"><button class="ai-btn" data-reference-map>图片节点</button></div><div data-generation-ref>'+generationReferencePreview()+'</div>'
    +'<div class="ai-plan"><span title="'+escapeHtml(ANTI_MODE_TIP)+'"><b data-ai-mode>'+aiPlan().mode+'</b></span></div>');
  html+=sec('results',
    '<div class="ai-actions"><button class="ai-btn primary" data-ai-action="place" data-ai-place>传回到 Photoshop</button><span class="settings-note" data-ai-count-line>共 <b data-ai-count>'+(aiRuntime.outputs||[]).length+' 张</b></span></div>'
    +'<div data-ai-output-area>'+aiResultsHtml()+'</div>');
  const goto=[['output','抓图与出图'],['return','传回到 PS'],['group','编组与联动'],['feather','边缘羽化'],['align','对齐与校色'],['sound','完成音效'],['shortcuts','快捷键']];
  html+=sec('where','<div class="ai-actions gen-goto">'+goto.map(([id,label])=>'<button type="button" class="ai-btn" data-gen-goto="'+id+'">'+escapeHtml(label)+'</button>').join('')+'</div>');
  html+='</div>';
  body.innerHTML=html;
  bindGenerationDetail(body);
  body.querySelectorAll('[data-gen-goto]').forEach(btn=>btn.addEventListener('click',e=>{
    e.preventDefault();e.stopPropagation();
    navigateCard('settings',0,{section:btn.dataset.genGoto}).catch(error=>ERR.report('UI_ACTION_FAILED',{message:'跳到设置：'+String(error&&error.message||error)}));
  }));
  aiRefreshInPlace();
  V7CardArchitecture.helpify(body);
  return null;
}
// 暴露给 cards/card-generation.js（卡片文件在另一个作用域，读不到这里的函数）
window.V7GenerationPanel={render:renderGenerationPanel,renderPage:renderGenerationPage,tabs:GENERATION_TABS};

// 2026-10-18：fillGenerationDetail（老 #dcBody 分档分发器）删了 —— 生成卡改大二级后 0 个调用（docs/238 §4-2）。

// ── 历史卡详情渲染器（2026-09-14）──
// 列出全部缓存历史（包括从任务栏收起的），点了能恢复到任务栏。
function historyRecordTask(task){
  if(!task||task.kind!=='generation'||!String(task.prompt||'').trim()||!window.V7ProductData)return;
  if(task.storageNamespaceId&&task.storageNamespaceId!==cacheNamespaceId())return;
  try{
    V7ProductData.addHistory({taskId:String(task.taskId||task.id),prompt:task.prompt,presetId:task.presetId,
      presetTitle:task.presetTitle,presetVersion:task.presetVersion,model:task.model,provider:task.provider,protocol:task.protocol,
      projectId:task.productProjectId||undefined,documentName:task.sourceDocName||'',status:task.status,
      createdAt:new Date(task.startedAt||Date.now()).toISOString(),
      cacheRef:task.cacheProject&&task.cacheRunId?{project:task.cacheProject,runId:task.cacheRunId}:undefined,
      outputIndices:(task.shots||[]).map((s,i)=>s&&s.imgId?i:-1).filter(i=>i>=0),
      parameters:Object.assign({size:task.size,aspectRatio:task.aspectRatio,batch:task.batch,antiMode:task.antiMode},aiPersistentParameters(task.workflowParameters,task)),
      workflowPresetId:String(task.workflowPresetId||'')});
  }catch(error){if(!task._historyErrorReported){task._historyErrorReported=true;ERR.report('HISTORY_OPERATION_FAILED',{message:String(error.message||error)});}}
}
let historyViewSeq=0;
function historyCheckpointItems(){
  if(!window.V7ProductData||!window.V7Checkpoints)return [];
  return window.V7ProductData.checkpoints().filter(item=>{
    try{
      const ref=window.V7Checkpoints.parseCacheRef(item.cacheRef);
      return !window.WHEELCHAIR_STORAGE||window.WHEELCHAIR_STORAGE.ownsCacheProject(ref.project);
    }catch(_){return false;}
  });
}
// ⚠ openHistoryWorkspace(zone) 已删（2026-09-30）：记录卡没有分区了，
//   还留着一个带 zone 参数的入口，迟早有人传 3 进来点空。
//   现在一律走 V7RouteRegistry.open('records/...') 或 navigateCard('history',0,{...})。
function historyProjectContext(){
  const state=window.V7ProjectSchedule?.quickState?.(),project=state?.projectId&&window.V7ProductData?.getProject?.(state.projectId);
  return project?{id:project.id,scope:state.scope,name:project.name,documents:project.items.map(item=>item.document).filter(Boolean)}:null;
}
// ⭐ 2026-09-29 方案 B：历史库的宿主抽出来复用 ——「记录与恢复」卡的近期任务 / 全部历史 / 检查点与账单，
//   和「项目」卡的「本项目记录」（view:'current'）用同一个宿主，不各写一份。
function historyLibraryHost(body,view,viewId,viewScope,extra){
  return Object.assign({
    view,
    projectContext:historyProjectContext,
    scope:cacheNamespaceId,active:()=>viewId===historyViewSeq&&body.isConnected,
    cache:window.uiwin?.cache,
    project:cacheScopedProject,
    withCapacity:(bytes,write)=>checkpointRuntime?.withCacheCapacity?checkpointRuntime.withCacheCapacity(bytes,write):write(),
    owns:row=>row&&row.meta&&row.meta.version===CACHE_META_VERSION&&row.meta.repository==='cache.v1'&&cacheOwnsEntry(row),
    inTaskbar:row=>taskList.some(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId),
    async restore(row){const result=await cacheRestoreOne(row);broadcastRecordsChanged();return result;},
    async preview(bytes,num,total){
      if(viewScope!==cacheNamespaceId())return;
      // ⭐ 2026-10-04：历史库「查看结果」改走内置预览框（docs/132 §三）
      if(window.V7Tween){ window.V7Tween.showImage(bytes); return; }
      viewerOpen=true;bigTask=null;
      try{const result=await uiwin.viewer.open({bytes,mime:'image/png',num,total,reset:true});if(result?.ok===false)throw new Error(result.error);}
      catch(error){viewerOpen=false;throw error;}
    },
    checkpoints:historyCheckpointItems,
    openCheckpoint:item=>V7Checkpoints.openFolder(item,{cache:uiwin.cache,ownsProject:project=>!window.WHEELCHAIR_STORAGE||WHEELCHAIR_STORAGE.ownsCacheProject(project)}),
    // The history card shows local/cache cost records.  Its "账单与兑换"
    // action must enter the account billing service, rather than routing back
    // to the same history/costs page and creating a self-loop.
    openBilling:()=>window.V7AccountCenter?.open('billing')||navigateCard('settings',0,{section:'billing'})
  },extra||{});
}
// 「记录与恢复」卡三级渲染（fillHistoryDetail）与卡面刷新（loadMainCardHistory）
//   已在 2026-09-30 整块删除（docs/96 问题一 + 白扫链）：
//   · fillHistoryDetail 是「残留三级框」的货源 —— 记录卡没有三级，留着只会再被谁调到。
//   · loadMainCardHistory 每次都把整个 cache 目录扫一遍，扫完交给 renderHistoryCardFace，
//     而宿主【根本没实现】refreshRecordsFace 这个回调 → 结果没人用，纯白扫磁盘。
//   现在记录卡的数据只由它自己读一次（recordsLoadData → cache.list），靠事件驱动重画。
// 项目卡第 2 格「本项目记录」：当前项目（项目管理里选中的那单）的生成任务。卡片架构调这个。
function mountProjectRecords(body){
  const viewId=++historyViewSeq,viewScope=cacheNamespaceId();
  window.V7HistoryLibrary?.dispose();
  if(!window.uiwin?.cache){
    body.innerHTML='<p class="history-library-empty">缓存接口未连接；请在桌面软件中查看本项目的生成记录。</p>';
    return ()=>{};
  }
  return V7HistoryLibrary.mount(body,historyLibraryHost(body,'current',viewId,viewScope,{
    refresh:()=>{broadcastRecordsChanged();if(viewId===historyViewSeq&&body.isConnected)mountProjectRecords(body);}
  }));
}

// 2026-10-18：旧 AI 调试面板 fillAiDetail（四档：主链路测试 / 抗截断验证 / 批量与任务 / 接口与衍生）删了 —— 0 个调用，早期调试界面（docs/238 §4-1）。
if(window.uiwin&&window.uiwin.ai)window.uiwin.ai.onProgress(aiHandleProgress);

// ── 正式设置页：按四类组织可配置项，保存后立即同步运行时 ──
const SETTINGS_ZONE_SET=ZONE_SETS[CARD_SETTINGS]||[];
function settingsPanelForZone(zone){return document.querySelector('#dcBody .settings-panel[data-settings-zone="'+String(zone)+'"]');}
function settingValue(key){return settingsRuntime[key];}
// 数字类设置项的取值范围。⚠ 改成拖拽条之后必须给范围 ——
//   条没有上下限就画不出来。范围取各自消费方实际认的区间(见对应代码)。
const SETTING_RANGES={
  cacheCapacityGB:{min:1,max:1024,step:1,suffix:' GB'},
  // 细节补偿强度。0=不补，100=完全用原图细节。
  // ☠ 过高会出双边缘（AI 图自己也有高频，两份叠一起就是描边）。
  detailStrength:{min:0,max:150,step:5,suffix:'%'},
  // 占【选区短边】的百分比。上限 20 已经很夸张了（1220px 选区 = 244px），
  // 不给到 50 是因为那个量级只会让人以为功能坏了。
  returnFeatherShrink:{min:0,max:20,step:0.5,suffix:'%'},
  returnFeatherBlur:{min:0,max:20,step:0.5,suffix:'%'},
  blur:{min:0,max:60,step:1,suffix:'px'},
  opacity:{min:35,max:100,step:1,suffix:'%'},
  presetFlipNotches:{min:2,max:30,step:1,suffix:' 格'},
  soundVolume:{min:0,max:100,step:5,suffix:'%'},
  bridgePollMs:{min:20,max:2000,step:10,suffix:'ms'}
};
// ⚠ Phase B：engineEnvironmentHtml() 已删 —— 环境行的 markup 现在由外挂卡
//   直接调 V7EngineEnvironment.markup()（唯一一份，见 engines-card.js 的 data-env-row）。

// ── 启动引擎 + 等它真的起来 ──────────────────────────────
//  ⚠ 不能点完 spawn 就报"已启动"：Python 起来要一两秒，
//    立刻去探必然失败，用户会以为按钮没用。
//    这里轮询探活，探到了才算成功。
//
//  ⚠⚠ 2026-10-03 晚：加了 which 参数（'match' 校色 / 'matting' 抠像）。
//    原来这里【写死了两处】：start() 不传参 → 壳里默认 'match'（校色，37893）；
//    轮询探的也是 MATCHENGINE（37893）。于是外挂卡那颗「启动引擎」按下去，
//    拉起的是校色引擎，抠像/人体解析/过渡帧那个（37894）压根没被碰过 ——
//    界面还高高兴兴报"引擎起来了"，卡面照样写"引擎没起"。用户实测"反正就用不了"。
//    ⇒ which 必须一路传下去：start(which) + 用对应模块轮询。
async function engineStartAndWait(onStep, which){
  const say=m=>{ try{ onStep&&onStep(m); }catch(_){} };
  const target=String(which||'match');
  const isMatting=target==='matting';
  if(!(window.uiwin&&window.uiwin.engine&&window.uiwin.engine.start)){
    return {ok:false,error:'当前版本没有启动接口'};
  }
  say('正在启动…');
  let r;
  try{ r=await window.uiwin.engine.start(target); }
  catch(e){ return {ok:false,error:String(e&&e.message||e)}; }
  if(!r||!r.ok) return {ok:false,error:(r&&r.error)||'启动失败'};
  // 轮询等它监听端口。⚠ 给够 12 秒：首次启动 Python 要加载 numpy/cv2/torch，
  //   torch 尤其慢（几秒很正常）。等太短会误判成失败。
  //   ⚠ 抠像引擎（37894）首次还要拉 torch 子进程，给 20 秒更稳。
  const tries=isMatting?20:12;
  const probe=isMatting?(window.MATTINGENGINE||null):(window.MATCHENGINE||null);
  if(!probe||typeof probe.probe!=='function') return {ok:false,error:'探活模块没加载，没法确认它起来了'};
  for(let i=0;i<tries;i++){
    await new Promise(res=>setTimeout(res,1000));
    say('已拉起（'+r.launcher+'），等它就绪… '+(i+1)+'s');
    let st;
    try{ st=await probe.probe(true); }catch(_){ st=null; }
    if(st&&st.available) return {ok:true,st,launcher:r.launcher,which:target};
  }
  return {ok:false,error:'进程起来了但一直没监听端口，多半是缺依赖（在终端里跑一次看报错）'};
}

// 引擎离线时弹的那张卡：带「立刻启动」按钮，不是干说一句"不可用"
let engineOfflineNotified=false;
// ⚠ force：用户【主动点了按钮】才走的路径必须强制弹卡。
//   一次性提醒对"后台自动发现掉线"是对的，但对"我点了它没反应"是灾难 ——
//   用户会以为功能坏了（记忆里那条"一次性动作必须留常驻入口"同理）。
function notifyEngineOffline(reason,force){
  if((engineOfflineNotified&&!force)||!window.ERR) return;
  engineOfflineNotified=true;
  ERR.report(force?'ENGINE_OFFLINE':'ENGINE_OFFLINE_BACKGROUND',{
    message:reason||'没有响应',
    context:{'影响':'只影响「稠密光流」对齐和「细节补偿」；网格对齐和校色已内置，照常工作','端口':String(MATCHENGINE.ENGINE_PORT)},
    confirm:'立刻启动', cancel:'先不用',
    // ⭐ 2026-10-06 晚：动作卡默认把详情摊开（按钮直接可见），但【不】注册成
    //   L3 决定卡 —— 否则 V7FocusScope 会让全局右滑手势停摆（用户实测的那个 bug）。
    expand:true,
    onConfirm:async()=>{
      const tip=m=>aiAddLog('[引擎] '+m,'info');
      // ⭐ 2026-10-22（docs/263 第 5 条）：失败时报错卡上给「再启动一次」（启动引擎不扣分），所以把启动包成可重复调用的
      const start=async()=>{
        const r=await engineStartAndWait(tip);
        if(r.ok){
          ERR.report('ENGINE_STARTED',{message:'档 '+r.st.tier+' · '+r.st.device});
          refreshEngineBox(true);
          engineOfflineNotified=false;      // 下次真掉线了还能再提醒
        }else{
          ERR.report('ENGINE_START_FAILED',{message:r.error,
            context:{'下一步':'去外挂能力卡 · 配置信息 看「环境」那一行，装好再启动'},
            retry:()=>{ start(); }, retryLabel:'再启动一次'});
        }
      };
      await start();
    },
    onCancel:()=>{ /* 用户明确说了不用，这次会话不再打扰 */ }
  });
}

function engineBoxHtml(){
  return '<div class="eng-box" data-engine-box>'+engineBoxInner(null,true)+'</div>';
}
// 引擎起不来时那句"原因"，翻成人话（2026-10-05）。
// ⚠⚠ 起因：用户报"还是留了大量的专有名词"，探针扫到卡片上印着
//   `原因：Failed to fetch` —— 那是浏览器/运行时抛出来的原始英文，用户看不懂。
//   ⚠ 细节【不丢】：调用方仍然把原始 lastError 原样报给 ERR.report。
//     这里只管"卡片上那句话怎么说"。
function engineWhyText(raw){
  const s=String(raw||'').trim();
  if(!s) return '引擎没有响应 —— 点下面「立刻启动」试一次';
  // 按最常见的几种翻；认不出来就兜底，不把英文原样吐给用户
  if(/failed to fetch|networkerror|econnrefused|connection refused/i.test(s))
    return '没连上引擎服务 —— 它可能还没启动，点下面「立刻启动」';
  if(/timeout|timed out|etimedout/i.test(s))
    return '引擎响应超时 —— 它可能在启动中，等十几秒再点「重新检测」';
  if(/enoent|not found|no such file/i.test(s))
    return '引擎还没装好 —— 去外挂能力卡 · 配置信息看「环境」那一行';
  if(/permission|eacces|access is denied/i.test(s))
    return '没有权限启动引擎 —— 换个位置装，或以管理员身份运行';
  if(/onnxruntime|import|modulenotfound|no module/i.test(s))
    return '引擎缺一个组件 —— 去外挂能力卡 · 配置信息点「安装」补齐';
  // 认不出来的：给一句人话 + 首行原文（截断，避免糊一大片）
  const first=s.split(/[\r\n]+/)[0].slice(0,60);
  return '引擎没起来。技术细节：'+first;
}
function engineBoxInner(st,probing){
  if(probing){
    return '<div class="eng-head"><i class="eng-dot busy"></i><span class="eng-title">正在检测…</span></div>';
  }
  if(st&&st.available){
    const caps=st.caps||{};
    // 能力标签：一眼看出缺哪块、缺的那块影响什么
    // ⚠ 这个 chip 只有 9px，图标给 10px（再小就糊成一团）。
    //   颜色不在这写 —— .eng-cap.on 已经管了绿色，图标 currentColor 自动跟上。
    const chip=(on,name)=>'<span class="eng-cap'+(on?' on':'')+'">'
      +(window.ICON?ICON.render(on?'check':'close',10):(on?'✓':'✗'))
      +'<span>'+name+'</span></span>';
    // ⭐⭐ Phase E（docs/150 §8-2）：调试卡只读化 ——【删操作按钮与绑定，保留只读状态显示】。
    //   操作入口（启动/停止/重新检测/安装/导入）都搬到外挂能力卡，这里不再留第二份绑定。
    return '<div class="eng-head"><i class="eng-dot ok"></i>'+
      '<span class="eng-title">加速引擎在线 · 档 '+st.tier+'</span></div>'+
      '<div class="eng-sub">'+escapeHtml(String(st.device||'').replace(/\s*\([^)]*\)\s*/g,''))+
        (st.vramGB?(' · 显卡内存 '+st.vramGB+'G'):'')+'</div>'+
      '<div class="eng-caps">'+
        chip(caps.numpy,'校色')+chip(caps.cv2,'细节还原')+
        chip(caps.cuda,'显卡加速')+chip(caps.cuda&&st.vramGB>=20,'无缝融合')+
      '</div>'+
      (st.tier<3?('<div class="eng-sub">'+(!caps.cv2
        ? '差一个图像处理组件 —— <b>细节还原和无缝融合都用不了</b>，装上提升最大'
        : '显卡内存不够，无缝融合未启用')+'</div>'):'')+
      '<div class="eng-sub">只读状态。要启动 / 停止 / 装模型，去 <b>外挂能力卡 · 配置信息</b>。</div>';
  }
  // 未就绪：把该做什么直接摆出来
  // ⚠⚠ 2026-10-05：原来这里把 st.lastError【原样印出来】——
  //   探针扫到界面上明晃晃写着 `原因：Failed to fetch`（用户："还是留了大量的专有名词"）。
  //   原始英文报错是给排查用的，不该出现在卡片上。这里统一换成人话，
  //   细节仍然原样报给 ERR（见调用方），不丢线索。
  const why=engineWhyText(st&&st.lastError);
  // ⭐ Phase E：只读 —— 按钮/环境块全删，只留"现在什么状态、为什么、去哪处理"。
  return '<div class="eng-head"><i class="eng-dot off"></i>'+
    '<span class="eng-title">未启用加速引擎</span></div>'+
    '<div class="eng-sub">当前用本机算法：<b>对齐和校色都已内置，生成照常工作</b>。'+
      '引擎只是让对齐更准一点、多一个细节还原。<br>原因：'+escapeHtml(why)+'</div>'+
    '<div class="eng-sub">只读状态。要启动 / 停止 / 装模型，去 <b>外挂能力卡 · 配置信息</b>。</div>';
}
// 刷新所有已渲染的检测器（设置页可能开着好几次）
// ═══ 抠像模型库（2026-09-14）═════════════════════════════════
//
// ⚠ 和校色那块的关键差别：校色没装也能用（回落档1），抠像【没装就是不能用】。
//   所以这里的措辞不能是"可选加速"，必须明说缺什么、去哪补（docs/40 规矩5）。
//
// ⚠ 模型不打进安装包（用户 2026-09-14 定）：单个 400~500MB，
//   全打进去会顶爆"安装包 1GB 以内"，服务器 2核2G 也发不了。
//   所以是【用户从网盘下到文件夹 → 这里扫出来 → 点启用】。
function mattingBoxInner(st, loading){
  if(loading) return '<div class="ai-note">正在检查抠像引擎…</div>';
  if(!st) return '<div class="ai-note">没读到引擎状态</div>';

  let h='';
  // ── 引擎状态行 ──
  const on=st.available;
  h+='<div class="eng-state'+(on?' ok':'')+'">'
    +'<span class="eng-dot"></span>'
    +'<b>'+(on?('引擎在线 · 档 '+st.tier):'引擎没启动')+'</b>'
    +(on&&st.device?'<span class="eng-dev">'+escapeHtml(st.device)+(st.vramGB?(' '+st.vramGB+'G'):'')+'</span>':'')
    +'</div>';

  // ── 用不了的话，把原因和下一步说清楚（这是本块最要紧的部分）──
  const why = window.MATTINGENGINE ? MATTINGENGINE.unusableReason() : '调度层没加载';
  if(why){
    h+='<div class="ai-note" style="color:hsl(var(--sem-warn))">⚠ '+escapeHtml(why)+'</div>';
  }

  // ── 依赖 ──
  if(on){
    const c=st.caps||{};
    const chip=(ok,name)=>'<span class="eng-cap'+(ok?' on':'')+'">'
      +(window.ICON?ICON.render(ok?'check':'close',10):(ok?'✓':'✗'))+'<span>'+name+'</span></span>';
    h+='<div class="eng-caps">'+chip(c.numpy,'numpy')+chip(c.onnx,'onnxruntime')
      +chip(c.onnx_gpu,'GPU 加速')+chip(c.pil||c.cv2,'图片编解码')+'</div>';
    if(!c.onnx_gpu && c.onnx){
      h+='<div class="ai-note">只有 CPU 可用 —— 能跑，但会慢很多（一张图可能要十几秒）。</div>';
    }
  }

  // ⭐⭐ Phase E（docs/150 §8-2）：抠像框只读化。
  //   模型/环境的【操作】入口全在外挂能力卡 · 配置信息（唯一管理页，§5.2）；
  //   这里只显示状态（引擎在不在、缺什么、模型目录在哪），按钮一个不留。
  if(on&&st.modelsDir){
    h+='<div class="eng-cmd">'+escapeHtml(st.modelsDir)+'</div>';
  }
  h+='<div class="ai-note">只读状态。装模型 / 准备环境 / 启停引擎，去 <b>外挂能力卡 · 配置信息</b>。</div>';
  return h;
}

function refreshMattingBox(force){
  const boxes=document.querySelectorAll('[data-matting-box]');
  if(!boxes.length) return;
  // ⚠ 调度层没加载时【不能静默 return】——
  //   那样界面会永远停在"正在检查…"，症状和"卡死"一模一样、毫无线索。
  //   2026-09-14 就吃过这个哑巴亏（当时真因是触发加错了函数，但表现完全一样，
  //   如果这里有这条提示，一眼就能排除掉一半可能）。
  if(!window.MATTINGENGINE){
    boxes.forEach(b=>{ b.innerHTML='<div class="ai-note" style="color:hsl(var(--sem-warn))">'
      +'⚠ matting-engine.js 没加载 —— 这是程序自身的问题，不是你的环境。</div>'; });
    return;
  }
  boxes.forEach(b=>{b.innerHTML=mattingBoxInner(null,true);});
  // ⚠ force=true：用户刚把文件拖进文件夹，必须拿实时的，不能吃 60 秒缓存
  MATTINGENGINE.probe(true).then(st=>{
    document.querySelectorAll('[data-matting-box]').forEach(b=>{
      b.innerHTML=mattingBoxInner(st,false);
    });
  }).catch(e=>{
    document.querySelectorAll('[data-matting-box]').forEach(b=>{
      b.innerHTML='<div class="ai-note">检查失败：'+escapeHtml(String(e&&e.message||e))+'</div>';
    });
  });
}
// ⚠⚠ Phase E（docs/150 §8-2）：bindMattingBox / bindEngineBox / bindEngineStop 三个函数
//   【已删】—— 它们绑的全是操作按钮（启动/停止/重扫/检查/释放显存），而那些操作
//   已经搬到外挂能力卡 · 配置信息（唯一管理页）。留在这里 = 两份绑定（铁律 28）。

function refreshEngineBox(force){
  const boxes=document.querySelectorAll('[data-engine-box]');
  if(!boxes.length||!window.MATCHENGINE) return;
  boxes.forEach(b=>{b.innerHTML=engineBoxInner(null,true);});
  MATCHENGINE.probe(!!force).then(st=>{
    document.querySelectorAll('[data-engine-box]').forEach(b=>{
      b.innerHTML=engineBoxInner(st,false);
    });
  }).catch(()=>{
    document.querySelectorAll('[data-engine-box]').forEach(b=>{
      b.innerHTML=engineBoxInner({available:false,lastError:'检测失败'},false);
    });
  });
}

// 把「自动校色（AI 图套回原图色调）」这种标签拆成两段：
//   主标签 = 自动校色        说明 = AI 图套回原图色调
// ⚠ 为什么要拆(2026-09-12 用户反馈"挤压得一塌糊涂")：
//   三级卡本来就窄，两列布局每列只剩约 140px，
//   16 个字的标签塞进去必然被截断成「自动校...」—— 用户根本看不出这是什么开关。
//   拆开之后主标签短了能放下，说明用小字单独占一行，信息一个字没丢。
function splitSettingLabel(label){
  const m=String(label||'').match(/^(.*?)[（(]([^）)]*)[）)]\s*$/);
  if(!m) return {main:String(label||''), hint:''};
  return {main:m[1].trim(), hint:m[2].trim()};
}
// 这一项该不该占满整行。
// ⚠ 判据是【主标签长度】不是原始标签 —— 拆掉括号之后多数标签都短了，
//   还按原长度判会让一堆本来放得下的项白白占整行。
function settingWantsFullRow(type,main,extra){
  if(type==='checkbox') return true;   // 开关是"标签在左、开关在右"，窄列必被挤
  if(type==='number') return true;     // 拖拽条要横向空间，窄列拖不动
  if(main.length>7) return true;       // 主标签超过 7 字就独占一行
  // ⚠ 还要看【选项文案】有多长 —— 标签短不代表放得下。
  //   例：「抓取分辨率」才 5 个字，但它的选项是
  //   「4096 · 约 64MB（几乎必被退回）」22 个字，窄框里照样截断。
  //   阈值取 6 是量出来的：三级卡两列时每列约 140px，
  //   12px 中文字放得下 7~8 个就到边了，再加下拉箭头和内边距，6 个字是安全线。
  //   ⚠ 宁可多占一行，也不要出现半截字 —— 用户抱怨的是"挤"，不是"长"。
  if(Array.isArray(extra)){
    const longest=extra.reduce((n,x)=>Math.max(n,String((x&&x[1])||'').length),0);
    if(longest>6) return true;
  }
  return false;
}

// ⚠⚠ 2026-10-08 新增第 5 个参数 opts：
//   「占位也占的不是很明确」（用户原话）—— 全项目的连接类输入框【一个 placeholder 都没有】
//   （实测 16 个：backendUrl / 四家 Url+Key / RH / ComfyUI 全无）。
//   用户看到一个空框，不知道该填 https:// 还是只填域名、Key 是 sk- 开头还是别的。
//   ⇒ opts.placeholder 给例子；opts.hint 给"填错了会怎样"的一句话（可选）。
//   ⚠ 参数位置在最后，老调用（key,label,type,extra）一个都不用改。
// ⭐ 2026-10-17 夏三六（用户：「没有把我们软件里面的这个接口和内容……暴露给我们的Agent」）：
//   设置页每画一项就在这里登记一次（名字 / 类型 / 能选哪些），夏三六的 settings_read / settings_write 只认登记过的项。
//   ⚠ 用 var 且不给初值、用到时才建：函数声明会提升，settingControl 可能在这一行执行【之前】就被调到，
//     写成 const 会撞暂时性死区（铁律 17 表里那条），写成 var X=new Map() 那时也还是 undefined。
var SETTING_META;
function settingControl(key,label,type,extra,opts){
  opts=opts||{};
  (SETTING_META||(SETTING_META=new Map())).set(key,{key,label:String(label||key),type:String(type||'text'),options:Array.isArray(extra)?extra.map(x=>[String(x&&x[0]),String(x&&x[1]!=null?x[1]:x&&x[0])]):null});
  const v=settingValue(key); let c='';
  const L=splitSettingLabel(label);
  const full=settingWantsFullRow(type,L.main,extra);
  const hintHtml=L.hint?'<span class="sf-hint">'+escapeHtml(L.hint)+'</span>':'';
  // ⚠⚠ 2026-10-08 修（用户："占位也占的不是很明确" + 实测有 16 个输入框没有任何提示）：
  //   整页的连接类输入框现在都能带一个例子占位。类型是 password 时给"已保存 · 换掉就填新的"，
  //   因为密码框不该把用户的 Key echo 出来，但也不能空着让人不知道填不填。
  const ph=opts.placeholder?String(opts.placeholder):'';
  const phAttr=ph?' placeholder="'+escapeHtml(ph)+'"':'';
  // ⚠ 值非空时不显示占位（HTML 本来就这样），但类型是 password 且已有保存值时要额外说一句
  const 已存提示=(type==='password'&&String(v||'').trim())?' placeholder="已保存 —— 要换就填新的"':'';
  // ⚠ 全项目不许出现原生控件外观(用户 2026-09-11 定案):
  //   checkbox → 滑动开关(.tgl)、number → 点按/拖拽条(.nsl)。
  //   底层元素没变(还是 checkbox / range)，所以 settingsReadFields 读值的代码一行没改。
  if(type==='checkbox'){
    c='<div class="settings-row full">'+switchControl(L.main,'data-setting="'+key+'"',!!v)+hintHtml+'</div>';
  }
  else if(type==='number'){
    const r=SETTING_RANGES[key]||{min:0,max:100,step:1,suffix:''};
    c='<div class="settings-row full">'
      +numControl({attr:'data-setting="'+key+'"',name:L.main,min:r.min,max:r.max,step:r.step,
                   suffix:r.suffix,value:Number(v),cls:'settings-field'})
      +hintHtml+'</div>';
  }
  else if(type==='color'){
    // ⭐ 调色控件（2026-09-14）：色块 + 「默认」按钮。
    // ⚠ 必须有「默认」那个按钮 —— 原生 <input type=color> 没有"清空"的操作，
    //   没有它用户一旦点过色块就再也回不到项目原本的配色了
    //   （同 feedback_one_shot_prompt_needs_entry：别把退路堵死）。
    const cv=String(v||'');
    c='<div class="settings-row full"><div class="settings-color">'
      +'<span class="sc-name">'+escapeHtml(L.main)+'</span>'
      +'<input type="color" data-setting="'+key+'" value="'+escapeHtml(cv||'#2a2f3a')+'"'+(cv?'':' data-unset="1"')+'>'
      +'<button type="button" class="sc-reset" data-color-reset="'+key+'"'+(cv?'':' disabled')+'>默认</button>'
      +'</div>'+hintHtml+'</div>';
  }
  else if(type==='select'){
    c='<label class="settings-field'+(full?' full':'')+'"><span>'+escapeHtml(L.main)+'</span>'
      +'<select data-setting="'+key+'">'+extra.map(x=>'<option value="'+escapeHtml(x[0])+'" '+(String(v)===String(x[0])?'selected':'')+'>'+escapeHtml(x[1])+'</option>').join('')+'</select>'
      +hintHtml+'</label>';
  }
  else {
    // ⚠ 2026-10-14：从"只认 generationShortcut"改成"认所有快捷键类字段"
    //   （加了 referenceShortcut；再来第三个键也不用再改这里）
    const isShortcut=SHORTCUT_SETTING_KEYS.has(key);
    const shown=isShortcut?formatShortcutValue(v||''):(v==null?'':String(v));
    c='<label class="settings-field'+(full?' full':'')+'"><span>'+escapeHtml(L.main)+'</span>'
      +'<input data-setting="'+key+'" type="'+(type||'text')+'" value="'+escapeHtml(shown)+'"'+(isShortcut?' placeholder="没设 · 点这里按组合键，按退格清除"':(phAttr+已存提示))
      +'>'
      +hintHtml+'</label>';
  }
  return c;
}
function normalizeShortcutValue(value){
  const aliases={control:'mod',ctrl:'mod',command:'mod',cmd:'mod',meta:'mod','ctrl/cmd':'mod',return:'enter',' ':'space'};
  const parts=String(value||'').toLowerCase().split('+').map(x=>x.trim()).filter(Boolean).map(x=>aliases[x]||x);
  const mods=['mod','alt','shift']; const out=[];
  mods.forEach(m=>{if(parts.includes(m))out.push(m);});
  const key=parts.find(x=>!mods.includes(x)); if(key)out.push(key);
  return out.join('+');
}
function eventShortcutValue(e){
  const parts=[]; if(e.ctrlKey||e.metaKey)parts.push('mod'); if(e.altKey)parts.push('alt'); if(e.shiftKey)parts.push('shift');
  let key=String(e.key||'').toLowerCase();
  if((!key||key==='unidentified')&&e.code) key=String(e.code).replace(/^key|^digit/,'').toLowerCase();
  if(key==='escape') key='esc';
  if(!['control','meta','alt','shift'].includes(key))parts.push(key===' ' ? 'space' : key);
  return normalizeShortcutValue(parts.join('+'));
}
// ⭐ 2026-10-14：改成"对指定的那个快捷键"匹配（原来写死只看 generationShortcut）。
//   加参考图键之后需要按字段名查，所以多一个参数；不传就还是老行为（生成）。
function shortcutMatchesEvent(e,key){
  const field=key||'generationShortcut';
  // 2026-10-18 晚：没设就是没有，不再兜底成 Ctrl+Enter
  const configured=normalizeShortcutValue(settingsRuntime[field]||'');
  const actual=eventShortcutValue(e);
  return !!configured && !!actual && configured===actual;
}
function formatShortcutValue(value){
  const labels={mod:'Ctrl/Cmd',alt:'Alt',shift:'Shift',enter:'Enter',space:'Space'};
  return normalizeShortcutValue(value).split('+').filter(Boolean).map(x=>labels[x]||x.toUpperCase()).join('+');
}
// 按钮的鼠标提示：设了快捷键写上；没设（2026-10-18 晚起默认没有）就说在哪设
function shortcutTitle(name,value){
  const shown=formatShortcutValue(value||'');
  return shown?(name+'（'+shown+'）'):(name+'（没设快捷键 · 可以在设置卡「快捷键」里设）');
}
// 无障碍属性要的是标准键名。mod 在两个平台上是两套键，按 aria 规范两组都列出来。
function ariaShortcutValue(value){
  const parts=normalizeShortcutValue(value).split('+').filter(Boolean);
  if(!parts.length)return '';
  const names={alt:'Alt',shift:'Shift',enter:'Enter',space:'Space',esc:'Escape'};
  const name=x=>names[x]||(x.length===1?x.toUpperCase():x.replace(/^./,c=>c.toUpperCase()));
  if(!parts.includes('mod'))return parts.map(name).join('+');
  const rest=parts.filter(x=>x!=='mod').map(name);
  return ['Control'].concat(rest).join('+')+' '+['Meta'].concat(rest).join('+');
}
function bindSettingsDetail(root){
  const boundScope=settingsStorageKey();root.dataset.settingsScope=boundScope;
  // ⭐ 2026-10-18 深夜：RunningHub 没接线 —— 选项灰掉、那一节的输入框和按钮全部点不了（总开关 window.V7_RUNNINGHUB_OFF）
  if(window.V7_RUNNINGHUB_OFF){
    root.querySelectorAll('select[data-setting="workflowSource"] option[value="own"]').forEach(o=>{o.disabled=true;});
    root.querySelectorAll('[data-setting="runninghubUrl"],[data-setting="runninghubKey"],[data-setting="rhWorkflowId"],[data-setting="rhWorkflowName"],[data-rh-test],[data-rh-import]').forEach(el=>{
      el.disabled=true;el.title='RunningHub 还没接通，暂时不能用';
      const box=el.closest('.settings-field,.settings-actions,label');if(box)box.classList.add('v7-rh-off');
    });
  }
  // A failed native exit can leave the current window expanded even when this
  // account prefers normal mode. Newly rendered controls must offer a real exit.
  root.querySelectorAll('[data-setting="freeMode"]').forEach(el=>{if(window.V7FreeMode)el.checked=V7FreeMode.isActive();});
  const layoutButton=root.querySelector('[data-layout-open]');
  if(layoutButton)layoutButton.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();
    if(window.V7LayoutManager)window.V7LayoutManager.open();
  });
  // ⚠ 2026-09-30：账号备份的入口现在是设置卡「存储与隐私 → 账号备份」，
  //   不再跳记录卡（记录卡只管找回以前的东西，备份是设置项）。
  const cloudButton=root.querySelector('[data-account-backup]');if(cloudButton)cloudButton.onclick=()=>window.V7RouteRegistry?.open('records/backup')||navigateCard('settings',3,{section:'account-backup'});
  //  ⚠ 2026-10-10：属性名从 data-community-open 改成 data-community-nav —— 见下面那个按钮的说明。
  const communityButton=root.querySelector('[data-community-nav]');if(communityButton)communityButton.onclick=()=>navigateCard('settings',0,{section:'community'});
  root.querySelectorAll('[data-account-center]').forEach(button=>button.onclick=()=>window.V7AccountCenter?.open(button.dataset.accountCenter));
  root.querySelectorAll('[data-setting]').forEach(el=>{
    el.addEventListener('input',()=>{el.dataset.settingEdited='1';});
    el.addEventListener('change',()=>{if(boundScope===settingsStorageKey())settingsReadFields(root,el);});
  });
  otherProfilesBind(root);
  providerLinesBind(root);   // 2026-10-24（V7待办/02）：阿吉 / 墨墨自动选线那一行
  // ⭐ 2026-10-09：设置页画完就刷一次「平台额度」那一行。
  //   ⚠ 必须在这里刷（而不是只在拼 markup 时刷）：那时 DOM 刚拼好、余额还没取；
  //     而且登录状态可能在这之后才变成已登录。
  //   ⚠ 延后一拍：这个函数跑在挂载流程里，立刻取余额会跟别的一次请求抢先后。
  try{ setTimeout(()=>{ if(typeof refreshGrsQuota==='function')refreshGrsQuota(); },400); }catch(_){}
  const accountStatus=()=>{
    const current=window.V7Backend&&window.V7Backend.state?window.V7Backend.state():null;
    const label=root.querySelector('[data-account-status]'), dot=root.querySelector('[data-account-status-dot]');
    if(!label||!dot)return;
    const signed=!!(current&&current.signedIn);
    // ⭐ 2026-10-15：设置页顶上那条"未登录…已置灰"横幅撤了，同样的话放到这里（它本来就该在登录这一节说）。
    label.textContent=signed?('已登录：'+((current.account&&current.account.email)||'当前账号')):'未登录：积分、云同步、云备份、客服、社区已置灰，登录后可用；自己的 API Key 不登录也能用';
    dot.className=signed?'ok':'';
  };
  root._settingsAccountCleanup?.();
  if(window.V7Backend&&window.V7Backend.onChange) root._settingsAccountCleanup=window.V7Backend.onChange(accountStatus);
  accountStatus();
  const accountValue=(name)=>{const el=root.querySelector('[data-account-'+name+']');return el?String(el.value||'').trim():'';};
  // ⚠⚠ 2026-10-10 对抗审查发现（用户要求「找到各种人为操作的 bug/问题/漏洞/边界/降级」）：
  //
  //   原来这里是：catch(err){ ERR.report('BACKEND_ACCOUNT_FAILED', {...}) }
  //   —— 所有账号操作的失败都被塞进【同一个码】，而且【只上报、不在界面上说】。
  //   实测踩到的现场（真窗口，全空点登录）：
  //     · 点了登录 → 屏幕上【什么都不显示】，状态行还停在"未登录：平台算力不可用"
  //     · ERR 里记的是 "BACKEND_ACCOUNT_FAILED 邮箱或密码错误"
  //   两个问题：
  //     ① 用户看不到 —— 点了没反应，他不知道是没填、验证码没取到、还是网络问题（静默失效）
  //     ② 归因是错的 —— 客户端拦下来的"验证码还没取到"，也被记成"邮箱或密码错误"
  //
  //   ⇒ 改法：按 err.code 出【用户能看懂、且能照着做】的提示；
  //     真的没有 code 的才落到通用码。
  //   ⚠ 提示出三个地方（状态行 + toast），因为用户可能正在看输入框、没看状态行。
  const accountFailText=err=>{
    const code=String((err&&err.code)||'');
    if(code==='ACCOUNT_EMAIL_EMPTY')return '还没填邮箱 —— 填你注册用的邮箱';
    if(code==='ACCOUNT_PASSWORD_EMPTY')return '还没填密码';
    if(code==='ACCOUNT_CAPTCHA_EMPTY')return '还没填验证码 —— 照右边图上那几位填';
    if(code==='CAPTCHA_NOT_READY')return '验证码还没取到 —— 点一下右边那张图，等它显示出来再试';
    if(code==='CAPTCHA_INVALID')return '验证码不对或过期了 —— 点一下图换一张再填';
    if(code==='LOGIN_FAILED')return '邮箱或密码不对。连续错多次会临时锁一会儿，先确认密码再试';
    if(code==='CARD_NOT_FOUND')return '卡密不对 —— 检查有没有输错字符（易混的 0/O、1/I 不存在）';
    if(code==='CARD_ALREADY_REDEEMED')return '这张卡密已经用过了';
    if(code==='AUTH_RATE_LIMITED')return '试得太频繁了，等一会儿再试';
    if(code==='BACKEND_UNREACHABLE'||code==='BACKEND_REQUEST_FAILED')return '连不上服务器 —— 检查网络后重试';
    if(code==='NETWORK_OFFLINE')return '现在没有网络 —— 恢复后再试';
    return String((err&&err.message)||err||'操作没成功');
  };
  const accountAction=(selector,fn)=>{const el=root.querySelector(selector);if(el)el.addEventListener('click',async e=>{
    e.preventDefault();e.stopPropagation();
    try{await fn();accountStatus();}
    catch(err){
      const text=accountFailText(err);
      // ① 状态行（用户多半正看着表单）
      const line=root.querySelector('[data-account-status]');
      if(line)line.textContent='⚠ '+text;
      // ② toast（状态行可能在视野外）
      if(window.UI&&UI.toast)UI.toast(text,'warn',4200);
      // ③ 上报（诊断用）—— 带上真实的 code，别再用一个通用码盖掉归因
      if(window.ERR)ERR.report(err&&err.code?String(err.code):'BACKEND_ACCOUNT_FAILED',
        {message:String(err&&err.message||err),context:{code:err&&err.code||''}});
    }
  });};

  // ⭐⭐ 2026-10-09（用户定：「你好歹去个手动验证码吧？手工输入的验证码登录的时候吧？」）
  //   图形验证码：取一张、画出来、登录/注册时带上答案。
  //   ⚠ 验证码【一次性】：后端 consume 不管对错都作废 ⇒ 成功后、失败后都要换新的。
  //     忘了换的后果是"第二次登录必然报验证码错"，用户会以为是自己打错了。
  //   ⚠ 图是后端自绘的 SVG（captcha.py），直接塞进按钮里；不引第三方。
  //   ⚠ 取码本身也有频率限制（每 IP 每分钟 20 张），所以【不能】在每次重绘时狂取 ——
  //     只在"进这一页"和"用户点图 / 上一次用掉了"这两种时机取。
  let accountCaptchaId='';
  const accountCaptchaEl=()=>root.querySelector('[data-account-captcha]');
  const accountCaptchaImgEl=()=>root.querySelector('[data-account-captcha-img]');
  function accountCaptchaFail(reason){const box=accountCaptchaImgEl();if(box)box.textContent=reason||'点这里取验证码';}
  async function accountRefreshCaptcha(){
    const box=accountCaptchaImgEl();
    if(!box||!window.V7Backend||!window.V7Backend.captchaChallenge)return;
    accountCaptchaId='';
    box.textContent='正在取…';
    try{
      const issued=await window.V7Backend.captchaChallenge();
      accountCaptchaId=String(issued&&issued.id||'');
      // ⚠ 用 innerHTML 塞 SVG：后端给的就是一段 <svg>，不是 data: URL。
      //   它自己带 width/height/viewBox，样式由 CSS 兜底（见 .settings-captcha-img svg）。
      if(issued&&issued.svg)box.innerHTML=String(issued.svg);else accountCaptchaFail('取不到验证码，点这里重试');
    }catch(err){
      accountCaptchaFail('取不到验证码（点这里重试）');
      console.log('[验证码] 取码失败：'+String(err&&err.message||err));
    }
  }
  const accountCaptchaAnswer=()=>{const el=accountCaptchaEl();return el?String(el.value||'').trim():'';};
  const accountClearCaptchaInput=()=>{const el=accountCaptchaEl();if(el)el.value='';};
  // 点图换一张
  {const img=accountCaptchaImgEl();if(img)img.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();accountClearCaptchaInput();accountRefreshCaptcha();});}
  // 进这一页就取一张（要等后端客户端就绪 —— 它是异步加载的）
  // ══════════════════════════════════════════════════════════════════
  //  ⭐⭐ 2026-10-14「记住我」+ 自动登录（用户要求：
  //      「登录账号的地方要加一个保存账号和密码以及自动登录」）
  // ══════════════════════════════════════════════════════════════════
  //  ⚠⚠ 存的是【登录凭证】，不是密码 —— 这一点是我问过用户之后他选的方案 A。
  //     界面上那句话也是照这个写的（"只保存登录凭证，不保存密码"）。
  //     别为了"省事"改成存密码：那会让他的密码以可解密的形式躺在硬盘上，
  //     而人多平台复用同一个密码，泄漏一个等于泄漏一片。
  const accountRememberEl=()=>root.querySelector('[data-account-remember]');
  const accountRememberWanted=()=>{const el=accountRememberEl();return !!(el&&el.checked);};
  // 把"现在记着哪个邮箱"显示出来 —— 不给回馈的话用户不知道勾了有没有生效
  function accountRefreshRememberStatus(){
    const out=root.querySelector('[data-account-remember-status]');
    if(!out)return;
    let info=null;
    try{ info=window.V7Backend&&window.V7Backend.remembered?window.V7Backend.remembered():null; }catch(_){}
    out.textContent=info?('本机已记住：'+info.email+' · 下次打开自动登录'):'本机没有记住任何账号';
    const el=accountRememberEl();
    // ⚠ 已经记住的时候把勾打上：不然用户看到"已记住 xxx"但勾是空的，会以为坏了
    if(el&&info&&!el.checked)el.checked=true;
  }
  // ⚠ 2026-10-14：挂到 window 上 —— card-architecture.js 的「账号」那一节是【挑着搬】的，
  //   搬完要按实际情况刷一次这行状态文字（"本机已记住：xxx"）。它读不到主 IIFE 里的局部函数。
  root.accountRefreshRememberStatus=accountRefreshRememberStatus;
  // ⚠⚠⚠ 2026-10-14：自动登录那段【不在这里】——它搬走了，见文件末尾
  //   「平台公告」那一片附近的 accountAutoLoginBoot。
  //   为什么必须搬：这里整个是 bindSettingsDetail() 的函数体，而它是【打开设置卡时才跑】的。
  //   我第一版把 accountAutoLoginBoot 写在这儿 ⇒ 不打开设置卡就永远不执行 ⇒
  //   自动登录【永远不生效、且没有任何报错】（启动探针 window.__autoLogin 一直是"(没跑)"，
  //   我查了整整两轮才定位到"它根本不在启动路径上"）。
  //   教训：往这个文件里加"启动时要做的事"之前，先确认自己站在哪个函数体内 ——
  //   这个文件里函数很长，视觉上很容易以为自己在顶层。

  (function accountCaptchaBoot(){
    let tries=0;
    const timer=setInterval(()=>{
      tries++;
      if(!accountCaptchaImgEl()||!(window.V7Backend&&window.V7Backend.captchaChallenge)){if(tries>40)clearInterval(timer);return;}
      clearInterval(timer);
      accountRefreshCaptcha();
    },250);
  })();

  accountAction('[data-account-login]',async()=>{
    if(!window.V7Backend)throw new Error('后端客户端不可用');
    // ⚠⚠ 2026-10-10 对抗审查补（用户要求「找到各种人为操作的 bug/问题/漏洞/边界/降级」）：
    //   实测：把表单全留空直接点登录，后端会回 LOGIN_FAILED「邮箱或密码错误」——
    //   可用户是【根本没填】。那个提示会让他去怀疑密码，方向全错。
    //   ⇒ 客户端先拦一道，说准原因。
    //   ⚠ 顺带省一次登录尝试额度：后端对同一邮箱 15 分钟只给 10 次，
    //     空提交也算一次的话，用户手快点几下就把自己的额度耗掉了。
    //   ⚠ 这里只做"空"的检查，不做邮箱格式校验 —— 格式对不对由后端说了算
    //     （前端自己判断格式，出错了会变成"我明明填对了它却不让提交"）。
    if(!accountValue('email').trim())throw Object.assign(new Error('还没填邮箱'),{code:'ACCOUNT_EMAIL_EMPTY'});
    if(!accountValue('password'))throw Object.assign(new Error('还没填密码'),{code:'ACCOUNT_PASSWORD_EMPTY'});
    if(!accountCaptchaAnswer().trim())throw Object.assign(new Error('还没填验证码'),{code:'ACCOUNT_CAPTCHA_EMPTY'});
    // ⚠ 先看有没有验证码再发请求：没取到就白跑一趟，还浪费一次登录尝试额度（同邮箱 15 分钟 10 次）。
    if(!accountCaptchaId)throw Object.assign(new Error('验证码还没取到，点一下图里的验证码换一张'),{code:'CAPTCHA_NOT_READY'});
    try{
      // ⭐ 2026-10-14：第五个参数 = 记住我（存的是登录凭证，不是密码，见 backend-client.js）
      await window.V7Backend.login(accountValue('email'),accountValue('password'),accountCaptchaId,accountCaptchaAnswer(),accountRememberWanted());
    }catch(err){
      // ⚠ 验证码是一次性的：失败后必须换一张，否则用户重试必然还是"验证码错误"。
      accountClearCaptchaInput();
      await accountRefreshCaptcha();
      throw err;
    }
    if(window.UI&&UI.toast)UI.toast('登录测试通过，平台账号已连接','ok',1800);
    // 登录成功后这张也作废了，换一张备用（用户可能马上要退出再登）
    accountClearCaptchaInput();accountRefreshCaptcha();
    // ⭐ 2026-10-14「记住我」：登录成功/失败都刷一下那行的状态文字
    //   （成功时它会变成"已记住 xxx@yyy，下次打开自动登录"）
    try{ accountRefreshRememberStatus(); }catch(_){}
  });
  // ⭐ 2026-10-14：「忘掉这台设备上的登录」——清掉本地凭证。
  //   ⚠ 跟"退出登录"的区别要写清楚，不然用户会以为点了没反应：
  //     退出登录 = 让【服务器】那张凭证作废（下次要重新输密码+验证码）
  //     忘掉设备 = 只清【本机】存的那份（服务器上那张还在别处有效）
  accountAction('[data-account-forget]',async()=>{
    if(!window.V7Backend||typeof V7Backend.forget!=='function')throw new Error('后端客户端不支持');
    V7Backend.forget();
    if(window.UI&&UI.toast)UI.toast('已清除本机保存的登录凭证，下次打开需要重新登录','ok',2600);
    try{ accountRefreshRememberStatus(); }catch(_){}
  });
  accountAction('[data-account-register]',async()=>{
    if(!window.V7Backend)throw new Error('后端客户端不可用');
    // ⚠⚠ 这里以前是 register(email, password, email) —— 第三个参数是 displayName，
    //   传 email 等于"昵称就是邮箱"；而且【完全没发验证码】。
    //   后端注册接口强制验码 ⇒ 以前点这个按钮必然失败（报"验证码错误或已过期"）。
    //   现在补上验证码，昵称按邮箱 @ 前面那段给个默认值（用户之后能在个人资料里改）。
    const email=accountValue('email');
    const 默认昵称=String(email||'').split('@')[0].slice(0,40);
    if(!accountCaptchaId)throw Object.assign(new Error('验证码还没取到，点一下图里的验证码换一张'),{code:'CAPTCHA_NOT_READY'});
    try{
      await window.V7Backend.register(email,accountValue('password'),默认昵称,accountCaptchaId,accountCaptchaAnswer());
    }catch(err){
      accountClearCaptchaInput();
      await accountRefreshCaptcha();
      throw err;
    }
    if(window.UI&&UI.toast)UI.toast('账号已注册并完成登录测试','ok',1800);
    accountClearCaptchaInput();accountRefreshCaptcha();
  });
  accountAction('[data-account-recovery]',async()=>{await V7CanvasWorkbench.browserVisible(false);V7AccountRecovery.open({email:accountValue('email'),onClose:()=>V7CanvasWorkbench.browserVisible(true)});});
  accountAction('[data-setup-open]',()=>V7Setup.open());
  accountAction('[data-account-logout]',async()=>{if(window.V7Backend)await window.V7Backend.logout();if(window.UI&&UI.toast)UI.toast('已退出平台账号','ok',1800);});
  accountAction('[data-account-points]',async()=>{if(!window.V7Backend||!window.V7Backend.state().signedIn)throw new Error('请先登录平台账号');const p=await window.V7Backend.points();if(window.UI&&UI.toast)UI.toast('通用积分 '+((p.balances&&p.balances.common)||0)+' · Banana 积分 '+((p.balances&&p.balances.banana)||0),'ok',3000);});
  accountAction('[data-rh-test]',async()=>{settingsReadFields(root);await V7Workflows.testRunningHub({url:settingsRuntime.runninghubUrl,key:settingsRuntime.runninghubKey});UI.toast('RH 连接测试通过；使用自己的 RH 余额','ok',2400);});
  accountAction('[data-rh-import]',async()=>{settingsReadFields(root);if(!settingsRuntime.rhWorkflowId)throw new Error('先填写 RH 工作流编号');const imported=await V7Workflows.importRunningHub({url:settingsRuntime.runninghubUrl,key:settingsRuntime.runninghubKey,workflowId:settingsRuntime.rhWorkflowId,name:settingsRuntime.rhWorkflowName});if(window.PRESETUI)PRESETUI.refreshListOnly();UI.toast('已保存到预设：'+imported.preset.title+(imported.needsInputMapping?'；多个图片入口需要作者补充映射':''),'ok',5000);});
  accountAction('[data-forge-comfy-refresh]',async()=>{if(!window.PRESETS||!PRESETS.refreshBuiltInComfyCatalog)throw new Error('内置 ComfyUI 目录接口不可用');const result=await PRESETS.refreshBuiltInComfyCatalog();if(window.PRESETUI)PRESETUI.refreshListOnly();UI.toast('Forge→ComfyUI 预设已检查：新增 '+Number(result.added||0)+' 条','ok',3200);});
  window.V7ProviderSettings?.mount(root);
  // ── 调色控件（2026-09-14）──
  // ⚠ 颜色要【拖着就变】，不能等松手 —— 选颜色是看着调的，
  //   松手才生效的话用户等于在盲选。所以除了 change 再挂一个 input。
  root.querySelectorAll('input[type="color"][data-setting]').forEach(el=>{
    el.addEventListener('input',()=>{
      el.removeAttribute('data-unset');
      const btn=root.querySelector('[data-color-reset="'+el.dataset.setting+'"]');
      if(btn) btn.disabled=false;
      settingsRuntime[el.dataset.setting]=el.value;
      applyThemeColors();            // 实时预览
    });
  });
  // 「默认」= 把这一项清空，回落到 tokens.css 里的原值
  root.querySelectorAll('[data-color-reset]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.preventDefault(); e.stopPropagation();
      const key=btn.dataset.colorReset;
      settingsRuntime[key]='';
      settingsSave();
      applyThemeColors();
      const el=root.querySelector('input[type="color"][data-setting="'+key+'"]');
      if(el) el.setAttribute('data-unset','1');
      btn.disabled=true;
    });
  });
  // ⭐ 2026-10-14：快捷键录入框 —— 现在有两个（开始计算 / 加参考图），
  //   改成对 [data-setting] 是快捷键类的通用处理，加第三个键不用再复制一段。
  //   ⚠ 改完必须调 shortcutApplyToMain()：只改 settingsRuntime 不重注册，
  //     用户会看到"录入框显示新键、但按下去没反应"（经典的能存不生效）。
  root.querySelectorAll('input[data-setting]').forEach(shortcut=>{
    if(!SHORTCUT_SETTING_KEYS.has(shortcut.dataset.setting))return;
    shortcut.addEventListener('keydown',e=>{
      if(['Control','Meta','Alt','Shift'].includes(e.key)) return;
      // ⭐ 2026-10-18 晚（用户：「用户可以清除快捷键，不用快捷键」）：单按退格 / Delete = 清掉这个快捷键
      if(!(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)&&(e.key==='Backspace'||e.key==='Delete')){
        e.preventDefault(); e.stopPropagation();
        settingsRuntime[shortcut.dataset.setting]='';
        shortcut.value='';
        settingsSave();
        shortcutApplyToMain();
        return;
      }
      if(!(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)) return;
      e.preventDefault(); e.stopPropagation();
      const value=eventShortcutValue(e);
      settingsRuntime[shortcut.dataset.setting]=value;
      shortcut.value=formatShortcutValue(value);
      settingsSave();
      shortcutApplyToMain();
    });
  });
  // ⭐ 遥测开关（2026-10-01）。用户要求"可以关闭"，所以这个开关必须真接线 ——
  //   能存不生效的开关比没有更坏（铁律：设置项要么真接线，要么别出现）。
  //   关掉 → 清空待发队列、停掉定时器、连 boot 事件都不发。
  root.querySelectorAll('[data-telemetry-toggle]').forEach(el=>el.addEventListener('change',e=>{
    const on=!!e.target.checked;
    try{
      if(window.V7Telemetry){
        V7Telemetry.setEnabled(on);
        if(!on) V7Telemetry.stop(); else V7Telemetry.start();
      }
    }catch(_){ }
    if(UI&&UI.toast)UI.toast(on?'已开启匿名使用与报错上报':'已关闭 —— 不会再发送任何数据',on?'ok':'warn',2600);
  }));
  // 报错分级调试：四个等级各弹一次，用来验证报错堆和 L4 冻结窗口。
  root.querySelectorAll('[data-error-test]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    const level=el.dataset.errorTest;
    if(level==='L1') UI.toast('L1 测试：这是一条会自己消失的胶囊提示','ok',2600);
    else if(level==='L2') UI.notice({title:'L2 测试 · 通知卡',body:'确认后消失。向右滑动可以看详细信息。',detail:'这里是 L2 的详细信息区，用来放错误原文或排查线索。',level:'info'});
    else if(level==='L3') UI.dialog({title:'L3 测试 · 需要你决定',body:'L3 同时给确认和取消两个选择。',detail:'这里是 L3 的详细信息区。',level:'warn',
      onConfirm:()=>aiAddLog('L3 测试：点了确定','info'), onCancel:()=>aiAddLog('L3 测试：点了取消','info')});
    else UI.block({title:'L4 测试 · 全屏冻结',body:'这是盖住整个显示器的独立冻结窗口。',
      detail:'只能点下面的按钮解除；Esc 和 Alt+F4 都被挡住。',action:'我知道了',
      onAction:()=>aiAddLog('L4 测试已解除','info')});
  }));
  // ⭐⭐ 2026-10-14（用户要求："在调试界面里面加一个添加虚假参考图的一个按钮"）
  //   用 canvas 现造几张测试图塞进参考图卡，省掉"先连 PS 抓选区 / 自己找图片文件"这一步。
  //
  //   ⚠ 每张的形状和颜色都不一样（方 / 横 / 竖 / 圆 / 小方），
  //     拖顺序时一眼就能看出有没有换对 —— 全都一样的话排序等于没验。
  //   ⚠ 走的是【正常那条路】：V7PresetReferences.append({imageBase64,mime,name})，
  //     也就是"用户自己加临时参考图"那个入口。不绕过闸门、不直接塞 store ——
  //     这样验的才是真实链路（上限 5 张、总量上限、缩略图生成全都照走）。
  //     实测确认过入参格式：preset-store.js 的 createReferenceAsset 认 imageBase64/base64/dataUrl/full。
  //   ⚠ 上限按卡片实际能显示的那个数（V7ReferenceLimits.REFS_MAX，默认 5），
  //     而 store 那边是 12 —— 不取小的话会加进去但卡片显示不下。
  function makeFakeReferenceImage(index){
    const SHAPES=[
      {w:512,h:512,label:'方'}, {w:768,h:512,label:'横'}, {w:512,h:768,label:'竖'},
      {w:640,h:640,label:'圆'}, {w:400,h:400,label:'小方'}
    ];
    const COLORS=[
      ['#ff5d5d','#8a1f1f'], ['#4ea1ff','#123a6b'], ['#41d18b','#12543a'],
      ['#ffc94d','#7a5410'], ['#b48cff','#3d2470']
    ];
    const s=SHAPES[index%SHAPES.length], c=COLORS[index%COLORS.length];
    const cv=document.createElement('canvas'); cv.width=s.w; cv.height=s.h;
    const g=cv.getContext('2d');
    const grad=g.createLinearGradient(0,0,s.w,s.h); grad.addColorStop(0,c[0]); grad.addColorStop(1,c[1]);
    g.fillStyle=grad; g.fillRect(0,0,s.w,s.h);
    // 中间的图形：圆那张画圆，其余画方框 —— 缩略图上一眼能区分
    g.strokeStyle='rgba(255,255,255,.9)'; g.lineWidth=Math.max(6,Math.round(Math.min(s.w,s.h)/28));
    const m=Math.round(Math.min(s.w,s.h)*0.18);
    if(s.label==='圆'){ g.beginPath(); g.arc(s.w/2,s.h/2,Math.min(s.w,s.h)/2-m,0,Math.PI*2); g.stroke(); }
    else { g.strokeRect(m,m,s.w-m*2,s.h-m*2); }
    // 序号：大字写在正中间（拖排序时用来认"第几张"）
    g.fillStyle='#fff'; g.textAlign='center'; g.textBaseline='middle';
    g.font='bold '+Math.round(Math.min(s.w,s.h)*0.34)+'px system-ui, sans-serif';
    g.fillText(String(index+1), s.w/2, s.h/2);
    g.font='bold '+Math.round(Math.min(s.w,s.h)*0.09)+'px system-ui, sans-serif';
    g.fillText(s.label+' '+s.w+'×'+s.h, s.w/2, s.h*0.5+Math.round(Math.min(s.w,s.h)*0.28));
    const dataUrl=cv.toDataURL('image/png');
    return {imageBase64:dataUrl.slice(dataUrl.indexOf(',')+1), mime:'image/png',
            name:'调试假图 '+(index+1)+' '+s.label};
  }
  async function addFakeReferenceImages(want){
    const refs=window.V7PresetReferences;
    if(!refs){ if(UI&&UI.toast)UI.toast('参考图模块没加载','warn',2600); return; }
    // ⚠ 现有几张要问 state()（唯一真相），别去数 DOM —— 卡片没图时是 hidden 的，数不到
    let have=0;
    try{ const st=refs.state(); have=(st.fixed?st.fixed.length:0)+(st.temporary?st.temporary.length:0); }catch(_){ }
    const cap=(window.V7ReferenceLimits&&window.V7ReferenceLimits.REFS_MAX)||5;
    const room=Math.max(0,cap-have);
    if(!room){ if(UI&&UI.toast)UI.toast('已经有 '+have+' 张了（上限 '+cap+'），先清一下再加','warn',3200); return; }
    const n=Math.min(Number(want)||1,room);
    const list=[]; for(let i=0;i<n;i++)list.push(makeFakeReferenceImage(have+i));
    try{
      await refs.append(list);
      if(UI&&UI.toast)UI.toast('加了 '+n+' 张假参考图'+(n<Number(want)?'（上限 '+cap+'，只加了这么多）':''),'ok',2600);
    }catch(error){
      // ⚠ 失败要说出来 —— 静默失败是这个项目最忌讳的形态（铁律 17）
      if(UI&&UI.toast)UI.toast('加假参考图失败：'+String(error&&error.message||error).slice(0,80),'warn',4000);
      if(window.ERR)ERR.report('PRESET_REFERENCE_FAILED',{message:'调试假图：'+String(error&&error.message||error)});
    }
  }
  root.querySelectorAll('[data-ref-fake]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    addFakeReferenceImages(Number(el.dataset.refFake)||1);
  }));
  root.querySelectorAll('[data-ref-fake-clear]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    try{
      // ⚠ 用 clearAll()（"这次一张都不带"）而不是 clear()（那个只清临时图）
      if(window.V7PresetReferences)window.V7PresetReferences.clearAll();
      if(UI&&UI.toast)UI.toast('参考图已清空','ok',2200);
    }catch(error){ if(UI&&UI.toast)UI.toast('清空失败：'+String(error&&error.message||error).slice(0,80),'warn',3600); }
  }));
  root.querySelectorAll('[data-perf-open]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    openPerfCard();
  }));
  // 重启软件(调试)。⚠ 正在跑的任务还没落盘，重启就没了 —— 有在跑的先问一句。
  root.querySelectorAll('[data-app-restart]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    if(!(window.uiwin&&window.uiwin.restart)){ UI.toast('当前环境不支持重启','warn',2600); return; }
    const running=taskList.filter(t=>t&&!aiTaskIsTerminal(t)).length;
    if(running>0){
      UI.dialog({title:'还有 '+running+' 个任务在跑',
        body:'正在跑的任务还没写进缓存，重启会丢掉（已完成的不受影响）。',
        level:'warn', confirm:'照样重启', cancel:'先等等', danger:true,
        onConfirm:()=>window.uiwin.restart()});
      return;
    }
    window.uiwin.restart();
  }));
  // 拖拽条要实时更新数字和填充(不然拖着不动、看不出调到哪了)
  bindNumControls(root);
  // 设置页一打开就检测引擎状态。⚠ 用缓存结果(不传 force)——
  // 每次翻设置都真探一次没必要，用户要最新的可以点"重新检测"。
  if(root.querySelector('[data-engine-box]')) refreshEngineBox(false);
  root.querySelectorAll('[data-settings-save]').forEach(el=>el.addEventListener('click',()=>{
    const wasDebug=isDebugOn();
    settingsReadFields(root);
    if(typeof UI!=='undefined'&&UI.toast)UI.toast('设置已保存','ok',1400);
    // ⚠ 调试模式刚打开时立刻报一次当前状态 —— 否则用户打开了开关，
    //   在下一次生成之前什么都看不到，会以为没生效。
    if(!wasDebug && isDebugOn()){
      setTimeout(()=>{
        const st=(window.MATCHENGINE&&MATCHENGINE.status&&MATCHENGINE.status())||{};
        dbg('调试模式','已开启 · 运行状态会实时弹在这里','ok');
        setTimeout(()=>dbg('环境','校色引擎'+(st.available?('在线 档'+st.tier+' · '+(st.device||'')):'未启用（用本机算法）')
          +' · 单次上限 '+AI_BATCH_MAX+' 张'),900);
      },200);
    }
  }));
  // ⚠ 2026-10-21：主题 / 面板位置搬进本机那份之后，「恢复默认」也要把它们清回出厂（原来跟账号存时就是一起恢复的）；
  //   快捷键、自由摆放开关照 10-19 的规矩不动。
  root.querySelectorAll('[data-settings-reset]').forEach(el=>el.addEventListener('click',()=>{try{localStorage.removeItem(settingsStorageKey());}catch(_){} try{const m=machineSettingsRead();if(m){THEME_MACHINE_KEYS.forEach(k=>{delete m[k];});localStorage.setItem(machineSettingsKey(),JSON.stringify(m));}}catch(_){} location.reload();}));
}
function openServiceWorkspace(section){return navigateCard('settings',0,{section:typeof section==='string'?section:'account'});}
// Existing controls and storage keys remain defined once; architecture only changes their grouping.
/* ⭐ 调试卡【自带】的标记（2026-10-01）。
   ⚠⚠ 为什么必须自带：这三段原来长在【设置 zone 3】里，调试卡靠 `source(3)` 去取
     （`from.querySelector('[data-perf-open]').closest('.settings-section')`）。
     用户定案"调试相关的直接挪到调试卡"之后，我把设置里那三段删了 ——
     调试卡立刻取到 null，报 `Cannot read properties of null (reading 'closest')`。
     所以搬家的正确姿势是【把标记也搬过去】，不是只删源头。
   ⚠ 里面的按钮靠 bindSettingsDetail 绑（bind(body) 会走到它），
     所以 data-error-test / data-perf-open / data-app-restart / data-browser-preferences
     这四个钩子名不能改。 */
function debugMarkup(){
  return '<div class="settings-section"><div class="settings-section-title">运行状态</div>'
      // ⚠⚠ 2026-10-01 真搬家：这一项原来在【设置卡 zone 1】，调试卡靠 `source(1)` 借过来。
      //   设置卡 zone 1 整段删掉之后必须搬过来 —— 调试开关本来就该归调试卡。
      //   ⚠ 标记必须写在这里（ui.html 里），不能写在 card-architecture.js 里合成：
      //     那边拿不到 settingsRuntime，勾选状态会永远是未勾选（"看得见但不对"）。
      +'<div class="settings-row full"><label class="ai-switch"><span>调试模式（把运行状态实时弹出来）</span>'
      +'<input type="checkbox" data-setting="debugMode"'+(settingsRuntime.debugMode===true?' checked':'')+'></label></div></div>'
    +'<div class="settings-section"><div class="settings-section-title">报错分级调试</div>'
    +'<div class="ai-actions" style="grid-template-columns:repeat(4,1fr)">'
      +'<button class="ai-btn" data-error-test="L1">L1 胶囊</button>'
      +'<button class="ai-btn" data-error-test="L2">L2 通知</button>'
      +'<button class="ai-btn" data-error-test="L3">L3 确认</button>'
      +'<button class="ai-btn danger" data-error-test="L4">L4 冻结</button>'
    +'</div><div class="settings-note">L1~L3 在报错堆里显示；L4 是盖住整个显示器的独立冻结窗口，只能点按钮解除。</div></div>'
    // ⭐⭐ 2026-10-14 新增（用户要求："在调试界面里面加一个添加虚假参考图的一个按钮"）。
    //   为什么需要它：参考图卡的拖拽排序 / 单张删除 / 点开看大图 / 右划菜单，
    //   全都要【先有参考图】才能试。而正常拿参考图要么连 Photoshop 抓选区、
    //   要么自己找图片文件 —— 调试和验收的时候很碍事。
    //   ⇒ 一键塞进几张现造的测试图，形状和颜色都不一样（方/横/竖/圆/小方），
    //     拖顺序时一眼能看出有没有换对（全都一样的话排序等于没验）。
    //   ⚠⚠ 这是【独立的一个 .settings-section】，不是塞在"报错分级调试"那一段里面。
    //     第一版我塞错了（挂在 .ai-actions 的收尾后面，其实已经在 section 外面了），
    //     而调试卡第 1 格是【挑着搬】的 —— 外面的段落不会出现在界面上。
    //     ⇒ 配套改了 card-architecture.js 的 zone===1：两段一起搬。
    +'<div class="settings-section"><div class="settings-section-title">参考图调试</div>'
      +'<div class="ai-actions">'
        +'<button class="ai-btn" data-ref-fake="2">加 2 张假参考图</button>'
        +'<button class="ai-btn" data-ref-fake="5">加满 5 张</button>'
        +'<button class="ai-btn danger" data-ref-fake-clear>清空全部参考图</button>'
      +'</div>'
      +'<div class="settings-note">给参考图卡造测试数据用的。每张的尺寸和颜色都不一样，方便看拖拽排序有没有换对。<br>'
      +'⚠ 加的是【这一次的临时参考图】，不会写进预设；关掉软件就没了。<br>'
      +'⚠ 上限跟正常用一样是 5 张，超了会被拦。</div>'
    +'</div>'
    +'<div class="settings-section"><div class="settings-section-title">开发调试</div>'
      +'<div class="settings-grid">'+settingControl('bridgePollMs','Photoshop 轮询间隔（毫秒）','number')+'</div>'
      +'<div class="settings-note">决定「鼠标划到缩略图 → Photoshop 里换显示」有多跟手。默认 180；调到 40 左右明显更快，代价是 Photoshop 里每秒多跑几次轮询。范围 20~2000，改完立刻生效、不用重载插件。</div>'
      +'<div class="ai-actions"><button class="ai-btn" data-perf-open>性能监视</button><button class="ai-btn danger" data-app-restart>重启软件</button></div>'
      +'<div class="settings-note">「性能监视」弹出一张卡，实时显示内存、CPU、GPU 占用和图片缓存大小（向右滑动看明细）。</div>'
      +'<div class="settings-note">用来验证「重启后任务还在」。已完成的任务会从缓存恢复；正在跑的任务会丢失。</div></div>'
    +'<div class="settings-section"><div class="settings-section-title">浏览器书签与任务锁</div><div class="settings-note">管理内置浏览器的本机书签。网页会话和 Cookie 保持独立；任务运行时不会被刷新或导航打断。</div><div class="ai-actions"><button class="ai-btn" data-browser-preferences>打开书签与任务锁</button></div></div>'
    // ⭐ 预览链追踪（2026-10-06）：任务卡右滑弹出的预览条/大框，到底是被谁收掉的。
    //   ⚠ 面板由 preview-trace.js 自己挂载（它拿到 [data-preview-trace] 就接管），
    //     所以这里【只出标记】，不写一行绑定代码 —— 免得两边各写一套。
    +'<div class="settings-section"><div class="settings-section-title">预览链追踪</div>'
      +'<div class="settings-note">记录「任务卡右滑弹出的预览条 / 上方大框」每一次被打开和被收掉的动作，'
      +'附调用栈和现场状态。用来查「滑一下弹出来又立刻没了」到底是谁干的。</div>'
      +'<div data-preview-trace></div></div>';
}
// ⭐ 生成与传回设置（2026-10-01 真搬家，docs/99 第一节）。
//   这些原来是【设置卡 zone 1】的内容，生成卡靠 `source(1)` 借过来渲染。
//   用户定案：设置里只放最纯粹的设置 —— "做什么事"的参数属于那张干事的卡。
//   ⚠⚠ 是【真搬家】，不是"点了跳到生成卡"（用户明确否掉了跳转那种做法）。
//   搬过来的 12 项 + 那几段说明（说明要跟着一起搬，不然用户在旧地方找不到解释）。
//   ⚠ 留在设置卡的只有两个：检查点（用户 2026-10-01 定）、缓存容量（属于存储）。
//   ⚠ debugMode 不在这里 —— 调试卡已经在管（见 debugMarkup）。
// ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：设置卡「传回」页的内容源。
//
//  ⚠ 为什么单独一个函数、而不是继续用 generationMarkup：
//    generationMarkup 那 12 项是【生成卡二级】的内容；
//    设置卡这一页只要「传回图层类型」一项（用户 10-08 定的搬家结果）。
//    两个页面共用一份标记的话，取控件时会互相抢（都按 data-setting 找）。
//  ⚠ 但控件的【写法】必须和别处一致（settingControl + data-setting）——
//    这样 bind() 那套绑定照样认得它。
function returnSettingsMarkup(){
  return '<div class="settings-section"><div class="settings-section-title">传回</div>'+
    '<div class="settings-grid">'+
    settingControl('layerType','传回图层类型','select',[['smartObject','智能对象'],['normal','普通图层']])+
    '</div>'+
    '<div class="ai-help">传回的图是贴成<b>智能对象</b>还是<b>普通图层</b>。<br>'+
    '智能对象能随时重新缩放、换内容而不损失画质；普通图层改起来更直接，但反复缩放会糊。<br>'+
    '⚠ 这一项一次定下就很少改，所以放在设置里，不占生成卡卡面的格子。</div></div>';
}

// ⭐ 2026-10-11：给「传回的组标注颜色」和三个音效位取选项。
//   ⚠ 值一律从 return-appearance.js 取 —— 那是唯一一份真相，
//     这里再抄一遍必然漂（改了一处忘了另一处）。
//   ⚠ 音效选项要【带上当前存的值】：用户要是手动往 assets/sfx-v6/ 里加过文件，
//     或者以后支持本地文件，存的值可能不在内置清单里 —— 不带上的话
//     select 会静默跳到第一项，用户一保存就把自己设的音效弄丢了。
//   ⚠⚠ 2026-10-11 修（我在真机上量出来的不一致）：
//     「任务成功」这一位【不能给"无"选项】。给的话，settingsRuntime 里
//     soundSuccess 是空串 ⇒ 下拉显示第一项「无」，但代码里 soundFor() 会
//     回落到 V6 默认的「三七唐笑」—— 界面上写"无"、实际会响。
//     这种"显示和实际不一样"正是铁律 16 说的假开关。
//     ⇒ 成功的选项 = 12 个内置音效（不带"无"），空值就默认选中「三七唐笑」。
//       V6 也是这样（成功那位没有"无"选项）。
//     ⚠ 失败那两位反过来：默认就是"无"，所以必须有「无」。
function returnAppearanceChoices(){
  const A=window.V7ReturnAppearance;
  return A?A.groupColorChoices():[['none','不给颜色']];
}
function soundChoices(slot){
  const A=window.V7ReturnAppearance;
  if(!A) return [['none','无']];
  const key='sound'+slot.charAt(0).toUpperCase()+slot.slice(1);
  const list=A.builtinSounds();
  // 空值 → 用 V6 的默认（成功=三七唐笑，另两位=none）。界面显示的值必须
  // 跟 soundFor() 实际会播的一致，否则就是假开关。
  const saved=String(settingsRuntime[key]||'')||A.DEFAULT_SOUNDS[slot]||'none';
  const out=[];
  const allowNone=(slot!=='success');        // 成功位不给「无」（见上面注释）
  if(allowNone) out.push(['none','无']);
  list.forEach(name=>out.push([name,name]));
  // 存的值不在清单里（用户自己加的 / 以后支持本地文件）⇒ 补一项，别把它吃掉
  if(saved&&saved!=='none'&&list.indexOf(saved)<0) out.push([saved,saved+'（自定义）']);
  return out;
}
function generationMarkup(){
  return '<div class="settings-section"><div class="settings-section-title">输出行为</div><div class="settings-grid">'
    +settingControl('layerType','传回图层类型','select',[['smartObject','智能对象'],['normal','普通图层']])
    +settingControl('captureMaxEdge','抓取分辨率（发给 AI 的图）','select',[['1024','1024 · 约 4MB'],['1536','1536 · 约 9MB'],['2048','2048 · 约 16MB（推荐）'],['3072','3072 · 约 36MB'],['4096','4096 · 约 64MB（多数服务会拒收）']])
    +settingControl('maxResolution','生成尺寸（AI 输出）','select',[['1K','1K'],['2K','2K'],['4K','4K']])
    +settingControl('autoReturn','自动传回','checkbox')
    +settingControl('autoFullCanvas','无选区时使用整张画布','checkbox')
    +settingControl('refSquarePad','带参考图时自动补成正方形','checkbox')
    +settingControl('autoGroup','自动编组','checkbox')
    // ⭐⭐ 2026-10-11（用户要求）：传回的组给 PS 标注色 + 完成音效。
    //   两个都照 V6 搬（组颜色 V6 写死黄色；音效 V6 有三个位）。
    //   ⚠ 颜色清单从 return-appearance.js 取，不在这里再抄一遍 ——
    //     抄两份必然漂（铁律 16 那种"以为改过了"的来源）。
    +settingControl('returnGroupColor','传回的组标注颜色','select',returnAppearanceChoices())
    +settingControl('soundEnabled','任务完成音效','checkbox')
    +settingControl('soundSuccess','音效 · 任务成功','select',soundChoices('success'))
    +settingControl('soundAllFail','音效 · 全部失败','select',soundChoices('allFail'))
    +settingControl('soundSingleFail','音效 · 单个失败','select',soundChoices('singleFail'))
    +settingControl('soundVolume','音效音量','number')
    +settingControl('soloSwitchDocument','联动时可切换文档','checkbox')
    // ⚠⚠ 2026-10-14（用户定）：原来这里还有一个
    //   settingControl('soloFocusRegion','联动时聚焦图层位置','checkbox')
    //   —— 【开关已删】。理由：用户说"缩放到指定位置"不该是开关，
    //   它应该融进缩略图机制本身 —— 现在【双击缩略图】就直接跳过去并缩放填满。
    //   ⚠ settingsRuntime.soloFocusRegion 这个【键保留】（见 ui.html 的 DEFAULT 定义）：
    //     老用户存档里可能有它，删键会让 write() 丢数据；而且双击走的就是它那条路径。
    //     实际行为：单击/划过 = 只 solo 显示；双击 = solo + 聚焦缩放（forceFocus）。
    +settingControl('autoDismissOnStamp','盖印后自动收起任务卡','checkbox')
    +settingControl('returnFeather','边缘羽化（消除选区边界的接缝）','checkbox')
    +settingControl('returnFeatherShrink','羽化 · 往里收','number')
    +settingControl('returnFeatherBlur','羽化 · 边缘模糊','number')
    +'</div>'
    +'<div class="settings-actions"><button class="settings-btn" data-forge-comfy-refresh>检查内置 Forge→ComfyUI 预设</button></div>'
    +'<div class="settings-note">音效说明（照 V6 搬）：算完传回时响一声，让你不用盯着屏幕。<br>'
    +'<b>任务成功</b>＝这一轮全都传回去了；<b>全部失败</b>＝一张都没成；<b>单个失败</b>＝有成的也有没成的。<br>'
    +'⚠ 默认<b>不启用</b>，要用得先把上面的开关打开。<br>'
    +'⚠ 内置的 12 个音效是从 V6 原样搬过来的；三个位置都能选「无」＝那一种情况不响。<br>'
    +'⚠ 「单个失败」连着来的时候只响一次（隔 2 秒），跟 V6 一样 —— 不然一波超时好几个失败会叠成一团。</div>'
    +'<div class="settings-note">⭐ <b>传回的组标注颜色</b>：V6 传回的组在 Photoshop 图层面板里永远是<b>黄色</b>标注；'
    +'这里可以换，也可以选「不给颜色」。<br>'
    +'⚠ 只能从 Photoshop 自己那 9 个固定色里挑 —— 这个颜色是 PS 写死的，插件改不了、也加不了自定义色（Adobe 至今没做）。<br>'
    +'⚠ 只对<b>新编的组</b>生效：已经传回去的旧组不会自动变色，你可以在 PS 里手动改。</div>'
    +'<div class="settings-note">开启「自动编组」后，传回的图会收进一个组；此时把鼠标移到任务预览里的某张缩略图，Photoshop 里就会只显示那一张（移开后停在最后看的那张）。<br>「联动时可切换文档」：划到属于别的文档的图时，是否自动切过去。关掉的话跨文档就什么都不做，不打断你当前的工作。</div>'
    +'<div class="settings-note">⭐ <b>盖印后自动收起任务卡</b>：你在传回组的上方盖印（Ctrl+Shift+Alt+E，或对着组按 Ctrl+Alt+E），'
    +'就表示这个任务你已经用完了 —— 那张任务卡会自动从任务栏收起，效果和你手点卡片右上角的 ✕ 一样，<b>硬盘上的图不会删</b>。<br>'
    +'⚠ 需要同时开着「自动编组」：没有组就没有判断的基准。<br>'
    +'⚠ <b>判断靠"位置 + 新出现"</b>：编组那一刻会记下当时同层有哪些图层，之后只有<b>新冒出来的、压在组上方的普通图层</b>才算盖印，'
    +'所以你原来就摆在那儿的图层不会被误判。但如果你在组上方<b>新建图层画别的东西</b>，仍然可能被当成盖印 —— '
    +'这个误判没法完全避免，觉得烦就关掉这个开关。<br>'
    +'⚠ 万一收错了：收起的任务都在<b>「历史→结果与任务」</b>里，点「恢复到任务栏」就回来了，硬盘上的图一直都在。</div>'
    +'<div class="settings-note">⭐ <b>边缘羽化</b>：AI 只改了选区里面，外面是原图 —— 两者在选区边界上会留下一条<b>笔直的接缝</b>。'
    +'羽化就是给贴回的图层加一张蒙版，把边界做成渐变，让它看不出来。<br>'
    +'⚠ 两个百分比都是<b>占选区短边</b>的：选区 1220×1736 → 短边 1220 → 「往里收 1%」= 12 像素。<br>'
    +'⚠ <b>这两个数没有实测依据，是估的起点</b> —— 接缝还看得见就往上调；'
    +'觉得 AI 的图被吃掉太多就把「往里收」调小。<br>'
    +'⚠ 细节补偿那一层<b>不用单独羽化</b>：它是剪切蒙版嵌在 AI 图层上的，自动跟着下面那层的蒙版走。</div></div>';
}
function legacySettingsMarkup(settingsZone){
  let html='<div class="settings-panel" data-settings-zone="'+settingsZone+'">';
    if(settingsZone===0){
      /* ═══════════════════════════════════════════════════════════════════
         「连接与账号」整页重排（2026-10-08，用户："完全重做"）

         用户原话（这一版的依据，别改回去）：
           ·"我填一个API key和URL，我找这个检查按钮我找特别久"
           ·"它们现在有很多占位也占的不是很明确"
           ·"行距、间距、字距也都很混乱"
           ·"右侧的这个导航栏和左侧的这个内容显示，这个不要动，这个是基础"

         ⚠ 重排的原则（按"你要干什么"排，不按"东西属于谁"排）：
           1. 先给【结论】，再给【设置】：一进页先看到"现在通不通、还有多少钱"，
              而不是先看到 6 个按钮。
           2. 【检查和它检查的东西放在一起】：Key 填完，紧跟着就是「检查连接」，
              中间不许夹别的字段（原来这个按钮在最底下，隔着 8 个别的输入框 —— 就是"找特别久"的原因）。
           3. 【填了才问】：选了自己的服务才显示地址，选了平台算力才显示积分说明。
              不填的一律不占版面（原来 4 个连接槽的字段全塞在一页里）。
           4. 每个输入框都【给例子】：不知道该填 https:// 还是域名，是这一步最常见的卡点。

         ⚠ 不许动的东西（改了就是静默失效）：
           data-setup-open / data-account-backup / data-community-open / data-account-center
           data-account-email / data-account-password / data-account-login|register|recovery|logout|points
           data-account-status-dot / data-account-status
           data-provider-connections / data-provider-connection-slot / data-provider-other-choice
           data-provider-catalog-host / data-provider-test / data-provider-test-cancel
           data-provider-test-status / data-provider-balance / data-provider-modelnote
           data-rh-test / data-rh-import
         ═══════════════════════════════════════════════════════════════════ */

      // ── ① 现在是什么情况（先给结论）──
      // ⚠ 这块只放"状态"，不放任何需要用户先动手的东西 —— 一进页就有信息可看。
      html+='<div class="settings-intro"><strong>账号与服务</strong>'
        +'平台算力要登录并用积分；你自己的第三方 API 可以单独用，不用登录。</div>'
        +'<div class="settings-section"><div class="settings-section-title">现在的情况</div>'
        +'<div class="settings-status"><i data-account-status-dot></i><span data-account-status>未登录：平台算力不可用</span></div>'
        // 余额框搬到【最上面】：它是"我还有多少钱"这个结论的一部分，
        // 原来埋在服务商那一段的最底下（要滚 800 多像素才看到）。
        +'<div class="provider-balance" data-provider-balance role="button" tabindex="0" data-state="unknown"><span class="pb-label">余额</span><span class="pb-value pb-dim">尚未检查 —— 地址暂时不知道可不可用，点下面的「检查连接」看一眼</span></div>'
        +'<div class="settings-note provider-modelnote" data-provider-modelnote hidden role="status"></div>'
        // ── ⭐⭐「平台账号（登录）」：2026-10-09 用户定，放在整页最顶端 ──
        //   用户原话：「你新加回来的这个登录框，它不能折叠啊，你把它提到这个整个界面最顶端，
        //             就是我们的这个设置界面最顶端，方便我们去登录。」
        //   ⚠⚠ 为什么放在【这一节里】而不是自己单独一节：
        //     这一节①排第一、②是点「账号设置」进来时路由聚焦的那节
        //     （card-architecture.js 的 routeOptions()?.section||'account'）、③本来就能折叠。
        //     所以放在这里 = 顺序、默认展开、点进来聚焦，三件事自动一致。
        //     （试过单独一节：折叠是"同屏只开一个"，两个都想默认开做不到；
        //       而且 focusSection 会展开 account 那节、顺手把我的默认展开挤掉。）
        +'<div class="settings-section-title settings-subtitle">平台账号（登录）</div>'
        +'<div class="settings-grid">'
        +settingControl('backendUrl','V7 后端地址','url',[],{placeholder:'https://www.xiasanqi.com'})
        +'<label class="settings-field"><span>账号邮箱</span><input type="email" data-account-email autocomplete="username" placeholder="登录邮箱"></label>'
        +'<label class="settings-field"><span>账号密码</span><input type="password" data-account-password autocomplete="current-password" placeholder="只用于本次登录"></label>'
        // ⭐⭐ 2026-10-09（用户定）：「登录咋没有验证码呢？…你好歹去个手动验证码吧？
        //   手工输入的验证码登录的时候吧？」
        //   ⇒ 登录、注册都要填图形验证码（后端 captcha.py 自绘 SVG，不依赖境外服务）。
        //   ⚠ 验证码是【一次性】的：不管对错用掉就作废 ⇒ 每次失败后必须点图换一张，
        //     不能拿旧图重试。下面 accountRefreshCaptcha 负责这件事。
        //   ⚠ 图放在 data-account-captcha-img 里（SVG 由 JS 填，不是 img src）。
        +'<label class="settings-field"><span>验证码</span><input type="text" data-account-captcha autocomplete="off" maxlength="8" placeholder="输入下面图里的字符"></label>'
        +'<div class="settings-field settings-captcha"><span>图里是什么</span>'
        +'<button type="button" class="settings-captcha-img" data-account-captcha-img title="看不清？点一下换一张" aria-label="点一下换一张验证码"></button>'
        +'</div>'
        +'</div>'
        +'<div class="settings-actions">'
        +'<button class="settings-btn settings-btn-primary" data-account-login>登录并验证</button>'
        +'<button class="settings-btn" data-account-register>注册账号</button>'
        +'<button class="settings-btn" data-account-logout>退出登录</button>'
        +'<button class="settings-btn" data-account-points>刷新积分</button>'
        +'</div>'
        // ⭐⭐ 2026-10-14（用户要求：「登录账号的地方要加一个保存账号和密码以及自动登录」）
        //   ⚠⚠ 我把「保存密码」改成了「保存登录凭证」——这是【问过用户他选的方案 A】：
        //     存密码 = 密码能被人解出来，而人往往多平台复用同一个密码；
        //     存凭证 = 只泄漏这张票据，而且改密码就能立刻作废。
        //     功能上"下次打开自动登录"一样拿到（凭证 30 天有效）。
        //   ⚠ 界面上的字必须【说实话】：写"记住我"但实际存密码，那是骗人（铁律 15）。
        //     所以下面明写"只存登录凭证，不存密码"，还要给出"怎么取消"。
        +'<div class="settings-row full" data-remember-row>'
        +'<label class="ai-switch"><span>记住我（下次打开自动登录）</span>'
        +'<input type="checkbox" data-account-remember></label>'
        +'</div>'
        +'<div class="settings-note" data-remember-note>'
        +'只保存【登录凭证】，<b>不保存密码</b>：凭证 30 天后失效，改密码也会立刻让它作废。'
        +'取消勾选后再点一次登录即可清除。想立刻清掉就点下面的按钮。'
        +'</div>'
        +'<div class="settings-actions">'
        +'<button class="settings-btn" data-account-forget>忘掉这台设备上的登录</button>'
        +'<span class="settings-note" data-account-remember-status role="status"></span>'
        +'</div>'
        +'<div class="settings-note">同一账号同一时间只保留一个设备会话。自己的第三方 API 不需要登录也能用。</div>'
        +'</div>'

      // ── ② 你在用哪家（填地址和 Key + 紧跟着检查）──
      // ⚠⚠ 这一段的顺序是这次重排的核心：选服务商 → 填地址 → 填 Key → 【检查连接】。
      //   检查按钮【必须】紧跟 Key，不许再往下夹 ComfyUI / RH 那些别的字段。
      //   ⭐⭐ 2026-10-09（用户定）：「在设置界面填 key 的时候分别有 阿吉 墨墨 GRS 和用户自定义；
      //     如果用户选择了 GRS，就可以选择走我的 key 或者走 GRS 官方的 key」
      //     ⇒ 一级下拉从 3 项变成 4 项，把 GRS 提上来（原来是藏在「Others」里的二级选择）。
      //   ⚠ 存储格式【没变】：选 GRS 仍然是 provider='other' + otherConnection='grs'。
      //     这样改的好处：下游（connection()/runtimePatch/grsUsesProxy/aiAttachGrsKey）
      //     一个字段都不用动，也不会让老用户的存档失效。
      //   ⚠ 对应地，一级下拉里那个「Others · 其他」的 selected 要靠 otherConnection 反推 ——
      //     见下面 data-provider-other-choice 的 hidden 逻辑（选了 GRS 时它是收起的）。
        +'<div class="settings-section"><div class="settings-section-title">你在用哪家生图</div><div class="settings-grid">';
      // 2026-10-21：渠道改过名的，这里显示「起的名（原名）」（computeSlotLabel，算力槽位）
      html+=settingControl('provider','算图服务商','select',[['aji',computeSlotLabel('aji')],['momo',computeSlotLabel('momo')],['grs',computeSlotLabel('grs')],['other',computeSlotLabel('other')]],{});
      html+='<div data-provider-other-choice hidden>'+settingControl('otherConnection','Others 里的哪一种','select',[['custom','原自定义连接'],['grs','旧 GRS 连接']])+'</div></div>';
      html+='<div data-provider-connections>';
      // ⚠ 占位提示逐条给的是【真实形状】（阿吉/默默是 https:// 开头的中转地址，Key 是 sk- 开头）。
      //   给例子比写"请输入地址"有用 —— 用户卡的往往就是"要不要带 https://"。
      for(const [slot,label,urlPh,keyPh] of [
          ['aji','AJI · 阿吉','https://ai.ajiai.top','sk- 开头的一串'],
          ['momo','MOMO · 墨墨','https://api.momoapi.icu','sk- 开头的一串'],
          ['other','自定义','https://你的中转站地址','该站给你的 Key'],
          ['grs','Others · 旧 GRS','留空 = 用国内直连','自带 Key 才填']])
        html+='<div class="settings-grid" data-provider-connection-slot="'+slot+'" hidden>'
          // ⭐ 2026-10-21：自定义渠道存多套方案（下拉切换 / 改名 / 另存 / 删除）—— 内容由 otherProfilesPaint() 画
          +(slot==='other'?'<div class="settings-field wide other-profiles" data-other-profiles></div>':'')
          // ⭐ 2026-10-24（V7待办/02，用户定「默认竞速」）：阿吉 / 墨墨默认自动选线 —— 这一行显示选中哪条、多快、余额、几条通过；
          //   自动时下面的地址框藏起来，改成「手动填」才露出来（内容由 10-settings-runtime.js providerLinesPaint 画）
          +((slot==='aji'||slot==='momo')?'<div class="settings-field wide provider-line" data-provider-line="'+slot+'">'
            +'<div class="settings-note" data-provider-line-status role="status">自动选线</div>'
            +'<div class="settings-actions settings-actions-inline"><button type="button" class="settings-btn" data-provider-line-race>重新测速</button>'
            +'<button type="button" class="settings-btn" data-provider-line-mode>改成手动填地址</button></div></div>':'')
          +settingControl(slot+'Url',label+' 地址','url',[],{placeholder:urlPh})
          +settingControl(slot+'Key',label+' Key','password',[],{placeholder:keyPh})
          +settingControl(slot+'Protocol','图像协议','select',[['gemini','Gemini Image'],['openai','GPT Image / OpenAI']])
          +settingControl(slot+'AuthMode','鉴权方式','select',[['bearer','Bearer（中转常用）'],['query','Query key'],['x-goog-api-key','Gemini 原生 API Key']])
          +(slot==='grs'?settingControl('grsMode','GRS 用哪把 Key','select',[['proxy','走平台额度（平台统一充值，扣香蕉积分）'],['byok','走 GRS 官方 Key（我自己的，不扣积分）']],{help:'平台额度 = 用夏三七在 GRS 开的批发池，按香蕉积分扣；官方 Key = 你自己在 GRS 开的 Key，花你自己的钱、不扣平台积分。' })
            // ⭐⭐ 2026-10-09（用户定）：「直接显示"平台额度余 XXX"」
            //   ⇒ 走平台额度时，把香蕉积分余额直接摆在这一槽里，不用去别处找。
            //   ⚠ 只在【走平台额度】时显示：走官方 Key 花的是用户自己的钱，
            //     给他看平台的额度余额只会让人误以为要扣（那是误导）。
            //   ⚠ 数据来源：/v1/points 的 balances.banana（跟「积分与账单」页同一个源）。
            //     没登录 / 没取到 → 显示原因，不显示假数字。
            +'<div class="settings-note settings-grs-quota" data-grs-quota role="status">平台额度：登录后显示</div>'
            :'')
          +'</div>';
      html+='</div>'
        // ⚠ 检查按钮 + 状态行 + 说明，四个东西连在一起，不夹任何字段。
        +'<div class="settings-actions settings-actions-inline"><button class="settings-btn settings-btn-primary" data-provider-test>检查连接</button><button class="settings-btn" data-provider-test-cancel hidden>取消</button></div>'
        +'<div class="settings-note" data-provider-test-status role="status">还没检查过 —— 填完上面的地址和 Key，点「检查连接」。</div>'
        +'<div class="settings-note">检查会做两件事：① 拉一次这个地址的模型列表（用来填生成卡的模型下拉框）② 查一次余额。'
        +'<b>模型列表正常不代表生图已验证</b>，也不会发任何生成请求。</div>'
        // 别人的报价当参考放在这里（原来它挂在"服务商与连接"段末尾，跟设置项混在一起）
        +'<div data-provider-catalog-host></div>'
        +'</div>'

      // ── ③ 算力怎么分工（填了才问）──
      // ⚠ 用户选了"平台 Banana"才提积分；选了"自己的服务"才提地址和 Key。
        +'<div class="settings-section"><div class="settings-section-title">生图算力分工</div><div class="settings-grid">'
      html+=settingControl('imageComputeSource','图像算力来源','select',[['own','自己的服务 / API Key'],['platform','平台 Banana 算力（要登录 · 扣积分）']])
        +settingControl('workflowSource','工作流算力来源','select',[['local','自己的本地 ComfyUI'],['own',window.V7_RUNNINGHUB_OFF?'自己的在线服务（RunningHub · 暂未接通）':'自己的在线服务 / Key'],['platform','平台云算力（要登录 · 扣积分）']])
        // ⭐ 2026-10-15 千问模式（剪影预设里的开关）在哪算：默认云端；也能用自己电脑上的 ComfyUI（要装 V7 映射节点和千问 2.1 模型）
        +settingControl('qwenSource','开源模型模式在哪算','select',[['platform','平台云端（要登录 · 现在免费）'],['local','自己电脑上的 ComfyUI']])
        +settingControl('comfyUrl','ComfyUI 地址','url',[],{placeholder:'http://127.0.0.1:8188'})
        +settingControl('comfyKey','ComfyUI Key（可选）','password',[],{placeholder:'一般不用填'})
        +'</div>'
        +'<div class="settings-note">ComfyUI 跑在你自己的电脑上，默认地址就是 <b>http://127.0.0.1:8188</b>，没设密码就留空。</div>'
        // ⭐ 2026-10-24 晚（V7待办/16，用户：同步放社区，设置卡原来那个按钮挪过去）：这里只留一句说明 + 跳过去的按钮
        +'<div class="ai-actions"><button class="ai-btn" data-go-community-cloud>去社区卡同步云端预设</button></div>'
        +'<div class="settings-note">云端预设的同步挪到了「社区」卡：登录后自动同步，后台下发的半小时内也会到；你改过的不覆盖，删掉的不再回来。</div></div>'

      // ── ④ 钱花到哪儿为止（提醒线，跟余额挨着）──
        +'<div class="settings-section"><div class="settings-section-title">余额警告线</div><div class="settings-grid">'
      // ⚠ 2026-10-07 新增（用户定："余额不足要提前提醒也可以，就是设置一个余额少于多少开始在弹窗里面弹一下"）：
      //   单位是【美元】；填 0 或不填 = 不提醒。只在"跌破这条线"的那一下提醒一次。
      html+=settingControl('lowBalanceUSD','低于这个数就提醒我（元；0 = 不提醒）','number')
        +'</div><div class="settings-note">只对阿吉和墨墨这种"充值到中转站的钱"生效。旧 GRS 的积分不按这个算。</div></div>'

      // ── ⑤ 自己的在线服务与工作流（RH，中频）──
      // ⚠⚠ data-rh-test / data-rh-import 两个按钮【必须有】—— ui.html:13364 的 accountAction 在
      //   document 上找它们，找不到就静默不绑（我重排时差点把这一整段弄丢过一次）。
        +'<div class="settings-section"><div class="settings-section-title">自己的在线服务与工作流</div><div class="settings-grid">'
        +settingControl('runninghubUrl','RunningHub 地址','url',[],{placeholder:'https://www.runninghub.cn'})
        +settingControl('runninghubKey','RunningHub Key','password',[],{placeholder:'RH 后台给你的 Key'})
        +settingControl('rhWorkflowId','RH 工作流编号','text',[],{placeholder:'作品链接末尾那串数字'})
        +settingControl('rhWorkflowName','存成预设时叫它什么','text',[],{placeholder:'留空就用「RH 工作流 + 编号」'})
        +'</div><div class="settings-actions">'
        +'<button class="settings-btn" data-rh-test>测试 RH 连接</button>'
        +'<button class="settings-btn" data-rh-import>从 RH 读取并存为预设</button>'
        +'</div><div class="settings-note">这是"工作流走你自己 RunningHub 账号"时才要填的。'
        +'编号在作品链接末尾；存成预设的名字就是它在预设列表里显示的名字。</div></div>'

      // ── ⑥ 平台账号（⭐⭐ 2026-10-09 用户定：登录框提到最上面 + 要能折叠）──
      //   用户原话：「你新加回来的这个登录框，它不能折叠啊，你把它提到这个整个界面最顶端，
      //             就是我们的这个设置界面最顶端，方便我们去登录。」
      //
      //   ⚠⚠ 为什么这节的【内容】现在住在 ①「现在的情况」那一节里（见上面 data-sec-anchor="account"）：
      //     试过"把这节排到最上 + 给它自己一个锚点 + 默认展开"，实测【不成立】，原因有两个：
      //       ① 折叠是"同屏只开一个"（closeFolds）—— 两个都想默认开是做不到的；
      //       ② 点「账号设置」进来时，路由给的 section 默认是 'account'
      //          （card-architecture.js 的 routeOptions()?.section||'account'），
      //          focusSection 会把「现在的情况」展开，顺手把我设的默认展开挤掉。
      //     ⇒ 干脆让【排序第一的那一节】和【路由聚焦的那一节】和【登录框所在的那一节】
      //       变成同一节：顺序、默认展开、点进来聚焦，三件事自动一致，不用再跟折叠规矩打架。
      //   ⚠ 原来那 6 个服务入口按钮（data-setup-open / data-account-backup / …）留在这一节，
      //     card-architecture.js 会把这一节的 .settings-actions 整排隐掉（入口在「更多服务」网格里）。
        +'<div class="settings-section" data-sec-anchor="platformAccountLegacy"><div class="settings-section-title">服务入口</div>'
        +'<div class="settings-actions">'
        +'<button class="settings-btn" data-account-recovery>忘记密码</button>'
        +'</div></div>'

      // ── ⑥ 服务入口（8 个按钮，收成折叠，不占首屏）──
        +'<div class="settings-section"><div class="settings-section-title">服务与工具</div>'
        +'<div class="settings-actions">'
        +'<button class="settings-btn" data-setup-open>开始设置 / 修复 Photoshop</button>'
        +'<button class="settings-btn" data-account-backup>账号云备份</button>'
        // ⚠⚠ 2026-10-10 审查时改名：这个按钮【只是跳到社区设置页】，不是"打开社区网页"那个。
        //   原来它和 card-architecture.js 里真正的社区按钮【共用 data-community-open】
        //   ⇒ 那边用 querySelector('[data-community-open]') 抓到的是【这一个】，
        //     于是"禁用/改文字"全改到了这个导航按钮上，真正那个按钮一直停在
        //     "可点但点了没反应"的状态（铁律 17 的静默失效）。
        //   实测现场：说明写着「社区网页还没配置」，按钮却是可点的。
        //   ⚠ 教训：同一个 data-* 属性名不要用在两个用途不同的元素上。
        +'<button class="settings-btn" data-community-nav>社区</button>'
        +'<button class="settings-btn" data-account-center="billing">账单与兑换</button>'
        +'<button class="settings-btn" data-account-center="support">我的客服记录</button>'
        +'<button class="settings-btn" data-account-center="service">公告与服务状态</button>'
        +'</div>'
        +'<div class="settings-note">旧 GRS 换到 Others 里了，它的地址和 Key 跟自定义连接分开保存，互不影响。</div></div>';
    }else if(settingsZone===1){
      // ⭐⭐ 2026-10-01【真搬家】。这里原来是「生成与传回」整段（12 个生成/传回项 + 说明）。
      //   用户定案：设置卡里只放【最纯粹的设置】——
      //   "做什么事"的参数属于那张干事的卡，不属于设置卡。
      //   → 那 12 项已经搬到【生成卡】（见 ui.html 的 generationMarkup()），
      //     debugMode 搬到【调试卡】（见 debugMarkup()）。
      //   ⚠ 是【真搬家】，不是"点一下跳到生成卡"——用户明确否掉了跳转那种做法。
      //   ⚠ 搬走之后这里【不能留同一批开关】：两张卡都放，用户不知道改的是哪个。
      // ── 只留下这两样（用户 2026-10-01 定）──
      //   · 检查点：用户说"检查点留在设置卡"
      //   · 缓存容量：属于存储，不是生成参数
      html+='<div class="settings-intro"><strong>存储与检查点</strong>这两项留在这里 —— 检查点是安全网，缓存容量属于存储。'
        +'<br>生成和传回那些选项已经搬到<b>生成卡</b>（在生成卡第 4 格），调试开关搬到了<b>调试卡</b>。</div>'
        +'<div class="settings-section"><div class="settings-section-title">检查点</div><div class="settings-grid">'
        +settingControl('checkpointEnabled','自动检查点（完整画布 PNG）','checkbox')
        +settingControl('checkpointIntervalMin','检查点间隔（分钟）','number')
        +settingControl('cacheCapacityGB','缓存容量上限（当前账号，GB）','number')
        +'</div>'
        +'<div class="settings-note" data-setting-help="checkpoint">「自动检查点」默认关闭。开启后每张照片独立计时，间隔够久的下一次生成前保存完整画布 PNG；不含图层，不会自动恢复。间隔可调（1–60 分钟，默认 5）。可在「记录与恢复」卡里打开保存文件夹。大画布可能增加等待时间和磁盘占用。</div>'
        +'<div class="settings-note">缓存是每次生成留下的图，攒够上限之后最旧的会先被清掉。占的是当前账号自己的额度。</div></div>';
    }else if(settingsZone===2){
      // ⚠ 只列真正生效的(settingsApplyAppearance 只消费 blur/opacity/bgQuality)。
      //   移除的项: simpleMode / flipEnabled / soundEnabled / emojiStyle / iconScale
      //             / themeColor / tileColorOpacity / textMode —— 见 docs/22。
      //   ⚠ 「界面缩放」2026-09-11 删除: 它只写 --ui-scale 而没有任何 CSS 读它，
      //     是个假开关(铁律 15)。要真做得走浏览器级缩放(两壳各自的 zoom API)——
      //     用 CSS transform 会把 14 个 position:fixed 元素全搞错位。
      html+='<div class="settings-intro"><strong>外观与交互</strong>调整配色、透明度、毛玻璃和卡片摆放方式。</div>'
        +'<div class="settings-section"><div class="settings-section-title">配色</div><div class="settings-grid">'
        +settingControl('themeCardBg','卡片底色','color')
        +settingControl('themeText','文字颜色','color')
        +settingControl('themeAccent','主题色','color')
        +settingControl('themeAutoContrast','底色浅时自动用深色文字','checkbox')
        +'</div><div class="settings-note" data-setting-help="theme">这三个颜色<b>一次改全部卡片</b>，改完立刻生效。点「默认」退回原本的配色。<br>'
        +'⚠ <b>卡片底色</b>只改色调，透不透明还是由下面的「界面不透明度」管 —— 因为卡片底下压着你自己设的背景图，做成不透明会把图整个盖掉。<br>'
        +'⚠ <b>主题色</b>是按钮、滑条、进度条这些的颜色。卡片边缘那几道光<b>不受它影响</b>，那个是从背景图自动取色的。<br>'
        +'⚠ 开着<b>自动深色文字</b>时，你选了浅色底就会自动翻成黑字；一旦你自己指定了文字颜色，就听你的、不再自动翻。</div></div>'
        +'<div class="settings-section"><div class="settings-section-title">界面</div><div class="settings-grid">'+settingControl('blur','毛玻璃强度','number')+settingControl('opacity','界面不透明度（%）','number')+settingControl('bgQuality','主题背景清晰度','select',[['1','X1 省内存'],['2','X2 标准'],['4','X4 高清']])+settingControl('reduceMotion','减少动画','checkbox')+'</div><div class="settings-note" data-setting-help="bgQuality">清晰度只影响之后导入的主题图；已经导入的不会自动重压。X4 在高分屏上最清晰，也最占内存。</div><div class="settings-actions"><button type="button" class="settings-btn" data-layout-open aria-label="打开布局与恢复">布局与恢复</button></div><div class="settings-note">布局与恢复现在从这里打开；设置卡会始终保留，避免隐藏其他核心卡后失去恢复入口。</div><div class="settings-row full">'+switchControl('自由摆放模式','data-setting="freeMode"',settingsRuntime.freeMode===true,'将每张一级主卡、整叠任务卡和整叠报错卡作为独立单元摆放；二三级面板仍跟随所属主卡。退出快捷键：Ctrl+Alt+Shift+F12。')+'</div><div class="settings-note" data-setting-help="freeMode">开启后只在当前显示器工作区域内摆放。空任务堆与报错堆会显示可拖动占位，真实卡片出现后接管原位置。</div></div><div class="settings-section"><div class="settings-section-title">交互手感</div><div class="settings-grid">'+settingControl('presetFlipNotches','预设列表翻页所需滚动格数','number')+settingControl('hoverOpensPreview','鼠标移到缩略图上自动弹出大预览框','checkbox')+settingControl('topmostFollowPs','只在用 Photoshop 时置顶（切到别的软件就退到后面）','checkbox')+'</div><div class="settings-note">在预设卡的列表里滚到头之后，要在约半秒内【连着滚够这么多格】才会翻到下一张主卡，边缘的光会显示攒了多少。数字越大越不容易误触。默认 10，范围 2~30。</div></div><div class="settings-section"><div class="settings-section-title">快捷键</div><div class="settings-grid">'+settingControl('generationShortcut','开始计算快捷键','text')+settingControl('referenceShortcut','加参考图快捷键','text')+settingControl('collapseShortcut','一键收起 / 展开快捷键','text')+settingControl('providerShortcut','换下一家渠道快捷键','text')+'</div><div class="settings-note">默认都没有快捷键，设了才生效。点击输入框后按下组合键即可录入，例如 Ctrl/Cmd+Enter；单按退格键清除，不用这个快捷键。加参考图会抓 Photoshop 当前选区加进参考图。</div></div>';
    }else{
      // ⚠ 余额追踪、改进计划、设备标识、教程调试全是占位，已移除(见 docs/22)。
      //   这一页目前只剩真能用的调试入口。
      html+='<div class="settings-intro"><strong>数据与隐私</strong>连接助手，管理 Agent 访问范围和软件恢复节点。</div>'+
        // ⭐ 遥测开关（2026-10-01）。用户明确要求：可以关。
        //   ⚠ 这个开关不写在 settingsRuntime 里 —— 它存在自己的键
        //   (v7.telemetry.enabled.v1)，因为 telemetry.js 可能在设置面板之前启动。
        //   所以用普通 checkbox + 自己的绑定，不走 settingControl。
        '<div class="settings-section"><div class="settings-section-title">匿名反馈</div>'+
        '<div class="settings-row full"><label class="ai-switch"><span>发送匿名使用与报错信息</span>'+
        '<input type="checkbox" data-telemetry-toggle '+((window.V7Telemetry?V7Telemetry.enabled():true)?'checked':'')+'></label></div>'+
        '<div class="settings-note">用来知道你在哪一步遇到问题、哪个功能真被用，好让我们把它修好。<br>'+
        '<b>绝不上传</b>：提示词和文案、文件名和路径、图片内容、任何 Key 或密码、邮箱和手机、设备型号全名、精确位置。<br>'+
        '报错消息里的中文和路径会在<b>你的电脑上先被抹掉</b>，再发出去；完整原文只留在本机。<br>'+
        '想给客服看完整报错时，可以在报错卡里手动附带。关掉这个开关后，连启动事件都不会发送。</div></div>'+
        (window.V7AssistantPanel?V7AssistantPanel.markup():'')+
        (window.V7ProjectSchedule?V7ProjectSchedule.markup():'')+
        // ⚠⚠ 2026-10-01 用户定案：设置里【只放最纯粹的设置】。
        //   这三段原样搬去「调试卡」了 —— 报错分级调试 / 开发调试（轮询间隔、性能监视、
        //   重启软件）/ 浏览器书签与任务锁。调试卡那边：
        //     · 报错分级（L1~L4）→ 已有（debug zone 1）
        //     · bridgePollMs、性能监视 → 已有（debug zone 0）
        //     · 「重启软件」按钮、【书签与任务锁】入口 → ⚠ 调试卡目前【还没有】，列进待办
        //       （docs/99_设置卡搬家待办_20261001.md）
        //   ⚠ 别在这里再留一份：两张卡都放同一批开关，用户不知道改的是哪个。
        '<div data-cache-settings></div>'+
        '<div class="settings-actions"><button class="settings-btn" data-settings-save>保存设置</button><button class="settings-btn danger" data-settings-reset>恢复默认</button></div><div class="settings-note">清除缓存和开发者入口将在高级设置阶段开放。</div>';
    }

  return html+'</div>';
}
function fillSettingsDetail(animate,dir,workspaceBody){
  const settingsZone=workspaceBody?0:zoneSel;
  const body=workspaceBody||document.getElementById('dcBody');
  if(!body)return;
  if(!workspaceBody&&!animate&&settingsPanelForZone(settingsZone))return;
  const render=()=>{
    if(!workspaceBody)detail.querySelector('.dc-name').textContent=SETTINGS_ZONE_SET[settingsZone][1];
    // ⭐ 2026-10-06 卡片拆分：改走总管理员（带回落）。
    if(window.V7CardManager&&typeof V7CardManager.mount==='function')V7CardManager.mount('settings',body,settingsZone);
    else window.V7CardArchitecture.settings(body,settingsZone);
  };
  if(workspaceBody)render();else specialDetailFill(render,animate,dir);
}
