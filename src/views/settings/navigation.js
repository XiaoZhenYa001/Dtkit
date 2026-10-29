import { prefersReducedSettingsMotion } from './motion.js';

let currentNavigation = null;

export function activeSettingsSection(positions, activationLine, atEnd = false) {
    if (!positions.length) return null;
    if (atEnd) return positions.at(-1).id;
    return positions.reduce((active, section) => section.top <= activationLine + 1 ? section.id : active, positions[0].id);
}

export function initSettingsNavigation() {
    const navigation = document.querySelector('.settings-side-nav');
    if (!navigation || currentNavigation?.navigation === navigation) return;
    currentNavigation?.destroy();
    const panels = document.querySelector('.settings-panels');
    const view = navigation.closest('#settingsView');
    const scroller = document.querySelector('.content-area');
    const sections = [...(panels?.querySelectorAll(':scope > .settings-section') || [])].filter(section => section.id);
    if (!scroller || !sections.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    const on = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal });
    const note = navigation.querySelector('.settings-side-nav__note');
    navigation.querySelectorAll('a[href^="#"]').forEach(link => link.remove());
    const links = sections.map(section => {
        const link = document.createElement('a');
        link.href = `#${section.id}`;
        link.className = 'settings-side-nav__item';
        const icon = document.createElement('i');
        icon.className = section.dataset.settingsNavIcon || section.querySelector('.settings-section-header > i')?.className || 'ri-settings-3-line';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = section.dataset.settingsNavLabel || section.querySelector('.settings-section-title')?.textContent?.trim() || section.id;
        link.append(icon, label);
        navigation.insertBefore(link, note);
        return link;
    });
    let pendingTarget = null;
    let activeId = null;
    let frame = null;
    let settleTimer = null;
    let arrivalTimer = null;
    let arrivalSection = null;
    let deferredHash = readHash();
    const visible = () => Boolean(view?.classList.contains('view--active') && panels.getClientRects().length);
    const offset = section => {
        const margin = Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 16;
        const horizontal = navigation.clientWidth >= panels.clientWidth * .8 && navigation.clientHeight < 160;
        return horizontal ? Math.max(margin, navigation.getBoundingClientRect().height + 12) : margin;
    };
    const targetTop = section => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset(section)));
    const revealLink = link => {
        if (navigation.scrollWidth <= navigation.clientWidth) return;
        const bounds = link.getBoundingClientRect();
        const viewport = navigation.getBoundingClientRect();
        if (bounds.left < viewport.left) navigation.scrollLeft -= viewport.left - bounds.left;
        else if (bounds.right > viewport.right) navigation.scrollLeft += bounds.right - viewport.right;
    };
    const activate = id => {
        if (id === activeId) return;
        activeId = id;
        links.forEach((link, index) => {
            const active = sections[index].id === id;
            link.classList.toggle('settings-side-nav__item--active', active);
            if (active) link.setAttribute('aria-current', 'true');
            else link.removeAttribute('aria-current');
            if (active) revealLink(link);
        });
    };
    const sync = () => {
        frame = null;
        if (!visible()) return;
        if (deferredHash) {
            const section = sections.find(item => item.id === deferredHash);
            deferredHash = null;
            if (section) { goTo(section, { instant: true }); return; }
        }
        if (pendingTarget && Math.abs(scroller.scrollTop - targetTop(pendingTarget)) > 2) return;
        pendingTarget = null;
        const positions = sections.map(section => ({ id: section.id, top: section.getBoundingClientRect().top }));
        activate(activeSettingsSection(positions, scroller.getBoundingClientRect().top + offset(sections[0]) + 2,
            scroller.scrollTop > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2));
    };
    const queueSync = () => { if (frame === null) frame = requestAnimationFrame(sync); };
    const clearArrival = () => {
        clearTimeout(arrivalTimer); arrivalTimer = null;
        arrivalSection?.removeAttribute('data-settings-arriving'); arrivalSection = null;
    };
    function readHash() {
        try { const id = decodeURIComponent(location.hash.slice(1)); return sections.some(section => section.id === id) ? id : null; }
        catch { return null; }
    }
    function goTo(section, { instant = false, focus = false, updateHash = false } = {}) {
        clearTimeout(settleTimer);
        clearArrival();
        const smooth = !instant && !prefersReducedSettingsMotion();
        pendingTarget = smooth ? section : null;
        activate(section.id);
        scroller.scrollTo({ top: targetTop(section), behavior: smooth ? 'smooth' : 'instant' });
        if (focus) {
            const heading = section.querySelector('.settings-section-title') || section;
            if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
        } else if (smooth) {
            arrivalSection = section;
            section.setAttribute('data-settings-arriving', 'true');
            arrivalTimer = setTimeout(clearArrival, 600);
        }
        if (updateHash) history.replaceState(history.state, '', `#${section.id}`);
        queueSync();
    }
    const interrupt = () => {
        if (!pendingTarget) return;
        pendingTarget = null; clearTimeout(settleTimer);
        scroller.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
        queueSync();
    };
    links.forEach((link, index) => {
        on(link, 'click', event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
            event.preventDefault(); deferredHash = null;
            goTo(sections[index], { instant: event.detail === 0, focus: event.detail === 0, updateHash: true });
        });
        on(link, 'keydown', event => {
            const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0;
            if (!step && !['Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (index + step + links.length) % links.length;
            links[next].focus({ preventScroll: true }); revealLink(links[next]);
        });
    });
    on(scroller, 'scroll', () => {
        queueSync(); clearTimeout(settleTimer);
        // A quiet-scroll fallback also works on WebViews without scrollend.
        if (pendingTarget) settleTimer = setTimeout(() => { pendingTarget = null; queueSync(); }, 120);
    }, { passive: true });
    on(scroller, 'scrollend', () => {
        // Cancelling an earlier smooth scroll may dispatch scrollend after the
        // next click. Only settle when the latest destination has been reached.
        if (!pendingTarget || Math.abs(scroller.scrollTop - targetTop(pendingTarget)) <= 2) {
            pendingTarget = null; clearTimeout(settleTimer);
        }
        queueSync();
    });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) on(scroller, event, interrupt, { passive: true });
    on(window, 'resize', () => { interrupt(); queueSync(); });
    on(window, 'hashchange', () => { deferredHash = readHash(); queueSync(); });
    const resizeObserver = new ResizeObserver(queueSync);
    resizeObserver.observe(navigation); resizeObserver.observe(panels);
    const viewObserver = new MutationObserver(() => {
        if (!visible()) { pendingTarget = null; clearTimeout(settleTimer); }
        queueSync();
    });
    if (view) viewObserver.observe(view, { attributes: true, attributeFilter: ['class'] });
    currentNavigation = {
        navigation,
        destroy() {
            controller.abort(); resizeObserver.disconnect(); viewObserver.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
            clearTimeout(settleTimer); clearArrival();
        }
    };
    on(window, 'pagehide', () => { currentNavigation?.destroy(); currentNavigation = null; }, { once: true });
    activate(sections[0].id); queueSync();
}
