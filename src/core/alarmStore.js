export const ALARM_STORAGE_KEY = 'alarm_clock_data';

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
