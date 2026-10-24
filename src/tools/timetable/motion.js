const easing = 'cubic-bezier(.22,1,.36,1)';
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** One transition per surface; a new intent replaces the running transition. */
export function createTimetableMotion(signal) {
    const records = new Map();
    const run = (node, frames, options = {}) => {
        if (!node?.animate || signal?.aborted || reduced()) return null;
        const animation = node.animate(frames, { duration: 280, easing, ...options });
        animation.finished.catch(() => {}); return animation;
    };
    const settle = key => {
        const record = records.get(key); if (!record) return;
        records.delete(key); record.animations.forEach(animation => animation?.cancel()); record.cleanup?.();
    };
    const remember = (key, animations, cleanup) => {
        const record = { animations: animations.filter(Boolean), cleanup }; records.set(key, record);
        Promise.allSettled(record.animations.map(animation => animation.finished)).then(() => { if (records.get(key) === record) settle(key); });
    };
    const content = (element, mutate, { direction = 0, animate = true } = {}) => {
        if (!element || signal?.aborted) return;
        const rect = element.getBoundingClientRect(), opacity = getComputedStyle(element).opacity;
        const snapshot = animate && !element.hidden && rect.width && rect.height && !reduced() ? element.cloneNode(true) : null;
        const copies = snapshot ? [snapshot, ...snapshot.querySelectorAll('*')] : [];
        const scrolled = snapshot ? [element, ...element.querySelectorAll('*')].map((node, index) => ({
            node: copies[index], left: node.scrollLeft || 0, top: node.scrollTop || 0
        })).filter(item => item.left || item.top) : [];
        settle(element);
        mutate();
        if (!snapshot || !element.parentElement || signal?.aborted) return;
        // Decorative copies never compete with the real editor's identity,
        // events, tab order or native form radio groups.
        snapshot.querySelectorAll('[data-tt-snapshot]').forEach(node => node.remove());
        for (const node of [snapshot, ...snapshot.querySelectorAll('*')]) {
            for (const attribute of ['id', 'name', 'data-tt-action', 'data-id', 'data-status', 'autofocus']) node.removeAttribute(attribute);
            for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-') && !['data-color', 'data-density', 'data-background', 'data-background-fit', 'data-phase', 'data-tone'].includes(attribute.name)) node.removeAttribute(attribute.name);
        }
        snapshot.dataset.ttSnapshot = 'true'; snapshot.inert = true; snapshot.setAttribute('aria-hidden', 'true');
        const parent = element.parentElement, bounds = parent.getBoundingClientRect();
        snapshot.style.position = 'absolute'; snapshot.style.left = rect.left - bounds.left + parent.scrollLeft + 'px';
        snapshot.style.top = rect.top - bounds.top + parent.scrollTop + 'px'; snapshot.style.width = rect.width + 'px'; snapshot.style.height = rect.height + 'px';
        snapshot.style.margin = '0'; snapshot.style.pointerEvents = 'none'; snapshot.style.overflow = 'hidden'; snapshot.style.zIndex = '2';
        parent.append(snapshot);
        scrolled.forEach(item => { if (item.node) { item.node.scrollLeft = item.left; item.node.scrollTop = item.top; } });
        const distance = direction ? direction * 16 : 0;
        const incoming = run(element, [{ opacity: Math.min(.35, Number(opacity)), transform: `translate(${distance}px,${direction ? 0 : 5}px)` }, { opacity: 1, transform: 'none' }]);
        const outgoing = run(snapshot, [{ opacity, transform: 'none' }, { opacity: 0, transform: `translate(${-distance}px,${direction ? 0 : -4}px)` }], { duration: 190, fill: 'forwards' });
        remember(element, [incoming, outgoing], () => snapshot.remove());
    };
    const show = (parent, target, { animate = true, selector = null } = {}) => {
        if (!parent || !target || signal?.aborted) return;
        const panels = [...parent.children].filter(panel => !panel.hasAttribute('data-tt-snapshot') && (!selector || panel.matches(selector)));
        const running = records.get(parent);
        if (running?.target === target) return;
        const old = running?.target || panels.find(panel => !panel.hidden);
        if (!running && old === target) { for (const panel of panels) { panel.hidden = panel !== target; panel.inert = panel !== target; } return; }
        const parentRect = parent.getBoundingClientRect(), oldRect = old?.getBoundingClientRect();
        const height = parentRect.height;
        const oldOpacity = old ? getComputedStyle(old).opacity : 1;
        settle(parent);
        settle(old); settle(target);
        for (const panel of panels) { panel.hidden = panel !== target; panel.inert = panel !== target; }
        if (!animate || !old || old === target || reduced()) return;
        const targetHeight = parent.getBoundingClientRect().height;
        const previousPosition = parent.style.position, placed = getComputedStyle(parent).position === 'static';
        if (placed) parent.style.position = 'relative';
        old.hidden = false; old.inert = true;
        old.style.position = 'absolute'; old.style.top = oldRect.top - parentRect.top + parent.scrollTop + 'px'; old.style.left = oldRect.left - parentRect.left + parent.scrollLeft + 'px'; old.style.width = oldRect.width + 'px'; old.style.pointerEvents = 'none';
        const incoming = run(target, [{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }]);
        const outgoing = run(old, [{ opacity: oldOpacity, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 160, fill: 'forwards' });
        const resize = height && targetHeight && Math.abs(height - targetHeight) > 1 ? run(parent, [{ height: height + 'px' }, { height: targetHeight + 'px' }]) : null;
        remember(parent, [incoming, outgoing, resize], () => {
            for (const panel of panels) {
                panel.hidden = panel !== target; panel.inert = panel !== target;
                for (const property of ['position', 'top', 'left', 'width', 'pointerEvents']) panel.style[property] = '';
            }
            if (placed) parent.style.position = previousPosition;
        });
        const record = records.get(parent); if (record) record.target = target;
    };
    const open = dialog => {
        if (!dialog || signal?.aborted) return;
        settle(dialog);
        if (!dialog.open) dialog.showModal();
        remember(dialog, [run(dialog, [{ opacity: 0, transform: 'translateY(14px) scale(.975)' }, { opacity: 1, transform: 'none' }])]);
    };
    const disclose = (element, expanded) => {
        if (!element || signal?.aborted) return;
        const wasHidden = element.hidden, opacity = wasHidden ? 0 : getComputedStyle(element).opacity;
        settle(element); element.hidden = false; element.inert = !expanded;
        if (reduced()) { element.hidden = !expanded; return; }
        const animation = run(element, expanded ? [{ opacity, transform: 'translateY(-6px) scale(.975)' }, { opacity: 1, transform: 'none' }]
            : [{ opacity, transform: 'none' }, { opacity: 0, transform: 'translateY(-5px) scale(.98)' }], { duration: expanded ? 220 : 140, fill: 'forwards' });
        remember(element, [animation], () => { element.hidden = !expanded; element.inert = !expanded; });
    };
    const close = async dialog => {
        if (!dialog?.open || signal?.aborted) return;
        const opacity = getComputedStyle(dialog).opacity;
        settle(dialog);
        const animation = run(dialog, [{ opacity, transform: getComputedStyle(dialog).transform }, { opacity: 0, transform: 'translateY(7px) scale(.985)' }], { duration: 140 });
        const record = { animations: [animation].filter(Boolean) }; records.set(dialog, record);
        if (animation) await animation.finished.catch(() => {});
        if (records.get(dialog) !== record || signal?.aborted) return;
        records.delete(dialog); dialog.close();
    };
    const dispose = () => { for (const key of [...records.keys()]) settle(key); };
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener('change', () => { if (media.matches) dispose(); }, { signal });
    signal?.addEventListener('abort', dispose, { once: true });
    return { content, show, open, close, disclose, dispose };
}
