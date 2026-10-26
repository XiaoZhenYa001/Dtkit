import { normalizeSpaceSettings } from './space-preferences.js';

export function applyGlassSettings(surface, settings) {
    const values = normalizeSpaceSettings(settings);
    surface.style.setProperty('--glass-opacity', String(values.glassOpacity / 100));
    surface.style.setProperty('--glass-blur', `${values.blur}px`);
    surface.dataset.reducedMotion = String(values.reducedMotion);
}

// Lighting only runs in response to input. There is no idle animation or capture
// loop, and reducing motion stops the light from following the pointer.
export function mountGlassMaterial(surface, { interactionTarget = surface, reducedMotion = () => false } = {}) {
    const view = surface.ownerDocument.defaultView;
    const media = view.matchMedia('(prefers-reduced-motion: reduce)');
    const disposers = [];
    let frame = 0, point = null, destroyed = false;
    const reduced = () => media.matches || reducedMotion();
    function on(target, event, handler) {
        target.addEventListener(event, handler);
        disposers.push(() => target.removeEventListener(event, handler));
    }
    function reset() {
        if (frame) view.cancelAnimationFrame(frame);
        frame = 0; point = null;
        for (const name of ['--glass-light-x', '--glass-light-y', '--glass-light-angle']) surface.style.removeProperty(name);
        delete surface.dataset.glassPressed;
    }
    function move(event) {
        if (destroyed || reduced() || event.pointerType === 'touch') return;
        point = { x: event.clientX, y: event.clientY };
        if (frame) return;
        frame = view.requestAnimationFrame(() => {
            frame = 0;
            if (!point || destroyed || reduced()) return;
            const rect = surface.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const x = Math.max(0, Math.min(1, (point.x - rect.left) / rect.width));
            const y = Math.max(0, Math.min(1, (point.y - rect.top) / rect.height));
            surface.style.setProperty('--glass-light-x', `${(x * 100).toFixed(1)}%`);
            surface.style.setProperty('--glass-light-y', `${(y * 100).toFixed(1)}%`);
            surface.style.setProperty('--glass-light-angle', `${(115 + x * 45 - y * 15).toFixed(1)}deg`);
        });
    }
    on(interactionTarget, 'pointermove', move);
    on(interactionTarget, 'pointerleave', reset);
    on(interactionTarget, 'pointerdown', event => {
        move(event);
        if (!reduced()) surface.dataset.glassPressed = 'true';
    });
    on(view, 'pointerup', () => delete surface.dataset.glassPressed);
    on(view, 'pointercancel', reset);
    on(view, 'blur', () => { reset(); delete surface.dataset.glassFocused; });
    on(view, 'focus', () => {
        if (interactionTarget.contains(surface.ownerDocument.activeElement)) surface.dataset.glassFocused = 'true';
    });
    on(interactionTarget, 'focusin', () => { surface.dataset.glassFocused = 'true'; });
    on(interactionTarget, 'focusout', event => {
        if (!interactionTarget.contains(event.relatedTarget)) delete surface.dataset.glassFocused;
    });
    on(media, 'change', reset);
    return {
        refresh() { if (reduced()) reset(); },
        destroy() {
            destroyed = true; reset(); delete surface.dataset.glassFocused;
            disposers.splice(0).forEach(dispose => dispose());
        }
    };
}
