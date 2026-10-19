import assert from 'node:assert/strict';
import test from 'node:test';
import { getElementBounds, hitTestElement, translateElement, constrainShape, fitCamera, zoomCamera, arrowHeadPoints } from '../src/tools/whiteboard/geometry.js';
import { drawStroke, paintStrokeIncrement } from '../src/tools/whiteboard/ink.js';
import { normalizeDocumentV2, historyWeight, MAX_ELEMENTS, MAX_POINTS, MAX_STROKE_POINTS } from '../src/tools/whiteboard/document.js';

const ink = (overrides = {}) => ({ id: 'ink', type: 'stroke', tool: 'pen', color: '#242937', width: 4, points: [[0, 0, 0.5], [100, 100, 0.5]], ...overrides });
const shape = (type = 'line', overrides = {}) => ({ id: type, type, color: '#242937', width: 4, x1: 0, y1: 0, x2: 100, y2: 100, ...overrides });
const document = elements => ({ version: 2, infinite: true, background: 'dots', camera: { x: 4, y: -2, zoom: 1 }, elements });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} ≠ ${b}`);

function recordingContext() {
    const calls = []; const stack = [];
    const context = { calls, globalAlpha: 0.7, lineWidth: 3 };
    context.save = () => { stack.push({ globalAlpha: context.globalAlpha, lineWidth: context.lineWidth }); };
    context.restore = () => Object.assign(context, stack.pop());
    for (const name of ['beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'fill']) context[name] = (...args) => calls.push([name, ...args]);
    context.stroke = () => calls.push(['stroke', context.globalAlpha]);
    return context;
}

test('v2 documents preserve all supported objects as independent normalized data', () => {
    const items = [ink({ id: 1, color: '#AABBCC' }), ...['line', 'arrow', 'rect', 'ellipse'].map(type => shape(type)),
        { id: 'text', type: 'text', color: '#242937', x: 0, y: 0, text: '中文\nhello' },
        { id: 'note', type: 'note', color: '#242937', x: 0, y: 0, text: '便签' },
        { id: 'formula', type: 'formula', color: '#242937', x: 0, y: 0, latex: '\\frac{1}{2}' }];
    const source = document(items); const result = normalizeDocumentV2(source);
    assert.equal(result.elements.length, 8); assert.equal(result.elements[0].id, '1'); assert.equal(result.elements[0].color, '#aabbcc');
    assert.equal(result.elements[5].size, 24); assert.equal(result.elements[6].height, 150); assert.equal(result.elements[7].height, 60);
    assert.equal(normalizeDocumentV2(document([ink({ tool: 'eraser' })])).elements[0].tool, 'eraser');
    result.elements[0].points[0][0] = 900; result.camera.x = 900;
    assert.equal(source.elements[0].points[0][0], 0); assert.equal(source.camera.x, 4);
    assert.equal(historyWeight(items), 8 + 2 + '中文\nhello'.length + '便签'.length + '\\frac{1}{2}'.length);
});

test('v2 documents reject unsupported formats and invalid view data', () => {
    for (const value of [null, { version: 1, strokes: [] }, { ...document([]), infinite: false }, { ...document([]), background: 'unknown' }, { ...document([]), camera: { x: Infinity, y: 0, zoom: 1 } }]) assert.throws(() => normalizeDocumentV2(value), /白板数据无效/);
    assert.equal(normalizeDocumentV2({ ...document([]), camera: { x: 0, y: 0, zoom: 20 } }).camera.zoom, 8);
    assert.equal(normalizeDocumentV2({ ...document([]), camera: { x: 0, y: 0, zoom: -1 } }).camera.zoom, 0.1);
});

test('v2 object schema rejects duplicate identities and invalid geometry instead of dropping content', () => {
    const invalid = [ink({ id: '' }), ink({ color: 'red' }), ink({ width: -2 }), shape('line', { x2: NaN }), { id: 'bad', type: 'image', color: '#242937' }, { id: 'text', type: 'text', x: 0, y: 0, color: '#242937', text: 25 }];
    for (const element of invalid) assert.throws(() => normalizeDocumentV2(document([element])), /白板数据无效/);
    assert.throws(() => normalizeDocumentV2(document([ink({ id: 1 }), ink({ id: '1' })])), /重复/);
});

test('v2 stroke schema validates finite coordinates, pressure and nonempty paths', () => {
    for (const points of [[], [[0]], [[Infinity, 0]], [['0', 1]], [[0, 0, -0.1]], [[0, 0, 1.1]], [[0, 0, NaN]]]) assert.throws(() => normalizeDocumentV2(document([ink({ points })])), /白板数据无效/);
    assert.deepEqual(normalizeDocumentV2(document([ink({ points: [[0, 1]] })])).elements[0].points, [[0, 1, 0.5]]);
});

test('v2 object capacity accepts its boundary and rejects overflow without truncation', () => {
    const items = Array.from({ length: MAX_ELEMENTS }, (_, id) => shape('line', { id }));
    assert.equal(normalizeDocumentV2(document(items)).elements.length, MAX_ELEMENTS);
    assert.throws(() => normalizeDocumentV2(document([...items, shape('rect')])), /对象超过/);
});

test('v2 point budgets enforce per-stroke and total limits without trimming saved ink', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [index, index, 0.5]);
    assert.equal(normalizeDocumentV2(document([ink({ points })])).elements[0].points.length, MAX_STROKE_POINTS);
    assert.throws(() => normalizeDocumentV2(document([ink({ points: [...points, [0, 0, 0.5]] })])), /笔迹点数/);
    const items = Array.from({ length: MAX_POINTS / MAX_STROKE_POINTS }, (_, id) => ink({ id, points }));
    assert.equal(normalizeDocumentV2(document(items)).elements.length, 5);
    assert.throws(() => normalizeDocumentV2(document([...items, ink({ id: 'extra', points: [[0, 0]] })])), /总点数/);
});

test('v2 bounds include ink width, arrow heads and every line of text', () => {
    assert.deepEqual(getElementBounds(ink()), { x: -2, y: -2, width: 104, height: 104 });
    const arrow = shape('arrow', { x2: 10, y2: 0 }); const bounds = getElementBounds(arrow);
    for (const head of arrowHeadPoints(arrow)) assert.ok(head.x >= bounds.x && head.y >= bounds.y && head.x <= bounds.x + bounds.width && head.y <= bounds.y + bounds.height);
    const text = getElementBounds({ type: 'text', x: 8, y: 9, size: 24, text: 'abc\n中文\nx' });
    assert.equal(text.height, 90); assert.equal(text.width, 48);
});

test('line and arrow hit tests reject empty bounding-box regions and include arrowhead edges', () => {
    assert.equal(hitTestElement(shape(), { x: 4, y: 96 }, 1), false);
    assert.equal(hitTestElement(shape(), { x: 50, y: 51 }, 1), true);
    const arrow = shape('arrow', { x2: 100, y2: 0 }); const head = arrowHeadPoints(arrow)[0];
    assert.equal(hitTestElement(arrow, head, 0.1), true);
});

test('stroke hit tests follow the rendered quadratic curve instead of its rectangular extent', () => {
    const stroke = ink({ points: [[0, 0, 0.5], [100, 0, 0.5], [100, 100, 0.5]] });
    assert.equal(hitTestElement(stroke, { x: 75, y: 12.5 }, 1), true);
    assert.equal(hitTestElement(stroke, { x: 5, y: 90 }, 1), false);
    assert.equal(hitTestElement(ink({ points: [[8, 9, 0.5]] }), { x: 9, y: 9 }, 0), true);
});

test('rectangle and ellipse outline hits stay distinct from selecting filled interiors', () => {
    for (const type of ['rect', 'ellipse']) {
        const value = shape(type);
        assert.equal(hitTestElement(value, { x: 50, y: 50 }, 1), false);
        assert.equal(hitTestElement(value, { x: 50, y: 50 }, 1, { fill: true }), true);
        assert.equal(hitTestElement(value, { x: 50, y: 0 }, 1), true);
    }
    assert.equal(hitTestElement(shape('ellipse', { x2: 0 }), { x: 1, y: 50 }, 1), true);
});

test('translations mutate each supported coordinate representation and preserve pressure', () => {
    const stroke = ink(); translateElement(stroke, 5, -7);
    assert.deepEqual(stroke.points, [[5, -7, 0.5], [105, 93, 0.5]]);
    const line = shape(); translateElement(line, -4, 9); assert.deepEqual([line.x1, line.y1, line.x2, line.y2], [-4, 9, 96, 109]);
    const note = { type: 'note', x: 10, y: 15 }; translateElement(note, 2, 3); assert.deepEqual(note, { type: 'note', x: 12, y: 18 });
});

test('shift constraints snap lines by 45 degrees and squares preserve drag quadrant', () => {
    const start = { x: 10, y: 20 }; const end = { x: 70, y: 40 };
    assert.deepEqual(constrainShape('line', start, end, false), end);
    const line = constrainShape('arrow', start, end, true); close(line.y, start.y); close(Math.hypot(line.x - start.x, line.y - start.y), Math.hypot(60, 20));
    assert.deepEqual(constrainShape('rect', start, { x: -20, y: 30 }, true), { x: -20, y: 50 });
    assert.deepEqual(constrainShape('ellipse', start, { x: 20, y: -20 }, true), { x: 50, y: -20 });
});

test('zoom keeps the anchor world point fixed and fit respects centered bounds', () => {
    const camera = { x: 80, y: -20, zoom: 0.5 }; const anchor = { x: 630, y: 190 }; const width = 800; const height = 600;
    const result = zoomCamera(camera, 2, anchor, width, height);
    close(camera.x + (anchor.x - width / 2) / camera.zoom, result.x + (anchor.x - width / 2) / result.zoom);
    close(camera.y + (anchor.y - height / 2) / camera.zoom, result.y + (anchor.y - height / 2) / result.zoom);
    assert.equal(zoomCamera(camera, 99, anchor, width, height).zoom, 8);
    assert.deepEqual(fitCamera(null, width, height), { x: 0, y: 0, zoom: 1 });
    const fit = fitCamera({ x: 20, y: 30, width: 200, height: 100 }, width, height, 80);
    assert.deepEqual(fit, { x: 120, y: 80, zoom: 2 });
});

test('committed ink handles dots, two-point lines and isolated highlighter opacity', () => {
    const dot = recordingContext(); drawStroke(dot, ink({ points: [[4, 5, 0.5]] }));
    assert.ok(dot.calls.some(call => call[0] === 'arc' && call[1] === 4 && call[2] === 5 && call[3] === 2));
    const context = recordingContext(); drawStroke(context, ink({ tool: 'highlighter' }));
    assert.deepEqual(context.calls.find(call => call[0] === 'lineTo'), ['lineTo', 100, 100]);
    assert.deepEqual(context.calls.find(call => call[0] === 'stroke'), ['stroke', 0.28]);
    assert.equal(context.globalAlpha, 0.7);
});

test('live ink appends the exact committed quadratic prefix once and exposes only the unfinished tail', () => {
    const points = [[0, 0, 0.5], [40, 20, 0.5], [60, 80, 0.5], [100, 100, 0.5], [140, 60, 0.5]];
    const live = recordingContext(); let state = { nextIndex: 1, initialized: false, tail: null };
    for (let count = 1; count <= points.length; count++) state = paintStrokeIncrement(live, ink({ points: points.slice(0, count), tool: 'highlighter' }), state.nextIndex, state.initialized);
    const stable = live.calls.filter(call => call[0] === 'quadraticCurveTo'); const committed = recordingContext(); drawStroke(committed, ink({ points }));
    assert.deepEqual(stable, committed.calls.filter(call => call[0] === 'quadraticCurveTo'));
    assert.equal(stable.length, points.length - 2);
    assert.deepEqual(state.tail, { from: [120, 80], to: [140, 60] });
    paintStrokeIncrement(live, ink({ points }), state.nextIndex, state.initialized);
    assert.equal(live.calls.filter(call => call[0] === 'quadraticCurveTo').length, stable.length);
    assert.ok(live.calls.filter(call => call[0] === 'stroke').every(call => call[1] === 1));
    assert.equal(live.globalAlpha, 0.7);
});
