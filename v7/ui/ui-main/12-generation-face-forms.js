// ═══ ui-main/12-generation-face-forms.js —— 主界面主程序第 12 / 21 段 ═══
//   管什么：生成主卡卡面参数 · 提示词净化 · 通用表单组件 · 数字滚动切换 · 张数悬停
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ═══ 生成主卡的卡面参数(2026-09-11 用户定案) ═══════════════
//  常用的六个参数直接放一级卡上，不用每次开三级。提示词【不在这里】——
//  那是预设系统的地盘(剪影卡右滑的提示词框)，两边各管各的。
//  ⚠ 字段名沿用 data-ai-field：aiReadFields(document) 是全页扫的，
//    放在这里自动就会被读进 aiRuntime，不用另开一套同步。
// ═══ 提示词净化(照搬 V6 host/ai-api.js 的 sanitizePrompt) ═══
//  2026-09-11 从 V6 移植。规则不是我定的，是 V6 已经跑了很久的那套：
//
//  ① 【填空:名=值】→ 直接换成值，标记本身消失。
//     ⚠ 同名一律取【第一个出现的值】——保证同一个名字在全文里同值，
//       否则同一个填空在不同段落被填成不同内容，出图会自相矛盾。
//     这一步【永远执行】，不管提示词是什么结构。
//  ② 只有含 `// MODULE_START:` 结构的提示词才做模块剔除，普通提示词原样返回。
//  ③ 模块块里【任意一个数值 @param 为 0】→ 整块删除。
//     也就是"滑块拉到底 = 不要这个模块"。
//     ⚠ _desc / _label / _note / _range 结尾的是元数据，不参与判断。
//
//  ⚠ 只作用于【发出去的那一份】，原文一个字不动 ——
//    用户的预设和输入框里该长什么样还是什么样。
function sanitizePrompt(rawPrompt){
  let text=String(rawPrompt||'');
  // ① 填空替换(同名取第一个值)
  const fillFirst={};
  text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g,(m,name,val)=>{
    if(!(name in fillFirst)) fillFirst[name]=(val!=null?val:'');
    return m;
  });
  text=text.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g,(m,name,val)=>
    (name in fillFirst)?fillFirst[name]:(val!=null?val:''));
  // ② 没有 MODULE 结构就到此为止
  if(text.indexOf('// MODULE_START:')===-1) return text;
  // ③ 块内有数值参数为 0 → 整块删掉
  text=text.replace(/\/\/ MODULE_START:(\w+)[\s\S]*?\/\/ MODULE_END:\1/g,block=>{
    const paramReg=/@param:([^"]+)"\s*:\s*([\d.]+)/g;
    let m;
    while((m=paramReg.exec(block))!==null){
      if(/_(?:desc|label|note|range)$/.test(m[1])) continue;
      if(parseFloat(m[2])===0) return '';
    }
    return block;
  });
  return text;
}

// ═══ 通用表单组件(2026-09-11) ═══════════════════════════════
//  全项目唯一的数字输入方式: 点按跳值 + 左右拖拽的条。
//  ⚠ 不许再用 <input type="number"> —— 它右边那对上下箭头是原生外观(用户明确不要)，
//    而且在卡面上滚轮会误改数值。
//  ⭐ 2026-10-19（docs/250 第 10 条，用户定实装）：【只有张数】例外 —— 鼠标停在张数条上时滚轮改张数（不翻卡），
//    见 batchWheelTarget / batchStep；别的数字条照旧不响应滚轮（滚轮在卡上是翻卡）。
//  底层仍是 range，所以读值的代码(el.value)不用改。
function numControl(o){
  const v=Math.max(o.min,Math.min(o.max,Number(o.value)||o.min));
  // ⚠ 上限可能等于下限（千问 2K 额度只剩 1 张时张数框是 1~1），别除以 0
  const pct=(o.max>o.min?(v-o.min)/(o.max-o.min)*100:100).toFixed(1);
  return '<label class="nsl '+(o.cls||'')+'">'+
    '<span class="nsl-head"><span class="nsl-name">'+escapeHtml(o.name)+'</span>'+
    '<span class="nsl-val" data-nsl-val>'+escapeHtml(String(v))+(o.suffix||'')+'</span></span>'+
    '<input type="range" class="nsl-range" min="'+o.min+'" max="'+o.max+'" step="'+(o.step||1)+'" '+
      'value="'+v+'" style="--fill:'+pct+'%" '+(o.attr||'')+(o.suffix?' data-nsl-suffix="'+escapeHtml(o.suffix)+'"':'')+'>'+
  '</label>';
}
// 布尔一律用滑动开关，不用原生 checkbox 的方块。底层仍是 checkbox(el.checked 照常能读)。
function switchControl(label,attr,checked,tip){
  return '<label class="tgl"'+(tip?' title="'+escapeHtml(tip)+'"':'')+'>'+
    '<span class="tgl-label">'+escapeHtml(label)+'</span>'+
    '<input type="checkbox" '+(attr||'')+(checked?' checked':'')+'>'+
    '<span class="tgl-track"><span class="tgl-dot"></span></span></label>';
}
// ═══ 数字滚动切换(2026-09-11) ═══════════════════════════════
//  值变大 → 新数字从下方滚上来；变小 → 从上方滚下去。方向跟着增减走，
//  不然拖回去的时候感觉是"倒着播"。全项目所有滑条共用这一个函数
//  (生成卡的 .nsl / 预设参数的 .pd-slider)，别各写各的。
//
//  ⚠ 拖条是高频事件(每帧都可能变值)。这里刻意【不做队列、不等动画结束】：
//    新值一来就重置动画重播，快速拖动时看到的是连续的滚动感；
//    要是排队播完再播下一个，松手之后数字还在追，反而像卡了。
//  ⚠ 动画只有 110ms —— 再长就跟不上手速。
//  ⚠ 【按位独立滚动】: 每一位是自己的滚轮，只有真的变了的那一位才动。
//    19→18 只有个位翻，19→20 才是十位和个位一起翻。
//    整串一起翻会显得笨重 —— 明明只变了 1，整个数字却整体跳一下。
//    小数点和单位(px/%)也各占一位，它们不变就不动，天然不会跟着抖。
window.rollNumber=function(box,text,dir){
  if(!box) return;
  text=String(text);
  const old=box.dataset.rnText;
  if(old===text) return;
  const chars=text.split('');
  let slots=[...box.querySelectorAll('.rn-d')];
  // 位数变了(9→10 / 加减单位) → 重建整排，不播动画。
  // 位数一变，"第 k 位"的含义就跟着变了，硬播只会看到一串乱翻。
  if(slots.length!==chars.length){
    box.textContent='';
    chars.forEach(c=>{
      const s=document.createElement('span'); s.className='rn-d';
      const i=document.createElement('i'); i.textContent=c;
      s.appendChild(i); box.appendChild(s);
    });
    box.dataset.rnText=text;
    return;
  }
  const oldChars=String(old||'').split('');
  slots.forEach((s,k)=>{
    if(oldChars[k]===chars[k]) return;        // 这一位没变 → 一动不动
    const i=s.querySelector('i');
    i.textContent=chars[k];
    i.style.transition='none';
    i.style.transform='translateY('+(dir<0?'-100%':'100%')+')';
    void i.offsetWidth;                       // 强制回流，让下面这次位移真的播得出来
    i.style.transition='transform .11s var(--ease-out)';
    i.style.transform='translateY(0)';
  });
  box.dataset.rnText=text;
};

// 条拖动时实时更新数字和填充。挂在容器上做事件委托，新加的条自动生效。
function bindNumControls(root){
  if(!root) return;
  root.addEventListener('input',e=>{
    const el=e.target;
    if(!el.classList||!el.classList.contains('nsl-range')) return;
    const box=el.closest('.nsl'), out=box&&box.querySelector('[data-nsl-val]');
    const min=Number(el.min)||0, max=Number(el.max)||100, v=Number(el.value);
    el.style.setProperty('--fill',((v-min)/(max-min)*100).toFixed(1)+'%');
    if(out){
      // 方向由"比上一次大还是小"决定 —— 存在元素上，因为一个容器里有好几个条
      const prev=Number(el.dataset.nslPrev);
      window.rollNumber(out,String(v)+(el.dataset.nslSuffix||''),
        Number.isFinite(prev)?(v-prev):1);
      el.dataset.nslPrev=String(v);
    }
  });
}

// ⚠ 回写期间要闸住 change 监听: 下面同步值时会派 change(ui-select 靠它重画标签)，
//   不闸的话会反过来触发 aiRefreshInPlace → 再同步 → 递归。
let gcSyncing=false;

/* ⭐⭐ 2026-10-07 新增：单个模型的单价（按分辨率档）。
   用户定案（问题「单价从哪里来」）：「这个东西我们现在后端还没有做完，你先按在这个地方，
   我们后端到时候会有一个专门的一个接口来做这件事情」+ 选的是"方案三"：
   先按最简形状留位置，字段名 priceUSD，按档位 {1K,2K,4K}。

   ⚠⚠ 真实来源（我核实过后端源码，不是猜的）：
     后端 /v1/models → db.list_models()（backend/db.py:890-900）是
        `output.append({..., **model, ...})`  ——【模型条目原样展开】
     ⇒ 以后往 providers.metadata_json.models[] 里加一个 priceUSD 字段，前端【立刻能收到】，
       后端接口一行都不用改。而现在前端（aiRefreshBackendModels）只取了 id/name，把其余字段丢了。
   ⚠⚠ 三个不许：不许估、不许写死一张表、不许拿"积分倍数"当美元用
     （平台算力那套是 billing_rules 的积分倍数，跟中转站的美元是两种钱）。
     拿不到就返回 null，界面显示"— 单价数据未接入"。
   ⚠ V6 的做法（供后端定字段时参考）：单价是【每个模型 × 每个尺寸档】一个价，例如
     'AJbanana3': prices { '1K':0.15, '2K':0.16, '4K':0.18 }；能出多少张 = floor(余额 ÷ 单价)。 */
function modelUnitPrice(modelId, size){
  const id=String(modelId||''), sz=String(size||'').toUpperCase();
  if(!id||!sz) return null;
  const slot=aiModelSlot();
  // ⭐ 2026-10-24（V7待办/02）：阿吉 / 墨墨先查供应商在后台配的模型目录（supplier-models.js）—— 墨墨从此也有单价。
  //   目录里没有这个模型 ⇒ 阿吉再退老的价目表；墨墨就是「单价未知」。
  if(slot==='aji'||slot==='momo'){
    const hit=window.V7SupplierModels?window.V7SupplierModels.priceFor(slot,id,sz):null;
    if(hit)return isFinite(hit.price)&&hit.price>0?hit.price:null;
    if(slot==='momo')return null;
  }
  // ⭐⭐ 2026-10-15：阿吉 = 后台那张价目表（ui-pure/aji-prices.js，美元/张）。
  //   用户定：「这个表只负责阿吉」「计价单位是美元」「不涉及任何我们的积分」。
  //   ⚠ 查不到就 null（界面写"单价未知"）—— 不回落到下面那条路，更不估。
  if(slot==='aji'){
    const hit=window.V7AjiPrices?window.V7AjiPrices.priceFor(id,sz):null;
    return hit&&isFinite(hit.price)&&hit.price>0?hit.price:null;
  }
  const rows=window.V7ProviderSettings?.modelsFor?window.V7ProviderSettings.modelsFor(slot):null;
  if(!Array.isArray(rows)) return null;
  for(const row of rows){
    const rid=typeof row==='string'?row:(row&&(row.id||row.name));
    if(String(rid)!==id) continue;
    const p=row&&typeof row==='object'?row.priceUSD:null;
    if(!p) return null;                                   // 该模型没给价 —— 不猜
    if(typeof p==='number') return isFinite(p)&&p>0?p:null;
    const v=Number(p[sz]);                                // 按档位给价
    return isFinite(v)&&v>0?v:null;
  }
  return null;
}
// ⭐ 2026-10-15：记录卡的花费也认这张价目表（单一来源）。records-core 里那张写死的旧表接上后不再参与。
if(window.V7RecordsCore&&typeof V7RecordsCore.setPriceResolver==='function'){
  // 2026-10-24（V7待办/02）：目录优先，查不到再退老价目表（同 modelUnitPrice）
  V7RecordsCore.setPriceResolver('aji',(model,size)=>(window.V7SupplierModels&&V7SupplierModels.priceFor('aji',model,size))||(window.V7AjiPrices?window.V7AjiPrices.priceFor(model,size):null));
  // 墨墨：用户 10-24 定「跟阿吉一模一样」显示余额和花费；价格由墨墨在后台目录里填
  V7RecordsCore.setPriceResolver('momo',(model,size)=>window.V7SupplierModels?V7SupplierModels.priceFor('momo',model,size):null);
}

/* 生成卡「模型」栏右边那一块：还能生成约 N 张。
   ⚠ 只对"自己 Key 的美元余额"算（用户定：显示的是给中转站充的美元）；
     GRS 是积分（pts）⇒ 不算张数，直接说明"积分按平台规则扣，这里不折算"。
   ⚠ 余额没查过 / 单价没接入 ⇒ 显示原因，不显示假数字（用户定："直接写一个单价数据未接入就好了，诚实一点"）。 */
// ═══════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-16 千问模式联动生成卡（用户：「切换为千问模式后模型锁死千问 分辨率只有1k 2k 张数上限相关都要联动修改」
//   「张数限制需要不能被破解 需要服务器验证 权限跟随账号走 普通账号和学员账号不一样 +2k限额」）
//   ① 模型：锁成「千问 2.1」，不能选（剪影预设里关掉千问模式，原来那个模型原样回来 —— aiRuntime.model 没动）
//   ② 分辨率：只有 1K / 2K；原来选着 4K 的切过来改成 2K，提示一次
//   ③ 张数上限：走云端时听服务器的（V7QwenMode.batchCap：普通 / 学员不同，2K 再跟剩余额度取小的）；
//      本机算只受软件总上限。⚠ 这里只是让框子显示对的数 —— 真正的拦截在后台逐单核对，改软件绕不过去。
//   ⚠ 选着工作流预设（Forge / ComfyUI）时不算千问（那些本来就不改道），卡面照原样。
// ═══════════════════════════════════════════════════════════════════
function qwenCardActive(){ return !!(window.V7QwenMode&&V7QwenMode.enabled()&&!aiRuntime.workflowPresetId); }
// ⭐ 2026-10-19（docs/250 第 6 条，用户定三套）：张数按引擎各记各的。
//   易曦原话：「选了 comfyui 的预设会把张数拉到 3，你切回 Banana 的预设之后，它的张数还会是 3 …… 就得来回调」。
//   ⚠ 工作流预设优先算 workflow：千问模式下选了 ComfyUI / Forge 预设，那一单照旧跑工作流（不改道），张数也该跟工作流那套。
function currentBatchKind(){ return aiRuntime.workflowPresetId?'workflow':(qwenCardActive()?'qwen':'banana'); }
function batchClamp(n){ return Math.max(1,Math.min(AI_BATCH_MAX,Math.round(Number(n)||1))); }
function batchSlots(){
  if(!aiRuntime.batchByKind||typeof aiRuntime.batchByKind!=='object'||Array.isArray(aiRuntime.batchByKind)) aiRuntime.batchByKind={};
  return aiRuntime.batchByKind;
}
// 记下「现在这套」的张数 —— aiSaveTempCache 存之前调：用户在哪改的张数（卡面 ± / 滑条 / 快捷参数 / 滚轮）都会落到这里
function batchKindRecord(){
  const k=aiRuntime.batchKind||(aiRuntime.batchKind=currentBatchKind());
  batchSlots()[k]=batchClamp(aiRuntime.batch);
}
// 换了一套：先把 batch 存回旧那套，再取新那套。
//   ⚠ 工作流预设自己带张数的（imageCount），还是用预设的 —— 原来就这样（ComfyUI 固定 3 就是这么来的），只是切回去时不再留着 3。
//   ⚠ prevKind 由调用方在【改状态之前】算好传进来：换成工作流预设 / 开了千问以后就算不出「原来是哪套」了。
function batchKindSwitch(prevKind,presetCount){
  const by=batchSlots(), next=currentBatchKind();
  if(prevKind&&prevKind!==next) by[prevKind]=batchClamp(aiRuntime.batch);
  if(presetCount!=null) aiRuntime.batch=batchClamp(presetCount);
  else if(prevKind!==next&&by[next]!=null) aiRuntime.batch=batchClamp(by[next]);
  aiRuntime.batchKind=next;
  by[next]=batchClamp(aiRuntime.batch);
}
// 这一单会不会改走千问：千问模式开着、而且不是工作流预设。
//   ⚠ 传进来的多半是 aiPayload 的结果 —— 它【没有】workflowPreset 字段、只有 workflow；
//     光靠 V7QwenMode.shouldReroute 会把 Forge 预设也当成千问，所以先看 workflow。
function aiWillQwen(x){ return !!(window.V7QwenMode&&x&&!x.workflow&&V7QwenMode.shouldReroute(x)); }
// ⭐ 10-25 用户：对外不写 Qwen（协议），界面一律叫「ComfyUI 工作流」；请求里的模型名不变
function aiQwenChannelLabel(){ return window.V7QwenMode&&V7QwenMode.source()==='local'?'本机 · ComfyUI 工作流':'云端 · ComfyUI 工作流'; }
function aiBatchMax(){
  if(!qwenCardActive()) return AI_BATCH_MAX;
  const cap=V7QwenMode.batchCap(aiRuntime.size);
  return cap==null?AI_BATCH_MAX:Math.max(1,Math.min(AI_BATCH_MAX,cap));
}
// 卡面要不要重画：千问开关 / 张数上限变了（syncGenerationCardFields 比对它）
function qwenCardSignature(){ return qwenCardActive()?'qwen:'+aiBatchMax():'normal'; }
// 用户自己动了张数就不再"还回去"（生成卡张数条、预设卡 ± 都会清它）
let qwenWantedBatch=0;
// ⭐ 2026-10-21（docs/261 U3，学员：千问模式切回来分辨率总被改成 2K，2K 额度用完了也改成 2K）：
//   分辨率也按「千问 / 普通」各记各的（跟张数 batchByKind 一个道理）：进千问用千问上次那档（没记过 = 1K），
//   出千问还原普通模式原来那档（比如 4K）。sizeByKind / sizeKind 跟着临时缓存存（AI_TEMP_FIELDS）。
//   ⚠ 每次 qwenClampCard 都调（开关千问、换预设、开软件都会经过它），所以不用另外挂事件。
function sizeKindSync(){
  if(!aiRuntime.sizeByKind||typeof aiRuntime.sizeByKind!=='object'||Array.isArray(aiRuntime.sizeByKind)) aiRuntime.sizeByKind={};
  const by=aiRuntime.sizeByKind, next=qwenCardActive()?'qwen':'normal', prev=aiRuntime.sizeKind||next;
  aiRuntime.sizeKind=next;
  if(prev===next) return false;
  by[prev]=String(aiRuntime.size||'2K').toUpperCase();
  const want=by[next]||(next==='qwen'?'1K':'');
  if(!want||want===String(aiRuntime.size||'').toUpperCase()) return false;
  aiRuntime.size=want;
  return true;
}
let qwenHighTierNoticeShown=false;
// 千问模式下把卡面上的值收进范围：4K→2K（提示一次）、2K 额度用完→1K、张数压到上限以内
function qwenClampCard(){
  let changed=sizeKindSync();
  if(!qwenCardActive()){ if(changed&&typeof aiSaveTempCache==='function')aiSaveTempCache(); return; }
  if(String(aiRuntime.size||'').toUpperCase()==='4K'){
    aiRuntime.size='2K';changed=true;
    const text='开源模型最高 2K：分辨率已从 4K 改成 2K';
    aiAddLog(text,'warn');
    if(window.UI&&typeof UI.toast==='function')UI.toast(text);
  }
  // 云端 2K 额度用完了还选着 2K ⇒ 发出去也会被拒，直接换 1K（本机算不占额度，不管）
  const lim=V7QwenMode.source()!=='local'&&V7QwenMode.limits();
  if(lim&&!lim.highTierUnlimited&&lim.highTierLeft!=null&&Number(lim.highTierLeft)<=0&&String(aiRuntime.size||'').toUpperCase()==='2K'){
    aiRuntime.size='1K';changed=true;
    if(!qwenHighTierNoticeShown){
      qwenHighTierNoticeShown=true;
      const text='2K 额度用完了：开源模型分辨率已改成 1K（1K 不占额度）';
      aiAddLog(text,'warn');
      if(window.UI&&typeof UI.toast==='function')UI.toast(text);
    }
  }
  const max=aiBatchMax(),cur=Number(aiRuntime.batch)||1,verified=!!V7QwenMode.limits();
  if(cur>max){
    // 还没问到额度时是按保守的 4 张压的：记下原来想要几张，问到了（比如学员 18）再还回去，不然每次开软件都被压成 4
    if(!verified)qwenWantedBatch=Math.max(qwenWantedBatch,cur);
    aiRuntime.batch=max;changed=true;
  }else if(qwenWantedBatch&&verified){
    const back=Math.min(qwenWantedBatch,max);
    qwenWantedBatch=0;
    if(back>cur){aiRuntime.batch=back;changed=true;}
  }
  if(changed&&typeof aiSaveTempCache==='function')aiSaveTempCache();
}
// 模型右边那一小块：千问模式下写「在哪算 · 一次最多几张 · 2K 剩几张」（一行，不许换行，见 .model-quota）
function qwenQuotaHtml(){
  const wrap=(state,html,title)=>'<span class="model-quota" data-model-quota data-state="'+state+'" title="'+escapeHtml(title)+'">'+html+'</span>';
  const head='开源模型模式开着：固定走 ComfyUI 工作流，分辨率只有 1K / 2K。剪影预设里关掉开源模型模式就换回原来的模型。';
  if(V7QwenMode.source()==='local') return wrap('none','本机 ComfyUI · 不扣积分',head+'现在设置成用你自己电脑上的 ComfyUI 算（设置 →「开源模型模式在哪算」能改成云端）。');
  const F=V7QwenMode.FALLBACK_BATCH||4;
  if(!window.V7Backend?.state?.().signedIn) return wrap('unknown','云端开源模型 · 需登录',head+'云端开源模型要登录平台账号才能用；登录前张数先按普通账号的 '+F+' 张算，登录后按服务器给你账号的上限。');
  const l=V7QwenMode.limits();
  if(!l){
    V7QwenMode.refreshLimits(false).catch(()=>null);
    const failed=V7QwenMode.limitsFailure();
    if(failed) return wrap('unknown','额度没查到 · 先按 '+F+' 张',head+'没查到你这个账号一次最多能出几张（'+failed+'）。张数先按普通账号的 '+F+' 张算；超了服务器会直接拒绝、不扣分。');
    return wrap('unknown','云端开源模型 · 正在查额度',head+'正在向服务器查你这个账号一次最多能出几张；查到之前先按 '+F+' 张算。');
  }
  const max=Number(l.maxBatch)>0?Number(l.maxBatch):null, high=V7QwenMode.quality(aiRuntime.size).value>=(Number(l.highTierFrom)||1025);
  const left=l.highTierLeft==null||l.highTierUnlimited?null:Math.max(0,Number(l.highTierLeft)||0);
  let tip=head+'一次最多几张由服务器按账号给（'+(l.admin?'管理员':l.student?'学员':'普通账号')+'：'+(max?max+' 张':'不限')+'），改软件也绕不过去。'
    +'同时跑 '+(Number(l.concurrent)||1)+' 张；可以连着点生成，多出来的在本机排队（排队的不发给服务器、不扣分，取消就不发）。';
  if(left!=null) tip+='2K 每人累计有限额，你还能出 '+left+' 张 2K（1K 不占这个额度）。';
  if(high&&left===0) return wrap('unknown','2K 额度用完了 · 改用 1K',tip);
  let html='云端 · 一次最多 <b>'+aiBatchMax()+'</b> 张';
  if(high&&left!=null) html+=' · 2K 剩 <b>'+left+'</b>';
  return wrap('known',html,tip);
}
window.addEventListener('wheelchair:qwen-limits',()=>{ try{ syncGenerationCardFields(); refreshModelQuota(); syncQuickParams(); }catch(_){} });
window.addEventListener('wheelchair:qwen-mode',e=>{
  // ⭐ 2026-10-19（docs/250 第 6 条）：开关一变，张数换成那一套记着的（关千问回香蕉那套、开千问回千问那套）。
  //   ⚠ 事件是在开关已经改好之后发的：原来是哪套只能按「开关的反面」推（工作流预设不受开关影响，还是 workflow）
  try{
    const on=!!(e&&e.detail&&e.detail.enabled);
    const prev=aiRuntime.batchKind||(aiRuntime.workflowPresetId?'workflow':(on?'banana':'qwen'));
    batchKindSwitch(prev,null);
    aiSaveTempCache();
  }catch(_){}
  setTimeout(()=>{ try{ syncGenerationCardFields(); syncQuickParams(); }catch(_){} },0);
});
// ═══════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-14（用户定）：张数 / 抗截断 = 两个【最高频切换】的参数，
//   提到【预设卡二级右上角】+【提示词卡右上角】。
//   用户原话："我们生成卡片里面的张数…它应该是一个非常非常频繁切换的一个内容。
//   然后呢我们的抗截断也应该是一个非常非常频繁切换的内容。这两个内容我希望它能够
//   到剪影预设卡片的二级卡片的右上角去……我们就可以直接在右上角直接把这两个
//   第一优先级的这个参数给调了。"
//
//   ⚠⚠ 两个位置【必须完全联动】：这里读写的就是 aiRuntime.batch / aiRuntime.antiMode
//     —— 和生成卡卡面、任务提交用的是【同一份真源】，不是又开一个仓库。
//     在一处调了，另一处跟着变（靠 aiRefreshInPlace → syncQuickParams 回填）。
//
//   ⚠ 为什么实现在 ui.html 而不是 preset-ui.js：aiRuntime / ANTI_MODE_LABELS /
//     aiRefreshInPlace 都是本文件的（preset-ui.js 是另一个作用域，读不到）。
//     那边只调 window.V7QuickParams.html() / .bind() / .sync()。
//   ⚠ 这不是"两份控件两份仓库"——它只有一份实现，两个调用点而已。
//
// ⭐⭐ 2026-10-19（docs/250 第 8、10 条，用户定）：改成三个「点一下换一下」的小按钮，省横向空间（200px 宽的头行很挤）：
//   · 张数「3张」：点击【不响应】，只能滚轮调（上 +1 / 下 −1，1~上限）—— 用户 10-19：「张数小按钮只能滚轮调」；
//   · 抗截断「抗关 / R17 / R17+」：点一下换下一档；
//   · 分辨率「1K / 2K / 4K」：点一下按现在能选的档循环（千问模式只有 1K / 2K；工作流预设隐藏 —— 分辨率归工作流自己管）。
//   悬停写全称。滚轮监听挂 window 捕获阶段 + 几何判断（记忆：滚轮监听别挂会隐藏的元素），生成卡卡面的张数条也认（第 10 条）。
// ═══════════════════════════════════════════════════════════════════
// 分辨率能选哪几档 —— 生成卡分辨率下拉和这里的小按钮【共用这一份】（别各写各的）
// ⭐ 2026-10-24（V7待办/02）：阿吉 / 墨墨在后台模型目录里给这个模型配了哪几档，就只给这几档（supplier-models.js）
// ⭐ 10-25（反馈 #41「点了 2K 还是自动跳回 1K」）：云端开源模型 2K 额度用完时，2K 在下拉里灰掉写明「额度用完（10/10）」，
//   小按钮也跳过它 —— 原来照样能点，点完被 qwenClampCard 拨回 1K，看着像坏了。返回 null = 没用完 / 不限 / 本机算
function qwenHighTierOut(){
  if(!qwenCardActive()||V7QwenMode.source()==='local')return null;
  const l=V7QwenMode.limits();
  if(!l||l.highTierUnlimited||l.highTierLeft==null||Number(l.highTierLeft)>0)return null;
  return {used:Number(l.highTierUsed)||0,quota:Number(l.highTierQuota)||0};
}
function aiSizeOptionRows(){
  const out=qwenHighTierOut();
  return aiSizeChoices().map(s=>out&&s==='2K'?[s,'2K · 额度用完'+(out.quota?'（'+out.used+'/'+out.quota+'）':''),'',true]:[s,s]);
}
function aiSizeChoices(){
  if(qwenCardActive())return ['1K','2K'];
  try{
    const slot=aiModelSlot(),hit=(slot==='aji'||slot==='momo')&&window.V7SupplierModels?V7SupplierModels.find(slot,aiRuntime.model):null;
    if(hit&&hit.sizes&&hit.sizes.length)return AI_SIZES.filter(s=>hit.sizes.includes(s));
  }catch(_){}
  return AI_SIZES.slice();
}
// 选了目录里的模型、当前分辨率它不支持 ⇒ 落到它的默认档（只在选模型那一下调，见 generationFieldChanged 里 model 那条）
function aiSnapSizeToModel(){
  try{
    const slot=aiModelSlot(),hit=(slot==='aji'||slot==='momo')&&window.V7SupplierModels?V7SupplierModels.find(slot,aiRuntime.model):null;
    if(hit&&!hit.sizes.includes(String(aiRuntime.size||'').toUpperCase())){aiRuntime.size=hit.default;return true;}
  }catch(_){}
  return false;
}
const ANTI_CHIP_LABELS=['抗关','R17','R17+'];
const ANTI_CHIP_TITLE='抗截断：关 / R17 / R17+（点一下换下一档）。图被服务商截断时用来还原。';
function batchChipTitle(max){ return '张数：在这里滚滚轮调（上 +1 / 下 −1，1~'+max+'）'+(qwenCardActive()&&max<AI_BATCH_MAX?'。开源模型模式下上限是服务器按你的账号给的':''); }
function sizeChipTitle(){ const out=qwenHighTierOut(); return '分辨率：'+aiSizeChoices().join(' / ')+'（点一下换下一档）'+(qwenCardActive()?'。开源模型最高 2K':'')+(out?'。2K 额度用完了'+(out.quota?'（'+out.used+'/'+out.quota+'）':'')+'，现在只能 1K':''); }
function quickParamsHtml(){
  const max=aiBatchMax(),batch=Math.max(1,Math.min(max,Number(aiRuntime.batch)||1));
  const mode=Math.max(0,Math.min(2,Number(aiRuntime.antiMode)||0));
  const size=String(aiRuntime.size||'2K').toUpperCase();
  return '<div class="pz-quick" data-quick-params role="group" aria-label="常用生成参数">'
    +'<span class="qk-chip qk-batch" data-qp-batch-box tabindex="0" role="spinbutton" aria-label="张数" aria-valuemin="1" aria-valuemax="'+max+'" aria-valuenow="'+batch+'" title="'+escapeHtml(batchChipTitle(max))+'"><b data-qp-batch-val>'+batch+'</b>张</span>'
    +'<button type="button" class="qk-chip" data-qp-anti title="'+escapeHtml(ANTI_CHIP_TITLE)+'">'+ANTI_CHIP_LABELS[mode]+'</button>'
    +'<button type="button" class="qk-chip" data-qp-size'+(aiRuntime.workflowPresetId?' hidden':'')+' title="'+escapeHtml(sizeChipTitle())+'">'+escapeHtml(size)+'</button>'
    +'</div>';
}
// 张数加减一档（滚轮 / 键盘上下键都走这里）—— 跟原来的 ± 按钮同一套：工作流预设的 imageCount 跟着走、存临时缓存、刷新两处
function batchStep(dir){
  const cur=Number(aiRuntime.batch)||1, next=Math.max(1,Math.min(aiBatchMax(),cur+dir));
  if(next===cur) return false;
  aiRuntime.batch=next;qwenWantedBatch=0;
  if(aiRuntime.workflowPresetId&&window.PRESETUI&&typeof PRESETUI.setWorkflowParameters==='function'){
    PRESETUI.setWorkflowParameters({imageCount:next,batch:next,count:next},{refresh:false});
  }
  if(typeof aiSaveTempCache==='function')aiSaveTempCache();
  if(typeof aiRefreshInPlace==='function')aiRefreshInPlace();
  return true;
}
function bindQuickParams(root){
  if(!root)return;
  root.querySelectorAll('[data-qp-batch-box]').forEach(box=>{
    if(box._bound)return; box._bound=true;
    box.addEventListener('click',ev=>ev.stopPropagation());          // 点击不响应（也别冒泡去开三级 / 选行）
    box.addEventListener('keydown',ev=>{
      if(ev.key==='ArrowUp'||ev.key==='ArrowRight'){ev.preventDefault();ev.stopPropagation();batchStep(1);}
      else if(ev.key==='ArrowDown'||ev.key==='ArrowLeft'){ev.preventDefault();ev.stopPropagation();batchStep(-1);}
    });
  });
  root.querySelectorAll('[data-qp-anti]').forEach(btn=>{
    if(btn._bound)return; btn._bound=true;
    btn.addEventListener('click',ev=>{
      ev.stopPropagation();
      aiRuntime.antiMode=((Math.max(0,Math.min(2,Number(aiRuntime.antiMode)||0)))+1)%3;
      if(typeof aiSaveTempCache==='function')aiSaveTempCache();
      if(typeof aiRefreshInPlace==='function')aiRefreshInPlace();
    });
  });
  root.querySelectorAll('[data-qp-size]').forEach(btn=>{
    if(btn._bound)return; btn._bound=true;
    btn.addEventListener('click',ev=>{
      ev.stopPropagation();
      const choices=aiSizeOptionRows().filter(r=>!r[3]).map(r=>r[0]), cur=String(aiRuntime.size||'').toUpperCase();
      const i=choices.indexOf(cur);
      aiRuntime.size=choices[(i+1)%choices.length];
      if(typeof aiSaveTempCache==='function')aiSaveTempCache();
      if(typeof aiRefreshInPlace==='function')aiRefreshInPlace();
    });
  });
}
// 值被别处改了（生成卡、缓存恢复、换预设、开关千问）时，把快捷条回填。
function syncQuickParams(){
  qwenClampCard();      // 生成卡没打开时这里也要把张数压进千问上限（显示的数 = 真发的数）
  const max=aiBatchMax(),batch=Math.max(1,Math.min(max,Number(aiRuntime.batch)||1));
  const mode=Math.max(0,Math.min(2,Number(aiRuntime.antiMode)||0));
  const size=String(aiRuntime.size||'2K').toUpperCase(), workflow=!!aiRuntime.workflowPresetId;
  document.querySelectorAll('[data-quick-params]').forEach(box=>{
    const batchBox=box.querySelector('[data-qp-batch-box]');
    if(batchBox){batchBox.title=batchChipTitle(max);batchBox.setAttribute('aria-valuemax',String(max));batchBox.setAttribute('aria-valuenow',String(batch));}
    const val=box.querySelector('[data-qp-batch-val]');
    if(val&&val.textContent!==String(batch)){
      if(window.rollNumber)window.rollNumber(val,String(batch),Number(batch)-(Number(val.textContent)||batch));
      else val.textContent=String(batch);
    }
    const anti=box.querySelector('[data-qp-anti]');
    if(anti&&anti.textContent!==ANTI_CHIP_LABELS[mode])anti.textContent=ANTI_CHIP_LABELS[mode];
    const sizeBtn=box.querySelector('[data-qp-size]');
    if(sizeBtn){
      if(sizeBtn.textContent!==size)sizeBtn.textContent=size;
      sizeBtn.hidden=workflow;sizeBtn.title=sizeChipTitle();
    }
  });
}
// ⭐ 2026-10-19（docs/250 第 10 条）：鼠标停在张数上（快捷条的「3张」或生成卡卡面的张数条）时，滚轮改张数、不翻卡。
//   ⚠ 挂 window 捕获阶段、而且要【比】预设二级那条攒格滚轮（也在 window 捕获、注册得更晚）和全局翻卡（冒泡）先跑 —— 这里在文件里更靠前。
//   ⚠ 判断用「这个点最上层的元素在不在张数控件里」：被三级 / 弹窗盖住、面板正在收起，都不算。
//   ⚠ 触控板一下来好多个小 deltaY：攒够 100 才走一格；鼠标一格（≥50）直接走一格。
let batchWheelAcc=0;
function batchWheelTarget(x,y){
  const hit=document.elementFromPoint(x,y);
  if(!hit)return null;
  const chip=hit.closest&&hit.closest('[data-qp-batch-box]');
  if(chip)return chip;
  const bar=hit.closest&&hit.closest('.nsl');
  return bar&&bar.querySelector('input[data-ai-field="batch"]')?bar:null;
}
window.addEventListener('wheel',e=>{
  if(typeof v7OverlayOpen==='function'&&v7OverlayOpen())return;
  const lock=document.getElementById('popupLock');if(lock&&lock.classList.contains('on'))return;
  if(!batchWheelTarget(e.clientX,e.clientY)){batchWheelAcc=0;return;}
  e.preventDefault();e.stopImmediatePropagation();
  if(Math.abs(e.deltaY)>=50){batchWheelAcc=0;batchStep(e.deltaY<0?1:-1);return;}
  batchWheelAcc+=e.deltaY;
  if(Math.abs(batchWheelAcc)>=100){batchStep(batchWheelAcc<0?1:-1);batchWheelAcc=0;}
},{capture:true,passive:false});
window.V7QuickParams={html:quickParamsHtml,bind:bindQuickParams,sync:syncQuickParams};

function modelQuotaHtml(){
  // ⭐ 2026-10-16 千问模式：这一块换成「在哪算 · 一次最多几张 · 2K 剩几张」（跟 Banana 的连接 / 余额无关）
  if(qwenCardActive()) return qwenQuotaHtml();
  // ⚠ 没配连接时【不画这一块】：那一行整个让给"请去设置里配置"的引导
  //   （用户定：模型空的就说清楚，不要在旁边挂一个"不折算"让人更糊涂）
  if(!aiConnectionConfigured()) return '';
  const slot=aiModelSlot();
  const b=window.V7ProviderSettings?.balanceFor?window.V7ProviderSettings.balanceFor(slot):null;
  const 单价=modelUnitPrice(aiRuntime.model,aiRuntime.size);
  const wrap=(state,html,title)=>'<span class="model-quota" data-model-quota data-state="'+state+'"'+(title?' title="'+escapeHtml(title)+'"':'')+'>'+html+'</span>';
  // ⭐⭐ 2026-10-15 阿吉：用后台价目表显示「每张多少 · 余额还够几张」（美元，参考价，不涉及积分）。
  //   用户原话：「通过不同的模型和不同的分辨率来显示不同的单价和我当前余额能算剩余多少张」。
  //   ⚠ 这一块【不许换行】（卡片高度只剩 ~37px 余量，见 .model-quota 的注释）——
  //     一行只放单价和够几张；本次合计、余额金额、哪一行价目，全放悬停提示里。
  // ⭐ 2026-10-24（V7待办/02，用户定「墨墨跟阿吉一模一样」）：墨墨也显示「单价 · 本次合计 · 余额够几张」，价格来自后台模型目录
  if(slot==='aji'||slot==='momo'){
    const 家=slot==='aji'?'阿吉':'墨墨';
    // ⭐ 2026-10-24（用户定）：显示「¥」，只换符号不换算（数字跟中转站后台一样）
    const usd=v=>'¥'+(v>=10?v.toFixed(1):v.toFixed(2));
    const 张=Math.max(1,Math.min(AI_BATCH_MAX,Number(aiRuntime.batch)||1));
    if(单价==null){
      return wrap('unknown','单价未知 · 以'+家+'账单为准',家+'的模型目录里没有「'+aiRuntime.model+(aiRuntime.size?' '+aiRuntime.size:'')+'」这一档的价格（或目录还没拉到）。'
        +'花多少以'+家+'的账单为准；'+家+'在我们后台「线路与模型」页填上价格就能显示。');
    }
    const 合计=单价*张;
    const hit=(window.V7SupplierModels&&V7SupplierModels.priceFor(slot,aiRuntime.model,aiRuntime.size))||(slot==='aji'&&window.V7AjiPrices?V7AjiPrices.priceFor(aiRuntime.model,aiRuntime.size):null);
    const 有余额=!!(b&&b.amount!=null&&b.unit!=='pts');
    const 够=有余额?Math.max(0,Math.floor(Number(b.amount)/单价+1e-9)):null;
    let tip=家+'参考价：'+usd(单价)+'/张'+(hit&&hit.model?'（'+hit.model+'）':'')+'；本次 '+张+' 张约 '+usd(合计)+'。';
    tip+=有余额?('余额 ¥'+Number(b.amount).toFixed(2)+'，按这个单价还够约 '+够+' 张'+(b.stale?'（余额是上次查到的）':'')+'。')
               :'余额还没查过：到设置卡「用哪家生图」点「检查连接」就能算出还够几张。';
    tip+='实际以'+家+'账单为准；只是参考价，不扣平台积分。';
    // ⭐ 两行：上「单价 · 本次合计」、下「余额够几张」（用户要三样都看得见；框外高不变，见 .model-quota[data-lines] 样式）
    return wrap('known','<span class="mq-l"><b>'+usd(单价)+'</b>/张 · 本次 <b>'+usd(合计)+'</b></span>'
      +'<span class="mq-l">'+(有余额?'余额够 <b>'+够.toLocaleString()+'</b> 张':'余额未查 · 设置里点「检查连接」')+'</span>',tip)
      .replace('<span class="model-quota"','<span class="model-quota" data-lines="2"');
  }
  if(!window.V7ProviderSettings?.canQueryBalance?.(slot)) return wrap('none','自定连接 · 不折算');
  if(!b||b.amount==null) return wrap('unknown','余额未查 · 点设置卡「检查连接」');
  if(b.unit==='pts') return wrap('none','余额 '+Math.round(b.amount).toLocaleString()+' 积分 · 不折算张数');
  if(单价==null) return wrap('unknown','—　单价数据未接入');
  const n=Math.floor(Number(b.amount)/单价);
  return wrap('known','约能生成 <b>'+(n>0?n.toLocaleString():'0')+'</b> 张（¥'+单价.toFixed(2)+'/张）');
}
// ⭐ 2026-10-15：只换估算那一小块（改张数 / 分辨率 / 模型、价目表到了、余额刷新了都要跟着变）。
//   ⚠ 不重建整张卡面：重建会把用户正在点的下拉框收掉。
function refreshModelQuota(){
  const old=document.querySelector('.block-card[data-card="generation"] [data-model-quota]');
  if(!old) return;
  const html=modelQuotaHtml();
  if(!html||old.outerHTML===html) return;
  old.insertAdjacentHTML('afterend',html);
  old.remove();
  // 2026-10-22（docs/263 第三批「参数变化补动画」）：价格/额度刷新后数字轻轻亮一下，让人注意到变了
  const now=document.querySelector('.block-card[data-card="generation"] [data-model-quota]');
  if(now&&window.V7Motion)window.V7Motion.bump(now);
}
window.addEventListener('wheelchair:aji-prices-updated',()=>{ try{ refreshModelQuota(); }catch(_){} });
function renderGenerationCardFields(){
  const host=document.querySelector('.block-card[data-card="generation"] [data-generation-fields]');
  if(!host) return;
  // 2026-10-22（docs/263 第三批「来源切换补动画」）：换渠道 / 换模型 / 进退出千问模式会整块重画，
  //   原来是一下跳变。已有内容时淡入 + 上移 4px；第一次画（host 还空着）不播，免得点开卡片就抖一下。
  const hadContent=!!host.firstElementChild;
  qwenClampCard();
  const qwen=qwenCardActive();
  host.dataset.qwenSig=qwenCardSignature();
  host.innerHTML=
    '<div class="generation-compute"><select data-generation-source aria-label="本次生成算力来源"></select><button type="button" data-generation-config aria-label="打开算力设置" title="打开算力设置">'+(window.ICON?ICON.render('gear',16):'')+'</button><button type="button" data-generation-account></button></div>'+
    // ⚠ 结构：文字单独一行（跟「分辨率/宽高比」那两格同长相），下一行是 下拉框 + 估算块。
    //   别把"模型"两个字跟下拉框并排塞进 grid —— grid 项不能是纯文本节点，
    //   浏览器会包一个匿名项，列就错位了（踩过，下框被压成 17×1 像素）。
    // ⚠⚠ 2026-10-08（用户定）：没配连接 ⇒ 下拉框【空的 + 灰掉】，
    //   旁边直接写"请到设置里配置连接 API Key"，而不是给一串用不了的模型名。
    (function(){
      // ⭐ 千问模式：模型锁成千问 2.1（⚠ 不挂 data-ai-field="model"：不然同步时会把 aiRuntime.model 塞进来、显示成空的）
      if(qwen) return '<div class="gcf modelrow">模型<div class="modelrow-line">'
        +'<select data-qwen-model disabled aria-label="开源模型模式：固定走 ComfyUI 工作流" title="开源模型模式开着：固定走 ComfyUI 工作流。剪影预设里关掉开源模型模式就换回原来的模型。"><option value="">ComfyUI 工作流</option></select>'
        +modelQuotaHtml()
        +'</div></div>';
      const 配了=aiConnectionConfigured();
      // 2026-10-24（V7待办/04）：配了连接但一个模型都没拉到（墨墨没点过「检查连接」）⇒ 明说，不拿别家的名单凑
      const 名单=配了?aiModelOptions():[];
      const 选项=配了&&名单.length?aiSelectOptions(名单,aiRuntime.model)
                     :配了?'<option value="">（还没有模型 · 去设置卡点「检查连接」）</option>'
                     :'<option value="">（还没有模型）</option>';
      return '<div class="gcf modelrow">模型<div class="modelrow-line">'
        +'<select data-ai-field="model"'+(配了?'':' disabled aria-label="还没有模型，请先在设置里配置连接"')+'>'+选项+'</select>'
        +(配了?modelQuotaHtml():'<span class="model-quota" data-state="empty" title="还没有模型 —— 请到设置卡「用哪家生图」里配置这个服务商的地址和 API Key，然后点「检查连接」">还没有模型 · 去设置卡配连接 API Key</span>')
        +'</div></div>';
    })()+
    '<label class="gcf"'+(qwen?' title="开源模型最高 2K"':'')+'>分辨率<select data-ai-field="size">'+aiSelectOptions(aiSizeOptionRows(),aiRuntime.size)+'</select></label>'+
    '<label class="gcf">宽高比<select data-ai-field="aspectRatio">'+aiSelectOptions(AI_ASPECTS.map(x=>[x,x]),aiRuntime.aspectRatio)+'</select></label>'+
    // 张数: 原生数字框的上下箭头已废弃, 改成点按/拖拽的条
    //   千问模式：上限 = 服务器按账号给的（aiBatchMax），见上面 qwenCardActive 那段
    numControl({attr:'data-ai-field="batch"',name:'张数',min:1,max:aiBatchMax(),step:1,value:Number(aiRuntime.batch)||1,cls:'gcf'})+
    '<label class="gcf" title="'+escapeHtml(ANTI_MODE_TIP)+'">抗截断<select data-ai-field="antiMode">'+
      aiSelectOptions(ANTI_MODE_LABELS.map((label,i)=>[String(i),label]),String(Number(aiRuntime.antiMode)||0))+
    '</select></label>'+
    // ⭐ 这两个原本只在设置里, 但它们【每次生成都可能要改】, 而且直接决定成败:
    //   抓取分辨率 = 发出去多大(4096 被 AI 服务器以 413 退回过);
    //   无选区用整张画布 = 没框选区时还能不能跑。
    //   属于"生成强相关", 挪到卡面。设置里那两处保留, 两边同一个值(settingsRuntime)。
    '<label class="gcf">抓取分辨率<select data-setting="captureMaxEdge">'+
      aiSelectOptions([['1024','1024'],['1536','1536'],['2048','2048'],['3072','3072'],['4096','4096']],String(settingsRuntime.captureMaxEdge||'2048'))+
    '</select></label>'+
    // ⭐⭐⭐ 2026-10-08（docs/170 §4.8）：卡面这一格从「传回图层」换成「校色方式」。
    //   为什么换：传回图层是【一次定下、很少改】的（搬去设置卡「传回」页）；
    //   而校色方式是【每次生成都可能想换】的 —— 用户要的正是"随手能切"。
    //   ⚠ 标签最多 4 字：同文件上面那两条注释记着"格子净宽只有约 110px"、
    //     "长文案会被切成'生成完成…'(用户截图)"。所以这里只写 2 个字的效果名，
    //     完整说明（每种什么时候不好）放 title，鼠标停上去能看全。
    //   ⚠ 同一个键在【二级「对齐与校色」组】里还有一份 —— 靠 syncSettingControl
    //     保两边显示一致（否则就是铁律 16 说的"两份控件两份仓库"）。
    '<label class="gcf" title="'+escapeHtml(COLOR_MODE_TIP)+'">校色方式<select data-setting="colorMatchMode">'+
      aiSelectOptions(COLOR_MODE_SHORT_OPTIONS,String(wantColorMode()))+
    '</select></label>'+
    // ⚠ 开关在半宽格子里只有约 120px，长文案会被切成"生成完成…"(用户截图)。
    //   标签给短的，完整说明放 title(鼠标停上去能看全)。
    // ⚠ 开关格子净宽只有约 110px，开关本体占 32px —— 标签最多四个字，
    //   再长就变成"无选区用…"(2026-09-11 用户截图)。完整意思靠 title。
    // ⚠⚠ 2026-09-13 修（用户实测"关了自动传回还是会传"）：
    //   这个开关以前写 data-ai-field（存进 aiRuntime），而设置卡上那个【同名开关】
    //   写 data-setting（存进 settingsRuntime）—— 两个开关、两个仓库、一个功能。
    //   而且是单向同步：settingsSave() 每次都用 settingsRuntime 把 aiRuntime 盖回去，
    //   启动时 aiLoadTempCache() 又用 7 天有效的临时缓存再盖一次（顺序在 settings 之后）。
    //   真正决定传不传的是 aiRuntime.autoReturn，于是出现"开关显示关、实际在传"
    //   —— 铁律 16 说的假开关。现在统一只写 settingsRuntime，aiRuntime 那份只当镜像。
    switchControl('自动传回','data-setting="autoReturn"',settingsRuntime.autoReturn===true,'生成完成后自动贴回 Photoshop')+
    switchControl('用整张图','data-setting="autoFullCanvas"',!!settingsRuntime.autoFullCanvas,'没有框选区时，直接用整张画布');
  bindNumControls(host);
  host.querySelector('[data-generation-config]').onclick=event=>{event.stopPropagation();const workflow=!!aiRuntime.workflowPresetId;const section=workflow?(settingsRuntime.workflowSource==='local'?'local':'own'):(settingsRuntime.imageComputeSource==='platform'?'platform':'own');navigateCard('settings',0,{section}).catch(error=>ERR.report('LAYOUT_FAILED',{message:String(error.message||error)}));};
  host.querySelector('[data-generation-account]').onclick=event=>{event.stopPropagation();const signed=window.V7Backend?.state?.().signedIn;if(signed)window.V7RouteRegistry?.open('records/billing');else navigateCard('settings',0,{section:'account'});};
  host.querySelector('[data-generation-source]').onchange=event=>{
    if(gcSyncing)return;
    const select=event.target,qwen=qwenCardActive(),key=qwen?'qwenSource':aiRuntime.workflowPresetId?'workflowSource':'imageComputeSource';
    if(aiHasActiveRequest()||select.selectedOptions[0]?.disabled){syncGenerationCompute();return;}
    if(!(qwen?['platform','local']:['own','platform',...(aiRuntime.workflowPresetId?['local']:[])]).includes(select.value))return;
    // 2026-10-18 深夜：工作流的「自有工作流」= RunningHub，没接线（总开关 window.V7_RUNNINGHUB_OFF）
    if(window.V7_RUNNINGHUB_OFF&&!qwen&&aiRuntime.workflowPresetId&&select.value==='own'){select.value=String(settingsRuntime.workflowSource||'platform');return;}
    settingsRuntime[key]=select.value;if(key==='workflowSource')settingsRuntime.workflowSourceChosen=true;settingsSave();aiRefreshInPlace();
  };
  syncGenerationCompute();
  // 卡面上混了两种字段: data-ai-field 存进 aiRuntime(本次生成参数)、
  // data-setting 存进 settingsRuntime(持久设置)。分开写，别串。
  host.querySelectorAll('[data-ai-field]').forEach(el=>{
    const write=()=>{
      aiRuntime[el.dataset.aiField]=el.type==='checkbox'?!!el.checked:el.value;
      if(el.dataset.aiField==='batch')qwenWantedBatch=0;
      if(el.dataset.aiField==='batch'&&aiRuntime.workflowPresetId&&window.PRESETUI)PRESETUI.setWorkflowParameters({imageCount:Number(el.value),batch:Number(el.value),count:Number(el.value)},{refresh:false});
      if(el.dataset.aiField==='model')aiSnapSizeToModel();   // 2026-10-24：目录模型不支持当前分辨率 ⇒ 落到它的默认档
      aiSaveTempCache();
    };
    el.addEventListener('input',()=>{ if(gcSyncing)return; write(); });
    el.addEventListener('change',()=>{ if(gcSyncing)return; write(); aiRefreshInPlace(); });
  });
  host.querySelectorAll('[data-setting]').forEach(el=>{
    const write=()=>{
      const k=el.dataset.setting;
      if(!Object.prototype.hasOwnProperty.call(settingsRuntime,k)) return;
      settingsRuntime[k]=el.type==='checkbox'?!!el.checked:el.value;
      settingsSave();            // 落盘 + 同步给 aiRuntime/外观
    };
    el.addEventListener('input',()=>{ if(gcSyncing)return; write(); });
    el.addEventListener('change',()=>{ if(gcSyncing)return; write(); aiRefreshInPlace(); });
  });
  // ⚠ 主卡【任何地方都要能滚轮切卡】(用户 2026-09-11 定案) —— 所以这里
  //   绝不能拦 wheel。之前拦过一版，结果鼠标停在参数上就滚不动卡了。
  //   数值改用拖拽条之后也不怕滚轮误改：range 不响应滚轮，
  //   下拉面板展开时全局滚轮本来就会让给它(UISelect.isOpen 判断)。
  //   点击和按下仍然要吃掉，否则会被主卡当成自己的点击/拖拽。
  ['mousedown','click'].forEach(type=>{
    host.addEventListener(type,e=>e.stopPropagation());
  });
  // 按在参数条上 = 开始拖 → 期间不判横向推进(见 mousemove 里的 gcDragging)
  host.addEventListener('mousedown',e=>{
    if(e.target&&e.target.classList&&e.target.classList.contains('nsl-range')) gcDragging=true;
  });
  if(hadContent&&window.V7Motion)window.V7Motion.swap(host);
}
// aiRuntime 被别处改了(设置页同步/从缓存恢复)时，把卡面上的值跟上。
// ⚠ 跳过正在操作的那个控件，不然会把用户刚选的值冲掉。
// 生成卡上用到的那几个 data-setting 键 —— aiRefreshInPlace 要把它们同步到别处。
// ⚠ 清单要跟卡面上的 data-setting 保持一致；漏一个的后果是"那张卡上的值不跟手"。
const GENERATION_CARD_SETTING_KEYS = [
  'captureMaxEdge', 'layerType', 'autoReturn', 'autoFullCanvas',
  'colorMatchMode', 'autoAlign', 'alignMode', 'matchTier',
];

function syncGenerationCardFields(){
  const host=document.querySelector('.block-card[data-card="generation"] [data-generation-fields]');
  if(!host || gcSyncing) return;
  // ⭐ 千问模式开关 / 张数上限变了：模型那格、分辨率选项、张数框上限都不一样，整块重画（只在变的那一下）
  if(host.dataset.qwenSig!==qwenCardSignature()){
    renderGenerationCardFields();
    const footer=document.querySelector('.gc-foot-info');if(footer)footer.textContent=generationFootInfo();
    return;
  }
  qwenClampCard();
  gcSyncing=true;
  try{
    syncGenerationCompute();
    const footer=document.querySelector('.gc-foot-info');if(footer)footer.textContent=generationFootInfo();
    host.querySelectorAll('[data-ai-field="model"],[data-ai-field="size"],[data-ai-field="aspectRatio"]').forEach(el=>{
      const row=el.closest('.gcf'); if(row)row.style.display=aiRuntime.workflowPresetId?'none':'';
      el.disabled=!!aiRuntime.workflowPresetId;
    });
    host.querySelectorAll('[data-ai-field],[data-setting]').forEach(el=>{
      if(el===document.activeElement) return;
      const k=el.dataset.aiField||el.dataset.setting;
      const v=el.dataset.aiField?aiRuntime[k]:settingsRuntime[k];
      if(el.type==='checkbox'){ if(el.checked!==!!v) el.checked=!!v; }
      else if(String(el.value)!==String(v==null?'':v)){
        el.value=v==null?'':v;
        // 拖拽条: 值变了要重算填充宽度和右上角那个数字
        if(el.classList.contains('nsl-range')){
          const min=Number(el.min)||0,max=Number(el.max)||100,nv=Number(el.value);
          el.style.setProperty('--fill',(max>min?(nv-min)/(max-min)*100:100).toFixed(1)+'%');
          const out=el.closest('.nsl')&&el.closest('.nsl').querySelector('[data-nsl-val]');
          if(out) out.textContent=String(nv)+(el.dataset.nslSuffix||'');
        }
        // ⚠ select 被 ui-select.js 包成了毛玻璃面板，直接改 value 它不知道 ——
        //   必须派个 change 让它重画标签(它自己就是靠这个同步的)，
        //   否则值变了而显示还是旧的，典型的静默失效。
        if(el.tagName==='SELECT') el.dispatchEvent(new Event('change',{bubbles:false}));
      }
    });
  } finally { gcSyncing=false; }
}
let generationPointsCache=null,generationPointsPending=false,generationPointsAt=0,generationPointsEpoch=0;
function syncGenerationCompute(){
  const source=document.querySelector('[data-generation-source]'),accountButton=document.querySelector('[data-generation-account]');
  if(!source||!accountButton)return;
  const workflow=!!aiRuntime.workflowPresetId,qwen=qwenCardActive(),key=qwen?'qwenSource':workflow?'workflowSource':'imageComputeSource',selected=String(settingsRuntime[key]||(qwen?'platform':'own')),account=window.V7Backend?.state?.()||{},busy=aiHasActiveRequest();
  const ownReady=workflow?!!settingsRuntime.runninghubKey:aiProviderReady();   // ⚠ GRS 托管没有 key 也算配好（见 aiProviderReady）
  // ⭐ 2026-10-16 千问模式：这一格就是设置里的「千问模式在哪算」（云端 / 本机 ComfyUI），跟 Banana 的连接无关
  const choices=qwen?[['platform','云端开源模型',!!account.signedIn],['local','本机 ComfyUI',!!settingsRuntime.comfyUrl]]
    :workflow?[['local','本地 ComfyUI',!!settingsRuntime.comfyUrl],['own',window.V7_RUNNINGHUB_OFF?'自有工作流（RunningHub）':'自有工作流',window.V7_RUNNINGHUB_OFF?false:ownReady],['platform','平台工作流',!!account.signedIn]]:[['own','自有 API · '+(V7ProviderConnections.TITLES?.[settingsRuntime.provider]||settingsRuntime.provider||'其他'),ownReady],['platform','平台算力',!!account.signedIn]];
  const html=choices.map(([value,label,ready])=>'<option value="'+value+'"'+(value===selected?' selected':'')+(!ready&&(value!==selected||(workflow&&value==='own'&&window.V7_RUNNINGHUB_OFF))?' disabled':'')+'>'+escapeHtml(label+(!ready?(value==='platform'?' · 需登录':(workflow&&value==='own'&&window.V7_RUNNINGHUB_OFF)?' · 暂未接通':' · 需配置'):''))+'</option>').join('');
  if(source.innerHTML!==html)source.innerHTML=html;
  if(source.value!==selected)source.value=selected;
  source.disabled=busy;source.title=busy?'当前任务结束后可切换工作流引擎':'本次生成工作流引擎';
  const points=generationPointsCache?.balances;
  const balance=points?'通用 '+Number(points.common||0)+' · Banana '+Number(points.banana||0)+' 积分':account.signedIn?'已登录 · 账单与余额':'未登录 · 账号设置';
  accountButton.textContent=(busy?aiActiveCount()+' 个任务处理中 · ':'')+balance;accountButton.title=accountButton.textContent;
  if(account.signedIn&&selected==='platform'&&!generationPointsPending&&Date.now()-generationPointsAt>60000){
    const epoch=generationPointsEpoch,scope=cacheNamespaceId(),session=account.sessionVersion;
    generationPointsPending=true;generationPointsAt=Date.now();
    V7Backend.points().then(value=>{if(epoch===generationPointsEpoch&&scope===cacheNamespaceId()&&session===V7Backend.state().sessionVersion){generationPointsCache=value;syncGenerationCompute();window.V7MainCardShortcuts?.refresh('settings');}}).catch(()=>{}).finally(()=>{if(epoch===generationPointsEpoch)generationPointsPending=false;});
  }
}
window.addEventListener('wheelchair:settings-changed',syncGenerationCompute);
window.addEventListener('wheelchair:storage-context',()=>{generationPointsEpoch++;generationPointsCache=null;generationPointsPending=false;generationPointsAt=0;queueMicrotask(syncGenerationCompute);});
window.V7Backend?.onChange?.(()=>{generationPointsEpoch++;generationPointsCache=null;generationPointsPending=false;generationPointsAt=0;syncGenerationCompute();});
function aiGenerate(){aiReadFields(document);aiBeginImmediate();}
function aiFull(){aiReadFields(document);aiBeginImmediate({autoReturn:true});}
function aiTaskContextGuard(task){
  const scope=cacheNamespaceId(),epoch=sourceImageEpoch;
  return ()=>scope===cacheNamespaceId()&&epoch===sourceImageEpoch&&(!task||taskById(task.taskId||task.id)===task);
}
function aiDetachedTransfer(submitted,result){
  return {ok:false,code:'AI_CONTEXT_CHANGED',detached:true,submitted:!!submitted,
    error:submitted?'账号或任务已变化，已停止后续处理；已发送的 Photoshop 操作可能已完成':'账号或任务已变化，未向 Photoshop 发送操作',
    outcomeUnknown:!!submitted&&!(result&&result.ok===true),result};
}
// ⭐ onlyIndexes：只传这几张（缩略图上的单张「传回」用）。不传 = 传所有还没传过的。
// ⭐ 10-25：第三个参数 opts.masks = { 第几张: {rle, width, height} }（任务卡「分割」用，游程编码的灰度蒙版、尺寸 = 选区）—— 带了蒙版的那一张，插件贴完按选区左上角写进图层蒙版、不加边缘羽化。
function aiTransfer(taskOrSnapshot, onlyIndexes, opts){
  const task=taskOrSnapshot&&taskOrSnapshot.taskId?taskOrSnapshot:aiSelectedTask();
  const ownsTransfer=aiTaskContextGuard(task);
  if(!ownsTransfer()) return Promise.resolve(aiDetachedTransfer(false));
  if(task?.colorToolRunId){
    if(window.V7ColorTools?.transferRun)return V7ColorTools.transferRun(task.colorToolRunId,onlyIndexes);
    const message='调色工作面尚未就绪，已阻止普通传回；请重新启动软件后从调色工作面重试。';
    ERR.report('CREATIVE_TOOL_FAILED',{message});return Promise.resolve({ok:false,error:message});
  }
  if(task?.migration?.returnBlocked){
    const message='V6 历史结果没有当前 Photoshop 文档绑定，已阻止传回。可查看或从缓存文件夹另行打开图片。';
    ERR.report('HISTORY_OPERATION_FAILED',{message});
    return Promise.resolve({ok:false,error:message,code:'HISTORY_RETURN_BLOCKED'});
  }
  // ⚠⚠ 2026-09-13 修：不能再读 task.outputs 了。
  //
  //   `task.outputs` 是【整批跑完】时才一次性赋值的（aiRestoreTaskImages 收尾那句
  //   `task.outputs = restored.filter(...)`）。生成中途它是空的 ——
  //   所以「提前结束」中途调这里，拿到空数组，直接走"没有可传回的生成结果"，
  //   **按下去什么都不发生**（用户 2026-09-13 实测撞到）。
  //
  //   改成【从 shots 现算】，并且自动跳过【已经传回过的】(psLayerByShot 里有记录的)：
  //     · 中途传一批 → 后面算完再传一批，不会重复贴图层
  //     · 整批跑完的老路径行为不变（那时 psLayerByShot 是空的，一个都不跳）
  let outputs=task?taskTransferableOutputs(task):((aiRuntime.outputs)||[]);
  if(task&&Array.isArray(onlyIndexes)&&onlyIndexes.length){
    const want=new Set(onlyIndexes.map(Number));
    outputs=outputs.filter(o=>want.has(Number(o.index)));
  }
  const isCurrent=()=>ownsTransfer()&&(!task||String(task.taskId||task.id||'')===String(aiRuntime.currentTaskId||''));
  const setStatus=(value)=>{if(isCurrent())aiRuntime.status=value;};
  if(!outputs.length){setStatus('没有可传回的生成结果');aiAddLog('没有可传回的生成结果','warn');aiRefreshInPlace();return Promise.resolve(null);}
  // ⭐⭐ 在途锁（2026-09-13 用户实测"传回容易多次传回"）。
  //   传回要等 Photoshop 的真回执，少则一两秒、多则十几秒，这期间按钮一直是能点的 ——
  //   连点两下就是两批图同时往 PS 里贴，图层会翻倍。
  //   ⚠ 必须在【所有出口】都解锁，漏一条这个按钮就永久点不动了，所以放在链尾统一解。
  if(task&&task._transferBusy){
    aiAddLog('上一次传回还没完成（Photoshop 还在贴图），等它结束再点','warn');
    aiRefreshInPlace();
    return Promise.resolve(null);
  }
  const c=aiCaptureSnapshot((task&&task.captureSnapshot)||task||null,task&&task.antiMode!==undefined?task.antiMode:aiRuntime.antiMode)||{};
  if(isDebugOn()){
    dbg('传回','准备贴回 '+outputs.length+' 张 · 目标文档 '+(c.docName||c.docId||'?')
      +' · 图层类型 '+(settingsRuntime.layerType==='smartObject'?'智能对象':String(settingsRuntime.layerType||'')));
  }
  if(!c||c.docId===null||c.docId===undefined||!c.selection){
    const msg='当前任务缺少完整的 Photoshop 来源快照，已阻止传回';
    setStatus(msg);aiAddLog(msg,'error');
    if(task)updateGenerationTask(task.taskId||task.id,{status:'failed',stage:'transfer',errorCode:'AI_SOURCE_SNAPSHOT_MISSING',error:msg,sub:msg});
    aiRefreshInPlace();
    return Promise.resolve({ok:false,error:msg});
  }
  // 结果已经在 UI 侧按任务快照完成还原；传回固定使用该任务的文档和选区。
  // ⚠⚠ 传回用的是【原图】，不是缩略图。原图从头到尾没被重新编码过：
  //    抗截断关 = 接口返回的原始字节原样；抗截断开 = 还原后的无损 PNG。
  //    绝不能图省事把缩略图传过去 —— 那是有损 JPEG，贴进 PS 画质就废了。
  // base64 只在这一刻现取，用完即弃，不留在任何对象里。
  // (桥那边 cleanBase64 按第一个逗号切，裸 base64 里没有逗号，所以给裸的就行。)
  const ready=outputs.filter(x=>x&&x.restoreState==='done'&&x.imgId);
  const sel=aiClonePlain(c.selection);
  const layerType=(settingsRuntime&&settingsRuntime.layerType)||'smartObject';
  const feather={enabled:settingsRuntime.returnFeather===true,
    shrinkPercent:Math.max(0,Math.min(50,Number(settingsRuntime.returnFeatherShrink)||0)),
    blurPercent:Math.max(0,Math.min(50,Number(settingsRuntime.returnFeatherBlur)||0))};
  setStatus('正在准备传回数据');aiRefreshInPlace();
  if(task) task._transferBusy=true;
  const unlock=()=>{ if(task) task._transferBusy=false; };
  // ⭐⭐ 2026-10-05（docs/136 S3）：这一张调过强度 → 传【调好的那一帧】，不是 100% 原图。
  //   用户实测："修改完强度之后点击传回，传回的不是修改完强度的，而是满强度的。"
  //   真因就是下面这句原来只有 IMG.base64(x.imgId) —— 从来没问过调强度模块。
  //   ⚠ 没调过 / 调回 100% → frameBytesFor 给 null → 照旧传无损原图（一个字节不变）。
  //   ⚠ 帧还在算 → frameBytesFor 会等它算完；算失败就报错，【不许】悄悄退回 100%
  //     （悄悄退回就是这次 bug 的形态：用户以为传的是调过的，其实不是）。
  const pickBase64=x=>{
    const T=window.V7Tween;
    if(!task||!T||typeof T.frameBytesFor!=='function') return window.IMG.base64(x.imgId);
    return T.frameBytesFor(task,x.imgId).then(bytes=>{
      if(!bytes) return window.IMG.base64(x.imgId);
      aiAddLog('第 '+(Number(x.index)+1)+' 张按调好的强度传回','info');
      return bytesToBase64(bytes);
    });
  };
  const masks=(opts&&opts.masks)||{};
  return Promise.all(ready.map(x=>pickBase64(x).then(b64=>Object.assign({imageBase64:b64,selection:aiClonePlain(sel),antiMode:0,layerType:layerType},
      masks[x.index]?{maskRle:masks[x.index].rle,maskWidth:masks[x.index].width,maskHeight:masks[x.index].height}:{}))))
    // ⚠ ready 要一路带到传回回执那里：图层 ID 按发送顺序返回，
    //   只有对着 ready 才能还原"第几张图 → 哪个图层"(见 autoGroupAfterTransfer)。
    .then(items=>ownsTransfer()?aiTransferSend(items,task,c,setStatus,ready,ownsTransfer,feather):aiDetachedTransfer(false))
    .catch(error=>{
      if(!ownsTransfer()) return aiDetachedTransfer(false);
      const msg='准备传回数据失败：'+(error&&error.message||error);
      setStatus(msg);aiAddLog(msg,'error');
      if(task)updateGenerationTask(task.taskId||task.id,{status:'failed',stage:'transfer',errorCode:'AI_TRANSFER_PREPARE_FAILED',error:msg,sub:msg});
      aiRefreshInPlace();
      return {ok:false,error:msg};
    })
    // ⚠ 解锁放在最后一环，成功失败都解 —— 不解的话这个任务的传回就永久废了。
    .then(value=>{ unlock(); return value; }, error=>{ unlock(); throw error; });
}
