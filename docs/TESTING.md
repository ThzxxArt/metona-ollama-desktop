# 测试指南（0.18.0）

## 1. 分层

| 层级 | 内容 | 位置 |
|---|---|---|
| 单元 | URL 归一化、认证头、上下文钳制、卸载策略、备份加解密、18 工具 schema | `tests/*.test.ts` |
| 工具 | `browser` 9 action、`file_transfer`、`read_file.paths`、`list_directory.format=tree`、`session.action`、工具总数 === 18 | `tests/tools-consolidated.test.ts` |
| 契约 | zod IPC schema | `tests/ipc-contract.test.ts` |
| 回归 | Plan Mode 完全移除、temperature 不存在 | `tests/plan-mode-removed.test.ts`、`check:no-temperature` |
| E2E | Playwright Electron：设置、连接、工具面板 | `tests/e2e/*.spec.ts` |

## 2. 常用命令

```bash
npm run typecheck
npm test
npm run test:coverage
npm run lint
npm run format:check
npm run check:no-temperature
npm run build
```

E2E（Linux 需要 xvfb）：

```bash
npm run build
xvfb-run -a npm run test:e2e
```

## 3. 当前基线

- 测试文件：24+
- 通过：340+
- 跳过：2
- 覆盖率目标：核心模块 70% 行覆盖

## 4. 新增测试约定

- 纯函数放 `src/shared/*`，便于在 Node 环境直接测试。
- 不依赖 Electron 的模块优先抽成纯函数。
- Ollama 集成测试使用本地 mock HTTP server，覆盖 NDJSON、401/404/429、abort、卸载。
- 工具测试必须断言 `TOOL_DEFINITIONS.length === 18`。
- 任何新工具合并都要补 schema/action 分支测试。

## 5. CI

`.github/workflows/ci.yml`：

1. Node 24
2. `npm ci`
3. `npm run lint`
4. `npm run format:check`
5. `npm run check:no-temperature`
6. `npm run typecheck`
7. `npm run test:coverage`
8. `npm run build`
9. E2E（xvfb）
