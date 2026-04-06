# 📋 更新日志

## 分支结构

项目有两条产品线，共 22 个分支：

**Web 版主线**（`master`）：
- `v1.1.0` → `v2.0.0` → `v2.1.0` → `v2.2.0` → `v3.0.0` → `v3.0.1` → `v3.0.2` → `v3.1.0` → `v3.1.1` → `v3.2.0` → `v4.0.0` → `v4.0.1` → `v4.0.2`（合并到 master）
- `refactor/modular-architecture`：重构分支，v4.0.3 合并到 master

**桌面版分支**（从 master v4.0.3 分出）：
- `metona-ollama-desktop-v1` → `metona-ollama-desktop-v1.1` → `metona-ollama-desktop-v2` → `metona-ollama-desktop-v3`（当前）

---

## 桌面版（Desktop）

### Desktop v3.0.0 — Tool Calling & Agent 记忆
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
- ⚡ **全功能协调运作** — 记忆检索 → RAG 检索 → Tool Calling 三层协作
- 🔧 Agent 预设系统移除，由记忆系统替代
- 📝 Tool Calling 技术开发文档（75KB）
- 📝 Wine 安装步骤和构建日志

### Desktop v2.0.0 — TypeScript 重写
- ⚡ **TypeScript + Vite + Electron 全面重构**
- 🏗️ 构建系统完善，模块化拆分
- 🖥️ 纯桌面版，专注 Electron 体验
- 📝 Windows 安装包构建指南

### Desktop v1.1.0 — UI 重塑
- 🎨 **Windows 11 Fluent Design 暗色主题** — Mica 毛玻璃材质
- 📐 知识库/历史弹框优化
- ✨ Think 按钮光效增强
- 🔧 修复知识库/历史弹框宽度、图片按钮禁用标识、Think hover 光效
- 📝 Windows 安装包构建指南，记录踩坑经验

### Desktop v1.0.0 — 桌面客户端诞生
- 🖥️ **Electron Windows 桌面客户端首版**
- 📦 NSIS 安装包 + 绿色便携版
- 🔧 隐藏窗口菜单栏

---

## Web 版

### v4.0.3 — 帮助弹框优化
- 📖 帮助弹框新增 Agent 预设说明，完善设置描述

### v4.0.2 — 预设系统修复
- 🔧 切换预设时 Think 按钮在模型不支持时不显示激活态
- 📝 README 新增 Agent 预设系统详细说明

### v4.0.1 — 温度控制
- 🎛️ 设置面板新增温度 (Temperature) 滑块控制

### v4.0.0 — Agent 预设系统
- 🤖 **Agent 预设系统** — 一键切换角色/工作模式

### v3.2.0 — IVF 索引优化
- ⚡ **IVF 倒排索引优化** — K-Means 聚类 + nprobe 近邻检索，向量搜索性能大幅提升
- 🎨 知识库弹框和帮助弹框视觉优化
- ♻️ state 管理优化 — 结构化浅比较 + update/setIn/batch API
- 🔧 setSelectedModel 触发 change 事件，恢复模型能力检测
- 🔧 RAG 临时状态消息时序修复

### v3.1.1 — 嵌入模型过滤
- 🔧 模型下拉框过滤嵌入模型

### v3.1.0 — RAG 来源修复
- 🔧 **7 个 RAG 修复**：消息不显示、loading 不消失、状态消息时序、RAG 来源历史展示
- 🔧 流结束后手动插入 RAG 来源到 DOM

### v3.0.2 — 显存管理
- ✨ 新建会话时自动释放显存，清理模型上下文
- 🔧 RAG 上下文根据 numCtx 动态计算可用预算，智能截取
- 🔧 RAG 请求增加 system prompt 长度限制（12000 字节）

### v3.0.1 — 嵌入模型检测
- 🔧 嵌入模型检测改用 `/api/show` capabilities 判断
- 🔧 嵌入模型下拉仅显示 embedding 模型

### v3.0.0 — RAG 本地知识库
- 📚 **RAG 本地知识库**
  - 文档上传 → 自动分块 → 向量化 → IndexedDB 持久化
  - 语义检索增强问答，多集合管理
  - IVF 索引（K-Means 聚类 + 倒排索引）
  - 嵌入模型自动检测
  - RAG 回复显示知识库来源（文件名 + 相似度分数）
  - RAG 检索过程可视化
  - 帮助按钮和使用说明弹框
- 🔧 嵌入模型下拉优化、知识库弹框布局修复
- 🔧 修复文档上传无反馈 bug

### v2.2.0 — 数据安全
- 🔒 **会话导出加密** — `.metona` 格式，AES-256-GCM（HTTPS）或 XOR（HTTP）
- 🎯 **模型选择增强**
  - 选中模型持久化为默认，刷新后自动恢复
  - 模型列表按名称排序，同名称按大小升序
  - 模型下拉框展示磁盘实际文件大小
- 🔧 修复刷新后模型选择恢复、chatAreaEl 重复声明

### v2.1.0 — 文件 & 交互增强
- 🧠 **智能滚动** — 流式回复时可向上查看历史，浮动按钮回到底部
- 👁️ **Vision 能力检测** — 不支持时禁用图片上传
- 📁 **多格式文件上传** — 支持 50+ 种文本/代码格式（≤500KB）
- 🔧 禁用按钮保留 hover 提示、文件图标按类型区分

### v2.0.0 — 架构重构
- ♻️ **模块化架构重构** — 项目文件归类整理
- ✨ 强制停止 AI 回复 — 真正中止 Ollama 接口请求
- 🎛️ 重新设计模型选择栏与 Think 模式
- 🎨 导航按钮和 Think 按钮渐变风格
- 🔧 修复消息渲染（undefined、sanitize）、历史记录分页

### v1.1.0 — 初始版本
- 🚀 Metona Ollama Client v1.1.0
- 📄 MIT License
