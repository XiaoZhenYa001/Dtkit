import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = {};

const { createNewTabConfig } = await import('../src/core/state.js');

test('multiple pages created within the same millisecond have distinct identities', () => {
    const originalNow = Date.now;
    Date.now = () => 123456789;
    try {
        const pages = Array.from({ length: 32 }, () => createNewTabConfig());
        assert.equal(new Set(pages.map(page => page.id)).size, pages.length);
    } finally {
        Date.now = originalNow;
    }
});

test('each page owns its navigation history and mutations cannot leak to another page', () => {
    const first = createNewTabConfig();
    const second = createNewTabConfig();
    first.toolId = 'html-preview';
    first.history[0].scrollTop = 250;
    first.history.push({ toolId: 'html-preview', viewType: 'toolLibrary', instanceId: 'first-preview' });
    first.historyIndex = 1;

    assert.equal(second.toolId, null);
    assert.equal(second.historyIndex, 0);
    assert.deepEqual(second.history, [{ toolId: null, viewType: 'toolLibrary' }]);
    assert.notEqual(first.history, second.history);
    assert.notEqual(first.history[0], second.history[0]);
});
