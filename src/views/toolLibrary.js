/**
 * 工具库视图
 */
import appState from '../core/state.js';
import DOM from '../core/dom.js';
import { getAllTools } from '../tools/index.js';
import { createToolCard } from '../components/toolCard.js';

// 打开工具的回调
let onOpenTool = null;

const categoryGrids = Object.freeze({
    dev: () => DOM.devToolsGrid,
    design: () => DOM.designToolsGrid,
    utility: () => DOM.utilityToolsGrid,
    other: () => DOM.otherToolsGrid
});

function renderCategorizedTools(tools) {
    Object.entries(categoryGrids).forEach(([category, resolveGrid]) => {
        const grid = resolveGrid();
        if (!grid) return;
        const matches = tools.filter(tool => tool.category === category);
        grid.replaceChildren(...matches.map(tool => createToolCard(tool, onOpenTool)));
        grid.closest('.home-section')?.classList.toggle('home-section--hidden', matches.length === 0);
    });
}

/**
 * 设置回调函数
 */
export function setToolLibraryCallbacks(callbacks) {
    onOpenTool = callbacks.onOpenTool;
}

/**
 * 渲染工具库
 */
export function renderToolLibrary() {
    const allTools = getAllTools();
    renderCategorizedTools(allTools);
}

/**
 * 处理搜索
 */
export function handleSearch(query) {
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
    
    renderCategorizedTools(filtered);
}

/**
 * 初始化搜索事件监听
 */
export function initSearchListener() {
    if (DOM.searchInput) {
        DOM.searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
    }
}
