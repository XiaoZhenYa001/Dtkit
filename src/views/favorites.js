/**
 * 收藏视图 - 交换式拖拽
 */
import appState, { clearFavorites, saveFavorites } from '../core/state.js';
import DOM from '../core/dom.js';
import { getAllTools } from '../tools/index.js';
import { createToolCard } from '../components/toolCard.js';

// 打开工具的回调
let onOpenTool = null;
let onRenderToolLibrary = null;

// 拖拽状态
let dragTarget = null;
let startPos = { x: 0, y: 0, offsetX: 0, offsetY: 0 };
let startIndex = -1;
let hasMoved = false; // 标记是否发生了拖拽移动
let cards = []; // 存储 { el, toolId, currentIndex }
let gridConfig = { cols: 0, cardWidth: 0, cardHeight: 0, gap: 20 };

/**
 * 设置回调函数
 */
export function setFavoritesCallbacks(callbacks) {
    onOpenTool = callbacks.onOpenTool;
    onRenderToolLibrary = callbacks.onRenderToolLibrary;
}

/**
 * 根据索引计算卡片的像素位置
 */
function getPosByIndex(index) {
    const col = index % gridConfig.cols;
    const row = Math.floor(index / gridConfig.cols);
    return {
        x: col * (gridConfig.cardWidth + gridConfig.gap),
        y: row * (gridConfig.cardHeight + gridConfig.gap)
    };
}

/**
 * 渲染收藏页面
 */
export function renderFavoritesPage() {
    const grid = DOM.favoritesGrid;
    if (!grid) return;
    
    grid.innerHTML = '';
    cards = [];
    
    if (appState.favorites.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>还未收藏任何工具</p></div>';
        return;
    }
    
    // 计算网格配置
    const gridStyles = window.getComputedStyle(grid);
    const templateColumns = gridStyles.gridTemplateColumns;
    gridConfig.cols = templateColumns.split(' ').length;
    
    // 计算单个卡片宽度（从 grid-template-columns 中提取）
    const colWidth = parseFloat(templateColumns.split(' ')[0]);
    gridConfig.cardWidth = colWidth;
    gridConfig.cardHeight = 180; // 固定高度，与 CSS 中的 tool-card 一致
    
    // 从 CSS 变量获取间距
    const gapValue = gridStyles.gap || gridStyles.gridGap;
    gridConfig.gap = parseFloat(gapValue) || 20;
    
    // 设置容器为相对定位
    grid.style.position = 'relative';
    grid.style.height = `${Math.ceil(appState.favorites.length / gridConfig.cols) * (gridConfig.cardHeight + gridConfig.gap)}px`;
    
    const allTools = getAllTools();
    appState.favorites.forEach((favId, index) => {
        const tool = allTools.find(t => t.id === favId);
        if (tool) {
            const card = createToolCard(tool, onOpenTool);
            
            // 改为绝对定位
            card.style.position = 'absolute';
            card.style.width = `${gridConfig.cardWidth}px`;
            card.style.transition = 'transform 0.4s cubic-bezier(0.2, 1, 0.3, 1)';
            
            // 计算初始位置
            const { x, y } = getPosByIndex(index);
            card.style.transform = `translate(${x}px, ${y}px)`;
            card.dataset.toolId = favId;
            
            // 显示拖动手柄
            const dragHandle = card.querySelector('.tool-card__drag-handle');
            if (dragHandle) dragHandle.style.display = 'flex';
            
            // 绑定拖拽事件
            card.addEventListener('mousedown', onMouseDown);
            
            grid.appendChild(card);
            cards.push({ el: card, toolId: favId, currentIndex: index });
        }
    });
}

/**
 * 鼠标按下 - 开始拖拽
 */
function onMouseDown(e) {
    // 只有点击拖动手柄才能拖拽
    if (!e.target.closest('.tool-card__drag-handle')) return;
    
    dragTarget = e.currentTarget;
    const rect = dragTarget.getBoundingClientRect();
    const gridRect = DOM.favoritesGrid.getBoundingClientRect();
    
    // 记录偏移
    startPos.offsetX = e.clientX - rect.left;
    startPos.offsetY = e.clientY - rect.top;
    
    const draggedItem = cards.find(item => item.el === dragTarget);
    startIndex = draggedItem ? draggedItem.currentIndex : -1;
    hasMoved = false; // 重置移动标志
    
    // 添加拖拽样式
    dragTarget.classList.add('dragging');
    dragTarget.style.zIndex = '100';
    dragTarget.style.transition = 'transform 0.05s linear';
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    
    e.preventDefault();
}

/**
 * 鼠标移动 - 实时更新
 */
function onMouseMove(e) {
    if (!dragTarget) return;
    
    hasMoved = true; // 标记发生了移动
    
    const gridRect = DOM.favoritesGrid.getBoundingClientRect();
    const curX = e.clientX - gridRect.left - startPos.offsetX;
    const curY = e.clientY - gridRect.top - startPos.offsetY;
    
    // 手里的卡片实时跟随
    dragTarget.style.transform = `translate(${curX}px, ${curY}px)`;
    
    // 计算当前悬停在哪个格子
    const centerX = curX + gridConfig.cardWidth / 2;
    const centerY = curY + gridConfig.cardHeight / 2;
    const col = Math.round(centerX / (gridConfig.cardWidth + gridConfig.gap));
    const row = Math.round(centerY / (gridConfig.cardHeight + gridConfig.gap));
    const hoverIndex = row * gridConfig.cols + col;
    
    // 处理其他卡片的位移
    cards.forEach(item => {
        if (item.el === dragTarget) return;
        
        const targetPos = getPosByIndex(item.currentIndex);
        
        if (hoverIndex === item.currentIndex && hoverIndex >= 0 && hoverIndex < cards.length) {
            // 悬停在某个卡片上 - 该卡片移动到起点位置
            const startCoords = getPosByIndex(startIndex);
            item.el.style.transform = `translate(${startCoords.x}px, ${startCoords.y}px)`;
            item.el.classList.add('swapping');
        } else {
            // 其他情况 - 回到原位
            item.el.style.transform = `translate(${targetPos.x}px, ${targetPos.y}px)`;
            item.el.classList.remove('swapping');
        }
    });
}

/**
 * 鼠标松开 - 完成拖拽
 */
function onMouseUp(e) {
    if (!dragTarget) return;
    
    const gridRect = DOM.favoritesGrid.getBoundingClientRect();
    const centerX = (e.clientX - gridRect.left - startPos.offsetX) + gridConfig.cardWidth / 2;
    const centerY = (e.clientY - gridRect.top - startPos.offsetY) + gridConfig.cardHeight / 2;
    const col = Math.round(centerX / (gridConfig.cardWidth + gridConfig.gap));
    const row = Math.round(centerY / (gridConfig.cardHeight + gridConfig.gap));
    const finalIndex = Math.max(0, Math.min(cards.length - 1, row * gridConfig.cols + col));
    
    dragTarget.classList.remove('dragging');
    dragTarget.style.zIndex = '1';
    dragTarget.style.transition = 'transform 0.4s cubic-bezier(0.2, 1, 0.3, 1)';
    
    // 查找被交换的卡片
    const swappedItem = cards.find(item => item.currentIndex === finalIndex && item.el !== dragTarget);
    
    if (swappedItem) {
        // 执行对调
        const draggedItem = cards.find(item => item.el === dragTarget);
        const oldTargetIndex = swappedItem.currentIndex;
        swappedItem.currentIndex = draggedItem.currentIndex;
        draggedItem.currentIndex = oldTargetIndex;
        
        // 更新数据
        swappedItem.el.dataset.index = swappedItem.currentIndex;
        dragTarget.dataset.index = draggedItem.currentIndex;
        
        // 更新 appState.favorites 顺序
        const newFavorites = new Array(cards.length);
        cards.forEach(item => {
            newFavorites[item.currentIndex] = item.toolId;
        });
        appState.favorites = newFavorites;
        saveFavorites();
    }
    
    // 刷新所有卡片位置
    refreshPositions();
    
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    
    // 如果发生了移动，临时禁用点击事件
    if (hasMoved) {
        const tempTarget = dragTarget;
        setTimeout(() => {
            tempTarget.style.pointerEvents = 'auto';
        }, 100);
        dragTarget.style.pointerEvents = 'none';
    }
    
    dragTarget = null;
    hasMoved = false;
}

/**
 * 刷新所有卡片到正确位置
 */
function refreshPositions() {
    cards.forEach(item => {
        const { x, y } = getPosByIndex(item.currentIndex);
        item.el.style.transform = `translate(${x}px, ${y}px)`;
        item.el.classList.remove('swapping');
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
