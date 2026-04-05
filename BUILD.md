# Windows 安装包构建指南

## 环境要求

- Ubuntu 24.04 (amd64)
- Node.js v22+
- Wine 9.0+（用于 electron-builder 交叉编译）
- i386 架构已启用（`dpkg --add-architecture i386`）

## 构建步骤

### 1. 克隆项目

```bash
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama
git checkout metona-ollama-desktop-v1.1
```

### 2. 安装依赖（使用国内镜像）

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

> ⚠️ **不要用默认 npm 源**，国内环境下大概率超时。npmmirror 速度快且稳定。

### 3. 构建 Windows 安装包

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

> ⚠️ **必须设置 `ELECTRON_MIRROR`**，否则 electron-builder 会从 GitHub 下载 Electron 二进制（115MB），国内基本连不上。

## 遇到的问题与解决方案

### 问题 1：apt 源不可用（阿里云镜像超时）

**现象**：`apt-get update` 报错 `mirrors.cloud.aliyuncs.com` 连接超时。

**解决**：替换为 Ubuntu 官方源：

```bash
sed -i 's|http://mirrors.cloud.aliyuncs.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list
```

### 问题 2：npm install 超时

**现象**：使用默认 npm registry 下载依赖超时。

**解决**：切换到 npmmirror 国内镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

### 问题 3：Electron 下载超时（GitHub 连不上）

**现象**：electron-builder 打包时卡在 `downloading electron-v33.4.11-win32-x64.zip`，115MB 从 GitHub 下载，国内超时。

**解决**：设置环境变量使用 npmmirror 的 Electron 镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

设置后 4.22 秒下载完成，vs 之前直接超时。

### 问题 4：winCodeSign 下载慢

**现象**：electron-builder 需要从 GitHub 下载 `winCodeSign-2.6.0`（5.6MB）。

**说明**：这个文件较小，即使从 GitHub 下载通常也能完成（可能需要几分钟）。如果超时，可以手动下载放到缓存目录：

```bash
# electron-builder 缓存目录
~/.cache/electron-builder/winCodeSign/winCodeSign-2.6.0/
```

## 常用命令

```bash
# 开发运行
npm start

# 仅构建目录（不打包，用于测试）
npm run pack

# 构建 NSIS 安装包
npm run dist:nsis

# 构建绿色便携版
npm run dist:portable

# 构建全部（NSIS + Portable）
npm run dist
```

## 构建产物

| 文件 | 说明 |
|------|------|
| `release/Metona Ollama Setup X.X.X.exe` | NSIS 安装包（可选目录、创建快捷方式） |
| `release/MetonaOllama-Portable-X.X.X.exe` | 绿色便携版（免安装，双击即用） |

## 发布到 Gitee

### 上传附件

```bash
TOKEN="your_access_token"
RELEASE_ID="600168"  # v1.1.0 release ID

curl -X POST \
  "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@release/Metona Ollama Setup 1.1.0.exe"

curl -X POST \
  "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@release/MetonaOllama-Portable-1.1.0.exe"
```

### 清理重复附件

```bash
# 查看附件列表
curl -s "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN"

# 删除指定附件
curl -X DELETE "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files/$ASSET_ID?access_token=$TOKEN"
```

## 提速清单

| 环节 | 默认方案 | 加速方案 | 效果 |
|------|----------|----------|------|
| apt 源 | archive.ubuntu.com | 保持官方源即可 | 稳定可用 |
| npm 依赖 | registry.npmjs.org | registry.npmmirror.com | 59s 完成 |
| Electron 下载 | github.com | npmmirror.com/mirrors/electron | 4s 完成（vs 超时） |
| winCodeSign | github.com | 小文件可等待 / 手动缓存 | 通常可完成 |
