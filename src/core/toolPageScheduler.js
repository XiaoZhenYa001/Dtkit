// A hidden tool keeps its editing context, but owns no running UI timers.
export function createToolPageScheduler(target = window) {
    const native = {
        timeout: target.setTimeout.bind(target), clear: target.clearTimeout.bind(target),
        frame: target.requestAnimationFrame.bind(target), cancel: target.cancelAnimationFrame.bind(target)
    };
    const pending = new Map();
    let sequence = 0;
    let suspended = false;
    let disposed = false;
    const now = () => target.performance.now();

    function arm(task) {
        if (suspended || disposed) return;
        task.startedAt = now();
        const fire = timestamp => {
            task.handle = null;
            if (suspended || disposed || !pending.has(task.id)) return;
            if (!task.repeat) pending.delete(task.id);
            try { task.callback(...(task.frame ? [timestamp] : task.args)); }
            finally {
                if (task.repeat && pending.has(task.id)) { task.remaining = task.delay; arm(task); }
            }
        };
        task.handle = task.frame ? native.frame(fire) : native.timeout(fire, task.remaining);
    }
    function schedule(callback, delay = 0, args = [], repeat = false, frame = false) {
        // Tool modules use function callbacks; preserve browser behavior for other callers.
        if (typeof callback !== 'function') throw new TypeError('A tool timer needs a function callback');
        const id = ++sequence;
        const duration = Math.min(2147483647, Math.max(0, Number(delay) || 0));
        const task = { id, callback, delay: duration, remaining: duration, args, repeat, frame, handle: null };
        pending.set(id, task); arm(task); return id;
    }
    function clear(id) {
        const task = pending.get(id);
        if (!task) return;
        if (task.handle !== null) (task.frame ? native.cancel : native.clear)(task.handle);
        pending.delete(id);
    }
    target.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args);
    target.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
    target.clearTimeout = clear;
    target.clearInterval = clear;
    target.requestAnimationFrame = callback => schedule(callback, 0, [], false, true);
    target.cancelAnimationFrame = clear;
    return {
        setSuspended(value) {
            const next = Boolean(value);
            if (next === suspended || disposed) return;
            suspended = next;
            for (const task of pending.values()) {
                if (next && task.handle !== null) {
                    (task.frame ? native.cancel : native.clear)(task.handle);
                    if (!task.frame) task.remaining = Math.max(0, task.remaining - (now() - task.startedAt));
                    task.handle = null;
                } else if (!next) arm(task);
            }
        },
        dispose() { disposed = true; [...pending.keys()].forEach(clear); },
        get suspended() { return suspended; },
        get pendingCount() { return pending.size; }
    };
}
