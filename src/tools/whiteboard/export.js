import { getElementBounds } from './geometry.js';
import { prepareFormulaDrawings } from './formulaExport.js';

function checkAbort(signal) { if (signal?.aborted) throw new DOMException('白板导出已取消', 'AbortError'); }

function contentBounds(elements, formulas) {
    if (!elements.length) return null;
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
    for (const element of elements) {
        const drawing = element.type === 'formula' ? formulas.get(element.id) : null;
        const bounds = drawing ? { x: element.x, y: element.y, width: drawing.width, height: drawing.height } : getElementBounds(element);
        left = Math.min(left, bounds.x); top = Math.min(top, bounds.y);
        right = Math.max(right, bounds.x + bounds.width); bottom = Math.max(bottom, bounds.y + bounds.height);
    }
    const bounds = { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    if (!Object.values(bounds).every(Number.isFinite)) throw new Error('白板内容范围超过可导出的尺寸');
    return bounds;
}

function imageLayout(bounds, thumbnail) {
    if (thumbnail) {
        const zoom = bounds ? Math.min(2, 288 / bounds.width, 168 / bounds.height) : 1;
        return { width: 320, height: 200, camera: bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom } : { x: 0, y: 0, zoom } };
    }
    if (!bounds) return { width: 960, height: 640, camera: { x: 0, y: 0, zoom: 1 } };
    const portrait = bounds.height > bounds.width;
    const maximumWidth = portrait ? 1_600 : 2_400; const maximumHeight = portrait ? 2_400 : 1_600;
    const minimumWidth = portrait ? 640 : 960; const minimumHeight = portrait ? 960 : 640; const padding = 64;
    const zoom = Math.min(2, (maximumWidth - padding * 2) / bounds.width, (maximumHeight - padding * 2) / bounds.height);
    return {
        width: Math.min(maximumWidth, Math.max(minimumWidth, Math.ceil(bounds.width * zoom + padding * 2))),
        height: Math.min(maximumHeight, Math.max(minimumHeight, Math.ceil(bounds.height * zoom + padding * 2))),
        camera: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom }
    };
}

function yieldDrawing(signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const abort = () => { clearTimeout(timer); cleanup(); reject(new DOMException('白板导出已取消', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 0);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

export async function renderBoardImage(boardDocument, { thumbnail = false, signal, runtime, drawElement, drawBackground } = {}) {
    checkAbort(signal);
    if (!boardDocument || !Array.isArray(boardDocument.elements)) throw new Error('白板导出文档无效');
    if (boardDocument.elements.length && typeof drawElement !== 'function') throw new Error('白板导出缺少对象绘制程序');
    const formulas = await prepareFormulaDrawings(boardDocument.elements, { runtime, signal });
    checkAbort(signal);
    const bounds = contentBounds(boardDocument.elements, formulas); const { width, height, camera } = imageLayout(bounds, thumbnail);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('白板导出图片无法创建');
    try {
        context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
        if (typeof drawBackground === 'function') {
            context.save(); drawBackground(context, width, height, camera, boardDocument.background); context.restore();
        }
        context.save();
        context.translate(width / 2 - camera.x * camera.zoom, height / 2 - camera.y * camera.zoom);
        context.scale(camera.zoom, camera.zoom);
        for (let index = 0; index < boardDocument.elements.length; index++) {
            checkAbort(signal); drawElement(context, boardDocument.elements[index], false, formulas);
            if ((index + 1) % 128 === 0) await yieldDrawing(signal);
        }
        context.restore(); checkAbort(signal);
        return canvas;
    } catch (error) {
        canvas.width = 0; canvas.height = 0;
        throw error;
    } finally { formulas.clear(); }
}
