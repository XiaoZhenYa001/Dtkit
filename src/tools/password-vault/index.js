import { registerTool } from '../toolRegistry.js';
import '../../css/tools/password-vault.css';

const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');
const words = ['amber','apple','atlas','bamboo','beacon','birch','bloom','blue','breeze','brook','cabin','cedar','charm','cloud','comet','coral','crane','dawn','delta','dream','ember','fern','field','finch','flame','forest','frost','garden','globe','grape','harbor','hazel','honey','island','jade','lake','lemon','light','lily','lotus','maple','meadow','mint','moon','nova','ocean','olive','orbit','peach','pearl','pine','pixel','plum','rain','river','rose','ruby','sage','shell','silver','sky','snow','solar','spark','spring','star','stone','sunny','tiger','trail','valley','violet','wave','willow','wind','winter','wood','zephyr'];

let controller;
let items = [];
let selectedId = null;
let detail = null;
let overview = null;
let activeView = 'all';
let activeCategory = '';
let searchTimer;
let importToken = null;
let importPreview = null;
let resultTotal = 0;
let resultsTruncated = false;
let refreshGeneration = 0;

function quickTemplate() {
    return `<div class="password-quick">
        <div class="password-quick__security"><i class="ri-shield-check-line"></i>本机加密 · 不进入剪贴板历史</div>
        <label class="password-search password-search--quick"><i class="ri-search-line"></i>
            <input id="passwordSearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索密码，或输入 #分类 开发" aria-label="搜索密码"><kbd>Esc</kbd>
        </label>
        <div id="passwordList" class="password-results password-results--quick" role="listbox"></div>
        <p id="passwordStatus" class="password-status" aria-live="polite"></p>
    </div>`;
}

function mainTemplate() {
    return `<div class="password-shell">
        <header class="password-hero">
            <div class="password-hero__identity"><span class="password-hero__icon"><i class="ri-lock-2-line"></i></span>
                <div><span class="password-kicker">LOCAL PASSWORDS</span><h2>密码</h2><p>由当前 Windows 用户保护；列表、搜索索引与安全报告都不返回密码正文。</p></div>
            </div>
            <div class="password-hero__actions">
                <button id="passwordAudit" class="password-button password-button--secondary" type="button"><i class="ri-shield-check-line"></i>安全检查</button>
                <button id="passwordImport" class="password-button password-button--secondary" type="button"><i class="ri-upload-2-line"></i>导入</button>
                <button id="passwordAdd" class="password-button password-button--primary" type="button"><i class="ri-add-line"></i>新建密码</button>
            </div>
        </header>
        <section class="password-commandbar">
            <label class="password-search"><i class="ri-search-line"></i><input id="passwordSearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索名称、账号、网址、备注；支持 #字段 内容" aria-label="搜索密码"></label>
            <label class="password-clipboard-setting">复制后<select id="passwordClipboardTime" aria-label="剪贴板自动清理时间"><option value="15">15 秒清除</option><option value="30">30 秒清除</option><option value="60">1 分钟清除</option><option value="0">永不清除</option></select></label>
        </section>
        <div class="password-workspace">
            <nav id="passwordNav" class="password-nav" aria-label="密码库分类"></nav>
            <section class="password-list-card">
                <div class="password-list-heading"><div><strong id="passwordListTitle">全部密码</strong><span id="passwordSummary">正在读取…</span></div><button id="passwordEmptyTrash" class="password-link-danger" type="button" hidden>清空回收站</button></div>
                <div id="passwordList" class="password-results" role="listbox"></div>
            </section>
            <aside id="passwordDetail" class="password-detail" aria-live="polite"></aside>
        </div>
        <p id="passwordStatus" class="password-status" aria-live="polite"></p>

        <dialog id="passwordEditor" class="password-dialog password-dialog--editor"><form id="passwordEditorForm" method="dialog">
            <div class="password-dialog__header"><div><span class="password-kicker">PASSWORD ENTRY</span><h3 id="passwordEditorTitle">新建密码</h3></div><button class="password-dialog__close" type="button" data-password-editor-cancel aria-label="关闭">×</button></div>
            <input id="passwordEntryId" type="hidden">
            <section class="password-editor-section is-primary"><div class="password-editor-section__title"><i class="ri-key-line"></i><div><strong>基础信息</strong><span>名称、分类与密码</span></div><label class="password-favorite-check"><input id="passwordFavorite" type="checkbox"><i class="ri-star-line"></i>收藏</label></div>
                <div class="password-form-grid"><label><span>名称 *</span><input id="passwordService" maxlength="200" required autocomplete="off"></label><label><span>分类</span><input id="passwordCategory" maxlength="200" autocomplete="off" list="passwordCategorySuggestions"></label>
                <label class="password-form-password"><span>密码 *</span><div><input id="passwordValue" maxlength="10000" type="password" required autocomplete="new-password"><button id="passwordReveal" type="button" title="按住显示"><i class="ri-eye-line"></i></button><button id="passwordGenerateToggle" type="button">生成器</button></div><small id="passwordStrength">尚未输入密码</small></label></div>
                <div id="passwordGenerator" class="password-generator" hidden><div class="password-generator__tabs"><button type="button" data-generator-mode="characters" class="is-active">随机字符</button><button type="button" data-generator-mode="phrase">易读短语</button></div><div class="password-generator__row"><label>长度 <input id="passwordLength" type="range" min="12" max="64" value="20"><output id="passwordLengthValue">20</output></label><label><input id="passwordUppercase" type="checkbox" checked>大写</label><label><input id="passwordNumbers" type="checkbox" checked>数字</label><label><input id="passwordSymbols" type="checkbox" checked>符号</label><label><input id="passwordAvoidAmbiguous" type="checkbox" checked>排除易混淆字符</label><button id="passwordGenerate" class="password-button password-button--primary" type="button">生成并填入</button></div></div>
            </section>
            <details class="password-editor-section" open><summary><i class="ri-user-line"></i><span><strong>身份与链接</strong><small>用户名、邮箱、手机号与网站</small></span><i class="ri-arrow-down-s-line"></i></summary><div class="password-form-grid"><label><span>用户名</span><input id="passwordUsername" maxlength="500" autocomplete="off"></label><label><span>邮箱</span><input id="passwordEmail" maxlength="500" type="email" autocomplete="off"></label><label><span>手机号</span><input id="passwordPhone" maxlength="100" autocomplete="off"></label><label><span>网站 URL</span><input id="passwordUrl" maxlength="2000" type="url" placeholder="https://" autocomplete="off"></label></div></details>
            <details class="password-editor-section"><summary><i class="ri-file-list-3-line"></i><span><strong>备注与自定义字段</strong><small>普通字段可预览，敏感字段仅按需复制</small></span><i class="ri-arrow-down-s-line"></i></summary><label class="password-form-note"><span>备注</span><textarea id="passwordNote" maxlength="10000" rows="3"></textarea></label><div class="password-custom-heading"><strong>自定义字段</strong><button id="passwordAddField" type="button"><i class="ri-add-line"></i>添加字段</button></div><div id="passwordCustomFields" class="password-custom-fields"></div></details>
            <datalist id="passwordCategorySuggestions"></datalist>
            <div class="password-dialog__footer"><button class="password-button password-button--secondary" type="button" data-password-editor-cancel>取消</button><button id="passwordEditorSave" class="password-button password-button--primary" type="submit">保存</button></div>
        </form></dialog>

        <dialog id="passwordImportDialog" class="password-dialog password-dialog--import"><form method="dialog"><div class="password-dialog__header"><div><span class="password-kicker">IMPORT REVIEW</span><h3>检查并导入密码</h3></div><button class="password-dialog__close" value="cancel" aria-label="关闭">×</button></div><div id="passwordImportSummary" class="password-import-summary"></div><div id="passwordImportWarnings" class="password-import-warnings"></div><div id="passwordImportIssues" class="password-import-issues" hidden></div><label class="password-import-strategy"><span>重复条目处理</span><select id="passwordDuplicateStrategy"><option value="skip">跳过重复项（推荐）</option><option value="keep">保留两者</option><option value="overwrite">用导入条目覆盖</option></select></label><details class="password-import-valid"><summary><span><i class="ri-checkbox-circle-line"></i>可导入条目</span><em id="passwordImportReadyCount">0 条</em></summary><div id="passwordImportItems" class="password-import-items"></div></details><p class="password-import-note"><i class="ri-shield-check-line"></i>错误详情只展示定位所需的非敏感字段；密码正文不会显示、返回页面或写入日志。</p><div class="password-dialog__footer"><button class="password-button password-button--secondary" value="cancel">取消</button><button id="passwordImportCommit" class="password-button password-button--primary" type="button">导入可用条目</button></div></form></dialog>
        <dialog id="passwordDeleteDialog" class="password-dialog password-dialog--danger"><form method="dialog"><div class="password-danger-icon"><i class="ri-delete-bin-6-line"></i></div><h3 id="passwordDeleteTitle">删除密码？</h3><p id="passwordDeleteDescription"></p><label class="password-permanent-check"><input id="passwordPermanentDelete" type="checkbox"><span><strong>彻底删除</strong><small>删除后无法恢复</small></span></label><div class="password-dialog__footer"><button class="password-button password-button--secondary" value="cancel">取消</button><button id="passwordDeleteConfirm" class="password-button password-button--danger" type="button">移入回收站</button></div></form></dialog>
        <dialog id="passwordAuditDialog" class="password-dialog password-dialog--audit"><form method="dialog"><div class="password-dialog__header"><div><span class="password-kicker">ON-DEMAND AUDIT</span><h3>密码安全检查</h3></div><button class="password-dialog__close" value="cancel" aria-label="关闭">×</button></div><div id="passwordAuditContent" class="password-audit-content"></div><p class="password-import-note"><i class="ri-shield-check-line"></i>仅在你点击检查时于本机内存中计算；不联网、不保存密码或检查结果。</p><div class="password-dialog__footer"><button class="password-button password-button--primary" value="cancel">完成</button></div></form></dialog>
    </div>`;
}

function setStatus(message, type = '') { const node = byId('passwordStatus'); if (node) { node.textContent = message; node.dataset.type = type; } }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)) : '从未'; }

function resetDialogPosition(dialog) {
    if (!dialog) return;
    dialog.style.removeProperty('--password-dialog-x');
    dialog.style.removeProperty('--password-dialog-y');
    dialog.dataset.dragX = '0';
    dialog.dataset.dragY = '0';
}

function makeDialogDraggable(dialog, signal) {
    const handle = dialog?.querySelector('.password-dialog__header');
    if (!dialog || !handle) return;
    let drag = null;
    const finish = event => {
        if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
        if (handle.hasPointerCapture?.(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
        drag = null;
        dialog.classList.remove('is-dragging');
    };
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button,input,select,textarea,a')) return;
        const rect = dialog.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: Number(dialog.dataset.dragX || 0),
            originY: Number(dialog.dataset.dragY || 0),
            rect
        };
        handle.setPointerCapture(event.pointerId);
        dialog.classList.add('is-dragging');
        event.preventDefault();
    }, { signal });
    handle.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const margin = 8;
        const rawX = event.clientX - drag.startX;
        const rawY = event.clientY - drag.startY;
        const moveX = Math.min(innerWidth - margin - drag.rect.right, Math.max(margin - drag.rect.left, rawX));
        const moveY = Math.min(innerHeight - margin - drag.rect.bottom, Math.max(margin - drag.rect.top, rawY));
        const x = drag.originX + moveX;
        const y = drag.originY + moveY;
        dialog.dataset.dragX = String(x);
        dialog.dataset.dragY = String(y);
        dialog.style.setProperty('--password-dialog-x', `${x}px`);
        dialog.style.setProperty('--password-dialog-y', `${y}px`);
    }, { signal });
    handle.addEventListener('pointerup', finish, { signal });
    handle.addEventListener('pointercancel', finish, { signal });
}

function resultNode(item) {
    const row = document.createElement('div');
    row.className = `password-result${selectedId === item.id ? ' is-selected' : ''}${item.deletedAt ? ' is-deleted' : ''}`;
    row.dataset.passwordId = item.id; row.setAttribute('role', 'option'); row.tabIndex = -1; row.setAttribute('aria-selected', String(selectedId === item.id));
    const icon = document.createElement('span'); icon.className = 'password-result__icon'; icon.textContent = (item.service.trim()[0] || '?').toUpperCase();
    const text = document.createElement('span'); text.className = 'password-result__text';
    const title = document.createElement('strong'); title.textContent = item.service;
    const note = document.createElement('small'); note.textContent = item.note || item.username || '未填写备注'; text.append(title, note);
    const meta = document.createElement('span'); meta.className = 'password-result__meta';
    if (item.favorite) { const star = document.createElement('i'); star.className = 'ri-star-fill'; meta.append(star); }
    if (!isQuickHost()) { const category = document.createElement('em'); category.textContent = item.category || '未分类'; meta.append(category); }
    row.append(icon, text, meta);
    if (!isQuickHost()) { const actions = document.createElement('span'); actions.className = 'password-result__actions'; actions.innerHTML = item.deletedAt ? '<button type="button" data-password-action="restore" title="恢复"><i class="ri-arrow-go-back-line"></i></button><button type="button" data-password-action="delete" title="彻底删除"><i class="ri-delete-bin-line"></i></button>' : '<button type="button" data-password-action="edit" title="编辑"><i class="ri-edit-line"></i></button><button type="button" data-password-action="delete" title="删除"><i class="ri-delete-bin-line"></i></button>'; row.append(actions); }
    return row;
}

function renderItems() {
    const list = byId('passwordList'); if (!list) return;
    if (items.length) list.replaceChildren(...items.map(resultNode));
    else { const empty = document.createElement('div'); empty.className = 'password-empty'; empty.innerHTML = isQuickHost() ? '<i class="ri-search-line"></i><strong>没有匹配的密码</strong><span>尝试名称、备注或 #分类</span>' : '<i class="ri-lock-2-line"></i><strong>这里还没有条目</strong><span>可以新建密码或导入 JSON / CSV。</span>'; list.replaceChildren(empty); }
    const summary = byId('passwordSummary'); if (summary) summary.textContent = resultsTruncated ? `显示 ${items.length} / ${resultTotal} 条` : `${resultTotal} 条`;
}

function navButton(view, icon, label, count, category = '') {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.passwordView = view; button.dataset.category = category;
    button.className = activeView === view && (view !== 'category' || activeCategory === category) ? 'is-active' : '';
    button.innerHTML = `<i class="${icon}"></i><span></span><em>${count}</em>`; button.querySelector('span').textContent = label; return button;
}

function renderNav() {
    const nav = byId('passwordNav'); if (!nav || !overview) return;
    const top = document.createElement('div'); top.className = 'password-nav__group';
    top.append(navButton('all', 'ri-key-line', '全部密码', overview.total), navButton('recent', 'ri-history-line', '最近使用', overview.recentCount), navButton('favorites', 'ri-star-line', '我的收藏', overview.favoriteCount));
    const categoryTitle = document.createElement('p'); categoryTitle.textContent = '分类';
    const categories = document.createElement('div'); categories.className = 'password-nav__group password-nav__categories';
    overview.categories.forEach(item => categories.append(navButton('category', 'ri-folder-line', item.name, item.count, item.name)));
    if (!overview.categories.length) { const blank = document.createElement('span'); blank.className = 'password-nav__empty'; blank.textContent = '还没有分类'; categories.append(blank); }
    const trash = navButton('trash', 'ri-delete-bin-6-line', '回收站', overview.trashCount);
    nav.replaceChildren(top, categoryTitle, categories, trash);
}

function detailField(icon, label, value, field, sensitive = false, hasValue = true, canOpen = false) {
    const row = document.createElement('div'); row.className = 'password-detail__field';
    row.innerHTML = `<i class="${icon}"></i><div><span></span><strong></strong></div>`; row.querySelector('span').textContent = label; row.querySelector('strong').textContent = sensitive ? (hasValue ? '••••••••' : '未填写') : (value || '未填写');
    if (hasValue && (value || sensitive)) { if (canOpen) { const open = document.createElement('button'); open.type = 'button'; open.dataset.openUrl = 'true'; open.title = '打开网站'; open.innerHTML = '<i class="ri-external-link-line"></i>'; row.append(open); } const copy = document.createElement('button'); copy.type = 'button'; copy.dataset.copyField = field; copy.title = `复制${label}`; copy.innerHTML = '<i class="ri-file-copy-line"></i>'; row.append(copy); }
    return row;
}

function renderDetail() {
    const panel = byId('passwordDetail'); if (!panel) return;
    if (!detail) { panel.innerHTML = '<div class="password-detail__empty"><span><i class="ri-shield-check-line"></i></span><strong>选择一条密码</strong><p>在这里查看非敏感详情，并按需复制密码。密码正文不会被提前送入页面。</p><div><kbd>Enter</kbd> 复制密码<br><kbd>Alt + Enter</kbd> 复制用户名</div></div>'; return; }
    const header = document.createElement('div'); header.className = 'password-detail__header';
    const avatar = document.createElement('span'); avatar.textContent = (detail.service.trim()[0] || '?').toUpperCase();
    const title = document.createElement('div'); const h = document.createElement('h3'); h.textContent = detail.service; const p = document.createElement('p'); p.textContent = detail.category || '未分类'; title.append(h, p);
    const star = document.createElement('button'); star.type = 'button'; star.id = 'passwordDetailFavorite'; star.className = detail.favorite ? 'is-active' : ''; star.title = detail.favorite ? '取消收藏' : '加入收藏'; star.innerHTML = `<i class="${detail.favorite ? 'ri-star-fill' : 'ri-star-line'}"></i>`; header.append(avatar, title, star);
    const primary = document.createElement('button'); primary.type = 'button'; primary.className = 'password-detail__copy-primary'; primary.dataset.copyPassword = detail.id; primary.innerHTML = '<i class="ri-file-copy-line"></i><span><strong>复制密码</strong><small>不会进入剪贴板历史</small></span>';
    const fields = document.createElement('div'); fields.className = 'password-detail__fields';
    fields.append(detailField('ri-user-line','用户名',detail.username,'username'), detailField('ri-mail-line','邮箱',detail.email,'email'), detailField('ri-phone-line','手机号',detail.phone,'phone'), detailField('ri-global-line','网站',detail.url,'url',false,true,true));
    detail.customFields.forEach(field => fields.append(detailField(field.sensitive ? 'ri-lock-line' : 'ri-price-tag-3-line', field.label || '自定义字段', field.value, `custom:${field.index}`, field.sensitive, field.hasValue)));
    const note = document.createElement('div'); note.className = 'password-detail__note'; note.innerHTML = '<span>备注</span><p></p>'; note.querySelector('p').textContent = detail.note || '暂无备注';
    const dates = document.createElement('div'); dates.className = 'password-detail__dates'; dates.textContent = `更新于 ${formatDate(detail.updatedAt)} · 最近使用 ${formatDate(detail.lastUsedAt)}`;
    const actions = document.createElement('div'); actions.className = 'password-detail__actions'; actions.innerHTML = '<button type="button" data-detail-action="edit"><i class="ri-edit-line"></i>编辑</button><button type="button" data-detail-action="delete"><i class="ri-delete-bin-line"></i>删除</button>';
    panel.replaceChildren(header, primary, fields, note, dates, actions);
}

async function loadOverview() { if (isQuickHost()) return; overview = await invoke('get_password_overview'); renderNav(); const list = byId('passwordCategorySuggestions'); if (list) list.replaceChildren(...overview.categories.map(item => { const option = document.createElement('option'); option.value = item.name; return option; })); }
async function loadDetail(id) { if (isQuickHost() || activeView === 'trash') return; try { detail = await invoke('get_password_detail', { id }); renderDetail(); } catch (error) { detail = null; renderDetail(); setStatus(String(error), 'error'); } }

async function refresh() {
    const generation = ++refreshGeneration; const query = byId('passwordSearch')?.value || ''; const includeDeleted = activeView === 'trash'; const limit = isQuickHost() ? 50 : 200;
    setStatus('正在安全读取密码索引…');
    try {
        const response = await invoke('list_passwords', { query, includeDeleted, view: isQuickHost() ? 'all' : activeView, category: activeCategory, limit });
        if (generation !== refreshGeneration) return; items = response.items; resultTotal = response.total; resultsTruncated = response.truncated;
        if (!items.some(item => item.id === selectedId)) { selectedId = null; detail = null; }
        renderItems(); renderDetail(); setStatus(resultsTruncated ? `共匹配 ${resultTotal} 条，仅显示前 ${items.length} 条；继续输入可缩小范围。` : '');
    } catch (error) { if (generation !== refreshGeneration) return; items = []; resultTotal = 0; renderItems(); setStatus(String(error), 'error'); }
}

async function copyPassword(id) { const item = items.find(entry => entry.id === id) || detail; if (!item) return; try { await invoke('copy_password', { id }); setStatus(`已复制“${item.service}”的密码；仅当剪贴板仍是这段内容时才会自动清除。`, 'success'); await loadOverview(); } catch (error) { setStatus(String(error), 'error'); } }
async function copyField(id, field) { try { await invoke('copy_password_field', { id, field }); setStatus('字段已安全复制；不会进入剪贴板历史。', 'success'); } catch (error) { setStatus(String(error), 'error'); } }

async function handleResultClick(event) {
    const row = event.target.closest('[data-password-id]'); if (!row) return; const id = row.dataset.passwordId; const action = event.target.closest('[data-password-action]')?.dataset.passwordAction;
    if (action === 'edit') return openEditor(id); if (action === 'delete') return openDeleteDialog(id);
    if (action === 'restore') { try { await invoke('restore_password_entry', { id }); await Promise.all([refresh(), loadOverview()]); setStatus('密码已恢复。','success'); } catch (error) { setStatus(String(error),'error'); } return; }
    if (selectedId === id) return copyPassword(id); selectedId = id; renderItems(); await loadDetail(id);
}

function secureIndex(max) { const ceiling = Math.floor(0x100000000 / max) * max; const value = new Uint32Array(1); do crypto.getRandomValues(value); while (value[0] >= ceiling); return value[0] % max; }
function generatePassword() {
    const mode = byId('passwordGenerator').dataset.mode || 'characters';
    if (mode === 'phrase') return Array.from({ length: 8 }, () => words[secureIndex(words.length)]).join('-');
    const length = Number(byId('passwordLength').value); const avoid = byId('passwordAvoidAmbiguous').checked;
    const groups = [avoid ? 'abcdefghijkmnopqrstuvwxyz' : 'abcdefghijklmnopqrstuvwxyz'];
    if (byId('passwordUppercase').checked) groups.push(avoid ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    if (byId('passwordNumbers').checked) groups.push(avoid ? '23456789' : '0123456789');
    if (byId('passwordSymbols').checked) groups.push('!@#$%^&*-_=+');
    const alphabet = groups.join(''); const output = groups.map(group => group[secureIndex(group.length)]);
    while (output.length < length) output.push(alphabet[secureIndex(alphabet.length)]);
    for (let index = output.length - 1; index > 0; index -= 1) { const target = secureIndex(index + 1); [output[index], output[target]] = [output[target], output[index]]; }
    return output.join('');
}
function updateStrength() { const input = byId('passwordValue'); const node = byId('passwordStrength'); if (!input || !node) return; const value = input.value; if (!value) { node.textContent = '尚未输入密码'; node.dataset.level = ''; return; } const classes = [/[a-z]/,/[A-Z]/,/\d/,/[^\w]/].filter(rule => rule.test(value)).length; const phraseWords = value.split('-').filter(Boolean).length; const score = phraseWords >= 6 || (value.length >= 16 && classes >= 3) ? 3 : value.length >= 12 && classes >= 2 ? 2 : 1; node.dataset.level = String(score); node.textContent = score === 3 ? '强度：强' : score === 2 ? '强度：中等' : '强度：较弱'; }

function customFieldNode(field = {}) { const row = document.createElement('div'); row.className = 'password-custom-field'; row.innerHTML = '<input data-field-label maxlength="100" placeholder="字段名称"><input data-field-value maxlength="10000" placeholder="字段内容"><label><input data-field-sensitive type="checkbox"><i class="ri-lock-line"></i>敏感</label><button type="button" data-remove-field title="删除字段"><i class="ri-close-line"></i></button>'; row.querySelector('[data-field-label]').value = field.label || ''; row.querySelector('[data-field-value]').value = field.value || ''; row.querySelector('[data-field-value]').type = field.sensitive ? 'password' : 'text'; row.querySelector('[data-field-sensitive]').checked = Boolean(field.sensitive); return row; }
function renderCustomFields(fields = []) { const box = byId('passwordCustomFields'); if (!box) return; box.replaceChildren(...fields.map(customFieldNode)); }
function fillEditor(entry = {}) { byId('passwordEntryId').value = entry.id || ''; byId('passwordService').value = entry.service || ''; byId('passwordCategory').value = entry.category || ''; byId('passwordUsername').value = entry.username || ''; byId('passwordEmail').value = entry.email || ''; byId('passwordPhone').value = entry.phone || ''; byId('passwordUrl').value = entry.url || ''; byId('passwordValue').value = entry.password || ''; byId('passwordNote').value = entry.note || ''; byId('passwordFavorite').checked = Boolean(entry.favorite); renderCustomFields(entry.customFields || []); updateStrength(); }
async function openEditor(id = null) { try { const entry = id ? await invoke('get_password_entry_for_edit', { id }) : {}; const editor=byId('passwordEditor'); fillEditor(entry); byId('passwordEditorTitle').textContent = id ? '编辑密码' : '新建密码'; resetDialogPosition(editor); editor.showModal(); byId('passwordService').focus(); } catch (error) { setStatus(String(error),'error'); } }
async function saveEditor(event) { event.preventDefault(); const customFields = [...byId('passwordCustomFields').children].map(row => ({ label: row.querySelector('[data-field-label]').value, value: row.querySelector('[data-field-value]').value, sensitive: row.querySelector('[data-field-sensitive]').checked })).filter(field => field.label || field.value); const entry = { id: byId('passwordEntryId').value || null, service: byId('passwordService').value, category: byId('passwordCategory').value, username: byId('passwordUsername').value, email: byId('passwordEmail').value, phone: byId('passwordPhone').value, url: byId('passwordUrl').value, password: byId('passwordValue').value, note: byId('passwordNote').value, favorite: byId('passwordFavorite').checked, customFields }; const button = byId('passwordEditorSave'); button.disabled = true; try { const saved = await invoke('save_password_entry', { entry }); byId('passwordEditor').close(); selectedId = saved.id; await Promise.all([refresh(), loadOverview()]); await loadDetail(saved.id); setStatus('密码条目已安全保存。','success'); } catch (error) { setStatus(String(error),'error'); } finally { button.disabled = false; } }

function importIssueNode(issue) {
    const card = document.createElement('article');
    card.className = 'password-import-issue';
    const header = document.createElement('header');
    const source = document.createElement('span'); source.className = 'password-import-issue__source'; source.textContent = issue.source || '未知位置';
    const title = document.createElement('strong'); title.textContent = issue.service || '未填写名称';
    const errors = document.createElement('div'); errors.className = 'password-import-issue__errors';
    (issue.errors || []).forEach(message => { const tag = document.createElement('span'); tag.textContent = message; errors.append(tag); });
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'password-import-issue__edit'; edit.dataset.importIssueEdit = issue.id || '';
    edit.textContent = issue.editable ? '修正' : '需修改源文件'; edit.disabled = !issue.editable;
    header.append(source, title, errors, edit);
    const metadata = document.createElement('dl');
    [['用户名', issue.username], ['邮箱', issue.email], ['分类', issue.category], ['备注', issue.note]].forEach(([label, value]) => {
        if (!value) return;
        const group = document.createElement('div'); const term = document.createElement('dt'); const description = document.createElement('dd');
        term.textContent = label; description.textContent = value; group.append(term, description); metadata.append(group);
    });
    if (!metadata.children.length) { const empty = document.createElement('p'); empty.textContent = '该条目没有可用于辨认的其他字段。'; metadata.append(empty); }
    card.append(header, metadata);
    if (issue.editable) {
        const form = document.createElement('form'); form.className = 'password-import-correction'; form.dataset.importIssueForm = issue.id; form.hidden = true;
        if ((issue.errors || []).includes('名称为空')) { const label=document.createElement('label'); label.innerHTML='<span>名称</span><input name="service" maxlength="200" autocomplete="off" required>'; form.append(label); }
        if ((issue.errors || []).includes('密码为空')) { const label=document.createElement('label'); label.innerHTML='<span>密码</span><input name="password" type="password" maxlength="10000" autocomplete="new-password" required>'; form.append(label); }
        const save=document.createElement('button'); save.type='submit'; save.textContent='保存修正'; form.append(save); card.append(form);
    }
    return card;
}

function renderImportPreview(preview) {
    importPreview = preview;
    byId('passwordImportSummary').innerHTML = `<div><strong>${preview.total}</strong><span>文件条目</span></div><div><strong>${preview.ready}</strong><span>可导入</span></div><div><strong>${preview.duplicates}</strong><span>重复项</span></div><div class="${preview.invalid ? 'is-warning' : ''}"><strong>${preview.invalid}</strong><span>错误条目</span></div>`;
    byId('passwordImportWarnings').replaceChildren(...(preview.warnings || []).map(message => { const p=document.createElement('p'); p.textContent=message; return p; }));
    const issuePanel = byId('passwordImportIssues'); const issues = preview.issues || [];
    issuePanel.hidden = !issues.length;
    if (issues.length) {
        const heading = document.createElement('div'); heading.className = 'password-import-issues__heading';
        const text = document.createElement('div'); text.innerHTML = '<i class="ri-error-warning-line"></i><span><strong>需要检查的条目</strong><small>可直接补全缺失字段；格式损坏的行需修改源文件。</small></span>';
        const count = document.createElement('em'); count.textContent = `${preview.invalid} 条`;
        heading.append(text, count); issuePanel.replaceChildren(heading, ...issues.map(importIssueNode));
    } else issuePanel.replaceChildren();
    byId('passwordImportReadyCount').textContent = `${preview.ready} 条`;
    byId('passwordImportItems').replaceChildren(...(preview.items || []).map(item => { const row=document.createElement('div'); const title=document.createElement('strong'); title.textContent=item.service; const note=document.createElement('span'); note.textContent=item.note||item.category||'无备注'; row.append(title,note); return row; }));
    byId('passwordImportCommit').disabled = preview.ready === 0;
}

async function correctImportIssue(form) {
    if (!importToken || !importPreview) return;
    const issueId = form.dataset.importIssueForm;
    const correction = {};
    const service = form.elements.namedItem('service');
    const password = form.elements.namedItem('password');
    if (service) correction.service = service.value;
    if (password) correction.password = password.value;
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
        const result = await invoke('update_password_import_entry', { token: importToken, issueId, correction });
        if (password) password.value = '';
        importPreview.ready = result.ready;
        importPreview.duplicates = result.duplicates;
        importPreview.invalid = result.invalid;
        const issueIndex = importPreview.issues.findIndex(issue => issue.id === issueId);
        if (issueIndex >= 0) {
            if (result.issue) importPreview.issues.splice(issueIndex, 1, result.issue);
            else importPreview.issues.splice(issueIndex, 1);
        }
        if (result.item) importPreview.items.push(result.item);
        renderImportPreview(importPreview);
    } catch (error) {
        if (password) password.value = '';
        setStatus(String(error), 'error');
        button.disabled = false;
    }
}

async function beginImport() {
    const path = await globalThis.window?.__TAURI__?.dialog?.open({ multiple:false, directory:false, title:'导入 REPassCard 密码', filters:[{ name:'REPassCard 导出文件', extensions:['json','csv'] }] });
    if (!path || Array.isArray(path)) return;
    const button = byId('passwordImport'); button.disabled = true;
    try {
        const preview = await invoke('preview_password_import',{ path });
        importToken = preview.token; importPreview = preview; renderImportPreview(preview);
        const dialog = byId('passwordImportDialog'); resetDialogPosition(dialog); dialog.showModal();
    } catch (error) { setStatus(String(error),'error'); }
    finally { button.disabled=false; }
}
async function commitImport() { if (!importToken) return; const button=byId('passwordImportCommit'); button.disabled=true; try { const result=await invoke('commit_password_import',{ token:importToken, strategy:byId('passwordDuplicateStrategy').value }); importToken=null; importPreview=null; byId('passwordImportDialog').close(); await Promise.all([refresh(),loadOverview()]); setStatus(`导入完成：新增 ${result.imported} 条，覆盖 ${result.overwritten} 条，跳过 ${result.skipped} 条。`,'success'); } catch(error){ setStatus(String(error),'error'); } finally { button.disabled=false; } }

function openDeleteDialog(id) { const item=items.find(entry=>entry.id===id)||detail; if(!item)return; const dialog=byId('passwordDeleteDialog'); dialog.dataset.passwordId=id; const deleted=Boolean(item.deletedAt||activeView==='trash'); byId('passwordPermanentDelete').checked=deleted; byId('passwordPermanentDelete').disabled=deleted; byId('passwordDeleteTitle').textContent=deleted?`彻底删除“${item.service}”？`:`删除“${item.service}”？`; updateDeleteDialog(); dialog.showModal(); }
function updateDeleteDialog(){ const permanent=byId('passwordPermanentDelete').checked; byId('passwordDeleteDescription').textContent=permanent?'密码将立即从加密库中移除，删除后无法恢复。':'密码会进入回收站，保留 30 天后自动彻底删除。'; byId('passwordDeleteConfirm').textContent=permanent?'仍然彻底删除':'移入回收站'; }
async function confirmDelete(){ const dialog=byId('passwordDeleteDialog'); try { await invoke('remove_password_entry',{ id:dialog.dataset.passwordId, permanent:byId('passwordPermanentDelete').checked }); dialog.close(); selectedId=null; detail=null; await Promise.all([refresh(),loadOverview()]); setStatus('删除操作已完成。','success'); } catch(error){ setStatus(String(error),'error'); } }
async function emptyTrash(){ if(!confirm('确定彻底删除回收站中的全部密码吗？此操作无法恢复。'))return; try { const removed=await invoke('empty_password_trash',{ confirmed:true }); await Promise.all([refresh(),loadOverview()]); setStatus(`已彻底删除 ${removed} 条密码。`,'success'); } catch(error){ setStatus(String(error),'error'); } }
async function runAudit(){ const button=byId('passwordAudit'); button.disabled=true; setStatus('正在本机内存中检查…'); try { const report=await invoke('audit_password_security'); const content=byId('passwordAuditContent'); content.innerHTML=`<div class="password-audit-grid"><div><strong>${report.total}</strong><span>有效条目</span></div><div><strong>${report.weak}</strong><span>较弱密码</span></div><div><strong>${report.reused}</strong><span>重复使用</span></div><div><strong>${report.stale}</strong><span>一年未更新</span></div><div><strong>${report.incomplete}</strong><span>缺少账号</span></div></div><div class="password-audit-list"></div>`; const labels={weak:'较弱',reused:'重复',stale:'陈旧',incomplete:'信息不完整'}; const list=content.querySelector('.password-audit-list'); report.issues.forEach(issue=>{ const row=document.createElement('button'); row.type='button'; row.dataset.auditId=issue.id; const name=document.createElement('strong'); name.textContent=issue.service; const tags=document.createElement('span'); tags.textContent=issue.kinds.map(kind=>labels[kind]).join(' · '); row.append(name,tags); list.append(row); }); if(!report.issues.length){ const p=document.createElement('p'); p.textContent='没有发现上述常见风险。'; list.append(p); } byId('passwordAuditDialog').showModal(); setStatus(''); } catch(error){ setStatus(String(error),'error'); } finally { button.disabled=false; } }

async function initializePasswordVault(){ controller?.abort(); controller=new AbortController(); const {signal}=controller; selectedId=null; detail=null; items=[]; overview=null; activeView='all'; activeCategory=''; if(!isQuickHost()) document.getElementById('navbar')?.classList.add('navbar--local-search');
    byId('passwordSearch')?.addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(refresh,120); },{signal});
    byId('passwordSearch')?.addEventListener('keydown',event=>{ if((event.key==='ArrowDown'||event.key==='ArrowUp')&&items.length){ event.preventDefault(); const current=items.findIndex(item=>item.id===selectedId); const offset=event.key==='ArrowDown'?1:-1; selectedId=items[(current+offset+items.length)%items.length].id; renderItems(); loadDetail(selectedId); } else if(event.key==='Enter'&&selectedId){ event.preventDefault(); if(event.altKey) copyField(selectedId,'username'); else copyPassword(selectedId); } },{signal});
    byId('passwordList')?.addEventListener('click',handleResultClick,{signal});
    byId('passwordNav')?.addEventListener('click',event=>{ const button=event.target.closest('[data-password-view]'); if(!button)return; activeView=button.dataset.passwordView; activeCategory=button.dataset.category||''; selectedId=null; detail=null; byId('passwordListTitle').textContent=activeView==='all'?'全部密码':activeView==='recent'?'最近使用':activeView==='favorites'?'我的收藏':activeView==='trash'?'回收站':activeCategory; byId('passwordEmptyTrash').hidden=activeView!=='trash'; renderNav(); refresh(); },{signal});
    byId('passwordDetail')?.addEventListener('click',async event=>{ const copy=event.target.closest('[data-copy-field]'); if(copy)return copyField(detail.id,copy.dataset.copyField); if(event.target.closest('[data-open-url]')){ try{await invoke('open_password_url',{id:detail.id});}catch(error){setStatus(String(error),'error');} return; } if(event.target.closest('[data-copy-password]'))return copyPassword(detail.id); if(event.target.closest('#passwordDetailFavorite')){ await invoke('set_password_favorite',{id:detail.id,favorite:!detail.favorite}); await Promise.all([loadDetail(detail.id),loadOverview(),refresh()]); return; } const action=event.target.closest('[data-detail-action]')?.dataset.detailAction; if(action==='edit')openEditor(detail.id); if(action==='delete')openDeleteDialog(detail.id); },{signal});
    byId('passwordAdd')?.addEventListener('click',()=>openEditor(),{signal}); byId('passwordImport')?.addEventListener('click',beginImport,{signal}); byId('passwordAudit')?.addEventListener('click',runAudit,{signal}); byId('passwordEditorForm')?.addEventListener('submit',saveEditor,{signal});
    byId('passwordGenerateToggle')?.addEventListener('click',()=>{ byId('passwordGenerator').hidden=!byId('passwordGenerator').hidden; },{signal}); byId('passwordGenerate')?.addEventListener('click',()=>{ byId('passwordValue').value=generatePassword(); updateStrength(); },{signal}); byId('passwordLength')?.addEventListener('input',event=>{ byId('passwordLengthValue').value=event.target.value; },{signal}); byId('passwordGenerator')?.addEventListener('click',event=>{ const button=event.target.closest('[data-generator-mode]'); if(!button)return; byId('passwordGenerator').dataset.mode=button.dataset.generatorMode; byId('passwordGenerator').querySelectorAll('[data-generator-mode]').forEach(item=>item.classList.toggle('is-active',item===button)); byId('passwordLength').closest('label').hidden=button.dataset.generatorMode==='phrase'; },{signal}); byId('passwordValue')?.addEventListener('input',updateStrength,{signal});
    const reveal=byId('passwordReveal'); const show=()=>{byId('passwordValue').type='text';}; const hide=()=>{byId('passwordValue').type='password';}; reveal?.addEventListener('pointerdown',show,{signal}); ['pointerup','pointerleave','pointercancel'].forEach(name=>reveal?.addEventListener(name,hide,{signal}));
    byId('passwordAddField')?.addEventListener('click',()=>byId('passwordCustomFields').append(customFieldNode()),{signal}); byId('passwordCustomFields')?.addEventListener('click',event=>event.target.closest('[data-remove-field]')?.closest('.password-custom-field')?.remove(),{signal}); byId('passwordCustomFields')?.addEventListener('change',event=>{ if(event.target.matches('[data-field-sensitive]')) event.target.closest('.password-custom-field').querySelector('[data-field-value]').type=event.target.checked?'password':'text'; },{signal});
    const editor=byId('passwordEditor'); makeDialogDraggable(editor,signal); editor?.querySelectorAll('[data-password-editor-cancel]').forEach(button=>button.addEventListener('click',()=>editor.close('cancel'),{signal})); editor?.addEventListener('close',()=>{ resetDialogPosition(editor); fillEditor(); },{signal}); window.addEventListener('resize',()=>resetDialogPosition(editor),{signal}); byId('passwordImportDialog')?.addEventListener('close',async()=>{ importPreview=null; if(!importToken)return; const token=importToken; importToken=null; try{await invoke('discard_password_import',{token});}catch{} },{signal}); byId('passwordImportIssues')?.addEventListener('click',event=>{ const button=event.target.closest('[data-import-issue-edit]'); if(!button)return; const form=button.closest('.password-import-issue')?.querySelector('[data-import-issue-form]'); if(!form)return; form.hidden=!form.hidden; if(!form.hidden)form.querySelector('input')?.focus(); },{signal}); byId('passwordImportIssues')?.addEventListener('submit',event=>{ const form=event.target.closest('[data-import-issue-form]'); if(!form)return; event.preventDefault(); correctImportIssue(form); },{signal}); byId('passwordImportCommit')?.addEventListener('click',commitImport,{signal}); byId('passwordPermanentDelete')?.addEventListener('change',updateDeleteDialog,{signal}); byId('passwordDeleteConfirm')?.addEventListener('click',confirmDelete,{signal}); byId('passwordEmptyTrash')?.addEventListener('click',emptyTrash,{signal}); byId('passwordAuditContent')?.addEventListener('click',event=>{ const row=event.target.closest('[data-audit-id]'); if(!row)return; byId('passwordAuditDialog').close(); selectedId=row.dataset.auditId; activeView='all'; activeCategory=''; byId('passwordSearch').value=''; renderNav(); refresh().then(()=>loadDetail(selectedId)); },{signal});
    byId('passwordClipboardTime')?.addEventListener('change',async event=>{ try{await invoke('set_password_settings',{settings:{clipboardClearSeconds:Number(event.target.value)}});setStatus('剪贴板清理时间已更新。','success');}catch(error){setStatus(String(error),'error');} },{signal});
    if(!isQuickHost()){ try{ const [settings]=await Promise.all([invoke('get_password_settings'),loadOverview()]); byId('passwordClipboardTime').value=String(settings.clipboardClearSeconds); }catch(error){setStatus(String(error),'error');} renderDetail(); }
    await refresh(); byId('passwordSearch')?.focus();
}

function destroyPasswordVault(){ controller?.abort(); controller=null; clearTimeout(searchTimer); searchTimer=null; if(importToken)invoke('discard_password_import',{token:importToken}).catch(()=>{}); importToken=null; importPreview=null; items=[]; detail=null; overview=null; refreshGeneration+=1; selectedId=null; document.getElementById('navbar')?.classList.remove('navbar--local-search'); }

registerTool({ id:'password-vault', name:'密码', icon:'ri-lock-2-line', colorClass:'tool-card__icon--orange', category:'utility', status:'ready', description:'由当前 Windows 用户保护的本机密码库，支持快捷搜索与安全复制。', template:isQuickHost()?quickTemplate:mainTemplate, init:initializePasswordVault, destroy:destroyPasswordVault });
export { destroyPasswordVault, initializePasswordVault };
