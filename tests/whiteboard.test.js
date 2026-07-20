import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_POINTS,
    MAX_STROKES,
    compactStrokes,
    deserializeBoard,
    normalizePoint,
    serializeBoard
} from '../src/tools/whiteboard/core.js';

const stroke = (id, pointCount = 2) => ({
    id,
    tool: 'pen',
    color: '#242937',
    width: 4,
    points: Array.from({ length: pointCount }, (_, index) => [index / Math.max(pointCount - 1, 1), 0.5, 0.5])
});

test('whiteboard points are normalized and bounded independently of canvas size', () => {
    assert.deepEqual(normalizePoint(50, 25, 100, 50, 0.75), [0.5, 0.5, 0.75]);
    assert.deepEqual(normalizePoint(-10, 90, 100, 50, 2), [0, 1, 1]);
});

test('whiteboard history keeps the newest bounded strokes and points', () => {
    const strokes = Array.from({ length: MAX_STROKES + 5 }, (_, index) => stroke(index, 2));
    const compacted = compactStrokes(strokes);

    assert.equal(compacted.length, MAX_STROKES);
    assert.equal(compacted[0].id, 5);
    assert.ok(compacted.reduce((total, item) => total + item.points.length, 0) <= MAX_POINTS);
});

test('whiteboard storage validates malformed data and round-trips safe strokes', () => {
    const serialized = serializeBoard([stroke('safe')], true);
    assert.deepEqual(deserializeBoard(serialized), {
        strokes: [stroke('safe')],
        gridEnabled: true
    });
    assert.deepEqual(deserializeBoard('{broken'), { strokes: [], gridEnabled: true });
    assert.deepEqual(deserializeBoard(JSON.stringify({ version: 99, strokes: [] })), { strokes: [], gridEnabled: true });
});
