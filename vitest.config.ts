import { defineConfig } from 'vitest/config';

/**
 * 覆盖率范围：所有可单元测试的核心逻辑层。
 *
 * UI 组件（src/renderer/components）与 Electron 入口（main.ts / preload.ts /
 * browser.ts）由 Playwright E2E 与打包 smoke 覆盖，不纳入 v8 单测分母，
 * 否则会把大量 DOM 事件绑定与 Electron 生命周期代码混入逻辑覆盖率。
 */
const CORE_COVERAGE = [
  'src/shared/**/*.ts',
  'src/main/ollama/**/*.ts',
  'src/main/db/**/*.ts',
  'src/main/ipc/**/*.ts',
  'src/renderer/api/**/*.ts',
  'src/renderer/db/**/*.ts',
  'src/renderer/services/context/**/*.ts',
  'src/renderer/services/tools/**/*.ts',
  'src/renderer/features/settings/**/*.ts',
];

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      all: true,
      include: CORE_COVERAGE,
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 85,
        // 防御性分支（错误回退、平台差异、空值保护）不强行追求 85%，
        // 但必须保持在 80% 以上，避免只测 happy path。
        branches: 80,
      },
    },
  },
});
