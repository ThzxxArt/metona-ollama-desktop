# 🦙 Metona Ollama Client

基于原生 JavaScript 的 [Ollama](https://ollama.com) AI 聊天客户端。零依赖、无构建步骤，开箱即用。

支持流式对话、多模态图片输入、文本/代码文件上传分析、Think 深度推理、RAG 本地知识库、历史记录管理，可安装为 PWA 离线使用。

![版本](https://img.shields.io/badge/version-4.0.3-brightgreen)
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
| RAG 知识库 | 本地向量存储，文档上传自动分块，语义检索增强问答 |
| Agent 预设 | 一键切换角色/工作模式（翻译官、代码审查、写作助手等），自动应用系统提示词+温度+Think |
| 使用帮助 | 内置帮助弹框，快速了解功能与快捷键 |

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

## 🧠 RAG 本地知识库

Metona 内置 RAG（检索增强生成）系统，让你可以基于本地文档进行精准问答。

### 工作流程

```
用户上传文档 → 文档分块(段落/句子级) → Ollama 嵌入向量 → IndexedDB 持久化
                                                        ↓
用户提问 → 查询嵌入 → 余弦相似度检索 Top-K → 上下文注入 System Prompt → Ollama 生成回答
```

### 使用方式

1. 点击顶部导航栏的 🧠 按钮打开知识库面板
2. 创建知识库集合（需选择一个嵌入模型，如 `nomic-embed-text`）
3. 上传文档文件（支持与文件上传相同的 50+ 种格式）
4. 系统自动分块并生成向量索引
5. 在对话时勾选知识库集合，用户的提问会自动检索相关文档片段并注入上下文

### 前置条件

需要安装嵌入模型：

```bash
ollama pull nomic-embed-text
# 或其他支持 /api/embed 的嵌入模型
```

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| RAG 管线 | `js/rag.js` | 检索增强生成主逻辑：嵌入、检索、上下文构造 |
| 向量存储 | `js/vector-store.js` | IndexedDB 向量持久化 + 余弦相似度搜索 |
| 文档处理 | `js/document-processor.js` | 文档分块（段落级 + 句子级，支持中英文） |
| 管理面板 | `js/components/kb-modal.js` | 知识库 UI：集合管理、文档上传、进度展示 |

### 分块策略

- 默认块大小 **1500 字符**，块间重叠 **200 字符**
- 先按段落（空行）分割，超长段落按句子（中英文句号/问号/感叹号）进一步切分
- 重叠区域保证上下文连贯性，避免关键信息被截断

### 存储结构

向量数据存储在独立的 IndexedDB 数据库 `metona-ollama-vectors` 中，与聊天历史互不干扰：

```
metona-ollama-vectors (IndexedDB)
├── collections       # 知识库集合（名称、嵌入模型、文档/块统计）
└── vectors           # 向量数据（文本块、嵌入向量、元数据、集合关联）
```

---

## 🤖 Agent 预设系统

用户可以创建、保存多个"角色预设"，每个预设包含系统提示词、温度、上下文长度、Think 开关等参数。**一键切换预设 = 切换人格/工作模式**，无需每次手动修改设置。

### 工作流程

```
选择预设 → applyPresetToState() → 同步到全局 state + 设置面板 UI
                                 ├── systemPrompt (系统提示词)
                                 ├── temperature  (温度 0~2)
                                 ├── numCtx       (上下文长度)
                                 └── think        (Think 推理开关)
                                                              ↓
                              用户直接发消息 → 使用新预设配置调用 /api/chat
```

### 内置预设

| 预设 | 图标 | 温度 | 上下文 | Think | 说明 |
|------|------|------|--------|-------|------|
| 默认 | 💬 | 0.7 | 24576 | ❌ | 通用对话，无系统提示词 |
| 翻译官 | 🌐 | 0.3 | 16384 | ❌ | 专业翻译，自动识别语言，保持格式语气 |
| 代码审查 | 🔍 | 0.2 | 32768 | ✅ | Bug/安全/性能/可读性五维审查，按严重程度排列 |
| 写作助手 | ✍️ | 0.9 | 24576 | ❌ | 多文体创作、润色、风格调整，温度较高鼓励创意 |
| 数据分析师 | 📊 | 0.4 | 32768 | ✅ | 统计分析、可视化建议、可执行洞察 |
| 学习导师 | 🎓 | 0.6 | 24576 | ✅ | 苏格拉底式引导教学，由浅入深 |

### 使用方式

1. 模型选择栏下方显示 **预设栏**，点击胶囊按钮即可切换
2. 点击右侧 **＋** 按钮打开管理面板
3. 创建自定义预设：填写名称、图标、系统提示词、温度、上下文长度、Think 开关
4. 右键自定义预设胶囊可编辑/删除

### 数据存储

预设存储在 IndexedDB `settings` Store 中：

```
metona-ollama (IndexedDB)
├── sessions          # 聊天会话
└── settings
    ├── agentPresets        # 用户自定义预设数组
    ├── activePresetId      # 当前激活预设 ID
    ├── systemPrompt        # 当前系统提示词
    ├── systemPromptEnabled # 系统提示词开关
    ├── numCtx              # 上下文长度
    └── temperature         # 温度参数
```

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 预设管理 | `js/preset-manager.js` | 预设 CRUD、内置预设定义、切换时应用配置 |
| 预设栏 | `js/components/preset-bar.js` | 预设胶囊按钮 UI、管理模态框（新建/编辑/删除） |

### 与设置面板的关系

- 预设系统和设置面板 **双向同步**：切换预设自动更新设置面板；设置面板修改也会反映在当前预设状态
- 预设是设置的 **快捷方式**，本质操作的是同一组参数（systemPrompt / numCtx / temperature / think）
- 内置预设不可修改/删除，自定义预设完全可编辑

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
| `/api/embed` | `POST` | `embed(model, input)` | rag.js | 生成文本嵌入向量，用于 RAG 知识库的文档向量化和查询检索 |

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
    ├── rag.js                  # RAG 检索增强生成管线（嵌入、检索、上下文构造）
    ├── vector-store.js         # 向量存储与余弦相似度检索（IndexedDB 持久化）
    ├── document-processor.js   # 文档分块处理（段落/句子级，中英文兼容）
    ├── preset-manager.js       # Agent 预设管理（CRUD + 内置预设 + 切换应用）
    ├── lib/
    │   └── marked.esm.js       # marked.js v15 (Markdown 解析器)
    └── components/
        ├── chat-area.js        # 消息渲染、流式更新、智能滚动、导出功能
        ├── input-area.js       # 文本输入、图片/文件上传、发送/停止逻辑
        ├── history-modal.js    # 历史记录面板、搜索、分页
        ├── settings-modal.js   # 设置面板、模型管理、数据管理
        ├── kb-modal.js         # 知识库管理面板（集合创建、文档上传、进度展示）
        ├── header.js           # 顶部导航、连接状态检测
        ├── model-bar.js        # 模型选择栏、Think/Vision 能力检测
        ├── preset-bar.js       # 预设栏胶囊按钮、预设管理模态框
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

## 📋 更新日志

### v4.0.3

- **帮助弹框新增 Agent 预设说明** — 内置预设列表、切换方式、自定义创建
- 帮助弹框设置章节补充系统提示词、上下文长度、温度描述
- 版本号升级至 4.0.3

### v4.0.2

- **修复切换预设时 Think 按钮显示异常** — 当模型不支持 Think 时，即使预设开启了 Think，按钮也不应显示激活态（蓝色渐变），保持禁用样式
- 版本号升级至 4.0.2

### v4.0.1

- **设置面板新增温度滑块** — 在上下文长度下方新增 Temperature 滑块控制 (0~2, 步长0.1)，实时显示当前值，保存到 IndexedDB 持久化
- 切换预设时自动同步温度滑块 UI
- 应用启动时从 DB 恢复温度设置
- 版本号升级至 4.0.1

### v4.0.0

- **Agent 预设系统** — 用户可创建、保存多个角色预设，每个预设包含系统提示词、温度、上下文长度、Think 开关。一键切换预设 = 切换人格/工作模式
  - 内置 6 个预设：💬 默认、🌐 翻译官、🔍 代码审查、✍️ 写作助手、📊 数据分析师、🎓 学习导师
  - 预设栏胶囊按钮，点击即切换，自动应用全部配置（系统提示词 + temperature + num_ctx + think）
  - 支持创建/编辑/删除自定义预设，IndexedDB 持久化
  - 切换预设时同步设置面板 UI，无需手动修改
  - 温度参数集成到 `/api/chat` 调用的 `options.temperature`
- **新模块** — `js/preset-manager.js`（预设 CRUD + 6 个内置预设）、`js/components/preset-bar.js`（预设栏 UI + 管理模态框）
- 版本号升级至 4.0.0

### v3.2.0

- **State 管理优化** — 新增 `shallowEqual` 结构化浅比较、`update()` 函数式更新、`setIn()` 路径式嵌套更新、`batch()` 批量更新 API，修复对象/数组变更无法触发监听器的问题
- **IVF 倒排索引优化向量搜索** — K-Means++ 聚类 + nprobe 近邻检索，N≥200 时搜索量降 75%，N≥5000 时搜索加速 3x+；N<200 自动降级暴力搜索；索引持久化到 IndexedDB
- **修复页面刷新后模型能力检测丢失** — `setSelectedModel()` 恢复时触发 `change` 事件，确保 Think/Vision 状态正确恢复
- **修复 RAG 检索状态消息过早消失** — RAG 状态消息延迟到首个 token 到达时才清除，消除回复前的空白期
- **知识库弹框优化** — 加大至 900px，工具栏加边框背景，左侧分隔线，选中态 glow 阴影
- **帮助弹框优化** — 加大至 640px，各功能区块加左边线强调，快捷键表格加边框和 hover 高亮
- **模态框全局优化** — 更深毛玻璃背景、圆角优化、入场缩放动画、头部微渐变
- 版本号升级至 3.2.0

### v3.1.1

- **模型选择下拉框过滤嵌入模型** — 后台检测模型 capabilities，自动移除不支持 completion 的嵌入模型（如 `nomic-embed-text`），仅保留可用于聊天的模型
- 版本号升级至 3.1.1

### v3.1.0

- **修复 RAG 知识库问答时消息不显示的问题** — 开启 RAG 后 AI 回复内容无法渲染，页面一直显示"正在思考..."
  - 根因：流式更新时 CSS 选择器 `.message.assistant:last-child` 被 `appendSystemMessage` 插入的系统消息破坏，导致 `updateLastAssistantMessage` 无法定位 placeholder
  - 最终方案：用模块变量 `currentPlaceholder` 直接持有 DOM 引用，彻底绕过选择器依赖
- **RAG 检索状态可视化** — 检索过程中显示"正在检索知识库..."和"已检索 X 个相关片段"状态提示
- **流式回复后展示 RAG 来源** — AI 回复下方显示知识库来源文件名和相似度分数
- 版本号升级至 3.1.0

### v3.0.2

- 新建会话时自动释放显存
- RAG 上下文根据 numCtx 和已有消息动态计算可用预算
- 版本号升级至 3.0.2

### v3.0.1

- 嵌入模型检测改用 /api/show capabilities 判断
- 嵌入模型下拉仅显示 embedding 模型
- 版本号升级至 3.0.1

### v3.0.0

- RAG 本地知识库：向量存储、文档分块、语义检索、知识库管理面板
- 版本号升级至 3.0.0

---

## 📄 License

MIT
