import { createNoteAutosave, editableDraft, sameNoteContent } from './autosave.js';

const api = globalThis.window?.__TAURI__;
const id = new URLSearchParams(location.search).get('id');
const recoveryKey = `dtkit_sticky_note_recovery_${id}`;
const colors = new Set(['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
const elements = Object.fromEntries([
    'noteTitle', 'noteContent', 'notePin', 'noteClose', 'noteDragHandle',
    'noteSaveStatus', 'noteCharCount', 'noteSaveError', 'noteSaveMessage',
    'noteRetry', 'noteReload', 'noteLoadError', 'noteLoadMessage', 'noteLoadRetry',
    'noteRecovery', 'recoveryMessage', 'recoveryPreview', 'recoveryRestore', 'recoveryDiscard'
].map(name => [name, document.getElementById(name)]));
const colorButtons = [...document.querySelectorAll('[data-note-color]')];
let autosave = null;
let recovery = null;
let loading = true;
let closing = false;
let closeFailure = false;
let recoveryAvailable = true;

function invoke(command, args) {
    if (!api?.core?.invoke) return Promise.reject(new Error('请在 DtKit 桌面应用中打开便签。'));
    return api.core.invoke(command, args);
}

function validDraft(value) {
    return value?.id === id && typeof value.title === 'string' && value.title.length <= 80
        && typeof value.content === 'string' && value.content.length <= 20000
        && colors.has(value.color) && typeof value.pinned === 'boolean'
        && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function readRecovery() {
    try {
        const value = JSON.parse(localStorage.getItem(recoveryKey) || 'null');
        return validDraft(value) ? value : null;
    } catch { return null; }
}

function rememberDraft(draft) {
    try { localStorage.setItem(recoveryKey, JSON.stringify(draft)); }
    catch { recoveryAvailable = false; }
}

function forgetDraft() {
    try { localStorage.removeItem(recoveryKey); }
    catch { recoveryAvailable = false; }
}

function setEditable() {
    const disabled = loading || closing || !autosave || Boolean(recovery);
    elements.noteTitle.disabled = disabled;
    elements.noteContent.disabled = disabled;
    elements.notePin.disabled = disabled;
    colorButtons.forEach(button => { button.disabled = disabled; });
    elements.noteClose.disabled = closing;
    elements.recoveryRestore.disabled = closing || loading;
    elements.recoveryDiscard.disabled = closing || loading;
}

function updateAppearance(draft) {
    document.body.dataset.noteTheme = draft.color;
    elements.notePin.setAttribute('aria-pressed', String(draft.pinned));
    elements.notePin.setAttribute('aria-label', draft.pinned ? '取消置顶' : '置顶便签');
    elements.notePin.title = draft.pinned ? '已置顶 · 点击取消' : '置顶便签';
    colorButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.noteColor === draft.color)));
    elements.noteCharCount.textContent = `${draft.content.length.toLocaleString('zh-CN')} 字`;
    document.title = `${draft.title.trim() || '无标题便签'} · DtKit`;
}

function showSaveError(error, isClosing = false) {
    const detail = error instanceof Error ? error.message : String(error);
    elements.noteSaveError.hidden = false;
    elements.noteSaveMessage.textContent = isClosing
        ? `内容已保存，但暂时无法收起：${detail}`
        : `尚未保存，请保留此窗口。${detail}`;
    elements.noteRetry.textContent = isClosing ? '重试收起' : '重试保存';
    elements.noteReload.hidden = isClosing;
    elements.noteSaveStatus.dataset.state = 'error';
    elements.noteSaveStatus.textContent = isClosing ? '收起失败' : '保存失败';
}

function renderState(state) {
    updateAppearance(state.draft);
    elements.noteSaveStatus.dataset.state = state.status;
    elements.noteSaveStatus.textContent = {
        saved: '已保存到本机', pending: '等待保存…', saving: '正在保存…', error: '保存失败'
    }[state.status];
    elements.noteSaveStatus.title = recoveryAvailable
        ? '自动保存 · Ctrl+S 立即保存' : '自动保存 · 本机草稿备份不可用，请等待保存成功后退出';
    elements.noteSaveError.hidden = state.status !== 'error';
    if (state.error) showSaveError(state.error);
}

function showRecovery(saved) {
    recovery = readRecovery();
    if (recovery && sameNoteContent(recovery, saved)) {
        forgetDraft();
        recovery = null;
    }
    elements.noteRecovery.hidden = !recovery;
    if (recovery) {
        elements.recoveryMessage.textContent = recovery.revision === saved.revision
            ? '上次有内容未能保存。恢复草稿后会继续自动保存。'
            : '已保存版本也有更新。请核对下方草稿，恢复会替换当前内容。';
        elements.recoveryPreview.value = `${recovery.title || '无标题便签'}\n\n${recovery.content}`;
        elements.recoveryRestore.focus();
    }
}

async function loadNote() {
    if (closing) return;
    loading = true;
    autosave?.dispose();
    autosave = null;
    setEditable();
    elements.noteLoadError.hidden = true;
    elements.noteSaveError.hidden = true;
    elements.noteRecovery.hidden = true;
    elements.noteSaveStatus.dataset.state = 'loading';
    elements.noteSaveStatus.textContent = '正在打开…';
    try {
        if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id || '')) {
            throw new Error('便签地址无效，请从便签工具重新打开。');
        }
        const note = await invoke('get_sticky_note', { id });
        if (!validDraft(note) || note.trashedAt) throw new Error('便签已移入回收站或内容无法读取。');
        if (closing) return;
        elements.noteTitle.value = note.title;
        elements.noteContent.value = note.content;
        closeFailure = false;
        autosave = createNoteAutosave({
            initialNote: note,
            save: draft => invoke('save_sticky_note', { draft }),
            onState: renderState,
            remember: rememberDraft,
            forget: forgetDraft
        });
        showRecovery(note);
        loading = false;
        setEditable();
        if (!recovery) elements.noteContent.focus();
    } catch (error) {
        loading = false;
        elements.noteLoadError.hidden = false;
        elements.noteLoadMessage.textContent = String(error instanceof Error ? error.message : error);
        elements.noteSaveStatus.dataset.state = 'error';
        elements.noteSaveStatus.textContent = '未加载';
        setEditable();
    }
}

function edit(changes) {
    if (!autosave || loading || closing || recovery) return;
    closeFailure = false;
    autosave.edit(changes);
}

async function requestClose() {
    if (closing) return;
    closing = true;
    closeFailure = false;
    setEditable();
    try {
        // A load failure must never send an empty save. The saved note and any
        // unresolved recovery draft remain intact when the window is closed.
        if (autosave) await autosave.flush();
        await invoke('close_sticky_note', { id });
        autosave?.dispose();
    } catch (error) {
        closing = false;
        closeFailure = Boolean(autosave && autosave.getState().status !== 'error');
        showSaveError(error, closeFailure);
        setEditable();
    }
}

async function retrySave() {
    if (closeFailure) return requestClose();
    if (!autosave || recovery) return;
    elements.noteRetry.disabled = true;
    try { await autosave.retry(); }
    catch { /* The autosave state keeps the failure visible. */ }
    finally { elements.noteRetry.disabled = false; }
}

elements.noteTitle.addEventListener('input', () => edit({ title: elements.noteTitle.value }));
elements.noteContent.addEventListener('input', () => edit({ content: elements.noteContent.value }));
elements.notePin.addEventListener('click', () => {
    if (!autosave) return;
    edit({ pinned: !autosave.getState().draft.pinned });
    autosave.flush().catch(() => {});
});
colorButtons.forEach(button => button.addEventListener('click', () => edit({ color: button.dataset.noteColor })));
elements.noteClose.addEventListener('click', requestClose);
elements.noteRetry.addEventListener('click', retrySave);
elements.noteLoadRetry.addEventListener('click', loadNote);
elements.noteReload.addEventListener('click', loadNote);
elements.recoveryRestore.addEventListener('click', () => {
    if (!recovery || !autosave) return;
    const recovered = editableDraft(recovery);
    recovery = null;
    elements.noteRecovery.hidden = true;
    elements.noteTitle.value = recovered.title;
    elements.noteContent.value = recovered.content;
    setEditable();
    // Explicit restoration adopts the currently loaded backend revision.
    // The recovery draft's stale revision is intentionally not applied.
    edit(recovered);
    autosave.flush().catch(() => {});
    elements.noteContent.focus();
});
elements.recoveryDiscard.addEventListener('click', () => {
    recovery = null;
    forgetDraft();
    elements.noteRecovery.hidden = true;
    setEditable();
    elements.noteContent.focus();
});
elements.noteDragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    api?.window?.getCurrentWindow?.().startDragging().catch(() => {});
});
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        retrySave();
    }
});
window.addEventListener('blur', () => {
    if (!loading && !closing && !recovery) autosave?.flush().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && !loading && !closing && !recovery) autosave?.flush().catch(() => {});
});
window.addEventListener('pagehide', () => {
    if (autosave?.getState().dirty) rememberDraft(autosave.getState().draft);
    autosave?.dispose();
});

try {
    if (api?.event?.listen) await api.event.listen('sticky-note-close-request', requestClose);
    await loadNote();
} catch (error) {
    // Without the close interception handshake, leave the editor disabled.
    loading = false;
    elements.noteLoadError.hidden = false;
    elements.noteLoadMessage.textContent = `便签初始化失败：${String(error)}`;
    elements.noteSaveStatus.textContent = '未加载';
    elements.noteSaveStatus.dataset.state = 'error';
    setEditable();
}
