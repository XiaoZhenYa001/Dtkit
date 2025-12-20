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
    countdownInterval: null // 全局倒计时更新定时器
};

// 标记工具是否已经初始化过（用于区分首次加载和标签页切换）
let isToolInitialized = false;

// 默认提示音列表
const DEFAULT_SOUNDS = [
    { id: 'bell', name: '铃声', icon: 'ri-notification-line' },
    { id: 'alarm', name: '闹钟', icon: 'ri-alarm-line' },
    { id: 'chime', name: '风铃', icon: 'ri-windy-line' },
    { id: 'beep', name: '蜂鸣', icon: 'ri-volume-up-line' },
    { id: 'ding', name: '叮咚', icon: 'ri-door-open-line' }
];

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
            overflow: hidden;
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
            overflow-y: auto;  /* 左侧独立滚动 */
            min-height: 0;     /* 允许缩小 */
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

        /* 右侧任务列表 */
        .alarm-list-panel {
            background: var(--color-bg-secondary);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            box-shadow: var(--shadow-md);
            border: 1px solid var(--color-border);
            overflow-y: auto;  /* 右侧独立滚动 */
            min-height: 0;     /* 允许缩小 */
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
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

        /* 拖拽中的卡片 */
        .alarm-task-card.dragging {
            opacity: 0.5;
            transform: scale(0.98);
            box-shadow: 0 15px 30px rgba(0, 0, 0, 0.15);
        }

        /* 拖拽目标位置 */
        .alarm-task-card.drag-over {
            border-top: 3px solid var(--color-primary);
            margin-top: -3px;
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
function init() {
    console.log('[AlarmClock] 初始化定时闹钟工具');
    
    // 只有首次加载时才从 localStorage 加载任务并启动定时器
    // 切换标签页回来时，任务和定时器已经在后台运行，只需刷新 UI
    if (!isToolInitialized) {
        // 首次加载：加载任务并启动定时器
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
    // 任务类型切换
    const taskTypeSelect = document.getElementById('alarmTaskType');
    if (taskTypeSelect) {
        taskTypeSelect.addEventListener('change', handleTaskTypeChange);
        // 初始化显示
        handleTaskTypeChange();
    }
    
    // 动作类型切换
    const actionTypeSelect = document.getElementById('alarmActionType');
    if (actionTypeSelect) {
        actionTypeSelect.addEventListener('change', handleActionTypeChange);
        // 初始化显示
        handleActionTypeChange();
    }
    
    // 添加任务按钮
    const addBtn = document.getElementById('addTaskBtn');
    if (addBtn) {
        addBtn.addEventListener('click', addTask);
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
        });
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
            // 显示声音选择器
            configArea.innerHTML = `
                <div class="alarm-input-group">
                    <label class="alarm-label">选择提示音</label>
                    <div class="alarm-sound-options" id="soundOptions">
                        ${DEFAULT_SOUNDS.map((sound, index) => `
                            <div class="alarm-sound-option ${index === 0 ? 'selected' : ''}" 
                                data-sound-id="${sound.id}">
                                <i class="${sound.icon}"></i>
                                <span>${sound.name}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            // 绑定声音选择事件
            bindSoundOptions();
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

// ============================================
// 声音选择绑定
// ============================================
function bindSoundOptions() {
    const options = document.querySelectorAll('.alarm-sound-option');
    options.forEach(option => {
        option.addEventListener('click', () => {
            options.forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            // 预览播放声音
            playPreviewSound(option.dataset.soundId);
        });
    });
}

// ============================================
// 文件选择绑定
// ============================================
function bindFileSelector() {
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
        });
    }
}

// ============================================
// 播放预览声音
// ============================================
function playPreviewSound(soundId) {
    // 创建音频上下文来生成简单的提示音
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
            const selectedSound = document.querySelector('.alarm-sound-option.selected');
            task.config.soundId = selectedSound?.dataset?.soundId || 'bell';
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
function startTask(task) {
    if (!task.enabled) return;
    
    // 清除之前的定时器
    if (alarmState.timers[task.id]) {
        clearInterval(alarmState.timers[task.id]);
    }
    
    switch (task.type) {
        case 'countdown':
            // 倒计时任务 - 每秒更新
            alarmState.timers[task.id] = setInterval(() => {
                task.config.remainingSeconds--;
                
                if (task.config.remainingSeconds <= 0) {
                    // 时间到，执行动作
                    executeAction(task);
                    stopTask(task.id);
                    task.enabled = false;
                    alarmState.completedToday++;
                    saveTasks();
                    renderTaskList();
                    updateStats();
                }
            }, 1000);
            break;
            
        case 'fixed':
            // 固定时间任务 - 每秒检查
            alarmState.timers[task.id] = setInterval(() => {
                const now = new Date();
                const currentDay = now.getDay();
                const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                
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
            alarmState.timers[task.id] = setInterval(() => {
                const now = new Date();
                const currentDay = now.getDay();
                
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
                executeAction(task);
                alarmState.completedToday++;
                updateStats();
            }, task.config.intervalMs);
            break;
    }
}

// ============================================
// 停止任务
// ============================================
function stopTask(taskId) {
    if (alarmState.timers[taskId]) {
        clearInterval(alarmState.timers[taskId]);
        delete alarmState.timers[taskId];
    }
}

// ============================================
// 切换任务状态
// ============================================
function toggleTask(taskId) {
    const task = alarmState.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    task.enabled = !task.enabled;
    
    if (task.enabled) {
        // 重新启动任务
        if (task.type === 'countdown') {
            // 重置倒计时
            task.config.remainingSeconds = task.config.totalSeconds;
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
            playAlarmSound(task.config.soundId);
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
// 显示通知
// ============================================
function showNotification(task) {
    // 使用浏览器通知
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            new Notification('定时提醒', {
                body: task.name,
                icon: '/src/assets/icon.png'
            });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('定时提醒', {
                        body: task.name,
                        icon: '/src/assets/icon.png'
                    });
                }
            });
        }
    }
    
    // 同时显示Toast
    showToast(`⏰ ${task.name}`, 'info');
}

// ============================================
// 播放闹钟声音
// ============================================
function playAlarmSound(soundId) {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        const frequencies = {
            bell: 800,
            alarm: 600,
            chime: 1000,
            beep: 440,
            ding: 1200
        };
        
        oscillator.frequency.value = frequencies[soundId] || 440;
        oscillator.type = 'sine';
        
        // 持续1.5秒，更明显
        gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 1.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 1.5);
    } catch (err) {
        console.error('[AlarmClock] 播放声音失败:', err);
    }
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
    const emptyHint = document.getElementById('emptyListHint');
    
    if (!panel) return;
    
    // 清除旧的任务卡片（保留 emptyHint）
    const oldCards = panel.querySelectorAll('.alarm-task-card');
    oldCards.forEach(card => card.remove());
    
    if (alarmState.tasks.length === 0) {
        if (emptyHint) emptyHint.style.display = 'flex';
        return;
    }
    
    if (emptyHint) emptyHint.style.display = 'none';
    
    alarmState.tasks.forEach(task => {
        const card = createTaskCard(task);
        panel.appendChild(card);
    });
}

// ============================================
// 创建任务卡片
// ============================================
function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = `alarm-task-card ${task.enabled ? '' : 'disabled'}`;
    card.dataset.taskId = task.id;
    card.draggable = true;  // 启用拖拽
    
    const countdown = getTaskCountdown(task);
    
    card.innerHTML = `
        <div class="alarm-task-drag-handle" title="拖拽排序">
            <i class="ri-drag-move-2-line"></i>
        </div>
        <div class="alarm-task-countdown" data-countdown-id="${task.id}">
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
            </div>
        </div>
        <div class="alarm-task-actions">
            <button class="alarm-task-btn alarm-task-btn--toggle ${task.enabled ? 'active' : ''}" 
                data-task-id="${task.id}" title="${task.enabled ? '暂停' : '启动'}">
                <i class="ri-${task.enabled ? 'pause' : 'play'}-line"></i>
            </button>
            <button class="alarm-task-btn alarm-task-btn--delete" 
                data-task-id="${task.id}" title="删除">
                <i class="ri-delete-bin-line"></i>
            </button>
        </div>
    `;
    
    // 绑定按钮事件
    const toggleBtn = card.querySelector('.alarm-task-btn--toggle');
    const deleteBtn = card.querySelector('.alarm-task-btn--delete');
    
    toggleBtn.addEventListener('click', () => toggleTask(task.id));
    deleteBtn.addEventListener('click', () => deleteTask(task.id));
    
    // 绑定拖拽事件
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragenter', handleDragEnter);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', handleDrop);
    
    return card;
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
// 拖拽排序相关
// ============================================
let draggedTaskId = null;

function handleDragStart(e) {
    draggedTaskId = e.currentTarget.dataset.taskId;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    // 移除所有 drag-over 样式
    document.querySelectorAll('.alarm-task-card.drag-over').forEach(card => {
        card.classList.remove('drag-over');
    });
    draggedTaskId = null;
}

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    e.preventDefault();
    const card = e.currentTarget;
    if (card.dataset.taskId !== draggedTaskId) {
        card.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    const card = e.currentTarget;
    // 确保离开的是卡片本身，而不是子元素
    if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drag-over');
    }
}

function handleDrop(e) {
    e.preventDefault();
    const targetCard = e.currentTarget;
    const targetTaskId = targetCard.dataset.taskId;
    
    if (draggedTaskId && targetTaskId && draggedTaskId !== targetTaskId) {
        // 找到拖拽的任务和目标任务的索引
        const draggedIndex = alarmState.tasks.findIndex(t => t.id === draggedTaskId);
        const targetIndex = alarmState.tasks.findIndex(t => t.id === targetTaskId);
        
        if (draggedIndex !== -1 && targetIndex !== -1) {
            // 从数组中移除拖拽的任务
            const [draggedTask] = alarmState.tasks.splice(draggedIndex, 1);
            // 插入到目标位置
            alarmState.tasks.splice(targetIndex, 0, draggedTask);
            
            // 保存并重新渲染
            saveTasks();
            renderTaskList();
        }
    }
    
    targetCard.classList.remove('drag-over');
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
    
    // 注意：不清除任务定时器，让它们在后台继续运行
    // 这样即使切换到其他工具，定时任务仍然会执行
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