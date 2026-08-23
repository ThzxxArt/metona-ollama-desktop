/**
 * 行级 Diff — 内存受控的 unified diff 生成
 *
 * 策略（兼顾正确性与内存上限）：
 * 1. 公共前缀/后缀裁剪（O(n+m)，真实场景下大多数编辑集中在中部）
 * 2. 中部区域若 n*m ≤ LCS_CELL_LIMIT → 精确 LCS 动态规划（Uint32Array，上限约 16MB）
 * 3. 超限则回退为"整段删除 + 整段插入"（结果正确但非最小差异）
 *
 * 取代旧实现的全量 (n+1)*(m+1) dp 数组（5000x5000 时约 100MB 单次分配）。
 */

export interface DiffOp {
  op: 'equal' | 'delete' | 'insert';
  oldIdx?: number; // 0-based 旧行号
  newIdx?: number; // 0-based 新行号
}

export interface UnifiedHunks {
  hunks: string[];
  additions: number;
  deletions: number;
}

/** LCS dp 单元上限（Uint32Array 约 16MB） */
const LCS_CELL_LIMIT = 4_000_000;

/** 计算行级差异操作序列（按旧序排列，含前后缀 equal） */
export function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  const n = oldLines.length;
  const m = newLines.length;

  // ── 公共前缀 ──
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    ops.push({ op: 'equal', oldIdx: prefix, newIdx: prefix });
    prefix++;
  }

  // ── 公共后缀 ──
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix++;
  }

  // ── 中部区域 ──
  const aStart = prefix;
  const aEnd = n - suffix;
  const bStart = prefix;
  const bEnd = m - suffix;
  const aLen = aEnd - aStart;
  const bLen = bEnd - bStart;

  if (aLen > 0 && bLen > 0) {
    if (aLen * bLen <= LCS_CELL_LIMIT) {
      lcsMiddle(oldLines, newLines, aStart, aEnd, bStart, bEnd, ops);
    } else {
      // 回退：整段替换（正确但非最小差异）
      for (let i = aStart; i < aEnd; i++) ops.push({ op: 'delete', oldIdx: i });
      for (let j = bStart; j < bEnd; j++) ops.push({ op: 'insert', newIdx: j });
    }
  } else if (aLen > 0) {
    for (let i = aStart; i < aEnd; i++) ops.push({ op: 'delete', oldIdx: i });
  } else if (bLen > 0) {
    for (let j = bStart; j < bEnd; j++) ops.push({ op: 'insert', newIdx: j });
  }

  // ── 后缀 equal ──
  for (let s = suffix - 1; s >= 0; s--) {
    ops.push({ op: 'equal', oldIdx: n - 1 - s, newIdx: m - 1 - s });
  }

  return ops;
}

/** 中部区域精确 LCS（Uint32Array dp + 回溯） */
function lcsMiddle(
  oldLines: string[],
  newLines: string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  ops: DiffOp[],
): void {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const ai = oldLines[aStart + i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === newLines[bStart + j - 1]) {
        dp[i * width + j] = dp[(i - 1) * width + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * width + j];
        const left = dp[i * width + (j - 1)];
        dp[i * width + j] = up >= left ? up : left;
      }
    }
  }

  // 回溯（从尾部），再整体反转
  const middleOps: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[aStart + i - 1] === newLines[bStart + j - 1]) {
      middleOps.push({ op: 'equal', oldIdx: aStart + i - 1, newIdx: bStart + j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * width + (j - 1)] >= dp[(i - 1) * width + j])) {
      middleOps.push({ op: 'insert', newIdx: bStart + j - 1 });
      j--;
    } else {
      middleOps.push({ op: 'delete', oldIdx: aStart + i - 1 });
      i--;
    }
  }
  middleOps.reverse();
  ops.push(...middleOps);
}

/**
 * 将 ops 序列分组为 unified diff hunks（带上下文行）。
 * 相邻变更点间隔 ≤ 2*contextSize+1 时合并为同一 hunk。
 */
export function buildUnifiedHunks(
  ops: DiffOp[],
  oldLines: string[],
  newLines: string[],
  contextSize: number,
): UnifiedHunks {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== 'equal') changes.push(i);
  }
  if (changes.length === 0) return { hunks: [], additions: 0, deletions: 0 };

  // 前缀计数：ops[0..k-1] 消耗的旧行数 / 新行数
  const oldBefore: number[] = new Array(ops.length + 1).fill(0);
  const newBefore: number[] = new Array(ops.length + 1).fill(0);
  for (let i = 0; i < ops.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (ops[i].op !== 'insert' ? 1 : 0);
    newBefore[i + 1] = newBefore[i] + (ops[i].op !== 'delete' ? 1 : 0);
  }

  // 变更点聚类
  const clusters: Array<[number, number]> = [];
  let clusterStart = changes[0];
  let prev = changes[0];
  for (let k = 1; k < changes.length; k++) {
    const c = changes[k];
    if (c - prev <= 2 * contextSize + 1) {
      prev = c;
    } else {
      clusters.push([clusterStart, prev]);
      clusterStart = c;
      prev = c;
    }
  }
  clusters.push([clusterStart, prev]);

  const hunks: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const [cStart, cEnd] of clusters) {
    const hunkStart = Math.max(0, cStart - contextSize);
    const hunkEnd = Math.min(ops.length - 1, cEnd + contextSize);

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = hunkStart; i <= hunkEnd; i++) {
      const op = ops[i];
      if (op.op === 'equal') {
        lines.push(' ' + oldLines[op.oldIdx!]);
        oldCount++;
        newCount++;
      } else if (op.op === 'delete') {
        lines.push('-' + oldLines[op.oldIdx!]);
        oldCount++;
        deletions++;
      } else {
        lines.push('+' + newLines[op.newIdx!]);
        newCount++;
        additions++;
      }
    }

    const oldStartLine = oldBefore[hunkStart] + 1;
    const newStartLine = newBefore[hunkStart] + 1;
    hunks.push(`@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@\n${lines.join('\n')}`);
  }

  return { hunks, additions, deletions };
}
