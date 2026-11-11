import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const IPC_DIR = path.resolve(__dirname, '../src/main/ipc');

function readIpcFiles(): Array<{ name: string; source: string }> {
  return fs
    .readdirSync(IPC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(IPC_DIR, name), 'utf-8') }));
}

describe('IPC 发送方校验覆盖', () => {
  it('除 register.ts 外，不允许直接调用 ipcMain.handle / ipcMain.on', () => {
    const violations = readIpcFiles()
      .filter((f) => f.name !== 'register.ts')
      .filter((f) => /ipcMain\.(handle|on)\s*\(/.test(f.source))
      .map((f) => f.name);
    expect(violations).toEqual([]);
  });

  it('所有注册通道的模块都从 register.ts 引入受信任包装', () => {
    const violations = readIpcFiles()
      .filter((f) => f.name !== 'register.ts')
      .filter((f) => /handleTrusted\(|onTrusted\(/.test(f.source))
      .filter((f) => !/from '\.\/register\.js'/.test(f.source))
      .map((f) => f.name);
    expect(violations).toEqual([]);
  });
});
