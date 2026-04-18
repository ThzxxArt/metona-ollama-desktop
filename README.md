# 🦙 Metona Ollama Desktop

基于 TypeScript + Electron 的 [Ollama](https://ollama.com) 桌面 AI Agent 客户端，专为 Windows 打造。

> 💡 全离线运行，数据本地存储，零外部依赖

![版本](https://img.shields.io/badge/version-5.0.0--desktop-brightgreen)
![平台](https://img.shields.io/badge/platform-Windows%20x64-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)
![Electron](https://img.shields.io/badge/Electron-33-47848f)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![协议](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 功能特性

### 💬 对话
- **流式对话** — ReadableStream 实时打字效果，支持强制停止
- **多模型支持** — 自动加载 Ollama 已安装模型，一键切换
- **Think 推理** — 展开/收起的深度思考过程（需模型支持）
- **多模态** — 图片上传，自动检测 Vision 模型能力
- **文件分析** — 支持 50+ 种文本/代码格式，单文件 ≤500KB

### 🔧 Tool Calling — 34 个内置工具 + MCP 动态工具

AI 在对话中主动调用本地工具完成任务，所有操作在用户可视化监督下执行：

| 工具 | 说明 |
|------|------|
| 📄 `read_file` | 读取文件内容（≤1MB，支持行范围） |
| ✏️ `write_file` | 写入文件（自动创建父目录） |
| 📁 `list_directory` | 列出目录（支持递归、隐藏文件） |
| 🔍 `search_files` | 按文件名/内容搜索（支持扩展名过滤） |
| 📂 `create_directory` | 创建目录（递归创建） |
| 🗑️ `delete_file` | 删除文件/目录 |
| 💻 `run_command` | 执行 Shell 命令（无超时，自动/需确认/禁用） |
| 📦 `move_file` | 移动/重命名文件或目录 |
| 📋 `copy_file` | 复制文件或目录 |
| 🌐 `web_fetch` | 抓取网页内容（HTTP/HTTPS） |
| 🔍 `web_search` | 联网搜索（DuckDuckGo/Bing） |
| ➕ `append_file` | 追加内容到文件末尾 |
| ✂️ `edit_file` | 查找替换文件中的文本 |
| ℹ️ `get_file_info` | 获取文件/目录详细信息 |
| 🌳 `tree` | 以树形结构展示目录 |
| ⬇️ `download_file` | 从 URL 下载文件到本地 |
| 🔀 `diff_files` | 对比两个文件差异（unified diff） |
| 🔄 `replace_in_files` | 按 glob 模式批量查找替换 |
| 📚 `read_multiple_files` | 批量读取多个文件内容 |
| 🔖 `git` | Git 操作（16 个子操作） |
| 🗜️ `compress` | 创建/解压归档（zip/tar.gz） |
| 🧠 `memory_search` | 搜索 Agent 记忆 |
| 💾 `memory_add` | 添加新记忆条目 |
| 📋 `session_list` | 列出历史会话 |
| 📖 `session_read` | 读取历史会话内容 |
| 🤖 `spawn_task` | 子代理委派（独立执行子任务） |
| 🌐 `browser_open` | 打开 URL 加载网页 |
| 📸 `browser_screenshot` | 浏览器截图 |
| ⚡ `browser_evaluate` | 在浏览器中执行 JavaScript |
| 📰 `browser_extract` | 提取页面文本和链接 |
| 👆 `browser_click` | 点击页面元素 |
| ⌨️ `browser_type` | 在输入框中输入文本 |
| ↕️ `browser_scroll` | 滚动浏览器页面 |
| ❌ `browser_close` | 关闭浏览器 |

**MCP 工具**：通过 [Model Context Protocol](https://modelcontextprotocol.io) 连接外部工具服务，动态注册工具。在设置面板添加 MCP Server 即可。

**Agent Loop（ReAct 模式）**：用户请求 → Thought → Action → Observation → Reflection → 循环直到 Final Answer。支持流式 + 并行调用 + 最大 15 轮保护 + 10 分钟总超时。自动检测并跳过重复工具调用。

> ⚠️ 需要模型支持 Tool Calling（推荐 Qwen3、Llama 3.1+、Mistral）

### 🔌 MCP (Model Context Protocol)
- 通过 JSON-RPC 2.0 over stdio 与外部工具服务通信
- 支持 `initialize` 握手、`tools/list` 工具发现、`tools/call` 工具执行
- 30 秒超时保护，优雅清理（pending 请求 + SIGTERM）
- 工具自动注入 Agent Loop，命名格式 `mcp_{server}_{tool}`
- 设置面板管理：添加/启用/禁用/删除服务器

### 🧠 Agent 记忆系统
AI 自动从对话中学习并记住关键信息，跨会话持续积累：

| 类型 | 说明 | 检索方式 |
|------|------|----------|
| 📌 事实 | 关于用户的事实 | 关键词 + 向量语义 |
| ⚙️ 偏好 | 用户的偏好习惯 | 始终注入 |
| 📏 规则 | 应遵守的规则 | 始终注入 |

**特性**：
- 对话 ≥6 条消息后自动触发提取
- FTS5 全文搜索 + 向量语义搜索
- SQLite 持久化，跨会话保留
- 可视化管理面板（搜索、筛选、编辑、删除）

### 🧠 技能自动生成
- 自动从成功工具调用链提取可复用技能
- `skills` 表持久化，支持关键词搜索和使用统计
- 下次同类任务自动匹配并注入技能上下文

### 👤 用户画像
- 从对话中自动检测用户技术栈（Python/TypeScript/Go/React 等）
- 用户画像注入 system prompt，Agent 行为更贴合用户习惯

### 🎭 人格模式
- 多种预设人格模板，独立 system prompt + 温度设置
- 快速切换，适配不同任务场景

### 🖥️ 工作空间 — 终端 & 文件浏览器
右侧常驻面板（480px），提供终端命令行和文件浏览器：

**终端**：
- 实时流式显示命令输出（支持 ANSI 颜色）
- 支持长时间运行命令，**无超时限制**
- 单一终端进程，可随时停止

**文件浏览器**：
- 浏览工作空间目录，目录树展示
- 点击文件预览内容（带行号）

### ⏰ 定时任务 (Cron)
- 支持一次性/周期性定时任务
- 任务触发时自动填入聊天输入框

### 📦 数据
- SQLite (sql.js WASM) 持久化，WAL 模式高性能
- 7 张表：sessions、messages、tool_calls、memories（FTS5）、settings、traces、skills
- 导出格式：Markdown / HTML / TXT / JSON（全量备份/恢复）
- 所有导入/导出均使用 Electron 原生文件对话框

### 🖥️ 桌面原生
- 暖色调亮色主题（奶白背景 + 珊瑚橙主色）
- 执行日志面板（左侧，实时显示运行日志）
- 工作空间面板（右侧，终端 + 文件浏览器，固定 480px）
- Token 消耗统计（Header 实时显示）
- 系统托盘 / 原生菜单 / 原生文件对话框
- 单实例锁 / 无 CORS 限制

---

## 🏗️ 架构

v5.0 五大子系统协调运作：

```
用户输入消息
    │
    ├─→ ① Agent 记忆检索（关键词 + 向量语义） → 注入 system prompt
    ├─→ ② ReAct Agent Loop → Thought → Action → Observation → Reflection
    │       │
    │       ├─→ 内置工具（34 个） → 主进程 tool-handlers
    │       └─→ MCP 工具 → 主进程 mcp-manager → JSON-RPC → MCP Server
    │
    ▼
  Ollama API（携带组合后的 system prompt + tools）
    │
    ▼
  流式响应 → 渲染到聊天区域（含工具调用卡片）
    │
    ▼
  保存会话 → SQLite → 自动提取记忆 / 技能

③ 工作空间（独立通道）
  AI 建议命令 → 用户确认 → spawn 子进程 → IPC 流式推送 → 终端面板

④ MCP（独立通道）
  启动时 spawn MCP Server → initialize 握手 → tools/list → 动态注册

⑤ 数据层（SQLite）
  sessions · messages · tool_calls · memories(FTS5) · settings · traces · skills
```

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
│  │  workspace.ts · browser.ts · mcp-manager.ts                ││
│  │  db/sqlite.ts (sql.js WASM · WAL · FTS5)                   ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

---

## 📥 下载

从 [Releases](https://gitee.com/thzxx/metona-ollama-desktop/releases) 页面下载：

| 文件 | 类型 |
|------|------|
| `Metona Ollama Setup 5.0.0.exe` | NSIS 安装包（可选目录、创建快捷方式） |

> ⚠️ 未签名版本，首次运行 Windows 可能弹出安全警告，点击「仍要运行」即可。

---

## 🔨 从源码构建

### 环境要求

- Node.js v22+
- Windows 或 Linux（交叉编译需 Wine 9.0+）

### 构建步骤

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout metona-ollama-desktop-v5.0.0

npm config set registry https://registry.npmmirror.com
npm install

# 构建并运行
npm start

# 构建 Windows 安装包
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

> 💡 详细构建指南见 [docs/BUILD.md](docs/BUILD.md)

### 常用命令

```bash
npm run build:renderer   # 仅构建渲染进程（Vite）
npm run build:main       # 仅构建主进程（tsc）
npm run build            # 构建全部
npm start                # 构建并运行
npm run dist             # 构建 Windows 安装包（NSIS）
```

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
│   ├── mcp-manager.ts                      # MCP 协议通信（JSON-RPC 2.0）
│   ├── menu.ts / tray.ts / utils.ts        # 菜单/托盘/工具函数
│   └── db/sqlite.ts                        # SQLite (sql.js WASM, WAL, FTS5)
└── renderer/                               # 渲染进程
    ├── main.ts                             # 入口、全局初始化
    ├── types.d.ts                          # 完整类型定义
    ├── api/ollama.ts                       # Ollama REST API 客户端
    ├── components/                         # 14 个 UI 组件
    │   ├── chat-area.ts                    # 消息渲染、工具卡片
    │   ├── input-area.ts                   # 消息发送、文件上传
    │   ├── workspace-panel.ts              # 工作空间（终端+文件）
    │   ├── settings-modal.ts               # 设置面板（含 MCP/Cron 管理）
    │   ├── memory-modal.ts                 # 记忆管理
    │   ├── tool-confirm-modal.ts           # 工具确认
    │   ├── tools-modal.ts / history-modal.ts / header.ts / ...
    │   └── toast.ts / lightbox.ts / prompt-modal.ts
    ├── services/                           # 核心服务
    │   ├── agent-engine.ts                 # ReAct Agent Loop 引擎
    │   ├── tool-registry.ts                # 工具注册调度（含 MCP 路由）
    │   ├── memory-manager.ts               # 记忆管理核心
    │   ├── vector-memory.ts                # 向量索引
    │   ├── vector-store.ts                 # 向量存储
    │   ├── context-manager.ts              # 上下文窗口管理
    │   ├── skill-manager.ts                # 技能自动生成
    │   ├── sub-agent.ts                    # 子代理委派
    │   ├── cron-manager.ts                 # 定时任务
    │   ├── mcp-client.ts                   # MCP 渲染端客户端
    │   ├── log-service.ts                  # 结构化执行日志
    │   └── crypto.ts                       # AES-256-GCM 加密
    ├── utils/                              # 工具函数
    │   ├── utils.ts / sanitizer.ts / marked-config.ts
    ├── state/state.ts                      # 响应式状态管理
    └── styles/style.css                    # 暖色调亮色主题
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

## 🔒 安全

### Tool Calling 安全
- **路径黑名单**：自动屏蔽 `/etc`, `/sys`, `/proc`, `~/.ssh`, `~/.gnupg` 等
- **写操作白名单**：仅允许用户目录下的写入
- **命令黑名单**：`rm -rf /`, `mkfs`, `dd`, `shutdown`, 反弹 shell 检测等
- **run_command 三模式**：自动执行 / 需确认 / 禁用
- **安全提示词注入**：自动向 system prompt 追加工具使用安全规则

### 应用安全
- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- contextIsolation + IPC 白名单 + 单实例锁
- SQLite 本地存储，不上传任何服务器

---

## 📋 更新日志

完整更新日志请查看 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 📄 License

MIT
