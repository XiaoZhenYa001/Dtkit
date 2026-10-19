import { escapeHtml } from '../../core/html.js';

const TASK_TYPES = { countdown: '倒计时', fixed: '固定时间', hourly: '整点报时', interval: '间隔提醒' };
const ACTION_TYPES = { notify: '消息通知', sound: '提示音', run: '运行程序', shutdown: '关闭电脑', lock: '锁定屏幕' };

export function formatAlarmDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00';
    const whole = Math.ceil(seconds);
    return [Math.floor(whole / 3600), Math.floor(whole % 3600 / 60), whole % 60]
        .map(value => String(value).padStart(2, '0')).join(':');
}

export function getAlarmTaskStatus(task) {
    return !task.enabled ? 'completed' : task.paused ? 'paused' : 'active';
}

export function filterAlarmTasks(tasks, filter = 'all') {
    return filter === 'all' ? tasks : tasks.filter(task => getAlarmTaskStatus(task) === filter);
}

function formatShortDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const parts = [[Math.floor(value / 3600), '小时'], [Math.floor(value % 3600 / 60), '分钟'], [value % 60, '秒']];
    return parts.filter(([number]) => number > 0).map(([number, unit]) => number + unit).join(' ') || '0秒';
}

export function getAlarmScheduleLabel(task) {
    const config = task.config || {};
    if (task.type === 'countdown') return formatShortDuration(config.totalSeconds);
    if (task.type === 'interval') return '每 ' + config.intervalValue + (config.intervalUnit === 'hours' ? ' 小时' : ' 分钟');
    const time = task.type === 'fixed' ? config.time : '每逢整点';
    if (config.repeatEnabled === false) return time + ' · 仅一次';
    const days = [...new Set((config.repeatDays || []).map(Number))].sort((a, b) => a - b);
    const key = days.join(',');
    const repeat = key === '0,1,2,3,4,5,6' ? '每天' : key === '1,2,3,4,5' ? '工作日'
        : key === '0,6' ? '周末' : '每周' + [1, 2, 3, 4, 5, 6, 0].filter(day => days.includes(day)).map(day => '日一二三四五六'[day]).join('、');
    return time + ' · ' + repeat;
}

function createActionButtons(task) {
    let action = 'pause', icon = 'ri-pause-line', label = '暂停提醒';
    if (!task.enabled) {
        action = task.type === 'countdown' && task.config.remainingSeconds <= 0 ? 'restart' : 'start';
        icon = action === 'restart' ? 'ri-refresh-line' : 'ri-play-line';
        label = action === 'restart' ? '重新开始' : '启动提醒';
    } else if (task.paused) {
        action = 'resume'; icon = 'ri-play-line'; label = '继续提醒';
    }
    return `<button type="button" class="alarm-task-btn alarm-task-btn--${action}" title="${label}" aria-label="${label}"><i class="${icon}" aria-hidden="true"></i></button>
        <button type="button" class="alarm-task-btn alarm-task-btn--edit" title="编辑提醒" aria-label="编辑提醒"><i class="ri-edit-line" aria-hidden="true"></i></button>
        <button type="button" class="alarm-task-btn alarm-task-btn--delete" title="删除提醒" aria-label="删除提醒"><i class="ri-delete-bin-line" aria-hidden="true"></i></button>`;
}

function createTaskCard(task, handlers) {
    const card = document.createElement('div');
    const status = getAlarmTaskStatus(task);
    card.className = 'alarm-task-card' + (status === 'completed' ? ' disabled' : status === 'paused' ? ' paused' : '');
    card.dataset.taskId = task.id;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', task.name);
    const statusLabel = status === 'active' ? '进行中' : status === 'paused' ? '已暂停'
        : task.type === 'countdown' && task.config.remainingSeconds <= 0 ? '已完成' : '已关闭';
    card.innerHTML = `
        <button type="button" class="alarm-task-drag-handle" title="拖动排序，或按上下方向键调整" aria-label="调整提醒顺序"${handlers.reorderable === false ? ' hidden' : ''}><i class="ri-drag-move-2-line" aria-hidden="true"></i></button>
        <div class="alarm-task-time-block">
            <div class="alarm-task-countdown${status === 'paused' ? ' paused-state' : ''}"></div>
            <span class="alarm-task-status">${statusLabel}</span>
        </div>
        <div class="alarm-task-info">
            <div class="alarm-task-name">${escapeHtml(task.name)}</div>
            <div class="alarm-task-schedule">${escapeHtml(getAlarmScheduleLabel(task))}</div>
            <div class="alarm-task-meta">
                <span class="alarm-task-meta-item">${TASK_TYPES[task.type] || '未知类型'}</span>
                <span class="alarm-task-meta-item">${ACTION_TYPES[task.action] || '未知动作'}</span>
            </div>
        </div>
        <div class="alarm-task-actions">${createActionButtons(task)}</div>`;
    const countdown = card.querySelector('.alarm-task-countdown');
    countdown.dataset.countdownId = task.id;
    countdown.textContent = handlers.getCountdown(task);
    const actions = { pause: () => handlers.onPause(task.id), resume: () => handlers.onResume(task.id),
        start: () => handlers.onToggle(task.id), restart: () => handlers.onRestart(task),
        edit: () => handlers.onEdit(task), delete: () => handlers.onDelete(task.id) };
    card.querySelectorAll('.alarm-task-actions button').forEach(button => {
        const action = Object.keys(actions).find(key => button.classList.contains('alarm-task-btn--' + key));
        button.addEventListener('click', actions[action]);
    });
    return card;
}

function bindTaskReordering(panel, tasks, onReorder) {
    let draggedCard = null;
    panel.querySelectorAll('.alarm-task-card').forEach((card, index) => {
        const handle = card.querySelector('.alarm-task-drag-handle');
        handle.addEventListener('pointerdown', () => { card.draggable = true; });
        handle.addEventListener('pointerup', () => { if (!draggedCard) card.draggable = false; });
        handle.addEventListener('keydown', event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const target = index + (event.key === 'ArrowUp' ? -1 : 1);
            if (target < 0 || target >= tasks.length) return;
            const reordered = [...tasks];
            [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
            void onReorder(reordered);
        });
        card.addEventListener('dragstart', event => {
            draggedCard = card;
            card.classList.add('sortable-drag', 'sortable-chosen');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(taskId(card)));
            }
        });
        card.addEventListener('dragend', () => {
            card.draggable = false;
            card.classList.remove('sortable-drag', 'sortable-chosen');
            panel.querySelectorAll('.sortable-ghost').forEach(item => item.classList.remove('sortable-ghost'));
            draggedCard = null;
        });
    });
    panel.ondragover = event => {
        if (!draggedCard) return;
        event.preventDefault();
        const target = event.target instanceof Element ? event.target.closest('.alarm-task-card') : null;
        if (!target || target === draggedCard) return;
        panel.querySelectorAll('.sortable-ghost').forEach(item => item.classList.remove('sortable-ghost'));
        target.classList.add('sortable-ghost');
        const rect = target.getBoundingClientRect();
        panel.insertBefore(draggedCard, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    };
    panel.ondrop = event => {
        if (!draggedCard) return;
        event.preventDefault();
        const byId = new Map(tasks.map(task => [String(task.id), task]));
        const reordered = [...panel.querySelectorAll('.alarm-task-card')].map(card => byId.get(taskId(card))).filter(Boolean);
        if (reordered.some((task, index) => task.id !== tasks[index]?.id)) void onReorder(reordered);
    };
}

function taskId(card) { return card.dataset.taskId; }

export function renderAlarmTaskList(panel, tasks, handlers) {
    const focused = document.activeElement;
    const focusedId = focused?.closest('.alarm-task-card')?.dataset.taskId;
    const focusedClass = focused?.className;
    const scrollTop = panel.scrollTop;
    panel.replaceChildren();
    panel.ondragover = null;
    panel.ondrop = null;
    if (!tasks.length) {
        const filtered = handlers.reorderable === false;
        panel.innerHTML = `<div class="alarm-list-empty" id="emptyListHint">
            <i class="ri-alarm-line" aria-hidden="true"></i>
            <p>${filtered ? '这里暂时没有提醒' : '让每一件重要的事，准时发生。'}</p>
            <p class="alarm-list-empty-sub">${filtered ? '切换分类，查看其他提醒。' : '从一个 5 分钟的小休息开始。'}</p>
            ${filtered ? '' : '<button type="button" class="alarm-empty-create">创建第一个提醒 <i class="ri-add-line" aria-hidden="true"></i></button>'}</div>`;
        panel.querySelector('.alarm-empty-create')?.addEventListener('click', handlers.onCreate);
        return;
    }
    const fragment = document.createDocumentFragment();
    tasks.forEach(task => fragment.appendChild(createTaskCard(task, handlers)));
    panel.appendChild(fragment);
    if (handlers.reorderable !== false) bindTaskReordering(panel, tasks, handlers.onReorder);
    panel.scrollTop = scrollTop;
    if (focusedId) {
        const card = [...panel.children].find(node => node.dataset.taskId === focusedId);
        const next = [...(card?.querySelectorAll('button') || [])].find(node => node.className === focusedClass)
            || card?.querySelector('.alarm-task-actions button');
        next?.focus({ preventScroll: true });
    }
}

export function updateAlarmTaskCountdowns(panel, tasks, getCountdown) {
    if (!panel) return;
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    panel.querySelectorAll('[data-countdown-id]').forEach(element => {
        const task = byId.get(element.dataset.countdownId);
        if (!task) return;
        const text = getCountdown(task);
        if (element.textContent !== text) element.textContent = text;
    });
}
