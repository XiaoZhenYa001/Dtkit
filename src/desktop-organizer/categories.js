const ASSIGNABLE_CATEGORY_KEYS = Object.freeze([
    'recent',
    'documents',
    'images',
    'videos',
    'audios',
    'archives',
    'programs',
    'folders',
    'others'
]);
const APPLICATION_BUILTIN_CATEGORIES = new Map([
    ['recent', 'recent'],
    ['最近使用', 'recent'],
    ['document', 'document'],
    ['documents', 'document'],
    ['文档', 'document'],
    ['image', 'image'],
    ['images', 'image'],
    ['图片', 'image'],
    ['video', 'video'],
    ['videos', 'video'],
    ['视频', 'video'],
    ['audio', 'audio'],
    ['audios', 'audio'],
    ['音频', 'audio'],
    ['archive', 'archive'],
    ['archives', 'archive'],
    ['压缩包', 'archive'],
    ['program', 'program'],
    ['programs', 'program'],
    ['程序', 'program'],
    ['folder', 'folder'],
    ['folders', 'folder'],
    ['文件夹', 'folder'],
    ['other', 'other'],
    ['others', 'other'],
    ['其他', 'other']
]);
const APPLICATION_BUILTIN_KEYS = new Set(APPLICATION_BUILTIN_CATEGORIES.values());
const APPLICATION_CATEGORY_LABELS = new Map([
    ['recent', '最近使用'], ['document', '文档'], ['image', '图片'],
    ['video', '视频'], ['audio', '音频'], ['archive', '压缩包'],
    ['program', '程序'], ['folder', '文件夹'], ['other', '其他']
]);
const FILE_BUILTIN_CATEGORY_KEYS = new Set([
    'document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other'
]);

function normalizedCategory(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function isValidFileCategoryKey(key, customCategories = []) {
    if (typeof key !== 'string' || !key || key.length > 240) return false;
    if (FILE_BUILTIN_CATEGORY_KEYS.has(key)) return true;
    if (key.startsWith('custom_')) return customCategories.some(category => category?.key === key);
    if (!key.startsWith('app_category_')) return false;
    const encodedName = key.slice('app_category_'.length);
    try {
        const name = decodeURIComponent(encodedName);
        return !!name && name.trim() === name && encodeURIComponent(name) === encodedName;
    } catch {
        return false;
    }
}

export function resolveApplicationCategoryKey(application, customCategories = []) {
    const category = normalizedCategory(application?.app_category) || 'program';
    const normalized = category.toLocaleLowerCase();
    const builtinCategory = APPLICATION_BUILTIN_CATEGORIES.get(normalized)
        || APPLICATION_BUILTIN_CATEGORIES.get(category);
    if (builtinCategory) return builtinCategory;

    const customCategory = customCategories.find(item => {
        const key = normalizedCategory(item?.key).toLocaleLowerCase();
        const name = normalizedCategory(item?.name).toLocaleLowerCase();
        return normalized === key || normalized === name;
    });
    if (customCategory) return customCategory.key;
    if (/^custom_\d+$/.test(normalized)) return 'program';
    return `app_category_${encodeURIComponent(category)}`;
}

export function applicationCategoryOption(value, customCategories = []) {
    const category = normalizedCategory(value) || 'program';
    const key = resolveApplicationCategoryKey({ app_category: category }, customCategories);
    const builtinLabel = APPLICATION_CATEGORY_LABELS.get(key);
    if (builtinLabel) return { value: key, label: builtinLabel };
    const customCategory = customCategories.find(item => item.key === key);
    if (customCategory) return { value: key, label: customCategory.name };
    return { value: category, label: category };
}

export function collectApplicationCategoryGroups(applications = [], customCategories = [], fileCategories = {}) {
    const groups = new Map();
    for (const application of applications) {
        const key = resolveApplicationCategoryKey(application, customCategories);
        if (APPLICATION_BUILTIN_KEYS.has(key) || key.startsWith('custom_')) continue;
        const name = normalizedCategory(application?.app_category);
        if (!name) continue;
        const current = groups.get(key);
        groups.set(key, { key, name: current?.name || name, count: (current?.count || 0) + 1 });
    }
    // Ordinary desktop files can remain in an application category after its last
    // application is moved elsewhere. Keep that category discoverable from assignments.
    for (const key of Object.values(fileCategories || {})) {
        if (!key?.startsWith?.('app_category_') || !isValidFileCategoryKey(key, customCategories)) continue;
        const current = groups.get(key);
        groups.set(key, {
            key,
            name: current?.name || decodeURIComponent(key.slice('app_category_'.length)),
            count: (current?.count || 0) + 1
        });
    }
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

export function migrateFileCategory(assignments, oldPath, newPath) {
    if (!assignments || typeof assignments !== 'object') return {};
    if (!oldPath || !newPath || oldPath === newPath || !Object.hasOwn(assignments, oldPath)) {
        return assignments;
    }

    const nextAssignments = { ...assignments };
    nextAssignments[newPath] = nextAssignments[oldPath];
    delete nextAssignments[oldPath];
    return nextAssignments;
}

export function reconcileFileCategories(assignments, files, validCategoryKeys) {
    if (!assignments || typeof assignments !== 'object') return {};
    const isValidKey = typeof validCategoryKeys === 'function'
        ? validCategoryKeys
        : (() => {
            const validKeys = validCategoryKeys instanceof Set
                ? validCategoryKeys : new Set(validCategoryKeys || []);
            return key => validKeys.has(key);
        })();
    const currentPaths = new Set(
        ASSIGNABLE_CATEGORY_KEYS
            .flatMap(key => Array.isArray(files?.[key]) ? files[key] : [])
            .filter(file => file && !file.app_id && typeof file.path === 'string')
            .map(file => file.path)
    );
    const nextEntries = Object.entries(assignments)
        .filter(([path, categoryKey]) => currentPaths.has(path) && isValidKey(categoryKey));

    if (nextEntries.length === Object.keys(assignments).length
        && nextEntries.every(([path, categoryKey]) => assignments[path] === categoryKey)) {
        return assignments;
    }
    return Object.fromEntries(nextEntries);
}
