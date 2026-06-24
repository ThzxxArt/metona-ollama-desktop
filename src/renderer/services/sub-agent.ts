/**
 * SubAgent - 子代理委派系统 (v0.10.2 增强版)
 * 子代理拥有受限工具集（只读），可独立完成调研/搜索/分析类任务
 * 主 Agent 通过 spawn_task 工具并行委派多个子代理
 */

import { state, KEYS } from '../state/state.js';
import { OllamaAPI } from '../api/ollama.js';
import { TOOL_DEFINITIONS } from './tool-registry.js';
import { getEnabledToolDefinitions } from './tool-registry.js';
import { logInfo, logWarn, logError } from './log-service.js';
import type { ToolResult, ToolCall, ToolDefinition } from '../types.js';

const SUB_AGENT_MAX_LOOPS = 10;    // 子代理最多 10 轮
const SUB_AGENT_TIMEOUT = 300000;  // 5 分钟超时

/** 子代理可用工具：只读类，不能修改文件系统 */
const SUB_AGENT_TOOL_WHITELIST = new Set([
  'read_file', 'list_directory', 'search_files',
  'web_search', 'web_fetch',
  'browser_extract', 'browser_screenshot',
  'memory',
  'session_list', 'session_read',
]);

/** 从总工具列表中筛选子代理可用的 */
function getSubAgentTools(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter(d => SUB_AGENT_TOOL_WHITELIST.has(d.function.name));
}

export interface SubAgentOptions {
  maxLoops?: number;
  timeout?: number;
  model?: string;
}

/**
 * 执行子代理任务
 * @param task 子任务描述
 * @param context 附加上下文
 * @param options 可选配置
 */
export async function executeSubAgent(
  task: string,
  context?: string,
  options: SubAgentOptions = {}
): Promise<ToolResult> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const model = options.model || state.get<string>('_defaultModel', '');
  const maxLoops = options.maxLoops ?? state.get<number>('subAgentMaxLoops', SUB_AGENT_MAX_LOOPS);
  const timeout = options.timeout ?? state.get<number>('subAgentTimeout', SUB_AGENT_TIMEOUT);
  const effectiveTimeout = timeout > 0 ? timeout : Infinity; // 0=禁用超时

  if (!api || !model) {
    return { success: false, error: '未选择模型，无法执行子任务' };
  }

  const tools = getSubAgentTools();
  const toolNames = [...SUB_AGENT_TOOL_WHITELIST].join(', ');
  logInfo(`子 Agent 启动`, `任务: ${task.slice(0, 80)} | 工具: ${toolNames} | 模型: ${model}`);

  // 如果子代理使用了不同于主 AI 的模型，获取该模型的实际上下文长度
  const defaultModel = state.get<string>('_defaultModel', '');
  let numCtx = state.get<number>(KEYS.NUM_CTX, 24576);
  if (model !== defaultModel) {
    try {
      const detail = await api.showModel(model);
      const modelInfo = detail.model_info || {};
      for (const key of Object.keys(modelInfo)) {
        if (key.endsWith('.context_length')) {
          numCtx = Number(modelInfo[key]) || numCtx;
          break;
        }
      }
    } catch { /* 获取失败用默认值 */ }
  }

  const systemPrompt = `你是一个子任务执行 Agent，拥有只读工具权限。请高效完成指定任务，给出结果报告。
${context ? `\n附加上下文：\n${context}` : ''}`;

  const messages: Array<{ role: string; content: string; tool_calls?: ToolCall[]; tool_name?: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ];

  let loopCount = 0;
  const startTime = Date.now();

  while (loopCount < maxLoops) {
    loopCount++;

    if (Date.now() - startTime > effectiveTimeout) {
      logWarn('子 Agent 超时', `${loopCount} 轮`);
      return { success: true, content: '子任务执行超时', loops: loopCount, duration: Date.now() - startTime, partial: true };
    }

    let content = '';
    let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    try {
      await api.chatStream({
        model,
        messages,
        stream: true,
        think: false,
        tools: tools as any,
        options: { num_ctx: numCtx, temperature: 0.3 }
      } as any, (chunk: any) => {
        if (chunk.message?.content) content += chunk.message.content;
        if (chunk.message?.tool_calls?.length) {
          for (const tc of chunk.message.tool_calls) {
            if (tc.function?.name && SUB_AGENT_TOOL_WHITELIST.has(tc.function.name)) {
              toolCalls.push({ name: tc.function.name, arguments: tc.function.arguments || {} });
            }
          }
        }
      });
    } catch (err) {
      logError('子 Agent 调用失败', (err as Error).message);
      return { success: false, error: (err as Error).message, loops: loopCount, duration: Date.now() - startTime };
    }

    // 无工具调用 → 完成
    if (toolCalls.length === 0) {
      logInfo(`子 Agent 完成`, `${loopCount} 轮, ${content.length} 字`);
      return { success: true, content, loops: loopCount, duration: Date.now() - startTime };
    }

    // 执行工具
    messages.push({ role: 'assistant', content, tool_calls: toolCalls.map(tc => ({
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments }
    })) });

    for (const tc of toolCalls) {
      try {
        const { executeTool } = await import('./tool-registry.js');
        const result = await executeTool(tc.name, tc.arguments);
        const resultStr = formatResult(tc.name, result);
        messages.push({
          role: 'tool',
          content: resultStr,
          tool_name: tc.name
        });
      } catch (err) {
        messages.push({
          role: 'tool',
          content: JSON.stringify({ success: false, error: (err as Error).message }),
          tool_name: tc.name
        });
      }
    }
  }

  logWarn('子 Agent 达到最大轮次', `${loopCount} 轮`);
  return { success: true, content: '达到最大轮次限制', loops: loopCount, duration: Date.now() - startTime, partial: true };
}

/** 格式化工具结果给子代理（不截断，和主AI一致） */
function formatResult(name: string, r: ToolResult): string {
  if (!r.success) return JSON.stringify({ success: false, error: r.error });
  return JSON.stringify(r);
}
