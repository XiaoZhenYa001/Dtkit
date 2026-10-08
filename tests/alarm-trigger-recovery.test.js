import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ALARM_STORAGE_KEY, readAlarmData } from '../src/core/alarmStore.js';

function completedCountdown(id = 'countdown') {
    const triggeredAt = new Date(2026, 9, 7, 12, 0, 0).getTime();
    return { id, name: '已经完成的提醒', type: 'countdown', action: 'notify', enabled: true,
        paused: false, config: { remainingSeconds: 30, totalSeconds: 30, deadlineAt: triggeredAt },
        triggerId: randomUUID(), triggeredAt };
}

function environment(triggers, tasks = triggers.map(({ triggerId, triggeredAt, ...task }) => task)) {
    const previous = Object.fromEntries(['window', 'localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const values = new Map([[ALARM_STORAGE_KEY, JSON.stringify({ tasks, completedToday: 0 })]]);
    const nativeLog = new Map(triggers.map(trigger => [trigger.triggerId, structuredClone(trigger)]));
    const operations = [];
    const listeners = new Set();
    const lockQueues = new Map();
    let rejectWrites = false;
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem(key, value) {
            if (rejectWrites) throw new Error('disk full');
            values.set(key, value);
            operations.push({ type: 'save', data: JSON.parse(value) });
        }
    };
    const win = new EventTarget();
    win.parent = win;
    win.__TAURI__ = {
        event: { listen: async (name, callback) => {
            assert.equal(name, 'alarm-triggered');
            listeners.add(callback); return () => listeners.delete(callback);
        } },
        core: { invoke: async (command, args) => {
            if (command === 'take_missed_alarm_triggers') {
                operations.push({ type: 'read' });
                // A native read never consumes the durable log.
                return structuredClone([...nativeLog.values()].slice(0, 200));
            }
            if (command === 'ack_missed_alarm_triggers') {
                const stored = readAlarmData();
                for (const id of args.triggerIds) {
                    assert.ok(stored.processedTriggers.includes(id), 'only saved completions may be acknowledged');
                    const taskId = nativeLog.get(id)?.id;
                    const task = stored.tasks.find(item => item.id === taskId);
                    if (task) assert.equal(task.enabled, false, 'countdown must be disabled before acknowledgment');
                    nativeLog.delete(id);
                }
                operations.push({ type: 'ack', ids: [...args.triggerIds] });
                return;
            }
            if (command === 'sync_alarm_tasks') {
                operations.push({ type: 'sync', tasks: structuredClone(args.tasks) });
                assert.ok(args.tasks.every(task => !task.enabled), 'completed countdowns must never be scheduled again');
                return;
            }
            assert.fail(`unexpected native command: ${command}`);
        } }
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        locks: { request(name, callback) {
            const result = (lockQueues.get(name) || Promise.resolve()).then(callback);
            lockQueues.set(name, result.catch(() => {}));
            return result;
        } }
    } });
    return {
        operations, nativeLog, listeners,
        rejectWrites(value) { rejectWrites = value; },
        async service() { return import(`../src/core/alarmService.js?recovery=${randomUUID()}`); },
        restore() {
            for (const [key, descriptor] of Object.entries(previous)) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
            }
        }
    };
}

test('startup saves a completed countdown before native acknowledgment and never schedules it again', async () => {
    const trigger = completedCountdown();
    const env = environment([trigger]);
    let service;
    try {
        service = await env.service();
        await service.initializeAlarmService();
        assert.deepEqual(env.operations.map(operation => operation.type), ['read', 'save', 'ack', 'sync']);
        assert.equal(env.nativeLog.size, 0);
        assert.equal(readAlarmData().completedToday, 1);
        assert.equal(readAlarmData().tasks[0].config.remainingSeconds, 0);
        assert.equal('deadlineAt' in readAlarmData().tasks[0].config, false);

        service.destroyAlarmService();
        service = await env.service();
        await service.initializeAlarmService();
        assert.equal(readAlarmData().completedToday, 1);
        assert.equal(env.operations.filter(operation => operation.type === 'ack').length, 1);
        assert.equal(env.operations.filter(operation => operation.type === 'sync').length, 2);
    } finally {
        service?.destroyAlarmService(); env.restore();
    }
});

test('a failed startup save leaves the native completion available and a retry recovers it', async t => {
    t.mock.method(console, 'error', () => {});
    const trigger = completedCountdown();
    const env = environment([trigger]);
    let service;
    try {
        service = await env.service();
        env.rejectWrites(true);
        await assert.rejects(service.initializeAlarmService(), /保存闹钟数据失败/);
        assert.deepEqual(env.operations.map(operation => operation.type), ['read']);
        assert.equal(env.nativeLog.size, 1);
        assert.equal(readAlarmData().tasks[0].enabled, true);
        assert.equal(env.listeners.size, 0);

        env.rejectWrites(false);
        await service.initializeAlarmService();
        assert.deepEqual(env.operations.map(operation => operation.type), ['read', 'read', 'save', 'ack', 'sync']);
        assert.equal(env.nativeLog.size, 0);
        assert.equal(readAlarmData().tasks[0].enabled, false);
        assert.equal(readAlarmData().completedToday, 1);
    } finally {
        service?.destroyAlarmService(); env.restore();
    }
});

test('startup drains a full completion batch and its tail with two native acknowledgments', async () => {
    const triggers = Array.from({ length: 201 }, (_, index) => completedCountdown(`countdown-${index}`));
    // A pending native record can outlive a task removed from the shared form.
    const tasks = triggers.slice(0, 200).map(({ triggerId, triggeredAt, ...task }) => task);
    const env = environment(triggers, tasks);
    let service;
    try {
        service = await env.service();
        await service.initializeAlarmService();
        const reads = env.operations.filter(operation => operation.type === 'read');
        const acknowledgments = env.operations.filter(operation => operation.type === 'ack');
        assert.equal(reads.length, 2);
        assert.deepEqual(acknowledgments.map(operation => operation.ids.length), [200, 1]);
        assert.equal(env.nativeLog.size, 0);
        assert.equal(readAlarmData().completedToday, 200);
        assert.equal(readAlarmData().processedTriggers.length, 201);
        assert.equal(env.operations.at(-1).type, 'sync');
    } finally {
        service?.destroyAlarmService(); env.restore();
    }
});
