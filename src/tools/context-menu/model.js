export const CONTEXT_CATEGORIES = Object.freeze([
    { id: 'all', name: '全部', icon: 'ri-menu-2-line' },
    { id: 'files', name: '文件', icon: 'ri-file-line' },
    { id: 'folders', name: '文件夹', icon: 'ri-folder-line' },
    { id: 'folderBackground', name: '文件夹空白处', icon: 'ri-folder-open-line' },
    { id: 'desktop', name: '桌面', icon: 'ri-computer-line' },
    { id: 'drives', name: '磁盘', icon: 'ri-hard-drive-line' },
    { id: 'fileTypes', name: '文件类型', icon: 'ri-file-text-line' }
]);

export function categoryLabel(id) {
    return CONTEXT_CATEGORIES.find(category => category.id === id)?.name || String(id);
}

export function normalizeExtension(input) {
    const value = String(input ?? '').trim().toLowerCase();
    if (!value) return null;
    const extension = value.startsWith('.') ? value : `.${value}`;
    if (!/^\.[a-z0-9_-]{1,31}$/.test(extension)) {
        throw new Error('请输入一个有效扩展名，例如 .pdf 或 .txt，不要输入文件路径。');
    }
    return extension;
}

export function prepareSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) throw new Error('未能读取菜单列表，请重新扫描。');
    const seen = new Set();
    const items = snapshot.items.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)
            || typeof item.enabled !== 'boolean' || typeof item.fingerprint !== 'string') {
            throw new Error('菜单数据不完整，请重新扫描。');
        }
        seen.add(item.id);
        const result = {
            ...item,
            name: String(item.name || '未命名菜单项'),
            categories: Array.isArray(item.categories) ? [...new Set(item.categories.map(String))] : [],
            canToggle: item.canToggle === true,
            managed: item.managed === true,
            requiresElevation: item.requiresElevation === true,
            kind: item.kind === 'extension' ? 'extension' : 'verb',
            scope: item.scope === 'system' ? 'system' : 'user',
            registryPath: String(item.registryPath || ''),
            command: String(item.command || ''),
            detail: String(item.detail || ''),
            disabledReason: item.disabledReason ? String(item.disabledReason) : null,
            clsid: item.clsid ? String(item.clsid) : null
        };
        result.searchText = [result.name, result.registryPath, result.command, result.clsid,
            result.detail, ...result.categories.map(categoryLabel)].join('\n').toLocaleLowerCase();
        return result;
    });
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    return {
        items,
        total: items.length,
        enabled: items.filter(item => item.enabled).length,
        disabled: items.filter(item => !item.enabled).length,
        readOnly: items.filter(item => !item.canToggle).length,
        scannedAt: snapshot.scannedAt,
        extension: normalizeExtension(snapshot.extension),
        warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.map(String) : []
    };
}

export function filterItems(items, { category = 'all', query = '', status = 'all', scope = 'all', kind = 'all' } = {}) {
    const search = String(query).trim().toLocaleLowerCase();
    return items.filter(item => (category === 'all' || item.categories.includes(category))
        && (!search || item.searchText.includes(search))
        && (status === 'all' || (status === 'enabled' && item.enabled)
            || (status === 'disabled' && !item.enabled)
            || (status === 'managed' && item.managed && !item.enabled)
            || (status === 'readOnly' && !item.canToggle))
        && (scope === 'all' || item.scope === scope)
        && (kind === 'all' || item.kind === kind));
}

export function categoryCounts(items) {
    return Object.fromEntries(CONTEXT_CATEGORIES.map(category => [category.id,
        category.id === 'all' ? items.length : items.filter(item => item.categories.includes(category.id)).length]));
}
