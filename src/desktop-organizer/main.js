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
    recent: { icon: '⏱️', name: '最近使用', key: 'recent' },
    document: { icon: '📄', name: '文档', key: 'documents' },
    image: { icon: '🖼️', name: '图片', key: 'images' },
    video: { icon: '🎬', name: '视频', key: 'videos' },
    audio: { icon: '🎵', name: '音频', key: 'audios' },
    archive: { icon: '📦', name: '压缩包', key: 'archives' },
    program: { icon: '💻', name: '程序', key: 'programs' },
    folder: { icon: '📂', name: '文件夹', key: 'folders' },
    other: { icon: '📎', name: '其他', key: 'others' },
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
};

// ============================================
// DOM 元素
// ============================================
const elements = {
    panel: document.getElementById('panel'),
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
    renameDialog: document.getElementById('renameDialog'),
    renameInput: document.getElementById('renameInput'),
    renameCancelBtn: document.getElementById('renameCancelBtn'),
    renameConfirmBtn: document.getElementById('renameConfirmBtn'),
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
    if (file.is_folder) return '📂';
    
    const iconMap = {
        document: '📄',
        image: '🖼️',
        video: '🎬',
        audio: '🎵',
        archive: '📦',
        program: '💻',
        other: '📎',
    };
    return iconMap[file.category] || '📄';
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

    const categoryOrder = ['recent', 'document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other'];
    let html = '';

    for (const catKey of categoryOrder) {
        const catConfig = CATEGORIES[catKey];
        const files = state.files[catConfig.key] || [];
        
        if (files.length === 0) continue;

        const isExpanded = state.expandedCategories.has(catKey);
        
        html += `
            <div class="category-item ${isExpanded ? 'expanded' : ''}" data-category="${catKey}">
                <div class="category-header" data-category="${catKey}">
                    <span class="category-icon">${catConfig.icon}</span>
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
    return files.map(file => `
        <div class="file-item" data-path="${escapeHtml(file.path)}" data-name="${escapeHtml(file.name)}">
            <span class="file-icon">${getFileIcon(file)}</span>
            <span class="file-name">${escapeHtml(file.name)}</span>
            <span class="file-size">${file.is_folder ? '→' : formatFileSize(file.size)}</span>
            ${file.is_folder && file.children ? renderFolderChildren(file.children) : ''}
        </div>
    `).join('');
}

function renderFolderChildren(children) {
    if (!children || children.length === 0) return '';
    
    const items = children.slice(0, 5).map(child => `
        <div class="file-item" data-path="${escapeHtml(child.path)}" data-name="${escapeHtml(child.name)}">
            <span class="file-icon">${getFileIcon(child)}</span>
            <span class="file-name">${escapeHtml(child.name)}</span>
        </div>
    `).join('');
    
    const moreCount = children.length - 5;
    const moreHtml = moreCount > 0 ? `<div class="file-item" style="color: var(--text-tertiary);">还有 ${moreCount} 个项目...</div>` : '';
    
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
// 数据加载
// ============================================
async function loadDesktopFiles() {
    try {
        elements.statusText.textContent = '扫描中...';
        state.files = await invoke('desktop_scan');
        renderCategoryList();
    } catch (error) {
        console.error('扫描桌面失败:', error);
        elements.statusText.textContent = '扫描失败';
        elements.categoryList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⚠️</div>
                <div class="empty-state-text">加载失败: ${error}</div>
            </div>
        `;
    }
}

async function searchFiles(query) {
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
        state.searchResults = await invoke('desktop_search', {
            query: searchTerm,
            categoryFilter: categoryFilter,
        });
        renderSearchResults();
    } catch (error) {
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
// 事件处理
// ============================================

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
    state.selectedFile = {
        path: fileItem.dataset.path,
        name: fileItem.dataset.name,
    };
    
    elements.contextMenu.style.display = 'block';
    elements.contextMenu.style.left = `${e.clientX}px`;
    elements.contextMenu.style.top = `${e.clientY}px`;
    
    // 确保菜单不超出窗口
    const rect = elements.contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        elements.contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
        elements.contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
}

function hideContextMenu() {
    elements.contextMenu.style.display = 'none';
}

elements.categoryList.addEventListener('contextmenu', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        showContextMenu(e, fileItem);
    }
});

elements.searchResultsList?.addEventListener('contextmenu', (e) => {
    const fileItem = e.target.closest('.file-item');
    if (fileItem) {
        showContextMenu(e, fileItem);
    }
});

document.addEventListener('click', () => {
    hideContextMenu();
});

// 右键菜单操作
elements.contextMenu.addEventListener('click', async (e) => {
    const menuItem = e.target.closest('.menu-item');
    if (!menuItem || !state.selectedFile) return;
    
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
        case 'cut':
            // 剪切需要配合粘贴功能，这里先复制路径
            await copyToClipboard(path);
            break;
        case 'rename':
            showRenameDialog(path, name);
            break;
    }
    
    hideContextMenu();
});

// 重命名对话框
function showRenameDialog(path, name) {
    elements.renameDialog.style.display = 'flex';
    elements.renameInput.value = name;
    elements.renameInput.focus();
    elements.renameInput.select();
    
    state.selectedFile = { path, name };
}

function hideRenameDialog() {
    elements.renameDialog.style.display = 'none';
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

// 监听窗口显示/隐藏事件，隐藏时关闭右键菜单
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        hideContextMenu();
        hideRenameDialog();
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

// 通知 Rust 端用户正在交互（拖动中）
async function notifyUserInteracting(interacting) {
    try {
        window.__userInteracting = interacting;
    } catch (e) {
        // ignore
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

document.querySelectorAll('.resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', async (e) => {
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
        
        document.body.style.cursor = getComputedStyle(handle).cursor;
        e.preventDefault();
        e.stopPropagation();
        
        // 清除之前的超时
        if (resizeEndTimeout) {
            clearTimeout(resizeEndTimeout);
            resizeEndTimeout = null;
        }
        notifyUserInteracting(true);
    });
});

document.addEventListener('mousemove', async (e) => {
    if (!isResizing) return;
    
    const deltaX = e.screenX - startX;
    const deltaY = e.screenY - startY;
    
    let newWidth = startWidth;
    let newHeight = startHeight;
    let newX = startWindowX;
    let newY = startWindowY;
    
    // 最小尺寸
    const minWidth = 400;
    const minHeight = 300;
    
    switch (resizeDirection) {
        case 'r': // 右边
            newWidth = Math.max(minWidth, startWidth + deltaX);
            break;
        case 'l': // 左边
            newWidth = Math.max(minWidth, startWidth - deltaX);
            newX = startWindowX + deltaX;
            if (newWidth === minWidth) {
                newX = startWindowX + (startWidth - minWidth);
            }
            break;
        case 'b': // 底部
            newHeight = Math.max(minHeight, startHeight + deltaY);
            break;
        case 'br': // 右下角
            newWidth = Math.max(minWidth, startWidth + deltaX);
            newHeight = Math.max(minHeight, startHeight + deltaY);
            break;
        case 'bl': // 左下角
            newWidth = Math.max(minWidth, startWidth - deltaX);
            newHeight = Math.max(minHeight, startHeight + deltaY);
            newX = startWindowX + deltaX;
            if (newWidth === minWidth) {
                newX = startWindowX + (startWidth - minWidth);
            }
            break;
    }
    
    // 使用 Tauri API 调整窗口
    try {
        if (resizeDirection === 'l' || resizeDirection === 'bl') {
            await appWindow.setPosition({ type: 'Physical', x: Math.round(newX), y: Math.round(newY) });
        }
        await appWindow.setSize({ type: 'Physical', width: Math.round(newWidth), height: Math.round(newHeight) });
    } catch (err) {
        console.error('调整窗口失败:', err);
    }
});

document.addEventListener('mouseup', () => {
    if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        
        // 保存用户偏好
        saveUserPreferences();
        
        // 延迟 500ms 后才允许收缩
        resizeEndTimeout = setTimeout(() => {
            notifyUserInteracting(false);
            resizeEndTimeout = null;
        }, 500);
    }
});

// ============================================
// 用户偏好
// ============================================
async function loadUserPreferences() {
    try {
        const prefs = localStorage.getItem('desktopOrganizerPrefs');
        if (prefs) {
            const { width, height, expandedCategories } = JSON.parse(prefs);
            // 使用 Tauri API 设置窗口尺寸
            if (width && height) {
                await appWindow.setSize({ type: 'Physical', width, height });
            }
            if (expandedCategories) {
                state.expandedCategories = new Set(expandedCategories);
            }
        }
    } catch (error) {
        console.error('加载偏好失败:', error);
    }
}

async function saveUserPreferences() {
    try {
        const size = await appWindow.innerSize();
        const prefs = {
            width: size.width,
            height: size.height,
            expandedCategories: Array.from(state.expandedCategories),
        };
        localStorage.setItem('desktopOrganizerPrefs', JSON.stringify(prefs));
    } catch (error) {
        console.error('保存偏好失败:', error);
    }
}

// ============================================
// 初始化
// ============================================
async function init() {
    await loadUserPreferences();
    await loadDesktopFiles();
}

init();
