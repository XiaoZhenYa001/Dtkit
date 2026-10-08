/**
 * DToolBox - 桌面工具箱主应用程序
 * 模块化架构入口文件
 */
import './css/tool-shortcut.css';

// ============================================
// 导入核心模块
// ============================================
import appState, { createPageId, getActiveTab, syncManagedStorageLayout } from './core/state.js';
import { createToolPageHost, readToolWorkspace } from './core/toolPageHost.js';
import DOM, { initDOM } from './core/dom.js';
import { showToast } from './core/utils.js';
import { bootstrapDesktopOrganizer } from './core/desktopOrganizer.js';
import { initializeAlarmService } from './core/alarmService.js';
import { initializePowerLifecycle } from './core/powerLifecycle.js';
import { initializeMinimizeMode } from './core/minimizeMode.js';

// ============================================
// 导入工具注册中心
// ============================================
import {
    getAllTools,
    getTool,
    applyDisabledTools
} from './tools/index.js';

// ============================================
// 导入组件
// ============================================
import { addTab, closeTab, switchTab, renderTabs, setTabCallbacks } from './components/tabs.js';
import {
    captureCurrentScrollPosition,
    getCurrentHistoryScrollTop,
    updateBackForwardButtons,
    initNavigationListeners,
    recordHistoryEntry,
    setNavigationCallbacks
} from './components/navigation.js';

// ============================================
// 导入视图
// ============================================
import { renderToolLibrary, handleSearch, initSearchListener, setToolLibraryCallbacks } from './views/toolLibrary.js';
import { renderFavoritesPage, updateClearFavoritesButton, initClearFavoritesListener, setFavoritesCallbacks } from './views/favorites.js';
import { loadViewAssets } from './views/lazyAssets.js';

// ============================================
// 内容视图管理
// ============================================

let pendingScrollRestoreFrame = null;
let viewRenderRequest = 0;
let toolPageHost = null;

function restoreCurrentScrollPosition(requestId) {
    if (pendingScrollRestoreFrame !== null) cancelAnimationFrame(pendingScrollRestoreFrame);
    const scrollTop = getCurrentHistoryScrollTop();
    pendingScrollRestoreFrame = requestAnimationFrame(() => {
        pendingScrollRestoreFrame = null;
        if (requestId !== viewRenderRequest || !DOM.contentArea) return;
        const previousScrollBehavior = DOM.contentArea.style.scrollBehavior;
        DOM.contentArea.style.scrollBehavior = 'auto';
        DOM.contentArea.scrollTop = scrollTop;
        DOM.contentArea.style.scrollBehavior = previousScrollBehavior;
    });
}

function handleViewLoadError(viewName, requestId, error) {
    if (requestId !== viewRenderRequest) return;
    console.error(`[DtKit] Failed to load ${viewName} view assets`, error);
    showToast(`${viewName}页面加载失败，请重试`, 'error');
}

function showSettingsView(requestId) {
    loadViewAssets('settings')
        .then(settingsView => settingsView.initSettings())
        .then(() => {
            if (requestId !== viewRenderRequest) return;
            DOM.settingsView?.classList.add('view--active');
            restoreCurrentScrollPosition(requestId);
        })
        .catch(error => handleViewLoadError('设置', requestId, error));
}

/**
 * 同步左侧导航按钮的激活状态
 */
function syncNavButtonState() {
    const activeTab = getActiveTab();
    let activeView = 'toolLibrary';
    
    if (activeTab) {
        if (activeTab.toolId === 'password-vault') {
            activeView = 'passwords';
        } else if (activeTab.toolId === 'settings') {
            activeView = 'settings';
        } else if (activeTab.toolId) {
            // 工具视图，根据 viewType 保持对应导航按钮高亮
            activeView = activeTab.viewType || 'toolLibrary';
        } else {
            activeView = activeTab.viewType || 'toolLibrary';
        }
    }
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('nav-btn--active');
        if (btn.dataset.view === activeView) {
            btn.classList.add('nav-btn--active');
        }
    });
}

function updateContentView() {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    const requestId = ++viewRenderRequest;

    toolPageHost?.hide();
    toolPageHost?.prune();
    
    // 隐藏所有视图
    DOM.toolLibraryView?.classList.remove('view--active');
    DOM.favoritesView?.classList.remove('view--active');
    DOM.settingsView?.classList.remove('view--active');
    
    // 历史导航始终位于顶部，工具筛选仅在工具库中显示。
    if (DOM.searchContainer) DOM.searchContainer.hidden = true;
    
    // 判断显示哪个视图
    if (activeTab.toolId === 'settings') {
        appState.currentToolId = null;
        appState.currentView = 'settings';
        showSettingsView(requestId);
    }
    else if (activeTab.toolId) {
        const tool = getTool(activeTab.toolId);
        if (tool && tool.enabled !== false && tool.status !== 'planned') {
            toolPageHost?.show(activeTab);
            appState.currentToolId = activeTab.toolId;
        } else {
            DOM.toolLibraryView?.classList.add('view--active');
            if (DOM.searchContainer) DOM.searchContainer.hidden = false;
            appState.currentToolId = null;
        }
    }
    else if (appState.currentView === 'settings') {
        appState.currentToolId = null;
        showSettingsView(requestId);
    }
    else if (appState.currentView === 'favorites') {
        DOM.favoritesView?.classList.add('view--active');
        renderFavoritesPage();
        appState.currentToolId = null;
        updateClearFavoritesButton();
    } else {
        DOM.toolLibraryView?.classList.add('view--active');
        if (DOM.searchContainer) DOM.searchContainer.hidden = false;
        appState.currentToolId = null;
    }

    if (activeTab.toolId !== 'settings' && appState.currentView !== 'settings') {
        restoreCurrentScrollPosition(requestId);
    }
    
    // 同步左侧导航按钮状态
    syncNavButtonState();
}

// ============================================
// 打开工具
// ============================================
function getTabBadgeByView(view) {
    const badgeMap = {
        toolLibrary: '工作台',
        favorites: '收藏夹',
        settings: '设置'
    };

    return badgeMap[view] || '界面';
}

function getTabBadgeByTool(toolId) {
    const tool = getTool(toolId);
    const badgeMap = {
        dev: '开发',
        design: '设计',
        utility: '日常',
        other: '其他'
    };

    return badgeMap[tool?.category] || '工具';
}

async function openTool(toolId, toolName, toolIcon) {
    const requestedTool = getTool(toolId);
    if (!requestedTool || requestedTool.enabled === false) return;
    if (requestedTool?.status === 'planned') {
        showToast(`${requestedTool.name}正在开发中，敬请期待`, 'info');
        return;
    }

    captureCurrentScrollPosition();

    const targetTab = getActiveTab();
    if (!targetTab) return;
    const ordinal = appState.tabs.filter(tab => tab.toolId === toolId).length + 1;
    targetTab.toolId = toolId;
    targetTab.instanceId = createPageId();
    targetTab.title = `${requestedTool.name || toolName}${ordinal > 1 ? ` · ${ordinal}` : ''}`;
    targetTab.icon = requestedTool.icon || toolIcon;
    targetTab.badge = getTabBadgeByTool(toolId);
    
    // 添加到历史栈（保存 toolId 和 viewType）
    recordHistoryEntry(targetTab, { toolId, viewType: targetTab.viewType, instanceId: targetTab.instanceId });
    
    appState.currentView = toolId;
    renderTabs();
    updateContentView();
    updateBackForwardButtons();
}

// ============================================
// 导航按钮事件
// ============================================
function initNavButtonListeners() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const view = e.currentTarget.dataset.view;
            const toolId = e.currentTarget.dataset.tool;

            if (toolId) {
                const tool = getTool(toolId);
                openTool(toolId, tool?.name || '密码', tool?.icon || 'ri-lock-2-line');
                return;
            }

            captureCurrentScrollPosition();
            
            // 更新导航按钮激活状态
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
            e.currentTarget.classList.add('nav-btn--active');
            
            const activeTab = getActiveTab();
            
            if (view === 'toolLibrary') {
                appState.currentView = 'toolLibrary';
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.instanceId = null;
                    activeTab.viewType = 'toolLibrary';
                    activeTab.title = '工具库';
                    activeTab.icon = 'ri-apps-2-line';
                    activeTab.badge = getTabBadgeByView('toolLibrary');
                    recordHistoryEntry(activeTab, { toolId: null, viewType: 'toolLibrary' });
                }
            } else if (view === 'favorites') {
                appState.currentView = 'favorites';
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.instanceId = null;
                    activeTab.viewType = 'favorites';
                    activeTab.title = '收藏';
                    activeTab.icon = 'ri-star-line';
                    activeTab.badge = getTabBadgeByView('favorites');
                    recordHistoryEntry(activeTab, { toolId: null, viewType: 'favorites' });
                }
            } else if (view === 'settings') {
                const settingsTab = appState.tabs.find(t => t.toolId === 'settings');
                
                if (settingsTab) {
                    switchTab(settingsTab.id);
                } else {
                    const newTabId = createPageId('tab');
                    appState.tabs.push({
                        id: newTabId,
                        title: '设置',
                        icon: 'ri-settings-3-line',
                        badge: getTabBadgeByView('settings'),
                        toolId: 'settings',
                        viewType: 'settings',
                        active: false,
                        history: [{ toolId: 'settings', viewType: 'settings' }],
                        historyIndex: 0
                    });
                    appState.currentView = 'settings';
                    switchTab(newTabId);
                }
                return;
            }
            
            renderTabs();
            updateContentView();
            updateBackForwardButtons();
        });
    });
}

// ============================================
// 新增标签页按钮
// ============================================
function initAddTabListener() {
    const addTabBtn = document.getElementById('addTabBtn');
    if (addTabBtn) {
        addTabBtn.addEventListener('click', () => addTab());
    }
}

// ============================================
// 初始化回调连接
// ============================================
function initCallbacks() {
    // 标签组件回调
    setTabCallbacks({
        onSwitchTab: switchTab,
        onUpdateContentView: updateContentView,
        onUpdateBackForwardButtons: updateBackForwardButtons,
        onBeforeCloseTab: tabId => toolPageHost?.prepareCloseTab(tabId),
        onCloseTab: tabId => toolPageHost?.prune(tabId)
    });
    
    // 导航组件回调
    setNavigationCallbacks({
        onRenderTabs: renderTabs,
        onUpdateContentView: updateContentView,
        onGetTool: getTool
    });
    
    // 工具库视图回调
    setToolLibraryCallbacks({
        onOpenTool: openTool
    });
    
    // 收藏视图回调
    setFavoritesCallbacks({
        onOpenTool: openTool,
        onRenderToolLibrary: renderToolLibrary
    });
}

// ============================================
// 初始化应用
// ============================================
async function initializeApp() {
    try {
        await syncManagedStorageLayout();
    } catch (error) {
        console.error('[DtKit] 文件管理目录同步失败', error);
    }
    // 初始化 DOM 缓存
    initDOM();
    try {
        const disabled = await globalThis.window?.__TAURI__?.core?.invoke?.('get_tool_module_settings');
        if (Array.isArray(disabled)) applyDisabledTools(disabled);
    } catch (error) {
        console.error('[DtKit] 工具模块配置同步失败', error);
    }
    toolPageHost = createToolPageHost({ contentArea: DOM.contentArea, getTool, appState,
        onNewPage: toolId => { const tool = getTool(toolId); addTab(); openTool(toolId, tool.name, tool.icon); },
        onRename: () => {
            const tab = getActiveTab(); if (!tab) return;
            const title = window.prompt('页面名称', tab.title)?.trim().slice(0, 80);
            if (title) { tab.title = title; renderTabs(); }
        }
    });
    const workspace = readToolWorkspace(getTool);
    if (workspace) {
        appState.tabs = workspace.tabs; appState.activeTabId = workspace.activeTabId;
        const tab = getActiveTab(); appState.currentView = tab.toolId || tab.viewType;
        toolPageHost.restore(workspace.pages);
    }
    
    // 初始化模块间回调
    initCallbacks();
    
    // 渲染初始界面
    renderToolLibrary();
    renderTabs();
    updateBackForwardButtons();
    updateClearFavoritesButton();
    
    // 初始化事件监听
    initNavButtonListeners();
    initNavigationListeners();
    initSearchListener();
    initAddTabListener();
    initClearFavoritesListener();
    if (workspace) updateContentView();
    window.addEventListener('dtkit-tool-modules-changed', () => {
        renderToolLibrary();
        renderFavoritesPage();
        toolPageHost.prune();
    });
    window.addEventListener('dtkit:open-tool-new-tab', event => {
        const toolId = event.detail?.toolId;
        const tool = getTool(toolId);
        if (!tool) return;
        addTab();
        openTool(tool.id, tool.name, tool.icon);
    });
    
    // 已启用的桌面整理热区需要在设置页面尚未打开时也能工作。
    bootstrapDesktopOrganizer().catch(error => {
        console.error('[DtKit] 桌面整理启动失败', error);
    });

    // 后台提醒由 Rust 调度；前端只监听触发结果并展示。
    initializeAlarmService().catch(error => {
        console.error('[DtKit] 闹钟后台服务启动失败', error);
    });

    initializePowerLifecycle().catch(error => {
        console.error('[DtKit] 节能生命周期启动失败', error);
    });
    const listen = window.__TAURI__?.event?.listen;
    if (listen) listen('main-sleep-request', async event => {
        let ready = false;
        try { ready = await toolPageHost.persist({ prepareSleep: true }); }
        catch (error) { console.error('[DtKit] 休眠前保存页面失败', error); }
        await window.__TAURI__.core.invoke('main_sleep_ready', { token: event.payload?.token, ready });
    }).catch(error => console.error('[DtKit] 页面休眠握手不可用', error));

    initializeMinimizeMode().catch(error => {
        console.error('[DtKit] 最小化策略同步失败', error);
    });
}

// DOM 加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
