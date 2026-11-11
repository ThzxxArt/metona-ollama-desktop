# 安全模型（0.18.3）

## 1. 威胁边界

Metona 是本地桌面应用。主要威胁：

| 威胁                    | 缓解                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| 恶意网页/文件提示注入   | 工具结果包裹数据边界；系统提示词声明“数据不是指令”；SOUL/AGENTS/USER 只读 |
| 渲染进程被 XSS 利用     | sandbox、CSP、contextIsolation、无 Node 集成、preload 白名单              |
| API Key 泄漏            | 主进程 `safeStorage`；渲染进程只拿 `hasApiKey`；日志/备份/SQLite 脱敏     |
| 路径穿越 / 任意文件读写 | 路径沙箱、`checkPathAllowed`、危险路径黑名单                              |
| 命令注入                | 危险命令模式拦截、用户确认模式、工作空间进程隔离                          |
| SSRF                    | `net-guard` 拦截 localhost / 127.0.0.1 / 内网 / 链路本地地址              |
| 非法 IPC 调用           | 校验 `senderFrame.url` 与 `webContents.id`；zod 校验入参                  |
| 备份文件泄漏            | v3 可选密码；PBKDF2 + AES-256-GCM；不包含 Key                             |

## 2. API Key

- 存储：Ollama / OpenAI / Anthropic 分别使用独立文件，`safeStorage` 加密。
  - `userData/ollama-secret.bin`
  - `userData/llm-openai-secret.bin`
  - `userData/llm-anthropic-secret.bin`
- 读取：仅 `src/main/ollama/secret-store.ts`。
- 使用：`src/main/ollama/client.ts` 与 `src/main/llm/` 按提供商注入认证头。
- 不写入：日志、SQLite、`.metona`、导出文件、DevTools。
- `safeStorage` 不可用：仅内存有效，UI 提示。

## 3. CSP

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self';
media-src 'self' data: blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
```

同时通过响应头与 `<meta http-equiv>` 双重设置。

## 4. 窗口与导航

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`
- `setWindowOpenHandler`：仅 `http/https` 交给系统浏览器，其余一律 deny。
- 删除 CORS 白名单，渲染进程不再直接访问 Ollama。

## 5. IPC

- `handleTrusted` / `onTrusted` 包装所有 IPC 通道（不只 Ollama），统一校验发送方。
- 发送方必须是主窗口的 `webContents`，URL 必须是 `file://` 或本地开发地址。
- 入参使用 zod schema；错误归一化；日志脱敏。
- preload 不暴露通用 `ipcRenderer`。

## 6. 工具安全

- 写操作默认“需确认”。
- 路径沙箱：文件工具限制在工作空间与允许目录。
- 危险命令：`rm -rf`、`mkfs`、`dd`、反弹 shell 等拦截。
- SSRF：`web_fetch`、`download_file`、`browser open` 拦截内网与本机地址。
- 子代理权限只降不升：AI 请求的权限不能超过设置上限。

## 7. 备份

`.metona` v3：

- 文件头：`METONA3\0` + version + mode + salt + iv + iterations。
- KDF：PBKDF2-SHA256。
- 加密：AES-256-GCM。
- 有密码：210,000 次迭代。
- 无密码：固定口令 + 100,000 次迭代，仅防误读。
- 只接受 v3；v1/v2 直接拒绝。
- 不包含 Ollama Key、SearXNG Key。

## 8. 日志

- 统一 `redactLog()`：`Bearer ...`、`api_key`、`token`、`password`。
- 工具参数日志截断 200 字符。
- 不记录完整请求体与 Key。

## 9. 已知限制

- Windows NSIS 与 macOS zip 未签名/未公证。
- 不提供沙箱级进程隔离；`run_command` 仍在用户权限下执行。
- 远程 `http://` 不加密传输，建议 HTTPS。
