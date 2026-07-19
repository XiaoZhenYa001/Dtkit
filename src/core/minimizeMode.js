import {
    DEFAULT_MINIMIZE_MODE,
    parseMinimizeMode,
    SETTINGS_STORAGE_KEYS
} from '../views/settings/model.js';

let currentMode = DEFAULT_MINIMIZE_MODE;

function getInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

export function getMinimizeMode() {
    const stored = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEYS.MINIMIZE_MODE);
    currentMode = parseMinimizeMode(stored);
    return currentMode;
}

export async function setMinimizeMode(mode) {
    currentMode = parseMinimizeMode(mode);
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEYS.MINIMIZE_MODE, currentMode);

    const invoke = getInvoke();
    if (invoke) await invoke('set_minimize_mode', { mode: currentMode });

    globalThis.window?.dispatchEvent(new CustomEvent('dtkit:minimize-mode-changed', {
        detail: { mode: currentMode }
    }));
    return currentMode;
}

export async function initializeMinimizeMode() {
    return setMinimizeMode(getMinimizeMode());
}
