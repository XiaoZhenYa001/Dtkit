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
    collectApplicationCategoryGroups,
    migrateFileCategory,
    reconcileFileCategories,
    resolveApplicationCategoryKey
} from './categories.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// ============================================
// 分类配置
// ============================================
const CATEGORIES = {
    recent: { icon: 'ri-history-line', name: '最近使用', key: 'recent' },
    document: { icon: 'ri-file-text-line', name: '文档', key: 'documents' },
    image: { icon: 'ri-image-line', name: '图片', key: 'images' },
    video: { icon: 'ri-video-line', name: '视频', key: 'videos' },
    audio: { icon: 'ri-music-2-line', name: '音频', key: 'audios' },
    archive: { icon: 'ri-archive-line', name: '压缩包', key: 'archives' },
    program: { icon: 'ri-apps-2-line', name: '程序', key: 'programs' },
    folder: { icon: 'ri-folder-2-line', name: '文件夹', key: 'folders' },
    other: { icon: 'ri-attachment-2', name: '其他', key: 'others' },
};

// 命令模式映射
const COMMAND_MAP = {
    '/d': 'document',
    '/p': 'image',
    '/v': 'video',
    '/a': 'program',
    '/f': 'folder',
    '/z': 'archive',
};

// ============================================
// 状态管理
// ============================================
let state = {
    files: null,          // 分类后的文件数据
    expandedCategories: new Set(['recent']), // 展开的分类
    selectedFile: null,   // 选中的文件
    searchQuery: '',      // 搜索关键词
    searchResults: [],    // 搜索结果
    searchIndex: [],      // 单次扫描生成的轻量搜索索引
    isSearching: false,   // 是否在搜索模式
    customCategories: [], // 自定义分类
    fileCategories: {},   // 文件到分类的映射 { filePath: categoryKey }
    folderView: {
        active: false,
        stack: [],
        categoryScrollTop: 0,
    },
};
const folderCache = new Map();
const FOLDER_CACHE_LIMIT = 8;
let folderRequestGeneration = 0;

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

// ============================================
// 工具函数
// ============================================
function formatFileSize(bytes) {
    if (bytes === 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let index = 0;
    let size = bytes;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index++;
    }
    return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function getFileIcon(file) {
    // 如果有真实图标，返回 img 标签
    if (file.icon) {
        return `<img src="${file.icon}" class="file-icon-img" alt="" loading="lazy">`;
    }
    
    if (file.is_folder) return '<i class="ri-folder-2-line"></i>';
    
    const iconMap = {
        document: '<i class="ri-file-text-line"></i>',
        image: '<i class="ri-image-line"></i>',
        video: '<i class="ri-video-line"></i>',
        audio: '<i class="ri-music-2-line"></i>',
        archive: '<i class="ri-archive-line"></i>',
        program: '<i class="ri-apps-2-line"></i>',
        other: '<i class="ri-attachment-2"></i>',
    };
    return iconMap[file.category] || iconMap.document;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function escapeAttribute(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapeHtml(text).replace(regex, '<span class="search-highlight">$1</span>');
}

const SEARCH_CATEGORY_KEYS = ['documents', 'images', 'videos', 'audios', 'archives', 'programs', 'folders', 'others', 'applications'];
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
    const sourceRank = file => file.app_manual ? 0 : file.app_id ? 2 : 1;
    const seenNames = new Set();
    state.searchIndex = SEARCH_CATEGORY_KEYS
        .flatMap(key => state.files?.[key] || [])
        .sort((left, right) => sourceRank(left) - sourceRank(right))
        .filter(file => {
            const name = file.name.trim().replace(/\.(exe|lnk|url)$/i, '').toLocaleLowerCase();
            if (!name || seenNames.has(name)) return false;
            seenNames.add(name);
            return true;
        })
        .map(file => ({ file, normalizedName: file.name.toLocaleLowerCase() }));
}

function filesForCategory(categoryKey) {
    const applications = state.files?.applications || [];
    if (categoryKey === 'managed-apps') {
        return applications.filter(file => file.app_manual);
    }
    if (categoryKey.startsWith('custom_')) {
        const files = state.searchIndex
            .filter(entry => !entry.file.app_id && state.fileCategories[entry.file.path] === categoryKey)
            .map(entry => entry.file);
        const categoryApps = applications.filter(file =>
            resolveApplicationCategoryKey(file, state.customCategories) === categoryKey);
        return [...files, ...categoryApps];
    }
    if (categoryKey.startsWith('app_category_')) {
        return applications.filter(file =>
            resolveApplicationCategoryKey(file, state.customCategories) === categoryKey);
    }

    const config = CATEGORIES[categoryKey];
    if (!config) return [];
    const files = state.files?.[config.key] || [];
    const categoryApps = applications.filter(file =>
        resolveApplicationCategoryKey(file, state.customCategories) === categoryKey);
    if (categoryKey === 'recent') return [...files, ...categoryApps];
    const uncategorizedFiles = files.filter(file => !state.fileCategories[file.path]);
    return [...uncategorizedFiles, ...categoryApps];
}

function categoryFilesMarkup(categoryKey, files) {
    if (files.length) return renderFileList(files);
    return categoryKey.startsWith('custom_')
        ? '<div class="empty-category-hint">右键文件并选择“移动到分类”</div>'
        : '';
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

    const categoryOrder = ['recent', 'document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other'];
    let html = '';

    const manualApps = (state.files.applications || []).filter(file => file.app_manual);
    if (manualApps.length) {
        const categoryKey = 'managed-apps';
        const isExpanded = state.expandedCategories.has(categoryKey);
        html += `<div class="category-item managed-app-category ${isExpanded ? 'expanded' : ''}" data-category="${categoryKey}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${categoryKey}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="ri-apps-2-line"></i></span><span class="category-name">我的应用</span><span class="category-count">${manualApps.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(categoryKey, manualApps) : ''}</div></div>`;
    }

    // 先渲染自定义分类（即使是空的也显示）
    for (const cat of state.customCategories) {
        const files = filesForCategory(cat.key);
        const isExpanded = state.expandedCategories.has(cat.key);
        html += `
            <div class="category-item custom-category ${isExpanded ? 'expanded' : ''}" data-category="${cat.key}" data-files-rendered="${isExpanded}">
                <button class="category-header" type="button" data-category="${cat.key}" aria-expanded="${isExpanded}">
                    <span class="category-icon">${cat.icon}</span>
                    <span class="category-name">${escapeHtml(cat.name)}</span>
                    <span class="category-count">${files.length}</span>
                    <span class="category-arrow">▶</span>
                </button>
                <div class="category-files">
                    ${isExpanded ? categoryFilesMarkup(cat.key, files) : ''}
                </div>
            </div>
        `;
    }

    for (const category of collectApplicationCategoryGroups(state.files.applications, state.customCategories)) {
        const files = filesForCategory(category.key);
        const isExpanded = state.expandedCategories.has(category.key);
        html += `
            <div class="category-item app-category ${isExpanded ? 'expanded' : ''}" data-category="${escapeAttribute(category.key)}" data-files-rendered="${isExpanded}">
                <button class="category-header" type="button" data-category="${escapeAttribute(category.key)}" aria-expanded="${isExpanded}">
                    <span class="category-icon"><i class="ri-apps-2-line"></i></span>
                    <span class="category-name">${escapeHtml(category.name)}</span>
                    <span class="category-count">${files.length}</span>
                    <span class="category-arrow">▶</span>
                </button>
                <div class="category-files">${isExpanded ? categoryFilesMarkup(category.key, files) : ''}</div>
            </div>
        `;
    }

    // 渲染默认分类
    for (const catKey of categoryOrder) {
        const catConfig = CATEGORIES[catKey];
        const files = filesForCategory(catKey);
        
        if (files.length === 0) continue;

        const isExpanded = state.expandedCategories.has(catKey);
        
        html += `
            <div class="category-item ${isExpanded ? 'expanded' : ''}" data-category="${catKey}" data-files-rendered="${isExpanded}">
                <button class="category-header" type="button" data-category="${catKey}" aria-expanded="${isExpanded}">
                    <span class="category-icon"><i class="${catConfig.icon}"></i></span>
                    <span class="category-name">${catConfig.name}</span>
                    <span class="category-count">${files.length}</span>
                    <span class="category-arrow">▶</span>
                </button>
                <div class="category-files">
                    ${isExpanded ? categoryFilesMarkup(catKey, files) : ''}
                </div>
            </div>
        `;
    }

    if (!html) {
        html = `
            <div class="empty-state">
                <div class="empty-state-icon">📂</div>
                <div class="empty-state-text">桌面没有文件</div>
            </div>
        `;
    }

    elements.categoryList.innerHTML = html;
    elements.statusText.textContent = `共 ${state.files.total_count} 个项目`;
    queueMicrotask(() => hydrateVisibleAppIcons(elements.categoryList));
}

function renderFileList(files) {
    return files.map(file => {
        const iconContent = getFileIcon(file);
        const isImgIcon = Boolean(file.icon);
        const trailingContent = file.is_folder
            ? '<span class="folder-drill">浏览 <i class="ri-arrow-right-s-line"></i></span>'
            : `<span class="file-size">${formatFileSize(file.size)}</span>`;
        return `
        <button type="button" class="file-item${file.is_folder ? ' file-item--folder' : ''}" data-path="${escapeAttribute(file.path)}" data-name="${escapeAttribute(file.name)}" data-is-folder="${file.is_folder ? 'true' : 'false'}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''}>
            <span class="file-icon${isImgIcon ? ' file-icon-real' : ''}">${iconContent}</span>
            <span class="file-name">${escapeHtml(file.name)}</span>
            ${trailingContent}
        </button>
    `}).join('');
}

function renderFolderBreadcrumb() {
    const segments = [
        '<button class="folder-browser__crumb" type="button" data-folder-depth="-1">桌面</button>'
    ];
    state.folderView.stack.forEach((folder, index) => {
        segments.push('<i class="ri-arrow-right-s-line" aria-hidden="true"></i>');
        segments.push(`<button class="folder-browser__crumb${index === state.folderView.stack.length - 1 ? ' is-current' : ''}" type="button" data-folder-depth="${index}" title="${escapeAttribute(folder.path)}">${escapeHtml(folder.name)}</button>`);
    });
    return segments.join('');
}

function readCachedFolder(path) {
    const cached = folderCache.get(path);
    if (!cached) return null;
    folderCache.delete(path);
    folderCache.set(path, cached);
    return cached;
}

function cacheFolder(path, contents) {
    folderCache.delete(path);
    folderCache.set(path, contents);
    while (folderCache.size > FOLDER_CACHE_LIMIT) {
        folderCache.delete(folderCache.keys().next().value);
    }
}

function renderFolderBrowser(contents = null, { syncing = false, error = null } = {}) {
    const currentFolder = state.folderView.stack.at(-1);
    if (!currentFolder) return;

    const items = contents?.items || [];
    const count = contents?.total_count ?? items.length;
    const folderBody = contents
        ? (items.length > 0
            ? renderFileList(items)
            : `<div class="folder-browser__empty"><span><i class="ri-folder-open-line"></i></span><strong>这个文件夹是空的</strong><small>新增内容后点击右上角刷新即可。</small></div>`)
        : (error
            ? `<div class="folder-browser__empty folder-browser__empty--error"><span><i class="ri-error-warning-line"></i></span><strong>暂时无法读取</strong><small>${escapeHtml(String(error))}</small></div>`
            : `<div class="folder-browser__loading" aria-label="正在读取文件夹"><i class="ri-loader-4-line"></i><span>正在读取文件夹…</span></div>`);

    elements.categoryList.classList.add('category-list--folder-view');
    elements.categoryList.innerHTML = `
        <section class="folder-browser" aria-label="文件夹浏览">
            <header class="folder-browser__toolbar">
                <button class="folder-browser__back" type="button" data-folder-back aria-label="返回上一层" title="返回上一层"><i class="ri-arrow-left-line"></i></button>
                <div class="folder-browser__identity">
                    <span>正在浏览</span>
                    <nav class="folder-browser__breadcrumb" aria-label="当前位置">${renderFolderBreadcrumb()}</nav>
                </div>
                <div class="folder-browser__actions">
                    <button type="button" data-folder-refresh aria-label="刷新当前文件夹" title="刷新当前文件夹"><i class="ri-refresh-line${syncing ? ' is-spinning' : ''}"></i></button>
                    <button type="button" data-folder-external aria-label="在资源管理器中打开" title="在资源管理器中打开"><i class="ri-folder-open-line"></i></button>
                </div>
            </header>
            <div class="folder-browser__summary">
                <span><i class="ri-folder-2-line"></i>${escapeHtml(currentFolder.name)}</span>
                <span class="folder-browser__sync-state">${syncing ? '正在同步…' : (error && contents ? '同步失败，显示缓存' : `${count} 个项目`)}</span>
            </div>
            <div class="folder-browser__list">${folderBody}</div>
            ${contents?.truncated ? `<footer class="folder-browser__limit"><i class="ri-information-line"></i>内容较多，仅显示前 ${items.length} 项，共 ${count} 项</footer>` : ''}
        </section>
    `;

    if (syncing) {
        setDesktopStatus(`正在同步 · ${currentFolder.name}`);
    } else if (error && contents) {
        setDesktopStatus(`显示缓存 · ${currentFolder.name} · 同步失败`);
    } else if (error) {
        setDesktopStatus(`读取失败 · ${currentFolder.name}`);
    } else {
        setDesktopStatus(`${currentFolder.name} · ${count} 个项目`);
    }
}

async function enterFolder(folder, { push = true } = {}) {
    if (!folder?.path) return;

    if (!state.folderView.active) {
        state.folderView.categoryScrollTop = elements.categoryList.scrollTop;
    }
    if (push) {
        state.folderView.stack.push({ path: folder.path, name: folder.name || '文件夹' });
    }
    state.folderView.active = true;
    state.selectedFile = null;

    const generation = ++folderRequestGeneration;
    const cached = readCachedFolder(folder.path);
    renderFolderBrowser(cached, { syncing: true });

    try {
        const contents = await invoke('desktop_list_folder', { path: folder.path });
        if (generation !== folderRequestGeneration || state.folderView.stack.at(-1)?.path !== folder.path) return;
        cacheFolder(folder.path, contents);
        renderFolderBrowser(contents);
    } catch (error) {
        if (generation !== folderRequestGeneration || state.folderView.stack.at(-1)?.path !== folder.path) return;
        console.error('读取文件夹失败:', error);
        renderFolderBrowser(cached, { error });
    }
}

function leaveFolderBrowser() {
    folderRequestGeneration++;
    state.folderView.active = false;
    state.folderView.stack = [];
    state.selectedFile = null;
    const scrollTop = state.folderView.categoryScrollTop;
    renderCategoryList();
    requestAnimationFrame(() => {
        elements.categoryList.scrollTop = scrollTop;
    });
}

function navigateFolderBack() {
    if (!state.folderView.active) return;
    if (state.folderView.stack.length <= 1) {
        leaveFolderBrowser();
        return;
    }

    state.folderView.stack.pop();
    enterFolder(state.folderView.stack.at(-1), { push: false });
}

function navigateFolderDepth(depth) {
    if (depth < 0) {
        leaveFolderBrowser();
        return;
    }
    if (depth >= state.folderView.stack.length) return;
    state.folderView.stack = state.folderView.stack.slice(0, depth + 1);
    enterFolder(state.folderView.stack.at(-1), { push: false });
}

function refreshCurrentView() {
    if (state.folderView.active) {
        const currentFolder = state.folderView.stack.at(-1);
        if (currentFolder) return enterFolder(currentFolder, { push: false });
    }
    return loadDesktopFiles();
}

function renderSearchResults() {
    if (state.searchResults.length === 0) {
        elements.searchResultsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-text">未找到匹配的文件</div>
            </div>
        `;
        elements.searchResultsCount.textContent = '0';
        return;
    }

    elements.searchResultsCount.textContent = state.searchResults.length;
    
    const query = state.searchQuery.replace(/^\/[a-z]\s*/i, ''); // 移除命令前缀
    
    elements.searchResultsList.innerHTML = state.searchResults.map(file => `
        <button type="button" class="file-item${file.is_folder ? ' file-item--folder' : ''}" data-path="${escapeAttribute(file.path)}" data-name="${escapeAttribute(file.name)}" data-is-folder="${file.is_folder ? 'true' : 'false'}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''}>
            <span class="file-icon">${getFileIcon(file)}</span>
            <span class="file-name">${highlightText(file.name, query)}</span>
            <span class="file-size">${file.is_folder ? '→' : formatFileSize(file.size)}</span>
        </button>
    `).join('');
    queueMicrotask(() => hydrateVisibleAppIcons(elements.searchResultsList));
}

// ============================================
// 自定义分类管理
// ============================================
const CUSTOM_CATEGORIES_KEY = 'desktop_organizer_custom_categories';
const FILE_CATEGORIES_KEY = 'desktop_organizer_file_categories';
const CATEGORY_ICONS = new Set(['📁', '⭐', '💼', '🎮', '🛠️', '📚', '🎨', '💡', '🔧', '📝', '🎯', '🚀']);

// 加载自定义分类
function loadCustomCategories() {
    try {
        const saved = localStorage.getItem(CUSTOM_CATEGORIES_KEY);
        const parsedCategories = saved ? JSON.parse(saved) : [];
        state.customCategories = (Array.isArray(parsedCategories) ? parsedCategories : [])
            .filter(category => category && /^custom_\d+$/.test(category.key) && typeof category.name === 'string')
            .slice(0, 50)
            .map(category => ({ key: category.key, name: category.name.trim().slice(0, 40), icon: CATEGORY_ICONS.has(category.icon) ? category.icon : '📁' }))
            .filter(category => category.name);
        
        const fileCategories = localStorage.getItem(FILE_CATEGORIES_KEY);
        const parsedAssignments = fileCategories ? JSON.parse(fileCategories) : {};
        const validKeys = new Set(state.customCategories.map(category => category.key));
        state.fileCategories = Object.fromEntries(Object.entries(parsedAssignments || {})
            .filter(([path, key]) => typeof path === 'string' && path.length <= 1024 && validKeys.has(key))
            .slice(0, 1000));
    } catch (e) {
        console.error('加载自定义分类失败:', e);
        state.customCategories = [];
        state.fileCategories = {};
    }
}

// 保存自定义分类
function saveCustomCategories() {
    try {
        localStorage.setItem(CUSTOM_CATEGORIES_KEY, JSON.stringify(state.customCategories));
        localStorage.setItem(FILE_CATEGORIES_KEY, JSON.stringify(state.fileCategories));
    } catch (e) {
        console.error('保存自定义分类失败:', e);
    }
}

// 创建新分类
function createCategory(name, icon) {
    name = name.trim().slice(0, 40);
    if (!name || state.customCategories.some(category => category.name === name)) return null;
    const key = `custom_${Date.now()}`;
    const newCategory = { key, name, icon: CATEGORY_ICONS.has(icon) ? icon : '📁' };
    state.customCategories.push(newCategory);
    saveCustomCategories();
    renderCategoryList();
    return newCategory;
}

// 删除分类
function deleteCategory(key) {
    state.customCategories = state.customCategories.filter(c => c.key !== key);
    // 移除该分类下的所有文件映射
    for (const [filePath, catKey] of Object.entries(state.fileCategories)) {
        if (catKey === key) {
            delete state.fileCategories[filePath];
        }
    }
    saveCustomCategories();
    renderCategoryList();
}

// 将文件移动到分类
function moveFileToCategory(filePath, categoryKey) {
    if (categoryKey === null) {
        delete state.fileCategories[filePath];
    } else {
        state.fileCategories[filePath] = categoryKey;
    }
    saveCustomCategories();
    renderCategoryList();
}

// 获取文件所属的自定义分类
function getFileCustomCategory(filePath) {
    return state.fileCategories[filePath] || null;
}

// 更新分类子菜单
function updateCategorySubmenu() {
    if (!elements.categorySubmenu) return;
    
    let html = `
        <div class="submenu-item" data-category="null">
            <span class="submenu-icon">🔄</span>
            <span class="submenu-text">恢复默认分类</span>
        </div>
    `;
    
    if (state.customCategories.length > 0) {
        html += '<div class="submenu-divider"></div>';
        html += state.customCategories.map(cat => `
            <div class="submenu-item" data-category="${cat.key}">
                <span class="submenu-icon">${cat.icon}</span>
                <span class="submenu-text">${escapeHtml(cat.name)}</span>
            </div>
        `).join('');
    }
    
    elements.categorySubmenu.innerHTML = html;
}

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
    // 解析命令模式
    let categoryFilter = null;
    let searchTerm = query;
    
    for (const [cmd, cat] of Object.entries(COMMAND_MAP)) {
        if (query.toLowerCase().startsWith(cmd)) {
            categoryFilter = cat;
            searchTerm = query.slice(cmd.length).trim();
            break;
        }
    }

    if (!searchTerm && !categoryFilter) {
        state.searchResults = [];
        renderSearchResults();
        return;
    }

    const normalizedTerm = searchTerm.toLocaleLowerCase();
    state.searchResults = state.searchIndex
        .filter(({ file, normalizedName }) =>
            (!categoryFilter || file.category === categoryFilter)
            && (!normalizedTerm || normalizedName.includes(normalizedTerm)))
        .slice(0, 200)
        .map(entry => entry.file);
    renderSearchResults();
}

// ============================================
// 文件操作
// ============================================
async function openFile(path, appId = '') {
    try {
        await invoke(appId ? 'desktop_open_app' : 'desktop_open_file', { path });
    } catch (error) {
        console.error('打开文件失败:', error);
        setDesktopStatus(`打开失败 · ${String(error)}`);
    }
}

async function locateFile(path, appId = '') {
    try {
        await invoke(appId ? 'desktop_locate_app' : 'desktop_locate_file', { path });
    } catch (error) {
        console.error('定位文件失败:', error);
        setDesktopStatus(`定位失败 · ${String(error)}`);
    }
}

async function renameFile(oldPath, newName) {
    try {
        const newPath = await invoke('desktop_rename_file', { oldPath, newName });
        const migratedCategories = migrateFileCategory(state.fileCategories, oldPath, newPath);
        if (migratedCategories !== state.fileCategories) {
            state.fileCategories = migratedCategories;
            saveCustomCategories();
        }
        await loadDesktopFiles();
        if (state.folderView.active) await refreshCurrentView();
    } catch (error) {
        console.error('重命名失败:', error);
        alert('重命名失败: ' + error);
    }
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (error) {
        console.error('复制失败:', error);
    }
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
            filesContainer.innerHTML = categoryFilesMarkup(category, filesForCategory(category));
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
        
        // 立即清除拖动和resize状态，防止再次显示时保持这些状态
        if (isDraggingPosition || isResizing) {
            isDraggingPosition = false;
            isResizing = false;
            document.body.style.cursor = '';
            document.body.classList.remove('is-dragging', 'is-resizing');
            if (elements.dragHandle) {
                elements.dragHandle.style.cursor = '';
            }
            
            // 清除超时
            if (resizeEndTimeout) {
                clearTimeout(resizeEndTimeout);
                resizeEndTimeout = null;
            }
            
            // 通知结束交互
            await notifyUserInteracting(false);
        }
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

let isResizing = false;
let resizeDirection = '';
let startX, startY, startWidth, startHeight, startWindowX, startWindowY;
let resizeEndTimeout = null;
const appWindow = getCurrentWindow();
let screenBounds = { x: 0, y: 0, width: 1920, height: 1080 }; // 当前显示器物理边界
let lastUpdateTime = 0; // 节流控制
let resizeUpdatePending = false;

// 通知 Rust 端用户正在交互（拖动中）
async function notifyUserInteracting(interacting) {
    try {
        window.__userInteracting = interacting;
        // 通知Rust端，阻止热区在用户交互时隐藏窗口
        await invoke('set_user_interacting', { interacting });
    } catch (e) {
        // 忽略错误，如果命令不存在就只设置本地标志
    }
}

// 获取当前窗口尺寸和位置
async function getWindowInfo() {
    const size = await appWindow.innerSize();
    const position = await appWindow.innerPosition();
    return { 
        width: size.width, 
        height: size.height,
        x: position.x,
        y: position.y
    };
}

// 获取并缓存屏幕边界信息
async function updateScreenBounds() {
    try {
        const bounds = await invoke('get_screen_bounds');
        if (bounds) {
            screenBounds = bounds;
        }
    } catch (e) {
        // 使用 DOM API 作为后备
        screenBounds = {
            x: (window.screen.availLeft || 0) * window.devicePixelRatio,
            y: (window.screen.availTop || 0) * window.devicePixelRatio,
            width: window.screen.width * window.devicePixelRatio,
            height: window.screen.height * window.devicePixelRatio
        };
    }
}

// 限制窗口位置在屏幕边界内
function clampPosition(x, y, width, height) {
    const margin = 10; // 边缘安全距离
    const left = (screenBounds.x || 0) + margin;
    const top = (screenBounds.y || 0) + margin;
    const right = (screenBounds.x || 0) + screenBounds.width - width - margin;
    const bottom = (screenBounds.y || 0) + screenBounds.height - height - margin;
    return {
        x: Math.max(left, Math.min(Math.max(left, right), x)),
        y: Math.max(top, Math.min(Math.max(top, bottom), y))
    };
}

// 限制窗口尺寸
function clampSize(width, height) {
    const minWidth = 400;
    const minHeight = 300;
    const maxWidth = screenBounds.width - 20;
    const maxHeight = screenBounds.height - 20;
    
    return {
        width: Math.max(minWidth, Math.min(maxWidth, width)),
        height: Math.max(minHeight, Math.min(maxHeight, height))
    };
}

document.querySelectorAll('.resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', async (e) => {
        // 防止与拖动冲突
        if (isDraggingPosition) return;
        
        isResizing = true;
        resizeDirection = handle.dataset.direction;
        startX = e.screenX;
        startY = e.screenY;
        
        // 获取当前窗口尺寸和位置
        const info = await getWindowInfo();
        startWidth = info.width;
        startHeight = info.height;
        startWindowX = info.x;
        startWindowY = info.y;
        
        // 更新屏幕边界
        await updateScreenBounds();
        
        document.body.style.cursor = getComputedStyle(handle).cursor;
        document.body.classList.add('is-resizing');
        e.preventDefault();
        e.stopPropagation();
        
        // 清除之前的超时
        if (resizeEndTimeout) {
            clearTimeout(resizeEndTimeout);
            resizeEndTimeout = null;
        }
        // 立即通知正在交互，阻止热区隐藏
        await notifyUserInteracting(true);
    });
});

document.addEventListener('mousemove', async (e) => {
    if (!isResizing || resizeUpdatePending) return;
    
    // 节流：限制更新频率为60fps
    const now = Date.now();
    if (now - lastUpdateTime < 32) return;
    lastUpdateTime = now;
    
    const deltaX = e.screenX - startX;
    const deltaY = e.screenY - startY;
    
    let newWidth = startWidth;
    let newHeight = startHeight;
    let newX = startWindowX;
    let newY = startWindowY;
    
    // 根据拖动方向计算新尺寸和位置
    switch (resizeDirection) {
        case 'r': // 右边
            newWidth = startWidth + deltaX;
            break;
        case 'l': // 左边
            const widthChange = startWidth - deltaX;
            newWidth = widthChange;
            newX = startWindowX + deltaX;
            break;
        case 'b': // 底部
            newHeight = startHeight + deltaY;
            break;
        case 'br': // 右下角
            newWidth = startWidth + deltaX;
            newHeight = startHeight + deltaY;
            break;
        case 'bl': // 左下角
            const widthChangebl = startWidth - deltaX;
            newWidth = widthChangebl;
            newHeight = startHeight + deltaY;
            newX = startWindowX + deltaX;
            break;
    }
    
    // 应用尺寸限制
    const clampedSize = clampSize(newWidth, newHeight);
    newWidth = clampedSize.width;
    newHeight = clampedSize.height;
    
    // 对于左侧拖动，如果宽度被限制，需要调整x位置
    if (resizeDirection === 'l' || resizeDirection === 'bl') {
        const actualWidthChange = newWidth - startWidth;
        newX = startWindowX - actualWidthChange;
    }
    
    // 应用位置限制
    const clampedPos = clampPosition(newX, newY, newWidth, newHeight);
    newX = clampedPos.x;
    newY = clampedPos.y;
    
    // 使用 Tauri API 调整窗口（批量操作）
    try {
        resizeUpdatePending = true;
        // 先设置尺寸，再设置位置，避免闪烁
        await appWindow.setSize({ type: 'Physical', width: Math.round(newWidth), height: Math.round(newHeight) });
        
        if (resizeDirection === 'l' || resizeDirection === 'bl') {
            await appWindow.setPosition({ type: 'Physical', x: Math.round(newX), y: Math.round(newY) });
        }
    } catch (err) {
        console.error('调整窗口失败:', err);
    } finally {
        resizeUpdatePending = false;
    }
});

document.addEventListener('mouseup', async () => {
    if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.classList.remove('is-resizing');
        
        // 保存用户偏好
        await saveUserPreferences();
        
        // 延迟通知结束交互，给保存操作时间完成
        resizeEndTimeout = setTimeout(async () => {
            await notifyUserInteracting(false);
            resizeEndTimeout = null;
        }, 300);
    }
});

// 防止在调整大小时出现文本选择
document.addEventListener('selectstart', (e) => {
    if (isResizing || isDraggingPosition) {
        e.preventDefault();
    }
});

// ============================================
// 用户偏好
// ============================================
async function loadUserPreferences() {
    let prefs = null;
    try {
        const saved = localStorage.getItem('desktopOrganizerPrefs');
        prefs = saved ? JSON.parse(saved) : null;
    } catch {
        localStorage.removeItem('desktopOrganizerPrefs');
    }

    try {
        if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
            const { width, height, positionX, expandedCategories } = prefs;
            if (Number.isFinite(width) && Number.isFinite(height) && width >= 400 && height >= 300) {
                await appWindow.setSize({ type: 'Physical', width: Math.round(width), height: Math.round(height) });
            }
            if (Number.isFinite(positionX)) {
                const position = await appWindow.innerPosition();
                await appWindow.setPosition({ type: 'Physical', x: Math.round(positionX), y: position.y });
            }
            if (Array.isArray(expandedCategories)) {
                state.expandedCategories = new Set(expandedCategories.filter(value => typeof value === 'string').slice(0, 64));
            }
        }
    } catch (error) {
        console.error('加载偏好失败:', error);
    }
    try {
        await invoke('clamp_desktop_organizer_window');
        await saveUserPreferences();
    } catch (error) {
        console.error('校正桌面整理窗口失败:', error);
    }
}

async function saveUserPreferences() {
    try {
        const size = await appWindow.innerSize();
        const position = await appWindow.innerPosition();
        const prefs = {
            width: size.width,
            height: size.height,
            positionX: position.x,
            expandedCategories: Array.from(state.expandedCategories),
        };
        localStorage.setItem('desktopOrganizerPrefs', JSON.stringify(prefs));
        
        // 通知 Rust 端更新热区位置
        try {
            await invoke('update_hotzone_position', { 
                x: position.x, 
                y: position.y,
                width: size.width,
                height: size.height
            });
        } catch (e) {
            // 忽略，可能命令未注册
        }
    } catch (error) {
        console.error('保存偏好失败:', error);
    }
}

// ============================================
// 拖动改变位置（优化版）
// ============================================
let isDraggingPosition = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartWindowX = 0;
let dragStartWindowY = 0;
let dragStartWindowWidth = 0;
let dragStartWindowHeight = 0;
let dragLastUpdateTime = 0;
let dragUpdatePending = false;
let dragMoved = false; // 用于区分点击和拖动

elements.dragHandle?.addEventListener('mousedown', async (e) => {
    // 防止与resize冲突
    if (isResizing) return;
    
    // 只响应左键
    if (e.button !== 0) return;
    
    isDraggingPosition = true;
    dragMoved = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    
    const position = await appWindow.innerPosition();
    const size = await appWindow.innerSize();
    dragStartWindowX = position.x;
    dragStartWindowY = position.y;
    dragStartWindowWidth = size.width;
    dragStartWindowHeight = size.height;
    
    // 更新屏幕边界
    await updateScreenBounds();
    
    document.body.style.cursor = 'grabbing';
    document.body.classList.add('is-dragging');
    elements.dragHandle.style.cursor = 'grabbing';
    
    // 立即通知正在交互，阻止热区隐藏
    await notifyUserInteracting(true);
    e.preventDefault();
});

document.addEventListener('mousemove', async (e) => {
    if (!isDraggingPosition || dragUpdatePending) return;
    
    const moveDistX = Math.abs(e.screenX - dragStartX);
    const moveDistY = Math.abs(e.screenY - dragStartY);
    
    // 判断是否真正移动（防止误触）
    if (!dragMoved && (moveDistX > 3 || moveDistY > 3)) {
        dragMoved = true;
    }
    
    if (!dragMoved) return;
    
    // 节流：限制更新频率为60fps
    const now = Date.now();
    if (now - dragLastUpdateTime < 32) return;
    dragLastUpdateTime = now;
    
    const deltaX = e.screenX - dragStartX;
    const deltaY = e.screenY - dragStartY;
    
    let newX = dragStartWindowX + deltaX;
    let newY = dragStartWindowY + deltaY;
    
    // 应用边界限制
    const clampedPos = clampPosition(newX, newY, dragStartWindowWidth, dragStartWindowHeight);
    newX = clampedPos.x;
    newY = clampedPos.y;
    
    // 磁吸效果：接近屏幕边缘时自动吸附
    const snapDistance = 15;
    const screenLeft = screenBounds.x || 0;
    const screenTop = screenBounds.y || 0;
    const screenRight = screenLeft + screenBounds.width;
    const screenBottom = screenTop + screenBounds.height;
    if (Math.abs(newX - screenLeft) < snapDistance) newX = screenLeft;
    if (Math.abs(newY - screenTop) < snapDistance) newY = screenTop;
    if (Math.abs(newX + dragStartWindowWidth - screenRight) < snapDistance) {
        newX = screenRight - dragStartWindowWidth;
    }
    if (Math.abs(newY + dragStartWindowHeight - screenBottom) < snapDistance) {
        newY = screenBottom - dragStartWindowHeight;
    }
    
    try {
        dragUpdatePending = true;
        await appWindow.setPosition({ 
            type: 'Physical', 
            x: Math.round(newX), 
            y: Math.round(newY) 
        });
    } catch (err) {
        console.error('移动窗口失败:', err);
    } finally {
        dragUpdatePending = false;
    }
});

document.addEventListener('mouseup', async () => {
    if (isDraggingPosition) {
        const wasDragging = isDraggingPosition;
        isDraggingPosition = false;
        document.body.style.cursor = '';
        document.body.classList.remove('is-dragging');
        elements.dragHandle.style.cursor = '';
        
        // 只有真正拖动过才保存
        if (dragMoved) {
            await saveUserPreferences();
        }
        
        // 延迟通知结束交互，给保存操作时间完成
        if (wasDragging) {
            setTimeout(async () => {
                await notifyUserInteracting(false);
            }, 300);
        }
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
        const pendingScan = scanPromise;
        if (pendingScan) await pendingScan;
        await loadDesktopFiles();
    });
    hydrateCachedDesktopSnapshot();
    await loadDesktopFiles();
    
    // 初始化时同步热区位置
    try {
        const size = await appWindow.innerSize();
        const position = await appWindow.innerPosition();
        await invoke('update_hotzone_position', { 
            x: position.x, 
            y: position.y,
            width: size.width,
            height: size.height
        });
    } catch (e) {
        // 忽略错误
    }
}

init();
