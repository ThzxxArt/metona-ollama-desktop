# 测试指南（0.18.0）

## 1. 分层

| 层级 | 内容                                                                                                                    | 位置                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 单元 | URL 归一化、认证头、上下文钳制、卸载策略、备份加解密、18 工具 schema                                                    | `tests/*.test.ts`                                         |
| 工具 | `browser` 9 action、`file_transfer`、`read_file.paths`、`list_directory.format=tree`、`session.action`、工具总数 === 18 | `tests/tools-consolidated.test.ts`                        |
| 契约 | zod IPC schema                                                                                                          | `tests/ipc-contract.test.ts`                              |
| 回归 | Plan Mode 完全移除、temperature 不存在                                                                                  | `tests/plan-mode-removed.test.ts`、`check:no-temperature` |
| 回归 | IPC 发送方校验覆盖全部通道                                                                                              | `tests/ipc-trust.test.ts`                                 |
| 回归 | SQLite upsert 不级联删除子表                                                                                            | `tests/db-safety.test.ts`                                 |
| E2E  | Playwright Electron：设置、连接、工具面板                                                                               | `tests/e2e/*.spec.ts`                                     |

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

- 测试文件：75
- 通过：1613（2 skipped）
- 跳过：2
- 单元覆盖率（全仓 `src/**/*.ts`）：statements 94.95% / branches 85.21% / functions 95.17% / lines 95.83%
- E2E 合并后覆盖率：statements 98.89% / branches 86.21% / functions 95.79% / lines 99.17%

## 4. 覆盖率门槛

CI 对**整个 `src/**/*.ts`** 强制执行 v8 覆盖率门槛，不排除 UI、Electron 入口或工具层：

```text
statements ≥ 85%
lines      ≥ 85%
functions  ≥ 85%
branches   ≥ 85%
```

`vitest.config.ts` 的 include 只有 `src/**/*.ts`，exclude 只有 `**/*.d.ts`。任何文件都不能靠排除来抬高覆盖率。

E2E 覆盖率通过 Playwright `page.coverage` 采集 renderer V8 数据，通过 `NODE_V8_COVERAGE` 采集 Electron main 进程数据；`npm run test:e2e:coverage` 负责采集，`npm run coverage:merge` 负责：

1. 用 source map 把 bundle 覆盖率映射回 `src/**/*.ts`；
2. 以 Vitest 的 statement/branch/function map 为唯一分母，把 E2E 覆盖到的相同源码位置标记为已覆盖（避免 bundle source map 与源码 statement id 不同导致分母翻倍）；
3. 重新执行四项 85% 门槛并生成 `coverage/merged/`。

## 5. 新增测试约定

- 纯函数放 `src/shared/*`，便于在 Node 环境直接测试。
- 不依赖 Electron 的模块优先抽成纯函数。
- Ollama 集成测试使用本地 mock HTTP server，覆盖 NDJSON、401/404/429、abort、卸载。
- 工具测试必须断言 `TOOL_DEFINITIONS.length === 18`。
- 任何新工具合并都要补 schema/action 分支测试。
- 不允许用 `.skip`、排除文件、降低阈值、`v8 ignore` 或删除测试来达标。

## 6. CI

`.github/workflows/ci.yml`：

1. Node 24
2. `npm ci`
3. `npm run lint`
4. `npm run format:check`
5. `npm run check:no-temperature`
6. `npm run typecheck`
7. `npm run test:coverage`（全仓单测门槛）
8. `npm run build`
9. E2E + V8 覆盖率（xvfb）
10. `npm run coverage:merge`（单元 + E2E 合并门槛）
