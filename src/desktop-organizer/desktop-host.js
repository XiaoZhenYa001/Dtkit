// The native desktop window covers the work area, but only these painted surfaces
// belong to it. Explorer keeps receiving input everywhere else.
import { createDesktopFurnitureController } from './desktop-furniture.js';
import { createDesktopControls } from './desktop-controls.js';
const SURFACES = [
    '.space-block', '.space-zone', '.space-popup', '.space-drawer',
    '.space-drawer-handle', '.space-context', '.space-editor', '.space-shelf-rail', '.space-shelf-preview', '.space-shelf-ghost',
    '.desktop-tools', '.appearance-panel', '.desktop-search-panel',
    '.desktop-folder-panel', '.context-menu', '.submenu', '.rename-dialog-content',
    '.desktop-scroll-rail'
].join(',');

export function clipDesktopRegion(rect, width, height, padding = 20) {
    const x = Math.max(0, Math.floor(rect.x - padding));
    const y = Math.max(0, Math.floor(rect.y - padding));
    const right = Math.min(width, Math.ceil(rect.x + rect.width + padding));
    const bottom = Math.min(height, Math.ceil(rect.y + rect.height + padding));
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function createDesktopRegionReporter({ document: doc, window: win, invoke }) {
    let frame = 0, destroyed = false, started = false, pending = null, flushing = null, signature = '', dragging = false;
    const held = new Map();
    const observed = new Set();
    const timers = new Set();
    const reservationTimers = new Map();
    const abort = new AbortController();
    function visibleRect(element) {
        if (element.closest('[hidden]') || !element.getClientRects().length) return null;
        let bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const computedStyle = win.getComputedStyle(ancestor);
            if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') return null;
            // Scrolled-off cabinets and zones must not claim invisible desktop space.
            if (ancestor !== element && /(hidden|auto|scroll|clip)/.test(`${computedStyle.overflowX} ${computedStyle.overflowY}`)) {
                const clip = ancestor.getBoundingClientRect();
                const left = Math.max(bounds.left, clip.left), top = Math.max(bounds.top, clip.top);
                const right = Math.min(bounds.right, clip.right), bottom = Math.min(bounds.bottom, clip.bottom);
                if (right <= left || bottom <= top) return null;
                bounds = { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
            }
        }
        return bounds;
    }
    const resize = new ResizeObserver(() => schedule());
    function collect() {
        // Pointer capture owns this gesture until release. Keep a fixed alpha
        // surface while furniture travels, rather than repainting a native HWND
        // forty times for forty mouse steps. Other gestures retain shaped holes.
        if (dragging) return [{ x: 0, y: 0, width: win.innerWidth, height: win.innerHeight }];
        const nodes = new Set(doc.querySelectorAll(SURFACES));
        for (const old of observed) if (!nodes.has(old)) { resize.unobserve(old); observed.delete(old); }
        const reservations = [...held.values()].flatMap(rectangles => rectangles.map(rect => clipDesktopRegion(rect, win.innerWidth, win.innerHeight, 24))).filter(Boolean);
        const regions = [...reservations];
        for (const element of nodes) {
            if (!observed.has(element)) { resize.observe(element); observed.add(element); }
            const rect = visibleRect(element);
            if (!rect) continue;
            element.dataset.desktopInteractive = '';
            const clipped = clipDesktopRegion(rect, win.innerWidth, win.innerHeight, element.matches('.space-shelf-rail,.space-shelf-panel') ? 16 : 20);
            // Reserve the entire motion once. Its animated descendants must not
            // trigger a new native repaint for each slightly different bound.
            if (clipped && !reservations.some(region => clipped.x >= region.x && clipped.y >= region.y
                && clipped.x + clipped.width <= region.x + region.width && clipped.y + clipped.height <= region.y + region.height)) regions.push(clipped);
        }
        for (const stage of doc.querySelectorAll('.space-stage')) {
            const bounds = visibleRect(stage);
            if (!bounds || stage.scrollHeight <= stage.clientHeight) continue;
            const scrollbar = clipDesktopRegion({ x: bounds.x + bounds.width - 8, y: bounds.y, width: 8, height: bounds.height }, win.innerWidth, win.innerHeight, 0);
            if (scrollbar) regions.push(scrollbar);
        }
        return [...new Map(regions.map(region => [JSON.stringify(region), region])).values()];
    }
    async function send() {
        if (flushing) return flushing;
        flushing = (async () => {
            while (pending && !destroyed) {
                const regions = pending;
                pending = null;
                const next = JSON.stringify(regions);
                if (next === signature) continue;
                try { await invoke('desktop_space_set_regions', { regions }); }
                catch (error) { if (destroyed) return; throw error; }
                signature = next;
            }
        })().finally(() => { flushing = null; });
        return flushing;
    }
    function schedule() {
        if (destroyed || !started || frame) return;
        frame = win.requestAnimationFrame(() => {
            frame = 0;
            pending = collect();
            void send().catch(error => console.error('同步桌面交互区域失败:', error));
        });
    }
    function hold({ target, source, duration = 420, id }) {
        if (destroyed) return;
        const token = id ?? {};
        const rectangles = [target, source].filter(Boolean);
        if (!rectangles.length) return;
        const x = Math.min(...rectangles.map(rect => rect.x)), y = Math.min(...rectangles.map(rect => rect.y));
        const right = Math.max(...rectangles.map(rect => rect.x + rect.width)), bottom = Math.max(...rectangles.map(rect => rect.y + rect.height));
        // A glass boundary travelling between two anchors needs the path too,
        // rather than only two disconnected endpoint regions.
        held.set(token, [{ x, y, width: right - x, height: bottom - y }]);
        schedule();
        const timer = win.setTimeout(() => {
            timers.delete(timer); reservationTimers.delete(token); held.delete(token); schedule();
        }, duration + 40);
        timers.add(timer);
        reservationTimers.set(token, timer);
    }
    const mutations = new MutationObserver(records => {
        // Reporter markers and icon hydration do not themselves change input geometry.
        if (records.some(record => record.type === 'childList' || ['hidden', 'style', 'class', 'aria-expanded'].includes(record.attributeName))) schedule();
    });
    mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'aria-expanded'] });
    win.addEventListener('resize', schedule, { signal: abort.signal });
    doc.addEventListener('scroll', schedule, { capture: true, passive: true, signal: abort.signal });
    doc.addEventListener('transitionend', schedule, { signal: abort.signal });
    doc.addEventListener('animationend', schedule, { signal: abort.signal });
    doc.addEventListener('dtkit:desktop-space-motion', event => hold(event.detail), { signal: abort.signal });
    doc.addEventListener('dtkit:desktop-space-motion-end', event => {
        const timer = reservationTimers.get(event.detail);
        if (timer) { win.clearTimeout(timer); timers.delete(timer); reservationTimers.delete(event.detail); }
        if (held.delete(event.detail)) schedule();
    }, { signal: abort.signal });
    doc.addEventListener('dtkit:desktop-space-drag', event => { dragging = event.detail === true; schedule(); }, { signal: abort.signal });
    return {
        schedule,
        hold,
        setDragging(active) { if (dragging !== active) { dragging = active; schedule(); } },
        start() { started = true; schedule(); },
        async flush() {
            if (!started || destroyed) return;
            if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
            pending = collect();
            await send();
        },
        destroy() {
            destroyed = true; abort.abort(); mutations.disconnect(); resize.disconnect();
            if (frame) win.cancelAnimationFrame(frame);
            for (const timer of timers) win.clearTimeout(timer);
            held.clear(); reservationTimers.clear(); observed.clear(); pending = null;
        }
    };
}

export function prepareDesktopHost({ document: doc, window: win, invoke }) {
    doc.documentElement.dataset.host = 'desktop';
    doc.body.dataset.host = 'desktop';
    const panel = doc.getElementById('panel');
    // Native must measure the finished furniture before showing its shaped window.
    // Opacity keeps that geometry available while preventing a first-frame flash.
    panel.style.opacity = '0';
    const tools = doc.getElementById('desktopTools');
    tools.hidden = false;
    tools.append(doc.getElementById('refreshBtn'), doc.getElementById('appearanceBtn'));
    const search = doc.querySelector('.search-container');
    search.hidden = true;
    search.classList.add('desktop-search-panel');
    const results = doc.getElementById('searchResults');
    results.classList.add('desktop-search-panel');
    doc.getElementById('categoryList').classList.add('desktop-folder-panel');
    const reporter = createDesktopRegionReporter({ document: doc, window: win, invoke });
    const furniture = createDesktopFurnitureController({ root: doc.getElementById('desktopSpaceView'), storage: win.localStorage,
        onMove: reporter.schedule, onDragChange: reporter.setDragging });
    const controls = createDesktopControls({ document: doc, window: win, onMove: reporter.schedule, onDragChange: reporter.setDragging });
    let lifeAnimation = null, retired = false;
    const reducedMotion = () => doc.body.dataset.reducedMotion === 'true' || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stopReporting = () => { controls.destroy(); furniture.destroy(); reporter.destroy(); };
    return {
        ...reporter,
        arrange() { furniture.arrange(); controls.arrange(); },
        setDisplays: controls.setDisplays,
        positionPopover: controls.positionPopover,
        closeTools: controls.close,
        cancelGestures() { furniture.cancelGesture(); controls.cancelGesture(); },
        enter() {
            if (retired) return;
            lifeAnimation?.cancel();
            panel.style.opacity = '1';
            panel.style.transform = 'none';
            if (!reducedMotion()) lifeAnimation = panel.animate(
                [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
                { duration: 350, easing: 'cubic-bezier(.22,.75,.25,1)' }
            );
        },
        retire() {
            if (retired) return;
            retired = true;
            // Capture an interrupted entrance before cancelling it, so a quick
            // change of mode leaves from the currently painted frame.
            const computed = win.getComputedStyle(panel);
            const from = { opacity: computed.opacity, transform: computed.transform };
            lifeAnimation?.cancel();
            panel.inert = true;
            stopReporting();
            panel.style.opacity = '0';
            panel.style.transform = 'translateY(6px)';
            if (!reducedMotion()) lifeAnimation = panel.animate(
                [from, { opacity: 0, transform: 'translateY(6px)' }],
                { duration: 140, easing: 'cubic-bezier(.4,0,1,1)' }
            );
        },
        destroy() { retired = true; lifeAnimation?.cancel(); stopReporting(); }
    };
}
