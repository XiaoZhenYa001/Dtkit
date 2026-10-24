import { showToast } from '../../core/utils.js';

const bound = new WeakSet();

export function initProjectLink() {
    const link = document.getElementById('aboutProjectLink');
    if (!link || bound.has(link)) return;
    bound.add(link);
    link.addEventListener('click', async event => {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return;
        event.preventDefault();
        try { await invoke('open_project_page'); }
        catch (error) { showToast(`无法打开项目主页：${error}`, 'error'); }
    });
}
