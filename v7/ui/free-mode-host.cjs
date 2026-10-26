'use strict';

// The native exit and watchdog remain usable when the renderer stops responding.
// multiScreen：铺满所有屏（2026-10-20）。默认关 —— 无头测试直接用这个壳，开着的话测试结果会跟着跑测试那台电脑有几块屏变；Electron 桌面壳（main.js）打开
function createFreeModeHost({getWindow,screen,globalShortcut,emit,canEnter=()=>true,multiScreen=false}){
  const shortcut='Control+Alt+Shift+F12';
  let active=false,original=null,lastPulse=0,watchdog=null,failedOpen=false,normalSize=null;
  const current=()=>{const win=getWindow();return win&&!win.isDestroyed()?win:null;};
  function place(win,bounds){
    const requested={...bounds};
    // Fractional DPI may round both the origin and the far edge, adding up
    // to two logical pixels. Correct the measured result with a bounded retry
    // instead of accumulating that error each time normal mode is restored.
    for(let attempt=0;attempt<3;attempt++){
      win.setBounds(requested,false);
      const actual=win.getBounds();
      if(['x','y','width','height'].every(key=>actual[key]===bounds[key]))return;
      for(const key of ['x','y','width','height'])requested[key]+=bounds[key]-actual[key];
    }
  }
  function stopWatchdog(){if(watchdog)clearInterval(watchdog);watchdog=null;}
  // ⭐ 2026-10-20：窗口内容区左上角的屏幕位置（跟 Tauri 壳 free_mode.rs 的 client_origin 对称）——
  //   前端拿切换前后两个原点，把卡片从切换前的屏幕位置一路动画到新位置
  const origin=win=>{try{const b=win.getContentBounds();return {x:b.x,y:b.y};}catch(_){return null;}};
  let monitors=[];
  function set(enabled){
    const win=current();if(!win)return {ok:false,error:'主窗口不存在'};
    const fromOrigin=origin(win);
    if(enabled===active)return {ok:true,enabled:active,shortcut};
    if(enabled){
      if(!canEnter())return {ok:false,error:'请先关闭独立工作面，再进入自由模式'};
      const before=win.getBounds(),display=screen.getDisplayMatching(before);
      // Do not accumulate Electron's <=1 logical pixel DPI rounding across mode switches.
      if(!normalSize||Math.abs(before.width-normalSize.width)>2||Math.abs(before.height-normalSize.height)>2)normalSize={width:before.width,height:before.height};
      let registered=false;
      // 2026-10-18 深夜：跟 Tauri 壳 free_mode.rs 对称 —— 自己专用的退出键还挂着 = 上次的残留，先摘掉再挂
      try{if(globalShortcut.isRegistered(shortcut))globalShortcut.unregister(shortcut);}catch(_){}
      try{registered=globalShortcut.register(shortcut,()=>{
        if(!active)return;
        const result=set(false);
        if(result.ok){win.setIgnoreMouseEvents(true,{forward:true});emit('shortcut:free-mode-exit',{});}
      });}catch(error){return {ok:false,error:String(error.message||error)};}
      if(!registered)return {ok:false,error:'退出快捷键 Ctrl+Alt+Shift+F12 被占用，未进入自由模式'};
      try{
        // ⭐ 2026-10-20 多屏：跟 Tauri 壳对称 —— 铺满所有屏工作区的外包矩形，monitors = 每块屏在窗口里的位置（当前这块排第一）
        const areas=[display.workArea,...(multiScreen?screen.getAllDisplays():[]).map(d=>d.workArea).filter(a=>a.width>0&&a.height>0&&!(a.x===display.workArea.x&&a.y===display.workArea.y&&a.width===display.workArea.width&&a.height===display.workArea.height))];
        const ux=Math.min(...areas.map(a=>a.x)),uy=Math.min(...areas.map(a=>a.y));
        const union={x:ux,y:uy,width:Math.max(...areas.map(a=>a.x+a.width))-ux,height:Math.max(...areas.map(a=>a.y+a.height))-uy};
        monitors=areas.map(a=>({x:a.x-ux,y:a.y-uy,width:a.width,height:a.height}));
        original={...before,...normalSize};place(win,union);active=true;lastPulse=Date.now();failedOpen=false;
        watchdog=setInterval(()=>{
          if(!active||!current())return stopWatchdog();
          if(Date.now()-lastPulse>5000&&!failedOpen){
            failedOpen=true;win.setIgnoreMouseEvents(true,{forward:true});emit('free-mode:mouse-reset',{});
          }
        },1000);
        watchdog.unref?.();
        win.setAlwaysOnTop(true,'screen-saver');
        // Use the acknowledged logical size consistently with pulse().
        // Windows fractional DPI can round setBounds by one logical pixel.
        const bounds=win.getBounds();
        return {ok:true,enabled:true,shortcut,workArea:{x:0,y:0,width:bounds.width,height:bounds.height},monitors,fromOrigin,toOrigin:origin(win)};
      }catch(error){
        active=false;original=null;stopWatchdog();globalShortcut.unregister(shortcut);
        try{place(win,before);}catch(_){}
        return {ok:false,error:String(error.message||error)};
      }
    }
    // Keep the native exit registered if restoring the window fails, so a retry remains possible.
    try{if(original)place(win,original);}catch(error){return {ok:false,error:String(error.message||error)};}
    active=false;original=null;stopWatchdog();globalShortcut.unregister(shortcut);
    win.setAlwaysOnTop(true,'screen-saver');
    return {ok:true,enabled:false,fromOrigin,toOrigin:origin(win)};
  }
  function pulse(){
    lastPulse=Date.now();if(failedOpen){failedOpen=false;emit('free-mode:mouse-reset',{});}
    // 同 Tauri 壳（docs/261 B2）：最小化时不报可用区域，界面这次不挪卡
    const win=active?current():null;
    if(win&&typeof win.isMinimized==='function'&&win.isMinimized())return {ok:true,enabled:true,minimized:true};
    const bounds=win?win.getBounds():null;
    return {ok:true,enabled:active,...(bounds?{workArea:{x:0,y:0,width:bounds.width,height:bounds.height}}:{})};
  }
  function dispose(){stopWatchdog();globalShortcut.unregister(shortcut);active=false;original=null;}
  return {set,pulse,dispose,isActive:()=>active};
}
module.exports={createFreeModeHost};
