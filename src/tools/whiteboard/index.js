import { renderBoardImage } from './export.js';
import { renderFormulaMarkup } from './formula.js';
import { createObjectDialog } from './dialog.js';
import { getTemplate } from './template.js';
import { getElementBounds, hitTestElement, translateElement, constrainShape, fitCamera, zoomCamera } from './geometry.js';
import { drawStroke, paintStrokeIncrement } from './ink.js';
import { normalizeDocumentV2, historyWeight, MAX_ELEMENTS, MAX_POINTS, MAX_STROKE_POINTS } from './document.js';
import { mountSegmentedControl, prefersReducedMotion } from '../../core/toolMotion.js';
import { registerTool } from '../toolRegistry.js';
import '../../css/tools/whiteboard.css';

const invoke = (command, args = {}) => globalThis.window?.__TAURI__?.core?.invoke?.(command, {
    ...args,
    instanceId: globalThis.window?.__DTKIT_TOOL_PAGE_CONTEXT?.instanceId ?? null
});
const DRAFT_DELAY_MS = 60_000;
const MAX_HISTORY = 40;
const DEFAULT_COLOR = '#242937';
const LEGACY_KEY = 'dtkit_whiteboard_v1';
const PREFS_KEY = 'dtkit_whiteboard_preferences_v2';

function createState() { return {
    canvas: null, context: null, committedCanvas: null, committedContext: null, surface: null, formulaLayer: null,
    elements: [], undo: [], redo: [], active: null, pointerId: null,
    mode: 'pen', color: DEFAULT_COLOR, width: 4, background: 'dots',
    camera: { x: 0, y: 0, zoom: 1 }, boardId: null, boardName: '未命名白板',
    isFormal: false, dirty: false, readOnly: false, logicalWidth: 1, logicalHeight: 1, pixelRatio: 1,
    abortController: null, resizeObserver: null, resizeFrame: null, drawFrame: null, draftTimer: null,
    formulaRuntime: null, historyObserver: null, histories: [],
    spacePressed: false, totalPoints: 0, editRevokedUnlisten: null,
    draftRevision: 0, savedDraftRevision: -1,
    root: null, selectionId: null, pointers: new Map(), pinch: null, boardGeneration: 0, storeTail: Promise.resolve(), pendingDraft: null,
    boardBusy: false, saveBusy: false, historyVersion: 0, renderVersion: 0,
    cameraFrame: null, cameraTarget: null, popovers: new Map(),
    legacyPending: false,
    inkLayer: null, tail: null, tailPath: null, cursor: null, dialog: null, exportBusy: false, closing: null, recovery: null, recoveryJob: null
}; }

let state = createState();
let boundsCache = new WeakMap();
let formulaModulePromise;
const live = view => view === state && !!view.abortController && !view.abortController.signal.aborted;
const hasNativeStore = () => typeof window.__TAURI__?.core?.invoke === 'function';
const editable = () => live(state) && !state.readOnly && !state.boardBusy;
const sameBoard = (view, generation, id) => live(view) && view.boardGeneration === generation && view.boardId === id;
const BROWSER_INDEX = 'dtkit_whiteboards_v2';
const browserBoardKey = id => 'dtkit_whiteboard_board_' + id;
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


function setStatus(message, tone = 'saved') {
    const target = document.getElementById('whiteboardStatus'); if (!target) return;
    target.className = 'whiteboard-status whiteboard-status--' + tone;
    const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true');
    target.replaceChildren(dot, document.createTextNode(' ' + String(message)));
}

function readPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        if (/^#[0-9a-f]{6}$/i.test(prefs.color || '')) state.color = prefs.color;
        if (Number.isFinite(prefs.width)) state.width = Math.max(1, Math.min(24, prefs.width));
        if (['blank','dots','grid','math','ruled','english'].includes(prefs.background)) state.background = prefs.background;
    } catch { /* Preferences are optional. */ }
}

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ color: state.color, width: state.width, background: state.background })); } catch { /* optional */ }
}

function documentValue(view = state) {
    return { version: 2, infinite: true, background: view.background, camera: { ...view.camera }, elements: structuredClone(view.elements) };
}

function applyDocument(document, fallbackName = state.boardName) {
    const value = normalizeDocumentV2(document?.document || document);
    replaceElements(value.elements); state.background = value.background; state.camera = value.camera;
    state.boardName = typeof document?.name === 'string' ? document.name.slice(0, 60) : fallbackName;
    cancelCameraAnimation(); state.undo = []; state.redo = []; state.active = null; state.selectionId = null; state.dirty = false;
    state.draftRevision = 0; state.savedDraftRevision = -1; state.renderVersion++;
    redraw(); updateControls();
}

function importLegacyBoard() {
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if (!legacy?.strokes?.length) return;
        const elements = legacy.strokes.map(stroke => ({
            ...stroke, type: 'stroke', id: String(stroke.id || newId()),
            points: stroke.points.map(point => [(point[0] - .5) * 1000, (point[1] - .5) * 700, point[2] ?? .5])
        }));
        const document = normalizeDocumentV2({ version: 2, infinite: true, elements, background: legacy.gridEnabled === false ? 'blank' : 'dots', camera: { x: 0, y: 0, zoom: 1 } });
        applyDocument(document); state.legacyPending = true; markDirty(); setStatus('旧白板已恢复，正在保存恢复草稿…', 'saving');
        void saveDraftNow();
    } catch (error) { setStatus('旧白板尚未导入：' + error.message + '；原数据已保留', 'warning'); }
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

function drawBackground(context, width, height, camera = state.camera, background = state.background) {
    context.save();
    context.fillStyle = '#fffdf9';
    context.fillRect(0, 0, width, height);
    if (background === 'blank') return context.restore();
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
    if (background === 'dots') {
        const step = 24 * zoom;
        if (step >= 6) {
            context.fillStyle = 'rgba(115,121,137,.2)';
            for (let x = ((originX % step) + step) % step; x < width; x += step) for (let y = ((originY % step) + step) % step; y < height; y += step) context.fillRect(x, y, 1.2, 1.2);
        }
    } else if (background === 'grid') line(32, 0, 'rgba(90,120,140,.15)');
    else if (background === 'math') { line(24, 0, 'rgba(91,137,151,.14)'); line(120, 0, 'rgba(72,111,125,.22)', 1.2); }
    else if (background === 'ruled') {
        const step = 34 * zoom; if(step<5)return context.restore(); context.strokeStyle = 'rgba(91,137,151,.18)'; context.beginPath();
        for (let y = ((originY % step) + step) % step; y < height; y += step) { context.moveTo(0, y); context.lineTo(width, y); } context.stroke();
    } else if (background === 'english') {
        const group = 72 * zoom; if(group<6)return context.restore();
        const opacity=Math.min(1,(group-6)/12),detail=Math.max(0,Math.min(1,(12*zoom-4)/4));
        // Fade secondary guides at distant zooms so the paper stays quiet while the camera moves.
        for(let index=0;index<4;index++){
            const alpha=.2*opacity*(index===3?1:detail);if(alpha<=0)continue;
            context.strokeStyle='rgba(91,137,151,'+alpha+')';context.beginPath();
            for(let base=((originY%group)+group)%group-group;base<height;base+=group){const y=base+index*12*zoom;context.moveTo(0,y);context.lineTo(width,y);}
            context.stroke();
        }
    }
    context.restore();
}



function drawArrowHead(context, fromX, fromY, toX, toY, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    context.beginPath(); context.moveTo(toX, toY);
    context.lineTo(toX - Math.cos(angle - Math.PI / 6) * size, toY - Math.sin(angle - Math.PI / 6) * size);
    context.moveTo(toX, toY);
    context.lineTo(toX - Math.cos(angle + Math.PI / 6) * size, toY - Math.sin(angle + Math.PI / 6) * size); context.stroke();
}


function wrapNoteText(context,text,width) {
    const lines=[];
    for(const paragraph of String(text).split('\n')){
        let line='';
        for(const character of paragraph){
            if(line&&context.measureText(line+character).width>width-28){lines.push(line);line='';}
            line+=character;
        }
        lines.push(line);
    }
    return lines;
}

function noteHeight(text,width) {
    const context=state.context||document.createElement('canvas').getContext('2d');
    context.save();context.font='20px "Segoe UI", "Microsoft YaHei", sans-serif';
    const height=Math.max(150,wrapNoteText(context,text,width).length*27+28);context.restore();return height;
}

function drawElement(context, element, selected = false, formulaDrawings = null) {
    context.save();
    if (element.type === 'stroke') drawStroke(context, element);
    else if (['line','arrow','rect','ellipse'].includes(element.type)) {
        context.strokeStyle = element.color; context.lineWidth = element.width; context.lineCap = 'round'; context.lineJoin = 'round';
        if (['line','arrow'].includes(element.type)) { context.beginPath(); context.moveTo(element.x1, element.y1); context.lineTo(element.x2, element.y2); context.stroke(); if (element.type === 'arrow') drawArrowHead(context, element.x1, element.y1, element.x2, element.y2, 14); }
        else if (element.type === 'rect') { context.beginPath(); context.roundRect(element.x1, element.y1, element.x2 - element.x1, element.y2 - element.y1, 0); context.stroke(); }
        else { context.beginPath(); context.ellipse((element.x1 + element.x2) / 2, (element.y1 + element.y2) / 2, Math.abs(element.x2 - element.x1) / 2, Math.abs(element.y2 - element.y1) / 2, 0, 0, Math.PI * 2); context.stroke(); }
    } else if (element.type === 'text') {
        context.fillStyle = element.color; context.font = (element.size || 24) + 'px "Segoe UI", "Microsoft YaHei", sans-serif'; context.textBaseline = 'top';
        String(element.text).split('\n').forEach((line,index) => context.fillText(line, element.x, element.y + index * (element.size || 24) * 1.25));
    } else if (element.type === 'note') {
        const width = element.width || 220, height = element.height || 150;
        context.fillStyle = '#fff0b4'; context.strokeStyle = '#dbc984'; context.lineWidth = 1;
        context.beginPath(); context.roundRect(element.x, element.y, width, height, 10); context.fill(); context.stroke();
        context.fillStyle = element.color; context.font = '20px "Segoe UI", "Microsoft YaHei", sans-serif'; context.textBaseline = 'top';
        const lines = wrapNoteText(context,element.text,width);
        context.save(); context.beginPath(); context.rect(element.x + 10, element.y + 10, width - 20, height - 20); context.clip();
        lines.forEach((line,index) => context.fillText(line, element.x + 14, element.y + 14 + index * 27)); context.restore();
    } else if (element.type === 'formula') formulaDrawings?.get(element.id)?.draw(context, element.x, element.y);
    context.restore();
}

function elementBounds(element) {
    const cached = boundsCache.get(element); if (cached) return cached;
    const box = getElementBounds(element); boundsCache.set(element, box); return box;
}

function visible(element) {
    const box = elementBounds(element); const left = state.camera.x - state.logicalWidth / state.camera.zoom / 2 - 100; const top = state.camera.y - state.logicalHeight / state.camera.zoom / 2 - 100;
    return box.x + box.width >= left && box.x <= left + state.logicalWidth / state.camera.zoom + 200 && box.y + box.height >= top && box.y <= top + state.logicalHeight / state.camera.zoom + 200;
}

function clearOverlay() {
    if (!state.context) return;
    state.context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0); state.context.clearRect(0, 0, state.logicalWidth, state.logicalHeight);
    if (state.tailPath) state.tailPath.setAttribute('d', '');
    if (state.inkLayer) state.inkLayer.style.opacity = '1';
}

function redrawOverlay() {
    if (!state.context) return; clearOverlay();
    const selected = state.elements.find(element => element.id === state.selectionId);
    state.context.save(); worldTransform(state.context);
    if (selected) {
        const box = elementBounds(selected), padding = 5 / state.camera.zoom;
        state.context.strokeStyle = '#007aff'; state.context.lineWidth = 1.5 / state.camera.zoom;
        state.context.setLineDash([]); state.context.beginPath(); state.context.roundRect(box.x-padding,box.y-padding,box.width+padding*2,box.height+padding*2,4/state.camera.zoom); state.context.stroke();
    }
    if (state.active?.preview && state.active.type !== 'stroke') drawElement(state.context, state.active.preview);
    state.context.restore();
    if(state.active?.type==='stroke'){state.active.nextIndex=1;state.active.initialized=false;paintActiveStroke();}
    updateSelectionControls();
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
    const active = state.active, stroke = active?.type === 'stroke' ? active.preview : null;
    if (!stroke || !state.context) return;
    if (state.inkLayer) state.inkLayer.style.opacity = stroke.tool === 'highlighter' ? '.28' : '1';
    state.context.save(); worldTransform(state.context);
    const result = paintStrokeIncrement(state.context, stroke, active.nextIndex || 1, !!active.initialized);
    state.context.restore(); active.nextIndex = result.nextIndex; active.initialized = result.initialized;
    if (state.tail && state.tailPath) {
        state.tail.setAttribute('viewBox', '0 0 ' + state.logicalWidth + ' ' + state.logicalHeight);
        if (result.tail) {
            const from = screenPoint({x:result.tail.from[0],y:result.tail.from[1]}), to = screenPoint({x:result.tail.to[0],y:result.tail.to[1]});
            state.tailPath.setAttribute('d', 'M ' + from.x + ' ' + from.y + ' L ' + to.x + ' ' + to.y);
            state.tailPath.setAttribute('stroke', stroke.color); state.tailPath.setAttribute('stroke-width', String(stroke.width * state.camera.zoom));
        } else state.tailPath.setAttribute('d','');
    }
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
    const view = state;
    formulaModulePromise ||= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => module.default || module).catch(error => { formulaModulePromise = null; throw error; });
    const runtime = await formulaModulePromise; if (live(view)) view.formulaRuntime = runtime; return runtime;
}

function renderFormulaLayer() {
    const view = state, layer = view.formulaLayer; if (!layer) return;
    const version = ++view.renderVersion, formulas = view.elements.filter(element => element.type === 'formula' && visible(element));
    const ids = new Set(formulas.map(element => element.id)); [...layer.children].forEach(node => { if (!ids.has(node.dataset.id)) node.remove(); });
    if (!formulas.length) return;
    ensureFormulaRuntime().then(runtime => {
        if (!live(view) || view.renderVersion !== version || view.formulaLayer !== layer) return;
        const nodes = new Map([...layer.children].map(node => [node.dataset.id,node]));
        for (const formula of formulas) {
            let node = nodes.get(formula.id);
            if (!node) { node = document.createElement('div'); node.className = 'whiteboard-formula-object'; node.dataset.id = formula.id; layer.append(node); }
            if (node.dataset.latex !== formula.latex) { renderFormulaMarkup(runtime,formula.latex,node,{displayMode:false,output:'html'}); node.dataset.latex = formula.latex; }
            const point = screenPoint(formula); node.style.left = point.x + 'px'; node.style.top = point.y + 'px'; node.style.transform = 'scale(' + view.camera.zoom + ')'; node.style.color = formula.color;
            const box = node.getBoundingClientRect();
            if (box.width && box.height) boundsCache.set(formula,{x:formula.x,y:formula.y,width:box.width/view.camera.zoom,height:box.height/view.camera.zoom});
        }
    }).catch(error => { if (live(view) && view.renderVersion === version) setStatus('公式加载失败，可重新打开公式工具重试：' + error.message,'warning'); });
}

function resizeCanvas() {
    state.resizeFrame = null; if (!state.canvas || !state.committedCanvas || !state.surface) return;
    const rect = state.surface.getBoundingClientRect(), width = Math.max(1,Math.floor(rect.width)), height = Math.max(1,Math.floor(rect.height));
    const ratio = Math.min(globalThis.devicePixelRatio || 1,2,Math.sqrt(6000000/(width*height)));
    const pixelWidth = Math.floor(width*ratio), pixelHeight = Math.floor(height*ratio);
    state.logicalWidth = width; state.logicalHeight = height; state.pixelRatio = ratio;
    if (state.canvas.width !== pixelWidth || state.canvas.height !== pixelHeight) {
        state.canvas.width=pixelWidth;state.canvas.height=pixelHeight;state.committedCanvas.width=pixelWidth;state.committedCanvas.height=pixelHeight;
    }
    state.context ||= state.canvas.getContext('2d',{alpha:true,desynchronized:true});
    state.committedContext ||= state.committedCanvas.getContext('2d',{alpha:false,desynchronized:true});
    redraw();
}

function scheduleResize() { if (state.resizeFrame === null) state.resizeFrame = requestAnimationFrame(resizeCanvas); }

function countStrokePoints(elements = state.elements) {
    let total = 0;
    for (const element of elements) if (element.type === 'stroke') total += element.points.length;
    return total;
}

function pushUndo(snapshot = cloneElements()) {
    state.undo.push(snapshot);
    let weight = state.undo.reduce((total, entry) => total + historyWeight(entry), 0);
    while (state.undo.length > MAX_HISTORY || (weight > 500000 && state.undo.length > 1)) weight -= historyWeight(state.undo.shift());
    state.redo = [];
}

function markDirty() {
    state.dirty = true; state.draftRevision++; setStatus('有未保存修改', 'warning'); scheduleDraft(); updateControls();
}

function scheduleDraft() {
    if (state.draftTimer !== null) return;
    state.draftTimer = setTimeout(() => { state.draftTimer = null; saveDraftNow(); }, DRAFT_DELAY_MS);
}

async function saveDraftNow(strict = false, force = false) {
    const view = state;
    if(view.readOnly)return persistRecovery(strict);
    if (!view.dirty || !view.boardId || (!force && view.savedDraftRevision === view.draftRevision)) return;
    const id = view.boardId, generation = view.boardGeneration, revision = view.draftRevision;
    if (view.pendingDraft?.id === id && view.pendingDraft.revision === revision) {
        if (strict) return view.pendingDraft.promise;
        return view.pendingDraft.promise.catch(() => {});
    }
    const request = { id, name: view.boardName, document: documentValue() };
    const job = { id, revision, promise: null };
    const promise = view.storeTail.catch(() => {}).then(async () => {
        await writeDraftRequest(request);
        if (view.boardGeneration === generation && view.boardId === id) {
            view.savedDraftRevision = revision;
            if (view.legacyPending) { localStorage.removeItem(LEGACY_KEY); view.legacyPending = false; }
        }
        if (sameBoard(view, generation, id) && view.draftRevision === revision) setStatus('恢复草稿已保存');
    });
    job.promise = promise; view.pendingDraft = job; view.storeTail = promise.catch(() => {});
    promise.finally(() => { if (view.pendingDraft === job) view.pendingDraft = null; }).catch(() => {});
    if (strict) return promise;
    return promise.catch(error => { if (sameBoard(view, generation, id)) setStatus('草稿保存失败：' + (error?.message || error), 'warning'); });
}

async function thumbnailDataUrl(snapshot,view=state) {
    const canvas=await renderBoardImage(snapshot,{thumbnail:true,signal:view.abortController.signal,drawElement,drawBackground,runtime:view.formulaRuntime});
    return canvas.toDataURL('image/png');
}

async function saveBoard(asNew=false) {
    if(!editable()||state.saveBusy)return;
    finishPointer();const view=state,generation=view.boardGeneration,previousId=view.boardId;
    view.boardName=view.root.querySelector('#whiteboardName').value.trim()||'未命名白板';
    const revision=view.draftRevision;let persistedRevision=-1,activeId=previousId;
    const request={id:asNew?null:previousId,name:view.boardName,document:documentValue(),thumbnailDataUrl:null};
    view.saveBusy=true;updateControls();setStatus('正在保存…','saving');
    try{
        request.thumbnailDataUrl=await thumbnailDataUrl(request.document,view);
        if(!sameBoard(view,generation,previousId))return;
        view.savedDraftRevision=-1;
        const operation=view.storeTail.catch(()=>{}).then(async()=>{
            // A formal write deletes its draft. Invalidate confirmations again after all preceding draft writes.
            view.savedDraftRevision=-1;
            let meta;
            if(hasNativeStore())meta=await invoke('save_whiteboard',{request});
            else {
            const id=request.id||newId(),now=Date.now(),list=JSON.parse(localStorage.getItem(BROWSER_INDEX)||'[]');
            meta={id,name:request.name,createdAt:list.find(item=>item.id===id)?.createdAt||now,updatedAt:now,hasDraft:false};
            localStorage.setItem(browserBoardKey(id),JSON.stringify({meta,document:request.document,thumbnail:request.thumbnailDataUrl}));
            localStorage.setItem(BROWSER_INDEX,JSON.stringify([meta,...list.filter(item=>item.id!==id)]));localStorage.removeItem('dtkit_whiteboard_draft_'+id);
            }
            if(view.boardGeneration===generation&&view.boardId===previousId&&view.draftRevision!==revision&&!view.readOnly){
                const latestRevision=view.draftRevision;
                try{await writeDraftRequest({id:meta.id,name:view.boardName,document:documentValue(view)});}
                catch(error){if(asNew)await releaseEdit(meta.id);throw error;}
                persistedRevision=latestRevision;
            }
            return meta;
        });
        view.storeTail=operation.catch(()=>{});const meta=await operation;
        if(!sameBoard(view,generation,previousId)){if(meta?.id&&meta.id!==previousId)await releaseEdit(meta.id);return;}
        if(!meta?.id)throw new Error('保存未返回有效的白板信息');
        const canDiscardOld=!view.readOnly;
        // Adopt a successful copy before cleanup yields, so new edits and teardown drafts use its identity.
        view.boardId=meta.id;activeId=meta.id;view.isFormal=true;
        if(asNew){view.recovery=null;setReadOnly(false);}
        if(asNew){
            // A draft queued during the save belongs to the old board. Finish it before releasing that lease.
            await view.storeTail;
            if(hasNativeStore()){
                // A failed cleanup must not orphan a successfully saved copy or discard another owner's draft.
                if(canDiscardOld)try{await invoke('discard_whiteboard_draft',{id:previousId});}catch{/* Keep the old recovery draft. */}
                await releaseEdit(previousId);
            }
            else localStorage.removeItem('dtkit_whiteboard_draft_'+previousId);
        }
        if(!sameBoard(view,generation,activeId))return;
        if(view.boardName===request.name)view.boardName=meta.name;
        view.isFormal=true;view.dirty=view.draftRevision!==revision;view.savedDraftRevision=persistedRevision>=0?persistedRevision:view.dirty?-1:revision;
        if(view.legacyPending){localStorage.removeItem(LEGACY_KEY);view.legacyPending=false;}
        clearTimeout(view.draftTimer);view.draftTimer=null;
        setStatus(view.dirty?'保存完成，后续修改仍待保存':'正式白板已保存',view.dirty?'warning':'saved');
        if(view.dirty&&view.savedDraftRevision!==view.draftRevision){scheduleDraft();void saveDraftNow();}
        await loadHistory();
    }catch(error){if(sameBoard(view,generation,activeId))setStatus('保存失败：'+(error?.message||error),'warning');}
    finally{view.saveBusy=false;if(live(view))updateControls();}
}

function contentBounds() {
    if (!state.elements.length) return null;
    const boxes = state.elements.map(elementBounds); const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y)); const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function fitContent() {
    animateCamera(fitCamera(contentBounds(),state.logicalWidth,state.logicalHeight,90));
}

function hitElement(point) {
    const padding = (state.mode === 'eraser' ? Math.max(10,state.width*2) : 7) / state.camera.zoom;
    return [...state.elements].reverse().find(element => {
        const box = elementBounds(element);
        return point.x >= box.x-padding && point.x <= box.x+box.width+padding && point.y >= box.y-padding && point.y <= box.y+box.height+padding && hitTestElement(element.type==='formula'?{...element,width:box.width,height:box.height}:element,point,padding,{fill:state.mode==='select'});
    });
}

function moveElement(element,dx,dy) { translateElement(element,dx,dy); boundsCache.delete(element); }

function beginPointer(event) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.pointerType === 'touch' && state.active?.pointerType === 'pen') return;
    if(event.pointerType==='touch')state.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if (event.pointerType === 'touch' && state.pointers.size === 2) {
        cancelPointer(false); state.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
        const points=[...state.pointers.values()]; if(points.length<2)return;
        const rect=state.canvas.getBoundingClientRect(), center={x:(points[0].x+points[1].x)/2-rect.left,y:(points[0].y+points[1].y)/2-rect.top};
        state.pinch={distance:Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y),camera:{...state.camera},center};
        for(const id of state.pointers.keys())try{state.canvas.setPointerCapture(id);}catch{}
        event.preventDefault(); return;
    }
    if (state.pointerId !== null || state.pinch) return;
    event.preventDefault(); closeHistory(); closeToolPanels(); closeHelp(); cancelCameraAnimation();
    const point=worldPoint(event), pan=event.button===1||state.spacePressed||state.mode==='pan';
    if (!pan && state.mode!=='select' && !editable()) return;
    state.pointerId=event.pointerId; try {state.canvas.setPointerCapture(event.pointerId);} catch { /* Synthetic or released pointer. */ }
    state.canvas.focus({preventScroll:true}); state.root.classList.add('is-interacting');
    if(pan){state.active={type:'pan',clientX:event.clientX,clientY:event.clientY,camera:{...state.camera}};updateCursor(event);return;}
    if(state.mode==='select'){
        const hit=hitElement(point);state.selectionId=hit?.id||null;state.active={type:'select',selectedId:hit?.id||null,last:point,snapshot:null,moved:false};redrawOverlay();updateControls();return;
    }
    state.selectionId=null;
    if(['pen','highlighter','line','arrow','rect','ellipse','text','note','formula'].includes(state.mode) && state.elements.length>=MAX_ELEMENTS){setStatus('已达到2000个对象，请新建白板后继续','warning');finishPointer();return;}
    if(['pen','highlighter'].includes(state.mode)){
        if(state.totalPoints>=MAX_POINTS){setStatus('笔迹点数已达上限，请新建白板','warning');finishPointer();return;}
        clearOverlay();state.active={type:'stroke',pointerType:event.pointerType,nextIndex:1,initialized:false,preview:{id:newId(),type:'stroke',tool:state.mode,color:state.color,width:state.width/state.camera.zoom,points:[[point.x,point.y,point.pressure]]}};schedulePointerRender('stroke');
    }else if(['line','arrow','rect','ellipse'].includes(state.mode)){
        clearOverlay();state.active={type:'shape',start:point,preview:{id:newId(),type:state.mode,color:state.color,width:state.width/state.camera.zoom,x1:point.x,y1:point.y,x2:point.x,y2:point.y}};schedulePointerRender('overlay');
    }else if(state.mode==='eraser'){state.active={type:'erase',snapshot:null,last:point,changed:false};eraseAt(point);}
    else if(['text','note','formula'].includes(state.mode)){state.pointerId=null;state.active=null;state.root.classList.remove('is-interacting');try{state.canvas.releasePointerCapture(event.pointerId);}catch{}void openObjectDialog(state.mode,point);}
    updateCursor(event);
}

function movePointer(event) {
    updateCursor(event);
    if(state.pointers.has(event.pointerId))state.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(state.pinch && state.pointers.size>=2){
        event.preventDefault();const points=[...state.pointers.values()],rect=state.canvas.getBoundingClientRect(),center={x:(points[0].x+points[1].x)/2-rect.left,y:(points[0].y+points[1].y)/2-rect.top};
        const gesture=state.pinch,next=Math.max(.1,Math.min(8,gesture.camera.zoom*Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y)/Math.max(1,gesture.distance)));
        const worldX=gesture.camera.x+(gesture.center.x-state.logicalWidth/2)/gesture.camera.zoom,worldY=gesture.camera.y+(gesture.center.y-state.logicalHeight/2)/gesture.camera.zoom;
        state.camera={x:worldX-(center.x-state.logicalWidth/2)/next,y:worldY-(center.y-state.logicalHeight/2)/next,zoom:next};schedulePointerRender('full');updateControls();return;
    }
    if(event.pointerId!==state.pointerId||!state.active)return;event.preventDefault();
    if(state.active.type==='pan'){state.camera.x=state.active.camera.x-(event.clientX-state.active.clientX)/state.camera.zoom;state.camera.y=state.active.camera.y-(event.clientY-state.active.clientY)/state.camera.zoom;schedulePointerRender('full');return;}
    if(!editable() && state.active.type!=='select')return;
    const samples=typeof event.getCoalescedEvents==='function'?event.getCoalescedEvents():[], events=samples.length?samples:[event];
    if(state.active.type==='stroke'){
        const points=state.active.preview.points;
        for(const sample of events){const point=worldPoint(sample),last=points.at(-1);if(Math.hypot(point.x-last[0],point.y-last[1])*state.camera.zoom>.7&&points.length<MAX_STROKE_POINTS&&state.totalPoints+points.length<MAX_POINTS)points.push([point.x,point.y,point.pressure]);}
        schedulePointerRender('stroke');return;
    }
    const point=worldPoint(events.at(-1));
    if(state.active.type==='shape'){const end=constrainShape(state.active.preview.type,state.active.start,point,event.shiftKey);state.active.preview.x2=end.x;state.active.preview.y2=end.y;schedulePointerRender('overlay');}
    else if(state.active.type==='select'&&state.active.selectedId&&editable()){
        const element=state.elements.find(element=>element.id===state.active.selectedId);
        if(element && Math.hypot(point.x-state.active.last.x,point.y-state.active.last.y)>.05){state.active.snapshot ||= cloneElements();moveElement(element,point.x-state.active.last.x,point.y-state.active.last.y);state.active.moved=true;state.active.last=point;schedulePointerRender('full');}
    }else if(state.active.type==='erase'){
        for(const sample of events){const next=worldPoint(sample),previous=state.active.last,steps=Math.min(128,Math.max(1,Math.ceil(Math.hypot(next.x-previous.x,next.y-previous.y)*state.camera.zoom/8)));
            for(let index=1;index<=steps;index++)eraseAt({x:previous.x+(next.x-previous.x)*index/steps,y:previous.y+(next.y-previous.y)*index/steps});state.active.last=next;}
        schedulePointerRender('full');
    }
}

function finishPointer(event) {
    if(event)state.pointers.delete(event.pointerId);
    if(state.pinch){if(state.pointers.size<2){state.pinch=null;state.pointerId=null;state.active=null;state.root?.classList.remove('is-interacting');}return;}
    if(event&&event.pointerId!==state.pointerId)return;
    const active=state.active;try{if(state.pointerId!==null)state.canvas?.releasePointerCapture?.(state.pointerId);}catch{}
    state.pointerId=null;state.active=null;if(!event)state.pointers.clear();state.root?.classList.remove('is-interacting');
    if(!active)return;cancelPendingDraw();
    if(editable()){
        if(active.type==='stroke'&&active.preview.points.length){pushUndo();state.elements.push(active.preview);state.totalPoints+=active.preview.points.length;markDirty();}
        else if(active.type==='shape'&&Math.hypot(active.preview.x2-active.preview.x1,active.preview.y2-active.preview.y1)>2){pushUndo();state.elements.push(active.preview);markDirty();}
        else if((active.type==='select'&&active.moved||active.type==='erase'&&active.changed)&&active.snapshot){pushUndo(active.snapshot);markDirty();}
    }
    redraw();updateControls();
}

function zoomAt(event) {
    event.preventDefault();if(state.pointerId!==null||state.pinch)return;cancelCameraAnimation();
    const rect=state.canvas.getBoundingClientRect(),delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?state.logicalHeight:1);
    state.camera=zoomCamera(state.camera,state.camera.zoom*Math.exp(-Math.max(-200,Math.min(200,delta))*.003),{x:event.clientX-rect.left,y:event.clientY-rect.top},state.logicalWidth,state.logicalHeight);
    schedulePointerRender('full');updateControls();
}

function setMode(mode) {
    if((state.readOnly||state.boardBusy)&&!['select','pan'].includes(mode))return;
    if(!['select','pan','pen','highlighter','eraser','line','arrow','rect','ellipse','text','note','formula'].includes(mode))return;
    finishPointer();state.mode=mode;closeToolPanels();if(mode!=='select')state.selectionId=null;redrawOverlay();updateControls();savePrefs();
}

function setColor(color) {
    if(!editable()||!/^#[0-9a-f]{6}$/i.test(color))return;
    state.color=color.toLowerCase();
    const element=selectedElement();if(state.mode==='select'&&element&&element.color!==state.color){pushUndo();element.color=state.color;markDirty();redraw();}
    updateControls();savePrefs();
}

function replaceElements(elements) {
    state.elements = elements; state.totalPoints = countStrokePoints(elements); boundsCache = new WeakMap();
}

function undo() { if(!editable())return;finishPointer();if(!state.undo.length)return;state.redo.push(cloneElements());replaceElements(state.undo.pop());state.active=null;state.selectionId=null;markDirty();redraw(); }

function redo() { if(!editable())return;finishPointer();if(!state.redo.length)return;pushUndoPreservingRedo();replaceElements(state.redo.pop());state.active=null;state.selectionId=null;markDirty();redraw(); }

function updateControls() {
    if (!state.root) return;
    const blocked = state.readOnly || state.boardBusy;
    state.root.style.setProperty('--wb-ink',state.color); state.root.style.setProperty('--wb-pen-width',state.width+'px');
    state.root.setAttribute('aria-busy',String(state.boardBusy)); state.surface.dataset.mode=state.spacePressed?'pan':state.mode;
    state.surface.classList.toggle('is-empty',state.elements.length===0);
    state.root.querySelectorAll('[data-board-mode]').forEach(button=>{
        button.setAttribute('aria-pressed',String(button.dataset.boardMode===state.mode));
        button.disabled=state.boardBusy || (state.readOnly && !['select','pan'].includes(button.dataset.boardMode));
    });
    state.root.querySelectorAll('[data-panel-modes]').forEach(button=>button.classList.toggle('is-mode-active',button.dataset.panelModes.split(',').includes(state.mode)));
    state.root.querySelectorAll('[data-board-color]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.boardColor===state.color));button.disabled=blocked;});
    state.root.querySelectorAll('[data-board-background]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.boardBackground===state.background));button.disabled=blocked;});
    const get=id=>state.root.querySelector('#'+id);
    const name=get('whiteboardName');if(document.activeElement!==name)name.value=state.boardName;name.readOnly=blocked;
    get('whiteboardSize').value=String(state.width);get('whiteboardSize').disabled=blocked;
    get('whiteboardSizeValue').textContent=state.width+' px';get('whiteboardColorInput').value=state.color;get('whiteboardColorInput').disabled=blocked;
    get('whiteboardUndo').disabled=blocked||!state.undo.length;get('whiteboardRedo').disabled=blocked||!state.redo.length;
    get('whiteboardSave').disabled=blocked||state.saveBusy;
    get('whiteboardSave').setAttribute('aria-busy',String(state.saveBusy));
    get('whiteboardSaveAs').disabled=blocked||state.saveBusy;
    get('whiteboardClear').disabled=blocked||!state.elements.length;
    get('whiteboardNew').disabled=state.boardBusy||state.saveBusy;
    get('whiteboardExport').disabled=state.exportBusy||state.boardBusy;
    get('whiteboardTakeOver').disabled=state.boardBusy||state.saveBusy;
    get('whiteboardObjectCount').textContent=state.elements.length+' 个对象';
    get('whiteboardZoom').textContent=Math.round(state.camera.zoom*100)+'%';
    get('whiteboardZoomOut').disabled=state.camera.zoom<=.1001;
    get('whiteboardZoomIn').disabled=state.camera.zoom>=7.999;
    if(state.cursor && blocked)state.cursor.hidden=true;
    updateSelectionControls();
}

function setReadOnly(readOnly) {
    if(readOnly&&!state.readOnly){
        cancelPointer();state.dialog?.close();
        if(state.dirty&&state.savedDraftRevision!==state.draftRevision){
            state.recovery={id:newId(),name:(state.boardName+' · 接管前恢复').slice(0,60),document:documentValue(),revision:state.draftRevision,persisted:false};
        }
    }
    state.readOnly=Boolean(readOnly);
    const banner=state.root?.querySelector('#whiteboardReadOnly');if(banner)banner.hidden=!state.readOnly;
    updateControls();
    if(state.readOnly&&state.recovery)void persistRecovery();
}

async function releaseEdit(id = state.boardId) {
    if (!hasNativeStore() || !id) return;
    try { await invoke('release_whiteboard_edit', { id }); } catch { /* Best effort on teardown. */ }
}

async function takeOverEdit() {
    const view=state,id=view.boardId,generation=view.boardGeneration;
    if(!hasNativeStore()||!id||view.boardBusy||view.saveBusy)return;
    view.boardBusy=true;updateControls();
    try{
        await persistRecovery(true);
        await invoke('take_over_whiteboard_edit',{id});
        const result=await invoke('load_whiteboard',{id});
        if(!sameBoard(view,generation,id)){if(result.editable)await releaseEdit(id);return;}
        const value=normalizeDocumentV2(result.draft?.document||result.document);
        applyDocument(value,result.draft?.name||result.meta.name);view.isFormal=result.isFormal!==false;
        view.dirty=Boolean(result.draft);view.savedDraftRevision=view.draftRevision;
        view.recovery=null;setReadOnly(result.editable===false);
        setStatus(view.readOnly?'编辑权再次被接管，请重试':'已加载最新内容并接管编辑权',view.readOnly?'warning':'saved');
    }catch(error){if(sameBoard(view,generation,id)){await releaseEdit(id);setStatus('接管失败：'+(error?.message||error),'warning');}}
    finally{if(live(view)){view.boardBusy=false;updateControls();}}
}

function openObjectDialog(type,point,element=null) { if(editable())return state.dialog?.open(type,point,element); }

function confirmObjectDialog({type,point,value,element}) {
    if(!editable())return false;
    if(!element && state.elements.length>=MAX_ELEMENTS){setStatus('已达到 2000 个对象上限，请新建白板继续','warning');return false;}
    const existing=element && state.elements.find(item=>item.id===element.id);
    if(element && !existing)return false;
    pushUndo();
    if(existing){if(type==='formula')existing.latex=value;else existing.text=value;if(type==='note')existing.height=noteHeight(value,existing.width);boundsCache.delete(existing);}
    else{
        const base={id:newId(),type,color:state.color,x:point.x,y:point.y};
        state.elements.push(type==='formula'?{...base,latex:value,width:220,height:60}:type==='note'?{...base,text:value,width:220,height:noteHeight(value,220)}:{...base,text:value,size:24});
    }
    markDirty();redraw();return true;
}

function toggleHistory() {
    const panel=state.root.querySelector('#whiteboardHistory'),open=panel.getAttribute('aria-hidden')==='true';
    closeToolPanels();closeHelp();
    panel.inert=!open;panel.setAttribute('aria-hidden',String(!open));
    state.root.querySelector('#whiteboardHistoryRail').setAttribute('aria-expanded',String(open));
    if(open)void loadHistory();
}

function closeHistory() {
    const panel=state.root?.querySelector('#whiteboardHistory');if(!panel)return;
    if(panel.contains(document.activeElement))state.root.querySelector('#whiteboardHistoryRail')?.focus({preventScroll:true});
    panel.inert=true;panel.setAttribute('aria-hidden','true');state.root.querySelector('#whiteboardHistoryRail')?.setAttribute('aria-expanded','false');
}

function closeToolPanels(except=null) {
    state.root?.querySelectorAll('[data-board-panel-content]').forEach(panel=>{if(panel.dataset.boardPanelContent!==except)showPopover(panel,false);});
    state.root?.querySelectorAll('[data-board-panel]').forEach(button=>{if(button.dataset.boardPanel!==except)button.setAttribute('aria-expanded','false');});
}

function toggleToolPanel(name) {
    const panel=state.root.querySelector('[data-board-panel-content="'+name+'"]'),trigger=state.root.querySelector('[data-board-panel="'+name+'"]');
    if(!panel||!trigger)return;
    const opening=trigger.getAttribute('aria-expanded')!=='true';closeToolPanels(opening?name:null);closeHelp();closeHistory();
    showPopover(panel,opening);trigger.setAttribute('aria-expanded',String(opening));
}

async function loadHistory() {
    const view=state,version=++view.historyVersion,list=view.root?.querySelector('#whiteboardHistoryList');if(!list)return;
    let items;
    try{items=hasNativeStore()?await invoke('list_whiteboards'):readBrowserHistory();}
    catch(error){if(live(view)&&view.historyVersion===version)setStatus('历史记录读取失败：'+(error?.message||error),'warning');return;}
    if(!live(view)||view.historyVersion!==version)return;
    view.histories=Array.isArray(items)?items.filter(item=>item&&typeof item.id==='string'&&typeof item.name==='string'):[];
    view.historyObserver?.disconnect();list.replaceChildren();
    if(!view.histories.length){const empty=document.createElement('div');empty.className='whiteboard-history-empty';empty.textContent='从一笔开始，恢复草稿与正式白板都会留在这里';list.append(empty);return;}
    for(const item of view.histories){
        const button=document.createElement('button');button.type='button';button.className='whiteboard-history-card'+(item.id===view.boardId?' is-current':'');button.dataset.boardId=item.id;
        const thumb=document.createElement('span');thumb.className='whiteboard-history-thumb';thumb.dataset.thumbnailId=item.id;
        const glyph=document.createElement('i');glyph.className='ri-layout-grid-line';thumb.append(glyph);
        const label=document.createElement('span'),title=document.createElement('strong'),date=document.createElement('small');
        title.textContent=item.name;date.textContent=new Date(item.updatedAt).toLocaleString()+(item.hasDraft?' · 未保存草稿':'');label.append(title,date);button.append(thumb,label);
        button.addEventListener('click',()=>void openBoard(item.id),{signal:view.abortController.signal});list.append(button);
    }
    if(typeof IntersectionObserver==='function'){
        view.historyObserver=new IntersectionObserver(entries=>entries.filter(entry=>entry.isIntersecting).forEach(entry=>void loadThumbnail(entry.target,view,version)),{root:list,rootMargin:'80px'});
        list.querySelectorAll('[data-thumbnail-id]').forEach(node=>view.historyObserver.observe(node));
    }else for(const node of list.querySelectorAll('[data-thumbnail-id]'))void loadThumbnail(node,view,version);
}

async function loadThumbnail(node,view=state,version=view.historyVersion) {
    view.historyObserver?.unobserve(node);
    try{
        const source=hasNativeStore()?await invoke('get_whiteboard_thumbnail',{id:node.dataset.thumbnailId}):JSON.parse(localStorage.getItem(browserBoardKey(node.dataset.thumbnailId))||'null')?.thumbnail;
        if(!live(view)||version!==view.historyVersion||!node.isConnected||!source?.startsWith('data:image/png;base64,'))return;
        const image=new Image();image.alt='';image.loading='lazy';image.src=source;node.replaceChildren(image);
    }catch{/* Keep the lightweight placeholder. */}
}

async function openBoard(id) {
    if (id === state.boardId || state.boardBusy || state.saveBusy) return;
    finishPointer(); const view = state, previousId = view.boardId, generation = view.boardGeneration;
    view.boardBusy = true; updateControls(); setStatus('正在打开白板…', 'saving');
    let acquiredId = null;
    try {
        await saveDraftNow(true); if (!sameBoard(view, generation, previousId)) return;
        let result;
        if (hasNativeStore()) result = await invoke('load_whiteboard', { id });
        else {
            const stored = JSON.parse(localStorage.getItem(browserBoardKey(id)) || 'null');
            const draft = JSON.parse(localStorage.getItem('dtkit_whiteboard_draft_' + id) || 'null');
            if (!stored && !draft) throw new Error('白板不存在');
            result = { meta: stored?.meta || { id, name: draft.name }, document: stored?.document, draft, editable: true, isFormal: !!stored };
        }
        acquiredId = result?.meta?.id; if (!sameBoard(view, generation, previousId)) { if (acquiredId && acquiredId !== previousId) await releaseEdit(acquiredId); return; }
        const value = normalizeDocumentV2(result.draft?.document || result.document);
        await releaseEdit(previousId); if (!sameBoard(view, generation, previousId)) { if (acquiredId) await releaseEdit(acquiredId); return; }
        clearTimeout(view.draftTimer); view.draftTimer = null; view.boardGeneration++;
        view.boardId = result.meta.id; view.boardName = result.meta.name; view.isFormal = result.isFormal !== false;
        view.recovery=null; applyDocument(value, result.draft?.name || result.meta.name); view.dirty = !!result.draft; view.savedDraftRevision = view.dirty ? 0 : -1; setReadOnly(result.editable === false);
        closeHistory(); setStatus(view.readOnly ? '已以只读方式打开' : result.draft ? '已恢复未保存草稿' : '正式白板已打开', view.readOnly || result.draft ? 'warning' : 'saved');
        await loadHistory();
    } catch (error) {
        if (acquiredId && acquiredId !== previousId && view.boardId !== acquiredId) await releaseEdit(acquiredId);
        if (live(view)) setStatus('打开失败，当前白板已保留：' + (error?.message || error), 'warning');
    } finally { if (live(view)) { view.boardBusy = false; updateControls(); } }
}

async function newBoard() {
    if (state.boardBusy || state.saveBusy) return;
    finishPointer(); const view = state, id = view.boardId, generation = view.boardGeneration;
    view.boardBusy = true; updateControls();
    try {
        await saveDraftNow(true); await view.storeTail; if (!sameBoard(view, generation, id)) return;
        await releaseEdit(id); if (!sameBoard(view, generation, id)) return;
        clearTimeout(view.draftTimer); view.draftTimer = null; view.boardGeneration++; view.boardId = newId();
        view.boardName = '未命名白板'; view.isFormal = false; view.dirty = false; view.legacyPending = false; view.draftRevision = 0; view.savedDraftRevision = -1;
        view.selectionId=null; view.recovery=null; cancelCameraAnimation(); replaceElements([]); view.camera = { x: 0, y: 0, zoom: 1 }; view.undo = []; view.redo = []; view.active = null;
        closeHistory(); setReadOnly(false); redraw(); setStatus('新白板');
    } catch (error) { if (live(view)) setStatus('恢复草稿保存失败，当前白板已保留：' + (error?.message || error), 'warning'); }
    finally { if (live(view)) { view.boardBusy = false; updateControls(); } }
}



async function exportBoard() {
    if(state.exportBusy||state.boardBusy)return;
    finishPointer();const view=state,generation=view.boardGeneration,id=view.boardId,snapshot=documentValue(),name=view.boardName;
    view.exportBusy=true;updateControls();setStatus('正在生成高清图片…','saving');closeToolPanels();
    try{
        const canvas=await renderBoardImage(snapshot,{signal:view.abortController.signal,drawElement,drawBackground,runtime:view.formulaRuntime});
        if(!sameBoard(view,generation,id))return;
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('无法生成 PNG 图片')),'image/png'));
        if(!sameBoard(view,generation,id))return;
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=(name||'DtKit-白板')+'.png';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('当前白板已导出为高清 PNG');
    }catch(error){if(sameBoard(view,generation,id))setStatus('导出失败：'+(error?.message||error),'warning');}
    finally{view.exportBusy=false;if(live(view))updateControls();}
}

function clearBoard() { if(!editable()||!state.elements.length||!globalThis.confirm('清空当前白板？可以使用撤销恢复。'))return;finishPointer();pushUndo();replaceElements([]);state.selectionId=null;markDirty();redraw(); }

function bindEvents(signal) {
    const view=state,on=(id,event,handler)=>view.root.querySelector('#'+id)?.addEventListener(event,handler,{signal});
    view.canvas.addEventListener('pointerdown',beginPointer,{signal});view.canvas.addEventListener('pointermove',movePointer,{signal});
    view.canvas.addEventListener('pointerup',finishPointer,{signal});view.canvas.addEventListener('pointercancel',()=>cancelPointer(),{signal});
    view.canvas.addEventListener('lostpointercapture',event=>{if(view.pointerId===event.pointerId)cancelPointer();},{signal});
    view.canvas.addEventListener('pointerleave',()=>{view.cursor.hidden=true;},{signal});
    view.canvas.addEventListener('wheel',zoomAt,{passive:false,signal});
    view.canvas.addEventListener('dblclick',event=>{if(view.mode!=='select'||!editable())return;const element=hitElement(worldPoint(event));if(element&&['text','note','formula'].includes(element.type))openObjectDialog(element.type,{x:element.x,y:element.y},element);},{signal});
    view.root.querySelectorAll('[data-board-mode]').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.boardMode),{signal}));
    view.root.querySelectorAll('[data-board-panel]').forEach(button=>button.addEventListener('click',()=>toggleToolPanel(button.dataset.boardPanel),{signal}));
    view.root.querySelectorAll('[data-board-color]').forEach(button=>button.addEventListener('click',()=>setColor(button.dataset.boardColor),{signal}));
    on('whiteboardColorInput','input',event=>setColor(event.target.value));
    on('whiteboardSize','input',event=>{if(!editable())return;view.width=Number(event.target.value);savePrefs();updateControls();});
    on('whiteboardName','input',event=>{if(!editable())return;view.boardName=event.target.value;markDirty();});
    on('whiteboardUndo','click',undo);on('whiteboardRedo','click',redo);
    on('whiteboardSave','click',()=>void saveBoard());on('whiteboardSaveAs','click',()=>void saveBoard(true));
    on('whiteboardExport','click',()=>void exportBoard());on('whiteboardClear','click',clearBoard);on('whiteboardFit','click',fitContent);
    on('whiteboardZoomOut','click',()=>animateCamera({...view.camera,zoom:Math.max(.1,view.camera.zoom/1.25)}));
    on('whiteboardZoomIn','click',()=>animateCamera({...view.camera,zoom:Math.min(8,view.camera.zoom*1.25)}));
    on('whiteboardZoomReset','click',()=>animateCamera({...view.camera,zoom:1}));
    on('whiteboardHistoryRail','click',toggleHistory);on('whiteboardHistoryClose','click',closeHistory);on('whiteboardNew','click',()=>void newBoard());
    on('whiteboardTakeOver','click',()=>void takeOverEdit());
    on('whiteboardBackground','click',()=>{const menu=view.root.querySelector('#whiteboardBackgroundMenu'),button=view.root.querySelector('#whiteboardBackground'),open=button.getAttribute('aria-expanded')!=='true';showPopover(menu,open);button.setAttribute('aria-expanded',String(open));});
    view.root.querySelectorAll('[data-board-background]').forEach(button=>button.addEventListener('click',()=>{
        if(!editable())return;
        if(view.background!==button.dataset.boardBackground){view.background=button.dataset.boardBackground;savePrefs();markDirty();redraw();}
        updateControls();
    },{signal}));
    on('whiteboardDelete','click',deleteSelected);on('whiteboardDuplicate','click',duplicateSelected);
    on('whiteboardEditSelected','click',()=>{const element=selectedElement();if(element)openObjectDialog(element.type,{x:element.x,y:element.y},element);});
    on('whiteboardHelp','click',()=>{const button=view.root.querySelector('#whiteboardHelp'),open=button.getAttribute('aria-expanded')!=='true';closeToolPanels();closeHistory();showPopover(view.root.querySelector('#whiteboardHelpPanel'),open);button.setAttribute('aria-expanded',String(open));});
    document.addEventListener('keydown',event=>{
        if(!live(view)||view.dialog?.isOpen())return;
        const key=event.key.toLowerCase(),modifier=event.ctrlKey||event.metaKey;
        const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]');
        if(modifier&&key==='s'){event.preventDefault();void saveBoard(event.shiftKey);return;}
        if(key==='escape'){
            const trigger=view.root.querySelector('[data-board-panel][aria-expanded="true"]');
            const handled=trigger||view.active||view.selectionId||view.root.querySelector('#whiteboardHelp')?.getAttribute('aria-expanded')==='true'||view.root.querySelector('#whiteboardHistory')?.getAttribute('aria-hidden')==='false';
            if(handled)event.preventDefault();
            closeToolPanels();closeHelp();closeHistory();cancelPointer();if(trigger)trigger.focus({preventScroll:true});else{view.selectionId=null;redrawOverlay();}return;
        }
        if(typing||event.altKey)return;
        if(modifier){
            if(key==='z'){event.preventDefault();event.shiftKey?redo():undo();}
            else if(key==='y'){event.preventDefault();redo();}
            else if(key==='d'){event.preventDefault();duplicateSelected();}
            else if(key==='0'){event.preventDefault();fitContent();}
            else if(key==='1'){event.preventDefault();animateCamera({...view.camera,zoom:1});}
            return;
        }
        if(key===' '){event.preventDefault();view.spacePressed=true;updateControls();return;}
        if(['delete','backspace'].includes(key)){if(selectedElement()){event.preventDefault();deleteSelected();}return;}
        if(key.startsWith('arrow')&&selectedElement()){event.preventDefault();const step=event.shiftKey?10:1;nudgeSelected(key==='arrowleft'?-step:key==='arrowright'?step:0,key==='arrowup'?-step:key==='arrowdown'?step:0);return;}
        const modes={v:'select',b:'pen',h:'highlighter',e:'eraser',r:'rect',o:'ellipse',l:'line',a:'arrow',t:'text',n:'note',f:'formula'};
        if(modes[key]){event.preventDefault();setMode(modes[key]);}
    },{signal});
    document.addEventListener('pointerdown',event=>{
        if(!event.target.closest('.whiteboard-cluster'))closeToolPanels();
        if(!event.target.closest('#whiteboardHelp,#whiteboardHelpPanel'))closeHelp();
    },{signal});
    view.root.addEventListener('keydown',event=>{
        const panel=event.target.closest('[data-board-panel-content]');
        if(!panel||event.target.matches('input,textarea')||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        const buttons=[...panel.querySelectorAll('button:not(:disabled)')].filter(button=>button.getClientRects().length);if(!buttons.length)return;
        event.preventDefault();const index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;buttons[next].focus();
    },{signal});
    document.addEventListener('keyup',event=>{if(event.key===' '){view.spacePressed=false;updateControls();}},{signal});
    window.addEventListener('blur',()=>{view.spacePressed=false;cancelPointer();updateControls();},{signal});
    window.addEventListener('dtkit:power-state',event=>{if(event.detail?.suspended){finishPointer();cancelCameraAnimation();void saveDraftNow();}},{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){finishPointer();cancelCameraAnimation();void saveDraftNow();}},{signal});
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change',()=>{
        if(!motion.matches)return;
        const target=view.cameraTarget;cancelCameraAnimation();if(target){view.camera=target;redraw();updateControls();}
        for(const [node,entry] of view.popovers){entry.animation?.cancel();node.hidden=!entry.open;}view.popovers.clear();
    },{signal});
}

async function initWhiteboardTool() {
    await destroyWhiteboardTool();state=createState();boundsCache=new WeakMap();
    const view=state;view.abortController=new AbortController();view.root=document.querySelector('.whiteboard-tool');
    if(!view.root){view.abortController.abort();return;}
    const get=id=>view.root.querySelector('#'+id);
    view.canvas=get('whiteboardCanvas');view.committedCanvas=get('whiteboardCommittedCanvas');view.surface=get('whiteboardSurface');view.formulaLayer=get('whiteboardFormulaLayer');
    view.inkLayer=get('whiteboardInkLayer');view.tail=get('whiteboardStrokeTail');view.tailPath=get('whiteboardStrokeTailPath');view.cursor=get('whiteboardCursor');
    readPrefs();view.boardId=newId();
    view.dialog=createObjectDialog({root:view.root,signal:view.abortController.signal,isEditable:()=>live(view)&&editable(),ensureFormulaRuntime,onConfirm:confirmObjectDialog});
    bindEvents(view.abortController.signal);mountSegmentedControl(view.root.querySelector('.whiteboard-direct-tools'),{signal:view.abortController.signal});
    if(typeof ResizeObserver==='function'){view.resizeObserver=new ResizeObserver(()=>{if(live(view))scheduleResize();});view.resizeObserver.observe(view.surface);}
    else window.addEventListener('resize',scheduleResize,{signal:view.abortController.signal});
    const listen=window.__TAURI__?.event?.listen;
    if(listen){
        Promise.resolve(listen('whiteboard-edit-revoked',event=>{
            if(!live(view))return;
            const revoked=event.payload,instanceId=window.__DTKIT_TOOL_PAGE_CONTEXT?.instanceId??null;
            const owner=typeof revoked==='string'||(revoked?.instanceId??null)===instanceId;
            if(owner&&(typeof revoked==='string'?revoked:revoked?.id)===view.boardId){setReadOnly(true);setStatus('编辑权已由另一页面接管','warning');}
        })).then(unlisten=>{if(!live(view))unlisten?.();else view.editRevokedUnlisten=unlisten;}).catch(error=>{if(live(view))setStatus('编辑状态监听失败：'+(error?.message||error),'warning');});
    }
    importLegacyBoard();updateControls();scheduleResize();showPopover(view.root.querySelector('.whiteboard-toolbar'),true);await loadHistory();
}

function destroyWhiteboardTool() {
    const view=state;
    if(view.closing)return view.closing;
    if(!view.abortController)return Promise.resolve();
    finishPointer();cancelCameraAnimation();view.dialog?.close();
    const closingId=view.boardId,draftPromise=saveDraftNow(false,true);
    clearTimeout(view.draftTimer);view.draftTimer=null;view.abortController.abort();
    for(const entry of view.popovers.values())entry.animation?.cancel();view.popovers.clear();
    view.resizeObserver?.disconnect();view.historyObserver?.disconnect();view.editRevokedUnlisten?.();view.editRevokedUnlisten=null;
    if(view.resizeFrame!==null)cancelAnimationFrame(view.resizeFrame);view.resizeFrame=null;cancelPendingDraw();
    view.closing=Promise.resolve(draftPromise).then(()=>view.storeTail).catch(()=>{}).then(()=>releaseEdit(closingId));
    return view.closing;
}

function serializeWhiteboard() {
    return {version:1,boardId:state.boardId,boardName:state.boardName,isFormal:state.isFormal,dirty:state.dirty,
        document:hasNativeStore()&&!state.recovery?null:documentValue(),recovery:!!state.recovery,ui:{mode:state.mode,color:state.color,width:state.width,camera:{...state.camera}}};
}

async function restoreWhiteboard(snapshot) {
    if(snapshot?.version!==1||!/^[0-9a-f-]{36}$/i.test(snapshot.boardId||''))return;
    const view=state,generation=++view.boardGeneration,previousId=view.boardId;let acquiredId=null;
    view.boardBusy=true;updateControls();
    try{
        if(snapshot.recovery&&snapshot.document){
            applyDocument(snapshot.document,snapshot.boardName);view.boardId=newId();view.boardName=(view.boardName+' · 恢复副本').slice(0,60);view.isFormal=false;view.dirty=true;view.draftRevision=1;setReadOnly(false);await saveDraftNow(true);
        }else if(hasNativeStore()&&(snapshot.isFormal||snapshot.dirty)){
            const result=await invoke('load_whiteboard',{id:snapshot.boardId});acquiredId=result.editable?snapshot.boardId:null;
            if(!live(view)||view.boardGeneration!==generation){if(result?.editable&&snapshot.boardId!==previousId)await releaseEdit(snapshot.boardId);return;}
            const document=normalizeDocumentV2(result.draft?.document||result.document);
            if(previousId!==snapshot.boardId)await releaseEdit(previousId);
            if(!live(view)||view.boardGeneration!==generation){if(result.editable)await releaseEdit(snapshot.boardId);return;}
            view.boardId=result.meta.id;view.isFormal=result.isFormal!==false;
            applyDocument(document,result.draft?.name||result.meta.name);view.dirty=Boolean(result.draft);view.savedDraftRevision=view.draftRevision;setReadOnly(result.editable===false);
        }else{
            if(!live(view)||view.boardGeneration!==generation)return;
            if(snapshot.document)applyDocument(snapshot.document,typeof snapshot.boardName==='string'?snapshot.boardName.slice(0,60):'未命名白板');
            view.boardId=snapshot.boardId;view.isFormal=Boolean(snapshot.isFormal);view.dirty=Boolean(snapshot.dirty);
        }
        if(!live(view)||view.boardGeneration!==generation)return;
        const ui=snapshot.ui||{};
        if(['pen','highlighter','eraser','line','arrow','rect','ellipse','select','pan','text','note','formula'].includes(ui.mode))view.mode=ui.mode;
        if(/^#[0-9a-f]{6}$/i.test(ui.color||''))view.color=ui.color;
        if(Number.isFinite(ui.width))view.width=Math.min(24,Math.max(1,ui.width));
        if(ui.camera&&[ui.camera.x,ui.camera.y,ui.camera.zoom].every(Number.isFinite))view.camera={x:ui.camera.x,y:ui.camera.y,zoom:Math.min(8,Math.max(.1,ui.camera.zoom))};
        redraw();setStatus(view.readOnly?'另一页面正在编辑，已以只读方式恢复':'已恢复白板工作区',view.readOnly?'warning':'saved');
    }catch(error){if(acquiredId&&view.boardId!==acquiredId)await releaseEdit(acquiredId);throw error;}
    finally{if(live(view)&&view.boardGeneration===generation){view.boardBusy=false;updateControls();}}
}

async function flushWhiteboard() {
    const view=state;finishPointer();clearTimeout(view.draftTimer);view.draftTimer=null;
    await saveDraftNow(true,true);await view.storeTail;
}

function cancelCameraAnimation() {
    if(state.cameraFrame!==null)cancelAnimationFrame(state.cameraFrame);state.cameraFrame=null;state.cameraTarget=null;
}
function animateCamera(target) {
    cancelCameraAnimation();const view=state,start={...view.camera};view.cameraTarget=target;
    if(prefersReducedMotion()){view.camera={...target};redraw();updateControls();view.cameraTarget=null;return;}
    const began=performance.now();
    const frame=now=>{if(!live(view))return;const t=Math.min(1,(now-began)/260),ease=1-Math.pow(1-t,3);
        view.camera={x:start.x+(target.x-start.x)*ease,y:start.y+(target.y-start.y)*ease,zoom:start.zoom+(target.zoom-start.zoom)*ease};redraw();updateControls();
        if(t<1)view.cameraFrame=requestAnimationFrame(frame);else{view.cameraFrame=null;view.cameraTarget=null;}};
    view.cameraFrame=requestAnimationFrame(frame);
}
function eraseAt(point) {
    if(!editable()||state.active?.type!=='erase')return;
    const hit=hitElement(point);if(!hit)return;state.active.snapshot ||= cloneElements();state.elements=state.elements.filter(element=>element!==hit);
    state.totalPoints=countStrokePoints();state.active.changed=true;if(state.selectionId===hit.id)state.selectionId=null;
}
function cancelPointer(clearPointers=true) {
    const active=state.active;try{if(state.pointerId!==null)state.canvas?.releasePointerCapture?.(state.pointerId);}catch{}
    state.pointerId=null;state.active=null;state.pinch=null;if(clearPointers)state.pointers.clear();cancelPendingDraw();
    if(active?.snapshot)replaceElements(active.snapshot);
    if(active?.type==='pan')state.camera=active.camera;
    state.root?.classList.remove('is-interacting');redraw();updateControls();
}
function updateCursor(event) {
    if(!state.cursor||!state.surface)return;
    const rect=state.surface.getBoundingClientRect(),tool=state.spacePressed||state.active?.type==='pan'?'pan':state.mode;
    state.surface.dataset.mode=tool;const show=event&&event.pointerType!=='touch'&&['pen','highlighter','eraser'].includes(tool)&&!state.readOnly&&!state.boardBusy;
    state.cursor.hidden=!show;
    if(show){const size=tool==='eraser'?Math.max(24,state.width*4):Math.max(6,state.width);state.cursor.style.width=size+'px';state.cursor.style.height=size+'px';state.cursor.style.transform='translate3d('+(event.clientX-rect.left-size/2)+'px,'+(event.clientY-rect.top-size/2)+ 'px,0)';state.cursor.style.borderColor=tool==='eraser'?'#8e8e93':state.color;}
}
function selectedElement() { return state.elements.find(element=>element.id===state.selectionId)||null; }
function updateSelectionControls() {
    const element=selectedElement(),bar=document.getElementById('whiteboardSelectionToolbar');if(!bar)return;
    bar.hidden=!element||state.mode!=='select'||!!state.active?.moved||state.active?.type==='pan';
    const names={stroke:'笔迹',line:'直线',arrow:'箭头',rect:'矩形',ellipse:'椭圆',note:'便签',text:'文字',formula:'公式'};
    const label=document.getElementById('whiteboardSelectionLabel');if(label)label.textContent=element?names[element.type]||'对象':'';
    for(const id of ['whiteboardDuplicate','whiteboardDelete','whiteboardEditSelected']){const button=document.getElementById(id);if(button)button.disabled=!element||!editable()||(id==='whiteboardEditSelected'&&!['text','note','formula'].includes(element.type));}
}
function deleteSelected() {
    if(!editable()||!selectedElement())return;finishPointer();pushUndo();replaceElements(state.elements.filter(element=>element.id!==state.selectionId));state.selectionId=null;markDirty();redraw();
}
function duplicateSelected() {
    const element=selectedElement();if(!editable()||!element)return;
    if(state.elements.length>=MAX_ELEMENTS||state.totalPoints+(element.points?.length||0)>MAX_POINTS){setStatus('白板已达容量上限，请新建白板','warning');return;}
    const clone=structuredClone(element);clone.id=newId();translateElement(clone,24/state.camera.zoom,24/state.camera.zoom);pushUndo();state.elements.push(clone);state.totalPoints=countStrokePoints();state.selectionId=clone.id;markDirty();redraw();
}
function nudgeSelected(dx,dy) {
    const element=selectedElement();if(!editable()||!element)return;pushUndo();moveElement(element,dx/state.camera.zoom,dy/state.camera.zoom);markDirty();redraw();
}
function pushUndoPreservingRedo() { const redo=state.redo;pushUndo();state.redo=redo; }
function closeHelp() { const panel=state.root?.querySelector('#whiteboardHelpPanel');if(panel)showPopover(panel,false);state.root?.querySelector('#whiteboardHelp')?.setAttribute('aria-expanded','false'); }


function showPopover(node,open) {
    if(!node)return;
    const view=state,previous=view.popovers.get(node);
    if(previous?.open===open||(!open&&node.hidden))return;
    const current=previous&&getComputedStyle(node),from=current?{opacity:current.opacity,translate:current.translate,scale:current.scale}:null;
    previous?.animation?.cancel();
    if(!open&&node.contains(document.activeElement)){
        const name=node.dataset.boardPanelContent;
        view.root.querySelector(name?'[data-board-panel="'+name+'"]':'#whiteboardHelp')?.focus({preventScroll:true});
    }
    node.hidden=false;node.inert=!open;
    const entry={open,animation:null};view.popovers.set(node,entry);
    const finish=()=>{if(view.popovers.get(node)!==entry)return;node.hidden=!entry.open;view.popovers.delete(node);};
    if(prefersReducedMotion()||!node.animate){finish();return;}
    const first=from||(open?{opacity:0,translate:'0 -6px',scale:'.98'}:{opacity:1,translate:'0 0',scale:'1'});
    entry.animation=node.animate([first,open?{opacity:1,translate:'0 0',scale:'1'}:{opacity:0,translate:'0 -4px',scale:'.985'}],{duration:open?240:140,easing:'cubic-bezier(.22,1,.36,1)'});
    entry.animation.finished.then(finish,()=>{});
}


async function persistRecovery(strict=false) {
    const view=state,record=view.recovery;
    if(!record||record.persisted)return;
    if(!view.recoveryJob){
        const job=view.storeTail.catch(()=>{}).then(async()=>{
            // The new identity protects the new owner's document and keeps this local work discoverable in history.
            let thumbnailDataUrl=null;
            try{const image=await renderBoardImage(record.document,{thumbnail:true,drawElement,drawBackground,runtime:view.formulaRuntime});thumbnailDataUrl=image.toDataURL('image/png');}
            catch{/* A preview failure must never block preserving the document. */}
            const request={id:record.id,name:record.name,document:record.document,thumbnailDataUrl};
            if(hasNativeStore()){await invoke('save_whiteboard',{request});await releaseEdit(record.id);}
            else{
                const now=Date.now(),meta={id:record.id,name:record.name,createdAt:now,updatedAt:now,hasDraft:false},list=JSON.parse(localStorage.getItem(BROWSER_INDEX)||'[]');
                localStorage.setItem(browserBoardKey(record.id),JSON.stringify({meta,document:record.document,thumbnail:request.thumbnailDataUrl}));
                localStorage.setItem(BROWSER_INDEX,JSON.stringify([meta,...list.filter(item=>item.id!==record.id)]));
            }
            record.persisted=true;
            if(live(view)&&view.recovery===record){setStatus('未保存修改已另存为“接管前恢复”白板');await loadHistory();}
        });
        view.recoveryJob=job;view.storeTail=job.catch(()=>{});
        job.finally(()=>{if(view.recoveryJob===job)view.recoveryJob=null;}).catch(()=>{});
    }
    if(strict)return view.recoveryJob;
    return view.recoveryJob.catch(error=>{if(live(view))setStatus('恢复副本保存失败，请保留此页并重试：'+(error?.message||error),'warning');});
}


async function writeDraftRequest(request) {
    if(hasNativeStore())await invoke('save_whiteboard_draft',{request});
    else localStorage.setItem('dtkit_whiteboard_draft_'+request.id,JSON.stringify({name:request.name,document:request.document,savedAt:Date.now()}));
}

function readBrowserHistory() {
    const stored=JSON.parse(localStorage.getItem(BROWSER_INDEX)||'[]');
    const list=Array.isArray(stored)?stored.map(item=>({...item,hasDraft:!!localStorage.getItem('dtkit_whiteboard_draft_'+item.id)})):[];
    const ids=new Set(list.map(item=>item.id));
    for(let index=0;index<localStorage.length;index++){
        const key=localStorage.key(index);if(!key?.startsWith('dtkit_whiteboard_draft_'))continue;
        const id=key.slice('dtkit_whiteboard_draft_'.length);
        if(ids.has(id)||!/^[0-9a-f-]{36}$/i.test(id))continue;
        try{const draft=JSON.parse(localStorage.getItem(key));if(!draft?.document)continue;list.push({id,name:draft.name||'未命名白板',createdAt:draft.savedAt||0,updatedAt:draft.savedAt||0,hasDraft:true});ids.add(id);}
        catch{/* A damaged draft does not hide other recoverable boards. */}
    }
    return list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
}

registerTool({
    id: 'whiteboard', name: '白板', icon: 'ri-brush-2-line', colorClass: 'tool-card__icon--orange', category: 'design', status: 'ready',
    description: '无限画布、教学纸张、公式、形状与本地历史白板。', template: getTemplate, init: initWhiteboardTool, destroy: destroyWhiteboardTool,
    serialize: serializeWhiteboard, restore: restoreWhiteboard, flush: flushWhiteboard
});

export { destroyWhiteboardTool, initWhiteboardTool };
