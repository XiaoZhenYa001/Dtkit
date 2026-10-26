export const CLASSIC_CATEGORY_STORAGE_KEY = 'dtkit_desktop_classic_categories_v1';
const LEGACY_STORAGE_KEY = 'dtkit_desktop_space_v1';
const safeKey = key => typeof key === 'string' && key.length <= 240 && !['__proto__', 'constructor', 'prototype'].includes(key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function normalizeClassicCategoryPreferences(value) {
    const names = {}, orders = {};
    if (object(value?.names)) for (const [key, name] of Object.entries(value.names).slice(0, 100)) {
        if (safeKey(key) && typeof name === 'string' && name.trim()) names[key] = name.trim().slice(0, 40);
    }
    if (object(value?.orders)) for (const [key, ids] of Object.entries(value.orders).slice(0, 100)) {
        if (safeKey(key) && Array.isArray(ids)) orders[key] = [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 1400))].slice(0, 4000);
    }
    return { version: 1, names, orders };
}

function parse(serialized) {
    try { const value = JSON.parse(serialized); return object(value) ? value : null; }
    catch { return null; }
}

export function writeClassicCategoryPreferences(storage, preferences) {
    const normalized = normalizeClassicCategoryPreferences(preferences);
    storage.setItem(CLASSIC_CATEGORY_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
}

export function readClassicCategoryPreferences(storage) {
    const saved = parse(storage.getItem(CLASSIC_CATEGORY_STORAGE_KEY));
    if (saved) return normalizeClassicCategoryPreferences(saved);
    const legacy = parse(storage.getItem(LEGACY_STORAGE_KEY));
    if (!legacy) return normalizeClassicCategoryPreferences(null);
    const names = {};
    if (object(legacy.groups)) for (const [key, group] of Object.entries(legacy.groups).slice(0, 100)) {
        if (safeKey(key) && typeof group?.name === 'string') names[key] = group.name;
    }
    // The launcher may retire the legacy key only after this write succeeds.
    return writeClassicCategoryPreferences(storage, { names, orders: legacy.orders });
}

export function migrateClassicCategoryPath(preferences, oldPath, newPath) {
    const next = normalizeClassicCategoryPreferences(preferences);
    if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !newPath || oldPath === newPath) return next;
    const previous = `file:${oldPath}`, replacement = `file:${newPath}`;
    for (const [key, ids] of Object.entries(next.orders)) next.orders[key] = [...new Set(ids.map(id => id === previous ? replacement : id))];
    return next;
}
