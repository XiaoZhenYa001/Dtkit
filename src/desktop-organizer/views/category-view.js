import {
    collectApplicationCategoryGroups,
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

export function filesForCategory(state, categoryKey) {
    const applications = state.files?.applications || [];
    if (categoryKey === 'managed-apps') return applications.filter(file => file.app_manual);
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
    return [...files.filter(file => !state.fileCategories[file.path]), ...categoryApps];
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
    const manualApps = (state.files.applications || []).filter(file => file.app_manual);
    if (manualApps.length) {
        const categoryKey = 'managed-apps';
        const isExpanded = state.expandedCategories.has(categoryKey);
        html += `<div class="category-item managed-app-category ${isExpanded ? 'expanded' : ''}" data-category="${categoryKey}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${categoryKey}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="ri-apps-2-line"></i></span><span class="category-name">我的应用</span><span class="category-count">${manualApps.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(categoryKey, manualApps) : ''}</div></div>`;
    }
    for (const category of state.customCategories) {
        const files = filesForCategory(state, category.key);
        const isExpanded = state.expandedCategories.has(category.key);
        html += `<div class="category-item custom-category ${isExpanded ? 'expanded' : ''}" data-category="${escapeAttribute(category.key)}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${escapeAttribute(category.key)}" aria-expanded="${isExpanded}"><span class="category-icon">${category.icon}</span><span class="category-name">${escapeHtml(category.name)}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(category.key, files) : ''}</div></div>`;
    }
    for (const category of collectApplicationCategoryGroups(state.files.applications, state.customCategories)) {
        const files = filesForCategory(state, category.key);
        const isExpanded = state.expandedCategories.has(category.key);
        html += `<div class="category-item app-category ${isExpanded ? 'expanded' : ''}" data-category="${escapeAttribute(category.key)}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${escapeAttribute(category.key)}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="ri-apps-2-line"></i></span><span class="category-name">${escapeHtml(category.name)}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(category.key, files) : ''}</div></div>`;
    }
    for (const categoryKey of categoryOrder) {
        const config = CATEGORIES[categoryKey];
        const files = filesForCategory(state, categoryKey);
        if (!files.length) continue;
        const isExpanded = state.expandedCategories.has(categoryKey);
        html += `<div class="category-item ${isExpanded ? 'expanded' : ''}" data-category="${categoryKey}" data-files-rendered="${isExpanded}"><button class="category-header" type="button" data-category="${categoryKey}" aria-expanded="${isExpanded}"><span class="category-icon"><i class="${config.icon}"></i></span><span class="category-name">${config.name}</span><span class="category-count">${files.length}</span><span class="category-arrow">▶</span></button><div class="category-files">${isExpanded ? categoryFilesMarkup(categoryKey, files) : ''}</div></div>`;
    }
    return html || '<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-text">桌面没有文件</div></div>';
}
