# Metona Ollama Desktop v3.0 技术开发文档

## Tool Calling — AI 本地文件操作系统

---

## 目录

1. [版本概述](#1-版本概述)
2. [核心概念](#2-核心概念)
3. [Ollama Tool Calling 协议详解](#3-ollama-tool-calling-协议详解)
4. [架构设计](#4-架构设计)
5. [工具定义规范](#5-工具定义规范)
6. [工具实现：主进程](#6-工具实现主进程)
7. [工具实现：渲染进程](#7-工具实现渲染进程)
8. [Agent Loop 引擎](#8-agent-loop-引擎)
9. [UI/UX 设计](#9-uiux-设计)
10. [安全模型](#10-安全模型)
11. [类型定义](#11-类型定义)
12. [文件变更清单](#12-文件变更清单)
13. [测试方案](#13-测试方案)
14. [兼容性与降级](#14-兼容性与降级)
15. [未来扩展](#15-未来扩展)
16. [附录](#16-附录)

---

## 1. 版本概述

### 1.1 目标

在 Metona Ollama v2.0（TypeScript + Electron）基础上，实现 **AI Tool Calling** 功能，使 AI 模型能够在对话中主动调用本地工具来完成任务，核心能力是**本地文件系统操作**。

### 1.2 核心能力

- AI 可以读取、写入、搜索、列出本地文件
- AI 可以创建、删除文件和目录
- AI 可以执行 shell 命令（可选，高风险，默认关闭）
- 所有工具调用在用户可视化监督下执行
- 高风险操作需要用户确认

### 1.3 适用模型

Tool Calling 需要模型本身支持。以下模型已验证支持：

| 模型系列 | Tool Calling 支持 | 推荐 |
|----------|-------------------|------|
| Qwen3 (all sizes) | ✅ 完整支持 | ⭐ 推荐 |
| Llama 3.1 / 3.2 / 3.3 | ✅ 完整支持 | ⭐ 推荐 |
| Mistral / Mixtral | ✅ 完整支持 | |
| Command R+ | ✅ 完整支持 | |
| Phi-4 | ✅ 支持 | |
| Gemma 2 / 3 | ⚠️ 部分支持 | |
| DeepSeek-V3 / R1 | ✅ 支持 | |

### 1.4 技术栈不变

- TypeScript 5.7
- Electron 33
- Vite 5
- Ollama REST API（原生 fetch，不使用 ollama-js SDK）

---

## 2. 核心概念

### 2.1 Tool Calling 是什么

Tool Calling（也叫 Function Calling）是一种让大语言模型（LLM）在生成回答时，能够声明"我需要调用某个工具"的能力。模型本身**不会执行**工具，而是返回一个结构化的调用请求，由客户端执行后把结果返回给模型。

### 2.2 为什么需要 Tool Calling

LLM 的知识截止于训练数据，且无法直接访问外部世界。Tool Calling 让模型能够：
- 获取实时信息（文件内容、系统状态）
- 执行动作（写文件、运行命令）
- 突破上下文窗口限制（按需读取文件而非全部塞入提示词）

### 2.3 Agent Loop（代理循环）

传统的单轮对话：用户 → 模型 → 回答。

Agent Loop 是多轮工具调用循环：

```
用户请求
  ↓
模型返回 tool_calls [read_file("config.json")]
  ↓
客户端执行 read_file → 返回内容
  ↓
模型返回 tool_calls [write_file("config.json", newContent)]
  ↓
客户端执行 write_file → 返回 "写入成功"
  ↓
模型返回最终回答："已更新配置文件，修改了..."
  ↓
循环结束（tool_calls 为空）
```

**关键**：循环终止条件是模型不再返回 `tool_calls`。

### 2.4 流式 + Tool Calling

在流式模式下，tool_calls 的 `arguments` 可能被分成多个 chunk 到达。必须累积所有 chunk 后再解析 JSON：

```typescript
// ❌ 错误：逐 chunk 解析 arguments
for (const chunk of stream) {
  const args = JSON.parse(chunk.tool_calls[0].function.arguments); // 可能不完整！
}

// ✅ 正确：累积后解析
let accumulatedArgs = '';
for (const chunk of stream) {
  accumulatedArgs += chunk.tool_calls[0].function.arguments;
}
const args = JSON.parse(accumulatedArgs); // 完整 JSON
```

---

## 3. Ollama Tool Calling 协议详解

### 3.1 请求格式

```json
{
  "model": "qwen3:8b",
  "messages": [
    {"role": "user", "content": "帮我读一下 package.json 的版本号"}
  ],
  "stream": true,
  "think": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read the contents of a local file",
        "parameters": {
          "type": "object",
          "required": ["path"],
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute or relative file path"
            }
          }
        }
      }
    }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称 |
| `messages` | array | ✅ | 对话历史 |
| `stream` | boolean | ❌ | 是否流式，默认 false |
| `think` | boolean | ❌ | 是否启用推理（需模型支持） |
| `tools` | array | ❌ | 工具定义列表 |

### 3.2 工具定义格式

```json
{
  "type": "function",
  "function": {
    "name": "函数名",
    "description": "函数描述（模型据此决定是否调用）",
    "parameters": {
      "type": "object",
      "required": ["必填参数1", "必填参数2"],
      "properties": {
        "参数名": {
          "type": "string | number | integer | boolean | array | object",
          "description": "参数描述",
          "enum": ["可选值1", "可选值2"],
          "items": { "type": "string" }   // array 类型时需要
        }
      }
    }
  }
}
```

### 3.3 模型响应格式

**普通回答**（无工具调用）：

```json
{
  "model": "qwen3:8b",
  "message": {
    "role": "assistant",
    "content": "这是一个普通的文本回答",
    "thinking": "模型的推理过程（think=true 时）"
  },
  "done": true
}
```

**工具调用**：

```json
{
  "model": "qwen3:8b",
  "message": {
    "role": "assistant",
    "content": "",
    "thinking": "用户想读取文件，我需要调用 read_file 工具...",
    "tool_calls": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": {
            "path": "package.json"
          }
        }
      }
    ]
  },
  "done": true
}
```

### 3.4 流式响应中的 tool_calls

流式模式下，tool_calls 按 chunk 到达：

```json
// chunk 1
{"message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "pack"}}}]}}

// chunk 2  
{"message": {"tool_calls": [{"function": {"arguments": {"age.json"}}}]}}
```

**注意**：Ollama 在流式模式下，`arguments` 对象会被增量发送。需要按 `name` 匹配同一工具调用，累积 `arguments`。

实际上 Ollama 的流式行为是：第一次 chunk 包含 `name` 和部分 `arguments`，后续 chunk 只有 `arguments` 的增量部分。但由于 arguments 是对象，在非流式下已经完整；流式下 Ollama 通常会在一个 chunk 内返回完整的 tool_calls。

### 3.5 回传工具结果

将工具执行结果以 `role: "tool"` 的消息格式添加到 messages 数组：

```json
{
  "role": "tool",
  "tool_name": "read_file",
  "content": "{\"name\": \"metona-ollama-desktop\", \"version\": \"2.0.0\", ...}"
}
```

**关键规则**：
- `role` 必须是 `"tool"`
- `tool_name` 必须与 tool_calls 中的 `name` 一致
- `content` 必须是**字符串**（复杂对象需要 JSON.stringify）
- 每个 tool_call 需要对应的 tool 消息，顺序保持一致

### 3.6 并行工具调用

模型可能一次返回多个 tool_calls：

```json
{
  "tool_calls": [
    {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}},
    {"function": {"name": "read_file", "arguments": {"path": "b.txt"}}}
  ]
}
```

客户端需要**全部执行**后，逐个回传结果：

```json
messages: [
  ...,
  {"role": "assistant", "tool_calls": [...]},
  {"role": "tool", "tool_name": "read_file", "content": "a.txt 的内容"},
  {"role": "tool", "tool_name": "read_file", "content": "b.txt 的内容"}
]
```

### 3.7 Agent Loop 完整流程

```typescript
async function agentLoop(userMessage: string, tools: ToolDefinition[]) {
  const messages: OllamaMessage[] = [{ role: 'user', content: userMessage }];
  
  while (true) {
    // 1. 发送请求
    const response = await ollama.chat({
      model: selectedModel,
      messages,
      tools,
      stream: false,
      think: true
    });
    
    // 2. 添加助手消息
    messages.push(response.message);
    
    // 3. 检查是否有工具调用
    if (!response.message.tool_calls?.length) {
      // 无工具调用 → 循环结束，返回最终内容
      return response.message.content;
    }
    
    // 4. 执行每个工具调用
    for (const call of response.message.tool_calls) {
      const result = await executeTool(call.function.name, call.function.arguments);
      messages.push({
        role: 'tool',
        tool_name: call.function.name,
        content: JSON.stringify(result)
      });
    }
    // 5. 回到步骤 1，继续循环
  }
}
```

---

## 4. 架构设计

### 4.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     渲染进程 (Renderer)                       │
│                                                             │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │  chat-area.ts │  │ tool-call-ui  │  │  tool-panel.ts  │  │
│  │  (消息渲染)    │  │ (工具调用卡片) │  │  (工具面板)      │  │
│  └──────┬───────┘  └───────┬───────┘  └────────┬────────┘  │
│         │                  │                    │           │
│  ┌──────┴──────────────────┴────────────────────┴────────┐  │
│  │                    agent-engine.ts                     │  │
│  │               (Agent Loop 核心引擎)                     │  │
│  │  - 流式消息发送                                          │  │
│  │  - tool_calls 解析                                      │  │
│  │  - 循环控制                                             │  │
│  │  - 消息累积                                             │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────┴──────────────────────────────┐  │
│  │                   tool-registry.ts                     │  │
│  │                 (工具注册与调度中心)                      │  │
│  │  - 工具注册/注销                                        │  │
│  │  - 参数校验                                             │  │
│  │  - 执行调度                                             │  │
│  │  - 权限检查                                             │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │ IPC (invoke)                    │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                    主进程 (Main)                              │
│                           │                                 │
│  ┌────────────────────────┴──────────────────────────────┐  │
│  │                   tool-handlers.ts                     │  │
│  │                 (工具执行器 - 文件操作)                   │  │
│  │  - handleReadFile()                                    │  │
│  │  - handleWriteFile()                                   │  │
│  │  - handleListDir()                                     │  │
│  │  - handleSearchFiles()                                 │  │
│  │  - handleDeleteFile()                                  │  │
│  │  - handleCreateDir()                                   │  │
│  │  - handleRunCommand()                                  │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────┴──────────────────────────────┐  │
│  │                   tool-security.ts                     │  │
│  │                 (安全检查与沙箱)                         │  │
│  │  - 路径白名单/黑名单                                    │  │
│  │  - 路径遍历检测 (../)                                   │  │
│  │  - 文件大小限制                                         │  │
│  │  - 命令黑名单                                           │  │
│  │  - 操作日志                                             │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │  Node.js fs │                          │
│                    │   child_    │                          │
│                    │   process   │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 数据流

```
用户输入 "帮我读取 src/main/main.ts"
        │
        ▼
┌─────────────────┐
│  input-area.ts  │  捕获用户输入
└────────┬────────┘
         │ 触发发送
         ▼
┌─────────────────┐
│ agent-engine.ts │  1. 构建 messages + tools
│                 │  2. 调用 ollama.chat() 流式
└────────┬────────┘
         │ 流式 chunk 到达
         ▼
┌─────────────────┐
│ chat-area.ts    │  3. 实时渲染 thinking + content
└────────┬────────┘
         │ 检测到 tool_calls
         ▼
┌─────────────────┐
│tool-call-ui.ts  │  4. 显示工具调用卡片（参数、执行中状态）
└────────┬────────┘
         │ 调用执行
         ▼
┌─────────────────┐
│tool-registry.ts │  5. 分发到对应工具处理器
└────────┬────────┘
         │ IPC invoke
         ▼
┌─────────────────┐
│tool-handlers.ts │  6. 执行文件操作（主进程，Node.js fs）
│ + security.ts   │  7. 安全检查
└────────┬────────┘
         │ 返回结果
         ▼
┌─────────────────┐
│tool-call-ui.ts  │  8. 更新卡片状态为"完成"，显示结果
└────────┬────────┘
         │ 结果回传 messages
         ▼
┌─────────────────┐
│ agent-engine.ts │  9. 追加 tool message，再次调用 ollama
│                 │  10. 循环直到无 tool_calls
└────────┬────────┘
         │ 最终回答
         ▼
┌─────────────────┐
│ chat-area.ts    │  11. 渲染最终回答
└─────────────────┘
```

### 4.3 模块依赖关系

```
agent-engine.ts
  ├── ollama.ts          (API 调用)
  ├── tool-registry.ts   (工具执行)
  ├── state.ts           (状态管理)
  └── chat-area.ts       (消息渲染)

tool-registry.ts
  ├── types.d.ts         (工具类型定义)
  └── window.toolBridge  (IPC 桥接)

tool-call-ui.ts
  ├── types.d.ts         (UI 类型)
  └── DOM 操作            (卡片渲染)

ipc.ts (主进程)
  ├── tool-handlers.ts   (工具实现)
  └── tool-security.ts   (安全检查)
```

---

## 5. 工具定义规范

### 5.1 工具清单

#### 5.1.1 read_file — 读取文件

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read the contents of a local file. Returns the file content as a string. Supports text files up to 1MB. For binary files, returns an error message.",
    "parameters": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The file path to read. Can be absolute or relative to the current working directory."
        },
        "encoding": {
          "type": "string",
          "enum": ["utf-8", "latin1", "base64"],
          "description": "File encoding. Default: utf-8"
        },
        "start_line": {
          "type": "integer",
          "description": "Start reading from this line number (1-indexed). Useful for large files."
        },
        "end_line": {
          "type": "integer",
          "description": "Stop reading at this line number (inclusive). If omitted, reads to end of file or max 500 lines from start_line."
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "path": "/absolute/path/to/file.txt",
  "content": "文件内容...",
  "encoding": "utf-8",
  "size": 1024,
  "lines": 42,
  "truncated": false,
  "line_range": [1, 42]
}
```

**限制**：
- 最大文件大小：1MB
- 最大返回行数：500 行（无 start_line/end_line 时）
- 二进制文件检测后拒绝

#### 5.1.2 write_file — 写入文件

```json
{
  "type": "function",
  "function": {
    "name": "write_file",
    "description": "Write content to a local file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories automatically.",
    "parameters": {
      "type": "object",
      "required": ["path", "content"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The file path to write to."
        },
        "content": {
          "type": "string",
          "description": "The content to write to the file."
        },
        "encoding": {
          "type": "string",
          "enum": ["utf-8"],
          "description": "File encoding. Default: utf-8"
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "path": "/absolute/path/to/file.txt",
  "bytesWritten": 1024,
  "created": true
}
```

**安全限制**：
- 内容最大大小：5MB
- 需要用户确认（可配置自动确认）
- 覆盖已存在文件时需要确认

#### 5.1.3 list_directory — 列出目录

```json
{
  "type": "function",
  "function": {
    "name": "list_directory",
    "description": "List the contents of a directory. Returns file names, types, sizes, and modification times.",
    "parameters": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The directory path to list."
        },
        "recursive": {
          "type": "boolean",
          "description": "If true, list contents recursively. Default: false."
        },
        "max_depth": {
          "type": "integer",
          "description": "Maximum recursion depth when recursive=true. Default: 3."
        },
        "include_hidden": {
          "type": "boolean",
          "description": "If true, include hidden files (starting with .). Default: false."
        },
        "filter_extension": {
          "type": "string",
          "description": "Filter by file extension, e.g. '.ts'. Only works for non-recursive."
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "path": "/absolute/path/to/dir",
  "entries": [
    {"name": "main.ts", "type": "file", "size": 4096, "modified": "2026-04-06T03:00:00Z"},
    {"name": "components", "type": "directory", "size": null, "modified": "2026-04-06T02:00:00Z"}
  ],
  "total": 2,
  "truncated": false
}
```

**限制**：
- 最大返回条目数：500（超出返回 truncated: true）
- 递归时遵守 max_depth 限制

#### 5.1.4 search_files — 搜索文件

```json
{
  "type": "function",
  "function": {
    "name": "search_files",
    "description": "Search for files by name pattern or search for text content within files.",
    "parameters": {
      "type": "object",
      "required": ["path", "query"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The root directory to search in."
        },
        "query": {
          "type": "string",
          "description": "The search query. Can be a filename glob pattern (e.g. '*.ts') or text to search inside files."
        },
        "search_type": {
          "type": "string",
          "enum": ["filename", "content", "both"],
          "description": "What to search: filename only, file content only, or both. Default: both."
        },
        "case_sensitive": {
          "type": "boolean",
          "description": "Whether the search is case-sensitive. Default: false."
        },
        "max_results": {
          "type": "integer",
          "description": "Maximum number of results to return. Default: 50."
        },
        "file_extensions": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Filter search to specific file extensions, e.g. ['.ts', '.js']"
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "query": "import electron",
  "search_type": "content",
  "results": [
    {
      "path": "src/main/main.ts",
      "matches": [
        {"line": 3, "text": "import { app, BrowserWindow } from 'electron';", "column": 8}
      ]
    }
  ],
  "total_files": 5,
  "total_matches": 12,
  "truncated": false
}
```

**限制**：
- 内容搜索最大扫描文件数：1000
- 单文件最大搜索大小：500KB
- 每文件最多返回 10 个匹配行

#### 5.1.5 create_directory — 创建目录

```json
{
  "type": "function",
  "function": {
    "name": "create_directory",
    "description": "Create a new directory. Creates parent directories if they don't exist.",
    "parameters": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The directory path to create."
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "path": "/absolute/path/to/new-dir",
  "created": true
}
```

#### 5.1.6 delete_file — 删除文件/目录

```json
{
  "type": "function",
  "function": {
    "name": "delete_file",
    "description": "Delete a file or empty directory. For safety, requires user confirmation in the UI.",
    "parameters": {
      "type": "object",
      "required": ["path"],
      "properties": {
        "path": {
          "type": "string",
          "description": "The file or directory path to delete."
        },
        "recursive": {
          "type": "boolean",
          "description": "If true, delete directories recursively. Default: false. USE WITH EXTREME CAUTION."
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "path": "/absolute/path/to/file.txt",
  "deleted": true
}
```

**安全限制**：
- **必须用户确认**，不可自动执行
- 递归删除时显示目录树预览
- 禁止删除系统关键路径

#### 5.1.7 run_command — 执行命令（可选，默认禁用）

```json
{
  "type": "function",
  "function": {
    "name": "run_command",
    "description": "Execute a shell command and return stdout/stderr. DANGEROUS: disabled by default, must be enabled in settings.",
    "parameters": {
      "type": "object",
      "required": ["command"],
      "properties": {
        "command": {
          "type": "string",
          "description": "The shell command to execute."
        },
        "cwd": {
          "type": "string",
          "description": "Working directory for the command. Default: user home."
        },
        "timeout": {
          "type": "integer",
          "description": "Timeout in milliseconds. Default: 30000 (30s). Max: 120000 (2min)."
        }
      }
    }
  }
}
```

**返回值**：

```json
{
  "success": true,
  "stdout": "命令输出...",
  "stderr": "",
  "exitCode": 0,
  "duration": 1234
}
```

**安全限制**：
- 默认禁用，需在设置中手动开启
- 每次执行必须用户确认
- 命令黑名单：`rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot` 等
- 超时限制：最长 2 分钟
- 输出大小限制：100KB

### 5.2 工具启用机制

在设置面板中新增"工具调用"设置组：

```
┌─ 工具调用 ──────────────────────────────────┐
│                                             │
│  工具调用总开关      [━━━●]  开启            │
│                                             │
│  ┌─ 可用工具 ─────────────────────────────┐ │
│  │ ☑ read_file         读取文件           │ │
│  │ ☑ write_file        写入文件（需确认）   │ │
│  │ ☑ list_directory    列出目录           │ │
│  │ ☑ search_files      搜索文件           │ │
│  │ ☑ create_directory  创建目录（需确认）   │ │
│  │ ☑ delete_file       删除文件（需确认）   │ │
│  │ ☐ run_command       执行命令⚠️（禁用）   │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  安全设置                                    │
│  ┌─ 路径限制 ─────────────────────────────┐ │
│  │ 允许访问的工作目录:                      │ │
│  │ [/home/user/projects                   ] │ │
│  │ [＋ 添加目录]                            │ │
│  │                                         │ │
│  │ 禁止访问的路径:                          │ │
│  │ /etc, /sys, /proc, C:\Windows           │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  操作确认                                    │
│  ○ 所有写操作都需确认                        │
│  ● 仅删除操作需确认                          │
│  ○ 完全自动（不推荐）                        │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 6. 工具实现：主进程

### 6.1 新增文件

#### `src/main/tool-handlers.ts`

```typescript
/**
 * Tool Handlers - 主进程工具执行器
 * 所有文件系统操作在此执行，通过 IPC 被渲染进程调用
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';

const execAsync = promisify(exec);

// ── 接口定义 ──

interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

interface ReadFileParams {
  path: string;
  encoding?: 'utf-8' | 'latin1' | 'base64';
  start_line?: number;
  end_line?: number;
}

interface WriteFileParams {
  path: string;
  content: string;
  encoding?: 'utf-8';
}

interface ListDirParams {
  path: string;
  recursive?: boolean;
  max_depth?: number;
  include_hidden?: boolean;
  filter_extension?: string;
}

interface SearchFilesParams {
  path: string;
  query: string;
  search_type?: 'filename' | 'content' | 'both';
  case_sensitive?: boolean;
  max_results?: number;
  file_extensions?: string[];
}

interface DeleteParams {
  path: string;
  recursive?: boolean;
}

interface RunCommandParams {
  command: string;
  cwd?: string;
  timeout?: number;
}

// ── 工具实现 ──

export async function handleReadFile(params: ReadFileParams): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    // 检查文件大小
    const stat = await fs.stat(filePath);
    if (stat.size > 1024 * 1024) {
      return { success: false, error: `文件过大 (${(stat.size/1024/1024).toFixed(1)}MB)，最大支持 1MB` };
    }

    const encoding = params.encoding || 'utf-8';
    const content = await fs.readFile(filePath, encoding);
    const lines = content.split('\n');

    // 行范围过滤
    let resultContent = content;
    let lineRange: [number, number] = [1, lines.length];
    let truncated = false;

    if (params.start_line || params.end_line) {
      const start = Math.max(1, params.start_line || 1) - 1;
      const end = Math.min(lines.length, params.end_line || Math.min(start + 500, lines.length));
      resultContent = lines.slice(start, end).join('\n');
      lineRange = [start + 1, end];
      truncated = end < lines.length;
    } else if (lines.length > 500) {
      resultContent = lines.slice(0, 500).join('\n');
      lineRange = [1, 500];
      truncated = true;
    }

    return {
      success: true,
      path: filePath,
      content: resultContent,
      encoding,
      size: stat.size,
      lines: lines.length,
      truncated,
      line_range: lineRange
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleWriteFile(params: WriteFileParams): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    // 内容大小检查
    if (params.content.length > 5 * 1024 * 1024) {
      return { success: false, error: '内容过大，最大支持 5MB' };
    }

    // 检查是否已存在
    let created = false;
    try {
      await fs.stat(filePath);
    } catch {
      created = true;
    }

    // 自动创建父目录
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, params.content, params.encoding || 'utf-8');

    return {
      success: true,
      path: filePath,
      bytesWritten: Buffer.byteLength(params.content, params.encoding || 'utf-8'),
      created
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleListDir(params: ListDirParams): Promise<ToolResult> {
  try {
    const dirPath = path.resolve(params.path);
    const allowed = checkPathAllowed(dirPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const maxEntries = 500;
    const entries: Array<{name: string; type: string; size: number | null; modified: string}> = [];
    let truncated = false;

    async function scanDir(dir: string, depth: number): Promise<void> {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (params.recursive && params.max_depth && depth > params.max_depth) return;

      const items = await fs.readdir(dir, { withFileTypes: true });

      for (const item of items) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (!params.include_hidden && item.name.startsWith('.')) continue;
        if (params.filter_extension && item.isFile() && !item.name.endsWith(params.filter_extension)) continue;

        const fullPath = path.join(dir, item.name);
        const stat = await fs.stat(fullPath);

        entries.push({
          name: params.recursive ? path.relative(dirPath, fullPath) : item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? stat.size : null,
          modified: stat.mtime.toISOString()
        });

        if (params.recursive && item.isDirectory()) {
          await scanDir(fullPath, depth + 1);
        }
      }
    }

    await scanDir(dirPath, 1);

    return {
      success: true,
      path: dirPath,
      entries,
      total: entries.length,
      truncated
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleSearchFiles(params: SearchFilesParams): Promise<ToolResult> {
  try {
    const rootPath = path.resolve(params.path);
    const allowed = checkPathAllowed(rootPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const searchType = params.search_type || 'both';
    const caseSensitive = params.case_sensitive || false;
    const maxResults = params.max_results || 50;
    const query = caseSensitive ? params.query : params.query.toLowerCase();

    const results: Array<{
      path: string;
      matches: Array<{line: number; text: string; column?: number}>;
    }> = [];
    let totalMatches = 0;
    let filesScanned = 0;
    const maxScanFiles = 1000;

    // 收集所有需要搜索的文件
    async function collectFiles(dir: string): Promise<string[]> {
      const files: string[] = [];
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (filesScanned >= maxScanFiles) return files;
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          files.push(...(await collectFiles(fullPath)));
        } else {
          if (params.file_extensions?.length) {
            const ext = path.extname(item.name);
            if (!params.file_extensions.includes(ext)) continue;
          }
          files.push(fullPath);
          filesScanned++;
        }
      }
      return files;
    }

    const allFiles = await collectFiles(rootPath);

    for (const filePath of allFiles) {
      if (totalMatches >= maxResults) break;

      // 文件名搜索
      if (searchType === 'filename' || searchType === 'both') {
        const fileName = path.basename(filePath);
        const nameToCheck = caseSensitive ? fileName : fileName.toLowerCase();
        if (nameToCheck.includes(query)) {
          results.push({ path: filePath, matches: [{ line: 0, text: `[文件名匹配] ${fileName}` }] });
          totalMatches++;
          continue; // 文件名匹配就不搜内容了
        }
      }

      // 内容搜索
      if (searchType === 'content' || searchType === 'both') {
        const stat = await fs.stat(filePath);
        if (stat.size > 500 * 1024) continue; // 跳过 >500KB 的文件

        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const fileMatches: Array<{line: number; text: string; column: number}> = [];

        for (let i = 0; i < lines.length && fileMatches.length < 10; i++) {
          const lineToCheck = caseSensitive ? lines[i] : lines[i].toLowerCase();
          const col = lineToCheck.indexOf(query);
          if (col !== -1) {
            fileMatches.push({ line: i + 1, text: lines[i].trim(), column: col + 1 });
            totalMatches++;
          }
        }

        if (fileMatches.length > 0) {
          results.push({ path: filePath, matches: fileMatches });
        }
      }
    }

    return {
      success: true,
      query: params.query,
      search_type: searchType,
      results,
      total_files: allFiles.length,
      total_matches: totalMatches,
      truncated: totalMatches >= maxResults
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleCreateDir(params: {path: string}): Promise<ToolResult> {
  try {
    const dirPath = path.resolve(params.path);
    const allowed = checkPathAllowed(dirPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    await fs.mkdir(dirPath, { recursive: true });

    return { success: true, path: dirPath, created: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleDeleteFile(params: DeleteParams): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      if (params.recursive) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.rmdir(filePath); // 只能删空目录
      }
    } else {
      await fs.unlink(filePath);
    }

    return { success: true, path: filePath, deleted: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleRunCommand(params: RunCommandParams): Promise<ToolResult> {
  try {
    // 命令安全检查
    const cmdCheck = checkCommandAllowed(params.command);
    if (!cmdCheck.ok) return { success: false, error: cmdCheck.reason };

    const timeout = Math.min(params.timeout || 30000, 120000);
    const cwd = params.cwd ? path.resolve(params.cwd) : process.env.HOME || '/';

    const cwdAllowed = checkPathAllowed(cwd, 'read');
    if (!cwdAllowed.ok) return { success: false, error: cwdAllowed.reason };

    const start = Date.now();
    const { stdout, stderr } = await execAsync(params.command, {
      cwd,
      timeout,
      maxBuffer: 100 * 1024 // 100KB
    });

    return {
      success: true,
      stdout: stdout.slice(0, 100 * 1024),
      stderr: stderr.slice(0, 100 * 1024),
      exitCode: 0,
      duration: Date.now() - start
    };
  } catch (err) {
    const error = err as {stdout?: string; stderr?: string; code?: number; message: string};
    return {
      success: false,
      stdout: error.stdout?.slice(0, 100 * 1024) || '',
      stderr: error.stderr?.slice(0, 100 * 1024) || error.message,
      exitCode: error.code || 1,
      error: error.message
    };
  }
}
```

#### `src/main/tool-security.ts`

```typescript
/**
 * Tool Security - 安全检查模块
 * 路径白名单/黑名单、命令过滤、路径遍历检测
 */

import * as path from 'path';
import * as os from 'os';

// ── 配置 ──

const HOME = os.homedir();

/** 默认允许的目录（可通过设置覆盖） */
let allowedDirs: string[] = [
  HOME,
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Projects'),
  path.join(HOME, 'projects'),
  '/tmp',
];

/** 永久禁止的目录 */
const BLOCKED_DIRS = [
  '/etc', '/sys', '/proc', '/dev', '/boot', '/root',
  'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.config/openclaw'),  // 保护 OpenClaw 配置
];

/** 命令黑名单 */
const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', ':(){ :|:& };:',
  'mkfs', 'dd if=', 'wipefs', 'shred',
  'shutdown', 'reboot', 'poweroff', 'halt',
  'useradd', 'usermod', 'userdel', 'passwd',
  'chmod 777', 'chown root',
  'crontab -e',
  'systemctl enable', 'systemctl disable',
  'curl | sh', 'wget | sh', 'curl | bash', 'wget | bash',
  'eval', 'exec >',
];

// ── 检查函数 ──

interface CheckResult {
  ok: boolean;
  reason?: string;
}

export function checkPathAllowed(targetPath: string, operation: 'read' | 'write'): CheckResult {
  const resolved = path.resolve(targetPath);

  // 检查路径遍历（多余的防御，path.resolve 已经处理）
  // 但仍检查是否路径中包含大量 ..
  if (targetPath.split(path.sep).filter(s => s === '..').length > 5) {
    return { ok: false, reason: '路径遍历深度过大' };
  }

  // 检查黑名单
  for (const blocked of BLOCKED_DIRS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      return { ok: false, reason: `禁止访问受保护路径: ${blocked}` };
    }
  }

  // 检查白名单（仅写操作严格检查）
  if (operation === 'write') {
    const inAllowedDir = allowedDirs.some(dir =>
      resolved === dir || resolved.startsWith(dir + path.sep)
    );
    if (!inAllowedDir) {
      return { ok: false, reason: `写操作被限制在允许的目录内。当前路径: ${resolved}` };
    }
  }

  return { ok: true };
}

export function checkCommandAllowed(command: string): CheckResult {
  const lowerCmd = command.toLowerCase().trim();

  for (const blocked of BLOCKED_COMMANDS) {
    if (lowerCmd.includes(blocked.toLowerCase())) {
      return { ok: false, reason: `命令包含被禁止的操作: ${blocked}` };
    }
  }

  // 禁止管道到 shell
  if (/(\||>|<)\s*(sh|bash|zsh|powershell|cmd)/i.test(lowerCmd)) {
    return { ok: false, reason: '禁止通过管道执行 shell 命令' };
  }

  // 禁止反弹 shell
  if (/\/dev\/tcp\//i.test(lowerCmd) || /bash\s+-i\s+>&/i.test(lowerCmd)) {
    return { ok: false, reason: '检测到疑似反弹 shell 操作' };
  }

  return { ok: true };
}

export function setAllowedDirs(dirs: string[]): void {
  allowedDirs = dirs.map(d => path.resolve(d));
}

export function getAllowedDirs(): string[] {
  return [...allowedDirs];
}

export function getBlockedDirs(): string[] {
  return [...BLOCKED_DIRS];
}
```

### 6.2 修改 `src/main/ipc.ts`

新增工具调用的 IPC handler：

```typescript
// 在 setupIPC() 函数中添加：

import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleRunCommand
} from './tool-handlers.js';

// 工具调用 IPC
ipcMain.handle('tool:execute', async (_, toolName: string, args: Record<string, unknown>) => {
  switch (toolName) {
    case 'read_file':          return handleReadFile(args as any);
    case 'write_file':         return handleWriteFile(args as any);
    case 'list_directory':     return handleListDir(args as any);
    case 'search_files':       return handleSearchFiles(args as any);
    case 'create_directory':   return handleCreateDir(args as any);
    case 'delete_file':        return handleDeleteFile(args as any);
    case 'run_command':        return handleRunCommand(args as any);
    default:                   return { success: false, error: `未知工具: ${toolName}` };
  }
});

// 获取工具权限配置
ipcMain.handle('tool:getConfig', () => ({
  allowedDirs: getAllowedDirs(),
  blockedDirs: getBlockedDirs()
}));

// 更新允许的目录
ipcMain.handle('tool:setAllowedDirs', (_, dirs: string[]) => {
  setAllowedDirs(dirs);
});
```

### 6.3 修改 `src/main/preload.ts`

新增工具调用 API 暴露：

```typescript
// 在 contextBridge.exposeInMainWorld('metonaDesktop', { ... }) 中添加：

tool: {
  execute: (toolName: string, args: Record<string, unknown>) =>
    ipcRenderer.invoke('tool:execute', toolName, args),
  getConfig: () =>
    ipcRenderer.invoke('tool:getConfig'),
  setAllowedDirs: (dirs: string[]) =>
    ipcRenderer.invoke('tool:setAllowedDirs', dirs)
}
```

---

## 7. 工具实现：渲染进程

### 7.1 新增文件

#### `src/renderer/services/tool-registry.ts`

```typescript
/**
 * Tool Registry - 工具注册与调度中心
 * 管理所有可用工具的定义，负责执行调度
 */

import type { ToolDefinition, ToolResult, ToolCall } from '../types.js';

// ── 工具定义 ──

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a local file. Returns the file content as a string. Supports text files up to 1MB. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'The file path to read. Absolute or relative.' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Default: utf-8' },
          start_line: { type: 'integer', description: 'Start line (1-indexed). For reading specific sections.' },
          end_line: { type: 'integer', description: 'End line (inclusive). Default: start_line + 500.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a local file. Creates parent directories automatically. Overwrites existing files. Max 5MB content.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'The file path to write to.' },
          content: { type: 'string', description: 'The content to write.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List directory contents. Returns file names, types, sizes, and modification times.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
          max_depth: { type: 'integer', description: 'Max recursion depth. Default: 3.' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search files by name pattern or text content within files.',
      parameters: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Root directory to search.' },
          query: { type: 'string', description: 'Search query (glob or text).' },
          search_type: { type: 'string', enum: ['filename', 'content', 'both'], description: 'Search target. Default: both.' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive. Default: false.' },
          max_results: { type: 'integer', description: 'Max results. Default: 50.' },
          file_extensions: { type: 'array', items: { type: 'string' }, description: 'Filter extensions, e.g. [".ts", ".js"]' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a new directory. Creates parents automatically.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path to create.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path to delete.' },
          recursive: { type: 'boolean', description: 'Recursive delete for directories. DANGEROUS.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command. DANGEROUS: disabled by default.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory.' },
          timeout: { type: 'integer', description: 'Timeout ms. Max 120000.' }
        }
      }
    }
  }
];

// ── 需要用户确认的工具 ──

const CONFIRM_TOOLS = ['write_file', 'delete_file', 'run_command', 'create_directory'];

export function needsConfirmation(toolName: string): boolean {
  return CONFIRM_TOOLS.includes(toolName);
}

// ── 工具启用状态 ──

let enabledTools: Set<string> = new Set([
  'read_file', 'list_directory', 'search_files',
  'write_file', 'create_directory', 'delete_file'
  // 'run_command' 默认禁用
]);

export function setToolEnabled(toolName: string, enabled: boolean): void {
  if (enabled) enabledTools.add(toolName);
  else enabledTools.delete(toolName);
}

export function isToolEnabled(toolName: string): boolean {
  return enabledTools.has(toolName);
}

export function getEnabledToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter(def => enabledTools.has(def.function.name));
}

// ── 工具执行 ──

export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!isToolEnabled(toolName)) {
    return { success: false, error: `工具 ${toolName} 未启用` };
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    return { success: false, error: '工具调用仅支持桌面版' };
  }

  try {
    const result = await bridge.tool.execute(toolName, args);
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
```

#### `src/renderer/services/agent-engine.ts`

```typescript
/**
 * Agent Engine - Agent Loop 核心引擎
 * 管理带工具调用的流式对话循环
 */

import { OllamaAPI } from '../api/ollama.js';
import { state, KEYS } from '../state/state.js';
import {
  executeTool,
  getEnabledToolDefinitions,
  needsConfirmation
} from './tool-registry.js';
import { showToast } from '../components/toast.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ChatMessage
} from '../types.js';

// ── 回调接口 ──

export interface AgentCallbacks {
  onThinking: (text: string) => void;        // 推理内容更新
  onContent: (text: string) => void;          // 回答内容更新
  onToolCallStart: (call: ToolCall) => void;  // 工具调用开始
  onToolCallResult: (name: string, result: ToolResult, call: ToolCall) => void; // 工具结果
  onToolCallError: (name: string, error: string, call: ToolCall) => void;       // 工具错误
  onDone: (finalContent: string) => void;     // 循环结束
  onConfirmTool: (call: ToolCall) => Promise<boolean>; // 用户确认回调
}

// ── Agent Loop ──

export async function runAgentLoop(
  userContent: string,
  images: string[],
  callbacks: AgentCallbacks
): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const currentSession = state.get(KEYS.CURRENT_SESSION);
  const model = currentSession?.model || state.get<string>('_defaultModel', '');

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  // 构建消息历史
  const messages: OllamaMessage[] = [];

  // 注入系统提示词（如果启用）
  if (state.get<boolean>(KEYS.SYSTEM_PROMPT_ENABLED)) {
    const systemPrompt = state.get<string>(KEYS.SYSTEM_PROMPT, '');
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
  }

  // 添加历史消息（最近 N 条）
  const historyMessages = currentSession?.messages || [];
  const maxHistory = 20; // 最近 20 条
  const recentHistory = historyMessages.slice(-maxHistory);

  for (const msg of recentHistory) {
    messages.push({
      role: msg.role,
      content: msg.content,
      ...(msg.images?.length && { images: msg.images })
    });
  }

  // 添加当前用户消息
  const userMsg: OllamaMessage = { role: 'user', content: userContent };
  if (images?.length) userMsg.images = images;
  messages.push(userMsg);

  // 获取启用的工具定义
  const tools = getEnabledToolDefinitions();
  const useTools = tools.length > 0;

  // Agent Loop
  let loopCount = 0;
  const maxLoops = 10; // 防止无限循环

  while (loopCount < maxLoops) {
    loopCount++;

    // 流式请求
    let thinking = '';
    let content = '';
    const toolCalls: ToolCall[] = [];

    const abortController = new AbortController();
    state.set(KEYS.ABORT_CONTROLLER, abortController);

    try {
      await api.chatStream(
        {
          model,
          messages,
          stream: true,
          think: state.get<boolean>('thinkEnabled', false),
          options: {
            num_ctx: state.get<number>(KEYS.NUM_CTX, 24576),
            temperature: state.get<number>('temperature', 0.7)
          },
          ...(useTools && { tools })
        },
        (chunk: OllamaStreamChunk) => {
          // 累积 thinking
          if (chunk.message?.thinking) {
            thinking += chunk.message.thinking;
            callbacks.onThinking(thinking);
          }

          // 累积 content
          if (chunk.message?.content) {
            content += chunk.message.content;
            callbacks.onContent(content);
          }

          // 累积 tool_calls
          if (chunk.message?.tool_calls?.length) {
            for (const tc of chunk.message.tool_calls) {
              // Ollama 流式下，第一次 chunk 有 name，后续只有 arguments 增量
              if (tc.function?.name) {
                // 新的工具调用
                toolCalls.push({
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || {}
                  }
                });
              } else if (toolCalls.length > 0) {
                // 增量更新最后一个 tool_call 的 arguments
                const last = toolCalls[toolCalls.length - 1];
                if (tc.function?.arguments) {
                  // 合并 arguments（Ollama 流式下 arguments 是对象）
                  if (typeof tc.function.arguments === 'object') {
                    Object.assign(last.function.arguments, tc.function.arguments);
                  }
                }
              }
            }
          }
        },
        abortController
      );
    } catch (err) {
      if (abortController.signal.aborted) {
        // 用户手动停止
        if (content || thinking) {
          messages.push({
            role: 'assistant',
            content,
            ...(thinking && { thinking })
          });
        }
        callbacks.onDone(content);
        return;
      }
      throw err;
    }

    // 将 assistant 消息加入历史
    const assistantMsg: OllamaMessage = {
      role: 'assistant',
      content,
      ...(thinking && { thinking })
    };
    if (toolCalls.length > 0) {
      (assistantMsg as any).tool_calls = toolCalls;
    }
    messages.push(assistantMsg);

    // 检查是否有工具调用
    if (toolCalls.length === 0) {
      // 没有工具调用 → 循环结束
      callbacks.onDone(content);
      return;
    }

    // 执行工具调用
    for (const call of toolCalls) {
      callbacks.onToolCallStart(call);

      // 确认检查
      if (needsConfirmation(call.function.name)) {
        const confirmed = await callbacks.onConfirmTool(call);
        if (!confirmed) {
          messages.push({
            role: 'tool',
            tool_name: call.function.name,
            content: JSON.stringify({ success: false, error: '用户取消了操作' })
          } as any);
          callbacks.onToolCallError(call.function.name, '用户取消', call);
          continue;
        }
      }

      // 执行工具
      try {
        const result = await executeTool(call.function.name, call.function.arguments);
        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: JSON.stringify(result)
        } as any);
        callbacks.onToolCallResult(call.function.name, result, call);
      } catch (err) {
        const errorMsg = (err as Error).message;
        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: JSON.stringify({ success: false, error: errorMsg })
        } as any);
        callbacks.onToolCallError(call.function.name, errorMsg, call);
      }
    }
    // 回到循环顶部，继续请求模型
  }

  // 达到最大循环次数
  callbacks.onDone(content || '（达到最大工具调用次数限制）');
}
```

### 7.2 修改 `src/renderer/api/ollama.ts`

现有的 `chatStream` 方法需要支持 `tools` 参数。检查当前实现，确保以下功能：

```typescript
// chatStream 方法签名需支持 tools
async chatStream(
  params: {
    model: string;
    messages: OllamaMessage[];
    stream?: boolean;
    think?: boolean;
    system?: string;
    tools?: ToolDefinition[];  // ← 新增
    options?: { num_ctx?: number; temperature?: number; [key: string]: unknown };
  },
  onChunk: (chunk: OllamaStreamChunk) => void,
  abortController?: AbortController
): Promise<void>
```

请求 body 中需要加入 `tools`：

```typescript
const body = {
  model: params.model,
  messages: params.messages,
  stream: true,
  ...(params.think !== undefined && { think: params.think }),
  ...(params.system && { system: params.system }),
  ...(params.tools?.length && { tools: params.tools }),
  ...(params.options && { options: params.options })
};
```

### 7.3 修改 `src/renderer/types.d.ts`

新增类型定义：

```typescript
// ── Tool Calling 类型 ──

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolParameters {
  type: 'object';
  required?: string[];
  properties: Record<string, ToolParameterProperty>;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

// 扩展 OllamaStreamChunk
export interface OllamaStreamChunk {
  model?: string;
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];  // ← 新增
  };
  done?: boolean;
  eval_count?: number;
  total_duration?: number;
}

// 扩展 OllamaMessage
export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: ToolCall[];  // ← 新增
  tool_name?: string;       // ← 新增（role=tool 时）
}

// 扩展 ChatMessage（本地存储的消息）
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string;
  think?: string;
  // ... 已有字段
  toolCalls?: Array<{           // ← 新增
    name: string;
    arguments: Record<string, unknown>;
    result: ToolResult;
  }>;
}

// 扩展 Window 接口
declare global {
  interface Window {
    metonaDesktop?: MetonaDesktopAPI & {
      tool: {
        execute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
        getConfig: () => Promise<{ allowedDirs: string[]; blockedDirs: string[] }>;
        setAllowedDirs: (dirs: string[]) => Promise<void>;
      };
    };
  }
}
```

---

## 8. Agent Loop 引擎

### 8.1 循环状态机

```
              ┌──────────┐
              │  IDLE    │  等待用户输入
              └────┬─────┘
                   │ 用户发送消息
                   ▼
              ┌──────────┐
              │ SENDING  │  流式请求 Ollama
              └────┬─────┘
                   │ chunk 到达
                   ▼
           ┌───────────────┐
           │ ACCUMULATING  │  累积 thinking/content/tool_calls
           └───────┬───────┘
                   │ 流结束
                   ▼
           ┌───────────────┐
           │ HAS_TOOLS?    │  有 tool_calls？
           └──┬─────────┬──┘
              │         │
           是 │         │ 否
              │         ▼
              │    ┌─────────┐
              │    │  DONE   │  返回最终 content
              │    └─────────┘
              ▼
        ┌──────────────┐
        │ EXECUTING    │  执行工具
        └──────┬───────┘
               │ 需要确认？
               ▼
        ┌──────────────┐
        │ CONFIRMING   │  弹出确认对话框
        └──────┬───────┘
               │ 用户确认/取消
               ▼
        ┌──────────────┐
        │ COLLECTING   │  收集所有工具结果
        └──────┬───────┘
               │ 全部执行完
               ▼
           回到 SENDING（下一轮循环）
```

### 8.2 流式工具调用的 arguments 累积策略

Ollama 的流式工具调用中，arguments 的到达方式有几种情况：

**情况 A：单 chunk 完整返回**
```json
{"message": {"tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "test.txt"}}}]}}
```

**情况 B：跨多个 chunk（arguments 增量）**
```json
// chunk 1
{"message": {"tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "te"}}}]}}
// chunk 2
{"message": {"tool_calls": [{"function": {"arguments": {"path": "st.txt"}}}]}}
```

**处理策略**：

```typescript
const pendingToolCalls: Map<number, {name: string; args: Record<string, unknown>}> = new Map();

function handleToolCallChunk(toolCalls: any[]) {
  for (const tc of toolCalls) {
    if (tc.function?.name) {
      // 新工具调用
      const index = pendingToolCalls.size;
      pendingToolCalls.set(index, {
        name: tc.function.name,
        args: tc.function.arguments || {}
      });
    } else if (pendingToolCalls.size > 0) {
      // 增量更新最后一个
      const lastIndex = pendingToolCalls.size - 1;
      const pending = pendingToolCalls.get(lastIndex)!;
      if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
        Object.assign(pending.args, tc.function.arguments);
      }
    }
  }
}
```

### 8.3 消息历史管理

Agent Loop 会产生大量消息（用户 + assistant + tool），需要注意：

1. **上下文窗口限制**：`num_ctx` 控制总 token 数，过多 tool 消息可能导致溢出
2. **截断策略**：保留系统提示词 + 最近 N 轮对话 + 当前工具调用链
3. **tool 消息压缩**：如果工具结果过长，可以截断或摘要

```typescript
function trimMessagesForContext(messages: OllamaMessage[], maxTokens: number): OllamaMessage[] {
  // 简单策略：保留 system + 最后 N 条
  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // 估计 token 数（粗略：1 中文字 ≈ 2 token，1 英文词 ≈ 1.3 token）
  let estimatedTokens = 0;
  const kept: OllamaMessage[] = [];

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i];
    const msgTokens = Math.ceil(msg.content.length * 1.5);
    if (estimatedTokens + msgTokens > maxTokens * 0.8) break; // 留 20% 余量
    estimatedTokens += msgTokens;
    kept.unshift(msg);
  }

  if (systemMsg) kept.unshift(systemMsg);
  return kept;
}
```

---

## 9. UI/UX 设计

### 9.1 工具调用卡片

当 AI 调用工具时，在聊天区域显示一个可视化的工具调用卡片：

```
┌─ 📁 read_file ──────────────────────────────────────┐
│ 路径: src/main/main.ts                               │
│ 状态: ✅ 完成                                         │
│ ─────────────────────────────────────────────────── │
│  1 │ import { app, BrowserWindow } from 'electron'; │
│  2 │ import * as path from 'path';                  │
│  3 │ import * as fs from 'fs';                      │
│    │ ... (共 156 行)                                 │
│ ─────────────────────────────────────────────────── │
│ 📄 4.2KB · 156 行 · utf-8                          │
└─────────────────────────────────────────────────────┘

┌─ ✏️ write_file ─────────────────────────────────────┐
│ 路径: src/main/config.ts                             │
│ 状态: ⏳ 等待确认                                     │
│ ─────────────────────────────────────────────────── │
│ 内容预览 (前 5 行):                                  │
│ export const config = {                             │
│   port: 3000,                                       │
│   debug: true,                                      │
│ };                                                  │
│ ─────────────────────────────────────────────────── │
│ [✅ 确认写入]  [❌ 取消]                             │
└─────────────────────────────────────────────────────┘

┌─ 🔍 search_files ──────────────────────────────────┐
│ 查询: "import electron"                              │
│ 路径: src/                                           │
│ 状态: ✅ 完成                                         │
│ ─────────────────────────────────────────────────── │
│ 📄 src/main/main.ts:3   import { app, Browser...    │
│ 📄 src/main/menu.ts:4   import { Menu, dialog...    │
│ 📄 src/main/tray.ts:4   import { Tray, Menu...      │
│ ... 共 5 个文件，12 处匹配                            │
└─────────────────────────────────────────────────────┘

┌─ 💻 run_command ────────────────────────────────────┐
│ 命令: npm run build                                  │
│ 工作目录: /home/user/metona-ollama                   │
│ 状态: ✅ 完成 (耗时 3.2s)                            │
│ ─────────────────────────────────────────────────── │
│ > vite v5.4.21 building for production...           │
│ > ✓ 25 modules transformed.                        │
│ > ✓ built in 349ms                                  │
│ exit code: 0                                        │
└─────────────────────────────────────────────────────┘
```

### 9.2 卡片状态

| 状态 | 图标 | 颜色 | 说明 |
|------|------|------|------|
| 等待确认 | ⏳ | 橙色 | 等待用户确认执行 |
| 执行中 | 🔄 | 蓝色 | 正在执行，带 spinner |
| 完成 | ✅ | 绿色 | 执行成功 |
| 失败 | ❌ | 红色 | 执行失败，显示错误信息 |
| 已取消 | 🚫 | 灰色 | 用户取消了操作 |

### 9.3 确认对话框

对于写操作/删除/命令执行，弹出模态确认框：

```
┌───────────────────────────────────────────────────┐
│ ⚠️ 确认操作                                       │
├───────────────────────────────────────────────────┤
│                                                   │
│  AI 请求执行以下操作：                              │
│                                                   │
│  操作类型：写入文件                                 │
│  文件路径：src/main/config.ts                      │
│  内容大小：256 bytes                               │
│                                                   │
│  ┌─ 内容预览 ──────────────────────────────────┐  │
│  │ export const config = {                     │  │
│  │   port: 3000,                               │  │
│  │   debug: true,                              │  │
│  │ };                                          │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ☐ 对此类操作不再询问（本次会话）                    │
│                                                   │
│            [❌ 取消]   [✅ 确认执行]                │
└───────────────────────────────────────────────────┘
```

### 9.4 修改 `src/renderer/components/chat-area.ts`

需要修改消息渲染逻辑，识别包含工具调用的消息：

```typescript
function renderMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement('div');
  el.className = `message message-${msg.role}`;

  // 普通内容
  if (msg.content) {
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = renderMarkdown(msg.content);
    el.appendChild(contentEl);
  }

  // Think 推理
  if (msg.think) {
    const thinkEl = createThinkBlock(msg.think);
    el.appendChild(thinkEl);
  }

  // Tool Calls（新增）
  if (msg.toolCalls?.length) {
    for (const tc of msg.toolCalls) {
      const toolCard = createToolCallCard(tc);
      el.appendChild(toolCard);
    }
  }

  return el;
}

function createToolCallCard(tc: ToolCallRecord): HTMLElement {
  const card = document.createElement('div');
  card.className = `tool-call-card tool-call-${tc.status}`;

  const icon = getToolIcon(tc.name);
  card.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-call-icon">${icon}</span>
      <span class="tool-call-name">${formatToolName(tc.name)}</span>
      <span class="tool-call-status">${getStatusBadge(tc.status)}</span>
    </div>
    <div class="tool-call-params">${formatParams(tc.arguments)}</div>
    ${tc.result ? `<div class="tool-call-result">${formatResult(tc.name, tc.result)}</div>` : ''}
  `;

  // 确认按钮
  if (tc.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'tool-call-actions';
    actions.innerHTML = `
      <button class="btn btn-sm btn-primary" data-action="confirm">✅ 确认执行</button>
      <button class="btn btn-sm btn-outline" data-action="cancel">❌ 取消</button>
    `;
    card.appendChild(actions);
  }

  return card;
}
```

### 9.5 CSS 样式

```css
/* ── 工具调用卡片 ── */

.tool-call-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  margin: 8px 0;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.03);
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 13px;
}

.tool-call-icon { font-size: 16px; }
.tool-call-name { font-weight: 600; color: var(--accent-cyan); }
.tool-call-status { margin-left: auto; font-size: 12px; }

.tool-call-params {
  padding: 8px 12px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  font-family: 'Cascadia Code', 'Consolas', monospace;
}

.tool-call-result {
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 状态颜色 */
.tool-call-pending { border-color: rgba(255, 165, 0, 0.4); }
.tool-call-running { border-color: rgba(0, 245, 212, 0.4); }
.tool-call-success { border-color: rgba(0, 200, 83, 0.4); }
.tool-call-error   { border-color: rgba(255, 82, 82, 0.4); }
.tool-call-cancelled { border-color: rgba(150, 150, 150, 0.4); }

/* 确认按钮区域 */
.tool-call-actions {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

/* 执行中 spinner */
.tool-call-running .tool-call-header::after {
  content: '';
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 245, 212, 0.3);
  border-top-color: var(--accent-cyan);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

---

## 10. 安全模型

### 10.1 威胁分析

| 威胁 | 风险等级 | 缓解措施 |
|------|----------|----------|
| AI 读取敏感文件（.ssh, .env） | 🔴 高 | 路径黑名单 + 白名单目录 |
| AI 写入恶意代码到项目 | 🟡 中 | 用户确认 + 内容预览 |
| AI 删除重要文件 | 🔴 高 | 用户确认 + 回收站优先 |
| AI 执行破坏性命令 | 🔴 高 | 默认禁用 + 命令黑名单 + 确认 |
| 路径遍历攻击（../../etc/passwd） | 🟡 中 | path.resolve() + 黑名单 |
| AI 泄露文件内容到外部 | 🟢 低 | 工具仅限本地操作，无网络工具 |
| 提示词注入诱导 AI 操作文件 | 🟡 中 | 系统提示词中加入安全指令 |

### 10.2 系统提示词安全注入

当启用工具调用时，在 system prompt 中追加安全指令：

```typescript
function buildSystemPromptWithTools(basePrompt: string): string {
  const toolSafetyPrompt = `
[工具使用安全规则]
1. 你可以在本地文件系统中读取和操作文件。
2. 在执行任何写操作（写文件、删除文件）之前，先向用户说明你要做什么以及为什么。
3. 不要读取或修改任何包含密码、密钥、令牌等敏感信息的文件（如 .env, .ssh/*, credentials）。
4. 不要执行任何可能破坏系统的命令。
5. 如果用户要求你执行看起来有风险的操作，请先警告用户。
6. 文件操作完成后，向用户汇报操作结果。
7. 每次工具调用都要考虑是否真的需要，不要做不必要的文件操作。
`;

  return basePrompt ? `${basePrompt}\n\n${toolSafetyPrompt}` : toolSafetyPrompt;
}
```

### 10.3 安全检查流程

```
AI 返回 tool_calls
       │
       ▼
  ┌─────────────┐
  │ 参数校验     │  JSON Schema 验证
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 路径安全检查 │  path.resolve() → 黑名单/白名单
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 权限检查     │  该工具是否启用？
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 用户确认     │  高风险操作弹确认框
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 执行工具     │  主进程 Node.js fs
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 结果过滤     │  截断过长输出、脱敏
  └──────┴──────┘
```

### 10.4 路径安全详细规则

```typescript
// 1. 解析为绝对路径（消除 ../ 和符号链接）
const resolved = path.resolve(inputPath);

// 2. 检查黑名单
for (const blocked of BLOCKED_DIRS) {
  if (resolved.startsWith(blocked)) {
    throw new Error(`禁止访问: ${blocked}`);
  }
}

// 3. 写操作额外检查白名单
if (operation === 'write') {
  const inWhitelist = allowedDirs.some(dir => resolved.startsWith(dir));
  if (!inWhitelist) {
    throw new Error(`写操作仅限允许的目录`);
  }
}

// 4. 检查文件名模式
const dangerousPatterns = [
  /\.env$/i,           // 环境变量文件
  /\.pem$/i,           // 证书文件
  /\.key$/i,           // 密钥文件
  /id_rsa/i,           // SSH 密钥
  /\.gnupg/i,          // GPG 目录
  /credentials/i,      // 凭证文件
  /password/i,         // 密码文件
];
for (const pattern of dangerousPatterns) {
  if (pattern.test(resolved)) {
    throw new Error(`疑似敏感文件，已阻止访问`);
  }
}
```

---

## 11. 类型定义

### 11.1 完整类型（追加到 `types.d.ts`）

```typescript
// ═══════════════════════════════════════════════════════════
// Tool Calling 类型
// ═══════════════════════════════════════════════════════════

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolParameters {
  type: 'object';
  required?: string[];
  properties: Record<string, ToolParameterProperty>;
}

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCall {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

// 聊天消息中记录的工具调用
export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult | null;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  confirmed?: boolean;
  timestamp: number;
}

// Agent Loop 状态
export type AgentState = 'idle' | 'sending' | 'accumulating' | 'executing' | 'confirming' | 'done';

// 扩展 ChatMessage
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string;
  think?: string;
  eval_count?: number;
  total_duration?: number;
  images?: string[];
  files?: ChatFile[];
  _fileContents?: FileContent[];
  ragSources?: RagSource[];
  stopped?: boolean;
  toolCalls?: ToolCallRecord[];  // ← 新增
}

// 扩展 OllamaMessage
export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

// 扩展 OllamaChatParams
export interface OllamaChatParams {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  think?: boolean;
  system?: string;
  tools?: ToolDefinition[];  // ← 新增
  keep_alive?: number | string;
  options?: {
    num_ctx?: number;
    temperature?: number;
    [key: string]: unknown;
  };
}

// 工具配置
export interface ToolConfig {
  enabled: boolean;
  enabledTools: string[];
  allowedDirs: string[];
  blockedDirs: string[];
  confirmationMode: 'all' | 'write-only' | 'none';
  runCommandEnabled: boolean;
}

// 扩展 MetonaDesktopAPI
export interface MetonaDesktopAPI {
  // ... 已有字段
  tool: {
    execute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
    getConfig: () => Promise<ToolConfig>;
    setAllowedDirs: (dirs: string[]) => Promise<void>;
    setToolEnabled: (toolName: string, enabled: boolean) => Promise<void>;
  };
}
```

---

## 12. 文件变更清单

### 12.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `src/main/tool-handlers.ts` | 主进程：工具执行器（7 个工具实现） |
| `src/main/tool-security.ts` | 主进程：安全检查（路径/命令过滤） |
| `src/renderer/services/tool-registry.ts` | 渲染进程：工具注册与调度 |
| `src/renderer/services/agent-engine.ts` | 渲染进程：Agent Loop 引擎 |
| `src/renderer/components/tool-confirm-modal.ts` | 渲染进程：确认对话框组件 |

### 12.2 修改文件

| 文件路径 | 变更内容 |
|----------|----------|
| `src/main/ipc.ts` | 新增 `tool:execute`, `tool:getConfig`, `tool:setAllowedDirs` IPC handler |
| `src/main/preload.ts` | 暴露 `tool` API 到渲染进程 |
| `src/renderer/types.d.ts` | 新增 Tool Calling 相关类型定义 |
| `src/renderer/api/ollama.ts` | `chatStream` 支持 `tools` 参数 |
| `src/renderer/components/chat-area.ts` | 渲染工具调用卡片 |
| `src/renderer/components/input-area.ts` | Agent Loop 触发逻辑替代直接 chat |
| `src/renderer/components/settings-modal.ts` | 新增"工具调用"设置组 |
| `src/renderer/styles/style.css` | 工具调用卡片、确认对话框样式 |
| `src/renderer/main.ts` | 初始化工具配置 |

### 12.3 不变的文件

| 文件路径 | 说明 |
|----------|------|
| `src/main/main.ts` | 无需修改 |
| `src/main/menu.ts` | 无需修改 |
| `src/main/tray.ts` | 无需修改 |
| `src/main/utils.ts` | 无需修改 |
| `src/renderer/db/chat-db.ts` | 无需修改（toolCalls 可存入 messages 数组） |
| `src/renderer/state/state.ts` | 无需修改 |
| `src/renderer/services/rag.ts` | 无需修改 |
| `src/renderer/services/vector-store.ts` | 无需修改 |

---

## 13. 测试方案

### 13.1 单元测试用例

| 编号 | 测试场景 | 输入 | 预期输出 |
|------|----------|------|----------|
| T01 | 读取存在的文件 | `read_file("package.json")` | 返回文件内容，success=true |
| T02 | 读取不存在的文件 | `read_file("nonexistent.txt")` | success=false, error=文件不存在 |
| T03 | 读取超大文件 | `read_file("large.log")` (2MB) | success=false, error=文件过大 |
| T04 | 写入新文件 | `write_file("/tmp/test.txt", "hello")` | success=true, created=true |
| T05 | 覆盖已有文件 | `write_file("/tmp/test.txt", "world")` | success=true, created=false |
| T06 | 写入禁止目录 | `write_file("/etc/test", "x")` | success=false, error=禁止访问 |
| T07 | 路径遍历 | `read_file("../../etc/passwd")` | success=false, error=禁止访问 |
| T08 | 列出目录 | `list_directory("src/")` | 返回文件列表 |
| T09 | 递归列出 | `list_directory("src/", recursive=true, max_depth=2)` | 返回嵌套结构 |
| T10 | 搜索文件名 | `search_files("src/", "*.ts", "filename")` | 返回匹配文件 |
| T11 | 搜索内容 | `search_files("src/", "import electron", "content")` | 返回匹配行 |
| T12 | 创建目录 | `create_directory("/tmp/newdir/sub")` | success=true |
| T13 | 删除文件 | `delete_file("/tmp/test.txt")` | success=true |
| T14 | 删除禁止路径 | `delete_file("/etc/passwd")` | success=false |
| T15 | 执行安全命令 | `run_command("ls -la")` | 返回 stdout |
| T16 | 执行危险命令 | `run_command("rm -rf /")` | success=false, error=命令被禁止 |
| T17 | 禁用工具执行 | 禁用 read_file 后调用 | success=false, error=工具未启用 |
| T18 | Agent Loop 终止 | 模型不返回 tool_calls | 循环正常结束 |
| T19 | Agent Loop 最大次数 | 连续返回 tool_calls | 第 10 次后强制终止 |
| T20 | 并行工具调用 | 返回 2 个 tool_calls | 全部执行，结果正确 |

### 13.2 集成测试场景

```
场景 1: 项目代码审查
用户: "帮我检查 src/main/ 目录下有没有未使用的 import"
预期: AI 调用 list_directory → 调用 read_file（逐个） → 给出分析结果

场景 2: 创建新文件
用户: "帮我创建一个 utils/math.ts，包含 add 和 multiply 函数"
预期: AI 调用 write_file → 返回最终回答

场景 3: 搜索并修改
用户: "找到所有 .ts 文件中使用 var 声明的地方，改成 const"
预期: AI 调用 search_files → 调用 read_file → 调用 write_file

场景 4: 项目初始化
用户: "帮我创建一个新的 Node.js 项目结构"
预期: AI 调用 create_directory（多个）→ 调用 write_file（多个）
```

### 13.3 安全测试

```
安全 1: 尝试读取 ~/.ssh/id_rsa
预期: 被路径黑名单阻止

安全 2: 尝试写入 /etc/crontab
预期: 被路径黑名单阻止

安全 3: 尝试路径遍历 ../../etc/passwd
预期: path.resolve 后被黑名单捕获

安全 4: 尝试执行 curl | bash
预期: 被命令黑名单捕获

安全 5: 尝试执行反弹 shell
预期: 被命令模式检测捕获
```

---

## 14. 兼容性与降级

### 14.1 不支持 Tool Calling 的模型

如果用户选择的模型不支持 Tool Calling：
- 不传 `tools` 参数，行为与 v2.0 完全一致
- 工具调用 UI 不显示
- Agent Loop 退化为普通流式对话

### 14.2 非桌面环境

如果未来恢复 Web 版支持：
- 工具调用功能自动禁用（`window.metonaDesktop.tool` 不存在）
- 提示用户"工具调用仅支持桌面版"

### 14.3 设置迁移

v2.0 → v3.0 设置兼容：
- 新增的工具设置有默认值
- 不影响已有设置

---

## 15. 未来扩展

### 15.1 更多工具

| 工具 | 说明 | 风险 |
|------|------|------|
| `web_search` | 网络搜索 | 🟢 低 |
| `web_fetch` | 获取网页内容 | 🟢 低 |
| `git_status` | Git 状态 | 🟢 低 |
| `git_diff` | Git 差异 | 🟢 低 |
| `git_commit` | Git 提交 | 🟡 中 |
| `process_list` | 列出进程 | 🟢 低 |
| `clipboard_read` | 读取剪贴板 | 🟡 中 |
| `clipboard_write` | 写入剪贴板 | 🟢 低 |

### 15.2 工具扩展机制

设计插件化的工具注册系统：

```typescript
// 允许第三方注册自定义工具
toolRegistry.register({
  definition: { type: 'function', function: { name: 'my_tool', ... } },
  execute: async (args) => { ... },
  needsConfirmation: true,
  category: 'custom'
});
```

### 15.3 操作历史与回滚

- 记录所有工具操作的完整日志
- 支持"撤销最后一次写操作"（备份机制）
- 操作历史面板（类似 IDE 的 Local History）

### 15.4 MCP (Model Context Protocol) 集成

考虑支持 MCP 协议，可以使用社区的 MCP 工具服务器：
- 文件系统 MCP
- Git MCP
- 数据库 MCP
- Docker MCP

---

## 16. 附录

### 16.1 Ollama Tool Calling 请求/响应完整示例

**请求**：

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:8b",
  "messages": [{"role": "user", "content": "读取 package.json 并告诉我版本号"}],
  "stream": false,
  "think": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read file contents",
        "parameters": {
          "type": "object",
          "required": ["path"],
          "properties": {
            "path": {"type": "string", "description": "File path"}
          }
        }
      }
    }
  ]
}'
```

**响应**：

```json
{
  "model": "qwen3:8b",
  "created_at": "2026-04-06T03:00:00Z",
  "message": {
    "role": "assistant",
    "content": "",
    "thinking": "用户想要读取 package.json 文件并获取版本号。我需要使用 read_file 工具来读取文件内容。",
    "tool_calls": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": {
            "path": "package.json"
          }
        }
      }
    ]
  },
  "done": true,
  "total_duration": 1234567890,
  "eval_count": 42
}
```

**回传工具结果**：

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:8b",
  "messages": [
    {"role": "user", "content": "读取 package.json 并告诉我版本号"},
    {
      "role": "assistant",
      "thinking": "用户想要读取 package.json 文件...",
      "tool_calls": [{"type": "function", "function": {"name": "read_file", "arguments": {"path": "package.json"}}}]
    },
    {"role": "tool", "tool_name": "read_file", "content": "{\"name\":\"metona-ollama\",\"version\":\"2.0.0\"}"}
  ],
  "stream": false,
  "think": true
}'
```

**最终响应**：

```json
{
  "message": {
    "role": "assistant",
    "content": "项目的版本号是 **2.0.0**。这是 Metona Ollama Desktop 的 TypeScript + Electron 重构版本。",
    "thinking": "工具返回了 package.json 的内容，我可以看到 version 字段是 2.0.0。"
  },
  "done": true
}
```

### 16.2 流式 Tool Calling 完整示例

```
chunk 1: {"message": {"role": "assistant", "thinking": "用户要读文件...", "content": ""}}
chunk 2: {"message": {"thinking": "我需要调用 read_file"}}
chunk 3: {"message": {"thinking": ""}}
chunk 4: {"message": {"tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "package.json"}}}]}}
chunk 5: {"message": {"done": true}}
```

### 16.3 关键参考

- Ollama Tool Calling 文档: https://docs.ollama.com/capabilities/tool-calling
- Ollama API 文档: https://docs.ollama.com/api
- OpenAI Function Calling 规范（Ollama 兼容）: https://platform.openai.com/docs/guides/function-calling
- Electron Security Best Practices: https://www.electronjs.org/docs/latest/tutorial/security

### 16.4 版本号

- 文档版本：1.0
- 目标版本：Metona Ollama Desktop v3.0.0
- 基于：v2.0.0 (TypeScript + Electron)
- 创建日期：2026-04-06
