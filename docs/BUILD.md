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
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama
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
npm run dist:portable  # 仅绿色便携版
npm run dist           # 全部（NSIS + Portable）
```

## 构建产物

| 文件 | 说明 |
|------|------|
| `release/Metona Ollama Setup X.X.X.exe` | NSIS 安装包（可选目录、创建快捷方式） |
| `release/MetonaOllama-Portable-X.X.X.exe` | 绿色便携版（免安装，双击即用） |

## 发布到 Gitee

### 创建 Release

```bash
TOKEN="your_access_token"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases?access_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name":"v3.1.0","name":"v3.1.0","body":"Release notes","target_commitish":"refactor/modular-architecture"}'
```

### 上传附件

```bash
TOKEN="your_access_token"
RELEASE_ID="600564"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" -F "file=@release/Metona Ollama Setup 3.1.0.exe"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" -F "file=@release/MetonaOllama-Portable-3.1.0.exe"
```

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| apt 源超时 | `sed -i 's\|mirrors.cloud.aliyuncs.com\|archive.ubuntu.com\|g' /etc/apt/sources.list` |
| npm 超时 | `npm config set registry https://registry.npmmirror.com` |
| Electron 下载超时 | 设 `ELECTRON_MIRROR` 或用 `restore-build-cache.sh` |
| NSIS/winCodeSign 下载超时 | `GITHUB_PROXY=https://gh-proxy.com/ bash restore-build-cache.sh` |
| "symbol already declared" | 检查 TS 文件中的重复 `const`/`let` 声明 |

## 构建日志

### v3.1.0（2026-04-07）

- ✅ `Metona Ollama Setup 3.1.0.exe`（78MB）
- ✅ `MetonaOllama-Portable-3.1.0.exe`（78MB）
- ✅ Gitee Release v3.1.0（ID: 600564）

### v3.0.0（2026-04-06）

- ✅ `Metona Ollama Setup 3.0.0.exe`（78MB）
- ✅ `MetonaOllama-Portable-3.0.0.exe`（78MB）
- ✅ Gitee Release v3.0.0（ID: 600370）

## 提速清单

| 环节 | 默认 → 加速 | 效果 |
|------|------------|------|
| apt 源 | aliyuncs → archive.ubuntu.com | 稳定 |
| npm | npmjs → npmmirror | ~17s |
| Electron | github → npmmirror | ~3s |
| NSIS/winCodeSign | github → ghfast + 本地缓存 | 秒级 |
