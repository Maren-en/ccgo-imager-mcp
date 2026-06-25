#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "CCGO Imager MCP 安装器"
echo
echo "这个安装器会："
echo "1. 安装本地依赖"
echo "2. 让你在终端粘贴 CCGO 生图 MCP Key"
echo "3. 自动写入 Codex / Claude MCP 配置"
echo "4. 写配置前自动备份"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装 Node.js 20 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo
  read "unused?按回车退出..."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 npm。请先安装 Node.js 20 或更高版本。"
  echo "下载地址：https://nodejs.org/"
  echo
  read "unused?按回车退出..."
  exit 1
fi

echo "正在安装依赖..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
echo

npm run install:local
echo

read "unused?按回车关闭窗口..."
