/**
 * 桌面整理 - 主逻辑
 * Desktop Organizer - Main Logic
 */

import {
    desktopSnapshotFingerprint,
    readDesktopSnapshot,
    writeDesktopSnapshot
} from './snapshot.js';
import {
    reconcileFileCategories
} from './categories.js';
import { createDesktopOrganizerState } from './store.js';
import { buildSearchIndex, querySearchIndex } from './search.js';
import {
    categoryFilesMarkup,
    filesForCategory,
    renderCategoryListMarkup
} from './views/category-view.js';
import {
    escapeHtml,
    renderSearchResultsMarkup
} from './views/file-view.js';
import { createFolderController } from './folder-controller.js';
import { createCategoryController } from './category-controller.js';
import { createFileActions } from './file-actions.js';
import { createWindowController } from './window-controller.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// ============================================
// 状态管理
// ============================================
const state = createDesktopOrganizerState();

// ============================================
// DOM 元素
// ============================================
const elements = {
    panel: document.getElementById('panel'),
    dragHandle: document.getElementById('dragHandle'),
    categoryList: document.getElementById('categoryList'),
    searchInput: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    commandHint: document.getElementById('commandHint'),
    searchResults: document.getElementById('searchResults'),
    searchResultsList: document.getElementById('searchResultsList'),
    searchResultsCount: document.getElementById('searchResultsCount'),
    statusText: document.getElementById('statusText'),
    refreshBtn: document.getElementById('refreshBtn'),
    contextMenu: document.getElementById('contextMenu'),
    blankContextMenu: document.getElementById('blankContextMenu'),
    categorySubmenu: document.getElementById('categorySubmenu'),
    renameDialog: document.getElementById('renameDialog'),
    renameInput: document.getElementById('renameInput'),
    renameCancelBtn: document.getElementById('renameCancelBtn'),
    renameConfirmBtn: document.getElementById('renameConfirmBtn'),
    createCategoryDialog: document.getElementById('createCategoryDialog'),
    categoryNameInput: document.getElementById('categoryNameInput'),
    iconPicker: document.getElementById('iconPicker'),
    createCategoryCancelBtn: document.getElementById('createCategoryCancelBtn'),
    createCategoryConfirmBtn: document.getElementById('createCategoryConfirmBtn'),
    manageCategoriesDialog: document.getElementById('manageCategoriesDialog'),
    customCategoriesList: document.getElementById('customCategoriesList'),
    manageCategoriesCloseBtn: document.getElementById('manageCategoriesCloseBtn'),
};

const appWindow = getCurrentWindow();
const windowController = createWindowController({
    invoke,
    appWindow,
    state,
    dragHandle: elements.dragHandle,
    storage: globalThis.localStorage,
    document,
    window
});
const loadUserPreferences = windowController.loadPreferences;

const appIconCache = new Map();

async function hydrateVisibleAppIcons(root = document) {
    const targets = [...root.querySelectorAll('.file-item[data-app-id]:not([data-icon-loaded])')].slice(0, 32);
    await Promise.all(targets.map(async item => {
        item.dataset.iconLoaded = 'true';
        const path = item.dataset.path;
        let icon = appIconCache.get(path);
        if (icon === undefined) {
            try { icon = await invoke('desktop_get_app_icon', { path }); } catch { icon = null; }
            if (appIconCache.size >= 96) appIconCache.clear();
            appIconCache.set(path, icon);
        }
        if (!icon || !item.isConnected) return;
        const holder = item.querySelector('.file-icon');
        if (holder) { holder.classList.add('file-icon-real'); holder.innerHTML = `<img src="${icon}" class="file-icon-img" alt="" loading="lazy">`; }
    }));
}

function rebuildSearchIndex() {
    state.searchIndex = buildSearchIndex(state.files);
}

// ============================================
// 渲染函数
// ============================================
function renderCategoryList() {
    elements.categoryList.classList.remove('category-list--folder-view');
    if (!state.files) {
        elements.categoryList.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
            </div>
        `;
        return;
    }
    elements.categoryList.innerHTML = renderCategoryListMarkup(state);
    elements.statusText.textContent = `共 ${state.files.total_count} 个项目`;
    queueMicrotask(() => hydrateVisibleAppIcons(elements.categoryList));
}

const folderController = createFolderController({
    state,
    categoryList: elements.categoryList,
    invoke,
    setStatus: setDesktopStatus,
    renderCategories: renderCategoryList,
    hydrateIcons: hydrateVisibleAppIcons,
    loadDesktopFiles
});
const enterFolder = folderController.enter;
const leaveFolderBrowser = folderController.leave;
const navigateFolderBack = folderController.back;
const navigateFolderDepth = folderController.navigateToDepth;
const refreshCurrentView = folderController.refresh;

function renderSearchResults() {
    elements.searchResultsCount.textContent = state.searchResults.length;
    elements.searchResultsList.innerHTML = renderSearchResultsMarkup(state.searchResults, state.searchQuery);
    if (state.searchResults.length) queueMicrotask(() => hydrateVisibleAppIcons(elements.searchResultsList));
}

const categoryController = createCategoryController({
    state,
    storage: globalThis.localStorage,
    renderCategories: renderCategoryList,
    categorySubmenu: elements.categorySubmenu
});
const loadCustomCategories = categoryController.load;
const saveCustomCategories = categoryController.save;
const createCategory = categoryController.create;
const deleteCategory = categoryController.remove;
const moveFileToCategory = categoryController.moveFile;
const getFileCustomCategory = categoryController.categoryForFile;
const updateCategorySubmenu = categoryController.updateSubmenu;

const fileActions = createFileActions({
    invoke,
    state,
    setStatus: setDesktopStatus,
    saveCategories: saveCustomCategories,
    loadDesktopFiles,
    refreshCurrentView
});
const openFile = fileActions.open;
const locateFile = fileActions.locate;
const renameFile = fileActions.rename;
const copyToClipboard = fileActions.copyToClipboard;

// ============================================
// 数据加载
// ============================================
const LIVE_RESCAN_INTERVAL_MS = 15_000;
let scanPromise = null;
let lastSuccessfulScanAt = 0;

function setDesktopStatus(message) {
    elements.statusText.textContent = message;
}

function hydrateCachedDesktopSnapshot() {
    const snapshot = readDesktopSnapshot(globalThis.localStorage);
    if (!snapshot) return false;

    state.files = snapshot.files;
    rebuildSearchIndex();
    renderCategoryList();
    setDesktopStatus(`上次扫描 · 共 ${state.files.total_count} 个项目 · 正在同步`);
    return true;
}

async function loadDesktopFiles() {
    if (scanPromise) return scanPromise;
    const previousFingerprint = desktopSnapshotFingerprint(state.files);
    scanPromise = invoke('desktop_scan');
    try {
        elements.refreshBtn.classList.add('is-syncing');
        elements.refreshBtn.setAttribute('aria-busy', 'true');
        if (!state.folderView.active) {
            setDesktopStatus(state.files ? `正在同步 · 共 ${state.files.total_count} 个项目` : '正在扫描桌面…');
        }

        const scannedFiles = await scanPromise;
        const nextFingerprint = desktopSnapshotFingerprint(scannedFiles);
        state.files = scannedFiles;
        const reconciledCategories = reconcileFileCategories(
            state.fileCategories,
            scannedFiles,
            new Set(state.customCategories.map(category => category.key))
        );
        if (reconciledCategories !== state.fileCategories) {
            state.fileCategories = reconciledCategories;
            saveCustomCategories();
        }
        rebuildSearchIndex();
        if (nextFingerprint !== previousFingerprint && !state.folderView.active) renderCategoryList();
        if (state.isSearching && state.searchQuery) searchFiles(state.searchQuery);
        writeDesktopSnapshot(globalThis.localStorage, scannedFiles);
        lastSuccessfulScanAt = Date.now();
        if (!state.folderView.active) setDesktopStatus(`已同步 · 共 ${state.files.total_count} 个项目`);
    } catch (error) {
        console.error('扫描桌面失败:', error);
        if (state.files && !state.folderView.active) {
            setDesktopStatus(`显示上次结果 · 同步失败`);
        } else if (!state.files && !state.folderView.active) {
            setDesktopStatus('扫描失败');
            elements.categoryList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">⚠️</div>
                    <div class="empty-state-text">加载失败: ${escapeHtml(String(error))}</div>
                </div>
            `;
        }
    } finally {
        elements.refreshBtn.classList.remove('is-syncing');
        elements.refreshBtn.removeAttribute('aria-busy');
        scanPromise = null;
    }
}

let searchGeneration = 0;
function searchFiles(query) {
    searchGeneration++;
    state.searchResults = querySearchIndex(state.searchIndex, query);
    renderSearchResults();
}

// ============================================
// 键盘快捷键
// ============================================
function visibleFileItems(currentItem) {
    const root = currentItem.closest('#searchResultsList, .folder-browser__list, .category-files')
        || (state.isSearching ? elements.searchResultsList : elements.categoryList);
    return [...root.querySelectorAll('.file-item')]
        .filter(item => item.getClientRects().length > 0);
}

function moveFileFocus(currentItem, key) {
    const items = visibleFileItems(currentItem);
    const currentIndex = items.indexOf(currentItem);
    if (currentIndex < 0 || items.length === 0) return false;
    const targetIndex = key === 'Home'
        ? 0
        : key === 'End'
            ? items.length - 1
            : Math.max(
                0,
                Math.min(items.length - 1, currentIndex + (key === 'ArrowDown' ? 1 : -1))
            );
    const target = items[targetIndex];
    target.focus();
    selectFileItem(target);
    return true;
}

document.addEventListener('keydown', async (e) => {
    // 如果重命名对话框打开，不处理快捷键（除了在输入框内的处理）
    if (getComputedStyle(elements.renameDialog).display !== 'none') {
        return;
    }
    
    // 如果焦点在搜索框，不处理文件操作快捷键
    if (document.activeElement === elements.searchInput) {
        // ESC 清空搜索
        if (e.key === 'Escape') {
            elements.searchInput.value = '';
            elements.searchInput.dispatchEvent(new Event('input'));
        }
        return;
    }

    const focusedFile = e.target.closest?.('.file-item');
    if (focusedFile && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        if (moveFileFocus(focusedFile, e.key)) e.preventDefault();
        return;
    }
    
    // 获取当前选中的文件
    const selectedItem = document.querySelector('.file-item.selected');
    
    if (selectedItem && state.selectedFile) {
        const { path, name, isFolder, appId } = state.selectedFile;
        
        // Enter - 打开文件
        if (e.key === 'Enter') {
            e.preventDefault();
            if (isFolder) {
                await enterFolder({ path, name });
            } else {
                await openFile(path, appId);
            }
        }
        // F2 - 重命名
        else if (e.key === 'F2') {
            e.preventDefault();
            if (!appId) showRenameDialog(path, name);
        }
        // Ctrl+C - 复制路径
        else if (e.ctrlKey && e.key === 'c') {
            e.preventDefault();
            await copyToClipboard(path);
        }
        // Ctrl+L - 定位文件
        else if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            await locateFile(path, appId);
        }
    }
    
    // ESC - 关闭右键菜单
    if (e.key === 'Escape') {
        hideContextMenu();
        if (state.folderView.active) navigateFolderBack();
    }
    
    // Ctrl+F 或 / - 聚焦搜索框
    if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        elements.searchInput.focus();
        elements.searchInput.select();
    }
    
    // F5 - 刷新
    if (e.key === 'F5') {
        e.preventDefault();
        refreshCurrentView();
    }
});

// ============================================
// 事件处理
// ============================================

// 文件选中状态
function selectFileItem(fileItem) {
    // 移除之前的选中状态
    document.querySelectorAll('.file-item.selected').forEach(item => {
        item.classList.remove('selected');
    });
    
    if (fileItem) {
        fileItem.classList.add('selected');
        state.selectedFile = {
            path: fileItem.dataset.path,
            name: fileItem.dataset.name,
            isFolder: fileItem.dataset.isFolder === 'true',
            appId: fileItem.dataset.appId || '',
        };
    } else {
        state.selectedFile = null;
    }
}

function persistExpandedCategories() {
    let existing = {};
    try {
        const parsed = JSON.parse(localStorage.getItem('desktopOrganizerPrefs') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
        // A malformed legacy preference must not prevent future settings from being saved.
    }
    try {
        localStorage.setItem('desktopOrganizerPrefs', JSON.stringify({
            ...existing,
            expandedCategories: Array.from(state.expandedCategories)
        }));
    } catch (error) {
        console.error('保存分类展开状态失败:', error);
    }
}

// 单击选中文件
elements.categoryList.addEventListener('click', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        selectFileItem(fileItem);
    }
});

elements.categoryList.addEventListener('focusin', e => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) selectFileItem(fileItem);
});

// 分类展开/折叠
elements.categoryList.addEventListener('click', (e) => {
    if (e.target.closest('[data-folder-back]')) {
        navigateFolderBack();
        return;
    }

    const breadcrumb = e.target.closest('[data-folder-depth]');
    if (breadcrumb) {
        navigateFolderDepth(Number(breadcrumb.dataset.folderDepth));
        return;
    }

    if (e.target.closest('[data-folder-refresh]')) {
        refreshCurrentView();
        return;
    }

    if (e.target.closest('[data-folder-external]')) {
        const path = state.folderView.stack.at(-1)?.path;
        if (path) openFile(path);
        return;
    }

    const header = e.target.closest('.category-header');
    if (header) {
        const category = header.dataset.category;
        const item = header.closest('.category-item');
        const filesContainer = item.querySelector('.category-files');
        const willExpand = !state.expandedCategories.has(category);
        if (!willExpand) {
            state.expandedCategories.delete(category);
            filesContainer.replaceChildren();
            item.dataset.filesRendered = 'false';
            if (item.querySelector('.file-item.selected')) state.selectedFile = null;
        } else {
            state.expandedCategories.add(category);
            filesContainer.innerHTML = categoryFilesMarkup(category, filesForCategory(state, category));
            item.dataset.filesRendered = 'true';
            queueMicrotask(() => hydrateVisibleAppIcons(filesContainer));
        }
        item.classList.toggle('expanded', willExpand);
        header.setAttribute('aria-expanded', String(willExpand));
        persistExpandedCategories();
        return;
    }

    const folderItem = e.target.closest('.file-item');
    if (folderItem?.dataset.isFolder === 'true') {
        enterFolder({ path: folderItem.dataset.path, name: folderItem.dataset.name });
    }
});

// 文件双击打开
elements.categoryList.addEventListener('dblclick', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem && fileItem.dataset.isFolder !== 'true') {
        const path = fileItem.dataset.path;
        if (path) {
            openFile(path, fileItem.dataset.appId || '');
        }
    }
});

elements.searchResultsList?.addEventListener('click', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) selectFileItem(fileItem);
});

elements.searchResultsList?.addEventListener('focusin', e => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) selectFileItem(fileItem);
});

elements.searchResultsList?.addEventListener('dblclick', async (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        const path = fileItem.dataset.path;
        if (path && fileItem.dataset.isFolder === 'true') {
            elements.searchInput.value = '';
            elements.searchInput.dispatchEvent(new Event('input'));
            await enterFolder({ path, name: fileItem.dataset.name });
        } else if (path) {
            await openFile(path, fileItem.dataset.appId || '');
        }
    }
});

// 右键菜单
function showContextMenu(e, fileItem) {
    e.preventDefault();
    hideBlankContextMenu();
    
    state.selectedFile = {
        path: fileItem.dataset.path,
        name: fileItem.dataset.name,
        isFolder: fileItem.dataset.isFolder === 'true',
        appId: fileItem.dataset.appId || '',
    };
    
    // 更新分类子菜单
    updateCategorySubmenu();
    
    elements.contextMenu.style.display = 'block';
    elements.contextMenu.style.left = `${e.clientX}px`;
    elements.contextMenu.style.top = `${e.clientY}px`;
    // 重置方向类
    elements.contextMenu.classList.remove('menu-up');
    
    // 确保菜单不超出窗口，并调整子菜单方向
    requestAnimationFrame(() => {
        const rect = elements.contextMenu.getBoundingClientRect();
        let menuLeft = e.clientX;
        let menuTop = e.clientY;
        
        // 水平方向调整
        if (rect.right > window.innerWidth) {
            menuLeft = window.innerWidth - rect.width - 10;
            elements.contextMenu.style.left = `${menuLeft}px`;
        }
        
        // 垂直方向调整 - 如果菜单底部超出窗口，向上展开
        if (rect.bottom > window.innerHeight) {
            // 从点击位置向上展开
            menuTop = e.clientY - rect.height;
            if (menuTop < 0) menuTop = 10; // 确保不超出顶部
            elements.contextMenu.style.top = `${menuTop}px`;
            elements.contextMenu.classList.add('menu-up');
        }
        
        // 检查子菜单是否需要向左展开
        const submenu = elements.categorySubmenu;
        if (submenu) {
            const menuRight = menuLeft + rect.width;
            const submenuWidth = 170; // 估算子菜单宽度
            if (menuRight + submenuWidth > window.innerWidth) {
                submenu.classList.add('submenu-left');
            } else {
                submenu.classList.remove('submenu-left');
            }
        }
    });
}

function hideContextMenu() {
    if (elements.contextMenu.style.display === 'none') return;
    elements.contextMenu.querySelector('.has-submenu')?.classList.remove('is-open');
    elements.contextMenu.classList.add('closing');
    setTimeout(() => {
        elements.contextMenu.style.display = 'none';
        elements.contextMenu.classList.remove('closing');
    }, 150);
}

// 空白区域右键菜单
function showBlankContextMenu(e) {
    e.preventDefault();
    hideContextMenu();
    
    elements.blankContextMenu.style.display = 'block';
    elements.blankContextMenu.style.left = `${e.clientX}px`;
    elements.blankContextMenu.style.top = `${e.clientY}px`;
    elements.blankContextMenu.classList.remove('menu-up');
    
    requestAnimationFrame(() => {
        const rect = elements.blankContextMenu.getBoundingClientRect();
        let menuTop = e.clientY;
        
        if (rect.right > window.innerWidth) {
            elements.blankContextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menuTop = e.clientY - rect.height;
            if (menuTop < 0) menuTop = 10;
            elements.blankContextMenu.style.top = `${menuTop}px`;
            elements.blankContextMenu.classList.add('menu-up');
        }
    });
}

function hideBlankContextMenu() {
    if (!elements.blankContextMenu || elements.blankContextMenu.style.display === 'none') return;
    elements.blankContextMenu.classList.add('closing');
    setTimeout(() => {
        elements.blankContextMenu.style.display = 'none';
        elements.blankContextMenu.classList.remove('closing');
    }, 150);
}

elements.categoryList.addEventListener('contextmenu', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        showContextMenu(e, fileItem);
    } else {
        // 空白区域右键
        showBlankContextMenu(e);
    }
});

elements.searchResultsList?.addEventListener('contextmenu', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        showContextMenu(e, fileItem);
    }
});

// 面板空白区域右键
elements.panel.addEventListener('contextmenu', (e) => {
    // 只在非文件区域触发
    if (!e.target.closest('.file-item') && !e.target.closest('.context-menu')) {
        showBlankContextMenu(e);
    }
});

document.addEventListener('click', () => {
    hideContextMenu();
    hideBlankContextMenu();
});

// 右键菜单操作 - 文件
elements.contextMenu.addEventListener('click', async (e) => {
    const menuItem = e.target.closest('.menu-item');
    if (!menuItem || !state.selectedFile) return;
    
    // 如果点击的是有子菜单的项，不处理
    if (menuItem.classList.contains('has-submenu')) {
        menuItem.classList.toggle('is-open');
        return;
    }
    
    const action = menuItem.dataset.action;
    const { path, name, appId } = state.selectedFile;
    
    switch (action) {
        case 'open':
            await openFile(path, appId);
            break;
        case 'locate':
            await locateFile(path, appId);
            break;
        case 'copy':
            await copyToClipboard(path);
            break;
        case 'rename':
            if (!appId) showRenameDialog(path, name);
            break;
    }
    
    hideContextMenu();
});

// 分类子菜单点击
elements.categorySubmenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    const submenuItem = e.target.closest('.submenu-item');
    if (!submenuItem || !state.selectedFile) return;
    
    const categoryKey = submenuItem.dataset.category;
    const { path } = state.selectedFile;
    
    if (categoryKey === 'null') {
        moveFileToCategory(path, null);
    } else {
        moveFileToCategory(path, categoryKey);
    }
    
    hideContextMenu();
});

// 空白区域菜单操作
elements.blankContextMenu?.addEventListener('click', async (e) => {
    const menuItem = e.target.closest('.menu-item');
    if (!menuItem) return;
    
    const action = menuItem.dataset.action;
    
    switch (action) {
        case 'create-category':
            showCreateCategoryDialog();
            break;
        case 'manage-categories':
            showManageCategoriesDialog();
            break;
        case 'refresh':
            await refreshCurrentView();
            break;
    }
    
    hideBlankContextMenu();
});

// ============================================
// 创建分类对话框
// ============================================
let selectedCategoryIcon = '📁';

function showCreateCategoryDialog() {
    elements.createCategoryDialog.style.display = 'flex';
    elements.createCategoryDialog.classList.remove('closing');
    elements.categoryNameInput.value = '';
    selectedCategoryIcon = '📁';
    
    // 重置图标选择
    elements.iconPicker.querySelectorAll('.icon-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.icon === '📁');
    });
    
    requestAnimationFrame(() => {
        elements.categoryNameInput.focus();
    });
}

function hideCreateCategoryDialog() {
    elements.createCategoryDialog.classList.add('closing');
    setTimeout(() => {
        elements.createCategoryDialog.style.display = 'none';
        elements.createCategoryDialog.classList.remove('closing');
    }, 150);
}

elements.iconPicker?.addEventListener('click', (e) => {
    const option = e.target.closest('.icon-option');
    if (!option) return;
    
    elements.iconPicker.querySelectorAll('.icon-option').forEach(opt => {
        opt.classList.remove('selected');
    });
    option.classList.add('selected');
    selectedCategoryIcon = option.dataset.icon;
});

elements.createCategoryCancelBtn?.addEventListener('click', () => {
    hideCreateCategoryDialog();
});

elements.createCategoryConfirmBtn?.addEventListener('click', () => {
    const name = elements.categoryNameInput.value.trim();
    if (!name) {
        elements.categoryNameInput.focus();
        return;
    }
    
    if (!createCategory(name, selectedCategoryIcon)) {
        elements.categoryNameInput.setCustomValidity('分类名称已存在');
        elements.categoryNameInput.reportValidity();
        elements.categoryNameInput.addEventListener('input', () => elements.categoryNameInput.setCustomValidity(''), { once: true });
        return;
    }
    hideCreateCategoryDialog();
});

elements.categoryNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        elements.createCategoryConfirmBtn.click();
    } else if (e.key === 'Escape') {
        hideCreateCategoryDialog();
    }
});

// ============================================
// 管理分类对话框
// ============================================
function showManageCategoriesDialog() {
    renderManageCategoriesList();
    elements.manageCategoriesDialog.style.display = 'flex';
    elements.manageCategoriesDialog.classList.remove('closing');
}

function hideManageCategoriesDialog() {
    elements.manageCategoriesDialog.classList.add('closing');
    setTimeout(() => {
        elements.manageCategoriesDialog.style.display = 'none';
        elements.manageCategoriesDialog.classList.remove('closing');
    }, 150);
}

function renderManageCategoriesList() {
    if (state.customCategories.length === 0) {
        elements.customCategoriesList.innerHTML = `
            <div class="empty-categories">
                <span>暂无自定义分类</span>
            </div>
        `;
        return;
    }
    
    elements.customCategoriesList.innerHTML = state.customCategories.map(cat => {
        const fileCount = Object.values(state.fileCategories).filter(k => k === cat.key).length;
        return `
            <div class="category-manage-item" data-key="${cat.key}">
                <span class="category-manage-icon">${cat.icon}</span>
                <span class="category-manage-name">${escapeHtml(cat.name)}</span>
                <span class="category-manage-count">${fileCount} 个文件</span>
                <button class="category-delete-btn" data-key="${cat.key}" title="删除分类">✕</button>
            </div>
        `;
    }).join('');
}

elements.customCategoriesList?.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.category-delete-btn');
    if (deleteBtn) {
        const key = deleteBtn.dataset.key;
        if (confirm('确定要删除这个分类吗？分类中的文件将恢复到默认分类。')) {
            deleteCategory(key);
            renderManageCategoriesList();
        }
    }
});

elements.manageCategoriesCloseBtn?.addEventListener('click', () => {
    hideManageCategoriesDialog();
});

// 重命名对话框
function showRenameDialog(path, name) {
    elements.renameDialog.style.display = 'flex';
    elements.renameDialog.classList.remove('closing');
    elements.renameInput.value = name;
    
    // 延迟focus以确保动画流畅
    requestAnimationFrame(() => {
        elements.renameInput.focus();
        // 选中文件名但不包括扩展名
        const dotIndex = name.lastIndexOf('.');
        if (dotIndex > 0) {
            elements.renameInput.setSelectionRange(0, dotIndex);
        } else {
            elements.renameInput.select();
        }
    });
    
    state.selectedFile = { path, name };
}

function hideRenameDialog() {
    if (elements.renameDialog.style.display === 'none') return;
    elements.renameDialog.classList.add('closing');
    setTimeout(() => {
        elements.renameDialog.style.display = 'none';
        elements.renameDialog.classList.remove('closing');
    }, 250);
}

elements.renameCancelBtn.addEventListener('click', hideRenameDialog);

elements.renameConfirmBtn.addEventListener('click', async () => {
    const newName = elements.renameInput.value.trim();
    if (newName && newName !== state.selectedFile.name) {
        await renameFile(state.selectedFile.path, newName);
    }
    hideRenameDialog();
});

elements.renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        elements.renameConfirmBtn.click();
    } else if (e.key === 'Escape') {
        hideRenameDialog();
    }
});

// 搜索功能
let searchTimeout = null;

elements.searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    state.searchQuery = query;
    
    // 显示/隐藏清除按钮
    elements.searchClear.style.display = query ? 'block' : 'none';
    
    // 显示命令提示
    const isCommand = query.startsWith('/');
    elements.commandHint.classList.toggle('visible', isCommand && query.length < 4);
    
    // 切换搜索模式
    if (query) {
        state.isSearching = true;
        elements.categoryList.style.display = 'none';
        elements.searchResults.style.display = 'block';
        
        // 防抖搜索
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchFiles(query);
        }, 200);
    } else {
        searchGeneration++;
        clearTimeout(searchTimeout);
        state.isSearching = false;
        elements.categoryList.style.display = 'block';
        elements.searchResults.style.display = 'none';
    }
});

elements.searchClear.addEventListener('click', () => {
    elements.searchInput.value = '';
    elements.searchInput.dispatchEvent(new Event('input'));
    elements.searchInput.focus();
});

// 刷新按钮
elements.refreshBtn.addEventListener('click', () => {
    refreshCurrentView();
});

// ============================================
// 拖拽调整大小
// ============================================

// 监听窗口显示/隐藏事件，隐藏时关闭右键菜单并清除拖动状态
document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
        clearTimeout(searchTimeout);
        searchGeneration++;
        hideContextMenu();
        hideRenameDialog();
        
        await windowController.cancelInteractions();
    } else if (Date.now() - lastSuccessfulScanAt >= LIVE_RESCAN_INTERVAL_MS) {
        // 只在窗口重新可见时刷新，不使用后台轮询。
        if (state.folderView.active) {
            void refreshCurrentView();
        } else {
            void loadDesktopFiles();
        }
    }
});

// 二级菜单使用短暂的关闭宽限期，避免鼠标穿过菜单间隙时意外消失。
const moveCategoryMenuItem = elements.contextMenu.querySelector('.menu-item.has-submenu');
let submenuCloseTimer = null;
function cancelSubmenuClose() { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
function openCategorySubmenu() { cancelSubmenuClose(); moveCategoryMenuItem?.classList.add('is-open'); }
function scheduleSubmenuClose() {
    cancelSubmenuClose();
    submenuCloseTimer = setTimeout(() => moveCategoryMenuItem?.classList.remove('is-open'), 260);
}
moveCategoryMenuItem?.addEventListener('pointerenter', openCategorySubmenu);
moveCategoryMenuItem?.addEventListener('pointerleave', scheduleSubmenuClose);
elements.categorySubmenu?.addEventListener('pointerenter', openCategorySubmenu);
elements.categorySubmenu?.addEventListener('pointerleave', scheduleSubmenuClose);

// 窗口失去焦点时关闭右键菜单
window.addEventListener('blur', () => {
    hideContextMenu();
});

// ============================================
// 初始化
// ============================================
async function init() {
    await loadUserPreferences();
    loadCustomCategories();
    await window.__TAURI__.event?.listen('desktop-app-index-changed', async () => {
        appIconCache.clear();
        const pendingScan = scanPromise;
        if (pendingScan) await pendingScan;
        await loadDesktopFiles();
    });
    hydrateCachedDesktopSnapshot();
    await loadDesktopFiles();
    
    await windowController.syncHotzonePosition();
}

init();
