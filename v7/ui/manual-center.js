(function (root) {
  'use strict';
  let overlay = null, query = '', selected = '', navigate = null;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function close(){overlay?.remove();overlay=null;}
  function show(entry){selected=entry?.id||''; render();}
  function render(){
    if(!overlay?.isConnected)return;
    const all=root.V7ManualContent?.search(query)||[],current=root.V7ManualContent?.get(selected)||all[0];
    const embedded=overlay.classList.contains('v7-manual-embedded');
    const nav='<nav aria-label="说明目录">'+all.map(e=>'<button data-manual-id="'+esc(e.id)+'" class="'+(current&&e.id===current.id?'active':'')+'" aria-current="'+String(current?.id===e.id)+'">'+esc(e.title)+'</button>').join('')+'</nav>';
    const article='<article>'+(current?'<h3>'+esc(current.title)+'</h3><div class="v7-manual-topic">'+esc(current.topic)+' · '+current.tags.map(esc).join(' · ')+'</div><p>'+esc(current.summary)+'</p><h4>操作步骤</h4><ol>'+current.steps.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ol><h4>注意</h4><ul>'+current.notes.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul><small>说明来源：软件内置操作合同与实现。</small>':'<p>没有匹配的说明。换一个关键词。</p>')+'</article>';
    overlay.innerHTML='<div class="v7-manual"'+(embedded?'':' role="dialog" aria-modal="true"')+'>'+(embedded?'':'<header><div><h2>使用说明</h2><p>软件操作说明离线可用；作者修图知识按学生资格单独开放。</p></div><button data-manual-close aria-label="关闭使用说明">×</button></header>')+'<div class="v7-manual-search"><input data-manual-search aria-label="搜索使用说明" placeholder="搜索功能、错误或关键词" value="'+esc(query)+'"><span>'+all.length+' 条</span></div><div class="v7-manual-body">'+(embedded?'<details class="v7-manual-directory"'+(!current?' open':'')+'><summary>章节目录 · '+all.length+' 条</summary>'+nav+'</details>':nav)+article+'</div></div>';
    const closer=overlay.querySelector('[data-manual-close]');if(closer)closer.onclick=close;
    const input=overlay.querySelector('[data-manual-search]');
    const update=()=>{
      const start=input.selectionStart,end=input.selectionEnd;query=input.value;selected='';render();
      // Rendering replaces the search input; restore focus on the new element.
      const next=overlay?.querySelector('[data-manual-search]');next?.focus({preventScroll:true});
      next?.setSelectionRange(start??query.length,end??query.length);
    };
    input.oninput=event=>{if(!event.isComposing)update();};input.oncompositionend=update;
    overlay.querySelectorAll('[data-manual-id]').forEach(button=>button.onclick=()=>{const id=button.dataset.manualId;show(root.V7ManualContent.get(id));if(!embedded)overlay.querySelector('[data-manual-id="'+id+'"]').focus({preventScroll:true});});
  }
  function initial(id){const entry=root.V7ManualContent.get(id);if(entry){query='';selected=entry.id;}else selected='';render();}
  function open(id){
    if(navigate)return navigate(id);
    if(!root.V7ManualContent)return;close();overlay=document.createElement('div');overlay.className='v7-manual-overlay';overlay.dataset.uiOverlay='true';document.body.append(overlay);initial(id);
  }
  function mount(container,id,searchQuery){
    if(!root.V7ManualContent)return ()=>{};
    close();const target=document.createElement('section');target.className='v7-manual-embedded';target.setAttribute('aria-label','使用说明');
    overlay=target;container.replaceChildren(target);
    if(typeof searchQuery==='string'){query=searchQuery;selected='';render();}else initial(id);
    return ()=>{if(overlay===target)close();else target.remove();};
  }
  root.V7Manual={open,close,mount,configure:options=>{navigate=typeof options?.navigate==='function'?options.navigate:null;}};
})(window);
