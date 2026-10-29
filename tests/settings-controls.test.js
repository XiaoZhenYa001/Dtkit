import assert from 'node:assert/strict';
import test from 'node:test';

import { getMinimizeMode, setMinimizeMode } from '../src/core/minimizeMode.js';

const stored = new Map();
const events = [];
const calls = [];
const pending = [];
globalThis.localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value)
};
globalThis.window = {
    dispatchEvent: event => events.push(event.detail.mode),
    __TAURI__: { core: { invoke: (command, args) => {
        calls.push({ command, args });
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } } }
};
const key = 'dtkit_minimize_mode';
const tick = () => Promise.resolve();

function reset(mode = 'efficient') {
    stored.set(key, mode); events.length = 0; calls.length = 0; pending.length = 0;
    assert.equal(getMinimizeMode(), mode);
}

test('resource strategy commits storage and change notification only after native success', async () => {
    reset();
    const save = setMinimizeMode('deep');
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { command: 'set_minimize_mode', args: { mode: 'deep' } });
    assert.equal(getMinimizeMode(), 'efficient');
    assert.equal(stored.get(key), 'efficient');
    assert.deepEqual(events, []);
    pending.shift().resolve();
    assert.equal(await save, 'deep');
    assert.equal(getMinimizeMode(), 'deep');
    assert.equal(stored.get(key), 'deep');
    assert.deepEqual(events, ['deep']);
});

test('a rejected strategy change leaves the confirmed state intact', async () => {
    reset();
    const save = setMinimizeMode('standard');
    await tick();
    const rejected = assert.rejects(save, /fixture failure/);
    pending.shift().reject(new Error('fixture failure'));
    await rejected;
    assert.equal(getMinimizeMode(), 'efficient');
    assert.equal(stored.get(key), 'efficient');
    assert.deepEqual(events, []);
});

test('native changes serialize in user order and a failed request does not poison later saves', async () => {
    reset('standard');
    const first = setMinimizeMode('deep');
    const second = setMinimizeMode('efficient');
    await tick();
    assert.equal(calls.length, 1);
    const rejected = assert.rejects(first, /first failed/);
    pending.shift().reject(new Error('first failed'));
    await rejected;
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.mode, 'efficient');
    assert.equal(getMinimizeMode(), 'standard');
    pending.shift().resolve();
    assert.equal(await second, 'efficient');
    assert.equal(getMinimizeMode(), 'efficient');
    assert.deepEqual(events, ['efficient']);
});

test('a browser-storage failure does not roll back an already confirmed native setting', async () => {
    reset();
    const write = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('storage is unavailable'); };
    try {
        const save = setMinimizeMode('deep');
        await tick(); pending.shift().resolve();
        assert.equal(await save, 'deep');
        assert.equal(getMinimizeMode(), 'deep');
        assert.deepEqual(events, ['deep']);
    } finally { localStorage.setItem = write; }
});
