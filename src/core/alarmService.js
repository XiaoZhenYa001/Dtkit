import {
    ALARM_STORAGE_KEY,
    readAlarmData,
    recordTriggeredAlarmOnce,
    updateAlarmData
} from './alarmStore.js';
import { AlarmSyncQueue } from './alarmSync.js';

const TRIGGER_EVENT = 'dtkit:alarm-triggered';
const SYNC_STATUS_EVENT = 'dtkit:alarm-sync-status';

let initialized = false;
let unlistenAlarm = null;
let initializationPromise = null;
let activeAlarmModule = null;
let sharedServiceApi = null;
let sharedAudioApi = null;
let alarmSyncStatus = { state: 'idle', attempt: 0, maxAttempts: 4 };

function getParentService() {
    const currentWindow = globalThis.window;
    if (!currentWindow?.__DTKIT_TOOL_PAGE_CONTEXT?.embedded) return null;
    try {
        if (currentWindow.parent === currentWindow || currentWindow.parent.location.origin !== currentWindow.location.origin) return null;
        return currentWindow.parent.__DTKIT_SHARED_ALARM_SERVICE__ || null;
    } catch { return null; }
}

export function stopAlarmAudio(taskId = null) {
    const parent = getParentService();
    if (parent) return parent.stopAudio(taskId);
    return activeAlarmModule?.stopBackgroundAlarmAudio?.(taskId) ?? false;
}

function emitSyncStatus(detail) {
    alarmSyncStatus = detail;
    globalThis.window?.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail }));
}

const alarmSyncQueue = new AlarmSyncQueue(async tasks => {
    const invoke = getInvoke();
    if (!invoke) return false;
    const syncLatest = async () => {
        const latest = readAlarmData();
        await invoke('sync_alarm_tasks', { tasks: Array.isArray(latest.tasks) ? latest.tasks : tasks });
    };
    // A slow IPC response from another window must not restore an older schedule.
    const locks = globalThis.navigator?.locks;
    if (locks?.request) await locks.request('dtkit-alarm-scheduler', syncLatest);
    else await syncLatest();
    return true;
}, { onStatus: emitSyncStatus });

function getInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

function getListen() {
    return globalThis.window?.__TAURI__?.event?.listen || null;
}

export function prepareAlarmTaskSchedule(task, { restart = false, now = Date.now() } = {}) {
    if (!task?.config || !task.enabled || task.paused) return task;

    if (task.type === 'countdown') {
        const remainingSeconds = Math.max(0, Number(task.config.remainingSeconds) || 0);
        if (restart || !Number.isFinite(task.config.deadlineAt)) {
            task.config.deadlineAt = now + remainingSeconds * 1000;
        }
    } else if (task.type === 'interval') {
        const intervalMs = Math.max(1, Number(task.config.intervalMs) || 1);
        if (restart || !Number.isFinite(task.config.nextTriggerAt)) {
            const remainingMs = Math.max(1, Number(task.config.remainingIntervalMs) || intervalMs);
            task.config.nextTriggerAt = now + remainingMs;
        }
    }

    return task;
}

export function normalizeAlarmTask(task) {
    if (!task || typeof task !== 'object') return task;
    if (!task.config || typeof task.config !== 'object') task.config = {};
    if (task.type === 'fixed' || task.type === 'hourly') {
        if (task.config.repeatEnabled === undefined) task.config.repeatEnabled = true;
        if (task.config.repeatEnabled && (!Array.isArray(task.config.repeatDays)
            || task.config.repeatDays.length === 0)) {
            task.config.repeatDays = [0, 1, 2, 3, 4, 5, 6];
        }
    }
    return task;
}

export function pauseAlarmTaskSchedule(task, now = Date.now()) {
    if (!task?.config) return task;

    if (task.type === 'countdown' && Number.isFinite(task.config.deadlineAt)) {
        task.config.remainingSeconds = Math.max(0, Math.ceil((task.config.deadlineAt - now) / 1000));
        delete task.config.deadlineAt;
    } else if (task.type === 'interval' && Number.isFinite(task.config.nextTriggerAt)) {
        task.config.remainingIntervalMs = Math.max(1, task.config.nextTriggerAt - now);
        delete task.config.nextTriggerAt;
    }
    return task;
}

export function getCountdownRemainingSeconds(task, now = Date.now()) {
    if (!task?.enabled || !task.config) return 0;
    if (task.paused || !Number.isFinite(task.config.deadlineAt)) {
        return Math.max(0, Number(task.config.remainingSeconds) || 0);
    }
    return Math.max(0, Math.ceil((task.config.deadlineAt - now) / 1000));
}

function getNextEnabledDayDistance(repeatDays, currentDay, includeToday) {
    const enabledDays = new Set(Array.isArray(repeatDays) ? repeatDays.map(Number) : []);
    for (let offset = includeToday ? 0 : 1; offset <= 7; offset++) {
        if (enabledDays.has((currentDay + offset) % 7)) return offset;
    }
    return null;
}

export function getAlarmRemainingSeconds(task, now = Date.now(), { includePaused = false } = {}) {
    if (!task?.enabled || !task.config || (task.paused && !includePaused)) return Infinity;

    if (task.type === 'countdown') {
        return getCountdownRemainingSeconds(task, now);
    }

    if (task.type === 'interval') {
        if (task.paused) {
            return Math.max(0, Math.ceil((Number(task.config.remainingIntervalMs) || 0) / 1000));
        }
        const nextTriggerAt = Number(task.config.nextTriggerAt);
        const intervalMs = Math.max(1, Number(task.config.intervalMs) || 1);
        const target = Number.isFinite(nextTriggerAt) && nextTriggerAt > now
            ? nextTriggerAt
            : now + intervalMs;
        return Math.max(0, Math.ceil((target - now) / 1000));
    }

    const current = new Date(now);
    let target;
    if (task.type === 'hourly') {
        target = new Date(current);
        target.setHours(current.getHours() + 1, 0, 0, 0);
    } else if (task.type === 'fixed') {
        const match = /^(\d{1,2}):(\d{2})$/.exec(task.config.time || '');
        if (!match) return Infinity;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours > 23 || minutes > 59) return Infinity;
        target = new Date(current);
        target.setHours(hours, minutes, 0, 0);
        if (target <= current) target.setDate(target.getDate() + 1);
    } else {
        return Infinity;
    }

    if (task.config.repeatEnabled !== false) {
        const includeToday = target.getDay() === current.getDay();
        const dayDistance = getNextEnabledDayDistance(
            task.config.repeatDays,
            current.getDay(),
            includeToday
        );
        if (dayDistance === null) return Infinity;
        const targetDayDistance = (target.getDay() - current.getDay() + 7) % 7;
        const extraDays = (dayDistance - targetDayDistance + 7) % 7;
        target.setDate(target.getDate() + extraDays);
    }

    return Math.max(0, Math.ceil((target.getTime() - now) / 1000));
}

export function syncAlarmTasks(tasks) {
    const parent = getParentService();
    if (parent) return parent.sync(tasks);
    if (!getInvoke()) return Promise.resolve(false);
    return alarmSyncQueue.request(tasks);
}

export function getAlarmSyncStatus() {
    const parent = getParentService();
    if (parent) return parent.getStatus();
    return alarmSyncStatus;
}

async function handleAlarmTriggered(task, { acknowledge = true } = {}) {
    const result = await updateAlarmData(data => recordTriggeredAlarmOnce(data, task));
    const invoke = getInvoke();
    if (acknowledge && invoke && typeof task.triggerId === 'string') {
        await invoke('ack_missed_alarm_triggers', { triggerIds: [task.triggerId] });
    }
    if (!result.changed) return;
    globalThis.window?.dispatchEvent(new CustomEvent(TRIGGER_EVENT, { detail: task }));

    if (task.action === 'sound') {
        try {
            const alarmModule = await import('../tools/alarm-clock/index.js');
            activeAlarmModule = alarmModule;
            await alarmModule.handleBackgroundAlarmTrigger(task);
        } catch (error) {
            console.error('[AlarmService] 播放提醒音失败', error);
        }
    }
}

async function initializeOwnedService() {
    const listen = getListen();
    if (!listen) return;

    unlistenAlarm = await listen('alarm-triggered', event => {
        handleAlarmTriggered(event.payload).catch(error => console.error('[AlarmService] 更新提醒记录失败', error));
    });

    const invoke = getInvoke();
    if (invoke) {
        // A durable log and a failed-write buffer can require more than one batch.
        // Drain only at initialization, and acknowledge a batch after all records
        // have reached local storage to avoid a native disk write for every item.
        for (let batch = 0; batch < 4; batch += 1) {
            const missedTriggers = await invoke('take_missed_alarm_triggers');
            if (!Array.isArray(missedTriggers) || missedTriggers.length === 0) break;
            for (const task of missedTriggers) await handleAlarmTriggered(task, { acknowledge: false });
            const triggerIds = missedTriggers.map(task => task.triggerId).filter(id => typeof id === 'string');
            if (triggerIds.length) await invoke('ack_missed_alarm_triggers', { triggerIds });
            if (missedTriggers.length < 200) break;
        }
    }

    const { data } = await updateAlarmData(data => {
        const previous = JSON.stringify(data.tasks);
        data.tasks = data.tasks.slice(0, 200);
        data.tasks.forEach(normalizeAlarmTask);
        data.tasks.forEach(task => prepareAlarmTaskSchedule(task));
        return previous !== JSON.stringify(data.tasks);
    });
    await syncAlarmTasks(data.tasks);
    initialized = true;
}

export function initializeAlarmService() {
    const parent = getParentService();
    if (parent) return parent.ready();
    if (initializationPromise) return initializationPromise;
    if (initialized) return Promise.resolve();
    initializationPromise = Promise.resolve().then(initializeOwnedService).catch(error => {
        unlistenAlarm?.(); unlistenAlarm = null; initialized = false;
        throw error;
    }).finally(() => { initializationPromise = null; });
    const currentWindow = globalThis.window;
    if (currentWindow) {
        sharedServiceApi = { ready: initializeAlarmService, sync: syncAlarmTasks, getStatus: getAlarmSyncStatus, stopAudio: stopAlarmAudio };
        sharedAudioApi = { stop: taskId => stopAlarmAudio(taskId), stopAll: () => stopAlarmAudio() };
        currentWindow.__DTKIT_SHARED_ALARM_SERVICE__ = sharedServiceApi;
        currentWindow.__DTKIT_SHARED_ALARM_AUDIO__ = sharedAudioApi;
    }
    return initializationPromise;
}

export function destroyAlarmService() {
    unlistenAlarm?.();
    unlistenAlarm = null;
    initialized = false;
    if (globalThis.window?.__DTKIT_SHARED_ALARM_SERVICE__ === sharedServiceApi) delete window.__DTKIT_SHARED_ALARM_SERVICE__;
    if (globalThis.window?.__DTKIT_SHARED_ALARM_AUDIO__ === sharedAudioApi) delete window.__DTKIT_SHARED_ALARM_AUDIO__;
    sharedServiceApi = null; sharedAudioApi = null;
}

export {
    ALARM_STORAGE_KEY,
    SYNC_STATUS_EVENT as ALARM_SYNC_STATUS_EVENT,
    TRIGGER_EVENT as ALARM_TRIGGER_EVENT
};
