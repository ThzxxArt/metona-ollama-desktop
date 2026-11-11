# LLM 连接指南（0.18.4）

Metona 支持五种连接：

| 提供商 / 模式 | 默认地址 | API Key | 自动卸载 |
|---|---|---|---|
| Ollama 本地 | `http://127.0.0.1:11434` | 不需要 | 新建会话 / 退出时 |
| Ollama 自建远程 | 用户填写 | 可选 | 默认开启，可关闭 |
| Ollama Cloud | `https://ollama.com` | 必填（通常） | 禁止 |
| OpenAI 兼容 | `https://api.openai.com` | 按服务要求 | 不适用 |
| Anthropic 兼容 | `https://api.anthropic.com` | 按服务要求 | 不适用 |

## 1. 设置面板

```text
[ Ollama ▼ ]                    ← 提供商：Ollama / OpenAI 兼容 / Anthropic 兼容
[ 本地 ▼ ]  [ http://127.0.0.1:11434................ ]

远程 / 第三方模式展开：
[ API Key（可选）·························· ] [显示] [清除]
✓ Ollama Cloud   ○ 自建远程
☑ 新建会话 / 退出时释放远程模型（仅自建远程）

第三方提供商额外显示：
[ 模型名称（第三方提供商）··············· ] [使用]

Agent 参数：
[ 上下文长度 131072 ] ≈ 128K
[ 最大输出 Token 4096 ] ≈ 4K

[ 测试连接 ]  ✓ Ollama 0.40.16 · 42 个模型 · 42ms
```

上下文长度以设置值为准；模型标称上限仅作参考，允许手动超过（服务端可能拒绝或截断）。

最大输出 Token 的映射：

| 提供商 | 实际参数 |
|---|---|
| Ollama | `options.num_predict` |
| OpenAI 兼容 | `max_tokens`；o1/o3/o4/gpt-5 等推理模型使用 `max_completion_tokens` |
| Anthropic 兼容 | `max_tokens`（必填） |

- 提供商下拉框在地址输入框上方；切换后立即保存。
- Ollama 本地模式隐藏 Key 与卸载开关。
- OpenAI / Anthropic 兼容模式隐藏 Ollama Cloud / 自建远程选项，只保留 Base URL、API Key 与模型名。
- Ollama Cloud 禁用自动卸载，并显示“云端模型由服务端管理”提示。
- 测试连接：Ollama 请求 `/api/version` + `/api/tags`；OpenAI / Anthropic 请求 `/v1/models`。

## 2. 本地

```bash
ollama serve
ollama pull qwen3:8b
```

默认无需任何配置。Metona 会在新建会话与退出时释放本地模型显存。

## 3. 自建远程

```bash
# 仅监听内网，前面放 HTTPS 反向代理
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

建议：

- 使用 HTTPS，避免 Key 与对话明文传输。
- 如果服务器被多人共享，关闭“新建会话/退出时自动卸载”，避免影响其他用户。
- 手动“释放显存”会二次确认。

卸载流程：

1. `GET /api/ps` 获取运行中模型。
2. 对每个模型 `POST /api/generate`，`keep_alive: 0`。
3. 请求携带 `Authorization: Bearer`（如有 Key）。
4. 退出时 5 秒超时，失败不阻塞。

## 4. Ollama Cloud

1. 在 <https://ollama.com> 创建 API Key。
2. 设置 → 远程 → `https://ollama.com` → Ollama Cloud。
3. 填写 Key → 测试连接。

云模型：

- 不执行自动卸载。
- 手动释放显存会提示“不支持”。
- `/api/tags` 中带 `remote_model` / `remote_host` 的模型显示 ☁️。

## 5. OpenAI / Anthropic 兼容接口

### OpenAI 兼容

- Base URL 示例：`https://api.openai.com`、`https://api.deepseek.com`、`https://openrouter.ai/api/v1`。
- 实际请求：`POST {base}/v1/chat/completions`；如果 Base URL 已以 `/v1` 结尾，不会重复拼接。
- 模型列表：`GET {base}/v1/models`。
- Embeddings：`POST {base}/v1/embeddings`，用于混合记忆检索。
- 认证：`Authorization: Bearer <API Key>`。
- 流式输出、`tool_calls`、图片输入、`usage` 用量均会转换为 Metona 内部格式。
- OpenCode Go：自动发送稳定的 `x-opencode-session` 与 `User-Agent: Metona-Ollama-Desktop`，避免 `MissingSessionID`。
- 第三方模型统一按支持图片 / 推理 / 工具处理，不再按模型名禁用上传或 Think 档位。
- OpenAI 兼容：Think 档位原样写入 `reasoning_effort`（`low` / `medium` / `high` / `max`），不再把 `max` 降级为 `high`；OpenCode / DeepSeek 等支持 `max` 的服务可直接使用。
- OpenAI 兼容：最大输出 Token 默认发送 `max_tokens`；若服务端明确要求 `max_completion_tokens`，会自动重试，不在代码里维护模型名清单。

### Anthropic 兼容

- Base URL 示例：`https://api.anthropic.com`，或兼容网关地址。
- 实际请求：`POST {base}/v1/messages`。
- 模型列表：`GET {base}/v1/models`。
- 认证：`x-api-key` + `anthropic-version: 2023-06-01`，同时兼容接受 `Authorization: Bearer` 的网关。
- Anthropic 不提供 embeddings 接口；开启语义记忆时会自动回退关键词检索。

### 手动模型名

如果第三方服务不实现 `/v1/models`，在设置页“模型名称（第三方提供商）”填入模型名并点“使用”，模型会加入顶部下拉框。

## 6. API Key 规则

- Ollama、OpenAI、Anthropic 的 Key 分别加密保存，互不覆盖。
- 未设置：不发送认证头。
- 已设置：Ollama / OpenAI 使用 `Bearer`；Anthropic 使用 `x-api-key`（并兼容 `Bearer`）。
- 已保存时输入框留空 = 保持原值；点“清除”才删除。
- `safeStorage` 不可用时仅当前会话有效。
- Key 不进入渲染进程、日志、SQLite、`.metona` 备份。

## 7. 错误排查

| 现象 | 排查 |
|---|---|
| 401/403 | Key 是否正确、是否有模型权限 |
| 404 | 模型名、地址路径；不要手动拼 `/api` |
| 429 | 降低并发或稍后重试 |
| TLS | 证书链、系统信任、反向代理配置 |
| 连接被拒绝 | 服务是否启动、端口、防火墙、代理 |
| 云模型无法卸载 | 预期行为，云服务由服务端管理 |

## 8. 从 0.17.2 升级

0.18.0 不读取旧 `serverUrl`、`temperature`、`numCtx`，也不读取旧数据库。升级后请：

1. 重新选择本地/远程。
2. 重新填写远程 API Key。
3. 重新设置上下文长度（默认 128K）。
4. 如需保留旧会话，请自行备份原始 `metona.db`；新版本不负责解析。
