#!/bin/bash
# restore-build-cache.sh
# 从 build-resources/ 恢复 electron-builder 缓存，加速构建
# 如果本地资源不存在，自动从镜像下载

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_ELECTRON="$HOME/.cache/electron"
CACHE_BUILDER="$HOME/.cache/electron-builder"
LOCAL="$SCRIPT_DIR/build-resources"

ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
GITHUB_PROXY="${GITHUB_PROXY:-https://ghfast.top/}"
GITHUB_ORIG="https://github.com/electron-userland/electron-builder-binaries/releases/download"

ELECTRON_VERSION="33.4.11"
NSIS_VERSION="3.0.4.1"
NSIS_RES_VERSION="3.4.1"
WINCODESIGN_VERSION="2.6.0"

echo "===== 恢复构建缓存 ====="

ELECTRON_FILE="electron-v${ELECTRON_VERSION}-win32-x64.zip"
mkdir -p "$CACHE_ELECTRON"
if [ -f "$LOCAL/electron/$ELECTRON_FILE" ]; then
    echo "[1/4] Electron ← 本地缓存"
    cp "$LOCAL/electron/$ELECTRON_FILE" "$CACHE_ELECTRON/"
elif [ -f "$CACHE_ELECTRON/$ELECTRON_FILE" ]; then
    echo "[1/4] Electron ← 缓存已存在"
else
    echo "[1/4] Electron ← 下载 ${ELECTRON_MIRROR}${ELECTRON_FILE}"
    mkdir -p "$LOCAL/electron"
    wget -q --show-progress -O "$CACHE_ELECTRON/$ELECTRON_FILE" "${ELECTRON_MIRROR}${ELECTRON_FILE}"
    cp "$CACHE_ELECTRON/$ELECTRON_FILE" "$LOCAL/electron/"
fi

mkdir -p "$CACHE_BUILDER/nsis"
NSIS_DIR="$CACHE_BUILDER/nsis/nsis-${NSIS_VERSION}"
if [ -d "$LOCAL/electron-builder/nsis-${NSIS_VERSION}" ]; then
    echo "[2/4] NSIS ${NSIS_VERSION} ← 本地缓存"
    cp -r "$LOCAL/electron-builder/nsis-${NSIS_VERSION}" "$NSIS_DIR"
elif [ -d "$NSIS_DIR" ]; then
    echo "[2/4] NSIS ${NSIS_VERSION} ← 缓存已存在"
else
    echo "[2/4] NSIS ${NSIS_VERSION} ← 下载"
    mkdir -p "$LOCAL/electron-builder"
    wget -q --show-progress -O "/tmp/nsis-${NSIS_VERSION}.7z" \
        "${GITHUB_PROXY}${GITHUB_ORIG}/nsis-${NSIS_VERSION}/nsis-${NSIS_VERSION}.7z"
    cd "$CACHE_BUILDER/nsis"
    7z x -y "/tmp/nsis-${NSIS_VERSION}.7z" -o"nsis-${NSIS_VERSION}" >/dev/null
    rm -f "/tmp/nsis-${NSIS_VERSION}.7z"
    cp -r "$NSIS_DIR" "$LOCAL/electron-builder/"
    cd "$SCRIPT_DIR"
fi

NSIS_RES_DIR="$CACHE_BUILDER/nsis/nsis-resources-${NSIS_RES_VERSION}"
if [ -d "$LOCAL/electron-builder/nsis-resources-${NSIS_RES_VERSION}" ]; then
    echo "[3/4] NSIS Resources ${NSIS_RES_VERSION} ← 本地缓存"
    cp -r "$LOCAL/electron-builder/nsis-resources-${NSIS_RES_VERSION}" "$NSIS_RES_DIR"
elif [ -d "$NSIS_RES_DIR" ]; then
    echo "[3/4] NSIS Resources ${NSIS_RES_VERSION} ← 缓存已存在"
else
    echo "[3/4] NSIS Resources ${NSIS_RES_VERSION} ← 下载"
    mkdir -p "$LOCAL/electron-builder"
    wget -q --show-progress -O "/tmp/nsis-resources-${NSIS_RES_VERSION}.7z" \
        "${GITHUB_PROXY}${GITHUB_ORIG}/nsis-resources-${NSIS_RES_VERSION}/nsis-resources-${NSIS_RES_VERSION}.7z"
    cd "$CACHE_BUILDER/nsis"
    7z x -y "/tmp/nsis-resources-${NSIS_RES_VERSION}.7z" -o"nsis-resources-${NSIS_RES_VERSION}" >/dev/null
    rm -f "/tmp/nsis-resources-${NSIS_RES_VERSION}.7z"
    cp -r "$NSIS_RES_DIR" "$LOCAL/electron-builder/"
    cd "$SCRIPT_DIR"
fi

WINCS_DIR="$CACHE_BUILDER/winCodeSign/winCodeSign-${WINCODESIGN_VERSION}"
if [ -d "$LOCAL/electron-builder/winCodeSign-${WINCODESIGN_VERSION}" ]; then
    echo "[4/4] winCodeSign ${WINCODESIGN_VERSION} ← 本地缓存"
    mkdir -p "$CACHE_BUILDER/winCodeSign"
    cp -r "$LOCAL/electron-builder/winCodeSign-${WINCODESIGN_VERSION}" "$WINCS_DIR"
elif [ -d "$WINCS_DIR" ]; then
    echo "[4/4] winCodeSign ${WINCODESIGN_VERSION} ← 缓存已存在"
else
    echo "[4/4] winCodeSign ${WINCODESIGN_VERSION} ← 下载"
    mkdir -p "$LOCAL/electron-builder"
    mkdir -p "$CACHE_BUILDER/winCodeSign"
    wget -q --show-progress -O "/tmp/winCodeSign-${WINCODESIGN_VERSION}.7z" \
        "${GITHUB_PROXY}${GITHUB_ORIG}/winCodeSign-${WINCODESIGN_VERSION}/winCodeSign-${WINCODESIGN_VERSION}.7z"
    cd "$CACHE_BUILDER/winCodeSign"
    7z x -y "/tmp/winCodeSign-${WINCODESIGN_VERSION}.7z" -o"winCodeSign-${WINCODESIGN_VERSION}" >/dev/null
    rm -f "/tmp/winCodeSign-${WINCODESIGN_VERSION}.7z"
    cp -r "$WINCS_DIR" "$LOCAL/electron-builder/"
    cd "$SCRIPT_DIR"
fi

echo ""
echo "===== 缓存恢复完成 ====="
echo "现在可以运行: ELECTRON_MIRROR=$ELECTRON_MIRROR npm run dist"
