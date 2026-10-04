import { escapeHtml } from './views/file-view.js';

const CUSTOM_CATEGORIES_KEY = 'desktop_organizer_custom_categories';
const FILE_CATEGORIES_KEY = 'desktop_organizer_file_categories';
const CATEGORY_ICONS = new Set(['📁', '⭐', '💼', '🎮', '🛠️', '📚', '🎨', '💡', '🔧', '📝', '🎯', '🚀']);

export function createCategoryController({ state, storage, renderCategories, categorySubmenu }) {
    function load() {
        try {
            const saved = storage.getItem(CUSTOM_CATEGORIES_KEY);
            const parsedCategories = saved ? JSON.parse(saved) : [];
            state.customCategories = (Array.isArray(parsedCategories) ? parsedCategories : [])
                .filter(category => category && /^custom_\d+$/.test(category.key) && typeof category.name === 'string')
                .slice(0, 50)
                .map(category => ({
                    key: category.key,
                    name: category.name.trim().slice(0, 40),
                    icon: CATEGORY_ICONS.has(category.icon) ? category.icon : '📁'
                }))
                .filter(category => category.name);

            const fileCategories = storage.getItem(FILE_CATEGORIES_KEY);
            const parsedAssignments = fileCategories ? JSON.parse(fileCategories) : {};
            const validKeys = new Set(state.customCategories.map(category => category.key));
            state.fileCategories = Object.fromEntries(Object.entries(parsedAssignments || {})
                .filter(([path, key]) => typeof path === 'string' && path.length <= 1024 && validKeys.has(key))
                .slice(0, 1000));
        } catch (error) {
            console.error('加载自定义分类失败:', error);
            state.customCategories = [];
            state.fileCategories = {};
        }
    }

    function save() {
        try {
            storage.setItem(CUSTOM_CATEGORIES_KEY, JSON.stringify(state.customCategories));
            storage.setItem(FILE_CATEGORIES_KEY, JSON.stringify(state.fileCategories));
        } catch (error) {
            console.error('保存自定义分类失败:', error);
        }
    }

    function create(name, icon) {
        const normalizedName = name.trim().slice(0, 40);
        if (!normalizedName || state.customCategories.some(category => category.name === normalizedName)) return null;
        const category = {
            key: `custom_${Date.now()}`,
            name: normalizedName,
            icon: CATEGORY_ICONS.has(icon) ? icon : '📁'
        };
        state.customCategories.push(category);
        save();
        renderCategories();
        return category;
    }

    function remove(key) {
        state.customCategories = state.customCategories.filter(category => category.key !== key);
        for (const [filePath, categoryKey] of Object.entries(state.fileCategories)) {
            if (categoryKey === key) delete state.fileCategories[filePath];
        }
        save();
        renderCategories();
    }

    function moveFile(filePath, categoryKey) {
        if (categoryKey === null) delete state.fileCategories[filePath];
        else state.fileCategories[filePath] = categoryKey;
        save();
        renderCategories();
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

    return { load, save, create, remove, moveFile, categoryForFile, updateSubmenu };
}
