# Metona Ollama Desktop v1.0

基于 [Metona Ollama](https://gitee.com/thzxx/metona-ollama) Web 版封装的 **Electron Windows 桌面客户端**。

## ✨ 桌面版特性

| 特性 | 说明 |
|------|------|
| 原生安装包 | NSIS 安装程序 + 绿色便携版 |
| 系统托盘 | 最小化到托盘，双击恢复，托盘右键菜单 |
| 原生菜单 | 完整的文件/编辑/视图/窗口/帮助菜单 |
| 原生文件对话框 | Windows 文件选择器替代浏览器 input |
| 系统通知 | 通过 Windows 原生通知中心推送 |
| 窗口管理 | 记忆窗口大小和位置，支持置顶 |
| 单实例锁 | 防止重复启动 |
| 无 CORS 限制 | 关闭 webSecurity，直接连接本地 Ollama |

## 🚀 开发

### 前置条件

- Node.js 18+
- npm

### 启动开发环境

```bash
# 安装依赖
npm install

# 启动开发模式
npm start
```

### 构建

```bash
# 构建目录（不打包，用于测试）
npm run pack

# 构建 Windows 安装包 (NSIS + Portable)
npm run dist

# 仅构建 NSIS 安装包
npm run dist:nsis

# 仅构建便携版
npm run dist:portable
```

构建产物在 `release/` 目录。

## 📁 Desktop 项目结构

```
metona-ollama/
├── electron/
│   ├── main.js                 # 主进程：窗口、菜单、托盘、IPC
│   ├── preload.js              # 预加载：contextBridge 安全 API 暴露
│   ├── desktop-bridge.js       # 渲染进程桥接：统一 API + 降级处理
│   └── desktop-integration.js  # 桌面集成：菜单响应、原生文件选择、快捷键
├── index.html                  # 入口（已集成桌面脚本）
├── js/                         # 原有 Web 应用代码（未修改）
├── css/                        # 原有样式（未修改）
├── assets/                     # 图标资源
├── package.json                # Electron + electron-builder 配置
└── ...
```

## 🔌 架构设计

```
┌──────────────────────────────────────────────┐
│                  Main Process                │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Browser  │ │   Tray   │ │    Menu      │ │
│  │ Window   │ │          │ │              │ │
│  └────┬─────┘ └────┬─────┘ └──────┬───────┘ │
│       │             │              │         │
│  ┌────┴─────────────┴──────────────┴───────┐ │
│  │              IPC Main                   │ │
│  └────────────────┬────────────────────────┘ │
└───────────────────┼──────────────────────────┘
                    │ contextBridge
┌───────────────────┼──────────────────────────┐
│  Renderer         │                          │
│  ┌────────────────┴───────────────────────┐  │
│  │  window.metonaDesktop (preload.js)     │  │
│  └────────────────┬───────────────────────┘  │
│  ┌────────────────┴───────────────────────┐  │
│  │  window.__metonaBridge (bridge.js)     │  │
│  │  统一接口 + 降级 (Web环境可用)          │  │
│  └────────────────┬───────────────────────┘  │
│  ┌────────────────┴───────────────────────┐  │
│  │  desktop-integration.js                │  │
│  │  菜单响应 · 原生文件 · 快捷键           │  │
│  └────────────────┬───────────────────────┘  │
│  ┌────────────────┴───────────────────────┐  │
│  │  原有 Web 应用 (app.js + components)   │  │
│  │  零修改，完全复用                        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## 🔒 安全策略

- `contextIsolation: true` — 渲染进程无 Node.js 访问
- `nodeIntegration: false` — 通过 preload 安全暴露 API
- `sandbox: false` — 允许文件系统访问（受 IPC 白名单控制）
- `webSecurity: false` — 仅用于连接本地 Ollama API

## 📝 与 Web 版的兼容性

桌面版完全兼容 Web 版代码，通过降级处理实现：

- `window.__metonaBridge.isDesktop` 判断当前环境
- Web 环境下所有 desktop API 自动降级为浏览器原生行为
- `index.html` 无条件加载桌面脚本，非 Electron 环境静默跳过
- 原有 JS/HTML/CSS 代码**零修改**
