import {
    DEFAULT_MINIMIZE_MODE,
    parseMinimizeMode,
    SETTINGS_STORAGE_KEYS
} from '../views/settings/model.js';

let currentMode = DEFAULT_MINIMIZE_MODE;
let lastStoredValue;
let hasReadStorage = false;
let pendingSave = Promise.resolve();

function getInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

export function getMinimizeMode() {
    try {
        const stored = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEYS.MINIMIZE_MODE);
        if (!hasReadStorage || stored !== lastStoredValue) {
            currentMode = parseMinimizeMode(stored);
            lastStoredValue = stored;
            hasReadStorage = true;
        }
    } catch { /* Keep the current session usable if browser storage is unavailable. */ }
    return currentMode;
}

export async function setMinimizeMode(mode) {
    getMinimizeMode();
    const requestedMode = parseMinimizeMode(mode);
    const save = pendingSave.then(async () => {
        const invoke = getInvoke();
        if (invoke) await invoke('set_minimize_mode', { mode: requestedMode });
        currentMode = requestedMode;
        try {
            globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEYS.MINIMIZE_MODE, requestedMode);
            lastStoredValue = requestedMode;
            hasReadStorage = true;
        } catch { /* The native setting already succeeded; retain it for this session. */ }
        globalThis.window?.dispatchEvent(new CustomEvent('dtkit:minimize-mode-changed', {
            detail: { mode: requestedMode }
        }));
        return requestedMode;
    });
    pendingSave = save.catch(() => {});
    return save;
}

export async function initializeMinimizeMode() {
    return setMinimizeMode(getMinimizeMode());
}
