/** 上下文模块共享类型 */

export interface StructuredSummary {
  topics: string[];
  decisions: string[];
  pendingTasks: string[];
  constraints: string[];
  knowledge: string[];
  toolResults: string[];
}

export interface ContextBuildOptions {
  windowSize?: number;
  summaryBatchSize?: number;
  maxTokens?: number;
  memoryContext?: string;
  workspaceContext?: string;
}
