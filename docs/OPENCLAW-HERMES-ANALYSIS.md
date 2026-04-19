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

### 1. 技能自动生成（Skill Learning Loop） ✅ 已实现 v5.1.0

**Hermes 做法**

完成复杂任务后自动将执行轨迹抽取为结构化 Skill，包含：
- 任务分解步骤
- 关键判断节点
- 潜在陷阱
- 验证方式

下次遇到类似任务时直接复用已有技能，跳过重新推理。多次使用中持续优化技能实现。

**Metona 现状** ✅ 已实现

`skills` 表 + `skill-manager.ts` 自动提取 + `skill_list` / `skill_view` 工具（Level 0 渐进式）。
Agent Loop 结束后从 traces 提取成功工具链，下次自动匹配复用。

### 2. 分层记忆 + 用户画像模型 ✅ 已实现 v5.0.0

**Hermes 做法**

- `memory.md`：事实卡片（技术栈、项目上下文、常用工具）
- `user.md`：用户画像（角色、领域经验、编码风格、偏好）
- 构建一个「关于用户的深层模型」，跨会话持续积累

**Metona 现状** ✅ 已实现

- fact/preference/rule 三类记忆 + FTS5 搜索 + 向量语义搜索
- 用户画像自动推断：检测 14 种技术栈，自动注入 system prompt
- `memory_replace` / `memory_remove` 支持修改和删除（v5.1.0）
- 记忆写入前安全扫描（prompt injection / 敏感信息检测）（v5.1.0）
- 记忆容量管理：上限 500 条，超限自动清理低价值条目（v5.1.2）
- 记忆过期衰减：90 天未使用自动降低 importance（v5.1.3）

### 3. 执行轨迹导出 → 自训练数据 🔵 P3（未实现）

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

### 4. Heartbeat 主动检查机制 ✅ 已实现 v5.0.0

**OpenClaw 做法**

Agent 定期（默认 30 分钟）主动检查邮箱、日历、通知等，有事才通知用户，没事保持安静（`HEARTBEAT_OK`）。支持在 `HEARTBEAT.md` 中配置检查项。

**Metona 现状** ✅ 已实现

后台 heartbeat 定时器，检查 Ollama 连接状态等，通过 Electron Notification API 推送通知。

### 5. Cron 定时任务 ✅ 已实现 v5.0.0

**OpenClaw 做法**

支持 `at`（一次性）和 `cron`（周期性）两种调度，systemEvent（注入文本）和 agentTurn（隔离执行）两种任务类型。

**Metona 现状** ✅ 已实现

`cron-manager.ts` 已集成，支持一次性 / 周期性任务调度，任务结果显示在聊天区域。

### 6. MCP（Model Context Protocol）生态对接 ✅ 已实现 v5.0.0

**OpenClaw + Hermes**

均支持 MCP 协议，可连接外部工具和 IDE（Cursor、VS Code、Claude Desktop）。工具从硬编码 → 动态发现。

**Metona 现状** ✅ 已实现

- `mcp-manager.ts`（主进程）+ `mcp-client.ts`（渲染进程）
- JSON-RPC 2.0 over stdio 通信
- 7 个 IPC 通道（startServer / stopServer / stopAll / callTool / getTools / getStatuses / refreshTools）
- Shadowing 防护：MCP 工具注册时自动检测与内置工具重名（v5.1.2）
- 设置面板管理：添加 / 启用 / 禁用 / 删除

### 7. 浏览器控制（Browser Automation） ✅ 已实现 v5.0.0

**OpenClaw**

内置 Playwright 浏览器自动化，支持截图、表单填写、页面交互。

**Metona 现状** ✅ 已实现

`browser.ts`（主进程）提供 8 个浏览器工具：browser_open / browser_screenshot / browser_evaluate / browser_extract / browser_click / browser_type / browser_scroll / browser_close。

### 8. 子代理委派（Sub-Agent Delegation） ✅ 已实现 v5.0.0

**OpenClaw**

`sessions_spawn` 生成独立子会话，支持 `run`（一次性）和 `session`（持久化）两种模式。

**Metona 现状** ✅ 已实现

`sub-agent.ts` + `spawn_task` 工具，主 Agent 可委派独立子任务执行。

---

## 四、从两者共同吸收（通用最佳实践）

### 9. 会话管理增强 ✅ 部分实现 v5.0.0

| 功能 | OpenClaw | Hermes | Metona 现状 |
|------|----------|--------|------------|
| `/new` `/reset` | ✅ | ✅ | ✅ 已有 |
| `/retry` 重试 | ✅ | ✅ | ✅ 已实现 |
| `/undo` 撤销 | ✅ | ✅ | ✅ 已实现 |
| `/compress` 压缩 | ✅ | ✅ | ❌ 未实现（上下文压缩） |
| `/usage` 统计 | ✅ | ✅ | ⚠️ 部分（日志面板有） |
| `/model` 切换 | ✅ | ✅ | ⚠️ 下拉框 |

**`/compress` 实现方案**（未实现）：

```typescript
// 将 messages 中间部分（保留首尾各 2 条）用 LLM 做摘要
// 摘要结果作为 system 消息注入
// 大幅减少 token 消耗，保留关键上下文
```

### 10. 诊断系统（Doctor） 🟢 P2（未实现）

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

### 11. 人格/模式切换 ✅ 已实现 v5.0.0

**OpenClaw**

`SOUL.md` 定义人格和行为准则。

**Hermes**

`/personality [name]` 切换不同人格模式。

**Metona 现状** ✅ 已实现

多种预设人格模板（编程助手/写作助手/数据分析师等），每种有独立 system prompt + 温度设置，设置面板快速切换。

### 12. 响应速度优化 ⚡ 部分实现

**Hermes 核心优势**

比 OpenClaw 响应更快，社区反馈明显。

**Metona 已优化方向**

1. ✅ **工具并行执行**：独立工具通过 `Promise.all` 并行执行（v5.0.0）
2. ❌ **模型预热**：切换模型后发送空请求保持 `keep_alive`
3. ❌ **上下文智能管理**：超过 `num_ctx` 时自动摘要而非截断
4. ❌ **工具结果预处理**：在格式化前预计算，减少序列化开销

---

## 五、优先级排序

### 按投入产出比排序

| 优先级 | 功能 | 复杂度 | 用户价值 | 来源 | 状态 |
|--------|------|--------|----------|------|------|
| 🔴 P0 | 技能自动生成（Skill Loop） | 高 | ⭐⭐⭐⭐⭐ | Hermes | ✅ v5.1.0 |
| 🔴 P0 | `/retry` `/undo` 会话操作 | 低 | ⭐⭐⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🟡 P1 | 用户画像模型 | 中 | ⭐⭐⭐⭐ | Hermes | ✅ v5.0.0 |
| 🟡 P1 | 上下文压缩 (`/compress`) | 中 | ⭐⭐⭐⭐ | 共同 | ❌ 未实现 |
| 🟡 P1 | 工具并行执行优化 | 中 | ⭐⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🟢 P2 | Heartbeat 主动检查 | 低 | ⭐⭐⭐ | OpenClaw | ✅ v5.0.0 |
| 🟢 P2 | 人格模板切换 | 低 | ⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🟢 P2 | 诊断系统 (`doctor`) | 低 | ⭐⭐⭐ | Hermes | ❌ 未实现 |
| 🔵 P3 | MCP 生态对接 | 高 | ⭐⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🔵 P3 | 浏览器控制 | 高 | ⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🔵 P3 | 子代理委派 | 高 | ⭐⭐⭐ | 共同 | ✅ v5.0.0 |
| 🔵 P3 | 训练数据导出 | 中 | ⭐⭐ | Hermes | ❌ 未实现 |
| ⚪ P4 | Cron 定时任务 | 中 | ⭐⭐ | OpenClaw | ✅ v5.0.0 |

### 待实施功能

| 功能 | 复杂度 | 说明 |
|------|--------|------|
| `/compress` 上下文压缩 | 中 | LLM 摘要中间轮次，而非简单滑动窗口 |
| 诊断系统 (`doctor`) | 低 | 设置面板一键检查连接/模型/权限/磁盘 |
| 训练数据导出 | 中 | traces → SFT 格式导出 |
| Skill 渐进式加载 | 中 | Level 0→1→2，先返回名称+描述，需要时再加载全文 |
| Session 谱系跟踪 | 中 | 压缩后创建子 session，保留 parent_id |

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

  已吸收（v5.0.0 ~ v5.1.3）：
  ✅ 技能自动生成（Hermes） — v5.1.0
  ✅ 用户画像模型（Hermes） — v5.0.0
  ✅ /retry /undo 会话操作（共同） — v5.0.0
  ✅ MCP 生态对接（共同） — v5.0.0
  ✅ 浏览器控制（共同） — v5.0.0
  ✅ Heartbeat 主动检查（OpenClaw） — v5.0.0
  ✅ Cron 定时任务（OpenClaw） — v5.0.0
  ✅ 子代理委派（共同） — v5.0.0
  ✅ 记忆容量管理 + 安全扫描（Hermes） — v5.1.2 / v5.1.0
  ✅ Shadowing 防护（Hermes） — v5.1.2
  ✅ 预算警告临时层（Hermes） — v5.1.2

  待吸收：
  🔜 /compress 上下文压缩（Hermes Context）
  🔜 诊断系统 doctor（Hermes）
  🔜 Skill 渐进式加载（Hermes）
  🔜 训练数据导出（Hermes）

最终形态 = 会学习的桌面 Agent
  = Metona 的原生桌面体验
  + Hermes 的学习进化能力
  + OpenClaw 的工程化实践
```

---

*最后更新：2026-04-19（根据 v5.1.3 实际代码更新实施状态）*
