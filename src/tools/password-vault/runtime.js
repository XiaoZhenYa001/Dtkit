const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);
const isQuickHost = () => location.pathname.toLowerCase().endsWith('/quick.html');
const words = 'amber apple atlas bamboo beacon birch bloom blue breeze brook cabin cedar charm cloud comet coral crane dawn delta dream ember fern field finch flame forest frost garden globe grape harbor hazel honey island jade lake lemon light lily lotus maple meadow mint moon nova ocean olive orbit peach pearl pine pixel plum rain river rose ruby sage shell silver sky snow solar spark spring star stone sunny tiger trail valley violet wave willow wind winter wood zephyr'.split(' ');
const PAGE_SIZE = 100;
let controller = null, unlisten = null, unlistenSettings = null, items = [], selectedId = null, detail = null, overview = null;
let activeView = 'all', activeCategory = '', offset = 0, resultTotal = 0, resultsTruncated = false;
let searchTimer = null, changeTimer = null, refreshGeneration = 0, detailGeneration = 0;
let importToken = null, importPreview = null, mutationBusy = false, clipboardSeconds = 30;
const importDecisions = new Map();
const live = signal => signal && !signal.aborted;
const currentSignal = () => controller?.signal;
const pageSize = () => isQuickHost() ? 50 : PAGE_SIZE;
const listen = (node, event, handler) => node?.addEventListener(event, handler, { signal: currentSignal() });

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}
function setStatus(message, type = '') {
    const element = byId('passwordStatus');
    if (element) { element.textContent = message; element.dataset.type = type; }
}
function inlineStatus(id, message = '') {
    const element = byId(id); if (element) { element.textContent = message; element.hidden = !message; }
}
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)) : '从未'; }
function iconButton(icon, label, action, value) {
    const button = node('button', 'password-icon-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    if (action) button.dataset[action] = value;
    button.append(node('i', icon)); return button;
}
function resetDialogPosition(dialog) {
    dialog?.style.removeProperty('--password-dialog-x'); dialog?.style.removeProperty('--password-dialog-y');
    if (dialog) { dialog.dataset.dragX = '0'; dialog.dataset.dragY = '0'; }
}
function makeDialogDraggable(dialog) {
    const handle = dialog.querySelector('.password-dialog__header'); if (!handle) return;
    let drag = null;
    const finish = () => { drag = null; dialog.classList.remove('is-dragging'); };
    listen(handle, 'pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button,input,select,textarea,a')) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: Number(dialog.dataset.dragX || 0), oy: Number(dialog.dataset.dragY || 0), rect: dialog.getBoundingClientRect() };
        handle.setPointerCapture(event.pointerId); dialog.classList.add('is-dragging'); event.preventDefault();
    });
    listen(handle, 'pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = Math.min(innerWidth - 8 - drag.rect.right, Math.max(8 - drag.rect.left, event.clientX - drag.x));
        const dy = Math.min(innerHeight - 8 - drag.rect.bottom, Math.max(8 - drag.rect.top, event.clientY - drag.y));
        dialog.dataset.dragX = String(drag.ox + dx); dialog.dataset.dragY = String(drag.oy + dy);
        dialog.style.setProperty('--password-dialog-x', `${drag.ox + dx}px`); dialog.style.setProperty('--password-dialog-y', `${drag.oy + dy}px`);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(handle, event, finish);
}
function showDialog(id) { const dialog = byId(id); resetDialogPosition(dialog); if (!dialog.open) dialog.showModal(); }
function closeDetail() { byId('passwordDetail')?.classList.remove('is-open'); if (byId('passwordDetailBackdrop')) byId('passwordDetailBackdrop').hidden = true; }
function showDetail() { if (!isQuickHost() && matchMedia('(max-width:1080px)').matches) { byId('passwordDetail').classList.add('is-open'); byId('passwordDetailBackdrop').hidden = false; } }

function resultNode(item) {
    const row = node('div', `password-result${selectedId === item.id ? ' is-selected' : ''}${item.deletedAt ? ' is-deleted' : ''}`);
    row.id = `password-option-${item.id}`; row.dataset.passwordId = item.id; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selectedId === item.id));
    const text = node('span', 'password-result__text');
    text.append(node('strong', '', item.service), node('small', '', isQuickHost() ? item.note || '暂无备注' : item.note || item.username || '暂无备注'));
    const meta = node('span', 'password-result__meta'); if (item.favorite) meta.append(node('i', 'ri-star-fill'));
    if (!isQuickHost()) meta.append(node('em', '', item.category || '未分类'));
    row.append(node('span', 'password-result__icon', (item.service.trim()[0] || '?').toUpperCase()), text, meta);
    if (!isQuickHost()) {
        const actions = node('span', 'password-result__actions');
        actions.append(iconButton(item.deletedAt ? 'ri-arrow-go-back-line' : 'ri-edit-line', item.deletedAt ? '恢复' : '编辑', 'passwordAction', item.deletedAt ? 'restore' : 'edit'), iconButton('ri-delete-bin-line', item.deletedAt ? '彻底删除' : '移入回收站', 'passwordAction', 'delete')); row.append(actions);
    }
    return row;
}
function renderItems() {
    const list = byId('passwordList'); if (!list) return;
    if (items.length) list.replaceChildren(...items.map(resultNode));
    else {
        const searching = Boolean(byId('passwordSearch')?.value.trim()); const empty = node('div', 'password-empty');
        empty.append(node('i', searching ? 'ri-search-line' : 'ri-lock-2-line'), node('strong', '', searching ? '没有匹配的密码' : activeView === 'trash' ? '回收站是空的' : activeView === 'favorites' ? '还没有收藏的密码' : '这里还没有条目'), node('span', '', searching ? '尝试其他关键词，或使用 #字段 搜索。' : activeView === 'trash' ? '删除的密码在这里保留 30 天。' : '可以新建密码或导入 JSON / CSV。')); list.replaceChildren(empty);
    }
    if (byId('passwordSummary')) byId('passwordSummary').textContent = `${resultTotal} 条`;
    if (byId('passwordPagination')) {
        byId('passwordPagination').hidden = resultTotal <= pageSize(); byId('passwordPageLabel').textContent = `${Math.floor(offset / pageSize()) + 1} / ${Math.max(1, Math.ceil(resultTotal / pageSize()))} 页`;
        byId('passwordPagePrev').disabled = offset === 0; byId('passwordPageNext').disabled = !resultsTruncated;
    }
    list.setAttribute('aria-activedescendant', selectedId ? `password-option-${selectedId}` : '');
    byId('passwordSearch')?.setAttribute('aria-activedescendant', selectedId ? `password-option-${selectedId}` : '');
}
function navButton(view, icon, label, count, category = '') {
    const button = node('button', activeView === view && (view !== 'category' || category === activeCategory) ? 'is-active' : '');
    button.type = 'button'; button.dataset.passwordView = view; button.dataset.category = category; button.setAttribute('aria-current', button.className ? 'page' : 'false');
    button.append(node('i', icon), node('span', '', label), node('em', '', count || 0)); return button;
}
function renderNav() {
    const nav = byId('passwordNav'); if (!nav || !overview) return;
    const top = node('div', 'password-nav__group');
    top.append(navButton('all', 'ri-key-line', '全部密码', overview.total), navButton('recent', 'ri-history-line', '最近使用', overview.recentCount), navButton('favorites', 'ri-star-line', '我的收藏', overview.favoriteCount));
    const categories = node('div', 'password-nav__group password-nav__categories'); categories.append(navButton('uncategorized', 'ri-folder-line', '未分类', overview.uncategorizedCount));
    for (const category of overview.categories) categories.append(navButton('category', 'ri-folder-line', category.name, category.count, category.name));
    const footer = node('div', 'password-nav__footer'); footer.append(navButton('trash', 'ri-delete-bin-6-line', '回收站', overview.trashCount), node('small', '', '当前 Windows 用户保护'));
    nav.replaceChildren(top, node('p', '', '分类'), categories, footer);
    byId('passwordListTitle').textContent = ({ all: '全部密码', recent: '最近使用', favorites: '我的收藏', trash: '回收站', uncategorized: '未分类' })[activeView] || activeCategory;
    byId('passwordEmptyTrash').hidden = activeView !== 'trash'; byId('passwordEmptyTrash').disabled = !overview.trashCount; byId('passwordTrashHint').hidden = activeView !== 'trash';
}
function detailField(icon, label, value, field, sensitive = false, hasValue = true, canOpen = false) {
    const row = node('div', 'password-detail__field'); const text = node('div');
    const content = node('strong', '', sensitive ? (hasValue ? '••••••••' : '未填写') : value || '未填写'); if (!sensitive) content.title = value || '';
    text.append(node('span', '', label), content); row.append(node('i', icon), text);
    if (hasValue && (value || sensitive)) { if (canOpen) row.append(iconButton('ri-external-link-line', '打开网站', 'openUrl', 'true')); row.append(iconButton('ri-file-copy-line', `复制${label}`, 'copyField', field)); } return row;
}
function renderDetail(loading = false) {
    const panel = byId('passwordDetail'); if (!panel) return;
    const close = iconButton('ri-close-line', '收起详情', 'closeDetail', 'true'); close.classList.add('password-detail__close');
    if (!detail) {
        const empty = node('div', 'password-detail__empty'); empty.append(node('i', 'ri-shield-check-line'), node('strong', '', loading ? '正在读取详情…' : activeView === 'trash' ? '条目可以恢复' : '选择一条密码'), node('p', '', activeView === 'trash' ? '使用条目右侧的恢复按钮。彻底删除后无法恢复。' : '查看账号信息，按需复制密码。'), node('small', '', 'Enter 复制密码 · Alt + Enter 复制用户名')); panel.replaceChildren(close, empty); return;
    }
    const header = node('div', 'password-detail__header'); const title = node('div'); title.append(node('h3', '', detail.service), node('p', '', detail.category || '未分类'));
    const star = iconButton(detail.favorite ? 'ri-star-fill' : 'ri-star-line', detail.favorite ? '取消收藏' : '加入收藏', 'favoriteDetail', detail.id); star.classList.toggle('is-active', detail.favorite);
    header.append(node('span', 'password-detail__avatar', (detail.service.trim()[0] || '?').toUpperCase()), title, star);
    const copy = node('button', 'password-detail__copy-primary'); copy.type = 'button'; copy.dataset.copyPassword = detail.id;
    const copyText = node('span'); copyText.append(node('strong', '', '复制密码'), node('small', '', clipboardSeconds ? `${clipboardSeconds} 秒后条件清除` : '自动清除已关闭')); copy.append(node('i', 'ri-file-copy-line'), copyText);
    const fields = node('div', 'password-detail__fields');
    fields.append(detailField('ri-user-line', '用户名', detail.username, 'username'), detailField('ri-mail-line', '邮箱', detail.email, 'email'), detailField('ri-phone-line', '手机号', detail.phone, 'phone'), detailField('ri-global-line', '网站', detail.url, 'url', false, true, true));
    for (const field of detail.customFields || []) fields.append(detailField(field.sensitive ? 'ri-lock-line' : 'ri-price-tag-3-line', field.label || '自定义字段', field.value, `custom:${field.index}`, field.sensitive, field.hasValue));
    const note = node('div', 'password-detail__note'); note.append(node('span', '', '备注'), node('p', '', detail.note || '暂无备注'));
    const dates = node('div', 'password-detail__dates'); dates.append(node('span', '', `创建于 ${formatDate(detail.createdAt)}`), node('span', '', `更新于 ${formatDate(detail.updatedAt)}`), node('span', '', `最近使用 ${formatDate(detail.lastUsedAt)} · 已使用 ${detail.useCount || 0} 次`));
    const actions = node('div', 'password-detail__actions'); for (const [action, label, icon] of [['edit', '编辑', 'ri-edit-line'], ['delete', '删除', 'ri-delete-bin-line']]) { const button = node('button'); button.type = 'button'; button.dataset.detailAction = action; button.append(node('i', icon), document.createTextNode(label)); actions.append(button); }
    panel.replaceChildren(close, header, copy, fields, note, dates, actions);
}
async function loadOverview() {
    if (isQuickHost()) return;
    const signal = currentSignal(); const next = await invoke('get_password_overview'); if (!live(signal)) return; overview = next; renderNav();
    byId('passwordCategorySuggestions')?.replaceChildren(...next.categories.map(category => { const option = node('option'); option.value = category.name; return option; }));
}
async function loadDetail(id) {
    if (isQuickHost() || activeView === 'trash') return;
    const generation = ++detailGeneration, signal = currentSignal(); detail = null; renderDetail(true);
    try { const next = await invoke('get_password_detail', { id }); if (!live(signal) || generation !== detailGeneration || selectedId !== id) return; detail = next; renderDetail(); }
    catch (error) { if (!live(signal) || generation !== detailGeneration) return; detail = null; renderDetail(); setStatus(String(error), 'error'); }
}
async function refresh({ reset = false, quiet = false } = {}) {
    if (reset) offset = 0; const signal = currentSignal(), generation = ++refreshGeneration; const list = byId('passwordList'); list?.setAttribute('aria-busy', 'true'); if (!quiet) setStatus('正在读取…');
    try {
        const response = await invoke('list_passwords', { query: byId('passwordSearch')?.value || '', includeDeleted: activeView === 'trash', view: isQuickHost() ? 'all' : activeView, category: activeCategory, limit: pageSize(), offset, sort: byId('passwordSort')?.value || 'recent' });
        if (!live(signal) || generation !== refreshGeneration) return;
        items = response.items; resultTotal = response.total; resultsTruncated = response.truncated; offset = response.offset ?? offset;
        if (!items.some(item => item.id === selectedId)) { selectedId = null; detail = null; detailGeneration++; closeDetail(); }
        renderItems(); renderDetail(); if (!quiet) setStatus('');
        if (selectedId && !detail && activeView !== 'trash') await loadDetail(selectedId);
    } catch (error) { if (!live(signal) || generation !== refreshGeneration) return; items = []; resultTotal = 0; selectedId = null; detail = null; renderItems(); renderDetail(); setStatus(`读取失败：${error}`, 'error'); }
    finally { if (live(signal) && generation === refreshGeneration) list?.removeAttribute('aria-busy'); }
}
async function reload() { await Promise.all([refresh({ quiet: true }), loadOverview()]); }
async function copyPassword(id) {
    const item = items.find(entry => entry.id === id) || detail; if (!item || activeView === 'trash') return; const signal = currentSignal();
    try { await invoke('copy_password', { id }); if (!live(signal)) return; setStatus(`已复制“${item.service}”${clipboardSeconds ? `；${clipboardSeconds} 秒后仅清除仍属于这次复制的内容。` : '；自动清除已关闭。'}`, 'success'); await loadOverview(); }
    catch (error) { if (live(signal)) setStatus(`复制失败：${error}`, 'error'); }
}
async function copyField(id, field) { const signal = currentSignal(); try { await invoke('copy_password_field', { id, field }); if (live(signal)) setStatus('已复制字段。敏感字段按当前策略条件清除。', 'success'); } catch (error) { if (live(signal)) setStatus(String(error), 'error'); } }
async function selectItem(id, show = false) { selectedId = id; renderItems(); if (show) showDetail(); await loadDetail(id); }
async function handleResultClick(event) {
    const row = event.target.closest('[data-password-id]'); if (!row) return; const id = row.dataset.passwordId, action = event.target.closest('[data-password-action]')?.dataset.passwordAction;
    if (action === 'edit') return openEditor(id); if (action === 'delete') return openDeleteDialog(id); if (action === 'restore') return restoreEntry(id);
    if (activeView === 'trash') { selectedId = id; renderItems(); renderDetail(); return; }
    if (selectedId === id) return copyPassword(id); await selectItem(id, true);
}
function handleKeyboard(event) {
    if (document.querySelector('dialog[open]')) return;
    const editable = event.target.closest('input,textarea,select,[contenteditable="true"]'); if (editable && editable.id !== 'passwordSearch') return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) {
        event.preventDefault(); const current = items.findIndex(item => item.id === selectedId); const index = current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        selectItem(items[index].id); byId(`password-option-${items[index].id}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && items.length && activeView !== 'trash') { event.preventDefault(); const id = selectedId || items[0].id; if (event.altKey) copyField(id, 'username'); else copyPassword(id); }
    else if (event.key === 'Escape' && byId('passwordDetail')?.classList.contains('is-open')) { event.preventDefault(); event.stopPropagation(); closeDetail(); }
}

function secureIndex(max) { const ceiling = Math.floor(0x100000000 / max) * max, value = new Uint32Array(1); do crypto.getRandomValues(value); while (value[0] >= ceiling); return value[0] % max; }
function generatePassword() {
    if (byId('passwordGenerator').dataset.mode === 'phrase') return Array.from({ length: 12 }, () => words[secureIndex(words.length)]).join('-');
    const avoid = byId('passwordAvoidAmbiguous').checked, groups = [avoid ? 'abcdefghijkmnopqrstuvwxyz' : 'abcdefghijklmnopqrstuvwxyz'];
    if (byId('passwordUppercase').checked) groups.push(avoid ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'); if (byId('passwordNumbers').checked) groups.push(avoid ? '23456789' : '0123456789'); if (byId('passwordSymbols').checked) groups.push('!@#$%^&*-_=+');
    const alphabet = groups.join(''), output = groups.map(group => group[secureIndex(group.length)]); while (output.length < Number(byId('passwordLength').value)) output.push(alphabet[secureIndex(alphabet.length)]);
    for (let index = output.length - 1; index > 0; index--) { const other = secureIndex(index + 1); [output[index], output[other]] = [output[other], output[index]]; } return output.join('');
}
function updateStrength() {
    const value = byId('passwordValue').value, label = byId('passwordStrength'); if (!value) { label.textContent = '尚未输入密码'; label.dataset.level = ''; return; }
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter(rule => rule.test(value)).length; const score = value.length >= 20 && new Set(value).size >= 10 ? 3 : value.length >= 12 && classes >= 2 && new Set(value).size >= 6 ? 2 : 1;
    label.dataset.level = String(score); label.textContent = `粗略强度：${['', '较弱', '中等', '较强'][score]}`;
}
function customFieldNode(field = {}) {
    const row = node('div', 'password-custom-field'); row.innerHTML = '<input data-field-label maxlength="100" placeholder="字段名称" aria-label="字段名称"><input data-field-value maxlength="10000" placeholder="字段内容" autocomplete="off" aria-label="字段内容"><label><input data-field-sensitive type="checkbox"><i class="ri-lock-line"></i>敏感</label><button type="button" data-remove-field aria-label="删除字段"><i class="ri-close-line"></i></button>';
    row.querySelector('[data-field-label]').value = field.label || ''; row.querySelector('[data-field-value]').value = field.value || ''; row.querySelector('[data-field-sensitive]').checked = Boolean(field.sensitive); row.querySelector('[data-field-value]').type = field.sensitive ? 'password' : 'text'; return row;
}
function updateFieldCount() { const count = byId('passwordCustomFields').children.length; byId('passwordFieldCount').textContent = `${count} / 20`; byId('passwordAddField').disabled = count >= 20; }
function fillEditor(entry = {}) {
    for (const [id, key] of Object.entries({ passwordEntryId: 'id', passwordService: 'service', passwordCategory: 'category', passwordUsername: 'username', passwordEmail: 'email', passwordPhone: 'phone', passwordUrl: 'url', passwordValue: 'password', passwordNote: 'note' })) byId(id).value = entry[key] || '';
    byId('passwordFavorite').checked = Boolean(entry.favorite); byId('passwordValue').type = 'password'; byId('passwordCustomFields').replaceChildren(...(entry.customFields || []).map(customFieldNode)); updateFieldCount(); updateStrength();
    byId('passwordGenerator').hidden = true; byId('passwordGenerateToggle').setAttribute('aria-expanded', 'false'); inlineStatus('passwordEditorStatus');
}
async function openEditor(id = null) {
    const signal = currentSignal(); try { const entry = id ? await invoke('get_password_entry_for_edit', { id }) : {}; if (!live(signal)) { entry.password = ''; return; }
        fillEditor(entry); byId('passwordEditorTitle').textContent = id ? '编辑密码' : '新建密码'; showDialog('passwordEditor'); byId('passwordService').focus(); entry.password = ''; for (const field of entry.customFields || []) if (field.sensitive) field.value = '';
    } catch (error) { if (live(signal)) setStatus(String(error), 'error'); }
}
async function saveEditor(event) {
    event.preventDefault(); if (mutationBusy) return; const signal = currentSignal(), button = byId('passwordEditorSave'); button.disabled = true; mutationBusy = true;
    const customFields = [...byId('passwordCustomFields').children].map(row => ({ label: row.querySelector('[data-field-label]').value, value: row.querySelector('[data-field-value]').value, sensitive: row.querySelector('[data-field-sensitive]').checked })).filter(field => field.label || field.value);
    const entry = { id: byId('passwordEntryId').value || null, service: byId('passwordService').value, category: byId('passwordCategory').value, username: byId('passwordUsername').value, email: byId('passwordEmail').value, phone: byId('passwordPhone').value, url: byId('passwordUrl').value, password: byId('passwordValue').value, note: byId('passwordNote').value, favorite: byId('passwordFavorite').checked, customFields };
    try { const saved = await invoke('save_password_entry', { entry }); if (!live(signal)) return; byId('passwordEditor').close(); activeView = 'all'; activeCategory = ''; byId('passwordSearch').value = ''; byId('passwordSort').value = 'updated'; offset = 0; selectedId = saved.id; detail = null; await reload(); await loadDetail(saved.id); setStatus('密码条目已保存。', 'success'); }
    catch (error) { if (live(signal)) inlineStatus('passwordEditorStatus', String(error)); }
    finally { entry.password = ''; for (const field of customFields) if (field.sensitive) field.value = ''; mutationBusy = false; if (live(signal)) button.disabled = false; }
}

const correctionFields = [['service', '名称', 200], ['username', '用户名', 500], ['email', '邮箱', 500], ['phone', '手机号', 100], ['note', '备注', 10000], ['category', '分类', 200], ['url', '网址', 2000], ['password', '密码', 10000]];
function importIssueNode(issue) {
    const card = node('article', 'password-import-issue'), header = node('header'), errors = node('div', 'password-import-issue__errors'); for (const error of issue.errors || []) errors.append(node('span', '', error));
    const edit = node('button', 'password-import-issue__edit', issue.editable ? '修正' : '修改源文件'); edit.type = 'button'; edit.dataset.importIssueEdit = issue.id; edit.disabled = !issue.editable;
    header.append(node('span', 'password-import-issue__source', issue.source || '未知位置'), node('strong', '', issue.service || '未填写名称'), errors, edit);
    const metadata = node('dl'); for (const [label, value] of [['用户名', issue.username], ['邮箱', issue.email], ['分类', issue.category], ['备注', issue.note]]) { if (!value) continue; const group = node('div'); group.append(node('dt', '', label), node('dd', '', value)); metadata.append(group); } card.append(header, metadata);
    if (issue.editable) {
        const form = node('form', 'password-import-correction'); form.dataset.importIssueForm = issue.id; form.hidden = true;
        for (const [key, label, maximum] of correctionFields) { if (!(issue.errors || []).some(error => error.startsWith(label))) continue; const wrapper = node('label'), input = node('input'); input.name = key; input.maxLength = maximum; input.type = key === 'password' ? 'password' : 'text'; input.autocomplete = key === 'password' ? 'new-password' : 'off'; input.required = key === 'service' || key === 'password'; if (key !== 'password') input.value = issue[key] || ''; wrapper.append(node('span', '', label), input); form.append(wrapper); }
        if (form.children.length) { const save = node('button', 'password-button password-button--primary', '保存修正'); save.type = 'submit'; form.append(save); card.append(form); } else edit.disabled = true;
    } return card;
}
function updateImportOutcome() { if (importPreview) byId('passwordImportOutcome').textContent = `${importPreview.ready} 条可用${importPreview.invalid ? ` · ${importPreview.invalid} 条错误将跳过` : ''}${byId('passwordDuplicateStrategy').value === 'overwrite' && importPreview.duplicates ? ' · 将覆盖重复条目' : ''}`; }
function renderImportPreview(preview) {
    importPreview = preview;
    byId('passwordImportSummary').replaceChildren(...[[preview.total, '文件条目'], [preview.ready, '可导入'], [preview.duplicates, '重复'], [preview.invalid, '需修正']].map(([count, label]) => { const card = node('div'); card.append(node('strong', '', count), node('span', '', label)); return card; }));
    byId('passwordImportWarnings').replaceChildren(...(preview.warnings || []).map(message => node('p', '', message)));
    const issues = preview.issues || [], panel = byId('passwordImportIssues'); panel.hidden = !issues.length; const heading = node('div', 'password-import-issues__heading'); heading.append(node('strong', '', '需要检查的条目'), node('small', '', `${preview.invalid} 条 · 展开即可补全`)); panel.replaceChildren(heading, ...issues.map(importIssueNode));
    byId('passwordImportReadyCount').textContent = `${preview.ready} 条`; byId('passwordImportItems').replaceChildren(...(preview.items || []).slice(0, 100).map(item => { const row = node('div'), text = node('span'); text.append(node('strong', '', item.service), node('small', '', item.username || item.note || item.category || '无备注')); row.append(text); return row; }));
    if (preview.ready > (preview.items || []).length) byId('passwordImportItems').append(node('p', 'password-import-preview-limit', `预览前 ${preview.items.length} 条，导入将处理全部 ${preview.ready} 条。`));
    const conflicts = preview.conflicts || []; byId('passwordImportConflicts').hidden = !conflicts.length; byId('passwordConflictCount').textContent = `${preview.duplicates} 条`;
    byId('passwordConflictItems').replaceChildren(...conflicts.map(item => { const row = node('div', 'password-import-conflict'), text = node('span'); text.append(node('strong', '', `${item.service}${item.username ? ' · ' + item.username : ''}`), node('small', '', item.source)); const select = node('select'); select.dataset.importDecision = item.id; select.setAttribute('aria-label', `处理重复条目 ${item.service}`);
        for (const [value, label] of [['default', '跟随统一策略'], ['skip', '跳过'], ['keep', '保留两者'], ['overwrite', '覆盖已有']]) { const option = node('option', '', label); option.value = value; select.append(option); } select.value = importDecisions.get(item.id) || 'default'; row.append(text, select); return row; }));
    if (preview.duplicates > conflicts.length) byId('passwordConflictItems').append(node('p', 'password-import-preview-limit', `展示前 ${conflicts.length} 个重复条目，其余按统一策略处理。`));
    byId('passwordImportCommit').disabled = preview.ready === 0; updateImportOutcome();
}
async function correctImportIssue(form) {
    if (!importToken || !importPreview) return; const signal = currentSignal(), token = importToken, correction = Object.fromEntries(new FormData(form)), button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try { const result = await invoke('update_password_import_entry', { token, issueId: form.dataset.importIssueForm, correction }); if (!live(signal) || token !== importToken) return;
        importPreview.ready = result.ready; importPreview.duplicates = result.duplicates; importPreview.invalid = result.invalid; importPreview.conflicts = result.conflicts || []; const index = importPreview.issues.findIndex(issue => issue.id === form.dataset.importIssueForm); if (index >= 0) { if (result.issue) importPreview.issues.splice(index, 1, result.issue); else importPreview.issues.splice(index, 1); } if (result.item) importPreview.items.push(result.item); renderImportPreview(importPreview); inlineStatus('passwordImportStatus');
    } catch (error) { if (live(signal)) inlineStatus('passwordImportStatus', String(error)); }
    finally { correction.password = ''; const password = form.elements.namedItem('password'); if (password) password.value = ''; if (live(signal)) button.disabled = false; }
}
async function discardImport() {
    const token = importToken; importToken = null; importPreview = null; importDecisions.clear(); byId('passwordImportIssues')?.replaceChildren(); byId('passwordImportItems')?.replaceChildren(); byId('passwordConflictItems')?.replaceChildren();
    if (token) try { await invoke('discard_password_import', { token }); } catch { /* Already released. */ }
}
async function beginImport() {
    const signal = currentSignal(), button = byId('passwordImport'); button.disabled = true;
    try { const path = await window.__TAURI__?.dialog?.open({ multiple: false, directory: false, title: '导入密码', filters: [{ name: 'JSON / CSV 密码文件', extensions: ['json', 'csv'] }] }); if (!path || Array.isArray(path) || !live(signal)) return; await discardImport(); const preview = await invoke('preview_password_import', { path });
        if (!live(signal)) { await invoke('discard_password_import', { token: preview.token }); return; } importToken = preview.token; byId('passwordImportFile').textContent = `${path.split(/[\\/]/).pop()} · ${preview.format}`; byId('passwordDuplicateStrategy').value = 'skip'; inlineStatus('passwordImportStatus'); renderImportPreview(preview); showDialog('passwordImportDialog');
    } catch (error) { if (live(signal)) setStatus(`导入预览失败：${error}`, 'error'); } finally { if (live(signal)) button.disabled = false; }
}
async function commitImport() {
    if (!importToken || mutationBusy) return; const signal = currentSignal(), button = byId('passwordImportCommit'); mutationBusy = true; button.disabled = true;
    try { const result = await invoke('commit_password_import', { token: importToken, strategy: byId('passwordDuplicateStrategy').value, decisions: [...importDecisions].map(([id, strategy]) => ({ id, strategy })) }); if (!live(signal)) return; importToken = null; byId('passwordImportDialog').close(); await reload(); setStatus(`导入完成：新增 ${result.imported} 条，覆盖 ${result.overwritten} 条，跳过 ${result.skipped} 条。`, 'success'); }
    catch (error) { if (live(signal)) inlineStatus('passwordImportStatus', `${error}。预览已保留，可以重试。`); } finally { mutationBusy = false; if (live(signal)) button.disabled = !importPreview?.ready; }
}
function beginExport() { inlineStatus('passwordExportStatus'); byId('passwordExportConfirmed').checked = false; byId('passwordExportCommit').disabled = true; byId('passwordExportScope').value = 'all'; byId('passwordExportScope').querySelector('[value="current"]').disabled = activeView === 'trash'; showDialog('passwordExportDialog'); }
async function exportPasswords() {
    if (!byId('passwordExportConfirmed').checked) return; const signal = currentSignal(), button = byId('passwordExportCommit'); button.disabled = true;
    try { const format = document.querySelector('[name="passwordExportFormat"]:checked').value; const path = await window.__TAURI__?.dialog?.save({ title: '导出密码', defaultPath: `passwords_export_${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }); if (!path || !live(signal)) return;
        const current = byId('passwordExportScope').value === 'current'; const result = await invoke('export_password_entries', { path, format, confirmed: true, query: current ? byId('passwordSearch').value : '', view: current ? activeView : 'all', category: current ? activeCategory : '' }); if (!live(signal)) return; byId('passwordExportDialog').close(); setStatus(`已导出 ${result.count} 条密码。文件包含明文密码，请妥善保管。`, 'success');
    } catch (error) { if (live(signal)) inlineStatus('passwordExportStatus', String(error)); } finally { if (live(signal)) button.disabled = !byId('passwordExportConfirmed').checked; }
}

function openDeleteDialog(id) {
    const item = items.find(entry => entry.id === id) || detail; if (!item) return; const dialog = byId('passwordDeleteDialog'); dialog.dataset.passwordId = id; dialog.dataset.emptyTrash = 'false'; const deleted = Boolean(item.deletedAt || activeView === 'trash');
    byId('passwordPermanentDelete').checked = deleted; byId('passwordPermanentDelete').disabled = deleted; byId('passwordPermanentDelete').closest('label').hidden = false; byId('passwordDeleteTitle').textContent = `${deleted ? '彻底删除' : '删除'}“${item.service}”？`; inlineStatus('passwordDeleteStatus'); updateDeleteDialog(); showDialog('passwordDeleteDialog');
}
function updateDeleteDialog() { const permanent = byId('passwordPermanentDelete').checked; byId('passwordDeleteDescription').textContent = permanent ? '密码将从加密库中移除，删除后无法恢复。' : '密码会进入回收站，保留 30 天后自动清除。'; byId('passwordDeleteConfirm').querySelector('span').textContent = permanent ? '彻底删除' : '移入回收站'; }
function emptyTrash() { const dialog = byId('passwordDeleteDialog'); dialog.dataset.emptyTrash = 'true'; byId('passwordDeleteTitle').textContent = `清空 ${overview?.trashCount || 0} 条回收站密码？`; byId('passwordDeleteDescription').textContent = '这些密码将被彻底删除，无法恢复。'; byId('passwordPermanentDelete').closest('label').hidden = true; byId('passwordDeleteConfirm').querySelector('span').textContent = '彻底清空'; inlineStatus('passwordDeleteStatus'); showDialog('passwordDeleteDialog'); }
async function confirmDelete() {
    if (mutationBusy) return; const signal = currentSignal(), dialog = byId('passwordDeleteDialog'), button = byId('passwordDeleteConfirm'); button.disabled = true; mutationBusy = true;
    try { if (dialog.dataset.emptyTrash === 'true') await invoke('empty_password_trash', { confirmed: true }); else await invoke('remove_password_entry', { id: dialog.dataset.passwordId, permanent: byId('passwordPermanentDelete').checked }); if (!live(signal)) return; dialog.close(); selectedId = null; detail = null; closeDetail(); await reload(); setStatus('删除操作已完成。', 'success'); }
    catch (error) { if (live(signal)) inlineStatus('passwordDeleteStatus', String(error)); } finally { mutationBusy = false; if (live(signal)) button.disabled = false; }
}
async function restoreEntry(id) { const signal = currentSignal(); try { await invoke('restore_password_entry', { id }); if (!live(signal)) return; await reload(); setStatus('密码已恢复。', 'success'); } catch (error) { if (live(signal)) setStatus(String(error), 'error'); } }
async function runAudit() {
    const signal = currentSignal(), button = byId('passwordAudit'); button.disabled = true;
    try { const report = await invoke('audit_password_security'); if (!live(signal)) return; const grid = node('div', 'password-audit-grid'); for (const [count, label] of [[report.total, '有效条目'], [report.weak, '较弱密码'], [report.reused, '重复使用'], [report.stale, '一年未更新'], [report.incomplete, '缺少账号']]) { const card = node('div'); card.append(node('strong', '', count), node('span', '', label)); grid.append(card); }
        const list = node('div', 'password-audit-list'), labels = { weak: '较弱', reused: '重复', stale: '陈旧', incomplete: '信息不完整' }; for (const issue of report.issues) { const row = node('button'); row.type = 'button'; row.dataset.auditId = issue.id; row.append(node('strong', '', issue.service), node('span', '', issue.kinds.map(kind => labels[kind]).join(' · '))); list.append(row); } if (!report.issues.length) list.append(node('p', '', '没有发现上述常见问题。')); byId('passwordAuditContent').replaceChildren(grid, list); showDialog('passwordAuditDialog');
    } catch (error) { if (live(signal)) setStatus(String(error), 'error'); } finally { if (live(signal)) button.disabled = false; }
}
async function handleDetailClick(event) {
    if (event.target.closest('[data-close-detail]')) return closeDetail(); if (!detail) return;
    const copy = event.target.closest('[data-copy-field]'); if (copy) return copyField(detail.id, copy.dataset.copyField); if (event.target.closest('[data-copy-password]')) return copyPassword(detail.id);
    if (event.target.closest('[data-open-url]')) { try { await invoke('open_password_url', { id: detail.id }); } catch (error) { setStatus(String(error), 'error'); } return; }
    if (event.target.closest('[data-favorite-detail]')) { try { await invoke('set_password_favorite', { id: detail.id, favorite: !detail.favorite }); await reload(); if (selectedId) await loadDetail(selectedId); } catch (error) { setStatus(String(error), 'error'); } return; }
    const action = event.target.closest('[data-detail-action]')?.dataset.detailAction; if (action === 'edit') openEditor(detail.id); if (action === 'delete') openDeleteDialog(detail.id);
}

export async function initializePasswordVault() {
    controller?.abort(); unlisten?.(); unlistenSettings?.(); unlisten = null; unlistenSettings = null; controller = new AbortController(); const signal = controller.signal; items = []; detail = null; overview = null; selectedId = null; activeView = 'all'; activeCategory = ''; offset = 0; mutationBusy = false;
    listen(byId('passwordSearch'), 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh({ reset: true }), 120); }); listen(document, 'keydown', handleKeyboard); listen(byId('passwordList'), 'click', handleResultClick);
    listen(byId('passwordPagePrev'), 'click', () => { offset = Math.max(0, offset - pageSize()); refresh(); }); listen(byId('passwordPageNext'), 'click', () => { offset += pageSize(); refresh(); });
    listen(byId('passwordNav'), 'click', event => { const button = event.target.closest('[data-password-view]'); if (!button) return; activeView = button.dataset.passwordView; activeCategory = button.dataset.category || ''; selectedId = null; detail = null; detailGeneration++; closeDetail(); renderNav(); refresh({ reset: true }); });
    listen(byId('passwordSort'), 'change', () => refresh({ reset: true })); listen(byId('passwordRefresh'), 'click', () => reload().catch(error => setStatus(String(error), 'error'))); listen(byId('passwordDetail'), 'click', handleDetailClick); listen(byId('passwordDetailBackdrop'), 'click', closeDetail);
    listen(byId('passwordSearchHelpToggle'), 'click', () => { const help = byId('passwordSearchHelp'); help.hidden = !help.hidden; byId('passwordSearchHelpToggle').setAttribute('aria-expanded', String(!help.hidden)); });
    listen(byId('passwordSearchHelp'), 'click', event => { const field = event.target.closest('[data-search-field]'); if (!field) return; byId('passwordSearch').value = `#${field.dataset.searchField} `; byId('passwordSearch').focus(); refresh({ reset: true }); });
    listen(byId('passwordAdd'), 'click', () => openEditor()); listen(byId('passwordImport'), 'click', beginImport); listen(byId('passwordExport'), 'click', beginExport); listen(byId('passwordAudit'), 'click', runAudit);
    listen(byId('passwordEditorForm'), 'submit', saveEditor); if (byId('passwordEditorSave')) byId('passwordEditorSave').type = 'submit'; listen(byId('passwordEditorCancel'), 'click', () => byId('passwordEditor').close());
    listen(byId('passwordGenerateToggle'), 'click', () => { byId('passwordGenerator').hidden = !byId('passwordGenerator').hidden; byId('passwordGenerateToggle').setAttribute('aria-expanded', String(!byId('passwordGenerator').hidden)); });
    listen(byId('passwordGenerate'), 'click', () => { byId('passwordValue').value = generatePassword(); updateStrength(); }); listen(byId('passwordValue'), 'input', updateStrength); listen(byId('passwordLength'), 'input', event => { byId('passwordLengthValue').value = event.target.value; });
    listen(byId('passwordGenerator'), 'click', event => { const button = event.target.closest('[data-generator-mode]'); if (!button) return; const phrase = button.dataset.generatorMode === 'phrase'; byId('passwordGenerator').dataset.mode = button.dataset.generatorMode; byId('passwordGenerator').querySelectorAll('[data-generator-mode]').forEach(item => item.classList.toggle('is-active', item === button)); byId('passwordGenerator').querySelectorAll('[data-character-option]').forEach(item => item.hidden = phrase); byId('passwordPhraseHint').hidden = !phrase; });
    const reveal = byId('passwordReveal'), hide = () => { if (byId('passwordValue')) byId('passwordValue').type = 'password'; };
    listen(reveal, 'pointerdown', event => { if (event.button === 0) { byId('passwordValue').type = 'text'; reveal.setPointerCapture(event.pointerId); } }); for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) listen(reveal, event, hide);
    listen(reveal, 'keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); byId('passwordValue').type = 'text'; } }); listen(reveal, 'keyup', hide); listen(window, 'blur', hide);
    listen(byId('passwordAddField'), 'click', () => { if (byId('passwordCustomFields').children.length >= 20) return; byId('passwordCustomFields').append(customFieldNode()); updateFieldCount(); }); listen(byId('passwordCustomFields'), 'click', event => { event.target.closest('[data-remove-field]')?.closest('.password-custom-field')?.remove(); updateFieldCount(); }); listen(byId('passwordCustomFields'), 'change', event => { if (event.target.matches('[data-field-sensitive]')) event.target.closest('.password-custom-field').querySelector('[data-field-value]').type = event.target.checked ? 'password' : 'text'; });
    document.querySelectorAll('.password-dialog').forEach(dialog => { makeDialogDraggable(dialog); listen(dialog, 'close', () => resetDialogPosition(dialog)); }); document.querySelectorAll('[data-close-dialog]').forEach(button => listen(button, 'click', () => byId(button.dataset.closeDialog).close('cancel')));
    listen(byId('passwordEditor'), 'close', () => fillEditor()); listen(byId('passwordImportDialog'), 'close', discardImport); listen(byId('passwordExportDialog'), 'close', () => { byId('passwordExportConfirmed').checked = false; });
    listen(window, 'resize', () => { document.querySelectorAll('.password-dialog[open]').forEach(resetDialogPosition); if (!matchMedia('(max-width:1080px)').matches) closeDetail(); });
    listen(byId('passwordImportIssues'), 'click', event => { const button = event.target.closest('[data-import-issue-edit]'); if (!button) return; const form = button.closest('article').querySelector('form'); if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); } }); listen(byId('passwordImportIssues'), 'submit', event => { event.preventDefault(); correctImportIssue(event.target); });
    listen(byId('passwordConflictItems'), 'change', event => { const id = event.target.dataset.importDecision; if (!id) return; if (event.target.value === 'default') importDecisions.delete(id); else importDecisions.set(id, event.target.value); }); listen(byId('passwordDuplicateStrategy'), 'change', updateImportOutcome); listen(byId('passwordImportCommit'), 'click', commitImport);
    listen(byId('passwordExportConfirmed'), 'change', () => { byId('passwordExportCommit').disabled = !byId('passwordExportConfirmed').checked; }); listen(byId('passwordExportCommit'), 'click', exportPasswords);
    listen(byId('passwordPermanentDelete'), 'change', updateDeleteDialog); listen(byId('passwordDeleteConfirm'), 'click', confirmDelete); listen(byId('passwordEmptyTrash'), 'click', emptyTrash);
    listen(byId('passwordAuditContent'), 'click', async event => { const row = event.target.closest('[data-audit-id]'); if (!row) return; byId('passwordAuditDialog').close(); activeView = 'all'; activeCategory = ''; byId('passwordSearch').value = row.querySelector('strong').textContent; offset = 0; selectedId = row.dataset.auditId; renderNav(); await refresh(); if (selectedId) await selectItem(selectedId, true); });
    listen(byId('passwordClipboardTime'), 'change', async event => { const select = event.target, previous = clipboardSeconds; select.disabled = true; try { const result = await invoke('set_password_settings', { settings: { clipboardClearSeconds: Number(select.value) } }); if (!live(signal)) return; clipboardSeconds = result.clipboardClearSeconds; renderDetail(); setStatus('剪贴板清理策略已保存。', 'success'); } catch (error) { if (live(signal)) { select.value = String(previous); setStatus(String(error), 'error'); } } finally { if (live(signal)) select.disabled = false; } });
    listen(window, 'dtkit:power-state', event => { if (event.detail?.suspended) hide(); });
    const events = window.__TAURI__?.event;
    if (events?.listen) {
        try {
            const stop = await events.listen('password-vault-changed', () => {
                clearTimeout(changeTimer); changeTimer = setTimeout(() => {
                    if (live(signal) && !mutationBusy) { detail = null; detailGeneration++; reload().catch(error => setStatus(String(error), 'error')); }
                }, 100);
            });
            if (live(signal)) unlisten = stop; else stop();
            const settingsStop = await events.listen('password-settings-changed', event => {
                if (!live(signal)) return; clipboardSeconds = event.payload.clipboardClearSeconds;
                if (byId('passwordClipboardTime')) byId('passwordClipboardTime').value = String(clipboardSeconds); renderDetail();
            });
            if (live(signal)) unlistenSettings = settingsStop; else settingsStop();
        } catch { /* The refresh button remains available if event registration fails. */ }
    }
    try { const settings = await invoke('get_password_settings'); if (!live(signal)) return; clipboardSeconds = settings.clipboardClearSeconds; if (byId('passwordClipboardTime')) byId('passwordClipboardTime').value = String(clipboardSeconds); await loadOverview(); } catch (error) { if (live(signal)) setStatus(String(error), 'error'); }
    if (!live(signal)) return; renderDetail(); await refresh(); if (live(signal)) byId('passwordSearch')?.focus();
}
export async function destroyPasswordVault() {
    controller?.abort(); controller = null; unlisten?.(); unlisten = null; unlistenSettings?.(); unlistenSettings = null; clearTimeout(searchTimer); clearTimeout(changeTimer); searchTimer = null; changeTimer = null; refreshGeneration++; detailGeneration++; items = []; detail = null; overview = null; selectedId = null;
    document.querySelectorAll('.password-dialog input, .password-dialog textarea').forEach(input => { input.value = ''; }); await discardImport();
}
export function serialize() { return { view: activeView, category: activeCategory, query: byId('passwordSearch')?.value || '', offset, sort: byId('passwordSort')?.value || 'recent' }; }
export async function restore(state) {
    if (!state || typeof state !== 'object') return; activeView = ['all', 'recent', 'favorites', 'trash', 'category', 'uncategorized'].includes(state.view) ? state.view : 'all'; activeCategory = String(state.category || '').slice(0, 200); byId('passwordSearch').value = String(state.query || '').slice(0, 2000); offset = Math.max(0, Number(state.offset) || 0);
    if (byId('passwordSort')) byId('passwordSort').value = ['recent', 'name', 'updated'].includes(state.sort) ? state.sort : 'recent'; renderNav(); await refresh();
}
