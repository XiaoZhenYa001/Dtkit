import { registerTool } from '../toolRegistry.js';
import '../../css/tools/password-vault.css';

const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');

let controller = null;
let items = [];
let selectedId = null;
let searchTimer = null;
let importToken = null;
let resultTotal = 0;
let resultsTruncated = false;
let refreshGeneration = 0;

function quickTemplate() {
    return `
        <div class="password-quick">
            <div class="password-quick__security"><i class="ri-shield-check-line"></i>
                本机加密 · 不进入剪贴板历史</div>
            <label class="password-search password-search--quick">
                <i class="ri-search-line"></i>
                <input id="passwordSearch" type="search" autocomplete="off" spellcheck="false"
                    placeholder="搜索密码，或输入 #分类 开发" aria-label="搜索密码">
                <kbd>Esc</kbd>
            </label>
            <div id="passwordList" class="password-results password-results--quick" role="listbox"></div>
            <p id="passwordStatus" class="password-status" aria-live="polite"></p>
        </div>`;
}

function mainTemplate() {
    return `
        <div class="password-shell">
            <header class="password-hero">
                <div class="password-hero__identity">
                    <span class="password-hero__icon"><i class="ri-lock-2-line"></i></span>
                    <div><span class="password-kicker">LOCAL PASSWORDS</span>
                        <h2>密码</h2>
                        <p>密码库由当前 Windows 用户保护；搜索结果不包含密码正文。</p>
                    </div>
                </div>
                <div class="password-hero__actions">
                    <button id="passwordImport" class="password-button password-button--secondary" type="button">
                        <i class="ri-upload-2-line"></i> 导入 JSON / CSV</button>
                    <button id="passwordAdd" class="password-button password-button--primary" type="button">
                        <i class="ri-add-line"></i> 新建密码</button>
                </div>
            </header>

            <section class="password-commandbar">
                <label class="password-search">
                    <i class="ri-search-line"></i>
                    <input id="passwordSearch" type="search" autocomplete="off" spellcheck="false"
                        placeholder="全局搜索；支持 #名称、#用户名、#邮箱、#手机号、#备注、#分类" aria-label="搜索密码">
                </label>
                <label class="password-clipboard-setting">复制后
                    <select id="passwordClipboardTime" aria-label="剪贴板自动清理时间">
                        <option value="15">15 秒清除</option>
                        <option value="30">30 秒清除</option>
                        <option value="60">1 分钟清除</option>
                        <option value="0">永不清除</option>
                    </select>
                </label>
                <button id="passwordTrashToggle" class="password-icon-button" type="button" aria-pressed="false" title="密码回收站">
                    <i class="ri-delete-bin-6-line"></i><span>回收站</span></button>
            </section>

            <div class="password-layout">
                <section class="password-list-card">
                    <div class="password-list-heading">
                        <div><strong id="passwordListTitle">全部密码</strong>
                            <span id="passwordSummary">正在读取…</span></div>
                        <button id="passwordEmptyTrash" class="password-link-danger" type="button" hidden>清空回收站</button>
                    </div>
                    <div id="passwordList" class="password-results" role="listbox"></div>
                </section>
                <aside class="password-guide">
                    <div class="password-guide__mark"><i class="ri-shield-check-line"></i></div>
                    <h3>快速，但不把秘密交给页面</h3>
                    <p>单击条目选中，再按 Enter 或再次点击复制。密码由原生后端直接写入剪贴板。</p>
                    <div class="password-syntax">
                        <span><code>#名称</code> GitHub</span><span><code>#用户名</code> example</span>
                        <span><code>#分类</code> 开发</span><span><code>#备注</code> 个人</span>
                    </div>
                    <div class="password-guide__note"><i class="ri-information-line"></i>
                        <span>移动到另一台电脑或重装系统后，当前密码库可能无法解密；DtKit 不会覆盖无法读取的数据。</span></div>
                </aside>
            </div>
            <p id="passwordStatus" class="password-status" aria-live="polite"></p>

            <dialog id="passwordEditor" class="password-dialog">
                <form id="passwordEditorForm" method="dialog">
                    <div class="password-dialog__header"><div><span class="password-kicker">PASSWORD ENTRY</span>
                        <h3 id="passwordEditorTitle">新建密码</h3></div>
                        <button class="password-dialog__close" value="cancel" aria-label="关闭">×</button></div>
                    <input id="passwordEntryId" type="hidden">
                    <div class="password-form-grid">
                        <label><span>名称 *</span><input id="passwordService" maxlength="200" required autocomplete="off"></label>
                        <label><span>分类</span><input id="passwordCategory" maxlength="200" autocomplete="off"></label>
                        <label><span>用户名</span><input id="passwordUsername" maxlength="500" autocomplete="off"></label>
                        <label><span>邮箱</span><input id="passwordEmail" maxlength="500" type="email" autocomplete="off"></label>
                        <label><span>手机号</span><input id="passwordPhone" maxlength="100" autocomplete="off"></label>
                        <label class="password-form-password"><span>密码 *</span><div>
                            <input id="passwordValue" maxlength="10000" type="password" required autocomplete="new-password">
                            <button id="passwordReveal" type="button" title="按住显示密码"><i class="ri-eye-line"></i></button>
                            <button id="passwordGenerate" type="button">生成</button></div></label>
                        <label class="password-form-note"><span>备注</span><textarea id="passwordNote" maxlength="10000" rows="4"></textarea></label>
                    </div>
                    <div class="password-dialog__footer">
                        <button class="password-button password-button--secondary" value="cancel">取消</button>
                        <button id="passwordEditorSave" class="password-button password-button--primary" type="submit">保存</button>
                    </div>
                </form>
            </dialog>

            <dialog id="passwordImportDialog" class="password-dialog password-dialog--import">
                <form method="dialog">
                    <div class="password-dialog__header"><div><span class="password-kicker">IMPORT PREVIEW</span>
                        <h3>确认导入</h3></div>
                        <button class="password-dialog__close" value="cancel" aria-label="关闭">×</button></div>
                    <div id="passwordImportSummary" class="password-import-summary"></div>
                    <div id="passwordImportWarnings" class="password-import-warnings"></div>
                    <label class="password-import-strategy"><span>重复条目处理</span>
                        <select id="passwordDuplicateStrategy">
                            <option value="skip">跳过重复项（推荐）</option>
                            <option value="keep">保留两者</option>
                            <option value="overwrite">用导入条目覆盖</option>
                        </select></label>
                    <div id="passwordImportItems" class="password-import-items"></div>
                    <p class="password-import-note"><i class="ri-shield-check-line"></i>
                        预览只显示名称、备注和分类；密码正文不会显示或写入日志。</p>
                    <div class="password-dialog__footer">
                        <button class="password-button password-button--secondary" value="cancel">取消</button>
                        <button id="passwordImportCommit" class="password-button password-button--primary" type="button">确认导入</button>
                    </div>
                </form>
            </dialog>

            <dialog id="passwordDeleteDialog" class="password-dialog password-dialog--danger">
                <form method="dialog">
                    <div class="password-danger-icon"><i class="ri-delete-bin-6-line"></i></div>
                    <h3 id="passwordDeleteTitle">删除密码？</h3>
                    <p id="passwordDeleteDescription">默认移入密码回收站，30 天后自动彻底删除。</p>
                    <label class="password-permanent-check"><input id="passwordPermanentDelete" type="checkbox">
                        <span><strong>彻底删除</strong><small>删除后无法恢复</small></span></label>
                    <div class="password-dialog__footer">
                        <button class="password-button password-button--secondary" value="cancel">取消</button>
                        <button id="passwordDeleteConfirm" class="password-button password-button--danger" type="button">移入回收站</button>
                    </div>
                </form>
            </dialog>
        </div>`;
}

function getTemplate() {
    return isQuickHost() ? quickTemplate() : mainTemplate();
}

function setStatus(message, type = '') {
    const status = byId('passwordStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
}

function resultNode(item) {
    const button = document.createElement('div');
    button.className = `password-result${selectedId === item.id ? ' is-selected' : ''}${item.deletedAt ? ' is-deleted' : ''}`;
    button.dataset.passwordId = item.id;
    button.setAttribute('role', 'option');
    button.tabIndex = -1;
    button.setAttribute('aria-selected', String(selectedId === item.id));
    const icon = document.createElement('span');
    icon.className = 'password-result__icon';
    icon.textContent = (item.service.trim()[0] || '?').toUpperCase();
    const text = document.createElement('span');
    text.className = 'password-result__text';
    const title = document.createElement('strong');
    title.textContent = item.service;
    const note = document.createElement('small');
    note.textContent = item.note || (isQuickHost() ? '无备注' : item.username || '未填写用户名');
    text.append(title, note);
    const category = document.createElement('span');
    category.className = 'password-result__category';
    category.textContent = item.category || '未分类';
    button.append(icon, text);
    if (!isQuickHost()) button.append(category);
    if (!isQuickHost()) {
        const actions = document.createElement('span');
        actions.className = 'password-result__actions';
        if (item.deletedAt) {
            actions.innerHTML = '<button type="button" data-password-action="restore" title="恢复"><i class="ri-arrow-go-back-line"></i></button><button type="button" data-password-action="delete" title="彻底删除"><i class="ri-delete-bin-line"></i></button>';
        } else {
            actions.innerHTML = '<button type="button" data-password-action="edit" title="编辑"><i class="ri-edit-line"></i></button><button type="button" data-password-action="delete" title="删除"><i class="ri-delete-bin-line"></i></button>';
        }
        button.append(actions);
    }
    return button;
}

function renderItems() {
    const list = byId('passwordList');
    if (!list) return;
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'password-empty';
        empty.innerHTML = isQuickHost()
            ? '<i class="ri-search-line"></i><strong>没有匹配的密码</strong><span>试试名称、备注或 #分类</span>'
            : '<i class="ri-lock-2-line"></i><strong>这里还没有密码</strong><span>导入 REPassCard JSON / CSV，或新建第一条密码。</span>';
        list.replaceChildren(empty);
    } else {
        list.replaceChildren(...items.map(resultNode));
    }
    const summary = byId('passwordSummary');
    if (summary) {
        const count = resultsTruncated ? `显示 ${items.length} / ${resultTotal} 条` : `${resultTotal} 条`;
        summary.textContent = `${count} · 单击选中，Enter 或再次点击复制`;
    }
}

async function refresh() {
    const generation = ++refreshGeneration;
    const query = byId('passwordSearch')?.value || '';
    const includeDeleted = byId('passwordTrashToggle')?.getAttribute('aria-pressed') === 'true';
    const limit = isQuickHost() ? 50 : 200;
    setStatus('正在安全读取密码索引…');
    try {
        const response = await invoke('list_passwords', { query, includeDeleted, limit });
        if (generation !== refreshGeneration) return;
        items = response.items;
        resultTotal = response.total;
        resultsTruncated = response.truncated;
        if (!items.some(item => item.id === selectedId)) selectedId = null;
        renderItems();
        setStatus(resultsTruncated
            ? `共匹配 ${resultTotal} 条，仅显示前 ${items.length} 条；继续输入可缩小范围。`
            : (items.length ? '' : (query ? '没有匹配的密码。' : '密码库为空。')));
    } catch (error) {
        if (generation !== refreshGeneration) return;
        items = [];
        resultTotal = 0;
        resultsTruncated = false;
        renderItems();
        setStatus(String(error), 'error');
    }
}

async function copySelected(id) {
    const item = items.find(candidate => candidate.id === id && !candidate.deletedAt);
    if (!item) return;
    try {
        await invoke('copy_password', { id });
        setStatus(`已复制“${item.service}”的密码；只有剪贴板仍未变化时才会按设置清除。`, 'success');
    } catch (error) {
        setStatus(String(error), 'error');
    }
}

async function handleResultClick(event) {
    const row = event.target.closest('[data-password-id]');
    if (!row) return;
    const id = row.dataset.passwordId;
    const action = event.target.closest('[data-password-action]')?.dataset.passwordAction;
    if (action === 'edit') return openEditor(id);
    if (action === 'restore') {
        try { await invoke('restore_password_entry', { id }); await refresh(); setStatus('密码已恢复。', 'success'); }
        catch (error) { setStatus(String(error), 'error'); }
        return;
    }
    if (action === 'delete') return openDeleteDialog(id);
    if (selectedId === id) return copySelected(id);
    selectedId = id;
    renderItems();
}

function generatePassword(length = 20) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    return [...bytes].map(value => alphabet[value % alphabet.length]).join('');
}

function fillEditor(entry = {}) {
    byId('passwordEntryId').value = entry.id || '';
    byId('passwordService').value = entry.service || '';
    byId('passwordCategory').value = entry.category || '';
    byId('passwordUsername').value = entry.username || '';
    byId('passwordEmail').value = entry.email || '';
    byId('passwordPhone').value = entry.phone || '';
    byId('passwordValue').value = entry.password || '';
    byId('passwordNote').value = entry.note || '';
}

async function openEditor(id = null) {
    const dialog = byId('passwordEditor');
    if (!dialog) return;
    try {
        const entry = id ? await invoke('get_password_entry_for_edit', { id }) : {};
        fillEditor(entry);
        byId('passwordEditorTitle').textContent = id ? '编辑密码' : '新建密码';
        dialog.showModal();
        byId('passwordService').focus();
    } catch (error) {
        setStatus(String(error), 'error');
    }
}

async function saveEditor(event) {
    event.preventDefault();
    const entry = {
        id: byId('passwordEntryId').value || null,
        service: byId('passwordService').value,
        category: byId('passwordCategory').value,
        username: byId('passwordUsername').value,
        email: byId('passwordEmail').value,
        phone: byId('passwordPhone').value,
        password: byId('passwordValue').value,
        note: byId('passwordNote').value
    };
    const button = byId('passwordEditorSave');
    button.disabled = true;
    try {
        await invoke('save_password_entry', { entry });
        byId('passwordEditor').close();
        fillEditor();
        await refresh();
        setStatus('密码条目已安全保存。', 'success');
    } catch (error) {
        setStatus(String(error), 'error');
    } finally {
        button.disabled = false;
    }
}

async function beginImport() {
    const path = await globalThis.window?.__TAURI__?.dialog?.open({
        multiple: false,
        directory: false,
        title: '导入 REPassCard 密码',
        filters: [{ name: 'REPassCard 导出文件', extensions: ['json', 'csv'] }]
    });
    if (!path || Array.isArray(path)) return;
    const button = byId('passwordImport');
    button.disabled = true;
    setStatus('正在原生后端解析导入文件…');
    try {
        const preview = await invoke('preview_password_import', { path });
        importToken = preview.token;
        byId('passwordImportSummary').innerHTML = `
            <div><strong>${preview.total}</strong><span>文件条目</span></div>
            <div><strong>${preview.ready}</strong><span>可导入</span></div>
            <div><strong>${preview.duplicates}</strong><span>重复项</span></div>
            <div class="${preview.invalid ? 'is-warning' : ''}"><strong>${preview.invalid}</strong><span>错误条目</span></div>`;
        const warningBox = byId('passwordImportWarnings');
        warningBox.replaceChildren(...preview.warnings.map(message => {
            const item = document.createElement('p'); item.textContent = message; return item;
        }));
        byId('passwordImportItems').replaceChildren(...preview.items.map(item => {
            const row = document.createElement('div');
            const title = document.createElement('strong'); title.textContent = item.service;
            const note = document.createElement('span'); note.textContent = item.note || item.category || '无备注';
            row.append(title, note); return row;
        }));
        byId('passwordImportDialog').showModal();
        setStatus('');
    } catch (error) {
        setStatus(String(error), 'error');
    } finally {
        button.disabled = false;
    }
}

async function commitImport() {
    if (!importToken) return;
    const button = byId('passwordImportCommit');
    button.disabled = true;
    try {
        const result = await invoke('commit_password_import', {
            token: importToken,
            strategy: byId('passwordDuplicateStrategy').value
        });
        importToken = null;
        byId('passwordImportDialog').close();
        await refresh();
        setStatus(`导入完成：新增 ${result.imported} 条，覆盖 ${result.overwritten} 条，跳过 ${result.skipped} 条。`, 'success');
    } catch (error) {
        setStatus(String(error), 'error');
    } finally {
        button.disabled = false;
    }
}

function openDeleteDialog(id) {
    const item = items.find(candidate => candidate.id === id);
    if (!item) return;
    const dialog = byId('passwordDeleteDialog');
    dialog.dataset.passwordId = id;
    byId('passwordPermanentDelete').checked = Boolean(item.deletedAt);
    byId('passwordPermanentDelete').disabled = Boolean(item.deletedAt);
    byId('passwordDeleteTitle').textContent = item.deletedAt ? `彻底删除“${item.service}”？` : `删除“${item.service}”？`;
    updateDeleteDialog();
    dialog.showModal();
}

function updateDeleteDialog() {
    const permanent = byId('passwordPermanentDelete').checked;
    byId('passwordDeleteDescription').textContent = permanent
        ? '密码将立即从加密库中移除，删除后无法恢复。'
        : '密码会进入回收站，保留 30 天后自动彻底删除。';
    byId('passwordDeleteConfirm').textContent = permanent ? '仍然彻底删除' : '移入回收站';
}

async function confirmDelete() {
    const dialog = byId('passwordDeleteDialog');
    const id = dialog.dataset.passwordId;
    const permanent = byId('passwordPermanentDelete').checked;
    try {
        await invoke('remove_password_entry', { id, permanent });
        dialog.close();
        selectedId = null;
        await refresh();
        setStatus(permanent ? '密码已彻底删除。' : '密码已移入回收站。', 'success');
    } catch (error) {
        setStatus(String(error), 'error');
    }
}

async function emptyTrash() {
    if (!confirm('确定彻底删除回收站中的全部密码吗？此操作无法恢复。')) return;
    try {
        const removed = await invoke('empty_password_trash', { confirmed: true });
        await refresh();
        setStatus(`已彻底删除 ${removed} 条密码。`, 'success');
    } catch (error) { setStatus(String(error), 'error'); }
}

async function initializePasswordVault() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    selectedId = null;
    items = [];
    resultTotal = 0;
    resultsTruncated = false;
    refreshGeneration += 1;
    if (!isQuickHost()) {
        document.getElementById('navbar')?.classList.add('navbar--local-search');
    }

    byId('passwordSearch')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 120);
    }, { signal });
    byId('passwordSearch')?.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && items.length) {
            event.preventDefault();
            const index = Math.max(-1, items.findIndex(item => item.id === selectedId));
            selectedId = items[(index + 1) % items.length].id;
            renderItems();
        } else if (event.key === 'ArrowUp' && items.length) {
            event.preventDefault();
            const index = items.findIndex(item => item.id === selectedId);
            selectedId = items[(index <= 0 ? items.length : index) - 1].id;
            renderItems();
        } else if (event.key === 'Enter' && selectedId) {
            event.preventDefault(); copySelected(selectedId);
        }
    }, { signal });
    byId('passwordList')?.addEventListener('click', handleResultClick, { signal });
    byId('passwordAdd')?.addEventListener('click', () => openEditor(), { signal });
    byId('passwordImport')?.addEventListener('click', beginImport, { signal });
    byId('passwordEditorForm')?.addEventListener('submit', saveEditor, { signal });
    byId('passwordGenerate')?.addEventListener('click', () => {
        byId('passwordValue').value = generatePassword();
    }, { signal });
    const reveal = byId('passwordReveal');
    const showPassword = () => { if (byId('passwordValue')) byId('passwordValue').type = 'text'; };
    const hidePassword = () => { if (byId('passwordValue')) byId('passwordValue').type = 'password'; };
    reveal?.addEventListener('pointerdown', showPassword, { signal });
    reveal?.addEventListener('pointerup', hidePassword, { signal });
    reveal?.addEventListener('pointerleave', hidePassword, { signal });
    reveal?.addEventListener('pointercancel', hidePassword, { signal });
    byId('passwordEditor')?.addEventListener('close', () => fillEditor(), { signal });
    byId('passwordImportDialog')?.addEventListener('close', async () => {
        if (!importToken) return;
        const token = importToken;
        importToken = null;
        try { await invoke('discard_password_import', { token }); } catch { /* secret is still dropped on app exit */ }
    }, { signal });
    byId('passwordImportCommit')?.addEventListener('click', commitImport, { signal });
    byId('passwordPermanentDelete')?.addEventListener('change', updateDeleteDialog, { signal });
    byId('passwordDeleteConfirm')?.addEventListener('click', confirmDelete, { signal });
    byId('passwordEmptyTrash')?.addEventListener('click', emptyTrash, { signal });
    byId('passwordTrashToggle')?.addEventListener('click', event => {
        const active = event.currentTarget.getAttribute('aria-pressed') !== 'true';
        event.currentTarget.setAttribute('aria-pressed', String(active));
        event.currentTarget.classList.toggle('is-active', active);
        byId('passwordListTitle').textContent = active ? '密码回收站' : '全部密码';
        byId('passwordEmptyTrash').hidden = !active;
        selectedId = null;
        refresh();
    }, { signal });
    byId('passwordClipboardTime')?.addEventListener('change', async event => {
        try {
            await invoke('set_password_settings', {
                settings: { clipboardClearSeconds: Number(event.target.value) }
            });
            setStatus(event.target.value === '0'
                ? '已关闭自动清理。密码仍不会进入 Windows 剪贴板历史。'
                : '剪贴板清理时间已更新。', 'success');
        } catch (error) { setStatus(String(error), 'error'); }
    }, { signal });

    if (!isQuickHost()) {
        try {
            const settings = await invoke('get_password_settings');
            byId('passwordClipboardTime').value = String(settings.clipboardClearSeconds);
        } catch (error) {
            setStatus(String(error), 'error');
        }
    }
    await refresh();
    byId('passwordSearch')?.focus();
}

function destroyPasswordVault() {
    controller?.abort();
    controller = null;
    clearTimeout(searchTimer);
    searchTimer = null;
    if (importToken) invoke('discard_password_import', { token: importToken }).catch(() => {});
    importToken = null;
    items = [];
    resultTotal = 0;
    resultsTruncated = false;
    refreshGeneration += 1;
    selectedId = null;
    document.getElementById('navbar')?.classList.remove('navbar--local-search');
}

registerTool({
    id: 'password-vault',
    name: '密码',
    icon: 'ri-lock-2-line',
    colorClass: 'tool-card__icon--orange',
    category: 'utility',
    status: 'ready',
    description: '由当前 Windows 用户保护的本机密码库，支持快捷搜索与安全复制。',
    template: getTemplate,
    init: initializePasswordVault,
    destroy: destroyPasswordVault
});

export { destroyPasswordVault, initializePasswordVault };
