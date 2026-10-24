import test from 'node:test';
import assert from 'node:assert/strict';
import { clientToPixel, pixelToClient, stepPixel, magnifierPosition } from '../src/color-pick/model.js';

test('overlay samples physical screenshot pixels under fractional display scaling', () => {
    const rect = { left: 12, top: 18, width: 640, height: 400 };
    assert.deepEqual(clientToPixel({ x: 332, y: 218 }, rect, 960, 600), { x: 480, y: 300 });
    const selected = { x: 481, y: 301 };
    assert.deepEqual(clientToPixel(pixelToClient(selected, rect, 960, 600), rect, 960, 600), selected);
});

test('out of bounds cursor coordinates clamp to valid screenshot pixels', () => {
    const rect = { left: 0, top: 0, width: 640, height: 400 };
    assert.deepEqual(clientToPixel({ x: -100, y: -50 }, rect, 960, 600), { x: 0, y: 0 });
    assert.deepEqual(clientToPixel({ x: 640, y: 500 }, rect, 960, 600), { x: 959, y: 599 });
});

test('keyboard precision moves one physical pixel or ten with Shift', () => {
    let point = stepPixel({ x: 480, y: 300 }, 'ArrowRight', 1, 960, 600);
    assert.deepEqual(point, { x: 481, y: 300 });
    point = stepPixel(point, 'ArrowDown', 10, 960, 600);
    assert.deepEqual(point, { x: 481, y: 310 });
    assert.deepEqual(stepPixel({ x: 0, y: 0 }, 'ArrowLeft', 10, 960, 600), { x: 0, y: 0 });
    assert.deepEqual(stepPixel({ x: 959, y: 599 }, 'ArrowDown', 10, 960, 600), { x: 959, y: 599 });
});

test('magnifier flips away from desktop edges and fits small viewports', () => {
    const result = magnifierPosition({ x: 635, y: 395 }, 640, 400, 156, 220);
    assert.ok(result.x >= 8 && result.x + 156 <= 632);
    assert.ok(result.y >= 8 && result.y + 220 <= 392);
    assert.deepEqual(magnifierPosition({ x: 0, y: 0 }, 100, 100, 156, 220), { x: 8, y: 8 });
});
