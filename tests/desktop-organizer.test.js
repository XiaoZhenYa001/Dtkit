import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildSearchIndex, querySearchIndex } from '../src/desktop-organizer/search.js';
import { createDesktopOrganizerState } from '../src/desktop-organizer/store.js';
import { filesForCategory, renderCategoryListMarkup } from '../src/desktop-organizer/views/category-view.js';

function createLocalStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

async function importFreshModule(testName) {
    const url = new URL('../src/core/desktopOrganizer.js', import.meta.url);
    url.searchParams.set('test', testName);
    return import(url.href);
}

test('desktop organizer settings use safe defaults for malformed storage', async t => {
    globalThis.localStorage = createLocalStorage({ dtkit_desktop_organizer: '{bad json' });
    const originalConsoleError = console.error;
    console.error = () => {};
    t.after(() => {
        console.error = originalConsoleError;
    });
    const module = await importFreshModule('malformed');

    assert.deepEqual(module.getDesktopOrganizerSettings(), {
        enabled: false,
        autoAnalyze: false
    });
});

test('desktop organizer bootstrap coalesces concurrent monitor starts', async () => {
    globalThis.localStorage = createLocalStorage({
        dtkit_desktop_organizer: JSON.stringify({ enabled: true, autoAnalyze: true })
    });
    const commands = [];
    globalThis.window = {
        __TAURI__: {
            core: {
                invoke: async command => {
                    commands.push(command);
                }
            }
        }
    };
    const module = await importFreshModule('coalesced');

    const results = await Promise.all([
        module.bootstrapDesktopOrganizer(),
        module.bootstrapDesktopOrganizer()
    ]);

    assert.deepEqual(results, [true, true]);
    assert.deepEqual(commands, ['start_hotzone_monitor']);

    await module.stopDesktopOrganizerMonitor();
    assert.deepEqual(commands, ['start_hotzone_monitor', 'stop_hotzone']);
});

test('desktop organizer native hotzone remains available while the main webview is suspended', async () => {
    const source = await readFile(new URL('../src/core/desktopOrganizer.js', import.meta.url), 'utf8');
    const lifecycle = source.match(/addEventListener\('dtkit:power-state'[\s\S]*?\n\s*\}\);/)?.[0] || '';
    assert.doesNotMatch(lifecycle, /stopDesktopOrganizerMonitor/);
    assert.match(lifecycle, /startDesktopOrganizerMonitor/);
});

test('desktop organizer enablement is persisted only after the native monitor starts', async () => {
    globalThis.localStorage = createLocalStorage({
        dtkit_desktop_organizer: JSON.stringify({ enabled: false, autoAnalyze: false })
    });
    globalThis.window = {
        __TAURI__: {
            core: {
                invoke: async command => {
                    if (command === 'start_hotzone_monitor') throw new Error('native start failed');
                }
            }
        }
    };
    const module = await importFreshModule('transactional-enable');

    await assert.rejects(() => module.setDesktopOrganizerEnabled(true), /native start failed/);
    assert.equal(module.getDesktopOrganizerSettings().enabled, false);
});

test('unfinished desktop analysis is visibly marked unavailable', async () => {
    const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
    const control = html.match(/<div class="settings-toggle-item sub-item">[\s\S]*?desktopAutoAnalyzeToggle[\s\S]*?<\/div>/)?.[0] || '';

    assert.match(control, /开发中/);
    assert.match(control, /desktopAutoAnalyzeToggle"[^>]*disabled/);

    globalThis.localStorage = createLocalStorage({
        dtkit_desktop_organizer: JSON.stringify({ enabled: false, autoAnalyze: true })
    });
    const module = await importFreshModule('dormant-analysis');
    assert.equal(module.getDesktopOrganizerSettings().autoAnalyze, false);
});

test('desktop app manager uses the cached index until the user explicitly refreshes', async () => {
    const source = await readFile(new URL('../src/tools/desktop-app-manager/index.js', import.meta.url), 'utf8');
    const init = source.match(/function init\(\)[\s\S]*?\n\}/)?.[0] || '';

    assert.match(init, /\n\s*loadApps\(\);\n\}/);
    assert.doesNotMatch(init, /\n\s*loadApps\(true\);\n\}/);
    assert.match(init, /appManagerRefresh[\s\S]*?loadApps\(true\)/);
});

test('application edits notify the open desktop organizer to refresh immediately', async () => {
    const commands = await readFile(new URL('../src-tauri/src/desktop/commands.rs', import.meta.url), 'utf8');
    const organizer = await readFile(new URL('../src/desktop-organizer/main.js', import.meta.url), 'utf8');

    assert.match(commands, /desktop_save_app[\s\S]*?desktop-app-index-changed/);
    assert.match(commands, /desktop_reset_app[\s\S]*?desktop-app-index-changed/);
    assert.match(organizer, /listen\(['"]desktop-app-index-changed['"][\s\S]*?loadDesktopFiles/);
});

test('desktop organizer UI smoke is part of the standard npm test command', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.match(manifest.scripts['test:ui'] || '', /desktop-organizer-refactor-ui-smoke\.py/);
    assert.match(manifest.scripts.test, /test:ui/);
});

test('desktop organizer state instances do not share mutable collections', () => {
    const first = createDesktopOrganizerState();
    const second = createDesktopOrganizerState();

    first.expandedCategories.add('program');
    first.folderView.stack.push({ path: 'C:\\One', name: 'One' });

    assert.deepEqual([...second.expandedCategories], ['recent']);
    assert.deepEqual(second.folderView.stack, []);
});

test('desktop search keeps the preferred app entry and supports command filters', () => {
    const manualSteam = { name: 'Steam', path: 'C:\\Steam.lnk', category: 'program', app_id: 'steam', app_manual: true };
    const duplicateSteam = { name: 'Steam.exe', path: 'C:\\Steam.exe', category: 'program' };
    const image = { name: 'Steam Logo.png', path: 'C:\\Steam Logo.png', category: 'image' };
    const index = buildSearchIndex({ applications: [manualSteam], programs: [duplicateSteam], images: [image] });

    assert.deepEqual(querySearchIndex(index, 'steam').map(file => file.path), [manualSteam.path, image.path]);
    assert.deepEqual(querySearchIndex(index, '/a steam').map(file => file.path), [manualSteam.path]);
});

test('category view routes applications into every visible custom category', () => {
    const state = createDesktopOrganizerState();
    const steam = { name: 'Steam', path: 'C:\\Steam.lnk', category: 'program', app_id: 'steam', app_category: '游戏' };
    state.files = { applications: [steam], recent: [], documents: [], images: [], videos: [], audios: [], archives: [], programs: [], folders: [], others: [], total_count: 1 };
    state.customCategories = [{ key: 'custom_1', name: '游戏', icon: '🎮' }];
    state.searchIndex = buildSearchIndex(state.files);

    assert.deepEqual(filesForCategory(state, 'custom_1'), [steam]);
    assert.match(renderCategoryListMarkup(state), /<span class="category-name">游戏<\/span><span class="category-count">1<\/span>/);
});
