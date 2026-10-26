(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.V7CreativeEffects=api;})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  const fail=message=>Object.assign(new Error(message),{code:'CREATIVE_TOOL_FAILED'});
  const effects=[
    ['particleDensity','细沙状粒子逸散',.7,'density'],['distortion','接触面扭曲解离',.6,'intensity'],
    ['heatHaze','粒子周围热空气折射',.6,'intensity'],['chromatic','粒子边缘色散',.4,'degree'],
    ['flocculent','细小组絮状粒子',.5,'amount'],['fadeSpeed','主粒子褪散至无色',.6,'speed'],
    ['hideLines','隐藏原始线条痕迹',.7,'hide'],['fresnel','菲涅尔能量（按明暗）',.7,'intensity'],
    ['edgeWarp','图形边缘光线扭曲',.5,'intensity'],['selfGlowLuma','自发光范围（明度联动）',.6,'glowRange'],
    ['densityByTransparency','粒子密度（线条透明度）',.6,'densityByAlpha']
  ].map(([id,label,weight,category])=>({id,label,weight,category}));
  const types=[['none','无粒子'],['original','影视级流体'],['energy','能量自发光'],['volumetric','体积云'],['smoke','烟雾'],['hair','毛发'],['burn','燃烧']];
  const descriptions={original:'影视级 VFX 细沙状流体粒子，单粒轮廓清晰，主粒子与细小絮状粒子同步逸散，运动严格遵循绘制线条走向',energy:'能量自发光：高饱和 HDR 自发光能量束，弥散辉光，叠加处亮度递增，流动波前和爆发感',volumetric:'体积雾软云，高斯软边、三维噪波、散射光、深度消隐、背光透射，先膨胀后收缩',smoke:'湍流烟雾，S 形轨迹、柏林噪波、自阴影、背光银边、热浮升、头浓尾淡和涡旋扰动',hair:'锥形毛发曲线条带，分叉末端，各向异性 Kajiya-Kay 高光，根部固定、尖端风动、次级运动延迟和根部环境遮蔽',burn:'自发光 VFX 火焰与零星火花；主粒子由参考图形中心向边缘扩展，辅助粒子由边缘向内外扩展'};
  const numeric={ior:[1,2],noiseRange:[0,1],noiseAmp:[0,1],blur:[0,1],fresnelSpread:[0,1],gravity:[0,1],mix:[0,1]};
  const flags=['iorOn','noiseOn','blurOn','fresnelOn','gravityOn'];
  function initial(){return {fx:Object.fromEntries(effects.map(e=>[e.id,{weight:e.weight,enabled:true}])),ior:1.33,iorOn:true,noiseRange:.5,noiseAmp:.5,noiseOn:true,blur:.5,blurOn:true,fresnelSpread:.5,fresnelOn:true,gravity:.5,gravityOn:true,mainType:'original',secondaryType:'none',mix:.3};}
  function number(value,min,max,label){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw fail(label+'必须在 '+min+' 至 '+max+' 之间');return value;}
  function state(value){if(value==null)return initial();if(typeof value!=='object'||Array.isArray(value)||!value.fx||typeof value.fx!=='object'||Array.isArray(value.fx))throw fail('尻特效配置无效');const out=initial();for(const e of effects){const item=value.fx[e.id];if(!item||typeof item.enabled!=='boolean')throw fail('尻特效开关无效');out.fx[e.id]={weight:number(item.weight,0,1,e.label),enabled:item.enabled};}if(Object.keys(value.fx).some(id=>!effects.some(e=>e.id===id)))throw fail('尻特效参数编号无效');for(const [key,range]of Object.entries(numeric))out[key]=number(value[key],...range,key);for(const key of flags){if(typeof value[key]!=='boolean')throw fail('尻特效开关无效');out[key]=value[key];}for(const key of ['mainType','secondaryType']){if(!types.some(t=>t[0]===value[key]))throw fail('粒子类型无效');out[key]=value[key];}return out;}
  function strength(value,category){const words={density:['稀疏','偏少','中等','密集','极密'],intensity:['隐约轻微','较弱','中等','明显强烈','极强'],degree:['几乎不可见','轻微','中等','显著','强烈'],amount:['少量','偏少','均衡','大量','极多'],speed:['慢速','偏慢','中速','快速','极快'],hide:['极少隐藏','部分隐藏（弱）','部分隐藏（中）','大部分隐藏','完全擦除'],glowRange:['微弱亮度联动','轻度亮度联动','中等亮度联动','较强亮度联动','极强亮度联动'],densityByAlpha:['极弱透明度影响','轻度透明度影响','中等透明度影响','较强透明度影响','极强透明度影响']};return (words[category]||words.intensity)[Math.min(4,Math.max(0,Math.ceil(value*5)-1))];}
  function prompt(value){const v=state(value),hasParticles=v.mainType!=='none',lines=['照片级影视 VFX 图像。以提供的 Photoshop 区域为唯一主图，绘制线条限定特效发生边界；保留主体身份、构图和未标注区域。实际输出尺寸服从本次生成设置，不额外声明 8K 或 4K。'];
    if(hasParticles){const mix=v.secondaryType!=='none'&&v.mix>0;lines.push(mix?'粒子混合：'+Math.round((1-v.mix)*100)+'% '+descriptions[v.mainType]+'；'+Math.round(v.mix*100)+'% '+descriptions[v.secondaryType]+'。':'主粒子：'+descriptions[v.mainType]+'。');lines.push('所有粒子颜色从对应参考图/绘制线条提取，无预设颜色；运动与画面空间一致，接触处有合理碰撞，景深按主体距离自然过渡。');}else lines.push('不生成粒子；仅在标记区域应用下面明确启用的非粒子特效。');
    const particleOnly=new Set(['particleDensity','heatHaze','chromatic','flocculent','fadeSpeed','selfGlowLuma','densityByTransparency']);
    for(const e of effects){const item=v.fx[e.id],enabled=item.enabled&&item.weight>0&&(!particleOnly.has(e.id)||hasParticles)&&(e.id!=='heatHaze'||v.iorOn);if(!enabled){lines.push(e.label+'：关闭，不添加该效果。');continue;}let detail=strength(item.weight,e.category)+'（权重 '+item.weight.toFixed(2)+'）';if(e.id==='heatHaze')detail+='，折射率 '+v.ior.toFixed(2);if(e.id==='fresnel')detail+='，'+(v.fresnelOn?'边缘向表面蔓延 '+v.fresnelSpread.toFixed(2)+'（0 为集中边缘，1 为覆盖表面）':'边缘与表面均衡分布')+'，明处表面更强，暗处边缘更强';if(e.id==='densityByTransparency')detail+='，线条越透明粒子越稀疏';if(e.id==='selfGlowLuma')detail+='，亮部反光范围大，暗部弱';lines.push(e.label+'：'+detail+'。');}
    lines.push(v.noiseOn&&(v.noiseRange>0||v.noiseAmp>0)?'全局噪波：范围 '+v.noiseRange.toFixed(2)+'，幅度 '+v.noiseAmp.toFixed(2)+'；与标记方向融合。':'全局噪波：关闭。');
    lines.push(v.blurOn&&v.blur>0?'动态模糊：强度 '+v.blur.toFixed(2)+'，方向性运动拖尾，主体保持清晰。':'动态模糊：关闭。');
    if(hasParticles)lines.push(v.gravityOn?'粒子重力：'+v.gravity.toFixed(2)+'（0 为近失重，0.5 为地球重力，1 为强重力），下落/碰撞/堆积一致。':'粒子重力：关闭，自由漂浮，不产生定向下落或堆积。');
    lines.push('避免非标记区域变化、主体变形、偏色、随机运动、穿透物体、整幅模糊和噪点。关闭项优先，不得由其他描述重新启用。');return lines.join('\n');
  }
  function randomize(random=Math.random){const out=initial(),sample=()=>number(random(),0,1,'随机值');for(const e of effects)out.fx[e.id]={weight:Math.round(sample()*100)/100,enabled:sample()>.3};for(const key of flags)out[key]=sample()>.3;for(const key of Object.keys(numeric)){const [min,max]=numeric[key];out[key]=Math.round((min+sample()*(max-min))*100)/100;}for(const key of ['mainType','secondaryType'])out[key]=types[Math.min(types.length-1,Math.floor(sample()*types.length))][0];return out;}
  return {effects,types,initial,state,prompt,randomize};
});
