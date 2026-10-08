const string = value => typeof value === 'string' ? value : '';

export function sourceLabel(kind) {
    return kind === 'startupFolder' ? '启动文件夹' : '注册表';
}

export function prepareStartupSnapshot(value) {
    const seen = new Set();
    const items = (Array.isArray(value?.items) ? value.items : []).filter(item => {
        if (!item || !string(item.id) || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    }).map(item => ({
        id: string(item.id), name: string(item.name) || '未命名启动项', command: string(item.command),
        targetPath: string(item.targetPath), sourcePath: string(item.sourcePath),
        sourceKind: item.sourceKind === 'startupFolder' ? 'startupFolder' : 'registry',
        sourceLabel: string(item.sourceLabel) || sourceLabel(item.sourceKind), sourceDetail: string(item.sourceDetail),
        scope: item.scope === 'system' ? 'system' : 'user', enabled: item.enabled === true,
        canToggle: item.canToggle === true && Boolean(string(item.fingerprint)), managed: item.managed === true,
        requiresElevation: item.requiresElevation === true, disabledReason: string(item.disabledReason),
        fingerprint: string(item.fingerprint), canReveal: item.canReveal === true,
        canRevealSource: item.canRevealSource === true, targetExists: item.targetExists === true
    }));
    return {
        items, total: items.length, enabled: items.filter(item => item.enabled).length,
        disabled: items.filter(item => !item.enabled).length, managed: items.filter(item => item.managed && !item.enabled).length,
        readOnly: items.filter(item => !item.canToggle).length,
        systemItems: items.filter(item => item.scope === 'system').length,
        userItems: items.filter(item => item.scope === 'user').length,
        scannedAt: value?.scannedAt,
        warnings: (Array.isArray(value?.warnings) ? value.warnings : []).filter(warning => typeof warning === 'string')
    };
}

export function filterStartupItems(items, { query = '', status = 'all', scope = 'all', source = 'all' } = {}) {
    const terms = string(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => {
        if (status === 'enabled' && !item.enabled) return false;
        if (status === 'disabled' && item.enabled) return false;
        if (status === 'managed' && (!item.managed || item.enabled)) return false;
        if (status === 'readOnly' && item.canToggle) return false;
        if (scope !== 'all' && item.scope !== scope) return false;
        if (source !== 'all' && item.sourceKind !== source) return false;
        const haystack = [item.name, item.command, item.targetPath, item.sourcePath, item.sourceLabel,
            item.sourceDetail, item.disabledReason, sourceLabel(item.sourceKind)].join(' ').toLocaleLowerCase();
        return terms.every(term => haystack.includes(term));
    });
}
