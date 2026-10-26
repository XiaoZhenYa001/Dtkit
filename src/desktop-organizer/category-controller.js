import { escapeHtml } from './views/file-view.js';
import { isValidFileCategoryKey } from './categories.js';
import { MAX_CUSTOM_CATEGORIES, MAX_CATEGORY_ASSIGNMENTS, readCategoryPreferences, writeCategoryPreferences } from './category-storage.js';

const CATEGORY_ICONS = new Set(['📁', '⭐', '💼', '🎮', '🛠️', '📚', '🎨', '💡', '🔧', '📝', '🎯', '🚀']);

export function createCategoryController({ state, storage, renderCategories, categorySubmenu, onError = () => {} }) {
    let errorMessage = '';
    function fail(message) { errorMessage = message; onError(message); return false; }
    function apply(preferences) {
        state.customCategories = preferences.customCategories;
        state.fileCategories = preferences.fileCategories;
    }
    function load() {
        try {
            apply(readCategoryPreferences(storage)); errorMessage = ''; onError(''); return true;
        } catch (error) {
            return fail(`读取分类设置失败，原数据已保留 · ${String(error)}`);
        }
    }

    function save(next = state) {
        try {
            readCategoryPreferences(storage);
            apply(writeCategoryPreferences(storage, next)); errorMessage = ''; onError(''); return true;
        } catch (error) {
            return fail(`保存分类设置失败，请重试 · ${String(error)}`);
        }
    }

    function latest() {
        try { return readCategoryPreferences(storage); }
        catch (error) { fail(`读取分类设置失败，原数据已保留 · ${String(error)}`); return null; }
    }

    function create(name, icon) {
        const normalizedName = name.trim().slice(0, 40);
        const next = latest();
        if (!next) return null;
        if (!normalizedName || next.customCategories.some(category => category.name === normalizedName)) {
            fail('分类名称为空或已存在'); return null;
        }
        if (next.customCategories.length >= MAX_CUSTOM_CATEGORIES) { fail(`最多创建 ${MAX_CUSTOM_CATEGORIES} 个分类，请先合并或删除分类`); return null; }
        let id = Date.now();
        while (next.customCategories.some(category => category.key === `custom_${id}`)) id++;
        const category = {
            key: `custom_${id}`,
            name: normalizedName,
            icon: CATEGORY_ICONS.has(icon) ? icon : '📁'
        };
        next.customCategories.push(category);
        if (!save(next)) return null;
        renderCategories();
        return category;
    }

    function remove(key) {
        const next = latest();
        if (!next) return false;
        next.customCategories = next.customCategories.filter(category => category.key !== key);
        for (const [filePath, categoryKey] of Object.entries(next.fileCategories)) {
            if (categoryKey === key) delete next.fileCategories[filePath];
        }
        if (!save(next)) return false;
        renderCategories();
        return true;
    }

    function moveFile(filePath, categoryKey) {
        if (typeof filePath !== 'string' || !filePath || filePath.length > 1400) return false;
        const next = latest();
        if (!next || categoryKey !== null && !isValidFileCategoryKey(categoryKey, next.customCategories)) return false;
        if (categoryKey === null) delete next.fileCategories[filePath];
        else {
            if (!Object.hasOwn(next.fileCategories, filePath) && Object.keys(next.fileCategories).length >= MAX_CATEGORY_ASSIGNMENTS) return fail('分类项目已达上限，请先移除部分归类');
            next.fileCategories[filePath] = categoryKey;
        }
        if (!save(next)) return false;
        renderCategories();
        return true;
    }

    function categoryForFile(filePath) {
        return state.fileCategories[filePath] || null;
    }

    function updateSubmenu() {
        if (!categorySubmenu) return;
        let html = `
            <div class="submenu-item" data-category="null">
                <span class="submenu-icon">🔄</span>
                <span class="submenu-text">恢复默认分类</span>
            </div>
        `;
        if (state.customCategories.length) {
            html += '<div class="submenu-divider"></div>';
            html += state.customCategories.map(category => `
                <div class="submenu-item" data-category="${category.key}">
                    <span class="submenu-icon">${category.icon}</span>
                    <span class="submenu-text">${escapeHtml(category.name)}</span>
                </div>
            `).join('');
        }
        categorySubmenu.innerHTML = html;
    }

    return { load, save, create, remove, moveFile, categoryForFile, updateSubmenu, get error() { return errorMessage; } };
}
