// 「截图加参考」：拖一个框截屏幕上任意位置，Esc 取消。
// macOS 用自带的 screencapture；Windows 调起系统截图（就是 Win+Shift+S 那个），截好的图在剪贴板里，从剪贴板取。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// 记下剪贴板序号，调起截图，等序号变了且剪贴板里是图就存成 PNG。
// 截图浮层（ScreenClippingHost / SnippingTool）出现过又消失、剪贴板没变，就当用户按了 Esc。
const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace PsAiBridge -Name Clip -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
$out = $env:PS_AI_BRIDGE_SHOT
$seq = [PsAiBridge.Clip]::GetClipboardSequenceNumber()
Start-Process 'ms-screenclip:'
$seen = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  if ([PsAiBridge.Clip]::GetClipboardSequenceNumber() -ne $seq -and [Windows.Forms.Clipboard]::ContainsImage()) {
    [Windows.Forms.Clipboard]::GetImage().Save($out, [Drawing.Imaging.ImageFormat]::Png)
    exit 0
  }
  if (Get-Process -Name ScreenClippingHost, SnippingTool -ErrorAction SilentlyContinue) { $seen = $true }
  elseif ($seen) {
    Start-Sleep -Milliseconds 800
    if ([PsAiBridge.Clip]::GetClipboardSequenceNumber() -eq $seq) { exit 2 }
  }
}
exit 2
`;

// 返回截好的 PNG 路径；用户取消时返回 null
export async function captureRegion() {
  const file = path.join(os.tmpdir(), `ps-ai-bridge-shot-${Date.now()}.png`);
  if (process.platform === 'darwin') {
    await new Promise((resolve) => execFile('/usr/sbin/screencapture', ['-i', '-x', file], () => resolve()));
  } else if (process.platform === 'win32') {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, PS_AI_BRIDGE_SHOT: file }, windowsHide: true, timeout: 90000,
    }, () => resolve()));
  } else {
    throw new Error('这个系统还不支持截图加参考');
  }
  return fs.existsSync(file) ? file : null;
}
