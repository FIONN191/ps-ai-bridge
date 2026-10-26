(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.V7ProviderModels=api;})(typeof window==='undefined'?null:window,function(){
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
     provider-models.js —— 从中转站拉到的模型名单：筛选 + 按槽缓存 + 变化检测

     ⚠⚠ 2026-10-07 新增。用户要求：
       ·「筛选掉不必要的字段，只拉取生图模型」+「关于图像和 Banana 之类的，以及 GPT Image 大小写之类」
       ·「命中的正常亮度显示，剩下疑似的灰色显示，用户点一下就能启用」
       ·「按服务商分别存」（这条他明确说不用问）
       ·「每一次开机自动选一遍模型，有消失/新增要提醒用户」
       ·「不要弹窗（打断）」

     ⚠⚠ 三条设计边界：
       1. 【不猜模型】——筛选只决定"显示成正常亮度还是灰色"，**不确定的一律保留在名单里**。
          绝不因为正则没命中就把模型从下拉框里【删掉】：中转商爱起自定义名
          （阿吉的 AJbanana3 = 显示名"香蕉Pro"），删掉就是静默失效（项目铁律最忌讳的形态）。
       2. 【不编价格】——单价数据还没接入后端（用户定：先留位置）。这一层只认
          `priceUSD`（按档位 {1K,2K,4K}）；没有就返回 null，界面显示"—"，不许估。
       3. 【按槽分开存】——阿吉和陌陌的名单不一样，混在一起必然串台。
     ═══════════════════════════════════════════════════════════════════════ */

  const STORE_KEY = 'v7.providerModels.v1';   // localStorage：槽 → {models, at}

  // ── 生图模型的"确定命中"规则 ──
  //   ⚠ 大小写不敏感（用户特意说了"GPT Image 大小写之类"）。
  //   ⚠⚠ 关键词【两边都不加词边界】：中转商爱把品牌名嵌进自定义 id 里，
  //      阿吉的 `AJbanana3`（显示名"香蕉Pro"）前面粘着字母 J ——
  //      加了 `(?:^|[^a-z])banana` 这种前边界就【会漏掉它】。
  //      （第一版就是这么写的，被验收脚本抓出来了：样本里 AJbanana3 没命中。）
  //   ⚠ 宁松不紧：判成"命中"只是让它亮着显示；判成"疑似"也只是灰色、仍可选。
  //      两种都不会删模型，所以放宽是安全的 —— 真漏了才会出事。
  const IMAGE_HINT = /(?:banana|image|imagen|dall[\s-]?e|seedream|flux|sdxl|stable-?diffusion|kolors|qwen-?image|nano-?banana|midjourney)/i;
  // ── 明确不是生图的（用来把"疑似"里明显不对的挑出去当灰色项）──
  const NON_IMAGE = /(?:embedding|rerank|whisper|\btts\b|moderation|transcri|speech|audio|vision-?only|ocr|classif)/i;

  function classify(id){
    const s = String(id||'');
    if (!s) return 'skip';
    if (NON_IMAGE.test(s)) return 'other';          // 明确非生图 → 灰色
    if (IMAGE_HINT.test(s)) return 'image';         // 确定生图 → 正常亮度
    return 'other';                                 // 名字看不出 → 灰色（但保留、可点选）
  }

  // 从中转站返回的原始名单里挑出模型 id（三种外形都认，跟 provider-probe 一致）
  function normalize(list){
    const out = [];
    for (const row of (Array.isArray(list) ? list : [])) {
      const id = typeof row === 'string' ? row : (row && typeof row === 'object' ? (row.id || row.name) : '');
      if (typeof id !== 'string') continue;
      const t = id.trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  // 把一份名单整理成界面要用的结构：命中的在前、疑似的在后（灰色），都保留
  function group(ids){
    const image = [], other = [];
    for (const id of normalize(ids)) (classify(id) === 'image' ? image : other).push(id);
    image.sort(); other.sort();
    return {
      image, other,
      total: image.length + other.length,
      imageCount: image.length,
      otherCount: other.length,
    };
  }

  // ── 按槽缓存（localStorage，两处窗口共用一份代币表的口径）──
  function readAll(){
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    } catch(_) { return {}; }
  }
  function slotEntry(slot){
    const all = readAll();
    const e = all[String(slot||'')];
    return (e && Array.isArray(e.models)) ? e : null;
  }
  function modelsFor(slot){ const e = slotEntry(slot); return e ? e.models : []; }
  function save(slot, ids){
    const all = readAll();
    const before = modelsFor(slot);
    const after = normalize(ids);
    all[String(slot||'')] = { models: after, at: new Date().toISOString() };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch(_) {}
    // 变化检测：消失的 / 新增的（用户要"有消失或新增要提醒"，但不要弹窗打断）
    const gone = before.filter(x => !after.includes(x));
    const added = after.filter(x => !before.includes(x));
    return { gone, added, firstTime: before.length === 0 };
  }
  function metaFor(slot){ const e = slotEntry(slot); return e ? { at: e.at } : null; }

  return { classify, normalize, group, modelsFor, metaFor, save, readAll, STORE_KEY,
           IMAGE_HINT, NON_IMAGE };
});
