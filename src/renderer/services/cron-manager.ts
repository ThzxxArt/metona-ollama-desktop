/**
 * CronManager - 定时任务系统 (v5.0)
 * 支持 one-shot 和周期性定时任务
 */

import { state, KEYS } from '../state/state.js';
import { generateId } from '../utils/utils.js';
import { logInfo, logWarn } from './log-service.js';

export interface CronTask {
  id: string;
  name: string;
  type: 'oneshot' | 'recurring';
  /** ISO-8601 时间戳（one-shot）或 cron 表达式（recurring） */
  schedule: string;
  /** 任务描述（注入给 Agent） */
  message: string;
  /** 是否启用 */
  enabled: boolean;
  /** 上次执行时间 */
  lastRunAt: number | null;
  /** 创建时间 */
  createdAt: number;
}

/** 活跃的定时器 */
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 获取所有定时任务
 */
export async function getCronTasks(): Promise<CronTask[]> {
  const db = state.get<any>(KEYS.DB);
  if (!db) return [];
  try {
    return await db.getSetting('cron_tasks', []);
  } catch {
    return [];
  }
}

/**
 * 保存定时任务
 */
async function saveCronTasks(tasks: CronTask[]): Promise<void> {
  const db = state.get<any>(KEYS.DB);
  if (db) await db.saveSetting('cron_tasks', tasks);
}

/**
 * 添加定时任务
 */
export async function addCronTask(task: Omit<CronTask, 'id' | 'createdAt' | 'lastRunAt'>): Promise<CronTask> {
  const tasks = await getCronTasks();
  const newTask: CronTask = {
    ...task,
    id: `cron_${generateId()}`,
    createdAt: Date.now(),
    lastRunAt: null
  };
  tasks.push(newTask);
  await saveCronTasks(tasks);

  if (newTask.enabled) {
    scheduleTask(newTask);
  }

  logInfo(`定时任务已添加: ${newTask.name}`, newTask.schedule);
  return newTask;
}

/**
 * 删除定时任务
 */
export async function removeCronTask(id: string): Promise<void> {
  const tasks = await getCronTasks();
  await saveCronTasks(tasks.filter(t => t.id !== id));
  clearTimer(id);
  logInfo(`定时任务已删除: ${id}`);
}

/**
 * 切换定时任务启用状态
 */
export async function toggleCronTask(id: string): Promise<boolean> {
  const tasks = await getCronTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return false;

  task.enabled = !task.enabled;
  await saveCronTasks(tasks);

  if (task.enabled) {
    scheduleTask(task);
  } else {
    clearTimer(id);
  }

  logInfo(`定时任务 ${task.enabled ? '已启用' : '已禁用'}: ${task.name}`);
  return task.enabled;
}

/**
 * 调度单个任务
 */
function scheduleTask(task: CronTask): void {
  clearTimer(task.id);

  if (task.type === 'oneshot') {
    const targetTime = new Date(task.schedule).getTime();
    const delay = targetTime - Date.now();
    if (delay <= 0) {
      logWarn(`定时任务已过期: ${task.name}`);
      return;
    }
    const timer = setTimeout(() => executeTask(task), delay);
    activeTimers.set(task.id, timer);
    logInfo(`One-shot 任务已调度: ${task.name}`, `${Math.round(delay / 1000)}s 后执行`);
  } else {
    // Recurring: 简化实现，使用 setInterval
    // cron 表达式暂简化为 "every Nm" 或 "every Nh" 格式
    const match = task.schedule.match(/every\s+(\d+)(m|h)/i);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const ms = unit === 'h' ? value * 3600000 : value * 60000;
      const timer = setInterval(() => executeTask(task), ms);
      activeTimers.set(task.id, timer);
      logInfo(`Recurring 任务已调度: ${task.name}`, `每 ${value}${unit} 执行`);
    }
  }
}

/**
 * 执行任务
 */
async function executeTask(task: CronTask): Promise<void> {
  logInfo(`执行定时任务: ${task.name}`);

  // 更新 lastRunAt
  const tasks = await getCronTasks();
  const t = tasks.find(tt => tt.id === task.id);
  if (t) {
    t.lastRunAt = Date.now();
    await saveCronTasks(tasks);
  }

  // 注入 systemEvent 到主会话
  // 实际执行需要触发 Agent Loop，这里通过事件通知
  window.dispatchEvent(new CustomEvent('metona:cron-task', { detail: task }));

  // One-shot 执行后自动删除
  if (task.type === 'oneshot') {
    await removeCronTask(task.id);
  }
}

/**
 * 清除定时器
 */
function clearTimer(id: string): void {
  const timer = activeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

/**
 * 恢复所有定时任务（应用启动时调用）
 */
export async function restoreCronTasks(): Promise<void> {
  const tasks = await getCronTasks();
  let scheduled = 0;
  for (const task of tasks) {
    if (task.enabled) {
      scheduleTask(task);
      scheduled++;
    }
  }
  if (scheduled > 0) {
    logInfo(`定时任务已恢复: ${scheduled} 个任务`);
  }
}
