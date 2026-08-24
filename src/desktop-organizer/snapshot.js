export const DESKTOP_SNAPSHOT_KEY = 'dtkit_desktop_snapshot_v1';

const SNAPSHOT_VERSION = 3;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_ITEMS = 800;
const RECENT_LIMIT = 7;
const CATEGORY_KEYS = Object.freeze([
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
const VALID_CATEGORIES = new Set([
    'document',
    'image',
    'video',
    'audio',
    'archive',
    'program',
    'folder',
    'other'
]);

function boundedString(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function finiteUnsigned(value) {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function compactFile(file, includeChildren = true) {
    if (!file || typeof file !== 'object') return null;

    const path = boundedString(file.path, 2048);
    const name = boundedString(file.name, 255);
    if (!path || !name) return null;

    const isFolder = file.is_folder === true;
    const category = VALID_CATEGORIES.has(file.category)
        ? file.category
        : (isFolder ? 'folder' : 'other');
    const children = includeChildren && isFolder && Array.isArray(file.children)
        ? file.children.slice(0, 5).map(child => compactFile(child, false)).filter(Boolean)
        : null;

    return {
        name,
        path,
        category,
        is_folder: isFolder,
        size: finiteUnsigned(file.size),
        extension: boundedString(file.extension, 32),
        modified_time: finiteUnsigned(file.modified_time),
        accessed_time: finiteUnsigned(file.accessed_time),
        children,
        children_truncated: file.children_truncated === true,
        app_id: boundedString(file.app_id, 64) || null,
        app_category: boundedString(file.app_category, 80) || null,
        app_manual: file.app_manual === true,
        // Base64 shell icons dominate snapshot size and are cheap to restore after the live scan.
        icon: null
    };
}

function compactFiles(files) {
    let remaining = SNAPSHOT_MAX_ITEMS;
    const compacted = {};

    for (const key of CATEGORY_KEYS) {
        const source = Array.isArray(files?.[key]) ? files[key] : [];
        compacted[key] = source
            .slice(0, remaining)
            .map(file => compactFile(file))
            .filter(Boolean);
        remaining -= compacted[key].length;
    }

    compacted.recent = (Array.isArray(files?.recent) ? files.recent : [])
        .slice(0, RECENT_LIMIT)
        .map(file => compactFile(file))
        .filter(Boolean);
    compacted.total_count = finiteUnsigned(files?.total_count);
    return compacted;
}

export function createDesktopSnapshot(files, capturedAt = Date.now()) {
    return {
        version: SNAPSHOT_VERSION,
        capturedAt: finiteUnsigned(capturedAt),
        files: compactFiles(files)
    };
}

export function writeDesktopSnapshot(storage, files, capturedAt = Date.now()) {
    if (!storage?.setItem) return false;
    try {
        storage.setItem(
            DESKTOP_SNAPSHOT_KEY,
            JSON.stringify(createDesktopSnapshot(files, capturedAt))
        );
        return true;
    } catch {
        storage.removeItem?.(DESKTOP_SNAPSHOT_KEY);
        return false;
    }
}

export function readDesktopSnapshot(storage, now = Date.now()) {
    if (!storage?.getItem) return null;
    try {
        const parsed = JSON.parse(storage.getItem(DESKTOP_SNAPSHOT_KEY));
        const capturedAt = finiteUnsigned(parsed?.capturedAt);
        const age = now - capturedAt;
        if (parsed?.version !== SNAPSHOT_VERSION || age < 0 || age > SNAPSHOT_MAX_AGE_MS) {
            storage.removeItem?.(DESKTOP_SNAPSHOT_KEY);
            return null;
        }
        return createDesktopSnapshot(parsed.files, capturedAt);
    } catch {
        storage.removeItem?.(DESKTOP_SNAPSHOT_KEY);
        return null;
    }
}

function textFingerprint(value) {
    if (typeof value !== 'string' || !value) return '';
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function fileFingerprint(file) {
    const children = Array.isArray(file.children)
        ? file.children.map(fileFingerprint).sort().join(',')
        : '';
    return [
        file.path,
        file.name,
        file.category,
        file.extension,
        file.is_folder === true ? 1 : 0,
        file.size,
        file.modified_time,
        file.accessed_time,
        file.app_id || '',
        file.app_category || '',
        file.app_manual === true ? 1 : 0,
        textFingerprint(file.icon),
        file.children_truncated === true ? 1 : 0,
        children
    ].join('\u0000');
}

export function desktopSnapshotFingerprint(files) {
    if (!files || typeof files !== 'object') return '';
    return CATEGORY_KEYS
        .flatMap(key => (Array.isArray(files[key]) ? files[key] : []).map(fileFingerprint))
        .sort()
        .concat(`total:${finiteUnsigned(files.total_count)}`)
        .join('\u0001');
}
