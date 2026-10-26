// The surface and its contents move separately: glass can stretch while text
// keeps its normal proportions. A single spring retains velocity on reversal.
export function createLauncherMotion({ root, panel, material, inner, lists, reducedMotion }) {
    const motions = new Map(), ghosts = new Map();
    const media = panel.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
    let position = 0, velocity = 0, target = 0, frame = 0, previousTime = 0, pending = null, destroyed = false;
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
    function paint() {
        const progress = clamp(position);
        // The native glass fills the whole HWND; transforming only its CSS tint
        // exposes an unstyled backdrop around it. Animate the contents instead.
        material.style.transform = 'none';
        material.style.opacity = '1';
        inner.style.opacity = String(clamp((progress - .13) / .74));
        inner.style.transform = progress === 1 ? 'none' : `translateY(${(1 - progress) * 13}px)`;
    }
    function finish() {
        position = target; velocity = 0; previousTime = 0; frame = 0; paint();
        root.classList.remove('is-moving');
        root.dataset.visible = String(target === 1);
        pending?.(true); pending = null;
    }
    function tick(now) {
        const delta = Math.min(previousTime ? (now - previousTime) / 1000 : 1 / 60, .032);
        previousTime = now;
        for (let step = 0; step < 3; step++) {
            const dt = delta / 3;
            velocity += ((target ? 390 : 490) * (target - position) - (target ? 34 : 40) * velocity) * dt;
            position += velocity * dt;
        }
        position = Math.max(-.008, Math.min(1.025, position)); paint();
        if (Math.abs(position - target) < .00015 && Math.abs(velocity) < .003) finish();
        else frame = requestAnimationFrame(tick);
    }
    function setOpen(open, { instant = false } = {}) {
        pending?.(false); pending = null; target = open ? 1 : 0;
        root.classList.add('is-moving');
        const result = new Promise(resolve => { pending = resolve; });
        if (instant || reduced()) { if (frame) cancelAnimationFrame(frame); finish(); }
        else if (!frame) frame = requestAnimationFrame(tick);
        return result;
    }
    function layout(update, { instant = false } = {}) {
        if (instant || reduced()) { settle(); update(); return; }
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
    function settle() {
        for (const element of [...motions.keys()]) cancel(element);
        for (const ghost of ghosts.values()) ghost.remove(); ghosts.clear();
        if (frame) cancelAnimationFrame(frame); finish();
    }
    media.addEventListener('change', settle);
    paint();
    return {
        setOpen, layout, indicator, animate, cancel, reduced,
        refresh: () => { if (reduced()) settle(); },
        destroy() {
            destroyed = true; media.removeEventListener('change', settle);
            if (frame) cancelAnimationFrame(frame); pending?.(false); pending = null;
            for (const element of [...motions.keys()]) cancel(element);
            for (const ghost of ghosts.values()) ghost.remove(); ghosts.clear();
        }
    };
}
