import { getSpaceSettings, initializeSpaceSettings, subscribeSpaceSettings } from './space-preferences.js';
import { applyGlassSettings, mountGlassMaterial } from './glass-material.js';

const surface = document.querySelector('.launcher-material');
const material = mountGlassMaterial(surface, {
    interactionTarget: document.querySelector('#launcher'),
    reducedMotion: () => getSpaceSettings().reducedMotion
});

export function getLauncherOptions() { return getSpaceSettings(); }
function apply(settings) {
    const style = document.documentElement.style;
    style.setProperty('--glass-opacity', String(settings.glassOpacity / 100));
    style.setProperty('--glass-blur', `${settings.blur}px`);
    applyGlassSettings(surface, settings);
    material.refresh();
    document.documentElement.dataset.iconSize = settings.iconSize;
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
    window.dispatchEvent(new CustomEvent('dtkit:space-settings-applied', { detail: settings }));
}
apply(getSpaceSettings());
const dispose = subscribeSpaceSettings(apply);
void initializeSpaceSettings().catch(() => {});
let unlistenMaterial = null, disposed = false;
void window.__TAURI__?.event?.listen('desktop-space-material', event => {
    document.documentElement.dataset.nativeBackdrop = event.payload.available ? 'available' : 'unavailable';
    window.dispatchEvent(new CustomEvent('dtkit:space-material-applied'));
}).then(unlisten => { if (disposed) unlisten(); else unlistenMaterial = unlisten; }).catch(() => {});
window.addEventListener('pagehide', () => {
    disposed = true; dispose(); material.destroy(); unlistenMaterial?.();
}, { once: true });
