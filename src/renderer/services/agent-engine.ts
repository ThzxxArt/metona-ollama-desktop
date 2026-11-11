/**
 * Agent Engine - ReAct Agent Loop 核心引擎
 * ReAct 模式: Thought → Action → Observation → Reflection
 * 状态机化架构 + Hook 系统
 */

import { OllamaAPI } from '../api/ollama.js';
import { state, KEYS } from '../state/state.js';
import { needsConfirmation, setSubAgentConfirmHandler } from './tool-registry.js';
import {
  classifyError,
  calculateBackoff,
  validatePathSandbox,
  addResultMetadata,
  recordErrorPattern,
  checkCommandSafety,
  getErrorRecoverySuggestions,
  formatErrorRecovery,
} from './agent-safety.js';
import { formatToolResultForModel, summarizeAuditResult } from './result-formatter.js';

import { showToast } from '../components/toast.js';
import { logInfo, logWarn, logError, logToolStart, logToolResult } from './log-service.js';
import { getWorkspaceDirPath } from './workspace-state.js';
import { estimateTokens, generateSessionSummary, saveSessionSummary } from './context-manager.js';
import { executeHooks, addWrittenFile } from './hooks.js';
import { recordToolCall, startSessionMetrics, endSessionMetrics } from './agent-metrics.js';
import { getEffectiveNumCtx } from '../components/model-bar.js';
import type {
  OllamaMessage,
  OllamaStreamChunk,
  ToolCall,
  ToolResult,
  ToolCallRecord,
  ChatSession,
  LoopState,
  LoopContext,
} from '../types.js';

import {
  MAX_RETRIES,
  MAX_MESSAGES,
  API_MAX_RETRIES,
  MAX_PARALLEL_TOOLS,
  S,
  transition,
  getFilteredTools,
  setFilteredTools,
} from './agent/state.js';
import type { AgentCallbacks } from './agent/types.js';
import { handleThinking } from './agent/stream.js';

export type { AgentCallbacks } from './agent/types.js';

import {
  sanitizeUntrustedInput,
  getThinkLevel,
  truncateByTokenBudget,
  loadCustomFiles,
  buildStandardPrompts,
} from './agent/prompt.js';

export { sanitizeUntrustedInput, getThinkLevel, truncateByTokenBudget } from './agent/prompt.js';

/** ── LoopState 常量与转换表已迁移至 agent/state.ts ── */

/** 有副作用的工具 — 同轮次去重时不返回缓存，需实际执行 */
import {
  SIDE_EFFECT_TOOLS,
  executeToolWithTimeout,
  hasPathDependency,
  pathsConflict,
  validateToolArgsQuick,
  setToolCache,
  getToolCache,
  isCacheValid,
  getToolCacheKey,
  isDuplicateCall,
  clearToolCache,
  deleteToolCache,
} from './agent/tool-planning.js';

export { pathsConflict, validateToolArgsQuick } from './agent/tool-planning.js';

// ═══════════════════════════════════════════════════════════════
// 跨轮次死循环检测已删除 — 硬熔断过于激进，软提示干扰 AI 判断
// AI 应自行判断是否需要继续调用相同工具
// ═══════════════════════════════════════════════════════════════
// 待清理的记忆提取 timer 由 agent/runtime.ts 统一管理

// 工具超时 / 路径依赖 / 参数前置校验 / 缓存已迁移至 agent/tool-planning.ts

// AgentCallbacks 已迁移至 agent/types.ts

import {
  getTraceFallbackBackup,
  restoreTraceFallbackBackup,
  saveTrace,
  flushAllTraces,
} from './agent/trace.js';
import {
  registerAbortController,
  isAborted,
  cleanupAbortController,
  snapshotLoopContext,
  clearPendingMemoryTimers,
} from './agent/runtime.js';
import { handleInit } from './agent/states/init.js';
import { handleParsing } from './agent/states/parsing.js';
import { handleObserving } from './agent/states/observing.js';
import { handleReflecting } from './agent/states/reflecting.js';
import { handleCompressing } from './agent/states/compressing.js';
import { makeStats } from './agent/stats.js';

export { getTraceFallbackBackup, restoreTraceFallbackBackup, flushAllTraces } from './agent/trace.js';

// AbortController 生命周期与 LoopContext 快照已迁移至 agent/runtime.ts

// Harness: 状态转换函数已迁移至 agent/state.ts

// LoopContext 快照已迁移至 agent/runtime.ts


// ═══════════════════════════════════════════════════════════════
// Harness: 状态处理器
// ═══════════════════════════════════════════════════════════════

/** 读取应用内置资源（webSecurity 开启后 file:// 页面无法 fetch 相对路径，改走 IPC） */
/**
 * INIT 状态：构建系统提示词、准备上下文、压缩检测
 */
// handleInit 已迁移至 agent/states/init.ts

// verifyToolResult 已删除 — 工具结果核验过于粗糙，误报边界情况
// AI 应基于工具返回的 success/error 字段自行判断结果有效性

/**
 * THINKING 状态：调用 LLM 流式
 */
// handleThinking 已迁移至 agent/stream.ts

/**
 * PARSING 状态：解析模型输出，提取工具调用和文本兜底
 */
// handleParsing 已迁移至 agent/states/parsing.ts

/**
 * EXECUTING 状态：执行工具（按批次并行）
 */
async function handleExecuting(
  ctx: LoopContext,
  callbacks: AgentCallbacks,
): Promise<void> {
  // ── 工具并行执行：智能批次划分（P0修复：检测实际数据依赖）──
  const batches: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [];

  for (const call of ctx.toolCalls) {
    if (currentBatch.length === 0) {
      currentBatch.push(call);
    } else if (hasPathDependency(call, currentBatch)) {
      // P2 #8 修复：路径依赖检查优先于 ALWAYS_PARALLEL，
      // 防止 read_file 在 write_file 同路径时被错误并行
      batches.push(currentBatch);
      currentBatch = [call];
    } else {
      currentBatch.push(call);
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  if (batches.length > 1) {
    logInfo(`工具并行执行: ${ctx.toolCalls.length} 个工具 → ${batches.length} 批次（首批 ${batches[0].length} 个并行）`);
  }

  /** 执行单个工具（含智能重试：永久错误立即返回，瞬态错误最多重试 MAX_RETRIES 次） */
  const executeSingleTool = async (call: ToolCall): Promise<[ToolCallRecord, string | null]> => {
    const cacheKey = getToolCacheKey(call.function.name, call.function.arguments);

    if (isDuplicateCall(call, ctx.toolCalls)) {
      // D4: 有副作用的工具不返回缓存，需实际执行（如 write_file、run_command）
      if (!SIDE_EFFECT_TOOLS.has(call.function.name)) {
        logWarn(`跳过重复工具调用: ${call.function.name}`);
        const cached = getToolCache(cacheKey);
        if (cached) {
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: cached.result, status: 'success' as const, timestamp: Date.now()
          }, null];
        }
      } else {
        logInfo(`有副作用的工具重复调用，实际执行: ${call.function.name}`);
      }
    }

    const cachedEntry = getToolCache(cacheKey);
    if (cachedEntry && isCacheValid(call.function.name, cachedEntry.timestamp)) {
      logInfo(`工具缓存命中: ${call.function.name}`);
      return [{
        name: call.function.name, arguments: call.function.arguments,
        result: cachedEntry.result, status: 'success' as const, timestamp: Date.now()
      }, null];
    }
    if (cachedEntry && !isCacheValid(call.function.name, cachedEntry.timestamp)) {
      deleteToolCache(cacheKey);
    }

    // 命令安全检查 — 对 run_command 进行风险评估
    if (call.function.name === 'run_command') {
      const cmdStr = String(call.function.arguments?.command || '');
      if (cmdStr) {
        const cmdSafety = checkCommandSafety(cmdStr);
        if (cmdSafety.riskLevel === 'forbidden') {
          logWarn(`R113: 命令安全拦截: ${cmdSafety.reason}`);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: { success: false, error: cmdSafety.reason || '命令被安全规则拦截' },
            status: 'error' as const, timestamp: Date.now()
          }, null];
        }
      }
    }

    // P2-4: 工具参数前置校验 — 参数无效直接返回错误，不执行实际工具，节省一轮迭代
    const paramError = validateToolArgsQuick(call.function.name, call.function.arguments);
    if (paramError) {
      logWarn(`参数校验失败: ${call.function.name}`, paramError);
      return [{
        name: call.function.name, arguments: call.function.arguments,
        result: { success: false, error: paramError },
        status: 'error' as const, timestamp: Date.now()
      }, null];
    }

    // R77/R87 已删除：速率限制 + 熔断器 — 剥夺 AI 试错空间，误伤密集型任务
    // AI 应基于工具返回的错误信息自行调整策略

    // R79: 路径沙箱验证 — 确保文件操作不超出工作空间边界
    const FILE_PATH_TOOLS = new Set([
      'read_file', 'write_file', 'edit_file', 'delete_file',
      'list_directory', 'search_files', 'compress',
      'file_transfer', 'download_file',
    ]);
    if (FILE_PATH_TOOLS.has(call.function.name)) {
      const workspaceDir = getWorkspaceDirPath();
      if (workspaceDir) {
        const pathArg = String(call.function.arguments?.path || call.function.arguments?.source || call.function.arguments?.destination || call.function.arguments?.file1 || '');
        if (pathArg) {
          const sandboxResult = validatePathSandbox(pathArg, workspaceDir);
          if (!sandboxResult.valid) {
            logWarn(`R79: 路径沙箱拦截: ${call.function.name}(${pathArg}) — ${sandboxResult.reason}`);
            return [{
              name: call.function.name, arguments: call.function.arguments,
              result: { success: false, error: sandboxResult.reason || '路径不在工作空间范围内' },
              status: 'error' as const, timestamp: Date.now()
            }, null];
          }
          // R79: 使用标准化路径替换原始路径，防止路径遍历
          if (sandboxResult.normalizedPath && sandboxResult.normalizedPath !== pathArg) {
            if (call.function.arguments?.path) {
              call.function.arguments.path = sandboxResult.normalizedPath;
            } else if (call.function.arguments?.source) {
              call.function.arguments.source = sandboxResult.normalizedPath;
            }
          }
        }
      }
    }

    // P2-10 修复：queueMicrotask 替代 rAF，在隐藏窗口下不会降频
    await new Promise<void>(r => { queueMicrotask(r); });
    callbacks.onToolCallStart(call);
    logToolStart(call.function.name, JSON.stringify(call.function.arguments));

    // ── pre_tool Hook（可阻断）──
    const hookResult = await executeHooks('pre_tool', ctx, { toolName: call.function.name, toolArgs: call.function.arguments });
    if (!hookResult.allPassed) {
      const reasons = hookResult.results.filter(r => !r.passed).map(r => r.message).join('; ');
      logWarn(`pre_tool Hook 阻断: ${call.function.name}`, reasons);
      return [{
        name: call.function.name, arguments: call.function.arguments,
        result: { success: false, error: reasons },
        status: 'cancelled' as const, timestamp: Date.now()
      }, null];
    }

    await new Promise<void>(r => { queueMicrotask(r); });

    if (needsConfirmation(call.function.name)) {
      const confirmed = await callbacks.onConfirmTool(call);
      // P1-E3 修复：用户在确认对话框期间可能点了"停止"，确认后检查中止信号
      if (isAborted()) {
        logInfo(`用户在工具确认期间中止: ${call.function.name}`);
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: { success: false, error: '用户中止' },
          status: 'cancelled' as const, timestamp: Date.now()
        }, null];
      }
      if (!confirmed) {
        logWarn(`工具取消: ${call.function.name}`);
        const cancelResult = { success: false, error: '用户取消了操作' };
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: cancelResult, status: 'cancelled' as const, timestamp: Date.now()
        }, null];
      }
    }

    // R116: 生成错误恢复建议的辅助函数
    const buildErrorWithRecovery = (errMsg: string): string => {
      try {
        const suggestion = getErrorRecoverySuggestions(call.function.name, errMsg);
        if (suggestion.suggestions.length > 0) {
          return formatErrorRecovery(suggestion);
        }
      } catch { /* 恢复建议生成失败不影响主流程 */ }
      return errMsg;
    };

    // ── R78: 增强错误分类重试 — 使用 classifyError 区分瞬态/永久/安全错误 ──
    let lastError = '';
    let classifiedError: import('./agent-safety.js').ClassifiedError | null = null;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      // 重试前检查中止信号
      if (isAborted()) {
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: { success: false, error: '用户中止' },
          status: 'cancelled' as const, timestamp: Date.now()
        }, null];
      }
      try {
        const result = await executeToolWithTimeout(call.function.name, call.function.arguments,
          state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal)
          .catch(err => ({ success: false, error: err?.message || String(err) }) as ToolResult);
        logToolResult(call.function.name, result.success, result.success ? undefined : result.error);
        // 记录 write_file 成功路径及内容指纹，供 FileWriteDedup Hook 做内容级去重
        if (call.function.name === 'write_file' && result.success && call.function.arguments?.path) {
          addWrittenFile(String(call.function.arguments.path), String(call.function.arguments.content || ''));
        }
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result, status: result.success ? 'success' as const : 'error' as const, timestamp: Date.now()
        }, result.success ? cacheKey : null];
      } catch (err) {
        lastError = (err as Error).message;
        // R78: 使用错误分类系统替代原有的 isPermanentError
        classifiedError = classifyError(lastError);
        
        // 安全错误或永久错误：不重试
        if (!classifiedError.shouldRetry) {
          logWarn(`R78: 工具${classifiedError.class}错误（不重试）: ${call.function.name}`, classifiedError.userMessage);
          const errWithRecovery = buildErrorWithRecovery(classifiedError.userMessage);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: { success: false, error: errWithRecovery },
            status: 'error' as const, timestamp: Date.now()
          }, null];
        }
        
        // R78: 检查是否超过最大重试次数
        if (retry >= (classifiedError.maxRetries || MAX_RETRIES)) {
          logError(`R78: 工具执行失败（已达最大重试 ${classifiedError.maxRetries}）: ${call.function.name}`, lastError);
          // R97: 记录错误模式并获取改进建议
          const errorSuggestion = recordErrorPattern(call.function.name, lastError);
          if (errorSuggestion) {
            logWarn(`R97: ${errorSuggestion}`);
          }
          const errWithRecovery = buildErrorWithRecovery(classifiedError.userMessage);
          return [{
            name: call.function.name, arguments: call.function.arguments,
            result: { success: false, error: errWithRecovery },
            status: 'error' as const, timestamp: Date.now()
          }, null];
        }
        
        if (retry < (classifiedError.maxRetries || MAX_RETRIES)) {
          // R78: 使用 calculateBackoff 计算指数退避延迟
          const delay = calculateBackoff(retry, classifiedError.backoffMs);
          logWarn(`R78: 工具重试 ${retry + 1}/${classifiedError.maxRetries}: ${call.function.name}（${classifiedError.class}错误，${delay}ms 后）`, lastError);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // P2 #6 修复：此处不可达（路径A已拦截），但作为安全兆底
        return [{
          name: call.function.name, arguments: call.function.arguments,
          result: { success: false, error: classifiedError.userMessage }, status: 'error' as const, timestamp: Date.now()
        }, null];
      }
    }
    // P2 #6 修复：循环结束兆底返回
    const fallbackErr = buildErrorWithRecovery(lastError || '工具执行失败');
    return [{
      name: call.function.name, arguments: call.function.arguments,
      result: { success: false, error: fallbackErr }, status: 'error' as const, timestamp: Date.now()
    }, null];
  };

  // 按批次执行
  for (const batch of batches) {
    if (state.get<AbortController | null>(KEYS.ABORT_CONTROLLER)?.signal.aborted) {
      // P0-R1 + P1-R5 修复：中止时设置 _abortToolRecords 并 throw AbortError，
      // 让主循环 catch 块统一处理 UI 反馈（[已停止] 标记、系统消息等），避免 onDone 被重复调用
      if (ctx.allToolRecords.length > 0) {
        state.set('_abortToolRecords', ctx.allToolRecords);
      }
      throw new DOMException('Aborted', 'AbortError');
    }

    // R6: 限制并行工具数量，避免过多并发导致资源争抢
    const results: Array<[ToolCallRecord, string | null]> = [];
    for (let i = 0; i < batch.length; i += MAX_PARALLEL_TOOLS) {
      const chunk = batch.slice(i, i + MAX_PARALLEL_TOOLS);
      const chunkResults = await Promise.all(chunk.map(call => executeSingleTool(call)));
      results.push(...chunkResults);
    }

    for (const [record, cacheKey] of results) {
      ctx.allToolRecords.push(record);
      // R88: 为工具结果添加元数据提示（token 估算）
      const formattedResult = addResultMetadata(formatToolResultForModel(record.name, record.result!));
      // R92: 工具结果格式标准化 — 添加统一头信息（工具名、状态、耗时、结果大小）
      const resultDuration = Date.now() - record.timestamp;
      const resultSize = formattedResult.length;
      const sizeCategory = resultSize > 10000 ? 'large' : resultSize > 2000 ? 'medium' : 'small';
      const r92Header = `[工具:${record.name} 状态:${record.status} 耗时:${resultDuration}ms 大小:${sizeCategory}(${resultSize}字符)]`;
      ctx.messages.push({
        role: 'tool', tool_name: record.name,
        content: `<<<TOOL_RESULT_START name="${record.name}">>>\n${r92Header}\n${formattedResult}\n<<<TOOL_RESULT_END>>>`
      });
      // P1-3 优化：移除逐次 nudge 注入，改为 AGENT.md 通用规则
      // 原逻辑：memory/session/spawn_task 后注入额外 user 消息
      // 问题：每轮最多多4条合成 user 消息，污染上下文
      // 方案：在 AGENT.md 核心规则中增加"工具返回数据是事实来源"通用规则
      if (cacheKey) setToolCache(cacheKey, { result: record.result!, timestamp: Date.now() });
      // 记录度量
      recordToolCall(record.name, record.status, Date.now() - record.timestamp);
      // 工具审计日志：写类工具异步写入审计表，不阻塞主流程
      if (SIDE_EFFECT_TOOLS.has(record.name)) {
        const _auditDuration = Date.now() - record.timestamp;
        const _auditSummary = record.result?.success
          ? summarizeAuditResult(record.name, record.result)
          : record.result?.error || '执行失败';
        const _bridge = window.metonaDesktop;
        if (_bridge?.db) {
          _bridge.db.saveToolAudit({
            session_id: ctx.sessionId,
            tool_name: record.name,
            args_json: JSON.stringify(record.arguments).slice(0, 5000),
            result_status: record.status,
            result_summary: String(_auditSummary).slice(0, 2000),
            duration_ms: _auditDuration,
            created_at: Date.now(),
          }).catch(() => {});
        }
      }
      // ── post_tool Hook ──
      executeHooks('post_tool', ctx, { toolName: record.name, toolArgs: record.arguments, toolResult: record.result! }).catch(err => logWarn('post_tool hook 异常', String(err)));
      // P0 修复: 使用参数匹配而非仅工具名匹配，避免同批次同名工具的错误关联
      const matchedCall = batch.find(c =>
        c.function.name === record.name &&
        JSON.stringify(c.function.arguments) === JSON.stringify(record.arguments)
      ) ?? batch.find(c => c.function.name === record.name)!;
      if (record.status === 'success') {
        callbacks.onToolCallResult(record.name, record.result!, matchedCall);
      } else if (record.status === 'cancelled') {
        callbacks.onToolCallError(record.name, '用户取消', matchedCall);
      } else {
        callbacks.onToolCallError(record.name, record.result?.error || '执行失败', matchedCall);
      }
    }
  }

  transition(ctx, S.OBSERVING);
}

/**
 * OBSERVING 状态：收集结果、裁剪旧消息、更新去重键
 */
// handleObserving 已迁移至 agent/states/observing.ts

/**
 * REFLECTING 状态：反思
 *
 * 核心原则：模型不调工具 = 模型认为完成了。信任模型的判断。
 * 仅在明确的异常情况下介入（空响应、超最大轮次）。
 */
// handleReflecting 已迁移至 agent/states/reflecting.ts

// handleCompressing 已迁移至 agent/states/compressing.ts

// ═══════════════════════════════════════════════════════════════
// Harness: 主入口 — 状态机循环
// ═══════════════════════════════════════════════════════════════

// makeStats 已迁移至 agent/stats.ts

export async function runAgentLoop(
  userContent: string,
  images: string[],
  historyMessages: OllamaMessage[],
  callbacks: AgentCallbacks
): Promise<void> {
  const api = state.get<OllamaAPI>(KEYS.API);
  const model = state.get<string>('_defaultModel', '');
  const currentSession = state.get<ChatSession | null>(KEYS.CURRENT_SESSION);
  const sessionId = currentSession?.id || 'unknown';

  if (!api || !model) {
    showToast('请先选择模型', 'error');
    return;
  }

  // ── 构建 LoopContext ──
  const ctx: LoopContext = {
    state: S.INIT,
    sessionId,
    loopCount: 0,
    maxLoops: state.get<number>('maxTurns', 85),
    content: '',
    thinking: '',
    toolCalls: [],
    allToolRecords: [],
    messages: [],
    totalEvalCount: 0,
    totalPromptEvalCount: 0,
    totalInferenceNs: 0,
    loopEvalCount: 0,
    loopPromptEvalCount: 0,
    loopInferenceNs: 0,
    prevLoopSuccessKeys: [],
    prevToolCalls: [],
    startTime: Date.now(),
    lastLoopStats: undefined,
    emergencyCompressCount: 0,
    compressedThisCycle: false,
  };

  state.set('_loopState', S.INIT);
  snapshotLoopContext(ctx);
  startSessionMetrics(sessionId, model);
  // 子代理确认管线：与主 Agent 共用同一确认回调（finally 中清理）
  setSubAgentConfirmHandler(callbacks.onConfirmTool ?? null);

  // ── 状态机主循环 ──
  try {
    // Phase 1: INIT
    await handleInit(ctx, api, model, callbacks, userContent, images, historyMessages, currentSession);
    transition(ctx, S.THINKING);

    // Phase 2-7: THINKING → PARSING → EXECUTING → OBSERVING → REFLECTING → (COMPRESSING) → loop
    while (ctx.state !== S.TERMINATED) {
      // ── 看门狗 — 全局超时熔断（可通过设置 loopWatchdogMs 配置，0=禁用）──
      // 默认 30 分钟（与设置面板默认值一致）
      const WATCHDOG_MS = state.get<number>('loopWatchdogMs', 1_800_000);
      if (WATCHDOG_MS > 0 && Date.now() - ctx.startTime > WATCHDOG_MS) {
        logWarn(`看门狗触发: Agent Loop 运行超过 ${WATCHDOG_MS / 60000} 分钟，强制终止`);
        callbacks.onDone(ctx.content || '（看门狗超时终止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
        transition(ctx, S.TERMINATED);
        break;
      }

      // ── 上下文硬上限 — 消息数超阈值强制压缩 ──
      if (ctx.messages.length > MAX_MESSAGES) {
        logWarn(`上下文硬上限触发: ${ctx.messages.length} 条消息 > ${MAX_MESSAGES}，强制压缩`);
        transition(ctx, S.COMPRESSING); // transition 内部会同步 state 和 _loopState
      }

      // 检查中止信号
      if (isAborted()) {
        logInfo('ReAct Agent Loop 已中止');
        if (ctx.allToolRecords.length > 0) {
          state.set('_abortToolRecords', ctx.allToolRecords);
        }
        throw new DOMException('Aborted', 'AbortError');
      }

      // Token 感知的动态迭代预算
      const numCtx = getEffectiveNumCtx();
      const usageRatio = numCtx > 0 ? estimateTokens(ctx.messages.map(m => m.content || '').join('')) / numCtx : 0;

      // 上下文使用率过高时触发紧急压缩（不限制轮次，而是回收上下文空间）
      // P2 #7 修复：提高阈值到 0.85 + 添加 compressedThisCycle 防同一轮重复压缩
      if (usageRatio > 0.85 && ctx.state === S.THINKING && !ctx.compressedThisCycle) {
        logWarn(`上下文使用率 ${(usageRatio * 100).toFixed(0)}%, 触发紧急压缩`);
        ctx.compressedThisCycle = true;
        transition(ctx, S.COMPRESSING); // transition 内部会同步 state 和 _loopState
      }

      // 仅在 THINKING 阶段通知 UI（一次迭代只通知一次，不是每个状态切换都通知）
      if (ctx.loopCount > 0 && ctx.state === S.THINKING && callbacks.onNewIteration) {
        callbacks.onNewIteration(ctx.prevToolCalls.length > 0 ? ctx.prevToolCalls : undefined, ctx.lastLoopStats);
      }

      // 状态分发
      switch (ctx.state) {
        case S.THINKING:
          await handleThinking(ctx, api, model, callbacks);
          // handleThinking 内部会 transition 到 PARSING 或 TERMINATED
          break;

        case S.PARSING:
          await handleParsing(ctx);
          // handleParsing 内部会 transition 到 EXECUTING 或 REFLECTING
          break;

        case S.EXECUTING:
          await handleExecuting(ctx, callbacks);
          // handleExecuting 内部会 transition 到 OBSERVING 或 THINKING 或 TERMINATED
          break;

        case S.OBSERVING:
          await handleObserving(ctx, currentSession);
          // handleObserving 内部会 transition 到 REFLECTING
          break;

        case S.REFLECTING:
          await handleReflecting(ctx, callbacks, currentSession);
          // handleReflecting 内部会 transition 到 THINKING / COMPRESSING / TERMINATED
          break;

        case S.COMPRESSING:
          await handleCompressing(ctx, api, model);
          // handleCompressing 内部会 transition 到 REFLECTING
          break;

default:
  // R7: 状态机恢复 — 尝试恢复到安全状态而非直接终止
  logWarn(`未知状态: ${ctx.state}，尝试恢复`);
  // 尝试恢复到 THINKING（最安全的状态，会重新调用 LLM）
  if (ctx.loopCount < ctx.maxLoops && ctx.messages.length > 0) {
    logInfo(`R7: 从未知状态 ${ctx.state} 恢复到 THINKING`);
    transition(ctx, S.THINKING); // 使用 transition 而非直接赋值，保持状态机封装
  } else {
    logWarn(`R7: 恢复条件不满足，强制终止`);
    transition(ctx, S.TERMINATED);
  }
      }

      snapshotLoopContext(ctx);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 中止是正常的，但仍需通知 UI 清理状态
      callbacks.onDone(ctx.content || '（已中止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
    } else {
      logError('Agent Loop 异常', (err as Error).message);
      callbacks.onDone(ctx.content || '（Agent Loop 异常终止）', ctx.allToolRecords.length > 0 ? ctx.allToolRecords : undefined, makeStats(ctx));
    }
    transition(ctx, S.TERMINATED);
    // P1-E2 修复：catch 块也需快照，确保终止状态写入 state._loopContext
    snapshotLoopContext(ctx);
  } finally {
    // 清理子代理确认回调（防止泄漏到下一次循环外）
    setSubAgentConfirmHandler(null);
    endSessionMetrics();
    // R123: 生成并保存会话摘要 — 供下一轮会话的 AI 参考
    try {
      if (ctx.loopCount > 0 && ctx.messages.length > 2) {
        const userMsg = ctx.messages.find(m => m.role === 'user')?.content || '';
        const totalTokens = ctx.totalEvalCount + ctx.totalPromptEvalCount;
        const summary = generateSessionSummary(userMsg, ctx.messages, ctx.allToolRecords, totalTokens);
        saveSessionSummary(summary);
      }
    } catch { /* 会话摘要保存失败不影响主流程 */ }
    cleanupAbortController();
    // 清理未执行的记忆提取 timer，避免新会话启动时旧提取污染
    clearPendingMemoryTimers();
    // P1-E4 修复：await 确保轨迹写入完成，避免应用立即关闭时丢失
    await flushAllTraces().catch(() => {});
  }
}
