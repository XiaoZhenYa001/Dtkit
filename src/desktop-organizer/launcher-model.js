import { readClassicCategoryPreferences } from './classic-preferences.js';

export const LAUNCHER_STORAGE_KEY = 'dtkit_desktop_space_v2';
const LEGACY_STORAGE_KEY = 'dtkit_desktop_space_v1';
const MAX_ITEMS = 4000;
const MAX_PATH = 1400;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);

// This is an identity for Windows UI metadata, not a filesystem permission check.
function canonicalPath(path) {
    if (!text(path, MAX_PATH) || !path.trim()) return '';
    let normalized = path.replaceAll('/', '\\');
    if (normalized.toLowerCase().startsWith('\\\\?\\unc\\')) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith('\\\\?\\') && /^[a-z]:\\/i.test(normalized.slice(4))) normalized = normalized.slice(4);
    const prefix = normalized.startsWith('\\\\') ? '\\\\' : '';
    normalized = normalized.replace(/\\+/g, '\\');
    return (prefix + normalized.replace(/^\\+/, prefix ? '' : '\\'))
        .replace(/\\+$/, '').toLowerCase();
}

export function launcherFileId(file) {
    const path = canonicalPath(file?.path);
    if (!path) return '';
    return text(file.app_id, 240) ? `app:${file.app_id}` : `file:${path}`;
}

export function launcherFolderScope(path) {
    const normalized = canonicalPath(path);
    return normalized ? `folder:${normalized}` : '';
}

function normalizeScope(scope) {
    if (!safeKey(scope)) return '';
    if (scope === 'root' || scope === 'pinned') return scope;
    if (scope.startsWith('folder:')) return launcherFolderScope(scope.slice(7));
    return /^(?:[a-z]:[\\/]|[\\/])/i.test(scope) ? launcherFolderScope(scope) : '';
}

function normalizeId(id) {
    if (!text(id, MAX_PATH + 5)) return '';
    if (id.startsWith('file:')) {
        const path = canonicalPath(id.slice(5));
        return path ? `file:${path}` : '';
    }
    return id.startsWith('app:') && text(id.slice(4), 240) ? id : '';
}

function normalizeIds(ids) {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.slice(0, MAX_ITEMS).map(normalizeId).filter(Boolean))];
}

function pinnedRecord(file) {
    if (!plainObject(file) || !launcherFileId(file)) return null;
    const name = text(file.name, 255) ? file.name : file.path.replaceAll('/', '\\').split('\\').filter(Boolean).at(-1);
    if (!text(name, 255)) return null;
    return {
        path: file.path,
        name,
        is_folder: file.is_folder === true,
        ...(text(file.app_id, 240) ? { app_id: file.app_id } : {}),
        size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
        category: text(file.category, 80) ? file.category : file.is_folder ? 'folder' : file.app_id ? 'program' : 'other'
    };
}

export function normalizeLauncherPreferences(input) {
    const pinned = [];
    const byPath = new Map();
    const seenIds = new Set();
    for (const item of (Array.isArray(input?.pinned) ? input.pinned : []).slice(0, MAX_ITEMS)) {
        const file = pinnedRecord(item);
        if (!file) continue;
        const path = canonicalPath(file.path);
        const id = launcherFileId(file);
        const previous = byPath.get(path);
        if (previous !== undefined) {
            if (file.app_id && !pinned[previous].app_id && !seenIds.has(id)) {
                seenIds.delete(launcherFileId(pinned[previous]));
                pinned[previous] = file;
                seenIds.add(id);
            }
            continue;
        }
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        byPath.set(path, pinned.length);
        pinned.push(file);
    }
    const orders = { root: [] };
    if (plainObject(input?.orders)) {
        for (const [key, ids] of Object.entries(input.orders).slice(0, 500)) {
            const scope = normalizeScope(key);
            if (scope) orders[scope] = normalizeIds([...(orders[scope] || []), ...normalizeIds(ids)]);
        }
    }
    return { version: 2, pinned, orders };
}

function uniqueFiles(files) {
    const paths = new Map();
    for (const file of files) {
        if (!plainObject(file) || !launcherFileId(file) || !text(file.name, 255)) continue;
        const key = canonicalPath(file.path);
        if (!paths.has(key) || file.app_id && !paths.get(key).app_id) paths.set(key, file);
    }
    const seenIds = new Set();
    return [...paths.values()].filter(file => {
        const id = launcherFileId(file);
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
    });
}

export function collectLauncherFiles(scan) {
    const keys = ['applications', 'documents', 'images', 'videos', 'audios', 'archives', 'programs', 'folders', 'others', 'recent'];
    return uniqueFiles(keys.flatMap(key => Array.isArray(scan?.[key]) ? scan[key] : []));
}

export function orderedLauncherFiles(files, preferences, scope = 'root') {
    const prefs = normalizeLauncherPreferences(preferences);
    const order = new Map((prefs.orders[normalizeScope(scope)] || []).map((id, index) => [id, index]));
    return uniqueFiles(Array.isArray(files) ? files : []).sort((left, right) => {
        const leftId = launcherFileId(left), rightId = launcherFileId(right);
        const leftPosition = order.get(leftId) ?? order.get(`file:${canonicalPath(left.path)}`);
        const rightPosition = order.get(rightId) ?? order.get(`file:${canonicalPath(right.path)}`);
        if (leftPosition !== undefined || rightPosition !== undefined) {
            if (leftPosition === undefined) return 1;
            if (rightPosition === undefined) return -1;
            return leftPosition - rightPosition;
        }
        return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
            || leftId.localeCompare(rightId, 'en');
    });
}

export function setLauncherPinned(preferences, file, pinned) {
    const next = normalizeLauncherPreferences(preferences);
    const record = pinnedRecord(file);
    if (!record) return next;
    const path = canonicalPath(record.path);
    const index = next.pinned.findIndex(item => canonicalPath(item.path) === path || launcherFileId(item) === launcherFileId(record));
    if (pinned) {
        if (index < 0) {
            if (next.pinned.length >= MAX_ITEMS) return next;
            next.pinned.push(record);
        }
        else next.pinned[index] = record;
        next.orders.pinned = normalizeIds([...(next.orders.pinned || []), launcherFileId(record)]);
    } else if (index >= 0) next.pinned.splice(index, 1);
    return next;
}

export function reorderLauncherFiles(preferences, scope, draggedId, beforeId, visibleIds, scopeFiles = []) {
    const next = normalizeLauncherPreferences(preferences);
    const key = normalizeScope(scope), dragged = normalizeId(draggedId);
    const visible = normalizeIds(visibleIds), visibleSet = new Set(visible);
    const before = beforeId == null ? null : normalizeId(beforeId);
    if (!key || !dragged || !visibleSet.has(dragged) || before === dragged
        || beforeId != null && (!before || !visibleSet.has(before))) return next;
    const allFiles = uniqueFiles(scopeFiles);
    const aliases = new Map(allFiles.filter(file => file.app_id)
        .map(file => [`file:${canonicalPath(file.path)}`, launcherFileId(file)]));
    const saved = (next.orders[key] || []).map(id => aliases.get(id) || id);
    const order = normalizeIds([...saved, ...allFiles.map(launcherFileId), ...visible]);
    const moved = order.filter(id => visibleSet.has(id) && id !== dragged);
    moved.splice(before === null ? moved.length : moved.indexOf(before), 0, dragged);
    let position = 0;
    // Filtering does not rewrite or discard the slots occupied by hidden files.
    next.orders[key] = order.map(id => visibleSet.has(id) ? moved[position++] : id);
    return next;
}

export function migrateLauncherPath(preferences, oldPath, newPath) {
    const next = normalizeLauncherPreferences(preferences);
    const previous = canonicalPath(oldPath), current = canonicalPath(newPath);
    if (!previous || !current) return next;
    const migrate = path => path === previous || path.startsWith(`${previous}\\`) ? `${current}${path.slice(previous.length)}` : path;
    for (const file of next.pinned) {
        const path = canonicalPath(file.path);
        if (path !== previous && !path.startsWith(`${previous}\\`)) continue;
        file.path = `${newPath}${path.slice(previous.length)}`;
        if (path === previous) file.name = newPath.replaceAll('/', '\\').split('\\').filter(Boolean).at(-1) || file.name;
    }
    for (const [scope, ids] of Object.entries(next.orders)) {
        const newScope = scope.startsWith('folder:') ? `folder:${migrate(scope.slice(7))}` : scope;
        const migrated = ids.map(id => id.startsWith('file:') ? `file:${migrate(id.slice(5))}` : id);
        if (newScope !== scope) delete next.orders[scope];
        next.orders[newScope] = normalizeIds([...(newScope !== scope ? next.orders[newScope] || [] : []), ...migrated]);
    }
    return normalizeLauncherPreferences(next);
}

function parseStoredPreferences(serialized, version, label) {
    const value = JSON.parse(serialized);
    if (!plainObject(value) || value.version !== undefined && value.version !== version
        || value.orders !== undefined && !plainObject(value.orders)
        || version === 2 && value.pinned !== undefined && !Array.isArray(value.pinned)) {
        throw new Error(`${label}格式或版本无效`);
    }
    return value;
}

// Loading is independent of writes: a full or temporarily read-only store must
// not turn already saved pins and ordering into empty in-memory preferences.
export function readLauncherPreferences(storage) {
    const current = storage.getItem(LAUNCHER_STORAGE_KEY);
    if (current !== null) {
        return normalizeLauncherPreferences(parseStoredPreferences(current, 2, '固定与排序设置'));
    }
    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    const previous = legacy === null ? {} : parseStoredPreferences(legacy, 1, '旧版固定与排序设置');
    const ids = plainObject(previous.orders) ? Object.entries(previous.orders)
        .filter(([key]) => safeKey(key)).flatMap(([, order]) => normalizeIds(order)) : [];
    return normalizeLauncherPreferences({ orders: { root: ids } });
}

export function migrateLauncherPreferences(storage) {
    const preferences = readLauncherPreferences(storage);
    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null) return preferences;
    // Even with authoritative v2, do not retire malformed legacy bytes that
    // cannot be backed up as classic preferences.
    parseStoredPreferences(legacy, 1, '旧版固定与排序设置');
    // Classic keeps its category aliases and order after the retired layout is removed.
    readClassicCategoryPreferences(storage);
    if (storage.getItem(LAUNCHER_STORAGE_KEY) === null) {
        storage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify(preferences));
    }
    storage.removeItem(LEGACY_STORAGE_KEY);
    return preferences;
}
