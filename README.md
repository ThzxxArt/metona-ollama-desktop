# Metona Ollama Desktop

> 本地 Ollama AI 桌面客户端 — TypeScript + Electron

## 简介

Metona Ollama Desktop 是一个基于 Ollama 的本地 AI 桌面客户端，支持 Tool Calling、记忆系统、浏览器控制、MCP 协议等能力。数据不离开本机，零配置启动。

## 特性

- 🤖 **ReAct Agent Loop** — Thought → Action → Observation → Reflection 循环，默认最大 85 轮
- 🔧 **38 个内置工具** — 文件系统/命令执行/联网搜索/浏览器/Git/记忆/技能/会话/子代理
- 🧠 **智能记忆系统** — 三类记忆（fact/preference/rule）+ FTS5 全文搜索 + 向量语义搜索 + 安全扫描
- 🌐 **MCP 协议** — JSON-RPC 2.0 over stdio，动态工具发现与执行，Shadowing 防护
- 🔍 **三引擎联网搜索** — Bing + 百度 + Google
- 🖥️ **工作空间面板** — 终端（实时流式输出）+ 文件浏览器一体化
- 🎨 **暖色调 UI** — 奶白 #FAF7F2 + 珊瑚橙 #E8734A，长时间使用不疲劳

## 工具列表

| 分类 | 数量 | 工具 |
|------|------|------|
| 文件系统 | 17 | read_file, write_file, list_directory, search_files, create_directory, delete_file, move_file, copy_file, append_file, edit_file, get_file_info, tree, download_file, diff_files, replace_in_files, read_multiple_files, compress |
| 命令执行 | 1 | run_command（实时流式输出，工作空间终端集成） |
| 联网搜索 | 2 | web_search（Bing + 百度 + Google 三引擎）, web_fetch |
| 浏览器控制 | 8 | browser_open, browser_screenshot, browser_evaluate, browser_extract, browser_click, browser_type, browser_scroll, browser_close |
| Git | 1 | git（init/clone/add/commit/push/pull/diff/log/status/branch/checkout/merge/stash/reset/tag/remote） |
| 记忆管理 | 4 | memory_search, memory_add, memory_replace, memory_remove |
| 技能系统 | 2 | skill_list, skill_view（渐进式加载） |
| 会话管理 | 2 | session_list, session_read |
| 子代理 | 1 | spawn_task（独立上下文 + 超时保护） |

## 架构

```
用户消息 → Agent Loop（ReAct）
              ↓
         记忆检索（FTS5 + 向量搜索）→ 上下文注入
              ↓
         Ollama API（流式响应）
              ↓
         工具调用（38 内置 + MCP 动态）
              ↓
         观察结果 → 反思 → 循环/最终回答
```

### 数据层

- **SQLite (sql.js WASM)**：7 张表（sessions, messages, tool_calls, memories, settings, traces, skills）
- **FTS5 全文搜索**：memories 表支持全文检索
- **WAL 模式 + NORMAL 同步**：零原生依赖，无需 electron-rebuild

### 记忆系统

- **三类记忆**：fact（事实）、preference（偏好）、rule（规则，始终注入）
- **安全扫描**：写入前检测 prompt injection、敏感信息泄露、不可见 Unicode 字符
- **容量管理**：上限 500 条，超限自动清理低价值条目（rule 类型受保护）
- **过期衰减**：90 天未使用的记忆自动降低 importance

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (strict mode) |
| 桌面框架 | Electron 33+ |
| 构建 | Vite（渲染进程）+ tsc（主进程） |
| 数据库 | sql.js (WASM) + FTS5 |
| 第三方库 | marked（Markdown）, DOMPurify（HTML 净化） |
| 打包 | electron-builder (NSIS) |

## 快速开始

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout desktop-v1-stable-release
npm config set registry https://registry.npmmirror.com
npm install
npm start
```

## 构建 Windows 安装包

```bash
# 环境：Ubuntu 24.04 + Node.js v22 + Wine 9.0+
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

产出：`release/Metona Ollama Setup v1-stable-release.exe`（82MB）

## 项目结构

```
src/
├── main/                         # Electron 主进程
│   ├── main.ts                   # 入口、窗口管理
│   ├── preload.ts                # contextBridge API（53 个 invoke + 2 个 send）
│   ├── ipc.ts                    # IPC 处理器
│   ├── browser.ts                # 浏览器控制（8 个工具）
│   ├── mcp-manager.ts            # MCP 协议管理（JSON-RPC 2.0 over stdio）
│   ├── tool-handlers-fs.ts       # 文件系统工具（15 个）
│   ├── tool-handlers-system.ts   # 系统网络工具（6 个）
│   ├── tool-handlers-git.ts      # Git 工具
│   ├── tool-handlers-shared.ts   # 共享工具函数
│   ├── tool-security.ts          # 路径/命令安全检查
│   └── db/sqlite.ts              # SQLite 数据库层（7 张表 + FTS5）
├── renderer/                     # 渲染进程
│   ├── main.ts                   # 入口、全局初始化
│   ├── services/
│   │   ├── agent-engine.ts       # ReAct Agent Loop 引擎
│   │   ├── tool-registry.ts      # 工具注册与调度（38 个内置 + MCP 动态）
│   │   ├── memory-manager.ts     # 记忆管理核心
│   │   ├── vector-memory.ts      # 记忆向量索引（IVF）
│   │   ├── vector-store.ts       # 向量存储
│   │   ├── context-manager.ts    # 上下文窗口管理
│   │   ├── skill-manager.ts      # 技能自动生成
│   │   ├── sub-agent.ts          # 子代理委派
│   │   ├── mcp-client.ts         # MCP 渲染端客户端
│   │   ├── log-service.ts        # 结构化日志
│   │   └── crypto.ts             # AES-256-GCM 加密
│   ├── components/               # UI 组件（14 个）
│   ├── utils/
│   │   ├── utils.ts              # 工具函数
│   │   ├── sanitizer.ts          # HTML 净化器
│   │   └── marked-config.ts      # Markdown 渲染
│   ├── state/state.ts            # 响应式状态管理
│   ├── db/chat-db.ts             # SQLite 渲染端接口
│   ├── styles/style.css          # 暖色调亮色主题
│   └── index.html                # 入口 HTML
└── vendor/                       # 第三方库（marked, DOMPurify）
```

## 推荐记忆规则

以下是使用 Metona Ollama Desktop 时推荐预先写入记忆系统的规则（rule 类型），可帮助 Agent 更高效、更安全地工作：

### 🔧 开发类规则

| 规则 | 说明 |
|------|------|
| `所有日志必须通过 log-service.ts 输出，禁止使用 console.log/error/warn` | 项目铁律，保持日志面板统一 |
| `新增第三方依赖优先 vendor 到 src/vendor/，避免 npm 运行时依赖` | 项目依赖管理策略，sql.js 除外 |
| `所有文件写入和命令执行必须经过 tool-security.ts 安全检查` | 安全底线，防止越权操作 |
| `TypeScript 严格模式，禁止滥用 any，类型定义集中在 types.d.ts` | 代码质量保障 |
| `文件名 kebab-case，类型 PascalCase，变量 camelCase，常量 UPPER_SNAKE_CASE` | 命名规范统一 |

### 🧠 效率类规则

| 规则 | 说明 |
|------|------|
| `联网搜索后必须用 web_fetch 抓取相关 URL 详情，不要只看摘要` | 搜索结果摘要信息有限，抓取原文才能给出准确回答 |
| `执行多步任务时优先使用子代理 spawn_task 分担，避免主会话上下文膨胀` | 保持主会话响应速度 |
| `复杂文件操作前先 list_directory 确认路径结构，再执行具体操作` | 防止路径错误导致意外 |
| `长对话中主动使用 session_list/session_read 回顾历史，避免重复工作` | 利用会话管理工具保持连贯性 |

### 🛡️ 安全类规则

| 规则 | 说明 |
|------|------|
| `禁止执行 rm -rf /、mkfs、dd、shutdown 等破坏性命令` | 硬性安全红线 |
| `写操作仅允许在用户工作目录下进行，系统目录只读` | 路径安全策略 |
| `记忆写入前自动扫描 prompt injection 和敏感信息，发现异常立即拒绝` | 记忆系统安全机制 |
| `MCP 工具注册时自动检测与内置工具重名，防止 Shadowing 攻击` | MCP 安全防护 |

### 💡 使用技巧

| 规则 | 说明 |
|------|------|
| `记忆系统上限 500 条，优先写入高价值信息，低价值内容会自动清理` | 合理利用记忆容量 |
| `rule 类型记忆始终注入上下文，适合放铁律和偏好；fact/preference 按需检索` | 区分记忆类型，提高注入效率 |
| `技能系统会从成功任务中自动学习，遇到重复任务时优先查看已有技能` | 利用技能系统减少重复推理 |

> 💡 **提示**：以上规则可通过 `memory_add` 工具写入，类型设为 `rule`，即可在每次对话中自动注入上下文。

## 许可证

MIT
