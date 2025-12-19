/**
 * 通用工具函数
 */

/**
 * 显示 Toast 提示
 * @param {string} message - 提示消息
 * @param {'success' | 'error' | 'info'} type - 提示类型
 */
export function showToast(message, type = 'success') {
    // 移除已存在的 toast
    const existingToast = document.querySelector('.dtkit-toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = `dtkit-toast dtkit-toast--${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        background: ${type === 'error' ? '#ef4444' : type === 'info' ? '#3b82f6' : '#10b981'};
        color: white;
        border-radius: 8px;
        font-size: 14px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: toastIn 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 挂载到 window 供全局使用
window.showToast = showToast;
