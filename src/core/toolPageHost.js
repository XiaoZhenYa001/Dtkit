import { createPageId } from './state.js';
import { mountShortcutBinding } from './shortcutBindingControl.js';
import { showToast } from './utils.js';
import '../css/tool-pages.css';

const WORKSPACE_KEY = 'dtkit_tool_workspace_v1';
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[\w-]{1,96}$/.test(value);

export function readToolWorkspace(getTool) {
    try {
        const source = localStorage.getItem(WORKSPACE_KEY);
        if (!source || source.length > MAX_JOURNAL_BYTES) return null;
        const journal = JSON.parse(source);
        if (journal.version !== 1 || !Array.isArray(journal.tabs) || journal.tabs.length > 64) return null;
        const tabs = journal.tabs.filter(tab => validId(tab?.id) && Array.isArray(tab.history) && tab.history.length <= 128)
            .map(tab => {
                const history = tab.history.filter(item => item && (!item.toolId || item.toolId === 'settings' || getTool(item.toolId)))
                    .map(item => ({ toolId: item.toolId || null, viewType: ['toolLibrary', 'favorites', 'settings'].includes(item.viewType) ? item.viewType : 'toolLibrary',
                        ...(validId(item.instanceId) ? { instanceId: item.instanceId } : {}), scrollTop: Math.max(0, Number(item.scrollTop) || 0) }));
                const historyIndex = Math.min(history.length - 1, Math.max(0, Number(tab.historyIndex) || 0));
                const current = history[historyIndex] || { toolId: null, viewType: 'toolLibrary' };
                return { id: tab.id, title: typeof tab.title === 'string' ? tab.title.slice(0, 100) : '工具库',
                    icon: getTool(current.toolId)?.icon || 'ri-apps-2-line', badge: '工具', history, historyIndex,
                    ...current, active: false };
            }).filter(tab => tab.history.length);
        if (!tabs.length || new Set(tabs.map(tab => tab.id)).size !== tabs.length) return null;
        const activeTabId = tabs.some(tab => tab.id === journal.activeTabId) ? journal.activeTabId : tabs[0].id;
        const pages = new Map();
        for (const entry of Array.isArray(journal.pages) ? journal.pages.slice(0, 256) : []) {
            if (validId(entry?.instanceId) && getTool(entry.toolId) && entry.schema === 1) pages.set(entry.instanceId, entry);
        }
        return { tabs, activeTabId, pages };
    } catch { return null; }
}

export function createToolPageHost({ contentArea, getTool, appState, onNewPage, onRename }) {
    const frames = new Map();
    let currentId = null;
    let powerSuspended = false;
    let shortcutDisposer = null;
    let snapshots = new Map();
    let container = document.getElementById('dynamicToolContainer');
    if (!container) { container = document.createElement('section'); container.id = 'dynamicToolContainer'; contentArea.append(container); }
    container.className = 'view tool-page-host';
    const toolbar = document.createElement('div'); toolbar.className = 'tool-page-toolbar';
    const shortcut = document.createElement('div'); shortcut.className = 'tool-page-shortcut';
    const actions = document.createElement('div'); actions.className = 'tool-page-actions';
    const createButton = (label, attribute, icon) => {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute(attribute, '');
        const glyph = document.createElement('i'); glyph.className = icon;
        const text = document.createElement('span'); text.textContent = label;
        button.append(glyph, text); actions.append(button); return button;
    };
    const newPage = createButton('新建同类页面', 'data-tool-page-new', 'ri-add-line');
    const rename = createButton('重命名', 'data-tool-page-rename', 'ri-edit-line');
    const windowButton = createButton('独立窗口', 'data-tool-page-window', 'ri-arrow-right-up-line');
    const launcherButton = createButton('创建启动入口', 'data-tool-page-launcher', 'ri-link');
    const sleepButton = createButton('主界面休眠', 'data-tool-page-sleep', 'ri-moon-line');
    toolbar.append(shortcut, actions); container.append(toolbar);
    const native = Boolean(window.__TAURI__?.core?.invoke);
    [windowButton, launcherButton, sleepButton].forEach(button => { button.disabled = !native; });
    newPage.addEventListener('click', () => { const entry = frames.get(currentId); if (entry) onNewPage(entry.toolId); });
    rename.addEventListener('click', () => onRename?.());
    windowButton.addEventListener('click', async () => {
        const entry = frames.get(currentId); if (!entry) return;
        try { await window.__TAURI__.core.invoke('open_quick_host', { target: { kind: 'tool', toolId: entry.toolId } }); }
        catch (error) { showToast(`打开独立窗口失败：${error}`, 'error'); }
    });
    launcherButton.title = '创建桌面快捷方式，下次只启动这个工具';
    launcherButton.addEventListener('click', async () => {
        const entry = frames.get(currentId); if (!entry || launcherButton.disabled) return;
        launcherButton.disabled = true;
        try {
            const path = await window.__TAURI__.core.invoke('create_tool_launcher', { toolId: entry.toolId });
            showToast(`已创建工具启动入口：${path}`);
        } catch (error) { showToast(`创建启动入口失败：${error}`, 'error'); }
        finally { launcherButton.disabled = false; }
    });
    sleepButton.addEventListener('click', () => window.__TAURI__.core.invoke('sleep_main_window').catch(error => showToast(`休眠失败：${error}`, 'error')));

    function lifecycle(entry, suspended) {
        entry.suspended = suspended;
        const runtime = entry.frame.contentWindow?.__DTKIT_TOOL_PAGE__;
        if (runtime) runtime.setSuspended(suspended);
        else entry.frame.contentWindow?.postMessage({ type: 'dtkit-tool-page-lifecycle', instanceId: entry.instanceId, suspended }, location.origin);
    }
    function hide() {
        for (const entry of frames.values()) { lifecycle(entry, true); entry.frame.hidden = true; }
        container.classList.remove('view--active');
        contentArea.classList.remove('content-area--tool-page');
        currentId = null;
        shortcutDisposer?.(); shortcutDisposer = null;
    }
    function show(tab) {
        const tool = getTool(tab.toolId);
        if (!tool || tool.enabled === false || tool.status === 'planned') return;
        if (!validId(tab.instanceId)) {
            tab.instanceId = createPageId();
            const history = tab.history[tab.historyIndex]; if (history?.toolId === tab.toolId) history.instanceId = tab.instanceId;
        }
        let entry = frames.get(tab.instanceId);
        if (!entry) {
            const frame = document.createElement('iframe'); frame.className = 'tool-page-frame';
            frame.dataset.instanceId = tab.instanceId; frame.dataset.toolId = tab.toolId;
            frame.title = tab.title; frame.hidden = true;
            const url = new URL('tool-page.html', location.href);
            url.searchParams.set('toolId', tab.toolId); url.searchParams.set('instanceId', tab.instanceId);
            frame.src = url.href;
            entry = { frame, toolId: tab.toolId, instanceId: tab.instanceId, suspended: true };
            frames.set(tab.instanceId, entry); container.append(frame);
        }
        currentId = tab.instanceId;
        shortcutDisposer?.(); shortcutDisposer = null;
        shortcut.replaceChildren();
        if (tool.surface !== 'internal') shortcutDisposer = mountShortcutBinding(shortcut, {
            label: tool.name, icon: tool.icon, compact: true, target: { kind: 'tool', toolId: tool.id }
        });
        container.classList.add('view--active'); contentArea.classList.add('content-area--tool-page');
        for (const other of frames.values()) {
            if (other === entry) continue;
            lifecycle(other, true);
            other.frame.hidden = true;
        }
        // Restore scroll only after the host and the sole active frame have layout.
        entry.frame.hidden = false;
        lifecycle(entry, powerSuspended);
    }
    async function remove(id) {
        const entry = frames.get(id); if (!entry) return;
        frames.delete(id); snapshots.delete(id); entry.frame.hidden = true;
        try { await entry.frame.contentWindow?.__DTKIT_TOOL_PAGE__?.dispose(); }
        finally {
            entry.frame.remove();
            persist().catch(error => console.error('工具页面记录保存失败', error));
        }
    }
    async function prepareCloseTab(tabId) {
        const tab = appState.tabs.find(item => item.id === tabId);
        const ids = new Set((tab?.history || []).map(item => item.instanceId));
        if (tab?.instanceId) ids.add(tab.instanceId);
        try {
            for (const id of ids) await frames.get(id)?.frame.contentWindow?.__DTKIT_TOOL_PAGE__?.flush();
            return true;
        } catch (error) {
            showToast(`页面保存失败，已保留编辑内容：${error}`, 'error'); return false;
        }
    }
    function prune(excludeTabId = null) {
        const referenced = new Set();
        for (const tab of appState.tabs) {
            if (tab.id === excludeTabId) continue;
            for (const item of tab.history) if (validId(item.instanceId) && getTool(item.toolId)?.enabled !== false) referenced.add(item.instanceId);
            if (validId(tab.instanceId) && getTool(tab.toolId)?.enabled !== false) referenced.add(tab.instanceId);
        }
        for (const id of frames.keys()) if (!referenced.has(id)) remove(id).catch(error => console.error('工具页面关闭失败', error));
        for (const id of snapshots.keys()) if (!referenced.has(id)) snapshots.delete(id);
    }
    async function persist({ prepareSleep = false } = {}) {
        let canRelease = true;
        for (const [id, entry] of frames) {
            const runtime = entry.frame.contentWindow?.__DTKIT_TOOL_PAGE__;
            if (!runtime?.ready) { canRelease = false; continue; }
            const value = prepareSleep ? await runtime.flush() : runtime.snapshot();
            snapshots.set(id, value); if (!value.canRelease) canRelease = false;
        }
        const journal = JSON.stringify({ version: 1, tabs: appState.tabs, activeTabId: appState.activeTabId, pages: [...snapshots.values()] });
        if (journal.length > MAX_JOURNAL_BYTES) throw new Error('页面草稿超过本机保存上限，已保留休眠界面');
        localStorage.setItem(WORKSPACE_KEY, journal);
        return canRelease;
    }
    const receive = event => {
        if (event.data?.type !== 'dtkit-tool-page-ready') return;
        const entry = frames.get(event.data.instanceId);
        if (!entry || event.source !== entry.frame.contentWindow) return;
        lifecycle(entry, entry.suspended);
    };
    window.addEventListener('message', receive);
    window.addEventListener('dtkit:power-state', event => {
        powerSuspended = Boolean(event.detail?.suspended);
        for (const entry of frames.values()) lifecycle(entry, entry.instanceId !== currentId || powerSuspended);
    });
    window.addEventListener('dtkit:alarm-sync-status', event => {
        for (const entry of frames.values()) entry.frame.contentWindow?.postMessage({
            type: 'dtkit-tool-page-event', name: 'dtkit:alarm-sync-status', detail: event.detail, instanceId: entry.instanceId
        }, location.origin);
    });
    window.addEventListener('pagehide', () => { persist().catch(error => console.error('工具页面保存失败', error)); });
    const host = { show, hide, prune, persist, prepareCloseTab, restore(pages) { snapshots = pages || new Map(); }, snapshotFor: id => snapshots.get(id) };
    window.__DTKIT_TOOL_WORKSPACE__ = host;
    return host;
}
