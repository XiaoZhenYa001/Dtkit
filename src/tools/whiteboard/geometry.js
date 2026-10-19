const SHAPES = new Set(['line', 'arrow', 'rect', 'ellipse']);
const clampZoom = value => Math.min(8, Math.max(0.1, value));
const point = value => Array.isArray(value) ? { x: value[0], y: value[1] } : value;

export function arrowHeadPoints(element, size = 14) {
    const angle = Math.atan2(element.y2 - element.y1, element.x2 - element.x1);
    return [
        { x: element.x2 - Math.cos(angle - Math.PI / 6) * size, y: element.y2 - Math.sin(angle - Math.PI / 6) * size },
        { x: element.x2, y: element.y2 },
        { x: element.x2 - Math.cos(angle + Math.PI / 6) * size, y: element.y2 - Math.sin(angle + Math.PI / 6) * size }
    ];
}

export function getElementBounds(element) {
    const padding = Math.max(0, Number(element.width) || 0) / 2;
    if (element.type === 'stroke') {
        let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
        for (const [x, y] of element.points) {
            left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (!element.points.length) return { x: 0, y: 0, width: 0, height: 0 };
        return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 };
    }
    if (SHAPES.has(element.type)) {
        const points = [{ x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }];
        if (element.type === 'arrow') points.push(...arrowHeadPoints(element));
        const left = Math.min(...points.map(item => item.x)); const top = Math.min(...points.map(item => item.y));
        return { x: left - padding, y: top - padding, width: Math.max(...points.map(item => item.x)) - left + padding * 2, height: Math.max(...points.map(item => item.y)) - top + padding * 2 };
    }
    if (element.type === 'note' || element.type === 'formula') {
        return { x: element.x, y: element.y, width: element.width || 220, height: element.height || (element.type === 'note' ? 150 : 60) };
    }
    const size = element.size || 24; const lines = String(element.text || '').split('\n');
    const measure = text => Array.from(text).reduce((sum, character) => sum + (/[^\u0000-\u024f]/u.test(character) ? 1 : 0.6), 0) * size;
    return { x: element.x, y: element.y, width: Math.max(size * 0.5, ...lines.map(measure)), height: size * 1.25 * lines.length };
}

export function distanceToSegment(value, start, end) {
    const p = point(value); const a = point(start); const b = point(end);
    const dx = b.x - a.x; const dy = b.y - a.y; const squared = dx * dx + dy * dy;
    const t = squared ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function nearQuadratic(p, from, control, to, threshold, depth = 0) {
    if (depth >= 10 || distanceToSegment(control, from, to) <= Math.max(0.05, threshold * 0.15)) {
        return distanceToSegment(p, from, to) <= threshold;
    }
    const left = { x: (from.x + control.x) / 2, y: (from.y + control.y) / 2 };
    const right = { x: (control.x + to.x) / 2, y: (control.y + to.y) / 2 };
    const middle = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    return nearQuadratic(p, from, left, middle, threshold, depth + 1) || nearQuadratic(p, middle, right, to, threshold, depth + 1);
}

function distanceToEllipse(p, cx, cy, rx, ry) {
    if (!rx || !ry) return distanceToSegment(p, { x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry });
    const px = Math.abs(p.x - cx); const py = Math.abs(p.y - cy);
    const squared = angle => (rx * Math.cos(angle) - px) ** 2 + (ry * Math.sin(angle) - py) ** 2;
    const step = Math.PI / 32; let best = 0;
    for (let index = 1; index <= 16; index++) if (squared(index * step) < squared(best * step)) best = index;
    let low = Math.max(0, (best - 1) * step); let high = Math.min(Math.PI / 2, (best + 1) * step);
    for (let index = 0; index < 32; index++) {
        const a = low + (high - low) / 3; const b = high - (high - low) / 3;
        if (squared(a) < squared(b)) high = b; else low = a;
    }
    return Math.sqrt(Math.min(squared(0), squared(Math.PI / 2), squared((low + high) / 2)));
}

export function hitTestElement(element, value, padding = 8, options = {}) {
    const p = point(value); const box = getElementBounds(element); const margin = Math.max(0, padding);
    if (p.x < box.x - margin || p.x > box.x + box.width + margin || p.y < box.y - margin || p.y > box.y + box.height + margin) return false;
    const threshold = margin + Math.max(0, Number(element.width) || 0) / 2;
    if (element.type === 'stroke') {
        const points = element.points; if (!points.length) return false;
        let from = point(points[0]);
        for (let index = 1; index < points.length - 1; index++) {
            const control = point(points[index]); const next = point(points[index + 1]); const to = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
            if (nearQuadratic(p, from, control, to, threshold)) return true;
            from = to;
        }
        return distanceToSegment(p, from, point(points.at(-1))) <= threshold;
    }
    if (element.type === 'line' || element.type === 'arrow') {
        if (distanceToSegment(p, { x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }) <= threshold) return true;
        if (element.type !== 'arrow') return false;
        const head = arrowHeadPoints(element);
        return distanceToSegment(p, head[0], head[1]) <= threshold || distanceToSegment(p, head[1], head[2]) <= threshold;
    }
    const fill = options === true || options.fill === true;
    if (element.type === 'rect') {
        const left = Math.min(element.x1, element.x2); const top = Math.min(element.y1, element.y2); const right = Math.max(element.x1, element.x2); const bottom = Math.max(element.y1, element.y2);
        if (fill && p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) return true;
        const corners = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
        return corners.some((corner, index) => distanceToSegment(p, corner, corners[(index + 1) % 4]) <= threshold);
    }
    if (element.type === 'ellipse') {
        const rx = Math.abs(element.x2 - element.x1) / 2; const ry = Math.abs(element.y2 - element.y1) / 2; const cx = (element.x1 + element.x2) / 2; const cy = (element.y1 + element.y2) / 2;
        if (fill && rx && ry && ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1) return true;
        return distanceToEllipse(p, cx, cy, rx, ry) <= threshold;
    }
    return true;
}

export function translateElement(element, dx, dy) {
    if (element.type === 'stroke') element.points.forEach(value => { value[0] += dx; value[1] += dy; });
    else if (SHAPES.has(element.type)) { element.x1 += dx; element.x2 += dx; element.y1 += dy; element.y2 += dy; }
    else { element.x += dx; element.y += dy; }
    return element;
}

export function constrainShape(type, start, end, shift = false) {
    if (!shift) return { x: end.x, y: end.y };
    const dx = end.x - start.x; const dy = end.y - start.y;
    if (type === 'line' || type === 'arrow') {
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; const length = Math.hypot(dx, dy);
        return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
    }
    if (type === 'rect' || type === 'ellipse') {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        return { x: start.x + (dx < 0 ? -side : side), y: start.y + (dy < 0 ? -side : side) };
    }
    return { x: end.x, y: end.y };
}

export function fitCamera(bounds, width, height, padding = 80) {
    if (!bounds) return { x: 0, y: 0, zoom: 1 };
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: Math.min(2, clampZoom(Math.min(Math.max(1, width - padding * 2) / Math.max(1, bounds.width), Math.max(1, height - padding * 2) / Math.max(1, bounds.height)))) };
}

export function zoomCamera(camera, zoom, anchor, width, height) {
    const next = clampZoom(zoom); const x = anchor.x - width / 2; const y = anchor.y - height / 2;
    return { x: camera.x + x / camera.zoom - x / next, y: camera.y + y / camera.zoom - y / next, zoom: next };
}
