const STORAGE_KEY = 'alarm_clock_data';
const TRIGGER_EVENT = 'dtkit:alarm-triggered';

let initialized = false;
let unlistenAlarm = null;

function getInvoke() {
    return globalThis.window?.__TAURI__?.core?.invoke || null;
}

function getListen() {
    return globalThis.window?.__TAURI__?.event?.listen || null;
}

function readAlarmData() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (error) {
        console.error('[AlarmService] 读取闹钟数据失败', error);
        return {};
    }
}

function writeAlarmData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function prepareAlarmTaskSchedule(task, { restart = false } = {}) {
    if (!task?.config || !task.enabled || task.paused) return task;

    const now = Date.now();
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

export function pauseAlarmTaskSchedule(task) {
    if (!task?.config) return task;
    const now = Date.now();

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

export async function syncAlarmTasks(tasks) {
    const invoke = getInvoke();
    if (!invoke) return false;

    await invoke('sync_alarm_tasks', { tasks });
    return true;
}

function updateStoredTaskAfterTrigger(triggeredTask) {
    const data = readAlarmData();
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const task = tasks.find(item => item.id === triggeredTask.id);
    if (!task) return;

    if (task.type === 'countdown') {
        task.enabled = false;
        task.config.remainingSeconds = 0;
        delete task.config.deadlineAt;
    } else if (task.type === 'interval') {
        task.config.nextTriggerAt = Date.now() + Math.max(1, Number(task.config.intervalMs) || 1);
    } else if ((task.type === 'fixed' || task.type === 'hourly')
        && task.config.repeatEnabled === false) {
        task.enabled = false;
    }

    const today = new Date().toDateString();
    data.completedToday = data.lastDate === today ? (Number(data.completedToday) || 0) + 1 : 1;
    data.lastDate = today;
    writeAlarmData(data);
}

async function handleAlarmTriggered(task) {
    updateStoredTaskAfterTrigger(task);
    globalThis.window?.dispatchEvent(new CustomEvent(TRIGGER_EVENT, { detail: task }));

    if (task.action === 'sound') {
        try {
            const alarmModule = await import('../tools/alarm-clock/index.js');
            await alarmModule.handleBackgroundAlarmTrigger(task);
        } catch (error) {
            console.error('[AlarmService] 播放提醒音失败', error);
        }
    }
}

export async function initializeAlarmService() {
    if (initialized) return;
    initialized = true;

    const listen = getListen();
    if (!listen) return;

    unlistenAlarm = await listen('alarm-triggered', event => {
        handleAlarmTriggered(event.payload);
    });

    const invoke = getInvoke();
    if (invoke) {
        const missedTriggers = await invoke('take_missed_alarm_triggers');
        for (const task of missedTriggers) await handleAlarmTriggered(task);
    }

    const data = readAlarmData();
    const tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, 200) : [];
    tasks.forEach(normalizeAlarmTask);
    tasks.forEach(task => prepareAlarmTaskSchedule(task));
    if (tasks.length > 0) writeAlarmData({ ...data, tasks });
    await syncAlarmTasks(tasks);
}

export function destroyAlarmService() {
    unlistenAlarm?.();
    unlistenAlarm = null;
    initialized = false;
}

export { STORAGE_KEY as ALARM_STORAGE_KEY, TRIGGER_EVENT as ALARM_TRIGGER_EVENT };
