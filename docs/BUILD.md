# Windows 安装包构建指南

## 环境要求

- Ubuntu 24.04 (amd64)
- Node.js v22+
- Wine 9.0+（用于 electron-builder 交叉编译）
- i386 架构已启用（`dpkg --add-architecture i386`）
- p7zip-full（解压构建资源）

## 快速构建（3 步）

```bash
# 1. 克隆并安装依赖
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
npm config set registry https://registry.npmmirror.com
npm install

# 2. 恢复构建缓存（首次从镜像下载，后续使用本地缓存）
bash restore-build-cache.sh

# 3. 构建
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

产出文件在 `release/` 目录。

## 构建资源管理

构建需要以下资源（共 ~145MB），通过 `restore-build-cache.sh` 自动管理：

| 资源 | 大小 | 来源 |
|------|------|------|
| Electron v33.4.11 win32-x64 | 110MB | npmmirror |
| NSIS 3.0.4.1 | 7.8MB | GitHub (ghfast.top 代理) |
| NSIS Resources 3.4.1 | 3.0MB | GitHub (ghfast.top 代理) |
| winCodeSign 2.6.0 | 24MB | GitHub (ghfast.top 代理) |

**工作原理**：
- 首次运行：从镜像下载 → 自动缓存到 `build-resources/` 和 `~/.cache/`
- 后续运行：从 `build-resources/` 复制到 `~/.cache/`（秒级完成）
- `build-resources/` 在 `.gitignore` 中，不进 git（Electron 二进制 110MB 超 git 限制）

**自定义镜像**：
```bash
GITHUB_PROXY=https://gh-proxy.com/ bash restore-build-cache.sh
```

## 详细步骤

### 1. 安装 Wine

```bash
dpkg --add-architecture i386
apt-get update
apt-get install -y wine wine32 p7zip-full
```

### 2. 安装 npm 依赖

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### 3. 恢复构建缓存

```bash
bash restore-build-cache.sh
```

首次会从镜像下载约 145MB 资源，后续构建只需秒级恢复。

### 4. 构建 Windows 安装包

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

## 常用命令

```bash
npm start              # 开发运行
npm run pack           # 仅构建目录（不打包）
npm run dist:nsis      # 仅 NSIS 安装包
npm run dist           # NSIS 安装包
```

## 构建产物

| 文件 | 说明 |
|------|------|
| `release/Metona Ollama Setup v0.11.1.exe` | NSIS 安装包（可选目录、创建快捷方式） |

> 仅提供 NSIS 安装包。

## 发布到 Gitee

### 创建 Release

```bash
TOKEN="your_access_token"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama-desktop/releases?access_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name":"v0.11.1","name":"v0.11.1","body":"Release notes","target_commitish":"master"}'
```

### 上传附件

```bash
TOKEN="your_access_token"
RELEASE_ID="<release_id>"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama-desktop/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" -F "file=@release/Metona Ollama Setup v0.11.1.exe"
```

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| apt 源超时（mirrors.cloud.aliyuncs.com 不可达） | `sed -i 's\|mirrors.cloud.aliyuncs.com\|archive.ubuntu.com\|g' /etc/apt/sources.list && apt-get update` |
| npm install 卡住无输出 | 终止后重试 `npm install --prefer-offline`，通常首次已装大部分包，二次秒完成 |
| npmmirror 缺少 Electron 包（restore-build-cache.sh 失败，NoSuchKey） | npmmirror 可能未同步特定版本。跳过缓存脚本，直接 `npm run dist`，electron-builder 会自动从 npmmirror 下载（`ELECTRON_MIRROR` 环境变量生效） |
| electron-builder 报错 "wine is required" | Wine 是签名步骤的硬依赖，必须安装：`dpkg --add-architecture i386 && apt-get update && apt-get install -y wine wine32` |
| apt 源 i386 架构下载失败 | 先确保主源可用（切 archive.ubuntu.com），再 `apt-get update`，最后装 wine |
| Electron 下载超时 | 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 或直接用 `npm run dist`（electron-builder 自动处理） |
| NSIS/winCodeSign 下载超时 | `GITHUB_PROXY=https://gh-proxy.com/ bash restore-build-cache.sh` |
| winCodeSign 下载 EOF 错误（github.com 连接中断） | 手动下载并缓存（见下方） |
| npm install 时 Electron "socket hang up" | 设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试 |
| restore-build-cache.sh 因 Electron 失败导致后续缓存全部跳过 | 跳过脚本，手动下载缺失资源（见下方） |
| "symbol already declared" | 检查 TS 文件中的重复 `const`/`let` 声明 |

### 手动下载构建缓存（逐项修复）

当 `restore-build-cache.sh` 部分失败时，可手动下载缺失资源：

```bash
GITHUB_PROXY="https://ghfast.top/"
GITHUB_ORIG="https://github.com/electron-userland/electron-builder-binaries/releases/download"
CACHE="$HOME/.cache/electron-builder"

# winCodeSign（构建签名步骤硬依赖）
mkdir -p "$CACHE/winCodeSign"
wget -O "/tmp/winCodeSign-2.6.0.7z" \
  "${GITHUB_PROXY}${GITHUB_ORIG}/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
cd "$CACHE/winCodeSign" && 7z x -y "/tmp/winCodeSign-2.6.0.7z" -o"winCodeSign-2.6.0"

# NSIS
mkdir -p "$CACHE/nsis"
wget -O "/tmp/nsis-3.0.4.1.7z" \
  "${GITHUB_PROXY}${GITHUB_ORIG}/nsis-3.0.4.1/nsis-3.0.4.1.7z"
cd "$CACHE/nsis" && 7z x -y "/tmp/nsis-3.0.4.1.7z" -o"nsis-3.0.4.1"

# NSIS Resources
wget -O "/tmp/nsis-resources-3.4.1.7z" \
  "${GITHUB_PROXY}${GITHUB_ORIG}/nsis-resources-3.4.1/nsis-resources-3.4.1.7z"
cd "$CACHE/nsis" && 7z x -y "/tmp/nsis-resources-3.4.1.7z" -o"nsis-resources-3.4.1"

# 清理临时文件
rm -f /tmp/winCodeSign-2.6.0.7z /tmp/nsis-3.0.4.1.7z /tmp/nsis-resources-3.4.1.7z
```

> Electron 无需手动下载——设置 `ELECTRON_MIRROR` 后 electron-builder 会自动处理。

### ⚠️ 已知问题：npmmirror 与 restore-build-cache.sh 兼容性

`restore-build-cache.sh` 第一步从 npmmirror 下载 Electron zip 时可能遇到 **NoSuchKey** 错误，因为 npmmirror 未同步该版本。此时脚本会因 `set -e` 直接退出，后续 NSIS/winCodeSign 缓存也不会恢复。

**推荐做法**：跳过 `restore-build-cache.sh`，直接执行：
```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```
electron-builder 会自动处理所有依赖下载（Electron、NSIS、winCodeSign），虽然首次较慢（~5分钟），但无需手动管理缓存。

## 提速清单

| 环节 | 默认 → 加速 | 效果 |
|------|------------|------|
| apt 源 | aliyuncs → archive.ubuntu.com | 稳定 |
| npm | npmjs → npmmirror | ~17s |
| Electron | github → npmmirror | ~3s |
| NSIS/winCodeSign | github → ghfast + 本地缓存 | 秒级 |
