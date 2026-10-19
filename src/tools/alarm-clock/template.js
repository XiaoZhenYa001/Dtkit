export function getAlarmTemplate() {
    return `
        <div class="view-container alarm-clock-view">
            <header class="alarm-workspace-header">
                <div>
                    <p class="alarm-eyebrow">MAKE TIME FOR WHAT MATTERS</p>
                    <h1 class="alarm-title">定时闹钟<span>.</span></h1>
                    <p class="alarm-subtitle">把时间留给专注，把提醒交给这里。</p>
                </div>
                <div class="alarm-header-actions">
                    <div class="alarm-sync-status" id="alarmSyncStatus" data-state="idle" role="status">
                        <i class="ri-check-line" aria-hidden="true"></i><span>调度就绪</span>
                    </div>
                    <button id="stopAllAlarmsBtn" class="alarm-stop-all-btn" type="button" title="停止所有正在播放的提示音">
                        <i class="ri-stop-circle-line" aria-hidden="true"></i> 停止响铃
                    </button>
                </div>
            </header>

            <section class="alarm-overview" aria-label="时间概览">
                <div class="alarm-next-card">
                    <div class="alarm-next-label"><i class="ri-alarm-line" aria-hidden="true"></i> 下一个提醒</div>
                    <div class="alarm-next-title" id="nextAlarmName">留一点时间，给重要的事。</div>
                    <div class="alarm-next-time" id="nextAlarmCountdown" aria-label="距离下一个提醒">--:--:--</div>
                    <p class="alarm-next-detail" id="nextAlarmDetail">创建一个提醒，从容安排接下来的时间。</p>
                </div>
                <div class="alarm-overview-side">
                    <div class="alarm-clock-face">
                        <div class="alarm-current-time" id="alarmCurrentTime" aria-label="当前时间">--:--</div>
                        <p class="alarm-current-date" id="alarmCurrentDate"></p>
                    </div>
                    <div class="alarm-header-stats">
                        <div class="alarm-stat-card">
                            <span class="alarm-stat-label">进行中</span>
                            <span class="alarm-stat-value" id="activeTaskCount">0</span>
                        </div>
                        <div class="alarm-stat-card">
                            <span class="alarm-stat-label">今日已提醒</span>
                            <span class="alarm-stat-value" id="completedTodayCount">0</span>
                        </div>
                    </div>
                </div>
            </section>

            <div class="alarm-main-container">
                <section class="alarm-config-panel" aria-labelledby="alarmFormTitle">
                    <div class="alarm-panel-heading">
                        <h2 class="alarm-panel-title" id="alarmFormTitle">新建提醒</h2>
                        <p class="alarm-panel-subtitle" id="alarmFormSubtitle">为下一件事，设一个时间。</p>
                    </div>
                    <form id="alarmTaskForm" novalidate>
                        <div class="alarm-input-group">
                            <label class="alarm-label" for="alarmTaskName">提醒名称</label>
                            <input type="text" id="alarmTaskName" class="alarm-input" maxlength="80" required
                                autocomplete="off" placeholder="喝杯水、休息一下，或任何重要的事">
                        </div>
                        <div class="alarm-input-group">
                            <span class="alarm-label" id="alarmTypeLabel">定时方式</span>
                            <select id="alarmTaskType" class="is-initially-hidden" aria-label="定时方式" tabindex="-1">
                                <option value="countdown">倒计时</option><option value="fixed">固定时间</option>
                                <option value="hourly">整点报时</option><option value="interval">间隔提醒</option>
                            </select>
                            <div class="alarm-type-switch" role="group" aria-labelledby="alarmTypeLabel">
                                <button type="button" data-alarm-type="countdown" aria-pressed="true">倒计时</button>
                                <button type="button" data-alarm-type="fixed" aria-pressed="false">固定时间</button>
                                <button type="button" data-alarm-type="hourly" aria-pressed="false">整点报时</button>
                                <button type="button" data-alarm-type="interval" aria-pressed="false">间隔提醒</button>
                            </div>
                        </div>
                        <div class="alarm-input-group" id="timeInputGroup">
                            <span class="alarm-label" id="timeInputLabel">倒计时时长</span>
                            <input type="time" id="alarmTimeInput" class="alarm-input is-initially-hidden" value="09:00" aria-label="执行时间">
                            <div id="countdownInputs" class="alarm-countdown-inputs">
                                <label class="alarm-duration-field"><input type="number" id="countdownHours" class="alarm-input alarm-input--small" min="0" max="23" step="1" value="0" aria-label="倒计时小时"><span>小时</span></label>
                                <span class="alarm-time-sep" aria-hidden="true">:</span>
                                <label class="alarm-duration-field"><input type="number" id="countdownMinutes" class="alarm-input alarm-input--small" min="0" max="59" step="1" value="5" aria-label="倒计时分钟"><span>分钟</span></label>
                                <span class="alarm-time-sep" aria-hidden="true">:</span>
                                <label class="alarm-duration-field"><input type="number" id="countdownSeconds" class="alarm-input alarm-input--small" min="0" max="59" step="1" value="0" aria-label="倒计时秒数"><span>秒钟</span></label>
                            </div>
                            <div class="alarm-quick-presets" id="alarmQuickPresets" role="group" aria-label="快捷时长">
                                <button type="button" data-duration="300" aria-pressed="true">5 分钟</button>
                                <button type="button" data-duration="900" aria-pressed="false">15 分钟</button>
                                <button type="button" data-duration="1500" aria-pressed="false">25 分钟</button>
                                <button type="button" data-duration="3600" aria-pressed="false">1 小时</button>
                            </div>
                            <div id="intervalInputs" class="alarm-interval-inputs is-initially-hidden">
                                <span class="alarm-interval-text">每隔</span>
                                <input type="number" id="intervalValue" class="alarm-input alarm-input--small" min="1" max="999" step="1" value="30" aria-label="提醒间隔">
                                <select id="intervalUnit" class="alarm-select alarm-select--small" aria-label="间隔单位"><option value="minutes">分钟</option><option value="hours">小时</option></select>
                                <span class="alarm-interval-text">提醒一次</span>
                            </div>
                            <p id="alarmHourlyHint" class="alarm-helper is-initially-hidden">在所选日期，每个整点准时提醒。</p>
                        </div>
                        <div class="alarm-input-group">
                            <label class="alarm-label" for="alarmActionType">提醒方式</label>
                            <select id="alarmActionType" class="alarm-select">
                                <option value="notify">消息通知</option><option value="sound">播放提示音</option>
                                <option value="run">运行程序或脚本</option><option value="shutdown">关闭电脑</option><option value="lock">锁定屏幕</option>
                            </select>
                        </div>
                        <div id="actionConfigArea" class="alarm-action-config"></div>
                        <div class="alarm-input-group is-initially-hidden" id="repeatSettingsGroup">
                            <div class="alarm-repeat-options">
                                <label class="alarm-checkbox-label"><span>按周重复</span><input type="checkbox" id="repeatEnabled" checked role="switch"></label>
                                <div id="repeatDaysGroup" class="alarm-repeat-days" role="group" aria-label="重复日期">
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="1" checked aria-label="星期一"><span>一</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="2" checked aria-label="星期二"><span>二</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="3" checked aria-label="星期三"><span>三</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="4" checked aria-label="星期四"><span>四</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="5" checked aria-label="星期五"><span>五</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="6" aria-label="星期六"><span>六</span></label>
                                    <label class="alarm-day-checkbox"><input type="checkbox" name="repeatDay" value="0" aria-label="星期日"><span>日</span></label>
                                </div>
                            </div>
                        </div>
                        <p id="alarmFormStatus" class="alarm-form-status" role="status" aria-live="polite"></p>
                        <div class="alarm-form-actions">
                            <button id="addTaskBtn" class="alarm-btn-add" type="submit"><i class="ri-add-line" aria-hidden="true"></i> 创建提醒</button>
                            <button id="cancelAlarmEditBtn" class="alarm-cancel-edit is-initially-hidden" type="button">取消编辑</button>
                        </div>
                    </form>
                </section>

                <section class="alarm-list-section" aria-labelledby="alarmListTitle">
                    <div class="alarm-list-toolbar">
                        <div><h2 class="alarm-panel-title" id="alarmListTitle">我的提醒</h2><p id="alarmTaskSummary" class="alarm-panel-subtitle">还没有提醒，开始安排吧。</p></div>
                        <div class="alarm-filter-tabs" role="group" aria-label="筛选提醒">
                            <button type="button" data-filter="all" aria-pressed="true">全部</button>
                            <button type="button" data-filter="active" aria-pressed="false">进行中</button>
                            <button type="button" data-filter="paused" aria-pressed="false">已暂停</button>
                            <button type="button" data-filter="completed" aria-pressed="false">已结束</button>
                        </div>
                    </div>
                    <div class="alarm-list-panel" id="taskListPanel"></div>
                    <p class="alarm-list-footnote">支持拖动手柄排序，也可聚焦手柄后按 ↑ / ↓ 调整顺序。</p>
                </section>
            </div>
        </div>
    `;
}
