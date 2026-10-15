import { containsArea, validateExportSize, wrappedLines } from './model.js';

const FONT = "'Segoe UI','Microsoft YaHei',sans-serif";
function rounded(ctx, x, y, w, h, radius = 10) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
}
export async function renderPNG(task, area, loadOriginal, { scale = 1, transparent = false, selected = null, shouldContinue = () => true } = {}) {
    const size = validateExportSize(area, scale), canvas = document.createElement('canvas');
    canvas.width = size.w; canvas.height = size.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画布绘图不可用');
    try {
    ctx.scale(scale, scale); ctx.translate(-area.x, -area.y);
    if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(area.x, area.y, area.w, area.h); }
    for (const node of task.nodes) {
        if(!shouldContinue()){canvas.width=canvas.height=1;throw new DOMException('导出已取消','AbortError');}
        if (!containsArea(node, area) || (selected && !selected.has(node.id))) continue;
        const { x, y, w, h } = node;
        ctx.save(); ctx.translate(x, y);
        if (node.rotation) { ctx.translate(w / 2, h / 2); ctx.rotate(node.rotation * Math.PI / 180); ctx.translate(-w / 2, -h / 2); }
        if (node.type === 'image') {
            // Originals are decoded one at a time and immediately released after drawing.
            const image = await loadOriginal(node.assetId);
            try { rounded(ctx, 0, 0, w, h); ctx.clip(); ctx.drawImage(image, 0, 0, w, h); }
            finally { if (image.close) image.close(); else image.src = ''; }
        } else if (node.type === 'rect') {
            ctx.strokeStyle = node.color; ctx.lineWidth = 2; rounded(ctx, 1, 1, w - 2, h - 2, 7); ctx.stroke();
        } else if (node.type === 'arrow' || node.type === 'pen') {
            ctx.strokeStyle = node.color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            const points = node.points.length ? node.points : [{ x: 3, y: h - 3 }, { x: w - 3, y: 3 }];
            ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
            if (node.type === 'arrow' && points.length >= 2) {
                const a = points.at(-2), b = points.at(-1), angle = Math.atan2(b.y - a.y, b.x - a.x);
                ctx.beginPath(); ctx.moveTo(b.x - 14 * Math.cos(angle - .5), b.y - 14 * Math.sin(angle - .5));
                ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - 14 * Math.cos(angle + .5), b.y - 14 * Math.sin(angle + .5)); ctx.stroke();
            }
        } else {
            ctx.fillStyle = node.type === 'note' ? '#fff5da' : '#ffffff'; rounded(ctx, 0, 0, w, h); ctx.fill();
            ctx.strokeStyle = node.type === 'note' ? '#efdfb3' : '#e5e8df'; ctx.lineWidth = 1; ctx.stroke();
            rounded(ctx, 0, 0, w, h); ctx.clip();
            if (node.type === 'link') {
                ctx.fillStyle = '#4a7566'; ctx.font = `600 14px ${FONT}`;
                const title = wrappedLines(ctx, node.name || '收集的链接', Math.max(10, w - 40));
                let py = 32; for (const line of title) { if (py > h - 18) break; ctx.fillText(line, 20, py); py += 20; }
                ctx.fillStyle = '#899589'; ctx.font = `11px ${FONT}`;
                for (const line of wrappedLines(ctx, node.url, Math.max(10, w - 40))) { if (py > h - 8) break; ctx.fillText(line, 20, py); py += 17; }
            } else {
                ctx.fillStyle = '#899589'; ctx.font = `9px ${FONT}`; ctx.fillText(node.type === 'note' ? 'A LITTLE NOTE' : 'COLLECTED TEXT', 20, 28);
                ctx.fillStyle = '#28312f'; ctx.font = `${node.fontSize}px ${FONT}`;
                const lineHeight = node.fontSize * 1.65; let py = 44 + node.fontSize;
                for (const line of wrappedLines(ctx, node.body, Math.max(10, w - 40))) { if (py > h) break; ctx.fillText(line, 20, py); py += lineHeight; }
            }
        }
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
    } finally { canvas.width = canvas.height = 1; }
}

export function textHeight(body, width = 320, fontSize = 18) {
    const ctx = document.createElement('canvas').getContext('2d'); ctx.font = `${fontSize}px ${FONT}`;
    return Math.max(100, Math.ceil(wrappedLines(ctx, body, Math.max(10, width - 40)).length * fontSize * 1.65 + 66));
}

export async function imageFilePNG(file) {
    if (file.size > 32 * 1024 * 1024) throw new Error('单张图片不能超过 32 MB');
    const bitmap = await createImageBitmap(file);
    try {
        validateExportSize({ w: bitmap.width, h: bitmap.height }, 1);
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const data = canvas.toDataURL('image/png'); canvas.width = canvas.height = 1; return data;
    } finally { bitmap.close(); }
}
