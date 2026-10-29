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
        size /= 1024; unit = units[index];
    }
    return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

class CleanupSettings {
    constructor() {
        this.invoke = null;
        this.status = null;
        this.busy = false;
        this.loading = false;
        this.confirming = false;
        this.automaticSaving = false;
        this.retentionSaving = false;
        this.retentionDirty = false;
        this.retentionRevision = 0;
        this.policyRevision = 0;
        this.retentionQueued = null;
        this.retentionSavePromise = null;
        this.refreshPromise = null;
    }

    async init() {
        this.card = document.getElementById('storageCleanupCard');
        if (!this.card) return;
        this.invoke = globalThis.window?.__TAURI__?.core?.invoke || null;
        this.abortController = new AbortController();
        const { signal } = this.abortController;
        const on = (id, event, handler) => document.getElementById(id).addEventListener(event, handler, { signal });
        on('refreshCleanupUsage', 'click', () => this.refresh());
        on('runStorageCleanup', 'click', () => this.run());
        on('restoreLatestCleanup', 'click', () => this.restore());
        on('automaticCleanupEnabled', 'change', event => this.setAutomaticEnabled(event.target.checked));
        on('permanentCleanupEnabled', 'change', () => this.syncControls());
        for (const id of ['cleanupTargetCache', 'cleanupTargetLogs', 'cleanupTargetRecovery']) on(id, 'change', () => this.syncControls());
        for (const id of ['cleanupCacheRetention', 'cleanupLogRetention']) {
            on(id, 'input', event => {
                this.retentionRevision++; this.retentionDirty = true;
                event.target.removeAttribute('aria-invalid');
                this.setMessage(this.retentionSaving ? '正在保存上一项，当前输入将在离开输入框时保存。'
                    : '保留期限有未保存修改，离开输入框或按 Enter 保存。', this.retentionSaving ? 'pending' : 'info');
                this.syncControls();
            });
            on(id, 'change', () => this.saveRetention());
            on(id, 'keydown', event => {
                if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void this.saveRetention(); }
            });
        }
        this.syncControls();
        if (!this.invoke) { this.setMessage('请在 DtKit 桌面程序中管理缓存与日志。', 'muted'); return; }
        await this.refresh();
    }

    isLocked() { return this.busy || this.confirming || this.loading || this.automaticSaving || this.retentionSaving; }

    async refresh({ keepMessage = false } = {}) {
        if (!this.invoke || this.busy || this.confirming || this.automaticSaving || this.retentionSaving) return;
        if (this.refreshPromise) return this.refreshPromise;
        this.loading = true; this.syncControls();
        const revision = this.retentionRevision;
        const policyRevision = this.policyRevision;
        if (!keepMessage && !this.retentionDirty) this.setMessage('正在刷新存储占用…', 'pending');
        this.refreshPromise = (async () => {
            try {
                const next = await this.invoke('get_cleanup_status');
                if (!next?.usage || !next.policy) throw new Error('存储维护服务返回了无效结果');
                this.status = policyRevision === this.policyRevision ? next : {
                    ...next, policy: this.status.policy,
                    cacheRetentionDays: this.status.cacheRetentionDays,
                    logRetentionDays: this.status.logRetentionDays
                };
                for (const [id, value] of [['cleanupCacheUsage', next.usage.cacheBytes], ['cleanupLogUsage', next.usage.logBytes], ['cleanupRecoveryUsage', next.usage.recoveryBytes]]) {
                    document.getElementById(id).textContent = formatBytes(value);
                }
                document.getElementById('automaticCleanupEnabled').checked = this.status.policy.automaticEnabled;
                if (!this.retentionDirty && revision === this.retentionRevision) {
                    document.getElementById('cleanupCacheRetention').value = String(this.status.cacheRetentionDays);
                    document.getElementById('cleanupLogRetention').value = String(this.status.logRetentionDays);
                }
                this.updatePolicyHint();
                if (!keepMessage && !this.retentionDirty && policyRevision === this.policyRevision && revision === this.retentionRevision) {
                    const lastRun = next.policy.lastAutomaticRunAt ? new Date(next.policy.lastAutomaticRunAt * 1000).toLocaleString() : '尚未执行';
                    this.setMessage(`自动清理：${next.policy.automaticEnabled ? '已启用' : '未启用'} · 上次运行：${lastRun}`);
                }
            } catch (error) {
                if (!keepMessage) this.setMessage(`读取清理状态失败：${error}`, 'error');
            } finally { this.loading = false; this.refreshPromise = null; this.syncControls(); }
        })();
        return this.refreshPromise;
    }

    updatePolicyHint() {
        if (!this.status) return;
        document.getElementById('cleanupPolicyHint').textContent = `缓存超过 ${this.status.cacheRetentionDays} 天、日志超过 ${this.status.logRetentionDays} 天时移入恢复区`;
    }

    syncControls() {
        const locked = this.isLocked();
        this.card?.setAttribute('aria-busy', String(locked));
        document.querySelectorAll('#storageCleanupCard button, #storageCleanupCard input').forEach(control => {
            control.disabled = locked || !this.status;
        });
        // Keep the draft editable while a previous retention value is being saved or usage is refreshing.
        for (const id of ['cleanupCacheRetention', 'cleanupLogRetention']) {
            document.getElementById(id).disabled = this.busy || this.confirming || this.automaticSaving || !this.status;
        }
        const permanent = document.getElementById('permanentCleanupEnabled').checked;
        const recovery = document.getElementById('cleanupTargetRecovery');
        if (!permanent) recovery.checked = false;
        recovery.disabled = locked || !this.status || !permanent;
        const button = document.getElementById('runStorageCleanup');
        button.disabled = locked || !this.status || this.retentionDirty || !this.selectedTargets().length;
        button.classList.toggle('settings-btn--danger', permanent);
        button.classList.toggle('settings-btn--primary', !permanent);
        document.getElementById('cleanupActionLabel').textContent = this.busy ? '正在处理…' : permanent ? '彻底删除' : '安全清理';
        document.getElementById('restoreLatestCleanup').disabled = locked || this.retentionDirty || !this.status?.latestRecoveryBatchId;
        document.getElementById('automaticCleanupEnabled').disabled = locked || this.retentionDirty || !this.status;
        document.getElementById('refreshCleanupUsage').disabled = locked || !this.invoke;
    }

    selectedTargets() {
        return [['cleanupTargetCache', 'cache'], ['cleanupTargetLogs', 'logs'], ['cleanupTargetRecovery', 'recovery']]
            .filter(([id]) => document.getElementById(id).checked).map(([, target]) => target);
    }

    async setAutomaticEnabled(enabled) {
        const toggle = document.getElementById('automaticCleanupEnabled');
        if (this.isLocked() || this.retentionDirty || !this.status) {
            toggle.checked = this.status?.policy?.automaticEnabled === true; return;
        }
        const previous = this.status.policy.automaticEnabled;
        this.automaticSaving = true; this.syncControls();
        this.setMessage('正在保存自动维护设置…', 'pending');
        try {
            const policy = await this.invoke('set_automatic_cleanup_enabled', { enabled });
            if (typeof policy?.automaticEnabled !== 'boolean') throw new Error('自动维护服务返回了无效结果');
            this.status.policy = policy;
            this.policyRevision++;
            toggle.checked = policy.automaticEnabled;
            this.setMessage(policy.automaticEnabled ? '已启用自动清理 · 将在下次启动时检查。' : '已关闭启动自动清理。', 'success');
        } catch (error) {
            toggle.checked = previous;
            this.setMessage(`保存自动清理设置失败，已恢复原选项：${error}`, 'error');
        } finally { this.automaticSaving = false; this.syncControls(); }
    }

    async saveRetention() {
        if (!this.invoke || !this.status || this.busy || this.confirming || this.automaticSaving) return;
        const cacheInput = document.getElementById('cleanupCacheRetention');
        const logInput = document.getElementById('cleanupLogRetention');
        const cacheDays = Number(cacheInput.value), logDays = Number(logInput.value);
        const valid = value => Number.isInteger(value) && value >= 1 && value <= 365;
        cacheInput.setAttribute('aria-invalid', String(!valid(cacheDays)));
        logInput.setAttribute('aria-invalid', String(!valid(logDays)));
        if (![cacheDays, logDays].every(valid)) {
            this.retentionQueued = null; this.retentionDirty = true;
            this.setMessage('保留天数必须是 1 到 365 之间的整数。输入已保留，修正后可重新保存。', 'error');
            this.syncControls(); return;
        }
        if (this.retentionInFlight?.cacheDays === cacheDays && this.retentionInFlight?.logDays === logDays
            && this.retentionInFlight?.revision === this.retentionRevision && !this.retentionQueued) return this.retentionSavePromise;
        this.retentionQueued = { cacheDays, logDays, revision: this.retentionRevision };
        if (this.retentionSavePromise) return this.retentionSavePromise;
        this.retentionSaving = true; this.syncControls();
        this.retentionSavePromise = (async () => {
            while (this.retentionQueued) {
                const next = this.retentionQueued; this.retentionQueued = null;
                this.retentionInFlight = next;
                this.setMessage('正在保存保留期限…', 'pending');
                try {
                    await this.invoke('set_cleanup_retention_days', { cacheDays: next.cacheDays, logDays: next.logDays });
                    this.status.cacheRetentionDays = next.cacheDays; this.status.logRetentionDays = next.logDays;
                    this.policyRevision++;
                    this.updatePolicyHint();
                    if (next.revision === this.retentionRevision) {
                        this.retentionDirty = false;
                        this.setMessage('保留期限已保存。', 'success');
                    }
                } catch (error) {
                    this.retentionDirty = true;
                    if (next.revision === this.retentionRevision || this.retentionQueued) {
                        this.setMessage(`保存保留期限失败，输入已保留：${error}`, 'error');
                    }
                }
            }
        })().finally(() => {
            this.retentionInFlight = null; this.retentionSaving = false; this.retentionSavePromise = null; this.syncControls();
        });
        return this.retentionSavePromise;
    }

    async run() {
        if (this.isLocked() || this.retentionDirty || !this.status) return;
        const targets = this.selectedTargets();
        if (!targets.length) { this.setMessage('请至少选择一个清理目标。', 'error'); return; }
        const permanent = document.getElementById('permanentCleanupEnabled').checked;
        if (permanent) {
            this.confirming = true; this.syncControls();
            let confirmed = false;
            try {
                confirmed = await showConfirmDialog('确认彻底删除',
                    '选中的缓存、日志或恢复区内容将被永久删除，无法从 DtKit 恢复。此操作不会访问受管目录之外的文件。',
                    { danger: true, confirmLabel: '永久删除' });
            } finally { this.confirming = false; this.syncControls(); }
            if (!confirmed) {
                this.setMessage('已取消，未处理文件。');
                document.getElementById('runStorageCleanup').focus({ preventScroll: true }); return;
            }
        }
        await this.withBusy(async () => {
            const result = await this.invoke('run_storage_cleanup', { request: { targets, permanent } });
            return `已${permanent ? '永久删除' : '移入恢复区'} ${result.filesProcessed} 个文件（${formatBytes(result.bytesProcessed)}）`;
        });
    }

    async restore() {
        if (this.isLocked() || this.retentionDirty || !this.status?.latestRecoveryBatchId) return;
        await this.withBusy(async () => {
            const result = await this.invoke('restore_latest_cleanup');
            return `已恢复 ${result.filesProcessed} 个文件（${formatBytes(result.bytesProcessed)}）`;
        });
    }

    async withBusy(action) {
        this.busy = true; this.syncControls(); this.setMessage('正在处理，请稍候…', 'pending');
        try {
            const message = await action(); this.setMessage(message, 'success'); showToast(message);
        } catch (error) {
            this.setMessage(`操作失败：${error}`, 'error'); showToast(`操作失败：${error}`, 'error');
        } finally {
            this.busy = false; await this.refresh({ keepMessage: true }); this.syncControls();
        }
    }

    setMessage(message, tone = '') {
        const status = document.getElementById('cleanupStatus');
        const text = status.querySelector('span');
        if (text) text.textContent = message; else status.textContent = message;
        status.dataset.tone = tone;
    }
}

export function initCleanupSettings() {
    if (!initializationPromise) initializationPromise = new CleanupSettings().init().catch(error => {
        initializationPromise = null; throw error;
    });
    return initializationPromise;
}

export { formatBytes };
