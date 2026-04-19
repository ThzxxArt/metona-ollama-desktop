/**
 * PromptModal - 自定义 prompt/confirm 对话框
 * 替代 window.prompt() / window.confirm()（Electron contextIsolation 下不可用）
 */

let overlayEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
let okBtn: HTMLButtonElement | null = null;

import { escapeHtml } from '../utils/utils.js';
let cancelBtn: HTMLButtonElement | null = null;
let resolveFn: ((value: string | null) => void) | null = null;

function ensureModal(): void {
  if (overlayEl) return;

  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay';
  overlayEl.id = 'promptModal';
  overlayEl.style.display = 'none';
  overlayEl.innerHTML = `
    <div class="modal" style="max-width:420px;">
      <div class="modal-header">
        <h3 id="promptTitle">输入</h3>
      </div>
      <div class="modal-body" id="promptBody"></div>
      <div class="modal-actions" style="padding:12px 20px 16px;">
        <div style="flex:1;"></div>
        <button class="btn btn-outline" id="promptCancel">取消</button>
        <button class="btn btn-primary" id="promptOk">确定</button>
      </div>
    </div>
  `;

  document.querySelector('#app')!.appendChild(overlayEl);
  titleEl = overlayEl.querySelector('#promptTitle')!;
  bodyEl = overlayEl.querySelector('#promptBody')!;
  okBtn = overlayEl.querySelector('#promptOk')! as HTMLButtonElement;
  cancelBtn = overlayEl.querySelector('#promptCancel')! as HTMLButtonElement;

  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) close(null);
  });
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close(null);
  });
  okBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (inputEl instanceof HTMLSelectElement) {
      close(inputEl.value);
    } else if (inputEl) {
      close((inputEl as HTMLInputElement | HTMLTextAreaElement).value);
    } else {
      close('');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!overlayEl || overlayEl.style.display === 'none') return;
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
    if (e.key === 'Enter' && !(inputEl instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      okBtn!.click();
    }
  });
}

function close(value: string | null): void {
  if (overlayEl) overlayEl.style.display = 'none';
  if (resolveFn) {
    const r = resolveFn;
    resolveFn = null;
    r(value);
  }
}

/** 显示自定义 prompt，返回用户输入或 null（取消） */
export function showPrompt(options: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  type?: 'text' | 'textarea' | 'select';
  options?: Array<{ value: string; label: string }>;
}): Promise<string | null> {
  ensureModal();

  return new Promise((resolve) => {
    resolveFn = resolve;
    titleEl!.textContent = options.title;

    let html = '';
    if (options.message) {
      html += `<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;white-space:pre-line;">${escapeHtml(options.message)}</p>`;
    }

    if (options.type === 'select' && options.options) {
      html += `<select class="setting-input" id="promptInput">${options.options.map(o =>
        `<option value="${escapeHtml(o.value)}"${o.value === options.defaultValue ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
      ).join('')}</select>`;
    } else if (options.type === 'textarea') {
      html += `<textarea class="setting-input" id="promptInput" rows="4" placeholder="${escapeHtml(options.placeholder || '')}" style="resize:vertical;min-height:80px;">${escapeHtml(options.defaultValue || '')}</textarea>`;
    } else {
      html += `<input class="setting-input" id="promptInput" type="text" value="${escapeHtml(options.defaultValue || '')}" placeholder="${escapeHtml(options.placeholder || '')}">`;
    }

    bodyEl!.innerHTML = html;
    inputEl = bodyEl!.querySelector('#promptInput')! as HTMLInputElement;

    overlayEl!.style.display = '';

    // 聚焦并选中文本
    setTimeout(() => {
      if (inputEl instanceof HTMLInputElement) {
        inputEl.focus();
        if (options.defaultValue) inputEl.select();
      } else if (inputEl instanceof HTMLTextAreaElement) {
        inputEl.focus();
      }
    }, 50);
  });
}

/** 显示自定义 confirm，返回 true/false */
export function showConfirm(message: string, title = '确认'): Promise<boolean> {
  ensureModal();

  return new Promise((resolve) => {
    resolveFn = (val) => resolve(val !== null);
    titleEl!.textContent = title;
    bodyEl!.innerHTML = `<p style="color:var(--text-secondary);font-size:13px;white-space:pre-line;">${escapeHtml(message)}</p>`;
    inputEl = null;
    overlayEl!.style.display = '';
    okBtn!.focus();
  });
}


