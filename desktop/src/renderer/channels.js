const apiSettingsEditor = mountApiSettings({root: $('apiSettings'), request: api, select: fillSelect, openLink: url => window.open(url, '_blank')});
let channelsHelperReady = false;
document.addEventListener('workspace-tab', e => {if (e.detail === 'settings') apiSettingsEditor.refresh();});
// Retry after helper startup, without reloading fields while someone is editing.
document.addEventListener('app-state', e => {
  const ready = !!e.detail.helper.health;
  if (ready && !channelsHelperReady) apiSettingsEditor.refresh();
  channelsHelperReady = ready;
});
apiSettingsEditor.refresh();
