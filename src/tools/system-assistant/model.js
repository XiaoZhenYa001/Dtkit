const string = value => typeof value === 'string' ? value : '';

export function sourceLabel(kind) {
    return kind === 'startupFolder' ? '启动文件夹' : '注册表';
}

export function prepareStartupSnapshot(value) {
    const seen = new Set();
    const recoveryState = string(value?.recoveryState) || 'ready';
    const items = (Array.isArray(value?.items) ? value.items : []).filter(item => {
        if (!item || !string(item.id) || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    }).map(item => ({
        id: string(item.id), name: string(item.name) || '未命名启动项', command: string(item.command),
        groupId: string(item.groupId), groupName: string(item.groupName), groupReason: string(item.groupReason),
        targetPath: string(item.targetPath), sourcePath: string(item.sourcePath),
        sourceKind: item.sourceKind === 'startupFolder' ? 'startupFolder' : 'registry',
        sourceLabel: string(item.sourceLabel) || sourceLabel(item.sourceKind), sourceDetail: string(item.sourceDetail),
        scope: item.scope === 'system' ? 'system' : 'user', enabled: item.enabled === true,
        canToggle: recoveryState === 'ready' && item.canToggle === true && Boolean(string(item.fingerprint)), managed: item.managed === true,
        requiresElevation: item.requiresElevation === true, disabledReason: string(item.disabledReason),
        fingerprint: string(item.fingerprint), canReveal: item.canReveal === true,
        canRevealSource: item.canRevealSource === true, targetExists: item.targetExists === true,
        backupPath: string(item.backupPath), canRevealBackup: item.canRevealBackup === true,
        canForgetBackup: recoveryState === 'ready' && item.canForgetBackup === true && Boolean(string(item.fingerprint)),
        backupConflict: item.backupConflict === true,
        backupDisabledAt: Number.isFinite(item.backupDisabledAt) && item.backupDisabledAt > 0 ? item.backupDisabledAt : null
    }));
    return {
        items, total: items.length, enabled: items.filter(item => item.enabled).length,
        disabled: items.filter(item => !item.enabled).length, managed: items.filter(item => item.managed && !item.enabled).length,
        readOnly: items.filter(item => !item.canToggle).length,
        systemItems: items.filter(item => item.scope === 'system').length,
        userItems: items.filter(item => item.scope === 'user').length,
        conflicts: items.filter(item => item.backupConflict).length,
        unlocated: items.filter(item => !item.targetExists).length,
        recoveryState,
        recoveryMessage: string(value?.recoveryMessage),
        recoveryFingerprint: string(value?.recoveryFingerprint),
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
        if (status === 'conflicts' && !item.backupConflict) return false;
        if (status === 'unlocated' && item.targetExists) return false;
        if (scope !== 'all' && item.scope !== scope) return false;
        if (source !== 'all' && item.sourceKind !== source) return false;
        const haystack = [item.name, item.groupName, item.command, item.targetPath, item.sourcePath, item.sourceLabel,
            item.sourceDetail, item.disabledReason, sourceLabel(item.sourceKind)].join(' ').toLocaleLowerCase();
        return terms.every(term => haystack.includes(term));
    });
}

const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function sortStartupItems(items, order = 'name') {
    const byName = (a, b) => names.compare(a.name, b.name) || names.compare(a.id, b.id);
    return [...items].sort((a, b) => {
        if (order === 'state') return Number(b.enabled) - Number(a.enabled) || Number(b.managed) - Number(a.managed) || byName(a, b);
        if (order === 'source') return names.compare(a.sourceLabel, b.sourceLabel) || byName(a, b);
        if (order === 'recent') return (b.backupDisabledAt || 0) - (a.backupDisabledAt || 0) || byName(a, b);
        return byName(a, b);
    });
}

export function groupStartupItems(items, order = 'name') {
    const grouped = new Map();
    const groups = [];
    const usedIds = new Set(items.map(item => string(item.groupId)).filter(id => id.trim()));
    for (const item of items) {
        const groupId = string(item.groupId);
        let group = groupId.trim() ? grouped.get(groupId) : null;
        if (!group) {
            let id = groupId;
            if (!groupId.trim()) {
                id = `startup-item:${item.id}`;
                while (usedIds.has(id)) id += ':';
            }
            usedIds.add(id);
            group = {
                id,
                name: groupId.trim() ? string(item.groupName) || item.name : item.name,
                reason: groupId.trim() ? string(item.groupReason) || 'unconfirmed' : 'unconfirmed',
                items: [], enabled: 0, disabled: 0
            };
            if (groupId.trim()) grouped.set(groupId, group);
            groups.push(group);
        }
        group.items.push(item);
        if (item.enabled === true) group.enabled += 1;
        else group.disabled += 1;
    }
    for (const group of groups) group.items = sortStartupItems(group.items, order);
    const byName = (a, b) => names.compare(a.name, b.name) || names.compare(a.id, b.id);
    return groups.sort((a, b) => {
        if (order === 'state') {
            return Number(b.enabled > 0) - Number(a.enabled > 0)
                || Number(b.items.some(item => item.managed)) - Number(a.items.some(item => item.managed))
                || byName(a, b);
        }
        if (order === 'source') return names.compare(a.items[0].sourceLabel, b.items[0].sourceLabel) || byName(a, b);
        if (order === 'recent') return (b.items[0].backupDisabledAt || 0) - (a.items[0].backupDisabledAt || 0) || byName(a, b);
        return byName(a, b);
    });
}

/** Keep small software groups whole; split only groups exceeding the page limit. */
export function paginateStartupGroups(groups, pageSize = 80) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('每页项目数应为正整数');
    const pages = [];
    let current = [], count = 0;
    const finishPage = () => {
        if (current.length) pages.push(current);
        current = []; count = 0;
    };
    for (const group of groups) {
        const totalCount = group.items.length;
        if (!totalCount) continue;
        if (totalCount <= pageSize && count + totalCount > pageSize) finishPage();
        for (let offset = 0; offset < totalCount;) {
            const length = Math.min(pageSize - count, totalCount - offset);
            current.push({ ...group, items: group.items.slice(offset, offset + length),
                continued: offset > 0, totalCount });
            count += length; offset += length;
            if (count === pageSize) finishPage();
        }
    }
    finishPage();
    return pages;
}
