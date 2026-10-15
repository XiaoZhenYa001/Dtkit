export const MAX_OBJECTS = 1000;
export const MAX_EXPORT_PIXELS = 40_000_000;
export const DEFAULT_FRAME = Object.freeze({ x: 60, y: 86, w: 824, h: 580 });
export const TOOLS = Object.freeze([
    ['select', 'cursor', '选择', 'V'], ['scissors', 'scissors', '区域截取', 'C'],
    ['text', 'text', '文字', 'T'], ['image', 'image', '图片', 'I'],
    ['rect', 'rect', '矩形', 'R'], ['arrow', 'arrow', '箭头', 'A'], ['pen', 'pen', '画笔', 'B']
]);
export const newId = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export function newNode(type, properties = {}) {
    return { id: newId(), type, x: 84, y: 110, w: 320, h: 160, name: '', body: '', originalBody: '',
        url: '', assetId: null, groupId: null, points: [], color: '#cf6c43', fontSize: 18,
        rotation: 0, sourceUrl: null, collectedAt: Date.now(), ...properties };
}
export function bounds(nodes) {
    if (!nodes.length) return { ...DEFAULT_FRAME };
    const x = Math.min(...nodes.map(n => n.x)), y = Math.min(...nodes.map(n => n.y));
    return { x, y, w: Math.max(...nodes.map(n => n.x + n.w)) - x,
        h: Math.max(...nodes.map(n => n.y + n.h)) - y };
}
export function containsArea(node, area) {
    return node.x < area.x + area.w && node.x + node.w > area.x
        && node.y < area.y + area.h && node.y + node.h > area.y;
}
export function toWorld(client, rect, camera) {
    return { x: (client.x - rect.left - camera.x) / camera.z, y: (client.y - rect.top - camera.y) / camera.z };
}
export function selectionArea(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
export function snapPosition(nodes, targets, x, y, zoom = 1, enabled = true) {
    const box = bounds(nodes), threshold = 8 / zoom, lines = []; let dx = threshold + 1, dy = threshold + 1;
    let gx = null, gy = null;
    if (enabled) for (const target of targets) {
        for (const a of [x, x + box.w / 2, x + box.w]) for (const b of [target.x, target.x + target.w / 2, target.x + target.w]) {
            if (Math.abs(b - a) < Math.abs(dx)) { dx = b - a; gx = b; }
        }
        for (const a of [y, y + box.h / 2, y + box.h]) for (const b of [target.y, target.y + target.h / 2, target.y + target.h]) {
            if (Math.abs(b - a) < Math.abs(dy)) { dy = b - a; gy = b; }
        }
    }
    if (Math.abs(dx) > threshold) dx = 0; else lines.push({ axis: 'x', value: gx });
    if (Math.abs(dy) > threshold) dy = 0; else lines.push({ axis: 'y', value: gy });
    return { x: x + dx, y: y + dy, lines };
}
export function layoutNodes(nodes, mode = 'vertical', gap = 24) {
    const result = clone(nodes), box = bounds(result); let x = box.x, y = box.y, rowHeight = 0;
    result.forEach((n, index) => {
        if (mode === 'grid' && index && index % 3 === 0) { x = box.x; y += rowHeight + gap; rowHeight = 0; }
        n.x = x; n.y = y; rowHeight = Math.max(rowHeight, n.h);
        if (mode === 'vertical') y += n.h + gap; else x += n.w + gap;
    }); return result;
}
export function diffOperations(before, after) {
    const a = new Map(before.map(n => [n.id, n])), b = new Map(after.map(n => [n.id, n]));
    const remove = [...a.keys()].filter(id => !b.has(id));
    const nodes = [...b.values()].filter(n => JSON.stringify(a.get(n.id)) !== JSON.stringify(n));
    return [...(remove.length ? [{ type: 'remove', ids: remove }] : []), ...(nodes.length ? [{ type: 'upsert', nodes: clone(nodes) }] : [])];
}
export function exportArea(task, selectedIds, scope) {
    if (scope === 'frame') return { ...task.frame };
    const nodes = scope === 'selected' ? task.nodes.filter(n => selectedIds.has(n.id)) : task.nodes;
    if (!nodes.length) throw new Error('请先选择或添加内容');
    const b = bounds(nodes); return { x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 };
}
export function validateExportSize(area, scale) {
    const w = Math.ceil(area.w * scale), h = Math.ceil(area.h * scale);
    if (w < 1 || h < 1 || w > 16384 || h > 16384 || w * h > MAX_EXPORT_PIXELS) {
        throw new Error('导出区域过大，请降低倍率、选择部分内容或拆分拼图框');
    } return { w, h };
}
export function wrappedLines(context, text, width) {
    const result = []; let line = '';
    for (const c of String(text)) {
        if (c === '\n') { result.push(line); line = ''; }
        else if (line && context.measureText(line + c).width > width) { result.push(line); line = c; }
        else line += c;
    } result.push(line); return result;
}
