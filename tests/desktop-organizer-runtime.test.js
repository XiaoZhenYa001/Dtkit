import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'dtkit_desktop_organizer';

async function environment(t, settings, invoke, setItem) {
    const previous = { window: globalThis.window, localStorage: globalThis.localStorage, CustomEvent: globalThis.CustomEvent };
    const values = new Map([[STORAGE_KEY, JSON.stringify(settings)]]);
    const events = [];
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: setItem ?? ((key, value) => values.set(key, value))
    };
    globalThis.CustomEvent = class {
        constructor(type, options) { this.type = type; this.detail = options.detail; }
    };
    globalThis.window = {
        dispatchEvent: event => events.push(event),
        __TAURI__: { core: { invoke } }
    };
    t.after(() => Object.assign(globalThis, previous));
    const url = new URL('../src/core/desktopOrganizer.js', import.meta.url);
    url.searchParams.set('runtime-test', t.name);
    const module = await import(url.href);
    return { module, values, events };
}

test('startup restores the native desktop mode after the main webview was discarded', async t => {
    const commands = [];
    const { module } = await environment(t, { enabled: false, presentation: 'classic', layout: 'drawer' }, async (command, args) => {
        commands.push({ command, args });
        if (command === 'get_desktop_organizer_mode') return { configured: true, enabled: true, presentation: 'space' };
    });
    assert.equal(await module.bootstrapDesktopOrganizer(), true);
    assert.equal(module.getDesktopOrganizerSettings().presentation, 'space');
    assert.equal(module.getDesktopOrganizerSettings().enabled, true);
    assert.equal(module.getDesktopOrganizerSettings().layout, 'drawer');
    assert.deepEqual(commands.at(-1), { command: 'set_desktop_organizer_mode', args: { enabled: true, presentation: 'space' } });
});

test('space enablement and a simultaneous presentation change cannot leave the hotzone active', async t => {
    const modes = [];
    let active = 0;
    let maxActive = 0;
    const { module } = await environment(t, { enabled: false, presentation: 'classic' }, async (command, args) => {
        assert.equal(command, 'set_desktop_organizer_mode');
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        modes.push(args);
        active--;
    });
    await Promise.all([
        module.setDesktopOrganizerEnabled(true),
        module.updateDesktopOrganizerPresentation({ presentation: 'space' }),
        module.updateDesktopOrganizerPresentation({ appearance: 'liquid', layout: 'zones' })
    ]);
    assert.equal(maxActive, 1);
    assert.deepEqual(modes, [{ enabled: true, presentation: 'classic' }, { enabled: true, presentation: 'space' }]);
    assert.deepEqual(module.getDesktopOrganizerSettings(), {
        enabled: true, autoAnalyze: false, presentation: 'space', appearance: 'liquid', layout: 'zones', reducedMotion: false
    });
});

test('failed desktop attachment restores the saved choice and permits a later retry', async t => {
    let fail = true;
    const { module, events } = await environment(t, { enabled: true, presentation: 'classic', layout: 'islands' }, async () => {
        if (fail) throw new Error('Explorer unavailable');
    });
    await assert.rejects(module.updateDesktopOrganizerPresentation({ presentation: 'space' }), /Explorer unavailable/);
    assert.equal(module.getDesktopOrganizerSettings().presentation, 'classic');
    assert.equal(events.length, 0);
    fail = false;
    await module.updateDesktopOrganizerPresentation({ presentation: 'space' });
    assert.equal(module.getDesktopOrganizerSettings().presentation, 'space');
});

test('disabling desktop space reaches the same native manager used to restore Explorer icons', async t => {
    const modes = [];
    const { module } = await environment(t, { enabled: true, presentation: 'space' }, async (command, args) => modes.push({ command, args }));
    await module.setDesktopOrganizerEnabled(false);
    assert.deepEqual(modes, [{ command: 'set_desktop_organizer_mode', args: { enabled: false, presentation: 'space' } }]);
    assert.equal(module.getDesktopOrganizerSettings().enabled, false);
});

test('a storage failure after enablement rolls back the native runtime', async t => {
    const modes = [];
    const { module } = await environment(t, { enabled: false, presentation: 'space' }, async (_command, args) => modes.push(args), () => {
        throw new Error('storage full');
    });
    await assert.rejects(module.setDesktopOrganizerEnabled(true), /storage full/);
    assert.deepEqual(modes, [{ enabled: true, presentation: 'space' }, { enabled: false, presentation: 'space' }]);
    assert.equal(module.getDesktopOrganizerSettings().enabled, false);
});

test('layout and material updates do not recreate the native desktop host', async t => {
    const commands = [];
    const { module } = await environment(t, { enabled: true, presentation: 'space' }, async command => commands.push(command));
    await module.updateDesktopOrganizerPresentation({ layout: 'zones', appearance: 'liquid', reducedMotion: true });
    assert.deepEqual(commands, []);
});

test('switching back after another webview changed the native mode never uses a stale local cache', async t => {
    let nativeMode = { configured: true, enabled: true, presentation: 'classic' };
    const modes = [];
    const { module, values } = await environment(t, { enabled: true, presentation: 'classic' }, async (command, args) => {
        if (command === 'get_desktop_organizer_mode') return nativeMode;
        nativeMode = { configured: true, ...args };
        modes.push(args);
    });
    await module.bootstrapDesktopOrganizer();
    // The organizer's appearance menu shares storage and the native manager,
    // while the main settings module remains loaded in a different WebView.
    nativeMode = { configured: true, enabled: true, presentation: 'space' };
    values.set(STORAGE_KEY, JSON.stringify({ ...module.getDesktopOrganizerSettings(), presentation: 'space' }));
    await module.updateDesktopOrganizerPresentation({ presentation: 'classic' });
    assert.equal(nativeMode.presentation, 'classic');
    assert.deepEqual(modes.at(-1), { enabled: true, presentation: 'classic' });
    assert.equal(modes.length, 2);
});

test('superseded queued mode selections do not recreate the desktop while the current handoff finishes', async t => {
    const modes = [];
    let release;
    const { module } = await environment(t, { enabled: true, presentation: 'classic' }, async (_command, args) => {
        modes.push(args);
        await new Promise(resolve => { release = resolve; });
    });
    const entering = module.updateDesktopOrganizerPresentation({ presentation: 'space' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(modes.length, 1);
    const outdated = module.updateDesktopOrganizerPresentation({ presentation: 'classic' });
    const latest = module.updateDesktopOrganizerPresentation({ presentation: 'space', layout: 'drawer' });
    release();
    await Promise.all([entering, outdated, latest]);
    assert.deepEqual(modes, [{ enabled: true, presentation: 'space' }]);
    assert.equal(module.getDesktopOrganizerSettings().presentation, 'space');
    assert.equal(module.getDesktopOrganizerSettings().layout, 'drawer');
});
