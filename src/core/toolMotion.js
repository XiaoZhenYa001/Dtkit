const running = new WeakMap();
const easing = 'cubic-bezier(.22, 1, .36, 1)';

export function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function animate(node, frames, options = {}, signal) {
    running.get(node)?.cancel();
    if (!node?.animate || prefersReducedMotion() || signal?.aborted) return;
    const animation = node.animate(frames, { duration: 260, easing, ...options });
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduce = () => { if (media.matches) animation.cancel(); };
    media?.addEventListener('change', reduce);
    running.set(node, animation);
    const stop = () => animation.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    animation.finished.catch(() => {}).finally(() => {
        signal?.removeEventListener('abort', stop);
        media?.removeEventListener('change', reduce);
        if (running.get(node) === animation) running.delete(node);
    });
    return animation;
}

export function revealContent(node, { signal, distance = 6 } = {}) {
    const current = running.has(node) && node?.isConnected ? getComputedStyle(node) : null;
    return animate(node, [{ opacity: current?.opacity || .2, transform: current?.transform || 'translateY(' + distance + 'px)' },
        { opacity: 1, transform: 'translateY(0)' }], { duration: 220 }, signal);
}

// Capture layout before and after the mutation. Retargeting starts from the
// currently painted positions, so fast changes do not queue animations.
export function transitionLayout(root, mutate, { signal, duration = 300 } = {}) {
    if (!root || signal?.aborted || prefersReducedMotion() || !root.animate) { mutate(); return; }
    const key = (node, index) => node.dataset.taskId || node.id || index;
    const before = new Map([...root.children].slice(0, 60)
        .map((node, index) => [key(node, index), node.getBoundingClientRect()]));
    const height = root.getBoundingClientRect().height;
    running.get(root)?.cancel();
    [...root.children].forEach(node => running.get(node)?.cancel());
    mutate();
    const nextHeight = root.getBoundingClientRect().height;
    if (height > 0 && Math.abs(nextHeight - height) > 1) {
        animate(root, [{ height: height + 'px' }, { height: nextHeight + 'px' }], { duration }, signal);
    }
    [...root.children].slice(0, 60).forEach((node, index) => {
        const rect = node.getBoundingClientRect();
        if (!rect.height || !rect.width) return;
        const old = before.get(key(node, index));
        if (!old?.height) { revealContent(node, { signal }); return; }
        const x = old.left - rect.left, y = old.top - rect.top;
        if (Math.abs(x) + Math.abs(y) < 1) return;
        animate(node, [{ transform: 'translate(' + x + 'px,' + y + 'px)' },
            { transform: 'translate(0,0)' }], { duration }, signal);
    });
}

// The indicator is decorative; the original buttons remain the focus targets.
export function mountSegmentedControl(group, { signal } = {}) {
    if (!group || signal?.aborted) return () => {};
    const indicator = document.createElement('span');
    indicator.className = 'tool-segment-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.prepend(indicator);
    group.classList.add('tool-motion-segmented');
    let frame = null;
    let disposed = false;
    const update = () => {
        frame = null;
        if (disposed || signal?.aborted) return;
        const selected = group.querySelector('button[aria-pressed="true"], button[aria-selected="true"]');
        if (!selected || !group.isConnected) return;
        indicator.style.width = selected.offsetWidth + 'px';
        indicator.style.height = selected.offsetHeight + 'px';
        indicator.style.transform = 'translate3d(' + selected.offsetLeft + 'px,' + selected.offsetTop + 'px,0)';
    };
    const schedule = () => { if (!disposed && !signal?.aborted && frame === null) frame = requestAnimationFrame(update); };
    update();
    frame = requestAnimationFrame(() => { frame = null; group.classList.add('tool-motion-ready'); update(); });
    const observer = new MutationObserver(schedule);
    observer.observe(group, { subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected'] });
    let width = group.offsetWidth, height = group.offsetHeight;
    const resize = new ResizeObserver(() => {
        if (disposed || signal?.aborted || (group.offsetWidth === width && group.offsetHeight === height)) return;
        width = group.offsetWidth; height = group.offsetHeight;
        if (frame !== null) cancelAnimationFrame(frame);
        group.classList.remove('tool-motion-ready');
        update();
        frame = requestAnimationFrame(() => {
            frame = null;
            if (disposed || signal?.aborted) return;
            group.classList.add('tool-motion-ready');
            update();
        });
    });
    resize.observe(group);
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener('change', schedule, { signal });
    const navigate = event => {
        const buttons = [...group.querySelectorAll('button')].filter(button => !button.disabled && !button.hidden);
        const index = buttons.indexOf(event.target.closest('button'));
        if (index < 0) return;
        const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
            : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1)
            : buttons[(index + offset + buttons.length) % buttons.length];
        next.focus(); next.click();
    };
    group.addEventListener('keydown', navigate);
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect(); resize.disconnect();
        group.removeEventListener('keydown', navigate);
        media?.removeEventListener('change', schedule);
        signal?.removeEventListener('abort', dispose);
        if (frame !== null) cancelAnimationFrame(frame);
        group.classList.remove('tool-motion-segmented', 'tool-motion-ready');
        indicator.remove();
    };
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
}
