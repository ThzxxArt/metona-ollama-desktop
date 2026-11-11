import { defineConfig } from 'vitest/config';

/**
 * 覆盖率口径：整个 src/**\/*.ts（仅排除类型声明文件）。
 *
 * 不再区分“核心逻辑层”和“UI/入口”。UI 组件、Electron 入口、主进程工具
 * 全部进入同一分母，任何文件都不能靠排除来抬高覆盖率。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'text-summary', 'json-summary', 'json', 'html'],
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 85,
        branches: 85,
      },
    },
  },
});
