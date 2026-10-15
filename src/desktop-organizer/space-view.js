import './space.css';
import { escapeAttribute, escapeHtml, getFileIcon } from './views/file-view.js';
import { DESKTOP_SPACE_STORAGE_KEY, createSpaceGroups, folderPreviewSlots, migrateSpaceOrderPath, normalizeSpacePreferences, spaceFileId, updateSpaceOrder } from './space-model.js';
import { createShelfView } from './shelf-view.js';

const TYPES = { small: '小文件夹', quad: '四宫格', nine: '九宫格' };
const TYPE_NOTES = { small: '9 个等大的图标，更多项目展开查看。', quad: '3 个大图标，右下角展示 4 个小图标。', nine: '8 个大图标，右下角展示 4 个小图标。' };
const escape = escapeHtml;

export function createDesktopSpaceView({ root, state, storage = globalThis.localStorage, onOpen, onSelect, onContextMenu, onAssign, hydrateIcons, onInteraction, onError }) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const abort = new AbortController();
    let preferences = normalizeSpacePreferences({});
    try { preferences = normalizeSpacePreferences(JSON.parse(storage.getItem(DESKTOP_SPACE_STORAGE_KEY) || '{}')); } catch { /* Recover from old or malformed data. */ }
    let groups = [], options = { layout: 'shelf', appearance: 'warm', reducedMotion: false }, shelf = null;
    let signature = '', activeGroup = '', drawerGroup = '', drawerOpen = false;
    let origin = null, editorDraft = null, returnFocus = null, contextKey = '', drag = null, scrollFrame = 0;
    let closingToken = 0, editorToken = 0, motionRevision = 0, destroyed = false, deferredRender = false;
    const motions = new Map();
    root.classList.add('space-view');
    root.innerHTML = '<div class="space-stage"></div><button type="button" class="space-drawer-handle" aria-label="展开我的桌面" aria-expanded="false" hidden><i class="ri-layout-grid-line"></i><span>我的桌面</span></button><section class="space-popup" role="dialog" aria-label="收纳块内容" hidden></section><section class="space-drawer" role="dialog" aria-label="我的桌面" hidden></section><div class="space-context" role="menu" hidden></div><div class="space-overlay" hidden></div>';
    const stage = root.querySelector('.space-stage');
    const handle = root.querySelector('.space-drawer-handle');
    const popup = root.querySelector('.space-popup');
    const drawer = root.querySelector('.space-drawer');
    const context = root.querySelector('.space-context');
    const overlay = root.querySelector('.space-overlay');
    const reduced = () => options.reducedMotion || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const groupByKey = key => groups.find(group => group.key === key);
    const allFiles = () => groups.flatMap(group => group.files);
    const fileById = id => allFiles().find(file => spaceFileId(file) === id);
    const selected = file => state.selectedFile?.path === file.path || (file.app_id && state.selectedFile?.appId === file.app_id);
    function interaction() { onInteraction?.(!!drag || !!editorDraft || !popup.hidden || !drawer.hidden || !context.hidden); }
    function save() {
        try { storage.setItem(DESKTOP_SPACE_STORAGE_KEY, JSON.stringify(preferences)); } catch (error) { onError?.(error); }
    }
    function hydrate(target = root) { Promise.resolve(hydrateIcons?.(target)).catch(error => onError?.(error)); }
    function iconMarkup(file, preview = false) {
        const kind = file.is_folder ? 'folder' : file.category || 'other';
        return `<span class="file-icon space-icon space-icon--${escapeAttribute(kind)}${file.icon ? ' file-icon-real' : ''}" data-space-icon data-path="${escapeAttribute(file.path)}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''}${preview ? ' aria-hidden="true"' : ''}>${getFileIcon(file)}</span>`;
    }
    function faceMarkup(group, size = group.size) {
        const slots = folderPreviewSlots(group.files, size);
        const count = size === 'quad' ? 3 : size === 'nine' ? 8 : 9;
        const cells = Array.from({ length: count }, (_, index) => `<span class="space-face-cell">${slots.direct[index] ? iconMarkup(slots.direct[index], true) : ''}</span>`).join('');
        const mini = size === 'small' ? '' : `<span class="space-mini-cell">${Array.from({ length: 4 }, (_, index) => `<span class="space-face-cell">${slots.mini[index] ? iconMarkup(slots.mini[index], true) : ''}</span>`).join('')}</span>`;
        return `<div class="space-face space-face--${size}">${cells}${mini}</div>`;
    }
    function fileMarkup(file) {
        const id = spaceFileId(file);
        return `<button type="button" draggable="true" class="space-file file-item${selected(file) ? ' selected' : ''}" data-space-id="${escapeAttribute(id)}" data-path="${escapeAttribute(file.path)}" data-name="${escapeAttribute(file.name)}" data-is-folder="${file.is_folder ? 'true' : 'false'}"${file.app_id ? ` data-app-id="${escapeAttribute(file.app_id)}"` : ''} aria-label="${escapeAttribute(file.name)}，${file.is_folder ? '打开文件夹' : '双击打开'}">${iconMarkup(file)}<span class="file-name">${escape(file.name)}</span></button>`;
    }
    function gridMarkup(group) {
        return `<div class="space-file-grid" data-space-drop="${escapeAttribute(group.key)}">${group.files.length ? group.files.map(fileMarkup).join('') : '<div class="space-empty">拖入项目，收进这里</div>'}</div>`;
    }
    function blockMarkup(group) {
        return `<article class="space-block${activeGroup === group.key ? ' is-open' : ''}" data-space-group="${escapeAttribute(group.key)}" data-space-drop="${escapeAttribute(group.key)}" aria-label="${escapeAttribute(group.name)} · ${TYPES[group.size]}" tabindex="0"><div class="space-folder-shell"><button type="button" class="space-folder-surface" data-space-open="${escapeAttribute(group.key)}" aria-label="展开${escapeAttribute(group.name)}" aria-expanded="${activeGroup === group.key}"></button>${faceMarkup(group)}</div><button type="button" class="space-caption" data-space-open="${escapeAttribute(group.key)}"><strong>${escape(group.name)}</strong><small data-space-count="${escapeAttribute(group.key)}">${group.files.length} 个项目</small></button></article>`;
    }
    function renderStage() {
        const scrollTop = stage.scrollTop;
        if (options.layout !== 'shelf') shelf?.deactivate();
        if (!state.files) stage.innerHTML = '<div class="space-empty">正在同步桌面…</div>';
        else if (!groups.length) stage.innerHTML = '<div class="space-empty"><i class="ri-folder-2-line"></i><br>桌面没有文件</div>';
        else if (options.layout === 'shelf') shelf.render(groups);
        else if (options.layout === 'zones') stage.innerHTML = `<div class="space-zones">${groups.map(group => `<article class="space-zone" data-space-group="${escapeAttribute(group.key)}" data-space-drop="${escapeAttribute(group.key)}"><header class="space-zone-head"><strong>${escape(group.name)}</strong><small data-space-count="${escapeAttribute(group.key)}">${group.files.length} 个项目</small></header>${gridMarkup(group)}</article>`).join('')}</div>`;
        else if (options.layout === 'drawer') stage.innerHTML = `<div class="space-drawer-home"><i class="ri-layout-grid-line"></i><strong>桌面，收在这里</strong><small>${allFiles().length} 个项目 · ${groups.length} 个收纳块</small><div class="space-drawer-summary">${groups.map(group => `<button type="button" data-space-drawer-open="${escapeAttribute(group.key)}">${escape(group.name)} <span>${group.files.length}</span></button>`).join('')}</div></div>`;
        else stage.innerHTML = `<div class="space-islands">${groups.map(blockMarkup).join('')}</div>`;
        stage.scrollTop = scrollTop;
        handle.hidden = options.layout !== 'drawer';
        hydrate(stage);
    }
    function clearMotion(element) {
        const running = motions.get(element);
        if (!running) return;
        running.animations.forEach(animation => animation.cancel());
        running.material.remove();
        element.classList.remove('space-motion-host');
        motions.delete(element);
        doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion-end', { detail: running.id }));
    }
    function motionPose(element, includeVisible = false) {
        if (element.hidden) return null;
        const running = motions.get(element);
        if (!running && !includeVisible) return null;
        const style = win.getComputedStyle(element);
        const radius = style.clipPath.match(/ round ([-.\d]+)px/);
        return {
            rect: (running?.material || element).getBoundingClientRect(),
            radius: Number(radius?.[1]) || parseFloat(style.borderTopLeftRadius) || 24,
            opacity: Number(style.opacity),
            contents: [...element.children].map(child => {
                const content = win.getComputedStyle(child);
                return { opacity: Number(content.opacity), transform: content.transform };
            })
        };
    }
    // Animate the glass boundary independently: the icons and text are clipped, never stretched.
    function animateSurface(element, anchor, closing = false, pose = motionPose(element)) {
        clearMotion(element);
        if (reduced() || !element.animate) return Promise.resolve();
        const target = element.getBoundingClientRect();
        const source = anchor?.getBoundingClientRect?.() || anchor;
        const compactWidth = Math.min(target.width, Math.max(32, source?.width || target.width * .94));
        const compactHeight = Math.min(target.height, Math.max(32, source?.height || target.height * .94));
        const compactX = source ? source.x + source.width / 2 - target.x - target.width / 2 : 0;
        const compactY = source ? source.y + source.height / 2 - target.y - target.height / 2 : 5;
        const radius = parseFloat(win.getComputedStyle(element).borderTopLeftRadius) || 24;
        const compact = { x: compactX, y: compactY, ix: (target.width - compactWidth) / 2, iy: (target.height - compactHeight) / 2, radius: Math.min(28, compactWidth * .24, compactHeight * .24), opacity: closing ? 0 : .72 };
        let initial = closing ? { x: 0, y: 0, ix: 0, iy: 0, radius, opacity: 1 } : compact;
        if (pose) {
            const painted = pose.rect;
            const ix = (target.width - painted.width) / 2, iy = (target.height - painted.height) / 2;
            initial = { x: painted.x - target.x - ix, y: painted.y - target.y - iy, ix, iy, radius: pose.radius, opacity: pose.opacity };
        }
        const final = closing ? compact : { x: 0, y: 0, ix: 0, iy: 0, radius, opacity: 1 };
        const samples = Array.from({ length: 25 }, (_, index) => {
            const offset = index / 24;
            const progress = (1 - (1 + 8 * offset) * Math.exp(-8 * offset)) / (1 - 9 * Math.exp(-8));
            return Object.fromEntries([['offset', offset], ...['x', 'y', 'ix', 'iy', 'radius', 'opacity'].map(key => [key, initial[key] + (final[key] - initial[key]) * progress])]);
        });
        const style = win.getComputedStyle(element), parentRect = element.parentElement.getBoundingClientRect();
        const material = doc.createElement('div');
        material.className = 'space-motion-material';
        material.setAttribute('aria-hidden', 'true');
        Object.assign(material.style, { left: `${target.x - parentRect.x}px`, top: `${target.y - parentRect.y}px`, width: `${target.width}px`, height: `${target.height}px`, background: style.background, border: style.border, boxShadow: style.boxShadow, backdropFilter: style.backdropFilter, webkitBackdropFilter: style.webkitBackdropFilter, zIndex: style.zIndex === 'auto' ? '0' : style.zIndex });
        element.before(material);
        element.classList.add('space-motion-host');
        const duration = closing ? 270 : 420;
        const id = ++motionRevision;
        const reservation = pose && source ? {
            x: Math.min(source.x, pose.rect.x), y: Math.min(source.y, pose.rect.y),
            width: Math.max(source.x + source.width, pose.rect.x + pose.rect.width) - Math.min(source.x, pose.rect.x),
            height: Math.max(source.y + source.height, pose.rect.y + pose.rect.height) - Math.min(source.y, pose.rect.y)
        } : source;
        if (doc.body.dataset.host === 'desktop') doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-motion', {
            detail: {
                target: { x: target.x, y: target.y, width: target.width, height: target.height },
                source: reservation ? { x: reservation.x, y: reservation.y, width: reservation.width, height: reservation.height } : null,
                duration, id
            }
        }));
        const timing = { duration, easing: 'linear', fill: 'both' };
        const glass = material.animate(samples.map(sample => {
            const sx = (target.width - 2 * sample.ix) / target.width, sy = (target.height - 2 * sample.iy) / target.height;
            return { offset: sample.offset, transform: `translate(${sample.x + sample.ix}px,${sample.y + sample.iy}px) scale(${sx},${sy})`, borderRadius: `${sample.radius / sx}px / ${sample.radius / sy}px`, opacity: sample.opacity };
        }), timing);
        const shape = element.animate(samples.map(sample => ({ offset: sample.offset, transform: `translate(${sample.x}px,${sample.y}px)`, clipPath: `inset(${sample.iy}px ${sample.ix}px round ${sample.radius}px)`, opacity: sample.opacity })), timing);
        const contents = [...element.children].map((child, index) => child.animate([{ opacity: pose?.contents[index]?.opacity ?? (closing ? 1 : 0), transform: pose?.contents[index]?.transform || `translateY(${closing ? 0 : 5}px)` }, { opacity: closing ? 0 : 1, transform: `translateY(${closing ? -2 : 0}px)` }], { duration: closing ? 100 : 190, delay: closing || pose ? 0 : 75, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' }));
        const running = { id, material, animations: [glass, shape, ...contents] };
        motions.set(element, running);
        return shape.finished.catch(() => {}).then(() => { if (!closing && motions.get(element) === running) clearMotion(element); });
    }
    function popupContent(group) {
        return `<header class="space-popup-head"><div><strong>${escape(group.name)}</strong><small>${group.files.length} 个项目</small></div><button type="button" class="space-popup-close" data-space-close aria-label="收起">×</button></header>${gridMarkup(group)}<footer class="space-popup-footer">${group.files.length} 个项目 · 双击打开 · 拖动调整顺序</footer>`;
    }
    function openPopup(key, trigger) {
        const group = groupByKey(key);
        if (!group) return;
        // Read the old paint before replacing content or changing its layout box.
        const pose = motionPose(popup, true);
        clearMotion(popup);
        closingToken++;
        activeGroup = key;
        origin = trigger.closest('.space-block')?.querySelector('.space-folder-shell') || trigger;
        const anchor = origin.getBoundingClientRect(), bounds = root.getBoundingClientRect();
        const desktop = doc.body.dataset.host === 'desktop';
        const width = Math.min(desktop ? 360 : 330, bounds.width - 24);
        popup.style.width = `${width}px`;
        const left = anchor.x - bounds.x - width - 18, right = anchor.x - bounds.x + anchor.width + 18;
        // Keep the cabinet visible beside its contents, as in the desktop demo.
        // Narrow work areas fall back to a bounded centre placement.
        const horizontal = desktop && left >= 24 ? left : desktop && right + width <= bounds.width - 24 ? right
            : Math.min(bounds.width - width - 12, Math.max(12, anchor.x - bounds.x + anchor.width / 2 - width / 2));
        popup.style.left = `${horizontal}px`;
        const height = Math.min(bounds.height - (desktop ? 120 : 24), desktop ? 540 : Infinity, Math.max(204, 93 + Math.ceil(group.files.length / 3) * 86));
        popup.style.top = desktop ? `${Math.min(bounds.height - height - 94, Math.max(24, anchor.y - bounds.y + anchor.height / 2 - height / 2))}px` : '12px';
        popup.style.height = `${height}px`;
        if (popup.dataset.contentGroup !== key || popup.hidden) popup.innerHTML = popupContent(group);
        popup.dataset.contentGroup = key;
        popup.hidden = false;
        popup.style.pointerEvents = '';
        root.querySelectorAll('.space-block').forEach(block => block.classList.toggle('is-open', block.dataset.spaceGroup === key));
        root.querySelectorAll('[data-space-open]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.spaceOpen === key)));
        hydrate(popup);
        animateSurface(popup, origin, false, pose);
        interaction();
    }
    function closePopup(immediate = false) {
        if (popup.hidden) return;
        const token = ++closingToken;
        activeGroup = '';
        popup.style.pointerEvents = 'none';
        root.querySelectorAll('.space-block').forEach(block => block.classList.remove('is-open'));
        root.querySelectorAll('[data-space-open]').forEach(button => button.setAttribute('aria-expanded', 'false'));
        const finish = () => { if (token !== closingToken) return; popup.hidden = true; clearMotion(popup); popup.style.pointerEvents = ''; interaction(); };
        if (immediate) finish();
        else animateSurface(popup, origin, true).then(finish);
    }
    function openDrawer(key = drawerGroup, trigger = handle) {
        const group = groupByKey(key) || groups[0];
        if (!group) return;
        const opening = drawer.hidden || !drawerOpen;
        const pose = opening ? motionPose(drawer, true) : null;
        if (opening) clearMotion(drawer);
        drawerGroup = group.key;
        drawerOpen = true;
        closingToken++;
        drawer.innerHTML = `<header class="space-popup-head"><div><strong>我的桌面</strong><small>${allFiles().length} 个项目，按分类收纳</small></div><button type="button" class="space-popup-close" data-space-close aria-label="收起抽屉">×</button></header><nav class="space-drawer-tabs" aria-label="收纳分类">${groups.map(item => `<button type="button" data-space-tab="${escapeAttribute(item.key)}" aria-selected="${item.key === drawerGroup}">${escape(item.name)}</button>`).join('')}</nav>${gridMarkup(group)}<footer class="space-popup-footer">${group.files.length} 个项目 · 双击打开 · 拖动调整顺序</footer>`;
        drawer.hidden = false;
        drawer.style.pointerEvents = '';
        handle.setAttribute('aria-expanded', 'true');
        hydrate(drawer);
        if (opening) animateSurface(drawer, trigger, false, pose);
        interaction();
    }
    function closeDrawer(immediate = false) {
        if (drawer.hidden) return;
        const token = ++closingToken;
        drawerOpen = false;
        drawer.style.pointerEvents = 'none';
        handle.setAttribute('aria-expanded', 'false');
        const finish = () => { if (token !== closingToken) return; drawer.hidden = true; clearMotion(drawer); drawer.style.pointerEvents = ''; interaction(); };
        if (immediate) finish();
        else animateSurface(drawer, handle, true).then(finish);
    }
    function hideContext() { context.hidden = true; contextKey = ''; interaction(); }
    function showBlockContext(event, block) {
        event.preventDefault();
        event.stopPropagation();
        const bounds = root.getBoundingClientRect(), rect = block.getBoundingClientRect();
        contextKey = block.dataset.spaceGroup;
        context.innerHTML = '<button type="button" role="menuitem" data-space-edit><i class="ri-edit-line"></i>编辑收纳块</button>';
        context.hidden = false;
        context.style.left = `${Math.max(8, Math.min(bounds.width - 158, (event.clientX || rect.x + rect.width / 2) - bounds.x))}px`;
        context.style.top = `${Math.max(8, Math.min(bounds.height - 52, (event.clientY || rect.y + rect.height / 2) - bounds.y))}px`;
        context.querySelector('button').focus({ preventScroll: true });
        interaction();
    }
    function renderEditorPreview() {
        const group = groupByKey(editorDraft?.key);
        if (!group) return;
        const target = overlay.querySelector('.space-editor-preview');
        target.innerHTML = `<div class="space-folder-shell"><span class="space-folder-surface"></span>${faceMarkup(group, editorDraft.size)}</div><strong>${escape(editorDraft.name.trim() || '未命名收纳块')}</strong>`;
        overlay.querySelectorAll('[data-space-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.spaceSize === editorDraft.size)));
        overlay.querySelector('.space-editor-note').textContent = TYPE_NOTES[editorDraft.size];
        hydrate(target);
    }
    function openEditor(key, trigger) {
        const group = groupByKey(key);
        if (!group) return;
        editorToken++;
        returnFocus = trigger;
        editorDraft = { key, name: group.name, size: group.size };
        hideContext();
        closePopup(true);
        shelf?.close();
        overlay.innerHTML = `<form class="space-editor" role="dialog" aria-modal="true" aria-labelledby="spaceEditorTitle"><header class="space-editor-head"><strong id="spaceEditorTitle">编辑收纳块</strong><button type="button" class="space-popup-close" data-space-editor-cancel aria-label="取消编辑">×</button></header><div class="space-editor-body"><div class="space-editor-preview" aria-label="实际图标布局预览"></div><div class="space-editor-fields"><label for="spaceEditorName">名称</label><input id="spaceEditorName" name="name" maxlength="40" required value="${escapeAttribute(group.name)}" autocomplete="off"><label>内部图标布局</label><div class="space-size-picker">${Object.entries(TYPES).map(([size, name]) => `<button type="button" data-space-size="${size}" aria-pressed="${size === group.size}">${name}</button>`).join('')}</div><p class="space-editor-note"></p></div></div><footer class="space-editor-actions"><button type="button" data-space-editor-cancel>取消</button><button type="submit">保存</button></footer></form>`;
        overlay.hidden = false;
        overlay.style.pointerEvents = '';
        renderEditorPreview();
        animateSurface(overlay.querySelector('.space-editor'), trigger);
        const input = overlay.querySelector('input');
        input.focus({ preventScroll: true });
        input.select();
        interaction();
    }
    function closeEditor(immediate = false) {
        if (!editorDraft) return;
        const token = ++editorToken;
        editorDraft = null;
        overlay.style.pointerEvents = 'none';
        const finish = () => {
            if (token !== editorToken) return;
            clearMotion(overlay.querySelector('.space-editor'));
            overlay.hidden = true;
            overlay.replaceChildren();
            overlay.style.pointerEvents = '';
            returnFocus?.isConnected && returnFocus.focus({ preventScroll: true });
            interaction();
        };
        if (immediate) finish();
        else animateSurface(overlay.querySelector('.space-editor'), returnFocus, true).then(finish);
    }
    function selectItem(item) {
        const file = fileById(item.dataset.spaceId);
        if (!file) return;
        root.querySelectorAll('.space-file.selected').forEach(other => other.classList.remove('selected'));
        item.classList.add('selected');
        onSelect?.(item, file);
    }
    function updateCounts() {
        shelf?.syncCounts(groups);
        root.querySelectorAll('[data-space-count]').forEach(target => { target.textContent = `${groupByKey(target.dataset.spaceCount)?.files.length || 0} 个项目`; });
        const current = groupByKey(options.layout === 'drawer' ? drawerGroup : activeGroup);
        const surface = options.layout === 'drawer' ? drawer : popup;
        if (current && !surface.hidden) {
            const count = surface.querySelector('.space-popup-head small');
            if (count && options.layout !== 'drawer') count.textContent = `${current.files.length} 个项目`;
            surface.querySelector('.space-popup-footer').textContent = `${current.files.length} 个项目 · 双击打开 · 拖动调整顺序`;
        }
    }
    function gridRects(grid) {
        return new Map([...grid?.querySelectorAll('[data-space-id]') || []].filter(item => !item.classList.contains('is-drag-source')).map(item => [item, item.getBoundingClientRect()]));
    }
    function animateGrid(grid, previous) {
        if (reduced()) return;
        grid?.querySelectorAll('[data-space-id]').forEach(item => {
            if (item.classList.contains('is-drag-source')) return;
            const before = previous.get(item);
            if (!before) return;
            const after = item.getBoundingClientRect();
            const x = before.x - after.x, y = before.y - after.y;
            item._spaceReorder?.cancel();
            if (Math.abs(x) + Math.abs(y) < 1) return;
            item._spaceReorder = item.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 200, easing: 'cubic-bezier(.2,.65,.25,1)' });
        });
    }
    function clearPreview() {
        drag?.placeholder.remove();
        if (drag?.grid) {
            const empty = drag.grid.querySelector('.space-empty');
            if (empty) empty.hidden = false;
        }
        root.querySelectorAll('.is-drop-target').forEach(target => target.classList.remove('is-drop-target'));
        if (drag) { drag.grid = null; drag.target = ''; drag.beforeId = null; }
    }
    function insertionId(grid, x, y) {
        const placeholderRect = drag.placeholder.isConnected ? drag.placeholder.getBoundingClientRect() : null;
        if (drag.grid === grid && placeholderRect && x >= placeholderRect.left && x <= placeholderRect.right && y >= placeholderRect.top && y <= placeholderRect.bottom) return drag.beforeId;
        const items = [...grid.querySelectorAll('[data-space-id]')].filter(item => item.dataset.spaceId !== drag.id);
        if (!items.length) return null;
        const bounds = grid.getBoundingClientRect(), style = win.getComputedStyle(grid);
        const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length;
        const width = items[0].offsetWidth, height = items[0].offsetHeight;
        const gapX = parseFloat(style.columnGap) || 0, gapY = parseFloat(style.rowGap) || 0;
        const col = Math.min(columns - 1, Math.max(0, Math.floor((x - bounds.x - (parseFloat(style.paddingLeft) || 0) + grid.scrollLeft) / (width + gapX))));
        const row = Math.max(0, Math.floor((y - bounds.y - (parseFloat(style.paddingTop) || 0) + grid.scrollTop) / (height + gapY)));
        return items[Math.min(items.length, row * columns + col)]?.dataset.spaceId || null;
    }
    function previewDrop(grid, x, y) {
        if (!drag || drag.pending) return;
        const beforeId = insertionId(grid, x, y);
        drag.x = x; drag.y = y;
        if (drag.grid === grid && drag.beforeId === beforeId) return;
        const oldGrid = drag.grid, oldRects = gridRects(oldGrid), nextRects = gridRects(grid);
        clearPreview();
        drag.grid = grid; drag.target = grid.dataset.spaceDrop; drag.beforeId = beforeId;
        const before = [...grid.querySelectorAll('[data-space-id]')].find(item => item.dataset.spaceId === beforeId);
        grid.querySelector('.space-empty')?.setAttribute('hidden', '');
        grid.insertBefore(drag.placeholder, before || null);
        grid.closest('.space-zone,.space-popup,.space-drawer')?.classList.add('is-drop-target');
        if (oldGrid && oldGrid !== grid) animateGrid(oldGrid, oldRects);
        animateGrid(grid, nextRects);
    }
    function dragScroll() {
        if (!drag || drag.pending) return;
        const grid = drag.grid;
        if (grid?.isConnected && grid.scrollHeight > grid.clientHeight) {
            const bounds = grid.getBoundingClientRect();
            if (drag.x >= bounds.left && drag.x <= bounds.right) {
                const speed = drag.y < bounds.top + 25 ? -Math.min(8, (bounds.top + 25 - drag.y) / 3) : drag.y > bounds.bottom - 25 ? Math.min(8, (drag.y - bounds.bottom + 25) / 3) : 0;
                if (speed) { const before = grid.scrollTop; grid.scrollTop += speed; if (before !== grid.scrollTop) previewDrop(grid, drag.x, drag.y); }
            }
        }
        scrollFrame = win.requestAnimationFrame(dragScroll);
    }
    function finishDrag() {
        if (!drag) return;
        clearPreview();
        drag.source.classList.remove('is-drag-source');
        drag.source.style.opacity = '';
        win.cancelAnimationFrame(scrollFrame);
        drag = null;
        root.classList.remove('space-dragging');
        interaction();
        if (deferredRender) { deferredRender = false; render(options); }
    }
    async function commitDrop(event) {
        if (!drag || drag.pending) return;
        const target = event.target.closest('[data-space-drop]');
        if (!target) { finishDrag(); return; }
        event.preventDefault();
        event.stopPropagation();
        const session = drag;
        const key = session.target || target.dataset.spaceDrop;
        const group = groupByKey(key), file = fileById(session.id);
        if (!group || !file) { finishDrag(); return; }
        session.pending = true;
        win.cancelAnimationFrame(scrollFrame);
        const next = updateSpaceOrder(preferences, groups, session.id, key, session.beforeId);
        try {
            if (key !== session.sourceGroup) {
                if (!onAssign) throw new Error('当前不能移动分类');
                await onAssign(file, key);
            }
            if (destroyed || drag !== session) return;
            preferences = next;
            save();
            groups = createSpaceGroups(state, preferences);
            // Keep neighbors and their in-flight animations. Replace only the reserved slot.
            if (session.grid && session.placeholder.isConnected) {
                session.placeholder.replaceWith(session.source);
                session.source.classList.remove('is-drag-source');
                session.source.style.opacity = '';
                session.source.classList.add('selected');
                session.grid.querySelector('.space-empty')?.remove();
                if (!session.sourceGrid.querySelector('[data-space-id]')) session.sourceGrid.innerHTML = '<div class="space-empty">拖入项目，收进这里</div>';
                updateCounts();
                root.querySelectorAll('.space-block').forEach(block => {
                    const current = groupByKey(block.dataset.spaceGroup);
                    if (current) block.querySelector('.space-face').outerHTML = faceMarkup(current);
                });
                hydrate(root);
                signature = modelSignature();
            } else { signature = ''; deferredRender = true; }
            onSelect?.(session.source, file);
        } catch (error) { onError?.(error); }
        finishDrag();
    }
    function modelSignature() { return JSON.stringify(groups.map(group => [group.key, group.name, group.size, group.files.map(file => [spaceFileId(file), file.name, file.icon])])) + options.layout; }
    function render(next = {}) {
        if (destroyed) return;
        const priorLayout = options.layout;
        options = { ...options, ...next };
        if (!['shelf', 'islands', 'drawer', 'zones'].includes(options.layout)) options.layout = 'shelf';
        if (!['warm', 'liquid'].includes(options.appearance)) options.appearance = 'warm';
        root.dataset.appearance = options.appearance;
        root.dataset.layout = options.layout;
        root.dataset.reducedMotion = String(!!options.reducedMotion);
        if (reduced()) motions.forEach((_, element) => clearMotion(element));
        if (drag) { deferredRender = true; return; }
        groups = createSpaceGroups(state, preferences);
        if (options.layout === 'shelf') {
            // A group remains a drop destination after its last file moves out.
            let changed = false;
            for (const group of groups) if (!preferences.groups[group.key]) { preferences.groups[group.key] = { size: group.size }; changed = true; }
            if (changed) save();
        }
        const nextSignature = modelSignature();
        if (priorLayout !== options.layout) { closePopup(true); closeDrawer(true); hideContext(); closeEditor(true); }
        if (nextSignature === signature) { if (options.layout === 'shelf') shelf.restorePinned(); return; }
        signature = nextSignature;
        renderStage();
        if (activeGroup && options.layout === 'islands' && !popup.hidden) {
            const group = groupByKey(activeGroup);
            if (group) { const scroll = popup.querySelector('.space-file-grid')?.scrollTop || 0; popup.innerHTML = popupContent(group); popup.querySelector('.space-file-grid').scrollTop = scroll; hydrate(popup); }
            else closePopup(true);
        }
        if (drawerOpen && options.layout === 'drawer') openDrawer(drawerGroup);
    }
    function close() { finishDrag(); closePopup(true); closeDrawer(true); hideContext(); closeEditor(true); shelf?.close(); }
    shelf = createShelfView({ root, stage, storage, gridMarkup, iconMarkup, faceMarkup, hydrate, animateSurface, clearMotion, motionPose,
        onEdit: openEditor, onError, onInteraction: moving => {
            doc.dispatchEvent(new win.CustomEvent('dtkit:desktop-space-drag', { detail: moving })); interaction();
        } });
    const listen = (target, event, callback, capture = false) => target.addEventListener(event, callback, { signal: abort.signal, capture });
    listen(root, 'click', event => {
        const edit = event.target.closest('[data-space-edit]');
        if (edit) { const key = contextKey; const block = [...root.querySelectorAll('[data-space-group]')].find(item => item.dataset.spaceGroup === key); openEditor(key, block); return; }
        if (event.target.closest('[data-space-editor-cancel]')) { closeEditor(); return; }
        const size = event.target.closest('[data-space-size]');
        if (size && editorDraft) { editorDraft.size = size.dataset.spaceSize; renderEditorPreview(); return; }
        if (event.target.closest('[data-space-close]')) { if (options.layout === 'drawer') closeDrawer(); else closePopup(); return; }
        const tab = event.target.closest('[data-space-tab]');
        if (tab) { openDrawer(tab.dataset.spaceTab); return; }
        const drawerTrigger = event.target.closest('[data-space-drawer-open]');
        if (drawerTrigger) { openDrawer(drawerTrigger.dataset.spaceDrawerOpen, drawerTrigger); return; }
        if (event.target.closest('.space-drawer-handle')) { drawerOpen ? closeDrawer() : openDrawer(); return; }
        const trigger = event.target.closest('[data-space-open]');
        if (trigger) { activeGroup === trigger.dataset.spaceOpen ? closePopup() : openPopup(trigger.dataset.spaceOpen, trigger); return; }
        const item = event.target.closest('.space-file[data-space-id]');
        if (item) { selectItem(item); return; }
        if (event.target === overlay) closeEditor();
        else if (!event.target.closest('.space-context')) hideContext();
        if ((event.target === stage || event.target.closest('.space-islands') === event.target) && !popup.hidden) closePopup();
    });
    listen(root, 'dblclick', event => { const item = event.target.closest('.space-file[data-space-id]'); if (item) { event.stopPropagation(); const file = fileById(item.dataset.spaceId); if (file) onOpen?.(file, item); } });
    listen(root, 'focusin', event => { const item = event.target.closest('.space-file[data-space-id]'); if (item) selectItem(item); });
    listen(root, 'contextmenu', event => {
        const item = event.target.closest('.space-file[data-space-id]');
        if (item) { event.preventDefault(); event.stopPropagation(); hideContext(); selectItem(item); onContextMenu?.(event, item, fileById(item.dataset.spaceId)); return; }
        const block = event.target.closest('[data-space-group]');
        if (block) showBlockContext(event, block);
    });
    listen(root, 'input', event => { if (editorDraft && event.target.matches('#spaceEditorName')) { editorDraft.name = event.target.value; event.target.setCustomValidity(''); renderEditorPreview(); } });
    listen(root, 'submit', event => {
        if (!event.target.matches('.space-editor') || !editorDraft) return;
        event.preventDefault();
        const name = editorDraft.name.trim();
        if (!name) { const input = overlay.querySelector('input'); input.setCustomValidity('请输入名称'); input.reportValidity(); return; }
        preferences.groups[editorDraft.key] = { name, size: editorDraft.size };
        save();
        closeEditor(true);
        signature = '';
        render(options);
    });
    listen(root, 'keydown', event => {
        if (editorDraft) {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeEditor(); }
            else if (event.key === 'Tab') {
                const targets = [...overlay.querySelectorAll('button,input')].filter(item => !item.disabled);
                const first = targets[0], last = targets.at(-1);
                if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
                else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
            }
            event.stopPropagation();
            return;
        }
        if (event.key === 'Escape' && (drag || !popup.hidden || !drawer.hidden || !context.hidden)) { event.preventDefault(); event.stopPropagation(); finishDrag(); closePopup(); closeDrawer(); hideContext(); return; }
        const item = event.target.closest('.space-file[data-space-id]');
        if (item && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onOpen?.(fileById(item.dataset.spaceId), item); return; }
        if (item && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const grid = item.closest('.space-file-grid'), items = [...grid.querySelectorAll('[data-space-id]')];
            const index = items.indexOf(item), columns = win.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]);
            const target = items[Math.max(0,Math.min(items.length - 1,next))];
            target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        } else if (event.key === 'Enter' && event.target.matches('.space-block')) { event.preventDefault(); event.stopPropagation(); openPopup(event.target.dataset.spaceGroup, event.target); }
    });
    listen(root, 'pointerover', event => {
        const block = event.target.closest('.space-block');
        if (!block || block.contains(event.relatedTarget) || drag) return;
        block.classList.add('is-hovered');
    });
    listen(root, 'pointerout', event => { const block = event.target.closest('.space-block'); if (block && !block.contains(event.relatedTarget)) block.classList.remove('is-hovered'); });
    listen(root, 'dragstart', event => {
        const source = event.target.closest('.space-file[data-space-id]');
        if (!source || !event.dataTransfer) return;
        finishDrag();
        const file = fileById(source.dataset.spaceId);
        if (!file) return;
        selectItem(source);
        const placeholder = doc.createElement('div');
        placeholder.className = 'space-file file-item space-drop-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.innerHTML = `${iconMarkup(file)}<span class="file-name">放在这里</span>`;
        const sourceGrid = source.closest('.space-file-grid');
        drag = { id: source.dataset.spaceId, source, sourceGrid, sourceGroup: sourceGrid.dataset.spaceDrop, placeholder, grid: null, target: '', beforeId: null, x: event.clientX, y: event.clientY, pending: false };
        event.dataTransfer.setData('text/plain', drag.id);
        event.dataTransfer.effectAllowed = 'move';
        source.style.opacity = '.3';
        root.classList.add('space-dragging');
        root.querySelectorAll('.is-hovered').forEach(block => block.classList.remove('is-hovered'));
        win.requestAnimationFrame(() => { if (drag?.source === source) source.classList.add('is-drag-source'); });
        scrollFrame = win.requestAnimationFrame(dragScroll);
        interaction();
    });
    listen(root, 'dragover', event => {
        if (!drag || drag.pending) return;
        const target = event.target.closest('[data-space-drop]');
        if (!target) { clearPreview(); return; }
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        const grid = target.matches('.space-file-grid') ? target : target.matches('.space-zone') ? target.querySelector('.space-file-grid') : null;
        if (grid) previewDrop(grid, event.clientX, event.clientY);
        else { clearPreview(); drag.target = target.dataset.spaceDrop; target.classList.add('is-drop-target'); }
    });
    listen(root, 'dragenter', event => { if (drag && !drag.pending && event.target.closest('[data-space-drop]')) { event.preventDefault(); event.stopPropagation(); } });
    listen(root, 'drop', event => { void commitDrop(event); });
    listen(root, 'dragend', () => { if (!drag?.pending) finishDrag(); });
    listen(doc, 'pointerdown', event => {
        if (!root.contains(event.target)) hideContext();
        if (editorDraft || drag || event.target.closest('.space-context,.context-menu,.rename-dialog,.space-overlay')) return;
        if (!event.target.closest('.space-drawer,.space-drawer-handle,[data-space-drawer-open]')) closeDrawer();
        if (!event.target.closest('.space-popup,.space-block,[data-space-open]')) closePopup();
    }, true);
    return {
        render,
        close,
        cancelGestures() { finishDrag(); shelf.cancelGesture(); },
        closeTransients() { hideContext(); if (!editorDraft) { closePopup(); closeDrawer(); shelf.close(true); } },
        setDisplays(value) { shelf.setDisplays(value); },
        getMetadata: () => normalizeSpacePreferences(preferences),
        migratePath(oldPath, newPath) { preferences = migrateSpaceOrderPath(preferences, oldPath, newPath); save(); signature = ''; },
        reloadMetadata() {
            try { preferences = normalizeSpacePreferences(JSON.parse(storage.getItem(DESKTOP_SPACE_STORAGE_KEY) || '{}')); signature = ''; render(options); } catch (error) { onError?.(error); }
        },
        getGroupDisplay: key => {
            const group = groupByKey(key);
            return group ? { name: group.name, size: group.size, order: group.files.map(spaceFileId) } : null;
        },
        destroy() { close(); destroyed = true; abort.abort(); shelf.destroy(); motions.forEach((_, element) => clearMotion(element)); root.replaceChildren(); }
    };
}
