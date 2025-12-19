/**
 * 收藏视图
 */
import appState, { clearFavorites, saveFavorites } from '../core/state.js';
import DOM from '../core/dom.js';
import { getAllTools } from '../tools/index.js';
import { createToolCard } from '../components/toolCard.js';

// 打开工具的回调
let onOpenTool = null;
let onRenderToolLibrary = null;

/**
 * 设置回调函数
 */
export function setFavoritesCallbacks(callbacks) {
    onOpenTool = callbacks.onOpenTool;
    onRenderToolLibrary = callbacks.onRenderToolLibrary;
}

/**
 * 渲染收藏页面
 */
export function renderFavoritesPage() {
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
            grid.appendChild(createToolCard(tool, onOpenTool));
        }
    });
}

/**
 * 更新清空收藏按钮状态
 */
export function updateClearFavoritesButton() {
    const btn = document.getElementById('clearFavoritesBtn');
    if (btn) {
        btn.style.display = appState.favorites.length === 0 ? 'none' : 'flex';
    }
}

/**
 * 初始化清空收藏按钮事件
 */
export function initClearFavoritesListener() {
    document.getElementById('clearFavoritesBtn')?.addEventListener('click', () => {
        if (confirm('确定要清空所有收藏吗？')) {
            clearFavorites();
            renderFavoritesPage();
            updateClearFavoritesButton();
            if (onRenderToolLibrary) onRenderToolLibrary();
        }
    });
}
