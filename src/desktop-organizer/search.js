const COMMAND_MAP = Object.freeze({
    '/d': 'document',
    '/p': 'image',
    '/v': 'video',
    '/a': 'program',
    '/f': 'folder',
    '/z': 'archive'
});

const SEARCH_CATEGORY_KEYS = Object.freeze([
    'documents',
    'images',
    'videos',
    'audios',
    'archives',
    'programs',
    'folders',
    'others',
    'applications'
]);

function normalizedPath(path) {
    return path.replaceAll('/', '\\')
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/^\\\\\?\\/, '')
        .toLocaleLowerCase();
}

export function buildSearchIndex(files) {
    const sourceRank = file => file.app_manual ? 0 : file.app_id ? 1 : 2;
    const seenAppIds = new Set();
    const seenPaths = new Set();
    return SEARCH_CATEGORY_KEYS
        .flatMap(key => files?.[key] || [])
        .sort((left, right) => sourceRank(left) - sourceRank(right))
        .filter(file => {
            if (!file.name.trim()) return false;
            const appId = typeof file.app_id === 'string' ? file.app_id.trim() : '';
            const path = typeof file.path === 'string' ? normalizedPath(file.path) : '';
            const duplicate = appId && seenAppIds.has(appId) || path && seenPaths.has(path);
            if (appId) seenAppIds.add(appId);
            if (path) seenPaths.add(path);
            return !duplicate;
        })
        .map(file => ({ file, normalizedName: file.name.toLocaleLowerCase() }));
}

export function querySearchIndex(index, query) {
    let categoryFilter = null;
    let searchTerm = query;
    for (const [command, category] of Object.entries(COMMAND_MAP)) {
        if (query.toLowerCase().startsWith(command)) {
            categoryFilter = category;
            searchTerm = query.slice(command.length).trim();
            break;
        }
    }
    if (!searchTerm && !categoryFilter) return [];
    const normalizedTerm = searchTerm.toLocaleLowerCase();
    return index
        .filter(({ file, normalizedName }) =>
            (!categoryFilter || file.category === categoryFilter)
            && (!normalizedTerm || normalizedName.includes(normalizedTerm)))
        .slice(0, 200)
        .map(entry => entry.file);
}
