const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);

const canvas = document.getElementById('regionCanvas');
const context = canvas.getContext('2d', { alpha: false });
const selectionElement = document.getElementById('regionSelection');
const topbar = document.getElementById('regionTopbar');
const toolbar = document.getElementById('regionToolbar');
const sizeElement = document.getElementById('regionSize');
const radiusInput = document.getElementById('regionRadius');
const radiusValue = document.getElementById('regionRadiusValue');
const shadowInput = document.getElementById('regionShadow');
const colorInput = document.getElementById('regionColor');
const strokeInput = document.getElementById('regionStrokeSize');
const strokeValue = document.getElementById('regionStrokeValue');
const inlineText = document.getElementById('regionInlineText');
const brushCursor = document.getElementById('regionBrushCursor');
const hint = document.getElementById('regionHint');
const undoButton = document.getElementById('regionUndo');

const MIN_REGION_SIZE = 12;
const PANEL_GAP = 8;
const VIEWPORT_PADDING = 8;
const SHADOW_PADDING = 20;
const MAX_ANNOTATIONS = 200;
const MAX_PEN_POINTS = 4000;
const mosaicBuffer = document.createElement('canvas');
const mosaicContext = mosaicBuffer.getContext('2d', { alpha: false });

let image = null;
let captureSource = null;
let selection = null;
let interaction = null;
let activeTool = 'move';
let annotations = [];
let draftAnnotation = null;
let finishing = false;
let renderQueued = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pointInSelection = (x, y) => selection
    && x >= selection.left && x <= selection.left + selection.width
    && y >= selection.top && y <= selection.top + selection.height;

function sourceScale() {
    return {
        x: canvas.width / Math.max(1, innerWidth),
        y: canvas.height / Math.max(1, innerHeight)
    };
}

function normalizeBox(startX, startY, endX, endY) {
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    return { left, top, width: Math.abs(endX - startX), height: Math.abs(endY - startY) };
}

function pixelSize(region = selection) {
    if (!region) return { width: 0, height: 0 };
    const scale = sourceScale();
    return {
        width: Math.max(1, Math.round(region.width * scale.x)),
        height: Math.max(1, Math.round(region.height * scale.y))
    };
}

function placeFloatingPanel(element, preferredX, preferredY) {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const x = clamp(preferredX, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, innerWidth - width - VIEWPORT_PADDING));
    const y = clamp(preferredY, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, innerHeight - height - VIEWPORT_PADDING));
    element.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
    return { x, y, width, height };
}

function positionPanels() {
    if (!selection || topbar.hidden || toolbar.hidden) return;
    const centerX = selection.left + selection.width / 2;
    const topHeight = topbar.offsetHeight;
    const toolHeight = toolbar.offsetHeight;
    const above = selection.top - PANEL_GAP;
    const below = selection.top + selection.height + PANEL_GAP;
    let topY = above - topHeight;
    let toolY = below;
    if (topY < VIEWPORT_PADDING) topY = selection.top + PANEL_GAP;
    if (toolY + toolHeight > innerHeight - VIEWPORT_PADDING) toolY = selection.top + selection.height - toolHeight - PANEL_GAP;
    const topRect = placeFloatingPanel(topbar, centerX - topbar.offsetWidth / 2, topY);
    if (Math.abs(toolY - topY) < Math.max(topHeight, toolHeight)) {
        toolY = topRect.y + topRect.height + PANEL_GAP;
    }
    placeFloatingPanel(toolbar, centerX - toolbar.offsetWidth / 2, toolY);
}

function renderSelection() {
    if (!selection || selection.width < 1 || selection.height < 1) {
        selectionElement.hidden = true;
        topbar.hidden = true;
        toolbar.hidden = true;
        return;
    }
    selectionElement.hidden = false;
    selectionElement.setAttribute('aria-hidden', 'false');
    selectionElement.dataset.state = interaction?.kind === 'select' ? 'selecting' : 'adjusting';
    selectionElement.style.transform = `translate3d(${Math.round(selection.left)}px,${Math.round(selection.top)}px,0)`;
    selectionElement.style.width = `${Math.round(selection.width)}px`;
    selectionElement.style.height = `${Math.round(selection.height)}px`;
    selectionElement.style.setProperty('--selection-radius', `${radiusInput.value}px`);
    const size = pixelSize();
    sizeElement.textContent = `${size.width} × ${size.height}`;
    const adjusting = selectionElement.dataset.state === 'adjusting';
    topbar.hidden = !adjusting;
    toolbar.hidden = !adjusting;
    if (adjusting) requestAnimationFrame(positionPanels);
}

function drawArrow(ctx, object) {
    const { x1, y1, x2, y2, color, size } = object;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, size * 3.2);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
}

function drawMosaic(ctx, object) {
    const box = normalizeBox(object.x1, object.y1, object.x2, object.y2);
    if (box.width < 2 || box.height < 2) return;
    const scale = sourceScale();
    const block = Math.max(4, Math.round(object.size * 1.8));
    mosaicBuffer.width = Math.max(1, Math.ceil(box.width / block));
    mosaicBuffer.height = Math.max(1, Math.ceil(box.height / block));
    mosaicContext.imageSmoothingEnabled = true;
    mosaicContext.drawImage(image, box.left * scale.x, box.top * scale.y, box.width * scale.x, box.height * scale.y, 0, 0, mosaicBuffer.width, mosaicBuffer.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mosaicBuffer, box.left, box.top, box.width, box.height);
    ctx.restore();
}

function drawAnnotation(ctx, object) {
    if (!object) return;
    ctx.save();
    ctx.strokeStyle = object.color;
    ctx.fillStyle = object.color;
    ctx.lineWidth = object.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (object.type === 'pen') {
        if (object.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(object.points[0].x, object.points[0].y);
            for (let index = 1; index < object.points.length; index += 1) {
                const point = object.points[index];
                const previous = object.points[index - 1];
                ctx.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
            }
            ctx.stroke();
        }
    } else if (object.type === 'rect') {
        const box = normalizeBox(object.x1, object.y1, object.x2, object.y2);
        ctx.strokeRect(box.left, box.top, box.width, box.height);
    } else if (object.type === 'ellipse') {
        const box = normalizeBox(object.x1, object.y1, object.x2, object.y2);
        ctx.beginPath();
        ctx.ellipse(box.left + box.width / 2, box.top + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
    } else if (object.type === 'arrow') {
        drawArrow(ctx, object);
    } else if (object.type === 'text') {
        ctx.font = `700 ${Math.max(14, object.size * 3.2)}px "Segoe UI","Microsoft YaHei",sans-serif`;
        ctx.textBaseline = 'top';
        object.text.split('\n').forEach((line, index) => ctx.fillText(line, object.x, object.y + index * Math.max(19, object.size * 4)));
    } else if (object.type === 'mosaic') {
        drawMosaic(ctx, object);
    }
    ctx.restore();
}

function renderFrame() {
    renderQueued = false;
    if (!image) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const scale = sourceScale();
    context.save();
    context.scale(scale.x, scale.y);
    if (selection) {
        context.beginPath();
        context.rect(selection.left, selection.top, selection.width, selection.height);
        context.clip();
    }
    annotations.forEach(object => drawAnnotation(context, object));
    drawAnnotation(context, draftAnnotation);
    context.restore();
}

function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderFrame);
}

function annotationAtStart(type, x, y) {
    const base = { type, color: colorInput.value, size: Number(strokeInput.value) };
    if (type === 'pen') return { ...base, points: [{ x, y }] };
    return { ...base, x1: x, y1: y, x2: x, y2: y };
}

function translateAnnotation(object, dx, dy) {
    if (object.type === 'pen') return { ...object, points: object.points.map(point => ({ x: point.x + dx, y: point.y + dy })) };
    if (object.type === 'text') return { ...object, x: object.x + dx, y: object.y + dy };
    return { ...object, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
}

function setTool(tool) {
    activeTool = tool;
    document.body.dataset.tool = tool;
    toolbar.querySelectorAll('[data-tool]').forEach(button => {
        const active = button.dataset.tool === tool;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    brushCursor.hidden = !['pen', 'mosaic'].includes(tool);
}

function updateUndo() {
    undoButton.disabled = annotations.length === 0;
}

function appendAnnotation(object) {
    annotations.push(object);
    if (annotations.length > MAX_ANNOTATIONS) annotations.splice(0, annotations.length - MAX_ANNOTATIONS);
    updateUndo();
}

function startInlineText(x, y) {
    inlineText.hidden = false;
    inlineText.value = '';
    inlineText.style.left = `${x}px`;
    inlineText.style.top = `${y}px`;
    inlineText.style.fontSize = `${Math.max(14, Number(strokeInput.value) * 3.2)}px`;
    inlineText.style.setProperty('--annotation-color', colorInput.value);
    inlineText.dataset.x = String(x);
    inlineText.dataset.y = String(y);
    inlineText.focus();
}

function commitInlineText() {
    if (inlineText.hidden) return;
    const text = inlineText.value.trim();
    if (text) {
        appendAnnotation({
            type: 'text',
            x: Number(inlineText.dataset.x),
            y: Number(inlineText.dataset.y),
            text,
            color: colorInput.value,
            size: Number(strokeInput.value)
        });
    }
    inlineText.hidden = true;
    inlineText.value = '';
    updateUndo();
    queueRender();
}

function cancelInlineText() {
    inlineText.hidden = true;
    inlineText.value = '';
}

async function finish(payload = {}) {
    if (finishing) return;
    finishing = true;
    selectionElement.classList.add('is-capturing');
    topbar.hidden = true;
    toolbar.hidden = true;
    brushCursor.hidden = true;
    try {
        await invoke('finish_screen_region_capture', payload);
    } catch (error) {
        finishing = false;
        selectionElement.classList.remove('is-capturing');
        document.getElementById('regionLoading').hidden = false;
        document.getElementById('regionLoading').textContent = String(error);
    }
}

function cancel() {
    finish({ dataUrl: null, width: null, height: null, x: null, y: null });
}

function roundedPath(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, safeRadius);
}

function selectedSourceRect() {
    if (!selection || selection.width < MIN_REGION_SIZE || selection.height < MIN_REGION_SIZE) return null;
    const scale = sourceScale();
    const sourceX = clamp(Math.floor(selection.left * scale.x), 0, canvas.width - 1);
    const sourceY = clamp(Math.floor(selection.top * scale.y), 0, canvas.height - 1);
    return {
        sourceX,
        sourceY,
        width: Math.min(canvas.width - sourceX, Math.max(1, Math.round(selection.width * scale.x))),
        height: Math.min(canvas.height - sourceY, Math.max(1, Math.round(selection.height * scale.y))),
        scale
    };
}

function closeLongMenu() {
    const menu = document.getElementById('regionLongMenu');
    const trigger = document.getElementById('regionLong');
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
}

function startLongCaptureFromSelection(direction) {
    if (finishing || !['vertical', 'horizontal'].includes(direction)) return;
    const rect = selectedSourceRect();
    if (!rect) return;
    cancelInlineText();
    closeLongMenu();
    finish({
        dataUrl: null,
        width: rect.width,
        height: rect.height,
        x: captureSource.x + rect.sourceX,
        y: captureSource.y + rect.sourceY,
        longDirection: direction,
        maxSegments: 12
    });
}

function confirmSelection() {
    if (!selection || finishing || selection.width < MIN_REGION_SIZE || selection.height < MIN_REGION_SIZE) return;
    commitInlineText();
    renderFrame();
    const rect = selectedSourceRect();
    if (!rect) return;
    const { sourceX, sourceY, width, height, scale } = rect;
    if (captureSource?.longDirection) {
        finish({ dataUrl: null, width, height, x: captureSource.x + sourceX, y: captureSource.y + sourceY });
        return;
    }
    const shadow = shadowInput.checked;
    const padding = shadow ? SHADOW_PADDING : 0;
    const output = document.createElement('canvas');
    output.width = width + padding * 2;
    output.height = height + padding * 2;
    const outputContext = output.getContext('2d');
    const radius = Number(radiusInput.value) * Math.min(scale.x, scale.y);
    if (shadow) {
        outputContext.save();
        outputContext.shadowColor = 'rgba(9,16,27,.38)';
        outputContext.shadowBlur = 15;
        outputContext.shadowOffsetY = 6;
        outputContext.fillStyle = '#fff';
        roundedPath(outputContext, padding, padding, width, height, radius);
        outputContext.fill();
        outputContext.restore();
    }
    outputContext.save();
    roundedPath(outputContext, padding, padding, width, height, radius);
    outputContext.clip();
    outputContext.drawImage(canvas, sourceX, sourceY, width, height, padding, padding, width, height);
    outputContext.restore();
    finish({ dataUrl: output.toDataURL('image/png'), width: output.width, height: output.height });
}

function beginSelection(event) {
    interaction = { kind: 'select', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    selection = { left: event.clientX, top: event.clientY, width: 0, height: 0 };
    annotations = [];
    canvas.setPointerCapture(event.pointerId);
    renderSelection();
}

function beginMove(event) {
    interaction = {
        kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        original: { ...selection }, annotations: structuredClone(annotations)
    };
    canvas.setPointerCapture(event.pointerId);
}

function beginResize(event, handle) {
    interaction = { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, handle, original: { ...selection } };
    selectionElement.setPointerCapture(event.pointerId);
}

function updateResize(event) {
    const { original, handle, startX, startY } = interaction;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    let left = original.left;
    let top = original.top;
    let right = original.left + original.width;
    let bottom = original.top + original.height;
    if (handle.includes('w')) left = clamp(original.left + dx, 0, right - MIN_REGION_SIZE);
    if (handle.includes('e')) right = clamp(right + dx, left + MIN_REGION_SIZE, innerWidth);
    if (handle.includes('n')) top = clamp(original.top + dy, 0, bottom - MIN_REGION_SIZE);
    if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_REGION_SIZE, innerHeight);
    selection = { left, top, width: right - left, height: bottom - top };
}

canvas.addEventListener('pointerdown', event => {
    if (!image || event.button !== 0 || finishing || !inlineText.hidden) return;
    if (!selection) {
        beginSelection(event);
        return;
    }
    if (!pointInSelection(event.clientX, event.clientY)) return;
    if (activeTool === 'move') {
        beginMove(event);
        return;
    }
    if (activeTool === 'text') {
        event.preventDefault();
        startInlineText(event.clientX, event.clientY);
        return;
    }
    interaction = { kind: 'draw', pointerId: event.pointerId };
    draftAnnotation = annotationAtStart(activeTool, event.clientX, event.clientY);
    canvas.setPointerCapture(event.pointerId);
    queueRender();
});

canvas.addEventListener('pointermove', event => {
    if (['pen', 'mosaic'].includes(activeTool) && selection && pointInSelection(event.clientX, event.clientY)) {
        brushCursor.hidden = false;
        brushCursor.style.width = `${strokeInput.value}px`;
        brushCursor.style.height = `${strokeInput.value}px`;
        brushCursor.style.transform = `translate3d(${event.clientX - Number(strokeInput.value) / 2}px,${event.clientY - Number(strokeInput.value) / 2}px,0)`;
    } else {
        brushCursor.hidden = true;
    }
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    if (interaction.kind === 'select') {
        selection = normalizeBox(interaction.startX, interaction.startY, clamp(event.clientX, 0, innerWidth), clamp(event.clientY, 0, innerHeight));
        renderSelection();
    } else if (interaction.kind === 'move') {
        const dx = clamp(event.clientX - interaction.startX, -interaction.original.left, innerWidth - interaction.original.left - interaction.original.width);
        const dy = clamp(event.clientY - interaction.startY, -interaction.original.top, innerHeight - interaction.original.top - interaction.original.height);
        selection = { ...interaction.original, left: interaction.original.left + dx, top: interaction.original.top + dy };
        annotations = interaction.annotations.map(object => translateAnnotation(object, dx, dy));
        renderSelection();
        queueRender();
    } else if (interaction.kind === 'resize') {
        updateResize(event);
        renderSelection();
        queueRender();
    } else if (interaction.kind === 'draw' && draftAnnotation) {
        const x = clamp(event.clientX, selection.left, selection.left + selection.width);
        const y = clamp(event.clientY, selection.top, selection.top + selection.height);
        if (draftAnnotation.type === 'pen') {
            const events = event.getCoalescedEvents?.() || [event];
            events.forEach(sample => {
                if (draftAnnotation.points.length >= MAX_PEN_POINTS) return;
                const next = {
                    x: clamp(sample.clientX, selection.left, selection.left + selection.width),
                    y: clamp(sample.clientY, selection.top, selection.top + selection.height)
                };
                const previous = draftAnnotation.points.at(-1);
                if (!previous || Math.hypot(next.x - previous.x, next.y - previous.y) >= .75) draftAnnotation.points.push(next);
            });
        } else {
            draftAnnotation.x2 = x;
            draftAnnotation.y2 = y;
        }
        queueRender();
    }
});

function endPointer(event) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    const kind = interaction.kind;
    interaction = null;
    if (kind === 'select') {
        if (!selection || selection.width < MIN_REGION_SIZE || selection.height < MIN_REGION_SIZE) selection = null;
        else hint.classList.add('is-dismissed');
        renderSelection();
    } else if (kind === 'draw' && draftAnnotation) {
        appendAnnotation(draftAnnotation);
        draftAnnotation = null;
        queueRender();
    } else {
        renderSelection();
    }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!interaction) brushCursor.hidden = true; });
canvas.addEventListener('dblclick', event => {
    if (!pointInSelection(event.clientX, event.clientY)) return;
    if (!inlineText.hidden && !inlineText.value.trim()) cancelInlineText();
    if (inlineText.hidden) confirmSelection();
});

selectionElement.querySelectorAll('[data-handle]').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || finishing) return;
        event.preventDefault();
        event.stopPropagation();
        beginResize(event, handle.dataset.handle);
    });
});
selectionElement.addEventListener('pointermove', event => {
    if (interaction?.kind !== 'resize' || event.pointerId !== interaction.pointerId) return;
    updateResize(event);
    renderSelection();
    queueRender();
});
selectionElement.addEventListener('pointerup', endPointer);
selectionElement.addEventListener('pointercancel', endPointer);

toolbar.addEventListener('pointerdown', event => event.stopPropagation());
topbar.addEventListener('pointerdown', event => event.stopPropagation());
toolbar.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.getElementById('regionLong').addEventListener('click', event => {
    event.stopPropagation();
    const menu = document.getElementById('regionLongMenu');
    const opening = menu.hidden;
    menu.hidden = !opening;
    event.currentTarget.setAttribute('aria-expanded', String(opening));
    if (opening) {
        const triggerRect = event.currentTarget.getBoundingClientRect();
        const menuHeight = menu.offsetHeight;
        menu.classList.toggle('opens-below', innerHeight - triggerRect.bottom >= menuHeight + 10);
    }
});
document.querySelectorAll('[data-region-long-direction]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    startLongCaptureFromSelection(button.dataset.regionLongDirection);
}));
document.getElementById('regionConfirm').addEventListener('click', confirmSelection);
document.getElementById('regionCancel').addEventListener('click', cancel);
undoButton.addEventListener('click', () => {
    annotations.pop();
    updateUndo();
    queueRender();
});
radiusInput.addEventListener('input', () => {
    radiusValue.textContent = radiusInput.value;
    renderSelection();
});
colorInput.addEventListener('input', () => {
    document.documentElement.style.setProperty('--annotation-color', colorInput.value);
});
strokeInput.addEventListener('input', () => { strokeValue.textContent = strokeInput.value; });
inlineText.addEventListener('input', () => {
    inlineText.style.height = 'auto';
    inlineText.style.height = `${Math.min(180, inlineText.scrollHeight)}px`;
});
inlineText.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        cancelInlineText();
    } else if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        commitInlineText();
    }
});
inlineText.addEventListener('blur', commitInlineText);

document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && !document.getElementById('regionLongMenu').hidden) closeLongMenu();
    else if (event.key === 'Escape') cancel();
    else if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.shiftKey && inlineText.hidden) confirmSelection();
    else if (event.key.toLowerCase() === 'z' && event.ctrlKey && annotations.length) {
        annotations.pop();
        updateUndo();
        queueRender();
    }
});
document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#regionLongControl')) closeLongMenu();
}, true);
document.addEventListener('contextmenu', event => {
    event.preventDefault();
    cancel();
});
addEventListener('resize', () => {
    if (selection) {
        selection.left = clamp(selection.left, 0, Math.max(0, innerWidth - selection.width));
        selection.top = clamp(selection.top, 0, Math.max(0, innerHeight - selection.height));
        renderSelection();
    }
    queueRender();
});

try {
    const capture = await invoke('get_screen_region_capture');
    captureSource = capture;
    if (capture.longDirection) {
        document.body.classList.add('is-long-mode');
        document.querySelector('.region-hint strong').textContent = '选择长截图滚动范围';
        document.querySelector('.region-hint span').textContent = '松开后调整范围，确认才开始滚动拼接';
    }
    const nextImage = new Image();
    nextImage.onload = () => {
        image = nextImage;
        canvas.width = capture.width;
        canvas.height = capture.height;
        renderFrame();
        setTool('move');
        document.getElementById('regionLoading').hidden = true;
    };
    nextImage.onerror = cancel;
    nextImage.src = capture.dataUrl;
} catch (error) {
    document.getElementById('regionLoading').textContent = String(error);
}
