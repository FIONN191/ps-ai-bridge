'use strict';
function createDocumentAction({app,core,constants}) {
  const receipts=new Map();
  return async function createDocument(p={}) {
    const fail=message=>Object.assign(new Error(message),{code:'CREATIVE_DOCUMENT_INVALID'});
    for(const [key,min,max]of [['width',256,16384],['height',256,16384],['dpi',72,600]])if(!Number.isInteger(p[key])||p[key]<min||p[key]>max)throw fail('海报尺寸或 PPI 超出范围');
    if(p.width*p.height>100000000||typeof p.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(p.requestId))throw fail('海报创建请求无效');
    const title=String(p.title||'V7 海报').replace(/[\r\n\t]/g,' ').slice(0,100),name=title+' [V7-'+p.requestId+']';
    const fingerprint=JSON.stringify([p.width,p.height,p.dpi,name]);
    return core.executeAsModal(async()=>{
      const known=receipts.get(p.requestId);
      if(known&&known.fingerprint!==fingerprint)throw fail('同一创建请求的尺寸已变化');
      // ⚠ 集合转数组逐个读（app.documents 不是真数组，见 ps-actions.js collectionToArray）
      const docs=[];try{for(const d of (app.documents||[]))if(d)docs.push(d);}catch(_){}if(!docs.length){try{for(let i=0;app.documents&&i<app.documents.length;i++)if(app.documents[i])docs.push(app.documents[i]);}catch(_){}}
      const existing=known?docs.find(d=>Number(d.id)===known.docId):docs.find(d=>d.name===name);
      if(known&&!existing)throw fail('已创建的海报文档已关闭，请先重新打开该文档');
      if(existing){if(Number(existing.width)!==p.width||Number(existing.height)!==p.height||Math.round(Number(existing.resolution))!==p.dpi)throw fail('已创建海报尺寸已变化，请核对原文档');return {docId:existing.id,docName:existing.name,width:p.width,height:p.height,dpi:p.dpi,reused:true};}
      // The request marker survives a bridge reload and prevents duplicate open documents after a lost receipt.
      // ⚠ 2026-10-15：原来用 batchPlay 的 make + _target/using —— Photoshop 不认这个写法、也不报错，
      //   什么都没建（工具箱复测实测：回执报"未返回新文档"，活动文档没变）。改用 DOM 的 app.createDocument。
      await app.createDocument({name,width:p.width,height:p.height,resolution:p.dpi,mode:constants.NewDocumentMode.RGB,fill:constants.DocumentFill.TRANSPARENT});
      const doc=app.activeDocument;
      if(!doc||doc.name!==name)throw fail('Photoshop 未返回新文档回执，请核对已打开的文档');
      receipts.set(p.requestId,{fingerprint,docId:doc.id});
      return {docId:doc.id,docName:doc.name,width:p.width,height:p.height,dpi:p.dpi,reused:false};
    },{commandName:'创建 V7 海报文档'});
  };
}
module.exports={createDocumentAction};
