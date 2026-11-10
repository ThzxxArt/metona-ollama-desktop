import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, MODE_TOOLS } from '../src/renderer/services/tool-registry.js';

const EXPECTED = [
  'read_file',
  'write_file',
  'list_directory',
  'search_files',
  'edit_file',
  'delete_file',
  'file_transfer',
  'download_file',
  'compress',
  'diff',
  'run_command',
  'web_search',
  'web_fetch',
  'browser',
  'git',
  'memory',
  'session',
  'spawn_task',
];

describe('0.18.0 工具矩阵（33 → 18）', () => {
  it('恰好 18 个内置工具', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(18);
    expect(TOOL_DEFINITIONS.map((t) => t.function.name).sort()).toEqual([...EXPECTED].sort());
  });

  it('MODE_TOOLS 与合并后的工具名一致', () => {
    expect(MODE_TOOLS).toEqual([
      'run_command',
      'write_file',
      'delete_file',
      'edit_file',
      'file_transfer',
      'download_file',
      'compress',
    ]);
    for (const name of MODE_TOOLS) {
      expect(EXPECTED).toContain(name);
    }
  });

  it('read_file 支持单文件与 paths 批量', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'read_file')!;
    expect(def.function.parameters.properties.path).toBeTruthy();
    expect(def.function.parameters.properties.paths?.type).toBe('array');
    expect(def.function.parameters.required).toBeUndefined();
  });

  it('list_directory 支持 list/tree 两种格式', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'list_directory')!;
    expect(def.function.parameters.properties.format?.enum).toEqual(['list', 'tree']);
  });

  it('file_transfer 支持 copy/move', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'file_transfer')!;
    expect(def.function.parameters.required).toEqual(['operation', 'source', 'destination']);
    expect(def.function.parameters.properties.operation.enum).toEqual(['copy', 'move']);
  });

  it('browser 合并 9 个 action', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'browser')!;
    expect(def.function.parameters.properties.action.enum).toEqual([
      'open',
      'extract',
      'screenshot',
      'click',
      'type',
      'scroll',
      'wait',
      'evaluate',
      'close',
    ]);
  });

  it('session 合并 list/read', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'session')!;
    expect(def.function.parameters.properties.action.enum).toEqual(['list', 'read']);
  });
});
