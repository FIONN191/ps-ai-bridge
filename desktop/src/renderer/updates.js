// 自动更新的窗口部分：「发现新版本」弹窗（立即更新 / 以后再说 / 跳过这个版本）、下载进度、设置页的版本行。
// 检查、下载、安装都在主进程（updater.mjs），这里只按它推过来的状态显示。

let upState = null;
let upRetry = 'install'; // 出错后「重试」做什么：install 或 check

const mb = (bytes) => (bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '');

function renderUpdate(s) {
  upState = s;
  // 设置页的版本行
  const text = $('updateText');
  const label = {
    available: `发现新版本 v${s.latest}`,
    downloading: `正在下载新版本… ${s.percent}%`,
    installing: '正在安装新版本…',
    checking: '正在检查更新…',
    latest: `当前 v${s.current}，已经是最新版本`,
    error: s.error,
    disabled: `当前 v${s.current}（开发版不检查更新）`,
  }[s.status] || `当前 v${s.current}`;
  text.textContent = label;
  text.className = s.status === 'available' ? 'has-update' : 'mute';
  $('checkUpdate').textContent = s.status === 'available' ? '查看更新' : '检查更新';
  $('checkUpdate').disabled = ['checking', 'downloading', 'installing'].includes(s.status);

  // 弹窗
  const show = s.prompt && ['available', 'downloading', 'installing', 'manual', 'error'].includes(s.status);
  $('updateModal').hidden = !show;
  if (!show) return;
  const busy = s.status === 'downloading' || s.status === 'installing';
  $('upTitle').textContent = s.status === 'error' ? (s.latest && upRetry === 'install' ? '更新失败' : '检查更新失败') : `发现新版本 v${s.latest}`;
  $('upMeta').textContent = s.status === 'error' ? '' : [`当前 v${s.current}`, mb(s.size) && `安装包 ${mb(s.size)}`].filter(Boolean).join(' · ');
  $('upNotes').textContent = s.status === 'error' ? '' : s.notes || '';
  $('upProgress').hidden = !busy;
  $('upBar').style.width = `${s.percent || 0}%`;
  $('upPct').textContent = s.status === 'installing' ? '安装中' : `${s.percent || 0}%`;
  const msg = {
    installing: navigator.platform.startsWith('Mac')
      ? '下载好了。App 会先退出，换成新版本后几秒内自动重新打开。'
      : '下载好了。安装程序马上打开，装完会自动重新打开 App。',
    manual: '安装包已经打开：把 PS AI Bridge 拖到「应用程序」文件夹替换旧版（提示时选「替换」），然后重新打开。先退出旧版，替换才不会失败。',
    error: s.error,
  }[s.status];
  $('upMsg').hidden = !msg;
  $('upMsg').textContent = msg || '';
  $('upMsg').className = `up-msg${s.status === 'error' ? ' err' : ''}`;
  $('upSkip').hidden = s.status !== 'available';
  $('upLater').hidden = busy;
  $('upInstall').hidden = s.status === 'installing';
  $('upInstall').disabled = busy;
  $('upInstall').textContent = s.status === 'manual' ? '退出旧版' : s.status === 'error' ? '重试' : s.status === 'downloading' ? '下载中…' : '立即更新';
}

$('upInstall').addEventListener('click', () => action(async () => {
  if (upState.status === 'manual') return window.bridge.quitForUpdate();
  if (upState.status === 'error' && upRetry === 'check') return renderUpdate(await window.bridge.checkUpdate());
  upRetry = 'install';
  await window.bridge.installUpdate();
}));
$('upLater').addEventListener('click', () => window.bridge.dismissUpdate());
$('upSkip').addEventListener('click', () => { window.bridge.skipUpdate(); toast(`以后不再提醒 v${upState.latest}，可以在设置页手动检查更新`); });
$('checkUpdate').addEventListener('click', () => action(async () => {
  upRetry = 'check';
  const s = await window.bridge.checkUpdate();
  if (s.status === 'available') upRetry = 'install';
  if (s.status === 'latest') toast(`已经是最新版本（v${s.current}）`);
  if (s.status === 'disabled') toast('开发版不检查更新');
}));

window.bridge.onUpdate(renderUpdate);
window.bridge.updateState().then(renderUpdate);
