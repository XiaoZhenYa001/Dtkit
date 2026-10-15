import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionGate } from '../src/desktop-organizer/presentation-controller.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('ending a native window drag cannot dismiss a still-open editor or file drag', async () => {
    const calls = [], window = {};
    const gate = createInteractionGate({ window, invoke: async (_, args) => calls.push(args.interacting) });
    gate.set('window', true); await flush();
    gate.set('editor', true); gate.set('window', false); await flush();
    assert.equal(window.__userInteracting, true);
    assert.deepEqual(calls, [true]);
    gate.set('file-drag', true); gate.set('editor', false); await flush();
    assert.equal(window.__userInteracting, true);
    gate.set('file-drag', false); await flush();
    assert.deepEqual(calls, [true, false]);
});
test('opening another interaction in the same event turn never briefly releases the hotzone', async () => {
    const calls = [], window = {};
    const gate = createInteractionGate({ window, invoke: async (_, args) => calls.push(args.interacting) });
    gate.set('menu', true); await flush();
    gate.set('menu', false); gate.set('editor', true); await flush();
    assert.deepEqual(calls, [true]);
    gate.clear(); await flush();
    assert.deepEqual(calls, [true, false]);
});
test('native notifications finish in order and a failed command cannot block later cleanup', async () => {
    const calls = [], window = {};
    let release;
    const gate = createInteractionGate({ window, invoke: async (_, args) => {
        calls.push(args.interacting);
        if (args.interacting) await new Promise(resolve => { release = resolve; });
        if (args.interacting) throw new Error('window was recreated');
    } });
    gate.set('file-drag', true); await flush();
    gate.clear(); await flush();
    assert.deepEqual(calls, [true]);
    release(); await flush();
    assert.deepEqual(calls, [true, false]);
    assert.equal(window.__userInteracting, false);
});
