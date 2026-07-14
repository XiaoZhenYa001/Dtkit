import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeAttribute, escapeHtml } from '../src/core/html.js';

test('escapeHtml neutralizes markup and inline event payloads', () => {
    const payload = `<img src=x onerror="window.__TAURI__.core.invoke('run_program')">`;
    assert.equal(
        escapeHtml(payload),
        '&lt;img src=x onerror=&quot;window.__TAURI__.core.invoke(&#39;run_program&#39;)&quot;&gt;'
    );
});

test('escapeAttribute protects double-quoted data attributes', () => {
    assert.equal(
        escapeAttribute(`https://example.test/" autofocus onfocus="alert(1)`),
        'https://example.test/&quot; autofocus onfocus=&quot;alert(1)'
    );
});

test('escaping handles nullish and non-string values', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(42), '42');
});
