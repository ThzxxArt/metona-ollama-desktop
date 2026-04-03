# 🦙 Metona Ollama Client

基于原生 JavaScript 的 [Ollama](https://ollama.com) AI 聊天客户端，支持流式对话、多模态图片、Think 推理模式、历史管理，可安装为 PWA 离线使用。

![版本](https://img.shields.io/badge/version-1.1.0-brightgreen)
![平台](https://img.shields.io/badge/platform-Web-blue)
![协议](https://img.shields.io/badge/license-MIT-green)

## ✨ 功能特性

- **流式对话** — 基于 ReadableStream 的实时打字机效果
- **多模型支持** — 自动加载 Ollama 已安装模型，一键切换
- **Think 推理模式** — 可展开/收起的思考过程展示
- **多模态输入** — 支持图片上传，兼容视觉模型
- **历史管理** — IndexedDB 持久化，支持搜索、分页、导出（Markdown/HTML/TXT/JSON）
- **PWA 离线** — Service Worker 缓存，可安装到桌面
- **连接检测** — 实时状态指示，CORS 问题自动提示
- **显存管理** — 一键卸载模型释放显存
- **XSS 防护** — 内置 HTML 净化器，安全渲染 Markdown

## 🚀 快速开始

### 前置条件

1. 安装 [Ollama](https://ollama.com) 并启动服务
2. 下载至少一个模型（例如 `ollama pull qwen2.5`）

### 启动

```bash
# 克隆仓库
git clone https://gitee.com/thzxx/metona-ollama.git
cd metona-ollama

# 直接用浏览器打开
open index.html

# 或用任意 HTTP 服务器托管
python3 -m http.server 8080
# 然后访问 http://localhost:8080
```

### 跨域配置

如果 Ollama 和页面不在同一域，需要设置环境变量：

```bash
OLLAMA_ORIGINS="*" ollama serve
```

## 📁 项目结构

```
metona-ollama/
├── index.html          # 主页面 + 应用逻辑
├── style.css           # 暗色主题样式
├── ollama-api.js       # Ollama REST API 封装
├── chat-db.js          # IndexedDB 持久化层
├── marked.esm.js       # Markdown 渲染器
├── sw.js               # Service Worker (PWA)
├── manifest.json       # PWA 清单
└── README.md
```

## ⚙️ 设置项

| 设置 | 说明 | 默认值 |
|------|------|--------|
| Ollama 服务地址 | API 端点 | `http://127.0.0.1:11434` |
| 系统提示词 | 全局 System Prompt | 关闭 |
| 上下文长度 | `num_ctx` 参数 | 24576 tokens |
| Think 模式 | 启用深度推理（需要模型支持） | 关闭 |

## 📦 数据导出

支持以下导出格式：

- **Markdown** — 单会话导出，便于阅读
- **HTML** — 带样式的离线页面
- **TXT** — 纯文本备份
- **JSON** — 全量备份/迁移，可跨设备导入

## 🛠️ 技术栈

- **纯原生 JS** — 零依赖（除 marked.js），无构建步骤
- **IndexedDB** — 异步持久化，支持大数据存储
- **Fetch API + ReadableStream** — 流式 NDJSON 解析
- **PWA** — Service Worker 离线缓存
- **CSS Variables** — 暗色主题，响应式布局

## 🔒 安全

- 内置 HTML 净化器（白名单标签 + 属性过滤）
- Markdown 链接协议白名单（http/https/mailto/tel）
- 阻止 `javascript:` / `vbscript:` / `data:` 协议注入
- 输入内容自动转义

## 📄 License

MIT
