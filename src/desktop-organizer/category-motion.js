// The accordion keeps its live contents until exit finishes, so reversing a
// collapse does not repaint files, lose focus, or restart at the full height.
export function createCategoryMotion({ window, reducedMotion }) {
    const active = new Map();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => reducedMotion() || media.matches;
    function finish(item, entry) {
        if (active.get(item) !== entry) return;
        active.delete(item);
        entry.animation?.cancel();
        entry.files.style.removeProperty('height');
        entry.files.style.removeProperty('opacity');
        entry.files.style.removeProperty('display');
        if (!entry.expanded) entry.clear();
    }
    function setExpanded(item, expanded, render, clear) {
        const files = item.querySelector('.category-files');
        const previous = active.get(item);
        const from = previous || item.classList.contains('expanded') ? files.getBoundingClientRect().height : 0;
        const opacity = previous ? Number(window.getComputedStyle(files).opacity) : from ? 1 : 0;
        if (previous) { active.delete(item); previous.animation?.cancel(); }
        files.style.display = 'block';
        files.style.height = 'auto';
        if (expanded && item.dataset.filesRendered !== 'true') render();
        const focusInside = files.contains(files.ownerDocument.activeElement);
        files.inert = !expanded;
        if (!expanded && focusInside) item.querySelector('.category-header').focus({ preventScroll: true });
        const to = expanded ? files.getBoundingClientRect().height : 0;
        item.classList.toggle('expanded', expanded);
        item.querySelector('.category-header').setAttribute('aria-expanded', String(expanded));
        const entry = { files, expanded, clear, animation: null };
        active.set(item, entry);
        if (reduced() || !files.animate || Math.abs(from - to) < 1) { finish(item, entry); return; }
        entry.animation = files.animate([
            { height: `${from}px`, opacity },
            { height: `${to}px`, opacity: expanded ? 1 : 0 }
        ], { duration: expanded ? 200 : 180, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'both' });
        entry.animation.finished.then(() => finish(item, entry)).catch(() => {});
    }
    function settle() { for (const [item, entry] of [...active]) finish(item, entry); }
    media.addEventListener('change', settle);
    return {
        setExpanded,
        refresh() { if (reduced()) settle(); },
        destroy() { settle(); media.removeEventListener('change', settle); }
    };
}
