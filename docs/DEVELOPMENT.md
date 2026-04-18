# Metona Ollama Desktop — 开发规范

> 版本: 5.1.0 | 更新: 2026-04-18 | 维护: 项目团队

---

## 一、项目概述

Metona Ollama Desktop 是基于 TypeScript + Electron 的本地 Ollama AI 桌面客户端，面向 Windows 平台。项目采用零外部依赖策略（仅 sql.js 为运行时依赖），所有核心功能（Markdown 解析、SHA-256、HTML 净化器等）均内联实现。

---

## 二、技术栈规范

| 层级 | 技术 | 版本约束 |
|------|------|----------|
| 语言 | TypeScript | ≥5.7，严格模式 (`strict: true`) |
| 桌面框架 | Electron | ≥33 |
| 构建工具 | Vite (渲染进程) + tsc (主进程) | Vite ≥5 |
| 数据存储 | sql.js (WASM) | ≥1.11，WAL 模式，FTS5 全文搜索，零原生依赖 |
| 打包 | electron-builder | NSIS 格式 |

---

## 三、目录结构

```
src/
├── main/                         # Electron 主进程
│   ├── main.ts                   # 入口、窗口管理
│   ├── preload.ts                # contextBridge API 暴露
│   ├── ipc.ts                    # IPC 处理器（invoke/handle + on/send）
│   ├── workspace.ts              # 子进程管理、流式输出
│   ├── tool-handlers.ts          # Tool Calling 25 个工具实现
│   ├── tool-security.ts          # 路径/命令安全检查
│   ├── menu.ts                   # 原生菜单
│   ├── tray.ts                   # 系统托盘
│   ├── utils.ts                  # 工具函数
│   └── db/
│       └── sqlite.ts             # SQLite 数据库层（6 张表 + FTS5）
├── renderer/                     # 渲染进程
│   ├── main.ts                   # 入口、全局初始化
│   ├── types.d.ts                # 完整类型定义
│   ├── index.html                # 入口 HTML
│   ├── api/
│   │   └── ollama.ts             # Ollama REST API 客户端
│   ├── components/               # 13 个 UI 组件
│   ├── services/
│   │   ├── agent-engine.ts       # ReAct Agent Loop 引擎
│   │   ├── tool-registry.ts      # 工具注册与调度（25 个工具定义）
│   │   ├── memory-manager.ts     # 记忆管理核心
│   │   ├── vector-memory.ts      # 记忆向量索引（IVF）
│   │   ├── vector-store.ts       # 向量存储 + IVF 索引
│   │   ├── context-manager.ts    # 上下文窗口管理
│   │   ├── document-processor.ts # 文档分块
│   │   ├── log-service.ts        # 结构化日志
│   │   └── crypto.ts             # AES-256-GCM 加密
│   ├── utils/
│   │   ├── utils.ts              # 工具函数
│   │   ├── sanitizer.ts          # HTML 净化器
│   │   └── marked-config.ts      # Markdown 渲染
│   ├── state/
│   │   └── state.ts              # 响应式状态管理
│   └── styles/
│       └── style.css             # 暖色调亮色主题
└── ...
```

---

## 四、代码规范

### 4.1 TypeScript 规范

- **严格模式**：所有文件必须通过 `strict: true` 编译
- **类型定义**：所有接口/类型在 `types.d.ts` 中集中定义，禁止 `any` 滥用
- **命名约定**：
  - 文件名：`kebab-case`（如 `tool-registry.ts`）
  - 类型/接口：`PascalCase`（如 `ToolCallRecord`）
  - 变量/函数：`camelCase`（如 `getEnabledToolDefinitions`）
  - 常量：`UPPER_SNAKE_CASE`（如 `MAX_LOOPS`）
  - 私有成员：`_` 前缀（如 `_workspaceDir`）

### 4.2 日志规范

**核心原则：项目中严禁使用 `console.log/error/warn/debug`。所有日志必须通过 `log-service.ts` 输出。**

日志服务提供以下级别：

```typescript
import { logInfo, logSuccess, logWarn, logError, logDebug } from './services/log-service.js';

logInfo('操作描述', '可选详情');
logSuccess('成功描述', '可选详情');
logWarn('警告描述', '可选详情');
logError('错误描述', '错误详情');
logDebug('调试信息', '可选详情');
```

专用日志函数：

```typescript
import {
  logInit, logSetting, logToolStart, logToolResult,
  logStream, logAgentLoop, logModelResponse,
  logSession, logThink, logMemory, logRAG
} from './services/log-service.js';
```

**主进程日志**：通过 `mainWindow?.webContents.send('main:log', ...)` 发送到渲染进程日志面板。

### 4.3 IPC 规范

| 模式 | 用途 | 超时 |
|------|------|------|
| `invoke/handle` | 请求-响应，同步等待结果 | 有（默认） |
| `on/send` | 单向推送，流式通信 | 无 |

**选择原则**：需要返回值 → `invoke/handle`；流式输出/实时推送 → `on/send`；长时间运行命令 → `on/send`。

### 4.4 安全规范

#### 文件系统安全
- 所有文件路径通过 `tool-security.ts` 的 `checkPathAllowed()` 验证
- 写操作仅允许在用户目录下进行
- 路径黑名单：`/etc`, `/sys`, `/proc`, `~/.ssh`, `~/.gnupg` 等

#### 命令执行安全
- 所有命令通过 `tool-security.ts` 的 `checkCommandAllowed()` 验证
- 命令黑名单：`rm -rf /`, `mkfs`, `dd`, `shutdown`, 反弹 shell 检测等
- `run_command` 支持三种模式（自动/需确认/禁用），用户可随时切换
- 其余 24 个工具均为自动执行，无需用户确认

#### 前端安全
- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- `contextIsolation: true` + IPC 白名单

---

## 五、架构规范

### 5.1 四大子系统

```
① Agent 系统    → agent-engine.ts + tool-registry.ts（25 工具）
② 记忆系统      → memory-manager.ts + vector-memory.ts
③ 向量存储      → vector-store.ts（IVF 索引）
④ 工作空间      → workspace.ts (主进程) + workspace-panel.ts (渲染进程)
⑤ 数据层       → db/sqlite.ts（SQLite, 6 张表, FTS5）
```

### 5.2 ReAct Agent Loop

```
用户消息 → Thought → Action(tool_calls) → Observation(result) → Reflection → 循环 → Final Answer
```

- 最大循环次数：15
- 全局超时：10 分钟
- 工具执行超时：30 秒（run_command 除外，走 workspace 无超时）
- 流式调用超时：2 分钟
- 自动重试：最多 2 次
- **去重机制**：工具调用缓存 + 同轮内重复检测 + 跨轮次重复检测

### 5.3 SQLite 数据库

6 张表，WAL 模式 + NORMAL 同步：

| 表 | 用途 | 关键特性 |
|---|---|---|
| `sessions` | 会话 | parent_id 父子关系 |
| `messages` | 消息 | 外键级联删除，thinking/tool_calls |
| `tool_calls` | 工具调用记录 | 按会话+工具名索引 |
| `memories` | Agent 记忆 | FTS5 全文搜索，向量嵌入 |
| `settings` | 设置 | JSON 序列化 |
| `traces` | ReAct 执行轨迹 | Agent 可观测性 |

### 5.4 联网搜索联动

- web_search 返回搜索结果（标题、URL、摘要），默认 15 条
- TOOL_USAGE_GUIDE 要求模型在 web_search 后必须选择相关 URL 调用 web_fetch 抓取详情
- web_fetch 默认返回完整内容（`max_chars=0`），不截断

### 5.5 工作空间与 AI 集成

- AI 通过 `run_command` 工具执行命令，命令在工作空间终端实时显示
- 执行路径：tool-registry.ts → bridge.workspace.execTool() → IPC → handleRunCommand() → spawn
- stdout/stderr 通过 `cmd:output` 实时推送到渲染进程终端面板

---

## 六、UI/UX 规范

### 6.1 设计语言

- **风格**：暖色调亮色主题
- **背景**：奶白 `#FAF7F2`，卡片白 `#FFFFFF`
- **主色调**：珊瑚橙 `#E8734A`
- **辅助色**：紫色 `#9B7ED8`（Think），金色 `#D4A03C`（Token）
- **字体**：Inter (正文) + JetBrains Mono (代码)
- **圆角**：控件 8px，卡片 12px，弹框 16-20px
- **终端区域**：暖棕深色 `#2D2016`，保证代码可读性

### 6.2 Z-Index 层级规范

| 层级 | 组件 | 值 |
|------|------|----|
| 最高层 | Toast 通知 | 200 |
| 高层 | 模态框 | 100 |
| 中层 | Header | 50 |
| 中层 | Model Bar | 40 |
| 中层 | Input Area | 30 |
| 低层 | 工作空间面板 | 10 |
| 基础 | 日志面板 | 5 |

### 6.3 响应式规则

- 工作空间面板宽度：固定 480px（flex 子元素）
- 模态框宽度：基础 480px，大号 860px

---

## 七、构建与发布

### 7.1 构建命令

```bash
npm run build          # 完整构建
npm run build:renderer # 仅渲染进程 (Vite)
npm run build:main     # 仅主进程 (tsc)
npm start              # 构建并运行
npm run dist           # 构建 Windows 安装包
```

### 版本号更新

更新版本号时，需同步修改以下文件：

| 文件 | 内容 |
|------|------|
| `package.json` | `"version": "X.Y.Z"` |
| `package-lock.json` | 顶层 version 字段（2 处） |
| `src/renderer/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `README.md` | 版本徽章、下载文件名、构建分支引用 |
| `docs/BUILD.md` | 构建分支引用、新增构建日志条目 |
| `docs/CHANGELOG.md` | 版本分支结构链、新增版本说明条目 |
| `docs/DEVELOPMENT.md` | 文件头部版本号 |

### 更新日志

- **所有更新日志只写在 `docs/CHANGELOG.md`**
- `README.md` 不写历史版本记录，只保留一行链接指向 `docs/CHANGELOG.md`

### 7.2 发布流程

1. 更新版本号（同步上述文件）
2. 更新 `docs/CHANGELOG.md`
3. 构建并测试：`npm start`
4. 构建安装包：`npm run dist`
5. 推送到 develop → 合并到 master → 创建版本分支

---

## 八、Git 规范

### 分支模型

- `master` — 稳定发布版本
- `develop` — 开发主分支
- `metona-ollama-desktop-vX.Y.Z` — 版本发布分支
- `feature/*` — 功能开发
- `fix/*` — Bug 修复

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

## 九、注意事项

1. **零外部依赖**：新增功能优先使用内联实现，避免引入 npm 包（sql.js 除外）
2. **安全优先**：所有文件/命令操作必须经过安全检查层
3. **日志完整**：关键操作必须记录到执行日志面板
4. **无超时设计**：工作空间相关操作不设超时，由用户控制生命周期
5. **桌面优先**：API 调用必须检查 `bridge.isDesktop`，非桌面环境优雅降级
