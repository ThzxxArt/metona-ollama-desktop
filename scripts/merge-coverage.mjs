/**
 * 合并 Vitest 与 Playwright/Electron V8 覆盖率。
 *
 * - 单元覆盖率：coverage/coverage-final.json（Vitest v8 -> Istanbul）
 * - E2E renderer：coverage-e2e/renderer.json（Playwright page.coverage）
 * - E2E main：coverage-e2e/main/*.json（NODE_V8_COVERAGE）
 *
 * 只保留映射回 src/**\/*.ts 的覆盖数据，避免把 dist/node_modules 混入分母。
 * 合并后重新执行 85% 门槛，防止“单测达标、合并后不达标”被忽略。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import v8toIstanbul from 'v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const ROOT = process.cwd();
const UNIT_PATH = path.join(ROOT, 'coverage', 'coverage-final.json');
const E2E_DIR = path.join(ROOT, 'coverage-e2e');
const MERGED_DIR = path.join(ROOT, 'coverage', 'merged');
const THRESHOLD = 85;

function isSourceFile(file) {
  return (
    file.includes(`${path.sep}src${path.sep}`) &&
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    !file.includes(`${path.sep}vendor${path.sep}`)
  );
}

function toLocalPath(url) {
  if (!url) return null;
  try {
    return url.startsWith('file://') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

async function convertV8Entry(entry) {
  const filePath = toLocalPath(entry.url);
  if (!filePath || !existsSync(filePath)) return null;
  if (!filePath.includes(`${path.sep}dist${path.sep}`)) return null;

  const converter = v8toIstanbul(filePath, 0, entry.source ? { source: entry.source } : undefined);
  await converter.load();
  converter.applyCoverage(entry.functions || []);
  const converted = converter.toIstanbul();
  const filtered = {};
  for (const [file, coverage] of Object.entries(converted)) {
    if (isSourceFile(file)) filtered[file] = coverage;
  }
  return filtered;
}

async function collectE2ECoverage() {
  const coverageMap = libCoverage.createCoverageMap({});
  let mappedFiles = new Set();

  const rendererPath = path.join(E2E_DIR, 'renderer.json');
  if (existsSync(rendererPath)) {
    const entries = JSON.parse(readFileSync(rendererPath, 'utf-8'));
    for (const entry of entries) {
      const converted = await convertV8Entry(entry);
      if (!converted) continue;
      coverageMap.merge(converted);
      for (const file of Object.keys(converted)) mappedFiles.add(file);
    }
  }

  const mainDir = path.join(E2E_DIR, 'main');
  if (existsSync(mainDir)) {
    for (const name of readdirSync(mainDir).filter((f) => f.endsWith('.json'))) {
      const payload = JSON.parse(readFileSync(path.join(mainDir, name), 'utf-8'));
      for (const entry of payload.result || []) {
        const converted = await convertV8Entry(entry);
        if (!converted) continue;
        coverageMap.merge(converted);
        for (const file of Object.keys(converted)) mappedFiles.add(file);
      }
    }
  }

  return { coverageMap, mappedFiles };
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.start.line <= b.end.line && b.start.line <= a.end.line;
}

/**
 * 以 Vitest 的 statement/branch/function map 为唯一分母，把 E2E 覆盖到的
 * 相同源码位置标记为已覆盖。不能直接 istanbul merge：bundle source map
 * 生成的 statement id 与源码 V8 覆盖率不同，直接 merge 会把分母翻倍。
 */
function applyE2ECoverage(unitMap, e2eMap) {
  let touched = 0;
  for (const file of unitMap.files()) {
    if (!e2eMap.files().includes(file)) continue;
    const unit = unitMap.fileCoverageFor(file);
    const e2e = e2eMap.fileCoverageFor(file);
    const e2eStatements = [];
    const e2eBranches = [];
    const e2eFunctions = [];

    for (const [id, count] of Object.entries(e2e.s)) {
      if (count > 0) e2eStatements.push(e2e.statementMap[id]);
    }
    for (const [id, counts] of Object.entries(e2e.b)) {
      if (counts.some((c) => c > 0)) {
        const branch = e2e.branchMap[id];
        for (const loc of branch.locations || [branch.loc]) {
          if (loc) e2eBranches.push(loc);
        }
      }
    }
    for (const [id, count] of Object.entries(e2e.f)) {
      if (count > 0) e2eFunctions.push(e2e.fnMap[id].loc);
    }

    let changed = false;
    for (const [id, loc] of Object.entries(unit.statementMap)) {
      if (unit.s[id] === 0 && e2eStatements.some((candidate) => overlaps(loc, candidate))) {
        unit.s[id] = 1;
        changed = true;
      }
    }
    for (const [id, fn] of Object.entries(unit.fnMap)) {
      if (unit.f[id] === 0 && e2eFunctions.some((candidate) => overlaps(fn.loc, candidate))) {
        unit.f[id] = 1;
        changed = true;
      }
    }
    for (const [id, branch] of Object.entries(unit.branchMap)) {
      const counts = unit.b[id];
      const locations = branch.locations || [branch.loc];
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] === 0 && locations[i] && e2eBranches.some((candidate) => overlaps(locations[i], candidate))) {
          counts[i] = 1;
          changed = true;
        }
      }
    }
    if (changed) touched++;
  }
  return touched;
}

function printAndCheck(summary) {
  const metrics = [
    ['Statements', summary.statements],
    ['Branches', summary.branches],
    ['Functions', summary.functions],
    ['Lines', summary.lines],
  ];
  let failed = false;
  for (const [name, metric] of metrics) {
    console.log(`${name.padEnd(11)}: ${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`);
    if (metric.pct < THRESHOLD) failed = true;
  }
  if (failed) {
    throw new Error(`合并覆盖率未达到 ${THRESHOLD}% 门槛`);
  }
}

async function main() {
  if (!existsSync(UNIT_PATH)) {
    throw new Error(`缺少单元覆盖率报告: ${UNIT_PATH}。请先运行 npm run test:coverage`);
  }
  if (!existsSync(E2E_DIR)) {
    throw new Error(`缺少 E2E 覆盖率目录: ${E2E_DIR}。请先运行 npm run test:e2e:coverage`);
  }

  const unitMap = libCoverage.createCoverageMap(JSON.parse(readFileSync(UNIT_PATH, 'utf-8')));
  const { coverageMap: e2eMap, mappedFiles } = await collectE2ECoverage();
  if (mappedFiles.size === 0) {
    throw new Error('E2E 覆盖率没有映射到任何 src/**/*.ts 文件；请确认 METONA_COVERAGE=1 构建并生成了 source map');
  }

  const touchedFiles = applyE2ECoverage(unitMap, e2eMap);
  mkdirSync(MERGED_DIR, { recursive: true });
  writeFileSync(path.join(MERGED_DIR, 'coverage-final.json'), JSON.stringify(unitMap.toJSON()));
  writeFileSync(path.join(MERGED_DIR, 'e2e-coverage-final.json'), JSON.stringify(e2eMap.toJSON()));

  const context = libReport.createContext({
    dir: MERGED_DIR,
    coverageMap: unitMap,
    watermarks: {
      statements: [50, 85],
      branches: [50, 85],
      functions: [50, 85],
      lines: [50, 85],
    },
  });
  reports.create('text').execute(context);
  reports.create('text-summary').execute(context);
  reports.create('json-summary').execute(context);
  reports.create('html').execute(context);

  console.log(`E2E 映射源文件: ${mappedFiles.size}，实际补全覆盖: ${touchedFiles}`);
  printAndCheck(unitMap.getCoverageSummary());
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
