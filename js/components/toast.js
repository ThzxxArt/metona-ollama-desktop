/**
 * Toast - 通知组件
 */

let toastContainer = null;

export function initToast() {
    toastContainer = document.querySelector('#toastContainer');
}

/**
 * 显示 Toast 通知
 * @param {string} text - 通知文本
 * @param {'info'|'success'|'warning'|'error'} type - 通知类型
 * @param {number} duration - 显示时长 (ms)
 */
export function showToast(text, type = 'info', duration = 3000) {
    if (!toastContainer) return;

    const iconMap = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${iconMap[type] || 'ℹ'}</span><span>${text}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        toast.addEventListener('animationend', () => toast.remove());
    }, duration);
}
