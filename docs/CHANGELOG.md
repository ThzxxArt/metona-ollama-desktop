# 📋 更新日志

## 项目发展历程

Metona Ollama 从 4 月 3 日创建，历经 4 天密集开发，从 Web 版 Ollama 客户端演进为功能完整的桌面 AI 聊天客户端。Web 版主线迭代到 v4.0.3，桌面版独立分支从 v1.0 到 v3.0，引入 Tool Calling 和 Agent 记忆系统。

---

## 2026-04-06 — 桌面版智能进化

### Desktop v3.0.0（metona-ollama-desktop-v3 分支）
- 🔧 **Tool Calling — AI 本地文件操作系统**
  - 7 个工具：`read_file` / `write_file` / `list_directory` / `search_files` / `create_directory` / `delete_file` / `run_command`
  - Agent Loop 引擎：流式多轮工具调用循环，支持并行调用（最大 10 轮）
  - 安全模型：路径白名单/黑名单、命令过滤、用户确认对话框
  - 工具调用可视化卡片（5 种状态：pending → running → success/error/denied）
- 🧠 **Agent 记忆系统**
  - 自动从对话中提取关键信息（事实/偏好/规则/事件）
  - 关键词 + 标签 + 重要性加权检索，自动注入上下文
  - IndexedDB 持久化，跨会话积累
  - 可视化记忆管理面板（搜索/筛选/编辑/删除）
  - 对话 ≥6 条消息后自动触发记忆提取
- ⚡ **全功能协调运作**
  - 记忆检索 → RAG 检索 → Tool Calling 三层协作
- 🔧 Agent 预设系统移除，由记忆系统替代
- 📝 添加 Tool Calling 技术开发文档（75KB）

### Desktop v2.0.0（metona-ollama-desktop-v2 分支）
- ⚡ **TypeScript + Electron v2 重构**
  - 构建系统完善，模块化拆分
  - 纯桌面版，专注 Electron 体验
- 📝 添加 Windows 安装包构建指南

---

## 2026-04-05 — Agent 预设 & 桌面客户端诞生

### Web 版 v4.0.0~v4.0.3（master 分支）
- 🤖 **Agent 预设系统** — 一键切换角色/工作模式
- 🎛️ 设置面板新增温度 (Temperature) 滑块控制
- 🔧 切换预设时 Think 按钮在模型不支持时不显示激活态
- 📖 帮助弹框新增 Agent 预设说明，完善设置描述

### Web 版 v3.1.0~v3.2.0
- ⚡ **IVF 倒排索引优化** — K-Means 聚类 + nprobe 近邻检索，向量搜索性能大幅提升
- 🔧 **RAG 问题修复**（7 个 fix）：消息不显示、loading 不消失、状态消息时序、RAG 来源历史展示
- 🎨 知识库弹框和帮助弹框视觉优化
- ♻️ state 管理优化 — 结构化浅比较 + update/setIn/batch API
- 🔧 模型下拉框过滤嵌入模型

### Desktop v1.0.0~v1.1.0（desktop 分支）
- 🖥️ **Electron Windows 桌面客户端首版**
- 📦 NSIS 安装包 + 绿色便携版
- 🎨 **Windows 11 Fluent Design 暗色主题** — Mica 毛玻璃材质
- 🔧 隐藏窗口菜单栏、Think 按钮光效增强
- 🔧 修复知识库/历史弹框宽度、图片按钮禁用标识

---

## 2026-04-04 — 数据增强 & RAG 知识库

### Web 版 v3.0.0~v3.0.2
- 📚 **RAG 本地知识库**
  - 文档上传 → 自动分块 → 向量化 → IndexedDB 持久化
  - 语义检索增强问答，多集合管理
  - IVF 索引（K-Means 聚类 + 倒排索引）
  - 嵌入模型自动检测（`/api/show` capabilities）
  - RAG 回复显示知识库来源（文件名 + 相似度分数）
  - RAG 检索过程可视化
  - 帮助按钮和使用说明弹框
- 🔧 嵌入模型下拉优化、知识库弹框布局修复
- 🔧 RAG 请求 system prompt 长度限制（12000 字节）
- 🔧 修复文档上传无反馈 bug
- ✨ 新建会话时自动释放显存

### Web 版 v2.1.0~v2.2.0
- 🧠 **智能滚动** — 流式回复时可向上查看历史，浮动按钮回到底部
- 👁️ **Vision 能力检测** — 不支持时禁用图片上传
- 📁 **多格式文件上传** — 支持 50+ 种文本/代码格式（≤500KB）
- 🔒 **会话导出加密** — `.metona` 格式，AES-256-GCM（HTTPS）或 XOR（HTTP）
- 🎯 **模型选择增强** — 持久化默认、按名称排序、显示磁盘大小
- 🔧 修复 chatAreaEl 重复声明、刷新后模型选择恢复

---

## 2026-04-03 — 项目诞生 & TypeScript 重写

### Web 版 v2.0.0
- 🚀 **项目初始创建**
- ♻️ **模块化架构重构** — 项目文件归类整理
- ⚡ 强制停止 AI 回复 — 真正中止 Ollama 接口请求
- 🎛️ 重新设计模型选择栏与 Think 模式
- 🎨 导航按钮和 Think 按钮渐变风格、视觉增强
- 🔧 修复消息渲染（undefined、sanitize）、历史记录分页

### 初始版本
- 🦙 Metona Ollama Client v1.1.0
- 📄 MIT License

---

## 版本演进时间线

| 日期 | 版本 | 阶段 | 关键变化 |
|------|------|------|----------|
| 04-03 | 初始 | 创建 | Ollama 客户端诞生 |
| 04-03 | v2.0.0 | 架构重构 | 模块化 + UI 重设计 + 停止回复 |
| 04-04 | v2.1.0 | 体验增强 | 文件上传、智能滚动、Vision 检测 |
| 04-04 | v2.2.0 | 数据安全 | 加密导出、模型持久化 |
| 04-04 | v3.0.0 | 知识增强 | RAG 本地知识库 |
| 04-04 | v3.0.1~v3.0.2 | 稳定迭代 | RAG 修复、显存管理 |
| 04-05 | v3.1.0~v3.2.0 | 性能优化 | IVF 索引、RAG 修复、状态管理 |
| 04-05 | v4.0.0~v4.0.3 | Agent 化 | Agent 预设系统、温度控制 |
| 04-05 | Desktop v1.0~v1.1 | 桌面化 | Electron 首版 + Fluent Design |
| 04-06 | Desktop v2.0.0 | 架构重写 | TypeScript + Vite + Electron |
| 04-06 | Desktop v3.0.0 | 智能化 | Tool Calling + Agent 记忆系统 |

> 4 天，从零到完整桌面 AI 客户端。
