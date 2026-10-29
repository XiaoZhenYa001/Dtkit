let current = null;

function readStatus(value) {
    if (!value || typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean'
        || typeof value.registered !== 'boolean' || (value.warning != null && typeof value.warning !== 'string')
        || (value.enabled && !value.registered)) {
        throw new Error('自启服务未返回有效状态');
    }
    return value;
}

export async function initAutostartSettings() {
    const root = document.getElementById('autostartSetting');
    const toggle = document.getElementById('autostartEnabled');
    const status = document.getElementById('autostartStatus');
    const retry = document.getElementById('autostartRetry');
    const remove = document.getElementById('autostartRemove');
    if (!root || !toggle || !status || !retry || !remove || current?.root === root) return;
    current?.destroy();
    const controller = new AbortController();
    const { signal } = controller;
    let confirmed = null, ready = false, busy = false;
    const active = () => !signal.aborted && root.isConnected;
    const on = (node, event, listener) => node.addEventListener(event, listener, { signal });
    const invoke = (command, args) => {
        const native = globalThis.window?.__TAURI__?.core?.invoke;
        if (typeof native !== 'function') throw new Error('请在 DtKit 桌面程序中设置开机自启');
        return native(command, args);
    };
    const message = (text, tone = '') => { status.textContent = text; status.dataset.tone = tone; };
    const controls = () => {
        root.setAttribute('aria-busy', String(busy));
        toggle.disabled = busy || !ready || !confirmed?.available;
        retry.disabled = busy; remove.disabled = busy;
    };
    const display = (value, action = null) => {
        confirmed = value; ready = true; toggle.checked = value.enabled;
        remove.hidden = !(value.registered && !value.enabled);
        retry.hidden = !value.warning;
        if (value.warning) message(value.warning, 'warning');
        else if (action && (action === 'enable' ? !value.enabled : value.registered)) {
            message('当前自启状态未达到请求的设置，请重新读取后重试。', 'warning'); retry.hidden = false;
        }
        else if (!value.available) message('当前环境不支持设置开机自启。', 'info');
        else if (value.enabled) message('已开启：下次登录 Windows 时仅在托盘运行。', action ? 'success' : '');
        else message(action === 'disable' ? '已关闭开机自启，不影响当前运行。' : '未开启开机自启。');
        controls();
    };
    const failed = (error, reading) => {
        ready = false;
        toggle.checked = confirmed?.enabled === true;
        remove.hidden = true; retry.hidden = false;
        message(`${reading ? '读取自启状态失败' : '未能确认自启设置'}：${error?.message || error}。请重新读取状态。`, 'error');
    };
    const recoverFocus = initiator => {
        if (initiator && document.activeElement === document.body && ready && confirmed?.available && !toggle.disabled) {
            toggle.focus({ preventScroll: true });
        }
    };
    const load = async () => {
        if (busy || !active()) return;
        const initiator = root.contains(document.activeElement) ? document.activeElement : null;
        busy = true; ready = false; controls();
        message('正在读取开机自启状态…', 'pending');
        try {
            const value = readStatus(await invoke('get_autostart_status'));
            if (active()) display(value);
        } catch (error) { if (active()) failed(error, true); }
        finally { if (active()) { busy = false; controls(); recoverFocus(initiator); } }
    };
    const save = async enabled => {
        if (busy || !ready || !active()
            || (enabled && !confirmed?.available)
            || (!enabled && !confirmed?.registered)) return;
        const initiator = root.contains(document.activeElement) ? document.activeElement : null;
        busy = true; controls();
        message(enabled ? '正在登记开机自启…' : '正在取消开机自启登记…', 'pending');
        try {
            const value = readStatus(await invoke('set_autostart_enabled', { enabled }));
            if (active()) display(value, enabled ? 'enable' : 'disable');
        } catch (error) { if (active()) failed(error, false); }
        finally { if (active()) { busy = false; controls(); recoverFocus(initiator); } }
    };
    on(toggle, 'change', () => void save(toggle.checked));
    on(retry, 'click', () => void load());
    on(remove, 'click', () => void save(false));
    const refreshVisible = () => {
        if (root.closest('#settingsView')?.classList.contains('view--active') && !busy) void load();
    };
    on(window, 'focus', refreshVisible);
    const view = root.closest('#settingsView');
    const observer = new MutationObserver(refreshVisible);
    if (view) observer.observe(view, { attributes: true, attributeFilter: ['class'] });
    current = { root, destroy() { controller.abort(); observer.disconnect(); } };
    on(window, 'pagehide', () => { current?.destroy(); current = null; });
    await load();
}
