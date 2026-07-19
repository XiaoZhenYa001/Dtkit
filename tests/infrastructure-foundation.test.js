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

test('desktop organizer bounds file access and avoids expensive unbounded scans', () => {
    const commands = read('src-tauri/src/desktop/commands.rs');
    const scanner = read('src-tauri/src/desktop/scanner.rs');
    const hotzone = read('src-tauri/src/desktop/hotzone.rs');
    const nativeWindow = read('src-tauri/src/lib.rs');
    const organizerUi = read('src/desktop-organizer/main.js');

    assert.match(commands, /validated_desktop_entry/);
    assert.match(commands, /validate_leaf_filename/);
    assert.match(commands, /spawn_blocking/);
    assert.match(scanner, /FOLDER_PREVIEW_LIMIT: usize = 5/);
    assert.match(scanner, /SEARCH_RESULT_LIMIT: usize = 200/);
    assert.match(hotzone, /compare_exchange\(false, true/);
    assert.match(hotzone, /if is_panel_visible \{\s*100\s*\} else \{\s*250/);
    assert.doesNotMatch(nativeWindow, /\.position\(1350\.0/);
    assert.match(nativeWindow, /fn fit_window_rect/);
    assert.match(nativeWindow, /clamp_desktop_organizer_window/);
    assert.match(commands, /pub x: i32/);
    assert.match(commands, /pub y: i32/);
    assert.match(organizerUi, /invoke\('clamp_desktop_organizer_window'\)/);
    assert.match(organizerUi, /screenBounds\.x/);
    assert.match(organizerUi, /screenBounds\.y/);
});

test('tool shortcuts are mounted from tool metadata instead of a centralized tool list', () => {
    const registry = read('src/tools/toolRegistry.js');
    const settings = read('src/views/settings/shortcuts.js');

    assert.match(registry, /mountShortcutBinding/);
    assert.match(registry, /target: \{ kind: 'tool', toolId \}/);
    assert.doesNotMatch(settings, /timestamp-converter|json-formatter|transfer-station/);
    assert.match(settings, /target: \{ kind: 'palette' \}/);
});
