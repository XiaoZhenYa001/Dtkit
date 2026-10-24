import { prefersReducedMotion } from '../../core/toolMotion.js';

/** Crossfade two real panels while keeping the surrounding layout continuous. */
export function createPanelMotion(signal) {
    const groups = new Map();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const settle = record => {
        record.animations.forEach(animation => animation.cancel());
        record.animations = [];
        for (const panel of record.panels) {
            panel.hidden = panel !== record.target;
            panel.inert = panel !== record.target;
            panel.style.position = ''; panel.style.width = ''; panel.style.top = ''; panel.style.left = '';
        }
    };
    const show = (parent, target, { immediate = false } = {}) => {
        if (!parent || !target || signal.aborted) return;
        const old = groups.get(parent);
        if (old?.target === target) return;
        const height = parent.getBoundingClientRect().height;
        const panels = [...parent.children];
        const outgoing = old?.target || panels.find(panel => !panel.hidden);
        const from = outgoing && getComputedStyle(outgoing).opacity;
        const paintedTarget = old?.animations.length && !target.hidden ? getComputedStyle(target) : null;
        const incomingFrom = paintedTarget ? { opacity: paintedTarget.opacity, translate: paintedTarget.translate } : { opacity: 0, translate: '0 8px' };
        if (old) settle(old);
        const record = { panels, target, animations: [] }; groups.set(parent, record);
        for (const panel of panels) { panel.hidden = panel !== target; panel.inert = panel !== target; }
        if (immediate || !outgoing || outgoing === target || prefersReducedMotion()) return;
        outgoing.hidden = false; outgoing.inert = true;
        outgoing.style.position = 'absolute'; outgoing.style.top = '0'; outgoing.style.left = '0'; outgoing.style.width = '100%';
        const duration = 300, easing = 'cubic-bezier(.22,1,.36,1)';
        const incoming = target.animate([incomingFrom, { opacity: 1, translate: '0 0' }], { duration, easing });
        record.animations.push(incoming, outgoing.animate([{ opacity: from || 1, translate: '0 0' }, { opacity: 0, translate: '0 -5px' }], { duration: 150, easing, fill: 'forwards' }));
        const nextHeight = parent.getBoundingClientRect().height;
        if (Math.abs(nextHeight - height) > 1) record.animations.push(parent.animate([{ height: height + 'px' }, { height: nextHeight + 'px' }], { duration, easing }));
        incoming.finished.then(() => { if (groups.get(parent) === record) settle(record); }).catch(() => {});
    };
    const stop = () => { for (const record of groups.values()) settle(record); };
    media.addEventListener('change', () => { if (media.matches) stop(); }, { signal });
    signal.addEventListener('abort', () => { stop(); groups.clear(); }, { once: true });
    return show;
}
