const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const canvas = document.getElementById('regionCanvas');
const context = canvas.getContext('2d', { alpha: false });
const selectionElement = document.getElementById('regionSelection');
const sizeElement = document.getElementById('regionSize');
let image = null;
let captureSource = null;
let selection = null;
let pointerId = null;
let finishing = false;

function normalizedSelection() {
    if (!selection) return null;
    const left = Math.min(selection.startX, selection.endX);
    const top = Math.min(selection.startY, selection.endY);
    return {
        left,
        top,
        width: Math.abs(selection.endX - selection.startX),
        height: Math.abs(selection.endY - selection.startY)
    };
}

function renderSelection() {
    const region = normalizedSelection();
    if (!region || region.width < 1 || region.height < 1) {
        selectionElement.hidden = true;
        return;
    }
    selectionElement.hidden = false;
    selectionElement.classList.toggle('is-near-top', region.top < 38);
    selectionElement.style.transform = `translate3d(${region.left}px,${region.top}px,0)`;
    selectionElement.style.width = `${region.width}px`;
    selectionElement.style.height = `${region.height}px`;
    const rect = canvas.getBoundingClientRect();
    const pixelWidth = Math.max(1, Math.round(region.width * canvas.width / rect.width));
    const pixelHeight = Math.max(1, Math.round(region.height * canvas.height / rect.height));
    sizeElement.textContent = `${pixelWidth} × ${pixelHeight}`;
}

async function finish(payload = {}) {
    if (finishing) return;
    finishing = true;
    try {
        await invoke('finish_screen_region_capture', payload);
    } catch (error) {
        finishing = false;
        document.getElementById('regionLoading').hidden = false;
        document.getElementById('regionLoading').textContent = String(error);
    }
}

function cancel() {
    finish({ dataUrl: null, width: null, height: null });
}

canvas.addEventListener('pointerdown', event => {
    if (!image || event.button !== 0 || finishing) return;
    pointerId = event.pointerId;
    selection = { startX: event.clientX, startY: event.clientY, endX: event.clientX, endY: event.clientY };
    canvas.setPointerCapture(pointerId);
    renderSelection();
});

canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId || !selection) return;
    selection.endX = Math.max(0, Math.min(innerWidth, event.clientX));
    selection.endY = Math.max(0, Math.min(innerHeight, event.clientY));
    renderSelection();
});

canvas.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId || !selection || finishing) return;
    selection.endX = Math.max(0, Math.min(innerWidth, event.clientX));
    selection.endY = Math.max(0, Math.min(innerHeight, event.clientY));
    const region = normalizedSelection();
    pointerId = null;
    if (!region || region.width < 4 || region.height < 4) {
        selection = null;
        renderSelection();
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const sourceX = Math.max(0, Math.floor(region.left * scaleX));
    const sourceY = Math.max(0, Math.floor(region.top * scaleY));
    const width = Math.min(canvas.width - sourceX, Math.max(1, Math.round(region.width * scaleX)));
    const height = Math.min(canvas.height - sourceY, Math.max(1, Math.round(region.height * scaleY)));
    if (captureSource?.longDirection) {
        selectionElement.classList.add('is-capturing');
        sizeElement.textContent = '自动滚动拼接中…';
        finish({
            dataUrl: null,
            width,
            height,
            x: captureSource.x + sourceX,
            y: captureSource.y + sourceY
        });
        return;
    }
    const cropped = document.createElement('canvas');
    cropped.width = width;
    cropped.height = height;
    cropped.getContext('2d', { alpha: false }).drawImage(canvas, sourceX, sourceY, width, height, 0, 0, width, height);
    finish({ dataUrl: cropped.toDataURL('image/png'), width, height });
});

canvas.addEventListener('pointercancel', () => {
    pointerId = null;
    selection = null;
    renderSelection();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
document.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); });

try {
    const capture = await invoke('get_screen_region_capture');
    captureSource = capture;
    if (capture.longDirection) {
        document.querySelector('.region-hint strong').textContent = '选择自动长截图范围';
        document.querySelector('.region-hint span').textContent = '松开后将自动滚动、识别重叠并拼接';
    }
    const nextImage = new Image();
    nextImage.onload = () => {
        image = nextImage;
        canvas.width = capture.width;
        canvas.height = capture.height;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        document.getElementById('regionLoading').hidden = true;
    };
    nextImage.onerror = () => cancel();
    nextImage.src = capture.dataUrl;
} catch (error) {
    document.getElementById('regionLoading').textContent = String(error);
}
