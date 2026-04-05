# 🦙 Metona Ollama

基于原生 JavaScript 的 [Ollama](https://ollama.com) AI 聊天客户端。Web 版零依赖开箱即用，桌面版基于 Electron 封装，支持 Windows。

![版本](https://img.shields.io/badge/version-1.0.0--desktop-brightgreen)
![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Web-blue)
![Electron](https://img.shields.io/badge/Electron-33-47848f)
![协议](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 功能特性

### 💬 对话
- **流式对话** — ReadableStream 实时打字效果，支持强制停止
- **多模型支持** — 自动加载 Ollama 已安装模型，一键切换
- **Think 推理** — 展开/收起的深度思考过程（需模型支持）
- **多模态** — 图片上传，自动检测 Vision 模型能力
- **文件分析** — 支持 50+ 种文本/代码格式，单文件 ≤500KB

### 🧠 RAG 知识库
- 文档上传 → 自动分块 → 向量化 → IndexedDB 持久化
- 语义检索增强问答，支持多集合管理
- 需嵌入模型（如 `nomic-embed-text`）

### 🤖 Agent 预设
- 内置 6 个预设：💬 默认、🌐 翻译官、🔍 代码审查、✍️ 写作助手、📊 数据分析师、🎓 学习导师
- 一键切换系统提示词 + 温度 + 上下文长度 + Think 开关
- 支持自定义创建/编辑/删除

### 📦 数据
- 历史记录 IndexedDB 持久化，支持搜索、分页
- 导出格式：Markdown / HTML / TXT / JSON / .metona 加密备份
- .metona 格式支持 AES-256-GCM 加密（HTTPS）或 XOR 混淆（HTTP）

---

## 🖥️ 桌面版

基于 Electron 封装，Windows 专用，在 Web 版全部功能基础上增加原生特性。

| 特性 | 说明 |
|------|------|
| 系统托盘 | 最小化到托盘，双击恢复，右键菜单 |
| 原生菜单 | 文件 / 编辑 / 视图 / 窗口 / 帮助完整菜单 |
| 原生文件对话框 | Windows 文件选择器替代浏览器 input |
| 系统通知 | Windows 原生通知中心推送 |
| 窗口管理 | 记忆窗口大小位置，支持置顶 |
| 单实例锁 | 防止重复启动 |
| 无 CORS 限制 | 直连本地 Ollama，无需配置 OLLAMA_ORIGINS |

### 下载

从 [Releases](https://gitee.com/thzxx/metona-ollama/releases) 页面下载：

| 文件 | 类型 |
|------|------|
| `Metona Ollama Setup 1.0.0.exe` | NSIS 安装包（可选目录、创建快捷方式） |
| `MetonaOllama-Portable-1.0.0.exe` | 绿色便携版（免安装，双击即用） |

> ⚠️ 未签名版本，首次运行 Windows 可能弹出安全警告，点击「仍要运行」即可。

### 从源码构建桌面版

```bash
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama
git checkout metona-ollama-desktop-v1
npm install
npm start          # 开发运行
npm run dist       # 构建 Windows 安装包
```

---

## 🌐 Web 版

零构建步骤，纯 HTML + ES Modules，任何 HTTP 服务器即可托管。

```bash
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama

# 方式一：直接浏览器打开
open index.html

# 方式二：HTTP 服务器
python3 -m http.server 8080
# 访问 http://localhost:8080
```

**跨域配置**（Web 版需要）：
```bash
OLLAMA_ORIGINS="*" ollama serve
```

### PWA 离线使用

Web 版内置 Service Worker，可安装到桌面离线使用（桌面版无需此功能）。

---

## 🔌 Ollama API 接口

| 接口 | 用途 | 调用位置 |
|------|------|----------|
| `GET /api/tags` | 已安装模型列表 | 模型选择栏 |
| `GET /api/ps` | 运行中模型 | 设置面板 |
| `GET /api/version` | Ollama 版本 | 连接检测 |
| `POST /api/show` | 模型详情（能力检测） | Think/Vision 检测 |
| `POST /api/chat` | 流式聊天（核心） | 消息发送 |
| `POST /api/embed` | 生成嵌入向量 | RAG 知识库 |

---

## 📁 项目结构

```
metona-ollama/
├── index.html                  # 入口页面
├── electron/                   # 桌面版（Electron）
│   ├── main.js                 # 主进程：窗口、托盘、菜单、IPC
│   ├── preload.js              # Preload：contextBridge 安全暴露
│   ├── desktop-bridge.js       # 渲染进程桥接 + Web 降级
│   └── desktop-integration.js  # 菜单响应、原生文件对话框
├── js/
│   ├── app.js                  # 主入口
│   ├── ollama-api.js           # Ollama REST API 封装
│   ├── chat-db.js              # IndexedDB 持久化
│   ├── state.js                # 响应式状态管理
│   ├── rag.js                  # RAG 检索增强生成
│   ├── vector-store.js         # 向量存储 + 相似度搜索
│   ├── document-processor.js   # 文档分块
│   ├── preset-manager.js       # Agent 预设管理
│   ├── crypto.js               # 会话加密（AES-256-GCM / XOR）
│   └── components/             # UI 组件
│       ├── chat-area.js        # 消息渲染、流式更新
│       ├── input-area.js       # 输入、文件上传
│       ├── settings-modal.js   # 设置面板
│       ├── history-modal.js    # 历史记录
│       ├── kb-modal.js         # 知识库管理
│       └── ...
├── css/style.css               # 全局样式（暗色主题）
├── assets/icons/               # 图标资源
├── package.json                # Electron + electron-builder 配置
├── sw.js                       # Service Worker（PWA）
└── manifest.json               # PWA 清单
```

---

## ⚙️ 设置

| 设置 | 默认值 | API 参数 |
|------|--------|----------|
| Ollama 服务地址 | `http://127.0.0.1:11434` | — |
| 系统提示词 | 关闭 | `system` |
| 上下文长度 | 24576 tokens | `options.num_ctx` |
| 温度 | 0.7 | `options.temperature` |
| Think 模式 | 关闭 | `think` |

---

## 🛠️ 技术栈

- **纯原生 JavaScript** (ES Modules) — 零构建步骤
- **Electron 33** — 桌面封装（Windows）
- **IndexedDB** — 异步持久化
- **Fetch + ReadableStream** — 流式 NDJSON 解析
- **CSS Variables** — 暗色主题，毛玻璃效果
- **electron-builder** — NSIS + Portable 打包

---

## 🔒 安全

- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- Markdown 链接仅允许 `http:` / `https:` / `mailto:` / `tel:`
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- 桌面版：contextIsolation + IPC 白名单 + 单实例锁

---

## 📄 License

MIT
