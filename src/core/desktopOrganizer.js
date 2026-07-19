const STORAGE_KEY = 'dtkit_desktop_organizer';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    autoAnalyze: false
});

let monitorStartPromise = null;
let monitorStarted = false;
let lifecycleInitialized = false;

export function getDesktopOrganizerSettings() {
    const savedSettings = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!savedSettings) return { ...DEFAULT_SETTINGS };

    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };
    } catch (error) {
        console.error('加载桌面整理设置失败:', error);
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveDesktopOrganizerSettings(settings) {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getTauriInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

export async function startDesktopOrganizerMonitor() {
    if (monitorStarted) return true;
    if (monitorStartPromise) return monitorStartPromise;

    const invoke = getTauriInvoke();
    if (!invoke) return false;

    monitorStartPromise = invoke('start_hotzone_monitor')
        .then(() => {
            monitorStarted = true;
            return true;
        })
        .finally(() => {
            monitorStartPromise = null;
        });

    return monitorStartPromise;
}

export async function stopDesktopOrganizerMonitor() {
    const invoke = getTauriInvoke();
    if (!invoke) {
        monitorStarted = false;
        return false;
    }

    await invoke('stop_hotzone');
    monitorStarted = false;
    return true;
}

export async function bootstrapDesktopOrganizer() {
    if (!lifecycleInitialized && typeof globalThis.window?.addEventListener === 'function') {
        lifecycleInitialized = true;
        globalThis.window.addEventListener('dtkit:power-state', event => {
            const suspended = Boolean(event.detail?.suspended);
            if (suspended) {
                stopDesktopOrganizerMonitor().catch(error => {
                    console.error('[DesktopOrganizer] 暂停热区监听失败', error);
                });
            } else if (getDesktopOrganizerSettings().enabled) {
                startDesktopOrganizerMonitor().catch(error => {
                    console.error('[DesktopOrganizer] 恢复热区监听失败', error);
                });
            }
        });
    }

    const settings = getDesktopOrganizerSettings();
    if (!settings.enabled) return false;
    return startDesktopOrganizerMonitor();
}
