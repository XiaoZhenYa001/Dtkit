import { clientToPixel, pixelToClient, stepPixel, magnifierPosition } from './model.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const canvas = document.getElementById('screenCanvas');
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
const magnifier = document.getElementById('magnifier');
const magnifierCanvas = document.getElementById('magnifierCanvas');
const magnifierContext = magnifierCanvas.getContext('2d', { alpha: false });
const hexLabel = document.getElementById('pickedHex');
const rgbLabel = document.getElementById('pickedRgb');
const coordinateLabel = document.getElementById('pickedCoordinate');
const swatch = document.getElementById('pickedSwatch');
const pickCursor = document.getElementById('pickCursor');
const loading = document.getElementById('loading');
const status = document.getElementById('pickStatus');
const abortController = new AbortController();
const listenerOptions = { signal: abortController.signal };
let point = { x: 0, y: 0 };
let captureOrigin = { x: 0, y: 0 };
let frame = 0;
let closeTimer = 0;
let ready = false;
let disposed = false;
let finishing = false;
let selectedHex = '#000000';
let announceNextSample = false;

function hex(r, g, b) {
    return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function sample() {
    frame = 0;
    if (!ready || disposed || finishing) return;
    const rect = canvas.getBoundingClientRect();
    const { x, y } = point;
    const client = pixelToClient(point, rect, canvas.width, canvas.height);
    const [r, g, b] = context.getImageData(x, y, 1, 1).data;
    // One source pixel always becomes one complete grid cell. Clearing first
    // prevents stale pixels at the outer edge of the virtual desktop.
    const cell = 12;
    const cells = 11;
    const sx = Math.max(0, x - 5);
    const sy = Math.max(0, y - 5);
    const width = Math.min(canvas.width, x + 6) - sx;
    const height = Math.min(canvas.height, y + 6) - sy;
    magnifierContext.fillStyle = '#24262b';
    magnifierContext.fillRect(0, 0, 132, 132);
    magnifierContext.imageSmoothingEnabled = false;
    magnifierContext.drawImage(canvas, sx, sy, width, height,
        (sx - x + 5) * cell, (sy - y + 5) * cell, width * cell, height * cell);
    magnifierContext.beginPath();
    for (let index = 1; index < cells; index++) {
        magnifierContext.moveTo(index * cell + .5, 0);
        magnifierContext.lineTo(index * cell + .5, 132);
        magnifierContext.moveTo(0, index * cell + .5);
        magnifierContext.lineTo(132, index * cell + .5);
    }
    magnifierContext.strokeStyle = 'rgba(0,0,0,.15)';
    magnifierContext.lineWidth = 1;
    magnifierContext.stroke();
    magnifierContext.strokeStyle = 'rgba(0,0,0,.8)';
    magnifierContext.lineWidth = 3;
    magnifierContext.strokeRect(59.5, 59.5, 13, 13);
    magnifierContext.strokeStyle = '#fff';
    magnifierContext.lineWidth = 1.5;
    magnifierContext.strokeRect(60.25, 60.25, 11.5, 11.5);
    selectedHex = hex(r, g, b);
    hexLabel.textContent = selectedHex;
    rgbLabel.textContent = `RGB ${r}, ${g}, ${b}`;
    coordinateLabel.textContent = `${captureOrigin.x + x}, ${captureOrigin.y + y} px`;
    if (announceNextSample) {
        status.textContent = `${selectedHex}，RGB ${r}，${g}，${b}，像素 ${captureOrigin.x + x}，${captureOrigin.y + y}`;
        announceNextSample = false;
    }
    swatch.style.backgroundColor = selectedHex;
    pickCursor.style.transform = `translate3d(${client.x}px,${client.y}px,0)`;
    const position = magnifierPosition(client, innerWidth, innerHeight,
        magnifier.offsetWidth, magnifier.offsetHeight);
    magnifier.style.transform = `translate3d(${position.x}px,${position.y}px,0)`;
}

function scheduleSample() {
    if (!frame && ready && !finishing && !disposed) frame = requestAnimationFrame(sample);
}

function move(event) {
    if (!ready || finishing) return;
    point = clientToPixel({ x: event.clientX, y: event.clientY },
        canvas.getBoundingClientRect(), canvas.width, canvas.height);
    scheduleSample();
}

async function finish(color = null) {
    if (finishing || disposed) return;
    finishing = true;
    cancelAnimationFrame(frame);
    frame = 0;
    document.body.classList.add('is-finishing');
    try {
        await invoke('finish_screen_color_pick', { color });
    } catch (error) {
        if (disposed) return;
        finishing = false;
        document.body.classList.remove('is-finishing');
        status.textContent = `操作失败：${String(error)}。按 Esc 取消或重试。`;
    }
}

function dispose() {
    disposed = true;
    ready = false;
    abortController.abort();
    cancelAnimationFrame(frame);
    clearTimeout(closeTimer);
    canvas.width = canvas.height = 1;
    magnifierCanvas.width = magnifierCanvas.height = 1;
}

canvas.addEventListener('pointermove', move, listenerOptions);
canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !ready || finishing) return;
    event.preventDefault();
    move(event);
    cancelAnimationFrame(frame);
    sample();
    void finish(selectedHex);
}, listenerOptions);
canvas.addEventListener('contextmenu', event => event.preventDefault(), listenerOptions);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.preventDefault();
        void finish(null);
        return;
    }
    if (!ready || finishing) return;
    if (event.key === 'Enter') {
        event.preventDefault();
        cancelAnimationFrame(frame);
        sample();
        void finish(selectedHex);
    } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        point = stepPixel(point, event.key, event.shiftKey ? 10 : 1, canvas.width, canvas.height);
        announceNextSample = true;
        scheduleSample();
    }
}, listenerOptions);
window.addEventListener('resize', scheduleSample, listenerOptions);
window.addEventListener('pagehide', dispose, { once: true });

async function initialize() {
    try {
        const capture = await invoke('get_screen_color_pick_capture');
        if (disposed) return;
        if (!capture || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)
            || capture.width < 1 || capture.height < 1 || typeof capture.dataUrl !== 'string') {
            throw new Error('屏幕取色画面无效');
        }
        const nextImage = new Image();
        await new Promise((resolve, reject) => {
            nextImage.onload = resolve;
            nextImage.onerror = () => reject(new Error('无法读取屏幕取色画面'));
            nextImage.src = capture.dataUrl;
        });
        if (disposed) { nextImage.src = ''; return; }
        canvas.width = capture.width;
        canvas.height = capture.height;
        context.drawImage(nextImage, 0, 0, capture.width, capture.height);
        nextImage.onload = nextImage.onerror = null;
        nextImage.src = '';
        captureOrigin = { x: Number(capture.x) || 0, y: Number(capture.y) || 0 };
        ready = true;
        loading.hidden = true;
        magnifier.hidden = false;
        pickCursor.hidden = false;
        point = clientToPixel({ x: innerWidth / 2, y: innerHeight / 2 },
            canvas.getBoundingClientRect(), canvas.width, canvas.height);
        sample();
        canvas.focus({ preventScroll: true });
    } catch (error) {
        if (disposed) return;
        loading.textContent = `无法启动屏幕取色：${String(error)}`;
        status.textContent = '按 Esc 返回';
        closeTimer = setTimeout(() => void finish(null), 1600);
    }
}
void initialize();
