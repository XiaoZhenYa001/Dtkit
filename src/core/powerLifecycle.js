let initialized = false;
let unlistenPowerState = null;

function applyPowerState(suspended) {
    document.documentElement.classList.toggle('app-is-suspended', suspended);

    if (suspended) {
        document.querySelectorAll('video').forEach(video => video.pause());
    }

    window.dispatchEvent(new CustomEvent('dtkit:power-state', {
        detail: { suspended }
    }));
}

export async function initializePowerLifecycle() {
    if (initialized) return;
    initialized = true;

    const listen = globalThis.window?.__TAURI__?.event?.listen;
    if (!listen) return;

    unlistenPowerState = await listen('app-power-state', event => {
        applyPowerState(Boolean(event.payload?.suspended));
    });
}

export function destroyPowerLifecycle() {
    unlistenPowerState?.();
    unlistenPowerState = null;
    initialized = false;
}
