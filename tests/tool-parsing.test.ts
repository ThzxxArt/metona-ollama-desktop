import { describe, it, expect } from 'vitest';
import { parseToolCallsFromText } from '../src/renderer/services/tool-parsing.js';

describe('parseToolCallsFromText — 文本工具调用兜底解析', () => {
  it('解析 Action / Action Input 格式', () => {
    const content = `
Thought: 我需要读取一个文件
Action: read_file
Action Input: {"path": "src/main.ts"}
`;
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
    expect(calls[0].function.arguments.path).toBe('src/main.ts');
  });

  it('解析 <tool_call> XML 格式', () => {
    const content = `<tool_call>
{
  "name": "web_search",
  "arguments": {"query": "rust language"}
}
</tool_call>`;
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('web_search');
    expect(calls[0].function.arguments.query).toBe('rust language');
  });

  it('解析 ```json 代码块中含 name 字段', () => {
    const content = '```json\n{"name": "list_directory", "arguments": {"path": "."}}\n```';
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('list_directory');
  });

  it('解析函数调用语法 func({...}) 且支持嵌套 JSON', () => {
    const content = '需要执行 read_file({"path": "a", "opts": {"b": 1}})';
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
    expect((calls[0].function.arguments as Record<string, unknown>).opts).toEqual({ b: 1 });
  });

  it('未知工具名被忽略', () => {
    const content = 'Action: not_a_real_tool\nAction Input: {"path": "x"}';
    expect(parseToolCallsFromText(content)).toHaveLength(0);
  });

  it('无工具调用返回空数组', () => {
    expect(parseToolCallsFromText('这是一个普通回答，没有工具调用。')).toHaveLength(0);
  });

  it('容忍不带引号的单引号参数', () => {
    const content = "Action: read_file\nAction Input: {'path': 'file.txt'}";
    const calls = parseToolCallsFromText(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments.path).toBe('file.txt');
  });
});
