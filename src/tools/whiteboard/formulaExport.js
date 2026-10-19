import { renderFormulaMarkup } from './formula.js';

const MAX_DIMENSION = 2_000;
const MAX_TOTAL_PIXELS = 50_000_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function abortError() { return new DOMException('公式导出已取消', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

function yieldTask(signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const abort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 0);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

function abortable(promise, signal) {
    if (!signal) return promise;
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(abortError()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

function fontValue(computed) { return `${computed.fontStyle || 'normal'} ${computed.fontWeight || '400'} ${computed.fontSize} ${computed.fontFamily}`; }
function transparent(color) { return color === 'transparent' || color === 'rgba(0, 0, 0, 0)'; }
function intersect(a, b) { return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }; }
function box(left, top, width, height) { return { left, top, right: left + width, bottom: top + height }; }

function opacityOf(element, root) {
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
        opacity *= Number.parseFloat(getComputedStyle(node).opacity) || 0;
        if (node === root) break;
    }
    return opacity;
}

function textRecords(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const records = [];
    while (walker.nextNode()) {
        const node = walker.currentNode; const parent = node.parentElement;
        if (!node.nodeValue || !node.nodeValue.replace(/[\s\u200b\u2060]/g, '') || parent.closest('svg, math, .katex-mathml')) continue;
        const computed = getComputedStyle(parent);
        if (computed.visibility !== 'visible' || computed.display === 'none') continue;
        const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); range.detach?.();
        if (rect.width <= 0 || rect.height <= 0) continue;
        records.push({ text: node.nodeValue, font: fontValue(computed), color: computed.color, rect, opacity: opacityOf(parent, root) });
    }
    return records;
}

function decorationRecords(root) {
    const records = [];
    for (const element of [root, ...root.querySelectorAll('*')]) {
        if (element.closest('svg, math, .katex-mathml')) continue;
        const computed = getComputedStyle(element); if (computed.visibility !== 'visible' || computed.display === 'none') continue;
        const rect = element.getBoundingClientRect(); const opacity = opacityOf(element, root);
        if (!transparent(computed.backgroundColor) && rect.width > 0 && rect.height > 0) records.push({ rect, color: computed.backgroundColor, opacity });
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
            const width = Number.parseFloat(computed[`border${side}Width`]); const color = computed[`border${side}Color`];
            if (!width || computed[`border${side}Style`] === 'none' || transparent(color)) continue;
            const border = side === 'Top' ? box(rect.left, rect.top, rect.width, width)
                : side === 'Bottom' ? box(rect.left, rect.bottom - width, rect.width, width)
                    : side === 'Left' ? box(rect.left, rect.top, width, rect.height)
                        : box(rect.right - width, rect.top, width, rect.height);
            records.push({ rect: border, color, opacity });
        }
    }
    return records;
}

function clippedSvgRect(svg, root) {
    let rect = svg.getBoundingClientRect();
    for (let parent = svg.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const computed = getComputedStyle(parent); const bounds = parent.getBoundingClientRect();
        if (['hidden', 'clip', 'auto', 'scroll'].includes(computed.overflowX)) rect = intersect(rect, { left: bounds.left, right: bounds.right, top: -Infinity, bottom: Infinity });
        if (['hidden', 'clip', 'auto', 'scroll'].includes(computed.overflowY)) rect = intersect(rect, { top: bounds.top, bottom: bounds.bottom, left: -Infinity, right: Infinity });
    }
    return rect;
}

function standaloneSvg(svg, clip) {
    const rect = svg.getBoundingClientRect(); const clone = svg.cloneNode(true);
    const originals = [svg, ...svg.querySelectorAll('*')]; const copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((node, index) => {
        if (!['svg', 'g', 'path', 'rect', 'line', 'circle', 'ellipse', 'polygon', 'polyline'].includes(node.localName)) throw new Error('公式包含无法导出的图形');
        const copy = copies[index]; const computed = getComputedStyle(node); copy.removeAttribute('style');
        for (const [property, attribute] of [['fill', 'fill'], ['stroke', 'stroke'], ['strokeWidth', 'stroke-width'], ['fillRule', 'fill-rule'], ['strokeLinecap', 'stroke-linecap'], ['strokeLinejoin', 'stroke-linejoin'], ['opacity', 'opacity']]) copy.setAttribute(attribute, computed[property]);
        copy.setAttribute('color', computed.color);
    });
    const viewBox = svg.viewBox.baseVal;
    const original = { x: viewBox.x, y: viewBox.y, width: viewBox.width || rect.width, height: viewBox.height || rect.height };
    let sx = rect.width / original.width; let sy = rect.height / original.height; let ox = 0; let oy = 0;
    const aspect = svg.preserveAspectRatio.baseVal;
    if (aspect.align !== 1) {
        const scale = aspect.meetOrSlice === 2 ? Math.max(sx, sy) : Math.min(sx, sy); sx = scale; sy = scale;
        const alignment = Math.max(0, aspect.align - 2);
        ox = (rect.width - original.width * scale) * (alignment % 3) / 2;
        oy = (rect.height - original.height * scale) * Math.floor(alignment / 3) / 2;
    }
    clone.setAttribute('xmlns', SVG_NAMESPACE);
    clone.setAttribute('width', String(clip.right - clip.left)); clone.setAttribute('height', String(clip.bottom - clip.top));
    clone.setAttribute('viewBox', `${original.x + (clip.left - rect.left - ox) / sx} ${original.y + (clip.top - rect.top - oy) / sy} ${(clip.right - clip.left) / sx} ${(clip.bottom - clip.top) / sy}`);
    clone.setAttribute('preserveAspectRatio', 'none');
    return new XMLSerializer().serializeToString(clone);
}

async function svgImage(source, signal) {
    checkAbort(signal);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' })); const image = new Image();
    try {
        await abortable(new Promise((resolve, reject) => {
            image.onload = resolve; image.onerror = () => reject(new Error('公式图形渲染失败'));
            image.src = url;
        }), signal);
        checkAbort(signal); return image;
    } finally {
        image.onload = null; image.onerror = null; URL.revokeObjectURL(url);
        if (signal?.aborted) image.src = '';
    }
}

async function renderFormula(formula, host, runtime, signal, budget) {
    const root = document.createElement('div'); root.className = 'whiteboard-export-formula';
    root.style.fontSize = '22px'; root.style.fontFamily = 'serif'; root.style.display = 'inline-block'; root.style.position = 'relative'; root.style.whiteSpace = 'nowrap'; root.style.color = formula.color; root.style.visibility = 'visible';
    host.replaceChildren(root);
    renderFormulaMarkup(runtime, formula.latex, root, { output: 'html', displayMode: false });
    root.getBoundingClientRect();
    let texts = textRecords(root);
    if (document.fonts) {
        const fonts = new Map();
        texts.forEach(record => fonts.set(record.font, (fonts.get(record.font) || '') + record.text));
        await abortable(Promise.all([...fonts].map(([font, text]) => document.fonts.load(font, text))), signal);
        await abortable(document.fonts.ready, signal);
        texts = textRecords(root);
    }
    checkAbort(signal);
    const decorations = decorationRecords(root); const graphics = [];
    for (const svg of root.querySelectorAll('.katex-html svg')) {
        const rect = clippedSvgRect(svg, root);
        if (rect.right <= rect.left || rect.bottom <= rect.top || getComputedStyle(svg).visibility !== 'visible') continue;
        graphics.push({ rect, image: await svgImage(standaloneSvg(svg, rect), signal), opacity: opacityOf(svg.parentElement, root) });
    }
    checkAbort(signal);
    const rects = [root.getBoundingClientRect(), ...texts.map(value => value.rect), ...decorations.map(value => value.rect), ...graphics.map(value => value.rect)];
    const left = Math.min(...rects.map(value => value.left)) - 1; const top = Math.min(...rects.map(value => value.top)) - 1;
    const width = Math.max(1, Math.ceil(Math.max(...rects.map(value => value.right)) - left + 1)); const height = Math.max(1, Math.ceil(Math.max(...rects.map(value => value.bottom)) - top + 1));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('公式尺寸无效');
    const density = Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.min(MAX_DIMENSION, Math.ceil(width * density))); canvas.height = Math.max(1, Math.min(MAX_DIMENSION, Math.ceil(height * density)));
    budget.pixels += canvas.width * canvas.height;
    if (budget.pixels > MAX_TOTAL_PIXELS) { canvas.width = 0; canvas.height = 0; throw new Error('公式图片超过导出容量，请拆分白板后重试'); }
    const context = canvas.getContext('2d'); if (!context) throw new Error('公式图片无法创建');
    context.scale(density, density);
    for (const decoration of decorations) {
        context.globalAlpha = decoration.opacity; context.fillStyle = decoration.color;
        context.fillRect(decoration.rect.left - left, decoration.rect.top - top, decoration.rect.right - decoration.rect.left, decoration.rect.bottom - decoration.rect.top);
    }
    context.textBaseline = 'alphabetic';
    for (const record of texts) {
        context.font = record.font; context.fillStyle = record.color; context.globalAlpha = record.opacity;
        const metrics = context.measureText(record.text); const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 0;
        context.fillText(record.text, record.rect.left - left, record.rect.bottom - top - descent);
    }
    for (const graphic of graphics) {
        context.globalAlpha = graphic.opacity;
        context.drawImage(graphic.image, graphic.rect.left - left, graphic.rect.top - top, graphic.rect.right - graphic.rect.left, graphic.rect.bottom - graphic.rect.top);
    }
    checkAbort(signal);
    return { width, height, draw(target, x, y) { target.drawImage(canvas, x, y, width, height); } };
}

export async function prepareFormulaDrawings(elements, { runtime, signal } = {}) {
    checkAbort(signal);
    const formulas = elements.filter(element => element.type === 'formula'); const result = new Map(); if (!formulas.length) return result;
    if (!runtime) {
        const [module] = await abortable(Promise.all([import('katex'), import('katex/dist/katex.min.css')]), signal);
        runtime = module.default || module;
    }
    const host = document.createElement('div'); host.className = 'whiteboard-export-measure'; host.setAttribute('aria-hidden', 'true');
    host.style.position = 'fixed'; host.style.left = '-100000px'; host.style.top = '0'; host.style.width = 'max-content'; host.style.pointerEvents = 'none'; host.style.visibility = 'hidden'; host.style.opacity = '0';
    document.body.append(host);
    try {
        const budget = { pixels: 0 };
        for (const formula of formulas) {
            checkAbort(signal);
            result.set(formula.id, await renderFormula(formula, host, runtime, signal, budget));
            if (result.size % 8 === 0) await yieldTask(signal);
        }
        return result;
    } catch (error) {
        result.clear();
        if (error?.name === 'AbortError') throw error;
        throw new Error(`公式导出失败：${error?.message || String(error)}`);
    } finally { host.remove(); }
}
