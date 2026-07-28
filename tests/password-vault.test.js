import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const tool = fs.readFileSync(new URL('../src/tools/password-vault/index.js', import.meta.url), 'utf8');
const backend = fs.readFileSync(new URL('../src-tauri/src/infrastructure/passwords.rs', import.meta.url), 'utf8');
const resources = fs.readFileSync(new URL('../src-tauri/src/infrastructure/resources.rs', import.meta.url), 'utf8');
const lifecycle = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('password quick results copy through Rust rather than navigator clipboard', () => {
    assert.match(tool, /invoke\('copy_password'/);
    assert.doesNotMatch(tool, /navigator\.clipboard/);
});

test('password list summaries do not include a password field', () => {
    const summary = backend.match(/struct PasswordSummary \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.doesNotMatch(summary, /\bpassword\s*:/);
    assert.match(summary, /\bservice\s*:/);
    assert.match(summary, /\bnote\s*:/);
});

test('password export is intentionally absent in phase one', () => {
    assert.doesNotMatch(tool, /export_password|密码导出/);
    assert.doesNotMatch(backend, /export_password/);
});

test('password search uses a native metadata-only cache and bounded responses', () => {
    assert.match(backend, /struct PasswordIndexCache/);
    assert.match(backend, /RwLock<Option<PasswordIndexCache>>/);
    assert.match(backend, /struct PasswordSearchResponse/);
    assert.match(backend, /limit:\s*Option<usize>/);
    assert.match(tool, /isQuickHost\(\)\s*\?\s*50\s*:\s*200/);
});

test('deep sleep and manual resource release drop password transient memory', () => {
    assert.match(resources, /state::<PasswordVaultManager>\(\)\.release_idle_state\(\)/);
    assert.match(lifecycle, /MinimizeMode::Deep[\s\S]{0,300}release_idle_state\(\)/);
});
