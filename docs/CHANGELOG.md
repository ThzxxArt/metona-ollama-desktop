# 📋 更新日志

## 分支结构

**桌面版主线**（`master`）：
- `metona-ollama-desktop-v1` → `metona-ollama-desktop-v1.1` → `metona-ollama-desktop-v2` → `metona-ollama-desktop-v3` → `metona-ollama-desktop-v3.2.0` → `metona-ollama-desktop-v3.2.1` → `metona-ollama-desktop-v3.2.2` → `metona-ollama-desktop-v3.2.3`（当前）

**Web 版历史**已独立为 [metona-ollama-web](https://gitee.com/thzxx/metona-ollama-web) 仓库（v1.1.0 ~ v4.0.3）。

---

## 桌面版（Desktop）

### Desktop v3.2.3 — 工作空间面板常驻显示 & Bug 修复

- 🖥️ **工作空间面板改为常驻显示**
  - 类似执行日志面板，固定显示不可关闭，移除关闭按钮和 header 中的切换按钮
  - 固定宽度 480px，移除拖拽调整宽度功能（`wsResizer` 及 `setupResizer()` 全部删除）
  - `main-wrap` 始终带 `with-workspace` class，面板初始化即可见（`panelVisible = true`）
  - 删除 `togglePanel()` 函数及相关事件绑定
- 🔧 **Bug 修复**
  - 修复 `tool-registry.ts` 使用 `logInfo` 但未导入导致 `run_command` 工具调用报 "logInfo is not defined" 异常
- 📦 **构建产物**
  - `Metona Ollama Setup 3.2.3.exe`（78MB）
  - Gitee Release v3.2.3-desktop（ID: 601248）

### Desktop v3.2.2 — 工作空间深度集成 & 构建修复

- 🔧 **工作空间与 AI Tool Calling 深度集成**
  - 工作空间命令行新增「执行」按钮，AI 建议的 `run_command` 工具调用可在工作空间终端中可视化执行
  - 工具调用结果实时流式输出到工作空间终端面板，支持长时间运行命令
  - 完善 IPC 通信链路：`preload.ts` 新增 workspace API 桥接、`ipc.ts` 新增对应 handler
- 📦 **构建流程修复与优化**
  - 修复 `npm install` 时 Electron "socket hang up" 问题（需设置 `ELECTRON_MIRROR`）
  - 修复 electron-builder 构建时 winCodeSign 从 GitHub 下载 EOF 错误（使用 ghfast.top 代理）
  - 修复 `restore-build-cache.sh` 因 npmmirror 缺包导致全部缓存跳过的问题
  - 新增手动缓存下载方案：逐项下载 winCodeSign/NSIS/NSIS Resources 的完整命令
  - `docs/BUILD.md` 故障排查表新增 3 条条目，附完整手动缓存命令
- 📝 **文档更新**
  - 更新 README.md 最新版本说明和构建分支引用
  - 更新 docs/CHANGELOG.md 版本分支结构
  - 更新 docs/BUILD.md 构建日志（v3.2.2 记录 5 个问题及处理步骤）

### Desktop v3.2.1 — 日志统一 & 构建优化

- ♻️ **主进程日志接入执行日志面板**
  - 清除 `ipc.ts` 4 处 `console.log/error`，新增 `sendLog()` 函数通过 IPC 推送到渲染进程
  - 清除 `workspace.ts` 1 处 `console.log`，统一走 `sendLog()`
  - `preload.ts` 新增 `onMainLog` 监听通道
  - `main.ts` 监听 `main:log` 事件转发到 `addLog()`，全项目零 `console.log`
- 📦 **移除便携版**
  - `package.json` 移除 `portable` 构建目标、`dist:portable` 脚本和 `portable` 配置块
  - Gitee 清理 v1.0.0 ~ v3.1.1 旧版本便携版附件，释放仓库配额
- 🗑️ 删除 `docs/V3-TOOL-CALLING.md`
- 📝 更新 README.md（下载说明、常用命令、项目结构）和 docs/BUILD.md

### Desktop v3.2.0 — 工作空间面板 & 构建优化

- 🖥️ **工作空间面板**
  - 右侧面板：命令行 Tab + 文件浏览器 Tab，宽度可拖拽调整
  - 终端界面：实时流式输出、ANSI 颜色支持、多终端 Tab、无超时限制
  - 文件浏览器：目录树、文件预览（带行号）、上级目录导航
  - IPC 双向通信：`on/send` 模式实现流式推送，独立于 Agent Loop 超时体系
  - 设置面板新增工作空间目录配置（默认 `userData/workspace`）
  - 窗口关闭时自动 SIGTERM 所有子进程，防止进程泄漏
- ♻️ **结构化日志系统**
  - 渲染进程 58 处 `console.log/warn/error` 全部迁移至 `log-service.ts`
  - 135 处结构化日志点覆盖全链路：初始化、连接、模型加载、工具调用、RAG 检索、记忆提取、流式响应、Agent Loop
  - 日志级别分级（init/success/info/warn/error/debug），便于过滤排查
- 🖥️ **文件对话框全面原生化**
  - 图片上传 → `bridge.dialog.openFile()`（原生文件选择器 + 图片类型过滤）
  - 文件上传 → `bridge.dialog.openFile()`（50+ 种文本/代码格式过滤）
  - 知识库文档上传 → `bridge.dialog.openFile()`（文档格式过滤）
  - 会话导入 → `bridge.dialog.openFile()`（.metona 格式过滤）
  - 会话导出 → `bridge.dialog.saveFile()`（替代浏览器 blob 下载）
  - 聊天导出（Markdown/HTML/TXT） → `bridge.dialog.saveFile()`（替代浏览器 blob 下载）
- 🪙 **Token 消耗统计**
  - Header 新增 🪙 图标 + 当前会话总 token 消耗实时显示
  - `updateTotalTokens()` 在每轮对话完成后自动更新
  - Agent Loop 和普通聊天均支持统计
- 🧹 **代码清理**
  - 移除浏览器专用工具函数：`fileToBase64()`、`fileToText()`、`downloadFile()`
  - 所有文件 I/O 统一走 Electron IPC 桥接（`bridge.fs.readFile` / `bridge.fs.writeFile`）
  - 清理废弃的 `DesktopBridge` 接口，统一使用 `MetonaDesktopAPI`
  - 移除 `types.d.ts` 中废弃的 `DesktopBridge` 类型和 `__metonaBridge` 全局声明
  - `fs.writeFile` 新增 `encoding` 参数支持（UTF-8 / base64）
  - 会话导出（.metona 加密备份）改用 base64 编码写入二进制文件
- 🔧 **编译修复**
  - 修复 `vector-store.ts` 中 `colId` 变量重复声明导致编译失败
  - 修复 `importSessions` 中 `result` 变量重复声明导致编译失败
  - 修复 token 统计在 `eval_count=0` 时仍显示的显示问题
- 📦 **构建工具**
  - 新增 `build-release.sh` — 一键构建脚本（自动安装 Wine + npm 依赖 + electron-builder）
  - 新增 `restore-build-cache.sh` — 构建资源本地缓存恢复（Electron 二进制等 145MB 资源）
  - 更新 `docs/BUILD.md` — 新增快速构建 3 步指南、构建资源管理说明
  - `.gitignore` 排除 build-resources 目录（本地缓存不进仓库）
- 📦 **构建优化**
  - 移除便携版构建目标，后续仅提供 NSIS 安装包
  - 清理 `package.json` 中 portable 相关配置
  - 更新 `docs/BUILD.md` 构建指南

### Desktop v3.0.0 — Tool Calling & Agent 记忆

#### v3.0.0-patch2 — 稳定性修复
- 🔧 **Tool Calling IPC 卡死修复**
  - `executeTool()` 新增 25 秒 IPC 硬超时，防止主进程无响应时无限挂起
  - `agent-engine.ts` 内 `.catch` 捕获异常，防止 reject 逃逸
  - 主进程 `tool:execute` 外层 try-catch，确保始终返回响应
  - 全链路 console.log 便于 DevTools 排查
- 🔧 **Electron contextIsolation 兼容**
  - 新增 `prompt-modal.ts` 自定义弹窗组件（替代原生 `window.prompt()` / `window.confirm()`）
  - 替换 memory-panel / kb-modal / settings-modal / history-modal 中全部 7 处原生调用
- 🔧 **日志面板改造**
  - 默认常驻显示，移除关闭/清空/切换按钮
  - 新增 earlyBuffer 缓冲机制，initLogPanel 前的日志不再丢失
  - initLogPanel() 移至 init() 最先执行
  - 确认为纯运行时日志，不持久化
- 🔧 **启动稳定性**
  - init() 中防御性重置 IS_STREAMING / IS_HISTORY_VIEW / toolCallingEnabled 等状态
  - catch 路径也重置关键状态并初始化日志面板
- 🔧 **新建会话修复** — 新建会话时强制中断正在进行的生成，恢复发送按钮
- 📝 对齐 Ollama 官方 Tool Calling JavaScript 文档

#### v3.0.0 — Tool Calling & Agent 记忆
- 🔧 **Tool Calling — AI 本地文件操作系统**
  - 7 个工具：`read_file` / `write_file` / `list_directory` / `search_files` / `create_directory` / `delete_file` / `run_command`
  - Agent Loop 引擎：流式多轮工具调用循环，支持并行调用（最大 10 轮）
  - 安全模型：路径白名单/黑名单、命令过滤、用户确认对话框
  - 工具调用可视化卡片（5 种状态：pending → running → success/error/denied）
- 🧠 **Agent 记忆系统**
  - 自动从对话中提取关键信息（事实/偏好/规则/事件）
  - 关键词 + 标签 + 重要性加权检索，自动注入上下文
  - IndexedDB 持久化，跨会话积累
  - 可视化记忆管理面板（搜索/筛选/编辑/删除）
  - 对话 ≥6 条消息后自动触发记忆提取
- ⚡ **全功能协调运作** — 记忆检索 → RAG 检索 → Tool Calling 三层协作
- 🔧 Agent 预设系统移除，由记忆系统替代
- 📝 Tool Calling 技术开发文档（75KB）
- 📝 Wine 安装步骤和构建日志

### Desktop v2.0.0 — TypeScript 重写
- ⚡ **TypeScript + Vite + Electron 全面重构**
- 🏗️ 构建系统完善，模块化拆分
- 🖥️ 纯桌面版，专注 Electron 体验
- 📝 Windows 安装包构建指南

### Desktop v1.1.0 — UI 重塑
- 🎨 **Windows 11 Fluent Design 暗色主题** — Mica 毛玻璃材质
- 📐 知识库/历史弹框优化
- ✨ Think 按钮光效增强
- 🔧 修复知识库/历史弹框宽度、图片按钮禁用标识、Think hover 光效
- 📝 Windows 安装包构建指南，记录踩坑经验

### Desktop v1.0.0 — 桌面客户端诞生
- 🖥️ **Electron Windows 桌面客户端首版**
- 📦 NSIS 安装包 + 绿色便携版
- 🔧 隐藏窗口菜单栏

---

