/**
 * Toast - 通知组件
 * 使用 textContent 渲染消息文本（防 XSS：文件名等外部输入可能包含 HTML）
 */

let toastContainer: HTMLElement | null = null;

function getContainer(): HTMLElement | null {
  if (!toastContainer) {
    toastContainer = document.querySelector('#toastContainer');
  }
  return toastContainer;
}

export function initToast(): void {
  toastContainer = document.querySelector('#toastContainer');
}

export function showToast(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info', duration = 3000): void {
  const container = getContainer();
  if (!container) return;

  const iconMap: Record<string, string> = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = iconMap[type] || 'ℹ';

  const msg = document.createElement('span');
  msg.textContent = text; // textContent 防止外部输入注入 HTML

  toast.append(icon, msg);
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}
