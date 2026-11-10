# Ollama API 参考（0.18.0 / Ollama 0.40.16）

> 适用版本：Metona Ollama Desktop 0.18.0  
> Ollama 基线：**v0.40.16（2026-11-09）**  
> 官方文档：<https://docs.ollama.com/api>  
> 认证文档：<https://docs.ollama.com/api/authentication>

本文只描述 Metona 实际使用的接口与字段。旧版 `docs/ollama-api-docs-20260518.html`（Ollama 0.12.6 快照）已在 0.18.0 删除。

---

## 1. 连接与认证

### 1.1 本地

```text
http://127.0.0.1:11434
```

本地默认不发送 `Authorization`。如果本地 Ollama 前面有反向代理并启用认证，可以在 Metona 中把连接模式设为“远程”并填写 Key。

### 1.2 自建远程

```text
https://ollama.example.com
```

- 支持 `http://`，但不加密传输，建议 HTTPS。
- 地址结尾的 `/api` 会被自动去掉，避免 `/api/api/chat`。
- 不填写 Key 时不发送 `Authorization`，可连接无认证的自建服务。

### 1.3 Ollama Cloud

```text
https://ollama.com
Authorization: Bearer <OLLAMA_API_KEY>
```

- Key 在 <https://ollama.com> 创建。
- 云模型由服务端管理，**不执行 `keep_alive: 0` 卸载**。
- 云模型可能在 `/api/tags` 中返回 `remote_model` / `remote_host`。

### 1.4 请求头规则

```ts
const headers = {
  'Content-Type': 'application/json',
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
};
```

覆盖：`/api/tags`、`/api/version`、`/api/ps`、`/api/show`、`/api/chat`、`/api/embed`、`/api/generate`。

Key 只在主进程读取；渲染进程、日志、SQLite、`.metona` 备份均不可见。

---

## 2. 端点

### 2.1 `GET /api/version`

```json
{ "version": "0.40.16" }
```

Metona 用连接测试同时请求 `/api/version` 与 `/api/tags`，以验证认证与模型列表。

### 2.2 `GET /api/tags`

```json
{
  "models": [
    {
      "name": "qwen3:8b",
      "size": 5230000000,
      "digest": "sha256:...",
      "modified_at": "2026-11-01T12:00:00Z"
    },
    {
      "name": "gpt-oss:120b",
      "remote_model": "gpt-oss:120b",
      "remote_host": "ollama.com"
    }
  ]
}
```

- `remote_model` / `remote_host` 存在时，Metona 显示 ☁️ 云模型徽章。
- 0.18.0 不再把非 completion 模型放进主模型下拉框。

### 2.3 `GET /api/ps`

```json
{
  "models": [
    {
      "name": "qwen3:8b",
      "size_vram": 6100000000,
      "context_length": 131072
    }
  ]
}
```

- `context_length` 用于设置面板“运行中的模型”提示。
- 远程卸载前先调用 `/api/ps`，再对每个模型调用 `/api/generate`（`keep_alive: 0`）。

### 2.4 `POST /api/show`

请求：

```json
{ "model": "qwen3:8b" }
```

响应（节选）：

```json
{
  "capabilities": ["completion", "tools", "thinking"],
  "model_info": {
    "qwen3.context_length": 131072
  }
}
```

Metona 读取：

- `capabilities`：`thinking` / `vision` / `tools` / `completion`
- `model_info.*.context_length`：模型上下文上限

### 2.5 `POST /api/chat`

请求：

```json
{
  "model": "qwen3:8b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "你好" }
  ],
  "stream": true,
  "think": "medium",
  "tools": [],
  "options": { "num_ctx": 131072 }
}
```

说明：

- `stream: true` 时响应为 NDJSON，每行一个 JSON 对象。
- `think` 支持 `false` / `"low"` / `"medium"` / `"high"`（模型支持时）。
- 0.18.0 **不再发送 `temperature`**，把采样权交还模型默认配置。
- `options.num_ctx` 实际值 = `min(用户设置, 模型 context_length)`。
- 工具调用通过 `message.tool_calls` 返回。

流式响应：

```json
{"model":"qwen3:8b","message":{"role":"assistant","content":"你"},"done":false}
{"model":"qwen3:8b","message":{"role":"assistant","content":"好"},"done":false}
{"model":"qwen3:8b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":12,"prompt_eval_count":48,"prompt_eval_cached_count":32,"total_duration":123456789}
```

Metona 处理：

| 字段 | 用途 |
|---|---|
| `done_reason: "length"` | 提示“输出达到模型上限，可继续生成” |
| `prompt_eval_cached_count` | Token 仪表盘缓存命中 tokens |
| `total_duration` | 推理耗时（纳秒） |

### 2.6 `POST /api/generate`

仅用于卸载：

```json
{ "model": "qwen3:8b", "keep_alive": 0 }
```

卸载策略：

- 本地：新建会话 / 退出时释放。
- 自建远程：默认开启，可在设置中关闭；手动“释放显存”不受开关限制。
- Ollama Cloud：跳过。
- 退出时最多等待 5 秒，不阻塞关闭。

### 2.7 `POST /api/embed`

```json
{ "model": "nomic-embed-text", "input": "要检索的文本" }
```

响应：

```json
{ "embedding": [0.0123, -0.0456, ...] }
```

Metona 用于混合记忆检索：

- 关闭时只用关键词/IDF。
- 开启后计算余弦相似度，向量缓存到 SQLite `memory_embeddings`。
- 无 embedding 模型或调用失败时自动回退关键词。

---

## 3. 错误码

| HTTP / 错误 | 分类 | Metona 提示 |
|---|---|---|
| 401 / 403 | `auth` | API Key 无效或权限不足 |
| 404 | `not-found` | 模型不存在或接口路径错误 |
| 429 | `rate-limit` | 请求频率过高，请稍后重试 |
| 5xx | `server` | Ollama 服务异常 |
| TLS / 证书 | `tls` | 证书校验失败，请检查 HTTPS |
| ECONNREFUSED / ENOTFOUND / 超时 | `network` | 无法连接，检查地址/网络/代理 |
| 用户取消 | `aborted` | 请求已取消 |

---

## 4. 与 0.12.6 旧文档的关键差异

| 项目 | 0.12.6 时代 | 0.40.16 / 0.18.0 |
|---|---|---|
| 认证 | 无 | `Authorization: Bearer`（可选） |
| 云模型 | 无 | `remote_model` / `remote_host` |
| 停止原因 | 无 | `done_reason` |
| 缓存 token | 无 | `prompt_eval_cached_count` |
| 运行中上下文 | 无 | `/api/ps` 的 `context_length` |
| 结构化输出 | 有限 | `format` 支持 JSON Schema |
| 思考档位 | 布尔 | `false` / `low` / `medium` / `high` |
| 采样参数 | Metona 硬编码 `temperature` | 不再发送，使用模型默认值 |

---

## 5. 相关文档

- [OLLAMA-CONNECTION.md](OLLAMA-CONNECTION.md) — 本地/远程/Cloud 配置与卸载策略
- [SECURITY.md](SECURITY.md) — Key 存储、CSP、威胁边界
- 官方 API：<https://docs.ollama.com/api>
