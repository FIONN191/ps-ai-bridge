// ═══ ui-main/03-bridge-collapse.js —— 主界面主程序第 3 / 21 段 ═══
//   管什么：桥断连看门狗 · 点按钮跳出来的二级 · 面板折叠 · 光效收尾 · 叠卡 · 设置卡 / 外挂卡卡面参数
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 桥断连看门狗(2026-09-11 新增) ═══════════════════════════
//  以前【完全没有】：Photoshop 关掉、插件面板被关、UXP 崩了，
//  界面都毫无察觉，只会一直转圈等一个永远不回来的结果。
//  判据是 Rust/Electron 记的 lastPollAt —— UXP 每 50~180ms 轮询一次，
//  超过 12 秒没动静就基本可以断定它不在了。
//  ⚠ 阈值别调太小：PS 执行大操作(比如抓 4K 图)时是单线程阻塞的，
//    那几秒确实不轮询，调到 3 秒会天天误报。
const BRIDGE_SILENT_MS=12000, BRIDGE_CHECK_MS=5000;
// ⭐ 2026-10-18（docs/242 §4.2 复现：PS 不在前台时，PS 把插件的定时器拖到约 1 分钟才跑一次）：
//   插件最近 3 分钟内自己报过「被拖慢」（pollLag，uxp-bridge/index.js 的 pollWithLag），说明它是被 PS 节流、不是掉线，
//   这时把「多久没动静算断开」放宽到 BRIDGE_THROTTLED_MS，界面写「已连接 · PS 在后台」。
//   真的关了面板 / PS 退出 → 不会再有新的 pollLag，3 分钟后回到 12 秒的老判据，照样会报断开。
const BRIDGE_THROTTLED_MS=150000, BRIDGE_LAG_FRESH_MS=180000;
function bridgeThrottled(){
  const lag=linkRuntime.pollLag;
  return !!(lag&&lag.lagMs>1000&&lag.at&&(Date.now()-Date.parse(lag.at))<BRIDGE_LAG_FRESH_MS);
}
let bridgeWasAlive=false, bridgeDownReported=false;
// 2026-10-21：插件没动静的起点（0 = 没在等）。连着这么久都没回来才弹提醒（见 checkBridgeAlive）
let bridgePausedSince=0;
const BRIDGE_PAUSE_NOTICE_MS=600000;
// ⭐ 2026-10-18 用户：「容易提示 Photoshop 插件断开了，桥有多少秒没有响应了。这个时候如果 PS 又有响应的话，就自己弹掉就好了」
//   记下断开那张卡的句柄，插件又来问话了就把它收起来（close 只是收卡，不触发「放弃这些任务」那个按钮的回调）。
//   ⚠ 不能靠用户手动点掉：PS 放后台时插件会被拖到约 1 分钟才问一次（docs/242 §4.2），这张卡来来回回地出，堆满一屏。
let bridgeDownCard=null;
function closeBridgeDownCard(){
  const card=bridgeDownCard;bridgeDownCard=null;
  try{ if(card&&typeof card.close==='function')card.close(); }catch(_){}
}
async function checkBridgeAlive(){
  if(!window.uiwin||!window.uiwin.link||!window.uiwin.link.status) return;
  let st=null;
  try{ st=await window.uiwin.link.status(); }catch(_){ return; }
  const b=(st&&st.bridge)||{};
  const last=b.lastPollAt?Date.parse(b.lastPollAt):0;
  const throttled=bridgeThrottled();
  const alive=!!last && (Date.now()-last)<(throttled?BRIDGE_THROTTLED_MS:BRIDGE_SILENT_MS);
  linkRuntime.connected=alive;
  // 「已连接 · PS 在后台」：连着，但最近被 PS 拖慢过（界面显示用，不影响判断）
  linkRuntime.background=alive&&throttled&&(Date.now()-last)>=BRIDGE_SILENT_MS;
  // 2026-10-16 冒烟：PS 插件在软件启动前就连着时，它那声「ready」界面没接到 ⇒ 关于软件里插件版本一直「版本未知」。
  //   外壳自己记着插件报的版本，这里顺手带上
  if(alive&&b.bridgeVersion){ linkRuntime.bridgeVersion=String(b.bridgeVersion); checkBridgeVersion(linkRuntime.bridgeVersion); }
  if(alive){
    // 2026-10-21：在「等 Photoshop 回来」期间（没弹过卡）回来了 ⇒ 悄悄恢复，什么都不说
    if(bridgePausedSince){bridgePausedSince=0;linkRuntime.waitingPs=false;}
    if(bridgeDownReported){
      bridgeDownReported=false;
      closeBridgeDownCard();
      if(window.ERR) ERR.report('BRIDGE_RECONNECTED',{message:'Photoshop 插件又连上了'});
    }
    bridgeWasAlive=true;
    refreshLinkStatusInPlace();
    return;
  }
  // 从"活着"变成"没动静"才报 —— 桌面板先于 Photoshop 启动是常态，
  // 那种"一直没连上"的情况不该弹卡打扰人。
  // ⭐⭐ 2026-10-21（用户：「PS 里打开液化、Camera Raw，会显示插件已断开连接，然后强制弹出要我点是否等待。
  //   这个东西就正常等就好了，弹出提示不至于，不要强行让我去选 Yes or No」）：
  //   液化 / Camera Raw 这类全屏窗口开着时，PS 会把插件整个停住 —— 看着像断开，关掉窗口就回来。
  //   ⇒ 没动静时【先不弹卡】，只把连接状态写成「等 Photoshop 回来」，在跑的任务照常等；
  //     连着 BRIDGE_PAUSE_NOTICE_MS（10 分钟）都没回来才弹一张普通提醒（L2，能直接关，不逼人二选一）。
  //   ⚠ 原来正在跑任务时弹的是 L3「继续等 / 放弃这些任务」—— 不再弹；想放弃某一单，在任务卡上照常取消。
  if(!bridgeWasAlive||bridgeDownReported) return;
  if(!bridgePausedSince){bridgePausedSince=Date.now();linkRuntime.waitingPs=true;refreshLinkStatusInPlace();}
  if(Date.now()-bridgePausedSince<BRIDGE_PAUSE_NOTICE_MS) return;
  bridgeDownReported=true;
  refreshLinkStatusInPlace();
  const busy=(typeof aiActiveCount==='function')?aiActiveCount():0;
  const silentSec=last?Math.round((Date.now()-last)/1000):0;
  const ctx={'最后一次响应':silentSec?(silentSec+' 秒前'):'从来没有过','在跑的任务':busy};
  // ⭐⭐ 2026-10-05 诊断（用户报：PS 放后台一会儿，桌面板就报『插件断开了』）。
  //   用户拍的是"先加诊断再改"，所以这里【不改判据】，只把证据摆到报错卡上。
  //   要分清的两件事：
  //     · 面板真的被关了 / UXP 崩了 → 它压根不会再上报，lag 也不会有新的
  //     · Photoshop 不在前台、宿主把定时器拖慢 → UXP 那边量到的大 lag 会先到这儿
  //   看到"插件拖慢了 N 秒"就基本可以定性是后者（即误报），下一轮才动阈值/判据。
  const lag=linkRuntime.pollLag;
  if(lag&&lag.lagMs>0){
    const lagSec=Math.round(lag.lagMs/1000);
    const fresh=lag.at&&(Date.now()-Date.parse(lag.at))<BRIDGE_SILENT_MS*2;
    ctx['插件上次被拖慢']=lagSec+' 秒'+(fresh?'（刚发生）':'（较久以前）');
    if(lag.visibility)ctx['它自报的可见性']=String(lag.visibility);
  }else{
    ctx['插件自报拖慢']='没有 —— 更像面板被关掉/退出了';
  }
  if(!window.ERR) return;
  // 10 分钟都没回来：一张普通提醒，不管有没有任务在跑都一样（不再弹 L3 逼人选「继续等 / 放弃」）
  ctx['已经等了']=Math.round((Date.now()-bridgePausedSince)/60000)+' 分钟';
  bridgeDownCard=ERR.report('BRIDGE_DISCONNECTED',{
    message:busy>0?('Photoshop 插件 '+silentSec+' 秒没有响应了，还有 '+busy+' 个任务在等它（任务没取消，插件回来会接着做；不想等了就在任务卡上取消）')
      :('桥有 '+silentSec+' 秒没有任何响应了'),
    context:ctx});
}
setInterval(checkBridgeAlive, BRIDGE_CHECK_MS);

function linkIso(){ return new Date().toISOString(); }
function linkSize(value){
  if(value==null) return 0;
  if(typeof value==='string') return value.length;
  if(value && typeof value==='object' && value.imageBase64) return value.imageBase64.length;
  try{return JSON.stringify(value).length;}catch(_){return 0;}
}
function linkPanelForZone(zone){
  return document.querySelector('#dcBody .link-panel[data-link-zone="'+String(zone)+'"]');
}
function linkActionRowHtml(action){
  const name=Array.isArray(action)?action[0]:action&&action.name;
  const fallback=Array.isArray(action)?action[1]:action&&action.label;
  const meta=linkActionMeta(name,fallback);
  return '<div class="link-action-row"><div class="link-action-copy">'+
    '<strong>'+escapeHtml(meta.label||name)+'</strong><code>'+escapeHtml(name||'')+'</code>'+ 
    '<small><b>做什么：</b>'+escapeHtml(meta.what||'')+'</small>'+ 
    '<small><b>前置：</b>'+escapeHtml(meta.requires||'')+'</small>'+ 
    '<small><b>参数：</b>'+escapeHtml(meta.params||'')+'</small>'+ 
    '</div><button data-link-ps-action="'+escapeHtml(name||'')+'">执行</button></div>';
}
function linkActionSignature(){ return JSON.stringify(linkRuntime.actions||[]); }
function refreshLinkActionsInPlace(){
  const panel=linkPanelForZone(3); if(!panel) return false;
  const list=panel.querySelector('.link-action-list'); if(!list) return false;
  const signature=linkActionSignature();
  if(list.dataset.signature===signature) return true;
  const top=list.scrollTop;
  list.innerHTML=(linkRuntime.actions||[]).map(linkActionRowHtml).join('');
  list.dataset.signature=signature;
  list.scrollTop=top;
  bindLinkDetail(list);
  return true;
}
function refreshLinkStatusInPlace(){
  const panel=linkPanelForZone(zoneSel); if(!panel) return false;
  const connected=linkRuntime.connected;
  const state=panel.querySelector('.link-state');
  const connection=panel.querySelector('[data-link-connection]');
  const statusEl=panel.querySelector('[data-link-test-status]');
  const testKey=zoneSel===0?'capture':zoneSel===1?'transfer':zoneSel===2?'generate':'control';
  const test=linkRuntime.tests[testKey];
  if(state){
    state.classList.toggle('ok',connected && (!test || test.status!=='failed'));
    state.classList.toggle('err',!!test && test.status==='failed');
  }
  if(connection) connection.textContent=connected?(linkRuntime.background?'UXP 已连接 · PS 在后台':'UXP 已连接'):(linkRuntime.waitingPs?'等 Photoshop 回来（可能开着液化 / Camera Raw 之类的窗口）':'等待 UXP 连接');
  if(statusEl) statusEl.textContent=test?linkStatusText(test):'';
  return true;
}
function linkDynamicHtml(zone){
  if(zone===0){
    return linkRuntime.capture ? '<div class="devrow"><span>最近图片</span><span class="dv-val">'+escapeHtml((linkRuntime.capture.width||0)+'×'+(linkRuntime.capture.height||0))+'</span></div>' : '';
  }
  if(zone===1){
    const img=linkRuntime.generated||linkRuntime.capture;
    return (img?'<img class="link-thumb" src="'+linkImageSrc(img)+'" alt="最近链路图片">':'')+
      '<div class="devrow"><span>输入来源</span><span class="dv-val">'+(linkRuntime.generated?'生成占位图':linkRuntime.capture?'最近抓取图':'固定占位图')+'</span></div>';
  }
  if(zone===2){
    return linkRuntime.generated?'<img class="link-thumb" src="'+linkImageSrc(linkRuntime.generated)+'" alt="生成占位图">':'';
  }
  return '';
}
function refreshLinkDynamicInPlace(){
  const panel=linkPanelForZone(zoneSel); if(!panel) return false;
  const dynamic=panel.querySelector('[data-link-dynamic]'); if(!dynamic) return false;
  dynamic.innerHTML=linkDynamicHtml(zoneSel);
  return true;
}
function logEntryHtml(l){
  return '<div class="log-entry '+(l.level==='error'?'err':l.level==='success'?'ok':'')+'"><div class="log-head"><span>'+escapeHtml(l.direction||'')+' · '+escapeHtml(l.action||'')+'</span><span>'+escapeHtml(String(l.at||'').slice(11,19))+'</span></div><div class="log-msg">'+escapeHtml(l.message||'')+'</div></div>';
}
function visibleLinkLogs(kind=zoneSel){
  let logs=linkRuntime.logs.slice();
  if(kind===1) logs=logs.filter(l=>String(l.direction||'').indexOf('UXP')>=0||String(l.direction||'').indexOf('UI')>=0);
  return logs;
}
function refreshLogDetailInPlace(){
  const panel=document.querySelector('#dcBody .link-panel[data-log-zone]'); if(!panel) return false;
  const kind=Number(panel.dataset.logZone)||0;
  panel.querySelectorAll('[data-log-show]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.logShow)===kind)));
  panel.querySelectorAll('[data-log-count]').forEach(el=>{el.textContent=linkRuntime.logs.length+' 条';});
  const list=panel.querySelector('[data-log-list]');
  if(list){
    const top=list.scrollTop;
    const logs=visibleLinkLogs(kind);
    list.innerHTML=logs.length?logs.slice().reverse().map(logEntryHtml).join(''):'<div class="devrow"><span>暂无日志</span><span class="dv-val">等待链路事件</span></div>';
    list.scrollTop=top;
  }
  return true;
}
function addLinkLog(entry){
  const row=Object.assign({at:linkIso(),level:'info',direction:'UI',message:''},entry||{});
  linkRuntime.logs.push(row);
  if(linkRuntime.logs.length>1000) linkRuntime.logs.splice(0,linkRuntime.logs.length-1000);
  window.V7MainCardShortcuts?.refresh('debug');
  if(document.querySelector('#dcBody [data-log-list]')&&!refreshLogDetailInPlace.pending){
    refreshLogDetailInPlace.pending=true;
    requestAnimationFrame(()=>{refreshLogDetailInPlace.pending=false;refreshLogDetailInPlace();});
  }
}
function setLinkTest(key,status,message){
  const test=linkRuntime.tests[key]; if(!test) return;
  test.status=status; test.message=message||''; test.at=linkIso();
  refreshLinkStatusInPlace();
}
function linkStatusClass(test){ return test.status==='success'?'ok':test.status==='failed'?'err':''; }
function linkStatusText(test){
  const map={idle:'未运行',queued:'排队中',running:'执行中',success:'成功',failed:'失败'};
  return map[test.status]||test.status;
}
function linkResultMessage(result){
  if(result && result.success) return '成功'+(result.data&&result.data.width?' · '+result.data.width+'×'+result.data.height:'');
  return (result&&result.error&&result.error.message)||'执行失败';
}
// PS 开着对话框 / 正在自由变换时，batchPlay 抛 number=9「host is in a modal state」。
//   插件把这个数字原样当错误码传上来 → 报错卡标题只有「出了点问题」、错误码「9」
//   （10-21 查遥测：1.9.3 传回时一天十几次）。在这里统一认出来，老插件也管用。
function normalizePsError(error){
  if(!error||typeof error!=='object') return error;
  const code=String(error.code==null?'':error.code);
  if(code==='9'||/host is in a modal state/i.test(String(error.message||''))) return Object.assign({},error,{code:'PS_BUSY'});
  // 10-25（docs/286 P0-4）：老插件把「没框选区」报成 SELECTION_CAPTURE_FAILED（原文里带 NO_SELECTION）⇒ 这里认回来，老插件也管用
  if((code==='SELECTION_CAPTURE_FAILED'||code==='CAPTURE_FAILED')&&/NO_SELECTION/.test(String(error.message||''))) return Object.assign({},error,{code:'NO_SELECTION'});
  return error;
}
// ⭐⭐ 2026-10-25（用户反馈 #16，docs/285 P0-1）：回执比「登记」先到就被丢 ⇒ 生成卡卡在「等待 Photoshop 图片 0%」、完成音效不响。
//   外壳 link_enqueue 是【先放进队列、再把编号还给前端】；插件长轮询插空就把活干完、回执先到了，
//   这时 linkQueue 还没 pending.set ⇒ linkHandleResult 找不到记录，after / afterError 永远不执行，也没超时。
//   ⇒ ① 找不到记录的回执先暂存（LINK_EARLY_MS 内），登记那一刻补上；
//     ② 每个请求有超时（LINK_TIMEOUT_MS，快的只读动作更短），到点按失败收尾，别让界面永远等；
//     ③ 超时以后才到的回执只记一条日志，不再执行（已经按失败处理过了）。
var LINK_EARLY_MS=30000;
var LINK_TIMEOUT_MS=180000;      // 传回 / 抓大图在 PS 忙的时候真能拖很久 —— 宁长勿短，短了会把已经贴进去的图报成失败
var LINK_FAST_ACTIONS={'ps.doc.listOpen':20000,'ps.doc.canvasThumb':30000,'ps.group.stampProbe':20000};
function linkRecTimeout(action,meta){
  const own=meta&&Number(meta.timeoutMs);
  return own>0?own:(LINK_FAST_ACTIONS[action]||LINK_TIMEOUT_MS);
}
function linkSweep(now){
  now=now||Date.now();
  const early=linkRuntime.early||(linkRuntime.early=new Map());
  early.forEach((v,id)=>{if(now-v.at>LINK_EARLY_MS) early.delete(id);});
  const dead=linkRuntime.timedOut||(linkRuntime.timedOut=new Map());
  dead.forEach((at,id)=>{if(now-at>10*60000) dead.delete(id);});
  linkRuntime.pending.forEach((rec,id)=>{
    if(!rec.registeredAt||now-rec.registeredAt<rec.timeoutMs) return;
    linkRuntime.pending.delete(id);
    dead.set(id,now);
    const result={requestId:id,action:rec.action,success:false,error:{code:'BRIDGE_RESULT_TIMEOUT',message:'Photoshop 那边 '+Math.round(rec.timeoutMs/1000)+' 秒没回话（插件可能断了或 PS 正忙），这一步按失败处理'}};
    addLinkLog({direction:'UI',level:'error',message:rec.action+' · 等回执超时',requestId:id,action:rec.action});
    linkSettle(rec,result);
  });
}
// 只跟「这个请求自己」有关的收尾（测试格子、after / afterError）—— 回执早到时，登记那一刻补跑的就是这一段
// 超时巡检：有请求在等时每 5 秒看一眼，都收尾了就停（⚠ 截源码跑的老测试里可能没有 setInterval）
function linkEnsureSweeper(){
  if(linkRuntime.sweeper||typeof setInterval!=='function') return;
  linkRuntime.sweeper=setInterval(()=>{
    linkSweep();
    if(!linkRuntime.pending.size&&!(linkRuntime.early&&linkRuntime.early.size)){clearInterval(linkRuntime.sweeper);linkRuntime.sweeper=0;}
  },5000);
}
function linkSettle(rec,result){
  const data=result.data||null;
  if(rec.testKey) setLinkTest(rec.testKey,result.success?'success':'failed',linkResultMessage(result));
  if(result.success&&typeof rec.after==='function'){
    try{rec.after(data,result);}catch(e){addLinkLog({level:'error',message:'后续链路步骤异常: '+e.message});}
  }
  if(!result.success&&typeof rec.afterError==='function'){
    try{rec.afterError(result);}catch(_){}
  }
}
function linkHandleResult(result){
  if(!result || !result.requestId) return;
  if(result.error) result.error=normalizePsError(result.error);
  const rec=linkRuntime.pending.get(result.requestId);
  if(rec) linkRuntime.pending.delete(result.requestId);
  const data=result.data||null;
  const message=linkResultMessage(result);
  const late=!rec&&linkRuntime.timedOut&&linkRuntime.timedOut.has(result.requestId);
  if(!(rec&&rec.quiet&&result.success)) addLinkLog({direction:'UXP → UI',level:late?'warn':result.success?'success':'error',message:result.action+' · '+message+(late?'（超时以后才到，已经按失败处理过，不再执行后续）':''),requestId:result.requestId,action:result.action,duration:result.startedAt&&result.finishedAt?new Date(result.finishedAt)-new Date(result.startedAt):0,inputBytes:rec?rec.inputBytes:0,outputBytes:linkSize(data)});
  if(result.success&&(['ps.selection.capture','ps.selection.captureRef','ps.selection.recaptureRef','ps.selection.captureForChat','captureRefImage','recaptureRefImage','captureForChat'].indexOf(result.action)>=0)&&data){
    linkRuntime.capture=data;
    addLinkLog({direction:'UI',level:'info',message:'已保存最近一次抓取图，可用于传回和生成'});
  }
  if(result.success&&result.action==='ps.layer.place') linkRuntime.lastRequest=result.requestId;
  if(rec){ linkSettle(rec,result); return; }
  // 找不到记录：多半是比「队列已接受」先到了 —— 先存着，linkQueue 登记时补上（本机假请求 local-… 不存）
  if(!late&&String(result.requestId).indexOf('link-')===0){
    linkSweep();
    linkRuntime.early.set(result.requestId,{result,at:Date.now()});
  }
}
// ⭐ 2026-10-20（docs/256 第 9 条 · 插件那一批）：PS 联动插件旧了要说 ——
//   学员软件 1.9.3、插件还是 1.8.1：软件拿到了插件版本号却从来不比，PS 里的新操作悄悄出错（那位学员日志里一串）。
//   ⚠ 不跟「软件版本」比：插件版本号每次发版都跟着软件一起升，那样每次发版都得所有人重装插件。
//     只跟 BRIDGE_MIN_VERSION 比 —— 【插件代码真改了】才往上调（1.9.4 改了替换 / 打组 / 抠像蒙版 / 后台抓图）。
//   ⚠ 同一个插件版本一次运行只说一次（插件断了重连会反复报 ready）。
var BRIDGE_MIN_VERSION='1.9.4';
var bridgeOutdatedWarned='';
function bridgeVersionLess(a,b){
  const pa=String(a).split('.').map(n=>parseInt(n,10)||0),pb=String(b).split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<3;i++){ if((pa[i]||0)!==(pb[i]||0)) return (pa[i]||0)<(pb[i]||0); }
  return false;
}
function checkBridgeVersion(v){
  const version=String(v||'').trim();
  if(!/^\d+\.\d+\.\d+/.test(version)||!bridgeVersionLess(version,BRIDGE_MIN_VERSION)||bridgeOutdatedWarned===version) return false;
  bridgeOutdatedWarned=version;
  // ⭐ 2026-10-24（docs/273 #10「重装 3 次还是 1.9.3」，用户定「软件加个重复检测」）：
  //   先让外壳把这台电脑上所有 PS 里的插件副本列一遍再弹卡 —— 重装了还旧，多半是 PS 加载的是另一份。
  //   ⚠ 外壳没有这个接口（Electron 开发壳 / 老外壳）就照旧马上弹原来那张卡。
  const copiesFn=window.uiwin&&window.uiwin.photoshop&&window.uiwin.photoshop.bridgeCopies;
  if(typeof copiesFn!=='function'){ bridgeOutdatedReport(version,null); return true; }
  Promise.resolve().then(()=>copiesFn()).then(r=>bridgeOutdatedReport(version,r&&r.ok&&Array.isArray(r.copies)?r.copies:null),()=>bridgeOutdatedReport(version,null));
  return true;
}
function bridgeOutdatedReport(version,copies){
  if(!window.ERR) return;
  const rows=Array.isArray(copies)?copies:[];
  const newer=rows.filter(c=>!c.legacy&&/^\d+\.\d+\.\d+/.test(String(c.version||''))&&!bridgeVersionLess(c.version,BRIDGE_MIN_VERSION));
  let message='现在装的 PS 联动插件是 '+version+'，这一版软件需要 '+BRIDGE_MIN_VERSION+' 以上。先保存并关掉 Photoshop，再点「去重新安装」。';
  if(rows.length>=2){
    message='这台电脑上找到 '+rows.length+' 份 PS 联动插件，Photoshop 现在用的是旧的 '+version+' 那份 —— 重装只会更新其中一份，所以一直是旧的。'
      +'先保存并关掉 Photoshop，把详情里标「旧」的那几个文件夹删掉（或挪到别处），再点「去重新安装」。';
  }else if(rows.length===1&&newer.length===1){
    message='插件文件已经是 '+rows[0].version+' 了，但 Photoshop 用的还是 '+version+'。先把 Photoshop 完全关掉再打开；还是旧的话，PS 可能从别的位置加载了一份旧插件，点「去重新安装」核对装到了哪个 Photoshop。';
  }
  const context={};
  rows.forEach((c,i)=>{
    const old=c.legacy||!/^\d+\.\d+\.\d+/.test(String(c.version||''))||bridgeVersionLess(c.version,BRIDGE_MIN_VERSION);
    context['插件副本 '+(i+1)]=(old?'【旧】':'')+(c.version||'版本未知')+(c.legacy?'（老插件）':'')+' · '+String(c.path||'')
      +(c.photoshopRunning?' · 这个 Photoshop 正开着':'')+(c.where==='adobe-external'?' · 从 Adobe 插件管理装的':'');
  });
  if(Array.isArray(copies)&&!rows.length) context['插件副本']='一份都没找到（PS 可能装在找不到的位置）';
  ERR.report('UXP_BRIDGE_OUTDATED',{message,context,
    confirm:'去重新安装',onConfirm:()=>{try{if(window.V7Setup&&typeof V7Setup.open==='function')V7Setup.open();}catch(_){}},cancel:'稍后'});
}
// ⭐ 2026-10-24（V7待办/08，用户定）：插件版本跟软件版本不一样 ⇒ 报错栏里常驻一张「插件需要更新」，
//   关不掉（persistent），带「一键更新」；更新好、插件重新报到且版本对上了，自动收掉。
//   ⚠ 这跟上面 BRIDGE_MIN_VERSION 那张不一样：那张是「旧到会出错」的诊断卡（会列出电脑上几份插件），
//     这张是「版本号对不上就提醒」—— 用户定每次发版插件都要跟着更新（只提醒，不挡任何操作）。
//   兜底：读不到插件版本 / 软件版本 ⇒ 不显示；插件比软件还新 ⇒ 不显示（开发时常见）。
let bridgeUpdateCard=null, bridgeUpdateFor='';
function bridgeUpdateCheck(bridgeVersion){
  const plugin=String(bridgeVersion||'').trim(), app=String(window.V7_VERSION&&window.V7_VERSION.app||'').trim();
  const need=/^\d+\.\d+\.\d+/.test(plugin)&&/^\d+\.\d+\.\d+/.test(app)&&bridgeVersionLess(plugin,app);
  if(!need){
    if(bridgeUpdateCard){ try{ bridgeUpdateCard.close(); }catch(_){} bridgeUpdateCard=null; bridgeUpdateFor=''; addLinkLog({direction:'UI',level:'success',message:'插件已是 '+plugin+'，更新提醒已收起'}); }
    return false;
  }
  bridgeUpdateShow(plugin,app);
  // PS 开着、插件报到说自己旧 ⇒ 开始「等 PS 关掉就自动装」（已经在等 / 装过 / 失败过就不重复起）
  if(!bridgeAuto.phase) bridgeAutoUpdate('ready');
  return true;
}
function bridgeOpenSetup(){
  try{ if(window.V7Setup&&typeof V7Setup.open==='function'){ V7Setup.open(); return; } }catch(error){ ERR.report('UI_ACTION_FAILED',{message:'打不开安装插件的页面：'+String(error&&error.message||error)}); return; }
  ERR.report('UI_ACTION_FAILED',{message:'这个环境打不开安装插件的页面。请照详情里的「手动更新」做。'});
}
// 常驻卡按自动更新走到哪一步换文字（卡不能改字 ⇒ 换一张）。同一对版本 + 同一步只挂一张（断线重连会反复报到）。
function bridgeUpdateShow(plugin,app){
  const phase=bridgeAuto.phase, key=plugin+'>'+app+'|'+phase;
  if(bridgeUpdateCard&&bridgeUpdateFor===key) return;
  if(bridgeUpdateCard){ try{ bridgeUpdateCard.close(); }catch(_){} bridgeUpdateCard=null; }
  if(!window.ERR) return;
  bridgeUpdateFor=key;
  const head='PS 里的联动插件是 '+(plugin||'旧版')+'，软件是 '+app+'。';
  const message=phase==='waiting'?head+'先保存并关掉 Photoshop，软件会自己把插件装好，不用点别的。'
    :phase==='installing'?'正在把 PS 联动插件更新到 '+app+' …… 弹出确认框点「确认」；Windows 再问「是否允许更改」点「是」。'
    :phase==='failed'?'插件没能自动更新：'+(bridgeAuto.error||'原因不明')+'。先关掉 Photoshop 再点「一键更新」重试，还不行照详情里的「手动更新」做。'
    :phase==='done'||phase==='restart'||phase==='current'?'插件文件已经是 '+app+' 了，Photoshop 用的还是 '+(plugin||'旧版')+'。把 Photoshop 完全关掉再打开；还是旧的点「打开安装页」核对装到了哪个 PS。'
    :head+'点「一键更新」：先保存并关掉 Photoshop，装好后再打开 PS。';
  const context={'插件版本':plugin||'（PS 没开，读的插件文件）','软件版本':app,'手动更新':'设置 → Photoshop → 重新安装插件（要先关掉 Photoshop）；装完打开 PS，在「增效工具」里打开修图轮椅面板。一键更新失败时照这个做。'};
  if(phase==='failed'&&bridgeAuto.error) context['没装上的原因']=bridgeAuto.error;
  const manual=()=>{ Promise.resolve(bridgeAutoUpdate('manual')).then(r=>{ if(r==='unsupported'||r==='none'||r==='error') bridgeOpenSetup(); }); };
  const actions=phase==='installing'?[]
    :phase==='waiting'||phase==='done'||phase==='restart'||phase==='current'?[{key:'bridge-setup',label:'打开安装页',run:bridgeOpenSetup}]
    :[{key:'bridge-update',label:'一键更新',primary:true,run:manual}];
  bridgeUpdateCard=ERR.report('UXP_BRIDGE_UPDATE_NEEDED',{message,context,persistent:true,actions})||null;
}
// ⭐ 2026-10-24（用户：「一键更新的时候可不可以顺便把插件更新了」）：插件跟着软件自动更新。
//   软件更新完重开 ⇒ 不等 PS 连上，直接读选中那个 PS 里插件文件是几版，比软件自带的旧就：
//     · PS 关着 ⇒ 马上装（两个壳装之前都会弹一个「确认」框，装在 Program Files 下还会再弹一次「是否允许更改」）；
//     · PS 开着 ⇒ 卡上写「关掉 Photoshop 后自动装好」，每 10 秒看一眼，关了就装；
//     · 装失败（「是否允许」点了否 / 没权限 …）⇒ 卡上写原因 + 手动步骤；同一版失败过下次开机不再自己弹，点「一键更新」重试。
//   ⚠ 只给【装过插件】的 PS 更新，从没装过的不替他装；教程壳的 photoshop 是假的 ⇒ 不跑。
//   ⚠ 只用两个壳都有的 discover / inspect / install（铁律 14），不加新外壳接口。
const BRIDGE_AUTO_FAIL_KEY='wheelchair.v7.bridge.autoUpdateFailed.v1', BRIDGE_AUTO_POLL_MS=10000, BRIDGE_AUTO_START_MS=6000;
let bridgeAuto={phase:'',busy:false,timer:0,error:''};
function bridgeAutoReason(r){
  if(r&&r.cancelled||/^UXP_(ELEVATION_CANCELLED|CONFIRMATION_REQUIRED)/.test(String(r&&r.error||''))) return '「是否允许更改」那一步点了否（或者取消了）';
  const code=String(r&&r.error||'UXP_INSTALL_FAILED').split(':')[0];
  const known={UXP_PERMISSION_REQUIRED:'没有权限写 Photoshop 的插件文件夹',UXP_ELEVATION_FAILED:'没拿到管理员权限',UXP_TARGET_CONFLICT:'PS 插件文件夹里同名的那份不是修图轮椅的插件',
    UXP_PROCESS_CHECK_FAILED:'查不了 Photoshop 开没开',
    UXP_PATH_UNSAFE:'插件文件夹是个快捷方式 / 链接，不敢往里写',UXP_PACKAGE_INVALID:'软件自带的插件文件不完整，重装一次软件',UXP_RECOVERY_REQUIRED:'装到一半出错，旧插件没能放回去'};
  return (known[code]||'安装出错')+'（'+code+(r&&r.detail?' · '+String(r.detail).slice(0,120):'')+'）';
}
function bridgeAutoFailed(){ try{ const v=JSON.parse(localStorage.getItem(BRIDGE_AUTO_FAIL_KEY)||'null'); return v&&typeof v==='object'?v:null; }catch(_){ return null; } }
// 找要更新的：保存过的那个 PS 排第一，其余也看一眼；rows 是「装过 + 比软件自带的旧」的，current 是装过且已经是新的有几个
async function bridgeAutoTargets(api){
  let saved='';
  try{ saved=String((JSON.parse(localStorage.getItem('wheelchair.v7.setup.local.v1')||'{}')||{}).photoshopPath||''); }catch(_){}
  const found=await api.discover(saved);
  const list=(found&&found.ok&&Array.isArray(found.candidates)?found.candidates:[]).slice().sort((a,b)=>(b.path===saved)-(a.path===saved));
  const rows=[]; let current=0, running=false;
  for(const candidate of list){
    let info=null; try{ info=await api.inspect(candidate); }catch(_){}
    if(info&&info.ok&&info.running===true) running=true;
    if(!info||!info.ok||!info.installed) continue;
    const have=String(info.installedVersion||''), pkg=String(info.packageVersion||'');
    if(/^\d+\.\d+\.\d+/.test(pkg)&&(!/^\d+\.\d+\.\d+/.test(have)||bridgeVersionLess(have,pkg))) rows.push({candidate,info});
    else current++;
  }
  return {rows,current,running};
}
function bridgeAutoSet(phase,plugin,app,error){
  bridgeAuto.phase=phase; bridgeAuto.error=error||'';
  if(phase==='done'||phase==='current'){
    // done = 我们刚装好（装之前确认过 PS 关着）；current = 别处装好了（安装页手动装 / 别的途径），PS 也关着。
    //   两种都是没什么要用户做的了 ⇒ 收卡、提示一句（之后 PS 开了插件还报旧版，上面会换成「重开 PS」那张）
    if(bridgeUpdateCard){ try{ bridgeUpdateCard.close(); }catch(_){} bridgeUpdateCard=null; bridgeUpdateFor=''; }
    if(window.UI&&typeof UI.toast==='function') UI.toast(phase==='done'?'PS 联动插件已自动更新到 '+app+'，打开 Photoshop 就是新的':'PS 联动插件已经是 '+app+' 了，打开 Photoshop 就是新的','ok',5000);
    return;
  }
  if(phase) bridgeUpdateShow(plugin,app);
}
async function bridgeAutoUpdate(reason){
  const api=window.uiwin&&window.uiwin.photoshop;
  if(window.__V7_TUTORIAL__||!api||!['discover','inspect','install'].every(k=>typeof api[k]==='function')) return 'unsupported';
  if(bridgeAuto.busy) return 'busy';
  bridgeAuto.busy=true; clearTimeout(bridgeAuto.timer); bridgeAuto.timer=0;
  const wait=(plugin,app)=>{ bridgeAutoSet('waiting',plugin,app); bridgeAuto.timer=setTimeout(()=>bridgeAutoUpdate('poll'),BRIDGE_AUTO_POLL_MS); return 'waiting'; };
  try{
    const {rows:targets,current,running}=await bridgeAutoTargets(api);
    if(!targets.length){
      // ⭐ 10-24 用户：「PS 关了、插件也更新了，提示还一直挂着说不符，直到下次开 PS 才消失 —— 严重违反设计原则」。
      //   卡上写的必须是【现在】的真实情况，不能只认插件上次报到的版本：
      //     · 文件已经是新的、PS 关着 ⇒ 马上收卡（下次开 PS 加载的就是新的）；
      //     · 文件已经是新的、PS 还开着 ⇒ 卡改成「重开 PS」；
      //     · 什么都没找到 / 没装过 ⇒ 不动（核对不了，卡照旧，点「一键更新」去安装页）。
      if(current&&bridgeUpdateCard&&reason!=='startup'){
        if(running) bridgeAutoSet('restart',linkRuntime.bridgeVersion||'',String(window.V7_VERSION&&window.V7_VERSION.app||''));
        else bridgeAutoSet('current',linkRuntime.bridgeVersion||'',String(window.V7_VERSION&&window.V7_VERSION.app||''));
      }
      return 'none';
    }
    const pkg=String(targets[0].info.packageVersion), plugin=linkRuntime.connected&&linkRuntime.bridgeVersion||String(targets[0].info.installedVersion||'');
    const failed=bridgeAutoFailed();
    if(reason!=='manual'&&failed&&failed.version===pkg){ bridgeAutoSet('failed',plugin,pkg,failed.error); return 'failed'; }
    if(targets.some(t=>t.info.running===true)) return wait(plugin,pkg);
    bridgeAutoSet('installing',plugin,pkg);
    addLinkLog({direction:'UI',level:'info',message:'自动更新 PS 联动插件 '+plugin+' → '+pkg+'（'+targets.length+' 个 Photoshop）'});
    for(const t of targets){
      let r; try{ r=await api.install(t.candidate); }catch(error){ r={ok:false,error:String(error&&error.message||error)}; }
      if(r&&r.ok) continue;
      const code=String(r&&r.error||'');
      if(code==='UXP_PS_RUNNING'||code==='UXP_INSTALL_BUSY') return wait(plugin,pkg);   // 正好这时候开了 PS / 安装页也在装 ⇒ 接着等
      const why=bridgeAutoReason(r);
      try{ localStorage.setItem(BRIDGE_AUTO_FAIL_KEY,JSON.stringify({version:pkg,error:why,at:new Date().toISOString()})); }catch(_){}
      addLinkLog({direction:'UI',level:'warn',message:'插件自动更新失败：'+why});
      bridgeAutoSet('failed',plugin,pkg,why);
      return 'failed';
    }
    try{ localStorage.removeItem(BRIDGE_AUTO_FAIL_KEY); }catch(_){}
    addLinkLog({direction:'UI',level:'success',message:'PS 联动插件已自动更新到 '+pkg});
    bridgeAutoSet('done',plugin,pkg);
    return 'done';
  }catch(error){
    addLinkLog({direction:'UI',level:'warn',message:'插件自动更新检查出错：'+String(error&&error.message||error)});
    return 'error';
  }finally{
    bridgeAuto.busy=false;
    // 卡还挂着 ⇒ 接着每 10 秒核对一次真实情况（PS 关没关、文件换没换），不等插件下次报到
    if(bridgeUpdateCard&&!bridgeAuto.timer) bridgeAuto.timer=setTimeout(()=>{ bridgeAuto.timer=0; bridgeAutoUpdate('poll'); },BRIDGE_AUTO_POLL_MS);
  }
}
// 安装页（设置 → Photoshop 联动）手动装好的那一刻也核对一次，不用等那 10 秒
if(typeof window.addEventListener==='function') window.addEventListener('wheelchair:bridge-installed',()=>{ if(bridgeUpdateCard) bridgeAutoUpdate('installed'); });
setTimeout(()=>bridgeAutoUpdate('startup'),BRIDGE_AUTO_START_MS);
function linkHandleEvent(event){
  if(!event) return;
  if(event.type==='ready'){
    linkRuntime.connected=true; linkRuntime.bridgeVersion=event.bridgeVersion||'';
    checkBridgeVersion(linkRuntime.bridgeVersion);
    bridgeUpdateCheck(linkRuntime.bridgeVersion);
    // 插件报到 = 连回来了：断开卡马上收掉，不用等下一轮 5 秒的检查（2026-10-18）
    if(bridgeDownReported){ bridgeDownReported=false; closeBridgeDownCard(); }
    if(Array.isArray(event.actions)&&event.actions.length) linkRuntime.actions=event.actions.map(a=>{
      const name=Array.isArray(a)?a[0]:(a.name||a.action||'');
      const known=LINK_DEFAULT_ACTIONS.find(item=>item[0]===name);
      const meta=linkActionMeta(name,Array.isArray(a)?a[1]:a.label||known&&known[1]);
      return [name,meta.label||name];
    }).filter(a=>a[0]);
    addLinkLog({direction:'UXP → UI',level:'success',message:'UXP 已连接'+(linkRuntime.bridgeVersion?' · '+linkRuntime.bridgeVersion:'')});
    refreshLinkStatusInPlace();
    refreshLinkActionsInPlace();
  }else if(event.type==='status'){
    linkRuntime.connected=event.connected!==false;
    addLinkLog({direction:'UXP → UI',level:'info',message:event.message||'桥状态更新',action:event.action,requestId:event.requestId});
    refreshLinkStatusInPlace();
  }else if(event.type==='log'){
    // ⭐ 2026-10-05 诊断：UXP 报上来的「轮询被延迟 N 毫秒」要单独记一笔。
    //   它是判断"Photoshop 插件到底断没断"的关键证据 ——
    //   桌面板只看得到"最后响应是 N 秒前"，分不清面板被关了还是被宿主节流了；
    //   这个 lag 是 UXP 自己量出的定时器空档，只有它能说明是后者。
    if(event.pollLagMs!=null){
      linkRuntime.pollLag={at:linkIso(),lagMs:Number(event.pollLagMs)||0,pollMs:event.pollMs,visibility:event.visibility};
    }
    addLinkLog({direction:'UXP → UI',level:event.level||'info',message:event.message||'',action:event.action,requestId:event.requestId});
  }
}
function linkQueue(action,params,meta){
  const testKey=meta&&meta.testKey;
  if(testKey) setLinkTest(testKey,'queued','已进入队列');
  const inputBytes=linkSize(params);
  // meta.quiet：示波器实时轮询这类每秒一次的只读请求不写「已排队」，失败才记（否则调试日志被刷满，2026-09-29）
  if(!(meta&&meta.quiet)) addLinkLog({direction:'UI → UXP',level:'info',message:'已排队 '+action,action,requestId:'待分配',inputBytes});
  if(!window.uiwin||!window.uiwin.link||!window.uiwin.link.enqueue){
    const fake={requestId:'local-'+Date.now(),action,success:false,error:{code:'BRIDGE_UNAVAILABLE',message:'当前 UI 没有暴露链路桥接口'}};
    if(testKey) setLinkTest(testKey,'failed',fake.error.message); linkHandleResult(fake);
    if(meta&&typeof meta.afterError==='function'){
      try{meta.afterError(fake);}catch(_){ }
    }
    return Promise.resolve(fake);
  }
  return window.uiwin.link.enqueue(action,params||{}).then(reply=>{
    if(!reply||!reply.ok) throw new Error(reply&&reply.error||'入队失败');
    const rec=Object.assign({action,testKey,inputBytes},meta||{},{registeredAt:Date.now(),timeoutMs:linkRecTimeout(action,meta)});
    addLinkLog({direction:'UI → UXP',level:'info',message:'队列已接受 '+action,action,requestId:reply.requestId,inputBytes});
    if(testKey) setLinkTest(testKey,'running','UXP 执行中');
    // 回执已经先到了（见 linkHandleResult 上面的说明）⇒ 直接补上收尾，不进 pending
    const early=linkRuntime.early&&linkRuntime.early.get(reply.requestId);
    if(early){
      linkRuntime.early.delete(reply.requestId);
      addLinkLog({direction:'UI',level:'info',message:action+' · 回执比登记先到，已补上',action,requestId:reply.requestId});
      linkSettle(rec,early.result);
      return reply;
    }
    linkRuntime.pending.set(reply.requestId,rec);
    linkEnsureSweeper();
    return reply;
  }).catch(err=>{
    const message=err.message||String(err);
    if(testKey) setLinkTest(testKey,'failed',message);
    addLinkLog({direction:'UI',level:'error',message:'入队失败 '+action+': '+message,action});
    if(meta&&typeof meta.afterError==='function'){
      try{meta.afterError({requestId:'local-'+Date.now(),action,success:false,error:{message}});}catch(_){ }
    }
    return {ok:false,error:message};
  });
}
if(window.uiwin&&window.uiwin.link){
  window.uiwin.link.onResult(linkHandleResult);
  window.uiwin.link.onEvent(linkHandleEvent);
}
let zoneCloseTimer=null;   // closeZones 的延迟清理句柄; 弹三级时要取消它(防三级出来二级被关)
let allCloseTimer=null;     // closeAll 的延迟清理句柄; 快速展开时必须取消旧清场
// ⭐ 2026-10-19（docs/250 第 5 条，用户同意）：点按钮跳出来的二级（navigateCard），鼠标【第一次进去之前】不按「离开就收」处理。
//   自由摆放时目标卡可能在屏幕另一边，鼠标过去要经过空白 —— 原来划到半路面板就收了（易曦 10-17 视频）。
//   值是这次跳转的编号（0 = 没有）：连着点两次时，前一次被取消不会把后一次的标记清掉。
//   撤掉的时机：鼠标进到「卡 + 面板」连通区一次、closeZones / closeAll（Esc、点外面、切主卡都走 closeAll）。
let zonesOpenedByNav=0, zonesNavSeq=0;
// ⚠ 三级"是否被真的用过": 点按/滚动/换页/滚轮 任一发生即置 true。
//   用途: 没用过就把鼠标往右(非二级方向)移出三级 → 二级三级一起收(误触/看一眼就走的场景)。
//   清空时机: 切换分区(三级换内容) + 三级关闭。停留不算操作(用户定案)。
let detailUsed=false;
// ⭐ 2026-10-21（docs/261 U1）：三级里【打过字】（提示词框正在写）—— 这时点一下 PS 不能把框收掉，回来还要接着写。
//   ⚠ 只认「在输入框里打过字」，不认"点过 / 滚过"：普通面板（预设列表、缓存列表）点一下就整块留下的做法
//     会把所有面板都粘在屏幕上（tool-hub 测试实测抓到："Without a tool card, blur no longer collapses ordinary panels"）。
//   清空时机：三级换内容 / 关闭（跟 detailUsed 同步）。
let detailEditing=false;

// ── 面板折叠: 其他卡片回收, 顶卡向上收成小灵动岛 ──
const anchorEl=document.querySelector('.anchor');
const collapsePill=document.getElementById('collapsePill');
const collapsePillIcon=document.getElementById('collapsePillIcon');
const collapsePillLabel=document.getElementById('collapsePillLabel');
const UI_SCALE=1;
function prepareExternalCollapseOffset(){
  const anchorRect=anchorEl && anchorEl.getBoundingClientRect();
  if(!anchorRect) return;
  const scale=UI_SCALE;
  // 小灵动岛收起后底部约在 anchor 顶部 + 36px，其他堆向这里回收。
  const targetTop=anchorRect.top + 36*scale;
  ['tasks','errors'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el) return;
    const r=el.getBoundingClientRect();
    if(r.width || r.height || el.style.top) el.style.setProperty('--collapse-dy', (targetTop-r.top)+'px');
  });
}
function clearExternalCollapseOffset(){
  ['tasks','errors'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.style.removeProperty('--collapse-dy');
  });
}
function updateCollapsePill(){
  const card=cards[cur];
  if(!card) return;
  const icon=card.querySelector('.bc-icon');
  const name=card.querySelector('.bc-name');
  // ⚠ 预设卡没有 .bc-icon/.bc-name(卡面整个是剪影画布)，回落到 data-bglabel，
  //   否则折叠胶囊会变成空图标 + "面板"。
  // ⚠⚠ 已知遗留（不是这轮引入的，2026-09-14 查明）：
  //   `.bc-icon` 在 2026-09-13「标题搬到底栏」那次改版后【已经不存在了】，
  //   所以这里永远走 else 分支 —— 除预设卡外，折叠胶囊的图标位一直是空的。
  //   这轮【只做 emoji→SVG 的等价替换，不改这个行为】（用户要求"不要擅自增加图标"）。
  //   要不要让胶囊显示当前卡的图标，等用户定。
  if(collapsePillIcon){
    if(icon){
      collapsePillIcon.textContent = icon.textContent;
    }else if(card.dataset.card==='presets'){
      if(window.ICON) ICON.set(collapsePillIcon,'person',15); else collapsePillIcon.textContent='';
    }else{
      collapsePillIcon.textContent='';
    }
  }
  if(collapsePillLabel) collapsePillLabel.textContent = name ? name.textContent : (card.dataset.bglabel || '面板');
}
function captureCollapseSnapshot(){
  collapseSnapshot={
    cur,
    zoneOpen:zones.classList.contains('show'),
    detailOpen:detail.classList.contains('show'),
    zoneSel,
    detailUsed,
    detailEditing,
    taskPreview:document.querySelector('.task-preview.show'),
    errorDetails:[...document.querySelectorAll('.error-detail.show')]
  };
}
function restoreCollapseSnapshot(){
  const snap=collapseSnapshot;
  collapseSnapshot=null;
  if(!snap) return;

  // 折叠期间不允许切主卡，但仍以快照为准，避免未来新增入口破坏恢复。
  if(Number.isInteger(snap.cur) && snap.cur>=0 && snap.cur<N && !layoutHidden.has(snap.cur)) cur=snap.cur;
  zoneSel=Number.isInteger(snap.zoneSel) ? snap.zoneSel : 0;
  setStack();

  zones.classList.remove('closing');
  detail.classList.remove('closing');
  selectZone(zoneSel);
  if(snap.zoneOpen || snap.detailOpen){
    fillZonesNow();
    zones.classList.add('show');
    zoneOpen=true;
  }else{
    zones.classList.remove('show');
    zoneOpen=false;
  }
  if(snap.detailOpen){
    detail.classList.add('show');
    updateDetailBg();
  }else{
    detail.classList.remove('show');
  }
  detailUsed=!!snap.detailUsed;
  detailEditing=!!snap.detailEditing;

  if(snap.taskPreview && document.body.contains(snap.taskPreview)){
    snap.taskPreview.classList.add('show');
    window.__pv=snap.taskPreview;
  }
  snap.errorDetails.forEach(el=>{
    if(document.body.contains(el)) el.classList.add('show');
  });
}
function clearTransientGlows(){
  // 折叠/展开会中断正在播放的预告光、弹出光和收回光，必须同时清掉动画类与内联宽度。
  document.querySelectorAll('.edgehint,.zone-edgehint,.task-edgehint,.error-edgehint').forEach(el=>{
    el.classList.remove('recoil');
    el.style.opacity='0';
    el.style.width='0px';
  });
  // ⚠ .zone-glow/.zone-bright 以前【漏在这个名单外】(2026-09-11 补)——
  //   它俩的 .glow 从来没人摘，正是下面那个"滚动也发光"的根源。
  document.querySelectorAll('.zone-glow,.zone-bright,.task-glow,.task-bright,.error-glow,.error-bright,.detail-glow,.detail-bright').forEach(el=>{
    el.classList.remove('glow');
    el.style.opacity='0';
    el.style.width='0px';
  });
}

// ═══ 光播完就把 .glow 摘掉(2026-09-11) ═══════════════════════
//  症状: 上下滚动切主卡时, 二级卡那圈绿色弹出光会跟着亮一下 —— 不该有, 那是右滑推进才有的。
//
//  真因(不是鼠标误触发, 是 CSS 行为):
//    syncZoneKind() 每次切主卡都会执行, 它用 display:none / '' 来切二级卡。
//    而 **元素从 display:none 恢复显示时, 身上的 CSS animation 会从头重播一遍**。
//    那些光弹出时加了 .glow, 播完【从来没摘】, class 一直挂着 ——
//    于是每次恢复显示就白白重播一次, 看起来就是"滚动也发光"。
//
//  为什么"有的主卡不会": 预设卡的二级是另一套元素(.pzone), 被 :not(.pzone) 排除,
//    根本不走那行 display 切换, 所以它不闪。不是那张卡特殊。
//
//  修法: 动画结束就摘掉 .glow。摘了之后元素回到 CSS 默认态(opacity:0/width:0),
//    和动画最后一帧完全一致, 所以没有任何视觉跳变。
//  ⚠ 用事件委托挂在 document 上, 不去六个点亮处逐个改 —— 逐个改必漏,
//    而且以后新加的光也自动受益。
const GLOW_ONCE_KINDS=['zone-glow','zone-bright','task-glow','task-bright',
                       'error-glow','error-bright','detail-glow','detail-bright'];
document.addEventListener('animationend', e=>{
  const t = e.target;
  if(!t || !t.classList || !t.classList.contains('glow')) return;
  if(GLOW_ONCE_KINDS.some(c=>t.classList.contains(c))) t.classList.remove('glow');
}, true);
function setCollapsed(next){
  const value=!!next;
  if(value===isCollapsed) return;
  isCollapsed=value;
  if(isCollapsed){
    captureCollapseSnapshot();
    prepareExternalCollapseOffset();
    clearTransientGlows();
    // 先启动二级/三级的原路回收，再切换顶卡形态，避免 collapsed 规则盖住 closing 动画。
    closeAll();
    clearPreview();
  }
  if(!isCollapsed){
    if(allCloseTimer){ clearTimeout(allCloseTimer); allCloseTimer=null; }
    if(zoneCloseTimer){ clearTimeout(zoneCloseTimer); zoneCloseTimer=null; }
    // 快速展开时取消尚未完成的收场动画；具体展开内容由折叠前快照恢复。
    zones.classList.remove('closing');
    detail.classList.remove('closing');
    zones.querySelectorAll('.zone-edgehint').forEach(eh=>{ eh.style.opacity='0'; eh.style.width='0px'; });
    clearTransientGlows();
  }
  if(anchorEl) anchorEl.classList.toggle('collapsed', isCollapsed);
  document.body.classList.toggle('ui-collapsed', isCollapsed);
  if(!isCollapsed) clearExternalCollapseOffset();
  if(collapsePill){
    collapsePill.setAttribute('aria-hidden', String(!isCollapsed));
  }
  document.querySelectorAll('[data-collapse-toggle]').forEach(btn=>{
    btn.textContent='';
    btn.dataset.collapsed=String(isCollapsed);
    btn.setAttribute('aria-label', isCollapsed ? '展开面板' : '折叠面板');
    btn.title=isCollapsed ? '展开面板' : '折叠面板';
    btn.setAttribute('aria-expanded', String(!isCollapsed));
  });
  const pillBtn=document.getElementById('collapsePillToggle');
  if(pillBtn){
    pillBtn.textContent='';
    pillBtn.dataset.collapsed=String(isCollapsed);
    pillBtn.setAttribute('aria-expanded', String(!isCollapsed));
    pillBtn.setAttribute('aria-label', isCollapsed ? '展开面板' : '折叠面板');
    pillBtn.title=isCollapsed ? '展开面板' : '折叠面板';
  }
  updateCollapsePill();
  updateStackPositions();
  if(!isCollapsed) restoreCollapseSnapshot();
}
document.querySelectorAll('[data-collapse-toggle]').forEach(btn=>{
  btn.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); setCollapsed(!isCollapsed); });
});
const pillToggle=document.getElementById('collapsePillToggle');
if(pillToggle) pillToggle.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); setCollapsed(false); });
// 折叠/展开完成后再校准一次外部堆位置，避免读取到过渡中的矩形。
stack.addEventListener('transitionend', e=>{
  if(e.propertyName==='transform') updateStackPositions();
});

// ── 叠卡: 上下类堆叠, 两堆统一参数, 都能看清叠压的卡 ──
const STEP=34, SCALE_K=0.05, OPACITY_K=0.62;
// 普通模式只展示有限的叠压层，深层卡片仍保留在轮换序列中。
// 任务堆和报错堆各自有自己的上限；这里约束的是一级主卡堆。
const MAX_STACK_VISIBLE=4;
function stackVisibleDepth(count){
  return Math.min(Math.max(0,Number(count)||0)-1,MAX_STACK_VISIBLE-1);
}
const ERR_STEP=24, ERR_MAX_VISIBLE=4;
// 2026-10-22：报错堆「还有 N 条」的列表开着没（setErrors 里用）。var：setErrors 加载早期就会被调
var errMoreOpen=false;

// ⭐⭐ 主卡的压暗层（2026-09-13）。**只管"越往下越暗"，不管标题** ——
//   标题是各张卡自己布局里的东西（生成卡 .gc-foot / 剪影卡 .ps-foot），
//   不再浮一条盖在卡面上（用户 2026-09-13：「不要做主卡片底部卡片，而是直接改 UI」）。
(function initStackDims(){
  cards.forEach(c=>{
    if(c.querySelector('.bc-dim')) return;                  // 幂等
    const dim=document.createElement('div');
    dim.className='bc-dim';
    c.appendChild(dim);
  });
})();

// ⭐ 设置卡 / 外挂能力卡的卡面参数（2026-09-13 用户要求：学生成卡，把最重要的开关搬上卡面）。
//
// ⚠⚠ 卡面控件一律用 `data-setting=`，和设置页【共用同一个 settingsRuntime】——
//   两边改哪边都同步，不会出现"卡面调了设置页没变"。
//   这不是新机制，生成卡的「抓取分辨率 / 传回图层」早就是这么干的。
// ⚠ 挑哪几个的原则：**每次干活都可能要改的** 才上卡面。
//   只在装机时设一次的（缓存位置、外观、隐私）留在设置页，别占卡面。
function renderSettingsCardFields(){
  window.V7MainCardShortcuts?.refresh('settings');
  const foot=document.querySelector('[data-settings-foot]');
  if(foot)foot.textContent='连接 · 积分 · 外观 · 工具 · 客服';
}
