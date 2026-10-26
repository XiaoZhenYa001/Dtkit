import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'dtkit_desktop_organizer';

function installEnvironment(t, initial = {}, { emit, setItem } = {}) {
    const previous = {
        localStorage: globalThis.localStorage,
        window: globalThis.window,
        CustomEvent: globalThis.CustomEvent
    };
    const values = new Map(Object.entries(initial));
    const localEvents = [];
    const nativeCommands = [];
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    };
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: setItem ?? ((key, value) => values.set(key, String(value)))
    };
    globalThis.window = {
        dispatchEvent: event => localEvents.push(event),
        __TAURI__: {
            core: { invoke: async command => nativeCommands.push(command) },
            event: emit ? { emit } : {}
        }
    };
    t.after(() => Object.assign(globalThis, previous));
    return { values, localEvents, nativeCommands };
}

async function freshModule(name) {
    const url = new URL('../src/core/desktopOrganizer.js', import.meta.url);
    url.searchParams.set('presentation-test', name);
    return import(url.href);
}

test('old settings retain classic presentation and monitor behavior until the user chooses otherwise', async t => {
    const environment = installEnvironment(t, {
        [STORAGE_KEY]: JSON.stringify({ enabled: true, autoAnalyze: false })
    });
    const module = await freshModule('legacy');
    assert.deepEqual(module.normalizeDesktopOrganizerPresentation(module.getDesktopOrganizerSettings()), {
        presentation: 'classic', reducedMotion: false
    });
    assert.equal(await module.bootstrapDesktopOrganizer(), true);
    assert.deepEqual(environment.nativeCommands, ['get_desktop_organizer_mode', 'set_desktop_organizer_mode']);
});

test('invalid stored presentation values cannot escape the supported choices', async t => {
    installEnvironment(t, {
        [STORAGE_KEY]: JSON.stringify({
            enabled: false, presentation: 'unknown', layout: 'shelves', appearance: 'dark', reducedMotion: 'false'
        })
    });
    const module = await freshModule('validation');
    const defaults = { presentation: 'classic', reducedMotion: false };
    assert.deepEqual(module.normalizeDesktopOrganizerPresentation(null), defaults);
    assert.deepEqual(module.normalizeDesktopOrganizerPresentation(module.getDesktopOrganizerSettings()), defaults);
});

test('choosing desktop space persists preferences and notifies both the local and open native view', async t => {
    const nativeEvents = [];
    const environment = installEnvironment(t, {
        [STORAGE_KEY]: JSON.stringify({ enabled: false, autoAnalyze: false })
    }, {
        emit: async (name, payload) => nativeEvents.push({ name, payload })
    });
    const module = await freshModule('events');
    const preferences = await module.updateDesktopOrganizerPresentation({
        presentation: 'space', layout: 'zones', appearance: 'liquid', reducedMotion: true
    });
    assert.deepEqual(preferences, { presentation: 'space', reducedMotion: true });
    assert.deepEqual(JSON.parse(environment.values.get(STORAGE_KEY)), {
        enabled: false, autoAnalyze: false, ...preferences
    });
    assert.deepEqual(nativeEvents, [{ name: 'desktop-organizer-presentation-changed', payload: { preferences } }]);
    const presentationEvents = environment.localEvents.filter(event => event.type === 'dtkit:desktop-organizer-presentation-changed');
    assert.equal(presentationEvents.length, 1);
    assert.deepEqual(presentationEvents[0].detail, { preferences });
    assert.ok(environment.localEvents.some(event => event.type === 'dtkit:shortcut-bindings-changed'));
    assert.deepEqual(environment.nativeCommands, ['set_desktop_organizer_mode'], 'top-level choices persist the mutually exclusive native mode');
});

test('saving supported preferences retires old layouts and materials while preserving enablement and future settings', async t => {
    const environment = installEnvironment(t, {
        [STORAGE_KEY]: JSON.stringify({
            enabled: true, autoAnalyze: false, presentation: 'space', layout: 'drawer',
            appearance: 'warm', reducedMotion: true, futurePreference: 'keep'
        })
    });
    const module = await freshModule('partial');
    await module.updateDesktopOrganizerPresentation({ reducedMotion: false, appearance: 'liquid', enabled: false, autoAnalyze: true });
    assert.deepEqual(JSON.parse(environment.values.get(STORAGE_KEY)), {
        enabled: true, autoAnalyze: false, presentation: 'space', reducedMotion: false, futurePreference: 'keep'
    });
});

test('rapid selections persist their final value and carry complete preference payloads', async t => {
    const environment = installEnvironment(t);
    const module = await freshModule('rapid');
    await Promise.all([
        module.updateDesktopOrganizerPresentation({ presentation: 'space' }),
        module.updateDesktopOrganizerPresentation({ reducedMotion: true }),
        module.updateDesktopOrganizerPresentation({ reducedMotion: false }),
        module.updateDesktopOrganizerPresentation({ reducedMotion: true })
    ]);
    assert.deepEqual(module.normalizeDesktopOrganizerPresentation(module.getDesktopOrganizerSettings()), {
        presentation: 'space', reducedMotion: true
    });
    assert.deepEqual(environment.localEvents.at(-1).detail.preferences, {
        presentation: 'space', reducedMotion: true
    });
});

test('failed persistence does not announce a preference the next window cannot load', async t => {
    const environment = installEnvironment(t, {}, {
        setItem: () => { throw new Error('storage full'); }
    });
    const module = await freshModule('failed-save');
    await assert.rejects(module.updateDesktopOrganizerPresentation({ presentation: 'space' }), /storage full/);
    assert.deepEqual(environment.localEvents, []);
});

test('a transient cross-window event failure keeps the saved choice available on reopen', async t => {
    installEnvironment(t, {}, { emit: async () => { throw new Error('window closed'); } });
    const originalConsoleError = console.error;
    console.error = () => {};
    t.after(() => { console.error = originalConsoleError; });
    const module = await freshModule('event-failure');
    await module.updateDesktopOrganizerPresentation({ presentation: 'space', appearance: 'liquid' });
    assert.equal(module.getDesktopOrganizerSettings().presentation, 'space');
    assert.equal(module.getDesktopOrganizerSettings().appearance, undefined);
});
