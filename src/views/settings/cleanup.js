import { showToast } from '../../core/utils.js';
import { showConfirmDialog } from './modal.js';

let initializationPromise = null;

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && size >= 1024; index += 1) {
        size /= 1024;
        unit = units[index];
    }
    return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

class CleanupSettings {
    constructor() {
        this.invoke = null;
        this.status = null;
        this.busy = false;
        this.abortController = null;
    }

    async init() {
        const card = document.getElementById('storageCleanupCard');
        if (!card) return;
        this.invoke = globalThis.window?.__TAURI__?.core?.invoke || null;
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        document.getElementById('refreshCleanupUsage').addEventListener('click', () => this.refresh(), { signal });
        document.getElementById('runStorageCleanup').addEventListener('click', () => this.run(), { signal });
        document.getElementById('restoreLatestCleanup').addEventListener('click', () => this.restore(), { signal });
        document.getElementById('automaticCleanupEnabled').addEventListener('change', event => {
            this.setAutomaticEnabled(event.target.checked);
        }, { signal });
        document.getElementById('permanentCleanupEnabled').addEventListener('change', event => {
            this.updatePermanentState(event.target.checked);
        }, { signal });
        document.getElementById('cleanupCacheRetention').addEventListener('change', () => this.saveRetention(), { signal });
        document.getElementById('cleanupLogRetention').addEventListener('change', () => this.saveRetention(), { signal });

        if (!this.invoke) {
            this.setMessage('请在 DtKit 桌面程序中管理缓存与日志。', 'muted');
            return;
        }
        await this.refresh();
    }

    async refresh() {
        if (!this.invoke || this.busy) return;
        try {
            this.status = await this.invoke('get_cleanup_status');
            const { usage, policy, latestRecoveryBatchId } = this.status;
            document.getElementById('cleanupCacheUsage').textContent = formatBytes(usage.cacheBytes);
            document.getElementById('cleanupLogUsage').textContent = formatBytes(usage.logBytes);
            document.getElementById('cleanupRecoveryUsage').textContent = formatBytes(usage.recoveryBytes);
            const automatic = document.getElementById('automaticCleanupEnabled');
            automatic.disabled = false;
            automatic.checked = policy.automaticEnabled;
            const cacheRetention = document.getElementById('cleanupCacheRetention');
            const logRetention = document.getElementById('cleanupLogRetention');
            cacheRetention.disabled = false;
            logRetention.disabled = false;
            cacheRetention.value = String(this.status.cacheRetentionDays);
            logRetention.value = String(this.status.logRetentionDays);
            document.getElementById('cleanupPolicyHint').textContent = `缓存超过 ${this.status.cacheRetentionDays} 天、日志超过 ${this.status.logRetentionDays} 天时移入恢复区`;
            document.getElementById('runStorageCleanup').disabled = false;
            document.getElementById('restoreLatestCleanup').disabled = !latestRecoveryBatchId;
            const lastRun = policy.lastAutomaticRunAt
                ? new Date(policy.lastAutomaticRunAt * 1000).toLocaleString()
                : '尚未执行';
            this.setMessage(`自动清理：${policy.automaticEnabled ? '已启用' : '未启用'} · 上次运行：${lastRun}`);
        } catch (error) {
            this.setMessage(`读取清理状态失败：${error}`, 'error');
        }
    }

    updatePermanentState(enabled) {
        const recovery = document.getElementById('cleanupTargetRecovery');
        recovery.disabled = !enabled;
        if (!enabled) recovery.checked = false;
        const button = document.getElementById('runStorageCleanup');
        button.classList.toggle('settings-btn--danger', enabled);
        button.classList.toggle('settings-btn--primary', !enabled);
        document.getElementById('cleanupActionLabel').textContent = enabled ? '彻底删除' : '安全清理';
    }

    selectedTargets() {
        const targets = [];
        if (document.getElementById('cleanupTargetCache').checked) targets.push('cache');
        if (document.getElementById('cleanupTargetLogs').checked) targets.push('logs');
        if (document.getElementById('cleanupTargetRecovery').checked) targets.push('recovery');
        return targets;
    }

    async setAutomaticEnabled(enabled) {
        const toggle = document.getElementById('automaticCleanupEnabled');
        toggle.disabled = true;
        try {
            await this.invoke('set_automatic_cleanup_enabled', { enabled });
            showToast(enabled ? '已启用启动自动清理' : '已关闭启动自动清理');
            await this.refresh();
        } catch (error) {
            toggle.checked = !enabled;
            toggle.disabled = false;
            showToast(`保存自动清理设置失败：${error}`, 'error');
        }
    }

    async saveRetention() {
        const cacheDays = Number(document.getElementById('cleanupCacheRetention').value);
        const logDays = Number(document.getElementById('cleanupLogRetention').value);
        if (![cacheDays, logDays].every(value => Number.isInteger(value) && value >= 1 && value <= 365)) {
            showToast('保留天数必须是 1 到 365 之间的整数', 'error');
            await this.refresh();
            return;
        }
        try {
            await this.invoke('set_cleanup_retention_days', { cacheDays, logDays });
            showToast('自动清理保留期限已更新');
            await this.refresh();
        } catch (error) {
            showToast(`保存保留期限失败：${error}`, 'error');
            await this.refresh();
        }
    }

    async run() {
        if (this.busy) return;
        const targets = this.selectedTargets();
        if (!targets.length) {
            showToast('请至少选择一个清理目标', 'error');
            return;
        }
        const permanent = document.getElementById('permanentCleanupEnabled').checked;
        if (permanent) {
            const confirmed = await showConfirmDialog(
                '确认彻底删除',
                '选中的缓存、日志或恢复区内容将被永久删除，无法从 DtKit 恢复。此操作不会访问受管目录之外的文件。',
                { danger: true, confirmLabel: '永久删除' }
            );
            if (!confirmed) return;
        }

        await this.withBusy(async () => {
            const result = await this.invoke('run_storage_cleanup', {
                request: { targets, permanent }
            });
            const verb = permanent ? '永久删除' : '移入恢复区';
            showToast(`已${verb} ${result.filesProcessed} 个文件（${formatBytes(result.bytesProcessed)}）`);
        });
    }

    async restore() {
        if (this.busy) return;
        await this.withBusy(async () => {
            const result = await this.invoke('restore_latest_cleanup');
            showToast(`已恢复 ${result.filesProcessed} 个文件（${formatBytes(result.bytesProcessed)}）`);
        });
    }

    async withBusy(action) {
        this.busy = true;
        this.setControlsDisabled(true);
        this.setMessage('正在处理，请稍候…');
        try {
            await action();
        } catch (error) {
            showToast(`操作失败：${error}`, 'error');
            this.setMessage(`操作失败：${error}`, 'error');
        } finally {
            this.busy = false;
            this.setControlsDisabled(false);
            await this.refresh();
        }
    }

    setControlsDisabled(disabled) {
        document.querySelectorAll('#storageCleanupCard button, #storageCleanupCard input').forEach(control => {
            control.disabled = disabled;
        });
        if (!disabled) this.updatePermanentState(document.getElementById('permanentCleanupEnabled').checked);
    }

    setMessage(message, tone = '') {
        const status = document.getElementById('cleanupStatus');
        status.querySelector('span').textContent = message;
        status.dataset.tone = tone;
    }
}

export function initCleanupSettings() {
    if (!initializationPromise) {
        initializationPromise = new CleanupSettings().init().catch(error => {
            initializationPromise = null;
            throw error;
        });
    }
    return initializationPromise;
}

export { formatBytes };
