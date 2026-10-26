(function(root){
  root.V7ProviderSettings.configure({
    settings:()=>settingsRuntime,runtime:()=>aiRuntime,read:container=>settingsReadFields(container),
    // ⭐ 2026-10-24（V7待办/02）：点「检查连接」时阿吉 / 墨墨先竞速选一次线（自动选线时），再检查选中的那条
    raceLines:()=>typeof providerLinesMaybeRace==='function'?providerLinesMaybeRace(true):Promise.resolve([]),
    async apply(patch){Object.assign(settingsRuntime,patch);settingsSave();if(settingsVault)await settingsVault.saveChanges();},
    confirm:spec=>new Promise(resolve=>UI.dialog({...spec,confirm:'采用地址',cancel:'取消',onConfirm:()=>resolve(true),onCancel:()=>resolve(false)}))
  });
})(window);
