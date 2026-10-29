import { showToast } from '../../core/utils.js';

let initialized = false;
const ALLOWED_SECONDS = new Set([0, 15, 30, 60]);
const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke?.(command, args);

function readSeconds(settings) {
    const seconds = settings?.clipboardClearSeconds;
    if (!ALLOWED_SECONDS.has(seconds)) throw new Error('密码设置服务未返回有效的清理时间');
    return seconds;
}

export async function initPasswordSettings() {
    if (initialized) return;
    const select = document.getElementById('settingsPasswordClipboardTime');
    const status = document.getElementById('settingsPasswordClipboardStatus');
    if (!select || !status) return;
    initialized = true;
    const row = select.closest('.password-clipboard-policy');
    let savedSeconds = 30, busy = false, ready = false;
    status.classList.add('settings-inline-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    select.setAttribute('aria-describedby', status.id);
    const retry = document.createElement('button');
    retry.id = 'settingsPasswordRetry';
    retry.className = 'settings-btn settings-btn--secondary settings-inline-retry';
    retry.type = 'button';
    retry.textContent = '重新读取';
    retry.hidden = true;
    status.after(retry);
    const message = (text, tone = '') => { status.textContent = text; status.dataset.tone = tone; };
    const setBusy = value => {
        busy = value; row?.setAttribute('aria-busy', String(value));
        select.disabled = value || !ready; retry.disabled = value;
    };
    const load = async () => {
        if (busy) return;
        ready = false; retry.hidden = true; setBusy(true);
        message('正在读取密码剪贴板策略…', 'busy');
        try {
            savedSeconds = readSeconds(await invoke('get_password_settings'));
            select.value = String(savedSeconds); ready = true;
            message('仅当剪贴板仍是本次复制的密码时才会清除；不会改动之后复制的内容。');
        } catch (error) {
            message(`读取失败：${error?.message || error}`, 'error'); retry.hidden = false;
        } finally { setBusy(false); }
    };
    retry.addEventListener('click', () => void load());
    select.addEventListener('change', async () => {
        if (busy || !ready) return;
        const requested = Number(select.value);
        if (!ALLOWED_SECONDS.has(requested)) { select.value = String(savedSeconds); return; }
        setBusy(true); message('正在保存密码剪贴板策略…', 'busy');
        try {
            savedSeconds = readSeconds(await invoke('set_password_settings', {
                settings: { clipboardClearSeconds: requested }
            }));
            select.value = String(savedSeconds);
            message(savedSeconds === 0
                ? '自动清理已关闭；密码仍会被排除在 Windows 剪贴板历史和云同步之外。'
                : '设置已保存；只会条件清理本次密码。', 'success');
            showToast('密码剪贴板策略已更新');
        } catch (error) {
            select.value = String(savedSeconds);
            message(`保存失败：${error?.message || error}，已保留原策略。`, 'error');
            showToast(`保存失败：${error?.message || error}`, 'error');
        } finally { setBusy(false); }
    });
    await load();
}
