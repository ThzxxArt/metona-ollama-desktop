import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.html')) out.push(full);
  }
  return out;
}

const SOURCES = walk(ROOT).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

const FORBIDDEN = [
  'plan_track',
  'PlanTracker',
  'initPlanTracker',
  'savePlanTracker',
  'clearPlanTracker',
  'formatPlanStatus',
  'agentMode',
  'planAutoConfirm',
  '_planTracker',
  '_planResumeData',
  'onPlanReady',
  'extractPlanSteps',
  'togglePlan',
  'setPlanModeActive',
  'planConstraint',
  'planRetries',
];

describe('Plan Mode 已完全移除', () => {
  it.each(FORBIDDEN)('源码中不存在 %s', (token) => {
    const hits = SOURCES.filter((s) => s.text.includes(token)).map((s) => s.file);
    expect(hits, `残留文件: ${hits.join(', ')}`).toEqual([]);
  });

  it('帮助面板不再宣传 Plan Mode', () => {
    const html = SOURCES.find((s) => s.file.endsWith('index.html'))?.text || '';
    expect(html.toLowerCase()).not.toContain('plan mode');
  });
});
