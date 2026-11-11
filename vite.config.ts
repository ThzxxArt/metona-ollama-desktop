import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // E2E 覆盖率需要把压缩后的 renderer bundle 映射回 src/**/*.ts。
    sourcemap: process.env.METONA_COVERAGE === '1',
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  css: {
    preprocessorOptions: {},
  },
});
