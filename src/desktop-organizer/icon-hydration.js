const TARGETS = '.file-item[data-app-id]:not([data-icon-loaded]),.file-item[data-icon-kind="file"]:not([data-icon-loaded])';

// Extraction can touch disk and the Windows shell. Keep a small, shared work
// queue, while every view paints its ordinary icon immediately.
export function createIconHydrator({ invoke, cache = new Map(), document: doc, window: win, concurrency = 4, cacheLimit = 256 }) {
    const watched = new Set(), pending = new Map(), queue = [];
    let active = 0, destroyed = false, revision = 0;
    const limit = Math.max(1, Math.min(4, concurrency));
    const capacity = Math.max(1, cacheLimit);
    function forget(target) { observer?.unobserve(target); watched.delete(target); }
    function paint(target, icon, path) {
        if (destroyed || !target.isConnected || target.dataset.path !== path) return;
        target.dataset.iconLoaded = 'true';
        if (!icon) return;
        const holder = target.querySelector('.file-icon');
        if (!holder) return;
        const image = doc.createElement('img');
        image.src = icon; image.className = 'file-icon-img'; image.alt = ''; image.loading = 'lazy';
        holder.classList.add('file-icon-real');
        holder.replaceChildren(image);
    }
    function remember(path, icon) {
        cache.delete(path);
        while (cache.size >= capacity) cache.delete(cache.keys().next().value);
        cache.set(path, icon);
    }
    function pump() {
        while (!destroyed && active < limit && queue.length) {
            const job = queue.shift();
            for (const target of job.targets) if (!target.isConnected) job.targets.delete(target);
            if (!job.targets.size) { pending.delete(job.path); continue; }
            active++;
            Promise.resolve().then(() => invoke(job.command, { path: job.path })).catch(() => null)
                .then(icon => {
                    if (destroyed || job.revision !== revision) return;
                    remember(job.path, icon);
                    for (const target of job.targets) paint(target, icon, job.path);
                }).finally(() => { active--; if (pending.get(job.path) === job) pending.delete(job.path); pump(); });
        }
    }
    function load(target) {
        forget(target);
        if (destroyed || !target.isConnected || target.dataset.iconLoaded) return;
        const path = target.dataset.path;
        if (!path) return;
        if (cache.has(path)) {
            const icon = cache.get(path);
            remember(path, icon); paint(target, icon, path);
            return;
        }
        const existing = pending.get(path);
        if (existing) existing.targets.add(target);
        else {
            const job = { path, targets: new Set([target]), revision,
                command: target.dataset.iconKind === 'file' ? 'desktop_get_icon' : 'desktop_get_app_icon' };
            pending.set(path, job); queue.push(job);
        }
        pump();
    }
    const observer = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) load(entry.target);
    }, { rootMargin: '48px' }) : null;
    function hydrate(root = doc) {
        if (destroyed) return;
        for (const target of watched) if (!target.isConnected) forget(target);
        for (const job of pending.values()) for (const target of job.targets) if (!target.isConnected) job.targets.delete(target);
        for (const target of root.querySelectorAll(TARGETS)) {
            if (watched.has(target)) continue;
            if (!observer) { load(target); continue; }
            watched.add(target); observer.observe(target);
        }
    }
    return {
        hydrate,
        invalidate() { revision++; cache.clear(); pending.clear(); queue.length = 0; },
        destroy() {
            destroyed = true; observer?.disconnect(); watched.clear(); queue.length = 0;
            for (const job of pending.values()) job.targets.clear();
            pending.clear();
        }
    };
}
