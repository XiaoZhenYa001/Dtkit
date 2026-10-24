import { registerTool } from '../toolRegistry.js';
import { escapeHtml as esc } from '../../core/html.js';
import { template, icon } from './template.js';
import { COLORS, LIMITS, TEMPLATES, normalizeNote, filterNotes, validateSeed, makeBackup, parseImport, noteMarkdown, safeFilename } from './core.js';
import '../../css/tools/sticky-notes.css';

let currentView;
const alive = view => Boolean(view && currentView === view && !view.controller.signal.aborted);
const node = (view, id) => view.root.querySelector('#' + id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const filters = ['all', 'pinned', 'opened', 'trash'];

function notice(view, text = '', error = false, undo = null) {
    if (!alive(view)) return;
    node(view, 'notesNotice').hidden = !text;
    node(view, 'notesNoticeText').textContent = text;
    node(view, 'notesNotice').classList.toggle('is-error', error);
    const inline = node(view, 'notesComposeNotice');
    if (inline) { inline.textContent = error && node(view, 'notesComposer').open ? text : ''; inline.hidden = !inline.textContent; }
    node(view, 'notesUndo').hidden = !undo;
    view.undo = undo;
}

function animate(view, element, frames, options = {}) {
    if (reduced() || !element.animate) return null;
    const animation = element.animate(frames, { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)', ...options });
    view.animations.add(animation);
    animation.finished.catch(() => {}).finally(() => view.animations.delete(animation));
    return animation;
}

function highlight(text, query) {
    const token = query.trim().replace(/^"|"$/g, '').split(/\s+/)[0];
    if (!token) return esc(text);
    const index = text.toLocaleLowerCase().indexOf(token.toLocaleLowerCase());
    return index < 0 ? esc(text) : esc(text.slice(0, index)) + '<mark>' + esc(text.slice(index, index + token.length)) + '</mark>' + esc(text.slice(index + token.length));
}

function dateLabel(timestamp) {
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function cardContent(view, note) {
    const title = note.title.trim() || '未命名便签', busy = view.pending.has(note.id), trash = Boolean(note.trashedAt);
    const selected = view.selected.has(note.id), query = node(view, 'notesSearch').value;
    const action = (name, label, symbol = name, disabled = false) => `<button type="button" data-note-action="${name}" ${busy || disabled ? 'disabled' : ''} title="${esc(label)}" aria-label="${esc(label + ' ' + title)}">${icon(symbol)}<span>${label}</span></button>`;
    return `<div class="notes-card__top"><div class="notes-card__badges">${note.pinned && !trash ? `<span title="桌面置顶">${icon('pin')}</span>` : ''}<span>${trash ? '回收站' : note.opened ? '桌面已打开' : '随时继续写'}</span></div><button class="notes-card__select" type="button" data-note-action="select" aria-label="选择 ${esc(title)}" aria-pressed="${selected}">${selected ? icon('check') : ''}</button></div>
        <button class="notes-card__content" type="button" data-note-action="${view.selecting ? 'select' : 'open'}" ${busy || (trash && !view.selecting) ? 'disabled' : ''}><h3>${highlight(title, query)}</h3><p class="${note.content ? '' : 'is-empty'}">${highlight(note.content.slice(0, 700) || '空白的纸，等你写下第一句话。', query)}</p></button>
        <div class="notes-card__meta">${note.progress.total ? `<span class="notes-card__progress">${icon('checklist')} ${note.progress.done}/${note.progress.total} 项完成</span>` : ''}<div class="notes-card__tags">${note.tags.slice(0, 3).map(tag => `<button type="button" data-note-tag="${esc(tag)}">#${esc(tag)}</button>`).join('')}</div></div>
        <div class="notes-card__footer"><time datetime="${new Date(note.updatedAt).toISOString()}" title="${esc(new Date(note.updatedAt).toLocaleString('zh-CN'))}">${dateLabel(note.trashedAt || note.updatedAt)}</time><div class="notes-card__actions">${trash ? action('restore', '恢复', 'restore') : action('open', note.opened ? '显示便签' : '打开便签', 'arrowUpRight')}
        <details class="notes-card-menu"><summary title="更多操作" aria-label="${esc(title)}的更多操作">${icon('more')}</summary><div class="notes-card-menu__panel">${trash ? action('delete', '永久删除', 'trash') : action('copy', '复制文字', 'copy') + action('duplicate', '创建副本', 'duplicate') + action('export', '导出 Markdown', 'download') + (note.opened ? action('close', '收起小窗', 'close') : '') + action('trash', '移入回收站', 'trash', note.opened)}</div></details></div></div>`;
}

// Keep surviving cards in the DOM: focus, open menus and spatial relationships survive refreshes.
function measureCards(view) {
    const positions = new Map();
    for (const [id, card] of view.cards) {
        positions.set(id, { rect: card.getBoundingClientRect(), opacity: getComputedStyle(card).opacity });
        card._motion?.cancel(); card._motion = null;
    }
    return positions;
}

function renderCards(view, notes, before) {
    const list = node(view, 'notesList');
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const nextIds = new Set(notes.map(note => note.id));
    list.querySelector('.notes-empty')?.remove();
    for (const [id, card] of view.cards) {
        if (nextIds.has(id)) continue;
        view.cards.delete(id);
        const { rect, opacity } = before.get(id), parent = list.getBoundingClientRect();
        card.inert = true; card.setAttribute('aria-hidden', 'true');
        card.removeAttribute('data-note-id');
        card.style.position = 'absolute'; card.style.left = rect.left - parent.left + 'px'; card.style.top = rect.top - parent.top + 'px';
        card.style.width = rect.width + 'px'; card.style.height = rect.height + 'px'; card.style.zIndex = '0';
        const animation = animate(view, card, [{ opacity, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.95)' }], { duration: 160, fill: 'forwards' });
        const exit = { card, animation }; view.exiting.set(id, exit);
        const remove = () => { if (view.exiting.get(id) === exit) { card.remove(); view.exiting.delete(id); } };
        if (animation) animation.finished.catch(() => {}).finally(remove); else remove();
    }
    let previous = null;
    for (const note of notes) {
        let card = view.cards.get(note.id), fresh = !card;
        let reenterOpacity = 0;
        const exiting = view.exiting.get(note.id);
        if (!card && exiting) {
            card = exiting.card; reenterOpacity = getComputedStyle(card).opacity;
            view.exiting.delete(note.id); exiting.animation?.cancel();
            for (const property of ['position', 'left', 'top', 'width', 'height', 'zIndex']) card.style[property] = '';
            card.inert = false; card.removeAttribute('aria-hidden'); card.dataset.noteId = note.id; view.cards.set(note.id, card);
        }
        if (!card) { card = document.createElement('article'); card.className = 'notes-card'; card.dataset.noteId = note.id; view.cards.set(note.id, card); }
        const signature = JSON.stringify([note.title, note.content.slice(0, 700), note.color, note.pinned, note.opened, note.trashedAt, note.updatedAt,
            note.tags, note.progress, view.pending.has(note.id), view.selected.has(note.id), view.selecting, node(view, 'notesSearch').value]);
        if (card._signature !== signature) {
            const menuOpen = card.querySelector('details')?.open;
            const focusedControl = card.contains(document.activeElement) ? document.activeElement : null;
            const focusKey = !focusedControl ? null : focusedControl.matches('summary') ? 'summary' : focusedControl.matches('.notes-card__content') ? 'content'
                : focusedControl.dataset.noteTag ? 'tag' : focusedControl.dataset.noteAction;
            const focusTag = focusedControl?.dataset.noteTag;
            card.innerHTML = cardContent(view, note); card._signature = signature;
            if (menuOpen) card.querySelector('details').open = true;
            const restoreFocus = focusKey === 'summary' ? card.querySelector('summary') : focusKey === 'content' ? card.querySelector('.notes-card__content')
                : focusKey === 'tag' ? [...card.querySelectorAll('[data-note-tag]')].find(button => button.dataset.noteTag === focusTag)
                    : focusKey ? [...card.querySelectorAll('[data-note-action]')].find(button => button.dataset.noteAction === focusKey && !button.matches('.notes-card__content')) : null;
            if (focusedControl) (restoreFocus || card.querySelector('summary'))?.focus({ preventScroll: true });
        }
        card.dataset.color = note.color; card.dataset.selected = String(view.selected.has(note.id)); card.dataset.selecting = String(view.selecting);
        card.classList.toggle('is-selected', view.selected.has(note.id)); card.classList.toggle('is-pending', view.pending.has(note.id));
        let next = previous ? previous.nextElementSibling : list.firstElementChild;
        while (next && next.inert) next = next.nextElementSibling;
        if (next !== card) list.insertBefore(card, next);
        previous = card;
        if (fresh) card._motion = animate(view, card, [{ opacity: reenterOpacity, transform: `translateY(${exiting ? 0 : 12}px) scale(.98)` }, { opacity: 1, transform: 'none' }]);
    }
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    for (const [id, card] of view.cards) {
        const measured = before.get(id); if (!measured) continue;
        const old = measured.rect, now = card.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
        const sx = now.width ? old.width / now.width : 1, sy = now.height ? old.height / now.height : 1;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(sx - 1) + Math.abs(sy - 1) > .01 || Number(measured.opacity) < 1) {
            card._motion = animate(view, card, [{ opacity: measured.opacity, transformOrigin: 'top left', transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { opacity: 1, transformOrigin: 'top left', transform: 'none' }]);
        }
    }
    if (!notes.length) {
        const searching = node(view, 'notesSearch').value || view.color !== 'all' || view.tag;
        const empty = document.createElement('div'); empty.className = 'notes-empty';
        empty.innerHTML = `<span>${icon(searching ? 'search' : view.filter === 'trash' ? 'trash' : 'note')}</span><h3>${searching ? '没有找到匹配的便签' : view.filter === 'trash' ? '回收站是空的' : view.filter === 'opened' ? '桌面上还没有便签' : view.filter === 'pinned' ? '留一个位置给重要的事' : '从一张小便签开始'}</h3><p>${searching ? '换个关键词，或清除筛选后再看看。' : view.filter === 'trash' ? '移入回收站的便签会保留在这里，可随时恢复。' : '想法、清单、会议要点，都值得随手记下。'}</p><button type="button" class="notes-button" data-empty-action="${searching ? 'reset' : 'create'}">${searching ? '清除筛选' : '写一张便签'} ${icon('arrow')}</button>`;
        list.append(empty); animate(view, empty, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }]);
    }
}

function render(view) {
    if (!alive(view)) return;
    const active = view.notes.filter(note => !note.trashedAt), list = node(view, 'notesList');
    // Measure the old geometry before changing the grid/list layout.
    const before = measureCards(view);
    const counts = { all: active.length, pinned: active.filter(note => note.pinned).length, opened: active.filter(note => note.opened).length, trash: view.notes.length - active.length };
    for (const [key, id] of Object.entries({ all: 'notesActiveCount', pinned: 'notesPinnedCount', opened: 'notesOpenedCount', trash: 'notesTrashCount' })) if (node(view, id)) node(view, id).textContent = counts[key];
    view.root.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === view.filter)));
    view.root.querySelectorAll('[data-filter-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filterColor === view.color)));
    view.root.querySelectorAll('[data-layout]').forEach(button => { if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.layout === view.layout)); });
    list.dataset.layout = view.layout; view.root.dataset.selecting = String(view.selecting);
    node(view, 'notesSelect').setAttribute('aria-pressed', String(view.selecting));
    node(view, 'notesCreate').disabled = !view.native || view.creating || view.notes.length >= LIMITS.notes;
    for (const id of ['notesQuickCreate', 'notesImport', 'notesRefresh', 'notesShowAll', 'notesHideAll']) if (node(view, id)) node(view, id).disabled = !view.native || view.creating;
    node(view, 'notesExport').disabled = !view.notes.length || view.exporting;
    node(view, 'notesSelectedCount').textContent = String(view.selected.size);
    node(view, 'notesBulk').hidden = !view.selecting;
    view.root.querySelectorAll('[data-bulk-action]').forEach(button => {
        const action = button.dataset.bulkAction;
        button.hidden = ['restore', 'delete'].includes(action) ? view.filter !== 'trash' : ['open', 'close', 'trash'].includes(action) ? view.filter === 'trash' : false;
        button.disabled = !['clear', 'all'].includes(action) && (!view.selected.size || view.batchBusy);
    });
    const visible = filterNotes(view.notes, { filter: view.filter, color: view.color, tag: view.tag, query: node(view, 'notesSearch').value, sort: node(view, 'notesSort').value });
    view.visible = visible;
    node(view, 'notesResultCount').textContent = `${visible.length} 张便签`;
    node(view, 'notesSummary').textContent = view.tag ? `#${view.tag} · 点击标签可取消筛选` : view.filter === 'trash' ? '回收站中的便签可恢复，永久删除需再次确认。' : `${counts.opened} 张在桌面 · ${active.reduce((sum, note) => sum + note.progress.total - note.progress.done, 0)} 项待完成`;
    const tags = new Map(); active.forEach(note => note.tags.forEach(tag => tags.set(tag, (tags.get(tag) || 0) + 1)));
    const tagHost = node(view, 'notesTags');
    if (tagHost) {
        const markup = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([tag, count]) => `<button type="button" data-note-tag="${esc(tag)}" aria-pressed="${view.tag === tag}"><span>#${esc(tag)}</span><small>${count}</small></button>`).join('') || '<p>在正文写 #标签，自动整理。</p>';
        if (tagHost.innerHTML !== markup) tagHost.innerHTML = markup;
    }
    renderCards(view, visible, before);
}

async function refresh(view) {
    if (!alive(view) || !view.native) return;
    clearTimeout(view.refreshTimer);
    const request = ++view.request;
    node(view, 'notesRefresh').classList.add('is-loading');
    try {
        const result = await invoke('list_sticky_notes');
        if (!alive(view) || request !== view.request) return;
        if (!Array.isArray(result)) throw new Error('便签列表读取失败，请重试。');
        view.notes = result.map(normalizeNote).filter(Boolean);
        const ids = new Set(view.notes.filter(note => Boolean(note.trashedAt) === (view.filter === 'trash')).map(note => note.id));
        view.selected = new Set([...view.selected].filter(id => ids.has(id)));
        render(view);
    } catch (error) { if (alive(view) && request === view.request) notice(view, String(error), true); }
    finally { if (alive(view) && request === view.request) node(view, 'notesRefresh').classList.remove('is-loading'); }
}

function scheduleRefresh(view) {
    if (!alive(view) || document.hidden) return;
    clearTimeout(view.refreshTimer); view.refreshTimer = setTimeout(() => refresh(view), 140);
}

function showDialog(view, id) {
    const dialog = node(view, id);
    if (!dialog || dialog.open) return;
    view.dialogFocus.set(dialog, document.activeElement);
    dialog.showModal();
    animate(view, dialog, [{ opacity: 0, transform: 'translateY(14px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
}

async function closeDialog(view, id) {
    const dialog = node(view, id);
    if (!dialog?.open || dialog.dataset.closing === 'true') return;
    dialog.dataset.closing = 'true';
    const animation = animate(view, dialog, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 140 });
    if (animation) await animation.finished.catch(() => {});
    dialog.close(); delete dialog.dataset.closing;
    const focus = view.dialogFocus.get(dialog);
    if (alive(view) && focus?.isConnected) focus.focus({ preventScroll: true });
}

function confirm(view, title, message, label = '确认', destructive = false) {
    view.confirmResolve?.(false);
    node(view, 'notesConfirmTitle').textContent = title; node(view, 'notesConfirmMessage').textContent = message;
    node(view, 'notesConfirmAccept').textContent = label; node(view, 'notesConfirmAccept').classList.toggle('is-danger', destructive);
    showDialog(view, 'notesConfirm');
    node(view, 'notesConfirmCancel').focus();
    return new Promise(resolve => { view.confirmResolve = resolve; });
}

function settleConfirm(view, accepted) {
    const resolve = view.confirmResolve; view.confirmResolve = null;
    closeDialog(view, 'notesConfirm').then(() => resolve?.(accepted && alive(view)));
}

function composeSnapshot(view) {
    return { title: node(view, 'notesComposeTitle').value, content: node(view, 'notesComposeContent').value, color: view.composeColor, pinned: node(view, 'notesComposePin').checked, open: node(view, 'notesComposeOpen').checked };
}

function updateCompose(view) {
    const draft = composeSnapshot(view);
    node(view, 'notesComposeCount').textContent = `${draft.content.length.toLocaleString('zh-CN')} / 20,000`;
    node(view, 'notesComposePaper').dataset.color = view.composeColor;
    view.root.querySelectorAll('[data-compose-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.composeColor === view.composeColor)));
    node(view, 'notesComposeSubmit').disabled = view.creating || !view.native;
    node(view, 'notesComposeForm').querySelectorAll('input,textarea,button:not(#notesComposeSubmit)').forEach(control => { control.disabled = view.creating; });
}

function openComposer(view) {
    if (!view.native || view.creating) return;
    const inline = node(view, 'notesComposeNotice'); if (inline) { inline.textContent = ''; inline.hidden = true; }
    updateCompose(view); showDialog(view, 'notesComposer');
    node(view, 'notesComposeContent').focus();
}

async function applyTemplate(view, key) {
    const seed = TEMPLATES[key]; if (!seed) return;
    const draft = composeSnapshot(view);
    if ((draft.title || draft.content) && !Object.values(TEMPLATES).some(item => item.title === draft.title && item.content === draft.content)) {
        if (!await confirm(view, '使用这个模板？', '将替换速记框中尚未创建的文字。', '使用模板')) return;
    }
    if (!alive(view)) return;
    node(view, 'notesComposeTitle').value = seed.title; node(view, 'notesComposeContent').value = seed.content; view.composeColor = seed.color;
    view.root.querySelectorAll('[data-template]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.template === key)));
    updateCompose(view); node(view, 'notesComposeContent').focus();
}

async function createNote(view, quick = false, suppliedSeed = null) {
    if (!alive(view) || !view.native || view.creating) return;
    let seed;
    try { seed = validateSeed(suppliedSeed || (quick ? { ...TEMPLATES.blank, pinned: true } : composeSnapshot(view))); }
    catch (error) { notice(view, error.message, true); return; }
    const shouldOpen = quick || suppliedSeed ? true : node(view, 'notesComposeOpen').checked;
    view.creating = true; notice(view); updateCompose(view); render(view);
    let note;
    try {
        note = await invoke('create_sticky_note', { seed });
        if (!alive(view)) return;
        if (!note?.id) throw new Error('便签创建结果无法确认，请刷新列表。');
        if (!quick && !suppliedSeed) {
            await closeDialog(view, 'notesComposer');
            node(view, 'notesComposeTitle').value = ''; node(view, 'notesComposeContent').value = '';
        }
        if (!alive(view)) return;
        view.filter = 'all'; view.tag = ''; view.color = 'all'; node(view, 'notesSearch').value = '';
        if (shouldOpen) await invoke('open_sticky_note', { id: note.id });
        if (alive(view)) notice(view, shouldOpen ? '便签已在桌面打开，写下的内容会自动保存。' : '已保存到便签库，随时打开继续写。');
    } catch (error) { if (alive(view)) notice(view, note ? `便签已创建，小窗暂未打开：${error}` : String(error), true); }
    finally { if (alive(view)) { view.creating = false; updateCompose(view); await refresh(view); } }
}

function download(view, text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime })); view.urls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); view.urls.delete(url); view.urlTimers.delete(timer); }, 30000); view.urlTimers.add(timer);
}

async function exportNotes(view, selected = null) {
    if (!alive(view) || view.exporting) return;
    const selectedIds = selected ? new Set(selected.map(note => note.id)) : null;
    view.exporting = true; render(view);
    try {
        // Another note window may have saved while this library is awaiting its debounced refresh.
        const result = view.native ? await invoke('list_sticky_notes') : view.notes;
        if (!alive(view)) return;
        if (!Array.isArray(result)) throw new Error('无法读取最新便签，未生成备份，请重试。');
        const latest = result.map(normalizeNote).filter(Boolean);
        const notes = selectedIds ? latest.filter(note => selectedIds.has(note.id)) : latest;
        if (!notes.length) throw new Error('没有可导出的便签，请刷新后重试。');
        download(view, makeBackup(notes), `DtKit-便签备份-${new Date().toISOString().slice(0, 10)}.json`, 'application/json;charset=utf-8');
        notice(view, `已导出 ${notes.length} 张便签的备份。`);
    } catch (error) { notice(view, `备份失败：${error}`, true); }
    finally { if (alive(view)) { view.exporting = false; render(view); } }
}

async function importFile(view, file) {
    if (!file || view.importing || !view.native) return;
    view.importing = true;
    try {
        if (file.size > LIMITS.importBytes) throw new Error('文件超过 16 MB，请拆分后导入。');
        const text = await file.text(); if (!alive(view)) return;
        const seeds = parseImport(text, { filename: file.name, currentCount: view.notes.length });
        const trash = seeds.filter(seed => seed.trashedAt != null).length;
        if (!await confirm(view, `导入 ${seeds.length} 张便签？`, `${file.name}\n${trash ? `其中 ${trash} 张会保留在回收站。` : ''}将创建新的便签，现有便签会完整保留。`, '导入便签')) return;
        await invoke('import_sticky_notes', { notes: seeds });
        if (alive(view)) { notice(view, `已导入 ${seeds.length} 张便签。`); await refresh(view); }
    } catch (error) { if (alive(view)) notice(view, String(error), true); }
    finally { if (alive(view)) { view.importing = false; node(view, 'notesImportFile').value = ''; } }
}

async function act(view, action, ids) {
    const targets = ids.map(id => view.notes.find(note => note.id === id)).filter(note => note && !view.pending.has(note.id));
    if (!targets.length || !alive(view)) return;
    if (action === 'export') { exportNotes(view, targets); return; }
    if (action === 'delete' && !await confirm(view, `永久删除 ${targets.length} 张便签？`, '删除后无法恢复。你也可以先导出备份，再执行删除。', '永久删除', true)) return;
    if (!alive(view)) return;
    if (action === 'trash' && targets.some(note => note.opened)) { notice(view, '请先收起已打开的小窗，确认内容保存后再移入回收站。', true); return; }
    if (action === 'duplicate') { const note = targets[0]; return createNote(view, true, { ...note, title: (note.title || '未命名便签').slice(0, 75) + ' · 副本' }); }
    if (action === 'copy') {
        try { await navigator.clipboard.writeText(noteMarkdown(targets[0])); notice(view, '便签文字已复制。'); }
        catch (error) { notice(view, `复制失败：${error}`, true); } return;
    }
    if (action === 'markdown') { const note = targets[0]; download(view, noteMarkdown(note), safeFilename(note.title), 'text/markdown;charset=utf-8'); notice(view, '已导出 Markdown。'); return; }
    const command = { open: 'open_sticky_note', close: 'close_sticky_note', trash: 'trash_sticky_note', restore: 'restore_sticky_note', delete: 'delete_sticky_note' }[action];
    if (!command) return;
    targets.forEach(note => view.pending.add(note.id)); view.batchBusy = true; render(view);
    const succeeded = [], failures = [];
    for (const note of targets) {
        if (!alive(view)) break;
        try { await invoke(command, { id: note.id }); succeeded.push(note.id); }
        catch (error) { failures.push(String(error)); }
    }
    if (!alive(view)) return;
    targets.forEach(note => view.pending.delete(note.id)); view.batchBusy = false;
    if (action !== 'close' && action !== 'open') succeeded.forEach(id => view.selected.delete(id));
    if (failures.length) notice(view, `${succeeded.length ? `已处理 ${succeeded.length} 张；` : ''}${failures[0]}${failures.length > 1 ? `（共 ${failures.length} 张未完成）` : ''}`, true);
    else if (action === 'trash') notice(view, `已将 ${succeeded.length} 张便签移入回收站。`, false, succeeded);
    else notice(view, ({ open: '已显示便签。', close: '已请求保存并收起小窗。', restore: '便签已恢复。', delete: '便签已永久删除。' })[action]);
    await refresh(view);
}

function setFilter(view, filter) {
    if (!filters.includes(filter)) return;
    view.filter = filter; view.selected.clear(); view.tag = ''; render(view);
}

async function handleClick(view, event) {
    const button = event.target.closest('button');
    const action = button?.dataset.noteAction;
    if (action) {
        const id = button.closest('[data-note-id]')?.dataset.noteId;
        if (!id || button.disabled) return;
        if (action === 'select') { view.selecting = true; view.selected.has(id) ? view.selected.delete(id) : view.selected.add(id); render(view); return; }
        const details = button.closest('details'); if (details) details.open = false;
        await act(view, action === 'export' ? 'markdown' : action, [id]); return;
    }
    if (button?.dataset.filter) { setFilter(view, button.dataset.filter); return; }
    if (button?.dataset.filterColor) { view.color = button.dataset.filterColor; render(view); return; }
    if (button?.dataset.noteTag) { view.tag = view.tag === button.dataset.noteTag ? '' : button.dataset.noteTag; render(view); return; }
    if (button?.dataset.layout) { view.layout = button.dataset.layout; render(view); return; }
    if (button?.dataset.template) { await applyTemplate(view, button.dataset.template); return; }
    if (button?.dataset.composeColor) { view.composeColor = button.dataset.composeColor; updateCompose(view); return; }
    if (button?.dataset.bulkAction) {
        const action = button.dataset.bulkAction;
        if (action === 'clear') { view.selected.clear(); view.selecting = false; render(view); return; }
        if (action === 'all') { view.selected = new Set(view.visible.map(note => note.id)); render(view); return; }
        await act(view, action, [...view.selected]); return;
    }
    if (button?.dataset.emptyAction === 'create') openComposer(view);
    if (button?.dataset.emptyAction === 'reset') { view.color = 'all'; view.tag = ''; node(view, 'notesSearch').value = ''; render(view); }
    if (button?.dataset.closeDialog) closeDialog(view, button.dataset.closeDialog);
}

async function init() {
    destroy();
    const root = document.querySelector('.notes-shell'); if (!root) return;
    const view = { root, controller: new AbortController(), notes: [], filter: 'all', color: 'all', tag: '', layout: 'grid', selected: new Set(), selecting: false,
        cards: new Map(), exiting: new Map(), pending: new Set(), animations: new Set(), dialogFocus: new Map(), urls: new Set(), urlTimers: new Set(), request: 0,
        native: Boolean(window.__TAURI__?.core?.invoke), creating: false, batchBusy: false, importing: false, composeColor: 'yellow' };
    currentView = view; const { signal } = view.controller;
    root.addEventListener('click', event => handleClick(view, event), { signal });
    document.addEventListener('pointerdown', event => {
        if (!alive(view)) return;
        root.querySelectorAll('details[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    }, { signal });
    node(view, 'notesCreate').addEventListener('click', () => openComposer(view), { signal });
    node(view, 'notesQuickCreate')?.addEventListener('click', () => createNote(view, true), { signal });
    node(view, 'notesSearch').addEventListener('input', () => render(view), { signal });
    node(view, 'notesSort').addEventListener('change', () => render(view), { signal });
    node(view, 'notesRefresh').addEventListener('click', () => refresh(view), { signal });
    node(view, 'notesSelect').addEventListener('click', () => { view.selecting = !view.selecting; if (!view.selecting) view.selected.clear(); render(view); }, { signal });
    node(view, 'notesComposeContent').addEventListener('input', () => updateCompose(view), { signal });
    node(view, 'notesComposeForm').addEventListener('submit', event => { event.preventDefault(); createNote(view); }, { signal });
    node(view, 'notesComposeCancel').addEventListener('click', () => closeDialog(view, 'notesComposer'), { signal });
    node(view, 'notesConfirmAccept').addEventListener('click', () => settleConfirm(view, true), { signal });
    node(view, 'notesConfirmCancel').addEventListener('click', () => settleConfirm(view, false), { signal });
    node(view, 'notesHelpTrigger')?.addEventListener('click', () => showDialog(view, 'notesHelp'), { signal });
    node(view, 'notesExport').addEventListener('click', () => exportNotes(view), { signal });
    node(view, 'notesImport').addEventListener('click', () => node(view, 'notesImportFile').click(), { signal });
    node(view, 'notesImportFile').addEventListener('change', event => importFile(view, event.target.files?.[0]), { signal });
    node(view, 'notesUndo').addEventListener('click', () => { const ids = view.undo; if (ids) act(view, 'restore', ids); }, { signal });
    for (const [id, visible] of [['notesShowAll', true], ['notesHideAll', false]]) node(view, id)?.addEventListener('click', async () => {
        try { await invoke('set_sticky_notes_visible', { visible }); notice(view, visible ? '已显示桌面便签。' : '已隐藏桌面便签，内容仍会自动保存。'); }
        catch (error) { notice(view, String(error), true); }
    }, { signal });
    root.querySelectorAll('dialog').forEach(dialog => {
        dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); if (dialog.id === 'notesConfirm') settleConfirm(view, false); else if (!view.creating) closeDialog(view, dialog.id); }, { signal });
        dialog.addEventListener('click', event => { if (event.target !== dialog || view.creating) return; const rect = dialog.getBoundingClientRect(); if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return; if (dialog.id === 'notesConfirm') settleConfirm(view, false); else closeDialog(view, dialog.id); }, { signal });
    });
    document.addEventListener('keydown', event => {
        if (!alive(view) || event.isComposing) return;
        const modifier = event.ctrlKey || event.metaKey;
        const dialog = [...root.querySelectorAll('dialog[open]')].at(-1);
        if (dialog) { if (modifier && event.key === 'Enter' && dialog.id === 'notesComposer') { event.preventDefault(); createNote(view); } if (event.key === 'Escape') event.stopPropagation(); return; }
        const menu = root.querySelector('details[open]');
        if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); return; }
        if (modifier && event.key.toLowerCase() === 'n') { event.preventDefault(); openComposer(view); }
        if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); node(view, 'notesSearch').focus(); }
        const editing = event.target.closest('input,textarea,[contenteditable=true]');
        if (modifier && event.key.toLowerCase() === 'a' && view.selecting && !editing) { event.preventDefault(); view.selected = new Set(view.visible.map(note => note.id)); render(view); }
        if (event.key === 'Escape' && view.selecting) { event.preventDefault(); event.stopPropagation(); view.selected.clear(); view.selecting = false; render(view); }
    }, { signal, capture: true });
    if (!window.__DTKIT_TOOL_PAGE_CONTEXT?.embedded) window.addEventListener('focus', () => scheduleRefresh(view), { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(view); }, { signal });
    window.addEventListener('dtkit:power-state', event => { if (!event.detail?.suspended) scheduleRefresh(view); }, { signal });
    render(view); updateCompose(view);
    if (!view.native) { notice(view, '请在 DtKit 桌面版中使用便签，内容会保存在本机。'); return; }
    try {
        const dispose = await window.__TAURI__.event?.listen?.('sticky-notes-changed', () => scheduleRefresh(view));
        if (!alive(view)) { dispose?.(); return; } view.unlisten = dispose;
    } catch (error) { notice(view, `实时列表暂不可用，可手动刷新：${error}`, true); }
    if (alive(view)) await refresh(view);
}

function serialize() {
    const view = currentView; if (!view) return null;
    return { version: 1, filter: view.filter, color: view.color, tag: view.tag, layout: view.layout, query: node(view, 'notesSearch').value, sort: node(view, 'notesSort').value,
        compose: composeSnapshot(view), composerOpen: node(view, 'notesComposer').open };
}

function restore(snapshot) {
    const view = currentView; if (!alive(view) || snapshot?.version !== 1) return;
    view.filter = filters.includes(snapshot.filter) ? snapshot.filter : 'all'; view.color = COLORS.includes(snapshot.color) ? snapshot.color : 'all';
    view.tag = typeof snapshot.tag === 'string' ? snapshot.tag.slice(0, 30) : ''; view.layout = snapshot.layout === 'list' ? 'list' : 'grid';
    node(view, 'notesSearch').value = String(snapshot.query || '').slice(0, 200); node(view, 'notesSort').value = ['updated', 'created', 'title'].includes(snapshot.sort) ? snapshot.sort : 'updated';
    if (snapshot.compose) try {
        const draft = validateSeed(snapshot.compose); node(view, 'notesComposeTitle').value = draft.title; node(view, 'notesComposeContent').value = draft.content; view.composeColor = draft.color;
        node(view, 'notesComposePin').checked = draft.pinned; node(view, 'notesComposeOpen').checked = snapshot.compose.open !== false;
    } catch { /* Invalid snapshots never replace a current draft. */ }
    render(view); updateCompose(view); if (snapshot.composerOpen) openComposer(view);
}

function destroy() {
    const view = currentView; if (!view) return;
    view.controller.abort(); view.unlisten?.(); clearTimeout(view.refreshTimer); view.request++; view.confirmResolve?.(false);
    view.animations.forEach(animation => animation.cancel()); view.urlTimers.forEach(clearTimeout); view.urls.forEach(url => URL.revokeObjectURL(url));
    view.root.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); currentView = null;
}

registerTool({ id: 'sticky-notes', name: '便签', icon: 'ri-sticky-note-line', colorClass: 'tool-card__icon--yellow', category: 'utility', status: 'ready',
    description: '模板速记、清单与 Markdown，分类检索、批量整理和备份，让桌面便签随手可用。', template, init, destroy, serialize, restore });
