import './shelf.css';
import { escapeAttribute, escapeHtml } from './views/file-view.js';
import { SHELF_STORAGE_KEY, normalizeShelves, transferShelfGroup, shelfOrientation, clampShelfPoint, shelfDockPreview, shelfPanelRect } from './shelf-model.js';

// Shelf gestures never take the file grid's drag path. The grid remains owned by
// space-view, including its reserved insertion slot and native file actions.
export function createShelfView({ root, stage, storage, gridMarkup, iconMarkup, faceMarkup, hydrate, animateSurface, clearMotion, motionPose, onEdit, onInteraction, onError }) {
    const doc = root.ownerDocument, win = doc.defaultView, abort = new AbortController();
    let shelves = [], groups = [], enabled = false, dragging = null, frame = 0, revision = 0;
    let displays = [], suppressUntil = 0, hoverTimer = 0, leaveTimer = 0, hoveredKey = '';
    let saved = [];
    try { saved = JSON.parse(storage.getItem(SHELF_STORAGE_KEY) || '[]'); } catch { /* Recover malformed layouts. */ }
    const nodes = new Map(), grids = new Map(), opened = new Set(), temporary = new Set(), scrolls = new Map();
    const menu = doc.createElement('div'), preview = doc.createElement('div'), ghost = doc.createElement('div'), parking = doc.createElement('div');
    menu.className = 'space-context space-shelf-menu'; menu.hidden = true;
    preview.className = 'space-shelf-preview'; preview.hidden = true;
    ghost.className = 'space-shelf-ghost'; ghost.hidden = true;
    parking.className = 'space-shelf-cache'; parking.hidden = true;
    root.append(menu, preview, ghost, parking);
    const listen = (target, type, fn, capture = false) => target.addEventListener(type, fn, { signal: abort.signal, capture });
    const shelfById = id => shelves.find(shelf => shelf.id === id);
    const groupByKey = key => groups.find(group => group.key === key);
    const bounds = () => root.getBoundingClientRect();
    const point = event => ({ x: event.clientX - bounds().x, y: event.clientY - bounds().y });
    const areas = () => displays.length ? displays : [{ id: 'primary', x: 0, y: 0, width: root.clientWidth, height: root.clientHeight }];
    const areaFor = shelf => areas().find(area => area.id === shelf.display) || areas()[0];
    const areaAt = p => areas().find(area => p.x >= area.x && p.y >= area.y && p.x < area.x + area.width && p.y < area.y + area.height) || areas()[0];
    const notify = () => onInteraction?.(dragging?.moved === true);
    const reduced = () => root.dataset.reducedMotion === 'true' || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function save() {
        try { storage.setItem(SHELF_STORAGE_KEY, JSON.stringify(shelves)); saved = shelves; }
        catch (error) { onError?.(error); }
    }
    function tabMarkup(key, shelf) {
        const group = groupByKey(key);
        const symbol = shelf.form === 'card' && shelf.keys.length === 1 ? `<span class="space-shelf-card-face">${faceMarkup(group)}</span>` : group.files[0] ? iconMarkup(group.files[0], true) : '<span class="space-shelf-empty-icon">▦</span>';
        return `<button type="button" class="space-shelf-tab" data-shelf-tab="${escapeAttribute(key)}" data-space-group="${escapeAttribute(key)}" data-space-drop="${escapeAttribute(key)}" role="tab" aria-selected="${opened.has(shelf.id) && shelf.active === key}" aria-expanded="${opened.has(shelf.id) && shelf.active === key}" aria-controls="panel-${escapeAttribute(shelf.id)}" title="${escapeAttribute(group.name)} · 拖动排序或拆出">${symbol}<span class="space-shelf-label"><strong>${escapeHtml(group.name)}</strong><small data-space-count="${escapeAttribute(key)}">${group.files.length} 个项目</small></span></button>`;
    }
    function createNode(shelf) {
        const article = doc.createElement('article');
        article.className = 'space-shelf'; article.dataset.shelfId = shelf.id;
        article.innerHTML = `<nav class="space-shelf-rail" aria-label="桌面收纳架"><button class="space-shelf-grip" type="button" aria-label="拖动收纳架" title="拖动底座移动 · 右键设置排列">⠿</button><div class="space-shelf-tabs" role="tablist" aria-label="收纳分组"></div><button class="space-shelf-fold" type="button" aria-label="收起收纳架" title="收起">⌄</button></nav><section class="space-popup space-shelf-panel" id="panel-${escapeAttribute(shelf.id)}" role="region" aria-label="收纳文件" hidden></section>`;
        stage.append(article); nodes.set(shelf.id, article);
        return article;
    }
    function syncTabs(shelf) {
        const article = nodes.get(shelf.id), tabs = article.querySelector('.space-shelf-tabs');
        const old = new Map([...tabs.children].map(tab => [tab.dataset.shelfTab, tab]));
        let index = 0;
        for (const key of shelf.keys) {
            if (!groupByKey(key)) { old.get(key)?.remove(); old.delete(key); continue; }
            let tab = old.get(key);
            const card = shelf.form === 'card' && shelf.keys.length === 1;
            if (tab && card !== !!tab.querySelector('.space-shelf-card-face')) { tab.remove(); tab = null; }
            if (!tab) { const template = doc.createElement('template'); template.innerHTML = tabMarkup(key, shelf); tab = template.content.firstElementChild; }
            const group = groupByKey(key);
            tab.querySelector('strong').textContent = group.name;
            tab.querySelector('small').textContent = `${group.files.length} 个项目`;
            if (card) tab.querySelector('.space-shelf-card-face').innerHTML = faceMarkup(group);
            else if (group.files[0] && tab.querySelector('[data-space-icon]')?.dataset.path !== group.files[0].path) {
                const template = doc.createElement('template'); template.innerHTML = iconMarkup(group.files[0], true);
                tab.firstElementChild.replaceWith(template.content.firstElementChild);
            }
            const active = opened.has(shelf.id) && shelf.active === key;
            tab.setAttribute('aria-selected', String(active)); tab.setAttribute('aria-expanded', String(active));
            // Re-appending a focused tab blurs it even when the order is unchanged.
            if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] || null);
            index++; old.delete(key);
        }
        old.forEach(tab => tab.remove());
        const fold = article.querySelector('.space-shelf-fold');
        fold.hidden = false;
        fold.setAttribute('aria-label', opened.has(shelf.id) ? '收起收纳架' : '展开收纳架');
        fold.textContent = opened.has(shelf.id) ? '⌄' : '⌃';
    }
    function arrangePanel(shelf) {
        const node = nodes.get(shelf.id), rail = node.querySelector('.space-shelf-rail'), panel = node.querySelector('.space-shelf-panel');
        if (panel.hidden) return;
        const r = rail.getBoundingClientRect(), base = bounds();
        const target = shelfPanelRect({ x: r.x - base.x, y: r.y - base.y, width: r.width, height: r.height }, shelf, areaFor(shelf), shelfOrientation(shelf), shelf.dock);
        Object.assign(panel.style, { left: `${target.x - parseFloat(node.style.left)}px`, top: `${target.y - parseFloat(node.style.top)}px`, width: `${target.width}px`, height: `${target.height}px` });
        node.dataset.direction = target.direction;
    }
    function arrange() {
        if (!enabled || dragging?.moved) return;
        for (const shelf of shelves) {
            const node = nodes.get(shelf.id), area = areaFor(shelf);
            node.dataset.orientation = shelfOrientation(shelf); node.dataset.dock = shelf.dock;
            node.dataset.form = shelf.form === 'card' && shelf.keys.length === 1 ? 'card' : 'capsule';
            const vertical = shelfOrientation(shelf) === 'vertical';
            const rail = node.querySelector('.space-shelf-rail');
            rail.style.width = `${Math.min(node.dataset.form === 'card' ? 170 : vertical ? 176 : 42 + shelf.keys.length * 132, area.width - 32)}px`;
            rail.style.maxHeight = `${area.height - 32}px`;
            const size = rail.getBoundingClientRect();
            const raw = { x: area.x + 16 + shelf.x * Math.max(0, area.width - size.width - 32), y: area.y + 16 + shelf.y * Math.max(0, area.height - size.height - 32) };
            if (shelf.dock === 'left') raw.x = area.x + 16;
            if (shelf.dock === 'right') raw.x = area.x + area.width - size.width - 16;
            if (shelf.dock === 'top') raw.y = area.y + 16;
            if (shelf.dock === 'bottom') raw.y = area.y + area.height - size.height - 16;
            const p = clampShelfPoint(raw, size, area);
            node.style.left = `${p.x}px`; node.style.top = `${p.y}px`;
            arrangePanel(shelf);
        }
    }
    function renderPanel(shelf, { refresh = false } = {}) {
        const panel = nodes.get(shelf.id).querySelector('.space-shelf-panel'), group = groupByKey(shelf.active);
        const previous = panel.querySelector('.space-file-grid');
        if (previous) {
            scrolls.set(previous.dataset.spaceDrop, previous.scrollTop);
            if (root.classList.contains('space-dragging')) parking.append(previous);
            else previous.remove();
        }
        const grid = grids.get(group.key);
        if (!grid || refresh && !root.classList.contains('space-dragging')) {
            const template = doc.createElement('template'); template.innerHTML = gridMarkup(group);
            grids.set(group.key, template.content.firstElementChild);
        }
        panel.innerHTML = `<header class="space-popup-head"><div><strong>${escapeHtml(group.name)}</strong><small>引用分组 · 原文件位置保持不变</small></div><button type="button" class="space-shelf-pin" aria-label="${shelf.pinned ? '取消常驻展开' : '常驻展开'}" aria-pressed="${shelf.pinned}">⌖</button><button type="button" class="space-shelf-close space-popup-close" aria-label="收起">×</button></header><footer class="space-popup-footer">${group.files.length} 个项目 · 双击打开 · 拖动整理</footer><button type="button" class="space-shelf-resize" aria-label="拖动调整面板大小" title="拖动调整大小">◢</button>`;
        panel.querySelector('footer').before(grids.get(group.key));
        grids.get(group.key).scrollTop = scrolls.get(group.key) || 0;
        panel.setAttribute('aria-label', group.name);
        hydrate(panel);
    }
    function open(shelf, key = shelf.active, transient = false) {
        if (!shelf || !groupByKey(key)) return;
        const node = nodes.get(shelf.id), panel = node.querySelector('.space-shelf-panel');
        const pose = motionPose(panel, true), moving = panel.classList.contains('space-motion-host'), already = opened.has(shelf.id), switching = shelf.active !== key;
        shelf.active = key; panel._closeToken = ++revision;
        if (transient && !already) temporary.add(shelf.id);
        else if (!transient) temporary.delete(shelf.id);
        opened.add(shelf.id);
        clearMotion(panel);
        if (switching || !panel.querySelector('.space-file-grid')) renderPanel(shelf);
        panel.hidden = false; panel.style.pointerEvents = '';
        syncTabs(shelf); arrangePanel(shelf);
        if (!already || moving) animateSurface(panel, node.querySelector('.space-shelf-rail'), false, pose);
        else if (switching && !reduced()) panel.querySelector('.space-file-grid').animate([{ opacity: .35, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.2,.7,.25,1)' });
        if (!transient) save();
    }
    function closeShelf(shelf, immediate = false) {
        const node = nodes.get(shelf.id), panel = node?.querySelector('.space-shelf-panel');
        if (!panel || panel.hidden) return;
        const token = panel._closeToken = ++revision;
        opened.delete(shelf.id); temporary.delete(shelf.id); syncTabs(shelf);
        panel.style.pointerEvents = 'none';
        const finish = () => { if (panel._closeToken !== token) return; panel.hidden = true; clearMotion(panel); panel.style.pointerEvents = ''; };
        if (immediate) finish(); else animateSurface(panel, node.querySelector('.space-shelf-rail'), true).then(finish);
    }
    function dismiss() {
        if (dragging?.moved || root.classList.contains('space-dragging')) return;
        clearHover(); hideMenu();
        for (const shelf of shelves) if (!shelf.pinned) closeShelf(shelf);
    }
    function render(nextGroups) {
        groups = nextGroups;
        shelves = normalizeShelves(shelves.length ? shelves : saved, groups.map(group => group.key));
        if (!enabled) { stage.replaceChildren(); parking.replaceChildren(); nodes.clear(); grids.clear(); opened.clear(); temporary.clear(); }
        enabled = true;
        const keep = new Set(shelves.map(shelf => shelf.id));
        for (const [id, node] of nodes) if (!keep.has(id)) { clearMotion(node.querySelector('.space-shelf-panel')); node.remove(); nodes.delete(id); opened.delete(id); temporary.delete(id); }
        for (const shelf of shelves) {
            if (!nodes.has(shelf.id)) createNode(shelf);
            syncTabs(shelf);
            if (opened.has(shelf.id)) renderPanel(shelf, { refresh: true });
        }
        arrange();
        for (const shelf of shelves) if (shelf.pinned && !opened.has(shelf.id)) open(shelf);
        hydrate(stage);
    }
    function storePoint(shelf, p, area, size) {
        const value = clampShelfPoint(p, size, area);
        shelf.display = area.id;
        shelf.x = Math.max(0, Math.min(1, (value.x - area.x - 16) / Math.max(1, area.width - size.width - 32)));
        shelf.y = Math.max(0, Math.min(1, (value.y - area.y - 16) / Math.max(1, area.height - size.height - 32)));
    }
    function transfer(key, target, before = null, p = null) {
        const source = shelves.find(shelf => shelf.keys.includes(key));
        if (!source) return;
        const wasOpen = opened.has(source.id);
        const area = areaAt(p || { x: 100, y: 100 });
        const detached = { id: `shelf-${Date.now().toString(36)}-${(++revision).toString(36)}`, display: area.id, orientation: 'horizontal', form: 'card' };
        shelves = transferShelfGroup(shelves, key, target, before, detached);
        render(groups);
        const destination = shelves.find(shelf => shelf.keys.includes(key));
        if (p && !target && destination) { storePoint(destination, p, area, nodes.get(destination.id).querySelector('.space-shelf-rail').getBoundingClientRect()); arrange(); }
        save();
        if (destination && wasOpen) open(destination, key);
    }
    function hideMenu() { menu.hidden = true; }
    function showMenu(event, shelf, key) {
        event.preventDefault(); event.stopImmediatePropagation();
        const p = point(event);
        menu.dataset.shelf = shelf.id; menu.dataset.key = key || '';
        menu.innerHTML = `${key ? '<button type="button" role="menuitem" data-shelf-action="edit">编辑名称与卡片</button><button type="button" role="menuitem" data-shelf-action="detach">拆为独立收纳</button>' : ''}${shelf.keys.length === 1 ? `<button type="button" role="menuitem" data-shelf-action="form">${shelf.form === 'card' ? '显示为紧凑胶囊' : '显示为文件预览卡片'}</button>` : ''}<button type="button" role="menuitem" data-shelf-action="pin">${shelf.pinned ? '取消常驻展开' : '常驻展开'}</button>${[['auto', '自动排列（跟随停靠）'], ['horizontal', '横向排列'], ['vertical', '竖向排列']].map(([value, label]) => `<button type="button" role="menuitemradio" aria-checked="${shelf.orientation === value}" data-shelf-orientation="${value}">${label}${shelf.orientation === value ? ' ✓' : ''}</button>`).join('')}${key ? shelves.filter(item => item.id !== shelf.id).map(item => `<button type="button" role="menuitem" data-shelf-merge="${escapeAttribute(item.id)}">并入 ${escapeHtml(groupByKey(item.keys[0])?.name || '收纳架')}</button>`).join('') : ''}`;
        menu.hidden = false;
        menu.style.left = `${Math.max(8, Math.min(root.clientWidth - menu.offsetWidth - 8, p.x))}px`;
        menu.style.top = `${Math.max(8, Math.min(root.clientHeight - menu.offsetHeight - 8, p.y))}px`;
        menu.querySelector('button')?.focus({ preventScroll: true });
    }
    function drawDrag() {
        frame = 0;
        if (!dragging?.moved) return;
        const d = dragging, p = d.latest, node = nodes.get(d.shelf.id), area = areaAt(p);
        if (d.kind === 'resize') {
            // Keep the rail anchored; resize the file surface within its work area.
            const direction = node.dataset.direction;
            d.shelf.width = Math.max(260, Math.min(area.width - 32, d.width + (direction === 'left' ? -d.dx : d.dx)));
            d.shelf.height = Math.max(180, Math.min(area.height - 110, d.height + (direction === 'top' ? -d.dy : d.dy)));
            arrangePanel(d.shelf); return;
        }
        const target = d.kind === 'rail' ? [...nodes.entries()].filter(([id]) => id !== d.shelf.id).map(([, item]) => item.querySelector('.space-shelf-rail')).find(item => {
            const rect = item.getBoundingClientRect(); return p.x + bounds().x >= rect.left && p.x + bounds().x <= rect.right && p.y + bounds().y >= rect.top && p.y + bounds().y <= rect.bottom;
        }) : doc.elementFromPoint(p.x + bounds().x, p.y + bounds().y)?.closest('.space-shelf-rail');
        d.target = target?.closest('.space-shelf')?.dataset.shelfId || '';
        if (d.kind === 'rail') {
            const raw = { x: d.origin.x + d.dx, y: d.origin.y + d.dy };
            const position = clampShelfPoint(raw, d.size, area);
            node.style.left = `${position.x}px`; node.style.top = `${position.y}px`;
            d.position = position; d.area = area;
            d.dock = shelfDockPreview(raw, d.size, area);
            d.target = d.target === d.shelf.id ? '' : d.target;
            preview.textContent = d.target ? '合并收纳架' : d.dock === 'free' ? '' : `${{ top: '顶部', bottom: '底部', left: '左侧', right: '右侧' }[d.dock]}停靠 · ${shelfOrientation(d.shelf, d.dock) === 'vertical' ? '竖排' : '横排'}`;
            Object.assign(preview.style, { left: `${position.x}px`, top: `${position.y}px`, width: `${d.size.width}px`, height: `${d.size.height}px` });
            preview.hidden = !d.target && d.dock === 'free';
        } else {
            ghost.hidden = false; ghost.style.left = `${p.x - 50}px`; ghost.style.top = `${p.y - 24}px`;
            const tab = target && [...target.querySelectorAll('.space-shelf-tab')].find(item => {
                const r = item.getBoundingClientRect(); return shelfOrientation(shelfById(d.target)) === 'vertical' ? p.y + bounds().y < r.y + r.height / 2 : p.x + bounds().x < r.x + r.width / 2;
            });
            d.before = tab?.dataset.shelfTab || null;
            stage.querySelectorAll('.is-tab-insertion').forEach(item => item.classList.remove('is-tab-insertion'));
            tab?.classList.add('is-tab-insertion');
        }
        stage.querySelectorAll('.is-shelf-target').forEach(item => item.classList.remove('is-shelf-target'));
        if (d.target) nodes.get(d.target)?.querySelector('.space-shelf-rail').classList.add('is-shelf-target');
    }
    function finishDrag(cancel = false) {
        const d = dragging;
        if (!d) return;
        if (frame) { win.cancelAnimationFrame(frame); drawDrag(); }
        dragging = null; root.classList.remove('space-shelf-moving');
        ghost.hidden = true; preview.hidden = true;
        stage.querySelectorAll('.is-tab-insertion,.is-shelf-target,.is-shelf-moving').forEach(item => item.classList.remove('is-tab-insertion', 'is-shelf-target', 'is-shelf-moving'));
        if (d.handle.hasPointerCapture?.(d.pointer)) d.handle.releasePointerCapture(d.pointer);
        if (d.moved) {
            suppressUntil = Date.now() + 300;
            if (cancel) shelves = d.snapshot;
            else if (d.kind === 'tab') transfer(d.key, d.target, d.before, d.latest);
            else if (d.kind === 'rail' && d.target) {
                for (const key of [...d.shelf.keys]) shelves = transferShelfGroup(shelves, key, d.target);
            } else if (d.kind === 'rail') {
                d.shelf.dock = d.dock; storePoint(d.shelf, d.position, d.area, d.size);
            }
            save(); render(groups);
            if (d.wasOpen && !d.target && d.kind === 'rail') open(shelfById(d.shelf.id));
        }
        notify();
    }
    listen(root, 'pointerdown', event => {
        if (!enabled || event.button !== 0 || !event.isPrimary || event.target.closest('[data-presentation-ghost]')) return;
        const handle = event.target.closest('.space-shelf-grip,.space-shelf-tab,.space-shelf-resize,.space-shelf-rail');
        if (!handle || event.target.closest('.space-shelf-fold,.space-shelf-pin,.space-shelf-close')) return;
        const node = handle.closest('.space-shelf'), shelf = shelfById(node.dataset.shelfId), p = point(event);
        const rect = node.querySelector('.space-shelf-rail').getBoundingClientRect();
        const kind = handle.matches('.space-shelf-resize') ? 'resize' : handle.matches('.space-shelf-tab') ? 'tab' : 'rail';
        dragging = { shelf, handle, kind, key: handle.dataset.shelfTab, pointer: event.pointerId, start: p, latest: p, dx: 0, dy: 0, moved: false,
            origin: { x: rect.x - bounds().x, y: rect.y - bounds().y }, size: rect, width: shelf.width, height: shelf.height, wasOpen: opened.has(shelf.id), snapshot: structuredClone(shelves) };
        handle.setPointerCapture?.(event.pointerId); hideMenu();
    }, true);
    listen(win, 'pointermove', event => {
        if (!dragging || event.pointerId !== dragging.pointer) return;
        const p = point(event), d = dragging; d.latest = p; d.dx = p.x - d.start.x; d.dy = p.y - d.start.y;
        if (!d.moved && Math.hypot(d.dx, d.dy) < 7) return;
        event.preventDefault();
        if (!d.moved) {
            d.moved = true; root.classList.add('space-shelf-moving'); nodes.get(d.shelf.id).classList.add('is-shelf-moving');
            if (d.kind === 'rail') closeShelf(d.shelf, true);
            if (d.kind === 'tab') ghost.textContent = groupByKey(d.key).name;
            notify();
        }
        if (!frame) frame = win.requestAnimationFrame(drawDrag);
    });
    listen(win, 'pointerup', () => finishDrag());
    listen(win, 'pointercancel', () => finishDrag(true));
    listen(win, 'blur', () => finishDrag(true));
    listen(root, 'lostpointercapture', event => { if (event.pointerId === dragging?.pointer) finishDrag(true); });
    listen(root, 'click', event => {
        if (Date.now() < suppressUntil && event.target.closest('.space-shelf')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
        const node = event.target.closest('.space-shelf'), shelf = shelfById(node?.dataset.shelfId);
        const tab = event.target.closest('.space-shelf-tab');
        if (tab && shelf) { event.stopImmediatePropagation(); opened.has(shelf.id) && shelf.active === tab.dataset.shelfTab && !temporary.has(shelf.id) ? closeShelf(shelf) : open(shelf, tab.dataset.shelfTab); return; }
        if (event.target.closest('.space-shelf-fold,.space-shelf-close') && shelf) { event.stopImmediatePropagation(); if (opened.has(shelf.id)) { shelf.pinned = false; closeShelf(shelf); } else open(shelf); save(); return; }
        if (event.target.closest('.space-shelf-pin') && shelf) { event.stopImmediatePropagation(); shelf.pinned = !shelf.pinned; temporary.delete(shelf.id); renderPanel(shelf); save(); return; }
        const action = event.target.closest('[data-shelf-action],[data-shelf-orientation],[data-shelf-merge]');
        if (action) {
            event.stopImmediatePropagation(); const current = shelfById(menu.dataset.shelf), key = menu.dataset.key; hideMenu();
            if (!current) return;
            if (action.dataset.shelfAction === 'edit') onEdit(key, nodes.get(current.id).querySelector(`[data-shelf-tab="${CSS.escape(key)}"]`));
            else if (action.dataset.shelfAction === 'detach') transfer(key, '', null, { x: parseFloat(nodes.get(current.id).style.left) - 40, y: parseFloat(nodes.get(current.id).style.top) - 110 });
            else if (action.dataset.shelfMerge) transfer(key, action.dataset.shelfMerge);
            else if (action.dataset.shelfAction === 'pin') { current.pinned = !current.pinned; open(current); }
            else if (action.dataset.shelfAction === 'form') { current.form = current.form === 'card' ? 'capsule' : 'card'; syncTabs(current); arrange(); hydrate(stage); }
            else if (action.dataset.shelfOrientation) { current.orientation = action.dataset.shelfOrientation; arrange(); }
            save(); return;
        }
        if (!event.target.closest('.space-shelf-menu')) hideMenu();
    }, true);
    listen(root, 'contextmenu', event => {
        const rail = event.target.closest('.space-shelf-rail');
        if (rail) showMenu(event, shelfById(rail.closest('.space-shelf').dataset.shelfId), event.target.closest('.space-shelf-tab')?.dataset.shelfTab);
    }, true);
    function clearHover() { win.clearTimeout(hoverTimer); win.clearTimeout(leaveTimer); hoverTimer = 0; hoveredKey = ''; }
    listen(root, 'dragover', event => {
        const tab = event.target.closest('.space-shelf-tab');
        if (!tab || !root.classList.contains('space-dragging')) return;
        event.preventDefault();
        if (hoveredKey === tab.dataset.shelfTab) return;
        clearHover(); hoveredKey = tab.dataset.shelfTab;
        const shelf = shelfById(tab.closest('.space-shelf').dataset.shelfId);
        hoverTimer = win.setTimeout(() => { if (root.classList.contains('space-dragging')) open(shelf, tab.dataset.shelfTab, true); }, 300);
    }, true);
    listen(root, 'dragleave', event => { if (event.target.closest('.space-shelf-tab') && !event.target.closest('.space-shelf-tab').contains(event.relatedTarget)) clearHover(); });
    listen(root, 'dragend', () => {
        clearHover();
        leaveTimer = win.setTimeout(() => { for (const id of temporary) { const node = nodes.get(id); if (!node?.matches(':hover') && menu.hidden) closeShelf(shelfById(id)); } }, 450);
    });
    listen(root, 'pointerout', event => {
        const node = event.target.closest('.space-shelf');
        if (!node || node.contains(event.relatedTarget) || root.classList.contains('space-dragging')) return;
        leaveTimer = win.setTimeout(() => { if (temporary.has(node.dataset.shelfId) && menu.hidden && !root.querySelector('.space-overlay:not([hidden])') && !doc.querySelector('#contextMenu:not(.is-initially-hidden):not([style*="display: none"])')) closeShelf(shelfById(node.dataset.shelfId)); }, 400);
    });
    listen(root, 'pointerover', event => { if (event.target.closest('.space-shelf')) win.clearTimeout(leaveTimer); });
    listen(root, 'keydown', event => {
        if (event.key === 'Escape' && dragging) { event.preventDefault(); event.stopImmediatePropagation(); finishDrag(true); return; }
        if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hideMenu(); return; }
        const currentNode = event.target.closest('.space-shelf'), currentShelf = shelfById(currentNode?.dataset.shelfId);
        if (event.key === 'Escape' && currentShelf && opened.has(currentShelf.id)
            && ![...doc.querySelectorAll('.rename-dialog,.context-menu')].some(node => node.getClientRects().length && win.getComputedStyle(node).visibility !== 'hidden')) {
            event.preventDefault(); event.stopImmediatePropagation();
            currentShelf.pinned = false; closeShelf(currentShelf); save();
            currentNode.querySelector(`[data-shelf-tab="${CSS.escape(currentShelf.active)}"]`)?.focus({ preventScroll: true });
            return;
        }
        if (currentShelf && event.target.matches('.space-shelf-grip') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
            const r = currentNode.querySelector('.space-shelf-rail').getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
            const p = { x: r.x - bounds().x + ({ ArrowLeft: -step, ArrowRight: step }[event.key] || 0), y: r.y - bounds().y + ({ ArrowUp: -step, ArrowDown: step }[event.key] || 0) };
            currentShelf.dock = 'free'; storePoint(currentShelf, p, areaAt({ x: p.x + r.width / 2, y: p.y + r.height / 2 }), r); arrange(); save(); return;
        }
        if (currentShelf && event.ctrlKey && event.key === 'Tab') {
            event.preventDefault(); event.stopImmediatePropagation();
            const index = (currentShelf.keys.indexOf(currentShelf.active) + (event.shiftKey ? -1 : 1) + currentShelf.keys.length) % currentShelf.keys.length;
            open(currentShelf, currentShelf.keys[index]); currentNode.querySelector(`[data-shelf-tab="${CSS.escape(currentShelf.keys[index])}"]`).focus({ preventScroll: true }); return;
        }
        const tab = event.target.closest('.space-shelf-tab'), shelf = currentShelf;
        if (!tab || !shelf) return;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
            const index = shelf.keys.indexOf(tab.dataset.shelfTab), delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? shelf.keys.length - 1 : (index + delta + shelf.keys.length) % shelf.keys.length;
            const target = nodes.get(shelf.id).querySelector(`[data-shelf-tab="${CSS.escape(shelf.keys[next])}"]`); target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            if (opened.has(shelf.id)) open(shelf, shelf.keys[next]);
        }
    }, true);
    listen(doc, 'pointerdown', event => {
        if (!enabled || dragging || root.classList.contains('space-dragging')
            || event.target.closest('.space-context,.context-menu,.rename-dialog,.space-overlay')) return;
        for (const shelf of shelves) if (!shelf.pinned && !nodes.get(shelf.id)?.contains(event.target)) closeShelf(shelf);
    }, true);
    listen(doc, 'keydown', event => {
        if (!enabled || event.defaultPrevented || event.key !== 'Escape' || !opened.size
            || [...doc.querySelectorAll('.rename-dialog,.context-menu,.space-overlay,.appearance-panel,.desktop-search-panel')].some(node => node.getClientRects().length && win.getComputedStyle(node).visibility !== 'hidden')) return;
        const shelf = shelfById([...opened].at(-1));
        event.preventDefault(); shelf.pinned = false; closeShelf(shelf); save();
        nodes.get(shelf.id).querySelector(`[data-shelf-tab="${CSS.escape(shelf.active)}"]`)?.focus({ preventScroll: true });
    });
    listen(win, 'resize', arrange);
    listen(win, 'storage', event => { if (event.key === SHELF_STORAGE_KEY && !dragging) { try { saved = JSON.parse(event.newValue || '[]'); shelves = []; if (enabled) render(groups); } catch (error) { onError?.(error); } } });
    return {
        render, arrange,
        restorePinned() { for (const shelf of shelves) if (shelf.pinned && !opened.has(shelf.id)) open(shelf); },
        syncCounts(value) {
            groups = value;
            if (!enabled) return;
            for (const shelf of shelves) {
                syncTabs(shelf);
                const footer = nodes.get(shelf.id)?.querySelector('.space-popup-footer');
                if (footer) footer.textContent = `${groupByKey(shelf.active)?.files.length || 0} 个项目 · 双击打开 · 拖动整理`;
            }
        },
        setDisplays(value) { displays = Array.isArray(value) ? value.filter(area => area.width > 0 && area.height > 0) : []; arrange(); },
        dismiss,
        cancelGesture: () => finishDrag(true),
        close(transientOnly = false) { if (transientOnly) { dismiss(); return; } clearHover(); hideMenu(); for (const shelf of shelves) closeShelf(shelf, true); },
        deactivate() { finishDrag(true); this.close(); enabled = false; },
        destroy() { this.deactivate(); abort.abort(); menu.remove(); preview.remove(); ghost.remove(); parking.remove(); },
        get moving() { return !!dragging?.moved; }
    };
}
