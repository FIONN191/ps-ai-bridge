(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.V7ProviderProbe=api;})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const fail=(code,message)=>Object.assign(new Error(message),{code});
  // ⭐ 2026-10-17 夜（用户：「你之前改那个语言模型URL没连上的时候，把生图的那个规则也改了。生图就直连就好了，按照之前的规则呀」）
  //   生图「检查连接 / 读模型列表」拼地址用的规则，原样照 10-17 之前 assistant-runtime.js 的 endpoint（git HEAD 那份，一字不改）。
  //   原来这里借的是语言模型那个函数（provider-settings.js 传进来），10-17 为了让语言模型连上中转站改了它的规则
  //   （版本段在中间也算、多去几种接口尾巴、没写 https:// 自动补），生图这边就被连带改了。
  //   ⚠ 别再跟语言模型那个合并：两边各管各的，语言模型怎么改都碰不到生图。
  function endpoint(base,protocol,action,model){
    const url=new URL(String(base||''));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('ASSISTANT_URL_INVALID','请填写有效的服务商地址');
    url.hash='';url.search='';
    let path=url.pathname.replace(/\/+$/,'');
    path=path.replace(/\/(?:chat\/completions|messages|models(?:\/[^/]+:generateContent)?)$/,'');
    if(!/\/v\d+(?:beta\d*)?$/.test(path))path+=protocol==='gemini'?'/v1beta':'/v1';
    path+=action==='models'?'/models':protocol==='gemini'?'/models/'+encodeURIComponent(String(model).replace(/^models\//,''))+':generateContent':protocol==='anthropic'?'/messages':'/chat/completions';
    url.pathname=path;
    return url.href;
  }
  function create(options){
    let sequence=0,active=null;
    function request(config){
      const c={...config},protocol=c.protocol||'gemini';
      if(!['openai','gemini'].includes(protocol))throw fail('PROVIDER_TEST_FAILED','请选择 Gemini 或 OpenAI 图像协议');
      let base;try{base=new URL(c.baseUrl||c.url||'');}catch(_){throw fail('PROVIDER_TEST_FAILED','请先填写完整的服务地址');}
      if(/[\s\\]/.test(String(c.baseUrl||c.url||'').trim())||!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw fail('PROVIDER_TEST_FAILED','服务地址不得包含账号、查询参数或片段；请将 Key 填入专用输入框');
      if(!String(c.apiKey||'').trim())throw fail('PROVIDER_TEST_FAILED','请先填写当前服务商的 API Key');
      base.pathname=base.pathname.replace(/\/images\/(?:generations|edits)\/?$/i,'');
      const url=new URL(options.endpoint(base.href,protocol,'models')),headers={Accept:'application/json'};
      const auth=String(c.authMode||'bearer');if(!['bearer','query','x-goog-api-key'].includes(auth)||auth==='x-goog-api-key'&&protocol!=='gemini')throw fail('PROVIDER_TEST_FAILED','请核对当前协议的鉴权方式');
      if(auth==='query')url.searchParams.set('key',c.apiKey);else if(auth==='x-goog-api-key')headers['x-goog-api-key']=c.apiKey;else headers.Authorization='Bearer '+c.apiKey;
      return {url:url.href,headers,method:'GET',timeoutMs:15000,requestId:'provider-probe-'+Date.now()+'-'+(++sequence)};
    }
    async function test(config,guard=()=>{}){
      if(active)throw fail('PROVIDER_TEST_FAILED','连接测试正在进行，请先等待或取消');
      guard();const descriptor=request(config),token={id:descriptor.requestId,cancelled:false};active=token;
      try{
        const response=await options.http.fetch(descriptor);guard();if(token.cancelled)throw fail('PROVIDER_TEST_CANCELLED','连接测试已取消');
        if(!response?.ok)throw fail('PROVIDER_TEST_FAILED','模型列表接口返回 HTTP '+(response?.status||'未知')+'；请核对地址、Key 与协议');
        let data;try{data=JSON.parse(response.body||'');}catch(_){throw fail('PROVIDER_TEST_FAILED','服务返回了网页或无法识别的数据；请核对 API 地址');}
        const rows=Array.isArray(data)?data:Array.isArray(data?.data)?data.data:Array.isArray(data?.models)?data.models:null;
        if(!rows||data?.error)throw fail('PROVIDER_TEST_FAILED','服务未返回模型列表；当前测试无法确认连接，请核对服务商接口说明');
        const names=[];for(const row of rows){const id=typeof row==='string'?row:row&&typeof row==='object'?(row.id||row.name):'';if(typeof id!=='string'||!id.trim())throw fail('PROVIDER_TEST_FAILED','服务返回的模型列表格式不正确');if(!names.includes(id))names.push(id);}
        // ⚠⚠ 2026-10-07：把名单【交出去】。原来这里只 return 了 names.length ——
        //   名单算出来又被丢掉，生成卡的下拉框只能去用"后台账号的模型表 + 写死的 17 个兜底"
        //   （写死那份里混着中转商自定义别名，换个中转站就不存在）。
        //   ⇒ 现在连 models 一起返回；调用方（provider-settings）负责筛选与缓存。
        //   ⚠ count 保留：老调用方可能还在读它，别删。
        //   ⚠ 仍然【不改】message 的口径：模型列表正常 ≠ 生图已验证、也不代表费用已确认。
        return {ok:true,kind:'model-list',count:names.length,models:names,status:response.status,checkedAt:new Date().toISOString(),message:'模型列表接口响应正常（'+names.length+' 项）；未验证图像生成或实际费用'};
      }catch(error){if(token.cancelled)throw fail('PROVIDER_TEST_CANCELLED','连接测试已取消');if(['PROVIDER_TEST_FAILED','PROVIDER_TEST_CANCELLED','PROVIDER_CATALOG_INVALID'].includes(error?.code))throw error;throw fail('PROVIDER_TEST_FAILED','连接测试未完成，请检查网络与服务地址后重试');}
      finally{if(active===token)active=null;}
    }
    async function cancel(){if(!active)return;active.cancelled=true;if(options.http.cancel)await options.http.cancel(active.id);}
    return {test,cancel,busy:()=>!!active};
  }
  return {create,endpoint};
});
