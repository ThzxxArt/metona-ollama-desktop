/**
 * SubAgent - 子代理委派系统 (v0.9.0 增强版)
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
  'memory_search',
  'session_list', 'session_read',
  'skill_list', 'skill_view',
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
  const maxLoops = options.maxLoops ?? SUB_AGENT_MAX_LOOPS;
  const timeout = options.timeout ?? SUB_AGENT_TIMEOUT;

  if (!api || !model) {
    return { success: false, error: '未选择模型，无法执行子任务' };
  }

  const tools = getSubAgentTools();
  const toolNames = [...SUB_AGENT_TOOL_WHITELIST].join(', ');
  logInfo(`子 Agent 启动`, `任务: ${task.slice(0, 80)} | 工具: ${toolNames}`);

  const systemPrompt = `你是一个子任务执行 Agent，拥有只读工具权限。请高效完成指定任务，给出结果报告。
${context ? `\n附加上下文：\n${context}` : ''}`;

  const messages: Array<{ role: string; content: string; tool_calls?: ToolCall[] }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ];

  let loopCount = 0;
  const startTime = Date.now();

  while (loopCount < maxLoops) {
    loopCount++;

    if (Date.now() - startTime > timeout) {
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
        options: { num_ctx: 8192, temperature: 0.3 }
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

/** 简洁格式化工具结果给子代理 */
function formatResult(name: string, r: ToolResult): string {
  if (!r.success) return JSON.stringify({ success: false, error: r.error });
  switch (name) {
    case 'web_search': return JSON.stringify({ success: true, query: r.query, total: r.total, results: (r.results as any[])?.slice(0, 3) });
    case 'web_fetch': return JSON.stringify({ success: true, url: r.url, content: String(r.content || '').slice(0, 3000) });
    case 'read_file': return JSON.stringify({ success: true, path: r.path, content: String(r.content || '').slice(0, 3000) });
    default: return JSON.stringify({ success: true, ...r });
  }
}
