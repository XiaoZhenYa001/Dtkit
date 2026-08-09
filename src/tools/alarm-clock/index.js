import '../../css/tools/alarm-clock.css';
/**
 * 定时闹钟工具
 * 支持倒计时、固定时间、整点报时、间隔提醒
 * 可执行：弹出通知、播放提示音、运行程序、关闭电脑、锁定屏幕
 */
import { registerTool } from '../toolRegistry.js';
import { showToast } from '../../core/utils.js';
import { getAlarmTemplate } from './template.js';
import {
    formatAlarmDuration,
    renderAlarmTaskList,
    updateAlarmTaskCountdowns
} from './taskListView.js';
import { AlarmAudioManager } from './audioManager.js';
import { renderAlarmActionConfig } from './actionConfigView.js';
import { createAlarmTask } from './taskFactory.js';
import {
    pauseAlarmTask,
    restartCountdownTask,
    resumeAlarmTask,
    toggleAlarmTask
} from './taskState.js';
import {
    applyTriggeredAlarmTaskState,
    readAlarmData,
    writeAlarmData
} from '../../core/alarmStore.js';
import {
    ALARM_SYNC_STATUS_EVENT,
    ALARM_TRIGGER_EVENT,
    getAlarmSyncStatus,
    getAlarmRemainingSeconds,
    normalizeAlarmTask,
    prepareAlarmTaskSchedule,
    syncAlarmTasks
} from '../../core/alarmService.js';

// ============================================
// 工具状态
// ============================================
let alarmState = {
    tasks: [],              // 任务列表
    completedToday: 0,      // 今日完成数
    countdownInterval: null, // 全局倒计时更新定时器
    abortController: null   // 用于清理事件监听器
};

const MAX_ALARM_TASKS = 200;
const audioManager = new AlarmAudioManager();

// 标记工具是否已经初始化过（用于区分首次加载和标签页切换）
let isToolInitialized = false;

// ============================================
// 音频文件管理
// ============================================

// 扫描并加载可用的音频文件
async function loadAvailableAudioFiles() {
    try {
        const audioFiles = await audioManager.loadAvailableFiles();
        console.log(`[AlarmClock] 加载了 ${audioFiles.length} 个音频文件`);
    } catch (err) {
        console.error('[AlarmClock] 加载音频文件失败:', err);
        audioManager.availableFiles = [];
    }
}

// 打开音频文件夹
async function openAudioFolder() {
    try {
        await audioManager.openAudioFolder();
        showToast('已打开音频文件夹', 'success');
    } catch (err) {
        console.error('[AlarmClock] 打开音频文件夹失败:', err);
        showToast('打开文件夹失败: ' + err, 'error');
    }
}

// ============================================
// 初始化函数
// ============================================
async function init() {
    console.log('[AlarmClock] 初始化定时闹钟工具');

    // 清理之前的事件监听器（防止重复绑定）
    if (alarmState.abortController) {
        alarmState.abortController.abort();
    }
    alarmState.abortController = new AbortController();

    // 只有首次加载时才从 localStorage 加载任务；调度由 Rust 后台负责。
    if (!isToolInitialized) {
        // 首次加载：加载音频文件列表
        await loadAvailableAudioFiles();

        // 加载任务并同步到 Rust 调度器
        loadTasks();
        isToolInitialized = true;
        showToast('定时闹钟工具已加载', 'success');
    }

    // 每次都需要重新绑定事件（因为 DOM 被重建了）
    bindEvents();

    // 渲染任务列表（显示当前内存中的任务状态）
    renderTaskList();

    // 启动全局倒计时更新（刷新 UI 显示）
    startGlobalCountdown();

    // 更新统计信息
    updateStats();
    updateAlarmSyncStatus(getAlarmSyncStatus());
}

// ============================================
// 事件绑定
// ============================================
function bindEvents() {
    const signal = alarmState.abortController?.signal;

    // 任务类型切换
    const taskTypeSelect = document.getElementById('alarmTaskType');
    if (taskTypeSelect) {
        taskTypeSelect.addEventListener('change', handleTaskTypeChange, { signal });
        // 初始化显示
        handleTaskTypeChange();
    }

    // 动作类型切换
    const actionTypeSelect = document.getElementById('alarmActionType');
    if (actionTypeSelect) {
        actionTypeSelect.addEventListener('change', handleActionTypeChange, { signal });
        // 初始化显示
        handleActionTypeChange();
    }

    // 添加任务按钮
    const addBtn = document.getElementById('addTaskBtn');
    if (addBtn) {
        addBtn.addEventListener('click', addTask, { signal });
    }

    // 停止所有闹钟按钮
    const stopAllBtn = document.getElementById('stopAllAlarmsBtn');
    if (stopAllBtn) {
        stopAllBtn.addEventListener('click', () => {
            if (!audioManager.hasActiveAudio) {
                showToast('当前没有正在播放的闹钟', 'info');
                return;
            }
            audioManager.stopAll();
            showToast('已停止所有闹钟', 'success');
        }, { signal });
    }

    // 重复开关
    const repeatEnabled = document.getElementById('repeatEnabled');
    if (repeatEnabled) {
        repeatEnabled.addEventListener('change', () => {
            const repeatDaysGroup = document.getElementById('repeatDaysGroup');
            if (repeatDaysGroup) {
                if (repeatEnabled.checked) {
                    repeatDaysGroup.style.display = 'flex';
                    // 触发重绘以确保动画执行
                    void repeatDaysGroup.offsetWidth;
                    repeatDaysGroup.style.opacity = '1';
                    repeatDaysGroup.style.transform = 'translateY(0)';
                } else {
                    repeatDaysGroup.style.opacity = '0';
                    repeatDaysGroup.style.transform = 'translateY(-10px)';
                    // 等待动画结束再隐藏
                    setTimeout(() => {
                        if (!repeatEnabled.checked) {
                            repeatDaysGroup.style.display = 'none';
                        }
                    }, 300);
                }
            }
        }, { signal });
    }
}

// ============================================
// 任务类型变化处理
// ============================================
function handleTaskTypeChange() {
    const taskType = document.getElementById('alarmTaskType')?.value;
    const timeInputLabel = document.getElementById('timeInputLabel');
    const timeInput = document.getElementById('alarmTimeInput');
    const countdownInputs = document.getElementById('countdownInputs');
    const intervalInputs = document.getElementById('intervalInputs');
    const repeatOptions = document.querySelector('.alarm-repeat-options');

    // 隐藏所有特殊输入
    if (timeInput) timeInput.style.display = 'none';
    if (countdownInputs) countdownInputs.style.display = 'none';
    if (intervalInputs) intervalInputs.style.display = 'none';

    switch (taskType) {
        case 'countdown':
            if (timeInputLabel) timeInputLabel.textContent = '倒计时时长';
            if (countdownInputs) countdownInputs.style.display = 'flex';
            if (repeatOptions) repeatOptions.style.display = 'none';
            break;
        case 'fixed':
            if (timeInputLabel) timeInputLabel.textContent = '每天执行时间';
            if (timeInput) timeInput.style.display = 'block';
            if (repeatOptions) repeatOptions.style.display = 'flex';
            break;
        case 'hourly':
            if (timeInputLabel) timeInputLabel.textContent = '整点报时设置';
            if (repeatOptions) repeatOptions.style.display = 'flex';
            // 整点报时不需要时间输入
            break;
        case 'interval':
            if (timeInputLabel) timeInputLabel.textContent = '提醒间隔';
            if (intervalInputs) intervalInputs.style.display = 'flex';
            if (repeatOptions) repeatOptions.style.display = 'none';
            break;
    }
}
// ============================================
// 动作类型变化处理
// ============================================
async function handleActionTypeChange() {
    const actionType = document.getElementById('alarmActionType')?.value;
    const configArea = document.getElementById('actionConfigArea');

    if (!configArea) return;
    if (actionType === 'sound') {
        await loadAvailableAudioFiles();
        if (document.getElementById('alarmActionType')?.value !== actionType) return;
    }
    const canCreate = renderAlarmActionConfig(
        configArea,
        actionType,
        audioManager.availableFiles,
        {
            signal: alarmState.abortController?.signal,
            onPreview: playPreviewAudio,
            onOpenFolder: openAudioFolder,
            onSelectProgram: selectProgramFile
        }
    );
    const addButton = document.getElementById('addTaskBtn');
    if (addButton) {
        addButton.disabled = !canCreate;
        addButton.title = canCreate ? '' : '请先将提示音添加到 Kits/Alarm 文件夹';
    }
}

// 播放预览音频
async function playPreviewAudio(audioPath) {
    try {
        await audioManager.preview(audioPath);
    } catch (err) {
        console.error('[AlarmClock] 预览播放失败:', err);
        showToast('预览播放失败', 'error');
    }
}

// ============================================
// 文件选择
// ============================================
async function selectProgramFile() {
    try {
        const result = await window.__TAURI__.dialog.open({
            multiple: false,
            filters: [
                { name: '可执行文件', extensions: ['exe', 'com', 'bat', 'cmd', 'ps1'] },
                { name: '所有文件', extensions: ['*'] }
            ]
        });

        if (result) {
            const pathDisplay = document.getElementById('selectedFilePath');
            if (pathDisplay) {
                pathDisplay.textContent = result;
                pathDisplay.title = result;
            }
        }
    } catch (err) {
        console.error('[AlarmClock] 选择文件失败:', err);
        showToast('选择文件失败', 'error');
    }
}

// ============================================
// 添加任务
// ============================================
function addTask() {
    if (alarmState.tasks.length >= MAX_ALARM_TASKS) {
        showToast(`最多创建 ${MAX_ALARM_TASKS} 个闹钟任务`, 'warning');
        return;
    }

    const selectedAudio = document.querySelector('.alarm-audio-item.selected');
    const fallbackAudio = audioManager.availableFiles[0];
    const { task, error } = createAlarmTask({
        name: document.getElementById('alarmTaskName')?.value,
        type: document.getElementById('alarmTaskType')?.value,
        action: document.getElementById('alarmActionType')?.value,
        hours: document.getElementById('countdownHours')?.value,
        minutes: document.getElementById('countdownMinutes')?.value,
        seconds: document.getElementById('countdownSeconds')?.value,
        time: document.getElementById('alarmTimeInput')?.value,
        intervalValue: document.getElementById('intervalValue')?.value,
        intervalUnit: document.getElementById('intervalUnit')?.value || 'minutes',
        repeatEnabled: document.getElementById('repeatEnabled')?.checked !== false,
        repeatDays: getSelectedRepeatDays(),
        audio: selectedAudio
            ? { path: selectedAudio.dataset.audioPath, name: selectedAudio.dataset.audioName }
            : fallbackAudio,
        filePath: document.getElementById('selectedFilePath')?.textContent
    });
    if (error) {
        showToast(error, 'warning');
        return;
    }

    // 添加到任务列表顶部（新任务在最前面）
    alarmState.tasks.unshift(task);

    // 计算下一次触发时间并交给 Rust 调度器
    startTask(task);

    // 保存并同步任务
    saveTasks();

    // 重新渲染列表
    renderTaskList();

    // 更新统计
    updateStats();

    // 重置表单
    resetForm();

    showToast(`任务"${task.name}"已添加`, 'success');
}

// ============================================
// 获取选中的重复日期
// ============================================
function getSelectedRepeatDays() {
    if (document.getElementById('repeatEnabled')?.checked === false) return [];
    const days = [];
    const checkboxes = document.querySelectorAll('input[name="repeatDay"]:checked');
    checkboxes.forEach(cb => days.push(parseInt(cb.value)));
    return days;
}

// ============================================
// 重置表单
// ============================================
function resetForm() {
    const taskName = document.getElementById('alarmTaskName');
    if (taskName) taskName.value = '';

    const countdownHours = document.getElementById('countdownHours');
    const countdownMinutes = document.getElementById('countdownMinutes');
    const countdownSeconds = document.getElementById('countdownSeconds');
    if (countdownHours) countdownHours.value = '0';
    if (countdownMinutes) countdownMinutes.value = '5';
    if (countdownSeconds) countdownSeconds.value = '0';

    const repeatEnabled = document.getElementById('repeatEnabled');
    if (repeatEnabled) repeatEnabled.checked = true;
}

// ============================================
// 启动任务
// ============================================
function startTask(task, options) {
    if (!task.enabled) return;
    prepareAlarmTaskSchedule(task, options);
}

// ============================================
// 停止任务
// ============================================
function stopTask(taskId) {
    console.log(`[AlarmClock] 停止任务: ${taskId}`);
    audioManager.stop(taskId);
}

// ============================================
// 暂停任务
// ============================================
function pauseTask(taskId) {
    const task = pauseAlarmTask(alarmState.tasks, taskId);
    if (!task) return;

    saveTasks();
    renderTaskList();
    updateStats();
    console.log(`[AlarmClock] 任务已暂停: ${task.name}`);
}

// ============================================
// 恢复任务
// ============================================
function resumeTask(taskId) {
    const task = resumeAlarmTask(alarmState.tasks, taskId);
    if (!task) return;

    saveTasks();
    renderTaskList();
    updateStats();
    console.log(`[AlarmClock] 任务已恢复: ${task.name}`);
}

// ============================================
// 切换任务状态（启用/禁用）
// ============================================
function toggleTask(taskId) {
    const task = toggleAlarmTask(alarmState.tasks, taskId);
    if (!task) return;
    if (!task.enabled) stopTask(taskId);

    saveTasks();
    renderTaskList();
    updateStats();
}

// ============================================
// 删除任务
// ============================================
function deleteTask(taskId) {
    stopTask(taskId);
    alarmState.tasks = alarmState.tasks.filter(t => t.id !== taskId);
    saveTasks();
    renderTaskList();
    updateStats();
    showToast('任务已删除', 'info');
}

// ============================================
// 保存任务到 localStorage
// ============================================
function saveTasks({ sync = true } = {}) {
    const data = {
        tasks: alarmState.tasks,
        completedToday: alarmState.completedToday,
        lastDate: new Date().toDateString()
    };
    if (!writeAlarmData(data)) {
        showToast('保存闹钟数据失败，请检查可用存储空间', 'error');
        return false;
    }
    if (sync) {
        syncAlarmTasks(alarmState.tasks).catch(error => {
            console.error('[AlarmClock] 同步 Rust 调度器失败', error);
        });
    }
    return true;
}

// ============================================
// 加载任务
// ============================================
function loadTasks() {
    try {
        const data = readAlarmData();
        if (Object.keys(data).length === 0) return;
        alarmState.tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, MAX_ALARM_TASKS) : [];

        // 检查日期，重置今日计数
        if (data.lastDate === new Date().toDateString()) {
            alarmState.completedToday = Number(data.completedToday) || 0;
        } else {
            alarmState.completedToday = 0;
        }

        // 为旧数据补齐绝对截止时间；不在前端启动任何后台计时器。
        alarmState.tasks.forEach(task => {
            normalizeAlarmTask(task);
            if (task.enabled) startTask(task);
        });
        saveTasks();
    } catch (err) {
        console.error('[AlarmClock] 加载任务失败:', err);
        alarmState.tasks = [];
    }
}

// ============================================
// 渲染任务列表
// ============================================
function renderTaskList() {
    const panel = document.getElementById('taskListPanel');
    if (!panel) return;

    renderAlarmTaskList(panel, alarmState.tasks, {
        getCountdown: getTaskCountdown,
        onPause: pauseTask,
        onResume: resumeTask,
        onToggle: toggleTask,
        onRestart(task) {
            if (!restartCountdownTask(alarmState.tasks, task.id)) return;
            saveTasks();
            renderTaskList();
            updateStats();
        },
        onDelete: deleteTask,
        onReorder(tasks) {
            alarmState.tasks = tasks;
            saveTasks({ sync: false });
        }
    });
}

// ============================================
// 获取任务倒计时显示
// ============================================
function getTaskCountdown(task) {
    if (!task.enabled) return '--:--:--';
    const remainingSeconds = getAlarmRemainingSeconds(task, Date.now(), { includePaused: true });
    return Number.isFinite(remainingSeconds) ? formatAlarmDuration(remainingSeconds) : '--:--:--';
}

// ============================================
// 格式化秒数
// ============================================
// ============================================
// 更新统计信息
// ============================================
function updateStats() {
    const activeCount = alarmState.tasks.filter(t => t.enabled).length;
    const activeEl = document.getElementById('activeTaskCount');
    const completedEl = document.getElementById('completedTodayCount');

    if (activeEl) activeEl.textContent = activeCount;
    if (completedEl) completedEl.textContent = alarmState.completedToday;

    updateNextAlarmCountdown();
}

// ============================================
// 更新下一个提醒倒计时
// ============================================
function updateNextAlarmCountdown() {
    const countdownEl = document.getElementById('nextAlarmCountdown');
    if (!countdownEl) return;

    let minSeconds = Infinity;

    alarmState.tasks.forEach(task => {
        const remainingSeconds = getAlarmRemainingSeconds(task);
        if (remainingSeconds < minSeconds) minSeconds = remainingSeconds;
    });

    if (minSeconds === Infinity) {
        countdownEl.textContent = '--:--:--';
    } else {
        countdownEl.textContent = formatAlarmDuration(minSeconds);
    }
}

// ============================================
// 启动全局倒计时更新
// ============================================
function startGlobalCountdown() {
    if (alarmState.countdownInterval) {
        clearInterval(alarmState.countdownInterval);
    }

    alarmState.countdownInterval = setInterval(() => {
        updateAlarmTaskCountdowns(
            document.getElementById('taskListPanel'),
            alarmState.tasks,
            getTaskCountdown
        );

        // 更新统计区域的倒计时
        updateNextAlarmCountdown();
    }, 1000);
}

function applyTriggeredTaskState(triggeredTask) {
    const task = alarmState.tasks.find(item => item.id === triggeredTask.id);
    if (!applyTriggeredAlarmTaskState(task)) return;

    alarmState.completedToday++;
    if (document.getElementById('taskListPanel')) renderTaskList();
    updateStats();
}

function updateAlarmSyncStatus(status, { notify = false } = {}) {
    const element = document.getElementById('alarmSyncStatus');
    if (!element || !status) return;
    const icon = element.querySelector('i');
    const label = element.querySelector('span');
    const labels = {
        idle: '调度就绪',
        syncing: '正在同步',
        retrying: `正在重试 ${Math.min(status.attempt + 1, status.maxAttempts)}/${status.maxAttempts}`,
        synced: status.attempt > 1 ? '调度已恢复' : '调度已同步',
        failed: '调度未同步'
    };
    const icons = {
        idle: 'ri-check-line',
        syncing: 'ri-loader-4-line',
        retrying: 'ri-refresh-line',
        synced: 'ri-check-line',
        failed: 'ri-error-warning-line'
    };
    element.dataset.state = status.state;
    element.title = status.error ? String(status.error) : '';
    if (icon) icon.className = icons[status.state] || icons.idle;
    if (label) label.textContent = labels[status.state] || labels.idle;

    if (notify && status.state === 'failed') {
        showToast('任务已保存，但后台调度同步失败；请保持应用开启并稍后重试', 'error');
    } else if (notify && status.state === 'synced' && status.attempt > 1) {
        showToast('后台调度已恢复同步', 'success');
    }
}

window.addEventListener(ALARM_TRIGGER_EVENT, event => {
    applyTriggeredTaskState(event.detail);
});

window.addEventListener(ALARM_SYNC_STATUS_EVENT, event => {
    updateAlarmSyncStatus(event.detail, { notify: true });
});

window.addEventListener('dtkit:power-state', event => {
    if (event.detail?.suspended) {
        if (alarmState.countdownInterval) {
            clearInterval(alarmState.countdownInterval);
            alarmState.countdownInterval = null;
        }
        audioManager.suspend();
    } else if (document.getElementById('taskListPanel')) {
        startGlobalCountdown();
        updateStats();
    }
});

export async function handleBackgroundAlarmTrigger(task) {
    if (task.action !== 'sound') return;
    if (audioManager.availableFiles.length === 0) await loadAvailableAudioFiles();
    task.__backendTriggered = true;
    await audioManager.play(task);
}

// ============================================
// 销毁函数
// ============================================
function destroy() {
    console.log('[AlarmClock] 销毁定时闹钟工具');

    // 清除全局倒计时更新
    if (alarmState.countdownInterval) {
        clearInterval(alarmState.countdownInterval);
        alarmState.countdownInterval = null;
    }

    // 取消所有事件监听器
    if (alarmState.abortController) {
        alarmState.abortController.abort();
        alarmState.abortController = null;
    }

    audioManager.suspend();

    // 注意：不清除任务定时器和音频循环，让它们在后台继续运行
    // 这样即使切换到其他工具，定时任务仍然会执行

    // 注意：不关闭 AudioContext，因为后台任务可能需要播放声音
}

// ============================================
// 注册工具
// ============================================
registerTool({
    id: 'alarm-clock',
    name: '定时闹钟',
    icon: 'ri-alarm-line',
    description: '创建倒计时、固定时间、整点报时、间隔提醒等定时任务',
    category: 'utility',
    template: getAlarmTemplate,
    init,
    destroy
});
