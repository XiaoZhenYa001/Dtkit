import '../../css/tools/screenshot-annotator.css';
import { registerTool } from '../toolRegistry.js';
import { template } from './template.js';
import { clamp, normalizeRect, objectBounds, hitTestObject, translateObject, resizeObject, sanitizeDocument, History, nextStepNumber, createId, hitTestHandle, selectionHandles, constrainPoint, LIMITS } from './core.js';
import { drawObject, drawSelection, renderDocument } from './renderer.js';
import { storeImage, readImage } from './assets.js';

const invoke = (command, args = {}) => window.__TAURI__?.core?.invoke?.(command, args);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');
const MAX_PIXELS = 32_000_000;
const MODES = new Set(['select', 'pen', 'highlight', 'rect', 'ellipse', 'line', 'arrow', 'text', 'step', 'mosaic', 'redact', 'crop']);
const KEYS = { v: 'select', p: 'pen', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', t: 'text', n: 'step', m: 'mosaic', b: 'redact', c: 'crop' };
let currentView;
const node = (view, id) => view.root.querySelector('#' + id);
const alive = view => currentView === view && !view.controller.signal.aborted;
const clone = value => structuredClone(value);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function status(view, text, tone = 'neutral') {
    if (!alive(view)) return;
    const output = node(view, 'captureStatus'); output.textContent = text; output.dataset.tone = tone;
}

function updateControls(view) {
    if (!alive(view)) return;
    const ready = Boolean(view.image), blocked = view.captureBusy || view.loading;
    view.root.querySelectorAll('[data-action="capture"]').forEach(button => { button.disabled = blocked || !view.nativeReady; });
    view.root.querySelectorAll('[data-action="import"]').forEach(button => { button.disabled = blocked; });
    if (!ready) {
        const loading = node(view, 'captureLoading'); loading.dataset.state = blocked ? 'loading' : 'ready';
        loading.querySelector('strong').textContent = view.captureBusy ? '正在截取屏幕…' : view.loading ? '正在载入图片…' : '清晰表达，从一张截图开始';
        loading.querySelector('span').textContent = view.captureBusy ? '在屏幕上拖动选择范围，Esc 取消。' : view.loading ? '正在准备画布，请稍候。' : '截取屏幕，或拖入一张图片。标记重点，随时分享。';
    }
    for (const id of ['captureSave', 'captureCopy', 'captureOcr', 'captureZoomOut', 'captureZoomIn', 'captureZoomFit', 'captureCanvasTrigger', 'captureClear']) {
        node(view, id).disabled = !ready || blocked || view.outputBusy || (['captureSave', 'captureCopy', 'captureOcr'].includes(id) && view.mode === 'crop') || (id === 'captureOcr' && view.ocrBusy);
    }
    node(view, 'captureUndo').disabled = !ready || blocked || !view.history?.canUndo;
    node(view, 'captureRedo').disabled = !ready || blocked || !view.history?.canRedo;
    node(view, 'captureDelete').disabled = !view.doc.objects.some(object => object.id === view.selectedId) || blocked;
    node(view, 'captureAgain').disabled = view.captureBusy || view.loading || !view.nativeReady;
    node(view, 'captureImport').disabled = blocked;
    node(view, 'captureLong').disabled = blocked || !view.nativeReady;
    node(view, 'captureAgainLabel').textContent = view.captureBusy ? '截图中…' : ready ? '重新截图' : '开始截图';
    node(view, 'captureSelectionActions').hidden = !view.selectedId || view.mode === 'crop';
    node(view, 'captureCropActions').hidden = view.mode !== 'crop' || !ready;
    node(view, 'captureCropApply').disabled = !view.cropDraft || view.cropDraft.width < 2 || view.cropDraft.height < 2;
    node(view, 'captureDimensions').textContent = ready ? `${Math.round(view.doc.crop.width)} × ${Math.round(view.doc.crop.height)} px · ${view.doc.objects.length} 个标注` : '截图 · 标注 · 轻松分享';
    node(view, 'captureCornerRadius').value = String(view.doc.cornerRadius);
    node(view, 'captureCornerRadiusValue').textContent = `${view.doc.cornerRadius} px`;
    node(view, 'captureCanvas').dataset.annotationCount = String(view.doc.objects.length);
    node(view, 'captureCanvas').dataset.selectedIndex = String(view.doc.objects.findIndex(object => object.id === view.selectedId));
    node(view, 'captureCanvas').dataset.cornerRadius = String(view.doc.cornerRadius);
    view.root.dataset.busy = String(blocked);
    view.root.querySelectorAll('[data-capture-color]').forEach(button => {
        const selected = button.dataset.captureColor.toLowerCase() === view.color.toLowerCase(); button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
    });
    view.root.querySelectorAll('[data-shape-style]').forEach(button => {
        const selected = button.dataset.shapeStyle === view.fill; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
    });
}

function visibleRect(view) {
    return view.mode === 'crop' ? { x: 0, y: 0, width: view.image.width, height: view.image.height } : view.doc.crop;
}

function renderBase(view) {
    if (!alive(view) || !view.image) return;
    const crop = visibleRect(view), canvas = node(view, 'captureCanvas'), overlay = node(view, 'captureOverlay');
    if (canvas.width !== crop.width || canvas.height !== crop.height) {
        canvas.width = crop.width; canvas.height = crop.height; overlay.width = crop.width; overlay.height = crop.height;
    }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    if (view.mode !== 'crop') { context.beginPath(); context.roundRect(0, 0, crop.width, crop.height, Math.min(view.doc.cornerRadius, crop.width / 2, crop.height / 2)); context.clip(); }
    context.translate(-crop.x, -crop.y); context.drawImage(view.image, 0, 0);
    for (const object of view.doc.objects) {
        if (object.id === view.textEdit?.id || object.id === view.drag?.object?.id) continue;
        drawObject(context, object, view.image);
    }
    context.restore();
    renderOverlay(view); updateControls(view);
}

function renderOverlay(view) {
    view.renderFrame = 0;
    if (!alive(view) || !view.image) return;
    const canvas = node(view, 'captureOverlay'), ctx = canvas.getContext('2d'), crop = visibleRect(view);
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save(); ctx.translate(-crop.x, -crop.y);
    if (view.active) drawObject(ctx, view.active, view.image, node(view, 'captureCanvas'));
    if (view.mode === 'crop') {
        const selection = view.cropDraft || view.doc.crop;
        ctx.fillStyle = 'rgba(9,15,25,.57)'; ctx.beginPath();
        ctx.rect(0, 0, view.image.width, view.image.height); ctx.rect(selection.x, selection.y, selection.width, selection.height); ctx.fill('evenodd');
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / view.zoom; ctx.setLineDash([5 / view.zoom, 4 / view.zoom]); ctx.strokeRect(selection.x, selection.y, selection.width, selection.height); ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,.24)'; ctx.lineWidth = 1 / view.zoom;
        for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(selection.x + selection.width * i / 3, selection.y); ctx.lineTo(selection.x + selection.width * i / 3, selection.y + selection.height); ctx.moveTo(selection.x, selection.y + selection.height * i / 3); ctx.lineTo(selection.x + selection.width, selection.y + selection.height * i / 3); ctx.stroke(); }
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1677ff'; ctx.lineWidth = 1 / view.zoom;
        const handleSize = 8 / view.zoom;
        for (const handle of selectionHandles(selection)) { ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize); ctx.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize); }
        node(view, 'captureCropSize').textContent = `${Math.round(selection.width)} × ${Math.round(selection.height)} px`;
    } else {
        const selected = view.active?.id === view.selectedId ? view.active : view.doc.objects.find(object => object.id === view.selectedId);
        if (selected && !view.textEdit) drawSelection(ctx, selected, { zoom: view.zoom });
    }
    ctx.restore();
}

function scheduleOverlay(view) {
    if (!view.renderFrame) view.renderFrame = requestAnimationFrame(() => renderOverlay(view));
}

function applyZoom(view) {
    if (!alive(view) || !view.image) return;
    const crop = visibleRect(view), viewport = node(view, 'captureViewport');
    viewport.style.width = `${crop.width * view.zoom}px`; viewport.style.height = `${crop.height * view.zoom}px`;
    node(view, 'captureZoomValue').textContent = `${Math.round(view.zoom * 100)}%`;
    renderOverlay(view);
    if (view.textEdit) positionText(view);
}

function fitZoom(view, animate = false) {
    if (!view.image) return;
    cancelAnimationFrame(view.zoomFrame); view.zoomFrame = 0; view.zoomMode = 'fit';
    const stage = node(view, 'captureStage'), crop = visibleRect(view);
    const target = clamp(Math.min(1, (stage.clientWidth - 96) / crop.width, (stage.clientHeight - 96) / crop.height), .05, 4);
    if (animate) { changeZoom(view, target); view.zoomMode = 'fit'; return; }
    view.zoom = target;
    applyZoom(view);
}

function changeZoom(view, target, anchor) {
    if (!view.image || view.captureBusy) return;
    cancelAnimationFrame(view.zoomFrame); view.zoomFrame = 0; view.zoomMode = 'manual';
    const stage = node(view, 'captureStage'), rect = stage.getBoundingClientRect();
    const anchorX = anchor?.clientX ?? rect.left + stage.clientWidth / 2, anchorY = anchor?.clientY ?? rect.top + stage.clientHeight / 2;
    const before = node(view, 'captureViewport').getBoundingClientRect();
    const imageX = (anchorX - before.left) / view.zoom, imageY = (anchorY - before.top) / view.zoom;
    const from = view.zoom, to = clamp(target, .05, 4), start = performance.now();
    const tick = now => {
        if (!alive(view)) return;
        const t = reducedMotion() || anchor ? 1 : Math.min(1, (now - start) / 160);
        view.zoom = from + (to - from) * (1 - Math.pow(1 - t, 3)); applyZoom(view);
        const after = node(view, 'captureViewport').getBoundingClientRect();
        stage.scrollLeft += after.left + imageX * view.zoom - anchorX; stage.scrollTop += after.top + imageY * view.zoom - anchorY;
        view.zoomFrame = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    tick(start);
}

function canvasPoint(view, event) {
    const rect = node(view, 'captureOverlay').getBoundingClientRect(), crop = visibleRect(view);
    return { x: clamp((event.clientX - rect.left) / view.zoom + crop.x, crop.x, crop.x + crop.width), y: clamp((event.clientY - rect.top) / view.zoom + crop.y, crop.y, crop.y + crop.height) };
}

function commit(view, document, message) {
    view.doc = sanitizeDocument(document, view.image.width, view.image.height);
    view.history.push(view.doc); view.active = null; view.drag = null;
    if (!view.doc.objects.some(object => object.id === view.selectedId)) view.selectedId = null;
    renderBase(view); if (message) status(view, message);
}

function addObject(view, object) {
    if (view.doc.objects.length >= LIMITS.objects) { status(view, '标注数量已达上限，请先删除部分标注', 'warning'); renderBase(view); return; }
    if (object.type === 'pen' && view.doc.objects.reduce((total, item) => total + (item.points?.length || 0), 0) >= LIMITS.points) { status(view, '笔迹已达上限，请先删除部分笔迹', 'warning'); renderBase(view); return; }
    view.selectedId = object.id; commit(view, { ...view.doc, objects: [...view.doc.objects, object] });
}

function selectMode(view, mode) {
    if (!MODES.has(mode)) return;
    commitInlineText(view); const changedCrop = (view.mode === 'crop') !== (mode === 'crop');
    view.mode = mode; view.active = null; view.drag = null; view.cropDraft = mode === 'crop' && view.image ? clone(view.doc.crop) : null;
    view.root.querySelectorAll('[data-capture-mode]').forEach(button => {
        const selected = button.dataset.captureMode === mode; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
    });
    node(view, 'captureCanvas').dataset.mode = mode; node(view, 'captureOverlay').dataset.mode = mode;
    node(view, 'captureOverlay').style.cursor = '';
    view.root.dataset.mode = mode;
    node(view, 'captureBrushCursor').hidden = true;
    if (mode !== 'select') view.selectedId = null;
    if (view.image) { renderBase(view); if (changedCrop) fitZoom(view); } else updateControls(view);
    if (mode === 'crop') status(view, '拖动框选，选区内移动或拖动手柄调整；Enter 应用，Esc 取消。');
}

const resizeCursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
function cropHit(view, point) {
    const rect = view.cropDraft;
    if (!rect || rect.width < 2 || rect.height < 2) return null;
    const handle = hitTestHandle(rect, point, { zoom: view.zoom });
    if (handle) return handle;
    const full = rect.x === 0 && rect.y === 0 && rect.width === view.image.width && rect.height === view.image.height;
    return !full && point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height ? 'move' : null;
}

function pointerDown(view, event) {
    if (!view.image || event.button !== 0 || view.captureBusy || view.pan || view.spacePressed || event.ctrlKey) return;
    commitInlineText(view); cancelAnimationFrame(view.zoomFrame); view.zoomFrame = 0;
    const point = canvasPoint(view, event), selected = view.doc.objects.find(object => object.id === view.selectedId);
    if (view.mode === 'select') {
        const handle = selected && hitTestHandle(selected, point, { zoom: view.zoom });
        const object = handle ? selected : [...view.doc.objects].reverse().find(item => hitTestObject(item, point, 7 / view.zoom));
        view.selectedId = object?.id || null;
        if (object) {
            view.color = object.color; view.size = clamp(object.size, 2, 40); view.fill = object.fill ? 'fill' : 'outline';
            node(view, 'captureColor').value = view.color; node(view, 'captureSize').value = String(view.size); node(view, 'captureSizeValue').textContent = view.size + ' px';
            view.root.querySelectorAll('[data-shape-style]').forEach(button => { const selected = button.dataset.shapeStyle === view.fill; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected)); });
        }
        if (object) {
            view.drag = { pointerId: event.pointerId, start: point, object: clone(object), bounds: objectBounds(object), handle: typeof handle === 'string' ? handle : handle?.name };
            view.active = clone(object);
        }
        renderBase(view);
    } else if (view.mode === 'text') {
        event.preventDefault(); const existing = [...view.doc.objects].reverse().find(item => item.type === 'text' && hitTestObject(item, point, 4 / view.zoom));
        startInlineText(view, point, existing); return;
    }
    else if (view.mode === 'step') { addObject(view, { id: createId(), type: 'step', ...point, size: view.size, number: nextStepNumber(view.doc.objects), color: view.color }); return; }
    else {
        view.selectedId = null; view.drag = { pointerId: event.pointerId, start: point };
        if (view.mode === 'crop') {
            view.drag.crop = clone(view.cropDraft);
            view.drag.handle = cropHit(view, point);
            if (!view.drag.handle) view.cropDraft = { ...point, width: 0, height: 0 };
        }
        else view.active = { id: createId(), type: view.mode, color: view.color, size: view.size, fill: view.fill === 'fill', ...point,
            ...(view.mode === 'pen' ? { points: [point] } : ['line', 'arrow'].includes(view.mode) ? { x2: point.x, y2: point.y } : { width: 0, height: 0 }) };
        renderOverlay(view); updateControls(view);
    }
    if (view.drag) { node(view, 'captureOverlay').setPointerCapture(event.pointerId); event.preventDefault(); }
}

function pointerMove(view, event) {
    if (!view.image) return;
    updateBrushCursor(view, event);
    if (view.mode === 'select' && !view.pan && !view.spacePressed) {
        const point = canvasPoint(view, event), selected = view.doc.objects.find(object => object.id === view.selectedId), handle = selected && hitTestHandle(selected, point, { zoom: view.zoom });
        node(view, 'captureOverlay').style.cursor = view.drag ? (resizeCursors[view.drag.handle] || 'grabbing') : resizeCursors[handle] || (view.doc.objects.some(object => hitTestObject(object, point, 7 / view.zoom)) ? 'move' : 'default');
    } else if (view.mode === 'crop' && !view.pan && !view.spacePressed) {
        const hit = view.drag ? view.drag.handle : cropHit(view, canvasPoint(view, event));
        node(view, 'captureOverlay').style.cursor = resizeCursors[hit] || (hit === 'move' ? (view.drag ? 'grabbing' : 'move') : 'crosshair');
    }
    if (!view.drag || event.pointerId !== view.drag.pointerId) return;
    const point = canvasPoint(view, event), drag = view.drag;
    if (view.mode === 'select') {
        if (drag.handle) {
            const bounds = drag.bounds, left = drag.handle.includes('w') ? point.x : bounds.x, top = drag.handle.includes('n') ? point.y : bounds.y;
            let right = drag.handle.includes('e') ? point.x : bounds.x + bounds.width, bottom = drag.handle.includes('s') ? point.y : bounds.y + bounds.height;
            if (event.shiftKey) { const ratio = bounds.width / Math.max(1, bounds.height), width = Math.abs(right - left), height = Math.abs(bottom - top); if (width > height * ratio) bottom = top + width / ratio; else right = left + height * ratio; }
            view.active = resizeObject(drag.object, bounds, normalizeRect({ x: left, y: top }, { x: right, y: bottom }));
        } else view.active = translateObject(drag.object, point.x - drag.start.x, point.y - drag.start.y);
    } else if (view.mode === 'crop') {
        if (drag.handle === 'move') {
            view.cropDraft = { ...drag.crop, x: clamp(drag.crop.x + point.x - drag.start.x, 0, view.image.width - drag.crop.width), y: clamp(drag.crop.y + point.y - drag.start.y, 0, view.image.height - drag.crop.height) };
        } else if (drag.handle) {
            const rect = drag.crop, left = drag.handle.includes('w') ? point.x : rect.x, top = drag.handle.includes('n') ? point.y : rect.y;
            const right = drag.handle.includes('e') ? point.x : rect.x + rect.width, bottom = drag.handle.includes('s') ? point.y : rect.y + rect.height;
            view.cropDraft = normalizeRect({ x: left, y: top }, { x: right, y: bottom });
        } else {
            const dx = point.x - drag.start.x, dy = point.y - drag.start.y, signX = Math.sign(dx || 1), signY = Math.sign(dy || 1);
            const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), signX < 0 ? drag.start.x : view.image.width - drag.start.x, signY < 0 ? drag.start.y : view.image.height - drag.start.y);
            const end = event.shiftKey ? { x: drag.start.x + signX * side, y: drag.start.y + signY * side } : point;
            view.cropDraft = normalizeRect(drag.start, end);
        }
    }
    else if (view.active.type === 'pen') {
        const coalesced = event.getCoalescedEvents?.(), samples = coalesced?.length ? coalesced : [event];
        for (const sample of samples) {
            const next = canvasPoint(view, sample), last = view.active.points.at(-1);
            if (Math.hypot(next.x - last.x, next.y - last.y) >= .5) {
                if (view.active.points.length >= 4000) view.active.points = view.active.points.filter((_, index) => index % 2 === 0);
                view.active.points.push(next);
            }
        }
    } else if (['line', 'arrow'].includes(view.active.type)) {
        const end = event.shiftKey ? constrainPoint(drag.start, point) : point; view.active.x2 = end.x; view.active.y2 = end.y;
    } else Object.assign(view.active, normalizeRect(drag.start, point, event.shiftKey));
    scheduleOverlay(view);
}

function pointerUp(view, event, cancelled = false) {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    if (!cancelled) pointerMove(view, event);
    const active = view.active, drag = view.drag; view.drag = null; view.active = null;
    const overlay = node(view, 'captureOverlay'); if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (cancelled) { if (view.mode === 'crop') view.cropDraft = drag.crop; renderBase(view); return; }
    if (view.mode === 'crop') { updateControls(view); renderOverlay(view); return; }
    if (view.mode === 'select' && active) commit(view, { ...view.doc, objects: view.doc.objects.map(object => object.id === active.id ? active : object) });
    else if (active) {
        const bounds = objectBounds(active);
        if (active.type === 'pen' || Math.max(bounds.width, bounds.height) > 2) addObject(view, active);
        else renderBase(view);
    } else if (drag) renderBase(view);
}

function updateBrushCursor(view, event) {
    const cursor = node(view, 'captureBrushCursor'), visible = view.mode === 'pen' && !view.pan && !view.spacePressed;
    cursor.hidden = !visible;
    if (!visible) return;
    const point = canvasPoint(view, event), crop = visibleRect(view), width = Math.max(4, view.size * view.zoom);
    cursor.style.width = cursor.style.height = width + 'px'; cursor.style.transform = `translate(${(point.x - crop.x) * view.zoom - width / 2}px, ${(point.y - crop.y) * view.zoom - width / 2}px)`;
}

function positionText(view) {
    if (!view.textEdit || !view.image) return;
    const input = node(view, 'captureInlineText'), crop = visibleRect(view), edit = view.textEdit;
    const style = getComputedStyle(input), insetX = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth), insetY = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
    input.style.left = `${(edit.x - crop.x) * view.zoom - insetX}px`; input.style.top = `${(edit.y - crop.y) * view.zoom - insetY}px`;
    input.style.fontSize = `${edit.fontSize * view.zoom}px`; input.style.color = edit.color;
    input.style.width = `${Math.max(100, Math.min((crop.x + crop.width - edit.x) * view.zoom, 480))}px`;
    input.style.height = 'auto'; input.style.height = Math.max(30, input.scrollHeight + input.offsetHeight - input.clientHeight) + 'px';
}

function startInlineText(view, point, existing) {
    commitInlineText(view);
    view.textEdit = existing ? clone(existing) : { id: createId(), type: 'text', ...point, text: '', fontSize: Math.max(16, view.size * 4), size: view.size, color: view.color };
    const input = node(view, 'captureInlineText'); input.value = view.textEdit.text; input.hidden = false;
    view.selectedId = existing?.id || null; renderBase(view); positionText(view); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}

function commitInlineText(view, cancel = false) {
    if (!view.textEdit) return;
    const edit = view.textEdit, input = node(view, 'captureInlineText');
    view.textEdit = null; input.hidden = true;
    if (cancel || !view.image) { renderBase(view); return; }
    const text = input.value.slice(0, 2000), exists = view.doc.objects.some(object => object.id === edit.id);
    if (!text.trim()) { if (exists) commit(view, { ...view.doc, objects: view.doc.objects.filter(object => object.id !== edit.id) }); else renderBase(view); return; }
    const context = node(view, 'captureCanvas').getContext('2d'); context.font = `600 ${edit.fontSize}px system-ui`;
    const object = { ...edit, text, width: Math.max(edit.fontSize, ...text.split('\n').map(line => context.measureText(line).width)), height: text.split('\n').length * edit.fontSize * 1.35 };
    if (exists) { view.selectedId = edit.id; commit(view, { ...view.doc, objects: view.doc.objects.map(item => item.id === edit.id ? object : item) }); }
    else addObject(view, object);
}

function undo(view, redo = false) {
    if (!view.image || view.captureBusy) return;
    commitInlineText(view); const document = redo ? view.history.redo() : view.history.undo(); if (!document) return;
    view.doc = document; view.selectedId = null; view.active = null; view.drag = null; view.cropDraft = view.mode === 'crop' ? clone(view.doc.crop) : null;
    renderBase(view); if (view.zoomMode === 'fit') fitZoom(view); else applyZoom(view); status(view, redo ? '已重做' : '已撤销');
}

function deleteSelected(view) {
    commitInlineText(view); if (!view.selectedId) return;
    commit(view, { ...view.doc, objects: view.doc.objects.filter(object => object.id !== view.selectedId) }, '已删除选中标注，可撤销');
}

function duplicateSelected(view) {
    const object = view.doc.objects.find(item => item.id === view.selectedId); if (!object) return;
    const copy = translateObject(object, 16, 16); copy.id = createId();
    if (copy.type === 'step') copy.number = nextStepNumber(view.doc.objects);
    addObject(view, copy); status(view, '已复制标注');
}

function reorderSelected(view, front) {
    const object = view.doc.objects.find(item => item.id === view.selectedId); if (!object) return;
    const remaining = view.doc.objects.filter(item => item.id !== object.id);
    commit(view, { ...view.doc, objects: front ? [...remaining, object] : [object, ...remaining] }, front ? '已置于顶层' : '已置于底层');
}

function applyProperty(view, patch) {
    view.root.querySelectorAll('[data-capture-color]').forEach(button => { const selected = button.dataset.captureColor.toLowerCase() === view.color.toLowerCase(); button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected)); });
    const object = view.doc.objects.find(item => item.id === view.selectedId);
    if (object && view.mode === 'select') {
        const changed = { ...object, ...patch };
        if (object.type === 'text' && patch.size) {
            changed.fontSize = Math.max(16, patch.size * 4);
            const context = node(view, 'captureCanvas').getContext('2d'); context.font = `600 ${changed.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            changed.width = Math.max(changed.fontSize, ...changed.text.split('\n').map(line => context.measureText(line).width)); changed.height = changed.text.split('\n').length * changed.fontSize * 1.35;
        }
        if (object.type === 'mosaic' && patch.size) changed.pixelSize = clamp(Math.max(8, patch.size * 3), 4, 96);
        view.doc = { ...view.doc, objects: view.doc.objects.map(item => item.id === object.id ? changed : item) }; renderBase(view);
    }
}

function finishProperty(view) { if (view.image) commit(view, view.doc); }

function applyCrop(view, reset = false) {
    if (!view.image) return;
    const crop = reset ? { x: 0, y: 0, width: view.image.width, height: view.image.height } : view.cropDraft;
    if (!crop || crop.width < 2 || crop.height < 2) return;
    commit(view, { ...view.doc, crop }, reset ? '已恢复完整画面' : '裁剪已应用，可撤销'); selectMode(view, 'select'); fitZoom(view);
}

function beginPan(view, event) {
    if (!view.image || !(view.spacePressed || event.ctrlKey || event.button === 1) || event.target.closest('textarea,button,input,select')) return;
    event.preventDefault(); event.stopPropagation();
    view.pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node(view, 'captureStage').scrollLeft, top: node(view, 'captureStage').scrollTop };
    node(view, 'captureStage').setPointerCapture(event.pointerId); node(view, 'captureStage').dataset.panning = 'true';
}

function endPan(view) { view.pan = null; node(view, 'captureStage').dataset.panning = 'false'; }

function releaseBackground(view) {
    if (view.image) { view.image.src = ''; view.image = null; }
    if (view.imageUrl) URL.revokeObjectURL(view.imageUrl); view.imageUrl = null;
}

function decodeImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file), image = new Image();
        image.onload = () => { image.onload = image.onerror = null; resolve({ image, url }); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片，请选择 PNG、JPEG、WebP 或 GIF 图片')); };
        image.src = url;
    });
}

async function loadImage(view, file, options = {}) {
    if (!file || !alive(view) || (view.captureBusy && !options.fromCapture)) return;
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type) || file.size > 50 * 1024 * 1024) { status(view, '请选择小于 50 MB 的 PNG、JPEG、WebP、GIF 或 BMP 图片', 'error'); return; }
    commitInlineText(view); const generation = ++view.captureGeneration; view.loading = true; updateControls(view);
    try {
        const decoded = await decodeImage(file);
        if (!alive(view) || generation !== view.captureGeneration) { decoded.image.src = ''; URL.revokeObjectURL(decoded.url); return; }
        if (decoded.image.width * decoded.image.height > MAX_PIXELS || Math.max(decoded.image.width, decoded.image.height) > 16384) {
            decoded.image.src = ''; URL.revokeObjectURL(decoded.url); throw new Error('图片过大，请使用不超过 3200 万像素、单边不超过 16384 px 的图片');
        }
        releaseBackground(view); view.image = decoded.image; view.imageUrl = decoded.url; view.imageName = file.name || '截图.png'; view.assetId = options.assetId || null;
        view.doc = sanitizeDocument(options.document || {}, view.image.width, view.image.height); view.history = new History(view.doc); view.selectedId = null; view.textEdit = null;
        view.mode = view.mode === 'crop' ? 'select' : view.mode; view.cropDraft = null;
        node(view, 'captureViewport').hidden = false; node(view, 'captureCanvas').hidden = false; node(view, 'captureLoading').hidden = true;
        node(view, 'captureOcrPanel').hidden = true; node(view, 'captureOcrText').value = ''; view.ocrGeneration++;
        selectMode(view, view.mode); fitZoom(view);
        status(view, `${view.imageName} · 可直接标注，或拖入图片替换`);
        view.assetJob = options.assetId ? Promise.resolve() : storeImage(file).then(id => { if (alive(view) && generation === view.captureGeneration) view.assetId = id; }).catch(() => { if (alive(view) && generation === view.captureGeneration) status(view, '图片已打开；本地缓存不可用，关闭页面后需要重新导入', 'warning'); });
        await view.assetJob;
        return true;
    } catch (error) { status(view, String(error.message || error), 'error'); }
    finally { if (alive(view) && generation === view.captureGeneration) { view.loading = false; updateControls(view); } }
}

function cancelCapture(view) {
    const pending = view.pendingCapture;
    if (!pending) return;
    view.pendingCapture = null; view.captureGeneration += 1; view.captureBusy = false; pending.resolve(null);
    void Promise.resolve(invoke('cancel_screen_region_capture', { requestId: pending.requestId })).catch(() => {});
    if (alive(view)) updateControls(view);
}

async function capture(view, options = {}) {
    if (!alive(view) || view.captureBusy || !view.nativeReady) return;
    commitInlineText(view); closeMenus(view); view.captureBusy = true; updateControls(view);
    const generation = view.captureGeneration, requestId = crypto.randomUUID(); view.captureTaskId = requestId;
    const result = new Promise(resolve => { view.pendingCapture = { requestId, resolve }; });
    try {
        const delayMs = Number(node(view, 'captureDelay').value) * 1000;
        status(view, delayMs ? `${delayMs / 1000} 秒后截图，请切换到目标内容…` : '在屏幕上拖动选取区域；Esc 取消');
        await invoke('start_screen_region_capture', { ...options, longMode: options.longMode || 'manual', delayMs, requestId, keepHidden: true });
        const selected = await result;
        if (!alive(view) || generation !== view.captureGeneration) return;
        if (!selected) { status(view, '已取消截图'); return; }
        if (typeof selected.dataUrl !== 'string' || !selected.dataUrl.startsWith('data:image/png;base64,')) throw new Error('截图图像格式无效');
        const bytes = atob(selected.dataUrl.slice('data:image/png;base64,'.length));
        const pixels = new Uint8Array(bytes.length);
        for (let index = 0; index < bytes.length; index++) pixels[index] = bytes.charCodeAt(index);
        if (!alive(view) || generation !== view.captureGeneration) return;
        const loaded = await loadImage(view, new File([pixels], options.longDirection ? '长截图.png' : '截图.png', { type: 'image/png' }), { fromCapture: true });
        if (loaded && typeof selected.warning === 'string' && selected.warning) status(view, selected.warning, 'warning');
    } catch (error) { if (alive(view) && view.captureTaskId === requestId && generation === view.captureGeneration) status(view, `截图失败：${String(error.message || error)}`, 'error'); }
    finally {
        if (view.pendingCapture?.requestId === requestId) { view.pendingCapture.resolve(null); view.pendingCapture = null; }
        if (alive(view) && view.captureTaskId === requestId) { view.captureBusy = false; updateControls(view); }
    }
}

function clearCapture(view) {
    cancelCapture(view); view.captureGeneration += 1; view.ocrGeneration++; commitInlineText(view, true); releaseBackground(view);
    view.doc = { objects: [], crop: { x: 0, y: 0, width: 1, height: 1 }, cornerRadius: 0 }; view.history = new History(view.doc);
    view.assetId = null; view.selectedId = null; view.active = null; view.drag = null; view.cropDraft = null;
    node(view, 'captureViewport').hidden = true; node(view, 'captureLoading').hidden = false; node(view, 'captureOcrPanel').hidden = true;
    for (const id of ['captureCanvas', 'captureOverlay']) { const canvas = node(view, id); canvas.width = canvas.height = 1; }
    updateControls(view); status(view, '画面已清空，可重新截图或导入图片');
}

function exportedCanvas(view, scale = Number(node(view, 'captureExportScale').value) || 1) {
    commitInlineText(view);
    const crop = view.doc.crop;
    if (crop.width * crop.height * scale * scale > MAX_PIXELS || Math.max(crop.width, crop.height) * scale > 16384) throw new Error('导出尺寸过大，请在画面设置中选择 1×，或先裁剪图片');
    const canvas = document.createElement('canvas'); renderDocument(canvas, view.image, view.doc, { scale }); return canvas;
}

function canvasBlob(canvas) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片编码失败')), 'image/png')); }

function download(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function output(view, copy = false) {
    if (!view.image || view.outputBusy || view.captureBusy) return;
    if (view.mode === 'crop') { status(view, '请先应用或取消裁剪，再输出图片', 'warning'); return; }
    view.outputBusy = true; updateControls(view); const generation = view.captureGeneration;
    let canvas;
    try {
        canvas = exportedCanvas(view);
        if (copy) {
            if (window.__TAURI__?.core?.invoke) await invoke('copy_screenshot_to_clipboard', { dataUrl: canvas.toDataURL('image/png') });
            else { if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('当前环境不支持图片复制，请保存 PNG'); const blob = await canvasBlob(canvas); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); }
            if (alive(view) && generation === view.captureGeneration) status(view, '图片已复制，可直接粘贴到聊天或文档', 'success');
        } else {
            const filename = `DtKit-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
            if (window.__TAURI__?.core?.invoke) {
                const path = await invoke('save_annotated_screenshot', { filename, dataUrl: canvas.toDataURL('image/png') });
                if (alive(view) && generation === view.captureGeneration) status(view, `已保存：${path}`, 'success');
            } else { download(await canvasBlob(canvas), filename); status(view, 'PNG 已导出', 'success'); }
        }
    } catch (error) { if (alive(view) && generation === view.captureGeneration) status(view, `${copy ? '复制' : '保存'}失败：${String(error.message || error)}`, 'error'); }
    finally { if (canvas) canvas.width = canvas.height = 1; if (alive(view)) { view.outputBusy = false; updateControls(view); } }
}

async function recognize(view) {
    if (!view.image || view.ocrBusy) return;
    if (!window.__TAURI__?.core?.invoke) { status(view, '本地文字识别需要 Windows 桌面版', 'warning'); return; }
    const job = ++view.ocrGeneration, generation = view.captureGeneration;
    view.ocrBusy = true; updateControls(view); status(view, '正在本地识别画面中的文字…');
    let canvas;
    try {
        canvas = exportedCanvas(view, 1);
        const result = await invoke('recognize_screenshot_text', { dataUrl: canvas.toDataURL('image/png') });
        if (!alive(view) || job !== view.ocrGeneration || generation !== view.captureGeneration) return;
        node(view, 'captureOcrText').value = typeof result === 'string' ? result : result?.text || '';
        node(view, 'captureOcrPanel').hidden = false;
        status(view, node(view, 'captureOcrText').value ? '识别完成，可编辑或复制文字' : '未识别到文字，试试更清晰的截图', node(view, 'captureOcrText').value ? 'success' : 'warning');
    } catch (error) { if (alive(view) && job === view.ocrGeneration) status(view, `识别失败：${String(error.message || error)}`, 'error'); }
    finally { if (canvas) canvas.width = canvas.height = 1; if (alive(view)) { view.ocrBusy = false; updateControls(view); } }
}

function closeMenus(view, except) {
    view.root.querySelectorAll('.capture-tool-menu').forEach(menu => {
        if (menu.id === except) return;
        menu.hidden = true; view.root.querySelector(`[aria-controls="${menu.id}"]`)?.setAttribute('aria-expanded', 'false');
    });
}

function toggleMenu(view, menuId, triggerId) {
    const menu = node(view, menuId), trigger = node(view, triggerId); if (!menu || !trigger) return;
    const open = menu.hidden; closeMenus(view, open ? menuId : null); menu.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const rect = trigger.getBoundingClientRect(), width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`; menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 8))}px`;
    if (!reducedMotion()) menu.animate([{ opacity: 0, transform: 'translateY(-6px) scale(.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function keyboard(view, event) {
    if (event.isComposing || event.target.closest('input,textarea,select,[contenteditable="true"]') || view.root.querySelector('dialog[open]')) return;
    if (event.target.closest('button') && [' ', 'Enter'].includes(event.key)) return;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (command && key === 'z') { event.preventDefault(); undo(view, event.shiftKey); return; }
    if (command && key === 'y') { event.preventDefault(); undo(view, true); return; }
    if (command && key === 's') { event.preventDefault(); void output(view); return; }
    if (command && key === 'c') { event.preventDefault(); void output(view, true); return; }
    if (command && key === 'd') { event.preventDefault(); duplicateSelected(view); return; }
    if (command && key === 'o') { event.preventDefault(); node(view, 'captureFile').click(); return; }
    if (event.key === ' ' && !event.repeat) { event.preventDefault(); view.spacePressed = true; node(view, 'captureStage').dataset.panReady = 'true'; }
    if (event.key === 'Escape') {
        const consumed = view.captureBusy || view.mode === 'crop' || view.selectedId || view.drag || view.root.querySelector('.capture-tool-menu:not([hidden])');
        if (consumed) { event.preventDefault(); event.stopPropagation(); }
        closeMenus(view); if (view.captureBusy) cancelCapture(view);
        else if (view.mode === 'crop') selectMode(view, 'select');
        else { view.drag = null; view.active = null; view.selectedId = null; renderBase(view); }
    }
    if (view.captureBusy || view.loading) return;
    if (event.key === 'Enter' && view.mode === 'crop') { event.preventDefault(); applyCrop(view); }
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); deleteSelected(view); }
    if (!command && !event.altKey && (KEYS[key] || key === 'o')) { event.preventDefault(); selectMode(view, KEYS[key] || 'ellipse'); }
    if (!command && ['+', '=', '-'].includes(key)) { event.preventDefault(); changeZoom(view, view.zoom * (key === '-' ? .8 : 1.25)); }
    if (!command && key === '0') fitZoom(view, true);
    if (view.mode === 'select' && view.selectedId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); const step = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        commit(view, { ...view.doc, objects: view.doc.objects.map(object => object.id === view.selectedId ? translateObject(object, dx, dy) : object) });
    }
}

function bindEvents(view) {
    const { signal } = view.controller, on = (id, type, callback) => node(view, id)?.addEventListener(type, callback, { signal });
    const stage = node(view, 'captureStage');
    on('captureOverlay', 'pointerdown', event => pointerDown(view, event)); on('captureOverlay', 'pointermove', event => pointerMove(view, event));
    on('captureOverlay', 'pointerup', event => pointerUp(view, event)); on('captureOverlay', 'pointercancel', event => pointerUp(view, event, true));
    on('captureOverlay', 'pointerleave', () => { node(view, 'captureBrushCursor').hidden = true; });
    on('captureOverlay', 'dblclick', event => { if (view.mode !== 'select') return; const point = canvasPoint(view, event), object = [...view.doc.objects].reverse().find(item => item.type === 'text' && hitTestObject(item, point, 6 / view.zoom)); if (object) { event.preventDefault(); startInlineText(view, point, object); } });
    stage.addEventListener('pointerdown', event => beginPan(view, event), { signal, capture: true });
    on('captureStage', 'pointermove', event => { if (!view.pan || event.pointerId !== view.pan.id) return; stage.scrollLeft = view.pan.left - event.clientX + view.pan.x; stage.scrollTop = view.pan.top - event.clientY + view.pan.y; });
    on('captureStage', 'pointerup', () => endPan(view)); on('captureStage', 'pointercancel', () => endPan(view));
    stage.addEventListener('wheel', event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); changeZoom(view, view.zoom * Math.exp(-event.deltaY * .002), event); }, { signal, passive: false });
    view.root.querySelectorAll('[data-capture-mode]').forEach(button => button.addEventListener('click', () => selectMode(view, button.dataset.captureMode), { signal }));
    view.root.querySelectorAll('[data-shape-mode]').forEach(button => button.addEventListener('click', () => { selectMode(view, button.dataset.shapeMode); closeMenus(view); }, { signal }));
    view.root.querySelectorAll('[data-shape-style]').forEach(button => button.addEventListener('click', () => {
        view.fill = button.dataset.shapeStyle; view.root.querySelectorAll('[data-shape-style]').forEach(item => { const selected = item === button; item.classList.toggle('is-active', selected); item.setAttribute('aria-pressed', String(selected)); }); applyProperty(view, { fill: view.fill === 'fill' }); finishProperty(view);
    }, { signal }));
    view.root.querySelectorAll('[data-capture-color]').forEach(button => button.addEventListener('click', () => { view.color = button.dataset.captureColor; node(view, 'captureColor').value = view.color; applyProperty(view, { color: view.color }); finishProperty(view); }, { signal }));
    on('captureColor', 'input', event => { view.color = event.target.value; applyProperty(view, { color: view.color }); }); on('captureColor', 'change', () => finishProperty(view));
    on('captureSize', 'input', event => { view.size = Number(event.target.value); node(view, 'captureSizeValue').textContent = view.size + ' px'; applyProperty(view, { size: view.size }); }); on('captureSize', 'change', () => finishProperty(view));
    on('captureCornerRadius', 'input', event => { view.doc = { ...view.doc, cornerRadius: Number(event.target.value) }; renderBase(view); }); on('captureCornerRadius', 'change', () => finishProperty(view));
    on('captureInlineText', 'input', () => positionText(view)); on('captureInlineText', 'blur', () => commitInlineText(view));
    on('captureInlineText', 'keydown', event => { if (event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); commitInlineText(view, true); } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitInlineText(view); } });
    on('captureUndo', 'click', () => undo(view)); on('captureRedo', 'click', () => undo(view, true)); on('captureDelete', 'click', () => deleteSelected(view));
    on('captureDuplicate', 'click', () => duplicateSelected(view)); on('captureBringFront', 'click', () => reorderSelected(view, true)); on('captureSendBack', 'click', () => reorderSelected(view, false));
    on('captureCropApply', 'click', () => applyCrop(view)); on('captureCropCancel', 'click', () => selectMode(view, 'select')); on('captureCropReset', 'click', () => applyCrop(view, true));
    on('captureClear', 'click', () => clearCapture(view)); on('captureAgain', 'click', () => void capture(view)); on('captureCopy', 'click', () => { view.outputJob = output(view, true); }); on('captureSave', 'click', () => { view.outputJob = output(view); });
    on('captureImport', 'click', () => node(view, 'captureFile').click());
    on('captureFile', 'change', event => { const file = event.target.files?.[0]; event.target.value = ''; view.imageJob = loadImage(view, file); });
    view.root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { if (button.dataset.action === 'capture') void capture(view); else if (button.dataset.action === 'import') node(view, 'captureFile').click(); }, { signal }));
    on('captureCanvasTrigger', 'click', () => toggleMenu(view, 'captureCanvasMenu', 'captureCanvasTrigger')); on('captureOptionsTrigger', 'click', () => toggleMenu(view, 'captureOptionsMenu', 'captureOptionsTrigger')); on('captureShapeOptionsTrigger', 'click', () => toggleMenu(view, 'captureShapeMenu', 'captureShapeOptionsTrigger'));
    on('captureZoomOut', 'click', () => changeZoom(view, view.zoom / 1.25)); on('captureZoomIn', 'click', () => changeZoom(view, view.zoom * 1.25)); on('captureZoomFit', 'click', () => fitZoom(view, true));
    on('captureLong', 'click', () => { closeMenus(view); node(view, 'captureLongDialog').showModal(); }); on('captureLongCancel', 'click', () => node(view, 'captureLongDialog').close());
    view.root.querySelectorAll('[data-long-direction]').forEach(button => button.addEventListener('click', () => { view.longDirection = button.dataset.longDirection; view.root.querySelectorAll('[data-long-direction]').forEach(item => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); }, { signal }));
    on('captureLongMode', 'change', () => {
        node(view, 'captureLongNote').textContent = node(view, 'captureLongMode').value === 'manual'
            ? '将鼠标放在选区内，自行缓慢向下（横向时向右）滚动，每次保留至少半屏重叠并稍停。Enter 完成，Esc 取消；10 分钟或达到段数上限时结束。'
            : '开始后自动滚动所选区域；到达末端或内容不再变化时结束，Esc 取消。请让目标窗口保持可见。';
    });
    on('captureLongStart', 'click', () => { node(view, 'captureLongDialog').close(); void capture(view, { longDirection: view.longDirection, longMode: node(view, 'captureLongMode').value, maxSegments: clamp(Number(node(view, 'captureLongSegments').value) || 12, 2, 20) }); });
    on('captureOcr', 'click', () => void recognize(view)); on('captureOcrClose', 'click', () => { node(view, 'captureOcrPanel').hidden = true; });
    on('captureOcrCopy', 'click', async () => { const text = node(view, 'captureOcrText').value; try { await navigator.clipboard.writeText(text); status(view, '文字已复制', 'success'); } catch (error) { status(view, `文字复制失败：${String(error.message || error)}`, 'error'); } });
    on('captureHelp', 'click', () => node(view, 'captureHelpDialog').showModal());
    view.root.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); view.root.classList.add('is-dragover'); } }, { signal });
    view.root.addEventListener('dragleave', event => { if (!view.root.contains(event.relatedTarget)) view.root.classList.remove('is-dragover'); }, { signal });
    view.root.addEventListener('drop', event => { event.preventDefault(); view.root.classList.remove('is-dragover'); view.imageJob = loadImage(view, [...event.dataTransfer.files].find(file => file.type.startsWith('image/')) || event.dataTransfer.files[0]); }, { signal });
    document.addEventListener('paste', event => { if (event.target.closest('input,textarea,[contenteditable="true"]')) return; const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) { event.preventDefault(); view.imageJob = loadImage(view, file); } }, { signal });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.capture-tool-group')) closeMenus(view); }, { signal });
    document.addEventListener('keydown', event => keyboard(view, event), { signal });
    document.addEventListener('keyup', event => { if (event.key === ' ') { view.spacePressed = false; stage.dataset.panReady = 'false'; endPan(view); } }, { signal });
    window.addEventListener('blur', () => { view.spacePressed = false; stage.dataset.panReady = 'false'; endPan(view); node(view, 'captureBrushCursor').hidden = true; if (view.drag) { view.active = null; view.drag = null; renderBase(view); } }, { signal });
    window.addEventListener('dtkit:power-state', event => { if (event.detail?.suspended) { view.active = null; view.drag = null; view.spacePressed = false; endPan(view); commitInlineText(view); renderBase(view); } }, { signal });
}

async function init() {
    destroy(); const root = document.querySelector('.capture-shell'); if (!root) return;
    const doc = { objects: [], crop: { x: 0, y: 0, width: 1, height: 1 }, cornerRadius: 0 };
    const view = { root, controller: new AbortController(), doc, history: new History(doc), image: null, imageUrl: null, assetId: null, mode: 'pen', color: '#007aff', size: 5, fill: 'outline', zoom: 1, zoomMode: 'fit',
        captureGeneration: 0, ocrGeneration: 0, captureBusy: false, outputBusy: false, ocrBusy: false, loading: false, nativeReady: false, pendingCapture: null,
        active: null, drag: null, selectedId: null, cropDraft: null, textEdit: null, pan: null, spacePressed: false, renderFrame: 0, zoomFrame: 0, longDirection: 'vertical', assetJob: Promise.resolve(), imageJob: Promise.resolve(), outputJob: Promise.resolve() };
    currentView = view; bindEvents(view); selectMode(view, 'pen');
    view.observer = new ResizeObserver(() => { if (alive(view) && view.zoomMode === 'fit') fitZoom(view); }); view.observer.observe(node(view, 'captureStage'));
    if (window.__TAURI__?.event?.listen) {
        try {
            const unlisten = await window.__TAURI__.event.listen('screen-region-captured', event => {
                if (!alive(view) || !view.pendingCapture || event.payload?.requestId !== view.pendingCapture.requestId) return;
                const pending = view.pendingCapture; view.pendingCapture = null; pending.resolve(event.payload.cancelled ? null : event.payload.capture || null);
            });
            if (!alive(view)) { unlisten?.(); return; } view.unlisten = unlisten; view.nativeReady = true;
        } catch (error) { if (alive(view)) status(view, `截图通道暂不可用，可导入图片：${String(error.message || error)}`, 'warning'); }
    } else status(view, '可导入、拖入或粘贴图片；屏幕截图需使用桌面版');
    if (!alive(view)) return;
    updateControls(view); if (isQuickHost() && view.nativeReady) void capture(view);
}

function serialize() {
    const view = currentView; if (!view) return null;
    return { version: 2, assetId: view.assetId, imageName: view.imageName, document: clone(view.doc), mode: view.mode, color: view.color, size: view.size, fill: view.fill,
        textEdit: view.textEdit ? { ...clone(view.textEdit), text: node(view, 'captureInlineText').value.slice(0, 2000) } : null, cropDraft: view.cropDraft ? clone(view.cropDraft) : null,
        ocr: { open: !node(view, 'captureOcrPanel').hidden, text: node(view, 'captureOcrText').value.slice(0, 50000) },
        exportScale: node(view, 'captureExportScale').value, delay: node(view, 'captureDelay').value, zoom: view.zoom, zoomMode: view.zoomMode };
}

async function restore(snapshot) {
    const view = currentView; if (!view || snapshot?.version !== 2) return;
    cancelCapture(view);
    let generation = ++view.captureGeneration; view.loading = false;
    const ownsRestore = () => alive(view) && generation === view.captureGeneration;
    if (typeof snapshot.color === 'string' && /^#[\da-f]{6}$/i.test(snapshot.color)) { view.color = snapshot.color; node(view, 'captureColor').value = view.color; }
    view.size = clamp(Number(snapshot.size) || 5, 2, 40); node(view, 'captureSize').value = String(view.size); node(view, 'captureSizeValue').textContent = view.size + ' px';
    view.fill = snapshot.fill === 'fill' ? 'fill' : 'outline';
    if (['1', '2'].includes(snapshot.exportScale)) node(view, 'captureExportScale').value = snapshot.exportScale;
    if (['0', '3', '5', '10'].includes(snapshot.delay)) node(view, 'captureDelay').value = snapshot.delay;
    if (snapshot.assetId) {
        try {
            const file = await readImage(snapshot.assetId); if (!ownsRestore()) return;
            if (!file) { status(view, '原图缓存已过期，请重新导入图片', 'warning'); updateControls(view); return; }
            const loading = loadImage(view, file, { assetId: snapshot.assetId, document: snapshot.document });
            generation = view.captureGeneration;
            if (!await loading || !ownsRestore()) return;
        } catch { if (ownsRestore()) { status(view, '无法恢复原图，请重新导入图片', 'warning'); updateControls(view); } return; }
    }
    if (!ownsRestore()) return; selectMode(view, MODES.has(snapshot.mode) ? snapshot.mode : 'pen');
    if (view.image && view.mode === 'crop' && snapshot.cropDraft) { view.cropDraft = sanitizeDocument({ crop: snapshot.cropDraft }, view.image.width, view.image.height).crop; renderOverlay(view); }
    if (view.image && snapshot.textEdit?.type === 'text') {
        const draft = sanitizeDocument({ objects: [{ ...snapshot.textEdit, text: 'draft' }] }, view.image.width, view.image.height).objects[0];
        if (draft) { draft.text = String(snapshot.textEdit.text || '').slice(0, 2000); startInlineText(view, draft, draft); }
    }
    if (view.image && snapshot.ocr?.open) { node(view, 'captureOcrText').value = String(snapshot.ocr.text || '').slice(0, 50000); node(view, 'captureOcrPanel').hidden = false; }
    if (view.image && snapshot.zoomMode === 'manual') changeZoom(view, Number(snapshot.zoom) || 1);
}

async function flush() { const view = currentView; if (!view) return; commitInlineText(view); await Promise.allSettled([view.imageJob, view.assetJob, view.outputJob]); }

function destroy() {
    const view = currentView; if (!view) return;
    cancelCapture(view); view.captureGeneration += 1; view.ocrGeneration++; view.controller.abort(); view.observer?.disconnect(); view.unlisten?.();
    cancelAnimationFrame(view.renderFrame); cancelAnimationFrame(view.zoomFrame); releaseBackground(view);
    view.root.querySelectorAll('canvas').forEach(canvas => { canvas.width = canvas.height = 1; }); currentView = null;
}

registerTool({ id: 'screenshot-annotator', name: '截图与标注', icon: 'ri-screenshot-2-line', colorClass: 'tool-card__icon--orange', category: 'design', status: 'ready',
    description: '区域与长截图、图片导入、丰富标注、裁剪遮挡、本地文字识别与一键复制。', template, init, destroy, serialize, restore, flush });
