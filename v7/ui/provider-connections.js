(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.V7ProviderConnections=factory();})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const TITLES=Object.freeze({aji:'AJI · 阿吉',momo:'MOMO · 墨墨',other:'Others · 其他'});
  const fail=message=>Object.assign(new Error(message),{code:'PROVIDER_CATALOG_INVALID'});
  const SLOTS=['aji','momo','grs','other'],AUTH=['bearer','query','x-goog-api-key'];
  function migrate(input,legacy,now=Date.now()){
    // ⭐⭐ 2026-10-09（用户定）：「填 key 的时候分别有 阿吉 墨墨 GRS 和用户自定义；
    //   如果用户选择了 GRS，就可以选择走我的 key 或者走 GRS 官方的 key」
    //   ⇒ 'grs' 现在是【一级服务商】，不再强制折成 other+otherConnection。
    //   ⚠ 老存档兼容：provider==='grs' 的老值本来就会被折成 other+grs，
    //     但现在我们【保留】它（下面那句不再改写它）—— 两种写法都能用，
    //     而且 slot 算出来都是 'grs'，所以底层设置项（grsUrl/grsKey/grsMode）完全不变。
    const out={...input};
    if(out.provider==='others')out.provider='other';
    if(out.provider==='other'&&out.otherConnection==='grs'){
      // 老写法（藏在 Others 里）→ 提升成一级，读写都走同一条路
      out.provider='grs';
    }
    if(!out.provider)out.provider='aji';
    if(!['custom','grs'].includes(out.otherConnection))out.otherConnection='custom';
    const slot=out.provider==='other'?(out.otherConnection==='grs'?'grs':'other'):out.provider;
    // Only the old active connection may inherit its temporary protocol/auth. Other slots get independent defaults.
    if(out.connectionsVersion!==1&&legacy?.version===1&&Number(legacy.savedAt)>0&&now-Number(legacy.savedAt)>=0&&now-Number(legacy.savedAt)<=7*86400000){
      const previous=legacy.connectionSlot||(legacy.provider==='others'?'other':legacy.provider);
      if(previous===slot&&(!legacy.baseUrl||String(legacy.baseUrl)===String(out[slot+'Url']||''))){
        if(!out[slot+'Protocol']&&['openai','gemini'].includes(legacy.protocol))out[slot+'Protocol']=legacy.protocol;
        if(!out[slot+'AuthMode']&&AUTH.includes(legacy.authMode))out[slot+'AuthMode']=legacy.authMode;
      }
    }
    for(const key of SLOTS){if(!out[key+'Protocol'])out[key+'Protocol']='gemini';if(!out[key+'AuthMode'])out[key+'AuthMode']='bearer';}
    out.connectionsVersion=1;return out;
  }
  // ⭐ 2026-10-24（V7待办/02，用户定「默认竞速」）：阿吉 / 墨墨默认【自动选线】—— 地址用 provider-lines.js 测出来的那条；
  //   用户在设置里改成「手动填」（xxxLineMode='manual'，有自己专线的人）才用他填的 xxxUrl。
  //   ⚠⚠ 判据【只在这一处】：所有要地址的地方（出图 / 查余额 / 配没配好 / 拉模型）都走 connection()，别在调用方各判一遍。
  //   ⚠ 没填 Key 时照旧用填的地址（空就是空）—— 不然「从没配过 Key」也会被当成配好了（aiConnectionConfigured 看的是 url）。
  function autoLine(s,slot){
    if((slot!=='aji'&&slot!=='momo')||s[slot+'LineMode']==='manual'||!String(s[slot+'Key']||'').trim())return '';
    const lines=typeof self!=='undefined'&&self.V7ProviderLines;
    try{return lines&&typeof lines.resolved==='function'?String(lines.resolved(slot)||''):'';}catch(_){return '';}
  }
  function connection(input){const s=migrate(input);if(!['aji','momo','grs','other'].includes(s.provider))throw fail('当前服务商配置无法识别，请重新选择连接');const slot=s.provider==='other'?(s.otherConnection==='grs'?'grs':'other'):s.provider;const auto=autoLine(s,slot);return {provider:s.provider,slot,url:auto||String(s[slot+'Url']||''),lineMode:auto?'auto':(slot==='aji'||slot==='momo')?(s[slot+'LineMode']==='manual'?'manual':'auto'):'',apiKey:String(s[slot+'Key']||''),protocol:String(s[slot+'Protocol']||''),authMode:String(s[slot+'AuthMode']||'')};}
  function runtimePatch(settings,runtime){const current=runtime||{},next=connection(settings),previousSlot=current.connectionSlot||(current.provider==='grs'?'grs':current.provider==='others'?'other':current.provider),changed=previousSlot!==next.slot||String(current.baseUrl||'')!==next.url||current.protocol!==next.protocol;return {provider:next.provider,connectionSlot:next.slot,baseUrl:next.url,apiKey:next.apiKey,protocol:next.protocol,authMode:next.authMode,endpoint:changed?'':String(current.endpoint||'')};}
  function safeUrl(value){if(value!=null&&typeof value!=='string')throw fail('服务地址必须是文本');const raw=String(value||'').trim();if(!raw)return '';let url;try{url=new URL(raw);}catch(_){throw fail('服务地址格式无效，请填写完整 HTTPS 地址');}if(raw.length>2048||/[\s\\]/.test(raw)||url.protocol!=='https:'||!url.hostname||url.port==='0'||url.username||url.password||url.search||url.hash)throw fail('推荐地址只接受不含账号、查询参数或片段的 HTTPS 地址');return url.href.replace(/\/$/,'');}
  function publicItem(value){
    if(!value||!['aji','momo'].includes(value.id)||typeof value.recommended!=='boolean')throw fail('推荐服务商编号或状态无效');
    const text=(key,limit)=>{const v=value[key];if(v!=null&&(typeof v!=='string'||v.length>limit))throw fail('推荐资料字段格式无效');return String(v||'');};
    const price=value.price==null?{}:value.price;if(typeof price!=='object'||Array.isArray(price)||value.price!==null&&value.price!==undefined&&(!Object.prototype.hasOwnProperty.call(price,'amount')||Object.keys(price).some(key=>!['amount','currency','unit','source','updatedAt'].includes(key))))throw fail('公开价格格式无效');
    const amount=price.amount==null?null:price.amount;
    if(amount!==null&&(typeof amount!=='number'||!Number.isFinite(amount)||amount<0||[['currency',12],['unit',80],['source',500],['updatedAt',80]].some(([key,max])=>typeof price[key]!=='string'||!price[key].trim()||price[key].length>max)||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(price.updatedAt)||!Number.isFinite(Date.parse(price.updatedAt))))throw fail('公开价格缺少金额、币种、单位、来源或有效更新时间');
    const protocol=text('protocol',20);if(protocol&&!['openai','gemini'].includes(protocol))throw fail('推荐协议无效');
    return {id:value.id,name:text('name',100)||TITLES[value.id],recommended:value.recommended,apiUrl:safeUrl(value.apiUrl),protocol,contact:text('contact',1000),description:text('description',3000),priceNotes:text('priceNotes',1000),updatedAt:text('updatedAt',80),price:{amount,currency:amount===null?'':price.currency,unit:amount===null?'':price.unit,source:amount===null?'':price.source,updatedAt:amount===null?'':price.updatedAt}};
  }
  function catalog(payload){if(!payload||!Array.isArray(payload.providers)||payload.providers.length>20)throw fail('后台推荐列表格式无效');const seen=new Set();return payload.providers.map(publicItem).filter(item=>{if(seen.has(item.id))throw fail('后台推荐列表存在重复服务商');seen.add(item.id);return item.recommended;});}
  function adoption(settings,item){const row=publicItem(item);if(!row.apiUrl)throw fail('后台尚未发布该服务商地址，请联系管理员或手动填写自己的连接');const prefix=row.id,current=String(settings[prefix+'Url']||''),oldProtocol=String(settings[prefix+'Protocol']||''),changed=current.trim().replace(/\/$/,'')!==row.apiUrl,protocolChanged=!!row.protocol&&oldProtocol!==row.protocol;return {patch:{provider:prefix,[prefix+'Url']:row.apiUrl,...(row.protocol?{[prefix+'Protocol']:row.protocol}:{}),...(protocolChanged?{[prefix+'AuthMode']:'bearer'}:{}),...(changed?{[prefix+'Key']:''}:{})},clearsKey:changed&&!!settings[prefix+'Key'],previousUrl:current,nextUrl:row.apiUrl};}
  return {TITLES,fail,migrate,connection,runtimePatch,safeUrl,publicItem,catalog,adoption};
});
