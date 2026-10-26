import { isValidFileCategoryKey } from './categories.js';

export const CATEGORY_STORAGE_KEY = 'dtkit_desktop_categories_v2';
export const MAX_CUSTOM_CATEGORIES = 50;
export const MAX_CATEGORY_ASSIGNMENTS = 1000;
const icons = new Set(['📁', '⭐', '💼', '🎮', '🛠️', '📚', '🎨', '💡', '🔧', '📝', '🎯', '🚀']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function normalize(customCategories, fileCategories) {
    if (!Array.isArray(customCategories) || !object(fileCategories)) throw new Error('分类设置格式无效，原数据已保留');
    // Existing data may exceed today's creation limit. Never silently truncate it.
    const seen = new Set();
    const categories = customCategories.filter(category => {
        if (!category || !/^custom_\d+$/.test(category.key) || typeof category.name !== 'string'
            || !category.name.trim() || seen.has(category.key)) return false;
        seen.add(category.key); return true;
    }).map(category => ({ key: category.key, name: category.name.trim().slice(0, 40), icon: icons.has(category.icon) ? category.icon : '📁' }));
    const assignments = Object.fromEntries(Object.entries(fileCategories).filter(([path, key]) => path.length > 0
        && path.length <= 1400 && isValidFileCategoryKey(key, categories)));
    return { version: 2, customCategories: categories, fileCategories: assignments };
}

export function readCategoryPreferences(storage) {
    const current = storage.getItem(CATEGORY_STORAGE_KEY);
    if (current != null) {
        const parsed = JSON.parse(current);
        if (!object(parsed) || parsed.version !== 2) throw new Error('分类设置版本不受支持，原数据已保留');
        return normalize(parsed.customCategories, parsed.fileCategories);
    }
    return normalize(JSON.parse(storage.getItem('desktop_organizer_custom_categories') || '[]'),
        JSON.parse(storage.getItem('desktop_organizer_file_categories') || '{}'));
}

export function writeCategoryPreferences(storage, preferences) {
    const normalized = normalize(preferences.customCategories, preferences.fileCategories);
    // Both definitions and assignments commit in one atomic localStorage write.
    // Legacy keys remain untouched as a recovery copy after migration.
    storage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
}
