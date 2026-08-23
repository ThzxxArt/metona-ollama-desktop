/**
 * Infrastructure Service - 基础设施服务
 * 全局错误边界：统一捕获未处理异常（渲染进程唯一定义，避免重复弹窗）
 */

import { logError, logInfo } from './log-service.js';
import { showToast } from '../components/toast.js';

/**
 * 初始化全局错误处理（应用启动时调用一次）
 * - 未捕获 JS 错误 / Promise rejection → 日志 + Toast
 * - 阻止默认行为（避免原生错误对话框）
 */
export function initGlobalErrorHandler(): void {
  window.addEventListener('error', (e) => {
    logError('未捕获错误', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    showToast(`发生错误: ${e.message}`, 'error', 5000);
    e.preventDefault();
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    logError('未处理的 Promise Rejection', msg);
    showToast(`操作失败: ${msg}`, 'error', 5000);
    e.preventDefault();
  });

  logInfo('全局错误处理器已初始化');
}
