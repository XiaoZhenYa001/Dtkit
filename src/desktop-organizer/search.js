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

export function buildSearchIndex(files) {
    const sourceRank = file => file.app_manual ? 0 : file.app_id ? 2 : 1;
    const seenNames = new Set();
    return SEARCH_CATEGORY_KEYS
        .flatMap(key => files?.[key] || [])
        .sort((left, right) => sourceRank(left) - sourceRank(right))
        .filter(file => {
            const name = file.name.trim().replace(/\.(exe|lnk|url)$/i, '').toLocaleLowerCase();
            if (!name || seenNames.has(name)) return false;
            seenNames.add(name);
            return true;
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
