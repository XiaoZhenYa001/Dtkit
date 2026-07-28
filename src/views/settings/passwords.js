import { showToast } from '../../core/utils.js';

let initialized = false;
const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke?.(command, args);

export async function initPasswordSettings() {
    if (initialized) return;
    const select = document.getElementById('settingsPasswordClipboardTime');
    const status = document.getElementById('settingsPasswordClipboardStatus');
    if (!select || !status) return;
    initialized = true;
    try {
        const settings = await invoke('get_password_settings');
        select.value = String(settings.clipboardClearSeconds);
        select.disabled = false;
        status.textContent = '仅当剪贴板仍是本次复制的密码时才会清除；不会改动之后复制的内容。';
    } catch (error) {
        status.textContent = `读取密码设置失败：${error}`;
    }
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await invoke('set_password_settings', {
                settings: { clipboardClearSeconds: Number(select.value) }
            });
            status.textContent = select.value === '0'
                ? '自动清理已关闭；密码仍会被排除在 Windows 剪贴板历史和云同步之外。'
                : '设置已保存；只会条件清理本次密码。';
            showToast('密码剪贴板策略已更新');
        } catch (error) {
            status.textContent = `保存失败：${error}`;
            showToast(`保存失败：${error}`, 'error');
        } finally {
            select.disabled = false;
        }
    });
}
