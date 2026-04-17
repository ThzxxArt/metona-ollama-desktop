# 🦙 Metona Ollama Desktop

基于 TypeScript + Electron 的 [Ollama](https://ollama.com) 桌面 AI Agent 客户端，专为 Windows 打造。

> 💡 全离线运行，数据本地存储，零外部依赖

![版本](https://img.shields.io/badge/version-4.0.0--desktop-brightgreen)
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

### 🔧 Tool Calling — 25 个工具（AI 自主工具调用）

AI 在对话中主动调用本地工具完成任务，所有操作在用户可视化监督下执行：

| 工具 | 说明 | 安全级别 |
|------|------|----------|
| 📄 `read_file` | 读取文件内容（≤1MB，支持行范围） | 自动 |
| ✏️ `write_file` | 写入文件（自动创建父目录） | 自动 |
| 📁 `list_directory` | 列出目录（支持递归、隐藏文件） | 自动 |
| 🔍 `search_files` | 按文件名/内容搜索（支持扩展名过滤） | 自动 |
| 📂 `create_directory` | 创建目录（递归创建） | 自动 |
| 🗑️ `delete_file` | 删除文件/目录 | 自动 |
| 💻 `run_command` | 执行 Shell 命令（无超时，工作空间终端执行） | 自动/需确认/禁用 |
| 📦 `move_file` | 移动/重命名文件或目录 | 自动 |
| 📋 `copy_file` | 复制文件或目录 | 自动 |
| 🌐 `web_fetch` | 抓取网页内容（HTTP/HTTPS，默认返回完整内容） | 自动 |
| 🔍 `web_search` | 联网搜索（DuckDuckGo/Bing，返回标题+链接+摘要） | 自动 |
| ➕ `append_file` | 追加内容到文件末尾 | 自动 |
| ✂️ `edit_file` | 查找替换文件中的文本 | 自动 |
| ℹ️ `get_file_info` | 获取文件/目录详细信息 | 自动 |
| 🌳 `tree` | 以树形结构展示目录 | 自动 |
| ⬇️ `download_file` | 从 URL 下载文件到本地 | 自动 |
| 🔀 `diff_files` | 对比两个文件差异（unified diff） | 自动 |
| 🔄 `replace_in_files` | 按 glob 模式批量查找替换多个文件 | 自动 |
| 📚 `read_multiple_files` | 批量读取多个文件内容 | 自动 |
| 🔖 `git` | Git 操作（status/log/diff/add/commit/push/pull/branch/checkout/merge/stash 等 16 个子操作） | 自动 |
| 🗜️ `compress` | 创建/解压归档（zip/tar.gz） | 自动 |
| 🧠 `memory_search` | 搜索 Agent 记忆（语义/关键词） | 自动 |
| 💾 `memory_add` | 添加新记忆条目 | 自动 |
| 📋 `session_list` | 列出历史会话 | 自动 |
| 📖 `session_read` | 读取历史会话内容 | 自动 |

**Agent Loop（ReAct 模式）**：用户请求 → Thought → Action → Observation → Reflection → 循环直到 Final Answer。支持流式 + 并行调用 + 最大 15 轮保护 + 10 分钟总超时。自动检测并跳过重复工具调用。

> ⚠️ 需要模型支持 Tool Calling（推荐 Qwen3、Llama 3.1+、Mistral）

### 🖥️ 工作空间 — 终端 & 文件浏览器
右侧常驻面板（480px），提供终端命令行和文件浏览器：

**终端**：
- 实时流式显示命令输出（支持 ANSI 颜色）
- 支持长时间运行命令（如 `ollama pull`），**无超时限制**
- 单一终端进程，可随时停止

**文件浏览器**：
- 浏览工作空间目录，目录树展示
- 点击文件预览内容（带行号）

> ⚠️ Tool Calling 走 Agent Loop（有超时），工作空间走独立进程（无超时），由用户主动触发。

### 🧠 Agent 记忆系统
AI 自动从对话中学习并记住关键信息，跨会话持续积累：

| 类型 | 说明 | 检索方式 |
|------|------|----------|
| 📌 事实 | 关于用户的事实 | 关键词 + 向量语义 |
| ⚙️ 偏好 | 用户的偏好习惯 | 始终注入 |
| 📏 规则 | 应遵守的规则 | 始终注入 |

**特性**：
- 对话 ≥6 条消息后自动触发 LLM 提取
- FTS5 全文搜索 + 向量语义搜索（需选择嵌入模型）
- SQLite 持久化，跨会话保留
- 可视化管理面板（搜索、筛选、编辑、删除）
- 设置中一键开关

### 📦 数据
- SQLite (sql.js WASM) 持久化，WAL 模式高性能
- 6 张表：sessions、messages、tool_calls、memories、settings、traces
- 导出格式：Markdown / HTML / TXT / JSON（全量备份/恢复）
- 所有导入/导出均使用 Electron 原生文件对话框

### 🖥️ 桌面原生
| 特性 | 说明 |
|------|------|
| 暖色调亮色主题 | 奶白背景 + 珊瑚橙主色，圆润柔和 |
| 执行日志面板 | 左侧面板实时显示应用运行日志 |
| 工作空间面板 | 右侧面板：终端 + 文件浏览器，固定 480px |
| Token 消耗统计 | Header 实时显示当前会话总 token 消耗 |
| 系统托盘 | 最小化到托盘，双击恢复 |
| 原生菜单 | 文件 / 编辑 / 视图 / 窗口 / 帮助完整菜单 |
| 原生文件对话框 | 文件选择/保存全部使用 Electron 原生对话框 |
| 单实例锁 | 防止重复启动 |
| 无 CORS 限制 | 直连本地 Ollama，无需配置 OLLAMA_ORIGINS |

---

## 🏗️ 架构

v4.0 四大子系统协调运作：

```
用户输入消息
    │
    ├─→ ① Agent 记忆检索（关键词 + 向量语义） → 注入 system prompt
    ├─→ ② ReAct Agent Loop → Thought → Action → Observation → Reflection
    │
    ▼
  Ollama API（携带组合后的 system prompt + tools）
    │
    ▼
  流式响应 → 渲染到聊天区域（含工具调用卡片）
    │
    ▼
  保存会话 → SQLite → 自动提取记忆（≥6 条消息时触发）

③ 工作空间（独立通道）
  AI 建议命令 → 用户确认 → spawn 子进程 → IPC 流式推送 → 终端面板实时展示

④ 数据层（SQLite）
  sessions · messages · tool_calls · memories(FTS5) · settings · traces
```

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron 应用                             │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    渲染进程 (Renderer)                        │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │ │
│  │  │  chat-area  │  │ input-area   │  │  workspace-panel   │ │ │
│  │  │  消息渲染    │  │ 消息发送      │  │  💻 终端            │ │ │
│  │  │  工具卡片    │  │ 记忆检索      │  │  📁 文件浏览器      │ │ │
│  │  └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘ │ │
│  │         │               │                     │            │ │
│  │  ┌──────┴───────────────┴─────────────────────┴──────────┐ │ │
│  │  │                    核心服务层                          │ │ │
│  │  │  agent-engine  memory-manager  vector-memory         │ │ │
│  │  │  tool-registry  vector-store  context-manager        │ │ │
│  │  └──────────────────────────┬────────────────────────────┘ │ │
│  │                             │                              │ │
│  │  ┌──────────────────────────┴────────────────────────────┐ │ │
│  │  │    ollama.ts (API)    (SQLite via IPC)                 │ │ │
│  │  └──────────────────────────┬────────────────────────────┘ │ │
│  └─────────────────────────────┼──────────────────────────────┘ │
│                                │ IPC                            │
│  ┌─────────────────────────────┴──────────────────────────────┐ │
│  │                    主进程 (Main)                             │ │
│  │  main.ts  menu.ts  tray.ts  ipc.ts  preload.ts            │ │
│  │  tool-handlers.ts (25 工具)  tool-security.ts  workspace.ts│ │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │  db/sqlite.ts: sql.js (WASM) · WAL · FTS5           │  │ │
│  │  │  workspace.ts: spawn 进程管理 · 流式输出 · 安全检查   │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📥 下载

从 [Releases](https://gitee.com/thzxx/metona-ollama-desktop/releases) 页面下载：

| 文件 | 类型 |
|------|------|
| `Metona Ollama Setup 4.0.0.exe` | NSIS 安装包（可选目录、创建快捷方式） |

> ⚠️ v3.2.0 起不再提供便携版，仅保留 NSIS 安装包。
>
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
git checkout metona-ollama-desktop-v4.0.0

# 安装依赖（国内使用 npmmirror 加速）
npm config set registry https://registry.npmmirror.com
npm install

# 恢复构建缓存（Electron 二进制等，首次从镜像下载）
bash restore-build-cache.sh

# 构建 TypeScript
npm run build

# 开发运行
npm start

# 构建 Windows 安装包
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

> 💡 Linux 交叉编译需安装 Wine：`apt install wine`，详细构建指南见 [docs/BUILD.md](docs/BUILD.md)
>
> 💡 一键构建脚本：`bash build-release.sh`（自动安装 Wine + 依赖 + 构建）

### 常用命令

```bash
npm run build:renderer   # 仅构建渲染进程（Vite）
npm run build:main       # 仅构建主进程（tsc）
npm run build            # 构建全部
npm start                # 构建并运行
npm run dist             # 构建 Windows 安装包（NSIS）
npm run dist:nsis        # 仅 NSIS 安装包
```

---

## 📁 项目结构

```
metona-ollama-desktop/
├── src/
│   ├── main/                              # Electron 主进程
│   │   ├── main.ts                        # 应用入口、窗口管理、workspace 初始化
│   │   ├── preload.ts                     # contextBridge 安全暴露（含 workspace/DB API）
│   │   ├── menu.ts                        # 原生菜单
│   │   ├── tray.ts                        # 系统托盘
│   │   ├── ipc.ts                         # IPC（Tool Calling + Workspace + SQLite）
│   │   ├── utils.ts                       # 工具函数
│   │   ├── tool-handlers.ts               # 🔧 25 个工具实现
│   │   ├── tool-security.ts               # 🔧 路径/命令安全检查
│   │   ├── workspace.ts                   # 🖥️ spawn 进程管理、流式输出
│   │   └── db/
│   │       └── sqlite.ts                  # 📦 SQLite 数据库（sql.js WASM, WAL, FTS5）
│   └── renderer/                          # 渲染进程
│       ├── index.html                     # 入口 HTML
│       ├── main.ts                        # 入口（全系统初始化）
│       ├── types.d.ts                     # 完整类型定义
│       ├── api/
│       │   └── ollama.ts                  # Ollama REST API 客户端
│       ├── components/
│       │   ├── chat-area.ts               # 消息渲染、工具调用卡片、导出
│       │   ├── input-area.ts              # 消息发送、记忆检索、自动提取
│       │   ├── workspace-panel.ts         # 🖥️ 工作空间面板（终端+文件）
│       │   ├── memory-modal.ts            # 🧠 记忆管理面板
│       │   ├── tool-confirm-modal.ts      # 🔧 工具确认对话框
│       │   ├── tools-modal.ts             # 🔧 工具列表面板
│       │   ├── settings-modal.ts          # 设置面板
│       │   ├── history-modal.ts           # 历史记录
│       │   ├── prompt-modal.ts            # 自定义弹窗
│       │   ├── header.ts                  # 顶部导航
│       │   ├── model-bar.ts               # 模型选择栏
│       │   ├── toast.ts                   # 通知
│       │   └── lightbox.ts                # 图片预览
│       ├── services/
│       │   ├── agent-engine.ts            # 🔧 ReAct Agent Loop 引擎
│       │   ├── tool-registry.ts           # 🔧 工具注册调度（25 个工具）
│       │   ├── memory-manager.ts          # 🧠 记忆管理核心
│       │   ├── vector-memory.ts           # 🧠 记忆向量索引（IVF）
│       │   ├── vector-store.ts            # 向量存储 + IVF 索引
│       │   ├── context-manager.ts         # 上下文窗口管理
│       │   ├── document-processor.ts      # 文档分块
│       │   ├── log-service.ts             # 结构化执行日志
│       │   └── crypto.ts                  # AES-256-GCM 加密
│       ├── utils/
│       │   ├── utils.ts                   # 工具函数
│       │   ├── sanitizer.ts               # HTML 净化器
│       │   └── marked-config.ts           # Markdown 渲染
│       ├── state/
│       │   └── state.ts                   # 响应式状态管理
│       └── styles/
│           └── style.css                  # 暖色调亮色主题样式
├── assets/icons/                          # 图标资源
├── docs/
│   ├── BUILD.md                           # 构建指南
│   ├── CHANGELOG.md                       # 更新日志
│   └── DEVELOPMENT.md                     # 开发规范
├── vite.config.ts                         # Vite 配置
├── tsconfig.json / tsconfig.main.json     # TypeScript 配置
├── package.json                           # 项目配置 + electron-builder
└── README.md
```

---

## 🔌 Ollama API 接口

| 接口 | 用途 | 调用位置 |
|------|------|----------|
| `GET /api/tags` | 已安装模型列表 | 模型选择栏 |
| `GET /api/ps` | 运行中模型 | 设置面板 |
| `GET /api/version` | Ollama 版本 | 连接检测 |
| `POST /api/show` | 模型详情（能力检测） | Think/Vision 检测 |
| `POST /api/chat` | 流式聊天（支持 tools） | 对话 / Agent Loop |
| `POST /api/embed` | 生成嵌入向量 | 向量记忆 |

---

## ⚙️ 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| Ollama 服务地址 | `http://127.0.0.1:11434` | 本地 Ollama 地址 |
| 上下文长度 | 24576 tokens | `num_ctx`，越大记忆越长 |
| 温度 | 0.7 | 0=精确，2=创意 |
| Think 模式 | 关闭 | 深度推理（需模型支持） |
| 工具调用 | 关闭 | AI 主动调用本地工具 |
| 命令执行 | 需确认 | Shell 命令执行模式：自动/需确认/禁用 |
| Agent 记忆 | 开启 | 自动学习+跨会话记忆 |
| 工作空间目录 | `userData/workspace` | 命令行默认执行目录 |

---

## 🛠️ 技术栈

- **TypeScript 5.7** — 严格类型，完整接口定义
- **Electron 33** — 桌面封装（Windows x64）
- **Vite 5** — 渲染进程构建、HMR 热更新
- **sql.js 1.11** — SQLite WASM 实现（零原生依赖，无需编译）
- **Fetch + ReadableStream** — 流式 NDJSON 解析
- **CSS Variables** — 暖色调亮色主题
- **electron-builder** — NSIS 安装包
- **零外部依赖** — Markdown 解析器、SHA-256、HTML 净化器全部内联实现

---

## 🔒 安全

### 应用安全
- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- Markdown 链接仅允许 `http:` / `https:` / `mailto:` / `tel:`
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- contextIsolation + IPC 白名单 + 单实例锁

### Tool Calling 安全
- **路径黑名单**：自动屏蔽 `/etc`, `/sys`, `/proc`, `~/.ssh`, `~/.gnupg` 等
- **写操作白名单**：仅允许用户目录下的写入
- **命令黑名单**：`rm -rf /`, `mkfs`, `dd`, `shutdown`, 反弹 shell 检测等
- **run_command 三模式**：自动执行 / 需确认 / 禁用，用户可随时切换
- **安全提示词注入**：自动向 system prompt 追加工具使用安全规则

### 工作空间安全
- **IPC 双向通信**：`on/send` 模式，不走 `invoke/handle`，无超时但有独立进程管理
- **命令安全检查**：复用 Tool Calling 的命令黑名单和路径检查
- **目录限制**：文件浏览器仅允许在工作空间目录内浏览
- **进程生命周期**：窗口关闭时自动 `SIGTERM` 所有子进程

### 数据安全
- SQLite 本地存储，不上传任何服务器
- 记忆提取仅基于对话内容，不读取文件系统
- 用户可随时查看、编辑、删除任意记忆条目

---

## 📋 更新日志

完整更新日志请查看 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 📄 License

MIT
