/**
 * 工具库视图
 */
import appState from '../core/state.js';
import DOM from '../core/dom.js';
import { getAllTools } from '../tools/index.js';
import { createToolCard } from '../components/toolCard.js';

// 打开工具的回调
let onOpenTool = null;

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
    console.log('[renderToolLibrary] 找到工具数量:', allTools.length);
    
    // 按分类分组
    const devTools = allTools.filter(t => t.category === 'dev');
    const designTools = allTools.filter(t => t.category === 'design');
    const utilityTools = allTools.filter(t => t.category === 'utility');
    const otherTools = allTools.filter(t => t.category === 'other');
    
    // 渲染开发工具
    if (DOM.devToolsGrid) {
        DOM.devToolsGrid.innerHTML = '';
        devTools.forEach(tool => {
            DOM.devToolsGrid.appendChild(createToolCard(tool, onOpenTool));
        });
    }
    
    // 渲染设计工具
    if (DOM.designToolsGrid) {
        DOM.designToolsGrid.innerHTML = '';
        designTools.forEach(tool => {
            DOM.designToolsGrid.appendChild(createToolCard(tool, onOpenTool));
        });
    }
    
    // 渲染日常工具
    if (DOM.utilityToolsGrid) {
        DOM.utilityToolsGrid.innerHTML = '';
        utilityTools.forEach(tool => {
            DOM.utilityToolsGrid.appendChild(createToolCard(tool, onOpenTool));
        });
    }
    
    // 渲染其他工具
    if (DOM.otherToolsGrid) {
        DOM.otherToolsGrid.innerHTML = '';
        otherTools.forEach(tool => {
            DOM.otherToolsGrid.appendChild(createToolCard(tool, onOpenTool));
        });
    }
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
    
    // 清空所有分类
    if (DOM.devToolsGrid) DOM.devToolsGrid.innerHTML = '';
    if (DOM.designToolsGrid) DOM.designToolsGrid.innerHTML = '';
    if (DOM.utilityToolsGrid) DOM.utilityToolsGrid.innerHTML = '';
    if (DOM.otherToolsGrid) DOM.otherToolsGrid.innerHTML = '';
    
    // 在第一个分类中显示搜索结果
    if (DOM.devToolsGrid) {
        filtered.forEach(tool => {
            DOM.devToolsGrid.appendChild(createToolCard(tool, onOpenTool));
        });
    }
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
