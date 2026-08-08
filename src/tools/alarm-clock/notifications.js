import { showToast } from '../../core/utils.js';
import { escapeHtml } from '../../core/html.js';

export function removeAlarmNotification(taskId, { animate = true } = {}) {
    const overlay = document.getElementById(`alarm-overlay-${taskId}`);
    const toast = document.getElementById(`alarm-toast-${taskId}`);
    if (!animate) {
        overlay?.remove();
        toast?.remove();
        return;
    }
    if (overlay) {
        overlay.classList.add('alarm-overlay--closing');
        setTimeout(() => overlay.remove(), 300);
    }
    if (toast) {
        toast.classList.add('dtkit-toast--alarm-closing');
        setTimeout(() => toast.remove(), 300);
    }
}

export function clearAlarmNotifications() {
    document.querySelectorAll('[id^="alarm-overlay-"], .alarm-overlay').forEach(element => element.remove());
    document.querySelectorAll('[id^="alarm-toast-"], .dtkit-toast--alarm').forEach(element => element.remove());
}

function showAlarmControl(task, onDismiss) {
    clearAlarmNotifications();

    const dismiss = () => {
        onDismiss();
        removeAlarmNotification(task.id);
        showToast('✓ 闹钟已停止', 'success');
    };

    const overlay = document.createElement('div');
    overlay.className = 'alarm-overlay';
    overlay.id = `alarm-overlay-${task.id}`;
    overlay.addEventListener('click', dismiss);
    document.body.appendChild(overlay);

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
            <button class="alarm-dismiss-btn" type="button">🔔 停止闹钟</button>
        </div>
    `;
    toast.querySelector('.alarm-dismiss-btn')?.addEventListener('click', event => {
        event.stopPropagation();
        dismiss();
    });
    document.body.appendChild(toast);
}

async function sendSystemNotification(task) {
    if (window.__TAURI__?.notification) {
        try {
            let permissionGranted = await window.__TAURI__.notification.isPermissionGranted();
            if (!permissionGranted) {
                permissionGranted = await window.__TAURI__.notification.requestPermission() === 'granted';
            }
            if (permissionGranted) {
                await window.__TAURI__.notification.sendNotification({
                    title: '⏰ 闹钟响了！',
                    body: task.name
                });
                try {
                    const getCurrentWindow = window.__TAURI__.window?.getCurrentWindow;
                    if (getCurrentWindow) {
                        const currentWindow = getCurrentWindow();
                        await currentWindow.unminimize();
                        await currentWindow.setFocus();
                    }
                } catch (error) {
                    console.info('[AlarmClock] 无法聚焦窗口', error);
                }
            }
        } catch (error) {
            console.error('[AlarmClock] Tauri 通知失败', error);
        }
        return;
    }

    if (!('Notification' in window)) return;
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const notification = new Notification('⏰ 定时提醒', {
        body: task.name,
        requireInteraction: true,
        tag: `alarm-${task.id}`
    });
    notification.onclick = () => window.focus();
}

export async function showSoundAlarmNotification(task, onDismiss, isActive = () => true) {
    if (!task.__backendTriggered) await sendSystemNotification(task);
    if (isActive()) showAlarmControl(task, onDismiss);
}
