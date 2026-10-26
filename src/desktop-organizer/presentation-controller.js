// Window drags, file drags and dialogs hold the same native hotzone open.
export function createInteractionGate({ invoke, window }) {
    const reasons = new Set();
    let sent = false, scheduled = false, chain = Promise.resolve();
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            const interacting = reasons.size > 0;
            window.__userInteracting = interacting;
            if (sent === interacting) return;
            sent = interacting;
            chain = chain.catch(() => {}).then(() => invoke('set_user_interacting', { interacting })).catch(() => {});
        });
    }
    function set(reason, active) {
        if (active) reasons.add(reason); else reasons.delete(reason);
        schedule();
    }
    function clear() { reasons.clear(); schedule(); }
    return { set, clear };
}
