# Metona Ollama Desktop v1-stable-release

> 本地 Ollama AI 桌面客户端 — 首个稳定版本

## 项目简介

Metona Ollama Desktop 是一个基于 **Ollama** 的本地 AI 桌面客户端，采用 TypeScript + Electron 构建。所有 AI 推理均在本地完成，数据不离开本机。支持 ReAct Agent Loop、38 个内置工具、智能记忆系统、MCP 协议扩展、三引擎联网搜索、浏览器控制等能力。

---

## 核心功能

### 🤖 ReAct Agent Loop
- Thought → Action → Observation → Reflection 完整循环
- 默认最大 85 轮迭代，支持自动重试（最多 2 次）
- 工具调用去重机制：调用缓存 + 同轮重复检测 + 跨轮次重复检测
- 并行工具调用：互相独立的工具可在同一次回复中同时执行
- 链式工具调用：web_search → web_fetch、list_directory → read_file 等模式
- 文本解析兜底：当模型未通过 tool_calls 返回时，从文本中提取 Action/Input

### 🔧 38 个内置工具

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

### 🧠 智能记忆系统
- **三类记忆**：fact（事实）、preference（偏好）、rule（规则，始终注入上下文）
- **双模式检索**：FTS5 全文搜索 + 向量语义搜索（IVF 索引）
- **安全扫描**：写入前检测 prompt injection、敏感信息泄露、不可见 Unicode 字符
- **容量管理**：上限 500 条，超限自动清理低价值条目（rule 类型受保护）
- **过期衰减**：90 天未使用的记忆自动降低 importance

### 🌐 MCP 协议支持
- JSON-RPC 2.0 over stdio 标准协议
- 动态工具发现与执行
- Shadowing 防护（防止 MCP 工具覆盖内置工具名）
- 30 秒请求超时保护

### 🔍 三引擎联网搜索
- Bing + 百度 + Google 三引擎聚合
- web_search 返回标题、URL、摘要（默认 15 条）
- web_fetch 支持网页内容抓取（默认不截断）
- 工具链规则：搜索后自动引导抓取详情

### 🖥️ 工作空间面板
- 终端（实时流式输出）+ 文件浏览器一体化
- AI 通过 run_command 工具执行命令，输出实时显示
- 命令安全检查：路径黑名单 + 命令黑名单 + 三种执行模式

### 🎨 Token 实时监控仪表盘
- 全局统计（跨会话累计 Token 分析）和当前会话统计双视图
- Token 消耗趋势图（输入/输出分色显示）
- 2 秒自动刷新

### 📊 技能自动生成系统
- 从成功的工具调用链中自动提取可复用技能
- Level 0 简短摘要（~100 tokens），渐进式加载
- 技能匹配与上下文注入

### 🔒 安全机制
- 文件路径安全检查（checkPathAllowed）
- 命令执行安全检查（checkCommandAllowed）
- 前端 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- contextIsolation: true + IPC 白名单
- AES-256-GCM 加密支持

---

## 技术架构

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

### 上下文管理（v5.0）
- 三层策略：滑动窗口 + LLM 摘要压缩 + 记忆注入
- `/compress` 手动触发上下文压缩
- 自动压缩阈值：消息 token 占 context window 50% 时触发
- Token 估算：中文 1.5 字/token，英文 4 字符/token

### 技术栈
| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (strict mode) |
| 桌面框架 | Electron 33+ |
| 构建 | Vite（渲染进程）+ tsc（主进程） |
| 数据库 | sql.js (WASM) + FTS5 |
| 第三方库 | marked（Markdown）, DOMPurify（HTML 净化） |
| 打包 | electron-builder (NSIS) |

---

## 最近改进

- **`/compress` 上下文压缩**：支持手动触发 LLM 摘要压缩，长对话不再丢失上下文
- **Skill 渐进式加载**：技能摘要（Level 0）仅 ~100 tokens，按需加载完整工具链
- **Token 全局统计**：仪表盘新增跨会话累计 Token 分析视图
- **图表重写**：Token 消耗趋势图重写 — 网格线 + 正确高度计算 + 柱子底部对齐
- **Agent Loop 稳定性**：修复 abortController 在自动压缩前未定义的严重 bug
- **工具调用修复**：修复工具卡片状态更新、错误信息显示、执行中状态残留等问题
- **消息渲染修复**：修复用户消息不显示、AI 消息时间戳、思考气泡残留等 UI 问题

---

## 系统要求

- **操作系统**：Windows 10/11（64 位）
- **Ollama**：需要本地运行 Ollama 服务（默认 http://localhost:11434）
- **磁盘空间**：安装包约 82MB，运行时根据模型大小需要额外空间
- **内存**：建议 8GB+（取决于使用的 AI 模型）

---

## 安装说明

1. 下载 `Metona Ollama Setup v1-stable-release.exe`
2. 运行安装程序，可自定义安装目录
3. 确保本地已安装并运行 [Ollama](https://ollama.com)
4. 启动 Metona Ollama，在设置中配置 Ollama 服务地址
5. 选择模型，开始对话

---

## 已知限制

- 仅支持 Windows x64 平台
- 需要本地运行 Ollama 服务，不支持远程 Ollama 服务器（后续版本考虑支持）
- 浏览器控制工具依赖系统 Chromium，部分 SPA 页面抓取可能不完整
- 向量搜索需要配置嵌入模型（embedding model），未配置时仅支持关键词搜索
- MCP 工具目前仅支持 stdio 传输方式
- 子代理（spawn_task）为独立上下文，无法共享主对话记忆
