import { shortcutFromKeyboardEvent } from '../views/settings/model.js';

function notify(message, type, fallback) {
    const toast = globalThis.window?.showToast;
    if (typeof toast === 'function') toast(message, type);
    else if (fallback) fallback.textContent = message;
}

function targetKey(target) {
    return target?.kind === 'palette' ? 'palette' : `tool:${target?.toolId || ''}`;
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
    let recording = false;

    const binding = () => bindings.find(item => targetKey(item.target) === key);
    const render = () => {
        renderKeys(view.record, binding()?.accelerator);
        view.record.classList.toggle('is-recording', recording);
        view.record.disabled = !invoke;
        view.clear.disabled = !invoke || !binding();
        view.hint.textContent = recording
            ? '请按包含 Ctrl、Alt、Shift 或 Win 的组合键'
            : (options.compact ? '仅弹出当前工具' : '唤起轻量命令面板');
    };

    view.record.addEventListener('click', event => {
        event.stopPropagation(); recording = !recording; render();
    }, { signal });
    view.clear.addEventListener('click', async event => {
        event.stopPropagation();
        if (!invoke) return;
        try {
            bindings = await invoke('replace_shortcut_bindings', {
                bindings: bindings.filter(item => targetKey(item.target) !== key)
            });
            recording = false; render(); notify(`已清除“${options.label}”快捷键`, '', view.hint);
        } catch (error) { notify(`快捷键清除失败：${error}`, 'error', view.hint); }
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
        const conflict = bindings.find(item => item.accelerator === candidate && targetKey(item.target) !== key);
        if (conflict) { notify(`快捷键 ${candidate} 已被其他工具使用`, 'error', view.hint); return; }
        const next = bindings.filter(item => targetKey(item.target) !== key);
        next.push({ accelerator: candidate, target, enabled: true });
        try {
            bindings = await invoke('replace_shortcut_bindings', { bindings: next });
            recording = false; render(); notify(`“${options.label}”快捷键已更新`, '', view.hint);
        } catch (error) { notify(`快捷键保存失败：${error}`, 'error', view.hint); }
    }, { signal, capture: true });

    container.replaceChildren(view.root);
    render();
    if (invoke) invoke('get_shortcut_bindings').then(result => {
        if (!signal.aborted) { bindings = result; render(); }
    }).catch(error => { if (!signal.aborted) view.hint.textContent = `读取失败：${error}`; });
    return () => controller.abort();
}
