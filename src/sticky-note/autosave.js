const FIELDS = ['title', 'content', 'color', 'pinned'];

export function sameNoteContent(left, right) {
    return Boolean(left && right && FIELDS.every(key => left[key] === right[key]));
}

export function editableDraft(note) {
    return {
        id: note.id,
        title: note.title,
        content: note.content,
        color: note.color,
        pinned: note.pinned,
        revision: note.revision
    };
}

// A single writer per note. An acknowledgment advances the revision, but never
// replaces edits made while its request was in flight.
export function createNoteAutosave({
    initialNote,
    save,
    onState = () => {},
    remember = () => {},
    forget = () => {},
    delay = 500,
    schedule = setTimeout,
    cancel = clearTimeout
}) {
    let draft = editableDraft(initialNote);
    let acknowledged = { ...draft };
    let timer = null;
    let running = null;
    let saving = false;
    let failure = null;
    let disposed = false;

    const dirty = () => !sameNoteContent(draft, acknowledged);
    const snapshot = () => ({
        draft: { ...draft },
        status: failure ? 'error' : saving ? 'saving' : dirty() ? 'pending' : 'saved',
        error: failure,
        dirty: dirty()
    });
    const notify = () => onState(snapshot());
    const clearTimer = () => {
        if (timer !== null) cancel(timer);
        timer = null;
    };
    const updateRecovery = () => {
        // During a write, even a reverted edit must be retained: the in-flight
        // value may become the server value before the reverted edit is saved.
        if (dirty() || saving) remember({ ...draft });
        else forget();
    };

    async function drain() {
        while (!disposed && dirty()) {
            const sent = { ...draft };
            saving = true;
            notify();
            try {
                const saved = await save(sent);
                if (!saved || saved.id !== sent.id || !Number.isSafeInteger(saved.revision)
                    || saved.revision <= sent.revision || !sameNoteContent(saved, sent)) {
                    throw new Error('保存结果无法确认，请重试。');
                }
                acknowledged = editableDraft(saved);
                draft.revision = saved.revision;
                saving = false;
                updateRecovery();
                notify();
            } catch (error) {
                saving = false;
                failure = error instanceof Error ? error : new Error(String(error));
                clearTimer();
                updateRecovery();
                notify();
                throw failure;
            }
        }
        return { ...acknowledged };
    }

    function flush() {
        clearTimer();
        if (disposed) return Promise.reject(new Error('便签已关闭。'));
        if (failure) return Promise.reject(failure);
        if (running) return running;
        // Deferring drain to a microtask ensures running is installed before
        // callbacks can request another flush.
        running = Promise.resolve().then(drain).finally(() => { running = null; });
        return running;
    }

    function edit(changes) {
        if (disposed) return;
        for (const key of FIELDS) {
            if (Object.hasOwn(changes, key)) draft[key] = changes[key];
        }
        clearTimer();
        updateRecovery();
        notify();
        // Failed writes need an explicit retry. Typing must never silently
        // retry a revision conflict or discard a recovery draft.
        if (!failure && dirty() && !saving) {
            timer = schedule(() => {
                timer = null;
                flush().catch(() => {});
            }, delay);
        }
    }

    function retry() {
        if (running) return running;
        failure = null;
        notify();
        return flush();
    }

    notify();
    return {
        edit,
        flush,
        retry,
        getState: snapshot,
        dispose() {
            disposed = true;
            clearTimer();
        }
    };
}
