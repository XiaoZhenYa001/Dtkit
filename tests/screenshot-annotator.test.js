import assert from 'node:assert/strict';
import test from 'node:test';
import {
    History, LIMITS, normalizeRect, constrainPoint, objectBounds, hitTestObject,
    translateObject, resizeObject, selectionHandles, hitTestHandle, nextStepNumber, sanitizeDocument,
} from '../src/tools/screenshot-annotator/core.js';
import { drawObject, renderDocument } from '../src/tools/screenshot-annotator/renderer.js';

const rect = (overrides = {}) => ({ id: 'r', type: 'rect', x: 10, y: 20, width: 80, height: 60, size: 2, color: '#ff453a', ...overrides });
const document = (objects = [], overrides = {}) => ({ objects, crop: { x: 0, y: 0, width: 400, height: 300 }, cornerRadius: 0, ...overrides });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('reverse region drags normalize, Shift maintains a square in every quadrant', () => {
    assert.deepEqual(normalizeRect({ x: 60, y: 90 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 50, height: 70 });
    assert.deepEqual(normalizeRect({ x: 60, y: 90 }, { x: 10, y: 20 }, true), { x: -10, y: 20, width: 70, height: 70 });
    assert.deepEqual(normalizeRect({ x: 60, y: 90 }, { x: 110, y: 100 }, true), { x: 60, y: 90, width: 50, height: 50 });
});

test('line constraints snap direction while preserving stroke length', () => {
    const snapped = constrainPoint({ x: 30, y: 20 }, { x: 90, y: 30 });
    close(snapped.y, 20); close(Math.hypot(snapped.x - 30, snapped.y - 20), Math.hypot(60, 10));
});

test('shape hit testing distinguishes empty interiors, filled shapes and outline ellipses', () => {
    assert.equal(hitTestObject(rect(), { x: 50, y: 50 }, 1), false);
    assert.equal(hitTestObject(rect(), { x: 10, y: 50 }, 1), true);
    assert.equal(hitTestObject(rect({ fill: true }), { x: 50, y: 50 }, 1), true);
    assert.equal(hitTestObject(rect({ type: 'ellipse' }), { x: 50, y: 50 }, 1), false);
    assert.equal(hitTestObject(rect({ type: 'ellipse' }), { x: 90, y: 50 }, 1), true);
    assert.equal(hitTestObject(rect({ type: 'ellipse', fill: true }), { x: 50, y: 50 }, 1), true);
    assert.equal(hitTestObject(rect({ type: 'mosaic' }), { x: 50, y: 50 }, 1), true);
});

test('pen and line hit tests follow visible strokes rather than their bounding boxes', () => {
    const pen = { type: 'pen', size: 3, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
    assert.equal(hitTestObject(pen, { x: 50, y: 50 }), true);
    assert.equal(hitTestObject(pen, { x: 10, y: 90 }), false);
    assert.equal(hitTestObject({ type: 'pen', size: 6, points: [{ x: 5, y: 5 }] }, { x: 5, y: 5 }), true);
    assert.equal(hitTestObject({ type: 'line', x: 0, y: 0, x2: 100, y2: 100, size: 2 }, { x: 5, y: 90 }), false);
});

test('arrow heads remain selectable outside a horizontal shaft bounding box', () => {
    const arrow = { type: 'arrow', x: 10, y: 50, x2: 90, y2: 50, size: 8 };
    assert.equal(hitTestObject(arrow, { x: 67, y: 63 }, 1), true);
    assert.equal(hitTestObject(arrow, { x: 20, y: 70 }, 1), false);
});

test('smooth pen hit testing follows rendered quadratic corners', () => {
    const pen = { type: 'pen', size: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] };
    assert.equal(hitTestObject(pen, { x: 75, y: 12.5 }, 1), true);
    assert.equal(hitTestObject(pen, { x: 75, y: 0 }, 1), false);
});

test('translation returns an independent object and translates every geometry kind', () => {
    const line = { type: 'line', x: 5, y: 6, x2: 15, y2: 16 };
    assert.deepEqual(translateObject(line, 10, 20), { type: 'line', x: 15, y: 26, x2: 25, y2: 36 });
    const pen = { type: 'pen', points: [{ x: 5, y: 6 }] };
    const moved = translateObject(pen, 10, 20); moved.points[0].x = 999;
    assert.equal(pen.points[0].x, 5); assert.equal(line.x, 5);
});

test('resize preserves reversed endpoints and handles initially vertical lines', () => {
    const line = { type: 'arrow', x: 100, y: 100, x2: 0, y2: 0 };
    const resized = resizeObject(line, objectBounds(line), { x: 10, y: 20, width: 200, height: 50 });
    assert.deepEqual(resized, { type: 'arrow', x: 210, y: 70, x2: 10, y2: 20 });
    const vertical = resizeObject({ type: 'line', x: 30, y: 10, x2: 30, y2: 100 }, { x: 30, y: 10, width: 0, height: 90 }, { x: 80, y: 20, width: 0, height: 180 });
    assert.equal(vertical.x, 80); assert.equal(vertical.x2, 80); assert.equal(vertical.y2, 200);
});

test('resize updates text font size, step badges and pen points without mutating originals', () => {
    const text = { type: 'text', x: 10, y: 20, text: '测试', fontSize: 20, width: 40, height: 27 };
    const resized = resizeObject(text, objectBounds(text), { x: 50, y: 60, width: 80, height: 54 });
    assert.equal(resized.fontSize, 40); assert.equal(text.fontSize, 20);
    const step = resizeObject({ type: 'step', x: 30, y: 30, size: 8, number: 1 }, { x: 14, y: 14, width: 32, height: 32 }, { x: 40, y: 50, width: 64, height: 64 });
    assert.deepEqual(objectBounds(step), { x: 40, y: 50, width: 64, height: 64 });
    const pen = { type: 'pen', size: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
    const resizedPen = resizeObject(pen, { x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 20, width: 200, height: 200 });
    assert.deepEqual(resizedPen.points, [{ x: 10, y: 20 }, { x: 210, y: 220 }]); assert.equal(resizedPen.size, 4);
});

test('horizontal and vertical text handles scale glyphs and selection bounds together', () => {
    const text = { type: 'text', x: 10, y: 20, text: '测试\n文字', fontSize: 20, size: 5, width: 40, height: 54 };
    for (const box of [
        { x: 50, y: 60, width: 80, height: 54 },
        { x: 50, y: 60, width: 40, height: 108 },
    ]) {
        const resized = resizeObject(text, objectBounds(text), box);
        assert.equal(resized.fontSize, 40);
        assert.equal(resized.size, 10);
        assert.deepEqual(objectBounds(resized), { x: 50, y: 60, width: 80, height: 108 });
        const canvas = mockCanvas(), context = canvas.getContext();
        drawObject(context, resized);
        assert.match(context.font, /600 40px /);
        const lines = context.operations.filter(operation => operation[0] === 'fillText');
        assert.equal(lines.length, 2);
        assert.equal(lines[1][3] - lines[0][3], 54);
    }
    assert.equal(text.fontSize, 20);
    assert.equal(text.width, 40);
});

test('text shrinking and font limits keep measured bounds proportional to actual font size', () => {
    const text = { type: 'text', x: 10, y: 20, text: '测试', fontSize: 20, size: 5, width: 40, height: 27 };
    const small = resizeObject(text, objectBounds(text), { x: 0, y: 0, width: 20, height: 27 });
    assert.equal(small.fontSize, 10);
    assert.deepEqual(objectBounds(small), { x: 0, y: 0, width: 20, height: 13.5 });
    const minimum = resizeObject(text, objectBounds(text), { x: 5, y: 6, width: 1, height: 1 });
    assert.equal(minimum.fontSize, 8);
    close(minimum.width / text.width, minimum.fontSize / text.fontSize);
    close(minimum.height / text.height, minimum.fontSize / text.fontSize);
    const maximum = resizeObject(text, objectBounds(text), { x: 5, y: 6, width: 4000, height: 2700 });
    assert.equal(maximum.fontSize, 256);
    close(maximum.width / text.width, maximum.fontSize / text.fontSize);
    close(maximum.height / text.height, maximum.fontSize / text.fontSize);
});

test('selection handles use source coordinates and maintain a screen-sized hit target', () => {
    const shape = rect();
    assert.equal(selectionHandles(shape).length, 8);
    assert.equal(hitTestHandle(shape, { x: 10, y: 20 }), 'nw');
    assert.equal(hitTestHandle(shape, { x: 2, y: 20 }, { zoom: 0.5 }), 'nw');
    assert.equal(hitTestHandle(shape, { x: 2, y: 20 }, { zoom: 2 }), null);
});

test('step numbering follows highest remaining number and ignores non-step objects', () => {
    assert.equal(nextStepNumber([]), 1);
    assert.equal(nextStepNumber([{ type: 'step', number: 2 }, { type: 'text', number: 999 }, { type: 'step', number: 7 }]), 8);
    assert.equal(nextStepNumber([{ type: 'step', number: 999 }]), 999);
});

test('document sanitation clips crop and radius, rejects unknown marks and nonfinite input', () => {
    const value = sanitizeDocument(document([
        rect({ x: -10, y: 10, width: 30 }),
        { type: 'script', text: 'discard' },
        { type: 'line', x: NaN, y: Infinity, x2: 500, y2: -10, color: 'url(x)' },
    ], { crop: { x: 390, y: 290, width: 999, height: 999 }, cornerRadius: 100 }), 400, 300);
    assert.deepEqual(value.crop, { x: 390, y: 290, width: 10, height: 10 });
    assert.equal(value.cornerRadius, 5); assert.equal(value.objects.length, 2);
    assert.equal(value.objects[0].x, 0); assert.equal(value.objects[0].width, 20);
    assert.equal(value.objects[1].x, 0); assert.equal(value.objects[1].x2, 400); assert.equal(value.objects[1].y2, 0);
    assert.equal(value.objects[1].color, '#ff453a');
    assert.deepEqual(sanitizeDocument(null, 400, 300).crop, { x: 0, y: 0, width: 400, height: 300 });
});

test('restored redaction is opaque and malformed duplicate ids cannot stall restoration', () => {
    const value = sanitizeDocument(document([
        rect({ id: 'mark-2-1' }), rect({ id: 'same' }), rect({ id: 'same' }),
        rect({ type: 'redact', opacity: 0, color: '#fff0' }),
    ]), 400, 300);
    assert.equal(new Set(value.objects.map(object => object.id)).size, 4);
    assert.equal(value.objects[3].opacity, 1); assert.equal(value.objects[3].color, '#1c1c1e');
});

test('restoration bounds annotations, text and total pen points while preserving a long stroke endpoint', () => {
    const points = Array.from({ length: LIMITS.points + 100 }, (_, index) => ({ x: index, y: 1 }));
    const value = sanitizeDocument(document([
        { type: 'pen', points }, { type: 'pen', points: [{ x: 0, y: 0 }] },
        { type: 'text', x: 0, y: 0, text: '字'.repeat(LIMITS.text + 100) },
        ...Array.from({ length: 400 }, () => rect()),
    ]), 50000, 300);
    assert.ok(value.objects.length <= LIMITS.objects);
    assert.equal(value.objects[0].points.length, LIMITS.points);
    assert.equal(value.objects[0].points.at(-1).x, points.at(-1).x);
    assert.equal(value.objects.filter(object => object.type === 'pen').length, 1);
    assert.equal(value.objects.find(object => object.type === 'text').text.length, LIMITS.text);
});

test('history snapshots survive mutable editor references, deduplicate and invalidate redo on a branch', () => {
    const initial = document(), history = new History(initial);
    const changed = document([rect()]);
    assert.equal(history.push(changed), true); assert.equal(history.push(changed), false);
    changed.objects[0].x = 999;
    assert.deepEqual(history.undo(), initial); assert.equal(history.canUndo, false); assert.equal(history.canRedo, true);
    const redone = history.redo(); assert.equal(redone.objects[0].x, 10); redone.objects[0].x = 111;
    history.undo(); history.push(document([rect({ x: 40 })]));
    assert.equal(history.redo(), null); assert.equal(history.canRedo, false);
    assert.equal(history.undo().objects.length, 0);
});

test('history caps retained entries and memory, and reset begins an independent capture', () => {
    const history = new History(document(), { maxEntries: 4, maxBytes: 1024 * 1024 });
    for (let index = 0; index < 20; index++) history.push(document([rect({ x: index })]));
    assert.equal(history.length, 4);
    assert.equal(history.undo().objects[0].x, 18);
    assert.equal(history.undo().objects[0].x, 17);
    assert.equal(history.undo().objects[0].x, 16); assert.equal(history.undo(), null);
    history.reset(document()); assert.equal(history.length, 1); assert.equal(history.canRedo, false);
    const bounded = new History(document(), { maxBytes: 1024 });
    for (let index = 0; index < 10; index++) bounded.push(document([{ type: 'text', x: index, text: 'x'.repeat(1800) }]));
    assert.equal(bounded.length, 2); assert.ok(bounded.undo());
});

function mockCanvas() {
    const operations = [], states = [];
    const context = {
        globalAlpha: 1, canvas: null, operations,
        save() { states.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, globalCompositeOperation: this.globalCompositeOperation }); operations.push(['save']); },
        restore() { Object.assign(this, states.pop()); operations.push(['restore']); },
        fillRect(...args) { operations.push(['fillRect', ...args, { alpha: this.globalAlpha, color: this.fillStyle }]); },
    };
    for (const name of ['clearRect', 'beginPath', 'roundRect', 'arcTo', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'quadraticCurveTo', 'stroke', 'strokeRect', 'fill', 'fillText', 'clip', 'scale', 'translate', 'drawImage', 'setLineDash']) context[name] = (...args) => operations.push([name, ...args]);
    const canvas = { width: 1, height: 1, getContext: () => context, ownerDocument: { createElement: () => mockCanvas() } };
    context.canvas = canvas;
    return canvas;
}

test('renderer exports crop dimensions and translation without editor selections', () => {
    const canvas = mockCanvas(), image = { width: 400, height: 300 };
    renderDocument(canvas, image, document([rect()], { crop: { x: 25, y: 40, width: 100, height: 80 }, cornerRadius: 12 }), { scale: 2 });
    assert.equal(canvas.width, 200); assert.equal(canvas.height, 160);
    assert.ok(canvas.getContext().operations.some(op => op[0] === 'translate' && op[1] === -25 && op[2] === -40));
    assert.ok(canvas.getContext().operations.some(op => op[0] === 'roundRect' && op[5] === 12));
    assert.equal(canvas.getContext().operations.filter(op => op[0] === 'strokeRect').length, 1);
    assert.equal(canvas.getContext().operations.some(op => op[0] === 'setLineDash'), false);
});

test('opaque redaction ignores injected alpha colors and restores canvas state', () => {
    const context = mockCanvas().getContext();
    drawObject(context, rect({ type: 'redact', color: '#ffffff00', opacity: 0.01 }));
    const fill = context.operations.find(op => op[0] === 'fillRect').at(-1);
    assert.equal(fill.alpha, 1); assert.equal(fill.color, '#1c1c1e'); assert.equal(context.globalAlpha, 1);
});

test('mosaic renders through an actual low-resolution canvas and disables final smoothing', () => {
    const context = mockCanvas().getContext();
    drawObject(context, rect({ type: 'mosaic', x: 10, y: 20, width: 80, height: 60, pixelSize: 10 }), { width: 400, height: 300 });
    const draw = context.operations.find(op => op[0] === 'drawImage');
    assert.ok(draw); assert.equal(draw[1].width, 8); assert.equal(draw[1].height, 6);
    assert.equal(context.imageSmoothingEnabled, false);
});

test('single-point pen marks produce visible dots and multipoint ink uses smooth curves', () => {
    const context = mockCanvas().getContext();
    drawObject(context, { type: 'pen', color: '#f00', size: 6, points: [{ x: 20, y: 30 }] });
    assert.ok(context.operations.some(op => op[0] === 'arc' && op[3] === 3));
    drawObject(context, { type: 'pen', size: 6, points: [{ x: 0, y: 0 }, { x: 20, y: 40 }, { x: 50, y: 50 }] });
    assert.ok(context.operations.some(op => op[0] === 'quadraticCurveTo'));
});
