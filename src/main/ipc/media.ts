/** 视频帧提取 IPC（ffmpeg）。 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { mainWindow } from '../main.js';
import { sendLog } from './shared.js';

interface ExtractedFrame {
  name: string;
  base64: string;
  timestampSeconds: number;
}

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
}

function getFFmpegPath(): string {
  if (ffmpegStatic) return ffmpegStatic;
  return 'ffmpeg';
}

function parseVideoInfo(stderr: string): VideoInfo | null {
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const duration = durMatch ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]) : 0;
  const resMatch = stderr.match(/(\d{2,5})x(\d{2,5})/);
  const width = resMatch ? parseInt(resMatch[1]) : 0;
  const height = resMatch ? parseInt(resMatch[2]) : 0;
  if (duration <= 0 && width <= 0) return null;
  return { duration, width, height };
}

async function extractVideoFrames(
  filePath: string,
  maxFrames: number,
  maxWidth: number,
): Promise<{ success: boolean; frames?: ExtractedFrame[]; videoInfo?: VideoInfo; error?: string }> {
  const tmpDir = path.join(os.tmpdir(), `metona-video-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const outPattern = path.join(tmpDir, 'frame_%04d.jpg');
    let ffmpegStderr = '';
    let lastProgressFrame = 0;
    let lastProgressTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        getFFmpegPath(),
        [
          '-y',
          '-i',
          filePath,
          '-vf',
          `scale=${maxWidth}:-1,fps=1`,
          '-q:v',
          '3',
          '-frames:v',
          String(maxFrames),
          '-threads',
          '2',
          '-progress',
          'pipe:1',
          outPattern,
        ],
        { timeout: 120_000 },
        (err) => {
          if (err) {
            reject(new Error(`ffmpeg 执行失败: ${err.message}`));
            return;
          }
          resolve();
        },
      );
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        ffmpegStderr = (ffmpegStderr + chunk).slice(-32768);
        const frameMatch = chunk.match(/frame=\s*(\d+)/g);
        if (frameMatch) {
          const currentFrame = parseInt(frameMatch[frameMatch.length - 1].replace(/\D/g, ''));
          if (currentFrame > lastProgressFrame && Date.now() - lastProgressTime > 1000) {
            lastProgressFrame = currentFrame;
            lastProgressTime = Date.now();
            mainWindow?.webContents.send('video:progress', { current: currentFrame });
          }
        }
      });
    });

    let videoInfo = parseVideoInfo(ffmpegStderr);
    if (!videoInfo) videoInfo = { duration: 0, width: 0, height: 0 };

    const files = await fs.promises.readdir(tmpDir);
    const jpegs = files.filter((f) => f.endsWith('.jpg')).sort();
    if (jpegs.length === 0) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      return { success: false, error: '没有提取到视频帧' };
    }
    if (videoInfo.duration <= 0) videoInfo.duration = jpegs.length;

    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < jpegs.length; i++) {
      const buf = await fs.promises.readFile(path.join(tmpDir, jpegs[i]));
      if (buf.length < 200) continue;
      frames.push({
        name: `frame_${String(i + 1).padStart(2, '0')}_${i.toFixed(1)}s.jpg`,
        base64: buf.toString('base64'),
        timestampSeconds: i,
      });
    }

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    return { success: true, frames, videoInfo };
  } catch (err) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    sendLog('error', '视频帧提取失败', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export function registerMediaIPC(): void {
  ipcMain.handle(
    'video:extractFrames',
    async (_, filePath: string, options?: { maxFrames?: number; maxWidth?: number; maxSize?: number }) => {
      const maxFrames = options?.maxFrames || 600;
      const maxWidth = options?.maxWidth || 512;
      const maxSize = options?.maxSize || 10 * 1024 * 1024;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > maxSize) {
          return {
            success: false,
            error: `视频文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB，限制 ${maxSize / 1024 / 1024}MB`,
          };
        }
      } catch {
        return { success: false, error: '无法读取视频文件' };
      }
      return extractVideoFrames(filePath, maxFrames, maxWidth);
    },
  );
}
