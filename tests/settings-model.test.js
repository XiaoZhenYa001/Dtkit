import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SHORTCUTS,
    findShortcutConflict,
    parseCustomMirrorConfig,
    parseStoredShortcuts,
    shortcutFromKeyboardEvent
} from '../src/views/settings/model.js';

test('shortcut storage is merged with defaults and malformed values are ignored', () => {
    assert.deepEqual(parseStoredShortcuts(null), DEFAULT_SHORTCUTS);
    assert.deepEqual(parseStoredShortcuts('{broken'), DEFAULT_SHORTCUTS);
    assert.deepEqual(parseStoredShortcuts(JSON.stringify({ toggleApp: 'Ctrl+Q', screenshot: 42 })), {
        ...DEFAULT_SHORTCUTS,
        toggleApp: 'Ctrl+Q'
    });
});

test('keyboard events produce stable shortcut labels', () => {
    assert.equal(shortcutFromKeyboardEvent({ key: 'c', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+C');
    assert.equal(shortcutFromKeyboardEvent({ key: ' ', altKey: true }), 'Alt+Space');
    assert.equal(shortcutFromKeyboardEvent({ key: 'ArrowUp', metaKey: true }), 'Win+↑');
    assert.equal(shortcutFromKeyboardEvent({ key: 'Control' }), null);
    assert.equal(shortcutFromKeyboardEvent({ key: 'Escape' }), 'Escape');
});

test('shortcut conflicts exclude the shortcut currently being edited', () => {
    const shortcuts = { first: 'Ctrl+A', second: 'Ctrl+B' };
    assert.deepEqual(findShortcutConflict(shortcuts, 'second', 'Ctrl+A'), ['first', 'Ctrl+A']);
    assert.equal(findShortcutConflict(shortcuts, 'first', 'Ctrl+A'), null);
});

test('custom mirror configuration is normalized and validated', () => {
    assert.deepEqual(parseCustomMirrorConfig('{"name":" Internal ","url":"https://mirror.example/npm","description":" Fast "}'), {
        name: 'Internal',
        url: 'https://mirror.example/npm',
        description: 'Fast'
    });
    assert.throws(() => parseCustomMirrorConfig(''), /请输入/);
    assert.throws(() => parseCustomMirrorConfig('[]'), /JSON 对象/);
    assert.throws(() => parseCustomMirrorConfig('{"name":"x"}'), /name 或 url/);
    assert.throws(() => parseCustomMirrorConfig('{"name":"x","url":"file:\/\/local"}'), /HTTP 或 HTTPS/);
});
