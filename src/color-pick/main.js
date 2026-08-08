const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const canvas = document.getElementById('screenCanvas');
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
const magnifier = document.getElementById('magnifier');
const magnifierCanvas = document.getElementById('magnifierCanvas');
const magnifierContext = magnifierCanvas.getContext('2d', { alpha: false });
const hexLabel = document.getElementById('pickedHex');
const rgbLabel = document.getElementById('pickedRgb');
const swatch = document.getElementById('pickedSwatch');
const pickCursor = document.getElementById('pickCursor');
let image = null;
let point = { x: 0, y: 0 };
let frame = 0;
let finishing = false;

function hex(r, g, b) {
    return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function sample() {
    frame = 0;
    if (!image) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((point.x - rect.left) * canvas.width / rect.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((point.y - rect.top) * canvas.height / rect.height)));
    const [r, g, b] = context.getImageData(x, y, 1, 1).data;
    const sourceSize = 11;
    magnifierContext.imageSmoothingEnabled = false;
    magnifierContext.drawImage(canvas, x - 5, y - 5, sourceSize, sourceSize, 0, 0, 132, 132);
    magnifierContext.strokeStyle = '#fff';
    magnifierContext.lineWidth = 2;
    magnifierContext.strokeRect(60, 60, 12, 12);
    magnifierContext.strokeStyle = 'rgba(0,0,0,.75)';
    magnifierContext.lineWidth = 1;
    magnifierContext.strokeRect(59, 59, 14, 14);
    const picked = hex(r, g, b);
    hexLabel.textContent = picked;
    rgbLabel.textContent = `RGB ${r}, ${g}, ${b}`;
    swatch.style.backgroundColor = picked;
    pickCursor.style.transform = `translate3d(${point.x}px,${point.y}px,0)`;
    const left = point.x + 172 > innerWidth ? point.x - 170 : point.x + 16;
    const top = point.y + 225 > innerHeight ? point.y - 220 : point.y + 16;
    magnifier.style.transform = `translate(${Math.max(8, left)}px,${Math.max(8, top)}px)`;
}

function move(event) {
    point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(sample);
}

async function finish(color = null) {
    if (finishing) return;
    finishing = true;
    try { await invoke('finish_screen_color_pick', { color }); }
    catch { finishing = false; }
}

canvas.addEventListener('pointermove', move);
canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    move(event);
    sample();
    finish(hexLabel.textContent);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') finish(null); });

try {
    const capture = await invoke('get_screen_color_pick_capture');
    const nextImage = new Image();
    nextImage.onload = () => {
        image = nextImage;
        canvas.width = capture.width;
        canvas.height = capture.height;
        context.drawImage(image, 0, 0);
        document.getElementById('loading').hidden = true;
        magnifier.hidden = false;
        pickCursor.hidden = false;
        point = { x: innerWidth / 2, y: innerHeight / 2 };
        sample();
    };
    nextImage.src = capture.dataUrl;
} catch (error) {
    document.getElementById('loading').textContent = String(error);
    setTimeout(() => finish(null), 1200);
}
