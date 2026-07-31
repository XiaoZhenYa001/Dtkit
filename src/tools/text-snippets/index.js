import '../../css/tools/text-snippets.css';
import { registerTool } from '../toolRegistry.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const byId = id => document.getElementById(id);
const quick = () => location.pathname.toLowerCase().endsWith('/quick.html');
let controller;
let items = [];
let selectedId = null;
let timer;
let generation = 0;
let saving = false;
let filter = 'all';
let knownTags = [];

function template() {
    return `<div class="snippet-shell${quick() ? ' snippet-shell--quick' : ''}">
      <header class="snippet-header">
        <div class="snippet-heading"><span class="snippet-heading__icon"><i class="ri-file-copy-2-line"></i></span><div><span class="snippet-kicker">TEXT LIBRARY</span><h2>文本片段库</h2>
          <p>${quick() ? '输入关键词，选择后按 Enter 复制' : '把重复输入变成一次搜索；数据仅保存在本机。'}</p></div></div>
        ${quick() ? '<span class="snippet-key-hint"><kbd>↑</kbd><kbd>↓</kbd> 选择　<kbd>Enter</kbd> 复制</span>' : '<div class="snippet-header__actions"><span class="snippet-local-badge"><i class="ri-shield-check-line"></i> 本地存储 · 按需读取</span><button id="snippetAdd" class="snippet-primary"><i class="ri-add-line"></i> 新建片段</button></div>'}
      </header>
      <div class="snippet-commandbar">
        <label class="snippet-search"><i class="ri-search-line"></i>
          <input id="snippetSearch" type="search" autocomplete="off" placeholder="搜索名称、内容或标签"><span class="snippet-search__key">/</span></label>
        <div class="snippet-filters" role="group" aria-label="片段筛选">
          <button type="button" class="is-active" data-snippet-filter="all" aria-pressed="true"><i class="ri-layout-grid-line"></i> 全部</button>
          <button type="button" data-snippet-filter="pinned" aria-pressed="false"><i class="ri-pushpin-line"></i> 已置顶</button>
        </div>
      </div>
      <div id="snippetTagStrip" class="snippet-tag-strip" aria-label="常用标签"></div>
      <div id="snippetList" class="snippet-list" role="listbox"></div>
      <footer class="snippet-footer"><p id="snippetStatus" class="snippet-status" role="status"></p><span><i class="ri-mouse-line"></i> 单击选择，再次点击复制</span></footer>
      ${quick() ? '' : `<dialog id="snippetEditor" class="snippet-dialog"><form id="snippetForm" method="dialog">
        <div class="snippet-dialog__head"><div><span class="snippet-kicker">SNIPPET</span><h3 id="snippetEditorTitle">新建片段</h3></div>
          <button id="snippetEditorClose" type="button" aria-label="关闭">×</button></div>
        <input id="snippetId" type="hidden">
        <label>名称<input id="snippetTitle" maxlength="120" required></label>
        <label>标签<input id="snippetTags" placeholder="使用逗号分隔，最多 12 个"></label>
        <label>内容<textarea id="snippetContent" maxlength="50000" rows="10" required></textarea></label>
        <label class="snippet-pin"><input id="snippetPinned" type="checkbox"><span>置顶显示</span></label>
        <div class="snippet-dialog__actions"><button id="snippetEditorCancel" type="button">取消</button><button id="snippetSave" class="snippet-primary" type="submit">保存</button></div>
      </form></dialog>`}
    </div>`;
}

function status(message, type = '') {
    const node = byId('snippetStatus');
    if (node) { node.textContent = message; node.dataset.type = type; }
}

function nodeFor(item) {
    const row = document.createElement('article');
    row.className = `snippet-row${selectedId === item.id ? ' is-selected' : ''}`;
    row.dataset.snippetId = item.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selectedId === item.id));
    row.tabIndex = 0;
    const mark = document.createElement('span');
    mark.className = 'snippet-row__mark';
    mark.innerHTML = `<i class="${item.pinned ? 'ri-pushpin-fill' : 'ri-file-copy-2-line'}"></i>`;
    const text = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = item.title;
    const preview = document.createElement('p');
    preview.textContent = item.content.replace(/\s+/g, ' ').slice(0, quick() ? 90 : 180);
    const tags = document.createElement('span');
    tags.className = 'snippet-row__tags';
    tags.textContent = item.tags.length ? item.tags.map(tag => `#${tag}`).join('  ') : '无标签';
    text.append(title, preview, tags);
    row.append(mark, text);
    if (!quick()) {
        const actions = document.createElement('div');
        actions.className = 'snippet-row__actions';
        [['copy', '复制', 'ri-file-copy-line'], ['edit', '编辑', 'ri-edit-line'], ['delete', '删除', 'ri-delete-bin-line']].forEach(([action, label, icon]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = action;
            button.title = label;
            button.setAttribute('aria-label', `${label}“${item.title}”`);
            const symbol = document.createElement('i');
            symbol.className = icon;
            button.append(symbol);
            actions.append(button);
        });
        row.append(actions);
    }
    return row;
}

function render() {
    const list = byId('snippetList');
    if (!list) return;
    const visible = filter === 'pinned' ? items.filter(item => item.pinned) : items;
    if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'snippet-empty';
        const searching = Boolean(byId('snippetSearch')?.value.trim());
        const pinnedEmpty = filter === 'pinned' && items.length;
        empty.innerHTML = `<i class="${searching ? 'ri-search-line' : pinnedEmpty ? 'ri-pushpin-line' : 'ri-file-copy-2-line'}"></i><strong>${searching ? '没有匹配的文本片段' : pinnedEmpty ? '还没有置顶片段' : '文本片段库还是空的'}</strong><span>${searching ? '换一个关键词，或清空搜索条件。' : pinnedEmpty ? '编辑片段并勾选“置顶显示”即可固定到前面。' : quick() ? '请在主窗口中创建第一个片段。' : '创建常用回复、代码或地址，之后可通过快捷键快速复制。'}</span>`;
        list.replaceChildren(empty);
    } else list.replaceChildren(...visible.map(nodeFor));
}

function renderTags() {
    const strip = byId('snippetTagStrip');
    if (!strip) return;
    const label = document.createElement('span');
    label.className = 'snippet-tag-strip__label';
    label.innerHTML = '<i class="ri-price-tag-3-line"></i> 标签';
    const tags = knownTags.slice(0, 8).map(tag => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.snippetTag = tag;
        button.textContent = `# ${tag}`;
        return button;
    });
    strip.replaceChildren(label, ...tags);
    strip.hidden = tags.length === 0 || quick();
}

async function refresh() {
    const current = ++generation;
    try {
        const result = await invoke('search_snippets', {
            query: byId('snippetSearch')?.value || '', limit: quick() ? 40 : 120
        });
        if (current !== generation) return;
        items = result.items;
        if (!byId('snippetSearch')?.value.trim()) {
            knownTags = [...new Set(items.flatMap(item => item.tags))].slice(0, 20);
            renderTags();
        }
        if (!items.some(item => item.id === selectedId)) selectedId = null;
        render();
        const visibleCount = filter === 'pinned' ? items.filter(item => item.pinned).length : items.length;
        status(result.truncated ? `共 ${result.total} 条，仅显示前 ${items.length} 条。` : `${visibleCount} 条片段${filter === 'pinned' ? '已置顶' : ''}`);
    } catch (error) { if (current === generation) status(String(error), 'error'); }
}

async function copy(item) {
    try {
        await navigator.clipboard.writeText(item.content);
        status(`已复制“${item.title}”`, 'success');
    } catch (error) {
        status(`复制失败：${error}`, 'error');
    }
}

function fill(item = {}) {
    byId('snippetId').value = item.id || '';
    byId('snippetTitle').value = item.title || '';
    byId('snippetTags').value = (item.tags || []).join(', ');
    byId('snippetContent').value = item.content || '';
    byId('snippetPinned').checked = Boolean(item.pinned);
}

function openEditor(item) {
    fill(item);
    byId('snippetEditorTitle').textContent = item ? '编辑片段' : '新建片段';
    byId('snippetEditor').showModal();
    byId('snippetTitle').focus();
}

async function handleClick(event) {
    const row = event.target.closest('[data-snippet-id]');
    if (!row) return;
    const item = items.find(entry => entry.id === row.dataset.snippetId);
    if (!item) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'copy') return copy(item);
    if (action === 'edit') return openEditor(item);
    if (action === 'delete') {
        if (!confirm(`删除“${item.title}”？`)) return;
        try {
            await invoke('delete_snippet', { id: item.id });
            await refresh();
            status(`已删除“${item.title}”`, 'success');
        } catch (error) {
            status(`删除失败：${error}`, 'error');
        }
        return;
    }
    if (selectedId === item.id) return copy(item);
    selectedId = item.id; render();
}

async function submit(event) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const saveButton = byId('snippetSave');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = '正在保存…';
    }
    try {
        await invoke('save_snippet', { draft: {
            id: byId('snippetId').value || null,
            title: byId('snippetTitle').value,
            content: byId('snippetContent').value,
            tags: byId('snippetTags').value.split(/[,，]/),
            pinned: byId('snippetPinned').checked
        }});
        byId('snippetEditor').close();
        await refresh(); status('文本片段已保存。', 'success');
    } catch (error) { status(String(error), 'error'); }
    finally {
        saving = false;
        if (saveButton?.isConnected) {
            saveButton.disabled = false;
            saveButton.textContent = '保存';
        }
    }
}

async function init() {
    controller?.abort(); controller = new AbortController();
    const { signal } = controller;
    byId('snippetSearch')?.addEventListener('input', () => {
        clearTimeout(timer); timer = setTimeout(refresh, 100);
    }, { signal });
    document.querySelectorAll('[data-snippet-filter]').forEach(button => button.addEventListener('click', () => {
        filter = button.dataset.snippetFilter;
        document.querySelectorAll('[data-snippet-filter]').forEach(node => {
            const active = node === button;
            node.classList.toggle('is-active', active);
            node.setAttribute('aria-pressed', String(active));
        });
        selectedId = null;
        render();
        const visibleCount = filter === 'pinned' ? items.filter(item => item.pinned).length : items.length;
        status(`${visibleCount} 条片段${filter === 'pinned' ? '已置顶' : ''}`);
    }, { signal }));
    byId('snippetTagStrip')?.addEventListener('click', event => {
        const tag = event.target.closest('[data-snippet-tag]')?.dataset.snippetTag;
        if (!tag) return;
        byId('snippetSearch').value = tag;
        refresh();
    }, { signal });
    byId('snippetSearch')?.addEventListener('keydown', event => {
        const navigable = filter === 'pinned' ? items.filter(item => item.pinned) : items;
        if (!navigable.length) return;
        let index = navigable.findIndex(item => item.id === selectedId);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            index = (index + (event.key === 'ArrowDown' ? 1 : -1) + navigable.length) % navigable.length;
            selectedId = navigable[index].id; render();
        } else if (event.key === 'Enter' && selectedId) {
            event.preventDefault(); copy(navigable.find(item => item.id === selectedId));
        }
    }, { signal });
    byId('snippetList')?.addEventListener('click', handleClick, { signal });
    byId('snippetList')?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('[data-snippet-id]');
        if (!row) return;
        event.preventDefault();
        handleClick(event);
    }, { signal });
    byId('snippetAdd')?.addEventListener('click', () => openEditor(), { signal });
    const closeEditor = () => byId('snippetEditor')?.close();
    byId('snippetEditorClose')?.addEventListener('click', closeEditor, { signal });
    byId('snippetEditorCancel')?.addEventListener('click', closeEditor, { signal });
    byId('snippetForm')?.addEventListener('submit', submit, { signal });
    document.addEventListener('keydown', event => {
        if (event.key === '/' && document.activeElement !== byId('snippetSearch') && !byId('snippetEditor')?.open) {
            event.preventDefault();
            byId('snippetSearch')?.focus();
        }
    }, { signal });
    await refresh(); byId('snippetSearch')?.focus();
}

function destroy() {
    controller?.abort(); controller = null; clearTimeout(timer); generation += 1; items = []; selectedId = null; saving = false; filter = 'all'; knownTags = [];
}

registerTool({
    id: 'text-snippets', name: '文本片段库', icon: 'ri-file-copy-2-line',
    colorClass: 'tool-card__icon--blue', category: 'utility', status: 'ready',
    description: '保存常用回复、代码和模板，通过快捷键快速搜索复制。',
    template, init, destroy
});
