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
git checkout metona-ollama-desktop-v5.0.1
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
| `release/Metona Ollama Setup X.X.X.exe` | NSIS 安装包（可选目录、创建快捷方式） |

> v3.2.0 起不再提供绿色便携版，仅保留 NSIS 安装包。

## 发布到 Gitee

### 创建 Release

```bash
TOKEN="your_access_token"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases?access_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name":"v3.2.0","name":"v3.2.0","body":"Release notes","target_commitish":"refactor/modular-architecture"}'
```

### 上传附件

```bash
TOKEN="your_access_token"
RELEASE_ID="600564"
curl -X POST "https://gitee.com/api/v5/repos/thzxx/metona-ollama/releases/$RELEASE_ID/attach_files?access_token=$TOKEN" \
  -H "Content-Type: multipart/form-data" -F "file=@release/Metona Ollama Setup 3.2.0.exe"
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

## 构建日志

### v5.0.1（2026-04-18） — metona-ollama-desktop 仓库

- 🔧 修复 DuckDuckGo 搜索超时过长（15s → 8s），添加 Google 作为第三搜索引擎兜底
- 🔧 修复 web_fetch User-Agent（MetonaOllama/1.0 → Chrome UA），增加超时至 30 秒
- 🔧 修复 Agent Loop 跨轮去重误杀失败工具的重试（仅对成功的调用去重，失败的允许重试）
- 🔧 优化 TOOL_USAGE_GUIDE：新增搜索 fallback 规则（fetch 失败时直接用搜索结果回答）、禁止抓取 SPA 页面、搜索查询进化指导
- 🔧 更新 AGENT_SYSTEM_PROMPT：工具数 25 → 34，新增 fetch 失败 fallback 规则
- 📝 版本号更新至 5.0.1（package.json / package-lock.json / index.html / README.md / CHANGELOG.md / BUILD.md / DEVELOPMENT.md）

### v5.0.0（2026-04-18） — metona-ollama-desktop 仓库

- ✨ 新增 8 个浏览器控制工具（browser_open/screenshot/evaluate/extract/click/type/scroll/close）
- ✨ 新增 Cron 定时任务系统（cron-manager.ts）
- ✨ 新增技能自动生成系统（skills 表 + 自动提取 + 关键词搜索）
- ✨ 新增用户画像自动推断（技术栈检测 + system prompt 注入）
- ✨ 新增人格模式（多预设模板）
- ✨ 新增 Heartbeat 主动检查机制
- ✨ 新增子代理委派工具（spawn_task）
- 🔧 工具并行执行优化（批次调度 + 依赖检测）
- 🔧 记忆系统增强（rule/preference 始终注入）
- 📝 版本号更新至 5.0.0（package.json / package-lock.json / index.html / README.md / CHANGELOG.md / BUILD.md / DEVELOPMENT.md）

### v4.0.0（2026-04-17） — metona-ollama-desktop 仓库

- 📦 SQLite (sql.js WASM) 替代 IndexedDB，6 张表 + FTS5 全文搜索（零原生依赖）
- 🔧 Agent Loop 升级为 ReAct 模式（15 轮，10 分钟超时，执行轨迹记录）
- 🧠 新增 4 个记忆/会话管理工具（memory_search, memory_add, session_list, session_read）
- 🎨 UI 主题改版：暗色 Fluent → 暖色调亮色（奶白 + 珊瑚橙）
- ✨ 新增 context-manager.ts 上下文管理服务
- 📝 版本号更新至 4.0.0（package.json / package-lock.json / index.html / README.md / CHANGELOG.md / BUILD.md / DEVELOPMENT.md）

### v3.3.4（2026-04-17） — metona-ollama-desktop 仓库

- 🔧 修复 Agent Loop 工具调用重复问题（缓存 + 同轮/跨轮去重 + 自动终止）
- 🔧 修复 web_fetch 默认截断 10000 字符（改为默认不截断）
- 🔧 修复记忆系统 rule/preference 类型不生效（改为始终注入，不依赖关键词匹配）
- 🔧 修复 buildMemoryContext 三类记忆措辞无区分（规则→强制、偏好→建议、事实→参考）
- 🔧 移除 tool-registry.ts executeTool 中重复的 logToolStart 调用
- 📝 版本号更新至 3.3.4

### v3.3.3（2026-04-17） — metona-ollama-desktop 仓库

- 🔧 修复工具面板中除 run_command 外所有工具错误显示为"需确认"
- 🔧 修复 run_command 执行模式下拉框未选中项白字白底不可见
- 🎨 加宽工具面板、历史记录、设置面板、帮助面板
- ✨ 增强联网搜索与网页抓取联动（TOOL_USAGE_GUIDE 新增规则）
- ✨ 增强 AI 主动调用工具的 prompt 指导（新增第 7 条规则）
- ✨ web_search 默认结果数 5 → 15
- 📝 版本号更新至 3.3.3

### v3.3.2（2026-04-16） — metona-ollama-desktop 仓库

- ✨ 新增 web_search 联网搜索工具（DuckDuckGo + Bing 双引擎，21 个工具）
- 🔧 除 run_command 外所有工具改为自动执行无需确认
- 🔧 run_command 改为下拉框设置：自动/需确认/禁用三种模式
- 📝 版本号更新至 3.3.2（package.json / index.html / README.md / CHANGELOG.md / BUILD.md）
- 📝 同步更新 README.md 安全说明、DEVELOPMENT.md 开发规范、index.html 帮助面板

### v3.3.1（2026-04-16） — metona-ollama-desktop 仓库

- 🔧 修复开启工具调用后图片无法传给 AI（agent-engine.ts + input-area.ts）
- 🔧 修复记忆系统弹框自动记忆开关点击无响应（memory-modal.ts CSS 类名修正）
- 🎨 统一应用图标为科技感羊驼（llama.png / llama.ico）
- 📝 版本号更新至 3.3.1（package.json / index.html / README.md / CHANGELOG.md / BUILD.md）

### v3.2.6（2026-04-15） — metona-ollama-desktop 仓库

- ✅ `Metona Ollama Setup 3.2.6.exe`（78MB）
- ✅ Gitee Release v3.2.6-desktop（ID: 604992）
- 🔧 工作空间面板从 position:fixed 改为 flex 子元素，修复与主内容区错位
- 🎨 Token 统计颜色优化（琥珀色图标+数值，消息内 token 高亮）
- ⚠️ 构建问题及处理：
  1. `restore-build-cache.sh` npmmirror NoSuchKey → 跳过，electron-builder 自动下载
  2. nsis-resources-3.4.1 GitHub 下载 EOF → 使用 ghfast.top 代理手动下载缓存
  3. 无编译错误，手动缓存后构建一次通过

### v3.2.5（2026-04-14） — metona-ollama-desktop 仓库

- ✅ `Metona Ollama Setup 3.2.5.exe`（78MB）
- ✅ Gitee Release v3.2.5-desktop（ID: 601311）
- 🔧 工具相对路径修复、工作空间单一终端重构、token SVG 图标、base64 编码修复
- ⚠️ 构建问题及处理：
  1. apt 源 `mirrors.cloud.aliyuncs.com` 不可达 → 切换 `archive.ubuntu.com`
  2. `restore-build-cache.sh` npmmirror NoSuchKey → 跳过，electron-builder 自动下载
  3. 无编译错误，构建一次通过

### v3.2.4（2026-04-08） — metona-ollama-desktop 仓库

- 🔧 AI 命令执行走工作空间终端，实时流式显示
- 🔧 设置面板修改地址后同步更新顶部导航连接状态
- ✅ 分支 `metona-ollama-desktop-v3.2.4` 已创建并推送

### v3.2.3（2026-04-08） — metona-ollama-desktop 仓库

- ✅ 工作空间面板改为常驻显示，固定宽度 480px
- ✅ 修复 tool-registry.ts 缺少 logInfo 导入导致 run_command 异常
- ✅ Gitee Release v3.2.3-desktop（仓库 thzxx/metona-ollama-desktop）
- ✅ 分支 `metona-ollama-desktop-v3.2.3` 已创建并推送

### v3.2.2（2026-04-08） — metona-ollama-desktop 仓库

- ✅ `Metona Ollama Setup 3.2.2.exe`（78MB）
- ✅ Gitee Release v3.2.2-desktop（ID: 600992，仓库 thzxx/metona-ollama-desktop）
- ✅ 分支 `metona-ollama-desktop-v3.2.2` 已创建并推送
- ⚠️ 构建问题及处理：
  1. apt 源 `mirrors.cloud.aliyuncs.com` 不可达 → 切换 `archive.ubuntu.com`
  2. npm install 时 Electron socket hang up → 设 `ELECTRON_MIRROR` 重试成功
  3. restore-build-cache.sh 第一步失败（npmmirror NoSuchKey）→ 跳过脚本
  4. electron-builder 直接构建时 winCodeSign 从 GitHub 下载 EOF → 使用 ghfast.top 代理手动下载缓存
  5. 手动缓存 NSIS 和 NSIS Resources 后重新构建成功

### v3.2.1（2026-04-07） — metona-ollama-desktop 仓库

- ✅ `Metona Ollama Setup 3.2.1.exe`（78MB）
- ✅ Gitee Release v3.2.1-desktop（ID: 600984，仓库 thzxx/metona-ollama-desktop）
- ♻️ 移除便携版构建，仅保留 NSIS 安装包

### v3.2.0（2026-04-07） — metona-ollama-desktop 仓库

- ✅ `Metona Ollama Setup 3.2.0.exe`（78MB）
- ✅ `MetonaOllama-Portable-3.2.0.exe`（78MB）
- ✅ Gitee Release v3.2.0-desktop（ID: 600739，仓库 thzxx/metona-ollama-desktop）
- ⚠️ 构建中遇到问题：npmmirror 缺 electron zip、npm install 卡顿、需安装 Wine。详见上方故障排查。

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
