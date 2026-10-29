export function prefersReducedSettingsMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function parseSettingsMotionTiming(value) {
    const match = String(value || '').trim().match(/^([\d.]+)(ms|s)\s+(.+)$/);
    return match && Number.isFinite(Number(match[1]))
        ? { duration: Math.min(300, Number(match[1]) * (match[2] === 's' ? 1000 : 1)), easing: match[3] }
        : { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
}

export function settingsMotionTiming(element, token = '--transition-normal') {
    return parseSettingsMotionTiming(globalThis.getComputedStyle?.(element).getPropertyValue(token));
}

/** Keep disclosure semantics synchronous; only its disappearing pixels outlive a close. */
export function createSettingsDisclosure({ content, trigger }) {
    if (!content?.parentElement || !trigger) return null;
    const shell = document.createElement('div');
    shell.className = 'settings-disclosure-shell';
    content.before(shell); shell.append(content);
    let animation = null;
    let expanded = !content.hidden;
    let generation = 0;
    let destroyed = false;
    const restoreStyles = () => {
        shell.style.height = '';
        shell.style.overflow = '';
        shell.style.opacity = '';
    };
    const settle = () => {
        animation?.cancel(); animation = null;
        content.hidden = !expanded;
        shell.hidden = !expanded;
        restoreStyles();
    };

    return {
        setExpanded(value, { animate = true } = {}) {
            if (destroyed) return;
            const next = Boolean(value);
            if (next === expanded && animation && animate) return;
            const version = ++generation;
            const wasHidden = content.hidden || shell.hidden;
            const startHeight = wasHidden ? 0 : shell.getBoundingClientRect().height;
            const startOpacity = wasHidden ? 0 : Number(getComputedStyle(shell).opacity);
            animation?.cancel(); animation = null;
            expanded = next;
            trigger.setAttribute('aria-expanded', String(next));
            if (!next && content.contains(document.activeElement)) trigger.focus({ preventScroll: true });
            content.inert = !next;
            content.setAttribute('aria-hidden', String(!next));
            content.hidden = false; shell.hidden = false;
            restoreStyles();
            const targetHeight = next ? shell.getBoundingClientRect().height : 0;
            if (!animate || prefersReducedSettingsMotion() || typeof shell.animate !== 'function'
                || Math.abs(startHeight - targetHeight) < 1) {
                settle(); return;
            }
            shell.style.overflow = 'hidden';
            animation = shell.animate([
                { height: `${startHeight}px`, opacity: startOpacity },
                { height: `${targetHeight}px`, opacity: next ? 1 : 0 }
            ], { ...settingsMotionTiming(content), fill: 'both' });
            animation.finished.then(() => {
                if (!destroyed && version === generation) settle();
            }, () => {});
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; generation++;
            settle();
            shell.replaceWith(content);
        }
    };
}
