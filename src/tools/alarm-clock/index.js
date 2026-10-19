import '../../css/tools/alarm-clock.css';
import '../../css/tool-motion.css';
import { mountSegmentedControl, transitionLayout } from '../../core/toolMotion.js';
import { registerTool } from '../toolRegistry.js';
import { showToast } from '../../core/utils.js';
import { getAlarmTemplate } from './template.js';
import { AlarmFormController } from './formController.js';
import { filterAlarmTasks, formatAlarmDuration, getAlarmScheduleLabel,
    renderAlarmTaskList, updateAlarmTaskCountdowns } from './taskListView.js';
import { AlarmAudioManager } from './audioManager.js';
import { pauseAlarmTask, restartCountdownTask, resumeAlarmTask, toggleAlarmTask } from './taskState.js';
import { ALARM_DATA_CHANGED_EVENT, ALARM_STORAGE_KEY, readAlarmData,
    reorderAlarmTasks, updateAlarmData } from '../../core/alarmStore.js';
import { ALARM_SYNC_STATUS_EVENT, ALARM_TRIGGER_EVENT, getAlarmSyncStatus,
    getAlarmRemainingSeconds, initializeAlarmService, normalizeAlarmTask,
    prepareAlarmTaskSchedule, stopAlarmAudio, syncAlarmTasks } from '../../core/alarmService.js';

const MAX_ALARM_TASKS = 200;
const audioManager = new AlarmAudioManager();
const alarmState = {
    tasks: [], completedToday: 0, completedDate: '', filter: 'all',
    countdownInterval: null, abortController: null, form: null, mutations: 0
};
const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const dueFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function setText(id, value) {
    const element = document.getElementById(id);
    const text = String(value);
    if (element && element.textContent !== text) element.textContent = text;
}

async function init() {
    destroy();
    const controller = new AbortController();
    alarmState.abortController = controller;
    await initializeAlarmService();
    const root = document.querySelector('.alarm-clock-view');
    if (controller.signal.aborted || !root) return;
    alarmState.filter = 'all';
    mountSegmentedControl(root.querySelector('.alarm-filter-tabs'), { signal: controller.signal });
    loadTasks();
    alarmState.form = new AlarmFormController(root, {
        signal: controller.signal, onSave: saveFormTask,
        loadAudioFiles: () => audioManager.loadAvailableFiles(),
        onPreview: async path => {
            try { await audioManager.preview(path); }
            catch { showToast('预览播放失败，请检查音频文件', 'error'); }
        },
        onStopPreview: () => audioManager.stopPreview(),
        onOpenFolder: async () => {
            try { await audioManager.openAudioFolder(); }
            catch (error) { showToast(String(error?.message || '打开音频文件夹失败'), 'error'); }
        },
        onSelectProgram: async () => {
            if (!window.__TAURI__?.dialog?.open) {
                showToast('请在桌面应用中选择程序或脚本', 'info');
                return null;
            }
            try {
                return await window.__TAURI__.dialog.open({ multiple: false, filters: [
                    { name: '可执行文件', extensions: ['exe', 'com', 'bat', 'cmd', 'ps1'] },
                    { name: '所有文件', extensions: ['*'] }
                ] });
            } catch (error) {
                showToast(String(error?.message || '选择文件失败'), 'error');
                return null;
            }
        }
    });
    root.querySelectorAll('[data-filter]').forEach(button => {
        button.addEventListener('click', () => {
            setFilter(button.dataset.filter);
            renderTaskList();
        }, { signal: controller.signal });
    });
    root.querySelector('#stopAllAlarmsBtn').addEventListener('click', () => {
        const hadLocalAudio = audioManager.hasActiveAudio;
        const stoppedShared = stopAlarmAudio();
        audioManager.stopAll();
        showToast(hadLocalAudio || stoppedShared ? '已停止所有提示音' : '当前没有正在播放的提示音', 'info');
    }, { signal: controller.signal });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshSharedTasks();
    }, { signal: controller.signal });
    renderTaskList();
    updateStats();
    updateAlarmSyncStatus(getAlarmSyncStatus());
    startGlobalCountdown();
}

async function saveFormTask(task, editingId) {
    const saved = await saveTasks({ mutate: tasks => {
        if (editingId) {
            const index = tasks.findIndex(item => item.id === editingId);
            if (index < 0) throw new Error('此提醒已在其他页面删除，请取消编辑后重新创建');
            const previous = tasks[index];
            Object.assign(task, { id: previous.id, createdAt: previous.createdAt,
                enabled: previous.enabled, paused: previous.enabled && previous.paused });
            if (task.paused) {
                task.pausedAt = Date.now();
                if (task.type === 'interval') task.config.remainingIntervalMs = task.config.intervalMs;
            }
            prepareAlarmTaskSchedule(task);
            tasks[index] = task;
        } else {
            if (tasks.length >= MAX_ALARM_TASKS) throw new Error('最多创建 200 个闹钟任务');
            prepareAlarmTaskSchedule(task);
            tasks.unshift(task);
        }
    } });
    if (saved) {
        if (editingId) stopTask(editingId);
        setFilter('all');
        renderTaskList();
        showToast(editingId ? '提醒已更新' : '提醒已创建', 'success');
    }
    return saved;
}

function stopTask(taskId) {
    audioManager.stop(taskId);
    stopAlarmAudio(taskId);
}

async function pauseTask(taskId) {
    if (await saveTasks({ mutate: tasks => Boolean(pauseAlarmTask(tasks, taskId)) })) stopTask(taskId);
}

async function resumeTask(taskId) {
    await saveTasks({ mutate: tasks => Boolean(resumeAlarmTask(tasks, taskId)) });
}

async function toggleTask(taskId) {
    await saveTasks({ mutate: tasks => Boolean(toggleAlarmTask(tasks, taskId)) });
}

async function deleteTask(taskId) {
    if (await saveTasks({ mutate: (tasks, data) => {
        data.tasks = tasks.filter(task => task.id !== taskId);
        return data.tasks.length !== tasks.length;
    } })) {
        stopTask(taskId);
        if (alarmState.form?.editingId === taskId) alarmState.form.reset();
        showToast('提醒已删除', 'info');
    }
}

async function saveTasks({ sync = true, mutate = () => false } = {}) {
    alarmState.mutations++;
    try {
        const { data, changed } = await updateAlarmData(data => mutate(data.tasks, data));
        loadTasks();
        renderTaskList();
        updateStats();
        if (sync && changed) syncAlarmTasks(data.tasks).catch(error => {
            console.error('[AlarmClock] 同步后台调度失败', error);
        });
        return true;
    } catch (error) {
        showToast(String(error?.message || error), 'error');
        loadTasks();
        renderTaskList();
        updateStats();
        return false;
    } finally {
        alarmState.mutations--;
    }
}

function loadTasks() {
    const data = readAlarmData();
    alarmState.tasks = (Array.isArray(data.tasks) ? data.tasks : [])
        .filter(task => task && typeof task === 'object' && typeof task.id === 'string')
        .slice(0, MAX_ALARM_TASKS);
    alarmState.completedDate = data.lastDate;
    alarmState.completedToday = Math.max(0, Number(data.completedToday) || 0);
    alarmState.tasks.forEach(task => {
        normalizeAlarmTask(task);
        prepareAlarmTaskSchedule(task);
    });
}

function setFilter(filter) {
    alarmState.filter = ['all', 'active', 'paused', 'completed'].includes(filter) ? filter : 'all';
    document.querySelectorAll('.alarm-filter-tabs [data-filter]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.filter === alarmState.filter));
    });
    document.querySelector('.alarm-list-footnote')?.classList.toggle('is-initially-hidden', alarmState.filter !== 'all');
}

function renderTaskList() {
    const panel = document.getElementById('taskListPanel');
    if (!panel) return;
    const tasks = filterAlarmTasks(alarmState.tasks, alarmState.filter);
    const paused = alarmState.tasks.filter(task => task.enabled && task.paused).length;
    setText('alarmTaskSummary', alarmState.tasks.length
        ? '共 ' + alarmState.tasks.length + ' 个提醒' + (paused ? ' · ' + paused + ' 个已暂停' : '')
        : '还没有提醒，开始安排吧。');
    transitionLayout(panel, () => renderAlarmTaskList(panel, tasks, {
        getCountdown: getTaskCountdown, onPause: pauseTask, onResume: resumeTask,
        onToggle: toggleTask, onDelete: deleteTask,
        onEdit: task => { void alarmState.form?.edit(task); },
        onCreate: () => {
            alarmState.form?.reset();
            document.getElementById('alarmTaskName')?.focus();
        },
        onRestart: task => saveTasks({ mutate: tasks => Boolean(restartCountdownTask(tasks, task.id)) }),
        reorderable: alarmState.filter === 'all',
        onReorder(tasks) {
            return saveTasks({ sync: false, mutate: (current, data) => {
                data.tasks = reorderAlarmTasks(current, tasks.map(task => task.id));
            } });
        }
    }), { signal: alarmState.abortController?.signal });
}

function getTaskCountdown(task) {
    if (!task.enabled) return task.type === 'countdown' && task.config.remainingSeconds <= 0 ? '00:00:00' : '--:--:--';
    const seconds = getAlarmRemainingSeconds(task, Date.now(), { includePaused: true });
    return Number.isFinite(seconds) ? formatAlarmDuration(seconds) : '--:--:--';
}

function updateStats() {
    const now = new Date();
    setText('activeTaskCount', alarmState.tasks.filter(task => task.enabled && !task.paused).length);
    setText('completedTodayCount', alarmState.completedDate === now.toDateString() ? alarmState.completedToday : 0);
    setText('alarmCurrentTime', clockFormat.format(now));
    setText('alarmCurrentDate', dateFormat.format(now));
    updateNextAlarmCountdown(now.getTime());
}

function updateNextAlarmCountdown(now = Date.now()) {
    let next = null, remaining = Infinity;
    for (const task of alarmState.tasks) {
        const seconds = getAlarmRemainingSeconds(task, now);
        if (seconds < remaining) { next = task; remaining = seconds; }
    }
    setText('nextAlarmCountdown', next ? formatAlarmDuration(remaining) : '--:--:--');
    setText('nextAlarmName', next ? next.name : '留一点时间，给重要的事。');
    setText('nextAlarmDetail', next
        ? dueFormat.format(new Date(now + remaining * 1000)) + ' 提醒 · ' + getAlarmScheduleLabel(next)
        : '创建一个提醒，从容安排接下来的时间。');
    document.querySelector('.alarm-next-card')?.classList.toggle('has-upcoming', Boolean(next));
}

// Rust owns execution. This single interval only refreshes the visible display.
function startGlobalCountdown() {
    if (alarmState.countdownInterval) clearInterval(alarmState.countdownInterval);
    alarmState.countdownInterval = setInterval(() => {
        if (document.hidden) return;
        updateAlarmTaskCountdowns(document.getElementById('taskListPanel'), alarmState.tasks, getTaskCountdown);
        updateStats();
    }, 1000);
}

function refreshSharedTasks() {
    if (!alarmState.abortController || alarmState.abortController.signal.aborted
        || alarmState.mutations || !document.getElementById('taskListPanel')) return;
    loadTasks();
    renderTaskList();
    updateStats();
}

function updateAlarmSyncStatus(status, { notify = false } = {}) {
    const element = document.getElementById('alarmSyncStatus');
    if (!element || !status) return;
    const labels = {
        idle: '调度就绪', syncing: '正在同步',
        retrying: '正在重试 ' + Math.min(status.attempt + 1, status.maxAttempts) + '/' + status.maxAttempts,
        synced: status.attempt > 1 ? '调度已恢复' : '调度已同步', failed: '调度未同步'
    };
    const icons = { idle: 'ri-check-line', syncing: 'ri-loader-4-line', retrying: 'ri-refresh-line',
        synced: 'ri-check-line', failed: 'ri-error-warning-line' };
    element.dataset.state = status.state;
    element.title = status.error ? String(status.error) : '';
    element.querySelector('i').className = icons[status.state] || icons.idle;
    element.querySelector('span').textContent = labels[status.state] || labels.idle;
    if (notify && status.state === 'failed') showToast('提醒已保存，后台调度暂未同步，正在等待恢复', 'error');
    else if (notify && status.state === 'synced' && status.attempt > 1) showToast('后台调度已恢复同步', 'success');
}

window.addEventListener(ALARM_DATA_CHANGED_EVENT, refreshSharedTasks);
window.addEventListener(ALARM_TRIGGER_EVENT, refreshSharedTasks);
window.addEventListener('storage', event => {
    if (event.key === ALARM_STORAGE_KEY || event.key === null) refreshSharedTasks();
});
window.addEventListener(ALARM_SYNC_STATUS_EVENT, event => updateAlarmSyncStatus(event.detail, { notify: true }));
window.addEventListener('dtkit:power-state', event => {
    if (event.detail?.suspended) {
        if (alarmState.countdownInterval) clearInterval(alarmState.countdownInterval);
        alarmState.countdownInterval = null;
        audioManager.suspend();
    } else if (alarmState.abortController && document.getElementById('taskListPanel')) {
        refreshSharedTasks();
        startGlobalCountdown();
    }
});

export async function handleBackgroundAlarmTrigger(task) {
    if (task.action !== 'sound') return;
    await audioManager.play({ ...task, __backendTriggered: true });
}

export function stopBackgroundAlarmAudio(taskId = null) {
    const hadAudio = audioManager.hasActiveAudio;
    if (taskId) audioManager.stop(taskId); else audioManager.stopAll();
    return hadAudio;
}

function serializePageDraft() {
    return { version: 1, ...alarmState.form?.serialize(), filter: alarmState.filter,
        workspaceScrollTop: document.querySelector('.alarm-clock-view')?.scrollTop || 0,
        configScrollTop: document.querySelector('.alarm-config-panel')?.scrollTop || 0,
        listScrollTop: document.getElementById('taskListPanel')?.scrollTop || 0 };
}

async function restorePageDraft(snapshot) {
    if (snapshot?.version !== 1 || !snapshot.fields || !alarmState.form) return;
    const form = alarmState.form;
    const draft = { ...snapshot };
    if (!alarmState.tasks.some(task => task.id === draft.editingId)) draft.editingId = null;
    await form.restore(draft);
    if (form !== alarmState.form || form.signal.aborted) return;
    setFilter(snapshot.filter);
    refreshSharedTasks();
    const config = document.querySelector('.alarm-config-panel');
    if (config) config.scrollTop = Math.max(0, Number(snapshot.configScrollTop) || 0);
    const list = document.getElementById('taskListPanel');
    if (list) list.scrollTop = Math.max(0, Number(snapshot.listScrollTop) || 0);
    const workspace = document.querySelector('.alarm-clock-view');
    if (workspace) workspace.scrollTop = Math.max(0, Number(snapshot.workspaceScrollTop) || 0);
}

function destroy() {
    if (alarmState.countdownInterval) clearInterval(alarmState.countdownInterval);
    alarmState.countdownInterval = null;
    alarmState.abortController?.abort();
    alarmState.abortController = null;
    alarmState.form = null;
    audioManager.suspend();
}

registerTool({
    id: 'alarm-clock', name: '定时闹钟', icon: 'ri-alarm-line',
    description: '创建倒计时、固定时间、整点报时、间隔提醒等定时任务',
    category: 'utility', template: getAlarmTemplate, init, destroy,
    serialize: serializePageDraft, restore: restorePageDraft
});
