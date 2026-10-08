import assert from 'node:assert/strict';
import test from 'node:test';

import { installToolPageRuntime } from '../src/core/toolPageRuntime.js';
import { AlarmAudioManager } from '../src/tools/alarm-clock/audioManager.js';

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
        classList: { add() {} }, remove() {}, querySelector: () => null
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
