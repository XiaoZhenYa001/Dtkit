/**
 * 工具卡片组件
 */
import appState, { toggleFavorite, isFavorited } from '../core/state.js';

/**
 * 创建工具卡片元素
 * @param {Object} tool - 工具配置对象
 * @param {Function} onOpenTool - 打开工具的回调函数
 * @returns {HTMLElement} 卡片元素
 */
export function createToolCard(tool, onOpenTool) {
    const desc = tool.description || '点击查看详情';
    const favorited = isFavorited(tool.id);
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolId = tool.id;
    const colorClass = tool.colorClass || 'tool-card__icon--blue';
    
    card.innerHTML = `
        <button class="tool-card__favorite ${favorited ? 'tool-card__favorite--active' : ''}" title="${favorited ? '取消收藏' : '收藏'}">
            <i class="ri-star-fill"></i>
        </button>
        <button class="tool-card__drag-handle" title="拖动调整顺序" style="display: none;">
            <i class="ri-draggable"></i>
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
            if (onOpenTool) {
                onOpenTool(tool.id, tool.name, tool.icon);
            }
        }
    });
    
    return card;
}

/**
 * 更新收藏按钮状态
 */
export function updateFavoriteButton(btn, toolId) {
    const favorited = isFavorited(toolId);
    btn.classList.toggle('tool-card__favorite--active', favorited);
    btn.title = favorited ? '取消收藏' : '收藏';
    btn.innerHTML = `<i class="ri-star-${favorited ? 'fill' : 'line'}"></i>`;
}
