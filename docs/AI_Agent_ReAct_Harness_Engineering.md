# AI Agent 工程化完整文档：ReAct Loop 与 Harness Engineering

> 本文围绕当下 AI Agent 工程化的两大核心命题展开：作为智能体"思考与执行内核"的 **ReAct Loop（推理-行动-观察循环）**，以及作为"运行环境与管控体系"的 **Harness Engineering（驾驭工程）**。两者共同构成生产级 AI Agent 的工程底座。

---

## 一、背景：从"调教模型"到"建造系统"

2026 年，AI Agent 的叙事重心发生了根本性转移：从追求单个 Agent 的"智力上限"，转向构建整个系统的"可靠性下限"。大模型早已不是 AI 落地的唯一瓶颈，行业已达成共识：

```
Agent = Model + Harness
```

模型是引擎，而 Harness（驾驭系统）才是决定智能体能否稳定跑完复杂长任务、从演示级走向生产级的关键。

AI 工程范式经历了三个阶段的演进：

| 阶段 | 时间范围 | 核心关注点 | 解决的问题 | 典型技术 |
|---|---|---|---|---|
| Prompt Engineering | 2022-2024 | 如何让模型理解你的意图 | 单次输出的质量 | 提示词模板、Few-shot 示例 |
| Context Engineering | 2025 | 如何给模型正确的知识边界 | 给模型看什么信息 | RAG、上下文窗口管理 |
| Harness Engineering | 2026- | 如何让 Agent 可靠、持续、不失控 | 多步骤、长周期任务的可靠性 | 状态机、沙箱、权限系统 |

这个演进路径反映了 AI 工程从"单点优化"到"系统构建"的转变：早期关注如何让模型"听懂人话"，中期关注如何给模型"正确的参考资料"，而现在关注如何让整个系统"持续稳定运行"。

---

## 二、ReAct Loop：Agent 的思考与执行内核

### 2.1 ReAct 的起源与定义

ReAct 源自普林斯顿大学与 Google Brain 于 2022 年联合发表的经典论文《ReAct: Synergizing Reasoning and Acting in Language Models》。在 ReAct 出现之前，大模型只有单纯的推理能力（Reasoning），存在严重的幻觉、知识滞后、无法实操的问题；而单纯的工具调用只有行动能力（Acting），缺乏逻辑推理，无法自主判断何时调用工具、调用什么工具。

ReAct 的核心颠覆式创新在于：**将大模型的推理思考（Thought）与外部工具行动（Action）进行闭环融合**。

```
ReAct = Reasoning（推理思考） + Acting（工具行动）
```

它是一套迭代式循环执行范式：Agent 不再一次性输出答案，而是通过「思考→行动→观察→再思考」的无限循环，逐步拆解复杂任务、调用外部工具、修正推理偏差，直到任务完成。ReAct 是目前 90% 以上开源 Agent（LangChain、LlamaIndex、Meta Agent）的底层核心执行逻辑，也是工业界公认的 AI Agent 标准思考框架。

### 2.2 T-A-O 三步循环机制

所有基于 ReAct 的 Agent，底层都是统一的 **T-A-O 循环闭环**，这是必须掌握的核心底层逻辑。

```
用户提问 → Thought 思考 → Action 行动 → Observation 观察 → 任务完成? → 否 → 再次 Thought → 是 → 输出最终答案
```

**1. Thought（推理思考）**

大模型基于当前用户问题、历史上下文、已有工具列表，进行自主推理判断：
- 当前任务是否需要调用工具？
- 需要调用哪一个工具？
- 工具入参应该如何构造？
- 当前任务是否已经完成，可以直接输出答案？

这一步是 Agent 的智能核心，完全依靠大模型的理解与推理能力。

**2. Action（工具行动）**

Agent 根据 Thought 的推理结果，通过 Harness 工具编排层，执行具体外部操作：
- 调用计算器、搜索引擎、数据库查询、接口请求、代码解释器等
- 严格按照 Harness 约束规则执行，受超时、重试、权限管控
- 单次仅执行单一工具任务，保证流程可控

**3. Observation（结果观察）**

获取 Action 工具执行的返回结果，将结果作为新的上下文信息喂给大模型，进入下一轮循环。Observation 是修正模型幻觉、补充真实信息的关键，让模型不再依赖陈旧参数知识。

完整闭环逻辑为：用户提问 → Thought 思考 → Action 执行工具 → Observation 获取结果 → 再次 Thought 迭代 → 任务完成 → 输出最终答案。

### 2.3 ReAct 范式与传统一次性 Prompt 的对比

很多新手分不清普通问答和 Agent 的区别，本质就是「是否具备 ReAct 循环能力」：

| 对比维度 | 传统一次性 Prompt 问答 | ReAct 智能体范式 |
|---|---|---|
| 执行方式 | 单次推理、一次性输出结果 | 迭代式循环、多轮思考执行 |
| 信息来源 | 仅依赖模型训练参数知识 | 模型知识 + 实时外部工具数据 |
| 复杂任务能力 | 无法拆解，复杂问题直接答错 | 自动拆解分步解决，适配复杂业务 |
| 幻觉概率 | 极高，知识滞后严重 | 大幅降低，以工具真实结果为准 |
| 工程依赖 | 无需 Harness，纯 Prompt 即可 | 强依赖 Harness 流程与工具管控 |
| 落地场景 | 简单问答、文案生成 | 企业自动化、数据查询、任务调度 |

### 2.4 ReAct 核心约束 Prompt 模板

ReAct 之所以能自动完成 T-A-O 循环，核心靠固定格式的系统 Prompt 约束，这也是 Harness 规则约束层的核心体现。原生 ReAct 标准 Prompt 核心结构如下：

```
你是一个可以自主思考和调用工具的智能体。
你需要遵循【Thought → Action → Observation】循环逻辑解决问题。
可用工具列表：{tools}
严格遵循输出格式：
1. 思考(Thought): 分析当前问题，判断是否需要调用工具
2. 行动(Action): 需要调用工具时，输出工具名称和参数
3. 观察(Observation): 接收工具返回结果
如果已经获取足够信息，无需继续调用工具，直接输出最终答案。
问题：{input}
历史记录：{agent_scratchpad}
```

其中 `agent_scratchpad` 是 ReAct 的核心缓存，记录每一轮的 Thought、Action、Observation，保存迭代全过程状态，属于 Harness 上下文记忆层能力；`tools` 是 Harness 注册的全部可调用工具列表；`input` 是用户原始任务指令。

---

## 三、Harness Engineering：Agent 的运行环境与管控体系

### 3.1 核心概念与思想

Harness Engineering，也叫"驾驭工程"或 Agent Harness，是围绕 AI Agent 构建工作环境的一套工程方法。它的目标不是让模型"回答得更好看"，而是让 Agent 在真实工程系统里：
- 能理解任务
- 能读取必要上下文
- 能调用合适工具
- 能安全修改代码
- 能运行测试验证
- 能观察日志和失败原因
- 能根据反馈继续修复
- 能在边界内完成交付

简而言之：**Prompt 是你怎么跟模型说话，Harness 是你怎么给 Agent 搭工作台**。如果说大模型本身提供的是推理和生成能力，那么 Harness 提供的就是工程环境、工具系统、反馈机制和安全边界。

Harness 的原意是"马具"——套在马身上用于控制方向、承受重负、连接马车的那套皮革与金属装置。这个比喻非常精准：大模型就像一匹充满力量但难以预测的野马，而 Harness 就是那套让它变得可控、有用的装置。更精确的公式是：

```
生产级 Agent = 模型潜能 - 模型熵增 + Harness 约束
```

其中"模型熵增"指大模型基于概率生成的不确定性，输入微小的 Prompt 变化可能导致巨大的行为漂移；而"Harness 约束"则是用确定性的代码逻辑去框住不确定的模型输出。Harness Engineering 的核心思想是：**每当 Agent 犯错，就将其工程化为一个永久性的系统修复，确保它不会再犯同样的错误**。

### 3.2 Harness 与 Prompt 工程的本质区别

| 维度 | Prompt Engineering | Harness Engineering |
|---|---|---|
| 核心问题 | 如何措辞指令 | 如何构建可靠系统 |
| 作用范围 | 单次推理 | 全任务生命周期 |
| 控制手段 | 文本指令 | 工具 + 约束 + 反馈 + 基建 |
| 失败模式 | 误解意图 | 缺乏纠错机制 |
| 可复现性 | 依赖模型一致性 | 依赖工程化保障 |
| 类比 | 写指令邮件 | 建项目管理体系 |

一个具体例子可以说明这种区别。你在 prompt 里写"请遵守项目架构，不要跨层调用"——这是 Prompt 工程；但如果你把架构边界写进 custom linter，每次 Agent 改完代码都会被自动检查，违反规则就失败——这就是 Harness 工程。Prompt 可以是 Harness 的一部分，但 Harness 远远不止 Prompt。

### 3.3 Harness 七层内核

一个生产级 Harness 由七大协同组件构成，共同约束与增强智能体行为：

1. **System Prompts（系统提示）**：行为宪法，定义身份、边界、硬约束。
2. **Tools and Capabilities（工具与能力）**：精准能力接口，命名自解释、参数精确、错误可修复。
3. **Infrastructure（基础设施）**：沙箱、执行引擎、文件系统等安全运行环境。
4. **Orchestration Logic（编排逻辑）**：子智能体调度、任务分发与路由。
5. **Hooks and Middleware（钩子与中间件）**：确定性检查点，安全门控、质量回路、完成门控、可观测性。
6. **Memory and State（记忆与状态）**：进度与记忆持久化，避免长任务"失忆"。
7. **Verification Systems（验证系统）**：Linter、测试、审查 Agent，最后质量防线。

它们联动形成闭环：验证触发 Hook，记忆动态组装 Prompt，编排决定工具调用。

### 3.4 引导系统与反馈系统：双控机制

为方便理解，可以把 Harness 工程拆成两大子系统：

**引导系统（前馈控制 Guide）**——Agent 执行前，怎么知道该怎么做。核心是把项目里的隐性规则显性化，常见内容包括 AGENTS.md、CLAUDE.md、README、架构文档、编码规范、目录结构说明、项目启动脚本、测试命令说明、API 文档、领域知识、任务拆解模板、团队 review checklist 等。它的作用是行动前设路标与护栏，从源头减少错误。

**反馈系统（反馈控制 Sensor）**——Agent 执行后，怎么知道有没有做对。常见内容包括单元测试、接口测试、端到端测试、类型检查、linter、静态扫描、架构测试、安全扫描、浏览器自动化、运行日志、metrics、traces、错误堆栈、代码评审 Agent、LLM Judge、人工 review。反馈内部再分为：
- **计算性反馈**：规则驱动、毫秒级、100% 可靠，优先用
- **推理性反馈**：AI 判断、秒级、非确定，作为补充

---

## 四、ReAct 与 Harness 的层级关系

结合 AI Agent 完整工程化体系，三者层级关系清晰可见：

```
1. LLM 模型：提供基础推理智能，是 Agent 的大脑基础
2. ReAct 范式：定义大脑的思考方式（T-A-O 循环），是 Agent 的执行内核逻辑
3. Harness 工程：为 ReAct 循环提供约束、容错、记忆、监控、工具调度的整套运行环境
```

终极公式为：

```
企业级 Agent = LLM + ReAct 执行逻辑 + Harness 工程管控
```

如果大模型是 Agent 的大脑，那 ReAct 就是 Agent 的"思考与行动规则"，是让 AI 从"只会说话"变成"会干活"的关键转折点；而 Harness 则是为这套规则提供可靠运行环境的"操作系统"。ReAct 是执行内核，Harness 是运行环境，二者缺一不可。

---

## 五、生产级 Agent Harness 四层架构

深入分析 Claude Code、OpenCode、OpenClaw、Hermess 等代表性生产级 Agent 项目，可以发现一个生产级的 Agent Harness 通常分为四层，每一层都有明确的职责和边界。

### 5.1 架构全景

这四层围绕"感知→决策→行动→反馈"闭环紧密协作：

1. **推理与编排层**：Agent 的"大脑与调度中心"，负责核心决策逻辑。
2. **上下文与记忆层**：Agent 的"工作记忆与长期记忆"，管理输入和进化。
3. **工具与安全执行层**：Agent 的"双手与安全护栏"，封装外部调用。
4. **支撑与基础架构层**：Agent 的"神经系统与循环系统"，提供底层支撑。

以"帮我在项目里添加用户登录功能"为例，完整流程为：支撑层接收请求并分配会话 ID → 上下文层组装输入（从 CLAUDE.md 读取技术栈、从记忆系统加载用户偏好）→ 推理层启动 Plan Mode 生成任务清单 → 用户批准后进入 Execute Mode → 安全层拦截工具调用做 AST 分析与风险评估 → 执行结果返回推理层 → 循环继续。

### 5.2 推理与编排层：Agent Loop 的状态机化

最基础的 Agent Loop 就是一个 while 循环：

```javascript
while (!done) {
  const response = await callLLM(messages);
  if (response.toolCalls.length > 0) {
    const results = await executeTools(response.toolCalls);
    messages.push(...results);
  } else {
    done = true;
    return response.content;
  }
}
```

但在生产环境中这远远不够，需要处理流式响应、并行执行、错误恢复、用户中断、状态持久化等问题。因此生产级系统普遍采用状态机管理循环，例如 Claude Code 内部定义了精细的状态：

```javascript
enum LoopState {
  INIT = 'INIT',           // 初始化，准备上下文
  THINKING = 'THINKING',   // 正在调用 LLM
  PARSING = 'PARSING',     // 解析 LLM 输出
  EXECUTING = 'EXECUTING', // 执行工具（可能并行）
  OBSERVING = 'OBSERVING', // 收集工具结果
  REFLECTING = 'REFLECTING', // （可选）反思结果
  COMPRESSING = 'COMPRESSING', // 触发上下文压缩
  TERMINATED = 'TERMINATED' // 终止
}
```

状态机的优势在于明确的阶段划分、易于调试、支持暂停/恢复、错误隔离。实现要点包括：状态转换要原子化、状态数据要隔离、超时控制要精细、可观测性要内置。每个状态对应一个独立的处理器（Handler），状态机只负责调度。

对于复杂任务，还支持多智能体编排，常见两种模式：
- **父子委派模式**（主 Agent 通过 Task 工具委派子任务给 SubAgent，具备上下文隔离、递归深度限制、结果聚合）
- **对等协作模式**（多个 Agent 组成团队，通过消息总线异步通信）

### 5.3 上下文与记忆层：System Prompt 的结构化组装

生产级系统的 System Prompt 分为静态区和动态区。静态区（角色定义、输出格式、安全规范）放在前面以利用 LLM 缓存，减少 Token 消耗；动态区（项目名、技术栈、当前任务、历史摘要）放在后面每次更新。

项目级上下文通过智能加载机制实现：Agent 启动时自动扫描项目根目录，按优先级寻找 CLAUDE.md、AGENTS.md、.claude/context.md 等配置文件，并对内容做智能截断（只取前 N 个 Token）。

### 5.4 上下文工程：渐进式披露

上下文是稀缺资源，上下文腐烂和描述膨胀会让准确率暴跌。核心策略是**渐进式披露**，分三层管理：

- **索引层**：始终保留项目结构、入口地图。
- **接口层**：操作模块时加载 API 与约束。
- **实现层**：修改文件时才加载源码。

用目录式索引告诉智能体"去哪找"，而非"全记住"，上下文可从数万 Token 压至几千。

---

## 六、实战：从零实现标准 ReAct Agent

下面给出一份基于 LangChain 的标准原生 ReAct 智能体完整可运行代码，完整保留 T-A-O 循环、格式约束、容错机制与 Harness 管控能力，适配国内开源大模型。

### 6.1 环境依赖

```bash
pip install langchain langchain-openai python-dotenv
```

### 6.2 完整可运行代码

```python
from dotenv import load_dotenv
import os
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_react_agent
from langchain.tools import CalculatorTool
from langchain_community.utilities import WikipediaAPIWrapper
from langchain_community.tools import WikipediaQueryRun
from langchain.prompts import PromptTemplate
from langchain.globals import set_debug

# 加载环境变量
load_dotenv()
# 开启全链路日志（Harness 可观测能力）
set_debug(True)

# ===================== 1. 初始化模型（适配国内任意 OpenAI 格式接口） =====================
llm = ChatOpenAI(
    model="qwen-turbo",
    temperature=0.0,  # 零随机性，保证 ReAct 思考逻辑稳定
    openai_api_key=os.getenv("OPENAI_API_KEY"),
    openai_api_base=os.getenv("OPENAI_API_BASE")
)

# ===================== 2. 注册工具（Harness 工具层） =====================
calc_tool = CalculatorTool()
wiki_api = WikipediaAPIWrapper(top_k_results=1, doc_content_chars_max=500)
wiki_tool = WikipediaQueryRun(api_wrapper=wiki_api)
tools = [calc_tool, wiki_tool]

# ===================== 3. 标准 ReAct 约束 Prompt（核心） =====================
react_prompt = PromptTemplate.from_template("""
你是严格遵循 ReAct 范式的智能体，必须按照 Thought → Action → Observation 循环执行任务。
可用工具：{tools}
执行规则：
1. 遇到需要计算、外部知识查询的问题，必须调用工具，禁止自行编造答案
2. 每一轮只能做一次思考 + 一次工具调用
3. 信息足够后，停止循环，输出简洁完整的最终答案
用户问题：{input}
执行过程记录：{agent_scratchpad}
""")

# ===================== 4. 创建 ReAct Agent + Harness 管控 =====================
agent = create_react_agent(llm, tools, react_prompt)

# Harness 容错、限流、防死循环配置
agent_executor = AgentExecutor(
    agent=agent,
    tools=tools,
    verbose=True,
    max_iterations=5,            # 最大循环次数，防止 ReAct 死循环
    handle_parsing_errors=True,  # 解析异常兜底
    timeout=15,                  # 超时熔断
    return_intermediate_steps=True  # 返回完整 ReAct 步骤
)

# ===================== 5. 测试运行 =====================
if __name__ == "__main__":
    query = "请查询圆周率的近似定义，并计算 3.14159 * 128 的结果"
    result = agent_executor.invoke({"input": query})
    print("=" * 50)
    print("最终答案：", result["output"])
    print("=" * 50)
    print("完整 ReAct 迭代步骤：")
    for step in result["intermediate_steps"]:
        print(f"步骤详情：{step}")
```

### 6.3 运行逻辑解析

执行过程遵循标准 ReAct 多轮迭代闭环：
1. 第一轮 Thought 识别任务需要先查询圆周率定义，调用维基百科工具
2. 第一轮 Action 执行百科查询
3. 第一轮 Observation 拿到文本信息，判断还需要数学计算
4. 第二轮 Thought 决定调用计算器工具执行乘法
5. 第二轮 Action 执行计算
6. 信息充足，终止循环输出最终答案

---

## 七、ReAct 工程落地常见踩坑与优化

在 Harness 工程落地中，ReAct 是故障高发点，核心问题全部来自循环机制本身。

| 问题 | 现象 | 根因 | 解决方案 |
|---|---|---|---|
| 无限循环 | Agent 反复调用同一工具，无法结束任务 | 模型无法判断任务是否完成、工具返回信息重复 | Harness 层配置 `max_iterations` 最大迭代限制，强制熔断 |
| 格式解析失败 | 模型输出不遵循 Thought/Action 格式，任务中断 | Prompt 约束不严格 | 开启 `handle_parsing_errors` 异常兜底，优化 Prompt 格式约束 |
| 过度调用工具 | 简单问题也强行调用工具，浪费 Token | 缺乏常识判断规则 | 在 Prompt 中增加规则：简单常识问题可直接回答 |
| 上下文溢出 | 多轮迭代后 `agent_scratchpad` 过长触发超限 | 迭代日志累积 | 依托 Harness 记忆层，定时精简迭代日志、截断无效历史 |

### 企业级 ReAct 工程优化方案（结合 Harness 架构）

原生 ReAct 仅能实现基础能力，企业落地必须结合 Harness 架构做优化：

1. **约束层优化**：分级规则管控，简单任务弱约束、复杂任务强约束，平衡稳定性与灵活性。
2. **容错层优化**：智能重试 + 失败降级，工具调用失败时自动重试 2 次，重试失败后触发兜底答案，不中断业务流程。
3. **记忆层优化**：迭代过程轻量化存储，区分"有效迭代步骤"和"冗余日志"，长期只保存关键 ReAct 决策过程。
4. **可观测层优化**：步骤级监控，统计每轮 ReAct 迭代耗时、失败率、工具调用命中率，数据驱动优化。

---

## 八、Harness 落地实践与治理

### 8.1 真实项目落地清单

在一个前后端分离的业务项目里，要让 Coding Agent 帮忙修 Bug、改接口、补测试，可以这样设计 Harness：

1. 用 AGENTS.md 或 CLAUDE.md 做统一入口，告知 Agent 项目结构、常用命令、关键约束和禁止事项。
2. 把详细架构文档放到 docs 目录，让 Agent 按需读取，而不是每次都塞进 prompt。
3. 用 linter、类型检查和架构测试限制跨层调用，避免 Agent 改出"能跑但不符合架构"的代码。
4. 提供标准化启动脚本，如 `start-backend`、`start-frontend`、`run-unit-test`、`run-api-test`。
5. 对接口任务接入 Swagger、OpenAPI、Postman Collection 或自动化接口测试。
6. 对前端任务接入 Playwright，让 Agent 不只是看代码，而是真的打开页面验证。
7. 暴露运行日志、metrics 和 traces，让 Agent 失败后能看到原因，而不是凭空猜。
8. 在任务结束前加入 checklist，要求确认需求点、测试结果、修改范围和风险点。
9. 对复杂任务引入独立 Review Agent 或人工 review，避免单 Agent 自说自话。
10. 关键仓库必须配置权限和沙箱，限制 Agent 能访问什么、能修改什么、能执行什么命令。

### 8.2 治理三维度与落地四阶段

**治理三维度（从易到难）**：

1. **可维护性**：代码规范、圈复杂度，工具成熟、自动化高。
2. **架构适应性**：性能、安全、依赖审计，需复杂基建。
3. **行为正确性**：业务需求匹配，最难、自动化最低。

**落地四阶段**：

1. **基础验证**：部署 Lint 与测试，打底质量底线。
2. **前馈增强**：把失败转为 AGENTS.md 规则，显性化隐性知识。
3. **闭环优化**：高频错误变 Hook，形成自纠错。
4. **度量驱动**：用指标仪表盘数据定向优化。

### 8.3 转向循环：让错误只犯一次

Harness 的终极价值是**复利效应**：观察失败 → 诊断根因 → 工程化修复 → 编码进 Harness → 验证部署。把单次人工修正，变成永久规则。比如智能体总提交超大代码，加一条"单次提交≤200 行"，所有会话永久遵守，同类错误彻底消失。

Terminal-Bench 2.0 基准显示：同一模型仅换 Harness，排名可偏移超 25 位；精良 Harness 的中等模型，能打败粗糙 Harness 的顶级模型——**Harness 质量，才是性能决定性因素**。

---

## 九、总结

ReAct 不是一个框架、不是一个工具，而是 AI Agent 的标准思考与执行范式，是所有智能体实现"自主解决复杂任务"的核心底层。它通过 T-A-O 循环让 AI 从"只会说话"变成"会干活"。

Harness Engineering 则让 AI 工程范式从"调教模型"转向"建造系统"，把不可控的概率输出变成可控、可复现、可持续优化的生产级能力。它的核心是搭建可验证、可约束的运行体系，让 AI 能可靠完成长链路任务。

二者的关系是：**ReAct 是执行内核，Harness 是运行环境**。只有吃透 ReAct 的迭代闭环、踩坑痛点与工程优化，同时构建完善的 Harness 约束、容错、记忆、监控体系，才能开发出稳定、可落地、可迭代的企业级 AI Agent，而不是只能跑 Demo 的玩具智能体。

AI Agent 的竞争早已不是模型军备竞赛，而是系统工程能力的比拼——未来决定 AI 落地上限的，不是模型有多强，而是你的 Harness 有多稳。

---

## 参考来源

- 《ReAct: Synergizing Reasoning and Acting in Language Models》— Yao et al., Princeton & Google Brain, 2022
- Anthropic Claude Agent SDK 工程博客 — "Agent Harness"
- Mitchell Hashimoto — "Harness Engineering" 概念提出
- Terminal-Bench 2.0 基准测试数据
- Claude Code / OpenCode / OpenClaw / Hermess 生产级 Agent 项目源码分析
- CSDN 博客：《AI Agent 驾驭工程：从理论到生产级系统架构实战》
- CSDN 博客：《AI Agent 核心范式 ReAct 深度详解》
- CSDN 博客：《Harness Engineering：AI Agent 从"能用"到"可靠"的工程革命》
- 博客园：《面试官问：什么是 Harness 工程？》
- 腾讯新闻：《AI 大模型实战篇：AI Agent 设计模式 ReAct》
