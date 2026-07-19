/**
 * 桌面整理 - 主逻辑
 * Desktop Organizer - Main Logic
 */

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
    isSearching: false,   // 是否在搜索模式
    customCategories: [], // 自定义分类
    fileCategories: {},   // 文件到分类的映射 { filePath: categoryKey }
};

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
    div.textContent = text;
    return div.innerHTML;
}

function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapeHtml(text).replace(regex, '<span class="search-highlight">$1</span>');
}

// ============================================
// 渲染函数
// ============================================
function renderCategoryList() {
    if (!state.files) {
        elements.categoryList.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
            </div>
        `;
        return;
    }

    // 收集被分配到自定义分类的文件路径
    const customCategoryFiles = new Set(Object.keys(state.fileCategories));
    
    // 构建自定义分类的文件列表
    const customCategoryData = {};
    for (const cat of state.customCategories) {
        customCategoryData[cat.key] = [];
    }
    
    // 从所有文件中找出分配到自定义分类的
    const allFiles = [
        ...(state.files.documents || []),
        ...(state.files.images || []),
        ...(state.files.videos || []),
        ...(state.files.audios || []),
        ...(state.files.archives || []),
        ...(state.files.programs || []),
        ...(state.files.folders || []),
        ...(state.files.others || []),
    ];
    
    for (const file of allFiles) {
        const catKey = state.fileCategories[file.path];
        if (catKey && customCategoryData[catKey]) {
            customCategoryData[catKey].push(file);
        }
    }

    const categoryOrder = ['recent', 'document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other'];
    let html = '';

    // 先渲染自定义分类（即使是空的也显示）
    for (const cat of state.customCategories) {
        const files = customCategoryData[cat.key] || [];
        
        const isExpanded = state.expandedCategories.has(cat.key);
        const emptyHint = files.length === 0 ? '<div class="empty-category-hint">将文件拖到此分类或右键文件选择"移动到分类"</div>' : '';
        
        html += `
            <div class="category-item custom-category ${isExpanded ? 'expanded' : ''}" data-category="${cat.key}">
                <div class="category-header" data-category="${cat.key}">
                    <span class="category-icon">${cat.icon}</span>
                    <span class="category-name">${escapeHtml(cat.name)}</span>
                    <span class="category-count">${files.length}</span>
                    <span class="category-arrow">▶</span>
                </div>
                <div class="category-files">
                    ${files.length > 0 ? renderFileList(files) : emptyHint}
                </div>
            </div>
        `;
    }

    // 渲染默认分类
    for (const catKey of categoryOrder) {
        const catConfig = CATEGORIES[catKey];
        let files = state.files[catConfig.key] || [];
        
        // 排除已分配到自定义分类的文件（最近使用分类除外）
        if (catKey !== 'recent') {
            files = files.filter(f => !customCategoryFiles.has(f.path));
        }
        
        if (files.length === 0) continue;

        const isExpanded = state.expandedCategories.has(catKey);
        
        html += `
            <div class="category-item ${isExpanded ? 'expanded' : ''}" data-category="${catKey}">
                <div class="category-header" data-category="${catKey}">
                    <span class="category-icon"><i class="${catConfig.icon}"></i></span>
                    <span class="category-name">${catConfig.name}</span>
                    <span class="category-count">${files.length}</span>
                    <span class="category-arrow">▶</span>
                </div>
                <div class="category-files">
                    ${renderFileList(files)}
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
}

function renderFileList(files) {
    return files.map(file => {
        const iconContent = getFileIcon(file);
        const isImgIcon = file.icon ? true : false;
        return `
        <div class="file-item" data-path="${escapeHtml(file.path)}" data-name="${escapeHtml(file.name)}">
            <span class="file-icon${isImgIcon ? ' file-icon-real' : ''}">${iconContent}</span>
            <span class="file-name">${escapeHtml(file.name)}</span>
            <span class="file-size">${file.is_folder ? '→' : formatFileSize(file.size)}</span>
            ${file.is_folder && file.children ? renderFolderChildren(file.children, file.children_truncated) : ''}
        </div>
    `}).join('');
}

function renderFolderChildren(children, truncated = false) {
    if (!children || children.length === 0) return '';
    
    const items = children.slice(0, 5).map(child => `
        <div class="file-item" data-path="${escapeHtml(child.path)}" data-name="${escapeHtml(child.name)}">
            <span class="file-icon">${getFileIcon(child)}</span>
            <span class="file-name">${escapeHtml(child.name)}</span>
        </div>
    `).join('');
    
    const moreHtml = truncated ? '<div class="file-item file-item--more">打开文件夹查看其余项目</div>' : '';
    
    return `<div class="folder-children">${items}${moreHtml}</div>`;
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
        <div class="file-item" data-path="${escapeHtml(file.path)}" data-name="${escapeHtml(file.name)}">
            <span class="file-icon">${getFileIcon(file)}</span>
            <span class="file-name">${highlightText(file.name, query)}</span>
            <span class="file-size">${file.is_folder ? '→' : formatFileSize(file.size)}</span>
        </div>
    `).join('');
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
let scanPromise = null;
async function loadDesktopFiles() {
    if (scanPromise) return scanPromise;
    scanPromise = invoke('desktop_scan');
    try {
        elements.statusText.textContent = '扫描中...';
        state.files = await scanPromise;
        loadCustomCategories();
        renderCategoryList();
    } catch (error) {
        console.error('扫描桌面失败:', error);
        elements.statusText.textContent = '扫描失败';
        elements.categoryList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⚠️</div>
                <div class="empty-state-text">加载失败: ${escapeHtml(String(error))}</div>
            </div>
        `;
    } finally {
        scanPromise = null;
    }
}

let searchGeneration = 0;
async function searchFiles(query) {
    const generation = ++searchGeneration;
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

    if (!searchTerm) {
        state.searchResults = [];
        renderSearchResults();
        return;
    }

    try {
        const results = await invoke('desktop_search', {
            query: searchTerm,
            categoryFilter: categoryFilter,
        });
        if (generation !== searchGeneration) return;
        state.searchResults = results;
        renderSearchResults();
    } catch (error) {
        if (generation !== searchGeneration) return;
        console.error('搜索失败:', error);
        state.searchResults = [];
        renderSearchResults();
    }
}

// ============================================
// 文件操作
// ============================================
async function openFile(path) {
    try {
        await invoke('desktop_open_file', { path });
    } catch (error) {
        console.error('打开文件失败:', error);
    }
}

async function locateFile(path) {
    try {
        await invoke('desktop_locate_file', { path });
    } catch (error) {
        console.error('定位文件失败:', error);
    }
}

async function renameFile(oldPath, newName) {
    try {
        await invoke('desktop_rename_file', { oldPath, newName });
        await loadDesktopFiles(); // 刷新列表
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
document.addEventListener('keydown', async (e) => {
    // 如果重命名对话框打开，不处理快捷键（除了在输入框内的处理）
    if (elements.renameDialog.style.display !== 'none') {
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
    
    // 获取当前选中的文件
    const selectedItem = document.querySelector('.file-item.selected');
    
    if (selectedItem && state.selectedFile) {
        const { path, name } = state.selectedFile;
        
        // Enter - 打开文件
        if (e.key === 'Enter') {
            e.preventDefault();
            await openFile(path);
        }
        // F2 - 重命名
        else if (e.key === 'F2') {
            e.preventDefault();
            showRenameDialog(path, name);
        }
        // Ctrl+C - 复制路径
        else if (e.ctrlKey && e.key === 'c') {
            e.preventDefault();
            await copyToClipboard(path);
        }
        // Ctrl+L - 定位文件
        else if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            await locateFile(path);
        }
    }
    
    // ESC - 关闭右键菜单
    if (e.key === 'Escape') {
        hideContextMenu();
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
        loadDesktopFiles();
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
        };
    } else {
        state.selectedFile = null;
    }
}

// 单击选中文件
elements.categoryList.addEventListener('click', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem && !e.target.closest('.folder-children')) {
        selectFileItem(fileItem);
    }
});

// 分类展开/折叠
elements.categoryList.addEventListener('click', (e) => {
    const header = e.target.closest('.category-header');
    if (header) {
        const category = header.dataset.category;
        if (state.expandedCategories.has(category)) {
            state.expandedCategories.delete(category);
        } else {
            state.expandedCategories.add(category);
        }
        const item = header.closest('.category-item');
        item.classList.toggle('expanded');
        return;
    }

    // 文件夹悬停展开
    const folderItem = e.target.closest('.file-item');
    if (folderItem) {
        const children = folderItem.querySelector('.folder-children');
        if (children) {
            folderItem.classList.toggle('folder-expanded');
        }
    }
});

// 文件双击打开
elements.categoryList.addEventListener('dblclick', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        const path = fileItem.dataset.path;
        if (path) {
            openFile(path);
        }
    }
});

elements.searchResultsList?.addEventListener('dblclick', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        const path = fileItem.dataset.path;
        if (path) {
            openFile(path);
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
    if (menuItem.classList.contains('has-submenu')) return;
    
    const action = menuItem.dataset.action;
    const { path, name } = state.selectedFile;
    
    switch (action) {
        case 'open':
            await openFile(path);
            break;
        case 'locate':
            await locateFile(path);
            break;
        case 'copy':
            await copyToClipboard(path);
            break;
        case 'rename':
            showRenameDialog(path, name);
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
            await loadDesktopFiles();
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
    loadDesktopFiles();
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
    }
});

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
    try {
        const prefs = localStorage.getItem('desktopOrganizerPrefs');
        if (prefs) {
            const { width, height, positionX, expandedCategories } = JSON.parse(prefs);
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
        await invoke('clamp_desktop_organizer_window');
        await saveUserPreferences();
    } catch (error) {
        console.error('加载偏好失败:', error);
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
                width: size.width 
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
    await loadDesktopFiles();
    
    // 初始化时同步热区位置
    try {
        const size = await appWindow.innerSize();
        const position = await appWindow.innerPosition();
        await invoke('update_hotzone_position', { 
            x: position.x, 
            width: size.width 
        });
    } catch (e) {
        // 忽略错误
    }
}

init();
