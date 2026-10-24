const easing = 'cubic-bezier(.22,1,.36,1)';

/** Interruptible decoration: every change takes effect before its animation starts. */
export function createBatchMotion(signal) {
    const records = new Map();
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = () => media?.matches;
    const run = (element, frames, options = {}) => {
        if (!element?.animate || reduced() || signal?.aborted) return null;
        const animation = element.animate(frames, { duration: 260, easing, ...options });
        animation.finished.catch(() => {});
        return animation;
    };
    const settle = element => {
        const record = records.get(element);
        if (!record) return;
        records.delete(element);
        record.animations.forEach(animation => animation.cancel());
        record.cleanup?.();
    };
    const remember = (element, animations, cleanup, extra = {}) => {
        const record = { animations: animations.filter(Boolean), cleanup, ...extra };
        records.set(element, record);
        Promise.allSettled(record.animations.map(animation => animation.finished)).then(() => {
            if (records.get(element) === record) settle(element);
        });
        return record;
    };
    const decorativeCopy = element => {
        const copy = element.cloneNode(true);
        copy.querySelectorAll('[data-batch-snapshot]').forEach(node => node.remove());
        for (const node of [copy, ...copy.querySelectorAll('*')]) {
            for (const attribute of [...node.attributes]) {
                if (['id', 'name', 'for', 'autofocus', 'form'].includes(attribute.name) || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
            }
        }
        copy.removeAttribute('hidden'); copy.inert = true; copy.setAttribute('aria-hidden', 'true');
        copy.dataset.batchSnapshot = 'true';
        return copy;
    };
    const switchPanel = (container, requested) => {
        if (!container || signal?.aborted) return;
        const target = typeof requested === 'string' ? container.querySelector(requested) : requested;
        if (!target) return;
        const panels = [...container.children].filter(node => node.classList.contains('batch-operation-panel') && !node.hasAttribute('data-batch-snapshot'));
        const old = panels.find(panel => !panel.hidden);
        if (old === target) { panels.forEach(panel => { panel.hidden = panel !== target; panel.inert = panel !== target; }); return; }
        const currentBounds = container.getBoundingClientRect();
        const oldBounds = old?.getBoundingClientRect();
        const oldOpacity = old ? getComputedStyle(old).opacity : '1';
        const copy = old && old !== target && oldBounds?.height && !reduced() ? decorativeCopy(old) : null;
        settle(container);
        panels.forEach(panel => { panel.hidden = panel !== target; panel.inert = panel !== target; });
        const targetBounds = target.getBoundingClientRect();
        if (!copy || !targetBounds.height || reduced()) return;
        Object.assign(copy.style, {
            position: 'absolute', top: `${oldBounds.top - currentBounds.top}px`, left: '0', width: `${oldBounds.width}px`,
            margin: '0', pointerEvents: 'none', zIndex: '2', opacity: oldOpacity
        });
        container.append(copy);
        const previousOverflow = container.style.overflow;
        container.style.overflow = 'hidden';
        const incoming = run(target, [{ opacity: .15, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
        const outgoing = run(copy, [{ opacity: oldOpacity, transform: 'none' }, { opacity: 0, transform: 'translateY(-7px)' }], { duration: 155, fill: 'forwards' });
        const height = Math.abs(currentBounds.height - targetBounds.height) > 1 ? run(container,
            [{ height: `${currentBounds.height}px` }, { height: `${targetBounds.height}px` }], { duration: 320 }) : null;
        remember(container, [incoming, outgoing, height], () => { copy.remove(); container.style.overflow = previousOverflow; });
    };
    const refresh = (element, mutate) => {
        if (signal?.aborted) return;
        if (!element) { mutate?.(); return; }
        settle(element);
        mutate?.();
        if (element.hidden) return;
        // No outgoing list clone: search, caret and row identity remain entirely live.
        remember(element, [run(element, [{ opacity: .72, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 210 })]);
    };
    const open = dialog => {
        if (!dialog || signal?.aborted) return;
        const wasOpen = dialog.open;
        const opacity = wasOpen ? getComputedStyle(dialog).opacity : '0';
        const transform = wasOpen ? getComputedStyle(dialog).transform : 'translateY(12px) scale(.975)';
        settle(dialog);
        if (!dialog.open) dialog.showModal();
        remember(dialog, [run(dialog, [{ opacity, transform }, { opacity: 1, transform: 'none' }], { duration: 280 })]);
    };
    const close = async dialog => {
        if (!dialog?.open || signal?.aborted) return;
        const opacity = getComputedStyle(dialog).opacity;
        const transform = getComputedStyle(dialog).transform;
        settle(dialog);
        const animation = run(dialog, [{ opacity, transform }, { opacity: 0, transform: 'translateY(7px) scale(.985)' }], { duration: 150 });
        if (!animation) { dialog.close(); return; }
        const record = { animations: [animation], cleanup: () => { if (dialog.open) dialog.close(); } }; records.set(dialog, record);
        await animation.finished.catch(() => {});
        if (records.get(dialog) !== record || signal?.aborted) return;
        settle(dialog);
    };
    const disclose = (details, expanded = !details.open) => {
        if (!details || signal?.aborted) return;
        const initialHeight = details.getBoundingClientRect().height;
        const content = details.querySelector('.batch-disclosure-content');
        const summary = details.querySelector('summary');
        settle(details);
        details.open = expanded;
        const finalHeight = details.getBoundingClientRect().height;
        if (content) content.inert = !expanded;
        if (reduced() || Math.abs(initialHeight - finalHeight) < 1) return;
        if (!expanded && details.contains(document.activeElement) && document.activeElement !== summary) summary?.focus({ preventScroll: true });
        // Keep the native content in layout until the collapse finishes.
        details.open = true;
        details.dataset.batchExpanded = String(expanded);
        const previousOverflow = details.style.overflow; details.style.overflow = 'hidden';
        const resize = run(details, [{ height: `${initialHeight}px` }, { height: `${finalHeight}px` }], { duration: 300 });
        const fade = content ? run(content, expanded ? [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }]
            : [{ opacity: getComputedStyle(content).opacity, transform: 'none' }, { opacity: 0, transform: 'translateY(-3px)' }], { duration: expanded ? 220 : 130, fill: expanded ? 'none' : 'forwards' }) : null;
        remember(details, [resize, fade], () => { details.open = expanded; delete details.dataset.batchExpanded; details.style.overflow = previousOverflow; if (content) content.inert = !expanded; }, { expanded });
    };
    const root = document.querySelector('.batch-tool-shell');
    const source = root?.querySelector('.batch-source-section');
    const sourceButton = root?.querySelector('#batchSelectFiles');
    let sourceState = root?.dataset.hasFiles === 'true';
    let sourceBounds = source?.getBoundingClientRect();
    let sourceButtonBounds = sourceButton?.getBoundingClientRect();
    const rememberSourceBounds = () => {
        if (!source || records.has(source)) return;
        sourceBounds = source.getBoundingClientRect(); sourceButtonBounds = sourceButton?.getBoundingClientRect();
    };
    root?.addEventListener('pointerdown', rememberSourceBounds, { signal });
    const sourceResize = source && globalThis.ResizeObserver ? new ResizeObserver(rememberSourceBounds) : null;
    sourceResize?.observe(source);
    const sourceChanges = root && source ? new MutationObserver(() => {
        const hasFiles = root.dataset.hasFiles === 'true';
        if (sourceState === hasFiles) return;
        sourceState = hasFiles;
        const oldBounds = sourceBounds, oldButton = sourceButtonBounds;
        settle(source);
        const nextBounds = source.getBoundingClientRect(), nextButton = sourceButton?.getBoundingClientRect();
        if (!oldBounds || reduced()) { rememberSourceBounds(); return; }
        const previousOverflow = source.style.overflow; source.style.overflow = 'hidden';
        const height = run(source, [{ height: `${oldBounds.height}px` }, { height: `${nextBounds.height}px` }], { duration: 320 });
        const button = oldButton && nextButton ? run(sourceButton, [{ transform: `translate(${oldButton.left - nextButton.left}px,${oldButton.top - nextButton.top}px)` }, { transform: 'none' }], { duration: 320 }) : null;
        remember(source, [height, button], () => { source.style.overflow = previousOverflow; sourceBounds = source.getBoundingClientRect(); sourceButtonBounds = sourceButton?.getBoundingClientRect(); });
    }) : null;
    sourceChanges?.observe(root, { attributes: true, attributeFilter: ['data-has-files'] });
    root?.addEventListener('click', event => {
        const summary = event.target.closest('details.batch-disclosure > summary');
        if (!summary || !root.contains(summary)) return;
        event.preventDefault();
        const details = summary.parentElement;
        disclose(details, !(records.get(details)?.expanded ?? details.open));
    }, { signal });
    let focusFrame = null;
    const cancelFocusCheck = () => { if (focusFrame !== null) cancelAnimationFrame(focusFrame); focusFrame = null; };
    root?.addEventListener('focusin', event => {
        if (!event.target.matches('.batch-rules-section :is(input,select,button,summary)')) return;
        cancelFocusCheck();
        const target = event.target;
        // Native focus scrolling can override an immediate smooth scroll. Check after its next layout.
        focusFrame = requestAnimationFrame(() => { focusFrame = requestAnimationFrame(() => {
            focusFrame = null;
            if (signal?.aborted || !target.isConnected || document.activeElement !== target) return;
            const bar = root.querySelector('.batch-config-footer');
            const bounds = target.getBoundingClientRect();
            let viewport = root.parentElement;
            while (viewport && !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
            const bottom = viewport?.getBoundingClientRect().bottom ?? window.innerHeight;
            if (bar && (bounds.top < bar.getBoundingClientRect().bottom + 8 || bounds.bottom > bottom - 12)) {
                target.scrollIntoView({ block: 'center', behavior: reduced() ? 'instant' : 'smooth' });
            }
        }); });
    }, { signal });
    const dispose = () => { cancelFocusCheck(); for (const element of [...records.keys()]) settle(element); };
    media?.addEventListener('change', () => { if (media.matches) dispose(); }, { signal });
    signal?.addEventListener('abort', () => { sourceChanges?.disconnect(); sourceResize?.disconnect(); dispose(); }, { once: true });
    return { switchPanel, refresh, open, close, disclose, dispose };
}
