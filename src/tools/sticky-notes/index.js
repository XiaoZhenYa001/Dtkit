import { registerTool } from '../toolRegistry.js';
import { escapeHtml } from '../../core/html.js';
import '../../css/tools/sticky-notes.css';

const colors = new Set(['yellow', 'green', 'blue', 'pink', 'purple', 'gray']);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const byId = id => document.getElementById(id);
let controller;
let unlisten;
let refreshTimer;
let generation = 0;
let request = 0;
let notes = [];
let trash = false;
let creating = false;
let pending = new Set();

function template() {
    return `<div class="notes-shell">
        <header class="notes-header"><div class="notes-heading"><span class="notes-emblem"><i class="ri-sticky-note-line"></i></span><div><span class="notes-kicker">灵感、琐事，随手记</span><h2>我的便签</h2><p>把需要记住的事，留在桌面上。</p></div></div><button id="notesCreate" class="notes-button notes-button--primary" type="button"><i class="ri-add-line"></i> 新建便签</button></header>
        <div class="notes-toolbar"><div class="notes-tabs" role="group" aria-label="便签分类"><button id="notesActiveTab" type="button" aria-pressed="true">全部便签 <span id="notesActiveCount">0</span></button><button id="notesTrashTab" type="button" aria-pressed="false"><i class="ri-delete-bin-line"></i> 回收站 <span id="notesTrashCount">0</span></button></div><label class="notes-search"><i class="ri-search-line"></i><input id="notesSearch" type="search" placeholder="搜索标题或内容" aria-label="搜索便签" autocomplete="off"></label><button id="notesRefresh" class="notes-button notes-refresh" type="button" aria-label="刷新便签" title="刷新"><i class="ri-refresh-line"></i></button></div>
        <p id="notesNotice" class="notes-notice" role="status" aria-live="polite"></p>
        <div id="notesList" class="notes-grid" aria-label="便签列表"></div>
        <footer class="notes-footer"><span><i class="ri-checkbox-circle-line"></i> 本地自动保存</span><span><i class="ri-pushpin-line"></i> 支持置顶、拖动和缩放</span><span>关闭小窗会保留内容，可随时再次打开</span></footer>
    </div>`;
}

function notice(message = '', error = false) {
    const element = byId('notesNotice');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', error);
}

function dateLabel(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function card(note) {
    const title = note.title.trim() || '未命名便签';
    const id = escapeHtml(note.id);
    const busy = pending.has(note.id);
    const color = colors.has(note.color) ? note.color : 'yellow';
    return `<article class="notes-card" data-note-id="${id}" data-color="${color}">
        <div class="notes-card__top"><span>${note.trashedAt ? '已移入回收站' : note.opened ? '桌面上已打开' : '随时打开继续写'}</span>${note.pinned && !note.trashedAt ? '<i class="ri-pushpin-line" title="已置顶" aria-label="已置顶"></i>' : ''}</div>
        <button class="notes-card__content" type="button" data-note-action="open" ${busy || note.trashedAt ? 'disabled' : ''} title="${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3><p class="${note.content ? '' : 'is-empty'}">${escapeHtml(note.content.slice(0, 700) || '空白的纸，等你写下第一句话。')}</p></button>
        <div class="notes-card__footer"><time datetime="${escapeHtml(new Date(note.updatedAt).toISOString())}">${escapeHtml(dateLabel(note.trashedAt || note.updatedAt))}</time><div class="notes-card__actions">${note.trashedAt
            ? `<button type="button" data-note-action="restore" ${busy ? 'disabled' : ''}>恢复</button><button type="button" data-note-action="delete" class="notes-card__delete" ${busy ? 'disabled' : ''} aria-label="永久删除 ${escapeHtml(title)}" title="永久删除"><i class="ri-delete-bin-line"></i></button>`
            : `<button type="button" data-note-action="open" ${busy ? 'disabled' : ''}>${note.opened ? '显示便签' : '打开便签'} <i class="ri-arrow-right-up-line"></i></button><button type="button" data-note-action="trash" ${busy || note.opened ? 'disabled' : ''} aria-label="移入回收站 ${escapeHtml(title)}" title="${note.opened ? '请先关闭便签小窗，再移入回收站' : '移入回收站'}"><i class="ri-delete-bin-line"></i></button>`}</div></div>
    </article>`;
}

function render() {
    if (!byId('notesList')) return;
    const query = byId('notesSearch').value.trim().toLocaleLowerCase();
    const activeCount = notes.filter(note => !note.trashedAt).length;
    byId('notesActiveCount').textContent = activeCount;
    byId('notesTrashCount').textContent = notes.length - activeCount;
    byId('notesActiveTab').setAttribute('aria-pressed', String(!trash));
    byId('notesTrashTab').setAttribute('aria-pressed', String(trash));
    byId('notesCreate').disabled = creating || !window.__TAURI__?.core?.invoke || notes.length >= 200;
    byId('notesCreate').title = notes.length >= 200 ? '已达 200 张上限，可在回收站永久删除不需要的便签' : '';
    const visible = notes.filter(note => Boolean(note.trashedAt) === trash && (!query || note.searchText.includes(query)))
        .sort((a, b) => Number(b.pinned && !trash) - Number(a.pinned && !trash) || (b.trashedAt || b.updatedAt) - (a.trashedAt || a.updatedAt));
    byId('notesList').innerHTML = visible.length ? visible.map(card).join('') : `<div class="notes-empty"><span><i class="${query ? 'ri-search-line' : trash ? 'ri-delete-bin-line' : 'ri-sticky-note-line'}"></i></span><h3>${query ? '没有找到匹配的便签' : trash ? '回收站是空的' : '从一张小便签开始'}</h3><p>${query ? '换个关键词试试，也可以搜索正文中的文字。' : trash ? '移入回收站的便签会保留在这里，直到你选择永久删除。' : '待办事项、临时想法、重要信息，都可以随手写下。'}</p>${!query && !trash ? '<button class="notes-button" type="button" data-create-note>写下第一张便签 <i class="ri-arrow-right-line"></i></button>' : ''}</div>`;
}

async function refresh() {
    if (!window.__TAURI__?.core?.invoke) return;
    clearTimeout(refreshTimer);
    const current = generation;
    const ticket = ++request;
    try {
        const result = await invoke('list_sticky_notes');
        if (current !== generation || ticket !== request) return;
        if (!Array.isArray(result)) throw new Error('便签列表读取失败，请重试');
        notes = result.map(note => ({ ...note, searchText: `${note.title}\n${note.content}`.toLocaleLowerCase() }));
        render();
    } catch (error) { if (current === generation && ticket === request) notice(String(error), true); }
}

function scheduleRefresh() {
    if (document.hidden) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 180);
}

async function createNote() {
    if (creating || !window.__TAURI__?.core?.invoke) return;
    creating = true;
    const current = generation;
    notice();
    render();
    let note;
    try {
        note = await invoke('create_sticky_note');
        if (current === generation) { trash = false; byId('notesSearch').value = ''; }
        await invoke('open_sticky_note', { id: note.id });
        if (current === generation) notice('便签已在独立小窗中打开，写下的内容会自动保存。');
    } catch (error) { if (current === generation) notice(note ? `便签已创建，但小窗未打开：${error}。可从列表重新打开。` : String(error), true); }
    finally { if (current === generation) { creating = false; await refresh(); render(); } }
}

async function performAction(event) {
    if (event.target.closest('[data-create-note]')) { await createNote(); return; }
    const button = event.target.closest('[data-note-action]');
    if (!button || button.disabled) return;
    const id = button.closest('[data-note-id]')?.dataset.noteId;
    if (!id || pending.has(id)) return;
    const action = button.dataset.noteAction;
    if (action === 'delete' && !window.confirm('永久删除这张便签？删除后无法恢复。')) return;
    const command = { open: 'open_sticky_note', trash: 'trash_sticky_note', restore: 'restore_sticky_note', delete: 'delete_sticky_note' }[action];
    if (!command) return;
    const current = generation;
    pending.add(id);
    notice();
    render();
    try {
        await invoke(command, { id });
        if (current === generation) {
            if (action === 'trash') notice('已移入回收站，可随时恢复。');
            if (action === 'restore') notice('便签已恢复，可在全部便签中打开。');
            if (action === 'delete') notice('便签已永久删除。');
        }
    } catch (error) { if (current === generation) notice(String(error), true); }
    finally { if (current === generation) { pending.delete(id); await refresh(); render(); } }
}

async function init() {
    destroy();
    const current = generation;
    controller = new AbortController();
    const { signal } = controller;
    notes = []; trash = false; creating = false; pending = new Set();
    render();
    if (!window.__TAURI__?.core?.invoke) { notice('请在 DtKit 桌面版中使用便签，内容会保存在本机。'); byId('notesRefresh').disabled = true; return; }
    byId('notesCreate').addEventListener('click', createNote, { signal });
    byId('notesList').addEventListener('click', performAction, { signal });
    byId('notesSearch').addEventListener('input', render, { signal });
    byId('notesActiveTab').addEventListener('click', () => { trash = false; render(); }, { signal });
    byId('notesTrashTab').addEventListener('click', () => { trash = true; render(); }, { signal });
    byId('notesRefresh').addEventListener('click', refresh, { signal });
    window.addEventListener('focus', scheduleRefresh, { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); }, { signal });
    try {
        const listen = window.__TAURI__?.event?.listen;
        if (listen) {
            const dispose = await listen('sticky-notes-changed', () => { if (current === generation) scheduleRefresh(); });
            if (current !== generation) { dispose(); return; }
            unlisten = dispose;
        }
    } catch (error) { if (current === generation) notice(`实时列表暂不可用，可点击刷新：${error}`, true); }
    if (current === generation) await refresh();
}

function destroy() {
    generation += 1;
    request += 1;
    controller?.abort(); controller = null;
    unlisten?.(); unlisten = null;
    clearTimeout(refreshTimer);
}

registerTool({ id: 'sticky-notes', name: '便签', icon: 'ri-sticky-note-line', colorClass: 'tool-card__icon--yellow', category: 'utility', status: 'ready', description: '随手记录灵感与待办，自动保存为可置顶的桌面便签。', template, init, destroy });
