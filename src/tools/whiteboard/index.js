import { registerTool } from '../toolRegistry.js';
import '../../css/tools/whiteboard.css';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const DRAFT_DELAY_MS = 60_000;
const MAX_HISTORY = 40;
const MAX_ELEMENTS = 2_000;
const MAX_POINTS = 100_000;
const MAX_STROKE_POINTS = 20_000;
const DEFAULT_COLOR = '#242937';
const LEGACY_KEY = 'dtkit_whiteboard_v1';
const PREFS_KEY = 'dtkit_whiteboard_preferences_v2';

const state = {
    canvas: null, context: null, committedCanvas: null, committedContext: null, surface: null, formulaLayer: null,
    elements: [], undo: [], redo: [], active: null, pointerId: null,
    mode: 'pen', color: DEFAULT_COLOR, width: 4, background: 'dots',
    camera: { x: 0, y: 0, zoom: 1 }, boardId: null, boardName: '未命名白板',
    isFormal: false, dirty: false, readOnly: false, logicalWidth: 1, logicalHeight: 1, pixelRatio: 1,
    abortController: null, resizeObserver: null, resizeFrame: null, drawFrame: null, draftTimer: null,
    formulaRuntime: null, formulaLoading: null, historyObserver: null, histories: [],
    sequence: 0, spacePressed: false, totalPoints: 0, editRevokedUnlisten: null
};

let boundsCache = new WeakMap();
const cloneElements = () => structuredClone(state.elements);
const newId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function getTemplate() {
    return `
        <div class="whiteboard-tool">
            <aside class="whiteboard-history" id="whiteboardHistory" aria-label="历史白板" aria-hidden="true">
                <header><div><span>WHITEBOARDS</span><strong>历史白板</strong></div><button id="whiteboardNew" type="button" title="新建白板"><i class="ri-add-line"></i></button></header>
                <div class="whiteboard-history-list" id="whiteboardHistoryList"></div>
            </aside>
            <button class="whiteboard-history-rail" id="whiteboardHistoryRail" type="button" aria-label="展开历史白板" aria-expanded="false">
                <i class="ri-history-line"></i><span>历史</span><i class="ri-arrow-right-s-line whiteboard-history-rail__arrow"></i>
            </button>

            <header class="whiteboard-hero">
                <div><span class="whiteboard-kicker">INFINITE LOCAL CANVAS</span><h2>无限白板</h2><p>教学、推演与随手记录。正式白板保存在 DtKit 文件管理目录。</p></div>
                <span class="whiteboard-local-badge"><i class="ri-shield-check-line"></i> 60 秒恢复草稿</span>
            </header>

            <div class="whiteboard-toolbar" role="toolbar" aria-label="白板工具栏">
                <input class="whiteboard-name" id="whiteboardName" maxlength="60" value="未命名白板" aria-label="白板名称">
                <div class="whiteboard-cluster" data-board-cluster="draw">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="draw" data-panel-modes="pen,highlighter,eraser" aria-expanded="false">
                        <i class="ri-brush-2-line"></i><span>绘制</span><i class="ri-arrow-down-s-line"></i>
                    </button>
                    <div class="whiteboard-cluster-panel whiteboard-cluster-panel--draw" data-board-panel-content="draw" hidden>
                        <div class="whiteboard-tool-group" aria-label="绘制工具">
                            <button type="button" data-board-mode="pen" aria-pressed="true" title="画笔 (B)"><i class="ri-brush-2-line"></i><span>画笔</span></button>
                            <button type="button" data-board-mode="highlighter" title="荧光笔 (H)"><i class="ri-mark-pen-line"></i><span>标记</span></button>
                            <button type="button" data-board-mode="eraser" title="橡皮擦 (E)"><i class="ri-eraser-line"></i><span>橡皮</span></button>
                        </div>
                        <div class="whiteboard-tool-group whiteboard-colors" aria-label="颜色">
                            <button class="whiteboard-color whiteboard-color--ink" type="button" data-board-color="#242937" aria-label="墨黑"></button>
                            <button class="whiteboard-color whiteboard-color--orange" type="button" data-board-color="#d96f3d" aria-label="暖橙"></button>
                            <button class="whiteboard-color whiteboard-color--blue" type="button" data-board-color="#3f6d74" aria-label="深蓝"></button>
                            <button class="whiteboard-color whiteboard-color--green" type="button" data-board-color="#3f8061" aria-label="墨绿"></button>
                            <label class="whiteboard-color-picker" title="自定义颜色"><i class="ri-palette-line"></i><input id="whiteboardColorInput" type="color" value="#242937"></label>
                        </div>
                        <label class="whiteboard-size-control" for="whiteboardSize"><span>笔宽</span><input id="whiteboardSize" type="range" min="1" max="24" value="4"><output id="whiteboardSizeValue">4 px</output></label>
                    </div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="shape">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="shape" data-panel-modes="line,arrow,rect,ellipse" aria-expanded="false">
                        <i class="ri-shape-line"></i><span>图形</span><i class="ri-arrow-down-s-line"></i>
                    </button>
                    <div class="whiteboard-cluster-panel" data-board-panel-content="shape" hidden>
                        <div class="whiteboard-tool-group whiteboard-shape-group" aria-label="图形工具">
                            <button type="button" data-board-mode="line" title="直线"><i class="ri-subtract-line"></i><span>直线</span></button>
                            <button type="button" data-board-mode="arrow" title="箭头"><i class="ri-arrow-right-line"></i><span>箭头</span></button>
                            <button type="button" data-board-mode="rect" title="矩形"><i class="ri-checkbox-blank-line"></i><span>矩形</span></button>
                            <button type="button" data-board-mode="ellipse" title="椭圆"><i class="ri-checkbox-blank-circle-line"></i><span>椭圆</span></button>
                        </div>
                    </div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="content">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="content" data-panel-modes="text,note,formula" aria-expanded="false">
                        <i class="ri-text"></i><span>内容</span><i class="ri-arrow-down-s-line"></i>
                    </button>
                    <div class="whiteboard-cluster-panel" data-board-panel-content="content" hidden>
                        <div class="whiteboard-tool-group" aria-label="内容工具">
                            <button type="button" data-board-mode="text" title="文字"><i class="ri-text"></i><span>文字</span></button>
                            <button type="button" data-board-mode="note" title="便签"><i class="ri-sticky-note-line"></i><span>便签</span></button>
                            <button type="button" data-board-mode="formula" title="数学表达式"><i class="ri-function-line"></i><span>公式</span></button>
                        </div>
                    </div>
                </div>
                <div class="whiteboard-cluster" data-board-cluster="canvas">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="canvas" data-panel-modes="select,pan" aria-expanded="false">
                        <i class="ri-drag-move-2-line"></i><span>画布</span><i class="ri-arrow-down-s-line"></i>
                    </button>
                    <div class="whiteboard-cluster-panel" data-board-panel-content="canvas" hidden>
                        <div class="whiteboard-tool-group" aria-label="画布工具">
                            <button type="button" data-board-mode="select" title="选择 (V)"><i class="ri-cursor-line"></i><span>选择</span></button>
                            <button type="button" data-board-mode="pan" title="平移 (空格)"><i class="ri-drag-move-2-line"></i><span>平移</span></button>
                            <button id="whiteboardBackground" type="button" title="更换纸张样式"><i class="ri-layout-grid-line"></i><span>纸张</span></button>
                            <button id="whiteboardFit" type="button" title="适应内容"><i class="ri-focus-3-line"></i><span>适应</span></button>
                        </div>
                    </div>
                </div>
                <div class="whiteboard-tool-group whiteboard-history-group">
                    <button id="whiteboardUndo" type="button" title="撤销 (Ctrl+Z)" disabled><i class="ri-arrow-go-back-line"></i></button>
                    <button id="whiteboardRedo" type="button" title="重做 (Ctrl+Y)" disabled><i class="ri-arrow-go-forward-line"></i></button>
                </div>
                <div class="whiteboard-cluster whiteboard-action-group" data-board-cluster="file">
                    <button class="whiteboard-cluster-trigger" type="button" data-board-panel="file" aria-expanded="false">
                        <i class="ri-save-3-line"></i><span>文件</span><i class="ri-arrow-down-s-line"></i>
                    </button>
                    <div class="whiteboard-cluster-panel whiteboard-cluster-panel--end" data-board-panel-content="file" hidden>
                        <div class="whiteboard-tool-group">
                            <button id="whiteboardSave" type="button" title="保存 (Ctrl+S)"><i class="ri-save-3-line"></i><span>保存</span></button>
                            <button id="whiteboardSaveAs" type="button" title="另存为"><i class="ri-file-copy-line"></i><span>另存</span></button>
                            <button id="whiteboardExport" type="button" title="导出 PNG"><i class="ri-download-2-line"></i><span>导出</span></button>
                            <button id="whiteboardClear" class="whiteboard-danger-action" type="button" title="清空"><i class="ri-delete-bin-6-line"></i><span>清空</span></button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="whiteboard-background-menu" id="whiteboardBackgroundMenu" hidden>
                <button data-board-background="blank">纯白</button><button data-board-background="dots">点阵</button>
                <button data-board-background="grid">方格纸</button><button data-board-background="math">数学作业本</button>
                <button data-board-background="ruled">横线纸</button><button data-board-background="english">英语四线三格</button>
            </div>

            <section class="whiteboard-stage" aria-label="无限白板画布">
                <div class="whiteboard-readonly" id="whiteboardReadOnly" hidden>
                    <i class="ri-lock-2-line"></i><span>此白板正在另一窗口编辑</span><button id="whiteboardTakeOver" type="button">接管编辑</button>
                </div>
                <div class="whiteboard-surface is-empty" id="whiteboardSurface">
                    <canvas id="whiteboardCommittedCanvas" aria-hidden="true"></canvas>
                    <canvas id="whiteboardCanvas" aria-label="可无限平移缩放的白板"></canvas>
                    <div class="whiteboard-formula-layer" id="whiteboardFormulaLayer" aria-hidden="true"></div>
                    <div class="whiteboard-empty-hint"><i class="ri-edit-line"></i><strong>从这里开始</strong><span>滚轮缩放 · 空格拖动画布</span></div>
                </div>
                <footer class="whiteboard-statusbar"><span id="whiteboardStatus"><i></i> 新白板</span><span id="whiteboardObjectCount">0 个对象</span><span id="whiteboardZoom">100%</span><span class="whiteboard-statusbar__hint">滚轮缩放 · 空格拖动画布</span></footer>
            </section>

            <div class="whiteboard-object-dialog" id="whiteboardObjectDialog" hidden>
                <div class="whiteboard-object-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="whiteboardDialogTitle">
                    <header><strong id="whiteboardDialogTitle">插入内容</strong><button id="whiteboardDialogClose" type="button">×</button></header>
                    <div class="whiteboard-formula-symbols" id="whiteboardFormulaSymbols" hidden>
                        <button data-formula="\\frac{}{}">分数</button><button data-formula="\\sqrt{}">根号</button><button data-formula="x^{}">上标</button>
                        <button data-formula="\\sum_{}^{}">求和</button><button data-formula="\\int_{}^{}">积分</button><button data-formula="\\lim_{}">极限</button>
                        <button data-formula="\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}">矩阵</button>
                    </div>
                    <textarea id="whiteboardObjectInput" rows="4" placeholder="输入文字"></textarea>
                    <div class="whiteboard-formula-preview" id="whiteboardFormulaPreview" hidden></div>
                    <footer><button id="whiteboardDialogCancel" type="button">取消</button><button id="whiteboardDialogConfirm" type="button">插入</button></footer>
                </div>
            </div>
        </div>`;
}

function setStatus(message, tone = 'saved') {
    const element = document.getElementById('whiteboardStatus');
    if (!element) return;
    element.className = `whiteboard-status whiteboard-status--${tone}`;
    element.innerHTML = `<i></i> ${message}`;
}

function readPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        if (typeof prefs.color === 'string') state.color = prefs.color;
        if (Number.isFinite(prefs.width)) state.width = prefs.width;
        if (typeof prefs.background === 'string') state.background = prefs.background;
    } catch { /* preferences are optional */ }
}

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ color: state.color, width: state.width, background: state.background })); } catch { /* optional */ }
}

function documentValue() {
    return { version: 2, infinite: true, background: state.background, camera: state.camera, elements: state.elements };
}

function applyDocument(document, fallbackName = state.boardName) {
    const value = document?.document || document;
    state.elements = Array.isArray(value?.elements) ? value.elements.slice(0, MAX_ELEMENTS) : [];
    state.background = typeof value?.background === 'string' ? value.background : 'dots';
    state.camera = value?.camera && Number.isFinite(value.camera.zoom)
        ? { x: Number(value.camera.x) || 0, y: Number(value.camera.y) || 0, zoom: Math.min(8, Math.max(0.1, value.camera.zoom)) }
        : { x: 0, y: 0, zoom: 1 };
    state.boardName = document?.name || fallbackName;
    state.undo = [];
    state.redo = [];
    state.totalPoints = countStrokePoints(state.elements);
    boundsCache = new WeakMap();
    state.dirty = Boolean(document?.savedAt);
    redraw();
    updateControls();
}

function importLegacyBoard() {
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if (!legacy?.strokes?.length) return;
        state.elements = legacy.strokes.map(stroke => ({
            ...stroke, type: 'stroke', id: stroke.id || newId(),
            points: stroke.points.map(point => [(point[0] - 0.5) * 1000, (point[1] - 0.5) * 700, point[2]])
        }));
        state.totalPoints = countStrokePoints(state.elements);
        boundsCache = new WeakMap();
        state.background = legacy.gridEnabled === false ? 'blank' : 'dots';
        state.dirty = true;
        localStorage.removeItem(LEGACY_KEY);
        setStatus('旧白板已转为恢复草稿', 'warning');
        scheduleDraft();
    } catch { /* malformed legacy board is ignored */ }
}

function screenPoint(world) {
    return {
        x: (world.x - state.camera.x) * state.camera.zoom + state.logicalWidth / 2,
        y: (world.y - state.camera.y) * state.camera.zoom + state.logicalHeight / 2
    };
}

function worldPoint(event) {
    const rect = state.canvas.getBoundingClientRect();
    return {
        x: ((event.clientX - rect.left) - state.logicalWidth / 2) / state.camera.zoom + state.camera.x,
        y: ((event.clientY - rect.top) - state.logicalHeight / 2) / state.camera.zoom + state.camera.y,
        pressure: event.pointerType === 'mouse' ? 0.5 : (event.pressure || 0.5)
    };
}

function worldTransform(context) {
    context.translate(state.logicalWidth / 2 - state.camera.x * state.camera.zoom, state.logicalHeight / 2 - state.camera.y * state.camera.zoom);
    context.scale(state.camera.zoom, state.camera.zoom);
}

function drawBackground(context, width, height, camera = state.camera) {
    context.save();
    context.fillStyle = '#fffdf9';
    context.fillRect(0, 0, width, height);
    if (state.background === 'blank') return context.restore();
    const zoom = camera.zoom;
    const originX = width / 2 - camera.x * zoom;
    const originY = height / 2 - camera.y * zoom;
    const line = (spacing, offset, color, lineWidth = 1) => {
        const step = spacing * zoom;
        if (step < 5) return;
        context.beginPath(); context.strokeStyle = color; context.lineWidth = lineWidth;
        for (let x = ((originX + offset * zoom) % step + step) % step; x < width; x += step) { context.moveTo(x, 0); context.lineTo(x, height); }
        for (let y = ((originY + offset * zoom) % step + step) % step; y < height; y += step) { context.moveTo(0, y); context.lineTo(width, y); }
        context.stroke();
    };
    if (state.background === 'dots') {
        const step = 24 * zoom;
        if (step >= 6) {
            context.fillStyle = 'rgba(115,121,137,.2)';
            for (let x = ((originX % step) + step) % step; x < width; x += step) for (let y = ((originY % step) + step) % step; y < height; y += step) context.fillRect(x, y, 1.2, 1.2);
        }
    } else if (state.background === 'grid') line(32, 0, 'rgba(90,120,140,.15)');
    else if (state.background === 'math') { line(24, 0, 'rgba(91,137,151,.14)'); line(120, 0, 'rgba(72,111,125,.22)', 1.2); }
    else if (state.background === 'ruled') {
        const step = 34 * zoom; context.strokeStyle = 'rgba(91,137,151,.18)'; context.beginPath();
        for (let y = ((originY % step) + step) % step; y < height; y += step) { context.moveTo(0, y); context.lineTo(width, y); } context.stroke();
    } else if (state.background === 'english') {
        const group = 72 * zoom; context.strokeStyle = 'rgba(91,137,151,.2)'; context.beginPath();
        for (let base = ((originY % group) + group) % group; base < height; base += group) for (let index = 0; index < 4; index += 1) { const y = base + index * 12 * zoom; context.moveTo(0, y); context.lineTo(width, y); }
        context.stroke();
    }
    context.restore();
}

function strokeStyle(context, element) {
    context.lineCap = 'round'; context.lineJoin = 'round'; context.strokeStyle = element.color;
    context.fillStyle = element.color; context.globalAlpha = element.tool === 'highlighter' ? 0.28 : 1;
}

function drawArrowHead(context, fromX, fromY, toX, toY, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    context.beginPath(); context.moveTo(toX, toY);
    context.lineTo(toX - Math.cos(angle - Math.PI / 6) * size, toY - Math.sin(angle - Math.PI / 6) * size);
    context.moveTo(toX, toY);
    context.lineTo(toX - Math.cos(angle + Math.PI / 6) * size, toY - Math.sin(angle + Math.PI / 6) * size); context.stroke();
}

function drawElement(context, element, selected = false) {
    context.save();
    if (element.type === 'stroke') {
        strokeStyle(context, element); context.lineWidth = element.width;
        if (element.points.length === 1) { context.beginPath(); context.arc(element.points[0][0], element.points[0][1], element.width / 2, 0, Math.PI * 2); context.fill(); }
        else {
            context.beginPath(); context.moveTo(element.points[0][0], element.points[0][1]);
            for (let index = 1; index < element.points.length - 1; index += 1) {
                const point = element.points[index]; const next = element.points[index + 1];
                context.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
            }
            const last = element.points.at(-1); context.lineTo(last[0], last[1]); context.stroke();
        }
    } else if (['line', 'arrow', 'rect', 'ellipse'].includes(element.type)) {
        context.strokeStyle = element.color; context.lineWidth = element.width; context.globalAlpha = 1;
        if (element.type === 'line' || element.type === 'arrow') { context.beginPath(); context.moveTo(element.x1, element.y1); context.lineTo(element.x2, element.y2); context.stroke(); if (element.type === 'arrow') drawArrowHead(context, element.x1, element.y1, element.x2, element.y2, 14); }
        if (element.type === 'rect') context.strokeRect(element.x1, element.y1, element.x2 - element.x1, element.y2 - element.y1);
        if (element.type === 'ellipse') { context.beginPath(); context.ellipse((element.x1 + element.x2) / 2, (element.y1 + element.y2) / 2, Math.abs(element.x2 - element.x1) / 2, Math.abs(element.y2 - element.y1) / 2, 0, 0, Math.PI * 2); context.stroke(); }
    } else if (element.type === 'text') {
        context.fillStyle = element.color; context.font = `${element.size || 24}px "Segoe UI", sans-serif`; context.textBaseline = 'top';
        String(element.text).split('\n').forEach((line, index) => context.fillText(line, element.x, element.y + index * (element.size || 24) * 1.25));
    } else if (element.type === 'note') {
        context.fillStyle = 'rgba(255,231,153,.94)'; context.strokeStyle = 'rgba(158,123,42,.2)'; context.lineWidth = 1;
        context.fillRect(element.x, element.y, element.width || 220, element.height || 150); context.strokeRect(element.x, element.y, element.width || 220, element.height || 150);
        context.fillStyle = '#54472f'; context.font = '20px "Segoe UI", sans-serif'; context.textBaseline = 'top'; context.fillText(element.text, element.x + 14, element.y + 14, (element.width || 220) - 28);
    } else if (element.type === 'formula') {
        context.fillStyle = element.color; context.font = '22px serif'; context.textBaseline = 'top'; context.fillText(element.latex, element.x, element.y);
    }
    if (selected) {
        const box = elementBounds(element); context.globalAlpha = 1; context.strokeStyle = '#d96f3d'; context.lineWidth = 1 / state.camera.zoom; context.setLineDash([5 / state.camera.zoom, 4 / state.camera.zoom]);
        context.strokeRect(box.x - 5, box.y - 5, box.width + 10, box.height + 10);
    }
    context.restore();
}

function elementBounds(element) {
    const cached = boundsCache.get(element);
    if (cached) return cached;
    let bounds;
    if (element.type === 'stroke') {
        let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
        for (const point of element.points) {
            left = Math.min(left, point[0]); top = Math.min(top, point[1]);
            right = Math.max(right, point[0]); bottom = Math.max(bottom, point[1]);
        }
        bounds = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    } else if (['line', 'arrow', 'rect', 'ellipse'].includes(element.type)) {
        bounds = { x: Math.min(element.x1, element.x2), y: Math.min(element.y1, element.y2), width: Math.abs(element.x2 - element.x1), height: Math.abs(element.y2 - element.y1) };
    } else if (element.type === 'note') {
        bounds = { x: element.x, y: element.y, width: element.width || 220, height: element.height || 150 };
    } else if (element.type === 'formula') {
        bounds = { x: element.x, y: element.y, width: element.width || 220, height: element.height || 60 };
    } else {
        bounds = { x: element.x, y: element.y, width: Math.max(80, String(element.text || '').length * (element.size || 24) * .6), height: (element.size || 24) * 1.4 };
    }
    boundsCache.set(element, bounds);
    return bounds;
}

function visible(element) {
    const box = elementBounds(element); const left = state.camera.x - state.logicalWidth / state.camera.zoom / 2 - 100; const top = state.camera.y - state.logicalHeight / state.camera.zoom / 2 - 100;
    return box.x + box.width >= left && box.x <= left + state.logicalWidth / state.camera.zoom + 200 && box.y + box.height >= top && box.y <= top + state.logicalHeight / state.camera.zoom + 200;
}

function clearOverlay() {
    if (!state.context) return;
    state.context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
    state.context.clearRect(0, 0, state.logicalWidth, state.logicalHeight);
}

function redrawOverlay() {
    if (!state.context) return;
    clearOverlay();
    const selected = state.active?.selectedId ? state.elements.find(element => element.id === state.active.selectedId) : null;
    state.context.save(); worldTransform(state.context);
    if (selected) drawElement(state.context, selected, true);
    if (state.active?.preview) drawElement(state.context, state.active.preview);
    state.context.restore();
}

function redraw() {
    if (!state.committedContext) return;
    const context = state.committedContext;
    context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
    context.clearRect(0, 0, state.logicalWidth, state.logicalHeight);
    drawBackground(context, state.logicalWidth, state.logicalHeight);
    context.save(); worldTransform(context);
    for (const element of state.elements) if (visible(element)) drawElement(context, element);
    context.restore();
    redrawOverlay();
    state.surface?.classList.toggle('is-empty', state.elements.length === 0);
    renderFormulaLayer();
}

function paintActiveStroke() {
    const stroke = state.active?.type === 'stroke' ? state.active.preview : null;
    if (!stroke || !state.context || !stroke.points.length) return;
    const start = Math.max(0, state.active.renderedPointIndex || 0);
    const points = stroke.points;
    state.context.save(); worldTransform(state.context); strokeStyle(state.context, stroke); state.context.lineWidth = stroke.width;
    if (points.length === 1 && start === 0) {
        state.context.beginPath(); state.context.arc(points[0][0], points[0][1], stroke.width / 2, 0, Math.PI * 2); state.context.fill();
    } else if (start < points.length - 1) {
        state.context.beginPath(); state.context.moveTo(points[start][0], points[start][1]);
        for (let index = start + 1; index < points.length; index += 1) state.context.lineTo(points[index][0], points[index][1]);
        state.context.stroke();
    }
    state.context.restore();
    state.active.renderedPointIndex = Math.max(0, points.length - 1);
}

function schedulePointerRender(mode) {
    const priorities = { stroke: 1, overlay: 2, full: 3 };
    if (!state.pendingDrawMode || priorities[mode] > priorities[state.pendingDrawMode]) state.pendingDrawMode = mode;
    if (state.drawFrame !== null) return;
    state.drawFrame = requestAnimationFrame(() => {
        state.drawFrame = null;
        const pending = state.pendingDrawMode; state.pendingDrawMode = null;
        if (pending === 'full') redraw();
        else if (pending === 'overlay') redrawOverlay();
        else paintActiveStroke();
    });
}

function cancelPendingDraw() {
    if (state.drawFrame !== null) cancelAnimationFrame(state.drawFrame);
    state.drawFrame = null; state.pendingDrawMode = null;
}

async function ensureFormulaRuntime() {
    if (state.formulaRuntime) return state.formulaRuntime;
    if (!state.formulaLoading) state.formulaLoading = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => (state.formulaRuntime = module.default || module));
    return state.formulaLoading;
}

function renderFormulaLayer() {
    if (!state.formulaLayer) return;
    const formulas = state.elements.filter(element => element.type === 'formula' && visible(element));
    const activeIds = new Set(formulas.map(formula => formula.id));
    state.formulaLayer.querySelectorAll('[data-id]').forEach(node => { if (!activeIds.has(node.dataset.id)) node.remove(); });
    if (!formulas.length) return;
    ensureFormulaRuntime().then(runtime => {
        if (!state.formulaLayer) return;
        formulas.forEach(formula => {
            const point = screenPoint(formula);
            let node = state.formulaLayer.querySelector(`[data-id="${formula.id}"]`);
            if (!node) { node = document.createElement('div'); node.className = 'whiteboard-formula-object'; node.dataset.id = formula.id; node.dataset.latex = formula.latex; try { runtime.render(formula.latex, node, { throwOnError: false, displayMode: false, strict: 'ignore' }); } catch { node.textContent = formula.latex; } state.formulaLayer.append(node); }
            node.style.left = `${point.x}px`; node.style.top = `${point.y}px`; node.style.transform = `scale(${state.camera.zoom})`; node.style.color = formula.color;
        });
    });
}

function resizeCanvas() {
    state.resizeFrame = null;
    if (!state.canvas || !state.committedCanvas || !state.surface) return;
    const rect = state.surface.getBoundingClientRect(); const width = Math.max(1, Math.floor(rect.width)); const height = Math.max(1, Math.floor(rect.height));
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 1.5); const pixelWidth = Math.floor(width * ratio); const pixelHeight = Math.floor(height * ratio);
    state.logicalWidth = width; state.logicalHeight = height; state.pixelRatio = ratio;
    if (state.canvas.width !== pixelWidth || state.canvas.height !== pixelHeight) {
        state.canvas.width = pixelWidth; state.canvas.height = pixelHeight;
        state.committedCanvas.width = pixelWidth; state.committedCanvas.height = pixelHeight;
        state.context = state.canvas.getContext('2d', { alpha: true, desynchronized: true });
        state.committedContext = state.committedCanvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    redraw();
}

function scheduleResize() { if (state.resizeFrame === null) state.resizeFrame = requestAnimationFrame(resizeCanvas); }

function countStrokePoints(elements = state.elements) {
    let total = 0;
    for (const element of elements) if (element.type === 'stroke') total += element.points.length;
    return total;
}

function pushUndo(snapshot = cloneElements()) { state.undo.push(snapshot); if (state.undo.length > MAX_HISTORY) state.undo.shift(); state.redo = []; }

function markDirty() { state.dirty = true; setStatus('有未保存修改', 'warning'); scheduleDraft(); updateControls(); }

function scheduleDraft() {
    if (state.draftTimer !== null) return;
    state.draftTimer = setTimeout(() => { state.draftTimer = null; saveDraftNow(); }, DRAFT_DELAY_MS);
}

async function saveDraftNow() {
    if (!state.dirty || !state.boardId || state.readOnly) return;
    try {
        const document = documentValue();
        if (invoke) await invoke('save_whiteboard_draft', { request: { id: state.boardId, name: state.boardName, document } });
        else localStorage.setItem(`dtkit_whiteboard_draft_${state.boardId}`, JSON.stringify({ name: state.boardName, document, savedAt: Date.now() }));
        setStatus('恢复草稿已保存');
    } catch (error) { setStatus(`草稿保存失败：${error}`, 'warning'); }
}

function thumbnailDataUrl() {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const context = canvas.getContext('2d');
    const bounds = contentBounds(); const scale = bounds ? Math.min(2, Math.min(290 / Math.max(1, bounds.width), 150 / Math.max(1, bounds.height))) : 1;
    const camera = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: scale } : state.camera;
    const oldCamera = state.camera; state.camera = camera; drawBackground(context, 320, 180, camera); context.save(); context.translate(160 - camera.x * camera.zoom, 90 - camera.y * camera.zoom); context.scale(camera.zoom, camera.zoom); state.elements.forEach(element => drawElement(context, element)); context.restore(); state.camera = oldCamera;
    return canvas.toDataURL('image/png');
}

async function saveBoard(asNew = false) {
    if (state.readOnly) return setStatus('当前窗口为只读；接管后才能保存', 'warning');
    const input = document.getElementById('whiteboardName'); state.boardName = input?.value.trim() || '未命名白板';
    setStatus('正在保存…', 'saving');
    try {
        const previousId = state.boardId;
        const request = { id: asNew ? null : state.boardId, name: state.boardName, document: documentValue(), thumbnailDataUrl: thumbnailDataUrl() };
        const meta = invoke ? await invoke('save_whiteboard', { request }) : { id: request.id || state.boardId, name: state.boardName, updatedAt: Date.now() };
        if (asNew && invoke) await invoke('discard_whiteboard_draft', { id: previousId });
        state.boardId = meta.id; state.boardName = meta.name; state.isFormal = true; state.dirty = false;
        setReadOnly(false);
        if (input) input.value = state.boardName;
        clearTimeout(state.draftTimer); state.draftTimer = null; setStatus('正式白板已保存');
        await loadHistory(); updateControls();
    } catch (error) { setStatus(`保存失败：${error}`, 'warning'); }
}

function contentBounds() {
    if (!state.elements.length) return null;
    const boxes = state.elements.map(elementBounds); const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y)); const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function fitContent() {
    const box = contentBounds(); if (!box) { state.camera = { x: 0, y: 0, zoom: 1 }; }
    else state.camera = { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: Math.min(2, Math.max(.1, Math.min((state.logicalWidth - 100) / Math.max(1, box.width), (state.logicalHeight - 100) / Math.max(1, box.height)))) };
    redraw(); updateControls();
}

function hitElement(point) {
    const padding = 10 / state.camera.zoom;
    return [...state.elements].reverse().find(element => { const box = elementBounds(element); return point.x >= box.x - padding && point.x <= box.x + box.width + padding && point.y >= box.y - padding && point.y <= box.y + box.height + padding; });
}

function moveElement(element, dx, dy) {
    if (element.type === 'stroke') element.points.forEach(point => { point[0] += dx; point[1] += dy; });
    else if (['line', 'arrow', 'rect', 'ellipse'].includes(element.type)) { element.x1 += dx; element.x2 += dx; element.y1 += dy; element.y2 += dy; }
    else { element.x += dx; element.y += dy; }
    boundsCache.delete(element);
}

function beginPointer(event) {
    if (state.pointerId !== null) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); closeHistory(); closeToolPanels(); state.pointerId = event.pointerId; state.canvas.setPointerCapture?.(event.pointerId);
    const point = worldPoint(event); const pan = event.button === 1 || state.spacePressed || state.mode === 'pan';
    if (pan) { state.active = { type: 'pan', clientX: event.clientX, clientY: event.clientY, camera: { ...state.camera } }; return; }
    if (state.readOnly) { state.pointerId = null; return; }
    if (['pen', 'highlighter'].includes(state.mode)) {
        pushUndo(); clearOverlay();
        state.active = { type: 'stroke', renderedPointIndex: 0, preview: { id: newId(), type: 'stroke', tool: state.mode, color: state.color, width: state.width / state.camera.zoom, points: [[point.x, point.y, point.pressure]] } };
        schedulePointerRender('stroke'); return;
    }
    if (['line', 'arrow', 'rect', 'ellipse'].includes(state.mode)) {
        pushUndo(); clearOverlay();
        state.active = { type: 'shape', start: point, preview: { id: newId(), type: state.mode, color: state.color, width: state.width / state.camera.zoom, x1: point.x, y1: point.y, x2: point.x, y2: point.y } };
        schedulePointerRender('overlay'); return;
    }
    if (state.mode === 'eraser') { const hit = hitElement(point); if (hit) { pushUndo(); state.elements = state.elements.filter(item => item.id !== hit.id); markDirty(); redraw(); } return; }
    if (state.mode === 'select') { const hit = hitElement(point); state.active = { type: 'select', selectedId: hit?.id || null, last: point, snapshot: hit ? cloneElements() : null }; redraw(); return; }
    if (['text', 'note', 'formula'].includes(state.mode)) { state.pointerId = null; openObjectDialog(state.mode, point); }
}

function movePointer(event) {
    if (event.pointerId !== state.pointerId || !state.active) return;
    event.preventDefault();
    if (state.active.type === 'pan') {
        state.camera.x = state.active.camera.x - (event.clientX - state.active.clientX) / state.camera.zoom;
        state.camera.y = state.active.camera.y - (event.clientY - state.active.clientY) / state.camera.zoom;
        schedulePointerRender('full'); return;
    }
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const events = samples.length ? samples : [event];
    if (state.active.type === 'stroke') {
        const points = state.active.preview.points;
        for (const sample of events) {
            const point = worldPoint(sample); const last = points.at(-1);
            if (Math.hypot(point.x - last[0], point.y - last[1]) * state.camera.zoom > 0.7
                && points.length < MAX_STROKE_POINTS && state.totalPoints + points.length < MAX_POINTS) {
                points.push([point.x, point.y, point.pressure]);
            }
        }
        schedulePointerRender('stroke'); return;
    }
    const point = worldPoint(events.at(-1));
    if (state.active.type === 'shape') { state.active.preview.x2 = point.x; state.active.preview.y2 = point.y; schedulePointerRender('overlay'); return; }
    if (state.active.type === 'select' && state.active.selectedId) {
        const element = state.elements.find(item => item.id === state.active.selectedId);
        if (element) moveElement(element, point.x - state.active.last.x, point.y - state.active.last.y);
        state.active.last = point; schedulePointerRender('full');
    }
}

function finishPointer(event) {
    if (event && event.pointerId !== state.pointerId) return;
    try { state.canvas?.releasePointerCapture?.(state.pointerId); } catch { /* released by OS */ }
    const active = state.active; state.pointerId = null;
    if (!active) return;
    cancelPendingDraw();
    if (active.type === 'stroke' && active.preview.points.length) {
        state.elements.push(active.preview); state.totalPoints += active.preview.points.length; markDirty();
    }
    if (active.type === 'shape' && Math.hypot(active.preview.x2 - active.preview.x1, active.preview.y2 - active.preview.y1) > 2) { state.elements.push(active.preview); markDirty(); }
    if (active.type === 'select' && active.snapshot && JSON.stringify(active.snapshot) !== JSON.stringify(state.elements)) { state.undo.push(active.snapshot); if (state.undo.length > MAX_HISTORY) state.undo.shift(); state.redo = []; markDirty(); }
    state.active = active.type === 'select' ? { type: 'select', selectedId: active.selectedId } : null;
    redraw(); updateControls();
}

function zoomAt(event) {
    event.preventDefault(); const before = worldPoint(event); const next = Math.min(8, Math.max(.1, state.camera.zoom * Math.exp(-event.deltaY * .0012)));
    const rect = state.canvas.getBoundingClientRect(); const sx = event.clientX - rect.left - state.logicalWidth / 2; const sy = event.clientY - rect.top - state.logicalHeight / 2;
    state.camera.zoom = next; state.camera.x = before.x - sx / next; state.camera.y = before.y - sy / next; redraw(); updateControls();
}

function setMode(mode) { state.mode = mode; closeToolPanels(); updateControls(); savePrefs(); }
function setColor(color) { if (/^#[0-9a-f]{6}$/i.test(color)) { state.color = color.toLowerCase(); updateControls(); savePrefs(); } }

function replaceElements(elements) {
    state.elements = elements; state.totalPoints = countStrokePoints(elements); boundsCache = new WeakMap();
}

function undo() { if (!state.undo.length) return; state.redo.push(cloneElements()); replaceElements(state.undo.pop()); state.active = null; markDirty(); redraw(); }
function redo() { if (!state.redo.length) return; state.undo.push(cloneElements()); replaceElements(state.redo.pop()); state.active = null; markDirty(); redraw(); }

function updateControls() {
    document.querySelectorAll('[data-board-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.boardMode === state.mode)));
    document.querySelectorAll('[data-panel-modes]').forEach(button => {
        button.classList.toggle('is-mode-active', button.dataset.panelModes.split(',').includes(state.mode));
    });
    document.querySelectorAll('[data-board-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.boardColor === state.color)));
    const name = document.getElementById('whiteboardName'); if (name && document.activeElement !== name) name.value = state.boardName;
    const size = document.getElementById('whiteboardSize'); if (size) size.value = String(state.width);
    const sizeValue = document.getElementById('whiteboardSizeValue'); if (sizeValue) sizeValue.textContent = `${state.width} px`;
    const undoButton = document.getElementById('whiteboardUndo'); if (undoButton) undoButton.disabled = !state.undo.length;
    const redoButton = document.getElementById('whiteboardRedo'); if (redoButton) redoButton.disabled = !state.redo.length;
    const count = document.getElementById('whiteboardObjectCount'); if (count) count.textContent = `${state.elements.length} 个对象`;
    const zoom = document.getElementById('whiteboardZoom'); if (zoom) zoom.textContent = `${Math.round(state.camera.zoom * 100)}%`;
    const nameInput = document.getElementById('whiteboardName'); if (nameInput) nameInput.readOnly = state.readOnly;
    document.querySelectorAll('[data-board-mode]:not([data-board-mode="pan"]), #whiteboardSave, #whiteboardSaveAs, #whiteboardClear, #whiteboardUndo, #whiteboardRedo')
        .forEach(control => { control.disabled = state.readOnly || control.disabled && ['whiteboardUndo', 'whiteboardRedo'].includes(control.id); });
}

function setReadOnly(readOnly) {
    state.readOnly = Boolean(readOnly);
    const banner = document.getElementById('whiteboardReadOnly');
    if (banner) banner.hidden = !state.readOnly;
    updateControls();
}

async function releaseEdit(id = state.boardId) {
    if (!invoke || !id) return;
    try { await invoke('release_whiteboard_edit', { id }); } catch { /* release is best effort during teardown */ }
}

async function takeOverEdit() {
    if (!invoke || !state.boardId) return;
    try {
        await invoke('take_over_whiteboard_edit', { id: state.boardId });
        setReadOnly(false); setStatus('已接管此白板的编辑权');
    } catch (error) { setStatus(`接管失败：${error}`, 'warning'); }
}

async function openObjectDialog(type, point) {
    const dialog = document.getElementById('whiteboardObjectDialog'); const input = document.getElementById('whiteboardObjectInput'); const symbols = document.getElementById('whiteboardFormulaSymbols'); const preview = document.getElementById('whiteboardFormulaPreview');
    dialog.dataset.type = type; dialog.dataset.x = point.x; dialog.dataset.y = point.y; input.value = ''; symbols.hidden = type !== 'formula'; preview.hidden = type !== 'formula';
    document.getElementById('whiteboardDialogTitle').textContent = type === 'formula' ? '插入数学表达式' : type === 'note' ? '插入便签' : '插入文字';
    input.placeholder = type === 'formula' ? '输入 LaTeX，例如：\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}' : '输入内容'; dialog.hidden = false; input.focus();
    if (type === 'formula') { await ensureFormulaRuntime(); updateFormulaPreview(); }
}

function closeObjectDialog() { document.getElementById('whiteboardObjectDialog').hidden = true; }

function updateFormulaPreview() {
    const dialog = document.getElementById('whiteboardObjectDialog'); if (dialog.dataset.type !== 'formula' || !state.formulaRuntime) return;
    const preview = document.getElementById('whiteboardFormulaPreview');
    try { state.formulaRuntime.render(document.getElementById('whiteboardObjectInput').value || '\\square', preview, { throwOnError: false, displayMode: true, strict: 'ignore' }); } catch { preview.textContent = '表达式暂时无法预览'; }
}

function confirmObjectDialog() {
    const dialog = document.getElementById('whiteboardObjectDialog'); const type = dialog.dataset.type; const value = document.getElementById('whiteboardObjectInput').value.trim(); if (!value) return;
    pushUndo(); const base = { id: newId(), type, color: state.color, x: Number(dialog.dataset.x), y: Number(dialog.dataset.y) };
    state.elements.push(type === 'formula' ? { ...base, latex: value, width: 220, height: 60 } : type === 'note' ? { ...base, text: value, width: 220, height: 150 } : { ...base, text: value, size: 24 });
    closeObjectDialog(); markDirty(); redraw();
}

function toggleHistory() {
    const panel = document.getElementById('whiteboardHistory'); const rail = document.getElementById('whiteboardHistoryRail'); const open = panel.getAttribute('aria-hidden') === 'true';
    panel.setAttribute('aria-hidden', String(!open)); rail.setAttribute('aria-expanded', String(open)); if (open) loadHistory();
}

function closeHistory() {
    const panel = document.getElementById('whiteboardHistory'); const rail = document.getElementById('whiteboardHistoryRail');
    if (!panel || panel.getAttribute('aria-hidden') === 'true') return;
    panel.setAttribute('aria-hidden', 'true'); rail?.setAttribute('aria-expanded', 'false');
}

function closeToolPanels(except = null) {
    document.querySelectorAll('[data-board-panel-content]').forEach(panel => {
        if (panel.dataset.boardPanelContent !== except) panel.hidden = true;
    });
    document.querySelectorAll('[data-board-panel]').forEach(button => {
        if (button.dataset.boardPanel !== except) button.setAttribute('aria-expanded', 'false');
    });
}

function toggleToolPanel(name) {
    const panel = document.querySelector(`[data-board-panel-content="${name}"]`);
    const trigger = document.querySelector(`[data-board-panel="${name}"]`);
    if (!panel || !trigger) return;
    const opening = panel.hidden;
    closeToolPanels(opening ? name : null);
    panel.hidden = !opening; trigger.setAttribute('aria-expanded', String(opening));
}

async function loadHistory() {
    try { state.histories = invoke ? await invoke('list_whiteboards') : []; } catch { state.histories = []; }
    const list = document.getElementById('whiteboardHistoryList'); if (!list) return;
    list.innerHTML = state.histories.length ? state.histories.map((item, index) => `
        <button class="whiteboard-history-card${item.id === state.boardId ? ' is-current' : ''}" type="button" data-board-id="${item.id}" data-distance="${Math.min(5, Math.abs(index - Math.max(0, state.histories.findIndex(entry => entry.id === state.boardId))))}">
            <span class="whiteboard-history-thumb" data-thumbnail-id="${item.id}"><i class="ri-layout-grid-line"></i></span>
            <span><strong>${escapeHtml(item.name)}</strong><small>${new Date(item.updatedAt).toLocaleString()}${item.hasDraft ? ' · 未保存草稿' : ''}</small></span>
        </button>`).join('') : '<div class="whiteboard-history-empty"><i class="ri-layout-grid-line"></i><span>手动保存后，白板会出现在这里</span></div>';
    list.querySelectorAll('[data-board-id]').forEach(button => button.addEventListener('click', () => openBoard(button.dataset.boardId), { signal: state.abortController.signal }));
    state.historyObserver?.disconnect();
    if (typeof IntersectionObserver === 'function') {
        state.historyObserver = new IntersectionObserver(entries => entries.filter(entry => entry.isIntersecting).forEach(entry => loadThumbnail(entry.target)), { root: list, rootMargin: '80px' });
        list.querySelectorAll('[data-thumbnail-id]').forEach(node => state.historyObserver.observe(node));
    }
    requestAnimationFrame(() => list.querySelector('.is-current')?.scrollIntoView({ block: 'center' }));
}

async function loadThumbnail(node) {
    state.historyObserver?.unobserve(node); try { const source = await invoke?.('get_whiteboard_thumbnail', { id: node.dataset.thumbnailId }); if (source) { const image = new Image(); image.alt = ''; image.loading = 'lazy'; image.src = source; node.replaceChildren(image); } } catch { /* keep placeholder */ }
}

async function openBoard(id) {
    if (id === state.boardId) return;
    await saveDraftNow(); await releaseEdit(); setStatus('正在打开白板…', 'saving');
    try {
        const result = await invoke('load_whiteboard', { id }); state.boardId = result.meta.id; state.boardName = result.meta.name; state.isFormal = true;
        applyDocument(result.draft?.document || result.document, result.meta.name); state.dirty = Boolean(result.draft); setReadOnly(result.editable === false);
        setStatus(state.readOnly ? '已以只读方式打开' : result.draft ? '已恢复未保存草稿' : '正式白板已打开', state.readOnly || result.draft ? 'warning' : 'saved'); await loadHistory();
    } catch (error) { setStatus(`打开失败：${error}`, 'warning'); }
}

function newBoard() {
    const previousId = state.boardId;
    Promise.resolve(saveDraftNow()).finally(() => releaseEdit(previousId));
    state.boardId = newId(); state.boardName = '未命名白板'; state.isFormal = false; replaceElements([]); state.camera = { x: 0, y: 0, zoom: 1 }; state.undo = []; state.redo = []; state.dirty = false; setReadOnly(false); redraw(); updateControls(); setStatus('新白板');
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

function exportBoard() {
    const bounds = contentBounds();
    const padding = 64;
    const scale = bounds
        ? Math.min(2, 2200 / Math.max(1, bounds.width), 1400 / Math.max(1, bounds.height))
        : 1;
    const width = bounds ? Math.max(640, Math.min(2400, Math.ceil(bounds.width * scale + padding * 2))) : 1280;
    const height = bounds ? Math.max(360, Math.min(1600, Math.ceil(bounds.height * scale + padding * 2))) : 720;
    const camera = bounds
        ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: scale }
        : { ...state.camera, zoom: 1 };
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const oldCamera = state.camera;
    try {
        state.camera = camera;
        drawBackground(context, width, height, camera);
        context.save();
        context.translate(width / 2 - camera.x * camera.zoom, height / 2 - camera.y * camera.zoom);
        context.scale(camera.zoom, camera.zoom);
        state.elements.forEach(element => drawElement(context, element));
        context.restore();
    } finally {
        state.camera = oldCamera;
    }
    const link = document.createElement('a'); link.href = canvas.toDataURL('image/png'); link.download = `${state.boardName || 'DtKit-白板'}.png`; link.click(); setStatus('当前白板已导出为高清 PNG');
}

function clearBoard() { if (!state.elements.length || !globalThis.confirm('确定清空当前白板的全部内容吗？')) return; pushUndo(); replaceElements([]); markDirty(); redraw(); }

function bindEvents(signal) {
    state.canvas.addEventListener('pointerdown', beginPointer, { signal }); state.canvas.addEventListener('pointermove', movePointer, { signal }); state.canvas.addEventListener('pointerup', finishPointer, { signal }); state.canvas.addEventListener('pointercancel', finishPointer, { signal }); state.canvas.addEventListener('wheel', zoomAt, { passive: false, signal });
    document.querySelectorAll('[data-board-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.boardMode), { signal }));
    document.querySelectorAll('[data-board-panel]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); toggleToolPanel(button.dataset.boardPanel); }, { signal }));
    document.querySelectorAll('[data-board-panel-content]').forEach(panel => panel.addEventListener('click', event => event.stopPropagation(), { signal }));
    document.querySelectorAll('[data-board-color]').forEach(button => button.addEventListener('click', () => setColor(button.dataset.boardColor), { signal }));
    document.getElementById('whiteboardColorInput').addEventListener('input', event => setColor(event.target.value), { signal });
    document.getElementById('whiteboardSize').addEventListener('input', event => { state.width = Number(event.target.value); savePrefs(); updateControls(); }, { signal });
    document.getElementById('whiteboardName').addEventListener('input', event => { state.boardName = event.target.value; markDirty(); }, { signal });
    document.getElementById('whiteboardUndo').addEventListener('click', undo, { signal }); document.getElementById('whiteboardRedo').addEventListener('click', redo, { signal });
    document.getElementById('whiteboardSave').addEventListener('click', () => saveBoard(false), { signal }); document.getElementById('whiteboardSaveAs').addEventListener('click', () => saveBoard(true), { signal });
    document.getElementById('whiteboardExport').addEventListener('click', exportBoard, { signal }); document.getElementById('whiteboardClear').addEventListener('click', clearBoard, { signal }); document.getElementById('whiteboardFit').addEventListener('click', fitContent, { signal });
    document.getElementById('whiteboardHistoryRail').addEventListener('click', toggleHistory, { signal }); document.getElementById('whiteboardNew').addEventListener('click', newBoard, { signal });
    document.getElementById('whiteboardTakeOver').addEventListener('click', takeOverEdit, { signal });
    document.getElementById('whiteboardBackground').addEventListener('click', () => { const menu = document.getElementById('whiteboardBackgroundMenu'); menu.hidden = !menu.hidden; }, { signal });
    document.querySelectorAll('[data-board-background]').forEach(button => button.addEventListener('click', () => { state.background = button.dataset.boardBackground; document.getElementById('whiteboardBackgroundMenu').hidden = true; savePrefs(); markDirty(); redraw(); }, { signal }));
    document.getElementById('whiteboardDialogClose').addEventListener('click', closeObjectDialog, { signal }); document.getElementById('whiteboardDialogCancel').addEventListener('click', closeObjectDialog, { signal }); document.getElementById('whiteboardDialogConfirm').addEventListener('click', confirmObjectDialog, { signal });
    document.getElementById('whiteboardObjectInput').addEventListener('input', updateFormulaPreview, { signal }); document.querySelectorAll('[data-formula]').forEach(button => button.addEventListener('click', () => { const input = document.getElementById('whiteboardObjectInput'); input.setRangeText(button.dataset.formula, input.selectionStart, input.selectionEnd, 'end'); input.focus(); updateFormulaPreview(); }, { signal }));
    document.addEventListener('keydown', event => {
        if (event.key === ' ' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { state.spacePressed = true; event.preventDefault(); }
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); saveBoard(event.shiftKey); }
        else if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
        else if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); }
        else if (key === 'v') setMode('select'); else if (key === 'b') setMode('pen'); else if (key === 'h') setMode('highlighter'); else if (key === 'e') setMode('eraser');
        else if (key === 'escape') { closeObjectDialog(); state.active = null; redraw(); }
    }, { signal });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.whiteboard-cluster')) closeToolPanels(); }, { signal });
    document.addEventListener('keyup', event => { if (event.key === ' ') state.spacePressed = false; }, { signal });
    window.addEventListener('dtkit:power-state', event => { if (event.detail?.suspended) { finishPointer(); saveDraftNow(); } }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraftNow(); }, { signal });
}

async function initWhiteboardTool() {
    destroyWhiteboardTool(); state.abortController = new AbortController(); state.canvas = document.getElementById('whiteboardCanvas'); state.committedCanvas = document.getElementById('whiteboardCommittedCanvas'); state.surface = document.getElementById('whiteboardSurface'); state.formulaLayer = document.getElementById('whiteboardFormulaLayer');
    if (!state.canvas || !state.committedCanvas || !state.surface) return;
    readPrefs(); state.boardId = newId(); state.boardName = '未命名白板'; state.isFormal = false; replaceElements([]); bindEvents(state.abortController.signal);
    if (typeof ResizeObserver === 'function') { state.resizeObserver = new ResizeObserver(scheduleResize); state.resizeObserver.observe(state.surface); } else window.addEventListener('resize', scheduleResize, { signal: state.abortController.signal });
    const listen = globalThis.window?.__TAURI__?.event?.listen;
    if (listen) {
        Promise.resolve(listen('whiteboard-edit-revoked', event => {
            if (event.payload === state.boardId) { setReadOnly(true); setStatus('编辑权已由另一窗口接管', 'warning'); }
        })).then(unlisten => { state.editRevokedUnlisten = unlisten; });
    }
    importLegacyBoard(); updateControls(); scheduleResize(); await loadHistory();
}

function destroyWhiteboardTool() {
    finishPointer();
    const closingBoardId = state.boardId;
    const draftPromise = state.dirty ? saveDraftNow() : Promise.resolve();
    Promise.resolve(draftPromise).finally(() => releaseEdit(closingBoardId));
    clearTimeout(state.draftTimer); state.draftTimer = null; state.abortController?.abort(); state.abortController = null; state.resizeObserver?.disconnect(); state.resizeObserver = null; state.historyObserver?.disconnect(); state.historyObserver = null; state.editRevokedUnlisten?.(); state.editRevokedUnlisten = null;
    if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame); state.resizeFrame = null; cancelPendingDraw(); state.canvas = null; state.context = null; state.committedCanvas = null; state.committedContext = null; state.surface = null; state.formulaLayer = null; state.pointerId = null; state.active = null;
}

registerTool({
    id: 'whiteboard', name: '白板', icon: 'ri-brush-2-line', colorClass: 'tool-card__icon--orange', category: 'design', status: 'ready',
    description: '无限画布、教学纸张、公式、形状与本地历史白板。', template: getTemplate, init: initWhiteboardTool, destroy: destroyWhiteboardTool
});

export { destroyWhiteboardTool, initWhiteboardTool };
