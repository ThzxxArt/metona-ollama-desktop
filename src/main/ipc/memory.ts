/**
 * MEMORY.md 专用 IPC（绕过路径白名单，仅限工作空间 MEMORY.md）。
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { sendLog } from './shared.js';
import { getWorkspaceDir } from '../workspace.js';

const MEMORY_TEMPLATE = `# METONA MEMORY
> ⚠️ 此文件由 memory 工具自动管理，严禁手动编辑
> 元数据格式: ## [类型] | id: [ID] | importance: [1-10] | tags: [tag1, tag2, ...]
> 条目内容紧跟元数据行，直到下一个 ## 或文件末尾

`;

function validateMemoryContent(content: string): boolean {
  if (!content || !content.trim()) return false;
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '# METONA MEMORY') return false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('>')) continue;
    const match = trimmed.match(
      /^##\s+(fact|preference|rule)\s*\|\s*id:\s*(mem_\d{8}_\d{3})\s*\|\s*importance:\s*(\d{1,2})\s*\|\s*tags:\s+(.+?)(?:\s*\|\s*hits:\s*(\d+)\s*\|\s*last:\s*(\d+))?\s*$/i,
    );
    if (match) {
      const importance = parseInt(match[3], 10);
      if (importance < 1 || importance > 10) return false;
      if (!match[4]?.trim()) return false;
    }
  }
  return true;
}

export function registerMemoryIPC(): void {
  ipcMain.handle('memory:read', async () => {
    const memoryPath = path.join(getWorkspaceDir(), 'MEMORY.md');
    try {
      if (!fs.existsSync(memoryPath)) return { success: true, content: '' };
      const content = await fs.promises.readFile(memoryPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('memory:write', async (_, content: string, reason?: string) => {
    const wsDir = getWorkspaceDir();
    const memoryPath = path.join(wsDir, 'MEMORY.md');
    const reasonTag = reason ? `（${reason}）` : '';
    try {
      if (!fs.existsSync(wsDir)) await fs.promises.mkdir(wsDir, { recursive: true });
      if (content === '' || content.trim() === '') {
        if (fs.existsSync(memoryPath)) await fs.promises.unlink(memoryPath);
        sendLog('info', '🧠 memory:write', `MEMORY.md 已清空${reasonTag}`);
        return { success: true };
      }
      await fs.promises.writeFile(memoryPath, content, 'utf-8');
      sendLog('success', '🧠 memory:write', `MEMORY.md 已写入 (${content.length} 字符)${reasonTag}`);
      return { success: true };
    } catch (err) {
      sendLog('error', '🧠 memory:write 失败', (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('memory:init', async () => {
    const wsDir = getWorkspaceDir();
    const memoryPath = path.join(wsDir, 'MEMORY.md');
    const result: { action: string; existed: boolean; valid: boolean; backedUp?: string } = {
      action: '',
      existed: false,
      valid: false,
    };

    try {
      if (!fs.existsSync(wsDir)) {
        await fs.promises.mkdir(wsDir, { recursive: true });
        sendLog('info', '🧠 memory:init', `工作空间目录已创建: ${wsDir}`);
      }

      const exists = fs.existsSync(memoryPath);
      result.existed = exists;

      if (!exists) {
        await fs.promises.writeFile(memoryPath, MEMORY_TEMPLATE, 'utf-8');
        result.action = 'created';
        sendLog('success', '🧠 MEMORY.md 已创建', `路径: ${memoryPath}`);
      } else {
        const content = await fs.promises.readFile(memoryPath, 'utf-8');
        result.valid = validateMemoryContent(content);
        if (!result.valid) {
          const bakPath = memoryPath + '.bak';
          await fs.promises.copyFile(memoryPath, bakPath);
          result.backedUp = bakPath;
          await fs.promises.writeFile(memoryPath, MEMORY_TEMPLATE, 'utf-8');
          result.action = 'recreated';
          sendLog(
            'warn',
            '🧠 MEMORY.md 格式不符合规范，已备份并重建',
            `原文件 → ${bakPath} | 新文件已创建: ${memoryPath}`,
          );
        } else {
          result.action = 'valid';
          sendLog(
            'info',
            '🧠 MEMORY.md 格式校验通过',
            `路径: ${memoryPath} | ${content.split('\n').filter((l) => /^## (fact|preference|rule)/i.test(l)).length} 条记忆`,
          );
        }
      }

      return { success: true, ...result };
    } catch (err) {
      sendLog('error', '🧠 memory:init 失败', (err as Error).message);
      return { success: false, error: (err as Error).message, ...result };
    }
  });
}
