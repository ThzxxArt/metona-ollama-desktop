# 📋 更新日志

## 分支结构

**桌面版主线**（`master`）：
- `metona-ollama-desktop-v3.2.6` → `metona-ollama-desktop-v3.3.4` → `metona-ollama-desktop-v4.0.0` → `metona-ollama-desktop-v5.0.0` → `metona-ollama-desktop-v5.0.1`（当前发布分支）

**Web 版历史**已独立为 [metona-ollama-web](https://gitee.com/thzxx/metona-ollama-web) 仓库（v1.1.0 ~ v4.0.3）。

---

## 桌面版（Desktop）

### Desktop v5.0.1 — 搜索引擎优化 & Agent 去重修复

- 🔧 **修复 DuckDuckGo 搜索超时过长**
  - 超时从 15 秒降至 8 秒（国内环境 DuckDuckGo 通常不可达，减少等待）
  - 添加 Google 作为第三搜索引擎兜底（DuckDuckGo → Bing → Google）
  - 新增 `parseGoogleResults()` 解析函数
  - 搜索 User-Agent 统一更新为 Chrome 131
- 🔧 **修复 web_fetch 无法抓取部分网站**
  - User-Agent 从 `MetonaOllama/1.0` 改为 Chrome 131 UA（部分网站屏蔽非浏览器 UA）
  - 超时从 15 秒增加至 30 秒（大页面加载更慢）
  - 新增 `Accept` 和 `Accept-Language` 请求头
- 🔧 **修复 Agent Loop 跨轮去重误杀失败工具的重试**
  - 原逻辑：连续两轮工具调用（工具名+参数）完全相同即终止
  - 问题：上一轮 `web_fetch` 超时失败，下一轮同样调用是合理重试，却被当作重复终止
  - 修复：仅对成功的工具调用做去重，失败的允许重试
  - 新增 `prevLoopSuccessKeys` 替代 `prevLoopToolKeys`
- 🔧 **优化 TOOL_USAGE_GUIDE（新增 3 条规则）**
  - 新增规则 2：web_fetch 失败时直接用 web_search 摘要回答，不要反复重试同一 URL
  - 新增规则 3：禁止抓取 SPA 页面（GitHub releases、npm 等），直接从搜索结果提取信息
  - 新增规则 4：搜索查询要进化，不要重复相同的查询
- 🔧 **更新 AGENT_SYSTEM_PROMPT**
  - 工具数量描述从 25 → 34
  - 核心规则新增：web_search 结果中的 snippet 已包含关键信息，不要忽视
  - 核心规则细化：同一 URL 连续失败 2 次后不要再尝试
  - 多工具协同示例新增：web_fetch 失败时直接用搜索结果回答
- 📝 **版本号更新至 5.0.1**（7 个文件同步更新）

### Desktop v5.0.0 — 浏览器控制 & MCP & 技能系统 & 全面重构

- ✨ **MCP (Model Context Protocol) 完整实现**
  - 主进程 `mcp-manager.ts`：JSON-RPC 2.0 over stdio 通信
  - 支持 `initialize` 握手、`tools/list` 工具发现、`tools/call` 工具执行
  - 7 个 IPC 通道：startServer / stopServer / stopAll / callTool / getTools / getStatuses / refreshTools
  - 渲染端 `mcp-client.ts`：配置管理 + 服务器生命周期 + 工具定义获取 + 工具执行
  - `tool-registry.ts` MCP 工具路由：`mcp_{server}_{tool}` 前缀识别
  - 设置面板 MCP 服务器管理 UI（添加/启用/禁用/删除/状态显示）
  - 启动时自动启动已启用的 MCP 服务器，退出时优雅清理
- ✨ **浏览器控制工具**（8 个新工具）
  - `browser_open` / `browser_screenshot` / `browser_evaluate` / `browser_extract`
  - `browser_click` / `browser_type` / `browser_scroll` / `browser_close`
  - AI 可交互式操作网页，支持截图、JS 执行、元素操作
  - 主进程 `browser.ts`，隐藏 BrowserWindow 实现
  - 全部 8 个函数新增 sendLog 执行日志
- ✨ **Cron 定时任务系统**
  - `cron-manager.ts` 定时任务管理器
  - 支持一次性/周期性任务调度
- ✨ **技能自动生成系统**
  - 自动从成功工具调用链提取可复用技能
  - `skills` 表持久化，支持关键词搜索和使用统计
  - 下次同类任务自动匹配并注入技能上下文
- ✨ **用户画像自动推断**
  - 从对话中自动检测用户技术栈（Python/TypeScript/Go/React 等 14 种）
  - 用户画像注入 system prompt，Agent 行为更贴合用户习惯
- ✨ **人格模式**
  - 多种预设人格模板，独立 system prompt + 温度设置
- ✨ **Heartbeat 主动检查**
  - 后台定时检查 Ollama 连接状态、磁盘空间等
- ✨ **子代理委派**
  - `spawn_task` 工具，主 Agent 可 spawn 独立子代理执行任务
  - 独立上下文，超时保护，结果回传主 Agent
- 🔧 **工具并行执行优化**
  - 同一批次内独立工具并行执行，跨批次串行
  - 依赖检测：web_fetch 自动等待 web_search 结果
- 🔧 **长对话上下文管理**
  - `context-manager.ts` 接入 Agent Loop
  - 滑动窗口（20 条）+ 摘要压缩 + 按 num_ctx 裁剪
  - Token 估算（中文 1.5 字/token，英文 4 字符/token）
- 🔧 **记忆系统增强**
  - rule/preference 类型始终注入，不依赖关键词匹配
  - buildMemoryContext 区分三类记忆措辞
- 🔧 **全面编译修复**
  - 修复 `useTools` 变量在声明前使用（TDZ 运行时 ReferenceError）
  - 修复 `browser.ts` loadURL 不支持的 timeout 参数
  - 修复 `ipc.ts` browserScroll direction 类型断言
- 🔧 **CSS 变量补全**
  - 补充 `--primary` / `--primary-bg` / `--bg-hover` 三个缺失变量
- 🧹 **全面代码清理**（删除 400+ 行死代码）
  - 删除 `training-export.ts`（训练数据导出，零引用）
  - 删除 `document-processor.ts`（RAG 遗留）
  - 清理 workspace.ts：`execWorkspaceCommand`（重复实现）、`isProcessAlive`、`getActiveProcessCount`、`terminateWorkspaceCommand`
  - 清理 sqlite.ts：`deleteMessagesBySession`、`getSkill`、`closeDatabase`
  - 清理 skill-manager.ts：`getAllSkillsForUI`、`deleteSkillById`、`clearAllSkills`
  - 清理 memory-manager.ts：`getVectorSearchResults`
  - 清理 tool-registry.ts：`isToolEnabled`
  - 清理 cron-manager.ts：`clearAllTimers`
  - 清理 workspace-panel.ts：`setOnToolTerminated`、`setWorkspaceDirPath`
  - 清理 mcp-manager.ts：`isServerRunning`
  - 移除 index.html 训练数据导出按钮及 settings-modal.ts 事件绑定
- 📊 **全链路执行日志**
  - browser.ts：全部 8 个函数新增 sendLog（打开/截图/JS/提取/点击/输入/滚动/关闭）
  - mcp-manager.ts：callTool 新增工具调用/完成/失败日志
  - 主进程日志覆盖：browser(20) + mcp(14) + tool-handlers(21) + workspace(11) + ipc(11)
- 📝 **版本号更新至 5.0.0**（7 个文件同步更新）

### Desktop v4.0.0 — SQLite & ReAct Agent & 全新主题

- 📦 **数据库迁移：IndexedDB → SQLite (sql.js WASM)**
  - 新增 `src/main/db/sqlite.ts`，使用 sql.js (WASM) 替代 IndexedDB
  - 零原生依赖，无需 electron-rebuild，消除 ABI 版本不匹配问题
  - 6 张表：sessions、messages、tool_calls、memories（FTS5 全文搜索）、settings、traces
  - WAL 模式 + NORMAL 同步，性能显著提升
  - 支持全量导出/导入（JSON 格式）
- 🔧 **Agent Loop 升级为 ReAct 模式**
  - Thought → Action → Observation → Reflection 循环
  - 任务复杂度评估（简单/中等/复杂）
  - 执行轨迹记录（traces 表），Agent 可观测性
  - 最大 15 轮循环，10 分钟总超时保护
- 🧠 **记忆/会话管理工具**
  - 新增 `memory_search`、`memory_add` 工具（AI 可主动管理记忆）
  - 新增 `session_list`、`session_read` 工具（AI 可查阅历史会话）
  - 记忆支持 FTS5 全文搜索 + 向量语义搜索
  - 上下文管理服务（`context-manager.ts`）
- 🎨 **UI 主题改版：暗色 → 暖色调亮色**
  - 奶白背景 `#FAF7F2` + 珊瑚橙主色 `#E8734A`
  - 圆润柔和设计：圆角 8-20px，柔和阴影
  - 紫色辅助色（Think/推理），金色标签（Token 统计）
  - 终端区域保留暖棕深色 `#2D2016` 保证代码可读性
  - 字体升级：Inter + JetBrains Mono
  - 窗口背景色、导出 HTML、theme-color 同步更新
- 🖥️ **工作空间改进**
  - IPC 通信优化，workspace 命令通过独立进程管理
  - AI 工具命令实时输出推送到工作空间终端
- 📝 **版本号更新至 4.0.0**

### Desktop v3.3.4 — Agent Loop 去重 & 记忆系统修复

- 🔧 **修复 Agent Loop 工具调用重复问题**
  - 新增工具调用缓存机制（`toolResultCache`），相同工具+参数不再重复执行
  - 新增同轮内重复检测：同一轮 tool_calls 中的重复调用自动跳过
  - 新增跨轮次重复检测：连续两轮工具调用完全相同则自动终止循环
  - TOOLS_USAGE_GUIDE 新增第 8 条"严禁重复调用"规则
- 🔧 **修复 web_fetch 内容截断**
  - 默认 `max_chars` 从 10000 改为 0（不截断，返回完整内容）
  - 仅当用户显式指定 `max_chars` 时才截断
- 🔧 **修复记忆系统 rule/preference 不生效**
  - `searchMemoriesByKeyword`：rule 和 preference 类型记忆始终注入，不再依赖关键词匹配
  - 仅 fact 类型保留关键词检索逻辑
  - `buildMemoryContext` 区分三类记忆的 system prompt 措辞：规则→"必须无条件执行"、偏好→"请遵循"、事实→"供参考"
- 🔧 **移除重复日志** — tool-registry.ts executeTool 中重复的 logToolStart 调用已移除

### Desktop v3.3.3 — 工具面板修复 & 搜索增强

- 🔧 **修复工具面板 badge 显示错误**
  - 除 run_command 外所有工具的 badge 从"需确认"改为"自动"（与代码实际行为一致）
  - 根因：CONFIRM_TOOLS 数组仅包含 run_command，但 HTML 硬编码了 10 个工具为 confirm
- 🔧 **修复 run_command 下拉框样式**
  - 未选中项白字白底不可见，根因：内联样式引用了未定义的 CSS 变量 --bg-tertiary
  - 改用 --bg-card 并为 option 元素添加显式暗色背景
- 🎨 **面板宽度优化**
  - 工具面板：720px → 900px
  - 历史记录：680px → 800px
  - 设置面板：480px → 640px
  - 帮助面板：600px → 760px
- ✨ **增强联网搜索与网页抓取联动**
  - TOOL_USAGE_GUIDE 新增第 6 条：要求 AI 在 web_search 后必须用 web_fetch 抓取详情
  - 新增第 7 条：明确 AI 在不确定、信息过时、需实时数据时应主动调用工具
  - 典型场景→工具映射：查版本→web_search+web_fetch、查文件→read_file、查项目→git status
- ✨ **web_search 默认结果数提升**：5 → 15，给 AI 更多线索定位目标页面

### Desktop v3.3.2 — 联网搜索 & 工具权限优化

- ✨ **新增 web_search 联网搜索工具**（第 21 个工具）
  - DuckDuckGo HTML 搜索优先，Bing 作为备用引擎
  - 返回结构化结果：标题、URL、摘要
  - 15 秒超时保护，最多 10 条结果
  - 自动启用，无需用户确认（只读操作）
- 🔧 **工具执行权限优化**
  - 除 run_command 外，所有 20 个工具改为自动执行无需确认
  - run_command 新增三模式下拉框：自动/需确认/禁用
  - 工具面板卡片 badge 实时联动模式状态

### Desktop v3.3.1 — Bug 修复 & 图标统一

- 🔧 **修复开启工具调用后图片无法传给 AI**
  - `agent-engine.ts`：当用户仅上传图片无文字时，自动生成分析提示作为 content，确保图片数组正确注入 Ollama API
  - `input-area.ts`：图片与文字合并为同一条消息，不再拆分为两条，修复 Agent Loop 构建历史时图片关联丢失
- 🔧 **修复记忆系统弹框自动记忆开关点击无响应**
  - `memory-modal.ts`：CSS 类名 `memory-toggle` → `toggle-label`，启用完整滑块样式和 `:checked` 状态切换
- 🎨 **统一应用图标为科技感羊驼**
  - `assets/icons/llama.png` / `llama.ico`：替换为霓虹电路风格羊驼图标（深色背景 + 青色描边 + 电路纹理）

### Desktop v3.3.0 — 文档同步 & 帮助面板修正

- 📝 **文档全面更新**
  - README.md：Tool Calling 工具表从 7 个扩展至 20 个，新增 13 个工具说明
  - README.md：移除已废弃的 RAG 知识库 section，更新为向量记忆说明
  - README.md：项目结构同步实际文件（移除已删除的 rag.ts / kb-modal.ts / memory-panel.ts，新增 memory-modal.ts / tools-modal.ts / prompt-modal.ts / vector-memory.ts）
  - README.md：架构图更新，移除 RAG 引用
  - README.md：记忆提取触发条件从 ≥3 条修正为 ≥6 条
  - README.md：记忆类型表移除「事件」类型（v3.0 后已归并为 fact）
  - README.md：技术栈从「NSIS + Portable」修正为「NSIS 安装包」
  - docs/DEVELOPMENT.md：子系统引用从 rag.ts 更新为 vector-memory.ts
  - docs/DEVELOPMENT.md：移除工作空间面板拖拽调整宽度的描述
- 🔧 **帮助面板修正**
  - 工作空间终端描述从「多终端 Tab」改为「单一终端进程」
  - 移除工作空间面板拖拽调整宽度的描述（当前固定 480px）

### Desktop v3.2.6 — 工作空间面板布局修复 & Token 统计样式优化

- 🔧 **修复工作空间面板与主内容区错位**
  - workspace-panel 从 `position: fixed` 改为 flex 子元素，与日志面板布局模式一致
  - 移除 `margin-right: 480px` hack 和 `--nav-height` CSS 变量，消除 JS/CSS 失步风险
  - 移除 `updateNavHeight()` 函数及 resize 监听，减少不必要的 DOM 计算
- 🎨 **Token 统计颜色优化**
  - Header token 统计区：琥珀色 (#FFD580) 图标 + 数值，含淡色背景和细边框
  - 消息内 token 数：琥珀色高亮，耗时用主题蓝色，三种信息一目了然

### Desktop v3.2.5 — 工具路径修复 & 安全性增强 & 工作空间重构

- 🔧 **修复工具相对路径解析错误**
  - 所有文件系统工具（`read_file` / `write_file` / `list_directory` / `search_files` / `create_directory` / `delete_file`）的相对路径此前用 `path.resolve()` 解析到进程当前工作目录，导致 AI 创建的文件实际写到了错误位置
  - 新增 `resolvePath()` 辅助函数：相对路径统一基于 `getWorkspaceDir()`（工作空间目录）解析，绝对路径保持不变
- ♻️ **工作空间改为单一终端**
  - 移除多 Tab 机制，工作空间面板简化为单个终端 + 文件浏览器
  - 移除标签页栏、新建 Tab 按钮、Tab 切换逻辑
  - 终端面板直接渲染 `#ws-terminal`，进程管理改用 `currentTermId` 单例模式
  - 文件浏览器宽度固定 200px，终端区域自适应填充剩余空间
- 🔧 **修复 token 统计图标显示问题**
  - Header 中 token 消耗图标从 Unicode 字符（🪙）改为纯 path SVG 内联
  - 避免 text 元素在部分系统（如旧版 Windows）不显示的问题
- 🔧 **修复图片/文件读取 Latin1 错误**
  - `atob()` 解码 Base64 时产生 Latin1 编码，导致中文文件名和中文内容乱码
  - 图片上传改用 `readFileBase64` IPC 读取，渲染端用 `Uint8Array` + `TextDecoder` 替代 `atob()`
  - 文件读取同样改用 base64 通道，避免 Latin1 编码丢失
- 🔧 **修复工作空间面板定位**
  - 面板顶部对齐修正（从 90px 调整为 92px，匹配 header 高度）
  - 修复中文乱码：Windows cmd 代码页切换 `chcp 65001` + 环境变量 `LANG/LC_ALL` 设为 UTF-8
  - 修复快捷键冲突和帮助文档内容更新
- 📦 **构建产物**
  - `Metona Ollama Setup 3.2.5.exe`（78MB）
  - Gitee Release v3.2.5-desktop（ID: 601311）

### Desktop v3.2.4 — AI 命令执行走工作空间终端 & Bug 修复

- 🔧 **AI 命令执行走工作空间终端**
  - `run_command` 工具不再在主进程内部执行，改为通过工作空间终端实时执行并显示
  - stdout/stderr 实时推送到工作空间终端面板，流式展示
  - 用户可通过停止按钮终止卡住的命令，结果自动回传 AI
  - 新增 `cmd:output` / `cmd:done` / `cmd:kill` IPC 通道
- 🖥️ **工作空间面板优化**
  - 去掉用户手动命令输入，所有命令由 AI 执行
  - 终端底部状态提示（等待/执行中）
  - 修复面板顶部对齐（90px → 92px）
- 🔧 **设置面板修复**
  - 修改 Ollama 服务地址后同步更新顶部导航连接状态和模型列表
- 📦 **构建产物**
  - `Metona Ollama Setup 3.2.4.exe`
  - Gitee Release v3.2.4-desktop

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
  - 对话 ≥3 条消息后自动触发记忆提取
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

