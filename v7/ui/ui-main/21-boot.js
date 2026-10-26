// ═══ ui-main/21-boot.js —— 主界面主程序第 21 / 21 段 ═══
//   管什么：启动收尾：报错系统收尾 · 启动时挂卡面 · 探引擎 · 公告
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 报错系统收尾 ═══════════════════════════════════════════
//  ⚠ 必须是整个主脚本的最后一段。markBootOk() 就是"跑到最后一行"的证据；
//    收不到它，error-report.js 的看门狗会在 6 秒后弹 L4 告诉用户界面没起来。
//    这是 CLAUDE.md 铁律 17 那条"末尾插 debug_log 验证"的自动化版本，
//    区别是它常驻、而且用户自己就能看见，不用开发在场。
// 生成主卡的卡面参数。放在这里是因为它依赖的 gcSyncing 是 let，
// 早于声明调用会撞暂时性死区(铁律 17)。此处所有声明都已完成。
renderGenerationCardFields();
try{ V7MainCardShortcuts.mountAll();renderSettingsCardFields(); renderEnginesCardFields(); }catch(e){ console.warn('[卡面] 快捷卡渲染失败', e);ERR.report('LAYOUT_FAILED',{message:String(e.message||e)}); }
// ⭐ 记录与恢复卡的卡面也在这里挂起来（2026-09-30）。
//   ⚠ 不能等第一次路由过去才挂 —— 那样用户第一次点进去，卡面还是旧骨架，
//     要等缓存读完才变，看着像"这张卡是空的"。启动就挂，之后靠事件刷新。
try{ recordsCardMount(); recordsCardReload(); }catch(e){ console.warn('[卡面] 记录卡渲染失败', e);ERR.report('HISTORY_OPERATION_FAILED',{message:String(e.message||e)}); }
// ⭐ 外挂能力卡（2026-10-01）：启动时把卡面和二级都建起来（三张档位卡【常驻】）。
//   ⚠ 和记录卡同理：这里只建 DOM 和挂事件，不去问引擎（引擎探活是异步的，
//     启动时打会拖慢首屏）。引擎状态等真开卡时再拉。
try{ renderEnginesCardFields(); enginesCardMount(); }catch(e){ console.warn('[卡面] 外挂卡渲染失败', e);ERR.report('ENGINE_OPERATION_FAILED',{message:String(e.message||e)}); }

// ── 启动时探一次校色加速引擎，把结果打进日志 ──
// ⚠ 为什么要在启动时探、而不是等第一次生成：
//   ① 用户能一眼知道"现在到底走档几"，不用生成一次才看得出来；
//   ② webview 访问 127.0.0.1 会不会被跨域/CSP 拦，这是【没实测过】的点 ——
//      有问题就在启动日志里暴露，而不是等生成到一半才发现。
//      2026-09-11 那次 `Failed to fetch` 的教训：请求出不出得去，要提前验。
if(window.MATCHENGINE){
  MATCHENGINE.probe(true).then(st=>{
    const msg='[校色] '+(st.available
      ? ('加速引擎在线 · 档'+st.tier+' · '+st.device+(st.vramGB?(' '+st.vramGB+'G'):''))
      : ('未检测到加速引擎，用本机算法(档1：网格对齐 + 校色，已内置)'+(st.lastError?(' · '+st.lastError):'')));
    console.log(msg);
    if(window.__TAURI__&&window.__TAURI__.core)window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
    // ⚠ 离线时【主动弹卡】，不能只写一行日志 —— 日志要翻才看得到。
    //   而且那张卡上直接带「立刻启动」，用户不用去开终端敲命令。
    //   ⚠ 只在用户没主动关掉加速时才提醒：他要是特意选了"只用本机算法"，
    //     再去烦他就是骚扰。
    if(!st.available && String(settingsRuntime.matchTier||'3')!=='1'){
      // ⭐⭐ Phase F（用户 2026-10-06 拍板）：校色引擎【不再自启】（engineAutoStart 代码不读了）。
      //   启动入口 = 外挂能力卡 · 配置信息「校色引擎」那一行 / 该能力的块里。
      //   ⚠ 这里只剩"你选了必须用它的功能（精流对齐/细节补偿）但它没开"时提醒一次 ——
      //     这是提醒不是自启，卡上带「立刻启动」，用户自己决定。
      // 2026-10-24：精确对齐（flow）已删，只剩细节补偿要用引擎
      if(settingsRuntime.detailBoost===true){
        // ⭐ 2026-09-29：网格对齐 + 校色已内置，引擎只剩「稠密光流」「细节补偿」要用。
        //   以前不管用不用得上，每次开软件都弹一张「引擎离线」报错卡 —— 用户以为校色坏了。
        //   现在只在设置里真选了这两样时才弹；其它情况写一行日志就够。
        setTimeout(()=>notifyEngineOffline(st.lastError),1200);   // 等启动动画走完再弹
      }
    }
  }).catch(()=>{});
}

// ⭐ 启动时探一次【外挂引擎】（37894，抠像/人体解析/指哪抠哪/过渡帧）。
//   ⚠⚠ 2026-10-03 晚新增。以前开机只探校色引擎（37893），抠像引擎
//     【没有任何自启入口】—— 用户每次都得手动去点，点了还点错（见 engineStartAndWait）。
//   用户原话：「直接让用户能够去拉起最高级别的那个引擎……跟随软件一起启动就好。」
//   ⚠ 默认仍然【关】（用户定的：默认全部关闭，用户自己打开，之后记住上次状态）。
//   ⚠ 失败【不弹报错卡】：开机弹卡很烦，这是可选功能。只写日志。
if(window.MATTINGENGINE){
  MATTINGENGINE.probe(true).then(st=>{
    const msg='[外挂] '+(st.available
      ? ('引擎在线 · '+Object.keys(st.tiers||{}).filter(k=>Number(st.tiers[k])>0).join('/')
         +(st.device?(' · '+st.device):''))
      : ('未检测到外挂引擎（抠像/人体解析/指哪抠哪都用不了）'+(st.lastError?(' · '+st.lastError):'')));
    console.log(msg);
    if(window.__TAURI__&&window.__TAURI__.core)window.__TAURI__.core.invoke('debug_log',{message:msg}).catch(()=>{});
    // ⭐⭐ Phase F（用户 2026-10-06 拍板）：外挂引擎【不再自启】——
    //   engineAutoStartMatting 代码不读了；启动入口 = 外挂能力卡（状态条那一行）。
    //   开机只"探一次、写日志"，起不起由用户在外挂卡里点。
  }).catch(()=>{});
}

if(window.ERR){
  // 报错同时进链路日志，排查时能和 UXP 的日志在同一条时间线上对齐
  ERR.setLogSink(aiAddLog);
  ERR.markBootOk();

  // ⭐⭐⭐ 2026-10-09（docs/195 §1）：后端可达性自检。
  //   为什么必须有：默认后端地址从"本机 127.0.0.1"改成"公网 xiasanqi.com"之后，
  //   服务器挂了 / 用户断网 ⇒ 账号、积分、平台算力（香蕉）全废，
  //   但软件【照样能开】（本机生成/修图/抠像/调色都不依赖服务器）。
  //   不提示的话用户看到的就是"按钮点了没反应"——铁律 17 的静默失效。
  //   ⚠ 探测用 /health（不需要登录、最轻、后端一定有）。
  //   ⚠ 2026-10-22 改（用户：「这个不属于我们 L1234 级的报错，为什么会有这种报错」）：
  //     原来这里调 ERR.backendBanner() —— 那是一条【手工拼的固定横幅】：内联样式、position:fixed、
  //     直接挂 body、z-index 99998，完全绕开报错卡体系（不进报错堆、不进 L1~L4 分级、
  //     不受「只露 4 张 / 还有 N 条 / 钉顶」那套管）。实测它的「重试 / ×」两个按钮
  //     命中的是 body —— 点不动，用户只能眼看着它挡在最上面。
  //     ⇒ 撤掉横幅，改走标准 L2 报错卡（code=ANNOUNCE_FETCH_FAILED，钉在堆顶、带重试）。
  //       这张卡由 ERR.report 画，按钮、层级、点击、关闭、能被「还有 N 条」和报错栏统一管理。
  //   ⚠ 只连续失败 2 次才弹（单次抖动不打扰）；恢复后自动撤卡；同一张卡复用，不叠一摞。
  (function backendReachabilityWatch(){
    let stopped=false, failures=0, lastCheckedUrl=null, handle=null, retrying=false;
    const url=()=>String((settingsRuntime&&settingsRuntime.backendUrl)||'').replace(/\/+$/,'');
    async function probeOnce(){
      const base=url();
      if(!base) return true;
      try{
        let ok=false;
        if(window.uiwin&&uiwin.http&&uiwin.http.fetch){
          const r=await uiwin.http.fetch({url:base+'/health',method:'GET',timeoutMs:6000});
          ok=!!(r&&r.ok);
        }else{
          const r=await fetch(base+'/health',{method:'GET',cache:'no-store',
            signal:(typeof AbortSignal!=='undefined'&&AbortSignal.timeout)?AbortSignal.timeout(6000):undefined});
          ok=!!(r&&r.ok);
        }
        return ok;
      }catch(_){ return false; }
    }
    async function check(manual){
      if(stopped) return;
      const ok=await probeOnce();
      if(ok){
        failures=0;
        if(handle){ try{ handle.close(); }catch(_){} handle=null; }
        ERR.backendBannerClear();          // 老版本可能还留着横幅，顺手清掉
        return;
      }
      failures++;
      // ⚠ 连续失败 2 次才提示：单次抖动（换网、休眠唤醒）不该打扰用户。
      //   手动点重试时立刻提示（那本来就是用户要看结果）。
      if(!(manual||failures>=2)) return;
      if(handle) return;                   // 卡片已经在：别叠第二张（重试时只改卡上的字）
      handle = ERR.report('ANNOUNCE_FETCH_FAILED', {
        message: '启动检查没连上服务器（' + url() + '）。账号、积分、平台算力暂时用不了；'
          + '本机生成、修图、抠像、调色不受影响，可以照常用。',
        detail: '可能是网络断了、服务器在维护、或者杀毒软件拦了。稍等一会儿点「重试」。',
        context: { '地址': url(), '连续失败': String(failures) + ' 次' },
        stage: 'startup',
        pin: 'top',
        confirm: '知道了',
        retry: async function(){
          if(retrying) return;
          retrying = true;
          try{
            const nowOk = await probeOnce();
            if(nowOk){
              failures = 0;
              try{ handle && handle.close(); }catch(_){}
              handle = null;
              if(window.UI) UI.toast('已连上 V7 服务器','ok',2400);
            }else{
              failures++;
              const desc = handle && handle.el && handle.el.querySelector('.ec-desc');
              if(desc) desc.textContent = '第 ' + failures + ' 次也没连上（' + url() + '）。检查一下网络再点「重试」。';
            }
          } finally { retrying = false; }
        }
      });
    }
    // 开机先等一下再探（让界面先画出来，别跟启动抢资源）
    setTimeout(()=>check(false),2500);
    // 之后每 30 秒复查一次：服务器恢复了要能自动撤掉提示条
    const timer=setInterval(()=>{ if(stopped){clearInterval(timer);return;} check(false); },30000);
    // ⚠⚠ 改完后端地址要【立刻】复查，不能让用户干等 30 秒。
    //   实测：用户在设置里改地址 → 不点重试的话最坏要等一整个周期才知道结果。
    //   settingsSave() 会派这个事件（见本文件 settingsSave）。
    try{
      window.addEventListener('wheelchair:settings-changed',()=>{
        const now=url();
        if(now===lastCheckedUrl) return;   // 地址没变就不重探（设置里改别的也会派这个事件）
        lastCheckedUrl=now;
        check(false);
      });
    }catch(_){}
    lastCheckedUrl=url();
  })();

  // ⭐ 遥测在启动跑通之后才开始采（2026-10-01）。
  //   放在 markBootOk 之后：跑不到这里说明界面都没起来，采 boot 事件没意义。
  //   ⚠ 用户可在设置里关掉；关掉后连 boot 事件都不发。
  try{ window.V7Telemetry?.start(); }catch(_){ }
  // 首次使用漏斗的第二步：Photoshop 真的连上了。
  // ⚠ 不能用"等 N 秒就当连上" —— 那会把"用户根本没装插件"也算成连上，
  //   漏斗数据就脏了。改成轮询真实连接状态（linkRuntime.connected 由
  //   Rust 记的 lastPollAt 判活，见 checkBridgeAlive），最多等 3 分钟。
  //   真的连上才报一次，然后停。
  (function watchPhotoshopConnected(){
    let tries=0;
    const timer=setInterval(()=>{
      tries++;
      let connected=false;
      try{ connected=!!(window.linkRuntime&&linkRuntime.connected); }catch(_){ }
      if(connected){
        clearInterval(timer);
        try{ window.V7Telemetry?.funnel('photoshop_connected'); }catch(_){ }
      }else if(tries>=36){        // 36 × 5s = 3 分钟，没连上就放弃
        clearInterval(timer);
      }
    },5000);
  })();
  const chk=ERR.selfCheck();
  const bootMsg='[报错] 错误码表 '+chk.total+' 条'+(chk.bad.length?(' / ⚠ 异常: '+chk.bad.join(' ')):' / 自检全过');
  console.log(bootMsg);
  if(window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('debug_log',{message:bootMsg}).catch(()=>{});
}else{
  console.error('[报错] error-report.js 没加载 —— 所有报错都只会进控制台，用户看不见');
}

// ═══════════════════════════════════════════════════════════
//  ⭐⭐ 自动登录（2026-10-14，用户要求「保存账号和密码以及自动登录」）
// ═══════════════════════════════════════════════════════════
//  ⚠⚠⚠ 这段【必须在启动路径上】。我第一版把它写进了 bindSettingsDetail() 的函数体里
//     —— 那是"打开设置卡时才跑"的 ⇒ 不打开设置卡就永远不执行 ⇒
//     自动登录永远不生效、而且没有任何报错（探针 window.__autoLogin 一直"(没跑)"）。
//     这个文件里函数很长，视觉上很容易以为自己在顶层，加"启动要做的事"之前先确认位置。
//
//  ⚠ 只在这几种情况下才算"该自动登录"：
//    ① 本地有凭证（用户勾过"记住我"）  ② 内存里还没有会话  ③ 使用条款已经同意过
//    ③ 很重要：首次使用还没同意条款时不该悄悄登录（那是引导流程的地盘）。
//  ⚠ 失败一律静默：凭证过期/没网 都不是用户能处理的错误，弹卡只会添乱。
//  ⚠ 存的是【登录凭证】不是密码 —— 见 backend-client.js 的 STORE_KEY 那一段。
(function accountAutoLoginBoot(){
  // 启动探针：自动登录失败时界面表现是"没登录"，跟"没记住过"完全一样，
  // 不记原因根本分不出是哪一种（这是我这轮踩得最久的一个坑）。
  window.__autoLogin = { ran: false, hadToken: false, trying: false, ok: false, err: '', signedIn: false };
  var tries=0;
  var timer=setInterval(function(){
    tries++;
    if(!(window.V7Backend&&typeof window.V7Backend.restoreSession==='function')){ if(tries>40)clearInterval(timer); return; }
    // ⚠ 前置条件只有"条款同意状态读得到"。
    //   ⚠⚠ 别加"账号表单已经挂出来"—— 设置卡是懒加载的，不打开就没有那个输入框，
    //     那样会白等 10 秒然后什么都不做（我第一版就是这么错的）。
    var ready=typeof window.V7FirstRun!=='undefined';
    if(!ready&&tries<40)return;
    clearInterval(timer);
    window.__autoLogin.ran = true;
    if(!window.V7Backend.remembered||!window.V7Backend.remembered())return;   // 没记过就别问
    window.__autoLogin.hadToken = true;
    // 承诺没同意之前不自动登录
    try{ if(window.V7FirstRun&&!V7FirstRun.isComplete())return; }catch(_){}
    window.__autoLogin.trying = true;
    window.V7Backend.restoreSession().then(function(snap){
      window.__autoLogin.ok = !!(snap&&snap.signedIn);
      window.__autoLogin.signedIn = !!(snap&&snap.signedIn);
      if(snap&&snap.signedIn){
        // 邮箱填回表单：⚠ 表单这会儿通常还没挂（懒加载），存在才填；
        // 不存在就靠账号节打开时的 accountRefreshRememberStatus 显示"本机已记住：xxx"。
        try{
          var em=document.querySelector('[data-account-email]');
          if(em&&!em.value&&snap.account&&snap.account.email)em.value=snap.account.email;
        }catch(_){}
        if(window.UI&&UI.toast)UI.toast('已自动登录：'+String((snap.account&&snap.account.email)||''),'ok',2600);
      }
      try{ if(window.accountRefreshRememberStatus)accountRefreshRememberStatus(); }catch(_){}
    }).catch(function(){ /* restoreSession 内部已经吞了，这里只是保险 */ });
  },250);
})();

// ═══════════════════════════════════════════════════════════
//  图标初始化（2026-09-14）
// ═══════════════════════════════════════════════════════════
if(window.ICON && window.MOTION){
  // ⚠ 自检要成功失败都报(铁律17)：数出来几个，光说"已初始化"等于没说。
  const bad=[];
  // 静态图标（HTML 里写死位置的）。⚠ 这些是【原本就有 emoji 的位置】的等价替换，
  //   不是新增 —— 用户明确"不要擅自增加图标"。
  let nStatic=0;
  document.querySelectorAll('[data-icon-static]').forEach(el=>{
    const name=el.dataset.iconStatic;
    try{ ICON.set(el,name,el.dataset.iconSize?Number(el.dataset.iconSize):18);
         if(el.querySelector('svg')) nStatic++; else bad.push(name+'(没画出来)'); }
    catch(err){ bad.push(name+'('+(err&&err.message||err)+')'); }
  });
  // 折叠胶囊：保持原行为（只有预设卡有图标，见 updateCollapsePill 的注释）
  const pillIcon=document.getElementById('collapsePillIcon');
  if(pillIcon && pillIcon.dataset.icon) ICON.set(pillIcon, pillIcon.dataset.icon, 15);
  const total=Object.keys(window.__ICON_GLYPHS__||{}).length;
  console.log('[图标] 图形库 '+total+' 个 / 静态 '+nStatic+' 个 / 大图标 '+MOTION.boundCount()+' 个已登记'
    +(bad.length?(' / ⚠ 异常: '+bad.join(' ')):' / 自检全过'));
}else{
  console.error('[图标] icons.js 或 motion.js 没加载 —— 图标位会是空的');
}

// ═══════════════════════════════════════════════════════════
//  ⭐⭐ 平台公告 · 启动检查（2026-10-15 用户重定，推翻 10-14 版）
// ═══════════════════════════════════════════════════════════
//  用户原话：
//    「让这个报错卡片每一次都去弹一下公告，并且这个公告是在报错卡片的最顶层的，
//      每次打开软件的时候都会弹一下」
//    「联网了一定要获取公告，如果没联网就报一个失败，让用户知道他现在没有办法连接上服务器」
//    「这个也其实是一个服务器状态验证」
//
//  ⇒ 启动后拉一次（不登录也能拉）：
//     · 连上 + 有正文 → 公告卡【钉在报错堆最顶】（pin:'top'），正文是分段富文本，「我已知晓」才关。
//     · 连上 + 正文空 → 不弹（没什么要说的；设置卡那一节会显示"已连上服务器"）。
//     · 连不上       → 「连不上 V7 服务器」卡钉在最顶（ERR 码 ANNOUNCE_FETCH_FAILED），
//                       详情里有「重试」：重试失败就在卡上改字（不再叠一张），成功就换成公告卡。
//  ⚠ 不再用本地缓存冒充公告（10-14 那版的约束②③作废）。
//  ⚠ 延迟 1.5 秒再拉：开机瞬间有引导/连接检查/模型清单在抢网络。
(function announceBoot(){
  // 启动探针（10-14 留下的）：公告没弹时一眼看出卡在哪一步。
  window.__announceBoot = { ran: true, hasModule: !!window.V7Announce, ticked: false, fetchDone: false, status: '', shown: '', error: '' };
  if(!window.V7Announce) return;
  // ⚠ 自动化测试页（?ui-test）默认不跑启动检查 —— 跟首次设置自动弹出（V7Setup autoOpen）同一个规矩。
  //   测试环境网络是拦死的，不跳过的话每个测试页都会钉一张「连不上 V7 服务器」在最顶上，
  //   抢走焦点、盖住别的卡（2026-10-15 实测打红 3 个焦点/安装测试）。
  //   公告自己的测试加 ?announce-test=1 照常跑（scripts/_test-announce-20261015.cjs）。
  var qs = new URLSearchParams(location.search);
  if(qs.has('ui-test') && !qs.has('announce-test')){ window.__announceBoot.skipped = 'ui-test'; return; }
  // 新手教程（tutorial-host.js）不联网：公告拉不到会钉一张「连不上服务器」，挡住教程要指的东西
  if(window.__V7_TUTORIAL__){ window.__announceBoot.skipped = 'tutorial'; return; }
  var DELAY_MS = 1500;
  setTimeout(async function(){
    window.__announceBoot.ticked = true;
    var snap;
    try{ snap = await window.V7Announce.fetch(); window.__announceBoot.fetchDone = true; }
    catch(error){ snap = { status:'fail', error:String(error&&error.message||error) }; }
    window.__announceBoot.status = snap.status;
    try{
      if(snap.status==='ok'){ if(snap.blocks&&snap.blocks.length){ showAnnouncement(snap); window.__announceBoot.shown='announcement'; } }
      else { showServerUnreachable(snap); window.__announceBoot.shown='unreachable'; }
    }catch(error){
      window.__announceBoot.error = String(error&&error.message||error);
      if(window.ERR) ERR.report('UI_ACTION_FAILED',{message:'启动公告：'+window.__announceBoot.error});
    }
  }, DELAY_MS);
})();

function announceClock(ms){
  try{ return new Date(ms||Date.now()).toLocaleTimeString('zh-CN',{hour12:false}); }catch(_){ return ''; }
}

function announceSignature(snap){
  // 公告的「是哪一条」：用正文算一个短指纹（后端没给编号；正文变了就是新公告）
  var text = String(snap && (snap.content || (snap.blocks ? JSON.stringify(snap.blocks) : '')) || '');
  if(!text) return '';
  var h = 2166136261;
  for(var i=0;i<text.length;i++){ h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'a1-' + h.toString(36) + '-' + text.length;
}
function showAnnouncement(snap){
  if(!window.UI || typeof UI.notice!=='function') return null;
  // ⭐ 2026-10-18 深夜（用户：「有些用户不会点开那个公告，公告就一直在那」；垃圾桶清掉 = 算已读、不再弹）：
  //   按公告内容记「读过了」——点「我已知晓」或者被垃圾桶清掉都算；同一条不再弹，内容变了（新公告）才再弹。
  //   设置卡「公告与状态」里随时还能看。⚠ 记在这台电脑上（不分账号：公告本来就不分账号）。
  var readKey = 'wheelchair.v7.announcement.read.v1';
  var sig = announceSignature(snap);
  try{ if(sig && localStorage.getItem(readKey) === sig) return null; }catch(_){}
  var markRead = function(){ try{ if(sig) localStorage.setItem(readKey, sig); }catch(_){} };
  var body = window.V7Announce.cardBodyNode(snap);
  return UI.notice({
    title: '平台公告',
    // body 留一份纯文字：日志 / 读屏 / 老逻辑用得到；画面上用的是 bodyNode（富文本）
    body: snap.content,
    bodyNode: body,
    pin: 'top',
    detail: '拉取时间：'+announceClock(snap.at)+'。\n公告在「设置 → 公告与状态」里也能随时再看。',
    level: 'info',
    confirm: '我已知晓',
    onConfirm: markRead,
    safeClear: 'confirm',
    // ⚠ actions 的按钮按了不关卡片 —— 跳去设置看一眼，回来还能点「我已知晓」。
    actions: [{ key:'open-notices', label:'到设置里看', run: function(){
      try{ navigateCard('settings', 0, { section:'notices' }); }
      catch(error){ if(window.ERR) ERR.report('UI_ACTION_FAILED',{message:'跳公告区：'+String(error&&error.message||error)}); }
    }}]
  });
}

function showServerUnreachable(snap){
  if(!window.ERR) return null;
  var tries = 0, handle = null, busy = false;
  var retry = async function(){
    if(busy) return;
    busy = true;
    tries++;
    var desc = handle && handle.el && handle.el.querySelector('.ec-desc');
    if(desc) desc.textContent = '正在重新连接…';
    var next;
    try{ next = await window.V7Announce.fetch(); }catch(error){ next = { status:'fail', error:String(error&&error.message||error) }; }
    busy = false;
    if(next.status==='ok'){
      if(handle) handle.close();
      if(next.blocks&&next.blocks.length) showAnnouncement(next);
      else if(window.UI) UI.toast('已连上 V7 服务器','ok',2400);
      return;
    }
    // ⚠ 重试失败：在【这张卡】上改字，不再叠一张新卡（同样的话叠一摞没有信息量）。
    //   日志照写（silent：只进日志不弹卡），重试几次、什么原因都留痕。
    ERR.report('ANNOUNCE_FETCH_FAILED',{silent:true,message:'第 '+tries+' 次重试：'+(next.error||'未知原因')});
    if(desc) desc.textContent = '第 '+tries+' 次重试也没连上（'+announceClock(next.at)+'）。'+(next.error?'原因：'+next.error:'');
  };
  handle = ERR.report('ANNOUNCE_FETCH_FAILED',{
    message: '启动检查没连上服务器，平台公告也没拉到。'+(snap.error?'（'+snap.error+'）':''),
    context: { '地址': snap.url||'', '时间': announceClock(snap.at) },
    stage: 'startup',
    pin: 'top',
    confirm: '知道了',
    actions: [{ key:'retry', label:'重试', primary:true, run: retry }]
  });
  return handle;
}




