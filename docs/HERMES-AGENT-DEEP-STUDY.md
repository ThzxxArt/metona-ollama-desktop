# Hermes Agent 深度研究 — Metona 可借鉴方案

> 基于 2026-04-18 对 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 源码和文档的深度研究。
> 定位：与 `OPENCLAW-HERMES-ANALYSIS.md` 互补，侧重**实现细节和可落地方案**。

---

## 一、Hermes 核心架构一览

```
语言：Python（~40K 行代码）
核心文件：
  run_agent.py       — AIAgent 类（~10,700 行），Agent Loop 引擎
  cli.py             — TUI 终端界面（~10,000 行）
  model_tools.py     — 工具发现、Schema 收集、调度
  tools/registry.py  — 中央工具注册表（47 个工具，19 个 toolset）
  hermes_state.py    — SQLite 状态数据库（FTS5）
  prompt_builder.py  — System Prompt 组装
  context_compressor.py — 上下文压缩
```

### 关键设计原则

| 原则 | 实践 |
|------|------|
| Prompt 稳定性 | System prompt 在对话中不变化，保护 LLM prefix cache |
| 可观测执行 | 每个工具调用通过 callback 通知用户 |
| 可中断 | API 调用和工具执行可被用户输入中断 |
| 平台无关核心 | 一个 AIAgent 类服务 CLI/Gateway/ACP/Batch/API |
| 松耦合 | MCP/插件/记忆提供者使用 registry 模式 + check_fn |
| Profile 隔离 | 每个 profile 独立 HERMES_HOME、配置、记忆、会话 |

---

## 二、Agent Loop 对比

### Hermes 的 Agent Loop

```
用户输入 → build_system_prompt() → resolve provider → API 调用
  → 有 tool_calls？→ 并行执行（ThreadPoolExecutor）→ 循环
  → 无 tool_calls？→ 持久化 → 返回
```

**关键差异：**

| 维度 | Hermes | Metona |
|------|--------|--------|
| API 模式 | 3 种（chat_completions / codex_responses / anthropic_messages） | 1 种（Ollama chat） |
| 工具执行 | 单工具主线程，多工具 ThreadPoolExecutor 并行 | 同一批次 Promise.all 并行 |
| 中断机制 | 后景线程 + interrupt event | AbortController |
| 迭代预算 | 90 轮（可配置） | ✅ 默认 85 轮，设置面板可配（v5.1.1） |
| 上下文压缩 | context_compressor.py 摘要中间轮次 | context-manager.ts 滑动窗口 |
| Prompt 缓存 | Anthropic prompt caching 支持 | 无 |
| 消息交替 | 严格 user→assistant 交替 | Ollama 自动处理 |
| 回调系统 | 8 种 callback（progress/thinking/reasoning/clarify/step/stream/status） | 5 种 callback |

### Metona 可借鉴

1. **迭代预算可配置化**：从硬编码 15 轮改为 `state.get('maxTurns', 15)`
2. **工具执行分单/并行逻辑优化**：单工具直接执行，多工具并行（Hermes 的 ThreadPoolExecutor 思路）
3. **上下文压缩**：当 context 超过 50% 时自动摘要中间轮次，而非简单滑动窗口

---

## 三、工具系统对比

### Hermes 的 Tool Registry

```python
# tools/registry.py — 中央注册表
class ToolRegistry:
    def register(self, name, toolset, schema, handler, check_fn, ...):
        # 每个 tool 文件在 import 时自动注册
        # 防止 shadowing（MCP 不能覆盖内置工具）
    
    def discover_builtin_tools(self):
        # AST 扫描 tools/*.py，找到 registry.register() 调用的文件自动 import
```

**关键差异：**

| 维度 | Hermes | Metona |
|------|--------|------|
| 注册方式 | 每个文件 import 时自动 register() | 集中式 getToolDefinitions() |
| 工具数量 | 47 个 + 19 个 toolset | 38 个内置 + MCP 动态注册 |
| Toolset | 工具分组，可按组启用/禁用 | 无分组，全部启用 |
| Shadowing 防护 | MCP 不能覆盖内置工具 | ✅ 已实现（v5.1.2） |
| 工具发现 | AST 扫描自动发现 | 手动导入 |
| 结果截断 | max_result_size_chars 每工具可配 | ✅ 按工具独立配置（v5.1.0） |
| 安全审批 | tools/approval.py 危险命令检测 + 用户确认 | tool-security.ts 路径/命令检查 |

### Metona 可借鉴

1. ✅ **结果截断按工具配置**：不同工具设置不同的 max_result_size_chars（v5.1.0 已实现）
2. ✅ **Shadowing 防护**：MCP 工具注册时检查是否与内置工具重名（v5.1.2 已实现）
3. ❌ **Toolset 分组**：将 38 个工具分为文件系统/系统网络/记忆会话/浏览器/MCP 等组，用户可按组启用/禁用

---

## 四、记忆系统对比

### Hermes 的记忆

| 维度 | Hermes | Metona |
|------|--------|--------|
| 存储方式 | 2 个 Markdown 文件（MEMORY.md + USER.md） | SQLite（memories 表 + FTS5） |
| 容量限制 | MEMORY.md 2200 字符，USER.md 1375 字符 | ✅ 上限 500 条，超限自动清理（v5.1.2） |
| 注入方式 | 会话开始时冻结快照注入 system prompt | 每次用户消息时检索注入 |
| 管理方式 | Agent 通过 memory tool 自主管理 | Agent 通过 memory_search/memory_add 工具 |
| 操作 | add / replace / remove（子串匹配） | ✅ search / add / replace / remove（v5.1.0） |
| 会话搜索 | session_search（FTS5 + Gemini 摘要） | session_read（原始内容） |
| 外部提供者 | 8 个插件（Honcho / Mem0 / OpenViking 等） | 无 |
| 安全扫描 | 注入检测 + 凭证外泄检测 | ✅ prompt injection / 敏感信息 / 不可见字符检测（v5.1.0） |

### Metona 可借鉴

1. ✅ **记忆容量限制**：上限 500 条，超限自动清理低价值条目（v5.1.2 已实现）
2. ✅ **replace/remove 操作**：记忆工具支持修改和删除（v5.1.0 已实现）
3. ✅ **安全扫描**：记忆条目写入前检查 prompt injection / 凭证外泄模式（v5.1.0 已实现）
4. ❌ **冻结快照模式**：会话开始时一次性注入记忆，不随对话变化（保护 LLM cache）
5. ❌ **记忆区分层**：MEMORY.md（环境/工作流）vs USER.md（用户画像）清晰分离

---

## 五、Skill 系统对比

### Hermes 的 Skill

| 维度 | Hermes | Metona |
|------|--------|------|
| 格式 | SKILL.md（Markdown 文件，YAML frontmatter） | SQLite skills 表 |
| 加载方式 | 渐进式披露（Level 0→1→2） | 匹配后全文注入 |
| 触发条件 | `/<skill-name>` 斜杠命令 + 自然对话 | 自动匹配关键词 |
| 创建时机 | 5+ 工具调用的复杂任务完成后 | 2+ 工具调用后 |
| 更新方式 | create / patch / edit / delete | 仅 create |
| 条件激活 | fallback_for_toolsets / requires_toolsets | 无 |
| Skill Hub | 在线注册表浏览/安装 | 无 |
| agentskills.io 兼容 | ✅ 开放标准 | ❌ |

### Metona 可借鉴

1. **渐进式加载**：先返回技能名称+描述（~3K tokens），Agent 需要时再加载全文
2. **patch 更新**：Agent 可以用 old_string/new_string 局部修改技能，而非全文替换
3. **条件激活**：某些技能只在特定工具不可用时才显示（fallback 机制）
4. **SKILL.md 格式标准化**：采用 YAML frontmatter + 结构化正文（When to Use / Procedure / Pitfalls / Verification）

---

## 六、Prompt 组装对比

### Hermes 的 Prompt Builder

```
prompt_builder.py 组装顺序：
1. Personality（SOUL.md）
2. Memory（MEMORY.md + USER.md 冻结快照）
3. Skills（渐进式索引）
4. Context Files（AGENTS.md, .hermes.md）
5. Tool-use guidance
6. Model-specific instructions
7. Ephemeral layers（budget warnings, context pressure）
```

**关键差异：**

| 维度 | Hermes | Metona |
|------|--------|------|
| 组装来源 | 6 层 + 2 个临时层 | 4 层（记忆+工作空间+Agent提示+人格） |
| 缓存保护 | Prompt 稳定性原则，不随对话变化 | 每次消息重新组装 |
| 预算警告 | 迭代接近上限时注入警告层 | 无 |
| 上下文压力 | context 超 50% 时注入压缩提示 | 无 |

### Metona 可借鉴

1. **临时层机制**：在 system prompt 末尾追加临时提示（预算警告、上下文压力），不影响基础 prompt 稳定性
2. **模型特定指令**：根据模型能力（tools/thinking/vision）动态调整 prompt 内容

---

## 七、上下文管理对比

### Hermes 的 Context Compression

```python
# context_compressor.py
# 当对话超过 context window 的 50% 时：
# 1. 保留首尾各 2-3 条消息
# 2. 中间消息用 LLM 摘要为 1-2 条 system 消息
# 3. 摘要后的消息标记为 compressed
# 4. 新消息基于压缩后的历史继续
```

| 维度 | Hermes | Metona |
|------|--------|--------|
| 压缩触发 | context > 50% | 无自动压缩 |
| 压缩方式 | LLM 摘要中间轮次 | 滑动窗口截断 |
| Session 谱系 | 压缩后创建子 session，保留 parent_id | 无谱系跟踪 |
| Token 估算 | model_metadata.py 按模型配置 | 粗略估算（中 1.5字/token，英 4字符/token） |

### Metona 可借鉴

1. **LLM 摘要压缩**：context 超过阈值时，用 LLM 摘要中间轮次而非简单截断
2. **Session 谱系**：压缩后创建新 session 并保留 parent_id，支持回溯
3. **Token 估算精确化**：按模型配置 token 估算参数

---

## 八、可落地的改进清单

按优先级排序，基于 Metona 现状和投入产出比：

### P0 — 已实施

| 改进 | 来源 | 复杂度 | 改动文件 | 状态 |
|------|------|--------|----------|------|
| 迭代预算可配置 | Hermes Agent Loop | 低 | agent-engine.ts | ✅ v5.1.1（默认 85 轮，设置面板可配） |
| 记忆 replace/remove 操作 | Hermes Memory | 中 | memory-manager.ts + tool-registry.ts | ✅ v5.1.0 |
| 记忆安全扫描 | Hermes Memory | 低 | memory-manager.ts | ✅ v5.1.0 |
| 工具结果截断按工具配置 | Hermes Tool Registry | 低 | tool-registry.ts | ✅ v5.1.0 |

### P1 — 近期实施

| 改进 | 来源 | 复杂度 | 改动文件 | 状态 |
|------|------|--------|----------|------|
| Skill 渐进式加载 | Hermes Skills | 中 | skill-manager.ts + agent-engine.ts | ❌ 当前 Level 0，全文注入 |
| Skill patch 更新 | Hermes Skills | 中 | skill-manager.ts + tool-registry.ts | ❌ 仅 create |
| Toolset 分组管理 | Hermes Toolset | 中 | tool-registry.ts + settings-modal.ts | ❌ 未实现 |
| LLM 摘要压缩 | Hermes Context | 高 | context-manager.ts + agent-engine.ts | ❌ 未实现（仍用滑动窗口） |

### P2 — 中期规划

| 改进 | 来源 | 复杂度 | 状态 |
|------|------|--------|------|
| Skill 条件激活 | Hermes Skills | 中 | ❌ 未实现 |
| Session 谱系跟踪 | Hermes Session | 中 | ❌ 未实现 |
| 预算警告临时层 | Hermes Prompt | 低 | ✅ v5.1.2（≤5 轮 warning，≤2 轮 critical） |
| Shadowing 防护 | Hermes Registry | 低 | ✅ v5.1.2（MCP 工具注册时自动检测重名） |

---

## 九、Hermes vs Metona 定位总结

```
Hermes = 云端 Python Agent（CLI + Gateway + 多平台）
  ✅ 技能生态成熟（agentskills.io 开放标准）
  ✅ 记忆系统精巧（容量限制 + 冻结快照）
  ✅ 工具注册表自动发现
  ❌ 非桌面原生体验
  ❌ 需要 Python 环境

Metona = 本地 Electron 桌面 Agent
  ✅ 零配置启动，全离线
  ✅ 系统托盘 + 原生文件对话框
  ✅ 工作空间面板（终端 + 文件浏览器）
  ✅ 暖色调 UI
  ✅ MCP 协议支持（v5.0.0）
  ✅ 技能自动生成（v5.1.0）
  ✅ 记忆容量管理 + 安全扫描（v5.1.0 / v5.1.2）
  ❌ 技能渐进式加载（Level 0，全文注入）
  ❌ 上下文管理粗糙（滑动窗口，无 LLM 压缩）

互补方向：
  Metona 吸收 Hermes 的学习进化能力
  Hermes 不具备 Metona 的桌面原生体验
```

---

*最后更新：2026-04-19（根据 v5.1.3 实际代码更新实施状态）*
