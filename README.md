<p align="center">
  <img src="assets/icons/icon-new.png" alt="Metona Ollama Desktop" width="128">
</p>

<h1 align="center">Metona Ollama Desktop</h1>

<p align="center">
  <strong>本地 AI 桌面客户端</strong> — 基于 TypeScript + Electron，为 Ollama 而生
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v1--stable--release-E8734A?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/electron-33+-47848F?style=flat-square&logo=electron" alt="electron">
  <img src="https://img.shields.io/badge/typescript-5.7+-3178C6?style=flat-square&logo=typescript" alt="typescript">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/platform-Windows%20x64-blue?style=flat-square" alt="platform">
</p>

<p align="center">
  所有 AI 推理均在本地完成，数据不离开本机。<br>
  零配置启动 · 全离线运行 · 暖色调 UI · 系统级集成
</p>

---

## ✨ 特性一览

<table>
<tr>
<td width="50%">

### 🤖 ReAct Agent Loop
Thought → Action → Observation → Reflection 完整循环，最大 85 轮迭代（可配置），支持自动重试、工具调用去重、并行/链式执行。

### 🔧 38 个内置工具
文件系统 · 命令执行 · 联网搜索 · 浏览器控制 · Git · 记忆 · 技能 · 会话 · 子代理

### 🧠 智能记忆系统
三类记忆（fact / preference / rule）+ FTS5 全文搜索 + 向量语义搜索，写入前自动安全扫描，容量管理 + 过期衰减。

</td>
<td width="50%">

### 🌐 MCP 协议扩展
JSON-RPC 2.0 over stdio，动态工具发现与执行，Shadowing 防护，30 秒超时保护。

### 🔍 三引擎联网搜索
Bing + 百度 + Google 聚合搜索，web_search → web_fetch 链式抓取，SPA 页面智能跳过。

### 🖥️ 工作空间面板
终端（实时流式输出）+ 文件浏览器一体化，命令安全检查，三种执行模式。

</td>
</tr>
</table>

---

## 🎨 界面预览

<p align="center">
  <img src="assets/icons/icon-new.svg" alt="Metona Logo" width="64">
</p>

| 设计元素 | 规范 |
|:---:|:---:|
| 背景色 | 奶白 `#FAF7F2` |
| 主色调 | 珊瑚橙 `#E8734A` |
| Think 标识 | 紫色 `#9B7ED8` |
| Token 标识 | 金色 `#D4A03C` |
| 终端区域 | 暖棕深色 `#2D2016` |
| 正文字体 | Inter |
| 代码字体 | JetBrains Mono |

---

## 📦 工具清单

<details>
<summary><strong>文件系统（17 个）</strong></summary>

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
<summary><strong>命令执行（1 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `run_command` | 执行 shell 命令，实时流式输出到工作空间终端，支持自动/需确认/禁用三种模式 |

</details>

<details>
<summary><strong>联网搜索（2 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `web_search` | 三引擎聚合搜索（Bing + 百度 + Google），返回标题、URL、摘要，默认 15 条 |
| `web_fetch` | 网页内容抓取，默认不截断 |

</details>

<details>
<summary><strong>浏览器控制（8 个）</strong></summary>

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
<summary><strong>Git（1 个，17 个子命令）</strong></summary>

| 子命令 | 功能 |
|--------|------|
| `init` `clone` `add` `commit` `push` `pull` | 基础操作 |
| `diff` `log` `status` `branch` `checkout` | 查看与切换 |
| `merge` `stash` `reset` `tag` `remote` | 高级操作 |

</details>

<details>
<summary><strong>记忆管理（4 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `memory_search` | 搜索记忆（FTS5 + 向量语义） |
| `memory_add` | 添加记忆（自动安全扫描） |
| `memory_replace` | 修改记忆 |
| `memory_remove` | 删除记忆 |

</details>

<details>
<summary><strong>技能 / 会话 / 子代理（5 个）</strong></summary>

| 工具 | 功能 |
|------|------|
| `skill_list` | 列出已生成的技能 |
| `skill_view` | 查看技能详情（渐进式加载） |
| `session_list` | 列出历史会话 |
| `session_read` | 读取会话内容 |
| `spawn_task` | 委派子代理（独立上下文 + 超时保护） |

</details>

---

## 🏗️ 架构

```
用户消息
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Engine (ReAct Loop)                              │
│  Thought → Action → Observation → Reflection → 循环     │
│  最大 85 轮 · 自动重试 2 次 · 工具去重 · 并行执行       │
└─────────────────┬───────────────────────────────────────┘
                  │
    ┌─────────────┼─────────────────┐
    ▼             ▼                 ▼
┌────────┐  ┌──────────┐  ┌──────────────┐
│ 记忆   │  │ 技能     │  │ 上下文管理   │
│ FTS5 + │  │ 自动提取 │  │ 滑动窗口 +   │
│ 向量   │  │ Level 0  │  │ LLM 摘要压缩 │
└────────┘  └──────────┘  └──────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Ollama API（流式响应）                                  │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Tool Registry                                          │
│  38 内置工具 + MCP 动态工具                              │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐     │
│  │ FS  │ │ CMD │ │ Web │ │ Git │ │ Mem │ │ MCP │ ... │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘     │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  SQLite (sql.js WASM)                                   │
│  sessions · messages · tool_calls · memories (FTS5)     │
│  settings · traces · skills                             │
│  WAL 模式 · 零原生依赖                                  │
└─────────────────────────────────────────────────────────┘
```

---

## 📂 项目结构

```
src/
├── main/                              # Electron 主进程
│   ├── main.ts                        #   入口、窗口管理
│   ├── preload.ts                     #   contextBridge API（53 invoke + 2 send）
│   ├── ipc.ts                         #   IPC 处理器（70+ 通道）
│   ├── workspace.ts                   #   子进程管理、流式输出
│   ├── tool-handlers.ts               #   Tool Calling re-export
│   ├── tool-handlers-fs.ts            #   17 个文件系统工具
│   ├── tool-handlers-system.ts        #   6 个系统网络工具
│   ├── tool-handlers-git.ts           #   Git 工具
│   ├── tool-handlers-shared.ts        #   共享工具函数和类型
│   ├── tool-security.ts               #   路径/命令安全检查
│   ├── browser.ts                     #   浏览器控制（8 个工具）
│   ├── mcp-manager.ts                 #   MCP 协议管理（JSON-RPC 2.0 over stdio）
│   ├── menu.ts                        #   原生菜单
│   ├── tray.ts                        #   系统托盘
│   ├── utils.ts                       #   工具函数
│   └── db/
│       └── sqlite.ts                  #   SQLite 数据库层（7 张表 + FTS5）
│
├── renderer/                          # 渲染进程
│   ├── main.ts                        #   入口、全局初始化
│   ├── index.html                     #   入口 HTML
│   ├── types.d.ts                     #   完整类型定义
│   ├── api/
│   │   └── ollama.ts                  #   Ollama REST API 客户端
│   ├── services/
│   │   ├── agent-engine.ts            #   ReAct Agent Loop 引擎
│   │   ├── tool-registry.ts           #   工具注册与调度（38 + MCP 动态）
│   │   ├── memory-manager.ts          #   记忆管理核心
│   │   ├── vector-memory.ts           #   记忆向量索引（IVF）
│   │   ├── vector-store.ts            #   向量存储 + IVF 索引
│   │   ├── context-manager.ts         #   上下文窗口管理（自动/手动压缩）
│   │   ├── skill-manager.ts           #   技能自动生成（Level 0）
│   │   ├── sub-agent.ts               #   子代理委派
│   │   ├── cron-manager.ts            #   定时任务
│   │   ├── mcp-client.ts              #   MCP 渲染端客户端
│   │   ├── document-processor.ts      #   文档分块
│   │   ├── log-service.ts             #   结构化日志
│   │   └── crypto.ts                  #   AES-256-GCM 加密
│   ├── components/                    #   14 个 UI 组件
│   ├── utils/
│   │   ├── utils.ts                   #   工具函数
│   │   ├── sanitizer.ts               #   HTML 净化器
│   │   └── marked-config.ts           #   Markdown 渲染配置
│   ├── state/
│   │   └── state.ts                   #   响应式状态管理
│   ├── db/
│   │   └── chat-db.ts                 #   SQLite 渲染端接口
│   └── styles/
│       └── style.css                  #   暖色调亮色主题
│
├── vendor/                            # 第三方库本地化
│   ├── marked.js                      #   Markdown 解析
│   ├── marked.d.ts
│   ├── dompurify.js                   #   HTML 净化
│   └── dompurify.d.ts
│
├── tsconfig.json                      # 渲染进程 TS 配置
├── tsconfig.main.json                 # 主进程 TS 配置
├── vite.config.ts                     # Vite 构建配置
└── package.json
```

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | ≥ 22 |
| npm | ≥ 10 |
| Ollama | 本地运行中（默认 `http://localhost:11434`） |

### 开发运行

```bash
# 克隆项目
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout desktop-v1-stable-release

# 设置 npm 镜像
npm config set registry https://registry.npmmirror.com

# 安装依赖
npm install

# 开发运行
npm start
```

### 构建 Windows 安装包

```bash
# 环境：Ubuntu 24.04 + Wine 9.0+
# 1. 恢复构建缓存（首次 ~145MB）
bash restore-build-cache.sh

# 2. 构建
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

产出文件：`release/Metona Ollama Setup v1-stable-release.exe`

---

## 🗄️ 数据库设计

项目使用 **sql.js (WASM)** 实现零原生依赖的 SQLite 存储，WAL 模式 + NORMAL 同步。

### 表结构

| 表 | 用途 | 关键特性 |
|:---|:---|:---|
| `sessions` | 会话 | `parent_id` 父子关系 |
| `messages` | 消息 | 外键级联删除，`thinking` / `tool_calls` 字段 |
| `tool_calls` | 工具调用记录 | 按会话 + 工具名索引 |
| `memories` | Agent 记忆 | FTS5 全文搜索 + 向量嵌入，容量上限 500 |
| `settings` | 设置 | JSON 序列化 |
| `traces` | ReAct 执行轨迹 | Agent 可观测性 |
| `skills` | 自动生成的技能 | 成功/失败次数、平均时长、summary 字段 |

### FTS5 全文搜索

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags, source,
  content='memories',
  content_rowid='rowid'
);
```

---

## 🧠 记忆系统

### 三种记忆类型

| 类型 | 图标 | 注入策略 | 适用场景 |
|:---:|:---:|:---|:---|
| `fact` | 📌 | 按需检索 | 项目信息、个人背景、技术栈 |
| `preference` | ⚙️ | 按需检索 | 语言偏好、输出风格、格式习惯 |
| `rule` | 📏 | **始终注入** | 行为准则、安全红线、铁律 |

### 记忆生命周期

```
用户对话 → 自动提取 → 安全扫描 → 存储（FTS5 + 向量）
                                      │
用户提问 → 语义检索 → 相关记忆注入上下文 → Agent 使用
                                      │
                              90 天未使用 → 自动衰减 importance
                              超过 500 条 → 自动清理低价值条目
```

### 安全扫描

写入前自动检测：
- Prompt Injection 攻击模式
- 敏感信息泄露（密钥、Token、密码）
- 不可见 Unicode 字符

---

## ⚡ 上下文管理

### 三层策略

```
┌─────────────────────────────────────┐
│  滑动窗口  │  保留首尾各 N 条消息    │
├─────────────────────────────────────┤
│  LLM 压缩  │  中间轮次摘要为 1-2 条  │
├─────────────────────────────────────┤
│  记忆注入  │  FTS5 + 向量检索注入    │
└─────────────────────────────────────┘
```

- **自动压缩阈值**：消息 token 占 context window 50% 时触发
- **手动压缩**：`/compress` 命令
- **Token 估算**：中文 1.5 字/token，英文 4 字符/token

---

## 🔒 安全机制

| 层级 | 措施 |
|------|------|
| 文件系统 | `checkPathAllowed()` — 路径黑名单（`/etc`, `/sys`, `/proc`, `~/.ssh` 等） |
| 命令执行 | `checkCommandAllowed()` — 命令黑名单 + 三种模式（自动/需确认/禁用） |
| 前端渲染 | HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查） |
| Electron | `contextIsolation: true` + IPC 白名单 |
| 数据加密 | AES-256-GCM |
| 记忆安全 | 写入前 Prompt Injection / 敏感信息 / 不可见字符检测 |
| MCP 安全 | Shadowing 防护（MCP 工具不能覆盖内置工具名） |

---

## 🛠️ 常用命令

```bash
npm start              # 构建并运行（开发）
npm run dev:renderer   # Vite watch 模式（渲染进程）
npm run dev:main       # tsc watch 模式（主进程）
npm run build          # 完整构建
npm run build:renderer # 仅渲染进程
npm run build:main     # 仅主进程
npm run pack           # 构建目录（不打包）
npm run dist           # 构建 Windows NSIS 安装包
npm run dist:nsis      # 同上
```

---

## 📋 版本号更新清单

更新版本号时需同步修改以下 **7 个文件**：

| 文件 | 修改内容 |
|------|----------|
| `package.json` | `"version": "X.Y.Z"` |
| `package-lock.json` | 顶层 version 字段（2 处） |
| `src/renderer/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `README.md` | 版本徽章、下载文件名 |
| `docs/BUILD.md` | 构建分支引用 |
| `docs/CHANGELOG.md` | 新增版本条目 |
| `docs/DEVELOPMENT.md` | 文件头部版本号 |

---

## 🌿 Git 规范

### 分支模型

```
master                          ← 稳定发布
develop                         ← 开发主分支
metona-ollama-desktop-vX.Y.Z   ← 版本发布分支
feature/*                       ← 功能开发
fix/*                           ← Bug 修复
```

### Commit 规范

| 前缀 | 用途 |
|------|------|
| `feat:` | 新功能 |
| `fix:` | Bug 修复 |
| `refactor:` | 重构 |
| `style:` | 样式调整 |
| `docs:` | 文档更新 |
| `chore:` | 构建/工具变更 |
| `perf:` | 性能优化 |

---

## 📖 技术文档

项目详细技术文档位于 `docs/` 目录：

| 文档 | 内容 |
|------|------|
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 开发规范、代码规范、架构设计 |
| [`docs/BUILD.md`](docs/BUILD.md) | Windows 安装包构建指南、故障排查 |
| [`docs/OPENCLAW-HERMES-ANALYSIS.md`](docs/OPENCLAW-HERMES-ANALYSIS.md) | 与 OpenClaw / Hermes 的对比分析 |
| [`docs/HERMES-AGENT-DEEP-STUDY.md`](docs/HERMES-AGENT-DEEP-STUDY.md) | Hermes Agent 深度研究 |

---

## 📄 许可证

[MIT](LICENSE)

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://gitee.com/thzxx">thzxx</a></sub>
</p>
