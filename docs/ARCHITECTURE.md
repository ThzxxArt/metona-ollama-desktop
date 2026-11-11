# 架构说明（0.18.0）

## 1. 分层

```text
Renderer（sandbox + CSP）
  features/chat · features/settings · features/workspace · dashboard
        │
        └── shared contracts + typed IPC
                    │
              preload.ts（薄白名单）
                    │
Main Process
  OllamaService · SettingsService · DatabaseService(node:sqlite)
  ToolService · McpService · WorkspaceService · MediaService
  SecurityService（path / command / net / secrets / sender）
```

- **Renderer** 不直接访问 Ollama、Node、文件系统。
- **Preload** 只暴露领域 API（`ollama`、`db`、`workspace`、`tool`、`mcp`、`media`），不暴露通用 `ipcRenderer`。
- **Main** 统一处理网络、数据库、密钥、工具执行与安全校验。
- **Shared** 存放 contracts 与 zod schemas，主进程与渲染进程共享类型。

## 2. Ollama 连接层

```text
src/main/ollama/
  config.ts        # 模式 / URL 归一化 / 上下文 / 持久化
  secret-store.ts  # safeStorage 加密 Key
  client.ts        # fetch / NDJSON 流 / 错误分类 / 卸载
  errors.ts        # 401/403/404/429/5xx/TLS/网络
src/main/ipc/ollama.ts
```

## 2.1 模块拆分

```text
src/main/ipc/
  register.ts  app.ts  ollama.ts  tools.ts  db.ts
  memory.ts    mcp.ts  media.ts   shared.ts
src/main/window-state.ts   # 主窗口 / 退出状态（打破 main ↔ ipc / menu / tray 循环）
src/main/tools/
  command.ts   # run_command
  web.ts       # web_fetch / web_search
  system.ts    # download_file / compress
src/main/tool-handlers-system.ts  # 兼容入口，re-export

src/renderer/services/agent/
  state.ts  runtime.ts  prompt.ts  stream.ts
  tool-planning.ts  trace.ts  stats.ts  types.ts
  states/{init,parsing,executing,observing,reflecting,compressing}.ts
src/renderer/services/context/
  tokenizer.ts  builder.ts  compressor.ts  metrics.ts
  session-summary.ts  checkpoint.ts  types.ts
src/renderer/services/tools/
  catalog.ts  validate.ts  format.ts  analytics.ts
src/renderer/services/workspace-state.ts  # 无 UI 依赖的工作空间路径
src/renderer/features/settings/
  connection.ts  data.ts
```


请求路径：

```text
Renderer OllamaAPI
  → preload.metonaDesktop.ollama
  → ipcMain 'ollama:*'
  → main/ollama/client.ts
  → 本地 / 自建 / Cloud
```

流式：

1. `ollama:chat:start` 返回 `streamId`。
2. 主进程每 16ms 合并 chunk，通过 `ollama:chat:chunk` 推送。
3. `ollama:chat:abort` 触发 `AbortController`。
4. 完成/失败通过 `ollama:chat:done` 通知，渲染端清理监听器。

## 3. 数据库

- `node:sqlite` 同步 API + WAL。
- 首次启动删除 v0.17.2 `metona.db`，创建全新库；sidecar 标记 `metona-0.18.schema` 防止后续启动误删。
- 表：`sessions`、`messages`、`tool_calls`、`settings`、`traces`、`tool_audit`、`memory_embeddings`。
- `PRAGMA foreign_keys = ON`、`busy_timeout = 5000`。
- 旧 `sql.js`、`METONA_DB_ENGINE=sqljs`、IndexedDB fallback 全部删除。

## 4. Agent Loop

保留 8 状态机：

```text
INIT → THINKING → PARSING → EXECUTING → OBSERVING
     → REFLECTING → COMPRESSING → TERMINATED
```

0.18.0 删除：

- Plan Mode 分支、计划确认、`plan_track`、断点续传。
- `AgentMode`、`LoopContext.mode`、`planApproved`、`planRetries`。

上下文管理：

- 手动 `num_ctx`，实际发送 `min(用户值, 模型上限)`。
- 滑动窗口 + LLM 结构化 JSON 摘要。
- 压缩/记忆提取使用 `format` JSON Schema。

## 5. 工具系统

```text
src/renderer/services/tool-registry.ts   # 18 个定义 + 校验 + 调度
src/main/tool-dispatch.ts                # 主进程执行器
src/main/tool-handlers-*.ts              # 文件/系统/Git 实现
```

- `TOOL_DEFINITIONS` 与实际注册表同源。
- `tools-modal.ts` 动态生成工具卡片。
- `MODE_TOOLS` 仅包含写操作：`run_command`、`write_file`、`delete_file`、`edit_file`、`file_transfer`、`download_file`、`compress`。
- 旧工具名不注册、不解析、不保留别名。

## 6. 状态与事件

- 单例 `state`，类型化 slice：`connection`、`chat`、`agent`、`context`、`ui`。
- 组件统一 `initX()` / `disposeX()`，避免全局监听泄漏。
- 跨组件事件使用 `CustomEvent` / 强类型回调，减少直接依赖。

## 7. 安全边界

- `sandbox: true` + CSP + `contextIsolation`。
- IPC 校验发送方（`senderFrame.url` + `webContents.id`）与 zod 入参。
- 路径沙箱、命令拦截、SSRF 防护。
- 日志脱敏：`Authorization`、`api_key`、`token`、`password`。
- API Key 只在主进程 `SecretStore`。

详见 [SECURITY.md](SECURITY.md)。
