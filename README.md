<div align="center">

# 🦙 Metona Ollama Desktop

**基于 TypeScript + Electron 的本地 Ollama AI 桌面客户端**

全离线运行 · 数据本地存储 · 第三方库本地化

[![版本](https://img.shields.io/badge/version-5.1.5-brightgreen?style=flat-square)](https://gitee.com/thzxx/metona-ollama-desktop/releases)
[![平台](https://img.shields.io/badge/platform-Windows%20x64-blue?style=flat-square)](https://gitee.com/thzxx/metona-ollama-desktop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646cff?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

---

## ✨ 功能特性

### 💬 智能对话

| 功能 | 说明 |
|------|------|
| 🔄 流式响应 | ReadableStream 实时打字效果，支持强制停止 |
| 🧠 Think 推理 | 展开/收起深度思考过程（需模型支持） |
| 🖼️ 多模态 | 图片上传，自动检测 Vision 模型能力 |
| 📄 文件分析 | 50+ 种文本/代码格式，单文件 ≤500KB |
| 🔀 多模型 | 自动加载 Ollama 已安装模型，一键切换 |

---

### 🔧 Tool Calling — 38 个内置工具

AI 在对话中**主动调用**本地工具完成任务，所有操作在用户可视化监督下执行。采用 **ReAct Agent Loop**（Thought → Action → Observation → Reflection），最大 15 轮，10 分钟超时。

> ⚠️ 需要模型支持 Tool Calling（推荐 Qwen3、Llama 3.1+、Mistral）

#### 📁 文件系统（12 个）

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件（≤1MB，支持行范围） |
| `write_file` | 写入文件（自动创建父目录） |
| `append_file` | 追加内容到文件末尾 |
| `edit_file` | 查找替换文本 |
| `list_directory` | 列出目录（支持递归、隐藏文件） |
| `create_directory` | 递归创建目录 |
| `delete_file` | 删除文件/目录 |
| `move_file` | 移动/重命名 |
| `copy_file` | 复制文件/目录 |
| `search_files` | 按文件名/内容搜索 |
| `get_file_info` | 获取文件详细信息 |
| `tree` | 树形结构展示目录 |

#### 💻 系统 & 网络（9 个）

| 工具 | 说明 |
|------|------|
| `run_command` | 执行 Shell 命令（自动/需确认/禁用 三模式） |
| `web_fetch` | 抓取网页内容（HTTP/HTTPS） |
| `web_search` | 联网搜索（Bing + 百度 + Google 三引擎） |
| `download_file` | 从 URL 下载文件 |
| `diff_files` | 对比文件差异（unified diff） |
| `replace_in_files` | 批量查找替换（glob 模式） |
| `read_multiple_files` | 批量读取多个文件 |
| `git` | Git 操作（16 个子操作） |
| `compress` | 创建/解压归档（zip/tar.gz） |

#### 🧠 记忆 & 会话（8 个）

| 工具 | 说明 |
|------|------|
| `memory_search` | 搜索 Agent 记忆 |
| `memory_add` | 添加新记忆条目 |
| `memory_replace` | 替换已有记忆（子串匹配，唯一匹配约束） |
| `memory_remove` | 删除记忆条目（子串匹配） |
| `skill_list` | 列出所有自动提取的技能（渐进式 Level 0） |
| `skill_view` | 查看技能详情：完整工具链、参数提示、成功率 |
| `session_list` | 列出历史会话 |
| `session_read` | 读取历史会话内容 |

#### 🤖 Agent & 浏览器（9 个）

| 工具 | 说明 |
|------|------|
| `spawn_task` | 子代理委派（独立执行子任务） |
| `browser_open` | 打开 URL 加载网页 |
| `browser_screenshot` | 浏览器截图 |
| `browser_evaluate` | 执行 JavaScript |
| `browser_extract` | 提取页面文本和链接 |
| `browser_click` | 点击页面元素 |
| `browser_type` | 在输入框输入文本 |
| `browser_scroll` | 滚动页面 |
| `browser_close` | 关闭浏览器 |

> 📌 **MCP 工具**：通过 [Model Context Protocol](https://modelcontextprotocol.io) 连接外部工具服务，动态注册。在设置面板添加 MCP Server 即可使用，工具命名格式 `mcp_{server}_{tool}`。

---

### 🔌 MCP (Model Context Protocol)

通过 JSON-RPC 2.0 over stdio 与外部工具服务通信：

```
启动 MCP Server → initialize 握手 → tools/list 发现 → tools/call 执行
```

- 7 个 IPC 通道：`startServer` / `stopServer` / `stopAll` / `callTool` / `getTools` / `getStatuses` / `refreshTools`
- 30 秒超时保护，退出时优雅清理（pending 请求 + SIGTERM）
- 设置面板管理：添加 / 启用 / 禁用 / 删除服务器

---

### 🧠 Agent 记忆系统

AI 自动从对话中学习并记住关键信息，跨会话持续积累：

| 类型 | 说明 | 注入策略 |
|------|------|----------|
| 📏 规则 | 应遵守的规则 | 始终注入（无条件执行） |
| ⚙️ 偏好 | 用户偏好习惯 | 始终注入（建议遵循） |
| 📌 事实 | 关于用户的事实 | 关键词 + 向量语义检索 |

- FTS5 全文搜索 + 向量语义搜索
- AI 可通过 `memory_replace` 更新、`memory_remove` 删除已有记忆（子串匹配 + 唯一匹配约束）
- 记忆写入前自动安全扫描（prompt injection / 敏感信息 / 不可见字符检测）
- 对话 ≥6 条消息后自动触发提取
- SQLite 持久化，可视化管理面板

---

### 📏 推荐规则记忆

通过 `memory_add` 工具添加以下规则，可显著约束 Agent 行为、减少无效操作：

> 规则类型（`rule`）在注入时标记为「必须无条件执行」，始终生效，不依赖关键词匹配。

#### 行为约束

| # | 规则 | 解决的问题 |
|---|------|-----------|
| 1 | **禁止重复调用** — 同一工具+参数连续失败 2 次后必须换策略，禁止第 3 次尝试 | 工具失败后死循环重试 |
| 2 | **搜索结果即答案** — `web_search` 返回的 snippet 已含关键摘要，能回答就直接回答，不要无意义追加 `web_fetch` | 过度抓取浪费 token |
| 3 | **禁止编造 URL** — 所有 URL 必须从搜索结果或文件中获取，禁止猜测、拼接、编造任何 URL 路径 | Agent 幻觉出不存在的链接 |
| 4 | **禁止抓取 SPA 页面** — GitHub releases、npm 等 SPA 网站内容无法被简单 fetch，从搜索 snippet 提取信息 | 反复抓取空壳页面 |
| 5 | **搜索查询必须进化** — 第一次结果不理想时，第二次必须换关键词/角度/表述，禁止重复相同查询 | 搜索死循环 |
| 6 | **工具调用前先想清楚** — 确认：(a) 工具能完成目标？(b) 参数正确？(c) 有更高效的方式？ | 盲目试错 |
| 7 | **命令结果要解读** — `run_command` 完成后必须分析输出并向用户解释，不要只贴原始输出 | 无意义的结果回显 |
| 8 | **文件操作先读后写** — 修改文件前必须先 `read_file` 确认当前内容，禁止凭记忆写入 | 覆盖用户已修改的文件 |
| 9 | **错误信息是线索** — 工具返回错误时仔细阅读并据此调整策略，忽略错误重复相同操作是最差行为 | 忽视错误继续撞墙 |
| 10 | **适时停止** — 任务已完成时立即停止，不要为了展示能力追加不必要的操作 | 过度操作 |

#### 信息获取

| # | 规则 | 解决的问题 |
|---|------|-----------|
| 11 | **始终使用中文回复** — 所有回复使用中文（技术术语可保留英文原名），除非用户明确使用其他语言 | 中英混杂体验差 |
| 12 | **优先官方来源** — 技术信息优先从官方文档 / GitHub 仓库 / 官方 API 获取，其次 Stack Overflow / MDN，避免引用未交叉验证的个人博客 | 信息准确性不足 |
| 13 | **联网前确认当前日期** — 每次联网查询信息前，必须先确认互联网当前最新日期（通过搜索或系统时间），确保引用的信息时效性准确，避免基于过期数据作答 | 引用过期信息导致误导 |

---

### 🖥️ 工作空间

右侧常驻面板（480px），集成**终端**和**文件浏览器**：

- **终端**：实时流式输出，支持 ANSI 颜色，无超时限制
- **文件浏览器**：目录树展示，点击文件预览内容（带行号）
- AI 工具命令自动在工作空间终端执行，用户可随时停止

---

### 🎭 更多功能

| 功能 | 说明 |
|------|------|
| 🧠 技能自动生成 | 从成功工具调用链提取可复用技能，渐进式加载（skill_list / skill_view），自动匹配复用 |
| 👤 用户画像 | 自动检测技术栈（14 种），注入 system prompt |
| 🎭 人格模式 | 多种预设模板，独立 system prompt + 温度设置 |
| 💓 Heartbeat | 后台主动检查 Ollama 连接状态、磁盘空间等 |
| ⏰ Cron 定时任务 | 一次性 / 周期性任务调度 |
| 📦 数据导出 | Markdown / HTML / TXT / JSON 全量备份与恢复 |

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Electron 应用                              │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    渲染进程 (Renderer)                         ││
│  │  chat-area · input-area · workspace-panel · settings-modal  ││
│  │  ─────────────────────────────────────────────────────────── ││
│  │  agent-engine · tool-registry · memory-manager              ││
│  │  vector-memory · context-manager · skill-manager           ││
│  │  sub-agent · cron-manager · mcp-client · log-service       ││
│  └─────────────────────────────┬────────────────────────────────┘│
│                                │ IPC                              │
│  ┌─────────────────────────────┴────────────────────────────────┐│
│  │                    主进程 (Main)                              ││
│  │  main.ts · ipc.ts · preload.ts · menu.ts · tray.ts         ││
│  │  tool-handlers.ts (25 工具) · tool-security.ts              ││
│  │  workspace.ts · browser.ts (8 工具) · mcp-manager.ts       ││
│  │  db/sqlite.ts (sql.js WASM · WAL · FTS5)                   ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Agent Loop (ReAct)

```
用户消息 → 注入记忆/技能上下文
    ↓
┌─ Thought → Action(tool_calls) → Observation(result) → Reflection ─┐
│                          循环（最大 15 轮，10 分钟超时）            │
└───────────────────────────────────────────────────────────────────┘
    ↓
流式响应 → 渲染到聊天区域（含工具调用卡片）→ 保存 → 自动提取记忆/技能
```

### 数据库（7 张表）

| 表 | 用途 |
|---|---|
| `sessions` | 会话（parent_id 父子关系） |
| `messages` | 消息（外键级联，thinking/tool_calls） |
| `tool_calls` | 工具调用记录 |
| `memories` | Agent 记忆（FTS5 全文搜索） |
| `settings` | 设置（JSON 序列化） |
| `traces` | ReAct 执行轨迹 |
| `skills` | 自动生成的可复用技能 |

---

## 📁 项目结构

```
src/
├── main/                                   # Electron 主进程
│   ├── main.ts                             # 应用入口、窗口管理
│   ├── preload.ts                          # contextBridge API 暴露
│   ├── ipc.ts                              # IPC 处理器
│   ├── tool-handlers.ts                    # 25 个内置工具实现
│   ├── tool-security.ts                    # 路径/命令安全检查
│   ├── workspace.ts                        # 子进程管理、流式输出
│   ├── browser.ts                          # 浏览器控制（8 工具）
│   ├── mcp-manager.ts                      # MCP 协议通信
│   ├── menu.ts · tray.ts · utils.ts        # 菜单/托盘/工具函数
│   └── db/sqlite.ts                        # SQLite (sql.js WASM)
│
├── renderer/                               # 渲染进程
│   ├── main.ts                             # 入口、全局初始化
│   ├── types.d.ts                          # 完整类型定义
│   ├── index.html                          # 入口 HTML
│   ├── api/
│   │   └── ollama.ts                       # Ollama REST API 客户端
│   ├── components/                         # 14 个 UI 组件
│   ├── services/
│   │   ├── agent-engine.ts                 # ReAct Agent Loop 引擎
│   │   ├── tool-registry.ts                # 工具注册调度（含 MCP 路由）
│   │   ├── memory-manager.ts               # 记忆管理核心
│   │   ├── vector-memory.ts                # 向量索引
│   │   ├── vector-store.ts                 # 向量存储
│   │   ├── context-manager.ts              # 上下文窗口管理
│   │   ├── skill-manager.ts                # 技能自动生成
│   │   ├── sub-agent.ts                    # 子代理委派
│   │   ├── cron-manager.ts                 # 定时任务
│   │   ├── mcp-client.ts                   # MCP 渲染端客户端
│   │   ├── log-service.ts                  # 结构化执行日志
│   │   └── crypto.ts                       # AES-256-GCM 加密
│   ├── utils/
│   │   ├── utils.ts · sanitizer.ts · marked-config.ts
│   ├── state/
│   │   └── state.ts                        # 响应式状态管理
│   └── styles/
│       └── style.css                       # 暖色调亮色主题
│
├── assets/icons/                           # 应用图标
├── src/vendor/                             # 第三方库本地化（ESM + 类型声明 + LICENSE）
│   ├── marked.js                           # Markdown 解析库（v18）
│   └── dompurify.js                        # HTML 净化库（v3）
├── docs/                                   # 文档
│   ├── BUILD.md                            # 构建指南
│   ├── CHANGELOG.md                        # 更新日志
│   ├── DEVELOPMENT.md                      # 开发规范
│   └── OPENCLAW-HERMES-ANALYSIS.md         # 改进路线图
├── package.json
├── vite.config.ts
└── tsconfig.json · tsconfig.main.json
```

---

## 🔌 Ollama API 接口

| 接口 | 用途 |
|------|------|
| `GET /api/tags` | 已安装模型列表 |
| `GET /api/ps` | 运行中模型 |
| `GET /api/version` | Ollama 版本 |
| `POST /api/show` | 模型详情（能力检测） |
| `POST /api/chat` | 流式聊天（支持 tools） |
| `POST /api/embed` | 生成嵌入向量 |

---

## 🔒 安全模型

### Tool Calling 安全

所有文件/命令操作必须经过 `tool-security.ts` 安全检查层：

| 维度 | 措施 |
|------|------|
| 路径 | 黑名单屏蔽 `/etc`, `/sys`, `/proc`, `~/.ssh`, `~/.gnupg` 等 |
| 写入 | 仅允许用户目录下的写操作 |
| 命令 | 黑名单拦截 `rm -rf /`, `mkfs`, `dd`, `shutdown`, 反弹 shell 等 |
| 模式 | `run_command` 支持自动执行 / 需用户确认 / 禁用三模式 |

### 应用安全

- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- `contextIsolation: true` + IPC 白名单 + 单实例锁
- SQLite 本地存储，不上传任何服务器

---

## 📥 下载

从 [Releases](https://gitee.com/thzxx/metona-ollama-desktop/releases) 页面下载最新安装包：

| 文件 | 类型 |
|------|------|
| `Metona Ollama Setup 5.1.5.exe` | NSIS 安装包（可选目录、创建快捷方式） |

> ⚠️ 未签名版本，首次运行 Windows 可能弹出安全警告，点击「仍要运行」即可。

---

## 🔨 从源码构建

### 环境要求

- Node.js v22+
- Windows 或 Linux（交叉编译需 Wine 9.0+）

### 快速开始

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout develop

npm config set registry https://registry.npmmirror.com
npm install
npm start
```

### 构建 Windows 安装包

```bash
bash restore-build-cache.sh                         # 恢复构建缓存（可选）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

### 常用命令

```bash
npm run build:renderer   # 仅构建渲染进程（Vite）
npm run build:main       # 仅构建主进程（tsc）
npm run build            # 构建全部
npm start                # 构建并运行
npm run dist             # 构建 Windows 安装包（NSIS）
```

> 💡 详细构建指南见 [docs/BUILD.md](docs/BUILD.md)（含故障排查）

---

## 🎨 设计语言

| 元素 | 值 |
|------|------|
| 背景 | 奶白 `#FAF7F2` |
| 主色 | 珊瑚橙 `#E8734A` |
| Think | 紫色 `#9B7ED8` |
| Token | 金色 `#D4A03C` |
| 终端 | 暖棕深色 `#2D2016` |
| 正文字体 | Inter |
| 代码字体 | JetBrains Mono |
| 圆角 | 控件 8px · 卡片 12px · 弹框 16-20px |

---

## 📋 更新日志

完整更新日志请查看 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 📄 License

[MIT](LICENSE)
