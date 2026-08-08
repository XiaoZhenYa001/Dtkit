const TASK_TYPES = {
    countdown: '倒计时',
    fixed: '固定时间',
    hourly: '整点报时',
    interval: '间隔提醒'
};

const ACTION_TYPES = {
    notify: '弹出消息通知',
    sound: '播放提示音',
    run: '运行程序或脚本',
    shutdown: '关闭电脑',
    lock: '锁定屏幕'
};

export function formatAlarmDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00';
    const wholeSeconds = Math.ceil(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainingSeconds = wholeSeconds % 60;
    return [hours, minutes, remainingSeconds]
        .map(value => String(value).padStart(2, '0'))
        .join(':');
}

function createActionButtons(task) {
    const isPaused = task.enabled && task.paused;
    const isCompleted = !task.enabled
        && task.type === 'countdown'
        && task.config.remainingSeconds <= 0;

    if (!task.enabled && !isCompleted) {
        return '<button class="alarm-task-btn alarm-task-btn--start" title="启动任务" aria-label="启动任务"><i class="ri-play-line"></i></button>';
    }
    if (isCompleted) {
        return '<button class="alarm-task-btn alarm-task-btn--restart" title="重新开始" aria-label="重新开始"><i class="ri-refresh-line"></i></button>';
    }
    if (isPaused) {
        return '<button class="alarm-task-btn alarm-task-btn--resume" title="恢复任务" aria-label="恢复任务"><i class="ri-play-line"></i></button>';
    }
    return '<button class="alarm-task-btn alarm-task-btn--pause" title="暂停任务" aria-label="暂停任务"><i class="ri-pause-line"></i></button>';
}

function createTaskCard(task, handlers) {
    const card = document.createElement('div');
    const statusClass = !task.enabled ? 'disabled' : task.paused ? 'paused' : '';
    const isPaused = task.enabled && task.paused;
    card.className = `alarm-task-card ${statusClass}`;
    card.dataset.taskId = task.id;
    card.innerHTML = `
        <div class="alarm-task-drag-handle" title="拖拽排序" aria-label="拖拽排序">
            <i class="ri-drag-move-2-line"></i>
        </div>
        <div class="alarm-task-countdown ${isPaused ? 'paused-state' : ''}" data-countdown-id="${task.id}">
            ${handlers.getCountdown(task)}
        </div>
        <div class="alarm-task-info">
            <div class="alarm-task-name">${escapeHtml(task.name)}</div>
            <div class="alarm-task-meta">
                <span class="alarm-task-meta-item"><i class="ri-time-line"></i> ${TASK_TYPES[task.type] || '未知类型'}</span>
                <span class="alarm-task-meta-item"><i class="ri-play-circle-line"></i> ${ACTION_TYPES[task.action] || '未知动作'}</span>
                ${isPaused ? '<span class="alarm-task-paused-badge"><i class="ri-pause-circle-line"></i> 已暂停</span>' : ''}
            </div>
        </div>
        <div class="alarm-task-actions">
            ${createActionButtons(task)}
            <button class="alarm-task-btn alarm-task-btn--delete" title="删除" aria-label="删除任务">
                <i class="ri-delete-bin-line"></i>
            </button>
        </div>
        ${isPaused ? '<div class="alarm-task-paused-overlay"><i class="ri-pause-circle-line"></i></div>' : ''}
    `;

    card.querySelector('.alarm-task-btn--pause')?.addEventListener('click', () => handlers.onPause(task.id));
    card.querySelector('.alarm-task-btn--resume')?.addEventListener('click', () => handlers.onResume(task.id));
    card.querySelector('.alarm-task-btn--start')?.addEventListener('click', () => handlers.onToggle(task.id));
    card.querySelector('.alarm-task-btn--restart')?.addEventListener('click', () => handlers.onRestart(task));
    card.querySelector('.alarm-task-btn--delete')?.addEventListener('click', () => handlers.onDelete(task.id));
    return card;
}

function bindTaskReordering(panel, tasks, onReorder) {
    let draggedCard = null;
    panel.querySelectorAll('.alarm-task-card').forEach(card => {
        card.querySelector('.alarm-task-drag-handle')?.addEventListener('pointerdown', () => {
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
        const target = event.target instanceof Element
            ? event.target.closest('.alarm-task-card')
            : null;
        if (!draggedCard || !target || target === draggedCard) return;
        const rect = target.getBoundingClientRect();
        target.classList.add('sortable-ghost');
        panel.insertBefore(draggedCard, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    };
    panel.ondrop = event => {
        event.preventDefault();
        const taskById = new Map(tasks.map(task => [task.id, task]));
        const reorderedTasks = [...panel.querySelectorAll('.alarm-task-card')]
            .map(card => taskById.get(card.dataset.taskId))
            .filter(Boolean);
        onReorder(reorderedTasks);
    };
}

export function renderAlarmTaskList(panel, tasks, handlers) {
    panel.replaceChildren();
    if (tasks.length === 0) {
        panel.innerHTML = `
            <div class="alarm-list-empty" id="emptyListHint">
                <i class="ri-alarm-line"></i>
                <p>暂无定时任务</p>
                <p class="alarm-list-empty-sub">在左侧创建你的第一个任务吧</p>
            </div>`;
        panel.ondragover = null;
        panel.ondrop = null;
        return;
    }

    const fragment = document.createDocumentFragment();
    tasks.forEach(task => fragment.appendChild(createTaskCard(task, handlers)));
    panel.appendChild(fragment);
    bindTaskReordering(panel, tasks, handlers.onReorder);
}
import { escapeHtml } from '../../core/html.js';
