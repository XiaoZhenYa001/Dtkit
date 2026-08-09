export function getAlarmTemplate() {
    return `
        <div class="view-container alarm-clock-view">
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
                <div class="alarm-sync-status" id="alarmSyncStatus" data-state="idle" role="status" aria-live="polite">
                    <i class="ri-check-line"></i>
                    <span>调度就绪</span>
                </div>
                <button id="stopAllAlarmsBtn" class="alarm-stop-all-btn" type="button" title="停止所有正在播放的闹钟">
                    <i class="ri-stop-circle-line"></i> 停止所有闹钟
                </button>
            </div>

            <div class="alarm-main-container">
                <div class="alarm-config-panel">
                    <h3 class="alarm-panel-title">
                        <i class="ri-add-circle-line"></i> 新建定时任务
                    </h3>

                    <div class="alarm-input-group">
                        <label class="alarm-label" for="alarmTaskName">任务名称</label>
                        <input type="text" id="alarmTaskName" class="alarm-input" maxlength="80"
                            placeholder="例如：该喝水了、下班打卡...">
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label" for="alarmTaskType">定时类型</label>
                        <select id="alarmTaskType" class="alarm-select">
                            <option value="countdown">倒计时</option>
                            <option value="fixed">固定时间</option>
                            <option value="hourly">整点报时</option>
                            <option value="interval">间隔提醒</option>
                        </select>
                    </div>

                    <div class="alarm-input-group" id="timeInputGroup">
                        <label class="alarm-label" id="timeInputLabel" for="alarmTimeInput">设定时间</label>
                        <input type="time" id="alarmTimeInput" class="alarm-input" value="09:00">
                        <div id="countdownInputs" class="alarm-countdown-inputs is-initially-hidden">
                            <input type="number" id="countdownHours" class="alarm-input alarm-input--small"
                                min="0" max="23" value="0" placeholder="时" aria-label="倒计时小时">
                            <span class="alarm-time-sep">:</span>
                            <input type="number" id="countdownMinutes" class="alarm-input alarm-input--small"
                                min="0" max="59" value="5" placeholder="分" aria-label="倒计时分钟">
                            <span class="alarm-time-sep">:</span>
                            <input type="number" id="countdownSeconds" class="alarm-input alarm-input--small"
                                min="0" max="59" value="0" placeholder="秒" aria-label="倒计时秒数">
                        </div>
                        <div id="intervalInputs" class="alarm-interval-inputs is-initially-hidden">
                            <span class="alarm-interval-text">每隔</span>
                            <input type="number" id="intervalValue" class="alarm-input alarm-input--small"
                                min="1" max="999" value="30" aria-label="提醒间隔">
                            <select id="intervalUnit" class="alarm-select alarm-select--small" aria-label="间隔单位">
                                <option value="minutes">分钟</option>
                                <option value="hours">小时</option>
                            </select>
                            <span class="alarm-interval-text">提醒一次</span>
                        </div>
                    </div>

                    <div class="alarm-input-group">
                        <label class="alarm-label" for="alarmActionType">执行动作</label>
                        <select id="alarmActionType" class="alarm-select">
                            <option value="notify">弹出消息通知</option>
                            <option value="sound">播放提示音</option>
                            <option value="run">运行程序或脚本</option>
                            <option value="shutdown">关闭电脑 (Shutdown)</option>
                            <option value="lock">锁定屏幕</option>
                        </select>
                    </div>

                    <div id="actionConfigArea" class="alarm-action-config"></div>

                    <div class="alarm-input-group">
                        <span class="alarm-label">重复设置</span>
                        <div class="alarm-repeat-options">
                            <label class="alarm-checkbox-label">
                                <input type="checkbox" id="repeatEnabled" checked>
                                <span>启用重复</span>
                            </label>
                            <div id="repeatDaysGroup" class="alarm-repeat-days">
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="1" checked><span>一</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="2" checked><span>二</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="3" checked><span>三</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="4" checked><span>四</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="5" checked><span>五</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="6"><span>六</span></label>
                                <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="0"><span>日</span></label>
                            </div>
                        </div>
                    </div>

                    <button id="addTaskBtn" class="alarm-btn-add" type="button">
                        <i class="ri-add-line"></i> 添加到任务列表
                    </button>
                </div>

                <div class="alarm-list-panel" id="taskListPanel">
                    <div class="alarm-list-empty" id="emptyListHint">
                        <i class="ri-alarm-line"></i>
                        <p>暂无定时任务</p>
                        <p class="alarm-list-empty-sub">在左侧创建你的第一个任务吧</p>
                    </div>
                </div>
            </div>
        </div>
    `;
}
