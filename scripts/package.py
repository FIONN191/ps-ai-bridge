#!/usr/bin/env python3
from pathlib import Path
import json, zipfile, hashlib
root=Path(__file__).resolve().parents[1]
v=json.loads((root/'plugin/manifest.json').read_text())['version']
out=root/'dist';out.mkdir(exist_ok=True);stem='PS-AI-Bridge-v'+v
assert 'PSAI_BRIDGE_PROBE' not in (root/'plugin/index.js').read_text(), 'Remove temporary test instrumentation first'
ccx=out/(stem+'.ccx')
def include(f):
    return f.is_file() and not f.is_symlink() and not any(s.startswith('.') or s=='node_modules' for s in f.relative_to(root).parts) and f.name!='config.json'
with zipfile.ZipFile(ccx,'w',zipfile.ZIP_DEFLATED) as z:
    for f in sorted((root/'plugin').rglob('*')):
        if include(f): z.write(f,f.relative_to(root/'plugin').as_posix())
    for n in ['LICENSE','NOTICE']: z.write(root/n,n)
note='''# 安装说明

1. 将完整 ZIP 解压到固定目录，保留 helper 和启动脚本。
2. 双击 CCX，通过 Adobe Creative Cloud 安装面板；同 ID 开发版先在 UDT 卸载。也可用 UDT 加载 plugin/manifest.json。
3. macOS 安装 Node.js 22/24、Google Chrome，双击「启动 helper.command」。首次联网安装依赖，终端保持开启。
4. 打开 PS 面板，登录专用 Chrome 后使用。快捷键位于生成按钮上方，默认 Cmd+G，输入组合键并保存即可修改；关闭须取消启用并保存。

新快捷键需要同时更新 helper。单独安装 CCX 不包含本机快捷键组件。每次启动 PS 后打开一次面板；helper 与面板会话在线、Photoshop 位于前台时快捷键才生效。原组合键对应的 PS 功能会被快捷键桥接优先接管。Windows 桥接尚未实现。Intel Mac 组件为交叉编译，未实机验证。

完整 ZIP 包含源码、原生组件源码与二进制、121 个出厂预设、许可证及测试；不含账号、API Key、个人预设、生成记录或 node_modules。CLI 通道另需 agent-imagen-skill。
'''
(out/'安装说明.md').write_text(note)
archive=out/(stem+'-full.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for n in ['README.md','LICENSE','NOTICE','启动 helper.command']:z.write(root/n,f'{stem}/{n}')
    for d in ['plugin','helper','scripts']:
        for f in sorted((root/d).rglob('*')):
            if include(f):z.write(f,f'{stem}/{f.relative_to(root).as_posix()}')
    z.write(ccx,f'{stem}/{ccx.name}');z.writestr(f'{stem}/安装说明.md',note)
for p in [ccx,archive]:
    with zipfile.ZipFile(p) as z: assert z.testzip() is None
    print(p.name,p.stat().st_size)
(out/(stem+'-SHA256SUMS.txt')).write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in [ccx,archive]))
