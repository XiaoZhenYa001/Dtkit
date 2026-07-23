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

    if (DOM.backBtn) DOM.backBtn.disabled = activeTab.historyIndex <= 0;
    if (DOM.forwardBtn) DOM.forwardBtn.disabled = activeTab.historyIndex >= activeTab.history.length - 1;
}

function applyHistoryItem(historyItem) {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    const toolId = typeof historyItem === 'object' ? historyItem.toolId : historyItem;
    const viewType = typeof historyItem === 'object' ? historyItem.viewType : 'toolLibrary';

    if (toolId === null) {
        activeTab.viewType = viewType;
        activeTab.toolId = null;
        appState.currentView = viewType;
        applyViewState(activeTab, viewType);
        return;
    }

    if (toolId === 'settings') {
        activeTab.viewType = 'settings';
        activeTab.toolId = 'settings';
        appState.currentView = 'settings';
        applyViewState(activeTab, 'settings');
        return;
    }

    const tool = onGetTool ? onGetTool(toolId) : null;
    if (!tool) return;

    activeTab.toolId = toolId;
    activeTab.title = tool.name;
    activeTab.icon = tool.icon;
    activeTab.badge = getToolBadge(tool);
    appState.currentView = toolId;
}

export function goBack() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex <= 0) return;

    activeTab.historyIndex--;
    applyHistoryItem(activeTab.history[activeTab.historyIndex]);

    if (onRenderTabs) onRenderTabs();
    if (onUpdateContentView) onUpdateContentView();
    updateBackForwardButtons();
}

export function goForward() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;

    activeTab.historyIndex++;
    applyHistoryItem(activeTab.history[activeTab.historyIndex]);

    if (onRenderTabs) onRenderTabs();
    if (onUpdateContentView) onUpdateContentView();
    updateBackForwardButtons();
}

export function initNavigationListeners() {
    if (DOM.backBtn) DOM.backBtn.addEventListener('click', goBack);
    if (DOM.forwardBtn) DOM.forwardBtn.addEventListener('click', goForward);
}
