import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeShelves, transferShelfGroup, shelfPanelRect, shelfDockPreview, shelfOrientation } from '../src/desktop-organizer/shelf-model.js';

test('saved groups occur exactly once and newly scanned groups remain accessible', () => {
    const next = normalizeShelves([{ id: 'a', keys: ['document', 'document'], x: NaN }, { id: 'a', keys: ['document', 'image'] }], ['document', 'image', 'program']);
    assert.deepEqual(next.flatMap(s => s.keys), ['document', 'program', 'image']);
    assert.notEqual(next[0].id, next[1].id);
    assert.equal(next[0].x, .5);
});
test('splitting and merging changes presentation only and preserves group membership', () => {
    const initial = normalizeShelves([], ['document', 'image', 'program']);
    const split = transferShelfGroup(initial, 'image', '', null, { id: 'second', x: .2 });
    assert.deepEqual(split.map(s => s.keys), [['document', 'program'], ['image']]);
    const merge = transferShelfGroup(split, 'image', initial[0].id, 'program');
    assert.deepEqual(merge.map(s => s.keys), [['document', 'image', 'program']]);
    assert.deepEqual(initial[0].keys, ['document', 'image', 'program']);
});
test('reordering a tab into its own slot is a no-op', () => {
    const initial = normalizeShelves([], ['a', 'b', 'c']);
    assert.equal(transferShelfGroup(initial, 'b', initial[0].id, 'b'), initial);
    assert.deepEqual(transferShelfGroup(initial, 'c', initial[0].id, 'a')[0].keys, ['c', 'a', 'b']);
});
test('edge docking respects manual orientation and previews near boundaries', () => {
    assert.equal(shelfOrientation({ orientation: 'auto', dock: 'left' }), 'vertical');
    assert.equal(shelfOrientation({ orientation: 'horizontal', dock: 'left' }), 'horizontal');
    const area = { x: 100, y: 0, width: 1200, height: 800 };
    assert.equal(shelfDockPreview({ x: 116, y: 300 }, { width: 170, height: 70 }, area), 'left');
    assert.equal(shelfDockPreview({ x: 500, y: 300 }, { width: 170, height: 70 }, area), 'free');
});
test('all dock placements open inside their own display work area', () => {
    const area = { x: 1920, y: 120, width: 1280, height: 720 };
    for (const [dock, rail] of Object.entries({
        left: { x: 1936, y: 300, width: 176, height: 260 }, right: { x: 3008, y: 300, width: 176, height: 260 },
        top: { x: 2200, y: 136, width: 650, height: 66 }, bottom: { x: 2200, y: 758, width: 650, height: 66 }
    })) {
        const result = shelfPanelRect(rail, { width: 420, height: 340 }, area, ['left', 'right'].includes(dock) ? 'vertical' : 'horizontal', dock);
        assert.ok(result.x >= area.x + 16 && result.y >= area.y + 16);
        assert.ok(result.x + result.width <= area.x + area.width - 16 && result.y + result.height <= area.y + area.height - 16);
        assert.equal(result.direction, { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[dock]);
    }
});
test('a free shelf keeps the requested panel size when another side has sufficient room', () => {
    const result = shelfPanelRect({ x: 500, y: 535, width: 440, height: 66 }, { width: 420, height: 340 }, { x: 0, y: 0, width: 1536, height: 816 });
    assert.equal(result.direction, 'top');
    assert.equal(result.height, 340);
});
