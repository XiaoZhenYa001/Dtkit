import { shortcutFromKeyboardEvent } from '../views/settings/model.js';

function notify(message, type, fallback) {
    const toast = globalThis.window?.showToast;
    if (typeof toast === 'function') toast(message, type);
    else if (fallback) fallback.textContent = message;
}

export function targetKey(target) {
    if (target?.kind === 'palette') return 'palette';
    if (target?.kind === 'desktopSpace') return 'desktopSpace';
    return `tool:${target?.toolId || ''}`;
}

function displayKeys(accelerator) {
    return accelerator
        .replace(/Control/gi, 'Ctrl')
        .replace(/Super/gi, 'Win')
        .replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓')
        .replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→')
        .split('+');
}

function renderKeys(container, accelerator) {
    if (!accelerator) {
        const label = document.createElement('span');
        label.className = 'shortcut-binding__unbound';
        label.textContent = '设置快捷键';
        container.replaceChildren(label);
        return;
    }
    const fragment = document.createDocumentFragment();
    displayKeys(accelerator).forEach((key, index, keys) => {
        const element = document.createElement('kbd'); element.textContent = key; fragment.append(element);
        if (index < keys.length - 1) fragment.append(document.createTextNode('+'));
    });
    container.replaceChildren(fragment);
}

function createMarkup({ label, icon, compact }) {
    const root = document.createElement('div');
    root.className = `shortcut-binding${compact ? ' shortcut-binding--compact' : ''}`;
    const identity = document.createElement('div'); identity.className = 'shortcut-binding__identity';
    const iconNode = document.createElement('i'); iconNode.className = icon || 'ri-command-line';
    const text = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = compact ? '专属快捷键' : label;
    const hint = document.createElement('span'); hint.textContent = compact ? '仅弹出当前工具' : '唤起轻量命令面板';
    text.append(title, hint); identity.append(iconNode, text);
    const controls = document.createElement('div'); controls.className = 'shortcut-binding__controls';
    const record = document.createElement('button'); record.type = 'button'; record.className = 'shortcut-binding__record'; record.disabled = true;
    record.setAttribute('aria-label', `设置“${label}”的快捷键`);
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'shortcut-binding__clear'; clear.disabled = true;
    clear.title = '清除快捷键'; clear.setAttribute('aria-label', `清除“${label}”的快捷键`); clear.innerHTML = '<i class="ri-close-line"></i>';
    controls.append(record, clear); root.append(identity, controls);
    return { root, record, clear, hint };
}

export function mountShortcutBinding(container, options) {
    const invoke = globalThis.window?.__TAURI__?.core?.invoke;
    const target = options.target;
    const key = targetKey(target);
    const controller = new AbortController();
    const { signal } = controller;
    const view = createMarkup(options);
    let bindings = [];
    let recording = false, ready = false, busy = false, revision = 0, lastError = '';
    const idleHint = options.hint || (options.compact ? '仅弹出当前工具' : '唤起轻量命令面板');

    const binding = () => bindings.find(item => targetKey(item.target) === key);
    const render = () => {
        renderKeys(view.record, binding()?.accelerator);
        view.record.classList.toggle('is-recording', recording);
        view.record.disabled = !invoke || !ready || busy;
        view.clear.disabled = !invoke || !ready || !binding() || busy;
        const unavailable = binding()?.registered === false;
        view.root.dataset.status = unavailable ? 'unregistered' : 'ready';
        view.hint.textContent = lastError || (recording
            ? '请按包含 Ctrl、Alt、Shift 或 Win 的组合键'
            : busy ? '正在保存…' : unavailable ? `快捷键未注册：${binding().registrationError || '请更换组合键或重试'}` : idleHint);
    };
    const accept = result => {
        if (signal.aborted || !Array.isArray(result)) return;
        revision++; bindings = result; ready = true; render();
    };
    const refresh = async () => {
        const request = ++revision;
        const result = await invoke('get_shortcut_bindings');
        if (!signal.aborted && request === revision) accept(result);
    };
    const save = async (command, args, message) => {
        if (!invoke || busy) return;
        busy = true; recording = false; lastError = ''; revision++; render();
        let committed = false;
        try {
            await invoke(command, args);
            committed = true;
            // Fetch the latest state rather than rendering an edit response that
            // may already be superseded by a concurrent edit in another WebView.
            await refresh();
            if (!signal.aborted) { announce(); notify(message, '', view.hint); }
        } catch (error) { lastError = `快捷键${committed ? '已保存，状态刷新失败' : '保存失败'}：${error}`; }
        finally { busy = false; if (!signal.aborted) render(); }
    };
    const announce = () => {
        window.dispatchEvent(new CustomEvent('dtkit:shortcut-bindings-changed', { detail: { bindings } }));
    };

    view.record.addEventListener('click', event => {
        event.stopPropagation();
        if (busy) return;
        lastError = ''; recording = !recording;
        if (recording) window.dispatchEvent(new CustomEvent('dtkit:shortcut-recording-started', { detail: view.root }));
        render();
    }, { signal });
    view.clear.addEventListener('click', event => {
        event.stopPropagation();
        void save('remove_shortcut_binding', { target }, `已清除“${options.label}”快捷键`);
    }, { signal });
    document.addEventListener('keydown', async event => {
        if (!recording) return;
        event.preventDefault(); event.stopPropagation();
        const candidate = shortcutFromKeyboardEvent(event);
        if (!candidate) return;
        if (candidate === 'Escape') { recording = false; render(); return; }
        if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            notify('系统级快捷键至少需要一个修饰键', 'error', view.hint); return;
        }
        await save('upsert_shortcut_binding', { binding: { accelerator: candidate, target, enabled: true } }, `“${options.label}”快捷键已更新`);
    }, { signal, capture: true });

    container.replaceChildren(view.root);
    render();
    if (invoke) {
        const reload = () => refresh().catch(error => { if (!signal.aborted) view.hint.textContent = `读取失败：${error}`; });
        window.addEventListener('dtkit:shortcut-bindings-changed', event => {
            if (Array.isArray(event.detail?.bindings)) accept(event.detail.bindings);
            else reload();
        }, { signal });
        const listen = window.__TAURI__?.event?.listen;
        if (typeof listen === 'function') {
            let unlisten = null;
            Promise.resolve(listen('shortcut-bindings-changed', event => accept(event.payload)))
                .then(dispose => { if (signal.aborted) dispose(); else unlisten = dispose; })
                .catch(error => { if (!signal.aborted) view.hint.textContent = `同步失败：${error}`; });
            signal.addEventListener('abort', () => unlisten?.(), { once: true });
        }
        window.addEventListener('focus', reload, { signal });
        window.addEventListener('dtkit:shortcut-recording-started', event => {
            if (event.detail !== view.root && recording) { recording = false; render(); }
        }, { signal });
        reload();
    }
    return () => controller.abort();
}
