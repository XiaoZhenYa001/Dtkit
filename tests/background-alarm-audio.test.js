import assert from 'node:assert/strict';
import test from 'node:test';

import { installToolPageRuntime } from '../src/core/toolPageRuntime.js';
import { AlarmAudioManager } from '../src/tools/alarm-clock/audioManager.js';
import { removeAlarmNotification, showSoundAlarmNotification } from '../src/tools/alarm-clock/notifications.js';
import { showToast } from '../src/core/utils.js';

test('sound controls are available before permission resolves, survive regular toasts and support keyboard dismissal', async () => {
    const saved = Object.fromEntries(['window', 'document', 'setTimeout']
        .map(key => [key, globalThis[key]]));
    const elements = [];
    const attributes = new WeakMap();
    let releasePermission;
    let dismissed = 0;
    let sentNotifications = 0;
    let active = true;
    const permission = new Promise(resolve => { releasePermission = resolve; });
    const element = () => {
        const node = Object.assign(new EventTarget(), {
            className: '', isConnected: true,
            classList: { add() {} },
            remove() { this.isConnected = false; },
            setAttribute(name, value) { attributes.get(this)[name] = value; },
            contains(target) { return target === this || target === this.button; },
            focus() { globalThis.document.activeElement = this; },
            querySelector(selector) {
                if (selector !== '.alarm-dismiss-btn') return null;
                this.button ||= Object.assign(new EventTarget(), {
                    focus() { globalThis.document.activeElement = this; }
                });
                return this.button;
            }
        });
        attributes.set(node, {});
        return node;
    };
    globalThis.document = {
        activeElement: null, createElement: element,
        getElementById: id => elements.find(node => node.id === id && node.isConnected) || null,
        querySelector: selector => selector === '.dtkit-toast'
            ? elements.find(node => node.isConnected && node.className.split(' ').includes('dtkit-toast')) || null : null,
        querySelectorAll: selector => elements.filter(node => node.isConnected
            && node.className.includes(selector.includes('alarm-overlay') ? 'alarm-overlay' : 'dtkit-toast--alarm')),
        body: { appendChild(node) { elements.push(node); } }
    };
    const previousFocus = element();
    previousFocus.focus();
    globalThis.window = { __TAURI__: { notification: {
        isPermissionGranted: () => permission,
        requestPermission: async () => 'denied',
        sendNotification: async () => { sentNotifications += 1; }
    } } };
    globalThis.setTimeout = () => 1;
    try {
        const presentation = showSoundAlarmNotification({ id: 'keyboard', name: '休息一下' }, () => {
            active = false;
            dismissed += 1;
            removeAlarmNotification('keyboard', { animate: false });
        }, () => active);
        const toast = document.getElementById('alarm-toast-keyboard');
        assert.ok(toast, 'an unresolved system permission must not hide the stop control');
        assert.equal(attributes.get(toast).role, 'alertdialog');
        assert.equal(document.activeElement, toast.button);
        showToast('已保存', 'success');
        assert.equal(toast.isConnected, true, 'ordinary status toasts must not remove alarm controls');
        const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
        toast.dispatchEvent(escape);
        assert.equal(dismissed, 1);
        assert.equal(document.activeElement, previousFocus);
        assert.equal(toast.isConnected, false);
        toast.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
        assert.equal(dismissed, 1);
        releasePermission(true);
        await presentation;
        assert.equal(sentNotifications, 0, 'stopping before permission resolves must prevent a late alert');
    } finally {
        releasePermission(false);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    }
});

test('stopping a loading alarm immediately advances queued audio and releases its loading timer', async () => {
    const saved = Object.fromEntries(['window', 'document', 'Audio']
        .map(key => [key, globalThis[key]]));
    const timers = new Map();
    const audios = [];
    let sequence = 0;
    class FakeAudio extends EventTarget {
        constructor() {
            super();
            this.readyState = audios.length === 0 ? 0 : 2;
            audios.push(this);
        }
        async play() { this.playing = true; }
        pause() { this.playing = false; }
        load() {}
    }
    globalThis.window = { __DTKIT_BACKGROUND_TIMERS__: {
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    } };
    globalThis.document = {
        getElementById: () => null, querySelectorAll: () => [],
        createElement: () => Object.assign(new EventTarget(), { querySelector: () => null, setAttribute() {} }),
        body: { appendChild() {} }
    };
    globalThis.Audio = FakeAudio;
    const manager = new AlarmAudioManager();
    const task = id => ({ id, name: id, __backendTriggered: true, config: { audioPath: `${id}.mp3` } });
    try {
        const firstPlayback = manager.play(task('loading'));
        // convertPath awaits once before installing the audio loading listeners.
        await Promise.resolve();
        assert.equal([...timers.values()].some(timer => timer.delay === 5000), true);
        await manager.play(task('queued'));
        manager.stop('loading');
        await firstPlayback;
        assert.equal(manager.currentController?.taskId, 'queued');
        assert.equal(audios[1].playing, true);
        assert.equal(audios[0].playing, false);
        assert.equal([...timers.values()].some(timer => timer.delay === 5000), false);
        assert.equal(timers.size, 1, 'only the next alarm playback limit remains');
    } finally {
        manager.stopAll();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    }
});

test('replacing an in-flight preview quietly cancels it and only schedules the current preview timer', async () => {
    const saved = Object.fromEntries(['window', 'Audio', 'setTimeout', 'clearTimeout']
        .map(key => [key, globalThis[key]]));
    const audios = [];
    const timers = new Map();
    let sequence = 0;
    class FakeAudio {
        constructor() { audios.push(this); }
        play() {
            return new Promise((resolve, reject) => { this.resolvePlay = resolve; this.rejectPlay = reject; });
        }
        pause() {}
    }
    globalThis.window = {};
    globalThis.Audio = FakeAudio;
    globalThis.setTimeout = callback => { const id = ++sequence; timers.set(id, callback); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    const manager = new AlarmAudioManager();
    try {
        const first = manager.preview('first.mp3');
        await Promise.resolve();
        const second = manager.preview('second.mp3');
        await Promise.resolve();
        audios[0].rejectPlay(new DOMException('Playback was interrupted', 'AbortError'));
        await first;
        audios[1].resolvePlay();
        await second;
        assert.equal(manager.previewAudio, audios[1]);
        assert.equal(timers.size, 1);

        const third = manager.preview('third.mp3');
        await Promise.resolve();
        manager.stopPreview();
        audios[2].resolvePlay();
        await third;
        assert.equal(timers.size, 0, 'a cancelled play promise cannot install a stale preview timer');
    } finally {
        manager.stopPreview();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    }
});

test('a suspended alarm still times out audio loading and stops playback, while disposal cancels timers', async () => {
    const saved = Object.fromEntries(['window', 'document', 'Audio', 'setTimeout', 'clearTimeout']
        .map(key => [key, globalThis[key]]));
    const tasks = new Map();
    let time = 0;
    let sequence = 0;
    const schedule = (callback, delay = 0) => {
        const id = ++sequence; tasks.set(id, { callback, at: time + delay }); return id;
    };
    const clear = id => tasks.delete(id);
    const advance = duration => {
        time += duration;
        for (const [id, task] of [...tasks]) if (task.at <= time) {
            tasks.delete(id); task.callback();
        }
    };
    const element = () => Object.assign(new EventTarget(), {
        classList: { add() {} }, remove() {}, querySelector: () => null, setAttribute() {}
    });
    const doc = Object.assign(new EventTarget(), {
        hidden: false,
        documentElement: { classList: { toggle() {} } },
        scrollingElement: { scrollTop: 0 },
        querySelectorAll: () => [], getElementById: () => null,
        createElement: element, body: { appendChild() {} }
    });
    const win = Object.assign(new EventTarget(), {
        setTimeout: schedule, clearTimeout: clear,
        requestAnimationFrame: callback => schedule(callback, 16), cancelAnimationFrame: clear,
        performance: { now: () => time }, __TAURI__: {}
    });
    win.parent = win;
    class FakeAudio extends EventTarget {
        readyState = 2;
        async play() { this.playing = true; }
        pause() { this.playing = false; }
        load() {}
    }
    globalThis.window = win; globalThis.document = doc; globalThis.Audio = FakeAudio;
    const runtime = installToolPageRuntime({ instanceId: 'background-audio', toolId: 'alarm-clock' });
    // Browser global timers are the wrapped Window methods. Keep that relationship
    // here so accidentally using a UI timeout would never fire while suspended.
    globalThis.setTimeout = win.setTimeout; globalThis.clearTimeout = win.clearTimeout;
    const manager = new AlarmAudioManager();
    try {
        runtime.setSuspended(true);
        const unavailable = new FakeAudio(); unavailable.readyState = 0;
        const loading = assert.rejects(manager.waitUntilPlayable(unavailable), /音频加载超时/);
        advance(5000); await loading;

        const task = { id: 'sound-task', name: '提醒', __backendTriggered: true,
            config: { audioPath: 'tone.mp3', audioName: 'tone.mp3' } };
        assert.equal(await manager.startTaskAudio(task), true);
        const audio = manager.currentController.audio;
        assert.equal(audio.playing, true);
        advance(7 * 60 * 1000);
        assert.equal(manager.hasActiveAudio, false);
        assert.equal(audio.playing, false);

        const pendingAudio = new FakeAudio(); pendingAudio.readyState = 0;
        void manager.waitUntilPlayable(pendingAudio);
        assert.equal(tasks.size, 1);
        await runtime.dispose();
        assert.equal(tasks.size, 0);
        advance(10000);
        assert.equal(tasks.size, 0);
    } finally {
        manager.stopAll();
        await runtime.dispose();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    }
});
