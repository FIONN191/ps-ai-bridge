// ═══ ui-main/19-detail-zones.js —— 主界面主程序第 19 / 21 段 ═══
//   管什么：三级详情卡 · 预设卡二级 · 打开三级 · 收回光 · 关二级 / 关全部
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ── 三级详情卡: 内容随 当前主卡 + 选中分区 变化(占位数据, 用于观察效果) ──
// 每个分区一套参数, 让切换时能明显看出三级也在联动
// ═══════════════════════════════════════════════════════════
//  弹窗系统 API (四级, 按打断程度递增)
//    UI.toast(msg, level)              L1 零打断, 自动消失
//    UI.banner(el, msg, level, opts)   L2 低打断, 卡内横条
//    UI.dialog({...})                  L3 中打断, 遮面板, 必须选
//    UI.block({...})                   L4 最高, 全屏冻结, 无关闭
//  ⚠ level: 'ok' | 'info' | 'warn' | 'err'  (语义色, 不跟背景图变)
// ═══════════════════════════════════════════════════════════
// 报错卡的语义图标 —— 值是【图标名】，交给 ICON.render 画。
const SEM_ICO  = { ok:'check', info:'info', warn:'warning', err:'close' };
// 同一批语义的【纯字符】版本。给拿不到图标库的地方用（L4 独立窗口）。
// ⚠ 两张表要一一对应，加语义时两边一起加。
const SEM_CHAR = { ok:'✓',     info:'ℹ',    warn:'⚠',      err:'✕'     };
const ERROR_LEVELS = ['L1','L2','L3','L4'];
let blockingCount=0;
function resolveErrorSeverity(o){
  const requested=String(o && o.severity || '').toUpperCase();
  if(ERROR_LEVELS.includes(requested)) return requested;
  if(o && o.blocking) return 'L4';
  if(o && o.confirm===false) return 'L1';
  // 旧调用方没有 severity 时按现有行为默认为 L2。
  return 'L2';
}
function syncBlockingLock(){
  const lock=document.getElementById('popupLock');
  if(!lock) return;
  lock.classList.toggle('on', blockingCount>0);
  lock.classList.toggle('strong', blockingCount>0);
  lock.classList.toggle('blocking-window', blockingCount>0);
  if(errorsEl) errorsEl.classList.toggle('has-blocking', blockingCount>0);
}

// L4 的业务状态仍由当前渲染进程持有，视觉和输入冻结交给独立 Electron 窗口。
let l4Seq=0;
function openL4Window(o={}){
  if(!window.uiwin || !window.uiwin.openBlocking){
    console.warn('[L4] 独立冻结窗口接口不可用');
    return null;
  }
  if(!window.__l4Handlers){
    window.__l4Handlers=new Map();
    if(window.uiwin.onBlockingAction){
      window.uiwin.onBlockingAction(id=>{
        const handler=window.__l4Handlers.get(id);
        if(!handler) return;
        try{
          if(handler.onAction) handler.onAction();
        }finally{
          handler.close();
        }
      });
    }
    if(window.uiwin.onBlockingClosed){
      window.uiwin.onBlockingClosed(id=>{
        const handler=window.__l4Handlers.get(id);
        if(handler && handler.onClosed) handler.onClosed();
      });
    }
  }

  const level=SEM_ICO[o.level] ? o.level : 'err';
  const id='l4-'+Date.now()+'-'+(++l4Seq);
  let closed=false;
  const close=()=>{
    if(closed) return;
    closed=true;
    window.__l4Handlers.delete(id);
    blockingCount=Math.max(0,blockingCount-1);
    syncBlockingLock();
    window.uiwin.closeBlocking(id);
  };
  const onClosed=()=>{
    if(closed) return;
    closed=true;
    window.__l4Handlers.delete(id);
    blockingCount=Math.max(0,blockingCount-1);
    syncBlockingLock();
  };
  window.__l4Handlers.set(id,{ onAction:o.onConfirm||o.onAction, close, onClosed });
  blockingCount++;
  syncBlockingLock();
  window.uiwin.openBlocking({
    id,
    title:o.title||'需要处理',
    body:o.body||'',
    detail:o.detail||'',
    level,
    // ⚠ L4 是【独立窗口】，它没加载 icons.js —— 传图标名过去会被当文字显示出 "close"。
    //   所以这里传【字符】，不传图标名。L4 那边自己用 l4-window.html 里的写法渲染。
    icon:o.icon || SEM_CHAR[level] || '✕',
    action:o.confirm||o.action||'立即处理',
    // ⚠ 背景先不带图，只给默认渐变 —— 窗口要立刻能显示，不能等图。
    //   背景 key 按打断等级分配，不能传语义色(err/warn)，否则会回落到 error.L2。
    background:'',
    backgroundFallback:window.BG && window.BG.errorDefault ? window.BG.errorDefault('L4') : ''
  });
  // ⚠⚠ L4 是【独立窗口】，blob: 地址只在本窗口有效，传过去那边解析不出来。
  //   所以必须转成 dataURL 再送。转换是异步的，所以分两步：
  //   窗口先用默认渐变开起来（不卡住），图取到了再补发一次。
  //   ⛔ 别为了"一次发完"把 openBlocking 改成异步 —— 那会让冻结窗口延迟出现，
  //      而 L4 的意义就是立刻挡住用户（见 docs/12 坑24）。
  if(window.BG && window.BG.getErrorBgDataUrl){
    window.BG.getErrorBgDataUrl('L4').then(dataUrl=>{
      if(!dataUrl || closed) return;
      window.uiwin.openBlocking({ id, background:dataUrl, backgroundOnly:true });
    }).catch(()=>{});
  }
  return { close, id };
}

// ⚠ 动态定位弹窗容器到【最上层主卡】(cards[cur]) 的中心。
//   不用写死坐标 —— 切主卡时叠压位置会变, 固定 top:460 会错位。
//   返回 { x, y } = 主卡中心(视口坐标, 供 position:fixed 用)。
function popupAnchor(){
  const c = cards && cards[cur];
  if(!c) return { x:60, y:460 };
  const r = c.getBoundingClientRect();
  // 主卡中心: 水平中心, 垂直中心(弹窗往上浮时以中心为锚)
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}

const UI = {
  // ── L1 Toast: 报错堆里的极窄胶囊条, 自动消失 ──
  toast(msg, level='info', ms=3000){
    const p=addErrorCard({
      title: msg,
      level: level||'info',
      severity: 'L1',
      duration: ms,
      confirm: false,         // 无按钮(纯提示)
    });
    return p;
  },

  // ── L2 通知卡: 报错堆里弹出, 确认后消失 ──
  //   { title, body, detail, level, confirm, onConfirm }
  notice(o={}){
    return addErrorCard({
      title: o.title||'提示',
      body: o.body,
      detail: o.detail,       // 详细信息(向右滑动显示)
      level: o.level||'info',
      severity: 'L2',
      confirm: o.confirm||'知道了',
      // ⭐ 2026-10-06 晚：默认仍然没有取消按钮；但调用方显式给了 cancel 就放行
      //   （引擎离线那种"立刻启动 / 先不用"动作卡）。
      //   ⚠ 不能直接写 o.cancel：undefined 会踩 addErrorCard 的 `o.cancel!==false`
      //     —— 结果每张 L2 都长出一个"取消"按钮。
      cancel: o.cancel===undefined ? false : o.cancel,
      onConfirm: o.onConfirm,
      onCancel: o.onCancel,
      // ⭐ 2026-10-14：调用方自定义按钮（公告的「到设置里看完整公告」要用）。
      //   ⚠⚠ 这里【必须显式透传】—— addErrorCard 支持 o.actions，
      //     但 notice() 是一个字段一个字段手动搬过去的，漏了这一个字段
      //     就等于"按钮永远不出现"，而且不报错（我第一版就是这么错的：
      //     用了之后发现公告弹窗上只有一个"我已知晓"）。
      actions: o.actions,
      // ⭐ 2026-10-15：钉顶 + 富文本正文（公告用）。⚠ 同上：notice() 是逐字段搬的，漏搬 = 静默失效。
      pin: o.pin,
      bodyNode: o.bodyNode,
      expand: !!o.expand,
      // 2026-10-18 深夜：垃圾桶一键清时这张卡怎么处理（'confirm' / 'cancel' / 'none'）。⚠ 逐字段搬，漏搬 = 静默失效
      safeClear: o.safeClear,
      // ⭐ 2026-10-22（docs/263 §2「报错卡上没有重试」）：有重试动作就带上按钮。
      //   ⚠ 同上：notice() 是逐字段搬的 —— 漏这一行就是「按钮永远不出现」，而且不报错。
      retry: o.retry,
      retryLabel: o.retryLabel,
      // ⭐ 2026-10-24：关不掉的常驻卡（插件需要更新）。⚠ 同上，逐字段搬 —— 漏搬 = 卡照样能关，不报错
      persistent: !!o.persistent,
      // 2026-10-18 深夜：错误码（报错卡「反馈这个问题」要带上）。⚠ 同上，逐字段搬
      code: o.code
    });
  },

  // 文档中的旧名称保留为 L2 通知别名，避免调用方出现两套接口。
  banner(o={}){ return UI.notice(o); },

  // ── L3 确认卡: 报错堆里弹出, 固定带取消按钮 ──
  dialog(o={}){
    const handle=addErrorCard({
      title: o.title||'确认操作',
      body: o.body,
      detail: o.detail,
      level: o.level||'warn',
      severity: 'L3',
      confirm: o.confirm||'确定',
      cancel: o.cancel||'取消',
      danger: !!o.danger,
      onConfirm: o.onConfirm,
      onCancel: o.onCancel,
      // 2026-10-18 深夜：垃圾桶一键清时怎么处理（默认当「取消」；取消是危险操作的卡传 'none'）
      safeClear: o.safeClear,
      code: o.code   // 错误码（「反馈这个问题」用）⚠ 逐字段搬
    });
    // Calls made directly from a card or integration do not pass through
    // outsideModal(). Register them in the same focus/inert scope and expose
    // the decision buttons immediately. Wrapped callers retain the existing
    // reveal-on-Enter behavior owned by V7FocusScope.outsideModal().
    if(handle?.el && !window.V7FocusScope?.isOutsideModalActive?.()){
      if(window.V7FocusScope?.registerConfirmation) window.V7FocusScope.registerConfirmation(handle.el);
      else if(handle.detailEl){
        handle.el.tabIndex=0;
        handle.el.setAttribute('role','button');
        handle.el.setAttribute('aria-label',(handle.el.querySelector('.ec-title')?.textContent||'确认操作')+'，按回车展开');
        handle.detailEl.classList.add('show');
        const first=handle.detailEl.querySelector('[data-a="cancel"],[data-a="confirm"]');
        if(first)requestAnimationFrame(()=>first.focus());
      }
    }
    return handle;
  },

  // ── L4 Blocking: 全屏冻结, 无关闭按钮, 只能按指定操作解除。Esc 无效 ──
  block(o={}){
    return addErrorCard({
      title: o.title||'需要处理',
      body: o.body,
      detail: o.detail,
      level: o.level||'err',
      severity: 'L4',
      confirm: o.action||'立即处理',
      cancel: false,
      danger: true,
      blocking: true,         // L4 冻结遮罩
      onConfirm: o.onAction,
      icon: o.icon||''
    });
  }
};
// 作为后续真实链路接入的唯一 UI 入口，同时保留脚本内部直接调用。
window.UI = UI;
if(window.V7HistoryPrompts)V7HistoryPrompts.configure({apply:async(value,context={check:()=>{}})=>{
  context.check();
  if(value.preset){
    const preset=window.PRESETS&&PRESETS.presetById(value.preset.id);
    if(!preset)throw new Error('原预设在当前预设库中不存在。可以取消勾选“原预设”，单独复用提示词或参数。');
    if(value.preset.version&&String(preset.version||'')!==value.preset.version)throw new Error('原预设版本已变化，请先确认当前预设，或只复用提示词与参数。');
    if(value.prompt&&preset.kind&&preset.kind!=='prompt')throw new Error('工具预设不能同时套用生图提示词，请分开选择复用内容。');
  }
  if(value.prompt&&!value.preset&&window.PRESETUI&&PRESETUI.getToolPreset())throw new Error('当前是工具预设，请先选择生图预设，再复用提示词。');
  if(value.model){
    const known=['aji','grs','other'];
    if(value.model.provider&&!known.includes(value.model.provider))throw new Error('该历史来自工作流或其他渠道，请通过对应预设选择算力来源；可取消“模型与渠道”，单独复用提示词或参数。');
  }
  if(value.parameters){
    const customKeys=Object.keys(value.parameters).filter(key=>!['size','aspectRatio','batch','antiMode'].includes(key));
    if(customKeys.length){
      const targetId=value.preset?.id||PRESETUI.prompt?.presetId||'';
      if(!value.workflowPresetId||targetId!==value.workflowPresetId)throw new Error('这些工作流参数属于原工作流。请勾选原预设一起复用，或取消参数复用。');
    }
  }
  if(value.preset)await PRESETUI.loadPresetById(value.preset.id,true);
  context.check();
  if(value.prompt!==undefined){PRESETUI.setPromptText(value.prompt);aiRuntime.prompt=value.prompt;}
  if(value.model){if(value.model.provider){settingsRuntime.provider=value.model.provider;settingsSyncAiRuntime();}if(value.model.id)aiRuntime.model=value.model.id;if(value.model.protocol)aiRuntime.protocol=value.model.protocol;}
  if(value.parameters){
    for(const name of ['size','aspectRatio'])if(value.parameters[name]!=null)aiRuntime[name]=String(value.parameters[name]);
    if(value.parameters.batch!=null)aiRuntime.batch=Math.max(1,Math.min(AI_BATCH_MAX,Number(value.parameters.batch)||1));
    if(value.parameters.antiMode!=null)aiRuntime.antiMode=Math.max(0,Math.min(2,Number(value.parameters.antiMode)||0));
    if(window.PRESETUI&&typeof PRESETUI.setWorkflowParameters==='function'){
      PRESETUI.setWorkflowParameters(value.parameters,{presetId:value.workflowPresetId||value.preset&&value.preset.id||''});
    }else{
      aiRuntime.workflowParameters=Object.assign({},aiRuntime.workflowParameters||{},value.parameters);
      aiRuntime.workflowPresetId=String(value.preset&&value.preset.id||aiRuntime.workflowPresetId||'');
    }
  }
  aiRefreshInPlace();
}});
if(window.V7CloudBackup)V7CloudBackup.configure({
  getSettings:()=>safeSettingsSnapshot(),
  applySettings:async value=>{
    const next={...SETTINGS_DEFAULTS,backendUrl:settingsRuntime.backendUrl};
    for(const name of Object.keys(SETTINGS_DEFAULTS))if(name!=='backendUrl'&&!SECRET_SETTING_KEYS.has(name)&&!MACHINE_SETTING_KEYS.has(name)&&Object.prototype.hasOwnProperty.call(value,name))next[name]=value[name];
    for(const name of SECRET_SETTING_KEYS)next[name]=settingsRuntime[name]||'';
    // ⭐ 2026-10-19（docs/250 第 18、19 条）：快捷键 / 自由摆放开关是「这台电脑的」，云端那份（别的电脑备份的）不许盖过来
    for(const name of MACHINE_SETTING_KEYS)next[name]=settingsRuntime[name];
    const safe={...next};for(const name of SECRET_SETTING_KEYS)delete safe[name];for(const name of MACHINE_SETTING_KEYS)delete safe[name];
    localStorage.setItem(settingsStorageKey(),JSON.stringify(safe));
    Object.assign(settingsRuntime,next);settingsSyncAiRuntime();settingsApplyAppearance();shortcutApplyIfChanged();
  },
  getAssistantConnection:()=>{try{return JSON.parse(localStorage.getItem(WHEELCHAIR_STORAGE.key('assistant.connection.v1'))||'{}');}catch(_){return {}; }},
  applyAssistantConnection:async value=>localStorage.setItem(WHEELCHAIR_STORAGE.key('assistant.connection.v1'),JSON.stringify(value)),
  getAssistantPresets:()=>{try{return JSON.parse(localStorage.getItem(WHEELCHAIR_STORAGE.key('assistant.presets.v1'))||'[]');}catch(_){return []; }},
  applyAssistantPresets:async value=>localStorage.setItem(WHEELCHAIR_STORAGE.key('assistant.presets.v1'),JSON.stringify(value)),
  getSecrets:()=>Object.fromEntries(Array.from(SECRET_SETTING_KEYS).map(name=>[name,String(settingsRuntime[name]||'')])),
  applySecrets:async values=>{for(const name of SECRET_SETTING_KEYS)if(Object.prototype.hasOwnProperty.call(values,name))settingsRuntime[name]=values[name];settingsSyncAiRuntime();window.dispatchEvent(new CustomEvent('wheelchair:secrets-restored'));},
  back:()=>{V7Workspaces.close('backup');openServiceWorkspace();}
});
let assistantPlanEpoch=0;
window.addEventListener('wheelchair:storage-context',()=>{assistantPlanEpoch++;});
// ⭐ 2026-10-17 夜（用户：「它现在卡在准备生成了，有一会了」）：等 Photoshop 回话一律带超时。
//   实测：准备生成发了 ps.selection.rect，PS 一直没回，这里原来没超时 ⇒ 夏三六的「准备生成」挂了 4 分多钟还在等。
//   超时就明说 PS 没回、下一步怎么办（多半是联动插件卡住，Reload 一下）。
function assistantLinkWait(action,params,timeoutMs,what){
  // ⭐ 2026-10-21（docs/261 U4）：插件根本没连上时以前也要干等 20 秒才报「超时」，用户不知道到底抓没抓到。
  //   发之前现问一次：插件最近有动静（或者正处在「等 Photoshop 回来」——液化 / Camera Raw 开着）就照常等；
  //   从来没动静 ⇒ 马上说清楚怎么办。问不到状态（旧壳）就照旧直接发。
  return assistantBridgeReady().then(ready=>{
    if(!ready) throw Object.assign(new Error('PS 联动插件没连上（'+what+'没发出去）：先在 Photoshop 里打开轮椅插件面板（窗口 → 增效工具），连上后再试'),{code:'PS_LINK_NOT_CONNECTED'});
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
      const timer=setTimeout(()=>finish(reject,Object.assign(new Error('Photoshop '+Math.round(timeoutMs/1000)+' 秒没回话（'+what+'）：联动插件可能卡住了，在 UXP Developer Tool 里 Reload 联动插件后再试'),{code:'PS_TIMEOUT'})),timeoutMs);
      linkQueue(action,params,{after:data=>finish(resolve,data),afterError:r=>finish(reject,new Error(linkResultMessage(r)))}).catch(e=>finish(reject,e));
    });
  });
}
async function assistantBridgeReady(){
  if(linkRuntime.connected||linkRuntime.waitingPs)return true;
  try{
    if(!window.uiwin?.link?.status)return true;
    const status=await window.uiwin.link.status(),last=Date.parse(status?.bridge?.lastPollAt||'');
    if(!Number.isFinite(last))return false;
    return Date.now()-last<(bridgeThrottled()?BRIDGE_THROTTLED_MS:BRIDGE_SILENT_MS);
  }catch(_){return true;}
}
function assistantReadTarget(){
  return assistantLinkWait('ps.selection.rect',{},20000,'读当前文档和选区').then(data=>({docId:data.docId,docName:data.docName,docWidth:data.docWidth,docHeight:data.docHeight,selection:data.hasSelection?{left:data.selLeft,top:data.selTop,right:data.selLeft+data.selWidth,bottom:data.selTop+data.selHeight}:null}));
}
if(window.V7AssistantPanel)V7AssistantPanel.configure({
  // 助手查询与“使用说明”共用同一份离线手册；作者修图知识仍由知识库自己的学生资格过滤。
  knowledge:{
    search(query, options){
      const manual=window.V7ManualContent?window.V7ManualContent.search(query):[];
      const publicEntries=manual.map(entry=>({id:'manual.'+entry.id,topic:entry.topic,title:entry.title,body:[entry.summary,...entry.steps,...entry.notes].join('\n'),tags:entry.tags,audience:'public',status:'published',source:'software-manual'}));
      const curated=window.V7KnowledgeBase?window.V7KnowledgeBase.search(query, options||{}):[];
      return publicEntries.concat(curated);
    },
    get(id, options){ return window.V7KnowledgeBase?.get(id, options||{}) || (window.V7ManualContent?.get(String(id||'').replace(/^manual\./,''))||null); }
  },
  canvasAvailable:async()=>{
    if(!window.uiwin?.link?.status)return false;
    const status=await window.uiwin.link.status(),last=Date.parse(status?.bridge?.lastPollAt||'');
    return Number.isFinite(last)&&Date.now()-last<BRIDGE_SILENT_MS;
  },
  capture:()=>new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('读取 Photoshop 画布超时，请确认桥接插件已连接'));}},45000);
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    linkQueue('ps.assistant.capture',{maxEdge:1536},{after:data=>finish(resolve,data),afterError:r=>finish(reject,new Error(linkResultMessage(r)))});
  }),
  viewState:async mode=>{
    const read=(action,params)=>new Promise((resolve,reject)=>{
      let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('Photoshop 响应超时'));}},12000);
      const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
      linkQueue(action,{...params,expiresAt:Date.now()+10000},{after:data=>finish(resolve,data),afterError:r=>finish(reject,new Error(linkResultMessage(r)))}).catch(error=>finish(reject,error));
    });
    const view=await read('ps.assistant.viewState',{});
    if(mode==='selection'&&view.activeDocumentBound){
      const selected=await read('ps.selection.rect',{docId:view.docId});
      if(String(selected.docId)!==String(view.docId))throw new Error('Photoshop 文档已切换');
      view.selection={status:selected.hasSelection?'present':'none',bounds:selected.hasSelection?{left:selected.selLeft,top:selected.selTop,right:selected.selLeft+selected.selWidth,bottom:selected.selTop+selected.selHeight}:null};
    }
    return view;
  },
  generation:{
    scope:()=>window.WHEELCHAIR_STORAGE?window.WHEELCHAIR_STORAGE.namespaceId():'anonymous',
    id:()=>aiNewTaskId('assistant'),
    capture:()=>new Promise((resolve,reject)=>{
      linkQueue('ps.selection.capture',{allowFullCanvas:!!settingsRuntime.autoFullCanvas,maxResolution:captureMaxEdge(),antiMode:Number(aiRuntime.antiMode)||0},{after:resolve,afterError:r=>reject(new Error(linkResultMessage(r)))});
    }),
    prepare:async input=>{
      const scope=cacheNamespaceId(),epoch=assistantPlanEpoch;
      const check=()=>{if(scope!==cacheNamespaceId()||epoch!==assistantPlanEpoch)throw new Error('账号已切换，请重新准备生成计划');if(input.checkContext)input.checkContext();};
      if(input.presetId){
        const preset=window.PRESETS&&PRESETS.presetById(input.presetId);
        if(!preset||preset.needsReview||(preset.kind&&preset.kind!=='prompt'))throw new Error('此预设不能直接用于助手生成，请先在对应工具中打开');
        if(PRESETUI.prompt.presetId!==input.presetId||PRESETUI.prompt.toolId){await PRESETUI.loadPresetById(input.presetId,false);check();}
        if(PRESETUI.prompt.presetId!==input.presetId||PRESETUI.prompt.toolId)throw new Error('所选预设未加载，尚未准备生成');
      }
      const config=aiClonePlain({...aiRuntime,...aiWorkflowSnapshot(),batch:input.count,presetId:input.presetId||'',presetTitle:input.presetTitle||presetTitleNow()});
      const autoReturn=!!settingsRuntime.autoReturn;
      const refs=window.V7PresetReferences?V7PresetReferences.capture():null;
      if(refs)config.refImages=await V7PresetReferences.payload(refs);
      check();
      if(config.preActionPreset&&window.V7PresetPreActions){await V7PresetPreActions.beforeGenerate(config.preActionPreset,null);check();}
      const target=await assistantReadTarget();check();
      const snapshot=aiClonePlain(input.capture||await assistantLinkWait('ps.selection.capture',{allowFullCanvas:!!config.autoFullCanvas,maxResolution:captureMaxEdge(),antiMode:Number(config.antiMode)||0},180000,'抓选区的图'));
      check();
      const afterCapture=await assistantReadTarget();check();
      if(!V7AssistantGeneration.sameTarget(target,afterCapture)||String(snapshot.docId)!==String(target.docId))throw new Error('Photoshop 目标在抓图期间改变，请重新准备计划');
      const payload=aiPayload({...config,captureSnapshot:snapshot});
      const workflow=window.V7Workflows&&V7Workflows.isWorkflow(payload);
      const provider=aiPlatformRoute(payload.provider);
      const route=provider==='runninghub'?'own':String(payload.computeSource||'own');
      let estimate={points:0,etaSeconds:0,source:route};
      if(route==='platform'&&window.V7Backend&&window.V7Backend.quote){
        const parameters=workflow?V7Workflows.billingParameters(payload):{size:payload.size,aspectRatio:payload.aspectRatio};
        const referenceCount=workflow&&Array.isArray(payload.refImages)?payload.refImages.length:0;
        if(workflow&&referenceCount){
          const available=await window.V7Backend.workflowAvailability(payload.platformPresetId||payload.presetId||'',provider,input.count,referenceCount);check();
          if(available?.referenceInput?.version!==1||available.referenceInput.count!==referenceCount)throw new Error('平台尚未提供与本次参考图匹配的输入能力');
        }
        const quoted=await window.V7Backend.quote(provider,input.count,{presetId:payload.platformPresetId||payload.presetId||'',workflowParameters:parameters,...(workflow?{referenceCount}:{})});
        check();
        if(workflow&&referenceCount){const contract=quoted.estimate.workflowReferenceContract;if(contract?.version!==1||!Array.isArray(contract.referenceNodeIds)||contract.referenceNodeIds.length!==referenceCount)throw new Error('平台报价没有绑定本次参考图输入');}
        estimate={...quoted.estimate,source:route};
      }else if(route==='own') estimate={points:0,etaSeconds:null,source:'own',label:'使用自己的 API，费用由服务商收取'};
      else if(route==='local')estimate={points:0,etaSeconds:null,source:'local',label:'本机工作流，不使用平台积分'};
      return {target,preview:{preset:config.presetTitle,part:target.selection?'当前 Photoshop 选区':'当前 Photoshop 画布',count:input.count,cost:Number.isFinite(estimate.points)&&route==='platform'?estimate.points+' 积分':estimate.label||'费用未知',eta:estimate.etaSeconds?estimate.etaSeconds+' 秒':'时间未知',source:estimate.source},privateConfig:{estimate,snapshot,config,autoReturn}};
    },
    confirm:async preview=>{
      if(window.V7FirstRun&&!V7FirstRun.isComplete()&&!await V7FirstRun.require())return false;
      return new Promise(resolve=>UI.dialog({title:'确认助手生成计划',body:'预设：'+preview.preset+' · 部位：'+preview.part+'\n生成 '+preview.count+' 次 · 预计费用：'+preview.cost+' · 预计时间：'+preview.eta,detail:billingNoRefundText(preview.cost),confirm:'确认并生成',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}));
    },
    target:assistantReadTarget,
    run:async plan=>{
      const snapshot=plan.privateConfig.snapshot, taskId=plan.planId;
      const input={...aiClonePlain(plan.privateConfig.config),taskId,batch:plan.preview.count,presetTitle:plan.preview.preset,captureSnapshot:snapshot,sourceImageBase64:snapshot.sourceImageBase64||snapshot.imageBase64,inputImageBase64:snapshot.imageBase64,inputMime:snapshot.mime};
      return aiGenerateNow(input,{autoReturn:plan.privateConfig.autoReturn,guard:plan.checkContext});
    }
  },
  connection:()=>({baseUrl:aiRuntime.baseUrl||'',apiKey:aiRuntime.apiKey||aiRuntime.key||''}),
  secrets:()=>Array.from(SECRET_SETTING_KEYS).map(k=>String(settingsRuntime[k]||'')).filter(Boolean),
  status:()=>({provider:settingsRuntime.provider,model:aiRuntime.model,batch:aiRuntime.batch,
    preset:window.PRESETUI?PRESETUI.getPresetTitle():'',
    tasks:(taskList||[]).map(t=>({id:t.id,status:t.status,preset:t.presetTitle,count:t.shots?t.shots.length:0}))})
});
// ⭐⭐ 2026-10-17 夜 夏三六 · 软件接口（用户：「你现在没有把我们软件里面的这个接口和内容以及别的东西暴露给我们的Agent呀」）
//   工具定义在 agent-app-tools.js；这里只把软件里【现成的】函数接给它，不另写业务。
//   ⚠ 全部是用到时才取（闭包），所以引用写在本文件后面的函数 / 常量也没关系。
//   ⚠ 设置只认 settingControl 登记过的项；Key / 密码 / 后端地址不让改（agentSettingsBlocked）。
function agentSettingsMeta(){
  // 把设置页的几份控件源「画」一遍（只拼字符串、不进 DOM），settingControl 每画一项就登记一次
  const draw=fn=>{try{fn();}catch(_){}};
  [0,1,2,3].forEach(i=>draw(()=>legacySettingsMarkup(i)));
  draw(generationMarkup);draw(returnSettingsMarkup);draw(debugMarkup);
  ['engine','align','detail','matting'].forEach(k=>draw(()=>enginesCapSettingsHtml(k,{noBox:true})));
  return [...(SETTING_META||new Map()).values()].filter(m=>Object.prototype.hasOwnProperty.call(settingsRuntime,m.key)).map(m=>({...m,range:SETTING_RANGES[m.key]||null}));
}
function agentSettingsBlocked(){return [...SECRET_SETTING_KEYS,'backendUrl'];}
// 每一项在设置卡的哪一节：只有设置卡画出来过才知道（按页面上真实的归属读，不另抄一张表）
function agentSettingsSections(){
  const zone=settingsCardEl();if(!zone)return null;
  const out={};
  zone.querySelectorAll('[data-sec-anchor]').forEach(sec=>sec.querySelectorAll('[data-setting]').forEach(el=>{if(!out[el.dataset.setting])out[el.dataset.setting]=sec.dataset.secAnchor;}));
  return Object.keys(out).length?out:null;
}
// 写设置：跟用户在设置页上改是同一条路（settingsReadFields 的写法），改完同名控件全刷新
function agentSettingsApply(changes){
  for(const [key,value] of Object.entries(changes||{})){
    if(!Object.prototype.hasOwnProperty.call(settingsRuntime,key)||agentSettingsBlocked().includes(key))continue;
    settingsRuntime[key]=SHORTCUT_SETTING_KEYS.has(key)?normalizeShortcutValue(value):value;
    if(key==='workflowSource')settingsRuntime.workflowSourceChosen=true;
    syncSettingControl(key);
  }
  settingsSave();
  if(typeof applyThemeColors==='function')applyThemeColors();
}
function agentGenerationState(){
  const qwen=!!(window.V7QwenMode&&V7QwenMode.enabled());
  return {provider:settingsRuntime.provider,connectionSlot:aiModelSlot(),connectionConfigured:aiConnectionConfigured(),providerReady:aiProviderReady(),
    imageComputeSource:settingsRuntime.imageComputeSource,workflowSource:settingsRuntime.workflowSource,
    model:aiRuntime.model,size:aiRuntime.size,aspectRatio:aiRuntime.aspectRatio,batch:Number(aiRuntime.batch)||1,prompt:String(aiRuntime.prompt||''),
    presetId:window.PRESETUI&&PRESETUI.prompt?String(PRESETUI.prompt.presetId||''):'',presetTitle:presetTitleNow(),
    qwenMode:qwen,qwenSource:window.V7QwenMode?V7QwenMode.source():'',
    sizes:qwen?['1K','2K']:AI_SIZES.slice(),aspectRatios:AI_ASPECTS.slice(),batchMax:AI_BATCH_MAX,autoReturn:settingsRuntime.autoReturn===true};
}
async function agentGenerationApply(value){
  if(value.presetId){
    const preset=window.PRESETS&&PRESETS.presetById(value.presetId);
    if(!preset)throw Object.assign(new Error('预设库里没有这个预设：'+value.presetId+'（preset_list 查）'),{code:'PRESET_NOT_FOUND'});
    if(preset.kind&&preset.kind!=='prompt')throw Object.assign(new Error('「'+preset.title+'」是工具预设，不是生图预设；工具用 tool_run 或 app_open'),{code:'PRESET_NOT_PROMPT'});
    await PRESETUI.loadPresetById(value.presetId,true);
  }
  if(value.prompt!=null){PRESETUI.setPromptText(value.prompt);aiRuntime.prompt=value.prompt;}
  if(value.model!=null)aiRuntime.model=value.model;
  if(value.size!=null)aiRuntime.size=value.size;
  if(value.aspectRatio!=null)aiRuntime.aspectRatio=value.aspectRatio;
  if(value.batch!=null){
    aiRuntime.batch=Math.max(1,Math.min(AI_BATCH_MAX,Number(value.batch)||1));
    if(aiRuntime.workflowPresetId&&window.PRESETUI&&PRESETUI.setWorkflowParameters)PRESETUI.setWorkflowParameters({imageCount:aiRuntime.batch,batch:aiRuntime.batch,count:aiRuntime.batch},{refresh:false});
  }
  aiSaveTempCache();renderGenerationCardFields();aiRefreshInPlace();
}
// 抠像 / 人体解析：跟用户点 ▶ 是同一条链（startMatting / startSegment），参数 = 出厂预设 + 大脑给的
async function agentRunTool(kind,params){
  const id=kind==='segment'?'__segment_default__':'__matting_default__';
  const preset=window.PRESETS&&PRESETS.presetById(id);
  if(!preset)throw Object.assign(new Error('没找到「'+(kind==='segment'?'人体解析':'抠像')+'」的出厂预设，重启软件会自动补回'),{code:'TOOL_OPEN_FAILED'});
  let defaults={};try{defaults=JSON.parse(preset.content||'{}');}catch(_){}
  const before=new Set(taskList.map(t=>t.id));
  const started=await (kind==='segment'?startSegment(preset,{...defaults,...params}):startMatting(preset,{...defaults,...params}));
  if(started===false)return null;
  return taskList.find(t=>!before.has(t.id)&&(t.kind===kind||t.kind==='matting'||t.kind==='segment'))||null;
}
async function agentRecordSend(row,indexes){
  let task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);
  if(!task){if(await cacheRestoreOne(row)===false)return {ok:false,code:'RECORD_RESTORE_FAILED',message:'恢复到任务栏没成功，传不回去'};task=taskList.find(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId);}
  if(!task)return {ok:false,code:'RECORD_RESTORE_FAILED',message:'找不到刚恢复的任务'};
  const r=await aiTransfer(task,indexes);
  if(!r)return {ok:false,code:'NOTHING_TO_RETURN',message:'没有可传回的图（可能已经传回过了，看 tasks_list）',taskId:task.id};
  return r.ok===false?{ok:false,code:'TASK_RETURN_FAILED',message:String(r.error||r.message||'传回没成功'),taskId:task.id}:{ok:true,taskId:task.id,layers:r.data&&Array.isArray(r.data.layerIds)?r.data.layerIds.length:null};
}
function agentAppHost(){
  const W=window;
  return {
    map:()=>{
      const reg=W.V7CardRegistry;
      const cardsOut=(reg?reg.cards:[]).filter(c=>cards.some(el=>el.dataset.card===c.id)).map(c=>{
        const tabs=Array.isArray(c.innerTabs)&&c.innerTabs.length?c.innerTabs.map(t=>({id:t.id,name:t.name,sub:t.sub||''})):
          (c.levels==='main-bigzone'?[]:(c.zones||[]).map(z=>({id:String(z.i),name:z.name,sub:z.sub||''})));
        return {id:c.id,name:c.name,info:c.footInfo||'',sections:c.id==='settings'?[]:tabs};
      });
      const tools=(W.V7ToolSilhouettes?.definitions||[]).filter(r=>r.key!=='poster').map(r=>({key:r.key,title:r.title,description:r.description}));
      return {cards:cardsOut,settingsSections:SETTINGS_TABS.map(t=>({id:t.id,name:t.name,sub:t.sub,group:t.group})),tools};
    },
    open:(id,section)=>{
      // ⚠ byId() 不收参数、返回整张表（第一版写成 byId(id) 拿到 undefined，页名全被丢掉 —— 实测抓到）
      const card=(W.V7CardRegistry?.byId?.()||{})[id];
      // ⚠ 外挂能力卡的页名走 opts.zone（enginesRoute → card.open(opts.zone)），别的大二级走 opts.section
      if(card&&card.levels==='main-bigzone')return navigateCard(id,0,section?(id==='engines'?{zone:section}:{section}):{});
      return navigateCard(id,Number(section)||0,{});
    },
    openTool:key=>W.PRESETUI.launchTool(key),
    about:()=>W.V7AboutInfo(),
    notices:()=>{
      const s=W.V7Announce?.state?.();if(!s)return null;
      const text=b=>String(b&&(b.text||b.title||b.body||b.content)||'').replace(/\s+/g,' ').slice(0,240);
      return {status:s.status,updatedAt:s.updatedAt||'',blocks:(s.blocks||[]).slice(0,8).map(b=>({type:b&&b.type||'',text:text(b)})).filter(b=>b.text),services:(s.services||[]).slice(0,10)};
    },
    logs:n=>aiRuntime.logs.slice(-n).map(l=>({at:l.at,level:l.level,message:String(l.message||'').slice(0,240)})),
    settings:{meta:agentSettingsMeta,values:safeSettingsSnapshot,sections:agentSettingsSections,blocked:agentSettingsBlocked,apply:agentSettingsApply},
    account:{
      state:()=>{const s=W.V7Backend?.state?.()||{};return {signedIn:!!s.signedIn,email:s.account&&s.account.email||''};},
      points:()=>W.V7Backend.points(),
      ledger:o=>W.V7Backend.pointLedger(o)
    },
    prices:()=>W.V7AjiPrices?W.V7AjiPrices.state():null,
    generation:{
      state:agentGenerationState,
      models:()=>aiModelOptions(),
      apply:agentGenerationApply,
      setQwen:on=>!!(W.V7QwenMode&&V7QwenMode.setEnabled(!!on)),
      refs:W.V7PresetReferences?{
        state:()=>V7PresetReferences.state(),
        addSelection:()=>referenceCaptureSelection(V7PresetReferences.context()),
        removeTemporary:i=>V7PresetReferences.remove('temporary',i),
        clearAll:()=>V7PresetReferences.clearAll()
      }:null
    },
    tasks:{
      list:()=>taskList.slice(),
      get:id=>taskList.find(t=>String(t.id)===String(id))||null,
      transferable:t=>taskTransferableOutputs(t).length,
      transfer:(t,indexes)=>aiTransfer(t,indexes||undefined),
      cancel:t=>aiCancel(t)
    },
    records:{
      core:W.V7RecordsCore,
      load:recordsLoadData,
      inTaskbar:row=>taskList.some(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId),
      restore:async row=>{
        if(taskList.some(t=>t.cacheProject===row.project&&t.cacheRunId===row.runId))return {ok:true,already:true,message:'已经在任务栏里了'};
        const ok=await cacheRestoreOne(row);broadcastRecordsChanged();
        return ok===false?{ok:false,code:'RECORD_RESTORE_FAILED',message:'恢复没成功（缓存里的图可能被清掉了）'}:{ok:true};
      },
      send:agentRecordSend,
      reusePrompt:meta=>V7HistoryPrompts.apply({prompt:String(meta&&meta.prompt||'')}),
      openCheckpoint:cp=>V7Checkpoints.openFolder(cp,{cache:uiwin.cache,ownsProject:project=>!W.WHEELCHAIR_STORAGE||WHEELCHAIR_STORAGE.ownsCacheProject(project)})
    },
    tools:{run:agentRunTool},
    trace:W.V7SeamReview||null,
    scopes:W.V7ImageScopes||null,
    network:W.V7NetworkDoctor||null
  };
}
if(window.V7AssistantPanel&&window.V7AgentAppTools)V7AssistantPanel.configure({app:agentAppHost()});

// DETAIL_SETS(四张占位主卡的假参数表)已随占位卡一起删除，2026-09-08。见 docs/22。
function syncDetailToZone(dir){
  const d0 = (dir===undefined? lastDir : dir);
  // 已开着 → 走错落换内容。内容填充统一交给 fillDetailBody。
  fillDetailBody(true, d0);
}

// (旧的分区触发逻辑已被上面的"六条规则"版本取代)

// ── 预设卡二级: 按形态打开(用户 2026-09-11 第三版定案) ──
//   kind='list'   点部位 → 预设列表
//   kind='prompt' 右滑   → 提示词框(200 宽的真二级卡, 切主卡跟别的二级一起联动)
//   二级位置永远只有一个: 列表开着时点部位=切分组/点空白=收; 提示词开着时点部位=换成列表。
//   二级开着时右滑无反应(在 mousemove 的 !zoneOpen 分支外面, 天然满足)。
function openPresetZone(kind, withGlow){
  if(cur!==CARD_PRESETS){ cur=CARD_PRESETS; setStack(); updateZoneBg(cur); }
  const zoneWasOpen = zones.classList.contains('show');      // 播光前先记下"本来就开着吗"
  const switching = zoneWasOpen && presetZoneKind!==kind;
  presetZoneKind = kind;
  syncZoneKind();
  updateDetailBg();
  if(zoneCloseTimer){ clearTimeout(zoneCloseTimer); zoneCloseTimer=null; }
  if(allCloseTimer){ clearTimeout(allCloseTimer); allCloseTimer=null; }
  // 换形态 = 二级被替换 → 三级(如果开着)一并收掉, 它挂的是旧形态的内容
  if(switching && detail.classList.contains('show')){ detail.classList.remove('show','closing'); detailUsed=false; }
  zoneOpen=true;
  zones.classList.remove('closing');
  zones.classList.add('show');
  if(window.PRESETUI){ if(kind==='prompt') PRESETUI.fillPromptZone(); else PRESETUI.fillZone(); }
  const target = kind==='prompt' ? promptZoneEl : presetZoneEl;
  const hint=cards[cur] && cards[cur].querySelector('.edgehint');
  if(hint){ hint.style.opacity='0'; hint.style.width='0px'; }
  // 弹出光: 右滑推进跟鼠标速度, 点按用固定时长
  // ⚠ 重复点击【不重播】(用户 2026-09-28 定案)：
  //   同一个二级面板已经开着、形态也没换（presetZoneKind 没变、二级还是 show），
  //   再点一次同一项只是"重新确认"，不该再放一遍光 —— 那样看着像刷新了。
  //   只有【刚打开】或【换了形态】才播。
  const reopenSame = zoneWasOpen && !switching;
  const playingGlow = !reopenSame;
  let durS=0.6;
  if(playingGlow){
    if(withGlow){ const pv=Math.max(0.15, Math.min(2.0, pushSpeed)); const t=(pv-0.15)/(2.0-0.15); durS=0.9 - Math.pow(t, 1.6)*(0.9-0.40); }
    ['.zone-glow','.zone-bright'].forEach(cls=>{
      const el=target && target.querySelector(cls);
      if(!el) return;
      el.style.animationDuration=durS+'s';
      el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
    });
  }
  if(kind==='list') requestAnimationFrame(()=>requestAnimationFrame(()=>{ if(window.PRESETUI) PRESETUI.measureList(); }));
}

// ── 打开三级详情(withGlow=true 时播放弹出光; false=点按直接弹, 无光) ──
function openDetail(withGlow){
  // ⚠⚠⚠ 2026-10-08 修（用户报"设置在二级大卡片再往右滑，还会弹出一个原来的三级卡片"）：
  //   **单张大二级的卡（设置 / 外挂能力 / 记录与恢复）【没有三级】，一个都不许弹。**
  //
  //   真因：openDetail() 原来【没有守门】—— 只要鼠标在二级卡右缘往右一推
  //   （下面 mousemove 里那处：zDist 落在触发区内且 dx 够大就 openDetail(true)），
  //   它无条件 show + fillDetailBody，不管当前这张卡有没有三级内容。
  //   于是设置卡右滑会推出一张【空壳 / 上一次别的卡留下的内容】的三级卡。
  //
  //   ⚠ 判据本来就有、而且导出了 —— 只是【从来没人调用】：
  //     V7CardRegistry.hasDetail(cardId)（card-registry.js:357，按 levels === 'main-zone' 判）。
  //     而 card-registry.js:218 那条注释早就写明了：
  //       "单张大二级卡【没有三级】，不许从右滑被推出来（docs/96 问题一的第 2 条路径）。"
  //     ⇒ 规矩写了、函数写了、就是没接上。这正是本项目最常见的那种"安静的缺一根线"。
  const cardId = (cards[cur] && cards[cur].dataset && cards[cur].dataset.card) || '';
  const registry = window.V7CardRegistry;
  if (cardId && registry && typeof registry.hasDetail === 'function' && !registry.hasDetail(cardId)) {
    // 顺手把可能残留的三级收干净（切卡那一刻它可能是开着的）
    detail.classList.remove('show');
    detail.classList.remove('closing');
    return;
  }
  if(allCloseTimer){ clearTimeout(allCloseTimer); allCloseTimer=null; }
  // ⚠ 先取消排队的"关二级"定时器, 并把二级恢复成 show ——
  //   否则 closeZones 的 360ms 延迟清理会在三级弹出后把二级关掉("偶发三级在二级没了")。
  //   二级是三级的标题, 三级开着时二级必须留着。
  if(zoneCloseTimer){ clearTimeout(zoneCloseTimer); zoneCloseTimer=null; }
  zones.classList.remove('closing');
  zones.classList.add('show');
  zoneOpen=true;
  const wasOpen=detail.classList.contains('show');
  detail.classList.remove('closing');
  detail.classList.add('show');
  detailUsed=false;                   // ⚠ 每次打开/切换分区都重置"用过"标记(切就清, 用户定案)
  updateDetailBg();                   // 三级绑定独立 bgkey(detail-{主卡}-{分区})
  // ⚠ 三级一开, 主卡光晕逻辑(mousemove 里 if(!detail.show))整体不跑了 → 光晕会停在最亮。
  const hint=cards[cur] && cards[cur].querySelector('.edgehint');
  if(hint){ hint.style.opacity='0'; hint.style.width='0px'; }
  // 二级预告光也清掉(三级已弹, 预告任务完成)
  zones.querySelectorAll('.zone-edgehint').forEach(eh=>{ eh.style.opacity='0'; eh.style.width='0px'; });
  if(withGlow){
    // 推进触发: 三级光带+亮线 播一次(跟二级同款, 速度跟鼠标推进)
    const pv=Math.max(0.15, Math.min(2.0, pushSpeed));
    const t=(pv-0.15)/(2.0-0.15);
    const durS=0.9 - Math.pow(t, 1.6)*(0.9-0.40);
    ['.detail-glow','.detail-bright'].forEach(cls=>{
      const el=document.querySelector('#detail '+cls);
      if(el){
        el.style.animationDuration=durS+'s';
        el.classList.remove('glow');
        void el.offsetWidth;
        el.classList.add('glow');
      }
    });
  }
  if(wasOpen){
    syncDetailToZone();               // 已开着 → 走错落换内容
  }else{
    fillDetailBody(false);            // 首次弹出 → 直接填内容(它自己有弹出动画)
  }
}

// 点分区 → 弹详情(三级内容随 主卡+分区 联动). 点击=直接弹, 无光.
zones.querySelectorAll('.zone').forEach(z=>{
  // ⚠ 预设卡那张单卡(.pzone)不走这条: 它的三级要【点中某个预设】才弹,
  //   点卡片本身(比如点搜索框)不能弹三级。由 preset-ui.js 自己决定什么时候开。
  if(z.classList.contains('pzone')) return;
  z.addEventListener('click',()=>{
    if(window.V7Workspaces?.hasEmbedded?.()){navigateCard(cards[cur].dataset.card,parseInt(z.dataset.z)).catch(error=>ERR.report('LAYOUT_FAILED',{message:String(error.message||error)}));return;}
    selectZone(parseInt(z.dataset.z));
    // ⭐ 点按触发动画（用户 2026-09-14 定）：从循环【当时那一帧】接出去，不是从零开始。
    //   ⚠ 要在 selectZone 之后调 —— 那之前循环还没起，接不上相位。
    const ic=z.querySelector('.z-ic');
    if(ic&&window.MOTION) MOTION.trigger(ic);
    openDetail(false);
    detailUsed=true;
  });
});

// ── 收回光: 一级卡片右缘播一道"从右往左"的光(像二三级被收回来撞进一级里) ──
// 复用 .edgehint 的样式/颜色, 不跟鼠标, 跟收回动画同速(.36s), 且【与收回同时开始】
function playRecoil(){
  const hint=cards[cur] && cards[cur].querySelector('.edgehint');
  if(!hint) return;
  hint.style.opacity=''; hint.style.width='';   // 清内联值, 让 animation 接管
  hint.classList.remove('recoil');
  void hint.offsetWidth;
  hint.classList.add('recoil');
  setTimeout(()=>hint.classList.remove('recoil'), 400);
}

// ── 只关二级(三级常驻不动) ──
// ⚠ 鼠标移出二级时用这个, 不能用 closeAll —— 三级要常驻(用户定案A: 三级弹出后移到哪都不关)
function closeZones(){
  zonesOpenedByNav=0;
  // ⭐ 2026-10-15：二级里展开着的下拉面板要跟着二级一起收（面板挂在 body 上，不会自己走）
  window.UISelect?.closeWithin?.(zones);
  const clear=()=>{
    zones.classList.remove('show','closing');
    zoneOpen=false;
    zones.querySelectorAll('.zone-edgehint').forEach(eh=>{ eh.style.opacity='0'; eh.style.width='0px'; });
  };
  if(zones.classList.contains('show')){
    zones.classList.remove('show'); zones.classList.add('closing');
    playRecoil();                       // ⚠ 跟收回动画【同时】开始, 不能等 clear(否则慢一拍)
    // ⚠ 存句柄: 这 360ms 内若触发三级(openDetail), 必须取消这个定时器,
    //   否则三级弹出后二级仍被这个排队的 clear 关掉 → "偶发三级在二级没了"。
    zoneCloseTimer = setTimeout(clear, 360);
  }else{ clear(); }
}

// ── 关全部(二级 + 三级). 只在明确关闭时用: Esc / 点面板外 / 失焦 / 切主卡 ──
function closeAll(){
  if(window.V7Workspaces?.hasEmbedded?.()){
    V7Workspaces.requestCloseAll().then(accepted=>{if(accepted)closeAll();}).catch(error=>ERR.report('LAYOUT_FAILED',{message:String(error.message||error)}));
    return;
  }
  zonesOpenedByNav=0;
  window.V7HistoryLibrary?.dispose();
  // ⭐ 2026-10-15：二级/三级里展开着的下拉面板跟着一起收（同 closeZones）
  window.UISelect?.closeWithin?.(zones);
  window.UISelect?.closeWithin?.(detail);
  if(allCloseTimer){ clearTimeout(allCloseTimer); allCloseTimer=null; }
  if(zoneCloseTimer){ clearTimeout(zoneCloseTimer); zoneCloseTimer=null; }
  // 从哪来到哪去: 先播收回动画(closing), 播完彻底清
  const clear=()=>{
    zones.classList.remove('show','closing');
    detail.classList.remove('show','closing');
    zones.querySelectorAll('.zone').forEach(x=>x.classList.remove('sel'));
    zoneOpen=false;
    detailUsed=false;detailEditing=false;                  // ⚠ 关闭也重置"用过"标记
    zones.querySelectorAll('.zone-edgehint').forEach(eh=>{ eh.style.opacity='0'; eh.style.width='0px'; });
  };
  if(zones.classList.contains('show')||detail.classList.contains('show')){
    zones.classList.remove('show'); zones.classList.add('closing');
    detail.classList.remove('show'); detail.classList.add('closing');
    playRecoil();                       // ⚠ 跟收回动画【同时】开始, 不能等 clear(否则慢一拍)
    // ⚠ 清场时间要对齐动画时长(--dur=.34s=340ms)。之前 260ms 比动画短, 卡片没滑完就被
    //   掐回到初始态, 造成"中途被截断"的脱节感。改 360ms 等动画走完再清。
    allCloseTimer=setTimeout(()=>{ allCloseTimer=null; clear(); }, 360);
  }else{ clear(); }
}

// 点面板外 → 收; Esc → 收; 失焦 → 收
// ⭐ 2026-09-29 用户定案：剪影预设里的工具大卡开着时，【只有】ESC 和大卡左上角的 ← 能收起（右上角 × 是主动点的，照旧能关）。
//   点到 PS（窗口失焦）、点到面板外都【不收】—— 用工具时要在 PS 里来回操作：示波器边画边看、痕迹检测点一条再去 PS 里看，
//   以前一点 PS 大卡就没了，等于没法用。
//   （「三级卡没用过、鼠标一移出就收」那条碰不到大卡：大卡打开时已把 detailUsed 置 true。）
const toolCardHolds=()=>!!window.V7ToolWorkbench?.isOpen?.();
document.addEventListener('click',e=>{
  if(v7OverlayOpen()||toolCardHolds()) return;
  // ⚠⚠ 判定【必须用 e.composedPath()，不能用 e.target.closest()】(2026-09-30 实测定案)。
  //   原因：有些点击处理函数会在【同一次事件冒泡途中】把自己所在的 DOM 重建掉，
  //   于是事件走到 document 这一层时 e.target 已经是游离节点 ——
  //   游离节点的 .closest() 恒为 null，这里就会误判成"点了面板外"→ closeAll()。
  //   实测（记录卡项目条）：capture 阶段 e.target.isConnected=true、closest('.block-card')=true；
  //   冒泡到这一层时 isConnected=false、closest 变 null → 刚打开的大二级当场被关掉，
  //   用户看到的就是"第一下只亮光、第二下才弹出"（第二下点的是已选中项，不触发重建，所以侥幸能开）。
  //   composedPath() 在事件派发时就定好了、不受后续 DOM 变动影响，全程可靠。
  //   ⚠ 别改回 closest()，也别只判 isConnected —— 游离节点只是其中一种表现。
  const path=e.composedPath();
  const inAny=sel=>path.some(n=>n&&n.nodeType===1&&n.matches&&n.matches(sel));
  if(!inAny('.block-card')&&!inAny('.zones')&&!inAny('.detail-card')&&!inAny('.v7-primary-nav')&&!inAny('.v7-floating-bar')) closeAll();
});
// 生成快捷键的监听统一收在 generationRunNow 附近，这里不再重复注册。
// ⭐ 2026-09-29：工具大卡开着时 ESC = 大卡左上角的 ←（收起大卡、回到工具列表），不碰底下的页面。
//   以前 ESC 一律按导航历史退一步：历史攒了几步时（开过设置 / 记录 / 工作区），退的是大卡【底下】被遮住的页面，
//   大卡本身关不掉，底下的页面还被悄悄换掉（实测历史 4 步时就这样；干净页面只有 1 步，才碰巧能关）。
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!v7OverlayOpen()&&!window.UISelect?.isOpen()){if(toolCardHolds()){e.preventDefault();window.V7ToolWorkbench.close();return;}if(window.V7NavigationShell?.backOnEscape(e))return;closeAll();}});

// 启动时把上次还在任务栏里的任务从缓存拉回来。
// ⚠ 放在最后: 依赖 addTask/IMG/taskErrorInfo 等全部就位。
// ⚠ 只读缩略图，原图按需加载 —— 一开机就读几百 MB 原图等于白优化(docs/21)。
if(typeof cacheRestoreTasks==='function') cacheRestoreTasks();
// 失焦收面板。
// ⚠ 大图/L4 是独立窗口，它们一弹出来主窗口就失焦。这时候【不能】收面板：
//   否则用户从任务预览点开大图、看完关掉，回来发现详情卡自己没了。
//   大图搬出主窗口之前不存在这个问题（那时是同一个窗口内的层，不会失焦）。
window.addEventListener('blur',()=>{
  // toolCardHolds：工具大卡开着时点到 PS 不收（见上面「点面板外」处的说明）
  if(viewerOpen || blockingCount>0 || window.V7Setup?.isOpen() || (window.V7Workspaces?.hasVisibleEmbedded?.()??window.V7Workspaces?.hasEmbedded?.()) || toolCardHolds()) return;
  // ⭐ 2026-10-21（docs/261 U1，用户：右滑出来的提示词框，去 PS 画个框就缩回去）：
  //   三级里【打过字】（detailEditing：提示词框正在写）= 去 PS 画个选区还要回来接着写 ⇒ 不收。
  //   没用过字的照旧一失焦就收（「看一眼就走」、预设列表点一下都不变）；Esc、点软件里的空白处照样收。
  if(detail.classList.contains('show') && detailEditing) return;
  closeAll();
});

