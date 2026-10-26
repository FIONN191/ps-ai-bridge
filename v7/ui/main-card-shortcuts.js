(function(root){
  'use strict';
  const ids=['settings','history','projects','assistant','debug'];
  let host={},epoch=0;
  const mounts=new Map();
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button=(action,label,primary=false)=>'<button type="button" class="quick-action'+(primary?' primary':'')+'" data-quick-action="'+action+'">'+label+'</button>';
  const field=(label,input,full=true)=>'<label class="gcf'+(full?' full':'')+'"><span>'+label+'</span>'+input+'</label>';
  const toggle=(key,label)=>'<label class="gcf-switch"><span>'+label+'</span><input type="checkbox" data-setting="'+key+'"></label>';
  const status=()=>'<output class="quick-status full" data-quick-status role="status"></output>';
  const help=text=>'<button type="button" class="v7-help" data-help-text="'+esc(text)+'" aria-label="说明：'+esc(text)+'">?</button>';
  const intro=(label,text)=>'<div class="quick-heading full"><span>'+label+'</span>'+help(text)+'</div>';
  // ⭐ 设置卡正脸的 5 条状态行 / tag（2026-10-01）。
  //   ⚠ 必须定义在 markup 之前（markup.settings 会直接读它们）。
  //   section = 跳进设置大卡时交给 settingsRoute 的 section；highlight = 落地后闪哪个元素。
  //   value(s) 从宿主给的 summary 里取真值；dot(s) 返回 true=绿 / false=灰。
  // ⭐⭐ 2026-10-14 用户定（正脸重排）：
  //   · 账号和积分【合成一行】：没登录 = 左边"未登录"、右边"未登录"；登录了 = 左边"已登录"、右边积分。
  //   · "后端地址"那一行【删掉】—— 后端写死、不让改（用户原话：后端写死那个网页，后端不允许改），
  //     放在正脸上只会让人以为能改。
  //   · "算力来源"改名"工作流引擎"（ComfyUI 这类开源工作流跑在哪）；"API 服务"= 闭源模型那边。
  const SETTINGS_ROWS=[
    {id:'account',label:'账号',section:'account',highlight:'[data-account-email]',dot:true,
      value:s=>s.signedIn?'已登录':'未登录',on:s=>s.signedIn,
      tip:s=>s.signedIn?(s.email||'已登录'):'未登录：平台积分和平台算力都用不了；只用自己的 Key 不受影响',
      extra:s=>!s.signedIn?'积分 未登录':s.points?('通用 '+Number(s.points.common||0).toLocaleString('zh-CN')+' · Banana '+Number(s.points.banana||0).toLocaleString('zh-CN')):'积分 读取中'},
    {id:'provider',label:'API 服务',section:'own',highlight:'[data-setting="provider"]',dot:true,
      value:s=>s.providerLabel+(s.providerReady?' · 已配置':' · 未配置'),on:s=>s.providerReady},
    {id:'compute',label:'工作流引擎',section:'workflow',
      value:s=>({local:'本地 ComfyUI',own:'自己的在线服务',platform:'平台云算力'}[s.flowSource]||'本地 ComfyUI')}
  ];
  // tag：三种
  //   · bool + section  = 有参数要调（检查点要调间隔、毛玻璃要调强度）→ 点了【跳进设置】那一节
  //   · bool + toggle   = 没参数、就一个开关（自由摆放、统一深色底）→ 点了【当场切换】，绿=开 灰=关
  //   · val             = 显示当前值，点了跳进设置
  //   ⭐ 2026-10-14 用户定的规矩："有参数要调 → 跳转；没参数 → 就地切"。
  //   ⚠ toggle 型改的是正脸里那颗【隐藏的真开关】（data-setting），走的是跟设置页同一条保存路，
  //     不是另写一份保存逻辑（另写 = 两份仓库，铁律 16）。
  // ⭐⭐ 2026-10-15 用户定：「这5个选项还不够多…把高频会用到的内容放到一级主卡片里面，
  //   让用户能够快速跳转或者快速地开始关闭开关…由你来决断，根据卡片的实际大小来排列」。
  //   ⇒ 分两组（group）：'toggle' = 没参数的开关，点一下当场切；'jump' = 有参数，点一下跳进设置那一节。
  //   ⚠ 选择的依据：常调 + 生成卡正脸上【没有】的（自动传回 / 用整张图 生成卡正脸已经有了，不重复放）。
  //   ⚠ type:'jump' = 纯跳转（没有状态可显示）；'val' = 显示当前值；'bool' 带 section = 显示开关状态但点了跳过去调参数。
  const SETTINGS_TAGS=[
    // ── 开关（当场切）──
    // 2026-10-22（docs/263 第 19 条）：「统一深色底」删了 —— 默认就是统一中性底，想换颜色去设置里「主题 · 卡片底色」
    {id:'free',group:'toggle',label:'自由摆放',type:'bool',toggle:'freeMode',on:s=>s.freeMode},
    {id:'autogroup',group:'toggle',label:'自动编组',type:'bool',toggle:'autoGroup',on:s=>s.autoGroup},
    {id:'autoalign',group:'toggle',label:'自动对齐',type:'bool',toggle:'autoAlign',on:s=>s.autoAlign},
    {id:'sound',group:'toggle',label:'完成音效',type:'bool',toggle:'soundEnabled',on:s=>s.sound},
    {id:'hover',group:'toggle',label:'悬停看大图',type:'bool',toggle:'hoverOpensPreview',on:s=>s.hoverPreview},
    // ── 去设置（有参数要调）──
    // ⚠ 顺序按【宽度】排过（量过：一行可用 248px）—— 3 行刚好装下 10 个：
    //   检查点 毛玻璃 配色 快捷键 ｜ 出图 边缘羽化 PS联动 ｜ 缓存 助手模型 布局恢复。乱排会挤成 4 行、被卡脚盖住。
    // ⚠ 2026-10-14：这里原来还有一个 {id:'hints',label:'教程提示',…} 的 tag，
    //   跟着"自动显示教程提示"开关一起删了（教程要重做）。重做时加回来，见 docs/217。
    {id:'checkpoint',group:'jump',label:'检查点',type:'bool',section:'storage',highlight:'[data-setting="checkpointEnabled"]',on:s=>s.checkpoint},
    {id:'glass',group:'jump',label:'毛玻璃',type:'bool',section:'appearance',highlight:'[data-setting="blur"]',on:s=>s.blur>0},
    {id:'theme',group:'jump',label:'配色',type:'jump',section:'theme'},
    // ⚠ 快捷键不显示具体按键（"Ctrl/Cmd+Enter" 一个标签占一整行，正脸装不下），悬停 title 里写
    {id:'shortcut',group:'jump',label:'快捷键',type:'jump',section:'shortcuts'},
    {id:'compute',group:'jump',label:'出图',type:'val',section:'platform',value:s=>s.imageSource==='platform'?'平台积分':'自带 Key',warn:s=>s.imageSource==='platform'},
    {id:'feather',group:'jump',label:'边缘羽化',type:'bool',section:'feather',highlight:'[data-setting="returnFeather"]',on:s=>s.feather},
    {id:'ps',group:'jump',label:'PS 联动',type:'jump',section:'photoshop'},
    {id:'cache',group:'jump',label:'缓存',type:'val',section:'cache',highlight:'[data-setting="cacheCapacityGB"]',value:s=>(s.cacheGB||'—')+' GB',warn:()=>false},
    {id:'assistant',group:'jump',label:'助手模型',type:'jump',section:'assistant'},
    {id:'layout',group:'jump',label:'布局恢复',type:'jump',section:'layout'}
  ];
  const tagMarkup=t=>t.toggle
    // ⚠ 当场切换的标签 = <label> 包一颗真 checkbox（透明、铺满整个标签）：点哪都是原生切换，
    //   键盘能聚焦、读屏能读出名字；改的是 data-setting，跟设置页走同一条保存路
    //   （mount() 里那条 change 监听调 host.readSetting，自由摆放的进出也在那条路里处理）。
    ?'<label class="sq-tag sq-toggle" data-tag="'+t.id+'"><input type="checkbox" class="sq-toggle-input" data-setting="'+t.toggle+'" aria-label="'+esc(t.label)+'"><i></i><span>'+esc(t.label)+'</span></label>'
    :'<button type="button" class="sq-tag'+(t.type==='jump'?' sq-jump':'')+'" data-quick-action="jump" data-tag="'+t.id+'" data-section="'+t.section+'"'+(t.highlight?' data-highlight="'+esc(t.highlight)+'"':'')+' aria-label="'+esc(t.label)+'"></button>';
  const markup={
    // ⭐ 设置卡正脸 = 总览：上面 3 条状态行，下面两组 tag（开关 / 去设置）。
    //   ⚠ 每一条显示的都必须是真值（铁律：能看不能用的比没有更坏）。
    //   ⚠ 行和 tag 的文字由 refreshSettings() 填，这里只搭骨架。
    settings:()=>'<div class="sq-rows full">'
        +SETTINGS_ROWS.map(r=>'<button type="button" class="sq-row" data-quick-action="jump" data-row="'+r.id+'" data-section="'+r.section+'"'+(r.highlight?' data-highlight="'+esc(r.highlight)+'"':'')+' aria-label="'+esc(r.label)+'">'
          +'<span class="sq-k">'+esc(r.label)+'</span><span class="sq-v" data-row-value></span>'
          +(r.extra?'<span class="sq-x" data-row-extra></span>':'')
          +(r.dot?'<i class="sq-dot" data-row-dot></i>':'')+'</button>').join('')
      +'</div>'
      +'<div class="sq-tags-h full">开关 · 点一下切换</div>'
      +'<div class="sq-tags full" data-tag-group="toggle">'+SETTINGS_TAGS.filter(t=>t.group==='toggle').map(tagMarkup).join('')+'</div>'
      +'<div class="sq-tags-h full">去设置 · 点一下跳过去</div>'
      +'<div class="sq-tags full" data-tag-group="jump">'+SETTINGS_TAGS.filter(t=>t.group==='jump').map(tagMarkup).join('')+'</div>',
    // ⭐ 2026-09-30 记录与恢复卡改版：这面卡不再画任何东西。
    //   卡面 = 搜索框 + 项目横条列表 + 底栏，全部由 V7RecordsCard 画
    //   （见 ui.html 的 mountRecordsHistoryFace）。
    //   ⚠ 原来那三个数字格（全部任务/今天完成/最近一次）和「查找任务」输入框
    //     都在新卡面上有更好的位置（底栏合计 / 卡内搜索框），留着就是两套口径。
    //   这里返回空串：留着挂载点，靠 [data-quick-action] 的老按钮全部不是这一格的。
    history:()=>'',
    // ⚠ 下面这些是【卡面快捷入口】的 HTML；它们的 action 由 act() 分发。
    //   记录卡的入口现在全在卡面上，不再有 quick-action 按钮。
    projects:()=>intro('当前项目','这里选择的项目与三级项目进度页一致。新建项目只建立本机记录，不改动 Photoshop 文件。')+
      field('当前项目','<select data-quick-project aria-label="当前项目"></select>')+
      field('新项目名称','<input data-quick-project-name maxlength="160" placeholder="输入名称后新建">')+
      button('create-project','新建项目',true)+button('project-progress','管理图片')+button('new-schedule','添加日程')+button('eagle','Eagle 归档')+status(),
    assistant:()=>intro('快速对话','与三级助手使用同一会话、模型和权限。首次使用、联网与敏感操作仍走原有确认。')+
      field('告诉助手你要做什么','<textarea data-quick-assistant-prompt rows="3" maxlength="12000" placeholder="例如：帮我整理这张照片的修图步骤"></textarea>')+
      button('send-assistant','发送',true)+button('stop-assistant','停止')+button('assistant-chat','查看对话')+button('assistant-model','选择模型')+button('assistant-permissions','查看权限')+button('assistant-recovery','恢复节点')+status(),
    debug:()=>intro('运行与排查','常用诊断放在卡面。报错模拟、清空日志和重启等操作保留在三级，避免误触。')+
      toggle('debugMode','详细调试日志')+'<span></span>'+button('performance','性能监视',true)+button('network','网络体检')+button('copy-logs','复制日志')+button('show-logs','查看日志')+button('bridge-logs','桥接日志')+button('error-tools','报错工具')+status(),
    // ⚠⚠ 2026-10-14：这里原来是「使用教程」卡的卡面（markup.tutorial）：
    //     intro('随用随查',…) + 「自动显示教程提示」开关
    //     + 搜索手册输入框 + 搜索手册/完整手册/三个"演示"按钮 + status()
    //   教程卡整张删掉后，这一段【没有卡再用了】。
    //   ⚠ 手册不是教程 —— 它的入口现在走手册自带的浮层（V7Manual.open），
    //     从设置卡进，见 ui.html 里 V7Manual.configure 那一段。
    //   ⚠ 重做教程卡时要恢复这一段（清单见 docs/217），原文：
    //     intro('随用随查','教程按钮直接播放对应演示；说明搜索在完整手册中查找。…')
    //     + 开关 data-quick-tutorial-hints + field('搜索操作说明', …data-quick-manual-query…)
    //     + button('search-manual','搜索手册',true) + button('manual','完整手册')
    //     + button('lesson-cards','卡片操作演示') + button('lesson-generation','生成传回演示')
    //     + button('lesson-history','历史恢复演示') + status()
  };
  function scope(){return root.WHEELCHAIR_STORAGE?.namespaceId?.()||'anonymous';}
  function message(id,text){const out=mounts.get(id)?.querySelector('[data-quick-status]');if(out)out.textContent=text||'';}
  function report(id,error){const codes={history:'HISTORY_OPERATION_FAILED',projects:'PROJECT_PLANNER_FAILED',assistant:'ASSISTANT_OPERATION_FAILED'};host.error?.(codes[id]||'LAYOUT_FAILED',error);}
  function values(container,selector,value,force=false){const el=container?.querySelector(selector);if(el&&(force||el!==document.activeElement)){if(el.type==='checkbox')el.checked=!!value;else if(el.value!==String(value??''))el.value=String(value??'');}}
  function options(select,rows,empty){
    if(!select)return;
    const html=rows.length?rows.map(row=>'<option value="'+esc(row.id)+'">'+esc(row.label)+'</option>').join(''):'<option value="">'+esc(empty)+'</option>';
    if(select.innerHTML!==html){const current=select.value;select.innerHTML=html;if(rows.some(row=>row.id===current))select.value=current;}
  }
  function refreshSettings(){
    const settings=host.settings?.()||{};
    for(const [id,node] of mounts){
      node.dataset.settingsScope=host.settingsScope?.()||'';
      node.querySelectorAll('[data-setting]').forEach(el=>{
        // Update both the shortcut and an already-open detail without rebuilding either.
        for(const linked of document.querySelectorAll('[data-setting="'+el.dataset.setting+'"]')){
          // The native window can remain in free mode when an exit fails.
          // Keep its retry control honest without changing the account's saved preference.
          const value=el.dataset.setting==='freeMode'&&root.V7FreeMode?root.V7FreeMode.isActive():settings[el.dataset.setting];
          if(linked.type==='checkbox')linked.checked=!!value;
          else if(linked!==document.activeElement){
            linked.value=String(value??'');
            if(linked.classList.contains('nsl-range')){
              const min=Number(linked.min)||0,max=Number(linked.max)||100,v=Number(linked.value);
              linked.style.setProperty('--fill',((v-min)/(max-min)*100).toFixed(1)+'%');
              const out=linked.closest('.nsl')?.querySelector('[data-nsl-val]');if(out)out.textContent=String(v)+(linked.dataset.nslSuffix||'');
              linked.dataset.nslPrev=String(v);
            }
          }
        }
      });
      if(id==='settings')paintSettingsFace(node);
    }
  }
  // 设置卡正脸：只改文字和 class，不重建节点（高频刷新时重建会打断 hover、还会闪）
  function paintSettingsFace(node){
    const s=host.settingsSummary?.();if(!s)return;
    for(const r of SETTINGS_ROWS){
      const el=node.querySelector('[data-row="'+r.id+'"]');if(!el)continue;
      const v=el.querySelector('[data-row-value]'),text=r.value(s);
      const tip=r.tip?r.tip(s):text;
      if(v.textContent!==text)v.textContent=text;
      const x=el.querySelector('[data-row-extra]');const xt=r.extra?r.extra(s):'';if(x&&x.textContent!==xt)x.textContent=xt;
      el.title=r.label+'：'+tip+(xt?'；'+xt:'')+'（点击去设置里看）';
      const dot=el.querySelector('[data-row-dot]');if(dot)dot.classList.toggle('on',!!r.on(s));
    }
    for(const t of SETTINGS_TAGS){
      const el=node.querySelector('[data-tag="'+t.id+'"]');if(!el)continue;
      let html,cls;
      if(t.type==='bool'){const on=!!t.on(s);html='<i></i>'+esc(t.label);cls=on?'on':'off';
        el.title=t.label+'：'+(on?'开':'关')+(t.toggle?'（点一下切换）':'（点击去设置里调）');
        // ⚠ 切换型标签里面有真 checkbox，【不能】整段重写 innerHTML（会把开关本身抹掉）—— 只改颜色
        if(t.toggle){el.classList.toggle('on',on);el.classList.toggle('off',!on);continue;}}
      else if(t.type==='jump'){html=esc(t.label)+'<span class="sq-arrow">›</span>';cls='off';el.title='去设置里的「'+t.label+'」';}
      else{const v=t.value(s);html=esc(t.label)+' <b>'+esc(v)+'</b>';cls=t.warn(s)?'warn':'off';el.title=t.label+'：'+v+'（点击去设置里改）';}
      if(el.innerHTML!==html)el.innerHTML=html;
      el.classList.toggle('on',cls==='on');el.classList.toggle('warn',cls==='warn');el.classList.toggle('off',cls==='off');
    }
  }
  // ⭐ 2026-09-30：记录卡的卡面整个改由 V7RecordsCard 画（搜索框 + 项目横条列表 + 底栏），
  //   这里不再渲染、也不再读缓存。
  //   ⚠⚠ 原来这里的 refreshHistory() 会 await host.history()（= loadMainCardHistory），
  //     而那个函数每次都把整个 cache 目录扫一遍，扫出来的 rows 交给 renderHistory，
  //     renderHistory 又去找 host.refreshRecordsFace —— 宿主从来没实现过它，
  //     所以那一整趟磁盘扫描的结果【一个消费者都没有】，纯浪费（docs/96 白扫链）。
  //   现在：这里只广播一个"记录变了"事件，真正要数据的记录卡自己去读一次。
  function renderHistory(){
    // ⚠ 这里【不能】先判 mounts.get('history') —— mount('history') 是直接 return 的，
    //   'history' 永远不在 mounts 里，那样判会让广播一次都发不出去（写了就当没写）。
    //   记录卡是事件驱动的：广播一下，它自己会重读缓存并重画。
    try{ root.dispatchEvent(new CustomEvent('wheelchair:records-changed')); }catch(_){}
  }
  async function refreshHistory(){ renderHistory(); }
  function refresh(id){
    const node=mounts.get(id);if(!node)return;
    if(id==='settings')refreshSettings();
    if(id==='history'){renderHistory();return;}
    if(id==='projects'){
      const state=root.V7ProjectSchedule.quickState();
      options(node.querySelector('[data-quick-project]'),state.projects.map(row=>({id:row.id,label:row.name})),'尚未创建项目');
      values(node,'[data-quick-project]',state.projectId);
      const selected=state.projects.find(row=>row.id===state.projectId);
      message(id,selected?selected.itemCount+' 张图片 · '+state.dueCount+' 条待办提醒':'新建项目后添加需要跟踪的图片');
    }
    if(id==='assistant'){
      if(node.classList.contains('agent-face'))return;   // 新卡面自己订阅中间人，自己刷新
      const state=root.V7AssistantPanel.quickState();
      node.querySelector('[data-quick-action="stop-assistant"]').disabled=!state.busy;
      node.querySelector('[data-quick-action="send-assistant"]').disabled=state.busy;
      message(id,state.busy?'助手正在处理，可随时停止':state.lastReply|| (state.ready?(state.model||'模型已连接'):'先选择模型，再发送消息'));
    }
    if(id==='debug')message(id,host.debugSummary?.()||'');
    // ⚠ 2026-10-14：原来这里有一行 if(id==='tutorial') 把「自动显示教程提示」勾选状态同步过来
    //   —— 跟着教程卡一起删了（V7Tutorial 模块不在了，留着这一行会抛）。
  }
  async function act(id,action,node,button){
    const go=(card,zone,options)=>host.navigate(card,zone,options);
    // ⭐ 设置卡正脸的状态行 / tag：跳进二级大卡对应那一页，落地那一项闪一下
    //   （自由摆放 / 统一深色底那两颗是 <label>+checkbox，原生切换，不走这里）
    if(action==='jump'){
      // 点的那一下给个回馈（引导用户看过去）。⚠ 用 element.animate，不给已存在的元素加 class 播 animation（会闪两次）
      // ⚠ 关键帧里不写 var()：先把主题色读成实值（主题一换也跟着走，又不赌 WAAPI 认不认变量）
      const accent=(getComputedStyle(document.documentElement).getPropertyValue('--accent-hsl')||'211 100% 68%').trim();
      button?.animate?.([{backgroundColor:'hsl('+accent+' / .45)'},{backgroundColor:'hsl('+accent+' / 0)'}],{duration:520,easing:'cubic-bezier(.22,.9,.32,1)'});
      const options={section:button?.dataset.section||'account'};
      if(button?.dataset.highlight)options.highlight=button.dataset.highlight;
      return go('settings',0,options);
    }
    if(action==='image-api')return go('settings',0,{section:'own'});
    if(action==='photoshop')return go('settings',0,{section:'photoshop'});
    if(action==='layout')return go('settings',2,{section:'layout'});
    if(action==='account')return go('settings',0,{section:'account'});
    // ⭐ 2026-09-30：记录卡的卡面整个改由 V7RecordsCard 画，
    //   「恢复到任务栏 / 查看时间线 / 复用提示词」这些快捷 action 一并作废
    //   （原来它们指向卡面上那几个节点，节点已经没有了，留着就是死路）。
    //   记录卡的入口现在走路由名，见 V7RouteRegistry 的 records/* 一族。
    if(action==='checkpoints')return root.V7RouteRegistry.open('records/recovery');
    if(action==='history-costs')return go('settings',0,{section:'billing'});
    if(action==='create-project'){
      const input=node.querySelector('[data-quick-project-name]'),name=input.value.trim();if(!name){input.focus();return;}
      const token=epoch;await root.V7ProjectSchedule.createProject(name);if(token===epoch){input.value='';refresh(id);}return;
    }
    if(action==='project-progress')return go('projects',0);
    if(action==='new-schedule')return root.V7ProjectSchedule.openNewSchedule();
    // ⭐ 2026-09-29 方案 B：项目卡重排后 Eagle 归档在第 4 格（zone 3），原来在第 3 格（zone 2，现为拍摄日程）。
    if(action==='eagle')return go('projects',3);
    if(action==='send-assistant'){
      const input=node.querySelector('[data-quick-assistant-prompt]'),text=input.value.trim();if(!text){input.focus();return;}
      const token=epoch,result=await root.V7AssistantPanel.sendQuickMessage(text);if(token===epoch&&result?.ok){if(input.value.trim()===text)input.value='';refresh(id);}return;
    }
    if(action==='stop-assistant')return root.V7AssistantPanel.stopQuickMessage();
    if(action.startsWith('assistant-'))return go('assistant',{chat:0,model:1,permissions:2,recovery:3}[action.slice(10)]);
    if(action==='performance')return host.openPerformance();
    if(action==='network')return root.V7NetworkDoctor.open();
    if(action==='copy-logs'){await host.copyLogs();message(id,'日志已复制');return;}
    if(action==='show-logs')return go('debug',2);
    if(action==='bridge-logs')return go('debug',2,{logKind:1});
    if(action==='error-tools')return go('debug',1);
    // ⚠⚠ 2026-10-14：这三条原来都跳「使用教程」卡：
    //     search-manual → go('tutorial',3,{query})   manual → go('tutorial',3)
    //     lesson-*      → go('tutorial',{cards:0,generation:1,history:2})
    //   教程卡整张删了 ⇒ go('tutorial',…) 会找不到卡（导航落空）。
    //   ⇒ 手册改走它自带的浮层（V7Manual.open 会自己建 overlay，不依赖任何卡）；
    //     lesson-* 那三个"演示"按钮是教程内容，【已删】。
    //   ⚠ 重做教程卡时这三条要改回 go('tutorial',…)，见 docs/217。
  }
  function mount(id){
    // ⚠⚠ 记录卡（history）这一格【不归这里管】（2026-09-30）。
    //   它的卡面由 V7RecordsCard 画（搜索框 + 项目横条列表 + 底栏）。
    //   原来这里会 node.innerHTML=markup[id]()，把那一格整个覆盖掉 ——
    //   而记录卡的卡面正好建在同一个 .bc-inner 里，于是"记录卡永远空白、
    //   还不报错"，典型的静默失效（第一次跑截图就栽在这）。
    //   返回空串只是个兜底声明；真正的保证是这里直接 return。
    if(id==='history')return;
    const node=document.querySelector('[data-card="'+id+'"] .bc-fields');if(!node)return;
    if(mounts.has(id)){refresh(id);return;}
    // ⭐ 2026-10-17 夏三六：助手卡的卡面整个交给 V7AgentZone 画（能直接开工，按钮用户自己定），
    //   跟记录卡交给 V7RecordsCard 一个套路。下面 markup.assistant 那套旧卡面只在新模块没加载时兜底。
    if(id==='assistant'&&root.V7AgentZone){mounts.set(id,node);root.V7AgentZone.mountFace(node);return;}
    mounts.set(id,node);node.classList.add('quick-card');node.dataset.quickCard=id;node.innerHTML=markup[id]();
    // 设置正脸显示登录态 / 积分：账号一变就刷新（只挂一次 —— mounts 已存在时上面就 return 了，不会翻倍）
    if(id==='settings')root.V7Backend?.onChange?.(()=>refresh('settings'));
    node.addEventListener('change',event=>{
      const input=event.target;
      if(input.matches('[data-setting]'))host.readSetting(node,input);
      if(input.matches('[data-quick-history-entry]'))renderHistory();
      if(input.matches('[data-quick-project]')){try{root.V7ProjectSchedule.selectProject(input.value);refresh(id);}catch(error){report(id,error);}}
      // ⚠ 2026-10-14：原来这里有一条 if(input.matches('[data-quick-tutorial-hints]'))
      //   → root.V7Tutorial.setHintsEnabled(...) —— 跟着教程卡一起删了。
    });
    node.addEventListener('input',event=>{if(event.target.matches('[data-setting][type=range]'))host.readSetting(node,event.target);});
    node.addEventListener('keydown',event=>{
      if(event.isComposing||event.key!=='Enter'||event.target.tagName==='TEXTAREA')return;
      const action=event.target.matches('[data-quick-history-query]')?'search-history':event.target.matches('[data-quick-manual-query]')?'search-manual':event.target.matches('[data-quick-project-name]')?'create-project':null;
      if(action){event.preventDefault();event.stopPropagation();node.querySelector('[data-quick-action="'+action+'"]').click();}
    });
    node.addEventListener('click',async event=>{
      const button=event.target.closest('[data-quick-action]');if(!button||button.disabled)return;
      event.preventDefault();event.stopPropagation();const token=epoch;button.disabled=true;
      try{await act(id,button.dataset.quickAction,node,button);}catch(error){if(token===epoch)report(id,error);}
      finally{if(token===epoch){button.disabled=false;refresh(id);}}
    });
    refreshSettings();refresh(id);
  }
  function mountAll(){ids.forEach(mount);refreshHistory();}
  function resetScope(){
    epoch++;
    for(const node of mounts.values()){
      node.querySelectorAll('input:not([data-setting]),textarea').forEach(input=>{if(input.type!=='checkbox')input.value='';});
      node.querySelectorAll('[data-quick-action]').forEach(button=>{button.disabled=false;});
    }
    queueMicrotask(()=>{ids.forEach(refresh);refreshHistory();});
  }
  root.addEventListener('wheelchair:storage-context',resetScope);
  root.addEventListener('wheelchair:settings-changed',refreshSettings);
  root.addEventListener('wheelchair:free-mode-changed',refreshSettings);
  // ⚠ 2026-10-14：原来这里还有一条
  //   root.addEventListener('wheelchair:tutorial-hints',()=>refresh('tutorial'));
  //   跟着教程卡一起删了（教程要重做）。重做时加回来，见 docs/217。
  root.addEventListener('wheelchair:project-state',()=>{refresh('projects');refreshHistory();});
  root.addEventListener('wheelchair:assistant-state',()=>refresh('assistant'));
  root.V7MainCardShortcuts={configure:options=>{host=options;},mountAll,refresh,refreshHistory};
})(window);
