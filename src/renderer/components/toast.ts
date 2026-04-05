/**
 * Toast - 通知组件
 */

let toastContainer: HTMLElement | null = null;

export function initToast(): void {
  toastContainer = document.querySelector('#toastContainer');
}

export function showToast(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info', duration = 3000): void {
  if (!toastContainer) return;

  const iconMap: Record<string, string> = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${iconMap[type] || 'ℹ'}</span><span>${text}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}
