import '../../css/tools/alarm-clock.css';
/**
 * 定时闹钟工具
 * 支持倒计时、固定时间、整点报时、间隔提醒
 * 可执行：弹出通知、播放提示音、运行程序、关闭电脑、锁定屏幕
 */
import { registerTool } from '../toolRegistry.js';
import { showToast } from '../../core/utils.js';
import {
    ALARM_TRIGGER_EVENT,
    getAlarmRemainingSeconds,
    normalizeAlarmTask,
    pauseAlarmTaskSchedule,
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
    abortController: null,  // 用于清理事件监听器
    activeLoopControllers: new Map(), // 音频循环控制器 { taskId: controller }
    currentPlayingAudio: null,        // 当前正在播放的音频控制器
    audioQueue: [],         // 音频播放队列
    audioQueueProcessing: false,
    availableAudioFiles: [], // 可用的音频文件列表
    blobUrls: new Map()     // Blob URL 跟踪器 { url: true } - 用于防止内存泄漏
};

const MAX_AUDIO_QUEUE_SIZE = 5;
const MAX_ALARM_TASKS = 200;

// 标记工具是否已经初始化过（用于区分首次加载和标签页切换）
let isToolInitialized = false;

// ============================================
// 音频文件管理
// ============================================

// 扫描并加载可用的音频文件
async function loadAvailableAudioFiles() {
    try {
        if (!window.__TAURI__) {
            console.log('[AlarmClock] 非Tauri环境，使用默认音频列表');
            alarmState.availableAudioFiles = [
                { name: '默认提示音', path: '', size: 0 }
            ];
            return;
        }

        const audioFiles = await window.__TAURI__.core.invoke('scan_audio_files');
        alarmState.availableAudioFiles = audioFiles;
        console.log(`[AlarmClock] 加载了 ${audioFiles.length} 个音频文件`);
    } catch (err) {
        console.error('[AlarmClock] 加载音频文件失败:', err);
        alarmState.availableAudioFiles = [];
    }
}

// 打开音频文件夹
async function openAudioFolder() {
    try {
        if (!window.__TAURI__) {
            showToast('此功能需要在Tauri环境中使用', 'error');
            return;
        }

        await window.__TAURI__.core.invoke('open_audio_folder');
        showToast('已打开音频文件夹', 'success');
    } catch (err) {
        console.error('[AlarmClock] 打开音频文件夹失败:', err);
        showToast('打开文件夹失败: ' + err, 'error');
    }
}

// 释放 Blob URL 以防止内存泄漏
function revokeBlobUrl(url) {
    if (url && url.startsWith('blob:')) {
        try {
            URL.revokeObjectURL(url);
            alarmState.blobUrls.delete(url);
            console.log('[AlarmClock] 释放 Blob URL:', url.substring(0, 50) + '...');
        } catch (e) {
            // 忽略错误
        }
    }
}

// 任务类型映射
const TASK_TYPES = {
    countdown: '倒计时',
    fixed: '固定时间',
    hourly: '整点报时',
    interval: '间隔提醒'
};

// 动作类型映射
const ACTION_TYPES = {
    notify: '弹出消息通知',
    sound: '播放提示音',
    run: '运行程序或脚本',
    shutdown: '关闭电脑',
    lock: '锁定屏幕'
};

// ============================================
// HTML 模板
// ============================================
function getTemplate() {
    return `
        <div class="view-container alarm-clock-view">
            <!-- 顶部统计栏 -->
            <div class="alarm-header-stats">
                <div class="alarm-stat-card">
                    <div class="alarm-stat-label">活跃任务</div>
                    <div class="alarm-stat-value" id="activeTaskCount">0</div>
                </div>
                <div class="alarm-stat-card">
                    <div class="alarm-stat-label">今日已完成</div>
                    <div class="alarm-stat-value" id="completedTodayCount">0</div>
                </div>
                <div class="alarm-stat-card">
                    <div class="alarm-stat-label">距离下个提醒</div>
                    <div class="alarm-stat-value alarm-stat-value--accent" id="nextAlarmCountdown">--:--:--</div>
                </div>
                <button id="stopAllAlarmsBtn" class="alarm-stop-all-btn" title="停止所有正在播放的闹钟">
                    <i class="ri-stop-circle-line"></i> 停止所有闹钟
                </button>
            </div>

            <!-- 主体布局 -->
            <div class="alarm-main-container">
                <!-- 左侧配置面板 -->
                <div class="alarm-config-panel">
                    <h3 class="alarm-panel-title">
                        <i class="ri-add-circle-line"></i> 新建定时任务
                    </h3>

                    <div class="alarm-input-group">
                        <label class="alarm-label">任务名称</label>
                        <input type="text" id="alarmTaskName" class="alarm-input" maxlength="80"
                            placeholder="例如：该喝水了、下班打卡...">
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label">定时类型</label>
                        <select id="alarmTaskType" class="alarm-select">
                            <option value="countdown">倒计时</option>
                            <option value="fixed">固定时间</option>
                            <option value="hourly">整点报时</option>
                            <option value="interval">间隔提醒</option>
                        </select>
                    </div>

                    <div class="alarm-input-group" id="timeInputGroup">
                        <label class="alarm-label" id="timeInputLabel">设定时间</label>
                        <input type="time" id="alarmTimeInput" class="alarm-input" value="09:00">
                        <!-- 倒计时专用输入 -->
                        <div id="countdownInputs" class="alarm-countdown-inputs is-initially-hidden">
                            <input type="number" id="countdownHours" class="alarm-input alarm-input--small"
                                min="0" max="23" value="0" placeholder="时">
                            <span class="alarm-time-sep">:</span>
                            <input type="number" id="countdownMinutes" class="alarm-input alarm-input--small"
                                min="0" max="59" value="5" placeholder="分">
                            <span class="alarm-time-sep">:</span>
                            <input type="number" id="countdownSeconds" class="alarm-input alarm-input--small"
                                min="0" max="59" value="0" placeholder="秒">
                        </div>
                        <!-- 间隔提醒专用输入 -->
                        <div id="intervalInputs" class="alarm-interval-inputs is-initially-hidden">
                            <span class="alarm-interval-text">每隔</span>
                            <input type="number" id="intervalValue" class="alarm-input alarm-input--small"
                                min="1" max="999" value="30">
                            <select id="intervalUnit" class="alarm-select alarm-select--small">
                                <option value="minutes">分钟</option>
                                <option value="hours">小时</option>
                            </select>
                            <span class="alarm-interval-text">提醒一次</span>
                        </div>
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label">执行动作</label>
                        <select id="alarmActionType" class="alarm-select">
                            <option value="notify">弹出消息通知</option>
                            <option value="sound">播放提示音</option>
                            <option value="run">运行程序或脚本</option>
                            <option value="shutdown">关闭电脑 (Shutdown)</option>
                            <option value="lock">锁定屏幕</option>
                        </select>
                    </div>

                    <!-- 动态配置区域 -->
                    <div id="actionConfigArea" class="alarm-action-config">
                        <!-- 根据选择的动作类型动态显示 -->
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label">重复设置</label>
                        <div class="alarm-repeat-options">
                            <label class="alarm-checkbox-label">
                                <input type="checkbox" id="repeatEnabled" checked>
                                <span>启用重复</span>
                            </label>
                            <div id="repeatDaysGroup" class="alarm-repeat-days">
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="1" checked>
                                    <span>一</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="2" checked>
                                    <span>二</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="3" checked>
                                    <span>三</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="4" checked>
                                    <span>四</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="5" checked>
                                    <span>五</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="6">
                                    <span>六</span>
                                </label>
                                <label class="alarm-day-checkbox">
                                    <input type="checkbox" name="repeatDay" value="0">
                                    <span>日</span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <button id="addTaskBtn" class="alarm-btn-add">
                        <i class="ri-add-line"></i> 添加到任务列表
                    </button>
                </div>

                <!-- 右侧任务列表 -->
                <div class="alarm-list-panel" id="taskListPanel">
                    <div class="alarm-list-empty" id="emptyListHint">
                        <i class="ri-alarm-line"></i>
                        <p>暂无定时任务</p>
                        <p class="alarm-list-empty-sub">在左侧创建你的第一个任务吧</p>
                    </div>
                    <!-- 任务项将动态添加到这里 -->
                </div>
            </div>
        </div>
    `;
}

// ============================================
// CSS 样式
// ============================================


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
            if (alarmState.activeLoopControllers.size === 0 && !alarmState.currentPlayingAudio) {
                showToast('当前没有正在播放的闹钟', 'info');
                return;
            }
            stopAllAudio();
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
function handleActionTypeChange() {
    const actionType = document.getElementById('alarmActionType')?.value;
    const configArea = document.getElementById('actionConfigArea');

    if (!configArea) return;

    // 清空配置区域
    configArea.innerHTML = '';

    switch (actionType) {
        case 'sound':
            // 显示音频文件选择器
            const audioListHTML = alarmState.availableAudioFiles.length > 0
                ? alarmState.availableAudioFiles.map((audio, index) => `
                    <div class="alarm-audio-item ${index === 0 ? 'selected' : ''}"
                        data-audio-path="${audio.path}"
                        data-audio-name="${audio.name}">
                        <div class="alarm-audio-icon">
                            <i class="ri-music-2-line"></i>
                        </div>
                        <div class="alarm-audio-info">
                            <div class="alarm-audio-name">${audio.name}</div>
                            <div class="alarm-audio-size">${formatFileSize(audio.size)}</div>
                        </div>
                        <button class="alarm-audio-preview-btn" data-audio-path="${audio.path}">
                            <i class="ri-play-line"></i>
                        </button>
                    </div>
                `).join('')
                : `
                    <div class="alarm-no-audio">
                        <i class="ri-music-line alarm-audio-empty__icon"></i>
                        <p>未找到音频文件</p>
                        <p class="alarm-audio-empty__hint">请将音频放入应用数据目录的 Kits/Alarm 文件夹</p>
                    </div>
                `;

            configArea.innerHTML = `
                <div class="alarm-input-group">
                    <label class="alarm-label">
                        选择提示音
                        <button class="alarm-open-folder-btn" id="openAudioFolderBtn" title="打开音频文件夹">
                            <i class="ri-folder-open-line"></i>
                        </button>
                    </label>
                    <div class="alarm-audio-list" id="audioList">
                        ${audioListHTML}
                    </div>
                </div>
            `;
            // 绑定音频选择事件
            bindAudioOptions();
            break;

        case 'run':
            // 显示文件选择器
            configArea.innerHTML = `
                <div class="alarm-input-group">
                    <label class="alarm-label">选择程序或脚本</label>
                    <div class="alarm-file-picker">
                        <div class="alarm-file-path" id="selectedFilePath">未选择文件</div>
                        <button class="alarm-file-btn" id="selectFileBtn">
                            <i class="ri-folder-open-line"></i> 浏览
                        </button>
                    </div>
                </div>
            `;
            // 绑定文件选择事件
            bindFileSelector();
            break;

        case 'notify':
        case 'shutdown':
        case 'lock':
        default:
            // 不需要额外配置
            break;
    }
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// ============================================
// 音频选择绑定
// ============================================
function bindAudioOptions() {
    const signal = alarmState.abortController?.signal;

    // 音频项选择
    const audioItems = document.querySelectorAll('.alarm-audio-item');
    audioItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // 如果点击的是预览按钮，不切换选中状态
            if (e.target.closest('.alarm-audio-preview-btn')) return;

            audioItems.forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
        }, { signal });
    });

    // 预览按钮
    const previewBtns = document.querySelectorAll('.alarm-audio-preview-btn');
    previewBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const audioPath = btn.dataset.audioPath;
            playPreviewAudio(audioPath);
        }, { signal });
    });

    // 打开文件夹按钮
    const openFolderBtn = document.getElementById('openAudioFolderBtn');
    if (openFolderBtn) {
        openFolderBtn.addEventListener('click', async () => {
            await openAudioFolder();
        }, { signal });
    }
}

// 预览音频播放器
let previewAudio = null;
let previewAudioBlobUrl = null; // 跟踪预览音频的 Blob URL

// 播放预览音频
async function playPreviewAudio(audioPath) {
    // 停止之前的预览并清理
    if (previewAudio) {
        previewAudio.pause();
        previewAudio.src = '';
        previewAudio = null;
    }
    // 释放之前的 Blob URL
    if (previewAudioBlobUrl) {
        revokeBlobUrl(previewAudioBlobUrl);
        previewAudioBlobUrl = null;
    }

    if (!audioPath) return;

    previewAudio = new Audio();
    const convertedPath = await convertPath(audioPath);
    // 记录 Blob URL 以便后续清理
    if (convertedPath.startsWith('blob:')) {
        previewAudioBlobUrl = convertedPath;
    }
    previewAudio.src = convertedPath;
    previewAudio.volume = 0.5;

    // 只播放3秒作为预览
    previewAudio.play().catch(err => {
        console.error('[AlarmClock] 预览播放失败:', err);
        showToast('预览播放失败', 'error');
    });

    setTimeout(() => {
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            previewAudio = null;
        }
        // 释放 Blob URL
        if (previewAudioBlobUrl) {
            revokeBlobUrl(previewAudioBlobUrl);
            previewAudioBlobUrl = null;
        }
    }, 3000);
}

// ============================================
// 文件选择绑定
// ============================================
function bindFileSelector() {
    const signal = alarmState.abortController?.signal;
    const selectBtn = document.getElementById('selectFileBtn');
    if (selectBtn) {
        selectBtn.addEventListener('click', async () => {
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
        }, { signal });
    }
}

// ============================================
// 添加任务
// ============================================
function addTask() {
    const taskName = document.getElementById('alarmTaskName')?.value.trim();
    const taskType = document.getElementById('alarmTaskType')?.value;
    const actionType = document.getElementById('alarmActionType')?.value;

    if (!taskName) {
        showToast('请输入任务名称', 'warning');
        return;
    }

    if (alarmState.tasks.length >= MAX_ALARM_TASKS) {
        showToast(`最多创建 ${MAX_ALARM_TASKS} 个闹钟任务`, 'warning');
        return;
    }

    // 构建任务对象
    const task = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: taskName,
        type: taskType,
        action: actionType,
        enabled: true,
        paused: false,  // 新增：暂停状态
        createdAt: new Date().toISOString(),
        config: {}
    };

    // 根据任务类型获取时间配置
    switch (taskType) {
        case 'countdown':
            const hours = Number(document.getElementById('countdownHours')?.value || 0);
            const minutes = Number(document.getElementById('countdownMinutes')?.value || 0);
            const seconds = Number(document.getElementById('countdownSeconds')?.value || 0);
            if (!Number.isInteger(hours) || hours < 0 || hours > 23
                || !Number.isInteger(minutes) || minutes < 0 || minutes > 59
                || !Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
                showToast('倒计时时间超出有效范围', 'warning');
                return;
            }
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;

            if (totalSeconds <= 0) {
                showToast('请设置有效的倒计时时长', 'warning');
                return;
            }

            task.config.totalSeconds = totalSeconds;
            task.config.remainingSeconds = totalSeconds;
            break;

        case 'fixed':
            const timeValue = document.getElementById('alarmTimeInput')?.value;
            if (!timeValue) {
                showToast('请设置执行时间', 'warning');
                return;
            }
            task.config.time = timeValue;
            task.config.repeatEnabled = document.getElementById('repeatEnabled')?.checked !== false;
            task.config.repeatDays = getSelectedRepeatDays();
            if (task.config.repeatEnabled && task.config.repeatDays.length === 0) {
                showToast('重复提醒至少选择一天', 'warning');
                return;
            }
            break;

        case 'hourly':
            task.config.repeatEnabled = document.getElementById('repeatEnabled')?.checked !== false;
            task.config.repeatDays = getSelectedRepeatDays();
            if (task.config.repeatEnabled && task.config.repeatDays.length === 0) {
                showToast('重复提醒至少选择一天', 'warning');
                return;
            }
            break;

        case 'interval':
            const intervalValue = Number(document.getElementById('intervalValue')?.value || 30);
            const intervalUnit = document.getElementById('intervalUnit')?.value || 'minutes';
            if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 999) {
                showToast('提醒间隔必须是 1 到 999 的整数', 'warning');
                return;
            }
            const intervalMs = intervalUnit === 'hours'
                ? intervalValue * 3600 * 1000
                : intervalValue * 60 * 1000;

            task.config.intervalMs = intervalMs;
            task.config.intervalValue = intervalValue;
            task.config.intervalUnit = intervalUnit;
            break;
    }

    // 根据动作类型获取额外配置
    switch (actionType) {
        case 'sound':
            const selectedAudio = document.querySelector('.alarm-audio-item.selected');
            if (selectedAudio) {
                task.config.audioPath = selectedAudio.dataset.audioPath;
                task.config.audioName = selectedAudio.dataset.audioName;
            } else if (alarmState.availableAudioFiles.length > 0) {
                // 默认选择第一个音频
                task.config.audioPath = alarmState.availableAudioFiles[0].path;
                task.config.audioName = alarmState.availableAudioFiles[0].name;
            }
            break;

        case 'run':
            const filePath = document.getElementById('selectedFilePath')?.textContent;
            if (filePath === '未选择文件' || !filePath) {
                showToast('请选择要运行的程序', 'warning');
                return;
            }
            task.config.filePath = filePath;
            break;
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

    showToast(`任务"${taskName}"已添加`, 'success');
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
    alarmState.audioQueue = alarmState.audioQueue.filter(task => task.id !== taskId);

    // 清理该任务的音频控制器
    const audioController = alarmState.activeLoopControllers.get(taskId);
    if (audioController) {
        audioController.stop = true;
        if (audioController.audio) {
            audioController.audio.pause();
            audioController.audio.src = '';
        }
        // 释放 Blob URL
        if (audioController.blobUrl) {
            revokeBlobUrl(audioController.blobUrl);
            audioController.blobUrl = null;
        }
        alarmState.activeLoopControllers.delete(taskId);

        // 如果是当前播放的音频，清空引用
        if (alarmState.currentPlayingAudio === audioController) {
            alarmState.currentPlayingAudio = null;
            processNextAudioInQueue();
        }
    }

    // 移除遮罩层和 Toast
    const overlay = document.getElementById(`alarm-overlay-${taskId}`);
    if (overlay) overlay.remove();
    const toast = document.getElementById(`alarm-toast-${taskId}`);
    if (toast) toast.remove();
}

// ============================================
// 暂停任务
// ============================================
function pauseTask(taskId) {
    const task = alarmState.tasks.find(t => t.id === taskId);
    if (!task || !task.enabled) return;

    task.paused = true;
    task.pausedAt = Date.now();
    pauseAlarmTaskSchedule(task);

    saveTasks();
    renderTaskList();
    updateStats();
    console.log(`[AlarmClock] 任务已暂停: ${task.name}`);
}

// ============================================
// 恢复任务
// ============================================
function resumeTask(taskId) {
    const task = alarmState.tasks.find(t => t.id === taskId);
    if (!task || !task.enabled) return;

    task.paused = false;
    delete task.pausedAt;
    prepareAlarmTaskSchedule(task, { restart: true });

    saveTasks();
    renderTaskList();
    updateStats();
    console.log(`[AlarmClock] 任务已恢复: ${task.name}`);
}

// ============================================
// 切换任务状态（启用/禁用）
// ============================================
function toggleTask(taskId) {
    const task = alarmState.tasks.find(t => t.id === taskId);
    if (!task) return;

    task.enabled = !task.enabled;

    if (task.enabled) {
        // 重新启动任务
        task.paused = false; // 清除暂停状态
        if (task.type === 'countdown') {
            // 如果是已完成的倒计时任务，重置时间
            if (task.config.remainingSeconds <= 0) {
                task.config.remainingSeconds = task.config.totalSeconds;
            }
        }
        startTask(task, { restart: true });
    } else {
        stopTask(taskId);
    }

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
// 显示通知（带音频控制）
// ============================================
async function showNotification(task, audioController = null) {
    const taskId = task.id;

    // 使用 Tauri v2 notification 插件（优先）
    if (window.__TAURI__?.notification) {
        try {
            // 检查权限
            let permissionGranted = await window.__TAURI__.notification.isPermissionGranted();
            if (!permissionGranted) {
                const permission = await window.__TAURI__.notification.requestPermission();
                permissionGranted = permission === 'granted';
            }

            if (permissionGranted) {
                // 发送系统通知
                await window.__TAURI__.notification.sendNotification({
                    title: '⏰ 闹钟响了！',
                    body: `${task.name}`,
                });
                console.log('[AlarmClock] 系统通知已发送');

                // 尝试聚焦窗口让用户能看到应用内的停止按钮
                try {
                    const { getCurrentWindow } = window.__TAURI__.window;
                    if (getCurrentWindow) {
                        const win = getCurrentWindow();
                        await win.setFocus();
                        await win.unminimize();
                    }
                } catch (e) {
                    console.log('[AlarmClock] 聚焦窗口失败:', e);
                }
            }
        } catch (err) {
            console.error('[AlarmClock] Tauri通知失败:', err);
        }
    }

    // 使用浏览器通知作为备选（当Tauri通知不可用时）
    if (!window.__TAURI__?.notification && 'Notification' in window) {
        if (Notification.permission === 'granted') {
            const notification = new Notification('⏰ 定时提醒', {
                body: task.name,
                icon: '/src/assets/icon.png',
                requireInteraction: true, // 保持通知直到用户交互
                tag: `alarm-${taskId}` // 使用tag防止重复通知
            });

            // 点击通知时聚焦窗口
            notification.onclick = () => {
                window.focus();
            };
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('⏰ 定时提醒', {
                        body: task.name,
                        icon: '/src/assets/icon.png',
                        requireInteraction: true,
                        tag: `alarm-${taskId}`
                    });
                }
            });
        }
    }

    // 如果有音频控制器，显示带关闭按钮的Toast
    if (audioController) {
        showToastWithAudioControl(task, audioController);
    } else {
        // 普通Toast
        showToast(`⏰ ${task.name}`, 'info');
    }
}

// 显示带音频控制的Toast（持久显示，不会自动消失）
function showToastWithAudioControl(task, audioController) {
    // 移除已存在的闹钟遮罩和toast
    const existingOverlay = document.querySelector('.alarm-overlay');
    if (existingOverlay) {
        existingOverlay.remove();
    }
    const existingToast = document.querySelector('.dtkit-toast--alarm');
    if (existingToast) {
        existingToast.remove();
    }

    // 创建半透明遮罩层（确保用户注意到闹钟）
    const overlay = document.createElement('div');
    overlay.className = 'alarm-overlay';
    overlay.id = `alarm-overlay-${task.id}`;

    // 点击遮罩层也可以关闭闹钟
    overlay.addEventListener('click', () => {
        dismissAlarm();
    });

    document.body.appendChild(overlay);

    // 关闭闹钟的函数 - 彻底清理所有资源
    function dismissAlarm() {
        console.log(`[AlarmClock] 用户关闭闹钟: ${task.name}`);

        audioController.stop = true;

        // 清除 setTimeout
        if (audioController.timeoutId) {
            clearTimeout(audioController.timeoutId);
            audioController.timeoutId = null;
        }

        if (audioController.audio) {
            // 移除事件监听器
            if (audioController.onError) {
                audioController.audio.removeEventListener('error', audioController.onError);
                audioController.onError = null;
            }

            audioController.audio.pause();
            audioController.audio.loop = false; // 重置 loop 属性
            audioController.audio.src = '';
            audioController.audio.load(); // 强制释放
        }

        // 释放 Blob URL
        if (audioController.blobUrl) {
            revokeBlobUrl(audioController.blobUrl);
            audioController.blobUrl = null;
        }

        // 清空引用
        audioController.audio = null;

        // 清理控制器
        alarmState.activeLoopControllers.delete(task.id);
        if (alarmState.currentPlayingAudio === audioController) {
            alarmState.currentPlayingAudio = null;
        }

        // 移除遮罩层
        const overlayEl = document.getElementById(`alarm-overlay-${task.id}`);
        if (overlayEl) {
            overlayEl.classList.add('alarm-overlay--closing');
            setTimeout(() => overlayEl.remove(), 300);
        }

        // 移除 Toast
        const toastEl = document.getElementById(`alarm-toast-${task.id}`);
        if (toastEl) {
            toastEl.classList.add('dtkit-toast--alarm-closing');
            setTimeout(() => toastEl.remove(), 300);
        }

        showToast('✓ 闹钟已停止', 'success');

        // 处理队列中的下一个
        processNextAudioInQueue();

        console.log(`[AlarmClock] 闹钟资源已完全释放: ${task.name}`);
    }

    const toast = document.createElement('div');
    toast.className = 'dtkit-toast dtkit-toast--alarm';

    toast.id = `alarm-toast-${task.id}`;
    toast.innerHTML = `
        <div class="alarm-toast__content">
            <i class="ri-alarm-warning-line alarm-toast__icon"></i>
            <div class="alarm-toast__body">
                <div class="alarm-toast__title">⏰ 闹钟响了！</div>
                <div class="alarm-toast__task">${escapeHtml(task.name)}</div>
            </div>
            <button id="dismissAlarmBtn-${task.id}" class="alarm-dismiss-btn">🔔 停止闹钟</button>
        </div>
    `;

    document.body.appendChild(toast);

    const dismissBtn = document.getElementById(`dismissAlarmBtn-${task.id}`);
    if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止事件冒泡到遮罩层
            dismissAlarm();
        });
    }
}

// ============================================
// 音频播放队列管理
// ============================================

// 使用队列播放音频（确保同时只播放一个）
async function playAudioWithQueue(task) {
    if ((alarmState.currentPlayingAudio && !alarmState.currentPlayingAudio.stop
        && alarmState.currentPlayingAudio.taskId === task.id)
        || alarmState.audioQueue.some(item => item.id === task.id)) {
        console.log(`[AlarmClock] 已合并重复音频提醒: ${task.id}`);
        return;
    }

    if (alarmState.audioQueue.length >= MAX_AUDIO_QUEUE_SIZE) {
        alarmState.audioQueue.shift();
    }
    alarmState.audioQueue.push(task);
    await processNextAudioInQueue();
}

// 处理队列中的下一个音频
async function processNextAudioInQueue() {
    if (alarmState.audioQueueProcessing || alarmState.currentPlayingAudio) return;
    alarmState.audioQueueProcessing = true;
    try {
        while (alarmState.audioQueue.length > 0 && !alarmState.currentPlayingAudio) {
            const nextTask = alarmState.audioQueue.shift();
            if (await playAudioLoop(nextTask)) break;
        }
    } finally {
        alarmState.audioQueueProcessing = false;
    }
}

// 循环播放音频（7分钟）
async function playAudioLoop(task) {
    const audioPath = task.config.audioPath;
    const audioName = task.config.audioName || '默认提示音';

    console.log(`[AlarmClock] 开始播放音频: ${audioName}`);

    // 如果没有音频文件，使用静默模式
    if (!audioPath || alarmState.availableAudioFiles.length === 0) {
        console.log('[AlarmClock] 无可用音频文件，静默模式');
        return false;
    }

    // 创建音频控制器
    const controller = {
        stop: false,
        audio: null,
        taskName: task.name,
        taskId: task.id,
        startTime: Date.now(),
        blobUrl: null,  // 跟踪 Blob URL 用于清理
        timeoutId: null, // 跟踪 setTimeout 用于清理
        onEnded: null,   // 事件监听器引用
        onError: null    // 事件监听器引用
    };

    const audio = new Audio();
    const convertedPath = await convertPath(audioPath);
    audio.src = convertedPath;
    audio.volume = 0.7;
    if (convertedPath.startsWith('blob:')) {
        controller.blobUrl = convertedPath;
    }

    controller.audio = audio;
    alarmState.currentPlayingAudio = controller;
    alarmState.activeLoopControllers.set(task.id, controller);

    // Rust 已发送系统通知时，只保留应用内停止控件，避免重复通知。
    if (task.__backendTriggered) showToastWithAudioControl(task, controller);
    else showNotification(task, controller);

    // 使用原生 loop 属性实现无缝循环播放
    audio.loop = true;
    const maxDuration = 7 * 60 * 1000; // 7分钟

    // 7分钟后自动停止
    controller.timeoutId = setTimeout(() => {
        console.log('[AlarmClock] 音频播放时长已达7分钟，自动停止');
        cleanup();
    }, maxDuration);

    // 音频加载错误 - 使用命名函数以便移除
    controller.onError = (e) => {
        console.error('[AlarmClock] 音频加载失败:', e);
        showToast(`音频加载失败: ${audioName}`, 'error');
        cleanup();
    };
    audio.addEventListener('error', controller.onError);

    // 开始播放
    const startPlayback = async () => {
        try {
            // 确保音频可以播放
            if (audio.readyState < 2) {
                // 等待音频加载
                await new Promise((resolve, reject) => {
                    let timeoutId;
                    const onCanPlay = () => {
                        audio.removeEventListener('canplay', onCanPlay);
                        audio.removeEventListener('error', onLoadError);
                        clearTimeout(timeoutId);
                        resolve();
                    };
                    const onLoadError = (e) => {
                        audio.removeEventListener('canplay', onCanPlay);
                        audio.removeEventListener('error', onLoadError);
                        clearTimeout(timeoutId);
                        reject(e);
                    };
                    audio.addEventListener('canplay', onCanPlay);
                    audio.addEventListener('error', onLoadError);
                    // 超时保护
                    timeoutId = setTimeout(() => {
                        audio.removeEventListener('canplay', onCanPlay);
                        audio.removeEventListener('error', onLoadError);
                        reject(new Error('音频加载超时'));
                    }, 5000);
                });
            }

            if (!controller.stop) {
                await audio.play();
                console.log('[AlarmClock] 音频开始循环播放（原生loop模式）');
            }
        } catch (err) {
            console.error('[AlarmClock] 播放音频失败:', err);
            if (err.name !== 'AbortError') {
                cleanup();
            }
        }
    };

    // 清理函数 - 彻底释放所有资源
    function cleanup() {
        if (controller.stop && !controller.audio) {
            // 已经清理过了
            return;
        }

        console.log(`[AlarmClock] 清理音频资源: ${controller.taskName}`);
        controller.stop = true;

        // 清除自动停止定时器
        if (controller.timeoutId) {
            clearTimeout(controller.timeoutId);
            controller.timeoutId = null;
        }

        if (audio) {
            // 移除事件监听器（防止内存泄漏）
            if (controller.onError) {
                audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }

            // 停止并清理音频
            audio.pause();
            audio.loop = false; // 重置 loop 属性
            audio.src = '';
            audio.load(); // 强制释放音频资源

            // 释放 Blob URL
            if (controller.blobUrl) {
                revokeBlobUrl(controller.blobUrl);
                controller.blobUrl = null;
            }
        }

        // 清空引用
        controller.audio = null;

        // 从控制器 Map 中移除
        alarmState.activeLoopControllers.delete(controller.taskId);

        // 如果是当前播放的音频，清空引用
        if (alarmState.currentPlayingAudio === controller) {
            alarmState.currentPlayingAudio = null;
        }

        // 移除对应的遮罩层
        const overlay = document.getElementById(`alarm-overlay-${controller.taskId}`);
        if (overlay) {
            overlay.style.animation = 'overlayFadeOut 0.3s ease forwards';
            setTimeout(() => overlay.remove(), 300);
        }

        // 移除对应的 toast
        const toast = document.getElementById(`alarm-toast-${controller.taskId}`);
        if (toast) {
            toast.style.animation = 'alarmToastOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }

        // 处理队列中的下一个
        processNextAudioInQueue();

        console.log(`[AlarmClock] 音频资源已完全释放: ${controller.taskName}`);
    }

    // 立即开始播放
    startPlayback();
    return true;
}

// 转换文件路径为Tauri可访问的URL
async function convertPath(filePath) {
    if (!window.__TAURI__) {
        return filePath;
    }

    console.log('[AlarmClock] 原始路径:', filePath);

    // 优先使用 convertFileSrc（最可靠的方式）
    if (window.__TAURI__.core?.convertFileSrc) {
        try {
            const converted = window.__TAURI__.core.convertFileSrc(filePath);
            console.log('[AlarmClock] 使用 convertFileSrc:', converted);
            return converted;
        } catch (e) {
            console.error('[AlarmClock] convertFileSrc 失败:', e);
        }
    }

    // 降级方案：尝试读取文件为 Blob
    try {
        // Tauri v2: 读取文件为 Blob，然后创建 Object URL
        const fs = window.__TAURI__.fs;
        if (fs && typeof fs.readFile === 'function') {
            // 读取音频文件
            const audioData = await fs.readFile(filePath);

            // 根据文件扩展名确定 MIME 类型
            const ext = filePath.toLowerCase().split('.').pop();
            const mimeTypes = {
                'wav': 'audio/wav',
                'mp3': 'audio/mpeg',
                'ogg': 'audio/ogg',
                'm4a': 'audio/mp4'
            };
            const mimeType = mimeTypes[ext] || 'audio/wav';

            // 创建 Blob 和 Object URL
            const blob = new Blob([audioData], { type: mimeType });
            const url = URL.createObjectURL(blob);

            // 记录 Blob URL 以便后续清理，防止内存泄漏
            alarmState.blobUrls.set(url, true);

            console.log('[AlarmClock] 创建 Blob URL:', url);
            return url;
        }
    } catch (err) {
        console.error('[AlarmClock] 文件读取失败:', err);
    }

    // 最后的降级：返回原始路径
    console.warn('[AlarmClock] 无法转换路径，返回原始路径:', filePath);
    return filePath;
}

// ============================================
// 停止所有音频播放
// ============================================
function stopAllAudio() {
    console.log('[AlarmClock] 正在停止所有音频播放...');

    // 停止当前播放
    if (alarmState.currentPlayingAudio) {
        const controller = alarmState.currentPlayingAudio;
        controller.stop = true;

        // 清除 setTimeout
        if (controller.timeoutId) {
            clearTimeout(controller.timeoutId);
            controller.timeoutId = null;
        }

        if (controller.audio) {
            // 移除事件监听器
            if (controller.onError) {
                controller.audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }

            controller.audio.pause();
            controller.audio.loop = false; // 重置 loop 属性
            controller.audio.src = '';
            controller.audio.load(); // 强制释放
            controller.audio = null;
        }

        // 释放 Blob URL
        if (controller.blobUrl) {
            revokeBlobUrl(controller.blobUrl);
            controller.blobUrl = null;
        }

        alarmState.currentPlayingAudio = null;
    }

    // 清空队列
    alarmState.audioQueue = [];
    alarmState.audioQueueProcessing = false;

    // 清理所有控制器
    alarmState.activeLoopControllers.forEach((controller, taskId) => {
        console.log(`[AlarmClock] 清理控制器: ${taskId}`);
        controller.stop = true;

        // 清除 setTimeout
        if (controller.timeoutId) {
            clearTimeout(controller.timeoutId);
            controller.timeoutId = null;
        }

        if (controller.audio) {
            // 移除事件监听器
            if (controller.onError) {
                controller.audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }

            controller.audio.pause();
            controller.audio.loop = false; // 重置 loop 属性
            controller.audio.src = '';
            controller.audio.load(); // 强制释放
            controller.audio = null;
        }

        // 释放 Blob URL
        if (controller.blobUrl) {
            revokeBlobUrl(controller.blobUrl);
            controller.blobUrl = null;
        }
    });
    alarmState.activeLoopControllers.clear();

    // 移除所有遮罩层和 Toast（同时使用 id 和 class 选择器确保完整清理）
    document.querySelectorAll('[id^="alarm-overlay-"], .alarm-overlay').forEach(el => el.remove());
    document.querySelectorAll('[id^="alarm-toast-"], .dtkit-toast--alarm').forEach(el => el.remove());

    console.log('[AlarmClock] 已停止所有音频播放，资源已释放');
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
    localStorage.setItem('alarm_clock_data', JSON.stringify(data));
    if (sync) {
        syncAlarmTasks(alarmState.tasks).catch(error => {
            console.error('[AlarmClock] 同步 Rust 调度器失败', error);
        });
    }
}

// ============================================
// 加载任务
// ============================================
function loadTasks() {
    try {
        const saved = localStorage.getItem('alarm_clock_data');
        if (saved) {
            const data = JSON.parse(saved);
            alarmState.tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, MAX_ALARM_TASKS) : [];

            // 检查日期，重置今日计数
            if (data.lastDate === new Date().toDateString()) {
                alarmState.completedToday = data.completedToday || 0;
            } else {
                alarmState.completedToday = 0;
            }

            // 为旧数据补齐绝对截止时间；不在前端启动任何后台计时器。
            alarmState.tasks.forEach(task => {
                normalizeAlarmTask(task);
                if (task.enabled) {
                    startTask(task);
                }
            });
            saveTasks();
        }
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

    // 清空现有内容
    panel.innerHTML = '';

    if (alarmState.tasks.length === 0) {
        panel.innerHTML = `
            <div class="alarm-list-empty" id="emptyListHint">
                <i class="ri-alarm-line"></i>
                <p>暂无定时任务</p>
                <p class="alarm-list-empty-sub">在左侧创建你的第一个任务吧</p>
            </div>`;
        return;
    }

    // 渲染任务卡片
    alarmState.tasks.forEach(task => {
        const card = createTaskCard(task);
        panel.appendChild(card);
    });

    // 初始化拖拽排序
    initTaskReordering();
}

// ============================================
// 初始化原生拖拽排序
// ============================================
function initTaskReordering() {
    const panel = document.getElementById('taskListPanel');
    if (!panel || alarmState.tasks.length === 0) return;

    let draggedCard = null;
    panel.querySelectorAll('.alarm-task-card').forEach(card => {
        const handle = card.querySelector('.alarm-task-drag-handle');
        handle?.addEventListener('pointerdown', () => {
            card.draggable = true;
        });
        card.addEventListener('dragstart', event => {
            draggedCard = card;
            card.classList.add('sortable-drag', 'sortable-chosen');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', card.dataset.taskId || '');
            if (navigator.vibrate) navigator.vibrate(15);
        });
        card.addEventListener('dragend', () => {
            card.draggable = false;
            card.classList.remove('sortable-drag', 'sortable-chosen');
            panel.querySelectorAll('.sortable-ghost').forEach(item => item.classList.remove('sortable-ghost'));
            draggedCard = null;
        });
    });

    panel.ondragover = event => {
        event.preventDefault();
        const target = event.target.closest('.alarm-task-card');
        if (!draggedCard || !target || target === draggedCard) return;
        const rect = target.getBoundingClientRect();
        target.classList.add('sortable-ghost');
        panel.insertBefore(draggedCard, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    };
    panel.ondrop = event => {
        event.preventDefault();
        const taskById = new Map(alarmState.tasks.map(task => [task.id, task]));
        alarmState.tasks = [...panel.querySelectorAll('.alarm-task-card')]
            .map(card => taskById.get(card.dataset.taskId))
            .filter(Boolean);
        saveTasks({ sync: false });
    };
}

// ============================================
// 创建任务卡片
// ============================================
function createTaskCard(task) {
    const card = document.createElement('div');

    // 确定卡片状态类
    let statusClass = '';
    if (!task.enabled) {
        statusClass = 'disabled';
    } else if (task.paused) {
        statusClass = 'paused';
    }

    card.className = `alarm-task-card ${statusClass}`;
    card.dataset.taskId = task.id;

    const countdown = getTaskCountdown(task);

    // 确定按钮状态
    const isRunning = task.enabled && !task.paused;
    const isPaused = task.enabled && task.paused;
    const isCompleted = !task.enabled && task.type === 'countdown' && task.config.remainingSeconds <= 0;

    let actionButtons = '';
    if (!task.enabled && !isCompleted) {
        // 已停止的任务：显示启动按钮
        actionButtons = `
            <button class="alarm-task-btn alarm-task-btn--start"
                data-task-id="${task.id}" title="启动任务">
                <i class="ri-play-line"></i>
            </button>
        `;
    } else if (isCompleted) {
        // 已完成的倒计时任务：显示重新开始按钮
        actionButtons = `
            <button class="alarm-task-btn alarm-task-btn--restart"
                data-task-id="${task.id}" title="重新开始">
                <i class="ri-refresh-line"></i>
            </button>
        `;
    } else if (isPaused) {
        // 已暂停：显示恢复按钮
        actionButtons = `
            <button class="alarm-task-btn alarm-task-btn--resume"
                data-task-id="${task.id}" title="恢复任务">
                <i class="ri-play-line"></i>
            </button>
        `;
    } else if (isRunning) {
        // 运行中：显示暂停按钮
        actionButtons = `
            <button class="alarm-task-btn alarm-task-btn--pause"
                data-task-id="${task.id}" title="暂停任务">
                <i class="ri-pause-line"></i>
            </button>
        `;
    }

    card.innerHTML = `
        <div class="alarm-task-drag-handle" title="拖拽排序">
            <i class="ri-drag-move-2-line"></i>
        </div>
        <div class="alarm-task-countdown ${isPaused ? 'paused-state' : ''}" data-countdown-id="${task.id}">
            ${countdown}
        </div>
        <div class="alarm-task-info">
            <div class="alarm-task-name">${escapeHtml(task.name)}</div>
            <div class="alarm-task-meta">
                <span class="alarm-task-meta-item">
                    <i class="ri-time-line"></i> ${TASK_TYPES[task.type]}
                </span>
                <span class="alarm-task-meta-item">
                    <i class="ri-play-circle-line"></i> ${ACTION_TYPES[task.action]}
                </span>
                ${isPaused ? '<span class="alarm-task-paused-badge"><i class="ri-pause-circle-line"></i> 已暂停</span>' : ''}
            </div>
        </div>
        <div class="alarm-task-actions">
            ${actionButtons}
            <button class="alarm-task-btn alarm-task-btn--delete"
                data-task-id="${task.id}" title="删除">
                <i class="ri-delete-bin-line"></i>
            </button>
        </div>
        ${isPaused ? '<div class="alarm-task-paused-overlay"><i class="ri-pause-circle-line"></i></div>' : ''}
    `;

    // 绑定按钮事件
    const pauseBtn = card.querySelector('.alarm-task-btn--pause');
    const resumeBtn = card.querySelector('.alarm-task-btn--resume');
    const startBtn = card.querySelector('.alarm-task-btn--start');
    const restartBtn = card.querySelector('.alarm-task-btn--restart');
    const deleteBtn = card.querySelector('.alarm-task-btn--delete');

    if (pauseBtn) pauseBtn.addEventListener('click', () => pauseTask(task.id));
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumeTask(task.id));
    if (startBtn) startBtn.addEventListener('click', () => toggleTask(task.id));
    if (restartBtn) {
        restartBtn.addEventListener('click', () => {
            // 重新开始倒计时任务
            task.config.remainingSeconds = task.config.totalSeconds;
            toggleTask(task.id);
        });
    }
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteTask(task.id));

    return card;
}

// ============================================
// 获取任务倒计时显示
// ============================================
function getTaskCountdown(task) {
    if (!task.enabled) return '--:--:--';
    const remainingSeconds = getAlarmRemainingSeconds(task, Date.now(), { includePaused: true });
    return Number.isFinite(remainingSeconds) ? formatSeconds(remainingSeconds) : '--:--:--';
}

// ============================================
// 格式化秒数
// ============================================
function formatSeconds(seconds) {
    if (seconds <= 0) return '00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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
        countdownEl.textContent = formatSeconds(minSeconds);
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
        // 更新所有任务卡片的倒计时显示
        alarmState.tasks.forEach(task => {
            const el = document.querySelector(`[data-countdown-id="${task.id}"]`);
            if (el) {
                el.textContent = getTaskCountdown(task);
            }
        });

        // 更新统计区域的倒计时
        updateNextAlarmCountdown();
    }, 1000);
}

function applyTriggeredTaskState(triggeredTask) {
    const task = alarmState.tasks.find(item => item.id === triggeredTask.id);
    if (task?.type === 'countdown') {
        task.enabled = false;
        task.config.remainingSeconds = 0;
        delete task.config.deadlineAt;
    } else if (task?.type === 'interval') {
        task.config.nextTriggerAt = Date.now() + Math.max(1, Number(task.config.intervalMs) || 1);
    } else if (task && (task.type === 'fixed' || task.type === 'hourly')
        && task.config.repeatEnabled === false) {
        task.enabled = false;
    }

    alarmState.completedToday++;
    if (document.getElementById('taskListPanel')) renderTaskList();
    updateStats();
}

window.addEventListener(ALARM_TRIGGER_EVENT, event => {
    applyTriggeredTaskState(event.detail);
});

window.addEventListener('dtkit:power-state', event => {
    if (event.detail?.suspended) {
        if (alarmState.countdownInterval) {
            clearInterval(alarmState.countdownInterval);
            alarmState.countdownInterval = null;
        }
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            previewAudio = null;
        }
    } else if (document.getElementById('taskListPanel')) {
        startGlobalCountdown();
        updateStats();
    }
});

export async function handleBackgroundAlarmTrigger(task) {
    if (task.action !== 'sound') return;
    if (alarmState.availableAudioFiles.length === 0) await loadAvailableAudioFiles();
    task.__backendTriggered = true;
    await playAudioWithQueue(task);
}

// ============================================
// HTML 转义
// ============================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

    // 停止预览音频并清理
    if (previewAudio) {
        previewAudio.pause();
        previewAudio.src = '';
        previewAudio = null;
    }
    if (previewAudioBlobUrl) {
        revokeBlobUrl(previewAudioBlobUrl);
        previewAudioBlobUrl = null;
    }

    // 释放所有未清理的 Blob URL（防止内存泄漏）
    console.log(`[AlarmClock] 释放 ${alarmState.blobUrls.size} 个 Blob URL`);
    alarmState.blobUrls.forEach((_, url) => {
        try {
            URL.revokeObjectURL(url);
        } catch (e) {
            // 忽略错误
        }
    });
    alarmState.blobUrls.clear();

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
    template: getTemplate,
    init,
    destroy
});
