export const SPACE_SETTINGS_KEY = 'dtkit_desktop_space_settings_v1';
export const DEFAULT_SPACE_SETTINGS = Object.freeze({
    version: 1, glassOpacity: 68, blur: 30, iconSize: 'medium', windowWidth: 90,
    windowHeight: 70, closeOnBlur: true, closeAfterOpen: true, reducedMotion: false
});
const numeric = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
export function normalizeSpaceSettings(value = {}) {
    const defaults = DEFAULT_SPACE_SETTINGS;
    return {
        version: 1,
        glassOpacity: numeric(value?.glassOpacity, defaults.glassOpacity, 40, 90),
        blur: numeric(value?.blur, defaults.blur, 12, 48),
        iconSize: ['small', 'medium', 'large'].includes(value?.iconSize) ? value.iconSize : defaults.iconSize,
        windowWidth: numeric(value?.windowWidth, defaults.windowWidth, 60, 96),
        windowHeight: numeric(value?.windowHeight, defaults.windowHeight, 45, 90),
        closeOnBlur: typeof value?.closeOnBlur === 'boolean' ? value.closeOnBlur : defaults.closeOnBlur,
        closeAfterOpen: typeof value?.closeAfterOpen === 'boolean' ? value.closeAfterOpen : defaults.closeAfterOpen,
        reducedMotion: typeof value?.reducedMotion === 'boolean' ? value.reducedMotion : defaults.reducedMotion
    };
}

function cachedSettings() {
    try { return normalizeSpaceSettings(JSON.parse(globalThis.localStorage?.getItem(SPACE_SETTINGS_KEY) || '{}')); }
    catch { return { ...DEFAULT_SPACE_SETTINGS }; }
}
let settings = cachedSettings(), initialization = null, subscribed = false, queue = Promise.resolve();
let nativeRevision = null;
const observers = new Set();
export function getSpaceSettings() { return { ...settings }; }
export function subscribeSpaceSettings(callback) {
    observers.add(callback);
    return () => observers.delete(callback);
}
function receive(value, { cache = true } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Number.isSafeInteger(value.revision) && value.revision >= 0) {
        if (nativeRevision !== null && value.revision < nativeRevision) return;
        nativeRevision = value.revision;
    }
    settings = normalizeSpaceSettings(value);
    if (cache) try {
        globalThis.localStorage?.setItem(SPACE_SETTINGS_KEY, JSON.stringify({ ...settings, ...(nativeRevision === null ? {} : { revision: nativeRevision }) }));
    } catch { /* Native settings remain authoritative. */ }
    for (const callback of observers) callback(getSpaceSettings());
}
function listenForUpdates() {
    if (subscribed || !globalThis.window) return;
    subscribed = true;
    const controller = new AbortController();
    window.addEventListener('storage', event => {
        if (event.key !== SPACE_SETTINGS_KEY || !event.newValue) return;
        try {
            receive(JSON.parse(event.newValue), { cache: false });
        } catch { /* Keep the last valid settings. */ }
    }, { signal: controller.signal });
    let unlisten = null;
    const listen = window.__TAURI__?.event?.listen;
    if (listen) Promise.resolve(listen('desktop-space-settings-changed', event => receive(event.payload)))
        .then(dispose => { if (controller.signal.aborted) dispose(); else unlisten = dispose; }).catch(() => {});
    window.addEventListener('pagehide', () => { controller.abort(); unlisten?.(); observers.clear(); }, { once: true });
}
export function initializeSpaceSettings() {
    listenForUpdates();
    if (!initialization) initialization = (async () => {
        const invoke = globalThis.window?.__TAURI__?.core?.invoke;
        if (!invoke) return getSpaceSettings();
        receive(await invoke('get_desktop_space_settings'));
        return getSpaceSettings();
    })().catch(error => { initialization = null; throw error; });
    return initialization;
}
export function updateSpaceSettings(patch) {
    const operation = queue.then(async () => {
        const invoke = globalThis.window?.__TAURI__?.core?.invoke;
        if (!invoke) throw new Error('当前环境无法保存桌面空间设置');
        const result = await invoke('update_desktop_space_settings', { patch });
        if (!result || typeof result !== 'object') throw new Error('空间设置未能保存，请重试');
        receive(result);
        return getSpaceSettings();
    });
    queue = operation.catch(() => {});
    return operation;
}
