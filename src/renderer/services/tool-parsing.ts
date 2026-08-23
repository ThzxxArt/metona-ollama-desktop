/**
 * Tool Parsing — 模型文本输出的工具调用解析（兜底）
 * 从 agent-engine.ts 拆分的纯解析模块。
 *
 * 覆盖场景：模型未通过原生 tool_calls 字段返回，而是在文本中书写工具调用。
 * 支持四种格式：Action/Action Input、<tool_call> XML、```json 代码块、函数调用语法。
 */

import { logInfo, logWarn } from './log-service.js';
import { TOOL_DEFINITIONS } from './tool-registry.js';
import type { ToolCall } from '../types.js';

/** 工具名白名单：从注册表派生（含 MCP 工具），不再手工维护 */
const VALID_TOOL_NAMES: Set<string> = new Set(TOOL_DEFINITIONS.map(d => d.function.name));

function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAMES.has(name) || name.startsWith('mcp_');
}

export function parseToolCallsFromText(content: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // 辅助函数：尝试解析 JSON 参数字符串，容错处理
  const tryParseArgs = (argsStr: string): Record<string, unknown> | null => {
    const TICK = String.fromCharCode(96);
    const tickJson = TICK + TICK + TICK + 'json';
    const tick3 = TICK + TICK + TICK;
    try {
      let cleaned = argsStr.split(tickJson).join('').split(tick3).join('').trim();
      return JSON.parse(cleaned);
    } catch {
      try {
        let fixed = argsStr
          .replace(/'/g, '"')
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .split(tickJson).join('')
          .split(tick3).join('')
          .trim();
        return JSON.parse(fixed);
      } catch {
        return null;
      }
    }
  };

  // 辅助函数：验证工具名并添加到结果
  const tryAddCall = (toolName: string, argsStr: string): boolean => {
    toolName = toolName.trim();
    if (!isValidToolName(toolName)) return false;
    const args = tryParseArgs(argsStr);
    if (!args) {
      logWarn('文本解析兜底: 工具 ' + toolName + ' 的参数 JSON 解析失败', argsStr.slice(0, 100));
      return false;
    }
    calls.push({ type: 'function', function: { name: toolName, arguments: args } });
    return true;
  };

  // ── 格式1: Action/Action Input ──
  const actionRegex = /\*{0,2}Action:?\*{0,2}\s*(\w+)\s+[\r\n\s]*\*{0,2}Action\s*Input:?\*{0,2}\s*(\{[\s\S]*?\})/gi;
  let match;
  while ((match = actionRegex.exec(content)) !== null) {
    tryAddCall(match[1], match[2]);
  }

  // ── 格式2: <tool_call> XML 标签 ──
  const xmlRegex = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  while ((match = xmlRegex.exec(content)) !== null) {
    const inner = match[1].trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(inner);
      const toolName = parsed.name || parsed.function?.name || '';
      const toolArgs = parsed.arguments || parsed.function?.arguments || parsed.parameters || {};
      if (toolName && isValidToolName(toolName)) {
        calls.push({ type: 'function', function: { name: toolName, arguments: toolArgs } });
      }
    } catch {
      // JSON 解析失败，尝试分别提取 name 和 arguments
      const nameMatch = inner.match(/"name"\s*:\s*"(\w+)"/i);
      if (nameMatch) {
        const argsMatch = inner.match(/"arguments"\s*:\s*(\{[\s\S]*\})/i);
        if (argsMatch) tryAddCall(nameMatch[1], argsMatch[1]);
      }
    }
  }

  // ── 格式3: ```json 代码块中含 "name" 字段 ──
  const codeBlockRegex = /```(?:json)?\s*(\{[\s\S]*?"name"\s*:\s*"\w+"[\s\S]*?\})\s*```/gi;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const jsonStr = match[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      const toolName = parsed.name || '';
      const toolArgs = parsed.arguments || parsed.parameters || {};
      if (toolName && isValidToolName(toolName)) {
        calls.push({ type: 'function', function: { name: toolName, arguments: toolArgs } });
      }
    } catch {
      // 解析失败忽略，其他格式可能匹配
    }
  }

  // ── 格式4: 函数调用语法 func_name({"key": "value"}) ──
  // 使用平衡括号匹配替代 [^}]*，支持嵌套 JSON 如 {"a": {"b": 1}}
  {
    const funcCallStart = /\b(\w+)\s*\(\s*\{/g;
    let fcMatch;
    while ((fcMatch = funcCallStart.exec(content)) !== null) {
      const toolName = fcMatch[1];
      const braceStart = fcMatch.index + fcMatch[0].length - 1; // 指向 '{'
      // 手动平衡匹配大括号
      let depth = 0;
      let endIdx = -1;
      let inString = false;
      let escapeNext = false;
      for (let i = braceStart; i < content.length; i++) {
        const ch = content[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx > 0) {
        const jsonStr = content.slice(braceStart, endIdx + 1);
        // 检查后面是否有闭合括号
        const afterClose = content.slice(endIdx + 1).match(/^\s*\)/);
        if (afterClose) {
          tryAddCall(toolName, jsonStr);
          // 移动 regex 位置到匹配结束后
          funcCallStart.lastIndex = endIdx + 1;
        }
      }
    }
  }

  if (calls.length > 0) {
    logInfo('文本解析兜底: 从回复中提取到 ' + calls.length + ' 个工具调用', calls.map(c => c.function.name).join(', '));
  }

  return calls;
}
