import assert from 'node:assert/strict';
import test from 'node:test';

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
