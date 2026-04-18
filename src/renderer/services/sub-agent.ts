/**
 * SubAgent - 子代理委派系统 (v4.3)
 * 允许主 Agent 将独立任务委派给子 Agent 执行
 * 子 Agent 独立运行，完成后将结果返回给主 Agent
 */

import { state, KEYS } from '../state/state.js';
import { OllamaAPI } from '../api/ollama.js';
import { logInfo, logWarn, logError, logAgentLoop } from './log-service.js';
import type { ToolResult } from '../types.js';

const SUB_AGENT_TIMEOUT = 120000; // 2 分钟超时
const SUB_AGENT_MAX_LOOPS = 5;    // 子 Agent 最多 5 轮

/**
 * 执行子 Agent 任务
 * @param task 子任务描述
 * @param context 附加上下文（主 Agent 提供的参考信息）
 * @returns 子 Agent 的执行结果
 */
export async function executeSubAgent(task: string, context?: string): Promise<ToolResult> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const model = state.get<string>('_defaultModel', '');

  if (!api || !model) {
    return { success: false, error: '未选择模型，无法执行子任务' };
  }

  logInfo(`子 Agent 启动`, `任务: ${task.slice(0, 80)}`);

  const systemPrompt = `你是一个子任务执行 Agent。你的任务是高效完成指定的单一任务，然后给出简洁的结果报告。
不要闲聊，不要说废话。直接执行任务，完成后给出结果。
${context ? `\n附加上下文：\n${context}` : ''}`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ];

  let resultContent = '';
  let loopCount = 0;
  const startTime = Date.now();

  try {
    while (loopCount < SUB_AGENT_MAX_LOOPS) {
      loopCount++;

      if (Date.now() - startTime > SUB_AGENT_TIMEOUT) {
        logWarn('子 Agent 超时', `${loopCount} 轮`);
        break;
      }

      let content = '';
      let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

      await api.chatStream({
        model,
        messages,
        stream: true,
        think: false,
        options: { num_ctx: 8192, temperature: 0.3 }
      } as any, (chunk: any) => {
        if (chunk.message?.content) content += chunk.message.content;
        if (chunk.message?.tool_calls?.length) {
          for (const tc of chunk.message.tool_calls) {
            if (tc.function?.name) {
              toolCalls.push({ name: tc.function.name, arguments: tc.function.arguments || {} });
            }
          }
        }
      });

      resultContent = content;

      if (toolCalls.length === 0) {
        // 子 Agent 完成
        logInfo(`子 Agent 完成`, `${loopCount} 轮, ${resultContent.length} 字`);
        return {
          success: true,
          content: resultContent,
          loops: loopCount,
          duration: Date.now() - startTime
        };
      }

      // 子 Agent 调用了工具（不支持，提示直接回答）
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: '你无法调用工具。请基于已有信息直接给出回答。如果需要工具才能完成，请说明你无法完成此任务及原因。'
      });
    }

    // 达到最大轮次
    logWarn('子 Agent 达到最大轮次', `${loopCount} 轮`);
    return {
      success: true,
      content: resultContent || '（子任务执行超时）',
      loops: loopCount,
      duration: Date.now() - startTime,
      partial: true
    };
  } catch (err) {
    logError('子 Agent 错误', (err as Error).message);
    return {
      success: false,
      error: (err as Error).message,
      loops: loopCount,
      duration: Date.now() - startTime
    };
  }
}
