import {
    collectApplicationCategoryGroups,
    isValidFileCategoryKey,
    resolveApplicationCategoryKey
} from '../categories.js';
import { escapeAttribute, escapeHtml, renderFileList } from './file-view.js';

export const CATEGORIES = Object.freeze({
    recent: { icon: 'ri-history-line', name: '最近使用', key: 'recent' },
    document: { icon: 'ri-file-text-line', name: '文档', key: 'documents' },
    image: { icon: 'ri-image-line', name: '图片', key: 'images' },
    video: { icon: 'ri-video-line', name: '视频', key: 'videos' },
    audio: { icon: 'ri-music-2-line', name: '音频', key: 'audios' },
    archive: { icon: 'ri-archive-line', name: '压缩包', key: 'archives' },
    program: { icon: 'ri-apps-2-line', name: '程序', key: 'programs' },
    folder: { icon: 'ri-folder-2-line', name: '文件夹', key: 'folders' },
    other: { icon: 'ri-attachment-2', name: '其他', key: 'others' }
});

const pathIdentity = path => path.replaceAll('/', '\\').toLocaleLowerCase();
const fileIdentity = file => file.app_id ? `app:${file.app_id}` : `file:${file.path}`;

function uniqueFiles(files) {
    const identities = new Set();
    return files.filter(file => {
        if (!file || typeof file.path !== 'string' || !file.path) return false;
        const identity = file.app_id ? `app:${file.app_id}` : `file:${pathIdentity(file.path)}`;
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
    });
}

function orderCategoryFiles(state, key, files) {
    const order = state.categoryPreferences?.orders?.[key];
    if (!Array.isArray(order) || !order.length) return files;
    const positions = new Map();
    order.forEach((id, index) => {
        if (typeof id === 'string' && !positions.has(id)) positions.set(id, index);
    });
    return [...files].sort((left, right) =>
        (positions.get(fileIdentity(left)) ?? Infinity) - (positions.get(fileIdentity(right)) ?? Infinity));
}

function ordinaryDesktopFiles(state, applications) {
    const byPath = new Map();
    const applicationPaths = new Set(applications.map(file => pathIdentity(file.path)));
    for (const [categoryKey, config] of Object.entries(CATEGORIES)) {
        if (categoryKey === 'recent') continue;
        for (const file of state.files?.[config.key] || []) {
            if (!file || file.app_id || typeof file.path !== 'string' || !file.path) continue;
            const identity = pathIdentity(file.path);
            if (applicationPaths.has(identity) || byPath.has(identity)) continue;
            byPath.set(identity, { file, categoryKey });
        }
    }
    // Recent is an aggregate bucket, but it may contain a scanned item that was not
    // copied into its type bucket. It is a fallback, never a name-based search index.
    for (const file of state.files?.recent || []) {
        if (!file || file.app_id || typeof file.path !== 'string' || !file.path) continue;
        const identity = pathIdentity(file.path);
        if (applicationPaths.has(identity) || byPath.has(identity)) continue;
        const categoryKey = file.is_folder ? 'folder' : CATEGORIES[file.category] ? file.category : 'other';
        byPath.set(identity, { file, categoryKey });
    }
    return [...byPath.values()];
}

export function filesForCategory(state, categoryKey) {
    if (typeof categoryKey !== 'string') return [];
    const applications = uniqueFiles(state.files?.applications || []);
    if (categoryKey === 'managed-apps') {
        return orderCategoryFiles(state, categoryKey, applications.filter(file => file.app_manual));
    }
    const categoryApps = applications.filter(file =>
        resolveApplicationCategoryKey(file, state.customCategories) === categoryKey);
    if (categoryKey === 'recent') {
        return orderCategoryFiles(state, categoryKey, uniqueFiles([...(state.files?.recent || []), ...categoryApps]));
    }
    if (!isValidFileCategoryKey(categoryKey, state.customCategories)) return [];
    const files = ordinaryDesktopFiles(state, applications)
        .filter(({ file, categoryKey: naturalCategory }) => {
            const assignment = state.fileCategories?.[file.path];
            return (isValidFileCategoryKey(assignment, state.customCategories) ? assignment : naturalCategory) === categoryKey;
        })
        .map(entry => entry.file);
    return orderCategoryFiles(state, categoryKey, [...files, ...categoryApps]);
}

export function categoryFilesMarkup(categoryKey, files) {
    if (files.length) return renderFileList(files);
    return categoryKey.startsWith('custom_')
        ? '<div class="empty-category-hint">右键文件并选择“移动到分类”</div>'
        : '';
}

export function renderCategoryListMarkup(state) {
    const categoryOrder = ['recent', 'document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other'];
    let html = '';
    const categoryName = (key, fallback) => {
        const name = state.categoryPreferences?.names?.[key];
        return typeof name === 'string' && name.trim() ? name.trim() : fallback;
    };
    const manualApps = filesForCategory(state, 'managed-apps');
    if (manualApps.length) {
        const categoryKey = 'managed-apps';
        const isExpanded = state.expandedCategories.has(categoryKey);
        html += `<div class="category-item managed-app-category ${isExpanded ? 'expanded' : ''}" data-category="${categoryKey}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${categoryKey}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="ri-apps-2-line"></i></span><span class="category-name">我的应用</span><span class="category-count">${manualApps.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(categoryKey, manualApps) : ''}</div></div>`;
    }
    for (const category of state.customCategories || []) {
        const files = filesForCategory(state, category.key);
        const isExpanded = state.expandedCategories.has(category.key);
        html += `<div class="category-item custom-category ${isExpanded ? 'expanded' : ''}" data-category="${escapeAttribute(category.key)}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${escapeAttribute(category.key)}" aria-expanded="${isExpanded}"><span class="category-icon">${escapeHtml(category.icon)}</span><span class="category-name">${escapeHtml(categoryName(category.key, category.name))}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(category.key, files) : ''}</div></div>`;
    }
    for (const category of collectApplicationCategoryGroups(state.files?.applications, state.customCategories, state.fileCategories)) {
        const files = filesForCategory(state, category.key);
        const isExpanded = state.expandedCategories.has(category.key);
        html += `<div class="category-item app-category ${isExpanded ? 'expanded' : ''}" data-category="${escapeAttribute(category.key)}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${escapeAttribute(category.key)}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="ri-apps-2-line"></i></span><span class="category-name">${escapeHtml(categoryName(category.key, category.name))}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(category.key, files) : ''}</div></div>`;
    }
    for (const categoryKey of categoryOrder) {
        const config = CATEGORIES[categoryKey];
        const files = filesForCategory(state, categoryKey);
        if (!files.length && categoryName(categoryKey, '') === '') continue;
        const isExpanded = state.expandedCategories.has(categoryKey);
        html += `<div class="category-item ${isExpanded ? 'expanded' : ''}" data-category="${categoryKey}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${categoryKey}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="${config.icon}"></i></span><span class="category-name">${escapeHtml(categoryName(categoryKey, config.name))}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(categoryKey, files) : ''}</div></div>`;
    }
    return html || '<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-text">桌面没有文件</div></div>';
}
