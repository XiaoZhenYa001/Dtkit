import { createNoteAutosave, editableDraft, sameNoteContent } from './autosave.js';
import { continueNoteList, findNoteMatches, formatNoteSelection, noteStats, renderNoteMarkdown, toggleNoteTask } from './editor-model.js';

const api = globalThis.window?.__TAURI__;
const id = new URLSearchParams(location.search).get('id');
const recoveryKey = `dtkit_sticky_note_recovery_${id}`;
const preferenceKey = `dtkit_sticky_note_preferences_${id}`;
const colors = new Set(['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
const elements = Object.fromEntries([
    'noteTitle', 'noteContent', 'notePin', 'noteClose', 'noteDragHandle', 'noteCollapse', 'noteHeaderTitle', 'noteBody',
    'noteSaveStatus', 'noteCharCount', 'noteSaveError', 'noteSaveMessage',
    'noteRetry', 'noteReload', 'noteLoadError', 'noteLoadMessage', 'noteLoadRetry',
    'noteRecovery', 'recoveryMessage', 'recoveryPreview', 'recoveryRestore', 'recoveryDiscard',
    'noteEditMode', 'notePreviewMode', 'notePreview', 'noteFormatToolbar', 'noteInsertDate',
    'noteFindToggle', 'noteFind', 'noteFindInput', 'noteFindCount', 'noteFindPrevious', 'noteFindNext', 'noteFindClose',
    'noteAppearance', 'noteAppearancePanel', 'noteTaskProgress', 'noteTaskBar', 'noteTaskCount'
].map(name => [name, document.getElementById(name)]));
const colorButtons = [...document.querySelectorAll('[data-note-color]')];
const fontButtons = [...document.querySelectorAll('button[data-font-size]')];
const formatButtons = [...document.querySelectorAll('[data-format]')];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const disclosures = new WeakMap();
let autosave = null;
let recovery = null;
let loading = true;
let closing = false;
let closeFailure = false;
let recoveryAvailable = true;
let preview = false;
let collapsed = false;
let collapsing = false;
let closeQueued = false;
let fontSize = 'medium';
let findMatches = [];
let findIndex = -1;
let savedSelection = null;
let editorScroll = 0;
let previewScroll = 0;
let previewSource = null;
let closeUnlisten;

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
    try { const value = JSON.parse(localStorage.getItem(recoveryKey) || 'null'); return validDraft(value) ? value : null; }
    catch { return null; }
}

function rememberDraft(draft) {
    try { localStorage.setItem(recoveryKey, JSON.stringify(draft)); }
    catch { recoveryAvailable = false; }
}

function forgetDraft() {
    try { localStorage.removeItem(recoveryKey); }
    catch { recoveryAvailable = false; }
}

function rememberPreferences() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ fontSize, preview })); }
    catch { /* The saved note remains independent from optional appearance settings. */ }
}

function setEditable() {
    const disabled = loading || closing || !autosave || Boolean(recovery);
    elements.noteTitle.disabled = disabled;
    elements.noteContent.disabled = disabled;
    elements.noteContent.inert = preview || collapsed;
    elements.notePreview.inert = !preview || disabled || collapsed;
    elements.notePin.disabled = disabled;
    elements.noteCollapse.disabled = disabled || collapsing;
    elements.noteClose.disabled = closing || collapsing;
    elements.noteEditMode.disabled = disabled;
    elements.notePreviewMode.disabled = disabled;
    elements.noteFindToggle.disabled = disabled;
    elements.noteInsertDate.disabled = disabled || preview;
    formatButtons.forEach(button => { button.disabled = disabled || preview; });
    colorButtons.forEach(button => { button.disabled = disabled; });
    elements.notePreview.querySelectorAll('input').forEach(input => { input.disabled = disabled; });
    elements.recoveryRestore.disabled = closing || loading;
    elements.recoveryDiscard.disabled = closing || loading;
}

function updateAppearance(draft) {
    document.body.dataset.noteTheme = draft.color;
    elements.notePin.setAttribute('aria-pressed', String(draft.pinned));
    elements.notePin.setAttribute('aria-label', draft.pinned ? '取消置顶' : '置顶便签');
    elements.notePin.title = draft.pinned ? '已置顶 · 点击取消' : '置顶便签';
    colorButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.noteColor === draft.color)));
    const stats = noteStats(draft.content);
    elements.noteCharCount.textContent = `${stats.characters.toLocaleString('zh-CN')} 字`;
    elements.noteTaskProgress.hidden = stats.tasks === 0;
    elements.noteTaskBar.max = Math.max(1, stats.tasks);
    elements.noteTaskBar.value = stats.completed;
    elements.noteTaskCount.textContent = `${stats.completed}/${stats.tasks} 项`;
    elements.noteTaskBar.setAttribute('aria-valuetext', `已完成 ${stats.completed} 项，共 ${stats.tasks} 项`);
    elements.noteHeaderTitle.textContent = collapsed ? draft.title.trim() || '无标题便签' : '便签';
    document.title = `${draft.title.trim() || '无标题便签'} · DtKit`;
}

function showSaveError(error, isClosing = false) {
    const detail = error instanceof Error ? error.message : String(error);
    elements.noteSaveError.hidden = false;
    elements.noteSaveMessage.textContent = isClosing ? `内容已保存，但暂时无法收起：${detail}` : `尚未保存，请保留此窗口。${detail}`;
    elements.noteRetry.textContent = isClosing ? '重试收起' : '重试保存';
    elements.noteReload.hidden = isClosing;
    elements.noteSaveStatus.dataset.state = 'error';
    elements.noteSaveStatus.textContent = isClosing ? '收起失败' : '保存失败';
}

function renderState(state) {
    updateAppearance(state.draft);
    elements.noteSaveStatus.dataset.state = state.status;
    elements.noteSaveStatus.textContent = { saved: '已保存到本机', pending: '等待保存…', saving: '正在保存…', error: '保存失败' }[state.status];
    elements.noteSaveStatus.title = recoveryAvailable ? '自动保存 · Ctrl+S 立即保存' : '自动保存 · 本机草稿备份不可用，请等待保存成功后退出';
    elements.noteSaveError.hidden = state.status !== 'error';
    if (state.error) showSaveError(state.error);
}

function showRecovery(saved) {
    recovery = readRecovery();
    if (recovery && sameNoteContent(recovery, saved)) { forgetDraft(); recovery = null; }
    elements.noteRecovery.hidden = !recovery;
    if (recovery) {
        elements.recoveryMessage.textContent = recovery.revision === saved.revision
            ? '上次有内容未能保存。恢复草稿后会继续自动保存。'
            : '已保存版本也有更新。请核对下方草稿，恢复会替换当前内容。';
        elements.recoveryPreview.value = `${recovery.title || '无标题便签'}\n\n${recovery.content}`;
        elements.recoveryRestore.focus();
    }
}

function renderPreview() {
    const source = elements.noteContent.value;
    if (source === previewSource) return;
    previewSource = source;
    const scroll = elements.notePreview.scrollTop;
    elements.notePreview.innerHTML = source.trim() ? renderNoteMarkdown(source) : '<p class="note-preview-empty">想法会在这里，慢慢成形。<br>切回编辑，开始记录。</p>';
    elements.notePreview.scrollTop = scroll;
    setEditable();
}

function setView(next, { focus = true } = {}) {
    if (next === preview && document.body.dataset.view === (next ? 'preview' : 'edit')) return;
    if (next) {
        savedSelection = { start: elements.noteContent.selectionStart, end: elements.noteContent.selectionEnd, direction: elements.noteContent.selectionDirection };
        editorScroll = elements.noteContent.scrollTop;
        renderPreview();
        elements.notePreview.scrollTop = previewScroll;
    } else previewScroll = elements.notePreview.scrollTop;
    preview = next;
    document.body.dataset.view = preview ? 'preview' : 'edit';
    elements.noteEditMode.setAttribute('aria-pressed', String(!preview));
    elements.notePreviewMode.setAttribute('aria-pressed', String(preview));
    setEditable();
    if (preview) { if (focus) elements.notePreview.focus({ preventScroll: true }); }
    else {
        if (savedSelection) elements.noteContent.setSelectionRange(savedSelection.start, savedSelection.end, savedSelection.direction);
        elements.noteContent.scrollTop = editorScroll;
        if (focus) elements.noteContent.focus({ preventScroll: true });
    }
    rememberPreferences();
}

function disclosure(element, open, floating = false) {
    const previous = disclosures.get(element);
    previous?.animation?.cancel();
    const token = { open };
    disclosures.set(element, token);
    if (open) element.hidden = false;
    if (reducedMotion() || !element.animate) { element.hidden = !open; return; }
    const height = element.getBoundingClientRect().height;
    const frames = floating
        ? [{ opacity: 0, transform: 'translateY(5px) scale(.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }]
        : [{ opacity: 0, flexBasis: '0px', height: '0px', transform: 'translateY(-4px)' }, { opacity: 1, flexBasis: `${height}px`, height: `${height}px`, transform: 'translateY(0)' }];
    token.animation = element.animate(open ? frames : [...frames].reverse(), { duration: open ? 210 : 150, easing: 'cubic-bezier(.22,1,.36,1)' });
    token.animation.finished.then(() => { if (disclosures.get(element) === token) element.hidden = !open; }).catch(() => {});
}

function showAppearance(open) {
    elements.noteAppearance.setAttribute('aria-expanded', String(open));
    disclosure(elements.noteAppearancePanel, open, true);
}

function showFind(open) {
    if (open && preview) setView(false, { focus: false });
    elements.noteFindToggle.setAttribute('aria-expanded', String(open));
    disclosure(elements.noteFind, open);
    if (open) { elements.noteFindInput.focus(); elements.noteFindInput.select(); refreshFind(false); }
    else elements.noteContent.focus({ preventScroll: true });
}

function refreshFind(navigate = false, direction = 1) {
    const previous = findMatches[findIndex]?.start;
    findMatches = findNoteMatches(elements.noteContent.value, elements.noteFindInput.value);
    if (!findMatches.length) findIndex = -1;
    else if (navigate) findIndex = (findIndex + direction + findMatches.length) % findMatches.length;
    else {
        const retained = findMatches.findIndex(match => match.start === previous);
        findIndex = retained >= 0 ? retained : 0;
    }
    elements.noteFindCount.textContent = `${findIndex + 1}/${findMatches.length}`;
    elements.noteFindPrevious.disabled = !findMatches.length;
    elements.noteFindNext.disabled = !findMatches.length;
    elements.noteFindInput.setAttribute('aria-invalid', String(Boolean(elements.noteFindInput.value && !findMatches.length)));
    if (navigate || (document.activeElement === elements.noteFindInput && findIndex >= 0)) {
        const match = findMatches[findIndex];
        if (!match) return;
        // Focus without a scroll jump, reveal the selection, then return focus to
        // the search field so Enter continues through the same result set.
        elements.noteContent.focus({ preventScroll: true });
        elements.noteContent.setSelectionRange(match.start, match.end);
        const measure = document.createElement('div');
        measure.className = 'note-find-measure'; measure.setAttribute('aria-hidden', 'true');
        measure.append(document.createTextNode(elements.noteContent.value.slice(0, match.start)));
        const marker = document.createElement('span'); marker.textContent = '\u200b'; measure.append(marker);
        elements.noteContent.parentElement.append(measure);
        elements.noteContent.scrollTop = Math.max(0, marker.offsetTop - elements.noteContent.clientHeight / 3);
        measure.remove();
        elements.noteFindInput.focus({ preventScroll: true });
    }
}

async function loadNote() {
    if (closing) return;
    loading = true;
    autosave?.dispose(); autosave = null;
    setEditable();
    elements.noteLoadError.hidden = true; elements.noteSaveError.hidden = true; elements.noteRecovery.hidden = true;
    elements.noteSaveStatus.dataset.state = 'loading'; elements.noteSaveStatus.textContent = '正在打开…';
    try {
        if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id || '')) throw new Error('便签地址无效，请从便签工具重新打开。');
        const note = await invoke('get_sticky_note', { id });
        if (!validDraft(note) || note.trashedAt) throw new Error('便签已移入回收站或内容无法读取。');
        if (closing) return;
        elements.noteTitle.value = note.title; elements.noteContent.value = note.content;
        previewSource = null; closeFailure = false;
        autosave = createNoteAutosave({ initialNote: note, save: draft => invoke('save_sticky_note', { draft }), onState: renderState, remember: rememberDraft, forget: forgetDraft });
        showRecovery(note);
        loading = false;
        if (preview) renderPreview();
        setEditable();
        if (!recovery) (preview ? elements.notePreview : elements.noteContent).focus();
    } catch (error) {
        loading = false; elements.noteLoadError.hidden = false;
        elements.noteLoadMessage.textContent = String(error instanceof Error ? error.message : error);
        elements.noteSaveStatus.dataset.state = 'error'; elements.noteSaveStatus.textContent = '未加载';
        setEditable();
    }
}

function edit(changes) {
    if (!autosave || loading || closing || recovery) return;
    closeFailure = false;
    autosave.edit(changes);
}

function contentChanged() {
    edit({ content: elements.noteContent.value });
    if (preview) renderPreview();
    if (!elements.noteFind.hidden) refreshFind();
}

function applyTextEdit(change) {
    if (!change || !autosave || loading || closing || recovery || preview) return;
    const field = elements.noteContent;
    field.focus({ preventScroll: true });
    field.setSelectionRange(change.from, change.to);
    // insertText participates in the native textarea undo history. Browsers that
    // do not support it still receive the exact edit through setRangeText.
    if (!document.execCommand('insertText', false, change.replacement)) {
        field.setRangeText(change.replacement, change.from, change.to, 'end');
        contentChanged();
    }
    field.setSelectionRange(change.selectionStart, change.selectionEnd);
}

function format(action) {
    applyTextEdit(formatNoteSelection(elements.noteContent.value, elements.noteContent.selectionStart, elements.noteContent.selectionEnd, action));
}

async function toggleCollapse() {
    if (loading || closing || collapsing || !autosave || recovery) return;
    const previous = collapsed;
    collapsed = !collapsed; collapsing = true;
    showAppearance(false);
    document.body.dataset.collapsed = String(collapsed);
    elements.noteCollapse.setAttribute('aria-expanded', String(!collapsed));
    elements.noteCollapse.setAttribute('aria-label', collapsed ? '展开便签' : '折叠便签');
    elements.noteCollapse.title = collapsed ? '展开便签' : '折叠为标题条';
    updateAppearance(autosave.getState().draft); setEditable();
    try { await invoke('set_sticky_note_collapsed', { id, collapsed, animate: !reducedMotion() }); }
    catch (error) {
        collapsed = previous; document.body.dataset.collapsed = String(collapsed);
        elements.noteCollapse.setAttribute('aria-expanded', String(!collapsed));
        elements.noteCollapse.setAttribute('aria-label', collapsed ? '展开便签' : '折叠便签');
        elements.noteCollapse.title = String(error instanceof Error ? error.message : error);
        updateAppearance(autosave.getState().draft);
    } finally {
        collapsing = false; setEditable();
        if (closeQueued) { closeQueued = false; requestClose(); }
    }
}

async function requestClose() {
    if (closing) return;
    if (collapsing) { closeQueued = true; return; }
    closing = true; closeFailure = false; setEditable();
    try {
        // A failed load or unresolved recovery must never send an empty save.
        if (autosave) await autosave.flush();
        await invoke('close_sticky_note', { id });
        autosave?.dispose();
    } catch (error) {
        closing = false;
        closeFailure = Boolean(autosave && autosave.getState().status !== 'error');
        // Reveal the error when a collapsed note cannot close.
        if (collapsed) await toggleCollapse();
        showSaveError(error, closeFailure); setEditable();
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
elements.noteContent.addEventListener('input', contentChanged);
elements.noteContent.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); format(event.shiftKey ? 'outdent' : 'indent'); }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && elements.noteContent.selectionStart === elements.noteContent.selectionEnd) {
        const next = continueNoteList(elements.noteContent.value, elements.noteContent.selectionStart);
        if (next) { event.preventDefault(); applyTextEdit(next); }
    }
});
elements.notePin.addEventListener('click', () => { if (!autosave) return; edit({ pinned: !autosave.getState().draft.pinned }); autosave.flush().catch(() => {}); });
colorButtons.forEach(button => button.addEventListener('click', () => edit({ color: button.dataset.noteColor })));
fontButtons.forEach(button => button.addEventListener('click', () => {
    fontSize = button.dataset.fontSize; document.body.dataset.fontSize = fontSize;
    fontButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button))); rememberPreferences();
}));
elements.noteAppearance.addEventListener('click', () => showAppearance(elements.noteAppearance.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('pointerdown', event => { if (!event.target.closest('.note-appearance-panel, #noteAppearance') && elements.noteAppearance.getAttribute('aria-expanded') === 'true') showAppearance(false); });
elements.noteEditMode.addEventListener('click', () => setView(false));
elements.notePreviewMode.addEventListener('click', () => setView(true));
formatButtons.forEach(button => { button.addEventListener('pointerdown', event => event.preventDefault()); button.addEventListener('click', () => format(button.dataset.format)); });
elements.noteInsertDate.addEventListener('pointerdown', event => event.preventDefault());
elements.noteInsertDate.addEventListener('click', () => {
    const now = new Date();
    const replacement = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const from = elements.noteContent.selectionStart; const to = elements.noteContent.selectionEnd;
    if (elements.noteContent.value.length - (to - from) + replacement.length <= 20000) applyTextEdit({ from, to, replacement, selectionStart: from + replacement.length, selectionEnd: from + replacement.length });
});
elements.notePreview.addEventListener('change', event => {
    const input = event.target.closest('[data-task-line]');
    if (!input || loading || closing || recovery) return;
    const source = toggleNoteTask(elements.noteContent.value, Number(input.dataset.taskLine), input.checked);
    elements.noteContent.value = source;
    // Keep the task DOM and focus in place; only its completion state changes.
    previewSource = source; input.closest('.note-task').classList.toggle('is-complete', input.checked);
    edit({ content: source });
});
elements.noteFindToggle.addEventListener('click', () => showFind(elements.noteFindToggle.getAttribute('aria-expanded') !== 'true'));
elements.noteFindInput.addEventListener('input', () => { findIndex = -1; refreshFind(); });
elements.noteFindInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); refreshFind(true, event.shiftKey ? -1 : 1); } });
elements.noteFindPrevious.addEventListener('click', () => refreshFind(true, -1));
elements.noteFindNext.addEventListener('click', () => refreshFind(true, 1));
elements.noteFindClose.addEventListener('click', () => showFind(false));
elements.noteCollapse.addEventListener('click', toggleCollapse);
elements.noteClose.addEventListener('click', requestClose);
elements.noteRetry.addEventListener('click', retrySave);
elements.noteLoadRetry.addEventListener('click', loadNote);
elements.noteReload.addEventListener('click', loadNote);
elements.recoveryRestore.addEventListener('click', () => {
    if (!recovery || !autosave) return;
    const recovered = editableDraft(recovery); recovery = null; elements.noteRecovery.hidden = true;
    elements.noteTitle.value = recovered.title; elements.noteContent.value = recovered.content;
    setEditable();
    // Recovery adopts the loaded revision; its stale revision is not applied.
    edit(recovered); if (preview) renderPreview(); autosave.flush().catch(() => {});
    (preview ? elements.notePreview : elements.noteContent).focus();
});
elements.recoveryDiscard.addEventListener('click', () => { recovery = null; forgetDraft(); elements.noteRecovery.hidden = true; setEditable(); (preview ? elements.notePreview : elements.noteContent).focus(); });
elements.noteDragHandle.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('button')) return; api?.window?.getCurrentWindow?.().startDragging().catch(() => {}); });
elements.noteDragHandle.addEventListener('dblclick', event => { if (!event.target.closest('button')) toggleCollapse(); });
document.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && key === 's') { event.preventDefault(); retrySave(); }
    else if (command && key === 'f' && autosave && !loading && !closing && !recovery && !collapsed) { event.preventDefault(); showFind(true); }
    else if (command && event.shiftKey && key === 'p' && autosave && !loading && !closing && !recovery && !collapsed) { event.preventDefault(); setView(!preview); }
    else if (command && !event.shiftKey && ['b', 'i'].includes(key) && document.activeElement === elements.noteContent && !preview) { event.preventDefault(); format(key === 'b' ? 'bold' : 'italic'); }
    else if (event.key === 'Escape') {
        if (elements.noteAppearance.getAttribute('aria-expanded') === 'true') { event.preventDefault(); showAppearance(false); elements.noteAppearance.focus(); }
        else if (!elements.noteFind.hidden) { event.preventDefault(); showFind(false); }
        else if (preview && !recovery) { event.preventDefault(); setView(false); }
    }
});
window.addEventListener('blur', () => { if (!loading && !closing && !recovery) autosave?.flush().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.hidden && !loading && !closing && !recovery) autosave?.flush().catch(() => {}); });
window.addEventListener('pagehide', () => { if (autosave?.getState().dirty) rememberDraft(autosave.getState().draft); autosave?.dispose(); closeUnlisten?.(); disclosures.get(elements.noteFind)?.animation?.cancel(); disclosures.get(elements.noteAppearancePanel)?.animation?.cancel(); });

try {
    const preferences = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (['small', 'medium', 'large'].includes(preferences?.fontSize)) fontSize = preferences.fontSize;
    document.body.dataset.fontSize = fontSize;
    fontButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fontSize === fontSize)));
    if (preferences?.preview === true) setView(true, { focus: false });
} catch { /* Ignore optional preferences that were cleared or are unavailable. */ }
try {
    if (api?.event?.listen) closeUnlisten = await api.event.listen('sticky-note-close-request', requestClose);
    await loadNote();
} catch (error) {
    // Without the close interception handshake, leave the editor disabled.
    loading = false; elements.noteLoadError.hidden = false;
    elements.noteLoadMessage.textContent = `便签初始化失败：${String(error)}`;
    elements.noteSaveStatus.textContent = '未加载'; elements.noteSaveStatus.dataset.state = 'error'; setEditable();
}
