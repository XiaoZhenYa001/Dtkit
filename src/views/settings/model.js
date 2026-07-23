export const SETTINGS_STORAGE_KEYS = Object.freeze({
    SHORTCUTS: 'dtkit_shortcuts',
    MINIMIZE_MODE: 'dtkit_minimize_mode'
});

export const MINIMIZE_MODES = Object.freeze(['standard', 'efficient', 'deep']);
export const DEFAULT_MINIMIZE_MODE = 'efficient';

export function parseMinimizeMode(value) {
    return MINIMIZE_MODES.includes(value) ? value : DEFAULT_MINIMIZE_MODE;
}

export const DEFAULT_SHORTCUTS = Object.freeze({});

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const KEY_LABELS = Object.freeze({
    ' ': 'Space',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
});

export function parseStoredShortcuts(serialized, defaults = DEFAULT_SHORTCUTS) {
    if (!serialized) return { ...defaults };

    try {
        const parsed = JSON.parse(serialized);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults };

        const shortcuts = { ...defaults };
        for (const [id, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value.trim()) shortcuts[id] = value.trim();
        }
        return shortcuts;
    } catch {
        return { ...defaults };
    }
}

export function shortcutFromKeyboardEvent(event) {
    if (!event || MODIFIER_KEYS.has(event.key)) return null;
    if (event.key === 'Escape') return 'Escape';

    const keys = [];
    if (event.ctrlKey) keys.push('Ctrl');
    if (event.shiftKey) keys.push('Shift');
    if (event.altKey) keys.push('Alt');
    if (event.metaKey) keys.push('Super');

    let keyName = KEY_LABELS[event.key] || event.key;
    if (keyName.length === 1) keyName = keyName.toUpperCase();
    keys.push(keyName);
    return keys.join('+');
}

export function findShortcutConflict(shortcuts, shortcutId, candidate) {
    return Object.entries(shortcuts).find(([id, value]) => id !== shortcutId && value === candidate) || null;
}
