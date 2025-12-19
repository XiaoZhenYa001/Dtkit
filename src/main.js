/**
 * DToolBox - 桌面工具箱主应用程序
 * 模块化架构入口文件
 */

// ============================================
// 导入核心模块
// ============================================
import appState, { getActiveTab } from './core/state.js';
import DOM, { initDOM } from './core/dom.js';
import { showToast } from './core/utils.js';

// ============================================
// 导入工具注册中心
// ============================================
import { 
    getAllTools, 
    initTool, 
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
import { initSettings } from './views/settings.js';

// ============================================
// 内容视图管理
// ============================================

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
            // 工具视图，不高亮任何导航按钮（或保持工具库高亮）
            activeView = 'toolLibrary';
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
    
    // 销毁当前工具（清理资源）
    if (appState.currentToolId && appState.currentToolId !== activeTab.toolId) {
        destroyTool(appState.currentToolId);
    }
    
    // 隐藏所有视图
    DOM.toolLibraryView?.classList.remove('view--active');
    DOM.favoritesView?.classList.remove('view--active');
    DOM.settingsView?.classList.remove('view--active');
    if (DOM.searchContainer) DOM.searchContainer.style.display = 'none';
    
    // 隐藏动态工具容器
    hideDynamicContainer();
    
    // 判断显示哪个视图
    if (activeTab.toolId === 'settings') {
        DOM.settingsView?.classList.add('view--active');
        appState.currentToolId = null;
        appState.currentView = 'settings';
    }
    else if (activeTab.toolId) {
        const tool = getTool(activeTab.toolId);
        if (tool) {
            if (hasToolTemplate(activeTab.toolId)) {
                renderToolView(activeTab.toolId);
                showDynamicContainer();
            }
            appState.currentToolId = activeTab.toolId;
            setTimeout(() => initTool(activeTab.toolId), 100);
        }
    }
    else if (appState.currentView === 'settings') {
        DOM.settingsView?.classList.add('view--active');
        appState.currentToolId = null;
    }
    else if (appState.currentView === 'favorites') {
        DOM.favoritesView?.classList.add('view--active');
        if (DOM.searchContainer) DOM.searchContainer.style.display = 'flex';
        renderFavoritesPage();
        appState.currentToolId = null;
        updateClearFavoritesButton();
    } else {
        DOM.toolLibraryView?.classList.add('view--active');
        if (DOM.searchContainer) DOM.searchContainer.style.display = 'flex';
        appState.currentToolId = null;
    }
    
    // 同步左侧导航按钮状态
    syncNavButtonState();
}

// ============================================
// 打开工具
// ============================================
function openTool(toolId, toolName, toolIcon) {
    // 检查是否已有标签打开了该工具
    const existingTab = appState.tabs.find(t => t.toolId === toolId);
    
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }
    
    // 在当前标签打开
    const activeTab = getActiveTab();
    if (!activeTab) return;
    
    activeTab.toolId = toolId;
    activeTab.title = toolName;
    activeTab.icon = toolIcon;
    
    // 添加到历史栈
    const historyIndex = activeTab.historyIndex + 1;
    activeTab.history = activeTab.history.slice(0, historyIndex);
    activeTab.history.push(toolId);
    activeTab.historyIndex = activeTab.history.length - 1;
    
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
                }
            } else if (view === 'favorites') {
                appState.currentView = 'favorites';
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.viewType = 'favorites';
                    activeTab.title = '收藏';
                    activeTab.icon = 'ri-star-line';
                }
            } else if (view === 'history') {
                alert('历史功能即将推出');
                return;
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
                        toolId: 'settings',
                        viewType: 'settings',
                        active: false,
                        history: ['settings'],
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
function initializeApp() {
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
    
    // 初始化设置（下载路径、快捷键）
    initSettings();
}

// DOM 加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
