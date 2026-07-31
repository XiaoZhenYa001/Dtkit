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
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('dtkit-toast--closing');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 挂载到浏览器窗口供旧模块使用；纯逻辑测试环境没有 window。
if (typeof window !== 'undefined') window.showToast = showToast;
