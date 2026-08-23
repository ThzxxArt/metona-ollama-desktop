import { describe, it, expect } from 'vitest';
import { parseMemoryMd, serializeMemoryMd } from '../src/renderer/services/memory-service.js';

const HEAD = '# METONA MEMORY\n\n> 条目内容紧跟元数据行，直到下一个 ## 或文件末尾\n\n';

describe('MEMORY.md 序列化/解析往返', () => {
  it('解析标准条目并保留访问统计', () => {
    const md = HEAD +
      '## fact | id: mem_20260101_001 | importance: 8 | tags: a, b | hits: 3 | last: 1700000000000\n内容甲\n\n';
    const entries = parseMemoryMd(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('mem_20260101_001');
    expect(entries[0].importance).toBe(8);
    expect(entries[0].tags).toEqual(['a', 'b']);
    expect(entries[0].accessCount).toBe(3);
    expect(entries[0].lastAccessed).toBe(1700000000000);
    expect(entries[0].content).toBe('内容甲');
  });

  it('旧格式（无 hits/last）兼容解析', () => {
    const md = HEAD + '## rule | id: mem_20260101_002 | importance: 10 | tags: x\n规则内容\n\n';
    const entries = parseMemoryMd(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].accessCount ?? 0).toBe(0);
  });

  it('序列化包含访问统计后缀并可通过主进程校验正则', () => {
    const entries = parseMemoryMd(HEAD + '## fact | id: mem_20260101_003 | importance: 5 | tags: t\nhello\n\n');
    entries[0].accessCount = 2;
    entries[0].lastAccessed = 1700000001000;
    const out = serializeMemoryMd(entries);
    expect(out).toMatch(/\| hits: 2 \| last: 1700000001000/);
    // 与主进程 validateMemoryContent 同构的条目头正则
    const headerLine = out.split('\n').find(l => l.startsWith('## '))!;
    expect(headerLine).toMatch(
      /^##\s+(fact|preference|rule)\s*\|\s*id:\s*mem_\d{8}_\d{3}\s*\|\s*importance:\s*\d{1,2}\s*\|\s*tags:\s+(.+?)(?:\s*\|\s*hits:\s*(\d+)\s*\|\s*last:\s*(\d+))?\s*$/i
    );
  });

  it('零访问计数不写入后缀（保持旧格式简洁）', () => {
    const entries = parseMemoryMd(HEAD + '## fact | id: mem_20260101_004 | importance: 5 | tags: t\nhello\n\n');
    const out = serializeMemoryMd(entries);
    expect(out).not.toContain('hits:');
  });

  it('往返保持内容一致', () => {
    const src = HEAD +
      '## preference | id: mem_20260101_005 | importance: 7 | tags: p1, p2\n偏好一\n\n' +
      '## rule | id: mem_20260101_006 | importance: 9 | tags: r1\n规则一\n\n';
    const round = serializeMemoryMd(parseMemoryMd(src));
    expect(parseMemoryMd(round).map(e => [e.id, e.content])).toEqual([
      ['mem_20260101_005', '偏好一'],
      ['mem_20260101_006', '规则一'],
    ]);
  });
});
