# Metona Ollama Desktop

> 本地 Ollama AI 桌面客户端 — TypeScript + Electron

## 简介

Metona Ollama Desktop 是一个基于 Ollama 的本地 AI 桌面客户端，支持 Tool Calling、记忆系统、浏览器控制、MCP 协议等能力。数据不离开本机，零配置启动。

## 特性

- 🤖 ReAct Agent Loop（Thought → Action → Observation → Reflection）
- 🔧 38 个内置工具（文件系统/命令执行/联网搜索/浏览器/Git/记忆/技能/MCP）
- 🧠 智能记忆系统（FTS5 全文搜索 + 向量语义搜索 + 安全扫描）
- 🌐 MCP 协议支持（动态工具发现与执行）
- 🔍 三引擎联网搜索（Bing + 百度 + Google）
- 🖥️ 工作空间面板（终端 + 文件浏览器一体化）
- 🎨 暖色调 UI（长时间使用不疲劳）

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (strict mode) |
| 桌面框架 | Electron 33+ |
| 构建 | Vite (渲染进程) + tsc (主进程) |
| 数据库 | sql.js (WASM) + FTS5 |
| 打包 | electron-builder (NSIS) |

## 快速开始

```bash
git clone https://gitee.com/thzxx/metona-ollama-desktop.git
cd metona-ollama-desktop
git checkout desktop-v1-stable-release
npm config set registry https://registry.npmmirror.com
npm install
npm start
```

## 构建 Windows 安装包

```bash
# 环境：Ubuntu 24.04 + Node.js v22 + Wine 9.0+
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
```

产出：`release/Metona Ollama Setup 1.0.0.exe`

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── main.ts              # 入口、窗口管理
│   ├── preload.ts           # contextBridge API
│   ├── ipc.ts               # IPC 处理器
│   ├── browser.ts           # 浏览器控制（8 个工具）
│   ├── mcp-manager.ts       # MCP 协议管理
│   ├── tool-handlers*.ts    # 工具执行（fs/system/git/shared）
│   ├── tool-security.ts     # 安全检查
│   └── db/sqlite.ts         # SQLite 数据库层
├── renderer/                # 渲染进程
│   ├── services/
│   │   ├── agent-engine.ts  # ReAct Agent Loop 引擎
│   │   ├── tool-registry.ts # 工具注册与调度
│   │   ├── memory-manager.ts# 记忆管理
│   │   ├── vector-memory.ts # 向量记忆
│   │   ├── skill-manager.ts # 技能自动生成
│   │   └── mcp-client.ts    # MCP 客户端
│   ├── components/          # UI 组件
│   ├── styles/style.css     # 暖色调主题
│   └── index.html           # 入口 HTML
└── vendor/                  # 第三方库（marked, DOMPurify）
```

## 许可证

MIT
