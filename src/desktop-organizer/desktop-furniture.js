const KEY = 'dtkit_desktop_space_positions_v1';
const LIMIT = 100;

export function normalizeFurniturePositions(value) {
    const output = { islands: {}, zones: {} };
    for (const layout of Object.keys(output)) {
        const entries = value?.[layout];
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        for (const [key, position] of Object.entries(entries).slice(0, LIMIT)) {
            if (key.length > 180 || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue;
            output[layout][key] = { x: Math.min(1, Math.max(0, position.x)), y: Math.min(1, Math.max(0, position.y)) };
        }
    }
    return output;
}

export function clampFurniturePosition({ x, y }, size, viewport) {
    return {
        x: Math.round(Math.max(12, Math.min(Math.max(12, viewport.width - size.width - 12), x))),
        y: Math.round(Math.max(12, Math.min(Math.max(12, viewport.height - size.height - 12), y)))
    };
}

// Cabinet captions move furniture; file buttons keep their own HTML5 drag path.
export function createDesktopFurnitureController({ root, storage, onMove, onDragChange }) {
    const doc = root.ownerDocument, win = doc.defaultView;
    const abort = new AbortController();
    let positions = normalizeFurniturePositions({}), drag = null, moveFrame = 0, suppressedKey = '', suppressedUntil = 0;
    try { positions = normalizeFurniturePositions(JSON.parse(storage.getItem(KEY) || '{}')); } catch { /* Fresh arrangement. */ }
    root.dataset.freeFurniture = 'true';
    const viewport = () => ({ width: win.innerWidth, height: win.innerHeight });
    const nodes = () => [...root.querySelectorAll('.space-stage :is(.space-block,.space-zone)')];
    function applyPosition(element, point) {
        const rect = element.getBoundingClientRect();
        const clamped = clampFurniturePosition(point, rect, viewport());
        element.style.left = `${clamped.x}px`;
        element.style.top = `${clamped.y}px`;
        return clamped;
    }
    function arrange() {
        const layout = root.dataset.layout;
        if (!positions[layout] || drag) return;
        const items = nodes();
        const stepX = layout === 'zones' ? Math.min(360, win.innerWidth - 48) : 186;
        const stepY = layout === 'zones' ? 264 : 224;
        const rows = Math.max(1, Math.floor((win.innerHeight - 120) / stepY));
        const columns = Math.max(1, Math.min(Math.floor((win.innerWidth - 48) / stepX), Math.max(2, Math.ceil(items.length / rows))));
        items.forEach((element, index) => {
            const saved = positions[layout][element.dataset.spaceGroup];
            applyPosition(element, saved ? { x: saved.x * win.innerWidth, y: saved.y * win.innerHeight } : {
                x: win.innerWidth - 36 - (columns - index % columns) * stepX,
                y: 36 + Math.floor(index / columns) * stepY
            });
        });
        onMove?.();
    }
    function drawMove() {
        moveFrame = 0;
        if (!drag?.moved) return;
        drag.last = applyPosition(drag.element, { x: drag.origin.x + drag.dx, y: drag.origin.y + drag.dy });
        onMove?.();
    }
    function finish() {
        if (!drag) return;
        if (moveFrame) { win.cancelAnimationFrame(moveFrame); drawMove(); }
        const current = drag;
        drag = null;
        if (current.moved) onDragChange?.(false);
        current.element.classList.remove('is-furniture-moving');
        if (current.handle.hasPointerCapture?.(current.pointer)) current.handle.releasePointerCapture(current.pointer);
        if (current.moved) {
            positions[current.layout][current.key] = {
                x: Number((current.last.x / win.innerWidth).toFixed(5)),
                y: Number((current.last.y / win.innerHeight).toFixed(5))
            };
            try { storage.setItem(KEY, JSON.stringify(positions)); } catch (error) { console.error('保存桌面收纳位置失败:', error); }
            suppressedKey = current.key; suppressedUntil = Date.now() + 300;
        }
        onMove?.();
    }
    root.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || event.target.closest('.space-editor,.space-popup,.space-drawer')) return;
        const handle = event.target.closest('.space-caption,.space-zone-head');
        const element = handle?.closest('.space-block,.space-zone');
        if (!element || element.closest('[data-presentation-ghost]')) return;
        const rect = element.getBoundingClientRect();
        drag = { element, handle, pointer: event.pointerId, layout: root.dataset.layout, key: element.dataset.spaceGroup,
            startX: event.clientX, startY: event.clientY, origin: { x: rect.x, y: rect.y }, dx: 0, dy: 0, moved: false, last: null };
        handle.setPointerCapture?.(event.pointerId);
    }, { signal: abort.signal });
    win.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        drag.dx = event.clientX - drag.startX; drag.dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 6) return;
        event.preventDefault();
        if (!drag.moved) { drag.moved = true; onDragChange?.(true); }
        drag.element.classList.add('is-furniture-moving');
        if (!moveFrame) moveFrame = win.requestAnimationFrame(drawMove);
    }, { signal: abort.signal });
    win.addEventListener('pointerup', finish, { signal: abort.signal });
    win.addEventListener('pointercancel', finish, { signal: abort.signal });
    win.addEventListener('blur', finish, { signal: abort.signal });
    root.addEventListener('lostpointercapture', event => { if (event.pointerId === drag?.pointer) finish(); }, { signal: abort.signal });
    doc.addEventListener('click', event => {
        if (Date.now() > suppressedUntil || event.target.closest('[data-space-group]')?.dataset.spaceGroup !== suppressedKey) return;
        event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true, signal: abort.signal });
    win.addEventListener('resize', arrange, { signal: abort.signal });
    win.addEventListener('storage', event => {
        if (event.key !== KEY) return;
        try { positions = normalizeFurniturePositions(JSON.parse(event.newValue || '{}')); } catch { positions = normalizeFurniturePositions({}); }
        arrange();
    }, { signal: abort.signal });
    const observer = new MutationObserver(records => {
        if (records.some(record => record.target.matches?.('.space-stage,.space-islands,.space-zones') || record.attributeName === 'data-layout')) arrange();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-layout'] });
    arrange();
    return { arrange, cancelGesture: finish, destroy() { finish(); abort.abort(); observer.disconnect(); if (moveFrame) win.cancelAnimationFrame(moveFrame); } };
}
