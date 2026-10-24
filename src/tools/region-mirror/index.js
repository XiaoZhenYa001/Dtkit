import { registerTool } from '../toolRegistry.js';
import { template, renderMirror } from './template.js';
import '../../css/tools/region-mirror.css';

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let controller = null;
let unlisten = null;
let generation = 0;
let revision = 0;
let refreshRequest = 0;
let busy = false;
let items = [];
const pending = new Set();

function available() { return Boolean(window.__TAURI__?.core?.invoke); }
function selecting() { return items.some(item => item.status === 'selecting'); }

function notice(message = '', error = false) {
    const element = document.getElementById('mirrorNotice');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', error);
}

function render(focusTarget = null) {
    const list = document.getElementById('mirrorList');
    if (!list) return;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedAction = focusTarget?.action || focused?.dataset.mirrorAction;
    const focusedId = focusTarget?.id || focused?.dataset.mirrorId;
    const focusedSummary = focused?.closest('details')?.dataset.mirrorOptions;
    const open = new Set([...list.querySelectorAll('details[open]')].map(element => element.dataset.mirrorOptions));
    document.getElementById('mirrorCount').textContent = `${items.filter(item => item.status !== 'selecting').length} / 6`;
    const select = document.getElementById('mirrorSelect');
    select.disabled = busy || !available() || items.length >= 6 || selecting();
    select.querySelector('span').textContent = busy || selecting() ? '正在框选…' : '框选悬浮区域';
    document.getElementById('mirrorLimit').textContent = selecting() ? '完成当前框选后可继续添加，Esc 可取消。' : items.length >= 6 ? '已打开 6 个小窗；可重新框选替换，或关闭后添加。' : '在目标窗口内拖动框选，按 Enter 确认 · Esc 取消';
    list.innerHTML = items.length ? items.map(item => renderMirror(item, {
        pending: pending.has(item.id),
        canReselect: !busy && !selecting(),
        open: open.has(String(item.id))
    })).join('') : `<div class="mirror-empty"><i class="ri-picture-in-picture-line" aria-hidden="true"></i><strong>把需要关注的内容，留在眼前</strong><span>先打开视频、下载进度或参考资料，再框选其中一块。</span><small>源窗口被其他窗口遮住时，小窗仍可显示；部分应用可能暂停后台渲染。</small></div>`;
    if (focusedAction) {
        const target = [...list.querySelectorAll('[data-mirror-action]')].find(element => element.dataset.mirrorAction === focusedAction && element.dataset.mirrorId === focusedId);
        if (target) target.focus({ preventScroll: true });
        else if (!items.some(item => String(item.id) === focusedId)) {
            const fallback = list.querySelector('[data-mirror-action="show"]:not(:disabled)') || document.getElementById('mirrorSelect');
            (fallback.disabled ? document.getElementById('mirrorRefresh') : fallback)?.focus({ preventScroll: true });
        }
    } else if (focusedSummary) [...list.querySelectorAll('details')].find(element => element.dataset.mirrorOptions === focusedSummary)?.querySelector('summary')?.focus({ preventScroll: true });
}

function applyItems(result) {
    const previousSelection = items.find(item => item.status === 'selecting');
    items = Array.isArray(result) ? result : [];
    if (previousSelection && !selecting()) {
        notice(items.some(item => item.id === previousSelection.id)
            ? '悬浮窗已就绪。可在下方调整显示，或随时找回小窗。'
            : '已取消框选，已有小窗继续保留。');
    }
    render();
}

async function refresh() {
    const current = generation;
    const before = revision;
    const request = ++refreshRequest;
    try {
        const result = await invoke('list_region_mirrors');
        if (current !== generation || before !== revision || request !== refreshRequest) return;
        applyItems(result);
    } catch (error) {
        if (current === generation && before === revision && request === refreshRequest) notice(`无法更新窗口列表：${error}`, true);
    }
}

async function selectRegion(replaceId) {
    if (busy || selecting() || !available()) return;
    const current = generation;
    const focused = document.activeElement;
    const restoreFocus = replaceId ? focused?.dataset.mirrorAction === 'reselect' && focused.dataset.mirrorId === String(replaceId) : focused?.id === 'mirrorSelect';
    let failed = false;
    busy = true;
    revision += 1;
    notice(replaceId ? '重新框选后按 Enter 替换；按 Esc 取消会保留原小窗。' : '在目标窗口内拖动框选，然后按 Enter 确认。');
    render();
    try { await invoke('start_region_mirror', replaceId ? { replaceId } : {}); }
    catch (error) { failed = true; if (current === generation) notice(String(error), true); }
    finally {
        if (current === generation) {
            busy = false;
            const shouldFocus = failed && restoreFocus && document.activeElement === document.body;
            render(shouldFocus && replaceId ? { id: String(replaceId), action: 'reselect' } : null);
            if (shouldFocus && !replaceId) document.getElementById('mirrorSelect')?.focus({ preventScroll: true });
        }
    }
}

async function control(event) {
    const element = event.target.closest('[data-mirror-action]');
    if (!element || element.disabled || (event.type === 'click' && element.tagName === 'SELECT')) return;
    const id = Number(element.dataset.mirrorId);
    const action = element.dataset.mirrorAction;
    if (!Number.isSafeInteger(id) || pending.has(id)) return;
    if (action === 'reselect') { await selectRegion(id); return; }
    const current = generation;
    const restoreFocus = document.activeElement === element;
    const value = element.tagName === 'SELECT' ? Number(element.value) : undefined;
    if (element.tagName === 'SELECT' && !element.value) return;
    pending.add(id);
    revision += 1;
    notice();
    render();
    try {
        await invoke('control_region_mirror', { id, action, ...(value === undefined ? {} : { value }) });
        if (current === generation && action === 'clickThrough') notice('穿透时可操作小窗后方的应用；点击「找回小窗」即可恢复拖动和菜单。');
    } catch (error) { if (current === generation) notice(String(error), true); }
    finally {
        if (current === generation) {
            pending.delete(id);
            const shouldFocus = restoreFocus && document.activeElement === document.body;
            const closed = action === 'close' && !items.some(item => item.id === id);
            render(shouldFocus ? { id: String(closed ? items[0]?.id : id), action: closed ? 'show' : action } : null);
            if (shouldFocus && closed && !items.length) document.getElementById('mirrorSelect')?.focus({ preventScroll: true });
        }
    }
}

async function init() {
    destroy();
    const current = generation;
    controller = new AbortController();
    const { signal } = controller;
    items = [];
    busy = false;
    pending.clear();
    render();
    if (!available()) {
        notice('请在 Windows 桌面版 DtKit 中使用区域悬浮。');
        document.getElementById('mirrorRefresh').disabled = true;
        return;
    }
    document.getElementById('mirrorSelect').addEventListener('click', () => selectRegion(), { signal });
    document.getElementById('mirrorRefresh').addEventListener('click', refresh, { signal });
    document.getElementById('mirrorList').addEventListener('click', control, { signal });
    document.getElementById('mirrorList').addEventListener('change', control, { signal });
    if (!window.__DTKIT_TOOL_PAGE_CONTEXT?.embedded) window.addEventListener('focus', refresh, { signal });
    window.addEventListener('dtkit:power-state', event => { if (!event.detail?.suspended) refresh(); }, { signal });
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
        try {
            const dispose = await listen('region-mirrors-changed', event => {
                if (current !== generation) return;
                revision += 1;
                applyItems(event.payload);
            });
            if (current !== generation) { dispose(); return; }
            unlisten = dispose;
        } catch (error) { if (current === generation) notice(`窗口状态监听失败，可点击刷新：${error}`, true); }
    }
    if (current === generation) await refresh();
}

function destroy() {
    generation += 1;
    controller?.abort();
    controller = null;
    unlisten?.();
    unlisten = null;
}

registerTool({ id: 'region-mirror', name: '区域悬浮', icon: 'ri-picture-in-picture-line', colorClass: 'tool-card__icon--green', category: 'utility', status: 'ready', description: '将窗口里的选定区域实时置顶显示。', template, init, destroy });
