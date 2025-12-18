/**
 * DToolBox - 桌面工具箱主应用程序
 * 提供模块化、易于维护的前端结构
 */

// ============================================
// 导入工具注册中心和工具模块
// ============================================
import { getAllTools, initTool, getTool, destroyTool } from './tools/index.js';

// ============================================
// 应用状态管理
// ============================================
const appState = {
    tabs: [
        { 
            id: 'toolLibrary', 
            title: '工具库', 
            icon: 'ri-apps-2-line', 
            toolId: null, 
            active: true, 
            history: [null],
            historyIndex: 0
        }
    ],
    activeTabId: 'toolLibrary',
    currentView: 'toolLibrary',
    currentToolId: null,
    searchQuery: '',
    favorites: JSON.parse(localStorage.getItem('dtkit_favorites') || '[]')
};

// ============================================
// DOM 元素缓存
// ============================================
const DOM = {
    tabBar: document.getElementById('tabBar'),
    contentArea: document.getElementById('contentArea'),
    toolLibraryView: document.getElementById('toolLibraryView'),
    favoritesView: document.getElementById('favoritesView'),
    settingsView: document.getElementById('settingsView'),
    timestampView: document.getElementById('timestampView'),
    jsonFormatterView: document.getElementById('jsonFormatterView'),
    base64CodecView: document.getElementById('base64CodecView'),
    devToolsGrid: document.getElementById('devToolsGrid'),
    designToolsGrid: document.getElementById('designToolsGrid'),
    otherToolsGrid: document.getElementById('otherToolsGrid'),
    favoritesGrid: document.getElementById('favoritesGrid'),
    backBtn: document.getElementById('backBtn'),
    forwardBtn: document.getElementById('forwardBtn'),
    searchContainer: document.getElementById('searchContainer'),
    searchInput: document.getElementById('searchInput')
};

// ============================================
// 工具卡片管理
// ============================================
function createToolCard(tool, description = '') {
    const desc = description || tool.description || '点击查看详情';
    const isFavorited = appState.favorites.includes(tool.id);
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolId = tool.id;
    const colorClass = tool.colorClass || 'tool-card__icon--blue';
    
    card.innerHTML = `
        <button class="tool-card__favorite ${isFavorited ? 'tool-card__favorite--active' : ''}" title="${isFavorited ? '取消收藏' : '收藏'}">
            <i class="ri-star-fill"></i>
        </button>
        <div class="tool-card__header">
            <div class="tool-card__icon ${colorClass}">
                <i class="${tool.icon}"></i>
            </div>
            <i class="ri-arrow-right-up-line tool-card__arrow"></i>
        </div>
        <h3 class="tool-card__title">${tool.name}</h3>
        <p class="tool-card__description">${desc}</p>
    `;
    
    // 收藏按钮事件
    const favoriteBtn = card.querySelector('.tool-card__favorite');
    favoriteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(tool.id);
        updateFavoriteButton(favoriteBtn, tool.id);
    });
    
    // 卡片整体点击打开工具
    card.addEventListener('click', (e) => {
        if (e.target !== favoriteBtn && !e.target.closest('.tool-card__favorite')) {
            openTool(tool.id, tool.name, tool.icon);
        }
    });
    
    return card;
}

function updateFavoriteButton(btn, toolId) {
    const isFavorited = appState.favorites.includes(toolId);
    btn.classList.toggle('tool-card__favorite--active', isFavorited);
    btn.title = isFavorited ? '取消收藏' : '收藏';
    btn.innerHTML = `<i class="ri-star-${isFavorited ? 'fill' : 'line'}"></i>`;
}

function toggleFavorite(toolId) {
    const index = appState.favorites.indexOf(toolId);
    if (index > -1) {
        appState.favorites.splice(index, 1);
    } else {
        appState.favorites.push(toolId);
    }
    localStorage.setItem('dtkit_favorites', JSON.stringify(appState.favorites));
}

// ============================================
// 标签页管理
// ============================================
function addTab() {
    const newTabId = 'tab_' + Date.now();
    appState.tabs.push({
        id: newTabId,
        title: '工具库',
        icon: 'ri-apps-2-line',
        toolId: null,
        active: false,
        history: [null],
        historyIndex: 0
    });
    switchTab(newTabId);
}

function closeTab(tabId) {
    const index = appState.tabs.findIndex(t => t.id === tabId);
    if (index < 0 || appState.tabs.length === 1) return;
    
    appState.tabs.splice(index, 1);
    
    if (appState.activeTabId === tabId && appState.tabs.length > 0) {
        const newIndex = Math.max(0, index - 1);
        switchTab(appState.tabs[newIndex].id);
    } else {
        renderTabs();
    }
}

// ============================================
// 内容视图管理
// ============================================
function updateContentView() {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab) return;
    
    // 销毁当前工具（清理资源）
    if (appState.currentToolId && appState.currentToolId !== activeTab.toolId) {
        destroyTool(appState.currentToolId);
    }
    
    // 隐藏所有视图
    DOM.toolLibraryView.classList.remove('view--active');
    DOM.favoritesView.classList.remove('view--active');
    DOM.settingsView.classList.remove('view--active');
    DOM.timestampView.classList.remove('view--active');
    DOM.jsonFormatterView.classList.remove('view--active');
    DOM.base64CodecView.classList.remove('view--active');
    DOM.searchContainer.style.display = 'none';
    
    // 如果当前视图是设置页面，显示设置视图
    if (appState.currentView === 'settings') {
        DOM.settingsView.classList.add('view--active');
        appState.currentToolId = null;
    }
    // 优先判断：如果标签页有工具ID，显示对应工具（即使在收藏页面也要打开工具）
    else if (activeTab.toolId === 'timestamp-converter') {
        DOM.timestampView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    } else if (activeTab.toolId === 'json-formatter') {
        DOM.jsonFormatterView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    } else if (activeTab.toolId === 'base64-codec') {
        DOM.base64CodecView.classList.add('view--active');
        appState.currentToolId = activeTab.toolId;
        setTimeout(() => initTool(activeTab.toolId), 100);
    }
    // 次优先：根据当前视图显示对应内容
    else if (appState.currentView === 'favorites') {
        DOM.favoritesView.classList.add('view--active');
        DOM.searchContainer.style.display = 'flex';
        renderFavoritesPage();
        appState.currentToolId = null;
        updateClearFavoritesButton();
    } else {
        // 默认显示工具库
        DOM.toolLibraryView.classList.add('view--active');
        DOM.searchContainer.style.display = 'flex';
        appState.currentToolId = null;
    }
}

function openTool(toolId, toolName, toolIcon) {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab) return;
    
    activeTab.toolId = toolId;
    activeTab.title = toolName;
    activeTab.icon = toolIcon;
    
    // 添加到当前标签的历史栈
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
// 标签渲染
// ============================================
function renderTabs() {
    DOM.tabBar.innerHTML = '';
    
    appState.tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.id === appState.activeTabId ? 'tab--active' : ''}`;
        
        const label = document.createElement('div');
        label.className = 'tab__label';
        label.innerHTML = `
            <i class="${tab.icon}"></i>
            <span>${tab.title}</span>
        `;
        
        label.addEventListener('click', () => switchTab(tab.id));
        tabEl.appendChild(label);
        
        // 总是显示关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab__close';
        closeBtn.innerHTML = '<i class="ri-close-line"></i>';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(tab.id);
        });
        closeBtn.style.display = appState.tabs.length > 1 ? 'flex' : 'none';
        tabEl.appendChild(closeBtn);
        
        // 中键点击关闭标签（类似浏览器）
        tabEl.addEventListener('mouseup', (e) => {
            if (e.button === 1 && appState.tabs.length > 1) {
                e.preventDefault();
                closeTab(tab.id);
            }
        });
        
        DOM.tabBar.appendChild(tabEl);
    });
}

function switchTab(tabId) {
    appState.activeTabId = tabId;
    const tab = appState.tabs.find(t => t.id === tabId);
    if (tab) {
        appState.currentView = tab.toolId ? tab.toolId : 'toolLibrary';
    }
    renderTabs();
    updateContentView();
    updateBackForwardButtons();
}

// ============================================
// 收藏页面
// ============================================
function renderFavoritesPage() {
    const grid = DOM.favoritesGrid;
    grid.innerHTML = '';
    
    if (appState.favorites.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>还未收藏任何工具</p></div>';
        return;
    }
    
    const allTools = getAllTools();
    appState.favorites.forEach(favId => {
        const tool = allTools.find(t => t.id === favId);
        if (tool) {
            grid.appendChild(createToolCard(tool));
        }
    });
}

function updateClearFavoritesButton() {
    const btn = document.getElementById('clearFavoritesBtn');
    if (btn) {
        btn.style.display = appState.favorites.length === 0 ? 'none' : 'flex';
    }
}

// ============================================
// 后退/前进
// ============================================
function updateBackForwardButtons() {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab) return;
    
    DOM.backBtn.disabled = activeTab.historyIndex <= 0;
    DOM.forwardBtn.disabled = activeTab.historyIndex >= activeTab.history.length - 1;
}

function goBack() {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab || activeTab.historyIndex <= 0) return;
    
    activeTab.historyIndex--;
    const toolId = activeTab.history[activeTab.historyIndex];
    
    if (toolId === null) {
        appState.currentView = 'toolLibrary';
        activeTab.toolId = null;
    } else {
        const tool = getTool(toolId);
        if (tool) {
            activeTab.toolId = toolId;
            appState.currentView = toolId;
        }
    }
    
    renderTabs();
    updateContentView();
    updateBackForwardButtons();
}

function goForward() {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
    
    activeTab.historyIndex++;
    const toolId = activeTab.history[activeTab.historyIndex];
    
    if (toolId === null) {
        appState.currentView = 'toolLibrary';
        activeTab.toolId = null;
    } else {
        const tool = getTool(toolId);
        if (tool) {
            activeTab.toolId = toolId;
            appState.currentView = toolId;
        }
    }
    
    renderTabs();
    updateContentView();
    updateBackForwardButtons();
}

// ============================================
// 工具库渲染
// ============================================
function renderToolLibrary() {
    const allTools = getAllTools();
    console.log('[renderToolLibrary] 找到工具数量:', allTools.length, '工具列表:', allTools);
    
    // 按分类分组
    const devTools = allTools.filter(t => t.category === 'dev');
    const designTools = allTools.filter(t => t.category === 'design');
    const otherTools = allTools.filter(t => t.category === 'other');
    
    console.log(`[renderToolLibrary] 分类: dev=${devTools.length}, design=${designTools.length}, other=${otherTools.length}`);
    
    // 渲染开发工具
    DOM.devToolsGrid.innerHTML = '';
    devTools.forEach(tool => {
        DOM.devToolsGrid.appendChild(createToolCard(tool));
    });
    
    // 渲染设计工具
    DOM.designToolsGrid.innerHTML = '';
    designTools.forEach(tool => {
        DOM.designToolsGrid.appendChild(createToolCard(tool));
    });
    
    // 渲染其他工具
    DOM.otherToolsGrid.innerHTML = '';
    otherTools.forEach(tool => {
        DOM.otherToolsGrid.appendChild(createToolCard(tool));
    });
}

// ============================================
// 搜索功能
// ============================================
function handleSearch(query) {
    appState.searchQuery = query.toLowerCase();
    
    const allTools = getAllTools();
    
    if (!appState.searchQuery) {
        renderToolLibrary();
        return;
    }
    
    const filtered = allTools.filter(tool =>
        tool.name.toLowerCase().includes(appState.searchQuery) ||
        tool.description?.toLowerCase().includes(appState.searchQuery)
    );
    
    // 清空所有分类
    DOM.devToolsGrid.innerHTML = '';
    DOM.designToolsGrid.innerHTML = '';
    DOM.otherToolsGrid.innerHTML = '';
    DOM.favoritesGrid.innerHTML = '';
    
    // 在第一个分类中显示搜索结果
    if (DOM.devToolsGrid.parentElement?.style.display !== 'none') {
        filtered.forEach(tool => {
            DOM.devToolsGrid.appendChild(createToolCard(tool));
        });
    }
}

// ============================================
// 事件监听初始化
// ============================================
function initializeEventListeners() {
    // 导航按钮
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const view = e.currentTarget.dataset.view;
            
            if (view === 'toolLibrary') {
                appState.currentView = 'toolLibrary';
            } else if (view === 'favorites') {
                appState.currentView = 'favorites';
            } else if (view === 'history') {
                alert('历史功能即将推出');
                return;
            } else if (view === 'settings') {
                appState.currentView = 'settings';
            }
            
            renderTabs();
            updateContentView();
        });
    });
    
    // 后退前进
    DOM.backBtn.addEventListener('click', goBack);
    DOM.forwardBtn.addEventListener('click', goForward);
    
    // 搜索
    DOM.searchInput.addEventListener('input', (e) => {
        handleSearch(e.target.value);
    });
    
    // 新增标签页
    const addTabBtn = document.getElementById('addTabBtn');
    if (addTabBtn) {
        addTabBtn.addEventListener('click', () => {
            addTab();
        });
    }
    
    // 清空收藏
    document.getElementById('clearFavoritesBtn')?.addEventListener('click', () => {
        if (confirm('确定要清空所有收藏吗？')) {
            appState.favorites = [];
            localStorage.setItem('dtkit_favorites', JSON.stringify(appState.favorites));
            renderFavoritesPage();
            updateClearFavoritesButton();
            renderToolLibrary();
        }
    });
}

// ============================================
// 初始化应用
// ============================================
function initializeApp() {
    renderToolLibrary();
    renderTabs();
    updateBackForwardButtons();
    initializeEventListeners();
    updateClearFavoritesButton();
}

// DOM 加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
