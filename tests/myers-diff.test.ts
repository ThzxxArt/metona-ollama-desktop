import { describe, it, expect } from 'vitest';
import { diffLines, buildUnifiedHunks } from '../src/main/myers-diff.js';

describe('diffLines', () => {
  it('全同文件返回全 equal', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(ops.every(op => op.op === 'equal')).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it('纯新增', () => {
    const ops = diffLines(['a'], ['a', 'x', 'y']);
    const inserts = ops.filter(op => op.op === 'insert');
    expect(inserts).toHaveLength(2);
    expect(ops.filter(op => op.op === 'equal')).toHaveLength(1);
    expect(ops.filter(op => op.op === 'delete')).toHaveLength(0);
  });

  it('纯删除', () => {
    const ops = diffLines(['a', 'x', 'y', 'b'], ['a', 'b']);
    expect(ops.filter(op => op.op === 'delete')).toHaveLength(2);
    expect(ops.filter(op => op.op === 'insert')).toHaveLength(0);
  });

  it('中部修改：前后缀裁剪 + LCS 精确差异', () => {
    const old = ['h1', 'h2', 'old1', 'old2', 't1', 't2'];
    const now = ['h1', 'h2', 'new1', 't1', 't2'];
    const ops = diffLines(old, now);
    expect(ops.filter(op => op.op === 'delete').map(op => old[op.oldIdx!])).toEqual(['old1', 'old2']);
    expect(ops.filter(op => op.op === 'insert').map(op => now[op.newIdx!])).toEqual(['new1']);
    // 前后缀 equal 保留
    expect(ops[0].op).toBe('equal');
    expect(ops[ops.length - 1].op).toBe('equal');
  });

  it('空文件对比', () => {
    expect(diffLines([], ['a'])).toEqual([{ op: 'insert', newIdx: 0 }]);
    expect(diffLines(['a'], [])).toEqual([{ op: 'delete', oldIdx: 0 }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('LCS 识别交叉公共子序列', () => {
    const old = ['a', 'b', 'c', 'd'];
    const now = ['b', 'd'];
    const ops = diffLines(old, now);
    expect(ops.filter(op => op.op === 'equal')).toHaveLength(2); // b、d 被识别为公共
    expect(ops.filter(op => op.op === 'delete')).toHaveLength(2); // a、c 删除
    expect(ops.filter(op => op.op === 'insert')).toHaveLength(0);
  });
});

describe('buildUnifiedHunks', () => {
  it('无差异返回空 hunks', () => {
    const ops = diffLines(['a'], ['a']);
    expect(buildUnifiedHunks(ops, ['a'], ['a'], 3).hunks).toEqual([]);
    expect(buildUnifiedHunks(ops, ['a'], ['a'], 3).additions).toBe(0);
  });

  it('生成带 @@ 头的 unified diff hunk', () => {
    const old = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
    const now = ['l1', 'l2', 'l3', 'CHANGED', 'l5', 'l6', 'l7'];
    const ops = diffLines(old, now);
    const { hunks, additions, deletions } = buildUnifiedHunks(ops, old, now, 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatch(/^@@ -1,7 \+1,7 @@/);
    expect(hunks[0]).toContain('-l4');
    expect(hunks[0]).toContain('+CHANGED');
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });

  it('相距较远的多处修改生成多个 hunks', () => {
    const old = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const now = [...old];
    now[2] = 'mod-a';
    now[25] = 'mod-b';
    const ops = diffLines(old, now);
    const { hunks } = buildUnifiedHunks(ops, old, now, 2);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });
});
