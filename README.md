# 🦙 Metona Ollama

基于 TypeScript + Electron 的 [Ollama](https://ollama.com) 桌面 AI 聊天客户端，专为 Windows 打造。

![版本](https://img.shields.io/badge/version-2.0.0--desktop-brightgreen)
![平台](https://img.shields.io/badge/platform-Windows%20x64-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)
![Electron](https://img.shields.io/badge/Electron-33-47848f)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
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

### 🖥️ 桌面原生
| 特性 | 说明 |
|------|------|
| Fluent Design 主题 | Windows 11 暗色风格，Mica 毛玻璃材质 |
| 系统托盘 | 最小化到托盘，双击恢复，右键菜单 |
| 原生菜单 | 文件 / 编辑 / 视图 / 窗口 / 帮助完整菜单 |
| 原生文件对话框 | Windows 文件选择器替代浏览器 input |
| 系统通知 | Windows 原生通知中心推送 |
| 窗口管理 | 记忆窗口大小位置，支持置顶 |
| 单实例锁 | 防止重复启动 |
| 无 CORS 限制 | 直连本地 Ollama，无需配置 OLLAMA_ORIGINS |

---

## 📥 下载

从 [Releases](https://gitee.com/thzxx/metona-ollama/releases) 页面下载：

| 文件 | 类型 |
|------|------|
| `Metona Ollama Setup 2.0.0.exe` | NSIS 安装包（可选目录、创建快捷方式） |
| `MetonaOllama-Portable-2.0.0.exe` | 绿色便携版（免安装，双击即用） |

> ⚠️ 未签名版本，首次运行 Windows 可能弹出安全警告，点击「仍要运行」即可。

---

## 🔨 从源码构建

### 环境要求

- Node.js v22+
- Windows 或 Linux（交叉编译需 Wine 9.0+）

### 构建步骤

```bash
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama
git checkout metona-ollama-desktop-v2

# 安装依赖（国内使用 npmmirror 加速）
npm config set registry https://registry.npmmirror.com
npm install

# 构建 TypeScript
npm run build

# 开发运行
npm start

# 构建 Windows 安装包
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

> 💡 Linux 交叉编译 Windows 安装包需安装 Wine：`apt install wine`

### 常用命令

```bash
npm run build:renderer   # 仅构建渲染进程（Vite）
npm run build:main       # 仅构建主进程（tsc）
npm run build            # 构建全部
npm start                # 构建并运行
npm run dist             # 构建 Windows 安装包（NSIS + Portable）
npm run dist:nsis        # 仅 NSIS 安装包
npm run dist:portable    # 仅便携版
```

### 构建产物

| 文件 | 说明 |
|------|------|
| `release/Metona Ollama Setup 2.0.0.exe` | NSIS 安装包 |
| `release/MetonaOllama-Portable-2.0.0.exe` | 绿色便携版 |
| `dist/main/` | 主进程编译输出 |
| `dist/renderer/` | 渲染进程构建输出 |

---

## 📁 项目结构

```
metona-ollama/
├── src/
│   ├── main/                    # Electron 主进程（TypeScript）
│   │   ├── main.ts              # 应用入口、窗口管理、生命周期
│   │   ├── preload.ts           # contextBridge 安全暴露
│   │   ├── menu.ts              # 原生菜单系统
│   │   ├── tray.ts              # 系统托盘
│   │   ├── ipc.ts               # IPC 处理器
│   │   └── utils.ts             # 主进程工具函数
│   └── renderer/                # 渲染进程（TypeScript）
│       ├── index.html           # 渲染进程入口 HTML
│       ├── main.ts              # 渲染进程入口
│       ├── types.d.ts           # 完整类型定义
│       ├── api/
│       │   └── ollama.ts        # Ollama REST API 封装
│       ├── db/
│       │   └── chat-db.ts       # IndexedDB 持久化
│       ├── state/
│       │   └── state.ts         # 响应式状态管理
│       ├── components/          # UI 组件
│       │   ├── chat-area.ts     # 消息渲染、流式更新
│       │   ├── input-area.ts    # 输入、文件上传
│       │   ├── header.ts        # 顶部导航
│       │   ├── model-bar.ts     # 模型选择栏
│       │   ├── settings-modal.ts
│       │   ├── history-modal.ts
│       │   ├── kb-modal.ts      # 知识库管理
│       │   ├── preset-bar.ts    # Agent 预设栏
│       │   ├── toast.ts         # 通知组件
│       │   └── lightbox.ts      # 图片预览
│       ├── services/
│       │   ├── rag.ts           # RAG 检索增强生成
│       │   ├── vector-store.ts  # 向量存储 + 相似度搜索
│       │   ├── document-processor.ts
│       │   ├── preset-manager.ts
│       │   └── crypto.ts        # AES-256-GCM / XOR 加密
│       ├── utils/
│       │   ├── utils.ts         # 工具函数
│       │   ├── sanitizer.ts     # HTML 净化器
│       │   └── marked-config.ts # Markdown 配置
│       └── styles/
│           └── style.css        # Windows 11 Fluent Design 样式
├── assets/icons/                # 图标资源
├── vite.config.ts               # Vite 构建配置
├── tsconfig.json                # 渲染进程 TypeScript 配置
├── tsconfig.main.json           # 主进程 TypeScript 配置
└── package.json                 # 项目配置 + electron-builder 打包
```

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

- **TypeScript 5.7** — 严格类型，完整接口定义
- **Electron 33** — 桌面封装（Windows x64）
- **Vite 5** — 渲染进程构建、HMR 热更新
- **IndexedDB** — 异步持久化
- **Fetch + ReadableStream** — 流式 NDJSON 解析
- **CSS Variables** — 暗色主题，毛玻璃效果
- **electron-builder** — NSIS + Portable 打包

---

## 🔒 安全

- 内置 HTML 净化器（白名单标签 + 属性过滤 + URI 协议检查）
- Markdown 链接仅允许 `http:` / `https:` / `mailto:` / `tel:`
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- contextIsolation + IPC 白名单 + 单实例锁

---

## 📋 更新日志

### v2.0.0
- ⚡ **TypeScript 全面重写** — 所有代码从 JavaScript 迁移至 TypeScript，严格类型定义
- 🏗️ **Vite 构建系统** — 替代零构建，支持模块化打包
- 🖥️ **纯桌面版** — 放弃 Web/PWA 支持，全面专注 Electron 桌面体验
- 🧩 **主进程模块化** — 按职责拆分为独立模块（menu/tray/ipc/preload/utils）
- 🗑️ 移除 sw.js、manifest.json、desktop-bridge.js 等 Web 相关代码

### v1.1.0
- 🎨 UI 重构为 Windows 11 Fluent Design 暗色主题（Mica 材质、Segoe UI Variable）
- 📐 知识库/历史记录弹框加宽
- ✨ Think 按钮开启后添加蓝色光效
- 🚫 彻底隐藏窗口菜单栏

### v1.0.0
- 🖥️ Electron Windows 桌面客户端首版
- 📦 NSIS 安装包 + 绿色便携版
- 📋 系统托盘、原生菜单、原生文件对话框
- 🔔 系统通知、窗口管理、单实例锁

---

## 📄 License

MIT
