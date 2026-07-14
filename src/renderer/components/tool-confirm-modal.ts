/**
 * ToolConfirmModal - 工具调用确认对话框
 *
 * 队列模式：当多个工具并行执行需要确认时，按 FIFO 队列逐个确认，
 * 避免单例竞态导致前一个确认被自动取消。
 */

import type { ToolCall } from '../types.js';
import { getToolIcon, formatToolName } from '../services/tool-registry.js';
import { logDebug, logInfo } from '../services/log-service.js';
import { escapeHtml } from '../utils/utils.js';

let modalEl: HTMLElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let initialized = false;

/** 确认请求队列 */
interface ConfirmRequest {
  call: ToolCall;
  resolve: (confirmed: boolean) => void;
}
const confirmQueue: ConfirmRequest[] = [];
let isShowing = false;

export function initToolConfirmModal(): void {
  modalEl = document.querySelector('#toolConfirmModal')!;
  if (!modalEl || initialized) return;
  initialized = true;

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      cancelCurrent();
    }
  });
}

export function showToolConfirm(call: ToolCall): Promise<boolean> {
  return new Promise((resolve) => {
    if (!modalEl) {
      modalEl = document.querySelector('#toolConfirmModal')!;
      if (!modalEl) { resolve(false); return; }
      if (!initialized) {
        initialized = true;
        modalEl.addEventListener('click', (e) => {
          if (e.target === modalEl) cancelCurrent();
        });
      }
    }

    // 加入队列，如果当前没有显示的确认框，则立即显示
    confirmQueue.push({ call, resolve });
    if (!isShowing) {
      showNext();
    }
  });
}

/** 显示队列中的下一个确认 */
function showNext(): void {
  if (confirmQueue.length === 0) {
    isShowing = false;
    return;
  }
  isShowing = true;

  const { call, resolve } = confirmQueue.shift()!;
  const icon = getToolIcon(call.function.name);
  const name = formatToolName(call.function.name);
  logInfo(`等待确认: ${call.function.name}`, JSON.stringify(call.function.arguments));

  const titleEl = modalEl!.querySelector('#toolConfirmTitle')!;
  const bodyEl = modalEl!.querySelector('#toolConfirmBody')!;
  confirmBtn = modalEl!.querySelector('#toolConfirmBtn') as HTMLButtonElement;
  cancelBtn = modalEl!.querySelector('#toolCancelBtn') as HTMLButtonElement;

  titleEl.textContent = `${icon} 确认操作：${name}`;

  let bodyHtml = `<div class="tool-confirm-info">`;
  bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">操作：</span><span>${name}</span></div>`;

  const args = call.function.arguments || {};
  if (call.function.name === 'read_file' || call.function.name === 'write_file' ||
      call.function.name === 'list_directory' || call.function.name === 'search_files' ||
      call.function.name === 'create_directory' || call.function.name === 'delete_file') {
    // 支持 paths 数组（批量删除）和单个 path
    if (args.paths && Array.isArray(args.paths) && args.paths.length > 0) {
      bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">路径（${args.paths.length} 项）：</span></div>`;
      bodyHtml += `<pre class="tool-confirm-preview">${escapeHtml(args.paths.map((p: string) => String(p)).join('\n'))}</pre>`;
    } else if (args.path) {
      bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">路径：</span><code>${escapeHtml(String(args.path))}</code></div>`;
    }
  }
  if (call.function.name === 'run_command') {
    if (args.command) {
      bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">命令：</span><code>${escapeHtml(String(args.command))}</code></div>`;
    }
  }
  if (call.function.name === 'write_file' && args.content) {
    const preview = String(args.content).slice(0, 500);
    bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">内容预览：</span></div>`;
    bodyHtml += `<pre class="tool-confirm-preview">${escapeHtml(preview)}${String(args.content).length > 500 ? '\n...' : ''}</pre>`;
  }

  bodyHtml += `</div>`;
  bodyEl.innerHTML = bodyHtml;

  // 队列计数提示
  if (confirmQueue.length > 0) {
    bodyEl.querySelector('.tool-confirm-info')!.insertAdjacentHTML('beforeend',
      `<div class="tool-confirm-row" style="margin-top:8px;color:var(--text-muted);font-size:12px;">队列中还有 ${confirmQueue.length} 个待确认</div>`);
  }

  modalEl!.style.display = '';

  const onConfirm = (e: Event) => {
    e.stopPropagation();
    cleanup();
    logInfo(`已确认: ${call.function.name}`);
    resolve(true);
    showNext();
  };
  const onCancel = (e: Event) => {
    e.stopPropagation();
    cleanup();
    logInfo(`已取消: ${call.function.name}`);
    resolve(false);
    showNext();
  };
  const cleanup = () => {
    confirmBtn?.removeEventListener('click', onConfirm);
    cancelBtn?.removeEventListener('click', onCancel);
    if (modalEl) modalEl.style.display = 'none';
  };

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', onCancel);
}

/** 取消当前显示的确认（不影响队列中的后续确认） */
function cancelCurrent(): void {
  if (!isShowing) return;
  // 当前显示的确认已从队列 shift 出来，直接触发取消按钮
  if (cancelBtn) {
    cancelBtn.click();
  }
}
