/**
 * 历史导航组件 - 后退/前进功能
 */
import appState, { getActiveTab } from '../core/state.js';
import DOM from '../core/dom.js';

let onRenderTabs = null;
let onUpdateContentView = null;
let onGetTool = null;

export function setNavigationCallbacks(callbacks) {
    onRenderTabs = callbacks.onRenderTabs;
    onUpdateContentView = callbacks.onUpdateContentView;
    onGetTool = callbacks.onGetTool;
}

function getToolBadge(tool) {
    const badgeMap = {
        dev: '开发',
        design: '设计',
        utility: '日常',
        other: '其他'
    };

    return badgeMap[tool?.category] || '工具';
}

function applyViewState(activeTab, viewType) {
    const viewMap = {
        toolLibrary: {
            title: '工具库',
            icon: 'ri-apps-2-line',
            badge: '工作台'
        },
        favorites: {
            title: '收藏',
            icon: 'ri-star-line',
            badge: '收藏夹'
        },
        settings: {
            title: '设置',
            icon: 'ri-settings-3-line',
            badge: '设置'
        }
    };

    const nextView = viewMap[viewType] || viewMap.toolLibrary;
    activeTab.title = nextView.title;
    activeTab.icon = nextView.icon;
    activeTab.badge = nextView.badge;
}

export function updateBackForwardButtons() {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    if (DOM.backBtn) DOM.backBtn.disabled = !hasNavigableHistory(activeTab, -1);
    if (DOM.forwardBtn) DOM.forwardBtn.disabled = !hasNavigableHistory(activeTab, 1);
}

function normalizeHistoryItem(historyItem) {
    if (historyItem && typeof historyItem === 'object') {
        const normalized = {
            toolId: historyItem.toolId ?? null,
            viewType: historyItem.viewType || 'toolLibrary'
        };
        const scrollTop = Number(historyItem.scrollTop);
        if (Number.isFinite(scrollTop) && scrollTop >= 0) normalized.scrollTop = scrollTop;
        return normalized;
    }
    return { toolId: historyItem ?? null, viewType: 'toolLibrary' };
}

export function captureCurrentScrollPosition() {
    const activeTab = getActiveTab();
    if (!activeTab || !DOM.contentArea || activeTab.historyIndex < 0) return;
    const current = normalizeHistoryItem(activeTab.history[activeTab.historyIndex]);
    current.scrollTop = Math.max(0, DOM.contentArea.scrollTop || 0);
    activeTab.history[activeTab.historyIndex] = current;
}

export function getCurrentHistoryScrollTop() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex < 0) return 0;
    const current = normalizeHistoryItem(activeTab.history[activeTab.historyIndex]);
    return current.scrollTop || 0;
}

function isSameHistoryItem(left, right) {
    const a = normalizeHistoryItem(left);
    const b = normalizeHistoryItem(right);
    return a.toolId === b.toolId && a.viewType === b.viewType;
}

function isHistoryItemAvailable(historyItem) {
    const { toolId } = normalizeHistoryItem(historyItem);
    if (toolId === null || toolId === 'settings') return true;
    const tool = onGetTool ? onGetTool(toolId) : null;
    return Boolean(tool && tool.enabled !== false && tool.status !== 'planned');
}

function hasNavigableHistory(activeTab, direction) {
    for (
        let index = activeTab.historyIndex + direction;
        index >= 0 && index < activeTab.history.length;
        index += direction
    ) {
        if (isHistoryItemAvailable(activeTab.history[index])) return true;
    }
    return false;
}

export function recordHistoryEntry(activeTab, historyItem) {
    if (!activeTab) return false;
    const next = normalizeHistoryItem(historyItem);
    const current = activeTab.history[activeTab.historyIndex];
    if (isSameHistoryItem(current, next)) return false;

    activeTab.history = activeTab.history.slice(0, activeTab.historyIndex + 1);
    activeTab.history.push(next);
    activeTab.historyIndex = activeTab.history.length - 1;
    return true;
}

function applyHistoryItem(historyItem) {
    const activeTab = getActiveTab();
    if (!activeTab) return false;

    const { toolId, viewType } = normalizeHistoryItem(historyItem);

    if (toolId === null) {
        activeTab.viewType = viewType;
        activeTab.toolId = null;
        appState.currentView = viewType;
        applyViewState(activeTab, viewType);
        return true;
    }

    if (toolId === 'settings') {
        activeTab.viewType = 'settings';
        activeTab.toolId = 'settings';
        appState.currentView = 'settings';
        applyViewState(activeTab, 'settings');
        return true;
    }

    if (!isHistoryItemAvailable(historyItem)) return false;
    const tool = onGetTool(toolId);

    activeTab.toolId = toolId;
    activeTab.viewType = viewType;
    activeTab.title = tool.name;
    activeTab.icon = tool.icon;
    activeTab.badge = getToolBadge(tool);
    appState.currentView = toolId;
    return true;
}

function moveHistory(direction) {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    captureCurrentScrollPosition();

    let nextIndex = activeTab.historyIndex + direction;
    while (nextIndex >= 0 && nextIndex < activeTab.history.length) {
        if (applyHistoryItem(activeTab.history[nextIndex])) {
            activeTab.historyIndex = nextIndex;
            if (onRenderTabs) onRenderTabs();
            if (onUpdateContentView) onUpdateContentView();
            updateBackForwardButtons();
            return;
        }
        nextIndex += direction;
    }
}

export function goBack() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex <= 0) return;
    moveHistory(-1);
}

export function goForward() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    moveHistory(1);
}

export function initNavigationListeners() {
    if (DOM.backBtn) DOM.backBtn.addEventListener('click', goBack);
    if (DOM.forwardBtn) DOM.forwardBtn.addEventListener('click', goForward);
}
