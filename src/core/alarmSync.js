const DEFAULT_RETRY_DELAYS = [250, 1_000, 3_000];

function cloneTasks(tasks) {
    if (typeof structuredClone === 'function') return structuredClone(tasks);
    return JSON.parse(JSON.stringify(tasks));
}

export class AlarmSyncQueue {
    constructor(syncTasks, {
        retryDelays = DEFAULT_RETRY_DELAYS,
        wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
        onStatus = () => {}
    } = {}) {
        this.syncTasks = syncTasks;
        this.retryDelays = retryDelays;
        this.wait = wait;
        this.onStatus = onStatus;
        this.pendingTasks = null;
        this.loopPromise = null;
    }

    request(tasks) {
        this.pendingTasks = cloneTasks(tasks);
        if (!this.loopPromise) {
            this.loopPromise = this.drain().finally(() => {
                this.loopPromise = null;
            });
        }
        return this.loopPromise;
    }

    async drain() {
        let result = false;
        while (this.pendingTasks) {
            const tasks = this.pendingTasks;
            this.pendingTasks = null;
            try {
                result = await this.syncSnapshot(tasks);
            } catch (error) {
                if (this.pendingTasks) continue;
                throw error;
            }
        }
        return result;
    }

    async syncSnapshot(tasks) {
        const maxAttempts = this.retryDelays.length + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.onStatus({ state: 'syncing', attempt, maxAttempts });
            try {
                const result = await this.syncTasks(tasks);
                this.onStatus({ state: 'synced', attempt, maxAttempts });
                return result;
            } catch (error) {
                if (this.pendingTasks) return false;
                if (attempt === maxAttempts) {
                    this.onStatus({ state: 'failed', attempt, maxAttempts, error });
                    throw error;
                }
                this.onStatus({ state: 'retrying', attempt, maxAttempts, error });
                await this.wait(this.retryDelays[attempt - 1]);
                if (this.pendingTasks) return false;
            }
        }
        return false;
    }
}
