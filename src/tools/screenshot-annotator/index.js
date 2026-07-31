import '../../css/tools/screenshot-annotator.css';
import { registerTool } from '../toolRegistry.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const byId = id => document.getElementById(id);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');
let controller;
let canvas;
let context;
let background;
let objects = [];
let active = null;
let mode = 'pen';
let color = '#ef6f3c';
let size = 5;
let frame = 0;
let captureGeneration = 0;
let captureBusy = false;
let saveBusy = false;
let pendingTextPoint = null;

function template() {
    return `<div class="capture-shell">
      <header class="capture-toolbar">
        <div class="capture-identity"><span><i class="ri-screenshot-2-line"></i></span><div><strong>截图标注</strong><small id="captureDimensions">等待截图</small></div></div>
        <div class="capture-tools" role="toolbar" aria-label="截图标注工具">
          <button class="is-active" data-capture-mode="pen" aria-pressed="true"><i class="ri-pencil-line"></i><span>画笔</span></button>
          <button data-capture-mode="rect" aria-pressed="false"><i class="ri-checkbox-blank-line"></i><span>矩形</span></button>
          <button data-capture-mode="arrow" aria-pressed="false"><i class="ri-arrow-right-up-line"></i><span>箭头</span></button>
          <button data-capture-mode="text" aria-pressed="false"><i class="ri-text"></i><span>文字</span></button>
          <span class="capture-divider"></span>
          <input id="captureColor" type="color" value="#ef6f3c" aria-label="标注颜色">
          <input id="captureSize" type="range" min="2" max="24" value="5" aria-label="标注粗细">
          <output id="captureSizeValue" for="captureSize">5 px</output>
          <button id="captureUndo" disabled><i class="ri-arrow-go-back-line"></i><span>撤销</span></button>
        </div>
        <div class="capture-actions">
          <button id="captureAgain"><i class="ri-screenshot-2-line"></i> <span id="captureAgainLabel">开始截图</span></button>
          <button id="captureSave" class="capture-save" disabled><i class="ri-save-3-line"></i> 保存 PNG</button>
        </div>
      </header>
      <div id="captureStage" class="capture-stage">
        <div id="captureLoading" class="capture-loading" data-state="ready"><i class="ri-screenshot-2-line"></i><strong>准备截图</strong><span>点击“开始截图”后才会读取当前桌面，进入工具本身不会自动截屏。</span></div>
        <canvas id="captureCanvas" hidden></canvas>
      </div>
      <footer><span id="captureStatus"><i class="ri-information-line"></i> 主界面手动开始；专属快捷键仍可直接截取全部显示器。</span><span class="capture-shortcuts"><kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销　<kbd>Esc</kbd> 关闭快捷窗口</span></footer>
      <dialog id="captureTextDialog" class="capture-text-dialog"><form id="captureTextForm" method="dialog">
        <header><span><i class="ri-text"></i></span><div><strong>添加文字标注</strong><small>文字将插入到刚才点击的位置</small></div></header>
        <textarea id="captureTextInput" maxlength="200" rows="3" placeholder="输入标注内容"></textarea>
        <footer><button id="captureTextCancel" type="button">取消</button><button class="capture-text-submit" type="submit">插入文字</button></footer>
      </form></dialog>
    </div>`;
}

function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height
    };
}

function line(a, b) {
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
}

function drawObject(object) {
    context.strokeStyle = object.color;
    context.fillStyle = object.color;
    context.lineWidth = object.size;
    context.lineCap = 'round'; context.lineJoin = 'round';
    if (object.type === 'pen') {
        context.beginPath();
        object.points.forEach((p, index) => index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
        context.stroke();
    } else if (object.type === 'rect') {
        context.strokeRect(object.start.x, object.start.y, object.end.x - object.start.x, object.end.y - object.start.y);
    } else if (object.type === 'arrow') {
        line(object.start, object.end);
        const angle = Math.atan2(object.end.y - object.start.y, object.end.x - object.start.x);
        const head = Math.max(14, object.size * 4);
        line(object.end, { x: object.end.x - head * Math.cos(angle - Math.PI / 6), y: object.end.y - head * Math.sin(angle - Math.PI / 6) });
        line(object.end, { x: object.end.x - head * Math.cos(angle + Math.PI / 6), y: object.end.y - head * Math.sin(angle + Math.PI / 6) });
    } else if (object.type === 'text') {
        context.font = `600 ${Math.max(18, object.size * 4)}px system-ui`;
        context.fillText(object.text, object.start.x, object.start.y);
    }
}

function render() {
    frame = 0;
    if (!background || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(background, 0, 0, canvas.width, canvas.height);
    objects.forEach(drawObject);
    if (active) drawObject(active);
}

function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
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
    const undo = byId('captureUndo');
    const saveButton = byId('captureSave');
    const again = byId('captureAgain');
    const againLabel = byId('captureAgainLabel');
    if (undo) undo.disabled = captureBusy || objects.length === 0;
    if (saveButton) saveButton.disabled = captureBusy || saveBusy || !background;
    if (again) again.disabled = captureBusy;
    if (againLabel) againLabel.textContent = captureBusy ? '正在截图' : (background ? '重新截图' : '开始截图');
}

function releaseBackground() {
    if (background) {
        background.onload = null;
        background.onerror = null;
        background.src = '';
    }
    background = null;
}

async function capture() {
    const current = ++captureGeneration;
    captureBusy = true;
    canvas.hidden = true;
    byId('captureLoading').hidden = false;
    showLoading('loading', '正在截取桌面…', '截图完成后不会保持后台捕获。');
    releaseBackground();
    objects = []; active = null;
    updateControls();
    try {
        const result = await invoke('capture_screen_for_annotation');
        if (current !== captureGeneration || !canvas) return;
        const image = new Image();
        image.onload = () => {
            if (current !== captureGeneration || !canvas) {
                image.src = '';
                return;
            }
            background = image;
            canvas.width = result.width; canvas.height = result.height;
            byId('captureLoading').hidden = true; canvas.hidden = false;
            captureBusy = false;
            render();
            byId('captureDimensions').textContent = `${result.width} × ${result.height}`;
            byId('captureStatus').textContent = `${result.width} × ${result.height} · 截图已进入本地标注画布`;
            updateControls();
        };
        image.onerror = () => {
            if (current !== captureGeneration) return;
            captureBusy = false;
            showLoading('error', '无法载入截图', '请重新截图，或检查当前显示器状态。');
            byId('captureStatus').textContent = '无法载入截图图像。';
            updateControls();
        };
        image.src = result.dataUrl;
    } catch (error) {
        if (current !== captureGeneration) return;
        captureBusy = false;
        showLoading('error', '截图失败', String(error));
        updateControls();
    }
}

function pointerDown(event) {
    if (!background || event.button !== 0) return;
    const start = point(event);
    canvas.setPointerCapture(event.pointerId);
    if (mode === 'text') {
        pendingTextPoint = start;
        byId('captureTextInput').value = '';
        byId('captureTextDialog').showModal();
        byId('captureTextInput').focus();
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        return;
    }
    active = mode === 'pen'
        ? { type: 'pen', points: [start], color, size }
        : { type: mode, start, end: start, color, size };
}

function pointerMove(event) {
    if (!active) return;
    if (active.type === 'pen') {
        const samples = event.getCoalescedEvents?.() || [event];
        for (const sample of samples) {
            if (active.points.length >= 20_000) break;
            active.points.push(point(sample));
        }
    } else active.end = point(event);
    scheduleRender();
}

function pointerUp(event) {
    if (!active) return;
    pointerMove(event);
    if (objects.length >= 500) objects.shift();
    objects.push(active); active = null; render();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    updateControls();
}

async function save() {
    if (!background || saveBusy) return;
    saveBusy = true;
    updateControls();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    try {
        const path = await invoke('save_annotated_screenshot', {
            filename: `DtKit-${stamp}.png`, dataUrl: canvas.toDataURL('image/png')
        });
        byId('captureStatus').textContent = `已保存到 ${path}`;
    } catch (error) { byId('captureStatus').textContent = String(error); }
    finally {
        saveBusy = false;
        updateControls();
    }
}

function submitText(event) {
    event.preventDefault();
    const text = byId('captureTextInput').value.trim();
    if (!text || !pendingTextPoint) return;
    if (objects.length >= 500) objects.shift();
    objects.push({ type: 'text', start: pendingTextPoint, text: text.slice(0, 200), color, size });
    pendingTextPoint = null;
    byId('captureTextDialog').close();
    render();
    updateControls();
}

async function init() {
    controller?.abort(); controller = new AbortController();
    const { signal } = controller;
    canvas = byId('captureCanvas'); context = canvas?.getContext('2d', { alpha: false });
    if (canvas) canvas.dataset.mode = mode;
    canvas?.addEventListener('pointerdown', pointerDown, { signal });
    canvas?.addEventListener('pointermove', pointerMove, { signal });
    canvas?.addEventListener('pointerup', pointerUp, { signal });
    canvas?.addEventListener('pointercancel', pointerUp, { signal });
    document.querySelectorAll('[data-capture-mode]').forEach(button => button.addEventListener('click', () => {
        mode = button.dataset.captureMode;
        document.querySelectorAll('[data-capture-mode]').forEach(node => {
            const selected = node === button;
            node.classList.toggle('is-active', selected);
            node.setAttribute('aria-pressed', String(selected));
        });
        canvas.dataset.mode = mode;
    }, { signal }));
    byId('captureColor')?.addEventListener('input', event => { color = event.target.value; }, { signal });
    byId('captureSize')?.addEventListener('input', event => {
        size = Number(event.target.value);
        byId('captureSizeValue').value = `${size} px`;
    }, { signal });
    byId('captureUndo')?.addEventListener('click', () => { objects.pop(); render(); updateControls(); }, { signal });
    byId('captureAgain')?.addEventListener('click', capture, { signal });
    byId('captureSave')?.addEventListener('click', save, { signal });
    byId('captureTextForm')?.addEventListener('submit', submitText, { signal });
    byId('captureTextCancel')?.addEventListener('click', () => {
        pendingTextPoint = null;
        byId('captureTextDialog').close();
    }, { signal });
    byId('captureTextDialog')?.addEventListener('cancel', () => { pendingTextPoint = null; }, { signal });
    document.addEventListener('keydown', event => {
        if (event.ctrlKey && event.key.toLowerCase() === 'z' && objects.length) {
            event.preventDefault(); objects.pop(); render(); updateControls();
        }
    }, { signal });
    updateControls();
    if (isQuickHost()) await capture();
}

function destroy() {
    controller?.abort(); controller = null;
    captureGeneration += 1;
    if (frame) cancelAnimationFrame(frame);
    frame = 0; objects = []; active = null; pendingTextPoint = null; captureBusy = false; saveBusy = false;
    releaseBackground(); context = null; canvas = null;
}

registerTool({
    id: 'screenshot-annotator', name: '截图与标注', icon: 'ri-screenshot-2-line',
    colorClass: 'tool-card__icon--orange', category: 'design', status: 'ready',
    description: '快捷截取虚拟桌面，并进行画笔、形状、箭头和文字标注。',
    template, init, destroy
});
