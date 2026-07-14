/**
 * 标签页管理组件
 */
import appState, { createNewTabConfig, getActiveTab } from '../core/state.js';
import DOM from '../core/dom.js';

// 回调函数引用（由主模块注入）
let onSwitchTab = null;
let onUpdateContentView = null;
let onUpdateBackForwardButtons = null;

/**
 * 注入回调函数
 */
export function setTabCallbacks(callbacks) {
    onSwitchTab = callbacks.onSwitchTab;
    onUpdateContentView = callbacks.onUpdateContentView;
    onUpdateBackForwardButtons = callbacks.onUpdateBackForwardButtons;
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
export function closeTab(tabId) {
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
        
        const label = document.createElement('div');
        label.className = 'tab__label';
        label.innerHTML = `
            <span class="tab__icon"><i class="${tab.icon}"></i></span>
            <span class="tab__text">
                <span class="tab__title">${tab.title}</span>
                <span class="tab__badge">${tab.badge || '界面'}</span>
            </span>
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
        
        // 整个标签元素点击切换
        tabEl.addEventListener('click', (e) => {
            if (e.target.closest('.tab__close')) return;
            switchTab(tab.id);
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
}
