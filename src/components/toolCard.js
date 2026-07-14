/**
 * 工具卡片组件
 */
import { toggleFavorite, isFavorited } from '../core/state.js';
import { isDragging } from '../views/favorites.js';

function getToolBadge(tool) {
    if (tool.status === 'planned') return '即将推出';
    if (tool.status === 'beta') return 'Beta';

    const badgeMap = {
        dev: '开发',
        design: '设计',
        utility: '日常',
        other: '其他'
    };

    return badgeMap[tool.category] || '工具';
}

/**
 * 创建工具卡片元素
 * @param {Object} tool - 工具配置对象
 * @param {Function} onOpenTool - 打开工具的回调函数
 * @returns {HTMLElement} 卡片元素
 */
export function createToolCard(tool, onOpenTool) {
    const desc = tool.description || '点击查看详情';
    const favorited = isFavorited(tool.id);
    const isPlanned = tool.status === 'planned';
    const card = document.createElement('div');
    card.className = `tool-card${isPlanned ? ' tool-card--planned' : ''}`;
    card.dataset.toolId = tool.id;
    card.dataset.status = tool.status || 'ready';
    if (isPlanned) {
        card.setAttribute('aria-disabled', 'true');
        card.title = '该工具正在开发中，暂不可用';
    }
    const colorClass = tool.colorClass || 'tool-card__icon--blue';
    const badgeText = getToolBadge(tool);
    
    card.innerHTML = `
        <button class="tool-card__favorite ${favorited ? 'tool-card__favorite--active' : ''}" title="${favorited ? '取消收藏' : '收藏'}">
            <i class="ri-star-fill"></i>
        </button>
        <button class="tool-card__drag-handle is-initially-hidden" title="拖动调整顺序">
            <i class="ri-draggable"></i>
        </button>
        <div class="tool-card__header">
            <div class="tool-card__icon ${colorClass}">
                <i class="${tool.icon}"></i>
            </div>
            <div class="tool-card__meta">
                <span class="tool-card__badge${isPlanned ? ' tool-card__badge--planned' : ''}">${badgeText}</span>
                <i class="${isPlanned ? 'ri-time-line' : 'ri-arrow-right-up-line'} tool-card__arrow"></i>
            </div>
        </div>
        <h3 class="tool-card__title">${tool.name}</h3>
        <p class="tool-card__description">${desc}</p>
        <div class="tool-card__footer">
            <span class="tool-card__footer-chip${isPlanned ? ' tool-card__footer-chip--planned' : ''}">${isPlanned ? '开发中' : '点击打开'}</span>
            <span class="tool-card__footer-chip tool-card__footer-chip--ghost">${tool.id}</span>
        </div>
    `;
    
    // 收藏按钮事件
    const favoriteBtn = card.querySelector('.tool-card__favorite');
    favoriteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(tool.id);
        updateFavoriteButton(favoriteBtn, tool.id);
    });
    
    // 卡片整体点击打开工具 - 拖动状态时不触发
    card.addEventListener('click', (e) => {
        // 如果正在拖动，不触发点击
        if (isDragging() || isPlanned) return;
        
        if (e.target !== favoriteBtn && !e.target.closest('.tool-card__favorite') && !e.target.closest('.tool-card__drag-handle')) {
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
