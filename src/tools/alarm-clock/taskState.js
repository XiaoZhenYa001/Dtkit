import {
    pauseAlarmTaskSchedule,
    prepareAlarmTaskSchedule
} from '../../core/alarmService.js';

function findTask(tasks, taskId) {
    return tasks.find(task => task.id === taskId) || null;
}

export function pauseAlarmTask(tasks, taskId, now = Date.now()) {
    const task = findTask(tasks, taskId);
    if (!task?.enabled) return null;
    task.paused = true;
    task.pausedAt = now;
    pauseAlarmTaskSchedule(task, now);
    return task;
}

export function resumeAlarmTask(tasks, taskId, now = Date.now()) {
    const task = findTask(tasks, taskId);
    if (!task?.enabled) return null;
    task.paused = false;
    delete task.pausedAt;
    prepareAlarmTaskSchedule(task, { restart: true, now });
    return task;
}

export function toggleAlarmTask(tasks, taskId, now = Date.now()) {
    const task = findTask(tasks, taskId);
    if (!task) return null;
    task.enabled = !task.enabled;
    if (!task.enabled) return task;

    task.paused = false;
    delete task.pausedAt;
    if (task.type === 'countdown' && task.config.remainingSeconds <= 0) {
        task.config.remainingSeconds = task.config.totalSeconds;
    }
    prepareAlarmTaskSchedule(task, { restart: true, now });
    return task;
}

export function restartCountdownTask(tasks, taskId, now = Date.now()) {
    const task = findTask(tasks, taskId);
    if (!task || task.type !== 'countdown') return null;
    task.config.remainingSeconds = task.config.totalSeconds;
    if (task.enabled) {
        prepareAlarmTaskSchedule(task, { restart: true, now });
        return task;
    }
    return toggleAlarmTask(tasks, taskId, now);
}
