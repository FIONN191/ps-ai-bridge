// helper 自己的数据目录：用户预设、专用 Chrome 配置、小状态、快捷键、用户配置都放这里，不进程序文件夹。
// macOS 是 ~/Library/Application Support/ps-ai-bridge，Windows 是 %APPDATA%\ps-ai-bridge。桌面端也从这里读路径。
import os from 'node:os';
import path from 'node:path';

function defaultDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ps-ai-bridge');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ps-ai-bridge');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ps-ai-bridge');
}

export const DATA_DIR = process.env.PS_AI_BRIDGE_DATA_DIR || defaultDir();
export const USER_CONFIG = path.join(DATA_DIR, 'config.json');
