/**
 * DToolBox - 桌面工具箱主应用程序
 * 模块化架构入口文件
 */
import './css/tool-shortcut.css';

// ============================================
// 导入核心模块
// ============================================
import appState, { getActiveTab, syncManagedStorageLayout } from './core/state.js';
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
    initTool,
    loadTool,
    getTool,
    destroyTool,
    hasToolTemplate,
    renderToolView,
    showDynamicContainer,
    hideDynamicContainer
} from './tools/index.js';

// ============================================
// 导入组件
// ============================================
import { addTab, closeTab, switchTab, renderTabs, setTabCallbacks } from './components/tabs.js';
import { updateBackForwardButtons, goBack, goForward, initNavigationListeners, setNavigationCallbacks } from './components/navigation.js';

// ============================================
// 导入视图
// ============================================
import { renderToolLibrary, handleSearch, initSearchListener, setToolLibraryCallbacks } from './views/toolLibrary.js';
import { renderFavoritesPage, updateClearFavoritesButton, initClearFavoritesListener, setFavoritesCallbacks } from './views/favorites.js';
import { loadViewAssets } from './views/lazyAssets.js';

// ============================================
// 内容视图管理
// ============================================

let pendingToolInitFrame = null;
const toolOpenRequests = new Map();
let viewRenderRequest = 0;

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
        if (activeTab.toolId === 'settings') {
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

    if (pendingToolInitFrame !== null) {
        cancelAnimationFrame(pendingToolInitFrame);
        pendingToolInitFrame = null;
    }
    
    // 销毁当前工具（清理资源）
    if (appState.currentToolId && appState.currentToolId !== activeTab.toolId) {
        destroyTool(appState.currentToolId);
    }
    
    // 隐藏所有视图
    DOM.toolLibraryView?.classList.remove('view--active');
    DOM.favoritesView?.classList.remove('view--active');
    DOM.settingsView?.classList.remove('view--active');
    
    // 默认隐藏导航栏
    if (DOM.navbar) DOM.navbar.style.display = 'none';
    
    // 隐藏动态工具容器
    hideDynamicContainer();
    
    // 判断显示哪个视图
    if (activeTab.toolId === 'settings') {
        appState.currentToolId = null;
        appState.currentView = 'settings';
        showSettingsView(requestId);
    }
    else if (activeTab.toolId) {
        const tool = getTool(activeTab.toolId);
        if (tool) {
            // 工具页面也显示导航栏（后退/前进按钮）
            if (DOM.navbar) DOM.navbar.style.display = 'flex';
            
            if (hasToolTemplate(activeTab.toolId)) {
                renderToolView(activeTab.toolId);
                showDynamicContainer();
            }
            appState.currentToolId = activeTab.toolId;
            const toolIdToInitialize = activeTab.toolId;
            pendingToolInitFrame = requestAnimationFrame(() => {
                pendingToolInitFrame = null;
                const latestTab = getActiveTab();
                if (latestTab?.toolId === toolIdToInitialize && appState.currentToolId === toolIdToInitialize) {
                    initTool(toolIdToInitialize);
                }
            });
        }
    }
    else if (appState.currentView === 'settings') {
        appState.currentToolId = null;
        showSettingsView(requestId);
    }
    else if (appState.currentView === 'favorites') {
        DOM.favoritesView?.classList.add('view--active');
        if (DOM.navbar) DOM.navbar.style.display = 'flex';
        renderFavoritesPage();
        appState.currentToolId = null;
        updateClearFavoritesButton();
    } else {
        DOM.toolLibraryView?.classList.add('view--active');
        if (DOM.navbar) DOM.navbar.style.display = 'flex';
        appState.currentToolId = null;
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
    if (requestedTool?.status === 'planned') {
        showToast(`${requestedTool.name}正在开发中，敬请期待`, 'info');
        return;
    }

    // 检查是否已有标签打开了该工具
    let existingTab = appState.tabs.find(t => t.toolId === toolId);
    
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }
    
    const targetTabId = appState.activeTabId;
    const requestToken = Symbol(toolId);
    toolOpenRequests.set(targetTabId, requestToken);

    try {
        await loadTool(toolId);
    } catch (error) {
        if (toolOpenRequests.get(targetTabId) !== requestToken) return;
        toolOpenRequests.delete(targetTabId);
        console.error(`[DtKit] 工具加载失败: ${toolId}`, error);
        showToast(`工具加载失败：${toolName}`, 'error');
        return;
    }

    if (toolOpenRequests.get(targetTabId) !== requestToken) return;
    toolOpenRequests.delete(targetTabId);

    // 加载期间可能发生了第二次打开请求。
    existingTab = appState.tabs.find(t => t.toolId === toolId);
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }

    // 将结果写回发起请求时的标签，避免异步加载期间切换标签导致串页。
    const targetTab = appState.tabs.find(tab => tab.id === targetTabId);
    if (!targetTab) return;

    const loadedTool = getTool(toolId);
    
    targetTab.toolId = toolId;
    targetTab.title = loadedTool?.name || toolName;
    targetTab.icon = loadedTool?.icon || toolIcon;
    targetTab.badge = getTabBadgeByTool(toolId);
    
    // 添加到历史栈（保存 toolId 和 viewType）
    const historyIndex = targetTab.historyIndex + 1;
    targetTab.history = targetTab.history.slice(0, historyIndex);
    targetTab.history.push({ toolId: toolId, viewType: targetTab.viewType });
    targetTab.historyIndex = targetTab.history.length - 1;
    
    appState.currentView = toolId;
    renderTabs();
    if (appState.activeTabId === targetTabId) {
        updateContentView();
        updateBackForwardButtons();
    }
}

// ============================================
// 导航按钮事件
// ============================================
function initNavButtonListeners() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const view = e.currentTarget.dataset.view;
            
            // 更新导航按钮激活状态
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
            e.currentTarget.classList.add('nav-btn--active');
            
            const activeTab = getActiveTab();
            
            if (view === 'toolLibrary') {
                appState.currentView = 'toolLibrary';
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.viewType = 'toolLibrary';
                    activeTab.title = '工具库';
                    activeTab.icon = 'ri-apps-2-line';
                    activeTab.badge = getTabBadgeByView('toolLibrary');
                }
            } else if (view === 'favorites') {
                appState.currentView = 'favorites';
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.viewType = 'favorites';
                    activeTab.title = '收藏';
                    activeTab.icon = 'ri-star-line';
                    activeTab.badge = getTabBadgeByView('favorites');
                }
            } else if (view === 'settings') {
                const settingsTab = appState.tabs.find(t => t.toolId === 'settings');
                
                if (settingsTab) {
                    switchTab(settingsTab.id);
                } else {
                    const newTabId = 'tab_' + Date.now();
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
        onUpdateBackForwardButtons: updateBackForwardButtons
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
