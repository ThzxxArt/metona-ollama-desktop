# 🦙 Metona Ollama Desktop

基于 TypeScript + Electron 的 [Ollama](https://ollama.com) 桌面 AI Agent客户端，专为 Windows 打造。

> 💻 桌面版仓库 | 🌐 [Web 版历史存档](https://gitee.com/thzxx/metona-ollama-web)

![版本](https://img.shields.io/badge/version-3.3.1--desktop-brightgreen)
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

### 🔧 Tool Calling — AI 本地文件操作（v3.0 新增）
AI 可以在对话中主动调用本地工具来完成任务，所有操作在用户可视化监督下执行：

| 工具 | 说明 | 安全级别 |
|------|------|----------|
| 📄 `read_file` | 读取文件内容（≤1MB，支持行范围） | 自动 |
| ✏️ `write_file` | 写入文件（自动创建父目录） | 需确认 |
| 📁 `list_directory` | 列出目录（支持递归、隐藏文件） | 自动 |
| 🔍 `search_files` | 按文件名/内容搜索（支持扩展名过滤） | 自动 |
| 📂 `create_directory` | 创建目录（递归创建） | 需确认 |
| 🗑️ `delete_file` | 删除文件/目录 | 需确认 |
| 💻 `run_command` | 执行 Shell 命令（无超时，通过工作空间终端执行） | 需确认 |
| 📦 `move_file` | 移动/重命名文件或目录 | 需确认 |
| 📋 `copy_file` | 复制文件或目录 | 需确认 |
| 🌐 `web_fetch` | 抓取网页内容（HTTP/HTTPS，自动提取文本） | 自动 |
| 🔍 `web_search` | 联网搜索（DuckDuckGo/Bing，返回标题+链接+摘要） | 自动 |
| ➕ `append_file` | 追加内容到文件末尾 | 需确认 |
| ✂️ `edit_file` | 查找替换文件中的文本（比重写整个文件高效） | 需确认 |
| ℹ️ `get_file_info` | 获取文件/目录详细信息（大小、日期、权限） | 自动 |
| 🌳 `tree` | 以树形结构展示目录 | 自动 |
| ⬇️ `download_file` | 从 URL 下载文件到本地 | 需确认 |
| 🔀 `diff_files` | 对比两个文件差异（unified diff） | 自动 |
| 🔄 `replace_in_files` | 按 glob 模式批量查找替换多个文件 | 需确认 |
| 📚 `read_multiple_files` | 批量读取多个文件内容 | 自动 |
| 🔖 `git` | Git 操作（status/log/diff/add/commit/push/pull/branch/checkout/merge/stash 等 16 个子操作） | 自动 |
| 🗜️ `compress` | 创建/解压归档（zip/tar.gz） | 需确认 |

**Agent Loop**：用户请求 → 模型返回 tool_calls → 客户端执行 → 回传结果 → 循环直到无工具调用，支持流式 + 并行调用 + 最大 10 轮保护。

> ⚠️ 需要模型支持 Tool Calling（推荐 Qwen3、Llama 3.1+、Mistral）

### 🖥️ 工作空间 — 终端 & 文件浏览器（v3.2 新增）
右侧可折叠面板，提供终端命令行和文件浏览器：

**终端**：
- 终端界面，实时流式显示命令输出（支持 ANSI 颜色）
- 支持长时间运行命令（如 `ollama pull`），**无超时限制**
- 单一终端进程，可随时停止
- `ollama pull` 等进度条实时展示（`\r` 覆盖处理）

**文件浏览器**：
- 浏览工作空间目录，目录树展示
- 点击文件预览内容（带行号）
- 支持上级目录导航、刷新

**工作原理**：
```
用户/AI 建议命令 → 工作空间执行按钮 → 主进程 spawn 子进程
                                          │
                    ┌─────────────────────┘
                    ▼
          IPC 双向通信（on/send 模式，无超时）
                    │
          stdout/stderr 实时推送 → 渲染进程终端面板
                    │
          进程退出 → 通知渲染进程显示退出状态
```

> ⚠️ 与 Tool Calling 的区别：Tool Calling 走 Agent Loop（有超时），工作空间走独立进程（无超时），由用户主动触发。

### 🧠 Agent 记忆系统（v3.0 新增）
AI 会自动从对话中学习并记住关键信息，跨会话持续积累，无需手动配置：

**记忆类型**：
| 类型 | 说明 | 示例 |
|------|------|------|
| 📌 事实 | 关于用户的事实 | "用户正在开发一个 Electron 应用" |
| ⚙️ 偏好 | 用户的偏好习惯 | "喜欢用中文回答，代码风格简洁" |
| 📏 规则 | 应遵守的规则 | "项目中使用 TypeScript 严格模式" |

**工作流程**：
```
会话结束 → LLM 自动提取关键信息 → 去重检测 → 存入 IndexedDB
                                              ↓
新消息发送 → 关键词+标签+重要性检索 → 注入 system prompt
                                              ↓
                               AI 基于记忆提供个性化回答
```

**特性**：
- **自动提取** — 对话 ≥6 条消息后自动触发，LLM 智能识别值得记住的信息
- **智能检索** — 关键词 + 标签 + 重要性加权 + 使用频率 + 时间衰减
- **持久化** — IndexedDB 独立存储，跨会话、跨浏览器重启保留
- **可视化管理** — 记忆面板支持搜索、筛选、编辑、删除
- **完全可控** — 设置中一键开关，不影响其他功能

### 📚 向量记忆（记忆系统的语义检索层）
- 选择嵌入模型（如 `nomic-embed-text`）后，记忆系统启用向量语义搜索
- 记忆条目自动向量化 → IndexedDB 持久化
- IVF 索引优化（K-Means 聚类 + 倒排索引），支持大规模记忆高效检索
- 未选择嵌入模型时退化为关键词匹配检索

### 📦 数据
- 历史记录 IndexedDB 持久化，支持搜索、分页
- 导出格式：Markdown / HTML / TXT / .metona 加密备份
- .metona 格式支持 AES-256-GCM 加密（HTTPS）或 XOR 混淆（HTTP）
- 所有导入/导出均使用 Electron 原生文件对话框（不再依赖浏览器下载）

### 🖥️ 桌面原生
| 特性 | 说明 |
|------|------|
| Fluent Design 主题 | Windows 11 暗色风格，Mica 毛玻璃材质 |
| 执行日志面板 | 左侧面板实时显示应用运行日志（初始化、连接、模型加载、工具调用等），纯运行时不持久化，常驻显示不可关闭 |
| 工作空间面板 | 右侧面板（常驻显示）：终端命令行（实时流式输出，单一终端进程）+ 文件浏览器，固定宽度 480px |
| Token 消耗统计 | Header 实时显示当前会话总 token 消耗 |
| 系统托盘 | 最小化到托盘，双击恢复，右键菜单 |
| 原生菜单 | 文件 / 编辑 / 视图 / 窗口 / 帮助完整菜单 |
| 原生文件对话框 | 文件选择/保存全部使用 Electron 原生对话框，支持文件类型过滤 |
| 系统通知 | Windows 原生通知中心推送 |
| 窗口管理 | 记忆窗口大小位置，支持置顶 |
| 单实例锁 | 防止重复启动 |
| 无 CORS 限制 | 直连本地 Ollama，无需配置 OLLAMA_ORIGINS |

---

## 🏗️ 架构

v3.3 四大子系统协调运作：

```
用户输入消息
    │
    ├─→ ① Agent 记忆检索（关键词 + 向量语义） → 注入 system prompt
    ├─→ ② Tool Calling 检查 → Agent Loop 或普通流式
    │
    ▼
  Ollama API（携带组合后的 system prompt + tools）
    │
    ▼
  流式响应 → 渲染到聊天区域（含工具调用卡片）
    │
    ▼
  保存会话 → 自动提取记忆（≥6 条消息时触发）

③ 工作空间（独立通道）
  AI 建议命令 → 用户确认 → spawn 子进程 → IPC 流式推送 → 终端面板实时展示
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
│  │  │  tool-registry  vector-store  workspace-panel         │ │ │
│  │  └──────────────────────────┬────────────────────────────┘ │ │
│  │                             │                              │ │
│  │  ┌──────────────────────────┴────────────────────────────┐ │ │
│  │  │    ollama.ts (API)    chat-db.ts (存储)                │ │ │
│  │  └──────────────────────────┬────────────────────────────┘ │ │
│  └─────────────────────────────┼──────────────────────────────┘ │
│                                │ IPC                            │
│  ┌─────────────────────────────┴──────────────────────────────┐ │
│  │                    主进程 (Main)                             │ │
│  │  main.ts  menu.ts  tray.ts  ipc.ts  preload.ts            │ │
│  │  tool-handlers.ts (21 个工具)  tool-security.ts  workspace.ts│ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
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
| `Metona Ollama Setup 3.3.1.exe` | NSIS 安装包（可选目录、创建快捷方式） |

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
git checkout metona-ollama-desktop-v3.3.1

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
│   │   ├── preload.ts                     # contextBridge 安全暴露（含 workspace API）
│   │   ├── menu.ts                        # 原生菜单
│   │   ├── tray.ts                        # 系统托盘
│   │   ├── ipc.ts                         # IPC（Tool Calling + Workspace 流式通信）
│   │   ├── utils.ts                       # 工具函数
│   │   ├── tool-handlers.ts               # 🔧 21 个工具实现
│   │   ├── tool-security.ts               # 🔧 路径/命令安全检查
│   │   └── workspace.ts                   # 🖥️ spawn 进程管理、流式输出
│   └── renderer/                          # 渲染进程
│       ├── index.html                     # 入口 HTML（含工作空间面板）
│       ├── main.ts                        # 入口（全系统初始化）
│       ├── types.d.ts                     # 完整类型定义（含 Workspace 类型）
│       ├── api/
│       │   └── ollama.ts                  # Ollama REST API
│       ├── db/
│       │   └── chat-db.ts                 # IndexedDB v2（会话+记忆+向量）
│       ├── state/
│       │   └── state.ts                   # 响应式状态管理
│       ├── components/
│       │   ├── chat-area.ts               # 消息渲染、工具调用卡片
│       │   ├── input-area.ts              # 消息发送、记忆检索、自动提取
│       │   ├── memory-modal.ts            # 🧠 记忆管理面板
│       │   ├── workspace-panel.ts         # 🖥️ 工作空间面板（终端+文件）
│       │   ├── tool-confirm-modal.ts      # 🔧 工具确认对话框
│       │   ├── tools-modal.ts             # 🔧 工具列表面板
│       │   ├── settings-modal.ts          # 设置面板（含工作空间目录）
│       │   ├── history-modal.ts           # 历史记录
│       │   ├── prompt-modal.ts            # 自定义弹窗（替代原生 prompt/confirm）
│       │   ├── header.ts                  # 顶部导航
│       │   ├── model-bar.ts               # 模型选择栏
│       │   ├── toast.ts                   # 通知
│       │   └── lightbox.ts                # 图片预览
│       ├── services/
│       │   ├── memory-manager.ts          # 🧠 记忆管理核心
│       │   ├── vector-memory.ts           # 🧠 记忆向量索引（IVF 索引）
│       │   ├── agent-engine.ts            # 🔧 Agent Loop 引擎
│       │   ├── tool-registry.ts           # 🔧 工具注册调度（21 个工具定义）
│       │   ├── vector-store.ts            # 向量存储 + IVF 索引
│       │   ├── document-processor.ts      # 文档分块
│       │   ├── log-service.ts             # 结构化执行日志
│       │   └── crypto.ts                  # AES-256-GCM 加密
│       ├── utils/
│       │   ├── utils.ts                   # 工具函数
│       │   ├── sanitizer.ts               # HTML 净化器
│       │   └── marked-config.ts           # Markdown 渲染
│       └── styles/
│           └── style.css                  # Fluent Design 样式（含工作空间面板）
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
| 命令执行 | 开启（需确认） | Shell 命令执行（高风险） |
| Agent 记忆 | 开启 | 自动学习+跨会话记忆 |
| 工作空间目录 | `userData/workspace` | 命令行默认执行目录 |

---

## 🛠️ 技术栈

- **TypeScript 5.7** — 严格类型，完整接口定义
- **Electron 33** — 桌面封装（Windows x64）
- **Vite 5** — 渲染进程构建、HMR 热更新
- **IndexedDB** — 异步持久化（会话 + 向量 + 记忆）
- **Fetch + ReadableStream** — 流式 NDJSON 解析
- **CSS Variables** — 暗色主题，毛玻璃效果
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
- **用户确认**：写入/删除/命令执行必须用户确认
- **安全提示词注入**：自动向 system prompt 追加工具使用安全规则

### 工作空间安全
- **IPC 双向通信**：`on/send` 模式，不走 `invoke/handle`，无超时但有独立进程管理
- **命令安全检查**：复用 Tool Calling 的命令黑名单和路径检查
- **目录限制**：文件浏览器仅允许在工作空间目录内浏览
- **进程生命周期**：窗口关闭时自动 `SIGTERM` 所有子进程，防止进程泄漏
- **用户控制**：命令由用户手动执行或确认，AI 仅建议不直接执行

### 记忆系统安全
- 记忆提取仅基于对话内容，不读取文件系统
- 记忆存储在本地 IndexedDB，不上传到任何服务器
- 用户可随时查看、编辑、删除任意记忆条目
- 支持一键关闭自动记忆功能

---

## 📋 更新日志

完整更新日志请查看 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

---

## 📄 License

MIT
