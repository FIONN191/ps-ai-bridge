#!/bin/bash
# 双击启动 ps-ai-bridge 的本机 helper。窗口要一直开着；关掉窗口 helper 就停了。
cd "$(dirname "$0")/helper" || exit 1
NODE="$(command -v node || echo "$HOME/.local/node/bin/node")"
[ -x "$NODE" ] || { echo "找不到 Node.js，请先安装 Node 18 以上版本"; read -r; exit 1; }
if [ ! -d node_modules/playwright-core ]; then
  echo "第一次运行，正在安装依赖…"
  PATH="$(dirname "$NODE"):$PATH" npm install --no-audit --no-fund || { read -r; exit 1; }
fi
exec "$NODE" server.mjs
