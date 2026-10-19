import { showToast } from '../../core/utils.js';
import { escapeHtml } from '../../core/html.js';

const notificationFocusTargets = new WeakMap();

function restoreNotificationFocus(toast) {
    const previousFocus = notificationFocusTargets.get(toast);
    notificationFocusTargets.delete(toast);
    if (toast.contains(document.activeElement) && previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
    }
}

export function removeAlarmNotification(taskId, { animate = true } = {}) {
    const overlay = document.getElementById(`alarm-overlay-${taskId}`);
    const toast = document.getElementById(`alarm-toast-${taskId}`);
    if (toast) restoreNotificationFocus(toast);
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
    document.querySelectorAll('[id^="alarm-toast-"], .dtkit-toast--alarm').forEach(element => {
        restoreNotificationFocus(element);
        element.remove();
    });
}

function showAlarmControl(task, onDismiss) {
    clearAlarmNotifications();

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        onDismiss();
        removeAlarmNotification(task.id);
        showToast('闹钟已停止', 'success');
    };

    const overlay = document.createElement('div');
    overlay.className = 'alarm-overlay';
    overlay.id = `alarm-overlay-${task.id}`;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.addEventListener('click', dismiss);
    document.body.appendChild(overlay);

    const toast = document.createElement('div');
    toast.className = 'dtkit-toast--alarm';
    toast.id = `alarm-toast-${task.id}`;
    toast.setAttribute('role', 'alertdialog');
    toast.setAttribute('aria-modal', 'true');
    toast.setAttribute('aria-label', '闹钟提醒');
    toast.tabIndex = -1;
    toast.innerHTML = `
        <div class="alarm-toast__content">
            <i class="ri-alarm-warning-line alarm-toast__icon"></i>
            <div class="alarm-toast__body">
                <div class="alarm-toast__title">时间到了</div>
                <div class="alarm-toast__task">${escapeHtml(task.name)}</div>
            </div>
            <button class="alarm-dismiss-btn" type="button">停止提示音</button>
        </div>
    `;
    const taskDescription = toast.querySelector('.alarm-toast__task');
    if (taskDescription) {
        taskDescription.id = `alarm-description-${task.id}`;
        toast.setAttribute('aria-describedby', taskDescription.id);
    }
    const dismissButton = toast.querySelector('.alarm-dismiss-btn');
    dismissButton?.addEventListener('click', event => {
        event.stopPropagation();
        dismiss();
    });
    toast.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            dismiss();
        } else if (event.key === 'Tab') {
            event.preventDefault();
            dismissButton?.focus({ preventScroll: true });
        }
    });
    notificationFocusTargets.set(toast, document.activeElement);
    document.body.appendChild(toast);
    (dismissButton || toast).focus?.({ preventScroll: true });
}

async function sendSystemNotification(task, isActive) {
    if (!isActive()) return;
    if (window.__TAURI__?.notification) {
        try {
            let permissionGranted = await window.__TAURI__.notification.isPermissionGranted();
            if (!isActive()) return;
            if (!permissionGranted) {
                permissionGranted = await window.__TAURI__.notification.requestPermission() === 'granted';
            }
            if (permissionGranted && isActive()) {
                await window.__TAURI__.notification.sendNotification({
                    title: '⏰ 闹钟响了！',
                    body: task.name
                });
                try {
                    const getCurrentWindow = window.__TAURI__.window?.getCurrentWindow;
                    if (getCurrentWindow && isActive()) {
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
    if (permission !== 'granted' || !isActive()) return;

    const notification = new Notification('⏰ 定时提醒', {
        body: task.name,
        requireInteraction: true,
        tag: `alarm-${task.id}`
    });
    notification.onclick = () => window.focus();
}

export async function showSoundAlarmNotification(task, onDismiss, isActive = () => true) {
    if (isActive()) showAlarmControl(task, onDismiss);
    if (!task.__backendTriggered) await sendSystemNotification(task, isActive);
}
