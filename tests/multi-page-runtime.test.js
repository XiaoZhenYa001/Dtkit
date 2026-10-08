import assert from 'node:assert/strict';
import test from 'node:test';

import { installToolPageRuntime } from '../src/core/toolPageRuntime.js';

function environment(api = {}) {
    const classes = new Set();
    const doc = new EventTarget();
    Object.assign(doc, {
        hidden: false,
        documentElement: { classList: { toggle(name,enabled) { enabled ? classes.add(name) : classes.delete(name); } } },
        scrollingElement: { scrollTop: 0 },
        querySelectorAll: () => [],
        getElementById: () => null
    });
    const win = new EventTarget();
    Object.assign(win, {
        __TAURI__: api,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 16),
        cancelAnimationFrame: clearTimeout,
        performance
    });
    win.parent = win;
    globalThis.window = win;
    globalThis.document = doc;
    return { win,doc,classes };
}

test('suspended pages coalesce native events and closing a page unsubscribes exactly once', async () => {
    let deliver;
    let unlistens = 0;
    const { win } = environment({ event: { listen: async (_name,callback) => {
        deliver = callback;
        return () => unlistens++;
    } } });
    const runtime = installToolPageRuntime({ instanceId:'events-A',toolId:'unit-converter' });
    const values = [];
    const stop = await win.__TAURI__.event.listen('native-change', event => values.push(event.payload));
    deliver({ payload:{ instanceId:'events-B',value:'belongs to another page' } });
    assert.deepEqual(values, []);
    deliver({ payload:1 });
    runtime.setSuspended(true);
    deliver({ payload:2 });
    deliver({ payload:3 });
    assert.deepEqual(values, [1]);
    runtime.setSuspended(false);
    assert.deepEqual(values, [1,3]);
    await runtime.dispose();
    stop();
    deliver({ payload:4 });
    assert.deepEqual(values, [1,3]);
    assert.equal(unlistens, 1);
});

test('a native subscription resolving after its page closes is released without delivering events', async () => {
    let finish;
    let deliver;
    let unlistens = 0;
    const { win } = environment({ event: { listen: (_name,callback) => {
        deliver = callback;
        return new Promise(resolve => { finish = resolve; });
    } } });
    const runtime = installToolPageRuntime({ instanceId:'late-listener',toolId:'unit-converter' });
    let calls = 0;
    const pending = win.__TAURI__.event.listen('native-change', () => calls++);
    await runtime.dispose();
    finish(() => unlistens++);
    await pending;
    deliver({ payload:'late' });
    assert.equal(calls, 0);
    assert.equal(unlistens, 1);
});

test('a page with pending native work cannot release its document and flush waits for that work', async () => {
    let finish;
    const requests = [];
    const { win } = environment({ core: { invoke: (command,args) => {
        requests.push({ command,args });
        return new Promise(resolve => { finish = resolve; });
    } } });
    const runtime = installToolPageRuntime({ instanceId:'work-A',toolId:'unit-converter' });
    runtime.attachTool({ id:'unit-converter' });
    const work = win.__TAURI__.core.invoke('native-work', { toolId:'unit-converter',instanceId:'forged' });
    await Promise.resolve();
    assert.deepEqual(requests, [{command:'native-work',args:{toolId:'unit-converter',instanceId:'work-A'}}]);
    assert.equal(runtime.snapshot().canRelease, false);
    let flushed = false;
    const flushing = runtime.flush().then(snapshot => { flushed = true; return snapshot; });
    await Promise.resolve();
    assert.equal(flushed, false);
    finish('saved');
    assert.equal(await work, 'saved');
    assert.equal((await flushing).canRelease, true);
    await runtime.dispose();
});

test('a restore ignores snapshots from a different page or tool', async () => {
    const { doc } = environment();
    const restored = [];
    const runtime = installToolPageRuntime({ instanceId:'restore-A',toolId:'custom-tool' });
    runtime.attachTool({ id:'custom-tool',serialize:() => ({ draft:'A' }),restore:value => restored.push(value) });
    const own = runtime.snapshot();
    await runtime.restore({ ...own,instanceId:'restore-B',state:{draft:'B'},scrollTop:500 });
    await runtime.restore({ ...own,toolId:'another-tool',state:{draft:'C'},scrollTop:500 });
    assert.deepEqual(restored, []);
    assert.equal(doc.scrollingElement.scrollTop, 0);
    await runtime.restore({ ...own,state:{draft:'restored A'},scrollTop:250 });
    assert.deepEqual(restored, [{draft:'restored A'}]);
    assert.equal(doc.scrollingElement.scrollTop, 250);
    await runtime.dispose();
});

test('sleep retains an open review dialog even when no field has been edited', async () => {
    const { doc } = environment();
    let openDialog = true;
    doc.querySelector = selector => selector === 'dialog[open]' && openDialog ? {} : null;
    const runtime = installToolPageRuntime({ instanceId:'import-review',toolId:'password-vault' });
    runtime.attachTool({ id:'password-vault' });
    assert.equal((await runtime.flush()).canRelease, false);
    openDialog = false;
    assert.equal((await runtime.flush()).canRelease, true);
    await runtime.dispose();
});

test('hidden page snapshots and resume retain scroll position after iframe layout resets', async () => {
    const { doc } = environment();
    const runtime = installToolPageRuntime({ instanceId:'scroll-A',toolId:'unit-converter',embedded:true });
    runtime.attachTool({ id:'unit-converter' });
    doc.scrollingElement.scrollTop = 320;
    runtime.setSuspended(true);
    doc.scrollingElement.scrollTop = 0; // Chromium resets the root when an iframe is display:none.
    runtime.setSuspended(true);
    assert.equal(runtime.snapshot().scrollTop, 320);
    runtime.setSuspended(false);
    assert.equal(doc.scrollingElement.scrollTop, 320);
    await runtime.dispose();
});

test('standalone page snapshots restore the visible quick content scroller', async () => {
    const { doc } = environment();
    const content = { scrollTop:180 };
    doc.getElementById = id => id === 'quickContent' ? content : null;
    const runtime = installToolPageRuntime({ instanceId:'quick-scroll',toolId:'unit-converter' });
    runtime.attachTool({ id:'unit-converter' });
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.scrollTop, 180);
    await runtime.restore({ ...snapshot,scrollTop:260 });
    assert.equal(content.scrollTop, 260);
    assert.equal(doc.scrollingElement.scrollTop, 0);
    await runtime.dispose();
});

test('floating panel actions belong to the active tool and stop when its page is suspended or disposed', async () => {
    environment();
    const called = [];
    const runtime = installToolPageRuntime({ instanceId:'panel-A',toolId:'timetable',embedded:true });
    runtime.attachTool({ id:'timetable', getPagePanel:() => ({ actions:[{id:'import'}] }), runPageAction:id => called.push(id) });
    assert.equal(runtime.embedded, true);
    assert.deepEqual(runtime.getPagePanel().actions, [{id:'import'}]);
    runtime.setSuspended(false);
    runtime.runPageAction('import');
    runtime.setSuspended(true);
    runtime.runPageAction('settings');
    assert.deepEqual(called, ['import']);
    await runtime.dispose();
    runtime.runPageAction('import');
    assert.equal(runtime.getPagePanel(), null);
    assert.deepEqual(called, ['import']);
});

test('a standalone tool boots with the non-writable Tauri internals used in native windows', async () => {
    const requests = [];
    const api = { core: Object.freeze({ invoke: async (command,args) => {
        requests.push({ command,args }); return [];
    } }) };
    const { win } = environment(api);
    Object.defineProperty(win, '__TAURI_INTERNALS__', { value:{}, writable:false, configurable:false });
    const internals = win.__TAURI_INTERNALS__;
    const runtime = installToolPageRuntime({ instanceId:'native-quick',toolId:'html-preview' });
    assert.equal(win.__TAURI_INTERNALS__, internals);
    await win.__TAURI__.core.invoke('get_tool_module_settings');
    assert.deepEqual(requests, [{command:'get_tool_module_settings',args:{instanceId:'native-quick'}}]);
    await runtime.dispose();
});

test('an embedded tool uses its parent API without overwriting its own Tauri internals', async () => {
    const requests = [];
    const parentAPI = { core:Object.freeze({ invoke:async (command,args) => {
        requests.push({ command,args }); return [];
    } }) };
    const childAPI = { core:Object.freeze({ invoke:async () => { throw new Error('child IPC must not be used'); } }) };
    const { win } = environment(childAPI);
    const childInternals = {};
    const parentInternals = {};
    Object.defineProperty(win, '__TAURI_INTERNALS__', { value:childInternals, writable:false, configurable:false });
    win.parent = { __TAURI__:parentAPI, __TAURI_INTERNALS__:parentInternals };
    const runtime = installToolPageRuntime({ instanceId:'native-frame',toolId:'html-preview',embedded:true });
    assert.equal(win.__TAURI_INTERNALS__, childInternals);
    await win.__TAURI__.core.invoke('get_tool_module_settings');
    assert.deepEqual(requests, [{command:'get_tool_module_settings',args:{instanceId:'native-frame'}}]);
    await runtime.dispose();
});

test('tool API wrappers retain non-enumerable plugin exports and native window controls', async () => {
    let minimizeCount = 0;
    const api = { core:Object.freeze({ invoke:async () => [] }) };
    const dialog = Object.freeze({ open:async () => 'selected.txt' });
    const fs = Object.freeze({ readFile:async () => new Uint8Array([1]) });
    const nativeWindow = { minimize:async () => { minimizeCount++; } };
    Object.defineProperties(api, {
        dialog:{ value:dialog }, fs:{ value:fs },
        window:{ value:Object.freeze({ getCurrentWindow:() => nativeWindow }) }
    });
    const { win } = environment(api);
    const runtime = installToolPageRuntime({ instanceId:'plugins',toolId:'hash-tool' });
    assert.equal(win.__TAURI__.dialog, dialog);
    assert.equal(win.__TAURI__.fs, fs);
    assert.equal(await win.__TAURI__.dialog.open(), 'selected.txt');
    await win.__TAURI__.window.getCurrentWindow().minimize();
    assert.equal(minimizeCount, 1);
    await runtime.dispose();
});
