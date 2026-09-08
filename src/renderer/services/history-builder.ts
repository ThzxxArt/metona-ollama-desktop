/**
 * History Builder — 从会话消息构建 Ollama 格式的历史消息列表（纯函数）
 *
 * 发送与 /retry 两条路径共用的唯一实现，保证跨 Loop 上下文一致。
 *
 * 核心契约（防重复注入）：调用方传入完整会话消息，本函数定位末尾的
 * 当前用户消息并排除它及其之后的所有内容——当前输入由
 * agent-engine.handleInit 以 userContent/images 重新构造注入。
 * 若历史中再包含一份当前输入，用户消息（含图片 base64）会被发送两份，
 * 视觉模型下图片 token 直接翻倍。
 *
 * 不注入 system 消息——系统提示词始终由 handleInit 统一构建，
 * 保证传给 API 时只有 1 条 system 且排在首位。
 */

import { formatToolResultForModel } from './result-formatter.js';
import type { ChatMessage, OllamaMessage } from '../types.js';

export function buildHistoryMessages(msgs: ChatMessage[], maxCount = 20): OllamaMessage[] {
  // 定位最后一条 user 消息（即本轮当前输入），排除它及其后的所有消息
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  const historyMsgs = lastUserIdx >= 0 ? msgs.slice(0, lastUserIdx) : msgs;

  const result: OllamaMessage[] = [];

  for (const msg of historyMsgs) {
    if (msg.role !== 'assistant' && msg.role !== 'user') continue;

    if (msg.role === 'user') {
      // 用 _apiContent（含附件 JSON 结构化数据），没有则回退 content
      const content = (msg as { _apiContent?: string })._apiContent || msg.content || '';
      result.push({ role: 'user', content, ...(msg.images?.length && { images: msg.images }) });
      continue;
    }

    // assistant：注入内容、thinking、images 与 tool_calls（Ollama 格式）
    const assistantMsg: OllamaMessage = {
      role: 'assistant',
      content: msg.content || '',
      ...(msg.think && { thinking: msg.think }),
      ...(msg.images?.length && { images: msg.images }),
    };
    if (msg.toolCalls?.length) {
      assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }
    result.push(assistantMsg);

    // 注入 tool 结果消息（role: 'tool'），复用 formatToolResultForModel
    // 保持与当前 Loop 格式一致
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        if (!tc.result) continue;
        const formattedResult = formatToolResultForModel(tc.name, tc.result);
        // R92: 工具结果格式标准化 — 添加统一头信息 + 数据边界标记
        const resultDuration = Date.now() - tc.timestamp;
        const resultSize = formattedResult.length;
        const sizeCategory = resultSize > 10000 ? 'large' : resultSize > 2000 ? 'medium' : 'small';
        const r92Header = `[工具:${tc.name} 状态:${tc.status} 耗时:${resultDuration}ms 大小:${sizeCategory}(${resultSize}字符)]`;
        result.push({
          role: 'tool',
          tool_name: tc.name,
          content: `<<<TOOL_RESULT_START name="${tc.name}">>>\n${r92Header}\n${formattedResult}\n<<<TOOL_RESULT_END>>>`,
        });
      }
    }
  }

  // 超过 maxCount 时从头部裁剪，保留最近的消息（旧实现在循环内 break，
  // 长会话会保留最旧的消息、丢失最近上下文）。
  // 裁剪点不得落在 tool 消息上——其所属 assistant(tool_calls) 会被切掉，产生孤立 tool 消息
  if (result.length > maxCount) {
    let cut = result.length - maxCount;
    while (cut < result.length && result[cut].role === 'tool') cut++;
    return result.slice(cut);
  }

  return result;
}
