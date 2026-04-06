/**
 * ToolConfirmModal - 工具调用确认对话框
 */

import type { ToolCall } from '../types.js';
import { getToolIcon, formatToolName } from '../services/tool-registry.js';

let modalEl: HTMLElement | null = null;
let resolveConfirm: ((confirmed: boolean) => void) | null = null;

export function initToolConfirmModal(): void {
  modalEl = document.querySelector('#toolConfirmModal')!;
  if (!modalEl) return;

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      cancelConfirm();
    }
  });
}

export function showToolConfirm(call: ToolCall): Promise<boolean> {
  return new Promise((resolve) => {
    if (!modalEl) {
      modalEl = document.querySelector('#toolConfirmModal')!;
      if (!modalEl) { resolve(false); return; }
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) cancelConfirm();
      });
    }

    resolveConfirm = resolve;

    const icon = getToolIcon(call.function.name);
    const name = formatToolName(call.function.name);

    const titleEl = modalEl.querySelector('#toolConfirmTitle')!;
    const bodyEl = modalEl.querySelector('#toolConfirmBody')!;
    const confirmBtn = modalEl.querySelector('#toolConfirmBtn')! as HTMLButtonElement;
    const cancelBtn = modalEl.querySelector('#toolCancelBtn')! as HTMLButtonElement;

    titleEl.textContent = `${icon} 确认操作：${name}`;

    let bodyHtml = `<div class="tool-confirm-info">`;
    bodyHtml += `<div class="tool-confirm-row"><span class="tool-confirm-label">操作：</span><span>${name}</span></div>`;

    const args = call.function.arguments || {};
    if (call.function.name === 'read_file' || call.function.name === 'write_file' ||
        call.function.name === 'list_directory' || call.function.name === 'search_files' ||
        call.function.name === 'create_directory' || call.function.name === 'delete_file') {
      if (args.path) {
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

    modalEl.style.display = '';

    const onConfirm = () => {
      cleanup();
      resolveConfirm?.(true);
    };
    const onCancel = () => {
      cleanup();
      resolveConfirm?.(false);
    };
    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      if (modalEl) modalEl.style.display = 'none';
      resolveConfirm = null;
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function cancelConfirm(): void {
  if (resolveConfirm) {
    const r = resolveConfirm;
    resolveConfirm = null;
    if (modalEl) modalEl.style.display = 'none';
    r(false);
  }
}

function escapeHtml(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}
