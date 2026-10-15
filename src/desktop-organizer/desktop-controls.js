const STORAGE_KEY = 'dtkit_desktop_controls_v1';
const SIZE = 52, EXPANDED = 244, MARGIN = 16;

// A fixed dial anchors both the unfolding tools and their popover. Docking keeps
// its own position; it never changes the shelf's group membership or file order.
export function createDesktopControls({ document: doc, window: win, onMove, onDragChange }) {
    const tools = doc.getElementById('desktopTools'), abort = new AbortController();
    const buttons = [...tools.children];
    const actions = doc.createElement('div');
    actions.className = 'desktop-tool-actions'; actions.id = 'desktopToolActions'; actions.hidden = true;
    actions.append(...buttons);
    for (const button of buttons) {
        const label = doc.createElement('span'); label.className = 'desktop-tool-label';
        label.textContent = ({ desktopSearchButton: '搜索', desktopCategoryButton: '新建', refreshBtn: '刷新', appearanceBtn: '外观' })[button.id];
        button.append(label);
    }
    const dial = doc.createElement('button');
    dial.id = 'desktopToolsToggle'; dial.className = 'desktop-tool-dial'; dial.type = 'button';
    dial.setAttribute('aria-label', '展开桌面快捷操作'); dial.setAttribute('aria-expanded', 'false');
    dial.setAttribute('aria-controls', actions.id); dial.title = '点击展开快捷操作 · 拖动移动，靠近收纳架或抽屉吸附';
    dial.innerHTML = '<span class="desktop-dial-ring" aria-hidden="true"></span><i class="ri-settings-3-line" aria-hidden="true"></i><span class="desktop-dial-dot" aria-hidden="true"></span>';
    tools.append(actions, dial);
    let saved = {}, expanded = false, dragging = null, frame = 0, animation = null, actionAnimation = null, revision = 0, suppressedUntil = 0;
    let position = { x: 0, y: 0 }, displays = [], candidate = null, reservation = null;
    let drawerWasOpen = null, followAnimation = null, followReservation = null;
    try {
        const value = JSON.parse(win.localStorage.getItem(STORAGE_KEY) || '{}');
        saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        if (saved.attachment && (!['left','right','top','bottom'].includes(saved.attachment.side)
            || !['shelf','drawer'].includes(saved.attachment.type))) saved.attachment = null;
    } catch { /* Fresh control position. */ }
    const listen = (target, type, callback, capture = false) => target.addEventListener(type, callback, { signal: abort.signal, capture });
    const areas = () => displays.length ? displays : [{ id: 'primary', x: 0, y: 0, width: win.innerWidth, height: win.innerHeight }];
    const areaAt = point => areas().find(area => point.x >= area.x && point.y >= area.y && point.x < area.x + area.width && point.y < area.y + area.height) || areas()[0];
    const clamp = (p, area = areaAt({ x: p.x + SIZE / 2, y: p.y + SIZE / 2 })) => ({
        x: Math.max(area.x + MARGIN, Math.min(area.x + area.width - SIZE - MARGIN, p.x)),
        y: Math.max(area.y + MARGIN, Math.min(area.y + area.height - SIZE - MARGIN, p.y))
    });
    const reduced = () => doc.body.dataset.reducedMotion === 'true' || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function save() {
        const area = areaAt({ x: position.x + SIZE / 2, y: position.y + SIZE / 2 });
        saved = { ...saved, display: area.id, x: (position.x - area.x - MARGIN) / Math.max(1, area.width - SIZE - MARGIN * 2), y: (position.y - area.y - MARGIN) / Math.max(1, area.height - SIZE - MARGIN * 2) };
        try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (error) { console.error('保存桌面快捷操作位置失败:', error); }
    }
    function anchorFor(attachment) {
        if (attachment?.type === 'shelf' && typeof attachment.id === 'string') return [...doc.querySelectorAll('.space-shelf')].find(node => node.dataset.shelfId === attachment.id)?.querySelector('.space-shelf-rail');
        if (attachment?.type === 'drawer') {
            const handle = doc.querySelector('.space-drawer-handle');
            return handle?.getAttribute('aria-expanded') === 'true' ? doc.querySelector('.space-drawer') : handle;
        }
        return null;
    }
    function dockPoint(anchor, side) {
        let r = anchor.getBoundingClientRect();
        if (anchor.matches('.space-drawer')) {
            // The drawer's animation is painted over its final layout. Attach to
            // that layout, so the dial follows one continuous path beside it.
            const base = anchor.offsetParent.getBoundingClientRect();
            r = { left: base.left + anchor.offsetLeft, top: base.top + anchor.offsetTop, width: anchor.offsetWidth, height: anchor.offsetHeight };
            r.right = r.left + r.width; r.bottom = r.top + r.height;
        }
        if (side === 'left') return { x: r.left - SIZE - 8, y: r.top + (r.height - SIZE) / 2 };
        if (side === 'top') return { x: r.left + (r.width - SIZE) / 2, y: r.top - SIZE - 8 };
        if (side === 'bottom') return { x: r.left + (r.width - SIZE) / 2, y: r.bottom + 8 };
        return { x: r.right + 8, y: r.top + (r.height - SIZE) / 2 };
    }
    function paint() {
        const area = areaAt({ x: position.x + SIZE / 2, y: position.y + SIZE / 2 });
        const attachment = tools.dataset.attached ? saved.attachment : null;
        const roomLeft = position.x - area.x - MARGIN + SIZE, roomRight = area.x + area.width - MARGIN - position.x;
        const vertical = expanded && ((attachment?.side === 'left' && roomLeft < EXPANDED) || (attachment?.side === 'right' && roomRight < EXPANDED));
        const width = expanded && !vertical ? Math.min(EXPANDED, area.width - MARGIN * 2) : SIZE;
        const height = vertical ? Math.min(EXPANDED, area.height - MARGIN * 2) : SIZE;
        const leftward = attachment?.side === 'left' && !vertical || !attachment && roomRight < width;
        const upward = vertical && position.y + height > area.y + area.height - MARGIN;
        tools.dataset.direction = vertical ? upward ? 'up' : 'down' : leftward ? 'left' : 'right';
        tools.dataset.expanded = String(expanded);
        tools.style.left = `${position.x - (leftward ? width - SIZE : 0)}px`;
        tools.style.top = `${position.y - (upward ? height - SIZE : 0)}px`; tools.style.width = `${width}px`; tools.style.height = `${height}px`;
        tools.style.right = 'auto'; tools.style.bottom = 'auto';
        positionPopover(); onMove?.();
    }
    function positionPopover() {
        const panel = doc.getElementById('appearancePanel');
        if (panel.hidden) return;
        const area = areaAt({ x: position.x + SIZE / 2, y: position.y + SIZE / 2 });
        const width = Math.min(310, area.width - MARGIN * 2);
        panel.style.width = `${width}px`;
        panel.style.maxHeight = `${Math.max(100, area.height - MARGIN * 2)}px`;
        const height = panel.offsetHeight;
        const y = position.y - height - 12 >= area.y + MARGIN ? position.y - height - 12 : Math.min(area.y + area.height - height - MARGIN, position.y + SIZE + 12);
        panel.style.left = `${Math.max(area.x + MARGIN, Math.min(area.x + area.width - width - MARGIN, position.x + SIZE - width))}px`;
        panel.style.top = `${Math.max(area.y + MARGIN, y)}px`; panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }
    function arrange() {
        if (dragging?.moved) return;
        const previous = tools.getBoundingClientRect();
        const anchor = anchorFor(saved.attachment);
        const attached = anchor?.getClientRects().length && !anchor.closest('[hidden]');
        const area = areas().find(item => item.id === saved.display) || areas()[0];
        position = clamp(attached ? dockPoint(anchor, saved.attachment.side) : {
            x: area.x + MARGIN + (Number.isFinite(saved.x) ? Math.max(0, Math.min(1, saved.x)) : 1) * Math.max(0, area.width - SIZE - MARGIN * 2),
            y: area.y + MARGIN + (Number.isFinite(saved.y) ? Math.max(0, Math.min(1, saved.y)) : 1) * Math.max(0, area.height - SIZE - MARGIN * 2)
        });
        tools.dataset.attached = attached ? saved.attachment.type : '';
        paint();
        const drawerOpen = anchor?.matches('.space-drawer') === true;
        if (attached && saved.attachment.type === 'drawer' && drawerWasOpen !== null && drawerWasOpen !== drawerOpen && !reduced()) {
            followAnimation?.cancel(); endFollow();
            const target = tools.getBoundingClientRect(), id = followReservation = `desktop-tools-follow-${++revision}`;
            doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion', { detail: { id, source: previous.toJSON(), target: target.toJSON(), duration: 270 } }));
            followAnimation = tools.animate([{ transform: `translate(${previous.x - target.x}px,${previous.y - target.y}px)` }, { transform: 'none' }], { duration: 270, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'both' });
            followAnimation.finished.catch(() => {}).then(() => { if (followReservation === id) { followAnimation?.cancel(); followAnimation = null; endFollow(); onMove?.(); } });
        }
        drawerWasOpen = drawerOpen;
    }
    function endFollow() {
        if (followReservation) doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion-end', { detail: followReservation }));
        followReservation = null;
    }
    function endMotion() {
        if (reservation) doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion-end', { detail: reservation }));
        reservation = null;
    }
    function toggle(open = !expanded, focus = false) {
        if (open === expanded) return;
        const style = win.getComputedStyle(tools), before = tools.getBoundingClientRect(), wasHidden = actions.hidden;
        const from = { width: style.width, height: style.height, left: style.left, top: style.top, borderRadius: style.borderRadius };
        const content = win.getComputedStyle(actions), contentFrom = { opacity: content.opacity, transform: content.transform };
        animation?.cancel(); actionAnimation?.cancel(); endMotion();
        expanded = open; actions.hidden = false; actions.inert = !open;
        dial.setAttribute('aria-expanded', String(open)); dial.setAttribute('aria-label', open ? '收起桌面快捷操作' : '展开桌面快捷操作');
        if (!open && actions.contains(doc.activeElement)) dial.focus({ preventScroll: true });
        paint(); const after = tools.getBoundingClientRect(), duration = open ? 340 : 230;
        if (reduced()) { actions.hidden = !open; return; }
        const id = reservation = `desktop-tools-${++revision}`;
        doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion', { detail: { id, source: before.toJSON(), target: after.toJSON(), duration } }));
        animation = tools.animate([from, { width: `${after.width}px`, height: `${after.height}px`, left: `${after.x}px`, top: `${after.y}px`, borderRadius: open ? '22px' : '26px' }], { duration, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'both' });
        actionAnimation = actions.animate([open ? { opacity: wasHidden ? 0 : Number(contentFrom.opacity), transform: wasHidden ? 'translateX(8px)' : contentFrom.transform } : contentFrom, { opacity: open ? 1 : 0, transform: open ? 'none' : 'translateX(6px)' }], { duration: open ? 210 : 130, delay: open && wasHidden ? 65 : 0, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'both' });
        animation.finished.catch(() => {}).then(() => {
            if (reservation !== id) return;
            animation?.cancel(); actionAnimation?.cancel(); animation = actionAnimation = null;
            actions.hidden = !expanded; endMotion(); onMove?.();
            if (focus && expanded) actions.querySelector('button')?.focus({ preventScroll: true });
        });
    }
    function findDock(p) {
        let best = null;
        for (const anchor of doc.querySelectorAll('.space-shelf-rail,.space-drawer-handle')) {
            if (!anchor.getClientRects().length || anchor.closest('[hidden]')) continue;
            const attachment = anchor.matches('.space-drawer-handle') ? { type: 'drawer' } : { type: 'shelf', id: anchor.closest('.space-shelf').dataset.shelfId };
            for (const side of ['right', 'left', 'bottom', 'top']) {
                const q = dockPoint(anchor, side), bounded = clamp(q);
                if (Math.abs(q.x - bounded.x) + Math.abs(q.y - bounded.y) > 1) continue;
                const distance = Math.hypot(q.x - p.x, q.y - p.y);
                if (distance < 46 && (!best || distance < best.distance)) best = { ...attachment, side, point: q, distance };
            }
        }
        return best;
    }
    function drawDrag() {
        frame = 0;
        if (!dragging?.moved) return;
        position = clamp({ x: dragging.origin.x + dragging.dx, y: dragging.origin.y + dragging.dy });
        candidate = findDock(position);
        tools.dataset.docking = candidate?.type || '';
        tools.dataset.attached = ''; paint();
    }
    function finishDrag(cancel = false) {
        const d = dragging;
        if (!d) return;
        if (frame) { win.cancelAnimationFrame(frame); drawDrag(); }
        dragging = null;
        tools.classList.remove('is-controls-moving'); tools.dataset.docking = '';
        if (dial.hasPointerCapture?.(d.pointer)) dial.releasePointerCapture(d.pointer);
        if (d.moved) {
            suppressedUntil = Date.now() + 350;
            if (cancel) { saved = d.saved; position = d.origin; }
            else { saved.attachment = candidate ? { type: candidate.type, id: candidate.id, side: candidate.side } : null; if (candidate) position = candidate.point; save(); }
            arrange(); onDragChange?.(false);
        }
        candidate = null;
    }
    listen(dial, 'pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        dragging = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position }, saved: structuredClone(saved), moved: false, dx: 0, dy: 0 };
        dial.setPointerCapture?.(event.pointerId);
    });
    listen(win, 'pointermove', event => {
        if (!dragging || event.pointerId !== dragging.pointer) return;
        dragging.dx = event.clientX - dragging.x; dragging.dy = event.clientY - dragging.y;
        if (!dragging.moved && Math.hypot(dragging.dx, dragging.dy) < 6) return;
        event.preventDefault();
        if (!dragging.moved) {
            dragging.moved = true; toggle(false);
            followAnimation?.cancel(); followAnimation = null; endFollow();
            animation?.cancel(); actionAnimation?.cancel(); animation = actionAnimation = null; endMotion(); actions.hidden = true;
            tools.classList.add('is-controls-moving'); onDragChange?.(true);
        }
        if (!frame) frame = win.requestAnimationFrame(drawDrag);
    });
    listen(win, 'pointerup', () => finishDrag()); listen(win, 'pointercancel', () => finishDrag(true));
    listen(dial, 'lostpointercapture', event => { if (dragging?.pointer === event.pointerId) finishDrag(true); });
    listen(dial, 'click', event => { if (Date.now() < suppressedUntil) { event.preventDefault(); return; } toggle(undefined, event.detail === 0); });
    listen(dial, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const step = event.shiftKey ? 40 : 10;
        saved.attachment = null; tools.dataset.attached = ''; position = clamp({ x: position.x + ({ ArrowLeft: -step, ArrowRight: step }[event.key] || 0), y: position.y + ({ ArrowUp: -step, ArrowDown: step }[event.key] || 0) }); save(); paint();
    });
    listen(doc, 'pointerdown', event => { if (!tools.contains(event.target) && !doc.getElementById('appearancePanel').contains(event.target)) toggle(false); }, true);
    listen(tools, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggle(false); dial.focus({ preventScroll: true }); } });
    listen(win, 'blur', () => { finishDrag(true); toggle(false); }); listen(win, 'resize', arrange);
    // Only furniture geometry and the popover's own changes can move the dial.
    // Observing tool styles would feed each paint back into another paint.
    const observer = new MutationObserver(records => {
        if (records.some(record => !tools.contains(record.target) && (record.type === 'childList' || record.target === doc.getElementById('appearancePanel') || saved.attachment && record.target.closest?.('#desktopSpaceView')))) {
            if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; arrange(); });
        }
    });
    observer.observe(doc.getElementById('desktopSpaceView'), { childList: true, subtree: true, attributes: true, attributeFilter: ['style','hidden','data-layout','aria-expanded'] });
    observer.observe(doc.getElementById('appearancePanel'), { attributes: true, attributeFilter: ['hidden'] });
    arrange();
    return { arrange, positionPopover, cancelGesture: () => finishDrag(true), close: () => toggle(false), setDisplays(value) { displays = Array.isArray(value) ? value.filter(area => area.width > 0 && area.height > 0) : []; arrange(); }, destroy() { finishDrag(true); abort.abort(); observer.disconnect(); if (frame) win.cancelAnimationFrame(frame); animation?.cancel(); actionAnimation?.cancel(); followAnimation?.cancel(); endMotion(); endFollow(); } };
}
