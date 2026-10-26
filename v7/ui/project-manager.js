(function(root,factory){ const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api; else root.V7ProjectManagerCore=api; })(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const statuses={pending:'未标注',completed:'已完成',abandoned:'已弃用',later:'稍后继续',exported:'已导出',reworking:'返工中'};
  const sameSession=(a,b)=>!!a&&!!b&&!!a.sessionId&&a.sessionId===b.sessionId&&Number.isSafeInteger(a.id)&&a.id===b.id;
  const validDocument=doc=>!!doc&&typeof doc.sessionId==='string'&&!!doc.sessionId&&Number.isSafeInteger(doc.id);
  function projectIdForCapture(projects,selectedId,capture,openDocuments){
    if(!selectedId||!Number.isSafeInteger(capture?.docId)||!Array.isArray(openDocuments))return '';
    const live=openDocuments.filter(doc=>validDocument(doc)&&doc.id===capture.docId&&doc.name===capture.docName);
    if(live.length!==1)return '';
    const project=projects.find(row=>row.id===selectedId);
    if(!project)return '';
    const matches=project.items.filter(item=>sameSession(item.document,live[0]));
    return matches.length===1?project.id:'';
  }
  const revision=doc=>doc&&doc.historyId!=null?JSON.stringify([doc.sessionId,doc.id,String(doc.historyId)]):null;
  const decision=item=>item.document&&item.document.projectDecision||{};
  const displayStatus=item=>item.status==='pending'&&decision(item).choice==='later'?'later':item.status;
  const unmarked=item=>item.status==='pending'&&!decision(item).choice;
  const sameItem=(event,projectId,sourceRef)=>event.projectId===projectId&&event.sourceRef===sourceRef;
  function createManager({ data, randomId=()=>crypto.randomUUID(), onChange=()=>{} }) {
    let openDocs=[];
    function patchDoc(project,item,doc,open){
      // Photoshop snapshots do not own the user's saved project decision.
      const document={...doc,open};
      delete document.projectDecision;
      if(item.document&&item.document.projectDecision)document.projectDecision=item.document.projectDecision;
      if(JSON.stringify(item.document)===JSON.stringify(document))return item;
      return data.setProjectItem(project.id,item.sourceRef,{document});
    }
    function pendingEvents(){
      const projects=data.projects(),seen=new Set(),pending=[];
      for(const event of data.projectEvents()){
        const project=projects.find(row=>row.id===event.projectId),item=project&&project.items.find(row=>row.sourceRef===event.sourceRef);
        const key=JSON.stringify([event.projectId,event.sourceRef]);
        if(!item||seen.has(key)||(event.kind==='changed'?item.status!=='completed':!unmarked(item))){data.resolveProjectEvent(event.id);continue;}
        seen.add(key);pending.push(event);
      }
      return pending;
    }
    function clearItemEvents(projectId,sourceRef){
      for(const event of data.projectEvents())if(sameItem(event,projectId,sourceRef))data.resolveProjectEvent(event.id);
    }
    function observeItem(project,item,event,pending){
      const saved=decision(item),currentRevision=revision(event.document);
      const acknowledged=saved.eventId===event.id||(currentRevision&&saved.revision===currentRevision);
      const needsDecision=event.kind==='changed'?item.status==='completed'&&!acknowledged:unmarked(item);
      if(needsDecision&&!pending.some(row=>sameItem(row,project.id,item.sourceRef))){
        const queued={id:JSON.stringify([event.id,project.id,item.sourceRef]),originalId:event.id,projectId:project.id,sourceRef:item.sourceRef,kind:event.kind,documentName:event.document.name,at:event.at};
        // Persist the question first so a failed write can be retried by the next snapshot.
        data.queueProjectEvent(queued);pending.push(queued);
      }
      patchDoc(project,item,event.document,event.kind==='closed'?false:true);
    }
    function register(projectId,docs){
      if(!Array.isArray(docs)||!docs.length)throw new Error('请先勾选需要纳入项目的 Photoshop 图片');
      if(docs.some(doc=>!validDocument(doc)))throw new Error('文档身份不完整，请重新读取 Photoshop 列表');
      if(!data.getProject(projectId))throw new Error('项目不存在');
      for(const doc of docs){
        const project=data.getProject(projectId),existing=project.items.find(row=>sameSession(row.document,doc));
        if(!existing){
          const document={...doc,open:true},sourceRef='ps-item:'+randomId();delete document.projectDecision;
          if(project.items.some(row=>row.sourceRef===sourceRef))throw new Error('图片记录身份重复，请重新添加');
          data.setProjectItem(projectId,sourceRef,{document});
        }
      }
      onChange();return data.getProject(projectId);
    }
    function snapshot(documents){
      if(!Array.isArray(documents)||documents.some(doc=>!validDocument(doc)))throw new Error('Photoshop 文档列表无效，请重新读取');
      // ⚠ 2026-10-15：PS 插件修好"读取已打开文档"后，每 1.6 秒真送一次快照过来。原来这里不管变没变都 onChange，
      //   一路广播到「记录与恢复」卡整张重画 —— 缩略图光效每 1.6 秒重播一次（一直闪），刚点下的缩略图也被换掉（点不开）。
      //   现在：处理前后各拍一张"已打开文档 + 项目记录 + 待确认事项"的快照，真有东西变了才通知。
      const fingerprint=()=>JSON.stringify([openDocs,data.projects(),data.projectEvents()]);
      const before=fingerprint();
      openDocs=documents.map(doc=>({...doc}));
      const pending=pendingEvents();
      for(const project of data.projects())for(const item of project.items){
        const old=item.document;if(!old)continue;
        let doc=documents.find(d=>sameSession(old,d));
        // Both sides must have a unique saved path; names never establish identity.
        if(!doc&&old.path){
          const matches=documents.filter(d=>d.path===old.path);
          if(matches.length===1&&project.items.filter(row=>row.document&&row.document.path===old.path).length===1&&!data.getProject(project.id).items.some(row=>row.sourceRef!==item.sourceRef&&sameSession(row.document,matches[0])))doc=matches[0];
        }
        if(doc){
          if(sameSession(old,doc)&&old.historyId!=null&&doc.historyId!=null&&String(old.historyId)!==String(doc.historyId)){
            observeItem(project,item,{id:'snapshot:changed:'+revision(doc),kind:'changed',document:doc},pending);continue;
          }
          const next={...doc,open:true};delete next.projectDecision;
          if(old.projectDecision)next.projectDecision=old.projectDecision;
          if(JSON.stringify(old)!==JSON.stringify(next))patchDoc(project,item,doc,true);
        }else if(old.open)observeItem(project,item,{id:'snapshot:closed:'+JSON.stringify([old.sessionId,old.id,old.historyId]),kind:'closed',document:old},pending);
      }
      pendingEvents();
      if(fingerprint()!==before)onChange();
    }
    function observe(event){
      if(!event||typeof event!=='object')throw new Error('Photoshop 项目事件无效');
      if(event.type==='project:snapshot'){snapshot(event.documents);return;}
      if(event.type!=='project:document'||!['closed','changed','exported'].includes(event.kind))return;
      if(!validDocument(event.document)||typeof event.id!=='string'||!event.id)throw new Error('Photoshop 项目事件身份不完整，请重新读取图片');
      const pending=pendingEvents();
      for(const project of data.projects())for(const item of project.items){
        if(!sameSession(item.document,event.document))continue;
        observeItem(project,item,event,pending);
      }
      onChange();
    }
    function mark(projectId,sourceRef,status,event){
      const project=data.getProject(projectId),item=project&&project.items.find(row=>row.sourceRef===sourceRef);
      if(!item)throw new Error('图片记录已不存在');
      if(!Object.prototype.hasOwnProperty.call(statuses,status)&&status!=='keep')throw new Error('图片状态无效');
      const document={...(item.document||{})};
      const choice=status==='keep'?(item.status==='pending'?'later':item.status):status;
      if(choice==='pending')delete document.projectDecision;
      else document.projectDecision={choice,revision:revision(document),eventId:event&&event.originalId||null};
      data.setProjectItem(projectId,sourceRef,{status:choice==='later'?'pending':choice,document});
      clearItemEvents(projectId,sourceRef);onChange();return {ok:true};
    }
    function decide(eventId,status){
      const event=data.projectEvents().find(row=>row.id===eventId);if(!event)throw new Error('待确认事项已处理');
      return mark(event.projectId,event.sourceRef,status,event);
    }
    function rebind(projectId,sourceRef,doc){
      if(!validDocument(doc))throw new Error('文档身份不完整，请重新读取 Photoshop 列表');
      const project=data.getProject(projectId),item=project&&project.items.find(row=>row.sourceRef===sourceRef);
      if(!item)throw new Error('图片记录已不存在');
      if(project.items.some(row=>row.sourceRef!==sourceRef&&sameSession(row.document,doc)))throw new Error('这张图片已绑定到当前项目的其他记录');
      patchDoc(project,item,doc,true);onChange();
    }
    return {register,observe,decide,mark,rebind,pendingEvents,displayStatus,openDocuments:()=>openDocs.map(d=>({...d})),statuses};
  }
  return {createManager,statuses,sameSession,displayStatus,projectIdForCapture};
});
