import '../../css/tools/screenshot-annotator.css';
import { registerTool } from '../toolRegistry.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const listen = (...args) => globalThis.window?.__TAURI__?.event?.listen?.(...args);
const byId = id => document.getElementById(id);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');
const SHAPE_MODES = new Set(['rect', 'ellipse', 'line', 'arrow']);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

let controller;
let canvas;
let context;
let background;
let objects = [];
let active = null;
let selectedIndex = -1;
let dragState = null;
let mode = 'pen';
let currentShape = 'rect';
let color = '#ef6f3c';
let size = 5;
let shapeStyle = 'outline';
let cornerRadius = 0;
let frame = 0;
let captureGeneration = 0;
let captureBusy = false;
let saveBusy = false;
let zoom = 1;
let zoomMode = 'fit';
let stageResizeObserver = null;
let pan = null;
let pendingRegionCapture = null;
let unlistenRegionCapture = null;
let editingTextIndex = -1;

function template() {
    const footerStatus = isQuickHost() ? '支持原位文字、形状、圆角与截图调整。' : '支持原位文字、形状、圆角与自动长截图。';
    const longCaptureAction = isQuickHost() ? '' : '<button id="captureLong" type="button" title="选择固定区域并自动滚动拼接" disabled><i class="ri-layout-row-line"></i><span>长截图</span></button>';
    const longCaptureDialog = isQuickHost() ? '' : `<dialog id="captureLongDialog" class="capture-long-dialog"><form method="dialog">
        <header><span><i class="ri-layout-row-line"></i></span><div><strong>自动长截图</strong><small>只需选择一次范围，DtKit 会自动滚动并拼接</small></div></header>
        <div class="capture-long-directions" role="group" aria-label="拼接方向">
          <button class="is-active" data-long-direction="vertical" type="button" aria-pressed="true"><i class="ri-arrow-down-line"></i><span>纵向拼接</span></button>
          <button data-long-direction="horizontal" type="button" aria-pressed="false"><i class="ri-arrow-right-line"></i><span>横向拼接</span></button>
        </div>
        <label>最多采集 <span><input id="captureLongSegments" type="number" min="2" max="20" value="12"> 段</span></label>
        <p>选区会显示高亮边框。DtKit 将向目标窗口发送滚动并自动识别重叠位置；到达页面末端或内容不再变化时会自动结束。</p>
        <footer><button id="captureLongCancel" type="button">取消</button><button id="captureLongStart" class="capture-long-primary" type="button">选择范围并开始</button></footer>
      </form></dialog>`;
    return `<div class="capture-shell">
      <header class="capture-toolbar">
        <div class="capture-identity"><span><i class="ri-screenshot-2-line"></i></span><div><strong>截图标注</strong><small id="captureDimensions">等待截图</small></div></div>
        <div class="capture-tools" role="toolbar" aria-label="截图标注工具">
          <button data-capture-mode="select" aria-pressed="false" title="选择、移动或双击编辑"><i class="ri-cursor-line"></i><span>选择</span></button>
          <button class="is-active" data-capture-mode="pen" aria-pressed="true"><i class="ri-pencil-line"></i><span>画笔</span></button>
          <div class="capture-tool-group">
            <button id="captureShapeTrigger" data-capture-mode="rect" aria-pressed="false" aria-haspopup="true" aria-expanded="false"><i class="ri-checkbox-blank-line"></i><span>矩形</span><i class="ri-arrow-down-s-line capture-menu-chevron"></i></button>
            <div id="captureShapeMenu" class="capture-tool-menu" role="menu" hidden>
              <div class="capture-tool-menu__title"><strong>形状</strong><small>选择后直接在截图上拖动</small></div>
              <div class="capture-shape-grid">
                <button class="is-active" data-shape-mode="rect" type="button"><i class="ri-checkbox-blank-line"></i><span>矩形</span></button>
                <button data-shape-mode="ellipse" type="button"><i class="ri-circle-line"></i><span>椭圆</span></button>
                <button data-shape-mode="line" type="button"><i class="ri-subtract-line"></i><span>直线</span></button>
                <button data-shape-mode="arrow" type="button"><i class="ri-arrow-right-up-line"></i><span>箭头</span></button>
              </div>
              <div class="capture-tool-menu__row"><span>外观</span><div class="capture-style-toggle" role="group" aria-label="形状样式">
                <button class="is-active" data-shape-style="outline" aria-pressed="true" title="仅描边"><i class="ri-checkbox-blank-line"></i><span>框</span></button>
                <button data-shape-style="fill" aria-pressed="false" title="填充"><i class="ri-checkbox-fill"></i><span>填充</span></button>
              </div></div>
            </div>
          </div>
          <button data-capture-mode="text" aria-pressed="false"><i class="ri-text"></i><span>文字</span></button>
          <span class="capture-divider"></span>
          <input id="captureColor" type="color" value="#ef6f3c" aria-label="标注颜色">
          <input id="captureSize" type="range" min="2" max="24" value="5" aria-label="标注粗细">
          <output id="captureSizeValue" for="captureSize">5 px</output>
          <button id="captureUndo" disabled><i class="ri-arrow-go-back-line"></i><span>撤销</span></button>
        </div>
        <div class="capture-actions">
          <div class="capture-zoom" role="group" aria-label="截图缩放">
            <button id="captureZoomOut" type="button" title="缩小" disabled><i class="ri-subtract-line"></i></button>
            <output id="captureZoomValue">100%</output>
            <button id="captureZoomIn" type="button" title="放大" disabled><i class="ri-add-line"></i></button>
            <button id="captureZoomFit" type="button" title="适合窗口" disabled><i class="ri-focus-3-line"></i></button>
          </div>
          <button id="captureDelete" class="capture-delete" type="button" title="删除当前截图" disabled><i class="ri-delete-bin-6-line"></i><span>删除</span></button>
          <div class="capture-tool-group capture-canvas-group">
            <button id="captureCanvasTrigger" type="button" title="调整截图外观" disabled aria-haspopup="true" aria-expanded="false"><i class="ri-rounded-corner"></i><span>圆角</span><i class="ri-arrow-down-s-line capture-menu-chevron"></i></button>
            <div id="captureCanvasMenu" class="capture-tool-menu capture-canvas-menu" hidden>
              <div class="capture-tool-menu__title"><strong>截图外观</strong><small>圆角会同时应用于预览与 PNG</small></div>
              <label for="captureCornerRadius"><span>圆角</span><output id="captureCornerRadiusValue">0 px</output></label>
              <input id="captureCornerRadius" type="range" min="0" max="64" value="0">
            </div>
          </div>
          ${longCaptureAction}
          <button id="captureAgain"><i class="ri-screenshot-2-line"></i> <span id="captureAgainLabel">开始截图</span></button>
          <button id="captureSave" class="capture-save" disabled><i class="ri-save-3-line"></i> 保存 PNG</button>
        </div>
      </header>
      <div id="captureStage" class="capture-stage">
        <div id="captureLoading" class="capture-loading" data-state="ready"><i class="ri-screenshot-2-line"></i><strong>准备截图</strong><span>点击“开始截图”，然后在屏幕上拖动选择需要标注的范围。</span></div>
        <canvas id="captureCanvas" hidden></canvas>
        <div id="captureBrushCursor" class="capture-brush-cursor" hidden aria-hidden="true"></div>
        <textarea id="captureInlineText" class="capture-inline-text" maxlength="500" rows="1" hidden aria-label="输入文字标注" spellcheck="false"></textarea>
      </div>
      <footer><span id="captureStatus"><i class="ri-information-line"></i> ${footerStatus}</span><span class="capture-shortcuts"><kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销　<kbd>Delete</kbd> 删除选中标注</span></footer>
      ${longCaptureDialog}
    </div>`;
}

function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height
    };
}

function line(a, b) {
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
}

function textMetrics(object) {
    const fontSize = object.fontSize || Math.max(18, object.size * 4);
    context.font = `600 ${fontSize}px system-ui`;
    const lines = String(object.text || '').split('\n');
    return {
        fontSize,
        lines,
        width: Math.max(fontSize, ...lines.map(value => context.measureText(value || ' ').width)),
        height: Math.max(fontSize * 1.3, lines.length * fontSize * 1.3)
    };
}

function objectBounds(object) {
    if (object.type === 'pen') {
        const xs = object.points.map(point => point.x);
        const ys = object.points.map(point => point.y);
        return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    }
    if (object.type === 'text') {
        const metrics = textMetrics(object);
        return { left: object.start.x, top: object.start.y, right: object.start.x + metrics.width, bottom: object.start.y + metrics.height };
    }
    return {
        left: Math.min(object.start.x, object.end.x),
        top: Math.min(object.start.y, object.end.y),
        right: Math.max(object.start.x, object.end.x),
        bottom: Math.max(object.start.y, object.end.y)
    };
}

function drawShape(object) {
    const left = Math.min(object.start.x, object.end.x);
    const top = Math.min(object.start.y, object.end.y);
    const width = Math.abs(object.end.x - object.start.x);
    const height = Math.abs(object.end.y - object.start.y);
    if (object.type === 'rect') {
        if (object.style === 'fill') context.fillRect(left, top, width, height);
        else context.strokeRect(left, top, width, height);
    } else if (object.type === 'ellipse') {
        context.beginPath();
        context.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        if (object.style === 'fill') context.fill(); else context.stroke();
    } else if (object.type === 'line') {
        line(object.start, object.end);
    } else if (object.type === 'arrow') {
        line(object.start, object.end);
        const angle = Math.atan2(object.end.y - object.start.y, object.end.x - object.start.x);
        const head = Math.max(14, object.size * 4);
        line(object.end, { x: object.end.x - head * Math.cos(angle - Math.PI / 6), y: object.end.y - head * Math.sin(angle - Math.PI / 6) });
        line(object.end, { x: object.end.x - head * Math.cos(angle + Math.PI / 6), y: object.end.y - head * Math.sin(angle + Math.PI / 6) });
    }
}

function drawObject(object) {
    context.save();
    context.strokeStyle = object.color;
    context.fillStyle = object.color;
    context.lineWidth = object.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (object.type === 'pen') {
        context.beginPath();
        object.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.stroke();
    } else if (SHAPE_MODES.has(object.type)) {
        drawShape(object);
    } else if (object.type === 'text') {
        const metrics = textMetrics(object);
        context.font = `600 ${metrics.fontSize}px system-ui`;
        context.textBaseline = 'alphabetic';
        metrics.lines.forEach((value, index) => context.fillText(value, object.start.x, object.start.y + metrics.fontSize + index * metrics.fontSize * 1.3));
    }
    context.restore();
}

function drawSelection() {
    if (selectedIndex < 0 || !objects[selectedIndex] || editingTextIndex === selectedIndex) return;
    const bounds = objectBounds(objects[selectedIndex]);
    const padding = Math.max(5, 5 / zoom);
    context.save();
    context.strokeStyle = '#2f7de1';
    context.lineWidth = Math.max(1, 1.5 / zoom);
    context.setLineDash([6 / zoom, 4 / zoom]);
    context.strokeRect(bounds.left - padding, bounds.top - padding, bounds.right - bounds.left + padding * 2, bounds.bottom - bounds.top + padding * 2);
    context.restore();
}

function render() {
    frame = 0;
    if (!background || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    roundedRectPath(context, 0, 0, canvas.width, canvas.height, cornerRadius);
    context.clip();
    context.drawImage(background, 0, 0, canvas.width, canvas.height);
    objects.forEach((object, index) => { if (index !== editingTextIndex) drawObject(object); });
    if (active) drawObject(active);
    drawSelection();
    context.restore();
    canvas.dataset.annotationCount = String(objects.length);
    canvas.dataset.selectedIndex = String(selectedIndex);
    canvas.dataset.cornerRadius = String(cornerRadius);
}

function roundedRectPath(target, x, y, width, height, radius) {
    const bounded = Math.max(0, Math.min(radius, width / 2, height / 2));
    target.beginPath();
    target.roundRect(x, y, width, height, bounded);
}

function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
}

function applyZoom() {
    if (!canvas || !background) return;
    canvas.style.width = `${Math.max(1, Math.round(canvas.width * zoom))}px`;
    canvas.style.height = `${Math.max(1, Math.round(canvas.height * zoom))}px`;
    byId('captureZoomValue').textContent = `${Math.round(zoom * 100)}%`;
}

function fitZoom() {
    if (!canvas || !background) return;
    const stage = byId('captureStage');
    zoomMode = 'fit';
    zoom = Math.max(MIN_ZOOM, Math.min(1, (stage.clientWidth - 32) / canvas.width, (stage.clientHeight - 32) / canvas.height));
    applyZoom();
}

function changeZoom(delta) {
    if (!background) return;
    zoomMode = 'manual';
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((zoom + delta) * 10) / 10));
    applyZoom();
}

function showLoading(state, title, detail) {
    const loading = byId('captureLoading');
    if (!loading) return;
    loading.dataset.state = state;
    const icons = { ready: 'ri-screenshot-2-line', loading: 'ri-loader-4-line', error: 'ri-error-warning-line' };
    loading.querySelector('i').className = icons[state] || icons.error;
    loading.querySelector('strong').textContent = title;
    loading.querySelector('span').textContent = detail;
}

function updateControls() {
    byId('captureUndo').disabled = captureBusy || objects.length === 0;
    byId('captureSave').disabled = captureBusy || saveBusy || !background;
    byId('captureAgain').disabled = captureBusy;
    ['captureZoomOut', 'captureZoomIn', 'captureZoomFit', 'captureDelete', 'captureLong', 'captureCanvasTrigger'].forEach(id => {
        const control = byId(id);
        if (control) control.disabled = captureBusy || !background;
    });
    byId('captureAgainLabel').textContent = captureBusy
        ? '选择范围中'
        : (background ? '重新截图' : '开始截图');
}

function releaseBackground() {
    if (background) {
        background.onload = null;
        background.onerror = null;
        background.src = '';
    }
    background = null;
}

function imageFromUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('无法读取截图图像'));
        image.src = dataUrl;
    });
}

async function applyCapture(result, current, resetAnnotations = true) {
    const image = await imageFromUrl(result.dataUrl);
    if (current !== captureGeneration || !canvas) {
        image.src = '';
        return;
    }
    releaseBackground();
    background = image;
    canvas.width = result.width;
    canvas.height = result.height;
    if (resetAnnotations) {
        objects = [];
        selectedIndex = -1;
        active = null;
    }
    byId('captureLoading').hidden = true;
    canvas.hidden = false;
    captureBusy = false;
    render();
    requestAnimationFrame(fitZoom);
    byId('captureDimensions').textContent = `${result.width} × ${result.height}`;
    byId('captureStatus').textContent = `${result.width} × ${result.height} · 截图已进入本地标注画布`;
    updateControls();
}

async function capture(options = {}) {
    if (captureBusy) return;
    commitInlineText();
    const current = ++captureGeneration;
    captureBusy = true;
    if (!background) {
        canvas.hidden = true;
        byId('captureLoading').hidden = false;
    }
    showLoading('loading', '请选择截图范围', '在屏幕上拖动选择区域；按 Esc 或右键可以取消。');
    byId('captureStatus').textContent = options.longDirection ? '请选择需要自动滚动的固定区域。' : '正在等待你选择截图范围。';
    updateControls();
    try {
        let result = await new Promise((resolve, reject) => {
            pendingRegionCapture = { current, resolve };
            invoke('start_screen_region_capture', options).catch(error => {
                if (pendingRegionCapture?.current === current) pendingRegionCapture = null;
                reject(error);
            });
        });
        if (!result) {
            if (current !== captureGeneration) return;
            captureBusy = false;
            if (background) {
                byId('captureLoading').hidden = true;
                canvas.hidden = false;
            } else {
                showLoading('ready', '已取消截图', '点击“开始截图”可重新选择需要截取的屏幕范围。');
            }
            byId('captureStatus').textContent = '截图已取消，原有内容保持不变。';
            updateControls();
            return;
        }
        await applyCapture(result, current, true);
        if (options.longDirection) byId('captureStatus').textContent = `${result.width} × ${result.height} · 自动长截图已完成`;
    } catch (error) {
        if (current !== captureGeneration) return;
        captureBusy = false;
        showLoading('error', '截图失败', String(error));
        updateControls();
    }
}

function hitTestObject(point) {
    const padding = Math.max(8, 8 / zoom);
    for (let index = objects.length - 1; index >= 0; index -= 1) {
        const bounds = objectBounds(objects[index]);
        if (point.x >= bounds.left - padding && point.x <= bounds.right + padding
            && point.y >= bounds.top - padding && point.y <= bounds.bottom + padding) return index;
    }
    return -1;
}

function translateObject(object, original, dx, dy) {
    if (object.type === 'pen') {
        object.points = original.points.map(point => ({ x: point.x + dx, y: point.y + dy }));
    } else if (object.type === 'text') {
        object.start = { x: original.start.x + dx, y: original.start.y + dy };
    } else {
        object.start = { x: original.start.x + dx, y: original.start.y + dy };
        object.end = { x: original.end.x + dx, y: original.end.y + dy };
    }
}

function pointerDown(event) {
    if (!background || event.button !== 0 || event.ctrlKey) return;
    commitInlineText();
    const start = canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    if (mode === 'select') {
        selectedIndex = hitTestObject(start);
        dragState = selectedIndex >= 0
            ? { index: selectedIndex, start, original: structuredClone(objects[selectedIndex]) }
            : null;
        render();
        return;
    }
    selectedIndex = -1;
    if (mode === 'text') {
        event.preventDefault();
        startInlineText(start);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        return;
    }
    active = mode === 'pen'
        ? { type: 'pen', points: [start], color, size }
        : { type: mode, start, end: start, color, size, style: shapeStyle };
}

function pointerMove(event) {
    updateBrushCursor(event);
    if (dragState && mode === 'select') {
        const current = canvasPoint(event);
        translateObject(objects[dragState.index], dragState.original, current.x - dragState.start.x, current.y - dragState.start.y);
        scheduleRender();
        return;
    }
    if (!active) return;
    const current = canvasPoint(event);
    if (active.type === 'pen') active.points.push(current); else active.end = current;
    scheduleRender();
}

function pointerUp(event) {
    if (dragState) {
        dragState = null;
        render();
        return;
    }
    if (!active) return;
    const finished = active;
    active = null;
    if (finished.type === 'pen' ? finished.points.length > 1 : Math.hypot(finished.end.x - finished.start.x, finished.end.y - finished.start.y) > 2) {
        objects.push(finished);
        selectedIndex = objects.length - 1;
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    render();
    updateControls();
}

function startInlineText(point, index = -1) {
    const editor = byId('captureInlineText');
    const object = index >= 0 ? objects[index] : null;
    editingTextIndex = index;
    selectedIndex = index;
    editor.value = object?.text || '';
    editor.dataset.x = String(object?.start.x ?? point.x);
    editor.dataset.y = String(object?.start.y ?? point.y);
    editor.hidden = false;
    const canvasRect = canvas.getBoundingClientRect();
    const x = Number(editor.dataset.x);
    const y = Number(editor.dataset.y);
    const scale = canvasRect.width / canvas.width;
    editor.style.left = `${canvas.offsetLeft + x * scale}px`;
    editor.style.top = `${canvas.offsetTop + y * scale}px`;
    editor.style.fontSize = `${Math.max(13, (object?.fontSize || Math.max(18, size * 4)) * scale)}px`;
    editor.style.color = object?.color || color;
    resizeInlineText();
    editor.focus();
    editor.select();
    render();
}

function resizeInlineText() {
    const editor = byId('captureInlineText');
    if (!editor || editor.hidden) return;
    editor.style.width = '1px';
    editor.style.height = '1px';
    editor.style.width = `${Math.min(420, Math.max(72, editor.scrollWidth + 12))}px`;
    editor.style.height = `${Math.min(220, Math.max(32, editor.scrollHeight + 4))}px`;
}

function commitInlineText(cancel = false) {
    const editor = byId('captureInlineText');
    if (!editor || editor.hidden) return;
    const index = editingTextIndex;
    const value = editor.value.trim();
    if (!cancel) {
        if (index >= 0) {
            if (value) objects[index].text = value;
            else objects.splice(index, 1);
        } else if (value) {
            objects.push({
                type: 'text',
                text: value,
                start: { x: Number(editor.dataset.x), y: Number(editor.dataset.y) },
                color,
                size,
                fontSize: Math.max(18, size * 4)
            });
            selectedIndex = objects.length - 1;
        }
    }
    editor.hidden = true;
    editor.removeAttribute('style');
    editor.value = '';
    editingTextIndex = -1;
    render();
    updateControls();
}

function doubleClick(event) {
    if (mode !== 'select' || !background) return;
    const index = hitTestObject(canvasPoint(event));
    if (index >= 0 && objects[index].type === 'text') startInlineText(objects[index].start, index);
}

function updateBrushCursor(event) {
    const cursor = byId('captureBrushCursor');
    if (!cursor || mode !== 'pen' || !background || event.ctrlKey) {
        if (cursor) cursor.hidden = true;
        return;
    }
    const stageRect = byId('captureStage').getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const inside = event.clientX >= canvasRect.left && event.clientX <= canvasRect.right && event.clientY >= canvasRect.top && event.clientY <= canvasRect.bottom;
    if (!inside) { cursor.hidden = true; return; }
    const diameter = Math.max(4, size * canvasRect.width / canvas.width);
    cursor.hidden = false;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
    cursor.style.transform = `translate3d(${event.clientX - stageRect.left - diameter / 2}px,${event.clientY - stageRect.top - diameter / 2}px,0)`;
}

function setPanReady(ready) {
    const stage = byId('captureStage');
    if (stage) stage.dataset.panReady = String(Boolean(ready));
}

function beginPan(event) {
    if (!background || !event.ctrlKey || event.button !== 0) return;
    const stage = byId('captureStage');
    pan = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.dataset.panning = 'true';
    event.preventDefault();
    event.stopPropagation();
}

function movePan(event) {
    if (!pan) return;
    const stage = byId('captureStage');
    stage.scrollLeft = pan.left - (event.clientX - pan.x);
    stage.scrollTop = pan.top - (event.clientY - pan.y);
}

function endPan() {
    pan = null;
    const stage = byId('captureStage');
    if (stage) stage.dataset.panning = 'false';
}

async function undo() {
    commitInlineText();
    if (objects.length) {
        objects.pop();
        selectedIndex = -1;
        render();
    }
    updateControls();
}

function clearCapture() {
    captureGeneration += 1;
    commitInlineText(true);
    objects = [];
    active = null;
    selectedIndex = -1;
    dragState = null;
    releaseBackground();
    canvas.hidden = true;
    canvas.removeAttribute('style');
    byId('captureLoading').hidden = false;
    showLoading('ready', '截图已移除', '点击“开始截图”重新选择范围。');
    byId('captureDimensions').textContent = '等待截图';
    byId('captureStatus').textContent = '当前没有截图，相关像素已经从内存释放。';
    zoom = 1;
    zoomMode = 'fit';
    byId('captureZoomValue').textContent = '100%';
    updateControls();
}

async function save() {
    if (!background || saveBusy) return;
    commitInlineText();
    selectedIndex = -1;
    render();
    saveBusy = true;
    updateControls();
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = await invoke('save_annotated_screenshot', { filename: `DtKit-${stamp}.png`, dataUrl: canvas.toDataURL('image/png') });
        byId('captureStatus').textContent = `已保存：${path}`;
    } catch (error) {
        byId('captureStatus').textContent = `保存失败：${String(error)}`;
    } finally {
        saveBusy = false;
        updateControls();
    }
}

function openLongDialog() {
    if (!background) return;
    byId('captureLongDialog').showModal();
}

async function startLongCapture() {
    const direction = document.querySelector('[data-long-direction].is-active')?.dataset.longDirection || 'vertical';
    const maxSegments = Math.max(2, Math.min(20, Number(byId('captureLongSegments').value) || 12));
    byId('captureLongDialog').close();
    await capture({ longDirection: direction, maxSegments });
}

function closeToolMenus(exceptId = '') {
    document.querySelectorAll('.capture-tool-menu').forEach(menu => {
        if (menu.id === exceptId) return;
        menu.hidden = true;
        const trigger = menu.parentElement?.querySelector('[aria-expanded]');
        trigger?.setAttribute('aria-expanded', 'false');
    });
}

function toggleToolMenu(menuId, triggerId) {
    const menu = byId(menuId);
    const trigger = byId(triggerId);
    const opening = menu.hidden;
    closeToolMenus(opening ? menuId : '');
    menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
        const rect = trigger.getBoundingClientRect();
        const width = menu.offsetWidth || 248;
        menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
        menu.style.top = `${Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 7)}px`;
    }
}

async function init() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    canvas = byId('captureCanvas');
    context = canvas?.getContext('2d', { alpha: true });
    canvas.dataset.mode = mode;
    unlistenRegionCapture?.();
    unlistenRegionCapture = await listen('screen-region-captured', event => {
        const pending = pendingRegionCapture;
        if (!pending) return;
        pendingRegionCapture = null;
        pending.resolve(event.payload?.cancelled ? null : event.payload?.capture || null);
    });
    canvas.addEventListener('pointerdown', pointerDown, { signal });
    canvas.addEventListener('pointermove', pointerMove, { signal });
    canvas.addEventListener('pointerup', pointerUp, { signal });
    canvas.addEventListener('pointercancel', pointerUp, { signal });
    canvas.addEventListener('dblclick', doubleClick, { signal });
    canvas.addEventListener('pointerleave', () => { byId('captureBrushCursor').hidden = true; }, { signal });
    const stage = byId('captureStage');
    stage.dataset.panReady = 'false';
    stage.addEventListener('pointerdown', beginPan, { signal, capture: true });
    stage.addEventListener('pointermove', movePan, { signal });
    stage.addEventListener('pointerup', endPan, { signal });
    stage.addEventListener('pointercancel', endPan, { signal });
    document.querySelectorAll('[data-capture-mode]').forEach(button => button.addEventListener('click', event => {
        if (button.id === 'captureShapeTrigger') {
            event.preventDefault();
            commitInlineText();
            mode = currentShape;
            document.querySelectorAll('[data-capture-mode]').forEach(node => {
                const selected = node === button;
                node.classList.toggle('is-active', selected);
                node.setAttribute('aria-pressed', String(selected));
            });
            canvas.dataset.mode = mode;
            toggleToolMenu('captureShapeMenu', 'captureShapeTrigger');
            render();
            return;
        }
        commitInlineText();
        mode = button.id === 'captureShapeTrigger' ? currentShape : button.dataset.captureMode;
        document.querySelectorAll('[data-capture-mode]').forEach(node => {
            const selected = node === button;
            node.classList.toggle('is-active', selected);
            node.setAttribute('aria-pressed', String(selected));
        });
        canvas.dataset.mode = mode;
        if (mode !== 'select') selectedIndex = -1;
        if (mode !== 'pen') byId('captureBrushCursor').hidden = true;
        render();
    }, { signal }));
    document.querySelectorAll('[data-shape-mode]').forEach(button => button.addEventListener('click', () => {
        currentShape = button.dataset.shapeMode;
        mode = currentShape;
        const trigger = byId('captureShapeTrigger');
        trigger.dataset.captureMode = currentShape;
        trigger.querySelector('i:first-child').className = button.querySelector('i').className;
        trigger.querySelector('span').textContent = button.querySelector('span').textContent;
        document.querySelectorAll('[data-shape-mode]').forEach(node => node.classList.toggle('is-active', node === button));
        document.querySelectorAll('[data-capture-mode]').forEach(node => {
            const selected = node === trigger;
            node.classList.toggle('is-active', selected);
            node.setAttribute('aria-pressed', String(selected));
        });
        canvas.dataset.mode = mode;
        closeToolMenus();
        render();
    }, { signal }));
    document.querySelectorAll('[data-shape-style]').forEach(button => button.addEventListener('click', () => {
        shapeStyle = button.dataset.shapeStyle;
        document.querySelectorAll('[data-shape-style]').forEach(node => {
            const selected = node === button;
            node.classList.toggle('is-active', selected);
            node.setAttribute('aria-pressed', String(selected));
        });
    }, { signal }));
    document.querySelectorAll('[data-long-direction]').forEach(button => button.addEventListener('click', () => {
        document.querySelectorAll('[data-long-direction]').forEach(node => {
            const selected = node === button;
            node.classList.toggle('is-active', selected);
            node.setAttribute('aria-pressed', String(selected));
        });
    }, { signal }));
    byId('captureColor').addEventListener('input', event => { color = event.target.value; }, { signal });
    byId('captureSize').addEventListener('input', event => {
        size = Number(event.target.value);
        byId('captureSizeValue').value = `${size} px`;
    }, { signal });
    byId('captureInlineText').addEventListener('input', resizeInlineText, { signal });
    byId('captureInlineText').addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); commitInlineText(true); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitInlineText(); }
    }, { signal });
    byId('captureInlineText').addEventListener('blur', () => commitInlineText(), { signal });
    byId('captureUndo').addEventListener('click', undo, { signal });
    byId('captureZoomOut').addEventListener('click', () => changeZoom(-0.1), { signal });
    byId('captureZoomIn').addEventListener('click', () => changeZoom(0.1), { signal });
    byId('captureZoomFit').addEventListener('click', fitZoom, { signal });
    byId('captureDelete').addEventListener('click', clearCapture, { signal });
    byId('captureAgain').addEventListener('click', capture, { signal });
    byId('captureSave').addEventListener('click', save, { signal });
    byId('captureLong')?.addEventListener('click', openLongDialog, { signal });
    byId('captureLongStart')?.addEventListener('click', startLongCapture, { signal });
    byId('captureLongCancel')?.addEventListener('click', () => byId('captureLongDialog')?.close(), { signal });
    byId('captureCanvasTrigger').addEventListener('click', () => toggleToolMenu('captureCanvasMenu', 'captureCanvasTrigger'), { signal });
    byId('captureCornerRadius').addEventListener('input', event => {
        cornerRadius = Number(event.target.value);
        byId('captureCornerRadiusValue').value = `${cornerRadius} px`;
        render();
    }, { signal });
    document.addEventListener('pointerdown', event => {
        if (!event.target.closest('.capture-tool-group')) closeToolMenus();
    }, { signal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Control') setPanReady(true);
        if (event.key === 'Delete' && selectedIndex >= 0 && byId('captureInlineText').hidden) {
            objects.splice(selectedIndex, 1);
            selectedIndex = -1;
            render();
            updateControls();
        }
        if (event.ctrlKey && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            undo();
        }
    }, { signal });
    document.addEventListener('keyup', event => { if (event.key === 'Control') setPanReady(false); }, { signal });
    window.addEventListener('blur', () => { pan = null; setPanReady(false); byId('captureBrushCursor').hidden = true; }, { signal });
    stageResizeObserver?.disconnect();
    stageResizeObserver = new ResizeObserver(() => { if (zoomMode === 'fit') fitZoom(); });
    stageResizeObserver.observe(stage);
    updateControls();
    if (isQuickHost()) await capture();
}

function destroy() {
    controller?.abort();
    controller = null;
    stageResizeObserver?.disconnect();
    stageResizeObserver = null;
    unlistenRegionCapture?.();
    unlistenRegionCapture = null;
    pendingRegionCapture?.resolve(null);
    pendingRegionCapture = null;
    captureGeneration += 1;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    objects = [];
    active = null;
    selectedIndex = -1;
    dragState = null;
    pan = null;
    editingTextIndex = -1;
    captureBusy = false;
    saveBusy = false;
    releaseBackground();
    context = null;
    canvas = null;
}

registerTool({
    id: 'screenshot-annotator',
    name: '截图与标注',
    icon: 'ri-screenshot-2-line',
    colorClass: 'tool-card__icon--orange',
    category: 'design',
    status: 'ready',
    description: '区域截图、实时文字、可编辑标注、多种形状与横向/纵向长图拼接。',
    template,
    init,
    destroy
});
