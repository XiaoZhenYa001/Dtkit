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

test('password detail remains metadata-only until an explicit copy or edit', () => {
    const detail = backend.match(/struct PasswordDetail \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.doesNotMatch(detail, /\bpassword\s*:/);
    assert.match(tool, /invoke\('get_password_detail'/);
    assert.match(tool, /invoke\('copy_password_field'/);
});

test('password audit is on-demand and never persisted', () => {
    assert.match(tool, /invoke\('audit_password_security'/);
    assert.match(backend, /fn audit_password_security/);
    assert.doesNotMatch(backend, /security-report\.json|audit-report\.json/);
});

test('password vault supports favorites, recent usage, urls and custom fields', () => {
    assert.match(backend, /favorite:\s*bool/);
    assert.match(backend, /last_used_at:\s*Option<i64>/);
    assert.match(backend, /custom_fields:\s*Vec<PasswordCustomField>/);
    assert.match(tool, /id="passwordUrl"/);
    assert.match(tool, /id="passwordCustomFields"/);
    assert.match(tool, /data-generator-mode="phrase"/);
});

test('password import preview identifies invalid source rows without exposing secret fields', () => {
    const issue = backend.match(/struct ImportIssue \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(issue, /source:\s*String/);
    assert.match(issue, /service:\s*String/);
    assert.match(issue, /errors:\s*Vec<String>/);
    assert.doesNotMatch(issue, /password:\s*String/);
    assert.match(tool, /passwordImportIssues/);
    assert.match(tool, /importIssueNode/);
});

test('clipboard cleanup is backend-owned and only clears the unchanged sensitive copy', () => {
    assert.match(backend, /tauri::async_runtime::spawn/);
    assert.match(backend, /GetClipboardSequenceNumber/);
    assert.match(backend, /clipboard_content_matches_ticket/);
    assert.match(backend, /if sensitive && clear_after > 0/);
    assert.match(backend, /Sha256::digest\(current_text\.as_bytes\(\)\)/);
});
