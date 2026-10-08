/**
 * 标签页管理组件
 */
import appState, { createNewTabConfig, getActiveTab } from '../core/state.js';
import DOM from '../core/dom.js';

// 回调函数引用（由主模块注入）
let onSwitchTab = null;
let onUpdateContentView = null;
let onUpdateBackForwardButtons = null;
let onCloseTab = null;
let onBeforeCloseTab = null;
const closingTabs = new Set();
let tabBarObserver = null;

function revealActiveTab() {
    DOM.tabBar?.querySelector('.tab--active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * 注入回调函数
 */
export function setTabCallbacks(callbacks) {
    onSwitchTab = callbacks.onSwitchTab;
    onUpdateContentView = callbacks.onUpdateContentView;
    onUpdateBackForwardButtons = callbacks.onUpdateBackForwardButtons;
    onCloseTab = callbacks.onCloseTab;
    onBeforeCloseTab = callbacks.onBeforeCloseTab;
    if (DOM.tabBar && !tabBarObserver) {
        tabBarObserver = new ResizeObserver(revealActiveTab);
        tabBarObserver.observe(DOM.tabBar);
    }
}

/**
 * 添加新标签页
 */
export function addTab() {
    const newTab = createNewTabConfig();
    appState.tabs.push(newTab);
    switchTab(newTab.id);
}

/**
 * 关闭标签页
 */
export async function closeTab(tabId) {
    if (closingTabs.has(tabId) || !appState.tabs.some(t => t.id === tabId) || appState.tabs.length === 1) return;
    closingTabs.add(tabId);
    try {
        if (onBeforeCloseTab && await onBeforeCloseTab(tabId) === false) return;
        const index = appState.tabs.findIndex(t => t.id === tabId);
        if (index < 0 || appState.tabs.length === 1) return;
    
        appState.tabs.splice(index, 1);
        onCloseTab?.(tabId);

        if (appState.activeTabId === tabId && appState.tabs.length > 0) {
            const newIndex = Math.max(0, index - 1);
            switchTab(appState.tabs[newIndex].id);
        } else {
            renderTabs();
        }
    } finally { closingTabs.delete(tabId); }
}

/**
 * 切换标签页
 */
export function switchTab(tabId) {
    appState.activeTabId = tabId;
    const tab = appState.tabs.find(t => t.id === tabId);
    if (tab) {
        // 根据标签的 viewType 或 toolId 设置 currentView
        if (tab.toolId) {
            appState.currentView = tab.toolId;
        } else {
            appState.currentView = tab.viewType || 'toolLibrary';
        }
    }
    renderTabs();
    if (onUpdateContentView) onUpdateContentView();
    if (onUpdateBackForwardButtons) onUpdateBackForwardButtons();
}

/**
 * 渲染标签栏
 */
export function renderTabs() {
    if (!DOM.tabBar) return;
    
    DOM.tabBar.innerHTML = '';
    
    appState.tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.id === appState.activeTabId ? 'tab--active' : ''}`;
        tabEl.dataset.tabId = tab.id;
        tabEl.setAttribute('role', 'tab');
        tabEl.setAttribute('aria-selected', String(tab.id === appState.activeTabId));
        tabEl.tabIndex = tab.id === appState.activeTabId ? 0 : -1;
        
        const label = document.createElement('div');
        label.className = 'tab__label';
        const icon = document.createElement('span'); icon.className = 'tab__icon';
        const glyph = document.createElement('i'); glyph.className = tab.icon; icon.append(glyph);
        const text = document.createElement('span'); text.className = 'tab__title'; text.textContent = tab.title;
        label.append(icon, text);
        tabEl.appendChild(label);
        
        // 关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab__close';
        closeBtn.innerHTML = '<i class="ri-close-line"></i>';
        closeBtn.title = `关闭“${tab.title}”`;
        closeBtn.setAttribute('aria-label', `关闭“${tab.title}”`);
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(tab.id);
        });
        closeBtn.style.display = appState.tabs.length > 1 ? 'flex' : 'none';
        tabEl.appendChild(closeBtn);
        
        // 整个标签元素点击切换
        tabEl.addEventListener('click', (e) => {
            if (e.target.closest('.tab__close')) return;
            switchTab(tab.id);
        });

        tabEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                switchTab(tab.id);
            }
        });
        
        // 中键点击关闭标签
        tabEl.addEventListener('mouseup', (e) => {
            if (e.button === 1 && appState.tabs.length > 1) {
                e.preventDefault();
                closeTab(tab.id);
            }
        });
        
        DOM.tabBar.appendChild(tabEl);
    });
    revealActiveTab();
}
