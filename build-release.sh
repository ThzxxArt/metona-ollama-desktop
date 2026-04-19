#!/bin/bash
set -e

PROJECT_DIR="/root/.openclaw/workspace/metona-ollama-desktop"
TOKEN="2faf8da068ae0944f7d40c265d21e651"
REPO="thzxx/metona-ollama-desktop"
VERSION="5.1.4"
LOG_FILE="/root/.openclaw/workspace/metona-ollama-desktop/build-v5.1.4.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "══════════════════════════════════════════════"
echo "  Metona Ollama Desktop v${VERSION} 构建开始"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

cd "$PROJECT_DIR"

# ── Step 1: 检查环境 ──
echo ""
echo "▶ Step 1: 检查构建环境"
echo "──────────────────────"
node --version
npm --version
echo "OS: $(uname -a)"
echo "Wine: $(wine --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "p7zip: $(7z 2>/dev/null | head -1 || echo 'NOT INSTALLED')"

# ── Step 2: 确保在正确分支 ──
echo ""
echo "▶ Step 2: 确认分支"
echo "──────────────────────"
git checkout develop
git log --oneline -1

# ── Step 3: 安装依赖 ──
echo ""
echo "▶ Step 3: npm install"
echo "──────────────────────"
npm config set registry https://registry.npmmirror.com
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install 2>&1
echo "npm install 完成"

# ── Step 4: 构建 ──
echo ""
echo "▶ Step 4: npm run build"
echo "──────────────────────"
npm run build 2>&1
echo "npm run build 完成"

# ── Step 5: 打包 Windows 安装包 ──
echo ""
echo "▶ Step 5: npm run dist (Windows NSIS)"
echo "──────────────────────────────────────"
# 先尝试恢复构建缓存
if [ -f restore-build-cache.sh ]; then
  echo "尝试恢复构建缓存..."
  bash restore-build-cache.sh 2>&1 || echo "构建缓存恢复失败，electron-builder 将自动下载"
fi

ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist 2>&1
echo "npm run dist 完成"

# ── Step 6: 检查产物 ──
echo ""
echo "▶ Step 6: 检查构建产物"
echo "────────────────────────"
ls -lh release/*.exe 2>/dev/null || echo "未找到 .exe 文件！"
EXE_FILE=$(ls release/*Setup*.exe 2>/dev/null | head -1)
if [ -z "$EXE_FILE" ]; then
  echo "❌ 构建失败：未找到安装包"
  exit 1
fi
echo "✅ 安装包: $EXE_FILE ($(du -h "$EXE_FILE" | cut -f1))"

# ── Step 7: Gitee 发布 ──
echo ""
echo "▶ Step 7: Gitee 发布"
echo "──────────────────────"

# 删除旧的 v5.1.4-desktop release（如有）
echo "检查旧 release..."
RELEASES=$(curl -s "https://gitee.com/api/v5/repos/${REPO}/releases?access_token=${TOKEN}&page=1&per_page=50")
OLD_RELEASE_ID=$(echo "$RELEASES" | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
    for r in releases:
        if r.get('tag_name') == 'v${VERSION}-desktop':
            print(r['id'])
            break
except: pass
" 2>/dev/null)

if [ -n "$OLD_RELEASE_ID" ]; then
  echo "删除旧 release ID: $OLD_RELEASE_ID"
  curl -s -X DELETE "https://gitee.com/api/v5/repos/${REPO}/releases/${OLD_RELEASE_ID}?access_token=${TOKEN}" > /dev/null
  echo "旧 release 已删除"
fi

# 创建新 release
echo "创建 v${VERSION}-desktop release..."
RELEASE_RESPONSE=$(curl -s -X POST "https://gitee.com/api/v5/repos/${REPO}/releases?access_token=${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"tag_name\": \"v${VERSION}-desktop\",
    \"name\": \"v${VERSION}-desktop\",
    \"body\": \"Metona Ollama Desktop v${VERSION}\\n\\n详见 [更新日志](https://gitee.com/thzxx/metona-ollama-desktop/blob/develop/docs/CHANGELOG.md)\",
    \"target_commitish\": \"develop\"
  }")

RELEASE_ID=$(echo "$RELEASE_RESPONSE" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    print(r.get('id', ''))
except: pass
" 2>/dev/null)

if [ -z "$RELEASE_ID" ]; then
  echo "❌ 创建 release 失败"
  echo "$RELEASE_RESPONSE"
  exit 1
fi
echo "✅ Release 创建成功，ID: $RELEASE_ID"

# 上传附件
echo "上传安装包附件..."
UPLOAD_RESPONSE=$(curl -s -X POST "https://gitee.com/api/v5/repos/${REPO}/releases/${RELEASE_ID}/attach_files?access_token=${TOKEN}" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@${EXE_FILE}")

UPLOAD_SUCCESS=$(echo "$UPLOAD_RESPONSE" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    if r.get('browser_download_url'):
        print('OK')
    else:
        print('FAIL: ' + str(r))
except Exception as e:
    print('FAIL: ' + str(e))
" 2>/dev/null)

if [ "$UPLOAD_SUCCESS" = "OK" ]; then
  echo "✅ 安装包上传成功"
else
  echo "❌ 上传失败: $UPLOAD_RESPONSE"
  exit 1
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  构建完成！v${VERSION}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Release: https://gitee.com/${REPO}/releases"
echo "══════════════════════════════════════════════"
