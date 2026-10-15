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
    reconcileFileCategories,
    isValidFileCategoryKey
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
import { createDesktopSpaceView } from './space-view.js';
import { createInteractionGate, createPresentationTransition } from './presentation-controller.js';
import { prepareDesktopHost } from './desktop-host.js';
import { createIconHydrator } from './icon-hydration.js';
import './desktop-host.css';
import {
    getDesktopOrganizerSettings,
    normalizeDesktopOrganizerPresentation,
    updateDesktopOrganizerPresentation
} from '../core/desktopOrganizer.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const isDesktopHost = new URLSearchParams(window.location.search).get('host') === 'desktop';

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
    spaceView: document.getElementById('desktopSpaceView'),
    stage: document.querySelector('.organizer-content'),
    appearanceBtn: document.getElementById('appearanceBtn'),
    appearancePanel: document.getElementById('appearancePanel'),
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
const interactions = isDesktopHost ? { set() {}, clear() {} } : createInteractionGate({ invoke, window });
let presentation = normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings());
presentation.presentation = isDesktopHost ? 'space' : 'classic';
const desktopRegions = isDesktopHost ? prepareDesktopHost({ document, window, invoke }) : null;
let appAssignmentDepth = 0, pendingAppRescan = false;
const windowController = isDesktopHost ? {
    async loadPreferences() {}, async syncHotzonePosition() {}, async cancelInteractions() {}
} : createWindowController({
    invoke,
    appWindow,
    state,
    dragHandle: elements.dragHandle,
    storage: globalThis.localStorage,
    document,
    window,
    setInteraction: interactions.set
});
const loadUserPreferences = windowController.loadPreferences;

const appIconCache = new Map();
const appIconHydrator = createIconHydrator({ invoke, cache: appIconCache, document, window });

async function hydrateVisibleAppIcons(root = document) {
    appIconHydrator.hydrate(root);
}

function rebuildSearchIndex() {
    state.searchIndex = buildSearchIndex(state.files);
}

// ============================================
// 渲染函数
// ============================================
function renderCategoryList() {
    const scrollTop = elements.categoryList.scrollTop;
    elements.categoryList.classList.remove('category-list--folder-view');
    if (!state.files) {
        elements.categoryList.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
            </div>
        `;
        return;
    }
    spaceView.render(presentation);
    elements.categoryList.innerHTML = renderCategoryListMarkup(state);
    elements.categoryList.scrollTop = scrollTop;
    elements.statusText.textContent = `共 ${state.files.total_count} 个项目`;
    queueMicrotask(() => hydrateVisibleAppIcons(elements.categoryList));
    syncViewVisibility();
    restoreSelection();
}

const folderController = createFolderController({
    state,
    categoryList: elements.categoryList,
    invoke,
    setStatus: setDesktopStatus,
    renderCategories: renderCategoryList,
    hydrateIcons: hydrateVisibleAppIcons,
    loadDesktopFiles,
    onRender: syncViewVisibility
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
    refreshCurrentView,
    onRename: (oldPath, newPath) => spaceView.migratePath(oldPath, newPath)
});
const openFile = fileActions.open;
const locateFile = fileActions.locate;
const renameFile = fileActions.rename;
const copyToClipboard = fileActions.copyToClipboard;

const spaceView = createDesktopSpaceView({
    root: elements.spaceView,
    state,
    storage: globalThis.localStorage,
    onSelect: selectFileItem,
    onOpen: async file => {
        if (file.is_folder) {
            spaceView.close();
            await enterFolder({ path: file.path, name: file.name });
        } else await openFile(file.path, file.app_id || '');
    },
    onContextMenu: showContextMenu,
    onAssign: assignSpaceFile,
    hydrateIcons: hydrateVisibleAppIcons,
    onInteraction: active => interactions.set('space', active),
    onError: error => setDesktopStatus(`操作失败 · ${String(error).slice(0, 100)}`)
});
state.groupPresentation = key => spaceView.getGroupDisplay(key);

function syncViewVisibility() {
    const showSpace = presentation.presentation === 'space' && (isDesktopHost || !state.isSearching && !state.folderView.active);
    elements.spaceView.hidden = !showSpace;
    elements.categoryList.hidden = isDesktopHost ? !state.folderView.active || presentation.presentation !== 'space' : showSpace || state.isSearching;
    elements.categoryList.style.display = elements.categoryList.hidden ? 'none' : 'block';
    elements.searchResults.hidden = !state.isSearching || isDesktopHost && presentation.presentation !== 'space';
    elements.searchResults.style.display = elements.searchResults.hidden ? 'none' : 'block';
    desktopRegions?.schedule();
}
function currentView() {
    return state.isSearching ? elements.searchResults : state.folderView.active || presentation.presentation === 'classic'
        ? elements.categoryList : elements.spaceView;
}
function restoreSelection() {
    if (!state.selectedFile) return;
    for (const item of currentView().querySelectorAll('.file-item')) {
        item.classList.toggle('selected', item.dataset.path === state.selectedFile.path);
    }
}
async function assignSpaceFile(file, categoryKey) {
    if (!isValidFileCategoryKey(categoryKey, state.customCategories)) throw new Error('分类已不存在，请刷新后重试');
    if (!file.app_id) {
        const next = { ...state.fileCategories, [file.path]: categoryKey };
        // Commit persistence before the drag replaces its placeholder. A failed
        // write leaves both the original category and the live source node intact.
        globalThis.localStorage.setItem('desktop_organizer_file_categories', JSON.stringify(next));
        state.fileCategories = next;
        return;
    }
    appAssignmentDepth++;
    try {
        const category = categoryKey.startsWith('app_category_')
            ? decodeURIComponent(categoryKey.slice('app_category_'.length)) : categoryKey;
        await invoke('desktop_save_app', { request: {
            path: file.path, name: file.name, category, hidden: false,
            manual: !!file.app_manual, iconPath: null
        } });
        file.app_category = category;
        const live = state.files?.applications?.find(app => app.app_id === file.app_id);
        if (live) live.app_category = category;
    } finally {
        appAssignmentDepth--;
        // The file grid commits its placeholder before an app-index refresh can render.
        if (!appAssignmentDepth && pendingAppRescan) {
            pendingAppRescan = false;
            setTimeout(() => void loadDesktopFiles(), 400);
        }
    }
}

const presentationTransition = createPresentationTransition({
    stage: elements.stage, getView: currentView,
    reducedMotion: () => presentation.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
});
function syncAppearanceControls() {
    document.body.dataset.appearance = presentation.appearance;
    document.body.dataset.presentation = presentation.presentation;
    document.body.dataset.reducedMotion = String(presentation.reducedMotion);
    for (const [attribute, key] of [['presentationChoice', 'presentation'], ['layoutChoice', 'layout'], ['appearanceChoice', 'appearance']]) {
        elements.appearancePanel.querySelectorAll(`[data-${attribute.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`).forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset[attribute] === presentation[key]));
        });
    }
    document.getElementById('spaceLayoutChoices').hidden = presentation.presentation !== 'space';
    document.getElementById('organizerReducedMotion').checked = presentation.reducedMotion;
}
function applyPresentation(settings, { animate = true } = {}) {
    const next = normalizeDesktopOrganizerPresentation(settings);
    // Each native host owns one presentation. Keep its current view intact
    // while native retires or hides it, including before the IPC is dispatched.
    if (next.presentation !== (isDesktopHost ? 'space' : 'classic')) return;
    if (JSON.stringify(next) === JSON.stringify(presentation)) return;
    const oldView = currentView(), focused = document.activeElement;
    const scroll = { classic: elements.categoryList.scrollTop, search: elements.searchResults.scrollTop };
    const render = () => {
        presentation = next;
        spaceView.close();
        syncAppearanceControls();
        spaceView.render(presentation);
        if (!state.folderView.active && state.files) elements.categoryList.innerHTML = renderCategoryListMarkup(state);
        elements.categoryList.scrollTop = scroll.classic;
        elements.searchResults.scrollTop = scroll.search;
        syncViewVisibility(); restoreSelection();
        if (oldView.contains(focused)) {
            const match = [...currentView().querySelectorAll('.file-item')].find(item => item.dataset.path === state.selectedFile?.path && item.getClientRects().length);
            (match || elements.searchInput).focus({ preventScroll: true });
        }
        queueMicrotask(() => hydrateVisibleAppIcons(currentView()));
    };
    if (animate && !next.reducedMotion) presentationTransition.run(render);
    else { presentationTransition.cancel(); render(); }
    desktopRegions?.schedule();
}
let appearanceAnimation = null;
function closeAppearance() {
    appearanceAnimation?.cancel();
    elements.appearancePanel.hidden = true;
    elements.appearanceBtn.setAttribute('aria-expanded', 'false');
    interactions.set('appearance', false);
}
elements.appearanceBtn.addEventListener('click', () => {
    if (!elements.appearancePanel.hidden) { closeAppearance(); return; }
    spaceView.close(); hideContextMenu(); hideBlankContextMenu();
    elements.appearancePanel.hidden = false;
    desktopRegions?.positionPopover();
    elements.appearanceBtn.setAttribute('aria-expanded', 'true');
    interactions.set('appearance', true);
    if (!presentation.reducedMotion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        appearanceAnimation = elements.appearancePanel.animate([{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }], { duration: 230, easing: 'cubic-bezier(.22,.75,.25,1)' });
    }
});
elements.appearancePanel.addEventListener('click', async event => {
    if (event.target.closest('[data-appearance-close]')) { closeAppearance(); elements.appearanceBtn.focus({ preventScroll: true }); return; }
    const button = event.target.closest('[data-presentation-choice], [data-layout-choice], [data-appearance-choice]');
    if (!button) return;
    const patch = button.dataset.presentationChoice ? { presentation: button.dataset.presentationChoice }
        : button.dataset.layoutChoice ? { layout: button.dataset.layoutChoice } : { appearance: button.dataset.appearanceChoice };
    if (isDesktopHost && !button.dataset.presentationChoice) patch.presentation = 'space';
    try {
        await updateDesktopOrganizerPresentation(patch);
        applyPresentation(getDesktopOrganizerSettings());
    }
    catch (error) { document.getElementById('appearanceFeedback').textContent = `保存失败：${error}`; }
});
document.getElementById('organizerReducedMotion').addEventListener('change', async event => {
    try {
        await updateDesktopOrganizerPresentation({ reducedMotion: event.target.checked, ...(isDesktopHost ? { presentation: 'space' } : {}) });
        applyPresentation(getDesktopOrganizerSettings());
    }
    catch (error) { document.getElementById('appearanceFeedback').textContent = `保存失败：${error}`; }
});
window.addEventListener('dtkit:desktop-organizer-presentation-changed', () => applyPresentation(getDesktopOrganizerSettings()));
window.addEventListener('storage', event => {
    if (event.key === 'dtkit_desktop_organizer') applyPresentation(getDesktopOrganizerSettings());
    if (event.key === 'dtkit_desktop_space_v1') {
        spaceView.reloadMetadata();
        if (!state.folderView.active) renderCategoryList();
    }
});
document.addEventListener('click', event => {
    if (!elements.appearancePanel.contains(event.target) && !elements.appearanceBtn.contains(event.target)) closeAppearance();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.appearancePanel.hidden) { event.preventDefault(); closeAppearance(); elements.appearanceBtn.focus({ preventScroll: true }); }
});
function toggleDesktopSearch(open) {
    if (!isDesktopHost) return;
    const container = elements.searchInput.closest('.search-container');
    container.hidden = !open;
    document.getElementById('desktopSearchButton').setAttribute('aria-expanded', String(open));
    if (open) {
        spaceView.close(); closeAppearance();
        elements.searchInput.focus({ preventScroll: true });
    } else {
        elements.searchInput.value = '';
        elements.searchInput.dispatchEvent(new Event('input'));
    }
    desktopRegions.schedule();
}
document.getElementById('desktopSearchButton').addEventListener('click', () => {
    toggleDesktopSearch(elements.searchInput.closest('.search-container').hidden);
});
document.getElementById('desktopCategoryButton').addEventListener('click', () => {
    spaceView.close(); closeAppearance(); showCreateCategoryDialog();
});
const legacyPopupObserver = new MutationObserver(() => {
    const open = [elements.contextMenu, elements.blankContextMenu, elements.renameDialog, elements.createCategoryDialog, elements.manageCategoriesDialog]
        .some(element => getComputedStyle(element).display !== 'none');
    interactions.set('legacy-popup', open);
});
for (const element of [elements.contextMenu, elements.blankContextMenu, elements.renameDialog, elements.createCategoryDialog, elements.manageCategoriesDialog]) {
    legacyPopupObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
}
syncAppearanceControls();
syncViewVisibility();

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
            key => isValidFileCategoryKey(key, state.customCategories)
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
    const root = currentItem.closest('#searchResultsList, .folder-browser__list, .category-files, .space-file-grid')
        || (state.isSearching ? elements.searchResultsList : elements.categoryList);
    return [...root.querySelectorAll('.file-item')]
        .filter(item => item.getClientRects().length > 0 && !item.closest('[data-presentation-ghost]'));
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
    if (e.target.closest?.('#appearancePanel, .space-editor')) return;
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
            if (isDesktopHost) toggleDesktopSearch(false);
        }
        return;
    }

    const focusedFile = e.target.closest?.('.file-item');
    if (focusedFile && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        if (moveFileFocus(focusedFile, e.key)) e.preventDefault();
        return;
    }
    
    // 获取当前选中的文件
    const selectedItem = [...currentView().querySelectorAll('.file-item.selected')]
        .find(item => item.getClientRects().length && !item.closest('[hidden], [data-presentation-ghost]'));
    
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
        if (isDesktopHost) toggleDesktopSearch(true);
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
        if (item.closest('[data-presentation-ghost]')) return;
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
    if (isDesktopHost && e.target.closest('.space-view, .desktop-tools, .appearance-panel')) return;
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
    syncViewVisibility();
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
        closeAppearance();
        spaceView.close();
        presentationTransition.cancel();
        
        await windowController.cancelInteractions();
        interactions.clear();
    } else {
        applyPresentation(getDesktopOrganizerSettings(), { animate: false });
        if (Date.now() - lastSuccessfulScanAt < LIVE_RESCAN_INTERVAL_MS) return;
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
    if (isDesktopHost) {
        hideBlankContextMenu(); closeAppearance();
        // Explorer receives clicks outside the shaped window, so its blank area
        // cannot generate a DOM click. Losing focus closes temporary surfaces,
        // while an unfinished name edit stays available when the user returns.
        if (elements.spaceView.querySelector('.space-overlay')?.hidden) spaceView.closeTransients();
        if (!elements.searchInput.closest('.search-container').hidden) toggleDesktopSearch(false);
    }
});

// ============================================
// 初始化
// ============================================
async function init() {
    await loadUserPreferences();
    loadCustomCategories();
    await window.__TAURI__.event?.listen('desktop-app-index-changed', async () => {
        appIconCache.clear();
        if (appAssignmentDepth) { pendingAppRescan = true; return; }
        const pendingScan = scanPromise;
        if (pendingScan) await pendingScan;
        await loadDesktopFiles();
    });
    await window.__TAURI__.event?.listen('desktop-organizer-presentation-changed', () => {
        // Native acknowledgements can complete out of order during rapid clicks.
        // Shared persisted preferences always contain the latest complete choice.
        applyPresentation(getDesktopOrganizerSettings(), { animate: !document.hidden });
    });
    if (isDesktopHost) {
        await window.__TAURI__.event?.listen('desktop-space-hiding', () => desktopRegions.retire());
        await window.__TAURI__.event?.listen('desktop-organizer-mode-changed', event => {
            const mode = event.payload;
            if (!mode) return;
            if (!mode.enabled || mode.presentation !== 'space') {
                spaceView.close(); closeAppearance(); presentationTransition.cancel();
                elements.panel.hidden = true;
            } else {
                elements.panel.hidden = false;
                applyPresentation({ ...getDesktopOrganizerSettings(), presentation: 'space' });
            }
            desktopRegions.schedule();
        });
        await window.__TAURI__.event?.listen('desktop-space-workarea-changed', event => { spaceView.setDisplays(event.payload?.displays); desktopRegions.setDisplays(event.payload?.displays); desktopRegions.schedule(); });
        await window.__TAURI__.event?.listen('desktop-space-close-transients', () => {
            desktopRegions.cancelGestures(); spaceView.cancelGestures();
            spaceView.closeTransients(); desktopRegions.closeTools(); closeAppearance(); hideContextMenu(); hideBlankContextMenu();
            if (!elements.searchInput.closest('.search-container').hidden) toggleDesktopSearch(false);
        });
        await window.__TAURI__.event?.listen('desktop-space-refresh', () => void loadDesktopFiles());
    }
    hydrateCachedDesktopSnapshot();
    await loadDesktopFiles();
    if (isDesktopHost) {
        const viewport = await invoke('desktop_space_ready');
        spaceView.setDisplays(viewport?.displays);
        desktopRegions.setDisplays(viewport?.displays);
        // Hidden WebViews may suspend animation frames. Initial bounds are read
        // synchronously before native shows the non-empty desktop window region.
        desktopRegions.arrange();
        desktopRegions.start();
        await desktopRegions.flush();
        desktopRegions.enter();
    } else await windowController.syncHotzonePosition();
}

init();

window.addEventListener('pagehide', () => {
    appIconHydrator.destroy();
    presentationTransition.cancel();
    spaceView.destroy();
    legacyPopupObserver.disconnect();
    desktopRegions?.destroy();
    interactions.clear();
});
