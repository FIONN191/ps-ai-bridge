import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

// Arguments are carried in UTF-8 JSON, never interpolated into PowerShell code.
export const WINDOWS_UPDATE_SCRIPT = String.raw`param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Save-Status([string]$stage, [string]$message) {
  $record = @{ version=$cfg.version; stage=$stage; message=$message; installer=$cfg.installer; executable=$cfg.executable; log=$cfg.log; time=[DateTime]::UtcNow.ToString('o') }
  $temp = $cfg.status + '.tmp'
  [IO.File]::WriteAllText($temp, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $cfg.status -Force
  Add-Content -LiteralPath $cfg.log -Value ((Get-Date -Format o) + ' ' + $stage + ' ' + $message) -Encoding UTF8
}
try {
  if (!(Test-Path -LiteralPath $cfg.installer -PathType Leaf)) { throw 'Downloaded installer is missing' }
  Save-Status 'ready' 'Installer helper ready; waiting for application exit'
  [IO.File]::WriteAllText($cfg.ready, 'ready')
  $deadline = (Get-Date).AddSeconds(90)
  while (Get-Process -Id $cfg.parentProcess -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw 'Application did not exit within 90 seconds' }
    Start-Sleep -Milliseconds 250
  }
  Save-Status 'installing' 'Starting installer in the existing installation directory'
  # NSIS /D must be last and unquoted, including when the directory contains spaces.
  $arguments = '/S --updated /D=' + $cfg.installDirectory
  $installerProcess = Start-Process -FilePath $cfg.installer -ArgumentList $arguments -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw ('Installer exit code: ' + $installerProcess.ExitCode) }
  if (!(Test-Path -LiteralPath $cfg.executable -PathType Leaf)) { throw 'Installed executable was not found' }
  $installed = (Get-Item -LiteralPath $cfg.executable).VersionInfo.ProductVersion
  if (($installed -split '[+-]')[0] -ne $cfg.version) { throw ('Installed version does not match: ' + $installed) }
  Save-Status 'installed' 'Installed version verified; reopening application'
  Start-Process -FilePath $cfg.executable
} catch {
  try { Save-Status 'failed' $_.Exception.Message } catch {}
  # Reopen only after the original process has gone. Never terminate user processes.
  if (!(Get-Process -Id $cfg.parentProcess -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $cfg.executable -PathType Leaf)) {
    Start-Process -FilePath $cfg.executable
  }
  exit 1
}
`;

export async function handoffWindowsUpdate({installer,executable,version,directory,parentProcess=process.pid,launch=spawn,timeoutMs=15000,powershell=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')}) {
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('更新版本号无效');
  fs.mkdirSync(directory,{recursive:true});
  const id=crypto.randomUUID(),script=path.join(directory,`install-${id}.ps1`),configFile=path.join(directory,`install-${id}.json`);
  const config={installer,executable,version,installDirectory:path.win32.dirname(executable),parentProcess,ready:path.join(directory,`ready-${id}`),status:path.join(directory,'last-install.json'),log:path.join(directory,`install-${id}.log`)};
  fs.writeFileSync(script,'\ufeff'+WINDOWS_UPDATE_SCRIPT,{mode:0o600});fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
  const encodedPath=Buffer.from(configFile,'utf8').toString('base64');
  const command=WINDOWS_UPDATE_SCRIPT.replace(/^param[^\n]+/,`$ConfigPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`);
  const child=launch(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{
    let timer;const finish=(error)=>{clearInterval(timer);child.removeListener('error',onError);child.removeListener('exit',onExit);if(error){child.kill();reject(error);}else resolve();};
    const onError=e=>finish(new Error(`安装助手未启动：${e.message}`));
    const onExit=code=>finish(new Error(`安装助手提前退出（${code}）。安装包已保留，可手动打开。`));
    child.once('error',onError);child.once('exit',onExit);const start=Date.now();
    timer=setInterval(()=>{if(fs.existsSync(config.ready))finish();else if(Date.now()-start>=timeoutMs)finish(new Error('安装助手未确认就绪，App 将保持打开。可手动运行已下载的安装包。'));},100);
  });
  child.unref();return config;
}

export function previousInstallOutcome(directory,current) {
  const file=path.join(directory,'last-install.json');
  if(!fs.existsSync(file))return null;
  try {
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(record.stage==='complete'||record.dismissed)return null;
    const parts=v=>/^\d+\.\d+\.\d+$/.test(v||'')?v.split('.').map(Number):null;
    const a=parts(current),b=parts(record.version);
    const reached=a&&b&&a.reduce((order,n,i)=>order||Math.sign(n-b[i]),0)>=0;
    if(reached){record.stage='complete';fs.writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});return null;}
    return {...record,error:`上次更新未完成：当前仍为 ${current}，目标为 ${record.version}。${record.message||''}`};
  }catch{return {error:'上次更新记录无法读取，请手动运行新版安装包。'};}
}
