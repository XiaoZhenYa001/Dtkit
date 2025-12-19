/**
 * DToolBox - 桌面工具箱主应用程序
 * 提供模块化、易于维护的前端结构
 */

// ============================================
// 导入工具注册中心和工具模块
// ============================================
import { 
    getAllTools, 
    initTool, 
    getTool, 
    destroyTool,
    hasToolTemplate,
    renderToolView,
    clearDynamicContainer,
    showDynamicContainer,
    hideDynamicContainer,
    getDynamicContainerId
} from './tools/index.js';

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
    favorites: JSON.parse(localStorage.getItem('dtkit_favorites') || '[]'),
    // 设置项
    settings: {
        downloadPath: localStorage.getItem('dtkit_downloadPath') || 'D:\\Program Files\\DtKit\\Downloads'
    }
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
    
    // 隐藏所有视图（带空值检查）
    DOM.toolLibraryView?.classList.remove('view--active');
    DOM.favoritesView?.classList.remove('view--active');
    DOM.settingsView?.classList.remove('view--active');
    if (DOM.searchContainer) DOM.searchContainer.style.display = 'none';
    
    // 隐藏动态工具容器
    hideDynamicContainer();
    
    // 优先判断：如果标签页有工具ID，显示对应工具或设置页
    if (activeTab.toolId === 'settings') {
        // 设置页面特殊处理
        DOM.settingsView?.classList.add('view--active');
        appState.currentToolId = null;
        appState.currentView = 'settings';
    }
    else if (activeTab.toolId) {
        // 普通工具
        const tool = getTool(activeTab.toolId);
        if (tool) {
            // 检查工具是否有自己的模板
            if (hasToolTemplate(activeTab.toolId)) {
                // 使用动态渲染
                renderToolView(activeTab.toolId);
                showDynamicContainer();
            }
            appState.currentToolId = activeTab.toolId;
            setTimeout(() => initTool(activeTab.toolId), 100);
        }
    }
    // 如果当前视图是设置页面，显示设置视图（向后兼容）
    else if (appState.currentView === 'settings') {
        DOM.settingsView?.classList.add('view--active');
        appState.currentToolId = null;
    }
    // 次优先：根据当前视图显示对应内容
    else if (appState.currentView === 'favorites') {
        DOM.favoritesView?.classList.add('view--active');
        if (DOM.searchContainer) DOM.searchContainer.style.display = 'flex';
        renderFavoritesPage();
        appState.currentToolId = null;
        updateClearFavoritesButton();
    } else {
        // 默认显示工具库
        DOM.toolLibraryView?.classList.add('view--active');
        if (DOM.searchContainer) DOM.searchContainer.style.display = 'flex';
        appState.currentToolId = null;
    }
}

function openTool(toolId, toolName, toolIcon) {
    // 先检查是否已有标签打开了该工具
    const existingTab = appState.tabs.find(t => t.toolId === toolId);
    
    if (existingTab) {
        // 如果已有标签打开该工具，直接切换到那个标签
        switchTab(existingTab.id);
        return;
    }
    
    // 没有已打开的标签，则在当前标签打开
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
    if (!DOM.tabBar) return;
    
    DOM.tabBar.innerHTML = '';
    
    appState.tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.id === appState.activeTabId ? 'tab--active' : ''}`;
        tabEl.dataset.tabId = tab.id;
        
        const label = document.createElement('div');
        label.className = 'tab__label';
        label.innerHTML = `
            <i class="${tab.icon}"></i>
            <span>${tab.title}</span>
        `;
        tabEl.appendChild(label);
        
        // 关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab__close';
        closeBtn.innerHTML = '<i class="ri-close-line"></i>';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(tab.id);
        });
        closeBtn.style.display = appState.tabs.length > 1 ? 'flex' : 'none';
        tabEl.appendChild(closeBtn);
        
        // 整个标签元素点击切换（而不仅仅是 label）
        tabEl.addEventListener('click', (e) => {
            // 如果点击的是关闭按钮，不处理
            if (e.target.closest('.tab__close')) return;
            switchTab(tab.id);
        });
        
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
    if (!grid) return;
    
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
    
    if (DOM.backBtn) DOM.backBtn.disabled = activeTab.historyIndex <= 0;
    if (DOM.forwardBtn) DOM.forwardBtn.disabled = activeTab.historyIndex >= activeTab.history.length - 1;
}

function goBack() {
    const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
    if (!activeTab || activeTab.historyIndex <= 0) return;
    
    activeTab.historyIndex--;
    const toolId = activeTab.history[activeTab.historyIndex];
    
    if (toolId === null) {
        appState.currentView = 'toolLibrary';
        activeTab.toolId = null;
        activeTab.title = '工具库';
        activeTab.icon = 'ri-apps-2-line';
    } else {
        const tool = getTool(toolId);
        if (tool) {
            activeTab.toolId = toolId;
            activeTab.title = tool.name;
            activeTab.icon = tool.icon;
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
        activeTab.title = '工具库';
        activeTab.icon = 'ri-apps-2-line';
    } else {
        const tool = getTool(toolId);
        if (tool) {
            activeTab.toolId = toolId;
            activeTab.title = tool.name;
            activeTab.icon = tool.icon;
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
    if (DOM.devToolsGrid) {
        DOM.devToolsGrid.innerHTML = '';
        devTools.forEach(tool => {
            DOM.devToolsGrid.appendChild(createToolCard(tool));
        });
    }
    
    // 渲染设计工具
    if (DOM.designToolsGrid) {
        DOM.designToolsGrid.innerHTML = '';
        designTools.forEach(tool => {
            DOM.designToolsGrid.appendChild(createToolCard(tool));
        });
    }
    
    // 渲染其他工具
    if (DOM.otherToolsGrid) {
        DOM.otherToolsGrid.innerHTML = '';
        otherTools.forEach(tool => {
            DOM.otherToolsGrid.appendChild(createToolCard(tool));
        });
    }
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
    if (DOM.devToolsGrid) DOM.devToolsGrid.innerHTML = '';
    if (DOM.designToolsGrid) DOM.designToolsGrid.innerHTML = '';
    if (DOM.otherToolsGrid) DOM.otherToolsGrid.innerHTML = '';
    if (DOM.favoritesGrid) DOM.favoritesGrid.innerHTML = '';
    
    // 在第一个分类中显示搜索结果
    if (DOM.devToolsGrid && DOM.devToolsGrid.parentElement?.style.display !== 'none') {
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
            
            // 更新导航按钮的激活状态
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('nav-btn--active'));
            e.currentTarget.classList.add('nav-btn--active');
            
            // 获取当前活动标签
            const activeTab = appState.tabs.find(t => t.id === appState.activeTabId);
            
            if (view === 'toolLibrary') {
                appState.currentView = 'toolLibrary';
                // 清除当前标签的工具ID，返回工具库
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.title = '工具库';
                    activeTab.icon = 'ri-apps-2-line';
                }
            } else if (view === 'favorites') {
                appState.currentView = 'favorites';
                // 清除当前标签的工具ID，显示收藏页
                if (activeTab) {
                    activeTab.toolId = null;
                    activeTab.title = '收藏';
                    activeTab.icon = 'ri-star-line';
                }
            } else if (view === 'history') {
                alert('历史功能即将推出');
                return;
            } else if (view === 'settings') {
                // 检查是否已有设置标签
                const settingsTab = appState.tabs.find(t => t.toolId === 'settings');
                
                if (settingsTab) {
                    // 如果已有设置标签，切换到该标签
                    switchTab(settingsTab.id);
                } else {
                    // 否则在新标签中打开设置
                    const newTabId = 'tab_' + Date.now();
                    appState.tabs.push({
                        id: newTabId,
                        title: '设置',
                        icon: 'ri-settings-3-line',
                        toolId: 'settings',
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
    
    // 后退前进
    if (DOM.backBtn) DOM.backBtn.addEventListener('click', goBack);
    if (DOM.forwardBtn) DOM.forwardBtn.addEventListener('click', goForward);
    
    // 搜索
    if (DOM.searchInput) {
        DOM.searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
    }
    
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
    
    // 下载路径相关事件
    initDownloadPathSettings();
}

// ============================================
// 下载路径设置
// ============================================
function initDownloadPathSettings() {
    const downloadPathInput = document.getElementById('downloadPathInput');
    const changeDownloadPathBtn = document.getElementById('changeDownloadPathBtn');
    const browseDownloadPathBtn = document.getElementById('browseDownloadPathBtn');
    
    // 初始化输入框显示当前路径
    if (downloadPathInput) {
        downloadPathInput.value = appState.settings.downloadPath;
    }
    
    // 点击"更改目录"按钮，保存输入框中的路径
    if (changeDownloadPathBtn) {
        changeDownloadPathBtn.addEventListener('click', () => {
            const newPath = downloadPathInput?.value?.trim();
            if (newPath) {
                saveDownloadPath(newPath);
                showToast('下载路径已更新');
            } else {
                showToast('请输入有效的路径', 'error');
            }
        });
    }
    
    // 点击文件夹图标，打开文件夹选择对话框
    if (browseDownloadPathBtn) {
        browseDownloadPathBtn.addEventListener('click', async () => {
            await selectDownloadFolder();
        });
    }
}

// 保存下载路径
function saveDownloadPath(path) {
    appState.settings.downloadPath = path;
    localStorage.setItem('dtkit_downloadPath', path);
    
    // 更新输入框显示
    const downloadPathInput = document.getElementById('downloadPathInput');
    if (downloadPathInput) {
        downloadPathInput.value = path;
    }
}

// 获取当前下载路径（供其他工具使用）
function getDownloadPath() {
    return appState.settings.downloadPath;
}

// 使用 Tauri dialog API 选择文件夹
async function selectDownloadFolder() {
    try {
        // 检查是否在 Tauri 环境中
        if (window.__TAURI__) {
            const { open } = window.__TAURI__.dialog;
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择下载文件夹',
                defaultPath: appState.settings.downloadPath
            });
            
            if (selected) {
                saveDownloadPath(selected);
                showToast('下载路径已更新');
            }
        } else {
            // 非 Tauri 环境（如浏览器中测试），提示用户手动输入
            showToast('请在输入框中手动输入路径', 'info');
        }
    } catch (error) {
        console.error('选择文件夹失败:', error);
        showToast('选择文件夹失败: ' + error.message, 'error');
    }
}

// 简单的 Toast 提示（如果还没有的话）
function showToast(message, type = 'success') {
    // 移除已存在的 toast
    const existingToast = document.querySelector('.dtkit-toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = `dtkit-toast dtkit-toast--${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        background: ${type === 'error' ? '#ef4444' : type === 'info' ? '#3b82f6' : '#10b981'};
        color: white;
        border-radius: 8px;
        font-size: 14px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: toastIn 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 导出 getDownloadPath 供其他模块使用
window.getDownloadPath = getDownloadPath;

// ============================================
// 快捷键绑定管理
// ============================================
const shortcutManager = {
    currentRecording: null, // 当前正在录入的元素
    shortcuts: {}, // 存储所有快捷键配置
    
    // 初始化
    init() {
        // 从 localStorage 加载保存的快捷键配置
        const saved = localStorage.getItem('dtkit_shortcuts');
        if (saved) {
            this.shortcuts = JSON.parse(saved);
        }
        
        // 初始化快捷键显示
        this.initShortcutItems();
        
        // 全局键盘监听
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        
        // 点击其他地方取消录入
        document.addEventListener('click', (e) => {
            if (this.currentRecording && !e.target.closest('.settings-shortcut-item')) {
                this.cancelRecording();
            }
        });
    },
    
    // 初始化快捷键项目
    initShortcutItems() {
        const container = document.getElementById('shortcutBindings');
        if (!container) return;
        
        const items = container.querySelectorAll('.settings-shortcut-item');
        items.forEach(item => {
            const shortcutId = item.dataset.shortcutId;
            const defaultValue = item.dataset.default;
            
            // 如果有保存的配置，使用保存的；否则使用默认值
            if (!this.shortcuts[shortcutId]) {
                this.shortcuts[shortcutId] = defaultValue;
            }
            
            // 更新显示
            this.updateShortcutDisplay(item, this.shortcuts[shortcutId]);
            
            // 双击进入录入状态
            item.addEventListener('dblclick', () => this.startRecording(item));
        });
    },
    
    // 开始录入
    startRecording(item) {
        // 如果有其他正在录入的，先取消
        if (this.currentRecording) {
            this.cancelRecording();
        }
        
        this.currentRecording = item;
        item.classList.add('recording');
        
        const keysContainer = item.querySelector('.settings-shortcut-keys');
        keysContainer.innerHTML = '<span class="settings-key" style="min-width: 120px; color: var(--color-primary);">按下新快捷键...</span>';
    },
    
    // 取消录入
    cancelRecording() {
        if (!this.currentRecording) return;
        
        const item = this.currentRecording;
        const shortcutId = item.dataset.shortcutId;
        
        item.classList.remove('recording');
        this.updateShortcutDisplay(item, this.shortcuts[shortcutId]);
        this.currentRecording = null;
    },
    
    // 处理键盘按下
    handleKeyDown(e) {
        if (!this.currentRecording) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        // 如果只按了修饰键，等待其他键
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
            return;
        }
        
        // ESC 取消录入
        if (e.key === 'Escape') {
            this.cancelRecording();
            return;
        }
        
        // 构建快捷键字符串
        const keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.shiftKey) keys.push('Shift');
        if (e.altKey) keys.push('Alt');
        if (e.metaKey) keys.push('Win');
        
        // 获取按键名称
        let keyName = e.key;
        
        // 特殊键名映射
        const keyNameMap = {
            ' ': 'Space',
            'ArrowUp': '↑',
            'ArrowDown': '↓',
            'ArrowLeft': '←',
            'ArrowRight': '→',
            'Backspace': 'Backspace',
            'Delete': 'Delete',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PageUp',
            'PageDown': 'PageDown',
            'Insert': 'Insert'
        };
        
        if (keyNameMap[keyName]) {
            keyName = keyNameMap[keyName];
        } else if (keyName.length === 1) {
            keyName = keyName.toUpperCase();
        }
        
        keys.push(keyName);
        
        const shortcutString = keys.join('+');
        
        // 保存快捷键
        const item = this.currentRecording;
        const shortcutId = item.dataset.shortcutId;
        
        // 检查是否与其他快捷键冲突
        const conflict = Object.entries(this.shortcuts).find(
            ([id, value]) => id !== shortcutId && value === shortcutString
        );
        
        if (conflict) {
            showToast(`快捷键 ${shortcutString} 已被"${this.getShortcutLabel(conflict[0])}"使用`, 'error');
            return;
        }
        
        this.shortcuts[shortcutId] = shortcutString;
        this.saveShortcuts();
        
        // 更新显示
        item.classList.remove('recording');
        this.updateShortcutDisplay(item, shortcutString);
        this.currentRecording = null;
        
        showToast(`快捷键已更新为 ${shortcutString}`);
    },
    
    // 获取快捷键标签名称
    getShortcutLabel(shortcutId) {
        const item = document.querySelector(`[data-shortcut-id="${shortcutId}"]`);
        if (item) {
            const label = item.querySelector('.settings-shortcut-label');
            return label ? label.textContent : shortcutId;
        }
        return shortcutId;
    },
    
    // 更新快捷键显示
    updateShortcutDisplay(item, shortcutString) {
        const keysContainer = item.querySelector('.settings-shortcut-keys');
        if (!keysContainer || !shortcutString) return;
        
        const keys = shortcutString.split('+');
        const html = keys.map((key, index) => {
            const keyHtml = `<span class="settings-key">${key}</span>`;
            if (index < keys.length - 1) {
                return keyHtml + ' <span class="settings-key-plus">+</span> ';
            }
            return keyHtml;
        }).join('');
        
        keysContainer.innerHTML = html;
    },
    
    // 保存快捷键到 localStorage
    saveShortcuts() {
        localStorage.setItem('dtkit_shortcuts', JSON.stringify(this.shortcuts));
    },
    
    // 获取某个快捷键的值
    getShortcut(shortcutId) {
        return this.shortcuts[shortcutId];
    }
};

// 导出快捷键管理器
window.shortcutManager = shortcutManager;

// ============================================
// 初始化应用
// ============================================
function initializeApp() {
    renderToolLibrary();
    renderTabs();
    updateBackForwardButtons();
    initializeEventListeners();
    updateClearFavoritesButton();
    
    // 初始化快捷键管理器
    shortcutManager.init();
}

// DOM 加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
