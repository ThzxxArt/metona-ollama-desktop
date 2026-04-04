# 🦙 Metona Ollama Client

基于原生 JavaScript 的 [Ollama](https://ollama.com) AI 聊天客户端。零依赖、无构建步骤，开箱即用。

支持流式对话、多模态图片输入、文本/代码文件上传分析、Think 深度推理、历史记录管理，可安装为 PWA 离线使用。

![版本](https://img.shields.io/badge/version-2.2.0-brightgreen)
![平台](https://img.shields.io/badge/platform-Web-blue)
![协议](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 流式对话 | 基于 ReadableStream 的实时打字机效果，支持强制停止 |
| 多模型支持 | 自动加载 Ollama 已安装模型，按名称排序，一键切换 |
| 模型磁盘大小 | 下拉框展示每个模型的实际磁盘占用，从小到大排序 |
| Think 推理模式 | 可展开/收起的思考过程展示（需模型支持） |
| 多模态输入 | 支持图片上传，兼容视觉模型（自动检测模型 Vision 能力） |
| 文件上传分析 | 支持 50+ 种文本/代码文件，内容自动格式化为代码块发送给模型 |
| 智能滚动 | 流式回复时可自由滚动查看历史，浮动按钮一键回到底部 |
| 强制停止 | 真正中止 Ollama 接口请求，双重保险（fetch abort + reader cancel） |
| 历史管理 | IndexedDB 持久化，支持搜索、分页、导出 |
| 数据导出 | Markdown / HTML / TXT / JSON 多格式 |
| PWA 离线 | Service Worker 缓存，可安装到桌面 |
| 连接检测 | 实时状态指示，CORS 问题自动提示 |
| 显存管理 | 一键卸载模型释放显存 |

---

## 🚀 快速开始

### 前置条件

1. 安装 [Ollama](https://ollama.com) 并启动服务
2. 下载至少一个模型：
   ```bash
   ollama pull qwen2.5
   ```

### 启动

```bash
# 克隆仓库
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama

# 方式一：直接用浏览器打开
open index.html

# 方式二：用 HTTP 服务器托管
python3 -m http.server 8080
# 访问 http://localhost:8080
```

### 跨域配置

如果 Ollama 和页面不在同一域，需要设置环境变量：

```bash
OLLAMA_ORIGINS="*" ollama serve
```

---

## 📎 文件上传分析

点击输入栏左侧的 📄 按钮上传文本或代码文件，内容会以代码块格式发送给模型分析。

### 支持的文件类型

| 类别 | 扩展名 | 图标 |
|------|--------|------|
| Python | `.py` `.pyw` `.pyi` | 🐍 |
| JavaScript | `.js` `.mjs` `.cjs` | 💛 |
| TypeScript | `.ts` `.tsx` | 🔷 / ⚛️ |
| Java | `.java` | ☕ |
| Go | `.go` | 🐹 |
| Rust | `.rs` | 🦀 |
| Ruby | `.rb` | 💎 |
| C / C++ | `.c` `.cpp` `.h` `.hpp` | ⚙️ |
| Shell | `.sh` `.bash` `.zsh` | 🐚 |
| Web | `.html` `.css` | 🌐 / 🎨 |
| 配置 | `.json` `.yaml` `.toml` `.xml` | 📋 / 📰 |
| 数据 | `.sql` `.csv` | 🗃️ / 📊 |
| 文档 | `.md` `.txt` `.log` | 📝 / 📄 / 📜 |
| 其他 | `.php` `.swift` `.kt` `.lua` `Dockerfile` 等 | 各有专属图标 |

- 单文件限制 **500KB**，支持多文件同时上传
- 文件展示为带图标的 chip，气泡内不暴露文件内容
- 模型需支持 Vision 才能上传图片（自动检测，不支持时按钮灰显）

---

## 🔌 Ollama API 调用清单

Metona 通过 `js/ollama-api.js` 封装了 Ollama REST API，以下是所有调用的接口：

### 模型管理

| 接口 | 方法 | 函数 | 调用位置 | 用途 |
|------|------|------|----------|------|
| `/api/tags` | `GET` | `listModels()` | model-bar.js | 获取已安装模型列表，填充下拉选择框 |
| `/api/ps` | `GET` | `psModels()` | header.js | 获取运行中的模型列表，展示在设置面板 |
| `/api/version` | `GET` | `getVersion()` | header.js | 获取 Ollama 版本号，用于连接检测和版本显示 |
| `/api/show` | `POST` | `showModel(model)` | model-bar.js | 查询模型详情，检测 Think/Vision 等能力 |

### 聊天

| 接口 | 方法 | 函数 | 调用位置 | 用途 |
|------|------|------|----------|------|
| `/api/chat` | `POST` | `chatStream(params, onChunk, abortController)` | input-area.js | **核心接口**。流式聊天（`stream: true`），通过 NDJSON 流实时返回 AI 回复，支持 AbortController 强制中止 |
| `/api/chat` | `POST` | `chat(params)` | settings-modal.js | 非流式聊天（`stream: false`）。用于释放显存：发送空消息并设置 `keep_alive: 0` 强制卸载模型 |
| `/api/generate` | `POST` | `generateStream(params, onChunk)` | — (未使用) | 单轮流式生成，预留接口 |
| `/api/embed` | `POST` | `embed(model, input)` | — (未使用) | 生成嵌入向量，预留接口 |

### 流式聊天数据格式 (NDJSON)

`/api/chat` 流式响应为 NDJSON（每行一个 JSON）：

```json
{"model":"qwen2.5","message":{"role":"assistant","content":"Hello"},"done":false}
{"model":"qwen2.5","message":{"role":"assistant","content":" world"},"done":false}
{"model":"qwen2.5","message":{"role":"assistant","content":"!"},"done":true,"eval_count":42,"total_duration":1234567890}
```

### 聊天请求参数

```javascript
{
  model: "qwen2.5",              // 模型名称
  messages: [                     // 对话历史
    { role: "user", content: "你好", images: ["base64..."] },
    { role: "assistant", content: "你好！" }
  ],
  stream: true,                   // 是否流式
  think: true,                    // 是否启用 Think 推理（需模型支持）
  system: "你是一个助手",          // 系统提示词
  keep_alive: "5m",               // 模型在内存中保持时间
  options: {
    num_ctx: 24576                // 上下文窗口大小（tokens）
  }
}
```

### 文件上传的消息格式

文件内容在发送时动态拼入消息的 `content` 字段，展示时仅显示文件 chip：

```javascript
// 存储的消息结构
{
  role: "user",
  content: "帮我分析这段代码",          // 用户输入文本
  files: [{ name: "app.py", language: "python", size: 1234 }],  // 展示用元数据
  _fileContents: [{ language: "python", content: "import os\n..." }]  // 发送用内容
}

// 发送给 Ollama 的消息（buildApiMessages 构造）
{
  role: "user",
  content: "帮我分析这段代码\n\n---\n📄 以下是一个文件内容：\n\n```python\nimport os\n...\n```"
}
```

### 强制停止机制

用户点击停止按钮时的完整流程：

```
用户点击 ■ → abortController.abort()
  ├── fetch signal → 浏览器取消 HTTP 连接 → Ollama 停止推理
  ├── abort listener → reader.cancel() → 中断 ReadableStream
  └── catch AbortError → 保留已有内容 → 标记 [已停止] → 恢复 UI
```

---

## 📁 项目结构

```
metona-ollama/
├── index.html                  # 入口页面（纯 HTML 模板）
├── manifest.json               # PWA 清单
├── sw.js                       # Service Worker (PWA 缓存)
├── LICENSE
├── README.md
│
├── assets/
│   └── icons/
│       ├── llama.ico           # 网站图标
│       └── llama.png           # PWA 图标
│
├── css/
│   └── style.css               # 全局样式（暗色主题 + 响应式）
│
└── js/
    ├── app.js                  # 主入口：初始化所有组件、事件绑定、生命周期管理
    ├── ollama-api.js           # Ollama REST API 封装（见上方 API 清单）
    ├── chat-db.js              # IndexedDB 持久化层（会话 CRUD + 设置存储）
    ├── crypto.js               # 会话加密模块（AES-256-GCM / XOR 混淆，.metona 格式）
    ├── state.js                # 响应式状态管理（发布-订阅模式）
    ├── utils.js                # 工具函数（ID生成、格式化、防抖、Base64、文件读取、语言检测）
    ├── sanitizer.js            # HTML XSS 净化器（白名单策略）
    ├── marked-config.js        # Markdown 渲染器配置（自定义链接/图片安全检查）
    ├── lib/
    │   └── marked.esm.js       # marked.js v15 (Markdown 解析器)
    └── components/
        ├── chat-area.js        # 消息渲染、流式更新、智能滚动、导出功能
        ├── input-area.js       # 文本输入、图片/文件上传、发送/停止逻辑
        ├── history-modal.js    # 历史记录面板、搜索、分页
        ├── settings-modal.js   # 设置面板、模型管理、数据管理
        ├── header.js           # 顶部导航、连接状态检测
        ├── model-bar.js        # 模型选择栏、Think/Vision 能力检测
        ├── toast.js            # Toast 通知组件
        └── lightbox.js         # 图片预览灯箱
```

---

## ⚙️ 设置项

| 设置 | 说明 | 默认值 | API 参数 |
|------|------|--------|----------|
| Ollama 服务地址 | API 端点 | `http://127.0.0.1:11434` | — |
| 系统提示词 | 全局 System Prompt | 关闭 | `system` |
| 上下文长度 | 上下文窗口大小 | 24576 tokens | `options.num_ctx` |
| Think 模式 | 启用深度推理 | 关闭 | `think` |
| 默认模型 | 切换模型后自动记忆，刷新恢复 | 上次选择 | — |

---

## 📦 数据导出

| 格式 | 说明 | 文件后缀 |
|------|------|----------|
| Markdown | 单会话导出，便于阅读和编辑 | `.md` |
| HTML | 带暗色主题样式的离线页面 | `.html` |
| TXT | 纯文本备份 | `.txt` |
| Metona 加密 | 全量备份/迁移，AES-256-GCM 加密（HTTPS 环境）或 XOR 混淆（HTTP 降级），仅支持 `.metona` 格式导入 | `.metona` |

---

## 🛠️ 技术栈

- **纯原生 JavaScript (ES Modules)** — 零构建步骤，`<script type="module">` 直接加载
- **IndexedDB** — 异步持久化，支持大数据（如 base64 图片）
- **Fetch API + ReadableStream** — 流式 NDJSON 解析，支持 AbortController 中止
- **PWA** — Service Worker 离线缓存
- **CSS Variables** — 暗色主题，响应式布局，渐变 + 毛玻璃效果

---

## 🔒 安全

- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- Markdown 链接仅允许 `http:` / `https:` / `mailto:` / `tel:` 协议
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- 输入内容自动转义，防御 XSS 攻击

---

## 📄 License

MIT
