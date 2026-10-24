import { registerTool } from '../toolRegistry.js';
import './style.css';
import { template, nodeContent, button, icon, escapeHTML as h } from './view.js';
import { TOOLS, MAX_HISTORY_DATA, newId, newNode, clone, bounds, visualBounds, penGeometry, editHistory, fitsHistory, containsArea, toWorld, selectionArea, snapPosition, layoutNodes, diffOperations, exportArea } from './model.js';
import { renderPNG, imageFilePNG, textHeight } from './render.js';

const DRAG_TYPE = 'application/x-dtkit-puzzle';
let editor = null;
const context = () => window.__DTKIT_TOOL_PAGE_CONTEXT;
const invoke = (name, args = {}) => {
    const api = window.__TAURI__?.core?.invoke;
    if (!api) return Promise.reject(new Error('请在 DtKit 中使用剪贴板拼图'));
    return api(name, { ...args, instanceId: context()?.instanceId ?? null });
};

class PuzzleEditor {
    constructor(root) {
        this.root = root; this.task = null; this.overview = null; this.camera = { x: 0, y: 0, z: 1 };
        this.selection = new Set(); this.mode = 'select'; this.space = false; this.gesture = null;
        this.regionMode = 'copy'; this.regionBusy = false;
        this.undo = []; this.redo = []; this.queue = Promise.resolve(); this.disposed = false;
        this.controller = new AbortController(); this.elements = new Map(); this.assets = new Map();
        this.imageRequests = new Map(); this.jobs=new Set(); this.pending = 0; this.refreshTimer = null; this.frame = null;
        this.stage = root.querySelector('#puzzleStage'); this.world = root.querySelector('#puzzleWorld');
        this.stage.tabIndex = 0;
        this.compact = document.documentElement.classList.contains('quick-tool--clipboard-puzzle');
        root.classList.toggle('is-compact', this.compact);
    }
    on(target, type, callback, options = {}) { target.addEventListener(type, callback, { ...options, signal: this.controller.signal }); }
    status(message, error = false) {
        if (this.disposed) return;
        const el = this.root.querySelector('#puzzleStatus'); el.textContent = message; el.title = message;
        el.style.color = error ? '#b84636' : '';
    }
    guard(operation) {
        if(this.disposed) return Promise.resolve();
        const work=Promise.resolve().then(operation).catch(error=>{if(error?.name!=='AbortError') this.status(String(error?.message||error),true);});
        this.jobs.add(work); work.finally(()=>this.jobs.delete(work)); return work;
    }
    async init() {
        let savedId = null;
        try { savedId = window.parent?.__DTKIT_TOOL_WORKSPACE__?.snapshotFor(context()?.instanceId)?.state?.taskId; } catch { /* Separate windows have no parent workspace. */ }
        try{await this.open(savedId,this.compact);}
        catch(error){if(savedId&&String(error).includes('拼图不存在或已过期')){this.expiredTaskId=savedId;await this.open();this.status('原临时拼图已过期 · 已创建新任务');}else throw error;}
        this.on(this.root, 'click', event => {
            if (this.regionBusy) { this.status('正在处理区域，请稍候…'); return; }
            const tool = event.target.closest('[data-tool]');
            if (tool && tool !== this.stage) { this.setMode(tool.dataset.tool); return; }
            const action = event.target.closest('[data-action]'); if (action) this.guard(() => this.action(action.dataset.action, event, action));
            const task = event.target.closest('[data-task-id]'); if (task) this.guard(() => this.open(task.dataset.taskId));
        });
        this.on(this.root.querySelector('#puzzleName'), 'change', event => this.guard(() => this.edit([{ type: 'configure', name: event.target.value }], false)));
        this.on(this.root.querySelector('#puzzleInspector'), 'change', event => { if(event.target.matches('[data-property]')) this.guard(()=>this.changeProperty(event.target)); });
        this.on(this.root.querySelector('#puzzleModal'), 'change', event => { if(event.target.id.startsWith('puzzleExport')) this.guard(()=>this.updateExport()); });
        this.on(this.root.querySelector('#puzzleFileInput'), 'change', event => {
            const files = [...event.target.files]; event.target.value = ''; this.guard(() => this.importFiles(files));
        });
        this.on(this.stage, 'pointerdown', event => this.pointerDown(event));
        this.on(this.stage, 'pointermove', event => this.pointerMove(event));
        this.on(this.stage, 'pointerup', event => this.guard(() => this.pointerUp(event)));
        this.on(this.stage, 'pointercancel', () => this.cancelGesture());
        this.on(this.stage, 'wheel', event => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) this.zoom(Math.exp(-event.deltaY * .003), { x: event.clientX, y: event.clientY });
            else { this.camera.x -= event.deltaX; this.camera.y -= event.deltaY; this.scheduleRender(); }
        }, { passive: false });
        this.on(this.stage, 'dragstart', event => this.dragStart(event));
        this.on(this.stage, 'dragover', event => this.dragOver(event));
        this.on(this.stage, 'drop', event => { event.preventDefault(); this.guard(() => this.drop(event)); });
        this.on(this.stage, 'dragend', () => { this.dragging = null; this.guides([]); this.root.querySelector('#puzzleSelection').hidden = true; });
        this.on(this.stage, 'dblclick', event => {
            const item = event.target.closest('[data-node-id]');
            if (item) { this.selection = new Set([item.dataset.nodeId]); this.guard(() => this.editContent()); }
        });
        this.on(this.stage, 'contextmenu', event => { event.preventDefault(); this.contextMenu(event); });
        this.on(document, 'pointerdown', event => {
            if (!event.target.closest('#puzzleMenu') && !event.target.closest('[data-action=more]')) this.root.querySelector('#puzzleMenu').hidden = true;
        });
        this.on(document, 'keydown', event => this.keyDown(event));
        this.on(document, 'keyup', event => { if (event.code === 'Space') this.space = false; });
        this.on(window, 'blur', () => { this.space = false; this.cancelGesture(); });
        this.on(document, 'paste', event => {
            if (event.target.closest('input,textarea,[contenteditable=true]')) return;
            event.preventDefault(); if (!this.regionBusy) this.guard(() => this.paste());
        });
        this.on(document, 'visibilitychange', () => { if (!document.hidden) this.scheduleRefresh(); });
        this.on(window, 'dtkit:power-state', event => { if (!event.detail?.suspended) this.scheduleRefresh(); });
        this.resize = new ResizeObserver(() => this.scheduleRender()); this.resize.observe(this.stage);
        this.unlisten = await window.__TAURI__?.event?.listen?.('clipboard-puzzle-changed', () => this.scheduleRefresh());
        this.render(); this.inspector();
    }
    async open(id = null, currentCollection = false) {
        await this.queue;
        const task = await invoke('puzzle_open', { taskId: id || null, currentCollection });
        if (this.disposed) return;
        this.task = task; this.selection.clear(); this.undo = []; this.redo = []; this.root.classList.remove('tasks-open');
        this.assets.clear(); this.elements.clear(); this.world.replaceChildren();
        await this.refreshOverview();
        if(task.nodes.length) this.fit(); else this.camera={x:24-task.frame.x,y:50-task.frame.y,z:1};
        this.render(); this.inspector(); this.status(task.meta.saved ? '已打开保存的拼图' : '内容自动保留 · 手动保存可长期保留');
    }
    async refreshOverview() {
        this.overview = await invoke('puzzle_overview');
        if (this.disposed) return;
        for (const [saved, target] of [[false, '#puzzleTaskList'], [true, '#puzzleSavedList']]) {
            const tasks = this.overview.tasks.filter(t => t.saved === saved);
            this.root.querySelector(target).innerHTML = tasks.length ? tasks.map(t => `<button class="puzzle-task ${t.id === this.task?.meta.id ? 'is-active' : ''}" data-task-id="${h(t.id)}">${icon(saved ? 'save' : 'board')}<div><strong>${h(t.name)}</strong><small>${t.count} 项内容${this.overview.collection.taskId === t.id ? ' · 收集中' : ''}</small></div></button>`).join('') : '<span class="puzzle-task-empty">暂无任务</span>';
        }
        const c = this.overview.collection, active = c.taskId === this.task?.meta.id;
        const collect = this.root.querySelector('#puzzleCollect'); collect.classList.toggle('is-active', active);
        collect.innerHTML = `${icon(active ? 'pause' : 'play')}<span>${active ? '暂停收集' : '开始收集'}</span>`;
        this.root.querySelector('#puzzleCollectionStatus').textContent = active ? '正在收集到此任务' : c.taskId ? '其他任务正在收集' : '收集已暂停';
        const hours = this.overview.retentionHours;
        this.root.querySelector('[data-action=retention] span').textContent = hours === 0 ? '临时拼图 · 手动清理' : `临时保留 ${hours === 168 ? '7 天' : '24 小时'}`;
        if (c.error) this.status(c.error, true);
    }
    scheduleRefresh() {
        if (this.disposed || this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this.gesture || this.dragging || this.pending || this.regionBusy) { this.scheduleRefresh(); return; }
            this.guard(async () => {
                await this.queue; if (!this.task || this.disposed) return;
                const id = this.task.meta.id;
                const task = await invoke('puzzle_get', { taskId: id });
                if (this.task.meta.id !== id) return;
                if (task.meta.revision !== this.task.meta.revision) { this.task = task; this.selection = new Set([...this.selection].filter(id => task.nodes.some(n => n.id === id))); this.render(); this.inspector(); }
                await this.refreshOverview();
            });
        }, 90);
    }
    async edit(operations, history = true, expectedRevision = null) {
        if (!operations.length || !this.task) return;
        const id = this.task.meta.id;
        const before = clone(this.task.nodes);
        const execute = async () => {
            if (expectedRevision != null && (this.disposed || this.task?.meta.id !== id || this.task.meta.revision !== expectedRevision)) {
                throw new Error('拼图已变化，请重新框选区域');
            }
            this.pending++;
            try {
                const result = await invoke('puzzle_edit', { taskId: id, operations, expectedRevision });
                if (this.task?.meta.id !== id || this.disposed) return;
                if (history) {
                    this.recordHistory(editHistory(before,result.nodes,operations));
                }
                this.task = result; this.render(); this.inspector(); this.status('已自动保留'); this.scheduleRefresh();
            } finally { this.pending--; }
        };
        const work = this.queue.then(execute); this.queue = work.catch(() => {}); return work;
    }
    recordHistory(entry) {
        this.undo.push(entry); this.redo = [];
        while (this.undo.length > 20 || JSON.stringify(this.undo).length > MAX_HISTORY_DATA) this.undo.shift();
    }
    acceptImport(task, previousIds) {
        if (this.disposed || this.task?.meta.id !== task.meta.id) return false;
        this.task = task;
        const added = task.nodes.filter(n => !previousIds.has(n.id));
        this.selection = new Set(added.map(n => n.id));
        if (added.length) this.recordHistory({ forward: [{ type: 'upsert', nodes: clone(added) }], inverse: [{ type: 'remove', ids: added.map(n => n.id) }] });
        return true;
    }
    selected() { return this.task?.nodes.filter(n => this.selection.has(n.id)) || []; }
    expandGroup(node, additive = false) {
        if (!additive) this.selection.clear();
        if (node.groupId) this.task.nodes.filter(n => n.groupId === node.groupId).forEach(n => this.selection.add(n.id));
        else this.selection.add(node.id);
    }
    worldPoint(event) { return toWorld({ x: event.clientX, y: event.clientY }, this.stage.getBoundingClientRect(), this.camera); }
    scheduleRender() { if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); }); }
    render() {
        if (!this.task || this.disposed) return;
        const c = this.camera, size = this.stage.getBoundingClientRect();
        this.world.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`;
        this.stage.dataset.paper = this.task.background; this.stage.style.backgroundPosition = `${c.x}px ${c.y}px`;
        this.stage.style.backgroundSize = `${(this.task.background === 'grid' ? 24 : 20) * c.z}px ${(this.task.background === 'grid' ? 24 : 20) * c.z}px`;
        this.stage.dataset.tool = this.mode;
        let frame = this.world.querySelector('.puzzle-frame');
        if (!frame) { frame = document.createElement('div'); frame.className = 'puzzle-frame'; frame.innerHTML = '<span class="puzzle-frame-label">收集区 / 拼图框</span>'; this.world.prepend(frame); }
        this.position(frame, this.task.frame);
        const viewport = { x: (-c.x - 120) / c.z, y: (-c.y - 120) / c.z, w: (size.width + 240) / c.z, h: (size.height + 240) / c.z };
        const visible = new Set();
        for (const [order,node] of this.task.nodes.entries()) {
            if (!containsArea(visualBounds(node), viewport)) continue;
            visible.add(node.id); let el = this.elements.get(node.id);
            if (!el) { el = document.createElement('div'); el.className = 'puzzle-node'; el.dataset.nodeId = node.id; this.elements.set(node.id, el); this.world.append(el); }
            const signature = JSON.stringify([node.type, node.body, node.url, node.name, node.assetId, node.points, node.fontSize, node.color]);
            if (el._signature !== signature) {
                el.innerHTML = `<div class="puzzle-node-content">${nodeContent(node)}</div><button class="puzzle-resize" aria-label="调整对象大小"></button>`; el._signature = signature;
            }
            el.dataset.type = node.type; el.draggable = this.mode === 'select' && !this.space; el.style.zIndex = String(order + 1);
            el.classList.toggle('selected', this.selection.has(node.id)); this.position(el, node); el.style.color = node.color;
            el.style.transform = node.rotation ? `rotate(${node.rotation}deg)` : '';
            const body = el.querySelector('.puzzle-text-body'); if (body) body.style.fontSize = `${node.fontSize}px`;
            const svg = el.querySelector('.puzzle-shape'); if (svg) { svg.style.fill = 'none'; svg.style.stroke = node.color; svg.style.strokeWidth = '3'; svg.style.strokeLinecap = 'round'; svg.style.strokeLinejoin = 'round'; }
            const img = el.querySelector('img'); if (img && !img.src && c.z > .12) this.loadPreview(node.assetId, img);
        }
        for (const [id, el] of this.elements) if (!visible.has(id)) { el.remove(); this.elements.delete(id); }
        const input = this.root.querySelector('#puzzleName'); if (document.activeElement !== input) input.value = this.task.meta.name;
        this.root.querySelector('#puzzleSavedBadge').textContent = this.task.meta.saved ? '已保存' : '临时拼图';
        this.root.querySelector('#puzzleCount').textContent = `${this.task.nodes.length} 项内容`;
        this.root.querySelector('#puzzleObjectCount').textContent = `${this.task.nodes.length} 个对象`;
        this.root.querySelector('#puzzleZoomValue').textContent = `${Math.round(c.z * 100)}%`;
        this.root.querySelector('#puzzleEmpty').hidden = this.task.nodes.length > 0 || this.gesture?.kind === 'pen';
        this.root.querySelector('[data-action=undo]').disabled = !this.undo.length;
        this.renderInkPreview();
    }
    position(el, node) { for (const [key, value] of Object.entries({ left: node.x, top: node.y, width: node.w, height: node.h })) el.style[key] = `${value}px`; }
    async loadPreview(id, img) {
        if(img.dataset.requested === id) return;
        img.dataset.requested = id;
        try {
            let data = this.assets.get(id);
            if (!data) {
                let request = this.imageRequests.get(id);
                if (!request) { request = invoke('puzzle_asset', { assetId: id, preview: true }); this.imageRequests.set(id, request); }
                data = await request; this.imageRequests.delete(id); if (this.disposed) return;
                this.assets.set(id, data); while (this.assets.size > 16 || [...this.assets.values()].reduce((n,value)=>n+value.length,0)>8*1024*1024) this.assets.delete(this.assets.keys().next().value);
            }
            if (img.isConnected && img.dataset.requested === id) img.src = data;
        } catch (error) { this.imageRequests.delete(id); if (img.isConnected) { img.alt = '原图读取失败'; this.status(String(error), true); } }
    }
    async original(id) {
        const data = await invoke('puzzle_asset', { assetId: id, preview: false });
        // Decode through the same local data source as previews, avoiding a
        // network request and an additional full-size Blob allocation.
        const image = new Image(); image.src = data;
        try { await image.decode(); return image; }
        catch (error) { image.src = ''; throw error; }
    }
    fit() {
        if (!this.task) return;
        const b = this.task.nodes.length ? bounds(this.task.nodes) : this.task.frame, r = this.stage.getBoundingClientRect();
        const z = Math.max(.08, Math.min(1, (r.width - 72) / b.w, (r.height - 150) / b.h));
        this.camera = { x: (r.width - b.w * z) / 2 - b.x * z, y: (r.height - b.h * z) / 2 - b.y * z - 15, z }; this.scheduleRender();
    }
    zoom(factor, client = null) {
        const r = this.stage.getBoundingClientRect(), p = client || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const world = toWorld(p, r, this.camera), z = Math.max(.08, Math.min(4, this.camera.z * factor));
        this.camera = { x: p.x - r.left - world.x * z, y: p.y - r.top - world.y * z, z }; this.scheduleRender();
    }
    setMode(mode) {
        if (this.regionBusy) return;
        if (mode === 'image') { this.root.querySelector('#puzzleFileInput').click(); return; }
        this.cancelGesture(); this.mode = mode;
        this.root.querySelectorAll('.puzzle-tool-button[data-tool]').forEach(b => { b.classList.toggle('is-active', b.dataset.tool === mode); b.setAttribute('aria-pressed', String(b.dataset.tool === mode)); });
        const hint = this.root.querySelector('#puzzleModeHint');
        hint.hidden = mode === 'select'; hint.textContent = mode === 'scissors' ? this.regionMode === 'cut' ? '框出区域剪切为新图片 · 原区域留空 · Ctrl Z 撤销' : '框出区域，生成图片副本 · 原件保留' : mode === 'text' ? '点击画布插入文字' : '拖动画布绘制 · Esc 返回选择'; this.render();
    }
    renderInkPreview() {
        let el = this.world.querySelector('#puzzleInkPreview');
        const gesture = this.gesture;
        if (gesture?.kind !== 'pen') { if (el) el.hidden = true; return; }
        if (!el) { el = document.createElement('div'); el.id = 'puzzleInkPreview'; el.className = 'puzzle-ink-preview'; el.setAttribute('aria-hidden','true'); this.world.append(el); }
        const node = penGeometry(gesture.points);
        this.position(el, node); el.innerHTML = nodeContent({ ...node, type: 'pen' }); el.hidden = false;
    }
    guides(lines) {
        const parent = this.root.querySelector('#puzzleGuides'); parent.replaceChildren();
        for (const line of lines) { const el = document.createElement('div'); el.className = `puzzle-guide ${line.axis}`; el.style[line.axis === 'x' ? 'left' : 'top'] = `${line.value * this.camera.z + this.camera[line.axis]}px`; parent.append(el); }
    }
    showArea(area, scissors = false) {
        const el = this.root.querySelector('#puzzleSelection'); el.hidden = false; el.classList.toggle('scissors', scissors);
        this.position(el, { x: area.x * this.camera.z + this.camera.x, y: area.y * this.camera.z + this.camera.y, w: area.w * this.camera.z, h: area.h * this.camera.z });
    }
    pointerDown(event) {
        if (!this.task || this.pending || this.regionBusy || event.target.closest('button,input,textarea') && !event.target.closest('.puzzle-resize')) return;
        if (event.button !== 0 && event.button !== 1) return;
        this.stage.focus({ preventScroll: true });
        const p = this.worldPoint(event), item = event.target.closest('[data-node-id]'), node = item && this.task.nodes.find(n => n.id === item.dataset.nodeId);
        if (this.space || event.button === 1) {
            event.preventDefault(); this.gesture = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, camera: { ...this.camera } };
        } else if (event.target.closest('.puzzle-resize') && node && this.mode === 'select') {
            event.preventDefault(); this.gesture = { kind: 'resize', start: p, node: clone(node), before: clone(this.task.nodes) };
        } else if (this.mode === 'select' && node) {
            if (event.ctrlKey || event.metaKey) { if (this.selection.has(node.id)) this.selection.delete(node.id); else this.expandGroup(node, true); }
            else if (!this.selection.has(node.id)) this.expandGroup(node);
            this.render(); this.inspector(); return;
        } else if (this.mode === 'text') { event.preventDefault(); this.insertionPoint = p; this.guard(() => this.editContent()); return; }
        else {
            event.preventDefault(); this.gesture = { kind: this.mode === 'select' ? 'marquee' : this.mode, start: p, current: p, points: [p], additive: event.ctrlKey || event.metaKey };
            if (this.mode === 'select' && !this.gesture.additive) this.selection.clear();
            if (this.mode === 'pen') { this.selection.clear(); this.render(); }
        }
        this.stage.setPointerCapture(event.pointerId); this.pointerId = event.pointerId;
    }
    pointerMove(event) {
        const g = this.gesture; if (!g) return;
        const p = this.worldPoint(event); g.current = p;
        if (g.kind === 'pan') { this.camera.x = g.camera.x + event.clientX - g.start.x; this.camera.y = g.camera.y + event.clientY - g.start.y; this.scheduleRender(); }
        else if (g.kind === 'resize') {
            const node = this.task.nodes.find(n => n.id === g.node.id);
            node.w = Math.max(24, g.node.w + p.x - g.start.x); node.h = Math.max(24, g.node.h + p.y - g.start.y);
            if (node.type === 'image' && !event.shiftKey) node.h = node.w * g.node.h / g.node.w;
            if (node.type === 'pen' || node.type === 'arrow') node.points = g.node.points.map(point => ({ x: point.x * node.w / g.node.w, y: point.y * node.h / g.node.h }));
            this.scheduleRender();
        } else if (g.kind === 'pen') {
            for (const sample of event.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event]) {
                const point = this.worldPoint(sample);
                if (g.points.length < 20_000 && Math.hypot(point.x - g.points.at(-1).x, point.y - g.points.at(-1).y) * this.camera.z > 2) g.points.push(point);
            }
            this.scheduleRender();
        } else {
            this.showArea(selectionArea(g.start, p), g.kind === 'scissors');
        }
    }
    async pointerUp(event) {
        const g = this.gesture; if (!g) return;
        this.gesture = null; if (this.stage.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
        this.root.querySelector('#puzzleSelection').hidden = true;
        this.renderInkPreview();
        const p = this.worldPoint(event), area = selectionArea(g.start, p);
        if (g.kind === 'pan') return;
        if (g.kind === 'resize') { const after = clone(this.task.nodes); this.task.nodes = g.before; await this.edit(diffOperations(g.before, after)); return; }
        if (g.kind === 'marquee') { for (const node of this.task.nodes) if (containsArea(node, area)) this.selection.add(node.id); this.render(); this.inspector(); return; }
        if (g.kind === 'pen') {
            if (g.points.length < 20_000 && Math.hypot(p.x - g.points.at(-1).x,p.y - g.points.at(-1).y) > .01) g.points.push(p);
            const stroke = penGeometry(g.points);
            if ((stroke.w - 6) * this.camera.z < 4 && (stroke.h - 6) * this.camera.z < 4) { this.render(); return; }
        } else if (area.w * this.camera.z < 4 && area.h * this.camera.z < 4) return;
        if (g.kind === 'scissors') {
            if (area.w < 1 || area.h < 1) return;
            await this.captureRegion(area); return;
        }
        const node = newNode(g.kind, { ...area, w: Math.max(2, area.w), h: Math.max(2, area.h), name: { rect: '矩形', pen: '笔迹', arrow: '箭头' }[g.kind] });
        if (g.kind === 'pen') {
            Object.assign(node, penGeometry(g.points));
        } else if (g.kind === 'arrow') node.points = [g.start, p].map(pt => ({ x: pt.x - node.x, y: pt.y - node.y }));
        await this.edit([{ type: 'upsert', nodes: [node] }]); this.selection = new Set([node.id]); this.setMode('select'); this.inspector();
    }
    cancelGesture() {
        if (this.gesture?.before && this.task) this.task.nodes = this.gesture.before;
        this.gesture = null; if (this.pointerId != null && this.stage.hasPointerCapture(this.pointerId)) this.stage.releasePointerCapture(this.pointerId);
        this.root.querySelector('#puzzleSelection').hidden = true; this.guides([]); this.scheduleRender();
    }
    async captureRegion(area) {
        const task = clone(this.task), cut = this.regionMode === 'cut';
        const affected = task.nodes.filter(node => containsArea(visualBounds(node),area));
        if (!affected.length) { this.status('框选区域没有内容'); return; }
        this.regionBusy = true; this.root.setAttribute('aria-busy','true');
        const active = () => !this.disposed && this.task?.meta.id === task.meta.id && this.task.meta.revision === task.meta.revision;
        try {
            this.status(cut ? '正在剪切区域…' : '正在生成区域副本…');
            const options = { transparent: true, shouldContinue: active };
            const data = await renderPNG(task, area, id => this.original(id), options);
            if (!active()) throw new Error('拼图已变化，请重新框选区域');
            const asset = await invoke('puzzle_import_image', { dataUrl: data });
            const replacements = [];
            if (cut) for (const original of affected) {
                const box = visualBounds(original);
                const remainder = await renderPNG({ ...task,nodes:[original] },box,id=>this.original(id),{ ...options,eraseArea:area });
                if (!active()) throw new Error('拼图已变化，请重新框选区域');
                const residual = await invoke('puzzle_import_image',{ dataUrl:remainder });
                replacements.push(newNode('image',{ ...box,id:original.id,name:original.name || '剪切后的内容',assetId:residual.assetId,
                    groupId:original.groupId,sourceUrl:original.sourceUrl,collectedAt:original.collectedAt }));
            }
            if (!active()) throw new Error('拼图已变化，请重新框选区域');
            const node = newNode('image',{ ...area,x:cut ? area.x + area.w + 24 : area.x,name:cut ? '剪切区域' : '区域副本',assetId:asset.assetId });
            const operations = [{ type:'upsert',nodes:[...replacements,node] }];
            if (cut) {
                const replacementMap = new Map(replacements.map(node=>[node.id,node]));
                const after = [...task.nodes.map(node=>replacementMap.get(node.id) || node),node];
                if (!fitsHistory(editHistory(task.nodes,after,operations))) {
                    throw new Error('区域涉及的内容过多，无法保证撤销；请缩小剪切区域后重试');
                }
            }
            await this.edit(operations,true,task.meta.revision);
            if (!this.disposed && this.task?.meta.id === task.meta.id) {
                this.selection = new Set([node.id]); this.regionBusy = false; this.setMode('select'); this.inspector();
                this.status(cut ? '已剪切到右侧新图片 · 原区域留空 · Ctrl Z 可撤销' : '已生成区域副本 · 原件保留，可拖到其他窗口');
            }
        } finally { this.regionBusy = false; this.root.removeAttribute('aria-busy'); this.scheduleRefresh(); }
    }
    inspector() {
        const nodes = this.selected(), node = nodes.length === 1 ? nodes[0] : null, box = nodes.length ? bounds(nodes) : this.task.frame;
        const number = (key, label, value) => `<label>${label}<input type="number" data-property="${key}" value="${Math.round(value)}" step="1"></label>`;
        const title = nodes.length ? `${nodes.length === 1 ? { image: '图片', text: '文字', note: '便签', link: '链接', rect: '矩形', arrow: '箭头', pen: '笔迹' }[node.type] : `${nodes.length} 个对象`}` : '画布与收集区';
        const el = this.root.querySelector('#puzzleInspector');
        el.innerHTML = `<div class="puzzle-property-section"><h3>${title}</h3><p>${nodes.length ? '拖动到其他窗口会复制内容。' : '内容自动排列到收集区，框线只辅助排版。'}</p><span class="puzzle-property-label">${nodes.length ? '位置与尺寸' : '拼图框尺寸'}</span><div class="puzzle-property-row">${number('x','X',box.x)}${number('y','Y',box.y)}</div><div class="puzzle-property-row">${number('w','宽',box.w)}${number('h','高',box.h)}</div></div>
        ${node ? `<div class="puzzle-property-section"><div class="puzzle-property-row"><label>名称<input type="text" data-property="name" value="${h(node.name)}" maxlength="120"></label></div>${['text','note'].includes(node.type) ? `<div class="puzzle-property-row">${number('fontSize','字号',node.fontSize)}</div>${button('edit-content','text','编辑文字')}${button('restore-text','undo','恢复原始文字')}${button('copy-text','copy','复制文字')}` : ''}${node.type === 'image' ? `${button('scissors','scissors','截取图片区域')}${button('copy-image','copy','复制为图片')}` : ''}${node.type === 'link' ? `${button('edit-content','link','编辑链接')}${button('open-link','globe','打开链接')}${button('copy-link','copy','复制链接')}` : ''}${['rect','arrow','pen'].includes(node.type) ? `<div class="puzzle-property-row"><label>颜色<input type="color" data-property="color" value="${h(node.color)}"></label></div>` : ''}<div class="puzzle-property-info">${node.collectedAt ? `添加于 ${h(new Date(node.collectedAt).toLocaleString())}` : ''}${node.sourceUrl ? `<br>来源：${h(node.sourceUrl)}` : ''}</div></div>` : ''}
        <div class="puzzle-property-section"><span class="puzzle-property-label">${nodes.length ? '整理所选内容' : '整理全部内容'}</span><div class="puzzle-alignments">${button('align-left','alignLeft','左对齐')}${button('align-center','alignCenter','居中')}${button('align-right','alignRight','右对齐')}</div>${button('layout-vertical','spacing','竖向排列')}${button('layout-grid','rect','网格排列')}${nodes.length > 1 ? `${button('group','layers','组合内容')}${button('ungroup','layers','取消组合')}` : ''}</div>
        <div class="puzzle-property-section">${button('export','download','导出拼图')}${button('save','save',this.task.meta.saved ? '已保存 · 长期保留' : '保存并长期保留')}${nodes.length ? button('delete','trash','删除所选内容','puzzle-danger') : button('delete-task','trash','删除当前任务','puzzle-danger')}</div>`;
    }
    async changeProperty(input) {
            const nodes = this.selected();
            const key = input.dataset.property, value = ['name','color'].includes(key) ? input.value : Number(input.value);
            if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1_000_000)) throw new Error('请输入有效的数值');
            if (!nodes.length) { const frame = { ...this.task.frame, [key]: value }; await this.edit([{ type: 'configure', frame }], false); }
            else {
                const b = bounds(nodes);
                if (['w','h'].includes(key) && value < 24) throw new Error('对象尺寸至少为 24');
                const result = nodes.map(n => {
                    if (nodes.length === 1) return { ...n, [key]: value, ...(key === 'fontSize' && ['text','note'].includes(n.type) ? { h: textHeight(n.body,n.w,value) } : {}) };
                    if (key === 'x' || key === 'y') return { ...n, [key]: n[key] + value - b[key] };
                    const axis = key === 'w' ? 'x' : 'y', ratio = value / b[key]; return { ...n, [axis]: b[axis] + (n[axis] - b[axis]) * ratio, [key]: n[key] * ratio };
                });
                await this.edit([{ type: 'upsert', nodes: result }]);
            }
    }
    showMenu(items, event) {
        const menu = this.root.querySelector('#puzzleMenu');
        menu.innerHTML = items.map(item => item === '-' ? '<hr>' : button(item[0],item[1],item[2],item[0].startsWith('delete') ? 'puzzle-danger' : '')).join(''); menu.hidden = false;
        const r = this.root.getBoundingClientRect(), m = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min((event?.clientX || r.right - 224) - r.left, r.width - m.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min((event?.clientY || r.bottom - 380) - r.top, r.height - m.height - 8))}px`;
    }
    contextMenu(event) {
        const item = event.target.closest('[data-node-id]'), node = item && this.task.nodes.find(n => n.id === item.dataset.nodeId);
        if (node && !this.selection.has(node.id)) { this.expandGroup(node); this.render(); this.inspector(); }
        const nodes = this.selected(), first = nodes[0], items = [];
        if (nodes.length) {
            if (nodes.length === 1 && ['text','note','link'].includes(first.type)) items.push(['edit-content','text','编辑内容']);
            if (nodes.length === 1 && ['text','note'].includes(first.type)) items.push(['copy-text','copy','复制文字'],['restore-text','undo','恢复原始文字']);
            if (nodes.length === 1 && first.type === 'link') items.push(['open-link','globe','打开链接'],['copy-link','copy','复制链接']);
            if (nodes.some(n => n.type === 'image')) items.push(['scissors','scissors','截取区域副本']);
            items.push(['copy-image','image','复制为图片'],['duplicate','copy','在此处创建副本'],'-');
            if (nodes.length > 1) items.push(['group','layers','组合内容']);
            if (nodes.some(n => n.groupId)) items.push(['ungroup','layers','取消组合']);
            items.push(['layout-vertical','spacing','竖向排列'],['layout-grid','rect','网格排列'],['to-front','layers','移到最上层'],'-',['delete','trash','删除所选内容']);
        } else {
            this.insertionPoint = this.worldPoint(event);
            items.push(['paste','paste','粘贴剪贴板'],['insert-text','text','插入文字'],['insert-link','link','插入链接'],['insert-image','image','插入图片'],['insert-note','note','插入便签'],'-', ['rect','rect','矩形'],['arrow','arrow','箭头'],['pen','pen','画笔'],['frame-content','frame','拼图框适应全部内容'],['paper','paper','更换画布样式']);
        }
        this.showMenu(items,event);
    }
    modal(title, body, footer) {
        const el = this.root.querySelector('#puzzleModal'); el.hidden = false;
        el.innerHTML = `<div class="puzzle-dialog" role="dialog" aria-modal="true" aria-label="${h(title)}"><header>${h(title)}${button('close-modal','close','关闭')}</header>${body}<footer>${footer}</footer></div>`;
        el.querySelector('textarea,input,select')?.focus(); return el;
    }
    async editContent(kind = null) {
        const node = !kind && this.selected().length === 1 ? this.selected()[0] : null;
        if (node?.type === 'image') { this.setMode('scissors'); return; }
        if (node && !['text','note','link'].includes(node.type)) return;
        const type = kind || node?.type || 'text';
        const body = type === 'link' ? `<input id="puzzleEditName" type="text" maxlength="120" placeholder="链接标题" value="${h(node?.name || '')}" aria-label="链接标题"><input id="puzzleEditURL" type="url" placeholder="https://…" value="${h(node?.url || '')}" aria-label="链接地址">` : `<textarea id="puzzleEditText" maxlength="1000000" placeholder="写下一段文字…" aria-label="文字内容">${h(node?.body || '')}</textarea><p>原始内容会保留。文字修改后将重新计算卡片高度。</p>`;
        this.editing = { node: node ? clone(node) : null, type, point: this.insertionPoint || this.visibleCenter() };
        this.modal(node ? '编辑内容' : { text: '插入文字', note: '插入便签', link: '插入链接' }[type], body, `${button('close-modal','close','取消')}${button('confirm-content','check',node ? '保存修改' : '插入','puzzle-primary')}`);
    }
    visibleCenter() { const r = this.stage.getBoundingClientRect(); return this.worldPoint({ clientX: r.left + r.width / 2 - 160 * this.camera.z, clientY: r.top + r.height / 2 - 80 * this.camera.z }); }
    async confirmContent() {
        const { node: existing, type, point } = this.editing;
        const node = existing || newNode(type,{ x: point.x, y: point.y, name: type === 'note' ? '随手便签' : '文字片段' });
        if (type === 'link') {
            node.url = this.root.querySelector('#puzzleEditURL').value.trim();
            let url; try { url = new URL(node.url); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 地址'); }
            if (!['http:','https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 地址');
            node.name = this.root.querySelector('#puzzleEditName').value.trim() || url.hostname; node.h = 120;
        } else {
            node.body = this.root.querySelector('#puzzleEditText').value; if (!node.body.trim()) throw new Error('请先输入文字');
            if (!existing) node.originalBody = node.body; node.h = textHeight(node.body,node.w,node.fontSize);
        }
        await this.edit([{ type: 'upsert', nodes: [node] }]); this.selection = new Set([node.id]); this.root.querySelector('#puzzleModal').hidden = true; this.insertionPoint = null; this.setMode('select'); this.inspector();
    }
    async importFiles(files, point = null) {
        let nextY = point?.y ?? Math.max(this.task.frame.y + 24, ...this.task.nodes.map(n => n.y + n.h + 24));
        const x = point?.x ?? this.task.frame.x + 24, nodes = [];
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            this.status(`正在导入 ${file.name}…`);
            const dataUrl = await imageFilePNG(file), asset = await invoke('puzzle_import_image', { dataUrl });
            const w = Math.min(400,asset.width), node = newNode('image',{ x, y: nextY, w, h: w * asset.height / asset.width, name: file.name, assetId: asset.assetId }); nodes.push(node); nextY += node.h + 24;
        }
        if (!nodes.length) throw new Error('请选择或拖入图片文件');
        const frame = { ...this.task.frame, h: Math.max(this.task.frame.h,nextY - this.task.frame.y) };
        await this.edit([{ type: 'upsert', nodes }, { type: 'configure', frame }]); this.selection = new Set(nodes.map(n => n.id)); this.render(); this.inspector();
    }
    async paste() {
        await this.queue; const wasEmpty = !this.task.nodes.length;
        const previous = new Set(this.task.nodes.map(n => n.id));
        const task = await invoke('puzzle_take_clipboard', { taskId: this.task.meta.id });
        if (!this.acceptImport(task, previous)) return;
        if (wasEmpty) this.fit(); this.render(); this.inspector(); this.status('已粘贴到收集区'); this.scheduleRefresh();
    }
    async exportDialog() {
        if (!this.task.nodes.length) throw new Error('请先添加内容');
        const selected = this.selection.size > 0;
        this.modal('导出拼图', `<div class="puzzle-options"><label>范围 <select id="puzzleExportScope"><option value="frame">拼图框</option><option value="all">全部内容</option><option value="selected" ${selected ? 'selected' : 'disabled'}>所选内容</option></select></label><label>倍率 <select id="puzzleExportScale"><option value="1">1×</option><option value="2">2×</option></select></label><label><input type="checkbox" id="puzzleExportTransparent">透明背景</label></div><div class="puzzle-export-preview" id="puzzleExportPreview">正在生成预览…</div><p class="puzzle-footnote">导出 PNG 图片，辅助线和画布点阵不包含在内。链接与可编辑文字保存在拼图任务中。</p>`, `${button('close-modal','close','取消')}${button('export-file','download','保存 PNG')}${button('export-copy','copy','复制图片','puzzle-primary')}`);
        await this.updateExport();
    }
    async updateExport() {
        const version = (this.exportVersion || 0) + 1; this.exportVersion = version; this.exportData = null;
        const scope = this.root.querySelector('#puzzleExportScope').value, scale = Number(this.root.querySelector('#puzzleExportScale').value), transparent = this.root.querySelector('#puzzleExportTransparent').checked;
        const area = exportArea(this.task,this.selection,scope), target = this.root.querySelector('#puzzleExportPreview'); target.textContent = '正在生成预览…';
        this.root.querySelectorAll('[data-action=export-file],[data-action=export-copy]').forEach(b=>b.disabled=true);
        const task=clone(this.task), selectedIds=new Set(this.selection);
        const render=async()=>{
            if(version!==this.exportVersion||this.disposed) return;
            const data=await renderPNG(task,area,id=>this.original(id),{scale,transparent,selected:scope==='selected'?selectedIds:null,shouldContinue:()=>version===this.exportVersion&&!this.disposed});
            if(version!==this.exportVersion||this.disposed) return;
            this.exportData=data;target.replaceChildren();const img=document.createElement('img');img.src=data;img.alt='拼图导出预览';target.append(img);
            this.root.querySelectorAll('[data-action=export-file],[data-action=export-copy]').forEach(b=>b.disabled=false);
        };
        const work=(this.exportQueue||Promise.resolve()).catch(()=>{}).then(render);this.exportQueue=work.catch(()=>{});await work;
    }
    async output(copy) {
        if (!this.exportData) throw new Error('请等待预览生成完成');
        const path = await invoke('puzzle_output',{ dataUrl: this.exportData, copy, name: this.task.meta.name, taskId: this.task.meta.id });
        this.closeModal(); this.status(copy ? '图片已复制 · 此任务的自动收集已暂停' : `已保存：${path}`); await this.refreshOverview();
    }
    async copyImage() {
        const area = exportArea(this.task,this.selection,this.selection.size ? 'selected' : 'all');
        const dataUrl = await renderPNG(this.task,area,id=>this.original(id),{ selected: this.selection.size ? this.selection : null });
        await invoke('puzzle_output',{ dataUrl, copy: true, name: this.task.meta.name, taskId: this.task.meta.id }); this.status('图片已复制 · 自动收集已暂停'); await this.refreshOverview();
    }
    closeModal(){const modal=this.root.querySelector('#puzzleModal');modal.hidden=true;modal.replaceChildren();this.exportData=null;this.exportVersion=(this.exportVersion||0)+1;}
    async history(back = true) {
        const stack = back ? this.undo : this.redo, target = back ? this.redo : this.undo;
        const entry = stack.pop(); if (!entry) return;
        try { await this.edit(back ? entry.inverse : entry.forward,false); target.push(entry); this.render(); }
        catch (error) { stack.push(entry); throw error; }
    }
    async action(action, event, element) {
        this.root.querySelector('#puzzleMenu').hidden = true;
        const nodes = this.selected(), node = nodes[0];
        if (action === 'new') { await this.queue; await invoke('puzzle_close'); await this.open(); }
        else if (action === 'canvas') { this.root.classList.remove('tasks-open'); }
        else if (action === 'tasks') this.root.classList.toggle('tasks-open');
        else if (action === 'properties') { this.root.classList.toggle('inspector-open'); this.root.classList.toggle('inspector-closed'); }
        else if (action === 'collect') {
            await this.queue; this.status('正在切换收集状态…');
            await invoke('puzzle_collect',{ taskId: this.overview?.collection.taskId === this.task.meta.id ? null : this.task.meta.id }); await this.refreshOverview();
        }
        else if (action === 'paste') await this.paste();
        else if (action === 'floating') await invoke('open_quick_host',{ target: { kind: 'tool', toolId: 'clipboard-puzzle' } });
        else if (action === 'save') { await this.edit([{ type: 'configure', saved: true }],false); this.status('已保存 · 长期保留'); await this.refreshOverview(); }
        else if (action === 'fit') this.fit();
        else if (action === 'zoom-in') this.zoom(1.2);
        else if (action === 'zoom-out') this.zoom(1 / 1.2);
        else if (action === 'paper') { const types = ['dots','grid','plain']; await this.edit([{ type: 'configure', background: types[(types.indexOf(this.task.background) + 1) % 3] }],false); }
        else if (action === 'more') this.showMenu([['insert-text','text','插入文字'],['insert-link','link','插入链接'],['insert-note','note','插入便签'],'-',['undo','undo','撤销'],['redo','redo','重做'],['frame-content','frame','拼图框适应内容'],['retention','clock','保留与清理']],event);
        else if (action === 'region-cut' || action === 'region-copy') {
            this.regionMode = action === 'region-cut' ? 'cut' : 'copy';
            this.root.querySelectorAll('#puzzleRegionModes [data-action]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.action===action)));
            this.setMode('scissors');
        }
        else if (['scissors','rect','arrow','pen'].includes(action)) this.setMode(action);
        else if (action === 'insert-image') this.root.querySelector('#puzzleFileInput').click();
        else if (action === 'insert-text') await this.editContent('text');
        else if (action === 'insert-note') await this.editContent('note');
        else if (action === 'insert-link') await this.editContent('link');
        else if (action === 'edit-content') await this.editContent();
        else if (action === 'confirm-content') await this.confirmContent();
        else if (action === 'close-modal') this.closeModal();
        else if (action === 'copy-text' && node) { await invoke('puzzle_copy_text',{ text: node.body }); this.status('文字已复制'); }
        else if (action === 'copy-link' && node) { await invoke('puzzle_copy_text',{ text: node.url }); this.status('链接已复制'); }
        else if (action === 'open-link' && node) await invoke('puzzle_open_url',{ url: node.url });
        else if (action === 'restore-text' && node) await this.edit([{ type: 'upsert', nodes: [{ ...node, body: node.originalBody, h: textHeight(node.originalBody,node.w,node.fontSize) }] }]);
        else if (action === 'delete' && nodes.length) { await this.edit([{ type: 'remove', ids: nodes.map(n => n.id) }]); this.selection.clear(); this.inspector(); }
        else if (action === 'duplicate' && nodes.length) {
            const groups = new Map(); const copies = nodes.map(n => ({ ...clone(n), id: newId(), x: n.x + 24, y: n.y + 24, groupId: n.groupId ? (groups.get(n.groupId) || (groups.set(n.groupId,newId()),groups.get(n.groupId))) : null }));
            await this.edit([{ type: 'upsert', nodes: copies }]); this.selection = new Set(copies.map(n => n.id)); this.render(); this.inspector();
        }
        else if (action === 'group' && nodes.length > 1) { const id = newId(); await this.edit([{ type: 'upsert', nodes: nodes.map(n => ({ ...n,groupId: id })) }]); }
        else if (action === 'ungroup' && nodes.length) await this.edit([{ type: 'upsert', nodes: nodes.map(n => ({ ...n,groupId: null })) }]);
        else if (action.startsWith('layout-')) { const target = nodes.length ? nodes : this.task.nodes; await this.edit([{ type: 'upsert', nodes: layoutNodes(target,action.slice(7)) }]); }
        else if (action.startsWith('align-')) {
            const target = nodes.length ? nodes : this.task.nodes, b = bounds(target);
            await this.edit([{ type: 'upsert', nodes: target.map(n => ({ ...n, x: action === 'align-left' ? b.x : action === 'align-right' ? b.x + b.w - n.w : b.x + (b.w - n.w) / 2 })) }]);
        }
        else if (action === 'frame-content' && this.task.nodes.length) { const b = bounds(this.task.nodes); await this.edit([{ type: 'configure', frame: { x: b.x - 24,y: b.y - 24,w: b.w + 48,h: b.h + 48 } }],false); }
        else if (action === 'to-front' && nodes.length) await this.edit([{ type: 'remove', ids: nodes.map(n => n.id) },{ type: 'upsert',nodes }],false);
        else if (action === 'undo') await this.history();
        else if (action === 'redo') await this.history(false);
        else if (action === 'export') await this.exportDialog();
        else if (action === 'export-file') await this.output(false);
        else if (action === 'export-copy') await this.output(true);
        else if (action === 'copy-image') await this.copyImage();
        else if (action === 'retention') {
            this.modal('保留与清理',`<p>临时任务按最后修改时间计时。正在打开或收集的任务不会自动清理；手动保存的拼图长期保留。</p><label>临时任务保留 <select id="puzzleRetention"><option value="24">24 小时</option><option value="168">7 天</option><option value="0">仅手动清理</option></select></label>`,`${button('close-modal','close','取消')}${button('confirm-retention','check','应用','puzzle-primary')}`);
            this.root.querySelector('#puzzleRetention').value = String(this.overview.retentionHours);
        }
        else if (action === 'confirm-retention') { await invoke('puzzle_retention',{ hours: Number(this.root.querySelector('#puzzleRetention').value) }); this.root.querySelector('#puzzleModal').hidden = true; await this.refreshOverview(); }
        else if (action === 'delete-task') this.modal('删除当前拼图',`<p>“${h(this.task.meta.name)}”中的 ${this.task.nodes.length} 项内容将删除。其他任务里的副本会保留。</p>`,`${button('close-modal','close','取消')}${button('confirm-delete-task','trash','删除任务','puzzle-danger')}`);
        else if (action === 'confirm-delete-task') { await this.queue; await invoke('puzzle_remove',{ taskId: this.task.meta.id }); this.root.querySelector('#puzzleModal').hidden = true; await this.open(); }
    }
    keyDown(event) {
        if (this.regionBusy) { if (event.ctrlKey || event.metaKey || event.key === 'Delete' || event.key === 'Backspace') event.preventDefault(); return; }
        if (event.target.closest('input,textarea,select,[contenteditable=true]')) return;
        const mod = event.ctrlKey || event.metaKey;
        if (event.code === 'Space') { event.preventDefault(); this.space = true; }
        if (event.key === 'Escape') { event.preventDefault(); this.cancelGesture(); this.setMode('select'); this.closeModal(); this.root.querySelector('#puzzleMenu').hidden = true; }
        if (!this.root.querySelector('#puzzleModal').hidden) return;
        if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); this.guard(()=>this.history(!event.shiftKey)); }
        else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); this.guard(()=>this.history(false)); }
        else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); this.guard(()=>this.action('save')); }
        else if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); this.selection = new Set(this.task.nodes.map(n=>n.id)); this.render(); this.inspector(); }
        else if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); this.guard(()=>this.action('duplicate')); }
        else if (mod && event.key.toLowerCase() === 'c' && this.selection.size) { event.preventDefault(); this.guard(()=>this.copyImage()); }
        else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.guard(()=>this.action('delete')); }
        else if (!mod) { const tool = TOOLS.find(t=>t[3].toLowerCase() === event.key.toLowerCase()); if (tool) { event.preventDefault(); this.setMode(tool[0]); } }
    }
    dragStart(event) {
        const item = event.target.closest('[data-node-id]'); if (!item || this.mode !== 'select' || this.pending || this.space) { event.preventDefault(); return; }
        const nodes = this.selected(), b = bounds(nodes), p = this.worldPoint(event);
        if (!nodes.length) { event.preventDefault(); return; }
        const payload = { version: 1, sourceTaskId: this.task.meta.id, sourceRevision: this.task.meta.revision, ids: nodes.map(n => n.id), grab: { x: p.x - b.x, y: p.y - b.y }, box: b, viewId: context()?.instanceId || 'quick' };
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload)); event.dataTransfer.setData('text/plain', `DtKit 拼图片段 · ${nodes.length} 项`); event.dataTransfer.effectAllowed = 'copyMove';
        const badge = this.root.querySelector('#puzzleDragBadge'); badge.textContent = `复制 ${nodes.length} 项内容`; event.dataTransfer.setDragImage(badge, 20, 15); this.dragging = payload;
    }
    dragOver(event) {
        if (![...event.dataTransfer.types].some(type => [DRAG_TYPE,'Files','text/plain','text/html','text/uri-list'].includes(type))) return;
        event.preventDefault(); event.dataTransfer.dropEffect = this.dragging ? 'move' : 'copy';
        const p = this.worldPoint(event), payload = this.dragging;
        if (payload) {
            const targets = [this.task.frame, ...this.task.nodes.filter(n => !this.selection.has(n.id))];
            const snapped = snapPosition(this.selected(), targets, p.x - payload.grab.x, p.y - payload.grab.y, this.camera.z, !event.altKey);
            this.showArea({ x: snapped.x, y: snapped.y, w: payload.box.w, h: payload.box.h }); this.guides(snapped.lines);
        }
    }
    async drop(event) {
        this.guides([]); this.root.querySelector('#puzzleSelection').hidden = true;
        const p = this.worldPoint(event), raw = event.dataTransfer.getData(DRAG_TYPE);
        if (!raw) {
            const files=[...event.dataTransfer.files].filter(file=>file.type.startsWith('image/'));
            if(files.length){await this.importFiles(files,p);return;}
            const text=event.dataTransfer.getData('text/plain')||event.dataTransfer.getData('text/uri-list').split('\n').filter(l=>!l.startsWith('#')).join('\n'),html=event.dataTransfer.getData('text/html');
            if(!text&&!html) return;
            const previous=new Set(this.task.nodes.map(n=>n.id));
            this.status('正在导入拖入的内容…');const task=await invoke('puzzle_import_content',{taskId:this.task.meta.id,text,html,x:p.x,y:p.y});
            if(!this.acceptImport(task,previous)) return;
            this.render();this.inspector();this.status('已导入到松开的位置');this.scheduleRefresh();return;
        }
        if (raw.length > 100_000) throw new Error('拖动数据过大');
        const payload = JSON.parse(raw);
        if (payload.version !== 1 || !Array.isArray(payload.ids) || !Number.isFinite(payload.grab?.x) || !Number.isFinite(payload.grab?.y)) throw new Error('拖动内容无效');
        const local = this.dragging && payload.sourceTaskId === this.task.meta.id;
        if (local) {
            const nodes = this.selected(), b = bounds(nodes);
            const targets = [this.task.frame, ...this.task.nodes.filter(n => !this.selection.has(n.id))];
            const snapped = snapPosition(nodes, targets, p.x - payload.grab.x, p.y - payload.grab.y, this.camera.z, !event.altKey);
            await this.edit([{ type: 'upsert', nodes: nodes.map(n => ({ ...n, x: n.x + snapped.x - b.x, y: n.y + snapped.y - b.y })) }]);
        } else {
            const before = new Set(this.task.nodes.map(n => n.id));
            const task = await invoke('puzzle_copy', { request: { sourceTaskId: payload.sourceTaskId, targetTaskId: this.task.meta.id, sourceRevision: payload.sourceRevision, ids: payload.ids, x: p.x - payload.grab.x, y: p.y - payload.grab.y } });
            if (!this.acceptImport(task, before)) return;
            this.status('已复制到松开的位置 · 原窗口内容保留'); this.render(); this.inspector(); this.scheduleRefresh();
        }
        this.dragging = null;
    }
}

registerTool({
    id: 'clipboard-puzzle', name: '剪贴板拼图', category: 'design', icon: 'ri-clipboard-line', colorClass: 'tool-card__icon--green', description: '收集文字、图片和链接，在无限画布中整理、拼图与导出',
    template,
    async init() { editor = new PuzzleEditor(document.getElementById('puzzleTool')); await editor.init(); },
    serialize() {
        if(!editor?.task) return null;
        const modal=editor.root.querySelector('#puzzleModal'), editing=editor.editing;
        const draft=!modal.hidden&&editing&&modal.querySelector('#puzzleEditText,#puzzleEditURL')?{type:editing.type,nodeId:editing.node?.id||null,point:editing.point,body:modal.querySelector('#puzzleEditText')?.value||'',name:modal.querySelector('#puzzleEditName')?.value||'',url:modal.querySelector('#puzzleEditURL')?.value||''}:null;
        return {taskId:editor.task.meta.id,camera:{...editor.camera},draft};
    },
    async restore(snapshot) {
        if(!editor||!snapshot?.taskId||snapshot.taskId===editor.expiredTaskId) return;
        if(editor.task?.meta.id!==snapshot.taskId) await editor.open(snapshot.taskId);
        if(snapshot.camera&&['x','y','z'].every(k=>Number.isFinite(snapshot.camera[k]))){editor.camera={...snapshot.camera,z:Math.max(.08,Math.min(4,snapshot.camera.z))};editor.render();}
        const draft=snapshot.draft;
        if(draft&&['text','note','link'].includes(draft.type)){
            if(draft.nodeId&&editor.task.nodes.some(n=>n.id===draft.nodeId)) editor.selection=new Set([draft.nodeId]);
            editor.insertionPoint=draft.point&&Number.isFinite(draft.point.x)&&Number.isFinite(draft.point.y)?draft.point:null;
            await editor.editContent(draft.nodeId?null:draft.type);
            for(const [id,value] of [['#puzzleEditText',draft.body],['#puzzleEditName',draft.name],['#puzzleEditURL',draft.url]]){const input=editor.root.querySelector(id);if(input&&typeof value==='string') input.value=value.slice(0,1000000);}
        }
    },
    async flush() { if(editor){await Promise.allSettled([...editor.jobs]);await editor.queue;} return true; },
    async destroy() { if (!editor) return; const old = editor; editor = null; old.disposed = true; old.controller.abort(); old.resize?.disconnect(); old.unlisten?.(); clearTimeout(old.refreshTimer); cancelAnimationFrame(old.frame); await old.queue; await invoke('puzzle_close'); old.assets.clear(); old.elements.clear(); },
    getPagePanel() { return {summary:editor?.task?.meta.name||'剪贴板拼图',status:editor?.task?`${editor.task.nodes.length} 项内容 · ${editor.task.meta.saved?'长期保留':'临时任务'}`:'正在打开',actions:[{id:'save',label:'保存拼图',icon:'ri-save-3-line'},{id:'export',label:'导出 PNG',icon:'ri-download-2-line'}]}; },
    runPageAction(id){return editor?.guard(()=>editor.action(id));}
});
