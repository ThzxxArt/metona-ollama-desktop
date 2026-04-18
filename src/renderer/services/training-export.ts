/**
 * TrainingExport - 训练数据导出 (v5.0)
 * 将 Agent 执行轨迹转换为 SFT 训练数据格式
 */

import { state, KEYS } from '../state/state.js';
import { logInfo, logSuccess, logError } from './log-service.js';

interface SFTRecord {
  instruction: string;
  input: string;
  output: string;
  tools?: Array<{ name: string; arguments: Record<string, unknown> }>;
  observations?: string[];
  metadata?: {
    session_id: string;
    session_title: string;
    timestamp: number;
    model: string;
    eval_count?: number;
    total_duration?: number;
  };
}

/**
 * 导出所有会话的训练数据
 * 从 traces + messages 中提取成功的工具调用链
 */
export async function exportTrainingData(): Promise<string | null> {
  const bridge = (window as any).metonaDesktop;
  if (!bridge?.db) return null;

  try {
    const sessions = await bridge.db.getAllSessions();
    const records: SFTRecord[] = [];

    for (const session of sessions) {
      const messages = await bridge.db.getMessages(session.id);
      const traces = await bridge.db.getTraces(session.id);

      // 遍历消息对（user → assistant）
      for (let i = 0; i < messages.length - 1; i++) {
        const userMsg = messages[i];
        const asstMsg = messages[i + 1];

        if (userMsg.role !== 'user' || asstMsg.role !== 'assistant') continue;
        if (!userMsg.content || !asstMsg.content) continue;

        // 解析工具调用
        let tools: Array<{ name: string; arguments: Record<string, unknown> }> | undefined;
        let observations: string[] | undefined;

        if (asstMsg.tool_calls) {
          try {
            const toolCalls = JSON.parse(asstMsg.tool_calls);
            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
              tools = toolCalls.map((tc: any) => ({
                name: tc.name || tc.function?.name || 'unknown',
                arguments: tc.arguments || tc.function?.arguments || {}
              }));
            }
          } catch { /* ignore */ }
        }

        // 从 traces 中提取 observation
        const sessionTraces = traces.filter(t =>
          t.created_at >= userMsg.created_at && t.created_at <= asstMsg.created_at
        );
        if (sessionTraces.length > 0) {
          observations = sessionTraces.map(t => t.observation || '').filter(Boolean);
        }

        records.push({
          instruction: userMsg.content,
          input: '',
          output: asstMsg.content,
          ...(tools && { tools }),
          ...(observations?.length && { observations }),
          metadata: {
            session_id: session.id,
            session_title: session.title,
            timestamp: userMsg.created_at,
            model: session.model,
            ...(asstMsg.eval_count && { eval_count: asstMsg.eval_count }),
            ...(asstMsg.total_duration && { total_duration: asstMsg.total_duration })
          }
        });

        i++; // 跳过 assistant 消息
      }
    }

    if (records.length === 0) {
      logInfo('训练数据导出: 无可导出数据');
      return null;
    }

    logSuccess(`训练数据导出完成: ${records.length} 条记录`);
    return records.map(r => JSON.stringify(r)).join('\n');
  } catch (err) {
    logError('训练数据导出失败', (err as Error).message);
    return null;
  }
}

/**
 * 保存训练数据到文件
 */
export async function saveTrainingData(): Promise<boolean> {
  const bridge = (window as any).metonaDesktop;
  if (!bridge?.dialog?.saveFile) return false;

  const data = await exportTrainingData();
  if (!data) return false;

  try {
    const filePath = await bridge.dialog.saveFile({
      defaultPath: `metona-training-data-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }, { name: 'JSON', extensions: ['json'] }]
    });
    if (!filePath) return false;

    await bridge.fs.writeFile(filePath, data);
    logSuccess(`训练数据已保存: ${filePath}`);
    return true;
  } catch (err) {
    logError('保存训练数据失败', (err as Error).message);
    return false;
  }
}
