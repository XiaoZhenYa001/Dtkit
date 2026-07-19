import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

globalThis.window = {};
const { formatBytes } = await import('../src/views/settings/cleanup.js');

test('cleanup usage formatting stays compact and deterministic', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.50 KB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10.0 MB');
});

test('automatic cleanup is startup-gated without a frontend polling timer', () => {
    const rust = readFileSync(resolve('src-tauri/src/infrastructure/cleanup.rs'), 'utf8');
    const frontend = readFileSync(resolve('src/views/settings/cleanup.js'), 'utf8');

    assert.match(rust, /AUTO_CLEANUP_INTERVAL_SECONDS/);
    assert.match(rust, /schedule_automatic_cleanup/);
    assert.doesNotMatch(frontend, /setInterval|setTimeout/);
});

test('permanent cleanup requires a danger confirmation in the UI', () => {
    const frontend = readFileSync(resolve('src/views/settings/cleanup.js'), 'utf8');
    assert.match(frontend, /确认彻底删除/);
    assert.match(frontend, /danger: true/);
    assert.match(frontend, /永久删除/);
});
