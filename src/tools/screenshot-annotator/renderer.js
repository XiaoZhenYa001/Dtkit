import { arrowHead, clamp, objectBounds, selectionHandles } from './core.js';

const scratchCache = new WeakMap();
const dimension = (image, axis) => image?.[axis === 'width' ? 'naturalWidth' : 'naturalHeight'] || image?.[axis] || 0;

function scratchFor(context) {
    const owner = context.canvas;
    if (scratchCache.has(owner)) return scratchCache.get(owner);
    const canvas = owner?.ownerDocument?.createElement('canvas') || (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null);
    if (!canvas) return null;
    scratchCache.set(owner, canvas);
    return canvas;
}

export function roundedRectPath(context, x, y, width, height, radius) {
    const r = clamp(radius, 0, Math.min(width, height) / 2);
    context.beginPath();
    if (context.roundRect) context.roundRect(x, y, width, height, r);
    else {
        context.moveTo(x + r, y); context.arcTo(x + width, y, x + width, y + height, r);
        context.arcTo(x + width, y + height, x, y + height, r);
        context.arcTo(x, y + height, x, y, r); context.arcTo(x, y, x + width, y, r); context.closePath();
    }
}

function drawPen(context, object) {
    const points = object.points || [];
    if (!points.length) return;
    context.beginPath();
    if (points.length === 1) { context.arc(points[0].x, points[0].y, Math.max(0.5, object.size / 2), 0, Math.PI * 2); context.fill(); return; }
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length - 1; index++) {
        const current = points[index], next = points[index + 1];
        context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    context.lineTo(points.at(-1).x, points.at(-1).y);
    context.stroke();
}

function drawMosaic(context, object, sourceImage) {
    if (!sourceImage) return;
    const width = dimension(sourceImage, 'width'), height = dimension(sourceImage, 'height');
    const x = clamp(object.x, 0, width), y = clamp(object.y, 0, height);
    const areaWidth = Math.min(object.width, width - x), areaHeight = Math.min(object.height, height - y);
    if (areaWidth <= 0 || areaHeight <= 0) return;
    const scratch = scratchFor(context), pixelSize = Math.max(4, object.pixelSize || object.size * 3 || 12);
    if (!scratch) { context.fillStyle = '#1c1c1e'; context.fillRect(x, y, areaWidth, areaHeight); return; }
    scratch.width = Math.max(1, Math.ceil(areaWidth / pixelSize)); scratch.height = Math.max(1, Math.ceil(areaHeight / pixelSize));
    const small = scratch.getContext('2d');
    small.imageSmoothingEnabled = true;
    small.drawImage(sourceImage, x, y, areaWidth, areaHeight, 0, 0, scratch.width, scratch.height);
    context.globalAlpha = 1;
    context.imageSmoothingEnabled = false;
    context.drawImage(scratch, 0, 0, scratch.width, scratch.height, x, y, areaWidth, areaHeight);
}

export function drawObject(context, object, sourceImage) {
    if (!object) return;
    context.save();
    context.lineCap = 'round'; context.lineJoin = 'round';
    context.lineWidth = object.size || 5;
    context.fillStyle = object.color || '#ff453a'; context.strokeStyle = object.color || '#ff453a';
    context.globalAlpha = object.type === 'redact' || object.type === 'mosaic' ? 1 : object.opacity ?? (object.type === 'highlight' ? 0.3 : 1);
    if (object.type === 'pen') drawPen(context, object);
    else if (object.type === 'rect') {
        if (object.fill) context.fillRect(object.x, object.y, object.width, object.height);
        else context.strokeRect(object.x, object.y, object.width, object.height);
    } else if (object.type === 'ellipse') {
        context.beginPath(); context.ellipse(object.x + object.width / 2, object.y + object.height / 2, object.width / 2, object.height / 2, 0, 0, Math.PI * 2);
        if (object.fill) context.fill(); else context.stroke();
    } else if (object.type === 'line' || object.type === 'arrow') {
        context.beginPath(); context.moveTo(object.x, object.y); context.lineTo(object.x2, object.y2);
        if (object.type === 'arrow') for (const head of arrowHead(object)) { context.moveTo(object.x2, object.y2); context.lineTo(head.x, head.y); }
        context.stroke();
    } else if (object.type === 'highlight') {
        context.globalCompositeOperation = 'multiply';
        context.fillRect(object.x, object.y, object.width, object.height);
    } else if (object.type === 'redact') {
        // Privacy masks are opaque even when a restored document contains an alpha color.
        context.fillStyle = /^#[\da-f]{6}$/i.test(object.color || '') ? object.color : '#1c1c1e';
        context.fillRect(object.x, object.y, object.width, object.height);
    } else if (object.type === 'mosaic') drawMosaic(context, object, sourceImage);
    else if (object.type === 'text') {
        const fontSize = object.fontSize || Math.max(16, object.size * 4);
        context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        context.textBaseline = 'top';
        String(object.text || '').split('\n').forEach((line, index) => context.fillText(line, object.x, object.y + index * fontSize * 1.35));
    } else if (object.type === 'step') {
        const radius = Math.max(24, object.size * 4) / 2;
        context.beginPath(); context.arc(object.x, object.y, radius, 0, Math.PI * 2); context.fill();
        context.strokeStyle = '#ffffff'; context.lineWidth = Math.max(1.5, radius / 10); context.stroke();
        context.font = `700 ${Math.max(12, radius * (object.number >= 100 ? 0.85 : 1.1))}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillText(String(object.number || 1), object.x, object.y + radius * 0.025);
    }
    context.restore();
}

/** Export only image content. Editor controls and selection never enter this canvas. */
export function renderDocument(canvas, image, document, { scale = 1, transparent = true } = {}) {
    const crop = document.crop || { x: 0, y: 0, width: dimension(image, 'width'), height: dimension(image, 'height') };
    const ratio = clamp(scale, 0.1, 4);
    canvas.width = Math.max(1, Math.round(crop.width * ratio)); canvas.height = Math.max(1, Math.round(crop.height * ratio));
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!transparent) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.save(); context.scale(ratio, ratio);
    roundedRectPath(context, 0, 0, crop.width, crop.height, document.cornerRadius || 0); context.clip();
    context.translate(-crop.x, -crop.y); context.drawImage(image, 0, 0);
    for (const object of document.objects || []) drawObject(context, object, image);
    context.restore();
    return canvas;
}

export function drawSelection(context, object, { zoom = 1 } = {}) {
    const bounds = objectBounds(object), inverse = 1 / Math.max(0.1, zoom);
    context.save(); context.strokeStyle = '#0a84ff'; context.lineWidth = 1.3 * inverse;
    context.setLineDash([4 * inverse, 3 * inverse]); context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.setLineDash([]); context.fillStyle = '#ffffff';
    for (const handle of selectionHandles(object)) {
        const edge = 6 * inverse;
        context.fillRect(handle.x - edge / 2, handle.y - edge / 2, edge, edge);
        context.strokeRect(handle.x - edge / 2, handle.y - edge / 2, edge, edge);
    }
    context.restore();
}
