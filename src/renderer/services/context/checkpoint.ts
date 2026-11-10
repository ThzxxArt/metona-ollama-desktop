/**
 * Agent 运行状态检查点。
 */

import type { OllamaMessage } from '../../types.js';
import { logInfo } from '../log-service.js';

export interface AgentCheckpoint {
  id: string;
  timestamp: number;
  loopCount: number;
  state: string;
  messagesSnapshot: OllamaMessage[];
  toolRecordsCount: number;
  goal: string;
}

const _checkpoints: AgentCheckpoint[] = [];
const MAX_CHECKPOINTS = 5;

export function createCheckpoint(
  loopCount: number,
  agentState: string,
  messages: OllamaMessage[],
  toolRecordsCount: number,
  goal: string,
): AgentCheckpoint {
  const checkpoint: AgentCheckpoint = {
    id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    loopCount,
    state: agentState,
    messagesSnapshot: messages.map((m) => ({ ...m })),
    toolRecordsCount,
    goal,
  };

  _checkpoints.push(checkpoint);
  if (_checkpoints.length > MAX_CHECKPOINTS) _checkpoints.shift();

  logInfo(`R125: 检查点已创建 (loop=${loopCount}, state=${agentState})`);
  return checkpoint;
}

export function clearCheckpoints(): void {
  _checkpoints.length = 0;
}
