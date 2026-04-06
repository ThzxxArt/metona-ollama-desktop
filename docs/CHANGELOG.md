# 📋 更新日志

## 项目发展历程

Metona Ollama 从最初的 Web 版 Ollama 客户端，经历了架构重构、Electron 桌面化、TypeScript 重写、RAG 知识库、Agent 记忆系统等多个阶段，逐步演进为一个功能完整的桌面 AI 聊天客户端。

---

## v3.0.x — Tool Calling & Agent 记忆

### v3.0.0（desktop-v3 分支）
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
  - 对话结束自动记忆提取，下次会话自动回忆
- 🔧 **Agent 预设系统移除**，由记忆系统替代

---

## v2.0.0~v2.2.0 — TypeScript 重写 & 数据增强

### v3.2.0（Web 版）
- 🎨 知识库弹框和帮助弹框视觉优化
- ⚡ IVF 倒排索引优化向量搜索 — K-Means 聚类 + nprobe 近邻检索
- 🔧 修复模型能力检测（Think/Vision）、RAG 状态消息时序

### v3.1.0~v3.1.1（Web 版）
- 🔧 修复 RAG 状态消息展示、loading 动画消失等 7 个问题
- 🔧 RAG 回复显示知识库来源（文件名 + 相似度分数）
- 📊 模型下拉框过滤嵌入模型

### v3.0.0~v3.0.2（Web 版）
- 📚 **RAG 本地知识库**
  - 文档上传 → 自动分块 → 向量化 → IndexedDB 持久化
  - 语义检索增强问答，多集合管理
  - IVF 索引优化（K-Means 聚类 + 倒排索引）
  - 嵌入模型自动检测（`/api/show` capabilities）
  - 帮助按钮和使用说明弹框
- 🔧 嵌入模型下拉优化、知识库弹框布局修复
- 🔧 RAG 请求 system prompt 长度限制（12000 字节）
- ✨ 新建会话时自动释放显存

### v2.2.0（TypeScript 重写）
- 🔒 **会话导出加密**
  - `.metona` 格式：AES-256-GCM 加密（HTTPS）或 XOR 混淆（HTTP）
  - 导入仅支持 `.metona` 格式
- 🎯 **模型选择增强**
  - 选中模型持久化为默认，刷新后自动恢复
  - 模型列表按名称排序，同名称按大小升序
  - 模型下拉框展示磁盘实际文件大小替代参数量
- 🔧 修复刷新后模型选择恢复为排序第一个的问题

### v2.1.0
- 🧠 **智能滚动** — 流式回复时可向上查看历史，浮动按钮回到底部
- 👁️ **Vision 能力检测** — 不支持时禁用图片上传
- 📁 **多格式文件上传** — 支持 50+ 种文本/代码格式（≤500KB）
- 🔧 禁用按钮保留 hover 提示、文件图标按类型区分

### v2.0.0
- ⚡ **TypeScript 全面重写**，严格类型定义
- 🏗️ Vite 5 构建系统，模块化打包
- 🖥️ **纯桌面版**，专注 Electron 体验
- 🧩 主进程模块化拆分
- ✨ 强制停止 AI 回复 — 真正中止 Ollama 接口请求
- 🎛️ 重新设计模型选择栏与 Think 模式
- 🔧 修复消息渲染（undefined、sanitize）、历史记录分页

---

## v1.0.0~v1.1.0 — Electron 桌面化

### v1.1.0
- 🎨 **Windows 11 Fluent Design 暗色主题**
- 📐 知识库/历史弹框优化
- ✨ Think 按钮光效增强
- 🔧 修复 Think 禁用态 hover 效果
- 📦 添加 Windows 安装包构建指南

### v1.0.0
- 🖥️ **Electron Windows 桌面客户端首版**
- 📦 NSIS 安装包 + 绿色便携版
- 🔧 隐藏窗口菜单栏

---

## 初始版本

### v1.1.0（初始提交）
- 🚀 项目初始创建 — Metona Ollama Client v1.1.0
- 📄 添加 MIT License

---

## 版本演进时间线

| 版本 | 阶段 | 关键变化 |
|------|------|----------|
| 初始 | 创建 | Ollama 客户端诞生 |
| v1.0.0 | 桌面化 | Electron 封装，首个 Windows 安装包 |
| v1.1.0 | UI 重塑 | Fluent Design 暗色主题 |
| v2.0.0 | 架构重构 | TypeScript + Vite 全面重写 |
| v2.1.0 | 体验增强 | 文件上传、智能滚动、Vision 检测 |
| v2.2.0 | 数据安全 | 加密导出、模型持久化 |
| v3.0.0（Web）| 知识增强 | RAG 本地知识库 |
| v3.0.1~v3.2.0 | 稳定迭代 | RAG 修复、IVF 索引优化、UI 优化 |
| v4.0.0~v4.0.3 | Agent 化 | Agent 预设系统、温度控制 |
| v3.0.0（Desktop）| 智能化 | Tool Calling + Agent 记忆系统 |
