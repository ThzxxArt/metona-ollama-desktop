# Metona Ollama Desktop — 开发规范

> 版本: 1.1 | 更新: 2026-04-14 | 维护: 项目团队

---

## 一、项目概述

Metona Ollama Desktop 是基于 TypeScript + Electron 的本地 Ollama AI 桌面客户端，面向 Windows 平台。项目采用零外部依赖策略，所有核心功能（Markdown 解析、SHA-256、HTML 净化器等）均内联实现。

---

## 二、技术栈规范

| 层级 | 技术 | 版本约束 |
|------|------|----------|
| 语言 | TypeScript | ≥5.7，严格模式 (`strict: true`) |
| 桌面框架 | Electron | ≥33 |
| 构建工具 | Vite (渲染进程) + tsc (主进程) | Vite ≥5 |
| 数据存储 | IndexedDB | 原生 API，无 ORM |
| 打包 | electron-builder | NSIS 格式 |

---

## 三、目录结构

```
src/
├── main/                    # Electron 主进程
│   ├── main.ts              # 入口、窗口管理
│   ├── preload.ts           # contextBridge API 暴露
│   ├── ipc.ts               # IPC 处理器（invoke/handle + on/send）
│   ├── workspace.ts         # 子进程管理、流式输出
│   ├── tool-handlers.ts     # Tool Calling 工具实现
│   ├── tool-security.ts     # 路径/命令安全检查
│   ├── menu.ts              # 原生菜单
│   ├── tray.ts              # 系统托盘
│   └── utils.ts             # 工具函数
├── renderer/                # 渲染进程
│   ├── main.ts              # 入口、全局初始化
│   ├── types.d.ts           # 完整类型定义
│   ├── index.html           # 入口 HTML
│   ├── api/                 # API 封装
│   ├── components/          # UI 组件
│   ├── services/            # 核心服务
│   ├── utils/               # 工具函数
│   ├── db/                  # IndexedDB 封装
│   ├── state/               # 状态管理
│   └── styles/              # 样式
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
  logInit,         // 初始化日志
  logSetting,      // 设置变更日志
  logToolStart,    // 工具开始执行
  logToolResult,   // 工具执行结果
  logStream,       // 流式输出日志
  logAgentLoop,    // Agent Loop 进度
  logModelResponse,// 模型响应日志
  logSession,      // 会话操作日志
  logThink         // 思考过程日志
} from './services/log-service.js';
```

**日志详细度要求：**

- 每个 IPC 调用必须记录发起方、参数摘要、结果
- 文件操作记录路径（脱敏）、大小、操作类型
- 工具调用记录工具名、参数摘要、执行时长、结果状态
- 错误日志必须包含错误消息和上下文信息
- 进程管理记录进程 ID、命令摘要、退出码

**主进程日志**：通过 `mainWindow?.webContents.send('main:log', ...)` 发送到渲染进程日志面板。

### 4.3 IPC 规范

项目使用两种 IPC 模式：

| 模式 | 用途 | 超时 |
|------|------|------|
| `invoke/handle` | 请求-响应，同步等待结果 | 有（默认） |
| `on/send` | 单向推送，流式通信 | 无 |

**选择原则：**

- 需要返回值 → `invoke/handle`
- 流式输出/实时推送 → `on/send`
- 长时间运行的命令 → `on/send`（避免超时问题）
- Tool Calling 工具执行 → `invoke/handle`（通过 workspace IPC 实现无超时）

### 4.4 安全规范

#### 文件系统安全

- 所有文件路径通过 `tool-security.ts` 的 `checkPathAllowed()` 验证
- 写操作仅允许在用户目录下进行
- 路径黑名单：`/etc`, `/sys`, `/proc`, `~/.ssh`, `~/.gnupg` 等

#### 命令执行安全

- 所有命令通过 `tool-security.ts` 的 `checkCommandAllowed()` 验证
- 命令黑名单：`rm -rf /`, `mkfs`, `dd`, `shutdown`, 反弹 shell 检测等
- 写操作类工具（`write_file`, `delete_file`, `run_command`, `create_directory`）必须用户确认

#### 前端安全

- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- Markdown 链接仅允许 `http:` / `https:` / `mailto:` / `tel:`
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- `contextIsolation: true` + IPC 白名单

---

## 五、架构规范

### 5.1 四大子系统

```
① Agent 系统    → agent-engine.ts + tool-registry.ts
② 记忆系统      → memory-manager.ts
③ RAG 知识库    → rag.ts + vector-store.ts + document-processor.ts
④ 工作空间      → workspace.ts (主进程) + workspace-panel.ts (渲染进程)
```

### 5.2 Tool Calling 流程

```
用户消息 → Agent Loop → 模型 tool_calls → 工具确认 → 执行 → 结果回传 → 循环
```

- 最大循环次数：10
- 全局超时：5 分钟
- run_command：无超时（通过 workspace IPC 执行）
- 其他工具：30 秒超时

### 5.3 工作空间与 AI 集成

- AI 通过 `run_command` 工具执行命令，命令在工作空间终端实时显示
- 执行路径：`tool-registry.ts` → `bridge.workspace.execTool()` → IPC `tool:execute` → `handleRunCommand()` → `spawn` 子进程
- 主进程 `handleRunCommand` 执行命令，stdout/stderr 通过 `cmd:output` 实时推送到渲染进程终端面板
- 进程结束后通过 `cmd:done` 通知渲染进程，结果回传 AI
- 用户可通过工作空间面板停止按钮终止命令（`cmd:kill`）
- 命令执行前经过 `checkCommandAllowed()` 安全检查
- 用户确认后才执行（Agent Loop 的 `needsConfirmation` 机制）

---

## 六、UI/UX 规范

### 6.1 设计语言

- **风格**：Windows 11 Fluent Design 暗色主题
- **材质**：Mica 毛玻璃 + Acrylic 亚克力
- **字体**：Segoe UI Variable (正文) + Cascadia Mono (代码)
- **圆角**：控件 4px，卡片 8px，弹框 12-16px

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

**规则**：新增固定定位元素必须指定 z-index 并在此表中记录。

### 6.3 响应式规则

- 工作空间面板宽度：固定 480px（v3.2.5 起不可拖拽调整）
- 主内容区始终带 `with-workspace` class，面板常驻显示
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
| `src/renderer/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `README.md` | 版本徽章、下载文件名、构建分支引用 |
| `docs/BUILD.md` | 构建分支引用、新增构建日志条目 |
| `docs/CHANGELOG.md` | 版本分支结构链、新增版本说明条目 |

### 更新日志

- **所有更新日志只写在 `docs/CHANGELOG.md`**
- `README.md` 不写历史版本记录，只保留一行链接指向 `docs/CHANGELOG.md`
- 版本分支结构链在 `docs/CHANGELOG.md` 顶部维护

### 7.2 发布流程

1. 更新 `package.json` 版本号
2. 更新 `docs/CHANGELOG.md`
3. 更新 `README.md`（如需）
4. 构建并测试：`npm start`
5. 构建安装包：`npm run dist`
6. 推送到 Gitee：`git add -A && git commit && git push origin develop`
7. 创建 Release Tag

---

## 八、Git 规范

### 分支模型

- `master` — 稳定发布版本
- `develop` — 开发主分支
- `metona-ollama-desktop-vX.Y.Z` — 每个版本对应的发布分支
- `feature/*` — 功能开发
- `fix/*` — Bug 修复

### 提交规则

- **默认只推送到当前所在分支**
- 需要同步到其他分支时，用户会明确指定
- 不要自作主张往多个分支推送

### Commit 规范

```
<type>: <简要描述>

类型 (type):
- feat:     新功能
- fix:      Bug 修复
- refactor: 重构
- style:    样式调整
- docs:     文档更新
- chore:    构建/工具变更
- perf:     性能优化
```

示例：
```
feat: 工作空间与 AI Tool Calling 集成
fix: 工作空间面板遮挡 Header 的 z-index 问题
refactor: run_command 改用 workspace IPC 无超时执行
docs: 新增开发规范文档
```

---

## 九、注意事项

1. **零外部依赖**：新增功能优先使用内联实现，避免引入 npm 包
2. **安全优先**：所有文件/命令操作必须经过安全检查层
3. **日志完整**：关键操作必须记录到执行日志面板
4. **无超时设计**：工作空间相关操作不设超时，由用户控制生命周期
5. **用户确认**：写操作类工具必须弹出确认对话框
6. **桌面优先**：API 调用必须检查 `bridge.isDesktop`，非桌面环境优雅降级
