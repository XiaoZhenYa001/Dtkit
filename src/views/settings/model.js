export const SETTINGS_STORAGE_KEYS = Object.freeze({
    SHORTCUTS: 'dtkit_shortcuts',
    CUSTOM_MIRROR: 'dtkit_custom_mirror_source',
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

export function parseCustomMirrorConfig(input) {
    const source = String(input ?? '').trim();
    if (!source) throw new TypeError('请输入 JSON 格式的配置');

    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        throw new SyntaxError(`JSON 格式错误：${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('配置必须是一个 JSON 对象');
    }

    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const urlValue = typeof parsed.url === 'string' ? parsed.url.trim() : '';
    if (!name || !urlValue) throw new TypeError('配置缺少必需的 name 或 url 字段');

    let url;
    try {
        url = new URL(urlValue);
    } catch {
        throw new TypeError('URL 格式无效');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new TypeError('镜像源仅支持 HTTP 或 HTTPS 地址');
    }

    return Object.freeze({
        name,
        url: url.toString(),
        description: typeof parsed.description === 'string' ? parsed.description.trim() : ''
    });
}
