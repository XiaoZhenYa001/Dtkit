import { collectApplicationCategoryGroups, resolveApplicationCategoryKey } from './categories.js';
import { CATEGORIES } from './views/category-view.js';

export const DESKTOP_SPACE_STORAGE_KEY = 'dtkit_desktop_space_v1';
export const SPACE_FOLDER_TYPES = Object.freeze(['small', 'quad', 'nine']);
const BUILTIN_KEYS = Object.keys(CATEGORIES).filter(key => key !== 'recent');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && key.length <= 240 && !['__proto__', 'prototype', 'constructor'].includes(key);

export function normalizeSpacePreferences(value) {
    const groups = {};
    const orders = {};
    if (plainObject(value?.groups)) {
        for (const [key, item] of Object.entries(value.groups).slice(0, 100)) {
            if (!safeKey(key) || !plainObject(item)) continue;
            const name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '';
            const size = SPACE_FOLDER_TYPES.includes(item.size) ? item.size : 'quad';
            groups[key] = { ...(name ? { name } : {}), size };
        }
    }
    if (plainObject(value?.orders)) {
        for (const [key, items] of Object.entries(value.orders).slice(0, 100)) {
            if (!safeKey(key) || !Array.isArray(items)) continue;
            orders[key] = [...new Set(items.filter(item => typeof item === 'string' && item.length <= 1400))].slice(0, 4000);
        }
    }
    return { version: 1, groups, orders };
}

export function spaceFileId(file) {
    return file?.app_id ? `app:${file.app_id}` : `file:${file?.path || ''}`;
}

export function collectSpaceFiles(state) {
    const byPath = new Map();
    const add = file => {
        if (!file || typeof file.path !== 'string' || !file.path || typeof file.name !== 'string') return;
        const key = file.path.replaceAll('/', '\\').toLocaleLowerCase();
        if (!byPath.has(key)) byPath.set(key, file);
    };
    (state.files?.applications || []).forEach(add);
    BUILTIN_KEYS.forEach(key => (state.files?.[CATEGORIES[key].key] || []).forEach(add));
    (state.searchIndex || []).forEach(entry => add(entry.file));
    return [...byPath.values()];
}

export function createSpaceGroups(state, preferences = {}) {
    const prefs = normalizeSpacePreferences(preferences);
    const allFiles = collectSpaceFiles(state);
    const definitions = [
        ...(state.customCategories || []).map(group => ({ key: group.key, name: group.name, icon: group.icon, custom: true })),
        ...collectApplicationCategoryGroups(state.files?.applications, state.customCategories, state.fileCategories).map(group => ({ ...group, icon: 'ri-apps-2-line' })),
        ...BUILTIN_KEYS.map(key => ({ key, name: CATEGORIES[key].name, icon: CATEGORIES[key].icon }))
    ];
    const groups = new Map(definitions.map((group, index) => [group.key, { ...group, index, files: [], size: prefs.groups[group.key]?.size || (group.key === 'program' ? 'nine' : 'quad'), name: prefs.groups[group.key]?.name || group.name }]));
    for (const file of allFiles) {
        let key = file.app_id
            ? resolveApplicationCategoryKey(file, state.customCategories)
            : state.fileCategories?.[file.path] || (file.is_folder ? 'folder' : file.category);
        if (key === 'recent') key = 'program';
        if (!groups.has(key)) key = file.is_folder ? 'folder' : BUILTIN_KEYS.includes(file.category) ? file.category : 'other';
        groups.get(key)?.files.push(file);
    }
    for (const group of groups.values()) {
        const order = new Map((prefs.orders[group.key] || []).map((id, index) => [id, index]));
        group.files.sort((left, right) => (order.get(spaceFileId(left)) ?? Infinity) - (order.get(spaceFileId(right)) ?? Infinity));
    }
    return [...groups.values()].filter(group => group.files.length || group.custom || prefs.groups[group.key]);
}

export function updateSpaceOrder(preferences, groups, fileId, targetKey, beforeId = null) {
    const next = normalizeSpacePreferences(preferences);
    const target = groups.find(group => group.key === targetKey);
    if (!target || !groups.some(group => group.files.some(file => spaceFileId(file) === fileId))) return next;
    for (const group of groups) {
        const ids = group.files.map(spaceFileId).filter(id => id !== fileId);
        if (group.key === targetKey) {
            const position = beforeId ? ids.indexOf(beforeId) : -1;
            ids.splice(position < 0 ? ids.length : position, 0, fileId);
        }
        next.orders[group.key] = ids;
    }
    return next;
}

export function folderPreviewSlots(files, type = 'quad') {
    if (type === 'small') return { direct: files.slice(0, 9), mini: [], capacity: 9 };
    const directCount = type === 'nine' ? 8 : 3;
    return { direct: files.slice(0, directCount), mini: files.slice(directCount, directCount + 4), capacity: directCount + 4 };
}

export function migrateSpaceOrderPath(preferences, oldPath, newPath) {
    const next = normalizeSpacePreferences(preferences);
    if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !newPath || oldPath === newPath) return next;
    const previousId = `file:${oldPath}`;
    const nextId = `file:${newPath}`;
    for (const [key, order] of Object.entries(next.orders)) {
        next.orders[key] = [...new Set(order.map(id => id === previousId ? nextId : id))];
    }
    return next;
}
