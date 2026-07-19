import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = path => readFileSync(resolve(path), 'utf8');

test('quick host is a separate minimal frontend entry', () => {
    const vite = read('vite.config.js');
    const html = read('src/quick.html');
    const script = read('src/quick/main.js');

    assert.match(vite, /quick:\s*`\$\{projectRoot\}src\/quick\.html`/);
    assert.match(html, /\.\/quick\/main\.js/);
    assert.doesNotMatch(html, /src=["']\.\/main\.js|tools\/index|alarmService/);
    assert.doesNotMatch(script, /setInterval|requestAnimationFrame|alarmService/);
    assert.match(script, /import\('\.\.\/tools\/index\.js'\)/);
    assert.match(script, /runtime\.loadTool\(target\.toolId\)/);
    assert.match(script, /search_local_files/);
    assert.match(script, /create_quick_countdown/);
});

test('quick host capability follows least privilege', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/quick-host.json'));

    assert.deepEqual(capability.windows, ['quick-host']);
    assert.ok(capability.permissions.includes('core:event:default'));
    assert.ok(capability.permissions.includes('core:window:allow-start-dragging'));
    assert.ok(!capability.permissions.some(permission => /fs|shell|global-shortcut/.test(permission)));
});

test('native shortcut registry starts empty and targets the single quick host', () => {
    const shortcuts = read('src-tauri/src/infrastructure/shortcuts.rs');
    const quickHost = read('src-tauri/src/infrastructure/quick_host.rs');

    assert.match(shortcuts, /derive\(Default\)[\s\S]*ShortcutRegistry/);
    assert.match(shortcuts, /no_shortcuts_are_bound_by_default/);
    assert.doesNotMatch(shortcuts, /with_shortcut|register\("/);
    assert.match(quickHost, /const QUICK_HOST_LABEL: &str = "quick-host"/);
    assert.match(quickHost, /get_webview_window\(QUICK_HOST_LABEL\)/);
});

test('portable storage and resource policy have explicit managed boundaries', () => {
    const storage = read('src-tauri/src/infrastructure/storage.rs');
    const resources = read('src-tauri/src/infrastructure/resources.rs');

    assert.match(storage, /const PORTABLE_MARKER: &str = "portable\.json"/);
    assert.match(storage, /temp-transfer/);
    assert.match(storage, /recovery/);
    assert.match(storage, /warning: Option<String>/);
    assert.match(resources, /max_workers_on_battery: 2/);
    assert.match(resources, /cache_limit_bytes: 100 \* 1024 \* 1024/);
    assert.match(resources, /RESOURCE_POLICY_FILE: &str = "resource-policy\.json"/);
});
