/**
 * 应用状态管理 - 单例模式
 * 所有模块共享同一个状态对象
 */

// 创建默认初始标签
function createDefaultTab() {
    return {
        id: 'toolLibrary',
        title: '工具库',
        icon: 'ri-apps-2-line',
        toolId: null,
        viewType: 'toolLibrary', // toolLibrary | favorites | settings
        active: true,
        history: [null],
        historyIndex: 0
    };
}

// 应用状态单例
const appState = {
    tabs: [createDefaultTab()],
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
// 状态持久化方法
// ============================================

/**
 * 保存收藏列表到 localStorage
 */
export function saveFavorites() {
    localStorage.setItem('dtkit_favorites', JSON.stringify(appState.favorites));
}

/**
 * 保存下载路径到 localStorage
 */
export function saveDownloadPath(path) {
    appState.settings.downloadPath = path;
    localStorage.setItem('dtkit_downloadPath', path);
}

/**
 * 获取下载路径
 */
export function getDownloadPath() {
    return appState.settings.downloadPath;
}

/**
 * 切换收藏状态
 */
export function toggleFavorite(toolId) {
    const index = appState.favorites.indexOf(toolId);
    if (index > -1) {
        appState.favorites.splice(index, 1);
    } else {
        appState.favorites.push(toolId);
    }
    saveFavorites();
}

/**
 * 检查是否已收藏
 */
export function isFavorited(toolId) {
    return appState.favorites.includes(toolId);
}

/**
 * 清空收藏
 */
export function clearFavorites() {
    appState.favorites = [];
    saveFavorites();
}

/**
 * 获取当前活动标签
 */
export function getActiveTab() {
    return appState.tabs.find(t => t.id === appState.activeTabId);
}

/**
 * 创建新标签的默认配置
 */
export function createNewTabConfig() {
    return {
        id: 'tab_' + Date.now(),
        title: '工具库',
        icon: 'ri-apps-2-line',
        toolId: null,
        viewType: 'toolLibrary', // toolLibrary | favorites | settings
        active: false,
        history: [null],
        historyIndex: 0
    };
}

// 导出状态单例
export default appState;

// 将 getDownloadPath 挂载到 window 供其他地方使用
window.getDownloadPath = getDownloadPath;
