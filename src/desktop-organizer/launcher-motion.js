// The WebView and native backdrop share the same short entrance/exit. WAAPI
// keeps the retained page moving while scans run; reversal starts at its pose.
export function createLauncherMotion({ root, panel, material, inner, lists, reducedMotion }) {
    const motions = new Map(), ghosts = new Map();
    const media = panel.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
    let target = false, surfaceMotion = null, destroyed = false;
    const reduced = () => media.matches || reducedMotion?.() === true;
    const clamp = value => Math.max(0, Math.min(1, value));

    function cancel(element) {
        const entry = motions.get(element);
        if (entry) {
            motions.delete(element); entry.animation.cancel(); entry.onFinish?.();
        }
    }
    function animate(element, frames, { duration = 350, delay = 0, easing = 'linear' } = {}, onFinish) {
        cancel(element);
        if (destroyed || reduced()) { onFinish?.(); return; }
        const animation = element.animate(frames, { duration, delay, easing, fill: 'both' });
        const entry = { animation, onFinish };
        motions.set(element, entry);
        animation.finished.then(() => {
            if (motions.get(element) !== entry) return;
            motions.delete(element); animation.cancel(); onFinish?.();
        }).catch(() => {});
    }
    function springFrames(make) {
        return Array.from({ length: 38 }, (_, index) => {
            const offset = index / 37;
            const progress = index === 37 ? 1 : 1 - Math.exp(-8 * offset) * (Math.cos(10 * offset) + .8 * Math.sin(10 * offset));
            return { offset, ...make(progress, offset) };
        });
    }
    const closedPose = 'translateY(.75%) scale(.975)';
    function finishSurface() {
        const previous = surfaceMotion;
        surfaceMotion = null;
        previous?.animation.cancel();
        root.style.opacity = target ? '1' : '0';
        root.style.transform = target || reduced() ? 'none' : closedPose;
        root.classList.remove('is-moving');
        root.dataset.visible = String(target);
        previous?.resolve(true);
    }
    function setOpen(open, { instant = false } = {}) {
        const style = getComputedStyle(root);
        const from = { opacity: style.opacity, transform: style.transform };
        const previous = surfaceMotion;
        surfaceMotion = null;
        previous?.resolve(false); previous?.animation.cancel();
        target = open;
        const to = { opacity: open ? '1' : '0', transform: open || reduced() ? 'none' : closedPose };
        Object.assign(root.style, to);
        root.classList.add('is-moving');
        if (instant || reduced() || Math.abs(Number(from.opacity) - Number(to.opacity)) < .001 && from.transform === to.transform) {
            finishSurface(); return Promise.resolve(true);
        }
        return new Promise(resolve => {
            const animation = root.animate([from, to], {
                duration: open ? 220 : 180, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'both'
            });
            const entry = { animation, resolve }; surfaceMotion = entry;
            animation.finished.then(() => { if (surfaceMotion === entry) finishSurface(); }).catch(() => {});
        });
    }
    function layout(update, { instant = false } = {}) {
        if (instant || reduced()) { settleCards(); update(); return; }
        const poses = new Map(), layer = lists.querySelector('.launcher-exits');
        for (const node of lists.querySelectorAll('.launcher-card[data-id]')) poses.set(node.dataset.id, { rect: node.getBoundingClientRect(), opacity: Number(getComputedStyle(node).opacity) });
        for (const [id, node] of ghosts) if (!poses.has(id)) poses.set(id, { rect: node.getBoundingClientRect(), opacity: Number(getComputedStyle(node).opacity) });
        const oldNodes = [...lists.querySelectorAll('.launcher-card[data-id]')];
        for (const node of oldNodes) { cancel(node); node.style.transform = 'none'; node.style.opacity = '1'; }
        update();
        const current = [...lists.querySelectorAll('.launcher-card[data-id]')], ids = new Set(current.map(node => node.dataset.id));
        for (const id of ids) {
            const ghost = ghosts.get(id);
            if (ghost) { cancel(ghost); ghost.remove(); ghosts.delete(id); }
        }
        const base = lists.getBoundingClientRect();
        if (!instant && !reduced()) for (const node of oldNodes) if (!ids.has(node.dataset.id)) {
            const pose = poses.get(node.dataset.id), clone = node.cloneNode(true), id = node.dataset.id;
            clone.removeAttribute('data-id'); clone.inert = true;
            Object.assign(clone.style, { position: 'absolute', left: `${pose.rect.x - base.x + lists.scrollLeft}px`, top: `${pose.rect.y - base.y + lists.scrollTop}px`, width: `${pose.rect.width}px`, height: `${pose.rect.height}px`, transform: 'none', opacity: String(pose.opacity) });
            layer.append(clone); ghosts.set(id, clone);
            animate(clone, [{ opacity: pose.opacity, transform: 'none' }, { opacity: 0, transform: 'translateY(-7px) scale(.93)' }], { duration: 150, easing: 'cubic-bezier(.2,.7,.2,1)' }, () => { clone.remove(); if (ghosts.get(id) === clone) ghosts.delete(id); });
        }
        if (!instant && !reduced()) current.forEach((node, index) => {
            const to = node.getBoundingClientRect(), from = poses.get(node.dataset.id);
            if (to.bottom < base.top - 50 || to.top > base.bottom + 50) return;
            const dx = from ? from.rect.x + from.rect.width / 2 - to.x - to.width / 2 : 0;
            const dy = from ? from.rect.y + from.rect.height / 2 - to.y - to.height / 2 : 12;
            const sx = from ? from.rect.width / to.width : .95, sy = from ? from.rect.height / to.height : .95;
            const opacity = from?.opacity ?? 0;
            if (Math.abs(dx) < .3 && Math.abs(dy) < .3 && Math.abs(sx - 1) < .003 && opacity > .99) return;
            animate(node, springFrames((s, t) => ({ transform: `translate(${dx * (1 - s)}px,${dy * (1 - s)}px) scale(${sx + (1 - sx) * s},${sy + (1 - sy) * s})`, opacity: clamp(opacity + (1 - opacity) * Math.min(1, t * 4)) })), { duration: 390, delay: from ? 0 : Math.min(index * 12, 60) });
        });
    }
    function indicator(nav, button, instant = false) {
        const indicator = nav.querySelector('.filter-indicator');
        if (!indicator || nav.hidden || !button) return;
        const base = nav.getBoundingClientRect(), to = button.getBoundingClientRect(), old = indicator.getBoundingClientRect();
        if (!to.width) return;
        const x = to.x - base.x, y = to.y - base.y, fromX = old.width ? old.x - base.x : x, fromY = old.height ? old.y - base.y : y;
        cancel(indicator);
        Object.assign(indicator.style, { width: `${to.width}px`, height: `${to.height}px`, transform: `translate(${x}px,${y}px)` });
        if (!instant) animate(indicator, springFrames(s => ({ width: `${(old.width || to.width) + (to.width - (old.width || to.width)) * s}px`, transform: `translate(${fromX + (x - fromX) * s}px,${fromY + (y - fromY) * s}px)` })), { duration: 360 });
    }
    function settleCards() {
        for (const element of [...motions.keys()]) cancel(element);
        for (const ghost of ghosts.values()) ghost.remove(); ghosts.clear();
    }
    function settle() {
        settleCards();
        finishSurface();
    }
    media.addEventListener('change', settle);
    root.style.opacity = '0'; root.style.transform = closedPose;
    material.style.transform = 'none'; material.style.opacity = '1';
    inner.style.transform = 'none'; inner.style.opacity = '1';
    return {
        setOpen, layout, indicator, animate, cancel, reduced,
        refresh: () => { if (reduced()) settle(); },
        destroy() {
            destroyed = true; media.removeEventListener('change', settle);
            surfaceMotion?.resolve(false); surfaceMotion?.animation.cancel(); surfaceMotion = null;
            for (const element of [...motions.keys()]) cancel(element);
            for (const ghost of ghosts.values()) ghost.remove(); ghosts.clear();
        }
    };
}
