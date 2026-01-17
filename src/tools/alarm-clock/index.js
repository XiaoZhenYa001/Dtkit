/**
 * 定时闹钟工具
 * 支持倒计时、固定时间、整点报时、间隔提醒
 * 可执行：弹出通知、播放提示音、运行程序、关闭电脑、锁定屏幕
 */
import { registerTool } from '../toolRegistry.js';
import { showToast } from '../../core/utils.js';

// ============================================
// 工具状态
// ============================================
let alarmState = {
    tasks: [],              // 任务列表
    timers: {},             // 定时器映射 { taskId: intervalId }
    completedToday: 0,      // 今日完成数
    nextAlarmTime: null,    // 下一个提醒时间
    countdownInterval: null, // 全局倒计时更新定时器
    sortableInstance: null, // Sortable 实例引用（防止重复创建）
    abortController: null,  // 用于清理事件监听器
    audioContext: null,     // 共享的 AudioContext 实例（已废弃，使用HTML5 Audio）
    activeLoopControllers: new Map(), // 音频循环控制器 { taskId: controller }
    currentPlayingAudio: null,        // 当前正在播放的音频控制器
    audioQueue: [],         // 音频播放队列
    availableAudioFiles: [], // 可用的音频文件列表
    preloadedAudios: new Map(), // 预加载的音频缓存 { taskId: Audio } - LRU缓存
    blobUrls: new Map()     // Blob URL 跟踪器 { url: true } - 用于防止内存泄漏
};

// 预加载配置
const PRELOAD_CONFIG = {
    MAX_CACHE_SIZE: 5,           // LRU缓存最大数量
    PRELOAD_THRESHOLD_SECONDS: 300, // 5分钟内的任务才预加载
    LOAD_TIMEOUT_MS: 5000        // 音频加载超时时间
};

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

// ============================================
// 智能预加载判断
// ============================================

// 判断任务是否应该预加载音频（即将触发的任务）
function shouldPreloadAudio(task) {
    if (task.action !== 'sound' || !task.config.audioPath) {
        return false;
    }
    
    if (!task.enabled || task.paused) {
        return false;
    }
    
    const threshold = PRELOAD_CONFIG.PRELOAD_THRESHOLD_SECONDS;
    
    switch (task.type) {
        case 'countdown':
            // 倒计时剩余时间 <= 5分钟
            return task.config.remainingSeconds <= threshold;
            
        case 'fixed':
            // 固定时间距离现在 <= 5分钟
            const [hours, minutes] = task.config.time.split(':').map(Number);
            const now = new Date();
            const target = new Date();
            target.setHours(hours, minutes, 0, 0);
            
            if (target <= now) {
                target.setDate(target.getDate() + 1);
            }
            
            const diffSeconds = Math.floor((target - now) / 1000);
            return diffSeconds <= threshold;
            
        case 'hourly':
            // 距离下一个整点 <= 5分钟
            const nowHourly = new Date();
            const nextHour = new Date();
            nextHour.setHours(nowHourly.getHours() + 1, 0, 0, 0);
            const diffSecondsHourly = Math.floor((nextHour - nowHourly) / 1000);
            return diffSecondsHourly <= threshold;
            
        case 'interval':
            // 间隔提醒总是预加载（因为可能随时触发）
            return true;
            
        default:
            return false;
    }
}

// ============================================
// LRU 缓存管理
// ============================================

// 添加到预加载缓存（实现 LRU）
function addToPreloadCache(taskId, audio) {
    // 如果已存在，先删除（更新为最新）
    if (alarmState.preloadedAudios.has(taskId)) {
        alarmState.preloadedAudios.delete(taskId);
    }
    
    // 如果超过缓存上限，删除最早的（Map的第一个元素）
    if (alarmState.preloadedAudios.size >= PRELOAD_CONFIG.MAX_CACHE_SIZE) {
        const firstKey = alarmState.preloadedAudios.keys().next().value;
        console.log(`[AlarmClock] LRU缓存已满，移除最早的任务: ${firstKey}`);
        cleanupPreloadedAudio(firstKey);
    }
    
    // 添加到缓存（作为最新的）
    alarmState.preloadedAudios.set(taskId, audio);
    console.log(`[AlarmClock] 当前预加载缓存: ${alarmState.preloadedAudios.size}/${PRELOAD_CONFIG.MAX_CACHE_SIZE}`);
}

// ============================================
// 预加载音频文件
// ============================================
async function preloadAudio(task) {
    if (task.action !== 'sound' || !task.config.audioPath) {
        return null;
    }
    
    try {
        const audio = new Audio();
        const convertedPath = await convertPath(task.config.audioPath);
        audio.src = convertedPath;
        audio.volume = 0.7;
        audio.preload = 'auto'; // 强制预加载
        
        // 等待音频加载就绪
        await new Promise((resolve, reject) => {
            audio.addEventListener('canplaythrough', resolve, { once: true });
            audio.addEventListener('error', reject, { once: true });
            
            // 触发加载
            audio.load();
            
            // 超时保护
            setTimeout(() => reject(new Error('音频加载超时')), PRELOAD_CONFIG.LOAD_TIMEOUT_MS);
        });
        
        console.log(`[AlarmClock] ✓ 音频预加载成功: ${task.name} (${task.config.audioName})`);
        return audio;
    } catch (err) {
        console.error(`[AlarmClock] ✗ 音频预加载失败: ${task.name}`, err);
        return null;
    }
}

// 清理预加载的音频
function cleanupPreloadedAudio(taskId) {
    const audio = alarmState.preloadedAudios.get(taskId);
    if (audio) {
        // 释放 Blob URL（如果是 blob: 开头的 URL）
        const audioSrc = audio.src;
        audio.pause();
        audio.src = '';
        revokeBlobUrl(audioSrc);
        alarmState.preloadedAudios.delete(taskId);
        console.log(`[AlarmClock] 清理预加载音频: ${taskId}`);
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
        <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
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
                        <input type="text" id="alarmTaskName" class="alarm-input" 
                            placeholder="例如：该喝水了、下班打卡...">
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label">定时类型</label>
                        <select id="alarmTaskType" class="alarm-select">
                            <option value="countdown">倒计时</option>
                            <option value="fixed">固定时间 (每天)</option>
                            <option value="hourly">整点报时</option>
                            <option value="interval">间隔提醒</option>
                        </select>
                    </div>

                    <div class="alarm-input-group" id="timeInputGroup">
                        <label class="alarm-label" id="timeInputLabel">设定时间</label>
                        <input type="time" id="alarmTimeInput" class="alarm-input" value="09:00">
                        <!-- 倒计时专用输入 -->
                        <div id="countdownInputs" class="alarm-countdown-inputs" style="display: none;">
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
                        <div id="intervalInputs" class="alarm-interval-inputs" style="display: none;">
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
function getStyles() {
    return `
        .alarm-clock-view {
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: var(--spacing-lg);
            gap: var(--spacing-lg);
            overflow: hidden;
        }

        /* 顶部统计栏 */
        .alarm-header-stats {
            display: flex;
            gap: var(--spacing-lg);
            flex-shrink: 0;
        }

        .alarm-stat-card {
            background: var(--color-bg-secondary);
            padding: var(--spacing-md) var(--spacing-lg);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-sm);
            border: 1px solid var(--color-border);
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .alarm-stat-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }

        .alarm-stat-label {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
        }

        .alarm-stat-value {
            font-size: 1.5rem;
            font-weight: bold;
            color: var(--color-primary);
        }

        .alarm-stat-value--accent {
            color: #ff6b6b;
            font-family: 'Courier New', monospace;
        }

        /* 主体布局 */
        .alarm-main-container {
            display: grid;
            grid-template-columns: 380px 1fr;
            gap: var(--spacing-lg);
            flex: 1;
            min-height: 0;  /* 关键：让 flex 子元素可以缩小 */
            height: 100%;   /* 强制铺满剩余空间 */
            overflow: hidden; /* 防止外层容器出现滚动条 */
        }

        /* 左侧配置面板 */
        .alarm-config-panel {
            background: var(--color-bg-secondary);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            box-shadow: var(--shadow-md);
            border: 1px solid var(--color-border);
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
            
            /* 核心修改： */
            align-self: start;   /* 确保左侧面板高度由内容决定，不会被拉长 */
            max-height: 100%;    /* 如果内容过多，左侧内部滚动 */
            overflow-y: auto;
        }

        .alarm-panel-title {
            margin: 0;
            font-size: var(--font-size-lg);
            color: var(--color-text-primary);
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            padding-bottom: var(--spacing-md);
            border-bottom: 1px solid var(--color-border);
        }

        .alarm-panel-title i {
            color: var(--color-primary);
        }

        .alarm-input-group {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs);
        }

        .alarm-label {
            font-size: var(--font-size-sm);
            font-weight: 600;
            color: var(--color-text-secondary);
        }

        .alarm-input,
        .alarm-select {
            padding: 12px 14px;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            background: var(--color-bg-tertiary);
            color: var(--color-text-primary);
            font-size: var(--font-size-sm);
            outline: none;
            transition: all 0.2s ease;
        }

        .alarm-input:hover,
        .alarm-select:hover {
            border-color: var(--color-text-tertiary);
        }

        .alarm-input:focus,
        .alarm-select:focus {
            border-color: var(--color-primary);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
            background: var(--color-bg-primary);
        }

        .alarm-input--small {
            width: 60px;
            text-align: center;
            padding: 10px 8px;
        }

        .alarm-select--small {
            width: auto;
            padding: 10px 12px;
        }

        /* 动画定义 */
        @keyframes alarmSlideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
                max-height: 0;
            }
            to {
                opacity: 1;
                transform: translateY(0);
                max-height: 200px;
            }
        }

        @keyframes alarmPopIn {
            0% { opacity: 0; transform: scale(0.95); }
            70% { transform: scale(1.02); }
            100% { opacity: 1; transform: scale(1); }
        }

        .alarm-countdown-inputs,
        .alarm-interval-inputs {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            margin-top: var(--spacing-xs);
            overflow: hidden;
        }

        /* 当通过 JS 显示时触发动画 */
        .alarm-countdown-inputs:not([style*="display: none"]),
        .alarm-interval-inputs:not([style*="display: none"]),
        .alarm-input:not([style*="display: none"]):not(#alarmTaskName) {
            animation: alarmSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }

        .alarm-time-sep {
            font-size: 1.2rem;
            font-weight: bold;
            color: var(--color-text-secondary);
        }

        .alarm-interval-text {
            font-size: var(--font-size-sm);
            color: var(--color-text-secondary);
        }

        /* 动态配置区域 */
        .alarm-action-config {
            min-height: 0;
            transition: all 0.3s ease;
        }

        .alarm-action-config > div {
            animation: alarmPopIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        .alarm-action-config:empty {
            display: none;
        }

        /* 音频列表样式 */
        .alarm-audio-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 300px;
            overflow-y: auto;
            padding: 4px;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            background: var(--color-bg-tertiary);
        }

        .alarm-audio-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            border: 2px solid transparent;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all 0.2s ease;
            background: white;
        }

        .alarm-audio-item:hover {
            border-color: var(--color-primary);
            background: #f8fafc;
            transform: translateX(4px);
        }

        .alarm-audio-item.selected {
            border-color: var(--color-primary);
            background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
            box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
        }

        .alarm-audio-icon {
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            border-radius: 10px;
            flex-shrink: 0;
        }

        .alarm-audio-icon i {
            font-size: 20px;
            color: white;
        }

        .alarm-audio-info {
            flex: 1;
            min-width: 0;
        }

        .alarm-audio-name {
            font-size: 14px;
            font-weight: 600;
            color: var(--color-text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .alarm-audio-size {
            font-size: 12px;
            color: var(--color-text-tertiary);
            margin-top: 2px;
        }

        .alarm-audio-preview-btn {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }

        .alarm-audio-preview-btn:hover {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            transform: scale(1.1);
        }

        .alarm-audio-preview-btn:hover i {
            color: white;
        }

        .alarm-audio-preview-btn i {
            font-size: 16px;
            color: var(--color-primary);
            transition: color 0.2s ease;
        }

        .alarm-no-audio {
            padding: 40px 20px;
            text-align: center;
            color: var(--color-text-tertiary);
        }

        .alarm-no-audio p {
            margin: 8px 0;
        }

        /* 打开文件夹按钮 */
        .alarm-open-folder-btn {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            border: none;
            border-radius: 6px;
            color: white;
            padding: 4px 8px;
            cursor: pointer;
            margin-left: 8px;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
        }

        .alarm-open-folder-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(59, 130, 246, 0.3);
        }

        .alarm-open-folder-btn i {
            font-size: 14px;
        }

        /* 兼容旧样式（已废弃，保留防止报错） */
        .alarm-sound-options {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: var(--spacing-sm);
            padding: 4px;
        }

        .alarm-sound-option {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--spacing-xs);
            padding: var(--spacing-md);
            border: 2px solid var(--color-border);
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            background: var(--color-bg-tertiary);
            position: relative;
            overflow: hidden;
        }

        .alarm-sound-option::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 100%;
            height: 100%;
            background: var(--color-primary);
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
            transition: all 0.3s ease;
            border-radius: 50%;
            z-index: 0;
        }

        .alarm-sound-option:hover {
            border-color: var(--color-primary);
            background: var(--color-bg-primary);
            transform: translateY(-2px);
        }

        .alarm-sound-option.selected {
            border-color: var(--color-primary);
            background: white;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15);
            transform: scale(1.05);
        }

        .alarm-sound-option.selected i {
            transform: scale(1.2);
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .alarm-sound-option i, 
        .alarm-sound-option span {
            position: relative;
            z-index: 1;
        }

        .alarm-sound-option i {
            font-size: 1.5rem;
            color: var(--color-primary);
            transition: all 0.3s ease;
        }

        .alarm-sound-option span {
            font-size: var(--font-size-xs);
            color: var(--color-text-secondary);
        }

        /* 文件选择器 */
        .alarm-file-picker {
            display: flex;
            gap: var(--spacing-sm);
            animation: alarmPopIn 0.3s ease forwards;
        }

        .alarm-file-path {
            flex: 1;
            padding: 12px 14px;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            background: var(--color-bg-tertiary);
            color: var(--color-text-primary);
            font-size: var(--font-size-xs);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: all 0.2s ease;
        }

        .alarm-file-btn {
            padding: 10px 16px;
            background: var(--color-primary);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
            transition: all 0.2s ease;
            font-size: var(--font-size-sm);
        }

        .alarm-file-btn:hover {
            background: var(--color-primary-hover);
            transform: scale(1.05);
        }

        /* 重复设置 */
        .alarm-repeat-options {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-sm);
            transition: all 0.3s ease;
        }

        .alarm-checkbox-label {
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            cursor: pointer;
            font-size: var(--font-size-sm);
            color: var(--color-text-primary);
            padding: 4px 0;
        }

        .alarm-checkbox-label input[type="checkbox"] {
            width: 18px;
            height: 18px;
            accent-color: var(--color-primary);
            cursor: pointer;
            transition: transform 0.2s ease;
        }

        .alarm-checkbox-label:hover input[type="checkbox"] {
            transform: scale(1.1);
        }

        .alarm-repeat-days {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
            overflow: hidden;
            padding: 0.5rem 0.25rem;
            transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .alarm-repeat-days:not([style*="display: none"]) {
            animation: alarmSlideIn 0.3s ease forwards;
        }

        .alarm-day-checkbox {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .alarm-day-checkbox input[type="checkbox"] {
            display: none;
        }

        .alarm-day-checkbox span {
            width: 34px;
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            border: 1.5px solid var(--color-border);
            background: white;
            font-size: 0.8125rem;
            font-weight: 600;
            color: var(--color-text-secondary);
            cursor: pointer;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            user-select: none;
        }

        .alarm-day-checkbox input:checked + span {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: white;
            transform: scale(1.15);
            box-shadow: 0 4px 10px rgba(59, 130, 246, 0.35);
        }

        .alarm-day-checkbox:not(:has(input:checked)):hover span {
            border-color: var(--color-primary);
            color: var(--color-primary);
            background: var(--color-bg-primary);
            transform: translateY(-2px);
        }

        /* 针对周末的特殊样式（可选，增加视觉区分） */
        .alarm-day-checkbox:nth-last-child(-n+2) span {
            /* 周六周日如果未选中，颜色稍微淡一点或不同 */
        }

        /* 添加按钮 */
        .alarm-btn-add {
            margin-top: auto;
            padding: 14px 20px;
            background: linear-gradient(135deg, var(--color-primary) 0%, #6366f1 100%);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            font-size: var(--font-size-md);
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--spacing-sm);
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
        }

        .alarm-btn-add:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
        }

        .alarm-btn-add:active {
            transform: translateY(0);
        }

        /* 停止所有闹钟按钮 */
        .alarm-stop-all-btn {
            padding: 12px 20px;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            font-size: var(--font-size-sm);
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
            white-space: nowrap;
        }

        .alarm-stop-all-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(239, 68, 68, 0.4);
        }

        .alarm-stop-all-btn:active {
            transform: translateY(0);
        }

        .alarm-stop-all-btn i {
            font-size: 1.2em;
        }

        /* 右侧任务列表 */
        .alarm-list-panel {
            background: var(--color-bg-secondary);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            box-shadow: var(--shadow-md);
            border: 1px solid var(--color-border);
            
            /* 核心修改： */
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
            height: 100%;        /* 强制等于父容器高度 */
            overflow-y: auto;    /* 内容增多时出现滚动条 */
            position: relative;
        }

        /* 优化滚动条样式（可选，增加美观度） */
        .alarm-list-panel::-webkit-scrollbar {
            width: 6px;
        }
        .alarm-list-panel::-webkit-scrollbar-thumb {
            background: var(--color-border);
            border-radius: 10px;
        }

        .alarm-list-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--color-text-tertiary);
            text-align: center;
        }

        .alarm-list-empty i {
            font-size: 4rem;
            margin-bottom: var(--spacing-md);
            opacity: 0.3;
        }

        .alarm-list-empty p {
            margin: 0;
            font-size: var(--font-size-md);
        }

        .alarm-list-empty-sub {
            font-size: var(--font-size-sm);
            opacity: 0.7;
            margin-top: var(--spacing-xs);
        }

        /* 任务卡片 */
        .alarm-task-card {
            background: white;
            border-radius: 1rem;
            padding: 1rem 1.25rem;
            border: 1px solid var(--color-border);
            display: flex;
            align-items: center;
            gap: 1.25rem;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .alarm-task-card::before {
            content: '';
            position: absolute;
            left: 6px;
            top: 20%;
            bottom: 20%;
            width: 5px;
            background: var(--color-primary);
            border-radius: 10px;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .alarm-task-card:not(.disabled)::before {
            opacity: 1;
        }

        /* 12种暖色调随机呈现 (通过 nth-child 模拟) */
        .alarm-task-card:not(.disabled):nth-child(12n+1)::before { background: #ff5f6d; }
        .alarm-task-card:not(.disabled):nth-child(12n+2)::before { background: #ff7e5f; }
        .alarm-task-card:not(.disabled):nth-child(12n+3)::before { background: #feb47b; }
        .alarm-task-card:not(.disabled):nth-child(12n+4)::before { background: #ff9a9e; }
        .alarm-task-card:not(.disabled):nth-child(12n+5)::before { background: #fecfef; }
        .alarm-task-card:not(.disabled):nth-child(12n+6)::before { background: #fda085; }
        .alarm-task-card:not(.disabled):nth-child(12n+7)::before { background: #f6d365; }
        .alarm-task-card:not(.disabled):nth-child(12n+8)::before { background: #f093fb; }
        .alarm-task-card:not(.disabled):nth-child(12n+9)::before { background: #f5576c; }
        .alarm-task-card:not(.disabled):nth-child(12n+10)::before { background: #fa709a; }
        .alarm-task-card:not(.disabled):nth-child(12n+11)::before { background: #ee9ca7; }
        .alarm-task-card:not(.disabled):nth-child(12n+12)::before { background: #ffecd2; }

        .alarm-task-card:hover {
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.05);
            transform: translateX(6px);
            border-color: var(--color-primary-light);
        }

        /* 拖拽手柄 */
        .alarm-task-drag-handle {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            color: var(--color-text-tertiary);
            cursor: grab;
            opacity: 0;
            transition: opacity 0.2s ease;
            font-size: 1.2rem;
        }

        .alarm-task-card:hover .alarm-task-drag-handle {
            opacity: 1;
        }

        .alarm-task-drag-handle:active {
            cursor: grabbing;
        }

        /* Sortable.js 拖拽样式 */
        .sortable-drag {
            opacity: 1 !important;
            transform: scale(1.03) rotate(1.5deg) !important;
            background: white !important;
            border: 2px solid var(--color-primary) !important;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15) !important;
            z-index: 9999 !important;
            cursor: grabbing !important;
        }

        /* 拖拽时的占位符 */
        .sortable-ghost {
            background: #eef2f7 !important;
            border: 2px dashed #cbd5e1 !important;
            border-radius: 1rem !important;
            opacity: 0.5 !important;
            box-shadow: inset 0 2px 8px rgba(0,0,0,0.06) !important;
        }

        .sortable-ghost * {
            visibility: hidden;
        }

        /* 选中瞬间 */
        .sortable-chosen {
            transition: 0.2s;
            box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
        }

        /* 其他卡片的过渡动画 */
        .alarm-task-card {
            transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), 
                        box-shadow 0.3s ease;
        }

        .alarm-task-card.disabled {
            background: #f1f5f9;
            border-color: transparent;
            filter: grayscale(0.8);
            opacity: 0.7;
        }

        .alarm-task-card.disabled::before {
            background: var(--color-text-tertiary);
        }

        /* 暂停状态样式 */
        .alarm-task-card.paused {
            background: #fef3c7;
            border-color: #fbbf24;
            position: relative;
        }

        .alarm-task-card.paused::before {
            background: #fbbf24;
        }

        .alarm-task-card.paused .alarm-task-countdown {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
            animation: none;
        }

        /* 暂停遮罩层 */
        .alarm-task-paused-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(251, 191, 36, 0.1);
            border-radius: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            pointer-events: none;
            z-index: 1;
        }

        .alarm-task-paused-overlay i {
            font-size: 4rem;
            color: rgba(251, 191, 36, 0.3);
        }

        /* 暂停徽章 */
        .alarm-task-paused-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
            color: white;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            margin-left: 8px;
        }

        /* 时间已过提示 */
        .alarm-task-time-passed {
            font-size: 12px;
            color: #94a3b8;
            font-weight: 500;
        }

        .alarm-task-countdown {
            min-width: 110px;
            padding: 0.75rem 1rem;
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            border-radius: 0.75rem;
            color: white;
            text-align: center;
            font-family: 'JetBrains Mono', 'Courier New', monospace;
            font-size: 1.125rem;
            font-weight: 700;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.2);
            transition: all 0.3s ease;
            position: relative;
        }

        /* 为正在执行的任务添加多样性颜色 */
        .alarm-task-card:not(.disabled):nth-child(3n+1) .alarm-task-countdown {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
        }
        .alarm-task-card:not(.disabled):nth-child(3n+2) .alarm-task-countdown {
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
            box-shadow: 0 4px 12px rgba(124, 58, 237, 0.25);
        }
        .alarm-task-card:not(.disabled):nth-child(3n+3) .alarm-task-countdown {
            background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
            box-shadow: 0 4px 12px rgba(8, 145, 178, 0.25);
        }

        /* 正在执行的任务呼吸灯效果 */
        @keyframes countdownPulse {
            0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.4); }
            70% { box-shadow: 0 0 0 6px rgba(37, 99, 235, 0); }
            100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
        }

        .alarm-task-card:not(.disabled) .alarm-task-countdown {
            animation: countdownPulse 2s infinite;
        }

        .alarm-task-card.disabled .alarm-task-countdown {
            background: #94a3b8;
            box-shadow: none;
            animation: none;
        }

        .alarm-task-info {
            flex: 1;
            min-width: 0;
        }

        .alarm-task-name {
            font-size: 1rem;
            font-weight: 600;
            color: var(--color-text-primary);
            margin-bottom: 0.25rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .alarm-task-meta {
            display: flex;
            gap: 1rem;
            font-size: 0.75rem;
            color: var(--color-text-tertiary);
        }

        .alarm-task-meta-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .alarm-task-meta-item i {
            font-size: 0.875rem;
            color: var(--color-primary);
            opacity: 0.7;
        }

        .alarm-task-actions {
            display: flex;
            gap: 0.5rem;
        }

        .alarm-task-btn {
            width: 34px;
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--color-border);
            background: white;
            border-radius: 0.5rem;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 1rem;
            color: var(--color-text-secondary);
        }

        .alarm-task-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 2px 6px rgba(0,0,0,0.05);
        }

        .alarm-task-btn--toggle:hover {
            border-color: #22c55e;
            color: #22c55e;
        }

        .alarm-task-btn--toggle.active {
            background: #22c55e;
            border-color: #22c55e;
            color: white;
        }

        .alarm-task-btn--delete:hover {
            border-color: #ef4444;
            color: #ef4444;
        }

        /* 响应式适配 */
        @media (max-width: 900px) {
            .alarm-main-container {
                grid-template-columns: 1fr;
            }

            .alarm-header-stats {
                flex-wrap: wrap;
            }

            .alarm-stat-card {
                min-width: calc(50% - var(--spacing-md));
            }
        }
    `;
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
    
    // 只有首次加载时才从 localStorage 加载任务并启动定时器
    // 切换标签页回来时，任务和定时器已经在后台运行，只需刷新 UI
    if (!isToolInitialized) {
        // 首次加载：加载音频文件列表
        await loadAvailableAudioFiles();
        
        // 加载任务并启动定时器
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
                        <i class="ri-music-line" style="font-size: 48px; opacity: 0.3;"></i>
                        <p>未找到音频文件</p>
                        <p style="font-size: 12px; opacity: 0.6;">请将音频文件放入 Kit/clock 文件夹</p>
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
                        { name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'ps1', 'sh'] },
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
// 获取或创建共享的 AudioContext
// ============================================
function getAudioContext() {
    if (!alarmState.audioContext || alarmState.audioContext.state === 'closed') {
        alarmState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return alarmState.audioContext;
}

// ============================================
// 播放预览声音
// ============================================
function playPreviewSound(soundId) {
    // 使用共享的音频上下文
    try {
        const audioContext = getAudioContext();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // 根据不同声音ID设置不同频率
        const frequencies = {
            bell: 800,
            alarm: 600,
            chime: 1000,
            beep: 440,
            ding: 1200
        };
        
        oscillator.frequency.value = frequencies[soundId] || 440;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (err) {
        console.error('[AlarmClock] 播放预览声音失败:', err);
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
    
    // 构建任务对象
    const task = {
        id: Date.now().toString(),
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
            const hours = parseInt(document.getElementById('countdownHours')?.value || 0);
            const minutes = parseInt(document.getElementById('countdownMinutes')?.value || 0);
            const seconds = parseInt(document.getElementById('countdownSeconds')?.value || 0);
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
            task.config.repeatDays = getSelectedRepeatDays();
            break;
            
        case 'hourly':
            task.config.repeatDays = getSelectedRepeatDays();
            break;
            
        case 'interval':
            const intervalValue = parseInt(document.getElementById('intervalValue')?.value || 30);
            const intervalUnit = document.getElementById('intervalUnit')?.value || 'minutes';
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
    
    // 保存任务
    saveTasks();
    
    // 启动任务
    startTask(task);
    
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
}

// ============================================
// 启动任务
// ============================================
async function startTask(task) {
    if (!task.enabled) return;
    
    // 清除之前的定时器
    if (alarmState.timers[task.id]) {
        clearInterval(alarmState.timers[task.id]);
    }
    
    // 智能预加载音频（只为即将触发的任务预加载）
    if (shouldPreloadAudio(task)) {
        cleanupPreloadedAudio(task.id); // 先清理旧的
        const preloadedAudio = await preloadAudio(task);
        if (preloadedAudio) {
            addToPreloadCache(task.id, preloadedAudio);
        }
    }
    
    switch (task.type) {
        case 'countdown':
            // 倒计时任务 - 每秒更新
            alarmState.timers[task.id] = setInterval(async () => {
                // 检查暂停状态
                if (!task.paused) {
                    task.config.remainingSeconds--;
                    
                    // 当接近触发时间时预加载音频
                    if (task.action === 'sound' && 
                        task.config.remainingSeconds === 60 && 
                        !alarmState.preloadedAudios.has(task.id)) {
                        console.log(`[AlarmClock] 倒计时即将触发，提前预加载音频: ${task.name}`);
                        const preloadedAudio = await preloadAudio(task);
                        if (preloadedAudio) {
                            addToPreloadCache(task.id, preloadedAudio);
                        }
                    }
                    
                    if (task.config.remainingSeconds <= 0) {
                        // 时间到，先停止定时器，再执行动作
                        // 这里只清除定时器，不清理音频（因为音频即将播放）
                        if (alarmState.timers[task.id]) {
                            clearInterval(alarmState.timers[task.id]);
                            delete alarmState.timers[task.id];
                            console.log(`[AlarmClock] 倒计时完成，清除定时器: ${task.id}`);
                        }
                        
                        task.enabled = false;
                        alarmState.completedToday++;
                        
                        // 执行动作（播放音频/显示通知等）
                        executeAction(task);
                        
                        saveTasks();
                        renderTaskList();
                        updateStats();
                    }
                }
            }, 1000);
            break;
            
        case 'fixed':
            // 固定时间任务 - 每秒检查
            alarmState.timers[task.id] = setInterval(async () => {
                // 检查暂停状态
                if (task.paused) return;
                
                const now = new Date();
                const currentDay = now.getDay();
                const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                
                // 提前1分钟预加载音频
                if (task.action === 'sound' && !alarmState.preloadedAudios.has(task.id)) {
                    const [hours, minutes] = task.config.time.split(':').map(Number);
                    const target = new Date();
                    target.setHours(hours, minutes, 0, 0);
                    if (target <= now) {
                        target.setDate(target.getDate() + 1);
                    }
                    const diffSeconds = Math.floor((target - now) / 1000);
                    if (diffSeconds <= 60 && diffSeconds > 0) {
                        console.log(`[AlarmClock] 固定时间即将触发，提前预加载音频: ${task.name}`);
                        const preloadedAudio = await preloadAudio(task);
                        if (preloadedAudio) {
                            addToPreloadCache(task.id, preloadedAudio);
                        }
                    }
                }
                
                if (task.config.repeatDays.includes(currentDay) && 
                    currentTime === task.config.time &&
                    now.getSeconds() === 0) {
                    executeAction(task);
                    alarmState.completedToday++;
                    updateStats();
                }
            }, 1000);
            break;
            
        case 'hourly':
            // 整点报时 - 每秒检查
            alarmState.timers[task.id] = setInterval(async () => {
                // 检查暂停状态
                if (task.paused) return;
                
                const now = new Date();
                const currentDay = now.getDay();
                
                // 提前1分钟预加载音频
                if (task.action === 'sound' && !alarmState.preloadedAudios.has(task.id)) {
                    const nextHour = new Date();
                    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
                    const diffSeconds = Math.floor((nextHour - now) / 1000);
                    if (diffSeconds <= 60 && diffSeconds > 0) {
                        console.log(`[AlarmClock] 整点报时即将触发，提前预加载音频: ${task.name}`);
                        const preloadedAudio = await preloadAudio(task);
                        if (preloadedAudio) {
                            addToPreloadCache(task.id, preloadedAudio);
                        }
                    }
                }
                
                if (task.config.repeatDays.includes(currentDay) &&
                    now.getMinutes() === 0 &&
                    now.getSeconds() === 0) {
                    executeAction(task);
                    alarmState.completedToday++;
                    updateStats();
                }
            }, 1000);
            break;
            
        case 'interval':
            // 间隔提醒 - 使用 setInterval
            alarmState.timers[task.id] = setInterval(() => {
                // 检查暂停状态
                if (!task.paused) {
                    executeAction(task);
                    alarmState.completedToday++;
                    updateStats();
                }
            }, task.config.intervalMs);
            break;
    }
}

// ============================================
// 停止任务
// ============================================
function stopTask(taskId) {
    console.log(`[AlarmClock] 停止任务: ${taskId}`);
    
    // 清除定时器
    if (alarmState.timers[taskId]) {
        clearInterval(alarmState.timers[taskId]);
        delete alarmState.timers[taskId];
        console.log(`[AlarmClock] 已清除定时器: ${taskId}`);
    }
    
    // 清理预加载的音频
    cleanupPreloadedAudio(taskId);
    
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
    
    // 对于间隔提醒，需要停止定时器
    if (task.type === 'interval') {
        if (alarmState.timers[taskId]) {
            clearInterval(alarmState.timers[taskId]);
            delete alarmState.timers[taskId];
        }
    }
    
    // 其他类型的任务不需要停止定时器，只需要标记暂停状态
    // 在定时器回调中会检查paused状态
    
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
    
    // 对于间隔提醒，需要重新启动定时器
    if (task.type === 'interval') {
        alarmState.timers[task.id] = setInterval(() => {
            if (!task.paused) {
                executeAction(task);
                alarmState.completedToday++;
                updateStats();
            }
        }, task.config.intervalMs);
    }
    
    // 其他类型的任务会在定时器回调中自动恢复
    
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
        startTask(task);
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
// 执行动作
// ============================================
async function executeAction(task) {
    console.log(`[AlarmClock] 执行任务: ${task.name}, 动作: ${task.action}`);
    
    switch (task.action) {
        case 'notify':
            showNotification(task);
            break;
            
        case 'sound':
            // 使用队列机制播放音频
            await playAudioWithQueue(task);
            showNotification(task);
            break;
            
        case 'run':
            await runProgram(task.config.filePath);
            break;
            
        case 'shutdown':
            await shutdownComputer();
            break;
            
        case 'lock':
            await lockScreen();
            break;
    }
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
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999998;
        animation: overlayFadeIn 0.3s ease;
        cursor: pointer;
    `;
    
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
            if (audioController.onEnded) {
                audioController.audio.removeEventListener('ended', audioController.onEnded);
                audioController.onEnded = null;
            }
            if (audioController.onError) {
                audioController.audio.removeEventListener('error', audioController.onError);
                audioController.onError = null;
            }
            
            audioController.audio.pause();
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
            overlayEl.style.animation = 'overlayFadeOut 0.3s ease forwards';
            setTimeout(() => overlayEl.remove(), 300);
        }
        
        // 移除 Toast
        const toastEl = document.getElementById(`alarm-toast-${task.id}`);
        if (toastEl) {
            toastEl.style.animation = 'alarmToastOut 0.3s ease forwards';
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
        <div style="display: flex; align-items: center; gap: 16px;">
            <i class="ri-alarm-warning-line" style="font-size: 36px; animation: alarmPulse 0.8s infinite;"></i>
            <div style="flex: 1;">
                <div style="font-weight: 700; font-size: 20px;">⏰ 闹钟响了！</div>
                <div style="font-size: 16px; opacity: 0.95; margin-top: 6px;">${escapeHtml(task.name)}</div>
            </div>
            <button id="dismissAlarmBtn-${task.id}" class="alarm-dismiss-btn" style="
                background: #ff4757;
                border: none;
                border-radius: 12px;
                color: white;
                padding: 16px 32px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 700;
                transition: all 0.2s;
                white-space: nowrap;
                box-shadow: 0 4px 12px rgba(255, 71, 87, 0.4);
            ">🔔 停止闹钟</button>
        </div>
    `;
    
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 20px 24px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border-radius: 16px;
        font-size: 14px;
        z-index: 999999;
        box-shadow: 0 16px 48px rgba(102, 126, 234, 0.5), 0 0 0 3px rgba(255, 255, 255, 0.3);
        animation: alarmToastIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        min-width: 400px;
        max-width: 550px;
        border: 2px solid rgba(255, 255, 255, 0.4);
    `;
    
    document.body.appendChild(toast);
    
    const dismissBtn = document.getElementById(`dismissAlarmBtn-${task.id}`);
    if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止事件冒泡到遮罩层
            dismissAlarm();
        });
        
        dismissBtn.addEventListener('mouseenter', () => {
            dismissBtn.style.background = '#ff6b7a';
            dismissBtn.style.transform = 'scale(1.05)';
        });
        dismissBtn.addEventListener('mouseleave', () => {
            dismissBtn.style.background = '#ff4757';
            dismissBtn.style.transform = 'scale(1)';
        });
    }
    
    // 添加CSS动画（如果还没有）
    if (!document.querySelector('#alarmToastAnimations')) {
        const style = document.createElement('style');
        style.id = 'alarmToastAnimations';
        style.textContent = `
            @keyframes alarmToastIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -30px) scale(0.9);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, 0) scale(1);
                }
            }
            @keyframes alarmToastOut {
                from {
                    opacity: 1;
                    transform: translate(-50%, 0) scale(1);
                }
                to {
                    opacity: 0;
                    transform: translate(-50%, -30px) scale(0.9);
                }
            }
            @keyframes alarmPulse {
                0%, 100% { 
                    transform: scale(1); 
                    opacity: 1; 
                }
                50% { 
                    transform: scale(1.2); 
                    opacity: 0.7; 
                }
            }
            @keyframes alarmGlow {
                0%, 100% {
                    box-shadow: 0 16px 48px rgba(102, 126, 234, 0.5), 0 0 0 3px rgba(255, 255, 255, 0.3);
                }
                50% {
                    box-shadow: 0 16px 48px rgba(102, 126, 234, 0.7), 0 0 20px rgba(255, 71, 87, 0.5), 0 0 0 3px rgba(255, 255, 255, 0.5);
                }
            }
            @keyframes overlayFadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes overlayFadeOut {
                from { opacity: 1; }
                to { opacity: 0; }
            }
            .dtkit-toast--alarm {
                animation: alarmToastIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), alarmGlow 1.5s infinite !important;
            }
        `;
        document.head.appendChild(style);
    }
}

// ============================================
// 音频播放队列管理
// ============================================

// 使用队列播放音频（确保同时只播放一个）
async function playAudioWithQueue(task) {
    // 如果已有音频在播放，加入队列
    if (alarmState.currentPlayingAudio && !alarmState.currentPlayingAudio.stop) {
        console.log('[AlarmClock] 音频正在播放，加入队列');
        alarmState.audioQueue.push(task);
        return;
    }
    
    // 直接播放
    await playAudioLoop(task);
}

// 处理队列中的下一个音频
async function processNextAudioInQueue() {
    if (alarmState.audioQueue.length > 0) {
        const nextTask = alarmState.audioQueue.shift();
        await playAudioLoop(nextTask);
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
        return;
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
    
    // 优先使用预加载的音频（零延迟播放）
    let audio = alarmState.preloadedAudios.get(task.id);
    
    if (audio) {
        console.log(`[AlarmClock] ⚡ 使用预加载音频，零延迟播放: ${audioName}`);
        // 重置播放位置
        audio.currentTime = 0;
        // 从缓存中移除（播放时独占使用）
        alarmState.preloadedAudios.delete(task.id);
        // 预加载的音频可能有 Blob URL
        if (audio.src && audio.src.startsWith('blob:')) {
            controller.blobUrl = audio.src;
        }
    } else {
        console.log(`[AlarmClock] ⏳ 未找到预加载音频，动态加载（可能有延迟）: ${audioName}`);
        // 降级方案：动态创建
        audio = new Audio();
        const convertedPath = await convertPath(audioPath);
        audio.src = convertedPath;
        audio.volume = 0.7;
        // 记录 Blob URL
        if (convertedPath.startsWith('blob:')) {
            controller.blobUrl = convertedPath;
        }
    }
    
    controller.audio = audio;
    alarmState.currentPlayingAudio = controller;
    alarmState.activeLoopControllers.set(task.id, controller);
    
    // 显示带控制按钮的通知
    showNotification(task, controller);
    
    // 循环播放逻辑
    let playCount = 0;
    const maxDuration = 7 * 60 * 1000; // 7分钟
    let isPlaying = false; // 防止重复播放
    
    const playOnce = async () => {
        if (controller.stop || isPlaying) {
            if (controller.stop) {
                console.log('[AlarmClock] 音频播放已停止');
                cleanup();
            }
            return;
        }
        
        // 检查是否超过7分钟
        if (Date.now() - controller.startTime > maxDuration) {
            console.log('[AlarmClock] 音频播放时长已达7分钟，自动停止');
            cleanup();
            return;
        }
        
        isPlaying = true;
        playCount++;
        console.log(`[AlarmClock] 播放音频 - 第 ${playCount} 次`);
        
        try {
            // 确保音频可以播放
            if (audio.readyState < 2) {
                // 等待音频加载
                await new Promise((resolve, reject) => {
                    const onCanPlay = () => {
                        audio.removeEventListener('canplay', onCanPlay);
                        audio.removeEventListener('error', onError);
                        resolve();
                    };
                    const onError = (e) => {
                        audio.removeEventListener('canplay', onCanPlay);
                        audio.removeEventListener('error', onError);
                        reject(e);
                    };
                    audio.addEventListener('canplay', onCanPlay);
                    audio.addEventListener('error', onError);
                    // 超时保护
                    setTimeout(() => reject(new Error('音频加载超时')), 5000);
                });
            }
            
            if (!controller.stop) {
                await audio.play();
            }
        } catch (err) {
            console.error('[AlarmClock] 播放音频失败:', err);
            isPlaying = false;
            // 不要立即 cleanup，可能只是暂时的错误
            if (err.name !== 'AbortError') {
                cleanup();
            }
        }
    };
    
    // 音频播放结束后再次播放 - 使用命名函数以便移除
    controller.onEnded = () => {
        isPlaying = false; // 重置播放状态
        if (!controller.stop && Date.now() - controller.startTime < maxDuration) {
            // 重置播放位置
            audio.currentTime = 0;
            // 减少延迟到100ms，并保存 timeoutId
            controller.timeoutId = setTimeout(playOnce, 100);
        } else {
            cleanup();
        }
    };
    audio.addEventListener('ended', controller.onEnded);
    
    // 音频加载错误 - 使用命名函数以便移除
    controller.onError = (e) => {
        console.error('[AlarmClock] 音频加载失败:', e);
        showToast(`音频加载失败: ${audioName}`, 'error');
        cleanup();
    };
    audio.addEventListener('error', controller.onError);
    
    // 清理函数 - 彻底释放所有资源
    function cleanup() {
        if (controller.stop && !controller.audio) {
            // 已经清理过了
            return;
        }
        
        console.log(`[AlarmClock] 清理音频资源: ${controller.taskName}`);
        controller.stop = true;
        
        // 清除 setTimeout
        if (controller.timeoutId) {
            clearTimeout(controller.timeoutId);
            controller.timeoutId = null;
        }
        
        if (audio) {
            // 移除事件监听器（防止内存泄漏）
            if (controller.onEnded) {
                audio.removeEventListener('ended', controller.onEnded);
                controller.onEnded = null;
            }
            if (controller.onError) {
                audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }
            
            // 停止并清理音频
            audio.pause();
            const audioSrc = audio.src;
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
    playOnce();
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
            if (controller.onEnded) {
                controller.audio.removeEventListener('ended', controller.onEnded);
                controller.onEnded = null;
            }
            if (controller.onError) {
                controller.audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }
            
            controller.audio.pause();
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
            if (controller.onEnded) {
                controller.audio.removeEventListener('ended', controller.onEnded);
                controller.onEnded = null;
            }
            if (controller.onError) {
                controller.audio.removeEventListener('error', controller.onError);
                controller.onError = null;
            }
            
            controller.audio.pause();
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
    
    // 移除所有遮罩层和 Toast
    document.querySelectorAll('[id^="alarm-overlay-"]').forEach(el => el.remove());
    document.querySelectorAll('[id^="alarm-toast-"]').forEach(el => el.remove());
    
    console.log('[AlarmClock] 已停止所有音频播放，资源已释放');
}

// ============================================
// 播放闹钟声音（已废弃，保留用于预览）
// ============================================
function playAlarmSound(soundId) {
    // 此函数已被playAudioLoop替代，仅用于预览音频
    console.log('[AlarmClock] playAlarmSound已废弃，请使用playAudioLoop');
}

// ============================================
// 运行程序
// ============================================
async function runProgram(filePath) {
    try {
        // 获取文件扩展名
        const ext = filePath.toLowerCase().split('.').pop();
        
        // 对于 .bat, .cmd, .ps1 脚本，使用 cmd 或 powershell 执行
        if (ext === 'bat' || ext === 'cmd') {
            // 使用 start 命令在后台启动，避免阻塞应用
            await window.__TAURI__.core.invoke('run_command', {
                cmd: 'cmd',
                args: ['/c', 'start', '', filePath]
            });
        } else if (ext === 'ps1') {
            await window.__TAURI__.core.invoke('run_command', {
                cmd: 'cmd',
                args: ['/c', 'start', 'powershell', '-ExecutionPolicy', 'Bypass', '-File', filePath]
            });
        } else {
            // 其他可执行文件使用 shell.open
            await window.__TAURI__.shell.open(filePath);
        }
        showToast('程序已启动', 'success');
    } catch (err) {
        console.error('[AlarmClock] 运行程序失败:', err);
        showToast('运行程序失败: ' + err, 'error');
    }
}

// ============================================
// 关闭电脑
// ============================================
async function shutdownComputer() {
    try {
        // Windows 关机命令
        await window.__TAURI__.core.invoke('run_command', {
            cmd: 'shutdown',
            args: ['/s', '/t', '60']  // 60秒后关机，给用户时间取消
        });
        showToast('电脑将在60秒后关机', 'warning');
    } catch (err) {
        console.error('[AlarmClock] 关机失败:', err);
        showToast('执行关机命令失败', 'error');
    }
}

// ============================================
// 锁定屏幕
// ============================================
async function lockScreen() {
    try {
        // Windows 锁屏命令
        await window.__TAURI__.core.invoke('run_command', {
            cmd: 'rundll32.exe',
            args: ['user32.dll,LockWorkStation']
        });
    } catch (err) {
        console.error('[AlarmClock] 锁屏失败:', err);
        showToast('执行锁屏命令失败', 'error');
    }
}

// ============================================
// 保存任务到 localStorage
// ============================================
function saveTasks() {
    const data = {
        tasks: alarmState.tasks,
        completedToday: alarmState.completedToday,
        lastDate: new Date().toDateString()
    };
    localStorage.setItem('alarm_clock_data', JSON.stringify(data));
}

// ============================================
// 加载任务
// ============================================
function loadTasks() {
    try {
        const saved = localStorage.getItem('alarm_clock_data');
        if (saved) {
            const data = JSON.parse(saved);
            alarmState.tasks = data.tasks || [];
            
            // 检查日期，重置今日计数
            if (data.lastDate === new Date().toDateString()) {
                alarmState.completedToday = data.completedToday || 0;
            } else {
                alarmState.completedToday = 0;
            }
            
            // 重启启用的任务
            alarmState.tasks.forEach(task => {
                if (task.enabled) {
                    startTask(task);
                }
            });
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
    initSortable();
}

// ============================================
// 初始化 Sortable.js 拖拽排序
// ============================================
function initSortable() {
    const panel = document.getElementById('taskListPanel');
    if (!panel || !window.Sortable || alarmState.tasks.length === 0) return;

    // 销毁旧的 Sortable 实例（防止累积）
    if (alarmState.sortableInstance) {
        alarmState.sortableInstance.destroy();
        alarmState.sortableInstance = null;
    }

    alarmState.sortableInstance = new Sortable(panel, {
        animation: 150,  // 动画速度稍微加快，体验更好
        handle: '.alarm-task-drag-handle',  // 只有点击手柄才能拖拽
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        chosenClass: 'sortable-chosen',
        
        onStart: function() {
            if (navigator.vibrate) navigator.vibrate(15);
        },
        
        onEnd: function(evt) {
            // 修正：根据 DOM 索引同步内存数组
            const tasks = [...alarmState.tasks];
            const [movedItem] = tasks.splice(evt.oldIndex, 1);
            tasks.splice(evt.newIndex, 0, movedItem);
            alarmState.tasks = tasks;
            saveTasks();
            // 注意：不要在这里调用 renderTaskList()，否则会触发 DOM 重建导致拖拽卡顿
        }
    });
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
    
    // 检查整点报时是否时间已过
    const isHourlyPassed = task.type === 'hourly' && isHourPassed();
    
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
    } else if (isHourlyPassed && task.type === 'hourly') {
        // 整点报时时间已过：不显示暂停/恢复按钮
        actionButtons = `
            <span class="alarm-task-time-passed">整点已过</span>
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

// 检查当前小时是否已过
function isHourPassed() {
    const now = new Date();
    return now.getMinutes() > 0;
}

// ============================================
// 获取任务倒计时显示
// ============================================
function getTaskCountdown(task) {
    if (!task.enabled) return '--:--:--';
    
    switch (task.type) {
        case 'countdown':
            return formatSeconds(task.config.remainingSeconds);
            
        case 'fixed':
            return getTimeUntilFixed(task.config.time);
            
        case 'hourly':
            return getTimeUntilNextHour();
            
        case 'interval':
            return `${task.config.intervalValue} ${task.config.intervalUnit === 'hours' ? '小时' : '分钟'}`;
            
        default:
            return '--:--:--';
    }
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
// 获取距离固定时间的倒计时
// ============================================
function getTimeUntilFixed(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    
    if (target <= now) {
        // 明天的这个时间
        target.setDate(target.getDate() + 1);
    }
    
    const diffMs = target - now;
    const diffSeconds = Math.floor(diffMs / 1000);
    return formatSeconds(diffSeconds);
}

// ============================================
// 获取距离下一个整点的倒计时
// ============================================
function getTimeUntilNextHour() {
    const now = new Date();
    const nextHour = new Date();
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    
    const diffMs = nextHour - now;
    const diffSeconds = Math.floor(diffMs / 1000);
    return formatSeconds(diffSeconds);
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
    
    // 找到最近的倒计时任务
    let minSeconds = Infinity;
    
    alarmState.tasks.forEach(task => {
        if (!task.enabled) return;
        
        if (task.type === 'countdown' && task.config.remainingSeconds < minSeconds) {
            minSeconds = task.config.remainingSeconds;
        }
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
    
    // 销毁 Sortable 实例
    if (alarmState.sortableInstance) {
        alarmState.sortableInstance.destroy();
        alarmState.sortableInstance = null;
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
    
    // 清理所有预加载的音频（释放内存）
    console.log(`[AlarmClock] 清理 ${alarmState.preloadedAudios.size} 个预加载音频`);
    alarmState.preloadedAudios.forEach((audio, taskId) => {
        cleanupPreloadedAudio(taskId);
    });
    
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
    styles: getStyles,
    init,
    destroy
});