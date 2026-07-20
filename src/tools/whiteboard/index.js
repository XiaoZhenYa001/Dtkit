import { registerTool } from '../toolRegistry.js';
import {
    MAX_POINTS,
    compactStrokes,
    deserializeBoard,
    normalizePoint,
    serializeBoard
} from './core.js';
import '../../css/tools/whiteboard.css';

const BOARD_STORAGE_KEY = 'dtkit_whiteboard_v1';
const BOARD_PREFS_KEY = 'dtkit_whiteboard_preferences_v1';
const STORAGE_CHAR_LIMIT = 1_250_000;
const DEFAULT_COLOR = '#242937';

const state = {
    canvas: null,
    context: null,
    surface: null,
    strokes: [],
    redoStrokes: [],
    activeStroke: null,
    pointerId: null,
    mode: 'pen',
    color: DEFAULT_COLOR,
    width: 4,
    gridEnabled: true,
    logicalWidth: 1,
    logicalHeight: 1,
    pixelRatio: 1,
    abortController: null,
    resizeObserver: null,
    resizeFrame: null,
    saveTimer: null,
    strokeSequence: 0,
};

function getTemplate() {
    return `
        <div class="whiteboard-tool">
            <header class="whiteboard-hero">
                <div>
                    <span class="whiteboard-kicker">LOCAL CANVAS</span>
                    <h2>白板</h2>
                    <p>随手书写、标注和推演。笔迹只保存在本机，不启动后台任务。</p>
                </div>
                <span class="whiteboard-local-badge"><i class="ri-shield-check-line" aria-hidden="true"></i> 本地自动保存</span>
            </header>

            <div class="whiteboard-toolbar" role="toolbar" aria-label="白板工具栏">
                <div class="whiteboard-tool-group whiteboard-mode-group" aria-label="绘制工具">
                    <button type="button" data-board-mode="pen" aria-pressed="true" title="画笔 (B)"><i class="ri-brush-2-line"></i><span>画笔</span></button>
                    <button type="button" data-board-mode="highlighter" aria-pressed="false" title="荧光笔 (H)"><i class="ri-mark-pen-line"></i><span>标记</span></button>
                    <button type="button" data-board-mode="eraser" aria-pressed="false" title="橡皮擦 (E)"><i class="ri-eraser-line"></i><span>橡皮</span></button>
                </div>

                <div class="whiteboard-tool-group whiteboard-colors" aria-label="画笔颜色">
                    <button class="whiteboard-color whiteboard-color--ink" type="button" data-board-color="#242937" aria-label="墨黑" aria-pressed="true"></button>
                    <button class="whiteboard-color whiteboard-color--orange" type="button" data-board-color="#d96f3d" aria-label="暖橙" aria-pressed="false"></button>
                    <button class="whiteboard-color whiteboard-color--blue" type="button" data-board-color="#3f6d74" aria-label="深蓝" aria-pressed="false"></button>
                    <button class="whiteboard-color whiteboard-color--green" type="button" data-board-color="#3f8061" aria-label="墨绿" aria-pressed="false"></button>
                    <label class="whiteboard-color-picker" title="自定义颜色"><i class="ri-palette-line" aria-hidden="true"></i><input id="whiteboardColorInput" type="color" value="#242937" aria-label="自定义画笔颜色"></label>
                </div>

                <label class="whiteboard-size-control" for="whiteboardSize">
                    <span>笔宽</span><input id="whiteboardSize" type="range" min="1" max="24" step="1" value="4"><output id="whiteboardSizeValue">4 px</output>
                </label>

                <div class="whiteboard-tool-group whiteboard-history-group" aria-label="历史操作">
                    <button id="whiteboardUndo" type="button" title="撤销 (Ctrl+Z)" disabled><i class="ri-arrow-go-back-line"></i><span>撤销</span></button>
                    <button id="whiteboardRedo" type="button" title="重做 (Ctrl+Y)" disabled><i class="ri-arrow-go-forward-line"></i><span>重做</span></button>
                </div>

                <div class="whiteboard-tool-group whiteboard-action-group" aria-label="白板操作">
                    <button id="whiteboardGrid" type="button" aria-pressed="true" title="显示或隐藏点阵 (G)"><i class="ri-layout-grid-line"></i></button>
                    <button id="whiteboardExport" type="button" title="导出 PNG"><i class="ri-download-2-line"></i><span>导出</span></button>
                    <button id="whiteboardClear" class="whiteboard-danger-action" type="button" title="清空白板"><i class="ri-delete-bin-6-line"></i></button>
                </div>
            </div>

            <section class="whiteboard-stage" aria-label="白板画布">
                <div class="whiteboard-surface whiteboard-surface--grid is-empty" id="whiteboardSurface">
                    <canvas id="whiteboardCanvas" aria-label="可使用鼠标、触控或触控笔书写的白板"></canvas>
                    <div class="whiteboard-empty-hint" aria-hidden="true"><i class="ri-edit-line"></i><strong>从这里开始书写</strong><span>支持鼠标、触控和压感笔</span></div>
                </div>
                <footer class="whiteboard-statusbar">
                    <span id="whiteboardStatus"><i></i> 本地已保存</span>
                    <span id="whiteboardStrokeCount">0 笔</span>
                    <span class="whiteboard-shortcuts">B 画笔 · H 标记 · E 橡皮 · Ctrl Z 撤销</span>
                </footer>
            </section>
        </div>
    `;
}

function readPreferences() {
    try {
        const parsed = JSON.parse(localStorage.getItem(BOARD_PREFS_KEY) || '{}');
        if (['pen', 'highlighter', 'eraser'].includes(parsed.mode)) state.mode = parsed.mode;
        if (/^#[0-9a-f]{6}$/i.test(parsed.color)) state.color = parsed.color.toLowerCase();
        const width = Number(parsed.width);
        if (Number.isFinite(width)) state.width = Math.min(24, Math.max(1, width));
    } catch {
        state.mode = 'pen';
        state.color = DEFAULT_COLOR;
        state.width = 4;
    }
}

function savePreferences() {
    try {
        localStorage.setItem(BOARD_PREFS_KEY, JSON.stringify({
            mode: state.mode,
            color: state.color,
            width: state.width
        }));
    } catch {
        // 偏好很小；存储不可用时继续保留当前会话设置。
    }
}

function readBoard() {
    const saved = deserializeBoard(localStorage.getItem(BOARD_STORAGE_KEY));
    state.strokes = saved.strokes;
    state.gridEnabled = saved.gridEnabled;
    state.redoStrokes = [];
}

function statusElement() {
    return document.getElementById('whiteboardStatus');
}

function setStatus(message, tone = 'saved') {
    const element = statusElement();
    if (!element) return;
    element.className = `whiteboard-status whiteboard-status--${tone}`;
    element.innerHTML = `<i></i> ${message}`;
}

function persistBoard() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.strokes = compactStrokes(state.strokes);
    let pointLimit = MAX_POINTS;
    let serialized = serializeBoard(state.strokes, state.gridEnabled);

    while (serialized.length > STORAGE_CHAR_LIMIT && pointLimit > 2_000) {
        pointLimit = Math.floor(pointLimit * 0.75);
        state.strokes = compactStrokes(state.strokes, 300, pointLimit);
        serialized = serializeBoard(state.strokes, state.gridEnabled);
    }

    try {
        localStorage.setItem(BOARD_STORAGE_KEY, serialized);
        setStatus('本地已保存');
    } catch (error) {
        console.warn('[Whiteboard] 无法保存白板:', error);
        setStatus('本地空间不足，当前笔迹仅保留在内存', 'warning');
    }
    updateControls();
}

function scheduleSave() {
    clearTimeout(state.saveTimer);
    setStatus('正在保存…', 'saving');
    state.saveTimer = setTimeout(persistBoard, 450);
}

function strokeStyle(context, stroke) {
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.globalAlpha = stroke.tool === 'highlighter' ? 0.28 : 1;
    context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
}

function pointWidth(stroke, point) {
    const toolMultiplier = stroke.tool === 'eraser' ? 2.25 : (stroke.tool === 'highlighter' ? 2.6 : 1);
    const pressureMultiplier = stroke.tool === 'highlighter' ? 1 : 0.65 + (point[2] || 0.5) * 0.7;
    return stroke.width * toolMultiplier * pressureMultiplier;
}

function drawStroke(context, stroke, width, height, startIndex = 0) {
    if (!stroke.points.length) return;
    context.save();
    strokeStyle(context, stroke);

    if (stroke.points.length === 1) {
        const point = stroke.points[0];
        context.beginPath();
        context.arc(point[0] * width, point[1] * height, pointWidth(stroke, point) / 2, 0, Math.PI * 2);
        context.fill();
        context.restore();
        return;
    }

    const firstSegment = Math.max(1, startIndex + 1);
    for (let index = firstSegment; index < stroke.points.length; index += 1) {
        const previous = stroke.points[index - 1];
        const current = stroke.points[index];
        context.beginPath();
        context.lineWidth = pointWidth(stroke, current);
        context.moveTo(previous[0] * width, previous[1] * height);
        context.lineTo(current[0] * width, current[1] * height);
        context.stroke();
    }
    context.restore();
}

function redrawBoard() {
    if (!state.context) return;
    state.context.save();
    state.context.globalCompositeOperation = 'source-over';
    state.context.clearRect(0, 0, state.logicalWidth, state.logicalHeight);
    state.context.restore();
    state.strokes.forEach(stroke => drawStroke(
        state.context,
        stroke,
        state.logicalWidth,
        state.logicalHeight
    ));
    state.surface?.classList.toggle('is-empty', state.strokes.length === 0);
}

function resizeCanvas() {
    state.resizeFrame = null;
    if (!state.canvas || !state.surface) return;
    const rect = state.surface.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    const pixelWidth = Math.floor(width * pixelRatio);
    const pixelHeight = Math.floor(height * pixelRatio);
    if (state.canvas.width === pixelWidth && state.canvas.height === pixelHeight) return;

    state.logicalWidth = width;
    state.logicalHeight = height;
    state.pixelRatio = pixelRatio;
    state.canvas.width = pixelWidth;
    state.canvas.height = pixelHeight;
    state.context = state.canvas.getContext('2d', { alpha: true, desynchronized: true });
    state.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    redrawBoard();
}

function scheduleResize() {
    if (state.resizeFrame !== null) return;
    state.resizeFrame = requestAnimationFrame(resizeCanvas);
}

function eventPoint(event) {
    const rect = state.canvas.getBoundingClientRect();
    const pressure = event.pointerType === 'mouse' ? 0.5 : (event.pressure || 0.5);
    return normalizePoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, pressure);
}

function appendPoint(event) {
    if (!state.activeStroke) return;
    const point = eventPoint(event);
    const previous = state.activeStroke.points.at(-1);
    if (previous) {
        const distance = Math.hypot(
            (point[0] - previous[0]) * state.logicalWidth,
            (point[1] - previous[1]) * state.logicalHeight
        );
        if (distance < 1.25) return;
    }
    state.activeStroke.points.push(point);
    drawStroke(
        state.context,
        state.activeStroke,
        state.logicalWidth,
        state.logicalHeight,
        Math.max(0, state.activeStroke.points.length - 2)
    );
}

function beginStroke(event) {
    if (event.button !== 0 || state.pointerId !== null) return;
    event.preventDefault();
    state.pointerId = event.pointerId;
    state.canvas.setPointerCapture?.(event.pointerId);
    state.activeStroke = {
        id: `${Date.now().toString(36)}-${state.strokeSequence++}`,
        tool: state.mode,
        color: state.color,
        width: state.width,
        points: []
    };
    appendPoint(event);
}

function moveStroke(event) {
    if (event.pointerId !== state.pointerId || !state.activeStroke) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    events.forEach(appendPoint);
}

function finishStroke(event = null) {
    if (!state.activeStroke || (event && event.pointerId !== state.pointerId)) return;
    if (event) appendPoint(event);
    const completed = state.activeStroke;
    try {
        if (state.pointerId !== null) state.canvas?.releasePointerCapture?.(state.pointerId);
    } catch {
        // 指针可能已由系统释放。
    }
    state.activeStroke = null;
    state.pointerId = null;
    if (completed.points.length === 0) return;
    state.strokes.push(completed);
    state.strokes = compactStrokes(state.strokes);
    state.redoStrokes = [];
    redrawBoard();
    updateControls();
    scheduleSave();
}

function updateControls() {
    document.querySelectorAll('[data-board-mode]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.boardMode === state.mode));
    });
    document.querySelectorAll('[data-board-color]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.boardColor === state.color));
    });
    const colorInput = document.getElementById('whiteboardColorInput');
    if (colorInput) colorInput.value = state.color;
    const sizeInput = document.getElementById('whiteboardSize');
    const sizeValue = document.getElementById('whiteboardSizeValue');
    if (sizeInput) sizeInput.value = String(state.width);
    if (sizeValue) sizeValue.textContent = `${state.width} px`;
    const undo = document.getElementById('whiteboardUndo');
    const redo = document.getElementById('whiteboardRedo');
    if (undo) undo.disabled = state.strokes.length === 0;
    if (redo) redo.disabled = state.redoStrokes.length === 0;
    const grid = document.getElementById('whiteboardGrid');
    if (grid) grid.setAttribute('aria-pressed', String(state.gridEnabled));
    state.surface?.classList.toggle('whiteboard-surface--grid', state.gridEnabled);
    state.surface?.classList.toggle('is-empty', state.strokes.length === 0);
    const count = document.getElementById('whiteboardStrokeCount');
    if (count) count.textContent = `${state.strokes.length} 笔`;
}

function setMode(mode) {
    if (!['pen', 'highlighter', 'eraser'].includes(mode)) return;
    state.mode = mode;
    updateControls();
    savePreferences();
}

function setColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    state.color = color.toLowerCase();
    if (state.mode === 'eraser') state.mode = 'pen';
    updateControls();
    savePreferences();
}

function undo() {
    const stroke = state.strokes.pop();
    if (!stroke) return;
    state.redoStrokes.push(stroke);
    redrawBoard();
    updateControls();
    scheduleSave();
}

function redo() {
    const stroke = state.redoStrokes.pop();
    if (!stroke) return;
    state.strokes.push(stroke);
    redrawBoard();
    updateControls();
    scheduleSave();
}

function toggleGrid() {
    state.gridEnabled = !state.gridEnabled;
    updateControls();
    scheduleSave();
}

function clearBoard() {
    if (state.strokes.length === 0) return;
    if (!globalThis.confirm('确定清空当前白板吗？此操作会删除当前白板的全部笔迹。')) return;
    state.redoStrokes = [];
    state.strokes = [];
    redrawBoard();
    updateControls();
    scheduleSave();
}

function drawExportGrid(context, width, height) {
    if (!state.gridEnabled) return;
    context.save();
    context.fillStyle = 'rgba(115, 121, 137, 0.18)';
    for (let x = 18; x < width; x += 24) {
        for (let y = 18; y < height; y += 24) {
            context.beginPath();
            context.arc(x, y, 0.8, 0, Math.PI * 2);
            context.fill();
        }
    }
    context.restore();
}

function exportBoard() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = state.canvas.width;
    exportCanvas.height = state.canvas.height;
    const context = exportCanvas.getContext('2d');
    context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
    context.fillStyle = '#fffdf9';
    context.fillRect(0, 0, state.logicalWidth, state.logicalHeight);
    drawExportGrid(context, state.logicalWidth, state.logicalHeight);
    state.strokes.forEach(stroke => drawStroke(
        context,
        stroke,
        state.logicalWidth,
        state.logicalHeight
    ));

    exportCanvas.toBlob(blob => {
        if (!blob) {
            setStatus('导出失败，请重试', 'warning');
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `DtKit-白板-${new Date().toISOString().slice(0, 10)}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setStatus('PNG 已导出');
    }, 'image/png');
}

function handleKeyboard(event) {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
    } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        redo();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (key === 'b') setMode('pen');
        if (key === 'h') setMode('highlighter');
        if (key === 'e') setMode('eraser');
        if (key === 'g') toggleGrid();
    }
}

function bindEvents(signal) {
    state.canvas.addEventListener('pointerdown', beginStroke, { signal });
    state.canvas.addEventListener('pointermove', moveStroke, { signal });
    state.canvas.addEventListener('pointerup', finishStroke, { signal });
    state.canvas.addEventListener('pointercancel', finishStroke, { signal });
    document.querySelectorAll('[data-board-mode]').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.boardMode), { signal });
    });
    document.querySelectorAll('[data-board-color]').forEach(button => {
        button.addEventListener('click', () => setColor(button.dataset.boardColor), { signal });
    });
    document.getElementById('whiteboardColorInput')?.addEventListener('input', event => setColor(event.target.value), { signal });
    document.getElementById('whiteboardSize')?.addEventListener('input', event => {
        state.width = Number(event.target.value);
        updateControls();
        savePreferences();
    }, { signal });
    document.getElementById('whiteboardUndo')?.addEventListener('click', undo, { signal });
    document.getElementById('whiteboardRedo')?.addEventListener('click', redo, { signal });
    document.getElementById('whiteboardGrid')?.addEventListener('click', toggleGrid, { signal });
    document.getElementById('whiteboardExport')?.addEventListener('click', exportBoard, { signal });
    document.getElementById('whiteboardClear')?.addEventListener('click', clearBoard, { signal });
    document.addEventListener('keydown', handleKeyboard, { signal });
    window.addEventListener('dtkit:power-state', event => {
        if (event.detail?.suspended) finishStroke();
    }, { signal });
}

function initWhiteboardTool() {
    destroyWhiteboardTool();
    state.abortController = new AbortController();
    state.canvas = document.getElementById('whiteboardCanvas');
    state.surface = document.getElementById('whiteboardSurface');
    if (!state.canvas || !state.surface) return;

    readPreferences();
    readBoard();
    bindEvents(state.abortController.signal);
    if (typeof ResizeObserver === 'function') {
        state.resizeObserver = new ResizeObserver(scheduleResize);
        state.resizeObserver.observe(state.surface);
    } else {
        window.addEventListener('resize', scheduleResize, { signal: state.abortController.signal });
    }
    updateControls();
    scheduleResize();
}

function destroyWhiteboardTool() {
    if (state.activeStroke) finishStroke();
    if (state.saveTimer !== null) persistBoard();
    state.abortController?.abort();
    state.abortController = null;
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = null;
    state.canvas = null;
    state.context = null;
    state.surface = null;
    state.pointerId = null;
    state.activeStroke = null;
}

registerTool({
    id: 'whiteboard',
    name: '白板',
    icon: 'ri-brush-2-line',
    colorClass: 'tool-card__icon--orange',
    category: 'design',
    status: 'ready',
    description: '鼠标、触控和压感笔书写，支持撤销、橡皮擦、本地保存与 PNG 导出。',
    template: getTemplate,
    init: initWhiteboardTool,
    destroy: destroyWhiteboardTool
});

export { destroyWhiteboardTool, initWhiteboardTool };
