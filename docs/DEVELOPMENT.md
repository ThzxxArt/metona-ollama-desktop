# 开发指南（0.18.0）

## 1. 环境

| 工具 | 版本 |
|---|---|
| Node.js | 24+ |
| npm | 12+ |
| Electron | 45.2.3 |
| TypeScript | 6.0.3 |
| Vite | 8.3.7 |
| Vitest | 5.1.0 |
| Ollama | 0.40+ |

```bash
git clone https://github.com/ThzxxArt/metona-ollama-desktop.git
cd metona-ollama-desktop
npm ci
```

> Electron 安装脚本会下载对应平台二进制。若网络受限，可设置 `ELECTRON_MIRROR` 后重试 `npm rebuild electron`。

## 2. 常用命令

```bash
npm run dev:renderer    # Vite 监听
npm run dev:main        # tsc 监听主进程
npm run build           # 渲染 + 主进程
npm start               # 构建后启动 Electron
npm run typecheck       # 渲染 + 主进程类型检查
npm test                # Vitest
npm run test:coverage   # 覆盖率
npm run test:e2e        # Playwright（Linux 需 xvfb）
npm run lint            # ESLint
npm run format:check    # Prettier
npm run check:no-temperature
npm run dist:win / dist:linux / dist:mac
```

## 3. 目录

```text
src/
  shared/
    contracts/          # 主进程 / preload / 渲染进程共享类型
    schemas/            # zod IPC 校验
  main/
    main.ts             # 主进程入口、CSP、窗口、退出卸载
    ipc.ts              # IPC 注册入口（49 行）
    ipc/
      register.ts       # 发送方校验 / zod / 日志脱敏
      app.ts            # 对话框 / 系统信息 / 更新检查
      ollama.ts         # Ollama 代理与流式
      tools.ts          # 工具 + 工作空间
      db.ts             # 数据库 / 会话 / 设置 / 统计
      memory.ts         # MEMORY.md
      mcp.ts            # MCP
      media.ts          # 视频帧
      shared.ts         # 日志桥
    ollama/
      config.ts         # 模式 / URL / 上下文 / 持久化
      secret-store.ts   # safeStorage
      client.ts         # 请求 / NDJSON / 错误 / 卸载
      errors.ts
    db/
      sqlite.ts         # node:sqlite + WAL + 破坏性重建
    tools/
      command.ts        # run_command
      web.ts            # web_fetch / web_search
      system.ts         # download_file / compress
    preload.ts          # 领域白名单桥
    menu.ts             # 原生菜单（版本用 app.getVersion）
    tool-dispatch.ts    # 18 工具主进程分发
    tool-handlers-*.ts  # 文件 / Git
    browser.ts          # Playwright 浏览器控制
    mcp-manager.ts      # MCP
    workspace.ts        # 工作空间进程
  renderer/
    main.ts             # 入口
    index.html          # 布局 / 设置 / 帮助 / 工具面板
    api/ollama.ts       # 主进程代理的薄封装
    features/settings/  # connection.ts / data.ts
    services/
      agent-engine.ts   # 8 状态 Agent Loop 编排器
      agent/            # state/runtime/prompt/stream/tool-planning/trace/stats
      agent/states/     # init/parsing/executing/observing/reflecting/compressing
      context/          # tokenizer/builder/compressor/metrics/session-summary/checkpoint
      tools/            # catalog/validate/format/analytics
      tool-registry.ts  # 18 工具调度（400 行）
      context-manager.ts# 公共导出 barrel
      memory-service.ts # MEMORY.md + 混合检索
      sub-agent.ts
    components/         # 原生 DOM 组件
    db/chat-db.ts       # 桌面端仓储（无 IndexedDB）
tests/                  # Vitest
docs/                   # 架构 / 安全 / API / 测试
```

## 4. 连接层

- 设置键：`ollama.connection`（新键，不读取旧 `serverUrl`）。
- Key：`userData/ollama-secret.bin`，`safeStorage`。
- 所有请求走 `src/main/ollama/client.ts`。
- 渲染进程 `OllamaAPI` 只调用 `window.metonaDesktop.ollama`。
- 流式用 `streamId` + `AbortController`，16ms 合并 chunk。

新增 Ollama 端点时：

1. 在 `client.ts` 添加请求函数。
2. 在 `ipc/ollama.ts` 注册 `handleTrusted`。
3. 在 preload / contracts 添加桥方法。
4. 在 `renderer/api/ollama.ts` 暴露。
5. 补认证头与错误分类测试。

## 5. 数据库

- `node:sqlite`，WAL，`foreign_keys=ON`，`busy_timeout=5000`。
- 0.18.0 不读取旧库；通过 `metona-0.18.schema` 标记区分新库。
- 新表：`memory_embeddings(entry_id, model, vector BLOB, updated_at)`。
- 不要恢复 `sql.js`、`METONA_DB_ENGINE`、IndexedDB fallback。

## 6. Agent Loop

8 状态：

```text
INIT → THINKING → PARSING → EXECUTING → OBSERVING
     → REFLECTING → COMPRESSING → TERMINATED
```

- 不发送 `temperature`。
- Think 档位：`false / low / medium / high`。
- 压缩与记忆提取使用 `format` JSON Schema。
- 不包含 Plan Mode、`plan_track`、计划确认、断点续传。

## 7. 工具

- 定义：`src/renderer/services/tool-registry.ts`。
- 执行：`src/main/tool-dispatch.ts`。
- 新增工具需要同时改两处，并补：
  - schema 必填/枚举
  - action 分支
  - 工具总数断言
  - README / 帮助面板
- 工具总数固定 **18**；旧名称不注册、不解析。
- 写操作加入 `MODE_TOOLS`，默认需确认。

## 8. 安全

- `sandbox: true`、CSP、`contextIsolation`。
- IPC 必须 `handleTrusted` + zod。
- 文件工具走路径沙箱；URL 工具走 `net-guard`。
- 日志用 `redactLog()`。
- Key 不进入渲染进程。

详见 [SECURITY.md](SECURITY.md)。

## 9. 测试

```bash
npm run typecheck
npm test
npm run test:coverage
```

当前基线：24+ 测试文件，340+ 通过，2 跳过。

E2E：

```bash
npm run build
xvfb-run -a npm run test:e2e
```

## 10. 打包

```bash
npm run dist:win     # NSIS
npm run dist:linux   # AppImage + deb
npm run dist:mac     # x64 + arm64 zip
```

产物输出到 `release/`。`electron-builder` 已配置 `--publish never`，本地构建不会自动上传。

## 11. 发布

```bash
git tag v0.18.0
git push origin v0.18.0
```

`.github/workflows/release.yml` 会：

1. 在 Windows / Linux / macOS 矩阵构建。
2. 生成 NSIS、AppImage、deb、mac zip。
3. 生成 `SHA256SUMS.txt`。
4. 创建 GitHub Release。

## 12. 文档

- `README.md` / `README.en.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/OLLAMA-CONNECTION.md`
- `docs/OLLAMA-API.md`
- `docs/TESTING.md`
- `docs/README-STYLE.md`

## 13. 署名

所有作者、维护者、页脚、关于窗口统一为 **ThzxxArt**。不要重新引入旧署名或旧托管平台地址。
