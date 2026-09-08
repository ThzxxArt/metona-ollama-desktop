# Metona Ollama Desktop — 开发规范

> 更新: 2026-08-23 | 维护: 项目团队

---

## 一、项目概述

Metona Ollama Desktop 是基于 TypeScript + Electron 的 Windows 本地 AI 桌面客户端，通过 Ollama API 连接本地大模型。所有 AI 推理在本地完成，数据不离开本机。

核心架构：
- **ReAct Agent Loop** — 8 状态机驱动的智能体循环（INIT→THINKING→PARSING→EXECUTING→OBSERVING→REFLECTING→COMPRESSING→TERMINATED），最大 85 轮（可配置）
- **33 个内置工具** — 文件系统（14，含 diff）、命令执行（1）、联网搜索（2）、浏览器控制（9）、Git（1）、记忆（1）、会话/子代理（3）、系统（1）、Plan Mode（1）
- **Harness Engineering** — 提示词加固 + 4 阶段 Hook 系统 + Agent Metrics
- **MCP 协议扩展** — JSON-RPC 2.0 over stdio，动态工具发现（tools/list 分页）
- **Plan Mode** — 开关切换，先规划后执行，步骤级进度追踪
- **SQLite 存储** — sql.js WASM 内存库，6 张表，防抖批量落盘 + `PRAGMA user_version` 迁移

---

## 二、技术栈规范

| 层级 | 技术 | 版本约束 |
|------|------|----------|
| 语言 | TypeScript | ≥5.7，严格模式 (`strict: true`) |
| 桌面框架 | Electron | ≥33 |
| 构建工具 | Vite (渲染进程) + tsc (主进程) | Vite ≥5 |
| 数据存储 | sql.js (WASM) | ≥1.11，零原生编译依赖 |
| 视频处理 | ffmpeg-static | ≥5.2，asrUnpack 外置 |
| 打包 | electron-builder | NSIS 格式 |

---

## 三、目录结构

```
src/
├── main/                              # Electron 主进程
│   ├── main.ts                        # 入口、窗口管理、CORS 允许清单、托盘、生命周期
│   ├── preload.ts                     # contextBridge API 暴露（白名单）
│   ├── ipc.ts                         # IPC 总线（工具调用、数据库、MCP、视频帧）
│   ├── workspace.ts                   # 终端子进程管理、流式输出
│   ├── browser.ts                     # 隐藏 BrowserWindow 实现浏览器控制（memory: 分区）
│   ├── net-guard.ts                   # SSRF 防护（环回/内网/链路本地地址拦截）
│   ├── calculator.ts                  # calculator 工具纯函数实现（递归下降解析）
│   ├── myers-diff.ts                  # 行级 diff 纯函数（前缀/后缀裁剪 + LCS 限额 + 回退）
│   ├── tool-dispatch.ts               # 主进程工具执行器注册表（消除 switch 硬编码）
│   ├── menu.ts                        # 原生菜单
│   ├── tray.ts                        # 系统托盘
│   ├── utils.ts                       # 通用工具函数（日志、通知）
│   ├── mcp-manager.ts                 # MCP JSON-RPC 2.0 协议管理（tools/list 分页）
│   ├── tool-security.ts               # 路径/命令安全检查（黑名单 + 系统目录硬红线 + 身份文件保护）
│   ├── tool-handlers.ts               # 工具处理器 re-export 聚合
│   ├── tool-handlers-fs.ts            # 14 个文件系统工具实现
│   ├── tool-handlers-system.ts        # 系统/网络工具 + 联网搜索（双模式）+ 自动抓取
│   ├── tool-handlers-git.ts           # Git 全操作（参数注入防护）
│   ├── tool-handlers-shared.ts        # 共享类型和辅助函数
│   └── db/
│       ├── sqlite.ts                  # SQLite 数据库层（6 张表，防抖落盘 + user_version 迁移）
│       └── sql.js.d.ts                # sql.js 类型声明
│
├── renderer/                          # 渲染进程
│   ├── main.ts                        # 应用入口、72 步初始化、桌面集成
│   ├── types.d.ts                     # 完整类型定义（消息、会话、Agent 状态机等）
│   ├── index.html                     # 入口 HTML（三栏布局 + 全部模态框）
│   ├── public/
│   │   ├── AGENT.md                   # 内置 Agent 行为准则（工作空间同名文件可覆盖）
│   │   └── SOUL.md                    # AI 人格定义（内置 fallback）
│   ├── api/
│   │   └── ollama.ts                  # Ollama REST API 客户端（流式 + 模型管理）
│   ├── components/                    # 18 个 UI 组件（原生 DOM）
│   │   ├── chat-area.ts              # 聊天消息区域（渲染、自动滚动）
│   │   ├── header.ts                 # 顶部导航栏 + 连接状态
│   │   ├── history-modal.ts          # 会话历史（摘要查询、SQL 搜索、分页、恢复）
│   │   ├── input-area.ts             # 输入框 + 图片/视频/文件上传 + Plan Mode 开关
│   │   ├── keybind-manager.ts        # 全局快捷键唯一注册点
│   │   ├── lightbox.ts               # 图片灯箱
│   │   ├── memory-modal.ts           # Agent 记忆管理面板（按 ID 删除）
│   │   ├── metrics-dashboard.ts      # Agent Metrics 仪表盘（JSON/Prometheus 导出）
│   │   ├── model-bar.ts              # 模型选择栏 + 能力徽章
│   │   ├── prompt-modal.ts           # 系统提示词查看 + Plan 确认弹窗
│   │   ├── searxng-modal.ts          # SearXNG 搜索引擎配置面板（批量保存）
│   │   ├── settings-modal.ts         # 设置面板（全部配置项 + 子代理权限上限）
│   │   ├── toast.ts                  # Toast 通知（textContent 渲染防 XSS）
│   │   ├── token-dashboard.ts        # Token 消耗仪表盘（全局 + 会话统计）
│   │   ├── tool-confirm-modal.ts     # 工具执行确认对话框（主/子代理共用）
│   │   ├── tools-modal.ts            # 工具列表面板（33 个工具卡片）
│   │   └── workspace-panel.ts        # 工作空间面板（终端 + 工具卡片 + 文件浏览）
│   ├── services/                      # 14 个服务模块（含 history-builder 历史消息构建）
│   │   ├── agent-engine.ts           # ★ ReAct Agent Loop 核心引擎（8 状态机）
│   │   ├── tool-registry.ts          # 工具注册与调度中心（33 内置 + MCP 动态 + Plan Mode）
│   │   ├── result-formatter.ts       # 工具结果 → 模型友好格式（纯函数，自 agent-engine 拆分）
│   │   ├── tool-parsing.ts           # 文本工具调用兜底解析（纯函数，自 agent-engine 拆分）
│   │   ├── memory-service.ts         # 记忆管理（条目缓存 + 访问统计持久化 + TTL 衰减）
│   │   ├── context-manager.ts        # 上下文窗口管理（滑动窗口 + Token 校准 + LLM 压缩）
│   │   ├── sub-agent.ts              # 子代理委派（权限只降不升 + 确认管线 + 完整路径沙箱）
│   │   ├── mcp-client.ts             # MCP 渲染端客户端
│   │   ├── log-service.ts            # 结构化日志（9 级分类）
│   │   ├── crypto.ts                 # AES-256-GCM 备份编码
│   │   ├── hooks.ts                  # 4 阶段 Hook 系统（SecurityCheck + FileWriteDedup）
│   │   ├── agent-metrics.ts          # Agent 度量采集 + 错误模式识别 + JSON/Prometheus 导出
│   │   ├── agent-safety.ts           # Agent 安全防护（错误分类 + 路径沙箱 + 恢复建议）
│   │   └── infra-service.ts          # 基础设施（全局错误处理，唯一定义）
│   ├── db/
│   │   └── chat-db.ts                # 渲染端数据库接口（摘要/搜索/批量写）+ IndexedDB→SQLite 迁移
│   ├── state/
│   │   └── state.ts                  # 响应式状态管理（单例模式）
│   ├── utils/
│   │   ├── utils.ts                  # 通用工具函数
│   │   ├── sanitizer.ts              # HTML 净化器（白名单 + URI 协议检查）
│   │   └── marked-config.ts          # Markdown 渲染配置
│   └── styles/
│       ├── style.css                 # 暖色调亮色主题（完整样式表）
│       └── dark-theme.css            # 暗色主题
│
├── vendor/                            # 第三方库本地化（ESM + 类型声明）
│   ├── marked.d.ts                   # Markdown 解析库类型
│   └── dompurify.d.ts               # HTML 净化库类型
│
├── assets/                            # 静态资源
│   └── icons/                        # 应用图标
│
└── docs/                              # 项目文档
    ├── DEVELOPMENT.md                 # 本文档
    ├── Agentic-Loop详解.md            # Agentic Loop 概念与分层体系参考
    └── ollama-api-docs-20260518.html  # Ollama API 参考（离线快照）
```

---

## 四、代码规范

### 4.1 命名约定

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件名 | `kebab-case` | `tool-registry.ts`, `agent-engine.ts` |
| 类型/接口 | `PascalCase` | `ToolCallRecord`, `LoopContext` |
| 变量/函数 | `camelCase` | `getEnabledToolDefinitions` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_LOOPS`, `AUTO_COMPRESS_THRESHOLD` |
| 私有成员/模块变量 | `_` 前缀 | `_workspaceDir`, `_planTracker` |

### 4.2 日志规范

**核心原则：项目中严禁使用 `console.log/error/warn/debug`。所有日志必须通过 `log-service.ts` 输出。**

```typescript
import { logInfo, logSuccess, logWarn, logError, logDebug } from './services/log-service.js';

logInfo('操作描述', '可选详情');
logSuccess('成功描述', '可选详情');
logWarn('警告描述', '可选详情');
logError('错误描述', '错误详情');
logDebug('调试信息', '可选详情');
```

主进程日志通过 `mainWindow?.webContents.send('main:log', { level, message, detail })` 推送到渲染进程日志面板。

### 4.3 IPC 规范

| 模式 | 用途 | 示例 |
|------|------|------|
| `invoke/handle` | 请求-响应，需返回值 | 工具调用、数据库操作、设置读写 |
| `on/send` | 单向推送，流式通信 | 终端实时输出、视频帧提取进度 |

选择原则：需要返回值 → `invoke/handle`；流式输出/实时推送 → `on/send`。

### 4.4 版本号规范

**版本号仅允许出现在以下 5 个文件中，其余所有源码禁止出现版本号：**

| 文件 | 内容 |
|------|------|
| `package.json` | `"version": "X.Y.Z"` |
| `package-lock.json` | 顶层 version 字段（2 处） |
| `src/renderer/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `src/main/menu.ts` | 关于对话框 `Metona Ollama Desktop vX.Y.Z` |
| `README.md` | 版本徽章、中英文下载文件名 |

代码注释中禁止出现版本号（如 `// vX.Y.Z: xxx`），只描述功能本身。

---

## 五、架构规范

### 5.1 五大子系统

```
① Agent 系统    → agent-engine.ts + tool-registry.ts（33 内置工具 + MCP 动态）+ result-formatter/tool-parsing
② 记忆系统      → memory-service.ts（MEMORY.md 文件存储 + 条目缓存 + 访问统计持久化 + 自动提取）
③ 上下文系统    → context-manager.ts（滑动窗口 + Token 校准 + LLM 压缩）
④ 工作空间      → workspace.ts (主进程) + workspace-panel.ts (渲染进程)
⑤ 数据层       → db/sqlite.ts（SQLite, 6 张表）+ chat-db.ts（渲染端接口）
```

### 5.2 ReAct Agent Loop（8 状态机）

```
INIT → THINKING → PARSING → EXECUTING → OBSERVING → REFLECTING → (COMPRESSING) → TERMINATED
```

| 状态 | 处理器 | 职责 |
|------|--------|------|
| INIT | `handleInit()` | 构建系统提示词、加载 SOUL/AGENT/USER.md（USER.md 仅工作空间）、记忆检索、上下文压缩检测 |
| THINKING | `handleThinking()` | 调用 Ollama 流式 API、工具缓存检查、任务感知注入、Token 预算警告 |
| PARSING | `handleParsing()` | 解析模型输出、提取 tool_calls、文本兜底解析 |
| EXECUTING | `handleExecuting()` | 按批次并行执行工具、重试（最多 2 次）、去重检测、Hook 触发 |
| OBSERVING | `handleObserving()` | 收集结果、裁剪旧消息、增量记忆提取、进度锚定、中途幻觉检测 |
| REFLECTING | `handleReflecting()` | Plan Mode 确认、空响应处理、Completion Gate、记忆最终提取 |
| COMPRESSING | `handleCompressing()` | LLM JSON 结构化压缩、滑动窗口 |
| TERMINATED | — | 循环终止、清理状态 |

关键参数：
- 最大轮次：85（默认，设置面板可调）
- 自动重试：2 次（MAX_RETRIES）
- 看门狗超时：30 分钟（默认，可配；引擎与设置面板默认值一致）
- 上下文硬上限：300 条消息
- 流式超时：可配（默认 300s，0=禁用）
- HTTP 超时：可配（默认 900s）
- MCP 超时：可配（默认 60s）

### 5.3 SQLite 数据库

6 张表，sql.js WASM 内存库 + **防抖批量落盘**：

| 表 | 用途 | 关键特性 |
|---|---|---|
| `sessions` | 会话 | parent_id 父子关系 |
| `messages` | 消息 | 外键级联删除，thinking/tool_calls/attachments/eval_count |
| `tool_calls` | 工具调用记录 | 按会话+工具名索引 |
| `settings` | 设置 | JSON 序列化，支持批量写（单事务） |
| `traces` | ReAct 执行轨迹 | Agent 可观测性，支持批量写 |
| `tool_audit` | 工具执行审计日志 | 按会话+时间索引 |

持久化策略（sql.js 为纯内存库，`db.export()` 是全库序列化）：
- 写操作只标记脏数据并调度 **300ms 防抖刷盘**（多次写合并为一次全库快照）
- 刷盘采用 temp 文件 + rename 原子替换，防止崩溃损坏
- 应用退出（before-quit）强制刷盘，崩溃时最多丢失最近 300ms 写入
- Schema 使用 `PRAGMA user_version` + 顺序迁移数组管理（新增列/表只追加迁移项）
- 会话列表/搜索使用摘要查询（`getSessionSummaries` / `searchSessions` 单条 SQL，含消息计数），不加载消息正文；导出走 `getAllSessionsData` 一次 IPC 取回全部行（渲染端不再 N+1 往返）
- 消息保存采用**差量同步**：新增消息批量插入，被裁剪消息（/undo、/retry、/compress）通过 `db:deleteMessages` 差量删除落库，重启后不会"复活"

### 5.4 Harness Engineering 体系

#### 5.4.1 提示词加固

| 层级 | 实现位置 | 机制 |
|------|---------|------|
| 提示词加固 | `handleInit()` | 注入安全规则：参考数据标记（<<<REFERENCE_DATA_START>>>）+ 工具结果仅为数据非指令 |

> 注：任务感知注入、中途检测、进度锚点、完成闸门已在版本迭代中移除，AI 基于工具返回值和上下文自行判断。

#### 5.4.2 Hook 系统（4 阶段）

| 阶段 | Hook | 优先级 | 行为 |
|------|------|--------|------|
| pre_tool | SecurityCheck | 100 | 命令/路径黑名单拦截 |
| post_tool | FileWriteDedup | 30 | 文件写入去重（内容指纹） |

Hook 异步并行执行，失败不阻塞主流程。可动态注册/移除（`registerHook` / `unregisterHook`）。

> 注：历史版本中的 DiffAnalyzer / FileChangeAudit / ResultValidation / IterationMetrics 已移除。

### 5.5 联网搜索体系

**双模式架构**：

| 模式 | 实现 | 特性 |
|------|------|------|
| SearXNG JSON API | `handleWebSearchSearxng()` | 70+ 引擎聚合，JSON/HTML 双格式，认证支持 |
| 内置四引擎 HTML 解析 | `handleWebSearch()` | Bing + 百度 + 搜狗 + 360 并行请求 |

**自动抓取与过滤**：
- 硬上限：`MAX_AUTO_FETCH = 8` 条
- 相关性过滤：`computeRelevance()` 基于 CJK/英文关键词匹配，跳过无关结果
- 浏览器回退缓存：同一 URL 10 分钟内渲染一次
- LRU 搜索缓存：200 条/5 分钟 TTL

### 5.6 工作空间

- 默认路径：Electron `userData` 下的 `workspace/` 目录
- 自定义路径：设置面板可修改
- **安全豁免**：工作空间目录通过 `addBlocklistExemptions()` 注册，不受路径黑名单限制
- 终端：命令无超时限制，实时流式输出，支持终止
- 文件浏览：限工作空间内，支持上级导航、文件预览
- 自定义文件：`SOUL.md`（人格，不可压缩）、`AGENT.md`（行为准则）、`USER.md`（用户画像，仅工作空间）

---

## 六、安全规范

### 6.1 文件系统安全

- 所有文件路径经 `checkPathAllowed()` 验证
- 永久黑名单：33 个系统/敏感目录（Linux + Windows）
- 写入操作额外限制在 `allowedDirs` 白名单内
- 工作空间目录通过 `addBlocklistExemptions()` 机制豁免
- 路径遍历深度检测（`..` 超过 5 层拦截）

### 6.2 命令执行安全

- 所有命令经 `checkCommandAllowed()` 验证
- 命令黑名单：30 条危险命令（POSIX + Windows）
- 反弹 shell 模式检测
- `run_command` 三种执行模式：自动 / 需确认 / 禁用

### 6.3 前端安全

- HTML 净化器：白名单标签 + 属性过滤 + URI 协议检查
- `contextIsolation: true`
- IPC 白名单 + 路径验证

### 6.4 网络安全

- `web_fetch` 流式体积限制 10MB
- 反爬 UA 轮换（5 个）+ 指数退避
- 拦截页检测（Cloudflare / 403 / 验证码）
- 无 content-length 时防 OOM 保护
- **SSRF 防护（net-guard.ts）**：`web_fetch` / `download_file` / `browser_open` 拦截环回/内网/链路本地地址（localhost、127.0.0.1、0.0.0.0、10.x、172.16-31.x、192.168.x、169.254.x、IPv6 ULA/fe80；域名经 DNS 解析后校验真实 IP）
- `browser_open` 协议白名单：仅 http/https（阻止 `file://` 读取本地文件绕过路径安全层）
- 搜索可达性预检只取响应头（`Range: bytes=0-0` + 立即取消 body）

### 6.5 MCP 安全

- Shadowing 防护：MCP 工具不可覆盖内置工具
- 双下划线分隔符防歧义：`mcp_{server}__{tool}`
- tools/list 分页遵循 nextCursor（上限 10 页防异常服务器死循环）

### 6.6 Electron 安全

- `webSecurity: true`（同源策略开启；Ollama API 通过 `webRequest.onHeadersReceived` CORS 允许清单精确放行，设置面板保存地址时动态更新）
- `contextIsolation: true` + `nodeIntegration: false`
- Agent 浏览器使用 `memory:agent` 内存分区（应用退出后 cookie/storage/缓存全部清空）
- 内置资源（SOUL.md / AGENT.md）通过 IPC `app:readResource` 读取（basename 防路径穿越），不做 file:// 直接 fetch

### 6.7 身份文件保护

- `MEMORY.md`：所有工具禁读禁写，仅 memory 专用 IPC 通道访问
- `SOUL.md` / `AGENT.md` / `USER.md`：工具**可读不可写**（防止提示注入诱导 AI 改写自身人格文件实现持久化劫持，只能由用户手动编辑）

### 6.8 子代理安全

- 权限分级（readonly / limited_write / full_write）**只降不升**：AI 通过 spawn_task 请求的权限封顶于用户设置 `subAgentMaxPermission`
- 写类工具与主 Agent 共用确认管线（`confirmHandler` 继承，无确认回调时默认拒绝）
- 路径沙箱覆盖全部文件类工具（read/write/edit/delete/create/list/search/tree/compress/move/copy/download/read_multiple）
- 子代理模型只能由设置面板配置，AI 传入的 model 参数被忽略

### 6.9 参数注入防护

- git 工具：branch / remote / url / remote_url / tag_name / stash_sub 等用户可控参数禁止以 `-` 开头（防 `git clone --upload-pack=恶意命令` 类选项注入）；`git add` 强制 `--` 分隔符
- `edit_file` 替换使用替换函数（`() => new_text`），防止 new_text 中的 `$&` / `$1` 被特殊解释污染文件内容

---

## 七、UI/UX 规范

### 7.1 设计语言

| 属性 | 值 |
|------|----|
| 风格 | 暖色调亮色主题 |
| 背景 | 奶白 `#FAF7F2`，卡片白 `#FFFFFF` |
| 主色调 | 珊瑚橙 `#E8734A` |
| 辅助色 | 紫色 `#9B7ED8`（Think），金色 `#D4A03C`（Token） |
| 终端色 | 暖棕深色 `#2D2016` |
| 字体 | Inter (正文) + JetBrains Mono (代码) |
| 圆角 | 控件 8px，卡片 12px，弹框 16-20px |

### 7.2 Z-Index 层级

| 层级 | 组件 | 值 |
|------|------|----|
| 最高层 | Toast 通知 | 200 |
| 高层 | 模态框 | 100 |
| 中层 | Header | 50 |
| 中层 | Model Bar | 40 |
| 中层 | Input Area | 30 |
| 低层 | 工作空间面板 | 10 |
| 基础 | 日志面板 | 5 |

### 7.3 布局

三栏布局（flex）：
- **左侧**：日志面板（可收起）
- **中间**：聊天区（Header + 模型栏 + 消息 + 输入框）
- **右侧**：工作空间（480px 固定宽度，3 个 Tab：💻终端 / 🔧工具 / 📁文件）

---

## 八、构建与发布

### 8.1 构建命令

```bash
npm run build:renderer  # 仅 Vite 构建渲染进程
npm run build:main      # 仅 tsc 编译主进程
npm run build           # 完整构建
npm start               # 构建并运行（开发调试）
npm run dist            # 构建 Windows 安装包（NSIS）
npm run dev:renderer    # Vite watch 模式
npm run dev:main        # tsc watch 模式
```

### 8.2 发布流程

1. 更新版本号（仅修改 5 个白名单文件）
2. 构建并测试：`npm start`
3. 构建安装包：`npm run dist`
4. 推送到 master + Gitee release

### 8.3 BUILD.md 已移除

构建指南已整合到 README.md。不再需要独立的 BUILD.md 文件。

---

## 九、Git 规范

### 分支模型

- `master` — 主分支（仅有分支，直接推送）

### Commit 规范

```
<type>: <简要描述>

feat:     新功能
fix:      Bug 修复
refactor: 重构
style:    样式调整
docs:     文档更新
chore:    构建/工具变更
perf:     性能优化
```

---

## 十、注意事项

1. **安全优先**：所有文件/命令操作必须经过 `tool-security.ts` 安全检查层
2. **日志完整**：关键操作必须通过 `log-service.ts` 记录到执行日志面板
3. **桌面优先**：API 调用必须检查 `bridge.isDesktop`，非桌面环境优雅降级
4. **上下文管控**：自动抓取最多 8 条网页，防止上下文爆炸；工具结果超 10 轮自动截断
5. **版本号纪律**：仅 5 个白名单文件允许出现版本号，其余源码一律禁止
6. **Vendor 优先**：第三方依赖优先本地化到 `src/vendor/`（sql.js 因含 WASM 二进制除外）
7. **无版本号注释**：代码注释中禁止出现 `v0.x.x: xxx` 格式，直接描述功能
