import assert from 'node:assert/strict';
import test from 'node:test';

const KEY = 'dtkit_desktop_space_settings_v1';
let sequence = 0;

async function setup(t, { cached, native, invoke } = {}) {
    const previous = { window: globalThis.window, localStorage: globalThis.localStorage };
    const values = new Map(cached ? [[KEY, JSON.stringify(cached)]] : []);
    const listeners = new Map(), calls = [];
    const target = new EventTarget();
    let persisted = native || { version: 1, glassOpacity: 68, blur: 30, iconSize: 'medium', windowWidth: 90, windowHeight: 70,
        closeOnBlur: true, closeAfterOpen: true, reducedMotion: false };
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    target.__TAURI__ = {
        core: { invoke: async (command, args) => {
            calls.push({ command, args });
            if (invoke) return invoke(command, args, persisted, value => { persisted = value; });
            if (command === 'get_desktop_space_settings') return structuredClone(persisted);
            if (command === 'update_desktop_space_settings') { persisted = { ...persisted, ...args.patch }; return structuredClone(persisted); }
            throw new Error(`Unexpected command: ${command}`);
        } },
        event: { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } }
    };
    globalThis.window = target;
    t.after(() => { target.dispatchEvent(new Event('pagehide')); Object.assign(globalThis, previous); });
    const module = await import(`../src/desktop-organizer/space-preferences.js?test=${++sequence}`);
    return { module, calls, values, listeners, target, persisted: () => persisted };
}

test('space defaults are bounded and invalid setting values fall back without accepting unknown fields', async t => {
    const { module } = await setup(t);
    assert.deepEqual(module.DEFAULT_SPACE_SETTINGS, {
        version: 1, glassOpacity: 68, blur: 30, iconSize: 'medium', windowWidth: 90, windowHeight: 70,
        closeOnBlur: true, closeAfterOpen: true, reducedMotion: false
    });
    const normalized = module.normalizeSpaceSettings({
        glassOpacity: 500, blur: -3, iconSize: 'giant', windowWidth: 60.7, windowHeight: NaN,
        closeOnBlur: 'false', closeAfterOpen: false, reducedMotion: true, unrelated: 'ignore'
    });
    assert.deepEqual(normalized, {
        version: 1, glassOpacity: 90, blur: 12, iconSize: 'medium', windowWidth: 61, windowHeight: 70,
        closeOnBlur: true, closeAfterOpen: false, reducedMotion: true
    });
    assert.equal(module.normalizeSpaceSettings({ glassOpacity: '40' }).glassOpacity, 68);
    assert.deepEqual(module.normalizeSpaceSettings(null), module.DEFAULT_SPACE_SETTINGS);
});

test('native reads replace the startup cache and subscribers cannot mutate stored settings', async t => {
    const { module, calls, values } = await setup(t, { cached: { glassOpacity: 42 }, native: { glassOpacity: 79, iconSize: 'large' } });
    assert.equal(module.getSpaceSettings().glassOpacity, 42);
    const observed = [];
    module.subscribeSpaceSettings(value => { observed.push(value); value.glassOpacity = 0; });
    await Promise.all([module.initializeSpaceSettings(), module.initializeSpaceSettings()]);
    assert.equal(calls.filter(call => call.command === 'get_desktop_space_settings').length, 1);
    assert.equal(module.getSpaceSettings().glassOpacity, 79);
    assert.equal(module.getSpaceSettings().iconSize, 'large');
    assert.equal(observed.length, 1);
    assert.equal(JSON.parse(values.get(KEY)).glassOpacity, 79);
    const copy = module.getSpaceSettings(); copy.blur = 0;
    assert.equal(module.getSpaceSettings().blur, 30);
});

test('updates send only the changed fields and retain other native settings across queued patches', async t => {
    const { module, calls, persisted } = await setup(t);
    await module.initializeSpaceSettings();
    await Promise.all([module.updateSpaceSettings({ glassOpacity: 76 }), module.updateSpaceSettings({ closeOnBlur: false })]);
    const updates = calls.filter(call => call.command === 'update_desktop_space_settings');
    assert.deepEqual(updates.map(call => call.args), [{ patch: { glassOpacity: 76 } }, { patch: { closeOnBlur: false } }]);
    assert.equal(persisted().glassOpacity, 76);
    assert.equal(persisted().closeOnBlur, false);
    assert.equal(module.getSpaceSettings().windowWidth, 90);
    assert.equal(module.getSpaceSettings().glassOpacity, 76);
    assert.equal(module.getSpaceSettings().closeOnBlur, false);
});

test('failed initialization can retry and failed saves keep the previous cache and permit later updates', async t => {
    let failRead = true, failSave = true;
    const { module, calls, values } = await setup(t, { invoke: async (command, args, current, persist) => {
        if (command === 'get_desktop_space_settings') {
            if (failRead) throw new Error('read unavailable');
            return current;
        }
        if (failSave) throw new Error('save unavailable');
        const next = { ...current, ...args.patch }; persist(next); return next;
    } });
    await assert.rejects(module.initializeSpaceSettings(), /read unavailable/);
    failRead = false;
    await module.initializeSpaceSettings();
    assert.equal(calls.filter(call => call.command === 'get_desktop_space_settings').length, 2);
    const before = module.getSpaceSettings(), serialized = values.get(KEY);
    await assert.rejects(module.updateSpaceSettings({ blur: 44 }), /save unavailable/);
    assert.deepEqual(module.getSpaceSettings(), before);
    assert.equal(values.get(KEY), serialized);
    failSave = false;
    await module.updateSpaceSettings({ blur: 44 });
    assert.equal(module.getSpaceSettings().blur, 44);
});

test('native and same-origin storage events synchronize observers and page cleanup detaches listeners', async t => {
    const { module, target, listeners } = await setup(t);
    const observed = [];
    module.subscribeSpaceSettings(value => observed.push(value));
    await module.initializeSpaceSettings();
    listeners.get('desktop-space-settings-changed')({ payload: { glassOpacity: 81, closeAfterOpen: false } });
    assert.equal(module.getSpaceSettings().glassOpacity, 81);
    assert.equal(module.getSpaceSettings().closeAfterOpen, false);
    function storage(key, newValue) {
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue } });
        target.dispatchEvent(event);
    }
    storage(KEY, JSON.stringify({ glassOpacity: 52, iconSize: 'small', reducedMotion: true }));
    assert.equal(module.getSpaceSettings().glassOpacity, 52);
    assert.equal(module.getSpaceSettings().iconSize, 'small');
    assert.equal(module.getSpaceSettings().reducedMotion, true);
    const count = observed.length;
    storage(KEY, '{bad'); storage('unrelated', JSON.stringify({ glassOpacity: 90 }));
    assert.equal(observed.length, count);
    target.dispatchEvent(new Event('pagehide'));
    assert.equal(listeners.has('desktop-space-settings-changed'), false);
    storage(KEY, JSON.stringify({ glassOpacity: 89 }));
    assert.equal(module.getSpaceSettings().glassOpacity, 52);
});

test('older native replies cannot replace a newer cross-window settings update', async t => {
    let release;
    const { module, listeners, values } = await setup(t, { invoke: async command => {
        assert.equal(command, 'get_desktop_space_settings');
        return new Promise(resolve => { release = resolve; });
    } });
    const loading = module.initializeSpaceSettings();
    await Promise.resolve();
    listeners.get('desktop-space-settings-changed')({ payload: { revision: 2, glassOpacity: 84, blur: 42 } });
    release({ revision: 1, glassOpacity: 50, blur: 20 });
    await loading;
    assert.equal(module.getSpaceSettings().glassOpacity, 84);
    assert.equal(module.getSpaceSettings().blur, 42);
    assert.equal(JSON.parse(values.get(KEY)).revision, 2);
});
