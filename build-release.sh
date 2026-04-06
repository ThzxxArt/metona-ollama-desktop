#!/bin/bash
set -e

PROJECT="/root/.openclaw/workspace/metona-ollama"
cd "$PROJECT"

echo "===== [1/6] 安装 Wine ====="
dpkg --add-architecture i386
apt-get update -qq 2>/dev/null || sed -i 's|http://mirrors.cloud.aliyuncs.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list && apt-get update -qq
apt-get install -y -qq wine wine32 2>&1 | tail -3
echo "Wine 安装完成: $(wine --version 2>/dev/null || echo 'installed')"

echo ""
echo "===== [2/6] 安装 npm 依赖 ====="
cd "$PROJECT"
npm config set registry https://registry.npmmirror.com
npm install 2>&1 | tail -5
echo "npm install 完成"

echo ""
echo "===== [3/6] 构建 Windows 安装包 ====="
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist 2>&1 | tail -20
echo ""
echo "构建产物："
ls -lh "$PROJECT/release/"*.exe 2>/dev/null || echo "未找到 exe 文件"

echo ""
echo "===== BUILD SCRIPT DONE ====="
