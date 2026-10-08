export const ALARM_STORAGE_KEY = 'alarm_clock_data';
export const ALARM_DATA_CHANGED_EVENT = 'dtkit:alarm-data-changed';
const ALARM_WRITE_LOCK = 'dtkit-alarm-data';

// A transaction always reads the current shared store, never a page's cached task list.
// Web Locks coordinate same-origin tool frames and independent native quick windows.
export async function updateAlarmData(mutate, {
    storage = globalThis.localStorage,
    locks = globalThis.navigator?.locks
} = {}) {
    const commit = () => {
        const data = readAlarmData(storage);
        if (!Array.isArray(data.tasks)) data.tasks = [];
        const changed = mutate(data) !== false;
        if (!changed) return { data, changed: false };
        if (data.tasks.length > 200) throw new Error('最多创建 200 个闹钟任务');
        const ids = new Set(data.tasks.map(task => task?.id));
        if (ids.has(undefined) || ids.has('') || ids.size !== data.tasks.length) throw new Error('闹钟任务标识无效或重复');
        data.revision = (Number.isSafeInteger(data.revision) ? data.revision : 0) + 1;
        if (!writeAlarmData(data, storage)) throw new Error('保存闹钟数据失败，请检查可用存储空间');
        globalThis.window?.dispatchEvent(new CustomEvent(ALARM_DATA_CHANGED_EVENT, {
            detail: { revision: data.revision }
        }));
        return { data, changed: true };
    };
    return locks?.request ? locks.request(ALARM_WRITE_LOCK, commit) : commit();
}

export function reorderAlarmTasks(tasks, orderedIds) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const ordered = [];
    for (const id of orderedIds) {
        if (!byId.has(id)) continue;
        ordered.push(byId.get(id));
        byId.delete(id);
    }
    // Tasks created in another page since drag started remain present.
    return [...ordered, ...byId.values()];
}

export function readAlarmData(storage = globalThis.localStorage) {
    try {
        const data = JSON.parse(storage?.getItem(ALARM_STORAGE_KEY) || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error('[AlarmStore] 读取闹钟数据失败', error);
        return {};
    }
}

export function writeAlarmData(data, storage = globalThis.localStorage) {
    try {
        storage?.setItem(ALARM_STORAGE_KEY, JSON.stringify(data));
        return Boolean(storage);
    } catch (error) {
        console.error('[AlarmStore] 保存闹钟数据失败', error);
        return false;
    }
}

export function applyTriggeredAlarmTaskState(task, now = Date.now()) {
    if (!task || typeof task !== 'object') return false;
    if (!task.config || typeof task.config !== 'object') task.config = {};

    if (task.type === 'countdown') {
        task.enabled = false;
        task.config.remainingSeconds = 0;
        delete task.config.deadlineAt;
    } else if (task.type === 'interval') {
        task.config.nextTriggerAt = now + Math.max(1, Number(task.config.intervalMs) || 1);
    } else if ((task.type === 'fixed' || task.type === 'hourly')
        && task.config.repeatEnabled === false) {
        task.enabled = false;
    }
    return true;
}

export function recordTriggeredAlarm(data, triggeredTask, now = Date.now()) {
    if (!data || typeof data !== 'object') return false;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const task = tasks.find(item => item.id === triggeredTask?.id);
    if (!task) return false;

    applyTriggeredAlarmTaskState(task, now);
    const today = new Date(now).toDateString();
    data.completedToday = data.lastDate === today ? (Number(data.completedToday) || 0) + 1 : 1;
    data.lastDate = today;
    return true;
}

export function recordTriggeredAlarmOnce(data, triggeredTask, now = Date.now()) {
    const triggerId = triggeredTask?.triggerId
        || `${triggeredTask?.id}:${triggeredTask?.config?.deadlineAt ?? triggeredTask?.config?.nextTriggerAt ?? Math.floor(now / 60_000)}`;
    const processed = Array.isArray(data.processedTriggers) ? data.processedTriggers : [];
    if (processed.includes(triggerId)) return false;
    data.processedTriggers = [...processed, triggerId].slice(-256);
    recordTriggeredAlarm(data, triggeredTask, Number(triggeredTask?.triggeredAt) || now);
    return true;
}
