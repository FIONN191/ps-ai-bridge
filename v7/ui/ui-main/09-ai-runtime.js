// ═══ ui-main/09-ai-runtime.js —— 主界面主程序第 9 / 21 段 ═══
//   管什么：AI 全量验证运行时 · 模型名单（先问后台）
//   2026-10-21 从 ui.html 那一整段内联 <script> 原样切出来。⚠ 改完跑 node scripts/build-ui-main.cjs 拼成 ui-main.js（软件加载的是那个）。
//   所有顶层的函数 / 变量照旧是全局的、互相直接用（拼起来还是一整段）。说明见 ui-main/README.md。
// ── 以上是文件说明（拼进 ui-main.js 时会去掉）──
// ── AI 全量验证运行时：状态与输入分离，生成进度只更新节点 ──
// 一次最多生成多少张。⚠ 全项目唯一出处 —— 这个数字原先散在 5 个地方
// (卡面控件、调试面板、aiReadFields 的钳制、两个壳各自的 total 计算)，改一处必漏其余。
// ⚠ 两个壳的后端也要同步(main.js / tauri-adapter.js 里各有一份 AI_BATCH_MAX)，
//   只改界面的话用户看到上限 18、后端照样肯跑更多(铁律 14)。
// ⚠ 必须声明在【所有使用点之前】：const 有暂时性死区，
//   放晚了整个主脚本会当场抛错、后面的初始化全不跑(铁律 17，2026-09-11 连栽两次)。
const AI_BATCH_MAX=18;
const AI_ASPECTS=['1:1','Auto','9:16','16:9','2:3','3:2','3:4','4:3','4:5','5:4','21:9','9:21','2:1','1:2','3:1','1:3'];
const AI_MODELS=[
  ['AJbanana3','香蕉Pro'],['Banana-pro-D','香蕉Pro-D'],['AJbanana2','香蕉2'],['gemini-2.5-flash-image','香蕉1'],['gpt-image-2','GPT-Image-2'],
  ['nano-banana-2','nano-banana-2'],['nano-banana-fast','nano-banana-fast'],['nano-banana','nano-banana'],['nano-banana-pro','nano-banana-pro'],['nano-banana-pro-vip','nano-banana-pro-vip'],['gpt-image-2-vip','GPT-Image-2 VIP']
];
// ═══ 模型名单：先问后台，后台没有就用上面这份（docs/114 第 5 件）═══
//
//  ⚠⚠ 2026-10-02 实装时查到：后台 /v1/models 现在【不能直接替换】上面这份 ——
//     真实库里 aji / momo 两个服务商的模型表是空的，GRS 根本没登记，
//     其余几条是占位名（banana-image 之类，服务商那边根本不存在）。
//     直接替换 = 下拉框里全是选了就失败的模型。
//  → 所以规则是：当前通道（aji / momo / grs）后台【有登记】就用后台的，
//     后台是空的 / 没登录 / 连不上，就用上面写死的这份（方案要求的「离线兜底」）。
//     按现在的数据结果跟改之前一模一样；以后后台给 aji 填上模型，生成卡自动跟上。
//  ⚠ 用户已经选中的模型不在名单里时【保留它】（标「当前」），不悄悄换掉 ——
//     悄悄换模型 = 价格、效果都变了，用户还不知道。
//  ⚠ 「自定义」通道（other）不问后台：那是用户自己接的服务，后台不可能知道它有什么模型。
const aiBackendModels=new Map();   // 通道 → [[id,名字],...]
let aiBackendModelsEpoch=0;
function aiModelSlot(){return String(aiRuntime.connectionSlot||settingsRuntime.provider||'aji');}
/* ⭐ 2026-10-08：阿吉的模型名带分辨率后缀（AJbanana3-2k）。
   用户定："三档浓缩成一个模型选择" ⇒ 界面上显示【基础名】，后缀交给分辨率栏。
   ⚠ 这个工具要放在 aiModelOptions 之前 —— 它是 const 箭头函数，
     放在后面用会撞暂时性死区（那个坑本项目栽过，注释里也写着）。 */
const AI_SIZE_SUFFIX=/-(?:1k|2k|4k)$/i;
const aiModelBase=id=>String(id==null?'':id).replace(AI_SIZE_SUFFIX,'');
const AI_SIZES=['1K','2K','4K'];
const aiSizeOfId=id=>{const m=AI_SIZE_SUFFIX.exec(String(id==null?'':id));return m?m[0].slice(1).toUpperCase():'';};
/* ⭐⭐ 2026-10-07 新增第三层来源（用户要求："从中转站动态拉取模型""筛选掉不必要的字段，只拉取生图模型"）：
   优先级 = ①用户自己中转站探测到的名单 → ②后台账号的模型表 → ③写死的兜底 AI_MODELS。
   ⚠ 为什么①最可信：那是用户自己填的地址和 Key，拉回来的就是他实际能用的模型；
     而②后台（docs/121 实测）当时是空的/占位名，③写死那份里混着中转商自定义别名、换站就失效。
   ⚠ 每一项带"tier"：'image' = 确定像生图（下拉框正常亮度）；'other' = 名字看不出/疑似非生图
     （下拉框灰色，但【仍然可选】—— 中转商爱起自定义名，删掉就是静默失效，绝不许删）。
   ⚠ 当前选中的模型永远保留（沿用原来那条规矩："不悄悄换掉"，换了价格和效果都变）。

   ⚠⚠⚠ 2026-10-08（用户定）：**从没填过 Key 的连接 ⇒ 模型下拉框必须是空的**，
     并在那一行直接引导"请到设置里配置连接 API Key"。
     原话："如果说用户从来都没有在那个地方输入过key的话，那么模型选择那个地方就必然是空的，
     空的那个地方就过去就是没有模型，请到设置里面配置连接API key就OK。"
     ⇒ 理由：没配连接时给他看一串模型名是【假的可用性】——他选了半天，生成时才失败。
       更糟的是原来那份写死的兜底名单里有中转商别名（AJbanana3 这种），
       换个中转站根本不存在。宁可他这一刻看到"没有模型"，也不要他以为能用。
     ⚠ 判定用 connection().url（"这个槽配过地址没有"），不看 apiKey ——
       有的中转站地址填了 Key 还没填，那也是"没配完"，同样不给名单。
     ⚠ 判据不许自己拼字段（去读 V7ProviderConnections），否则以后槽位改名这里就静默失配。 */
function aiConnectionConfigured(){
  try{
    const c=window.V7ProviderConnections?.connection?.(settingsRuntime);
    return !!(c&&String(c.url||'').trim());
  }catch(_){ return false; }
}
// ⭐ 2026-10-21（用户要求，照 V6 算力槽位）：下拉框里露哪些模型、叫什么名字，由设置「渠道名字和露出的模型」决定。
//   ⚠ 只在这一层做（生成卡 / 助手 / 重算 / 记录都走 aiModelOptions），原始名单的生成（aiModelOptionsRaw）一个字没动。
//   ⚠ 只换显示名、只藏不删：真实模型 id 不变；当前选着的模型就算被藏也照样留着（老预设 / 历史重算不丢）。
function aiModelOptions(current){
  const rows=aiModelOptionsRaw(current);
  if(!window.V7ComputeSlots)return rows;
  const cur=current==null?String(aiRuntime.model||''):String(current||'');
  return V7ComputeSlots.applyModels(rows,(settingsRuntime.computeModelPrefs||{})[aiModelSlot()],cur);
}
function aiModelOptionsRaw(current){
  const slot=aiModelSlot();
  if(!aiConnectionConfigured()) return [];              // ⚠ 空就是空，不给兜底名单
  const 中转=window.V7ProviderSettings?.modelsFor?window.V7ProviderSettings.modelsFor(slot):null;
  // ⭐ 2026-10-24（V7待办/02）：阿吉 / 墨墨在我们后台配了【模型目录】（supplier-models.js）⇒ 下拉框以目录为准：
  //   显示名是供应商起的，键是基础请求名（拼不拼 -2K 后缀发请求时 modelForRequest 再按目录拼）。
  //   ⚠ 下面那套「阿吉名单按后缀收敛」只管中转站原始名单，目录的键本来就是基础名，别再过一遍（会被当成「不带后缀直接无视」）。
  //   中转站拉到、目录里没有的模型照旧灰色列在后面（老规矩：中转商爱起自定义名，删掉就是静默失效）。
  const 目录=(slot==='aji'||slot==='momo')&&window.V7SupplierModels?V7SupplierModels.modelsFor(slot):[];
  if(目录.length){
    const 当前=current==null?String(aiRuntime.model||''):String(current||'');
    const out=目录.map(m=>[m.id,m.name,'image']);
    const 见过=new Set(目录.map(m=>m.id.toLowerCase()));
    for(const raw of (中转||[])){
      const id=typeof raw==='string'?raw:String(raw&&(raw.id||raw[0])||'');
      const 基础=aiModelBase(id)||id;
      if(!基础||见过.has(基础.toLowerCase()))continue;
      见过.add(基础.toLowerCase());
      out.push([基础,基础,'other']);
    }
    const 当前基础=aiModelBase(当前)||当前;
    return (当前基础&&!out.some(x=>x[0].toLowerCase()===当前基础.toLowerCase()))?out.concat([[当前基础,当前基础+'（当前）','other']]):out;
  }
  const remote=aiBackendModels.get(slot);
  let list=null, tag=null;
  if(中转&&中转.length){
    const g=(window.V7ProviderModels&&V7ProviderModels.group)?V7ProviderModels.group(中转):{image:中转.slice(),other:[]};
    list=g.image.concat(g.other);
    tag=id=>g.image.includes(id)?'image':'other';
  }else if(remote&&remote.length){
    list=remote;
  }else{
    // ⭐ 2026-10-24（V7待办/04）：写死的 AI_MODELS 是【阿吉的名字】（AJbanana3 = 香蕉Pro …）。
    //   墨墨没拉到自己的清单时原来也退到这里 ⇒ 用户在墨墨下选「香蕉Pro」，发给墨墨的是 AJbanana3。
    //   墨墨 ⇒ 空着（生成卡写「点检查连接」），写死兜底只给阿吉和老路径用。
    list=slot==='momo'?[]:AI_MODELS;
  }
  const cur=current==null?String(aiRuntime.model||''):String(current||'');
  /* ⚠⚠⚠ 2026-10-08 修（用户反复报的"模型显示不正常、只有一个字母"，真因就在这里）：
     `list.map(x=>[x[0],x[1],…])` 这句【假定每一项是 [键,名字] 两元数组】，
     但三个来源的形状根本不一样：
       · AI_MODELS（写死那份）      → [['AJbanana3','香蕉Pro'], …]      两元数组 ✅
       · 后台模型表 aiBackendModels → [['gpt-image-1','gpt-image-1'], …] 两元数组 ✅
       · 中转站名单（中转缓存）      → ['AJbanana3','Banana-pro-D', …]   **纯字符串** ❌
     ⇒ 字符串取 [0]/[1] 就是它的【第 0 个字符和第 1 个字符】：
         'AJbanana3' → 键 'A'、名字 'J'；于是下拉框里出现 A / B / g / g / n / d 这种。
     实测证据（打桩一份真实名单跑出来的）：
        aiModelOptions() = [["A","J","other"],["B","a","other"],["g","e","other"],…]
     这是【形状假设写错】，跟下拉框宽度、跟显示名长短都无关 —— 我前面按"太窄被截断"去修过一轮，
     那是误判（宽度确实也窄，但那不是这个症状的原因）。
     ⇒ 在这里【统一归一化】：不管来源给的是字符串还是两元数组，一律先变成 [键, 显示名]。
     ⚠ 归一化必须在这一层做，不能在各调用方各做一遍（调用方有五处，漏一处就又出现单字母）。
     ⚠ 对象形状（{id,name}）也一并兜住 —— 后台以后可能改成对象。 */
  const 归一=x=>{
    if(typeof x==='string')return [x,x];                    // 中转站名单：字符串就是模型 id
    if(Array.isArray(x))return [String(x[0]),String(x[1]==null?x[0]:x[1])];
    if(x&&typeof x==='object'){const id=String(x.id||x.name||'');return [id,String(x.name||id)];}
    return ['',''];
  };
  let rows=list.map(归一).filter(r=>r[0]);

  /* ⭐⭐ 2026-10-08 阿吉专用：把"分辨率钉在模型名里"的名单收敛成一个模型。
     用户给的规则（原话）："所有不带后缀的直接无视，然后我们那边就只显示，
     就是123K浓缩成一个模型选择，然后我们的分辨率就联动这个模型的后缀，然后一起发出去"

     例：名单里 AJbanana3-1k / AJbanana3-2k / AJbanana3-4k 三条
       ⇒ 当前分辨率 2K 时，下拉框里只留【一条】AJbanana3（显示名不带后缀）。
     例：AJbanana3（不带后缀）⇒ 【直接无视】（用户明确要求）。

     ⚠ 只在"这份名单确实带后缀"时才启用这套规则。判据：列表里存在带 -1k/-2k/-4k 的项，
       且当前连接是阿吉。这样：
         · 别的服务商（默默/自定义）名单里没有这种后缀 ⇒ 一条都不动
         · 阿吉以后改了命名（不带后缀了）⇒ 自动不启用，不会把模型全过滤光
     ⚠ 万一当前分辨率一条都匹配不上（比如只有 -1k/-4k，用户选了 2K），
       不许把下拉框清空（那等于"选不了模型"）—— 退回"把全部基础名去重显示"，
       并且不接后缀（宁可发原样，也不要凭空拼一个 404 的模型名）。 */
  const isAji=isAjiConnection(aiRuntime);
  const 列表原样=rows;
  const 带后缀的=rows.filter(r=>aiSizeOfId(r[0]));
  if(isAji&&带后缀的.length){
    const 档=String(aiRuntime.size||'').toUpperCase();
    const 命中=rows.filter(r=>aiSizeOfId(r[0])===档);
    const 用这份=命中.length?命中:带后缀的;
    const 见过=new Set();const 收敛=[];
    for(const r of 用这份){
      const 基础=aiModelBase(r[0]);
      if(!基础||见过.has(基础))continue;      // 三档收敛成一个名字
      见过.add(基础);
      收敛.push([基础,基础]);
    }
    rows=收敛;
    // ⭐⭐ 2026-10-15 修（用户报：「本地前端似乎把 GPT Image 筛掉了」）：
    //   上面那条"不带后缀的直接无视"，本意是扔掉 AJbanana3 这种【跟分档版本重名的别名】。
    //   但它把【本来就不分档】的生图模型也一起扔了 —— gpt-image-2 / gpt-image-2.5-* / gemini-2.5-flash-image
    //   在阿吉名单里根本没有 -1k/-2k/-4k 版本，扔掉 = 这些模型在阿吉下永远选不到。
    //   ⇒ 只扔"有分档兄弟"的那种；没有分档版本的生图模型照常列出来（发请求时也原名发，见 ajiModelId）。
    //   ⚠ 只补【生图】的（名单分类里判成 image 的）；聊天/文字模型照旧不进下拉框，别把它刷成一长串。
    const 分档基础=new Set(带后缀的.map(r=>aiModelBase(r[0]).toLowerCase()));
    const 见过2=new Set(rows.map(r=>r[0].toLowerCase()));
    for(const r of 列表原样){
      if(aiSizeOfId(r[0]))continue;
      const k=r[0].toLowerCase();
      if(分档基础.has(k)||见过2.has(k))continue;
      if(tag&&tag(r[0])!=='image')continue;
      见过2.add(k);
      rows.push([r[0],r[1]]);
    }
    // ⚠ 当前选中的如果还带着后缀（老预设里存过），也要按基础名比对，否则会被当成"不在名单里"
    const curBase=aiModelBase(cur);
    return (curBase&&!rows.some(x=>x[0]===curBase))?rows.concat([[curBase,curBase+'（当前）','other']]):rows;
  }

  const rows2=rows.map(r=>[r[0],r[1],tag?tag(r[0]):((中转&&中转.length)?'other':'')]);
  return (cur&&!rows2.some(x=>x[0]===cur))?rows2.concat([[cur,cur+'（当前）','other']]):rows2;
}
async function aiRefreshBackendModels(){
  const B=window.V7Backend;
  if(!B||typeof B.models!=='function'||typeof B.state!=='function')return;
  const epoch=++aiBackendModelsEpoch;
  // 没登录（或刚换了账号）→ 清掉，回落到内置名单
  if(!B.state().signedIn){if(aiBackendModels.size){aiBackendModels.clear();renderGenerationCardFields();}return;}
  const slot=aiModelSlot();
  if(!['aji','momo','grs'].includes(slot))return;
  let rows;
  try{
    const r=await B.models(slot);
    rows=(r&&Array.isArray(r.models)?r.models:[]).filter(m=>m&&m.providerId===slot&&m.id).map(m=>[String(m.id),String(m.name||m.id)]);
  }catch(_){return;}   // 连不上就保持原样（兜底），不报错卡 —— 下拉框照常能用
  if(epoch!==aiBackendModelsEpoch)return;   // 期间换了账号/通道，这份作废
  const before=JSON.stringify(aiBackendModels.get(slot)||[]);
  aiBackendModels.set(slot,rows);
  if(before!==JSON.stringify(rows))renderGenerationCardFields();
}
// 什么时候去后台拿：开机一次、登录/换账号时、换通道时（这个通道还没拿过才拿）。
// ⚠ 开机那次要延后：这里比 settingsRuntime / aiRuntime 定义得早，同步调用会撞
//   const 暂时性死区，整个主脚本当场死掉（铁律 17 表里那条，本文件栽过两次）。
// ⚠ 不是每次存设置都去拿 —— 存设置很频繁，只有「这个通道还没拿过」才发请求。
// ⚠ 每一句都先确认有这个能力再挂：有几组测试会把本文件的源码切一段放进精简沙箱跑，
//   沙箱里没有 addEventListener。2026-10-02 不加判断时，ai-task-concurrency 那 4 条
//   【本来就红】的测试改成在这一行崩，把它们原来真正的病因（V7ProviderConnections 未定义）盖住了。
if(window.V7Backend&&typeof window.V7Backend.onChange==='function'){
  window.V7Backend.onChange(()=>{aiBackendModels.clear();aiRefreshBackendModels();});
}
if(typeof window.addEventListener==='function'){
  // ⭐ 2026-10-24（V7待办/02）：供应商模型目录到了 / 变了 ⇒ 生成卡的模型下拉、分辨率、单价跟着重画
  window.addEventListener('wheelchair:supplier-models',()=>{try{renderGenerationCardFields();}catch(_){}});
  window.addEventListener('wheelchair:settings-changed',()=>{if(!aiBackendModels.has(aiModelSlot()))aiRefreshBackendModels();});
  // ⚠⚠ 2026-10-07 新增两条：用户点「检查连接」拉到模型名单 / 刷到余额之后，
  //   生成卡的「模型」下拉框和右边的"约能生成 N 张"必须跟着更新 ——
  //   不接的话，用户检查完连接回到生成卡，看到的还是旧名单（而且不报错 = 静默失效）。
  //   ⚠ 用 try 包住：这个监听可能在宿主还没就位时被触发。
  window.addEventListener('wheelchair:provider-models',()=>{ try{renderGenerationCardFields();}catch(_){} });
  window.addEventListener('wheelchair:provider-balance',()=>{ try{renderGenerationCardFields();}catch(_){} });
}
if(typeof setTimeout==='function')setTimeout(()=>{aiRefreshBackendModels();},0);
// ⭐ 10-25 用户定：打开软件默认比例 Auto（原来 1:1）—— Auto 时香蕉不带比例参数，服务商按发过去的图自己定
const aiRuntime={
  protocol:'gemini',provider:'aji',baseUrl:'',endpoint:'',apiKey:'',authMode:'bearer',model:'AJbanana3',size:'2K',aspectRatio:'Auto',batch:1,prompt:'',antiMode:0,autoFullCanvas:false,autoReturn:false,presetTitle:'',
  workflowParameters:{},workflowPresetId:'',
  // ⭐ 2026-10-19（docs/250 第 6 条，用户定三套）：张数按引擎各记各的 —— banana（香蕉 / GPT 等普通生图）/ workflow（ComfyUI / Forge / RH 预设）/ qwen（千问模式）。
  //   batch 永远是「现在这套」的张数；batchKind 记它属于哪一套；切预设 / 开关千问时先把 batch 存回旧那套、再取新那套（见 batchKindSwitch）。
  batchByKind:{},batchKind:'',
  // ⭐ 2026-10-21（docs/261 U3）：分辨率也按「千问 / 普通」各记各的（见 sizeKindSync）
  sizeByKind:{},sizeKind:'',
  capture:null,captureSnapshot:null,outputs:[],errors:[],queue:[],running:false,currentTaskId:'',activePhase:'',activeTasks:Object.create(null),status:'待开始',progress:0,logs:[],lastPlan:null
};
// API Key 只在当前进程内存中保留。任务、设置、临时缓存和历史记录只保存引用，
// 不能把原始 Key 写进 localStorage 或任务 JSON。
const aiSessionSecrets=new Map();
