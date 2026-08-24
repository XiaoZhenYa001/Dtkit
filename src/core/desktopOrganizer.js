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
        return {
            ...DEFAULT_SETTINGS,
            ...JSON.parse(savedSettings),
            // Keep the dormant feature off until an analyzer and confirmation flow exist.
            autoAnalyze: false
        };
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
    if (monitorStartPromise) {
        try {
            await monitorStartPromise;
        } catch {
            // A failed start leaves nothing to stop.
        }
    }
    const invoke = getTauriInvoke();
    if (!invoke) {
        monitorStarted = false;
        return false;
    }

    await invoke('stop_hotzone');
    monitorStarted = false;
    return true;
}

export async function setDesktopOrganizerEnabled(enabled) {
    const nextEnabled = enabled === true;
    const succeeded = nextEnabled
        ? await startDesktopOrganizerMonitor()
        : await stopDesktopOrganizerMonitor();
    if (!succeeded) {
        throw new Error('当前环境无法控制桌面整理热区');
    }

    const nextSettings = {
        ...getDesktopOrganizerSettings(),
        enabled: nextEnabled
    };
    saveDesktopOrganizerSettings(nextSettings);
    return nextSettings;
}

export async function bootstrapDesktopOrganizer() {
    if (!lifecycleInitialized && typeof globalThis.window?.addEventListener === 'function') {
        lifecycleInitialized = true;
        globalThis.window.addEventListener('dtkit:power-state', event => {
            // 热区是原生低频监听，不依赖主 WebView。节能/深度休眠期间也应继续可用；
            // 桌面整理 WebView 仍会在离开面板后按资源策略关闭。
            if (getDesktopOrganizerSettings().enabled) {
                startDesktopOrganizerMonitor().catch(error => {
                    console.error('[DesktopOrganizer] 保持热区监听失败', error);
                });
            }
        });
    }

    const settings = getDesktopOrganizerSettings();
    if (!settings.enabled) return false;
    return startDesktopOrganizerMonitor();
}
