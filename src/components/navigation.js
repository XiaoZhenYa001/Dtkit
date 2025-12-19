/**
 * 历史导航组件 - 后退/前进功能
 */
import appState, { getActiveTab } from '../core/state.js';
import DOM from '../core/dom.js';

// 回调函数引用
let onRenderTabs = null;
let onUpdateContentView = null;
let onGetTool = null;

/**
 * 注入回调函数
 */
export function setNavigationCallbacks(callbacks) {
    onRenderTabs = callbacks.onRenderTabs;
    onUpdateContentView = callbacks.onUpdateContentView;
    onGetTool = callbacks.onGetTool;
}

/**
 * 更新后退/前进按钮状态
 */
export function updateBackForwardButtons() {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    
    if (DOM.backBtn) DOM.backBtn.disabled = activeTab.historyIndex <= 0;
    if (DOM.forwardBtn) DOM.forwardBtn.disabled = activeTab.historyIndex >= activeTab.history.length - 1;
}

/**
 * 后退
 */
export function goBack() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex <= 0) return;
    
    activeTab.historyIndex--;
    const toolId = activeTab.history[activeTab.historyIndex];
    
    if (toolId === null) {
        appState.currentView = 'toolLibrary';
        activeTab.toolId = null;
        activeTab.title = '工具库';
        activeTab.icon = 'ri-apps-2-line';
    } else {
        const tool = onGetTool ? onGetTool(toolId) : null;
        if (tool) {
            activeTab.toolId = toolId;
            activeTab.title = tool.name;
            activeTab.icon = tool.icon;
            appState.currentView = toolId;
        }
    }
    
    if (onRenderTabs) onRenderTabs();
    if (onUpdateContentView) onUpdateContentView();
    updateBackForwardButtons();
}

/**
 * 前进
 */
export function goForward() {
    const activeTab = getActiveTab();
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    
    activeTab.historyIndex++;
    const toolId = activeTab.history[activeTab.historyIndex];
    
    if (toolId === null) {
        appState.currentView = 'toolLibrary';
        activeTab.toolId = null;
        activeTab.title = '工具库';
        activeTab.icon = 'ri-apps-2-line';
    } else {
        const tool = onGetTool ? onGetTool(toolId) : null;
        if (tool) {
            activeTab.toolId = toolId;
            activeTab.title = tool.name;
            activeTab.icon = tool.icon;
            appState.currentView = toolId;
        }
    }
    
    if (onRenderTabs) onRenderTabs();
    if (onUpdateContentView) onUpdateContentView();
    updateBackForwardButtons();
}

/**
 * 初始化导航事件监听
 */
export function initNavigationListeners() {
    if (DOM.backBtn) DOM.backBtn.addEventListener('click', goBack);
    if (DOM.forwardBtn) DOM.forwardBtn.addEventListener('click', goForward);
}
