(function(root){
  'use strict';
  let epoch=0,opened=null;
  root.addEventListener('wheelchair:storage-context',()=>{epoch++;opened?.forceClose?.();});
  function store(){
    const token=epoch,key=root.WHEELCHAIR_STORAGE.key(root.V7BrowserPreferences.KEY);
    return root.V7BrowserPreferences.createStore({storage:localStorage,key,check:()=>{
      if(token!==epoch||key!==root.WHEELCHAIR_STORAGE.key(root.V7BrowserPreferences.KEY))throw root.V7BrowserPreferences.fail('账号已切换，旧书签操作已停止');
    }});
  }
  function read(){return store().load();}
  function create(container,{onSaved=()=>{},onClosed=()=>{},currentUrl='',currentTitle='',...options}={}){
    if(opened?.dialog.isConnected){opened.dialog.querySelector('input')?.focus();return opened;}
    const render=workspace=>{
      opened=workspace;
      const data=store(),saved=data.load();let draft=saved.bookmarks.map(row=>({...row}));
      let savedValue=JSON.stringify({bookmarks:saved.bookmarks,idleLock:saved.idleLock}),leavePrompt=null,resolveLeave=null;
      const panel=document.createElement('div');panel.className='browser-preferences';
      const list=document.createElement('div');list.className='browser-bookmark-editor';
      const controls=document.createElement('div');controls.className='browser-preferences-actions';
      const button=(label,action)=>{const element=document.createElement('button');element.type='button';element.className='settings-btn';element.textContent=label;element.onclick=action;return element;};
      const sync=()=>{draft=[...list.querySelectorAll('[data-bookmark-row]')].map(row=>({name:row.querySelector('[data-bookmark-name]').value,url:row.querySelector('[data-bookmark-url]').value}));};
      const paint=()=>{
        list.replaceChildren();
        if(!draft.length){const empty=document.createElement('p');empty.textContent='还没有书签，可以添加网址。';list.append(empty);}
        draft.forEach((bookmark,index)=>{
          const row=document.createElement('div');row.className='browser-bookmark-row';row.dataset.bookmarkRow=String(index);
          const field=(label,value,attr,max)=>{const container=document.createElement('label');container.textContent=label;const input=document.createElement('input');input.type='text';input.value=value;input.maxLength=max;input.setAttribute(attr,'');container.append(input);return container;};
          row.append(field('名称',bookmark.name,'data-bookmark-name',120),field('网址',bookmark.url,'data-bookmark-url',2048));
          const actions=document.createElement('div');actions.className='browser-preferences-actions';
          const move=delta=>{sync();[draft[index],draft[index+delta]]=[draft[index+delta],draft[index]];paint();list.querySelectorAll('[data-bookmark-name]')[index+delta]?.focus();};
          const up=button('上移',()=>move(-1)),down=button('下移',()=>move(1));up.disabled=index===0;down.disabled=index===draft.length-1;
          for(const control of [up,down])control.setAttribute('aria-label',control.textContent+'书签 '+(index+1));
          const remove=button('删除',()=>{sync();draft.splice(index,1);paint();});remove.setAttribute('aria-label','删除书签 '+(index+1));
          actions.append(up,down,remove);row.append(actions);list.append(row);
        });
      };
      const add=(name='',url='')=>{sync();if(draft.length>=root.V7BrowserPreferences.MAX_BOOKMARKS){workspace.state.textContent='最多保存 200 个书签';return;}draft.push({name,url});paint();list.querySelectorAll('[data-bookmark-name]')[draft.length-1]?.focus();};
      controls.append(button('添加书签',()=>add()),button('恢复默认书签',()=>{draft=root.V7BrowserPreferences.defaults().bookmarks;paint();workspace.state.textContent='已填回默认书签，保存后生效';}));
      if(currentUrl)controls.append(button('加入当前网页',()=>add(currentTitle||currentUrl,currentUrl)));
      const lock=document.createElement('label');lock.className='browser-task-lock-option';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=saved.idleLock;checkbox.dataset.browserIdleLock='';lock.append(checkbox,document.createTextNode('没有进行中任务时锁定网页'));
      const note=document.createElement('p');note.className='settings-note';note.textContent='默认开启。有任务时立即解锁，任务结束 4 秒后锁定；关闭后可自由浏览。锁定保留网页，不会刷新或退出网页账号。';
      panel.append(list,controls,lock,note);workspace.body.append(panel);paint();
      const changed=()=>{sync();return JSON.stringify({bookmarks:draft,idleLock:checkbox.checked})!==savedValue;};
      const save=()=>{
        try{sync();const value=data.save({version:1,bookmarks:draft,idleLock:checkbox.checked});savedValue=JSON.stringify({bookmarks:value.bookmarks,idleLock:value.idleLock});draft=value.bookmarks.map(row=>({...row}));paint();onSaved(value);workspace.state.textContent='已保存到当前账号的本机设置';return true;}
        catch(error){workspace.state.textContent=error.message;root.ERR?.report('BROWSER_PREFERENCES_FAILED',{message:error.message});return false;}
      };
      workspace.footer.append(button('保存',save));
      workspace.setBeforeClose?.(()=>{
        if(!changed())return true;
        if(leavePrompt)return leavePrompt;
        const confirmation=document.createElement('div');confirmation.className='browser-unsaved-choice';confirmation.setAttribute('role','group');confirmation.setAttribute('aria-label','书签尚未保存');
        const text=document.createElement('p');text.textContent='书签尚未保存';confirmation.append(text);
        const previous=document.activeElement;
        const finish=accepted=>{confirmation.remove();leavePrompt=null;const resolve=resolveLeave;resolveLeave=null;if(!accepted&&previous?.isConnected)previous.focus();resolve?.(accepted);};
        const keep=button('继续编辑',()=>finish(false)),discard=button('放弃修改',()=>finish(true)),commit=button('保存并返回',()=>{if(save())finish(true);});
        confirmation.append(keep,discard,commit);workspace.footer.prepend(confirmation);
        leavePrompt=new Promise(resolve=>{resolveLeave=resolve;});keep.focus();return leavePrompt;
      });
      return ()=>{resolveLeave?.(false);resolveLeave=null;leavePrompt=null;if(opened===workspace)opened=null;onClosed();};
    };
    const args=['browser-bookmarks','浏览器书签与任务锁','书签和开关按当前软件账号保存在本机；网页登录与 Cookie 保留在独立浏览器会话。',render];
    return container?root.V7Workspaces.mount(container,...args,options):root.V7Workspaces.open(...args);
  }
  root.V7BrowserBookmarks={read,open:options=>create(null,options),mount:(container,options)=>create(container,options)};
})(window);
