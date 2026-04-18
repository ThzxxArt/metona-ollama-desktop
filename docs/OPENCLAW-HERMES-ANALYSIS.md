# OpenClaw & Hermes Agent 对比分析 — Metona 改进路线图

> 基于 2026 年 4 月对 OpenClaw 和 Hermes Agent 两个开源 AI Agent 项目的深度研究，
> 梳理 Metona Ollama Desktop 可吸收和改进的功能点。

---

## 一、项目概览

### OpenClaw（原 Clawdbot）

- **定位**：个人 AI 助手运行平台（Gateway 中心化架构）
- **核心哲学**：编排 + 生态 — 你配置模型、工具、通道，网关负责路由
- **GitHub Stars**：6 万+（2026 年初现象级项目）
- **特点**：技能市场成熟、多通道接入、团队协作友好、生态丰富

### Hermes Agent（Nous Research）

- **定位**：自进化 AI 智能体（Learning Agent 架构）
- **核心哲学**：学习循环 — Agent 从经验中积累技能，越用越强
- **GitHub Stars**：6.4 万+（2026 年 2-4 月爆火）
- **特点**：技能自动生成、分层记忆、执行轨迹反哺、多实例隔离

### Metona Ollama Desktop

- **定位**：本地 Ollama 桌面 AI Agent 客户端（Electron + TypeScript）
- **核心哲学**：原生桌面体验 — 零配置、全离线、系统级集成
- **差异化优势**：系统托盘、原生文件对话框、工作空间面板、暖色调 UI

### 架构对比

```
OpenClaw:  Gateway 中心化 → 路由/编排/生态 → 偏「平台」
Hermes:    学习循环核心 → 记忆/技能/进化 → 偏「个体智能体」
Metona:    Electron 桌面 → 工具调用/UI → 偏「客户端」

Metona 进化方向：
  当前 = 工具调用客户端
  目标 = 会学习的桌面 Agent（吸收 Hermes 的学习能力 + OpenClaw 的工程化能力）
```

---

## 二、从 Hermes Agent 吸收

### 1. 技能自动生成（Skill Learning Loop）🔴 P0

**Hermes 做法**

完成复杂任务后自动将执行轨迹抽取为结构化 Skill，包含：
- 任务分解步骤
- 关键判断节点
- 潜在陷阱
- 验证方式

下次遇到类似任务时直接复用已有技能，跳过重新推理。多次使用中持续优化技能实现。

**Metona 现状**

有 ReAct 执行轨迹记录（`traces` 表），但仅用于回溯查看，没有自动提炼为可复用技能。

**改进方案**

1. 在 `traces` 表基础上，Agent Loop 结束后自动分析执行轨迹
2. 提取成功的工具调用序列 → 保存为 `skills` 表
3. 下次新会话检索匹配的 skill → 优先复用
4. 技能质量随使用次数迭代优化

```
新表结构：
skills:
  id              TEXT PRIMARY KEY
  name            TEXT           -- 技能名称
  description     TEXT           -- 技能描述
  trigger_pattern TEXT           -- 触发条件（关键词/意图模式）
  tool_chain      TEXT           -- 工具调用链（JSON 数组）
  success_count   INTEGER        -- 成功次数
  fail_count      INTEGER        -- 失败次数
  avg_duration    INTEGER        -- 平均执行时长（ms）
  created_at      INTEGER
  updated_at      INTEGER
  last_used_at    INTEGER
```

Agent Loop 新增流程：

```
任务完成 → 分析 traces → 提取工具链模式 → 判断是否可复用
  → 新技能？→ 创建 skill 记录
  → 匹配已有技能？→ 更新成功率、优化参数
  → 下次同类任务 → 优先使用 skill → 跳过推理直接执行
```

### 2. 分层记忆 + 用户画像模型 🟡 P1

**Hermes 做法**

- `memory.md`：事实卡片（技术栈、项目上下文、常用工具）
- `user.md`：用户画像（角色、领域经验、编码风格、偏好）
- 构建一个「关于用户的深层模型」，跨会话持续积累

**Metona 现状**

有 fact/preference/rule 三类记忆 + FTS5 搜索 + 向量语义搜索。但没有独立的用户画像系统，不理解「用户是谁」。

**改进方案**

1. 新增 `user_profiles` 表或独立的 `user.md` 文件
2. 自动推断用户画像：
   - 技术栈偏好（Python/TypeScript/Go...）
   - 编码风格（verbose/compact、type hints/any）
   - 常用工具链
   - 工作时间段
   - 对错误的容忍度
3. 记忆注入时区分层级：
   - 画像 → 决策上下文（决定 Agent 的行为风格）
   - 偏好 → 行为引导（决定具体操作方式）
   - 事实 → 参考信息（决定知识引用）

```
user_profiles 表：
  id              TEXT PRIMARY KEY
  role            TEXT           -- 角色（后端工程师/全栈/数据科学家...）
  tech_stack      TEXT           -- 技术栈（JSON 数组）
  code_style      TEXT           -- 编码风格描述
  experience      TEXT           -- 经验描述
  work_hours      TEXT           -- 工作时间段
  error_tolerance TEXT           -- 错误容忍度（high/medium/low）
  updated_at      INTEGER
```

### 3. 执行轨迹导出 → 自训练数据 🔵 P3

**Hermes 做法**

将工具调用轨迹导出为训练数据，可用于后续模型微调。Agent 不仅在「用模型」，也在不断生产可以反哺模型的训练数据。

**Metona 现状**

`traces` 表已记录每步 Thought → Action → Observation，但没有导出功能。

**改进方案**

1. 新增「导出训练数据」功能
2. 将 traces 转换为 SFT 格式：
   ```json
   {
     "instruction": "帮我查询项目中所有 TypeScript 文件",
     "input": "",
     "output": "我来帮你搜索...",
     "tool_calls": [
       {"name": "search_files", "arguments": {"path": ".", "query": "*.ts"}}
     ],
     "observations": ["找到 42 个文件..."],
     "final_answer": "项目中有 42 个 TypeScript 文件..."
   }
   ```
3. 设置中新增「允许导出训练数据」开关
4. 导出格式支持 JSON / JSONL

---

## 三、从 OpenClaw 吸收

### 4. Heartbeat 主动检查机制 🟢 P2

**OpenClaw 做法**

Agent 定期（默认 30 分钟）主动检查邮箱、日历、通知等，有事才通知用户，没事保持安静（`HEARTBEAT_OK`）。支持在 `HEARTBEAT.md` 中配置检查项。

**Metona 现状**

纯被动模式，用户不说话就不动。

**改进方案**

1. 新增后台 heartbeat 定时器（可配置间隔，默认关闭）
2. 可配置检查项：
   - Ollama 服务连接状态
   - 磁盘空间（workspace 目录）
   - 新模型可用性（对比 `ollama list` 和本地列表）
   - 长时间未保存的会话
3. 有异常时通过 Electron Notification API 推送系统通知
4. 检查结果写入 `heartbeat-state.json` 避免重复告警

### 5. Cron 定时任务 🔵 P4

**OpenClaw 做法**

支持两种调度：
- `at`：一次性定时（ISO-8601 时间戳）
- `cron`：周期性调度（cron 表达式 + 时区）

任务类型：
- `systemEvent`：注入文本到主会话
- `agentTurn`：在隔离会话中执行 Agent 任务

**Metona 现状**

无定时任务功能。

**改进方案**

1. 集成轻量级调度器（`cron` npm 包或 `setInterval`）
2. 预设任务模板：
   - 每日对话摘要（自动总结当天对话）
   - 定期备份（导出会话为 JSON）
   - 旧会话清理（超过 N 天的归档）
   - Ollama 模型更新检查
3. 任务结果直接显示在聊天区域或工作空间面板

### 6. MCP（Model Context Protocol）生态对接 🔵 P3

**OpenClaw + Hermes**

均支持 MCP 协议，可连接外部工具和 IDE（Cursor、VS Code、Claude Desktop）。工具从硬编码 → 动态发现。

**Metona 现状**

25 个内置工具硬编码在 `tool-registry.ts`，无法扩展外部工具。

**改进方案**

1. 实现 MCP Client（连接外部 MCP Server）
2. 工具注册表重构：
   - 内置工具（现有 25 个）
   - MCP 工具（通过配置文件或 UI 添加）
3. 用户可自行添加 MCP 工具，如：
   - 数据库查询 MCP Server
   - 外部 API 调用 MCP Server
   - 专用硬件控制 MCP Server
4. 设置面板新增「MCP 工具管理」页面

### 7. 浏览器控制（Browser Automation） 🔵 P3

**OpenClaw**

内置 Playwright 浏览器自动化，支持截图、表单填写、页面交互。

**Hermes**

「全网页与浏览器控制」，真正的网页浏览能力。

**Metona 现状**

只有 `web_fetch`（HTTP 抓取纯文本）和 `web_search`（搜索引擎），无法交互式操作网页。

**改进方案**

1. 集成 Playwright 或 Puppeteer 作为新工具
2. 新增工具集：
   - `browser_open`：打开 URL
   - `browser_click`：点击元素
   - `browser_type`：输入文本
   - `browser_screenshot`：截图
   - `browser_extract`：提取页面数据
3. 在工作空间面板显示浏览器实时预览
4. 注意：会增加应用体积约 200MB（Chromium 二进制），可设为可选组件

### 8. 子代理委派（Sub-Agent Delegation） 🔵 P3

**OpenClaw**

`sessions_spawn` 生成独立子会话，支持 `run`（一次性）和 `session`（持久化）两种模式。子 Agent 完成后自动汇报。

**Hermes**

生成独立子代理处理并行工作流，零上下文成本。

**Metona 现状**

单 Agent Loop，串行执行，最多 15 轮。

**改进方案**

1. 主 Agent 识别可并行任务后 spawn 子 Agent
2. 子 Agent 独立执行（独立消息上下文）
3. 完成后汇报结果给主 Agent
4. 在聊天区域以可折叠卡片展示子 Agent 进度
5. 实现方式：复用当前 Agent Loop，但起始消息不同

---

## 四、从两者共同吸收（通用最佳实践）

### 9. 会话管理增强 🟡 P1

| 功能 | OpenClaw | Hermes | Metona 现状 | 改进方案 |
|------|----------|--------|------------|----------|
| `/new` `/reset` | ✅ | ✅ | ✅ 已有 | — |
| `/retry` 重试 | ✅ | ✅ | ❌ | 回退到上一轮消息，重新生成 |
| `/undo` 撤销 | ✅ | ✅ | ❌ | 删除最后一条用户/AI 消息对 |
| `/compress` 压缩 | ✅ | ✅ | ❌ | LLM 摘要长对话，压缩上下文 |
| `/usage` 统计 | ✅ | ✅ | ⚠️ 部分 | 按日/周/月 token 消耗统计 |
| `/model` 切换 | ✅ | ✅ | ⚠️ 下拉框 | 输入框快速切换，支持模糊搜索 |

**`/retry` 实现方案**：

```typescript
// 从 messages 数组中找到最后一个 user 消息的位置
// 删除该位置之后的所有消息（assistant 回复 + 可能的 tool 调用）
// 用相同的 user 消息重新发起 Agent Loop
```

**`/compress` 实现方案**：

```typescript
// 将 messages 中间部分（保留首尾各 2 条）用 LLM 做摘要
// 摘要结果作为 system 消息注入
// 大幅减少 token 消耗，保留关键上下文
```

### 10. 诊断系统（Doctor） 🟢 P2

**Hermes 做法**

`hermes doctor` 一键诊断所有配置问题：连接、模型、工具权限、磁盘空间等。

**Metona 现状**

设置面板只有 Ollama 连接检测。

**改进方案**

在设置面板新增「系统诊断」页面，检查项：

| 检查项 | 说明 |
|--------|------|
| Ollama 连接 | 服务地址可达、版本号 |
| 模型可用性 | 选中模型是否已下载、是否正在运行 |
| Tool Calling 支持 | 当前模型是否支持 function calling |
| Vision 支持 | 当前模型是否支持图片 |
| 磁盘空间 | workspace 目录剩余空间 |
| SQLite 完整性 | 数据库文件完整性检查 |
| 工具权限 | 安全配置是否合理 |
| 版本信息 | Metona 版本、Electron 版本、Node 版本 |

### 11. 人格/模式切换 🟢 P2

**OpenClaw**

`SOUL.md` 定义人格和行为准则。

**Hermes**

`/personality [name]` 切换不同人格模式。

**Metona 现状**

只有 system prompt 自定义设置。

**改进方案**

1. 预设多个人格模板：

   | 人格 | 说明 | 温度 | 工具集 |
   |------|------|------|--------|
   | 编程助手 | 严谨、注重代码质量 | 0.3 | 文件操作 + Git + 命令 |
   | 写作助手 | 流畅、有文采 | 0.8 | 文件操作 + 网络搜索 |
   | 数据分析师 | 精确、数据驱动 | 0.2 | 文件操作 + 命令 |
   | 翻译 | 准确、信达雅 | 0.4 | 文件操作 |
   | 通用助手 | 平衡 | 0.7 | 全部 |

2. 每个人格有独立的 system prompt + 工具集 + 温度设置
3. 在 Header 或 Model Bar 快速切换
4. 用户可创建自定义人格

### 12. 响应速度优化 ⚡

**Hermes 核心优势**

比 OpenClaw 响应更快，社区反馈明显。

**Metona 可优化方向**

1. **模型预热**：切换模型后发送空请求保持 `keep_alive`，减少首次推理延迟
2. **工具并行执行**：当前多个工具串行执行，互相独立的工具可并行
   ```typescript
   // 改进前：串行
   for (const call of toolCalls) {
     await executeTool(call);
   }
   
   // 改进后：检测依赖关系，并行执行独立工具
   const independentCalls = toolCalls.filter(/* 无依赖 */);
   const dependentCalls = toolCalls.filter(/* 有依赖 */);
   await Promise.all(independentCalls.map(c => executeTool(c)));
   for (const c of dependentCalls) await executeTool(c);
   ```
3. **上下文智能管理**：超过 `num_ctx` 时自动摘要而非截断，保留更多信息
4. **工具结果预处理**：在格式化前预计算，减少序列化开销

---

## 五、优先级排序

### 按投入产出比排序

| 优先级 | 功能 | 复杂度 | 用户价值 | 来源 |
|--------|------|--------|----------|------|
| 🔴 P0 | 技能自动生成（Skill Loop） | 高 | ⭐⭐⭐⭐⭐ | Hermes |
| 🔴 P0 | `/retry` `/undo` 会话操作 | 低 | ⭐⭐⭐⭐⭐ | 共同 |
| 🟡 P1 | 用户画像模型 | 中 | ⭐⭐⭐⭐ | Hermes |
| 🟡 P1 | 上下文压缩 (`/compress`) | 中 | ⭐⭐⭐⭐ | 共同 |
| 🟡 P1 | 工具并行执行优化 | 中 | ⭐⭐⭐⭐ | 共同 |
| 🟢 P2 | Heartbeat 主动检查 | 低 | ⭐⭐⭐ | OpenClaw |
| 🟢 P2 | 人格模板切换 | 低 | ⭐⭐⭐ | 共同 |
| 🟢 P2 | 诊断系统 (`doctor`) | 低 | ⭐⭐⭐ | Hermes |
| 🔵 P3 | MCP 生态对接 | 高 | ⭐⭐⭐⭐ | 共同 |
| 🔵 P3 | 浏览器控制 | 高 | ⭐⭐⭐ | 共同 |
| 🔵 P3 | 子代理委派 | 高 | ⭐⭐⭐ | 共同 |
| 🔵 P3 | 训练数据导出 | 中 | ⭐⭐ | Hermes |
| ⚪ P4 | Cron 定时任务 | 中 | ⭐⭐ | OpenClaw |

### 建议实施路线

**v4.1 — 会话增强（快速见效）**

- `/retry` 重试上一轮
- `/undo` 撤销最后消息
- `/compress` 上下文压缩
- 工具并行执行优化

**v4.2 — 智能进化（核心差异化）**

- 技能自动生成系统（Skill Loop）
- 用户画像模型
- 人格模板切换

**v4.3 — 生态扩展（长期建设）**

- MCP Client 支持
- Heartbeat 主动检查
- 诊断系统
- 子代理委派

**v5.0 — 全面进化**

- 浏览器控制
- 训练数据导出
- Cron 定时任务
- 多实例隔离

---

## 六、Metona 的差异化定位

```
OpenClaw  = 平台型（Gateway + Skills + 多通道 + 团队）
Hermes    = 进化型（学习循环 + 记忆 + 技能自动生成）
Metona    = 桌面型（原生体验 + 系统集成 + 离线优先）

Metona 的独特价值：
  ✅ 零配置启动（npm start 即用）
  ✅ 系统托盘 + 原生文件对话框
  ✅ 工作空间面板（终端 + 文件浏览器一体化）
  ✅ 暖色调 UI（非暗色主题，长时间使用不疲劳）
  ✅ 全离线运行（数据不离开本机）

  待吸收：
  🔜 技能自动生成（Hermes）
  🔜 用户画像模型（Hermes）
  🔜 会话管理增强（共同）
  🔜 MCP 生态对接（共同）

最终形态 = 会学习的桌面 Agent
  = Metona 的原生桌面体验
  + Hermes 的学习进化能力
  + OpenClaw 的工程化实践
```

---

*最后更新：2026-04-18*
