<p align="center">
  <img src="assets/icons/icon-new.png" alt="Metona Ollama Desktop" width="128">
</p>

<h1 align="center">Metona Ollama Desktop</h1>

<p align="center">
  <strong>🤖 本地 AI 桌面客户端 · Local AI Desktop Client</strong>
</p>

<p align="center">
  <a href="#-中文"><img src="https://img.shields.io/badge/🇨🇳-中文-E8734A?style=flat-square" alt="中文"></a>
  <a href="#-english"><img src="https://img.shields.io/badge/🇬🇧-English-47848F?style=flat-square" alt="English"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v1--stable--release-E8734A?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/electron-33+-47848F?style=flat-square&logo=electron" alt="electron">
  <img src="https://img.shields.io/badge/typescript-5.7+-3178C6?style=flat-square&logo=typescript" alt="typescript">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/platform-Windows%20x64-blue?style=flat-square" alt="platform">
</p>

<p align="center">
  <em>所有 AI 推理在本地完成，数据不离开本机。</em><br>
  <em>All AI inference runs locally — data never leaves your machine.</em>
</p>

---

# 🇨🇳 中文

## ✨ 特性

| | 功能 | 说明 |
|:---:|:---|:---|
| 🤖 | **ReAct Agent Loop** | Thought → Action → Observation → Reflection 完整循环，最大 85 轮（可配置），自动重试 2 次，工具去重，并行/链式执行 |
| 🔧 | **38 个内置工具** | 文件系统 · 命令执行 · 联网搜索 · 浏览器控制 · Git · 记忆 · 技能 · 会话 · 子代理 |
| 🧠 | **智能记忆系统** | 三类记忆（fact / preference / rule），FTS5 全文搜索 + 向量语义搜索，写入前安全扫描，容量 500 条，90 天衰减 |
| 🌐 | **MCP 协议扩展** | JSON-RPC 2.0 over stdio，动态工具发现，Shadowing 防护 |
| 🔍 | **三引擎联网搜索** | Bing + 百度 + Google 聚合，web_search → web_fetch 链式抓取 |
| 🌏 | **浏览器控制** | 打开网页 · 截图 · 执行 JS · 提取内容 · 点击 · 输入 · 滚动 · 关闭 |
| 🖥️ | **工作空间面板** | 终端（实时流式输出）+ 文件浏览器，命令安全检查 |
| 📊 | **技能自动生成** | 从成功的工具调用链自动提取可复用技能（≥2 步），Level 0 摘要 |
| 🗜️ | **上下文管理** | 滑动窗口 + LLM 摘要压缩（50% 自动触发）+ /compress 手动触发 |
| 👥 | **子代理委派** | spawn_task 工具，独立上下文 + 超时保护 |
| ⏰ | **定时任务** | cron-manager，支持一次性/周期性调度 |
| 📈 | **Token 仪表盘** | 全局 + 会话统计，消耗趋势图，2 秒刷新 |
| 🎨 | **暖色调 UI** | 奶白 `#FAF7F2` + 珊瑚橙 `#E8734A`，长时间使用不疲劳 |
| 🔔 | **系统托盘** | 原生托盘集成 |
| 🔐 | **AES-256-GCM** | 数据加密支持 |

## 🔧 工具清单

<details>
<summary><strong>📁 文件系统（17 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `list_directory` | 列出目录内容 |
| `search_files` | 搜索文件（正则/通配符） |
| `create_directory` | 创建目录 |
| `delete_file` | 删除文件 |
| `move_file` | 移动/重命名文件 |
| `copy_file` | 复制文件 |
| `append_file` | 追加内容到文件 |
| `edit_file` | 编辑文件（查找替换） |
| `get_file_info` | 获取文件元信息 |
| `tree` | 目录树结构 |
| `download_file` | 下载文件 |
| `diff_files` | 文件差异对比 |
| `replace_in_files` | 批量替换 |
| `read_multiple_files` | 批量读取 |
| `compress` | 压缩文件/目录 |

</details>

<details>
<summary><strong>⚡ 命令执行（1 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `run_command` | 执行 shell 命令，实时流式输出，支持自动/需确认/禁用三种模式 |

</details>

<details>
<summary><strong>🔍 联网搜索（2 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `web_search` | 三引擎聚合搜索（Bing + 百度 + Google），返回标题、URL、摘要，默认 15 条 |
| `web_fetch` | 网页内容抓取，默认不截断 |

</details>

<details>
<summary><strong>🌐 浏览器控制（8 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `browser_open` | 打开网页 |
| `browser_screenshot` | 页面截图 |
| `browser_evaluate` | 执行 JavaScript |
| `browser_extract` | 提取页面内容 |
| `browser_click` | 点击元素 |
| `browser_type` | 输入文本 |
| `browser_scroll` | 页面滚动 |
| `browser_close` | 关闭浏览器 |

</details>

<details>
<summary><strong>📦 Git（1 个，17 个子命令）</strong></summary>

| 子命令 | 功能 |
|--------|------|
| `init` `clone` `add` `commit` `push` `pull` | 基础操作 |
| `diff` `log` `status` `branch` `checkout` | 查看与切换 |
| `merge` `stash` `reset` `tag` `remote` | 高级操作 |

</details>

<details>
<summary><strong>🧠 记忆管理（4 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `memory_search` | 搜索记忆（FTS5 + 向量语义） |
| `memory_add` | 添加记忆（自动安全扫描） |
| `memory_replace` | 修改记忆 |
| `memory_remove` | 删除记忆 |

</details>

<details>
<summary><strong>📊 技能 / 会话 / 子代理（5 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `skill_list` | 列出已生成的技能 |
| `skill_view` | 查看技能详情 |
| `session_list` | 列出历史会话 |
| `session_read` | 读取会话内容 |
| `spawn_task` | 委派子代理（独立上下文 + 超时保护） |

</details>

## 🏗️ 架构

```
用户消息 → Agent Engine (ReAct Loop, ≤85轮)
              ↓
         记忆检索 (FTS5 + 向量语义搜索) → 上下文注入
              ↓
         Ollama API (流式响应)
              ↓
         Tool Registry (38 内置 + MCP 动态)
              ↓
         观察结果 → 反思 → 循环 / 最终回答
```

### 🧩 UI 组件（原生 DOM）

```
main.ts (入口)
  ├── header.ts              # 顶部导航栏
  ├── model-bar.ts           # 模型选择栏
  ├── chat-area.ts           # 聊天消息区域
  ├── input-area.ts          # 输入框 + 文件上传
  ├── workspace-panel.ts     # 终端 + 文件浏览器
  ├── log-panel.ts           # 结构化日志面板
  ├── settings-modal.ts      # 设置面板
  ├── history-modal.ts       # 会话历史
  ├── memory-modal.ts        # 记忆管理
  ├── tools-modal.ts         # 工具列表
  ├── token-dashboard.ts     # Token 消耗仪表盘
  ├── tool-confirm-modal.ts  # 工具执行确认
  ├── toast.ts               # Toast 通知
  └── lightbox.ts            # 图片灯箱
```

### 🗄️ 数据库

SQLite (sql.js WASM)，7 张表，WAL 模式 + FTS5 全文搜索：

| 表 | 用途 |
|---|---|
| `sessions` | 会话（parent_id 父子关系） |
| `messages` | 消息（外键级联删除） |
| `tool_calls` | 工具调用记录 |
| `memories` | Agent 记忆（FTS5 + 向量嵌入） |
| `settings` | 设置（JSON 序列化） |
| `traces` | ReAct 执行轨迹 |
| `skills` | 自动生成的技能 |

## 🔒 安全机制

| 层级 | 措施 |
|------|------|
| 📁 文件系统 | `checkPathAllowed()` — 路径黑名单 |
| ⚡ 命令执行 | `checkCommandAllowed()` — 命令黑名单 + 三种模式 |
| 🖥️ 前端渲染 | HTML 净化器（白名单标签 + URI 协议检查） |
| 🔒 Electron | `contextIsolation: true` + IPC 白名单 |
| 🔐 数据加密 | AES-256-GCM |
| 🧠 记忆安全 | 写入前 Prompt Injection / 敏感信息检测 |
| 🌐 MCP 安全 | Shadowing 防护 |

## 🚀 快速开始

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout desktop-v1-stable-release
npm config set registry https://registry.npmmirror.com
npm install
npm start
```

## 📦 构建 Windows 安装包

```bash
# 环境：Ubuntu 24.04 + Node.js v22 + Wine 9.0+
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

产出：`release/Metona Ollama Setup v1-stable-release.exe`

## 🛠️ 常用命令

```bash
npm start              # 构建并运行
npm run dev:renderer   # Vite watch（渲染进程）
npm run dev:main       # tsc watch（主进程）
npm run build          # 完整构建
npm run dist           # 构建 Windows 安装包
```

## 💻 系统要求

- 🖥️ Windows 10/11（64 位）
- 🤖 Ollama 本地运行中（默认 `http://localhost:11434`）
- 💾 建议 8GB+ 内存

## 📄 许可证

[MIT](LICENSE)

---

# 🇬🇧 English

## ✨ Features

| | Feature | Description |
|:---:|:---|:---|
| 🤖 | **ReAct Agent Loop** | Full Thought → Action → Observation → Reflection cycle, up to 85 iterations (configurable), auto-retry 2 times, tool dedup, parallel/chain execution |
| 🔧 | **38 Built-in Tools** | File system · Command · Web search · Browser · Git · Memory · Skills · Sessions · Sub-agent |
| 🧠 | **Smart Memory System** | Three types (fact / preference / rule), FTS5 + vector semantic search, pre-write security scan, 500 capacity, 90-day decay |
| 🌐 | **MCP Protocol Extension** | JSON-RPC 2.0 over stdio, dynamic tool discovery, Shadowing protection |
| 🔍 | **Triple-engine Web Search** | Bing + Baidu + Google aggregation, web_search → web_fetch chain |
| 🌏 | **Browser Control** | Open pages · Screenshot · JS execution · Content extraction · Click · Type · Scroll · Close |
| 🖥️ | **Workspace Panel** | Terminal (real-time streaming) + file browser, command security checks |
| 📊 | **Auto Skill Generation** | Extracts reusable skills from successful tool call chains (≥2 steps), Level 0 summaries |
| 🗜️ | **Context Management** | Sliding window + LLM summary compression (auto at 50%) + /compress manual trigger |
| 👥 | **Sub-agent Delegation** | spawn_task tool, isolated context + timeout protection |
| ⏰ | **Cron Tasks** | cron-manager, one-time and periodic scheduling |
| 📈 | **Token Dashboard** | Global + session stats, consumption trend chart, 2s refresh |
| 🎨 | **Warm-tone UI** | Cream `#FAF7F2` + coral `#E8734A`, fatigue-free for extended use |
| 🔔 | **System Tray** | Native tray integration |
| 🔐 | **AES-256-GCM** | Data encryption support |

## 🔧 Tool List

<details>
<summary><strong>📁 File System (17)</strong></summary>

| Tool | Function |
|------|------|
| `read_file` | Read file content |
| `write_file` | Write file |
| `list_directory` | List directory contents |
| `search_files` | Search files (regex/wildcard) |
| `create_directory` | Create directory |
| `delete_file` | Delete file |
| `move_file` | Move/rename file |
| `copy_file` | Copy file |
| `append_file` | Append content to file |
| `edit_file` | Edit file (find & replace) |
| `get_file_info` | Get file metadata |
| `tree` | Directory tree structure |
| `download_file` | Download file |
| `diff_files` | File diff comparison |
| `replace_in_files` | Batch replace |
| `read_multiple_files` | Batch read |
| `compress` | Compress file/directory |

</details>

<details>
<summary><strong>⚡ Command Execution (1)</strong></summary>

| Tool | Function |
|------|------|
| `run_command` | Execute shell command, real-time streaming, auto/confirm/disabled modes |

</details>

<details>
<summary><strong>🔍 Web Search (2)</strong></summary>

| Tool | Function |
|------|------|
| `web_search` | Triple-engine search (Bing + Baidu + Google), returns title, URL, snippet, 15 results |
| `web_fetch` | Fetch web page content, no truncation |

</details>

<details>
<summary><strong>🌐 Browser Control (8)</strong></summary>

| Tool | Function |
|------|------|
| `browser_open` | Open web page |
| `browser_screenshot` | Page screenshot |
| `browser_evaluate` | Execute JavaScript |
| `browser_extract` | Extract page content |
| `browser_click` | Click element |
| `browser_type` | Type text |
| `browser_scroll` | Scroll page |
| `browser_close` | Close browser |

</details>

<details>
<summary><strong>📦 Git (1 tool, 17 subcommands)</strong></summary>

| Subcommands | Function |
|--------|------|
| `init` `clone` `add` `commit` `push` `pull` | Basic operations |
| `diff` `log` `status` `branch` `checkout` | View & switch |
| `merge` `stash` `reset` `tag` `remote` | Advanced operations |

</details>

<details>
<summary><strong>🧠 Memory Management (4)</strong></summary>

| Tool | Function |
|------|------|
| `memory_search` | Search memories (FTS5 + vector semantic) |
| `memory_add` | Add memory (auto security scan) |
| `memory_replace` | Modify memory |
| `memory_remove` | Delete memory |

</details>

<details>
<summary><strong>📊 Skills / Sessions / Sub-agent (5)</strong></summary>

| Tool | Function |
|------|------|
| `skill_list` | List generated skills |
| `skill_view` | View skill details |
| `session_list` | List session history |
| `session_read` | Read session content |
| `spawn_task` | Delegate sub-agent (isolated context + timeout) |

</details>

## 🏗️ Architecture

```
User message → Agent Engine (ReAct Loop, ≤85 rounds)
              ↓
         Memory Retrieval (FTS5 + Vector Semantic Search) → Context Injection
              ↓
         Ollama API (Streaming Response)
              ↓
         Tool Registry (38 Built-in + MCP Dynamic)
              ↓
         Observation → Reflection → Loop / Final Answer
```

### 🧩 UI Components (Native DOM)

```
main.ts (Entry)
  ├── header.ts              # Top navigation bar
  ├── model-bar.ts           # Model selector
  ├── chat-area.ts           # Chat message area
  ├── input-area.ts          # Input box + file upload
  ├── workspace-panel.ts     # Terminal + file browser
  ├── log-panel.ts           # Structured log panel
  ├── settings-modal.ts      # Settings panel
  ├── history-modal.ts       # Session history
  ├── memory-modal.ts        # Memory management
  ├── tools-modal.ts         # Tool list
  ├── token-dashboard.ts     # Token consumption dashboard
  ├── tool-confirm-modal.ts  # Tool execution confirmation
  ├── toast.ts               # Toast notifications
  └── lightbox.ts            # Image lightbox
```

### 🗄️ Database

SQLite (sql.js WASM), 7 tables, WAL mode + FTS5 full-text search:

| Table | Purpose |
|---|---|
| `sessions` | Sessions (parent_id hierarchy) |
| `messages` | Messages (cascade delete) |
| `tool_calls` | Tool call records |
| `memories` | Agent memories (FTS5 + vector embedding) |
| `settings` | Settings (JSON serialization) |
| `traces` | ReAct execution traces |
| `skills` | Auto-generated skills |

## 🔒 Security

| Layer | Measure |
|------|------|
| 📁 File System | `checkPathAllowed()` — path blacklist |
| ⚡ Command Execution | `checkCommandAllowed()` — command blacklist + three modes |
| 🖥️ Frontend Rendering | HTML sanitizer (whitelist tags + URI protocol check) |
| 🔒 Electron | `contextIsolation: true` + IPC whitelist |
| 🔐 Data Encryption | AES-256-GCM |
| 🧠 Memory Security | Pre-write prompt injection / sensitive info detection |
| 🌐 MCP Security | Shadowing protection |

## 🚀 Quick Start

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout desktop-v1-stable-release
npm config set registry https://registry.npmmirror.com
npm install
npm start
```

## 📦 Build Windows Installer

```bash
# Environment: Ubuntu 24.04 + Node.js v22 + Wine 9.0+
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

Output: `release/Metona Ollama Setup v1-stable-release.exe`

## 🛠️ Common Commands

```bash
npm start              # Build and run
npm run dev:renderer   # Vite watch (renderer)
npm run dev:main       # tsc watch (main process)
npm run build          # Full build
npm run dist           # Build Windows installer
```

## 💻 System Requirements

- 🖥️ Windows 10/11 (64-bit)
- 🤖 Ollama running locally (default `http://localhost:11434`)
- 💾 8GB+ RAM recommended

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://gitee.com/thzxx">thzxx</a></sub>
</p>
