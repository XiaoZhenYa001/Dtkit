/**
 * DOM 元素缓存
 * 统一管理所有 DOM 元素引用
 */

// DOM 元素缓存对象
const DOM = {
    // 标签栏
    tabBar: null,
    
    // 内容区域
    contentArea: null,
    
    // 视图容器
    toolLibraryView: null,
    favoritesView: null,
    settingsView: null,
    
    // 工具网格
    devToolsGrid: null,
    designToolsGrid: null,
    utilityToolsGrid: null,
    otherToolsGrid: null,
    favoritesGrid: null,
    
    // 导航按钮
    backBtn: null,
    forwardBtn: null,
    
    // 搜索
    searchContainer: null,
    searchInput: null
};

/**
 * 初始化 DOM 缓存
 * 在 DOMContentLoaded 后调用
 */
export function initDOM() {
    DOM.tabBar = document.getElementById('tabBar');
    DOM.contentArea = document.getElementById('contentArea');
    DOM.toolLibraryView = document.getElementById('toolLibraryView');
    DOM.favoritesView = document.getElementById('favoritesView');
    DOM.settingsView = document.getElementById('settingsView');
    DOM.devToolsGrid = document.getElementById('devToolsGrid');
    DOM.designToolsGrid = document.getElementById('designToolsGrid');
    DOM.utilityToolsGrid = document.getElementById('utilityToolsGrid');
    DOM.otherToolsGrid = document.getElementById('otherToolsGrid');
    DOM.favoritesGrid = document.getElementById('favoritesGrid');
    DOM.backBtn = document.getElementById('backBtn');
    DOM.forwardBtn = document.getElementById('forwardBtn');
    DOM.searchContainer = document.getElementById('searchContainer');
    DOM.searchInput = document.getElementById('searchInput');
}

export default DOM;
