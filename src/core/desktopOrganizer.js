const STORAGE_KEY = 'dtkit_desktop_organizer';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    autoAnalyze: false
});
const PRESENTATION_DEFAULTS = Object.freeze({
    presentation: 'classic',
    reducedMotion: false
});
const PRESENTATION_VALUES = Object.freeze({
    presentation: ['classic', 'space']
});
const PRESENTATION_KEYS = Object.keys(PRESENTATION_DEFAULTS);

let mutationQueue = Promise.resolve();
let presentationRevision = 0;
let bootstrapPromise = null;
let lifecycleInitialized = false;
let shortcutWarning = '';

export function getDesktopOrganizerShortcutWarning() { return shortcutWarning; }
export function clearDesktopOrganizerShortcutWarning() { shortcutWarning = ''; }

function serializeMutation(operation) {
    const pending = mutationQueue.then(operation, operation);
    mutationQueue = pending.catch(() => {});
    return pending;
}

export function normalizeDesktopOrganizerPresentation(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return {
        presentation: PRESENTATION_VALUES.presentation.includes(source.presentation)
            ? source.presentation : PRESENTATION_DEFAULTS.presentation,
        reducedMotion: source.reducedMotion === true
    };
}

function validateStoredPresentation(settings) {
    const { layout, appearance, ...current } = settings;
    // Keep the legacy enablement settings shape until presentation preferences are saved.
    // Both old installations and fresh installations receive presentation defaults through
    // normalizeDesktopOrganizerPresentation.
    return PRESENTATION_KEYS.some(key => Object.hasOwn(current, key))
        ? { ...current, ...normalizeDesktopOrganizerPresentation(current) }
        : current;
}

export function getDesktopOrganizerSettings() {
    const savedSettings = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!savedSettings) return { ...DEFAULT_SETTINGS };

    try {
        return validateStoredPresentation({
            ...DEFAULT_SETTINGS,
            ...JSON.parse(savedSettings),
            // Keep the dormant feature off until an analyzer and confirmation flow exist.
            autoAnalyze: false
        });
    } catch (error) {
        console.error('加载桌面整理设置失败:', error);
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveDesktopOrganizerSettings(settings) {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(validateStoredPresentation(settings)));
}

async function notifyPresentation(preferences) {
    const targetWindow = globalThis.window;
    if (typeof targetWindow?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
        targetWindow.dispatchEvent(new CustomEvent('dtkit:desktop-organizer-presentation-changed', {
            detail: { preferences }
        }));
    }
    const emit = targetWindow?.__TAURI__?.event?.emit;
    if (typeof emit === 'function') {
        try {
            await emit('desktop-organizer-presentation-changed', { preferences });
        } catch (error) {
            console.error('[DesktopOrganizer] 同步桌面外观失败', error);
        }
    }
}

export async function updateDesktopOrganizerPresentation(patch) {
    const selectionRevision = patch && Object.hasOwn(patch, 'presentation') ? ++presentationRevision : 0;
    const preferences = await serializeMutation(async () => {
        const current = getDesktopOrganizerSettings();
        const updates = {};
        if (patch && typeof patch === 'object') {
            for (const key of PRESENTATION_KEYS) {
                if (Object.hasOwn(patch, key) && (key !== 'presentation' || selectionRevision === presentationRevision)) {
                    updates[key] = patch[key];
                }
            }
        }
        const preferences = normalizeDesktopOrganizerPresentation({
            ...normalizeDesktopOrganizerPresentation(current),
            ...updates
        });
        const next = { ...current, ...preferences };
        saveDesktopOrganizerSettings(next);
        if (normalizeDesktopOrganizerPresentation(current).presentation !== preferences.presentation) {
            try {
                await applyRuntime(next);
            } catch (error) {
                saveDesktopOrganizerSettings(current);
                throw error;
            }
        }
        return preferences;
    });
    await notifyPresentation(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
    return preferences;
}

function getTauriInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

async function applyRuntime(settings) {
    const invoke = getTauriInvoke();
    if (!invoke) return false;
    const mode = {
        enabled: settings.enabled === true,
        presentation: normalizeDesktopOrganizerPresentation(settings).presentation
    };
    // Another WebView can change the native mode while this module stays alive.
    // Every top-level action must reach the shared manager; local caches are stale.
    const result = await invoke('set_desktop_organizer_mode', mode);
    shortcutWarning = mode.enabled && mode.presentation === 'space' && typeof result?.shortcutWarning === 'string'
        ? result.shortcutWarning : '';
    if (typeof globalThis.window?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
        globalThis.window.dispatchEvent(new CustomEvent('dtkit:shortcut-bindings-changed', { detail: null }));
    }
    return true;
}

// Keep lifecycle names for existing callers. Space owns a shortcut launcher;
// only classic starts the upper-right monitor, through the native mode manager.
export async function startDesktopOrganizerMonitor() {
    return serializeMutation(() => applyRuntime({ ...getDesktopOrganizerSettings(), enabled: true }));
}

export async function stopDesktopOrganizerMonitor() {
    return serializeMutation(() => applyRuntime({ ...getDesktopOrganizerSettings(), enabled: false }));
}

export async function setDesktopOrganizerEnabled(enabled) {
    return serializeMutation(async () => {
        const current = getDesktopOrganizerSettings();
        const nextSettings = { ...current, enabled: enabled === true };
        const succeeded = await applyRuntime(nextSettings);
        if (!succeeded) throw new Error('当前环境无法控制桌面整理');
        try {
            saveDesktopOrganizerSettings(nextSettings);
        } catch (error) {
            await applyRuntime(current).catch(rollbackError => {
                console.error('[DesktopOrganizer] 恢复整理方式失败', rollbackError);
            });
            throw error;
        }
        return nextSettings;
    });
}

export async function bootstrapDesktopOrganizer() {
    if (!lifecycleInitialized && typeof globalThis.window?.addEventListener === 'function') {
        lifecycleInitialized = true;
        globalThis.window.addEventListener('dtkit:power-state', () => {
            // Both desktop hosting and the classic monitor outlive the main WebView.
            if (getDesktopOrganizerSettings().enabled) {
                startDesktopOrganizerMonitor().catch(error => {
                    console.error('[DesktopOrganizer] 保持桌面整理运行失败', error);
                });
            }
        });
    }

    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = serializeMutation(async () => {
        const invoke = getTauriInvoke();
        if (!invoke) return false;
        const savedMode = await invoke('get_desktop_organizer_mode');
        let settings = getDesktopOrganizerSettings();
        if (savedMode?.configured === true) {
            settings = {
                ...settings,
                enabled: savedMode.enabled === true,
                presentation: normalizeDesktopOrganizerPresentation(savedMode).presentation
            };
            saveDesktopOrganizerSettings(settings);
        }
        const succeeded = await applyRuntime(settings);
        return succeeded && settings.enabled === true;
    }).finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
}
