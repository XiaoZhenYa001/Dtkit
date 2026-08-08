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
    assert.match(html, /id="quickMaximize"/);
    assert.match(html, /id="quickPin"/);
    assert.doesNotMatch(html, /src=["']\.\/main\.js|tools\/index|alarmService/);
    assert.doesNotMatch(script, /setInterval|requestAnimationFrame|alarmService/);
    assert.match(script, /import\('\.\.\/tools\/index\.js'\)/);
    assert.match(script, /runtime\.loadTool\(target\.toolId\)/);
    assert.match(script, /search_local_files/);
    assert.match(script, /create_quick_countdown/);
    assert.match(script, /schedulePaletteIdleDismiss/);
    assert.match(read('src-tauri/src/infrastructure/quick_host.rs'), /PALETTE_IDLE_TIMEOUT_SECONDS: u64 = 180/);
});

test('quick host capability follows least privilege', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/quick-host.json'));

    assert.deepEqual(capability.windows, ['quick-host-*']);
    assert.ok(capability.permissions.includes('core:event:default'));
    assert.ok(capability.permissions.includes('core:window:allow-start-dragging'));
    assert.ok(capability.permissions.includes('core:window:allow-toggle-maximize'));
    assert.ok(capability.permissions.includes('core:window:allow-minimize'));
    assert.ok(capability.permissions.includes('core:window:allow-set-always-on-top'));
    assert.ok(!capability.permissions.some(permission => /fs|shell|global-shortcut/.test(permission)));
});

test('screen region selector is an isolated ephemeral frontend entry', () => {
    const vite = read('vite.config.js');
    const html = read('src/screen-region.html');
    const capability = JSON.parse(read('src-tauri/capabilities/screen-region-overlay.json'));

    assert.match(vite, /screenRegion:\s*`\$\{projectRoot\}src\/screen-region\.html`/);
    assert.match(html, /\.\/screen-region\/main\.js/);
    assert.deepEqual(capability.windows, ['screen-region-overlay-*']);
    assert.ok(!capability.permissions.some(permission => /fs|shell|global-shortcut/.test(permission)));
});

test('native shortcut registry starts empty and creates independent quick hosts', () => {
    const shortcuts = read('src-tauri/src/infrastructure/shortcuts.rs');
    const quickHost = read('src-tauri/src/infrastructure/quick_host.rs');

    assert.match(shortcuts, /derive\(Default\)[\s\S]*ShortcutRegistry/);
    assert.match(shortcuts, /no_shortcuts_are_bound_by_default/);
    assert.doesNotMatch(shortcuts, /with_shortcut|register\("/);
    assert.match(quickHost, /const QUICK_HOST_LABEL_PREFIX: &str = "quick-host-"/);
    assert.match(quickHost, /next_label\.fetch_add/);
    assert.doesNotMatch(quickHost, /get_webview_window\(QUICK_HOST_LABEL\)/);
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
    assert.match(scanner, /FOLDER_BROWSE_LIMIT: usize = 200/);
    assert.match(scanner, /SEARCH_RESULT_LIMIT: usize = 200/);
    assert.match(scanner, /PROGRAM_ICON_CACHE_LIMIT: usize = 96/);
    assert.match(scanner, /cached_program_icon/);
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
    assert.match(organizerUi, /visibilitychange[\s\S]*LIVE_RESCAN_INTERVAL_MS[\s\S]*loadDesktopFiles/);
    assert.match(organizerUi, /rebuildSearchIndex/);
    assert.doesNotMatch(organizerUi, /invoke\('desktop_search'/);
    assert.doesNotMatch(organizerUi, /setInterval\s*\(/);
});

test('desktop folders are scanned on demand instead of during the top-level scan', () => {
    const commands = read('src-tauri/src/desktop/commands.rs');
    const scanner = read('src-tauri/src/desktop/scanner.rs');
    const organizerUi = read('src/desktop-organizer/main.js');

    assert.match(scanner, /FOLDER_BROWSE_LIMIT: usize = 200/);
    assert.doesNotMatch(scanner, /scan_file_info\(&path, true\)/);
    assert.doesNotMatch(scanner, /scan_folder_children/);
    assert.match(commands, /desktop_list_folder/);
    assert.match(organizerUi, /invoke\('desktop_list_folder'/);
    assert.match(organizerUi, /FOLDER_CACHE_LIMIT = 8/);
    assert.match(organizerUi, /folder-browser/);
    assert.doesNotMatch(organizerUi, /renderFolderChildren/);
});

test('tool shortcuts are mounted from tool metadata instead of a centralized tool list', () => {
    const registry = read('src/tools/toolRegistry.js');
    const settings = read('src/views/settings/shortcuts.js');

    assert.match(registry, /mountShortcutBinding/);
    assert.match(registry, /target: \{ kind: 'tool', toolId \}/);
    assert.doesNotMatch(settings, /timestamp-converter|json-formatter|transfer-station/);
    assert.match(settings, /target: \{ kind: 'palette' \}/);
});

test('whiteboard shortcut opens as an immersive quick canvas', () => {
    const quickHost = read('src-tauri/src/infrastructure/quick_host.rs');
    const quickScript = read('src/quick/main.js');
    const quickStyle = read('src/quick/style.css');
    const whiteboardStyle = read('src/css/tools/whiteboard.css');

    assert.match(quickHost, /\| "whiteboard"/);
    assert.match(quickScript, /quick-shell--whiteboard/);
    assert.match(quickStyle, /\.quick-shell--whiteboard[\s\S]*grid-template-rows:\s*1fr/);
    assert.match(whiteboardStyle, /quick-tool--whiteboard[\s\S]*\.whiteboard-hero[\s\S]*display:\s*none/);
});

test('whiteboard persistence is rooted in managed storage and remains idle when unchanged', () => {
    const frontend = read('src/tools/whiteboard/index.js');
    const backend = read('src-tauri/src/infrastructure/whiteboard.rs');
    const storage = read('src-tauri/src/infrastructure/storage.rs');

    assert.match(frontend, /DRAFT_DELAY_MS = 60_000/);
    assert.doesNotMatch(frontend, /setInterval\s*\(/);
    assert.match(frontend, /save_whiteboard_draft/);
    assert.match(frontend, /list_whiteboards/);
    assert.match(frontend, /thumbnailDataUrl/);
    assert.match(frontend, /getCoalescedEvents/);
    assert.match(frontend, /committedCanvas/);
    assert.doesNotMatch(frontend, /state\.elements\.reduce\([\s\S]*totalPoints/);
    assert.match(backend, /\.whiteboards/);
    assert.match(backend, /atomic_write/);
    assert.match(storage, /root\.join\("Kits"\)\.join\("Whiteboards"\)/);
});

test('storage migration verifies a staged copy before changing the root pointer', () => {
    const storage = read('src-tauri/src/infrastructure/storage.rs');

    assert.match(storage, /\.dtkit-migration-/);
    assert.match(storage, /staged_bytes != bytes_copied/);
    assert.match(storage, /verify_copied_file\(&source_path, &destination\)/);
    assert.match(storage, /file_sha256\(source\)\? != file_sha256\(destination\)\?/);
    assert.match(storage, /write_root_pointer\(bootstrap_file, &layout\.root\)/);
    assert.match(storage, /target\.starts_with\(source\) \|\| source\.starts_with\(target\)/);
    assert.doesNotMatch(storage, /has_active_downloads/);
    assert.match(storage, /has_active_share/);
});
