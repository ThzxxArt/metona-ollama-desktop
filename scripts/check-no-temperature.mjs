#!/usr/bin/env node
/**
 * 0.18.0 防回归：确保 temperature 不再出现在源码中。
 * 覆盖 src/ 下所有 TS/HTML/CSS 文件。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.html', '.css', '.json']);
const PATTERN = /temperature/i;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

const hits = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (PATTERN.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (hits.length > 0) {
  console.error('✗ 发现 temperature 残留（0.18.0 已彻底移除）：');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log('✓ 未发现 temperature 残留');
