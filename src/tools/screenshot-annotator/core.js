/** Screenshot documents use source-image pixels, independently of editor zoom. */
export const LIMITS = Object.freeze({ objects: 300, points: 24000, text: 2000, history: 60, historyBytes: 12 * 1024 * 1024 });

const TYPES = new Set(['pen', 'rect', 'ellipse', 'line', 'arrow', 'text', 'step', 'highlight', 'mosaic', 'redact']);
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value, min)));
export const createId = () => globalThis.crypto?.randomUUID?.() || `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function normalizeRect(a, b, constrain = false) {
    const x = finite(a?.x), y = finite(a?.y);
    let dx = finite(b?.x) - x, dy = finite(b?.y) - y;
    if (constrain) {
        const edge = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (dx < 0 ? -1 : 1) * edge;
        dy = (dy < 0 ? -1 : 1) * edge;
    }
    return { x: Math.min(x, x + dx), y: Math.min(y, y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

export function constrainPoint(a, b, angleStep = Math.PI / 4) {
    const dx = finite(b?.x) - finite(a?.x), dy = finite(b?.y) - finite(a?.y);
    const angle = Math.round(Math.atan2(dy, dx) / angleStep) * angleStep;
    const distance = Math.hypot(dx, dy);
    return { x: finite(a?.x) + Math.cos(angle) * distance, y: finite(a?.y) + Math.sin(angle) * distance };
}

export function textBounds(object) {
    const fontSize = clamp(object.fontSize ?? Math.max(16, finite(object.size, 5) * 4), 8, 256);
    const lines = String(object.text || '').split('\n');
    // CJK characters are approximately one em; Latin characters approximately 0.6 em.
    const units = line => [...line].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/u.test(char) ? 1 : 0.6), 0);
    const width = Math.max(fontSize * 0.6, ...lines.map(line => units(line) * fontSize));
    return { x: finite(object.x), y: finite(object.y), width: finite(object.width, width), height: finite(object.height, Math.max(1, lines.length) * fontSize * 1.35) };
}

export function objectBounds(object) {
    if (!object) return { x: 0, y: 0, width: 0, height: 0 };
    if (object.type === 'pen') {
        const points = object.points || [];
        if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const point of points) {
            left = Math.min(left, point.x); top = Math.min(top, point.y);
            right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
        }
        const pad = Math.max(0.5, finite(object.size, 5) / 2);
        return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
    }
    if (object.type === 'text') return textBounds(object);
    if (object.type === 'step') {
        const diameter = Math.max(24, finite(object.size, 5) * 4);
        return { x: finite(object.x) - diameter / 2, y: finite(object.y) - diameter / 2, width: diameter, height: diameter };
    }
    if (object.type === 'line' || object.type === 'arrow') return normalizeRect(object, { x: object.x2, y: object.y2 });
    return normalizeRect(object, { x: finite(object.x) + finite(object.width), y: finite(object.y) + finite(object.height) });
}

function segmentDistance(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1) : 0;
    return Math.hypot(point.x - a.x - ratio * dx, point.y - a.y - ratio * dy);
}

function hitTestPen(points, point, padding) {
    if (!points.length) return false;
    if (points.length === 1) return Math.hypot(points[0].x - point.x, points[0].y - point.y) <= padding;
    let start = points[0];
    for (let index = 1; index < points.length - 1; index++) {
        const control = points[index], next = points[index + 1];
        const end = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
        // Follow the quadratic path used by the renderer, including widely spaced imported points.
        const steps = Math.min(32, Math.max(4, Math.ceil((Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(end.x - control.x, end.y - control.y)) / 6)));
        let previous = start;
        for (let sample = 1; sample <= steps; sample++) {
            const t = sample / steps, inverse = 1 - t;
            const current = { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y };
            if (segmentDistance(point, previous, current) <= padding) return true;
            previous = current;
        }
        start = end;
    }
    return segmentDistance(point, start, points.at(-1)) <= padding;
}

export function arrowHead(object) {
    const angle = Math.atan2(object.y2 - object.y, object.x2 - object.x);
    const length = Math.min(Math.hypot(object.x2 - object.x, object.y2 - object.y) * 0.5, Math.max(12, finite(object.size, 5) * 3.5));
    return [
        { x: object.x2 - length * Math.cos(angle - Math.PI / 6), y: object.y2 - length * Math.sin(angle - Math.PI / 6) },
        { x: object.x2 - length * Math.cos(angle + Math.PI / 6), y: object.y2 - length * Math.sin(angle + Math.PI / 6) },
    ];
}

export function hitTestObject(object, point, tolerance = 6) {
    if (!object || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    const bounds = objectBounds(object), padding = Math.max(0, finite(tolerance)) + finite(object.size, 5) / 2;
    const inside = point.x >= bounds.x - padding && point.x <= bounds.x + bounds.width + padding && point.y >= bounds.y - padding && point.y <= bounds.y + bounds.height + padding;
    if (!inside && object.type !== 'arrow') return false;
    if (object.type === 'pen') {
        const points = object.points || [];
        return hitTestPen(points, point, padding);
    }
    if (object.type === 'line' || object.type === 'arrow') {
        const end = { x: object.x2, y: object.y2 };
        return segmentDistance(point, object, end) <= padding || object.type === 'arrow' && arrowHead(object).some(head => segmentDistance(point, end, head) <= padding);
    }
    if (object.type === 'step') return Math.hypot(point.x - object.x, point.y - object.y) <= bounds.width / 2 + tolerance;
    if (object.type === 'ellipse') {
        const rx = bounds.width / 2, ry = bounds.height / 2;
        if (!rx || !ry) return segmentDistance(point, { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }) <= padding;
        const dx = point.x - bounds.x - rx, dy = point.y - bounds.y - ry;
        const value = dx * dx / (rx * rx) + dy * dy / (ry * ry);
        if (object.fill) return value <= 1 + padding / Math.min(rx, ry) * 2;
        const gradient = Math.hypot(2 * dx / (rx * rx), 2 * dy / (ry * ry));
        return gradient > 0 && Math.abs(value - 1) / gradient <= padding;
    }
    if (object.type === 'rect' && !object.fill) {
        return Math.min(Math.abs(point.x - bounds.x), Math.abs(point.x - bounds.x - bounds.width), Math.abs(point.y - bounds.y), Math.abs(point.y - bounds.y - bounds.height)) <= padding;
    }
    return true;
}

export function translateObject(object, dx, dy) {
    dx = finite(dx); dy = finite(dy);
    if (object.type === 'pen') return { ...object, points: object.points.map(point => ({ x: point.x + dx, y: point.y + dy })) };
    const moved = { ...object, x: finite(object.x) + dx, y: finite(object.y) + dy };
    if (object.type === 'line' || object.type === 'arrow') { moved.x2 = object.x2 + dx; moved.y2 = object.y2 + dy; }
    return moved;
}

export function resizeObject(object, initialBounds, newBounds) {
    const before = initialBounds || objectBounds(object);
    const after = normalizeRect(newBounds, { x: newBounds.x + newBounds.width, y: newBounds.y + newBounds.height });
    const sx = before.width > 0.0001 ? after.width / before.width : 1;
    const sy = before.height > 0.0001 ? after.height / before.height : 1;
    const x = value => before.width > 0.0001 ? after.x + (value - before.x) * sx : after.x + after.width / 2;
    const y = value => before.height > 0.0001 ? after.y + (value - before.y) * sy : after.y + after.height / 2;
    if (object.type === 'pen') return { ...object, size: clamp(finite(object.size, 5) * Math.sqrt(Math.abs(sx * sy)), 1, 64), points: object.points.map(point => ({ x: x(point.x), y: y(point.y) })) };
    if (object.type === 'line' || object.type === 'arrow') return { ...object, x: x(object.x), y: y(object.y), x2: x(object.x2), y2: y(object.y2) };
    if (object.type === 'step') return { ...object, x: after.x + after.width / 2, y: after.y + after.height / 2, size: clamp(Math.min(after.width, after.height) / 4, 6, 64) };
    if (object.type === 'text') {
        // Text is rendered with a font size, rather than stretched to arbitrary box dimensions.
        // A side handle must therefore scale both axes, retaining measured glyph bounds.
        const previousFont = clamp(object.fontSize ?? Math.max(16, finite(object.size, 5) * 4), 8, 256);
        const requestedScale = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
        const fontSize = clamp(previousFont * requestedScale, 8, 256), scale = fontSize / previousFont;
        return { ...object, x: after.x, y: after.y, width: before.width * scale, height: before.height * scale, fontSize, size: fontSize / 4 };
    }
    return { ...object, ...after };
}

export function selectionHandles(object, { zoom = 1, padding = 0 } = {}) {
    const bounds = objectBounds(object), pad = Math.max(0, padding) / Math.max(0.1, zoom);
    const x = bounds.x - pad, y = bounds.y - pad, width = bounds.width + pad * 2, height = bounds.height + pad * 2;
    return [
        { name: 'nw', x, y }, { name: 'n', x: x + width / 2, y }, { name: 'ne', x: x + width, y },
        { name: 'e', x: x + width, y: y + height / 2 }, { name: 'se', x: x + width, y: y + height },
        { name: 's', x: x + width / 2, y: y + height }, { name: 'sw', x, y: y + height }, { name: 'w', x, y: y + height / 2 },
    ];
}

export function hitTestHandle(object, point, { zoom = 1 } = {}) {
    const radius = 7 / Math.max(0.1, zoom);
    return selectionHandles(object).find(handle => Math.abs(handle.x - point.x) <= radius && Math.abs(handle.y - point.y) <= radius)?.name || null;
}

export function nextStepNumber(objects) {
    return Math.min(999, Math.max(0, ...objects.filter(object => object.type === 'step').map(object => Math.floor(finite(object.number)))) + 1);
}

function normalizeColor(value, fallback = '#ff453a') {
    if (typeof value !== 'string') return fallback;
    if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[\da-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map(char => char + char).join('')}`.toLowerCase();
    return fallback;
}

export function sanitizeDocument(input, imageWidth, imageHeight) {
    const width = Math.max(1, Math.floor(finite(imageWidth, 1))), height = Math.max(1, Math.floor(finite(imageHeight, 1)));
    const requested = input?.crop || { x: 0, y: 0, width, height };
    const cropX = clamp(Math.round(finite(requested.x)), 0, width - 1), cropY = clamp(Math.round(finite(requested.y)), 0, height - 1);
    const crop = { x: cropX, y: cropY, width: clamp(Math.round(finite(requested.width, width)), 1, width - cropX), height: clamp(Math.round(finite(requested.height, height)), 1, height - cropY) };
    let pointBudget = LIMITS.points;
    const objects = [], ids = new Set();
    for (const candidate of Array.isArray(input?.objects) ? input.objects.slice(0, LIMITS.objects) : []) {
        if (!candidate || !TYPES.has(candidate.type)) continue;
        const type = candidate.type;
        let id = typeof candidate.id === 'string' && candidate.id.length <= 96 ? candidate.id : `mark-${objects.length}`;
        let duplicate = 0;
        while (ids.has(id)) id = `mark-${objects.length}-${++duplicate}`;
        ids.add(id);
        const object = { id, type, color: normalizeColor(candidate.color, type === 'redact' ? '#1c1c1e' : '#ff453a'), size: clamp(candidate.size ?? 5, 1, 64) };
        object.opacity = type === 'redact' || type === 'mosaic' ? 1 : clamp(candidate.opacity ?? (type === 'highlight' ? 0.3 : 1), 0.05, 1);
        if (type === 'pen') {
            const points = Array.isArray(candidate.points) ? candidate.points : [];
            object.points = [];
            // Sample the complete stroke when restoring an oversized document, preserving its ending.
            const count = Math.min(points.length, pointBudget), stride = count > 1 ? (points.length - 1) / (count - 1) : 0;
            for (let index = 0; index < count; index++) {
                const point = points[Math.round(index * stride)];
                if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) object.points.push({ x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) });
            }
            if (!object.points.length) continue;
            pointBudget -= object.points.length;
        } else {
            object.x = clamp(candidate.x, 0, width); object.y = clamp(candidate.y, 0, height);
            if (type === 'line' || type === 'arrow') {
                object.x2 = clamp(candidate.x2, 0, width); object.y2 = clamp(candidate.y2, 0, height);
            } else if (type === 'step') {
                object.number = Math.floor(clamp(candidate.number ?? nextStepNumber(objects), 1, 999));
            } else if (type === 'text') {
                object.text = String(candidate.text || '').slice(0, LIMITS.text);
                if (!object.text.trim()) continue;
                object.fontSize = clamp(candidate.fontSize ?? Math.max(16, object.size * 4), 8, 256);
                if (Number.isFinite(candidate.width) && candidate.width > 0) object.width = clamp(candidate.width, 1, width * 2);
                if (Number.isFinite(candidate.height) && candidate.height > 0) object.height = clamp(candidate.height, 1, height * 2);
            } else {
                const origin = { x: finite(candidate.x), y: finite(candidate.y) };
                const box = normalizeRect(origin, { x: origin.x + finite(candidate.width), y: origin.y + finite(candidate.height) });
                object.x = clamp(box.x, 0, width); object.y = clamp(box.y, 0, height);
                object.width = clamp(box.x + box.width, 0, width) - object.x; object.height = clamp(box.y + box.height, 0, height) - object.y;
                object.fill = Boolean(candidate.fill);
                if (type === 'mosaic') object.pixelSize = clamp(candidate.pixelSize ?? Math.max(8, object.size * 3), 4, 96);
                if (!object.width || !object.height) continue;
            }
        }
        objects.push(object);
    }
    return { objects, crop, cornerRadius: clamp(input?.cornerRadius ?? 0, 0, Math.min(crop.width, crop.height) / 2) };
}

function snapshot(document) {
    const value = clone(document || { objects: [], crop: { x: 0, y: 0, width: 1, height: 1 }, cornerRadius: 0 });
    let remaining = LIMITS.points;
    value.objects = (Array.isArray(value.objects) ? value.objects : []).slice(0, LIMITS.objects).map(object => {
        if (object.type === 'text') object.text = String(object.text || '').slice(0, LIMITS.text);
        if (object.type === 'pen') { object.points = (object.points || []).slice(0, remaining); remaining -= object.points.length; }
        return object;
    }).filter(object => object.type !== 'pen' || object.points.length);
    return { value, key: JSON.stringify(value) };
}

/** Gesture-level history: mutating a returned snapshot can never mutate stored history. */
export class History {
    constructor(initial, { maxEntries = LIMITS.history, maxBytes = LIMITS.historyBytes } = {}) {
        this.maxEntries = Math.max(2, Math.floor(finite(maxEntries, LIMITS.history)));
        this.maxBytes = Math.max(1024, finite(maxBytes, LIMITS.historyBytes));
        this.reset(initial);
    }
    get canUndo() { return this.cursor > 0; }
    get canRedo() { return this.cursor < this.entries.length - 1; }
    get length() { return this.entries.length; }
    reset(document) { this.entries = [snapshot(document)]; this.cursor = 0; }
    push(document) {
        const entry = snapshot(document);
        if (entry.key === this.entries[this.cursor].key) return false;
        this.entries.splice(this.cursor + 1);
        this.entries.push(entry);
        let bytes = this.entries.reduce((sum, item) => sum + item.key.length * 2, 0);
        while (this.entries.length > 2 && (this.entries.length > this.maxEntries || bytes > this.maxBytes)) bytes -= this.entries.shift().key.length * 2;
        this.cursor = this.entries.length - 1;
        return true;
    }
    undo() { return this.canUndo ? clone(this.entries[--this.cursor].value) : null; }
    redo() { return this.canRedo ? clone(this.entries[++this.cursor].value) : null; }
}
