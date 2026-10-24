import { registerTool } from '../toolRegistry.js';
import '../../css/tools/file-batch.css';
import { getTemplate, batchIcon } from './template.js';
import { createBatchMotion } from './motion.js';
import { basename, extension, parseExtensions, mergeSources, sortSources, formatBytes,
    renderRename, normalizeRenameOptions, requestFingerprint } from './core.js';

const OPERATIONS = { rename: '重命名', copy: '复制', move: '移动', delete: '删除' };
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const FIELD_IDS = ['batchNamePattern', 'batchStartIndex', 'batchNumberPadding', 'batchNumberStep', 'batchFind', 'batchReplace', 'batchCaseMode', 'batchExtensions', 'batchPermanent'];
const PRESETS = { numbered: '{name}_{n}{dotext}', original: '{name}{dotext}', sequence: '文件_{n}{dotext}', prefix: '整理_{name}{dotext}', suffix: '{name}_整理{dotext}' };
const records = new Map();
const pendingProgress = new Map();
let currentView;
let progressUnlisten;
let progressPromise;
const node = (view, id) => view.root.querySelector('#' + id);
const alive = view => currentView === view && !view.controller.signal.aborted;
const pathKey = path => String(path).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replaceAll('/', '\\').toLocaleLowerCase();
const text = (view, id, value) => { const element = node(view, id); if (element) element.textContent = value; };
const activeRecord = view => records.get(view.recordId);
const isBusy = view => { const record = activeRecord(view); return Boolean(record && !TERMINAL.has(record.status)); };

async function invoke(command, args = {}) {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) throw new Error('请在 DtKit 桌面应用中使用文件批处理。');
    return call(command, args);
}

function status(view, message, tone = '') {
    if (!alive(view)) return;
    text(view, 'batchStatus', message); node(view, 'batchStatus').dataset.type = tone;
}

function readRequest(view) {
    const value = id => node(view, id).value;
    const startIndex = view.operation === 'rename' ? Number(value('batchStartIndex')) : 1;
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > 999999) throw new Error('起始序号应为 0 到 999999 的整数。');
    return {
        sources: sortSources(view.files, node(view, 'batchSort').value), operation: view.operation,
        destination: view.destination || null, namePattern: value('batchNamePattern'), startIndex,
        extensions: parseExtensions(value('batchExtensions')), permanent: view.operation === 'delete' && node(view, 'batchPermanent').checked,
        renameOptions: normalizeRenameOptions(view.operation === 'rename' ? { find: value('batchFind'), replace: value('batchReplace'), caseMode: value('batchCaseMode'),
            numberPadding: Number(value('batchNumberPadding')), numberStep: Number(value('batchNumberStep')) } : {})
    };
}

function matchesPreview(view) {
    if (!view.preview) return false;
    try { return view.preview.key === requestFingerprint(readRequest(view)); } catch { return false; }
}

function updateControls(view) {
    const busy = isBusy(view);
    view.root.dataset.busy = String(busy);
    view.root.querySelectorAll('.batch-config-card input, .batch-config-card select, .batch-config-card button, #batchSort, #batchClearFiles, .batch-row-remove').forEach(element => { element.disabled = busy; });
    const valid = matchesPreview(view);
    node(view, 'batchExecute').disabled = busy || !valid || Boolean(view.preview?.response.hasConflicts) || !view.preview?.response.items?.length;
    node(view, 'batchPreview').disabled = busy || Boolean(view.checking) || !view.files.length;
    node(view, 'batchPreview').dataset.loading = String(Boolean(view.checking));
    node(view, 'batchClearFiles').disabled = busy || !view.files.length;
    node(view, 'batchExport').disabled = !view.files.length;
    node(view, 'batchCancel').disabled = !busy || !activeRecord(view)?.jobId || activeRecord(view)?.status === 'cancelling';
    const execute = node(view, 'batchExecute');
    execute.dataset.operation = view.operation;
    const label = execute.querySelector('[data-batch-execute-label]');
    if (label) label.textContent = `执行${OPERATIONS[view.operation]}`;
}

function invalidate(view, { animate = false, message = true } = {}) {
    view.revision += 1; view.checking = null; view.preview = null; view.resultRecord = null; view.limit = 60;
    if (message && !isBusy(view)) status(view, view.files.length ? '规则已更新，检查变更后即可执行。' : '添加文件，从一份清晰的变更预览开始。');
    render(view, animate); updateControls(view);
}

function updateOperation(view, animate = true) {
    view.operation = view.root.querySelector('input[name="batchOperation"]:checked')?.value || 'rename';
    const target = node(view, view.operation === 'rename' ? 'batchRenameOptions' : view.operation === 'delete' ? 'batchDeleteOptions' : 'batchDestinationOptions');
    if (view.operation !== 'delete') node(view, 'batchPermanent').checked = false;
    view.root.dataset.operation = view.operation;
    if (animate) view.motion.switchPanel(node(view, 'batchOptions'), target);
    else for (const panel of node(view, 'batchOptions').children) { panel.hidden = panel !== target; panel.inert = panel !== target; }
    invalidate(view);
}

function draftItems(view) {
    let request;
    try { request = readRequest(view); } catch (error) {
        return view.files.map(source => ({ source, name: basename(source), target: null, conflict: String(error.message || error), size: null, draft: true }));
    }
    const checked = matchesPreview(view) ? new Map(view.preview.response.items.map(item => [pathKey(item.source), item])) : null;
    const extensions = new Set(request.extensions); let index = request.startIndex;
    const items = request.sources.map(source => {
        const excluded = extensions.size > 0 && !extensions.has(extension(source).toLowerCase());
        const native = checked?.get(pathKey(source));
        if (native) return { ...native, selectedSource: source };
        const item = { source, selectedSource: source, name: basename(source), size: null, target: null, conflict: null, draft: !checked, excluded: excluded || Boolean(checked) };
        if (!item.excluded) {
            if (request.operation === 'rename') {
                try { item.target = source.slice(0, source.length - basename(source).length) + renderRename(source, index, request.namePattern, request.renameOptions); }
                catch (error) { item.conflict = String(error.message || error); }
            } else if (request.operation === 'copy' || request.operation === 'move') {
                item.target = request.destination ? request.destination.replace(/[\\/]$/, '') + '\\' + item.name : null;
            }
            index += request.renameOptions.numberStep;
        }
        return item;
    });
    // Local duplicate detection is a useful draft hint; the native check remains authoritative.
    if (!checked) {
        const targets = new Map();
        for (const item of items) if (!item.excluded && item.target) {
            const key = pathKey(item.target);
            if (targets.has(key)) { item.conflict = '多个文件会产生相同目标名称'; targets.get(key).conflict = item.conflict; }
            else targets.set(key, item);
        }
    }
    return items;
}

function fileIcon(path) {
    const ext = extension(path).toLowerCase();
    return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(ext) ? 'image' : ['mp4', 'mov', 'mkv', 'mp3', 'wav', 'flac'].includes(ext) ? 'media' : 'file';
}

function makeRow(view, item, index, result) {
    const row = document.createElement('div');
    row.className = `batch-preview-row${item.conflict ? ' batch-preview-row--conflict' : ''}${item.excluded ? ' is-excluded' : ''}`;
    row.dataset.path = item.selectedSource || item.source;
    row.innerHTML = `<span class="batch-file-icon">${batchIcon(fileIcon(item.source))}</span><div class="batch-file-identity"><strong></strong><small></small></div><span class="batch-file-arrow">${batchIcon('arrow')}</span><div class="batch-file-target"><strong></strong><small></small></div><span class="batch-row-status"></span><button class="batch-row-remove" type="button">${batchIcon('remove')}</button>`;
    const identity = row.querySelector('.batch-file-identity'); identity.querySelector('strong').textContent = item.name; identity.querySelector('small').textContent = item.source; identity.title = item.source;
    const target = row.querySelector('.batch-file-target');
    const isDelete = (result?.request?.operation || view.operation) === 'delete';
    const targetName = item.excluded ? '已排除' : item.conflict || (item.target ? basename(item.target) : isDelete ? ((result?.request.permanent ?? node(view, 'batchPermanent').checked) ? '彻底删除' : '移入恢复区') : '请选择目标文件夹');
    target.querySelector('strong').textContent = targetName;
    target.querySelector('small').textContent = item.excluded ? '扩展名不匹配或无法参与处理' : item.conflict ? '调整规则或移除此项后重新检查' : item.target || (isDelete ? '删除前请检查这份清单' : '设置位置后显示完整路径');
    target.title = item.conflict || item.target || targetName;
    const badge = row.querySelector('.batch-row-status');
    const done = result && index < Number(result.result?.processed || 0);
    const running = result && !TERMINAL.has(result.status);
    badge.textContent = item.excluded ? '排除' : done ? '已完成' : running ? '处理中' : result ? '未处理' : item.conflict ? '冲突' : item.draft ? '草稿' : '可执行';
    badge.dataset.state = item.excluded ? 'excluded' : done ? 'completed' : running ? 'running' : item.conflict ? 'conflict' : item.draft ? 'draft' : 'ready';
    const remove = row.querySelector('.batch-row-remove'); remove.dataset.batchRemove = item.selectedSource || item.source;
    remove.title = `移除 ${item.name}`; remove.setAttribute('aria-label', remove.title); remove.disabled = isBusy(view); remove.hidden = Boolean(result);
    return row;
}

function renderList(view, items, result, animate) {
    const query = node(view, 'batchSearch').value.trim().toLocaleLowerCase();
    const onlyConflicts = node(view, 'batchOnlyConflicts').checked;
    const filtered = items.map((item, index) => ({ item, index })).filter(({ item }) => (!onlyConflicts || item.conflict) && (!query || `${item.name}\n${item.source}\n${item.target || ''}\n${item.conflict || ''}`.toLocaleLowerCase().includes(query)));
    const list = node(view, 'batchPreviewList'); const focused = document.activeElement?.closest('.batch-row-remove')?.dataset.batchRemove;
    const mutate = () => {
        const fragment = document.createDocumentFragment();
        for (const { item, index } of filtered.slice(0, view.limit)) fragment.append(makeRow(view, item, index, result));
        if (!filtered.length) {
            const empty = document.createElement('div'); empty.className = 'batch-empty-state';
            empty.innerHTML = `${items.length ? `<span class="batch-empty-icon">${batchIcon('search')}</span>` : `<span class="batch-empty-art"><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span><span>${batchIcon('file')}</span></span>`}<strong></strong><span></span>`;
            empty.querySelector('strong').textContent = items.length ? (onlyConflicts ? '没有符合条件的冲突' : '没有找到这些文件') : '把繁琐，交给批处理。';
            empty.querySelector(':scope > span:last-child').textContent = items.length ? '试试其他关键词，或关闭“仅看冲突”。' : '添加文件，规则变化会即时呈现在这里。';
            fragment.append(empty);
        }
        list.replaceChildren(fragment);
    };
    if (animate) view.motion.refresh(list, mutate); else mutate();
    if (focused) [...list.querySelectorAll('.batch-row-remove')].find(button => button.dataset.batchRemove === focused)?.focus({ preventScroll: true });
    node(view, 'batchShowMore').hidden = filtered.length <= view.limit;
    text(view, 'batchShowMore', `再显示 ${Math.min(60, filtered.length - view.limit)} 项`);
    text(view, 'batchListCount', `显示 ${Math.min(view.limit, filtered.length)} / ${filtered.length} 项${query || onlyConflicts ? ` · 共 ${items.length} 项` : ''}`);
}

function render(view, animate = false) {
    if (!alive(view)) return;
    const result = (view.resultRecord && records.get(view.resultRecord)) || (isBusy(view) && activeRecord(view)) || null;
    const items = result ? result.preview.items : draftItems(view);
    view.root.dataset.hasFiles = String(view.files.length > 0);
    const eligible = items.filter(item => !item.excluded); const conflicts = eligible.filter(item => item.conflict).length;
    const summary = node(view, 'batchSelectionSummary'); summary.classList.toggle('batch-selection--empty', !view.files.length);
    summary.textContent = view.files.length ? `已选择 ${view.files.length} 个文件` : '尚未选择文件 · 最多 500 项';
    text(view, 'batchCountTotal', items.length); text(view, 'batchCountReady', eligible.length - conflicts); text(view, 'batchCountConflict', conflicts);
    text(view, 'batchDestinationPath', view.destination || '尚未选择文件夹'); node(view, 'batchDestinationPath').title = view.destination;
    const checked = matchesPreview(view);
    node(view, 'batchPreviewMeta').dataset.state = result ? 'finished' : checked ? conflicts ? 'conflict' : 'checked' : 'draft';
    text(view, 'batchPreviewMeta', result ? `${OPERATIONS[result.request.operation]}${result.status === 'completed' ? '完成' : TERMINAL.has(result.status) ? '结果' : '中'} · ${items.length} 项` : checked ? `${eligible.length} 项 · ${formatBytes(view.preview.response.totalBytes)}${view.preview.response.skipped ? ` · 排除 ${view.preview.response.skipped}` : ''}` : view.files.length ? `${eligible.length} 项待检查 · 实时草稿` : '等待添加文件');
    renderList(view, items, result, animate); renderProgress(view); renderHistory(view); updateControls(view);
}

function addFiles(view, incoming) {
    if (!alive(view) || isBusy(view)) return;
    const merged = mergeSources(view.files, incoming);
    view.files = merged.sources;
    if (merged.added) invalidate(view, { animate: true, message: false });
    status(view, merged.overflow ? `已添加 ${merged.added} 项；超过 500 项的 ${merged.overflow} 个文件未加入。` : merged.added ? `已添加 ${merged.added} 个文件${merged.duplicates ? `，略过 ${merged.duplicates} 个重复项` : ''}。` : '这些文件已在清单中。', merged.overflow ? 'error' : '');
}

async function chooseFiles(view) {
    if (view.selecting || isBusy(view)) return;
    view.selecting = true;
    try {
        const open = window.__TAURI__?.dialog?.open;
        if (!open) throw new Error('请在 DtKit 桌面应用中选择本地文件。');
        const result = await open({ multiple: true, directory: false, title: '添加要批量处理的文件' });
        if (alive(view) && result) addFiles(view, Array.isArray(result) ? result : [result]);
    } catch (error) { status(view, String(error.message || error), 'error'); }
    finally { view.selecting = false; }
}

async function chooseDestination(view) {
    if (view.choosingDestination || isBusy(view)) return;
    view.choosingDestination = true;
    try {
        const result = await window.__TAURI__?.dialog?.open({ directory: true, multiple: false, title: '选择目标文件夹' });
        if (alive(view) && typeof result === 'string') { view.destination = result; invalidate(view); }
    } catch (error) { status(view, String(error.message || error), 'error'); }
    finally { view.choosingDestination = false; }
}

async function previewBatch(view) {
    if (!alive(view) || isBusy(view) || view.checking) return;
    if (!view.files.length) return status(view, '请先添加文件。', 'error');
    let request;
    try { request = readRequest(view); } catch (error) { return status(view, String(error.message || error), 'error'); }
    const token = {}; const revision = view.revision; const key = requestFingerprint(request);
    view.checking = token; view.preview = null; view.resultRecord = null;
    updateControls(view); status(view, '正在检查文件、名称和目标位置…');
    try {
        const response = await invoke('preview_file_batch', { request });
        if (!alive(view) || view.checking !== token || revision !== view.revision || key !== requestFingerprint(readRequest(view))) return;
        if (!response || !Array.isArray(response.items)) throw new Error('没有收到有效的文件检查结果。');
        view.preview = { request, response, key }; render(view, true);
        status(view, response.hasConflicts ? '发现冲突。请修改规则或移除冲突文件后再检查。' : `${response.items.length} 项检查通过，可以执行${OPERATIONS[view.operation]}。`, response.hasConflicts ? 'error' : 'success');
    } catch (error) {
        if (alive(view) && view.checking === token) { view.preview = null; status(view, String(error.message || error), 'error'); }
    } finally {
        if (alive(view) && view.checking === token) { view.checking = null; updateControls(view); }
    }
}

async function ensureProgressListener() {
    if (progressUnlisten) return;
    if (!progressPromise) progressPromise = (async () => {
        const listen = window.__TAURI__?.event?.listen;
        if (!listen) throw new Error('无法连接任务进度，请在桌面应用中重试。');
        progressUnlisten = await listen('file-batch-progress', event => handleProgress(event.payload));
    })().finally(() => { progressPromise = null; });
    return progressPromise;
}

function trimRecords() {
    if (records.size <= 20) return;
    for (const [id, record] of records) if (records.size > 20 && TERMINAL.has(record.status) && !record.result?.recoveryBatchId) records.delete(id);
}

function handleProgress(payload) {
    if (!payload?.jobId) return;
    const record = [...records.values()].find(item => item.jobId === payload.jobId || item.id === payload.clientId);
    if (!record) {
        pendingProgress.set(payload.jobId, payload);
        if (pendingProgress.size > 12) pendingProgress.delete(pendingProgress.keys().next().value);
        return;
    }
    if (TERMINAL.has(record.status)) return;
    if (payload.status !== 'preparing') record.jobId = payload.jobId;
    const nextStatus = payload.status === 'preparing' ? 'starting' : payload.status;
    if (record.status !== 'cancelling' || TERMINAL.has(nextStatus)) record.status = nextStatus;
    record.progress = Math.max(record.progress, Number(payload.progress) || 0);
    record.error = payload.error; if (payload.result) record.result = payload.result;
    if (Array.isArray(payload.result?.preview?.items)) record.preview = payload.result.preview;
    if (TERMINAL.has(record.status)) { record.finishedAt = Date.now(); trimRecords(); }
    const view = currentView;
    if (!view || !alive(view)) return;
    if (view.recordId === record.id) {
        if (TERMINAL.has(record.status)) applyResult(view, record);
        else { renderProgress(view); renderHistory(view); updateControls(view); }
    } else renderHistory(view);
}

function applyResult(view, record) {
    if (view.appliedJobId !== record.id && record.sessionId === view.sessionId) {
        const processed = Number(record.result?.processed || 0);
        const changed = new Map(record.preview.items.slice(0, processed).map(item => [pathKey(item.source), item.target]));
        if (record.request.operation !== 'copy') view.files = view.files.flatMap(path => changed.has(pathKey(path)) ? record.request.operation === 'delete' ? [] : [changed.get(pathKey(path)) || path] : [path]);
        view.appliedJobId = record.id; view.revision += 1; view.preview = null; view.checking = null; view.resultRecord = record.id;
    }
    render(view);
    const processed = Number(record.result?.processed || 0);
    status(view, record.error || (record.status === 'completed' ? `${processed} 个文件已${OPERATIONS[record.request.operation]}。${record.result?.recoveryBatchId ? '可在此恢复本批文件。' : ''}` : `任务已取消，已处理 ${processed} / ${record.preview.items.length} 项。`), record.status === 'completed' ? 'success' : 'error');
}

async function startBatch(view) {
    if (!alive(view) || isBusy(view) || !matchesPreview(view) || view.preview.response.hasConflicts) return;
    const approved = view.preview;
    const record = { id: crypto.randomUUID(), sessionId: view.sessionId, jobId: null, request: structuredClone(approved.request),
        preview: structuredClone(approved.response), status: 'starting', progress: 0, createdAt: Date.now(), result: null, error: null, launching: true };
    record.request.clientId = record.id;
    records.set(record.id, record); view.recordId = record.id; view.resultRecord = null;
    render(view); status(view, '正在准备处理…');
    try {
        await ensureProgressListener();
        const started = await invoke('start_file_batch', { request: { ...record.request, clientId: record.id } });
        if (!started?.jobId) throw new Error('没有收到有效的任务编号。');
        record.jobId = started.jobId; if (!TERMINAL.has(record.status)) record.status = 'running'; record.launching = false;
        if (Array.isArray(started.preview?.items) && !record.result?.preview) record.preview = started.preview;
        const pending = pendingProgress.get(record.jobId);
        if (pending) { pendingProgress.delete(record.jobId); handleProgress(pending); }
        const visible = currentView;
        if (visible?.recordId === record.id && alive(visible) && !TERMINAL.has(record.status)) { render(visible); status(visible, `正在${OPERATIONS[record.request.operation]} ${started.fileCount} 个文件。切换页面后会继续处理。`); }
    } catch (error) {
        record.status = 'failed'; record.error = String(error.message || error); record.finishedAt = Date.now(); record.result = { processed: 0, total: record.preview.items.length };
        const visible = currentView;
        if (visible?.recordId === record.id && alive(visible)) { visible.preview = null; render(visible); status(visible, record.error, 'error'); }
    } finally {
        record.launching = false;
    }
}

function executeBatch(view) {
    if (isBusy(view)) return;
    if (!matchesPreview(view)) return status(view, '请先检查当前规则的变更。', 'error');
    if (view.preview.response.hasConflicts) return status(view, '请先解决清单中的冲突。', 'error');
    if (view.operation === 'delete' && node(view, 'batchPermanent').checked) {
        view.confirmKey = view.preview.key; view.motion.open(node(view, 'batchDangerDialog')); return;
    }
    startBatch(view);
}

function renderProgress(view) {
    const record = activeRecord(view); const panel = node(view, 'batchProgressPanel'); panel.hidden = !record;
    if (!record) return;
    const labels = { starting: '正在准备任务', running: `正在${OPERATIONS[record.request.operation]}`, cancelling: '正在取消，等待当前文件完成', completed: '处理完成', cancelled: '任务已取消', failed: '处理失败' };
    text(view, 'batchProgressLabel', labels[record.status] || '正在处理');
    const progress = record.status === 'completed' ? 1 : record.progress;
    text(view, 'batchProgressValue', `${Math.round(progress * 100)}%`);
    node(view, 'batchProgressBar').value = progress; panel.dataset.state = record.status;
    node(view, 'batchCancel').hidden = TERMINAL.has(record.status);
    const restore = node(view, 'batchRestore'); restore.hidden = !record.result?.recoveryBatchId || record.restored;
    restore.dataset.recordId = record.id; restore.disabled = Boolean(record.restoring) || isBusy(view);
}

function renderHistory(view) {
    const list = node(view, 'batchHistoryList'); if (!list) return;
    const key = JSON.stringify([...records.values()].map(record => [record.id, record.status, record.result?.processed, Boolean(record.restored), Boolean(record.restoring)]));
    if (view.historyKey === key) return;
    view.historyKey = key;
    const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.batchRestore : null;
    const fragment = document.createDocumentFragment();
    for (const record of [...records.values()].reverse()) {
        const row = document.createElement('div'); row.className = 'batch-history-row';
        const identity = document.createElement('div'); const strong = document.createElement('strong'); const small = document.createElement('small');
        strong.textContent = `${OPERATIONS[record.request.operation]} · ${record.preview.items.length} 个文件`;
        const label = { starting: '准备中', running: '处理中', cancelling: '取消中', completed: '已完成', cancelled: '已取消', failed: '失败' }[record.status] || record.status;
        small.textContent = `${new Date(record.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${label}${record.result ? ` · ${record.result.processed} 项已处理` : ''}${record.restored ? ' · 已恢复' : ''}`;
        identity.append(strong, small); row.append(identity);
        if (record.result?.recoveryBatchId && !record.restored) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'batch-button batch-button--secondary';
            button.dataset.batchRestore = record.id; button.textContent = record.restoring ? '恢复中…' : '恢复'; button.disabled = Boolean(record.restoring) || isBusy(view); row.append(button);
        }
        fragment.append(row);
    }
    if (!records.size) { const empty = document.createElement('p'); empty.className = 'batch-history-empty'; empty.textContent = '本次使用中的处理记录会显示在这里。'; fragment.append(empty); }
    list.replaceChildren(fragment);
    if (focused) [...list.querySelectorAll('[data-batch-restore]')].find(button => button.dataset.batchRestore === focused)?.focus({ preventScroll: true });
}

async function cancelBatch(view) {
    const record = activeRecord(view); if (!record?.jobId || TERMINAL.has(record.status) || record.status === 'cancelling') return;
    const previous = record.status; record.status = 'cancelling'; renderProgress(view); updateControls(view);
    try { await invoke('cancel_job', { jobId: record.jobId }); }
    catch (error) { if (record.status === 'cancelling') record.status = previous; if (alive(view)) { renderProgress(view); updateControls(view); status(view, String(error.message || error), 'error'); } }
}

async function restoreBatch(view, id) {
    const record = records.get(id); if (!record?.result?.recoveryBatchId || record.restored || record.restoring || isBusy(view)) return;
    record.restoring = true; renderProgress(view); renderHistory(view);
    try {
        const result = await invoke('restore_file_batch', { batchId: record.result.recoveryBatchId });
        record.restored = result.skipped === 0;
        if (alive(view)) {
            if (!result.skipped) { view.files = mergeSources(view.files, record.preview.items.slice(0, record.result.processed).map(item => item.source)).sources; invalidate(view, { message: false }); }
            status(view, `已恢复 ${result.restored} 个文件${result.skipped ? `，${result.skipped} 项暂未恢复，可处理同名文件后重试` : ''}。`, result.skipped ? 'error' : 'success');
        }
    } catch (error) { status(view, String(error.message || error), 'error'); }
    finally { record.restoring = false; if (alive(view)) { renderProgress(view); renderHistory(view); } }
}

function exportList(view) {
    const record = (view.resultRecord && records.get(view.resultRecord)) || (isBusy(view) && activeRecord(view)) || null;
    const items = record ? record.preview.items : draftItems(view);
    const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
    const rows = [['原文件', '目标路径', '操作', '大小（字节）', '检查状态'], ...items.map(item => [item.source, item.target || '', OPERATIONS[record?.request.operation || view.operation], item.size ?? '', item.conflict || (item.excluded ? '排除' : item.draft ? '待检查' : '已检查')])];
    const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `文件批处理清单-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    view.urls.add(url); const timer = setTimeout(() => { URL.revokeObjectURL(url); view.urls.delete(url); view.timers.delete(timer); }, 30000); view.timers.add(timer);
    status(view, '已导出完整清单，包含当前搜索未显示的文件。', 'success');
}

function resetRules(view) {
    if (isBusy(view)) return;
    const defaults = { batchNamePattern: '{name}_{n}{dotext}', batchStartIndex: '1', batchNumberPadding: '1', batchNumberStep: '1', batchFind: '', batchReplace: '', batchCaseMode: 'keep', batchExtensions: '' };
    for (const [id, value] of Object.entries(defaults)) node(view, id).value = value;
    node(view, 'batchPermanent').checked = false;
    const preset = node(view, 'batchRenamePreset'); if (preset) preset.value = 'custom';
    invalidate(view); status(view, '重命名规则与筛选已还原。');
}

function wire(view) {
    const signal = view.controller.signal;
    const on = (id, event, fn) => node(view, id)?.addEventListener(event, fn, { signal });
    on('batchSelectFiles', 'click', () => chooseFiles(view)); on('batchSelectDestination', 'click', () => chooseDestination(view));
    on('batchClearFiles', 'click', () => { if (!isBusy(view)) { view.files = []; invalidate(view, { animate: true }); } });
    view.root.querySelectorAll('input[name="batchOperation"]').forEach(input => input.addEventListener('change', () => updateOperation(view), { signal }));
    for (const id of FIELD_IDS) on(id, 'input', () => { if (id === 'batchNamePattern') { const preset = node(view, 'batchRenamePreset'); if (preset) preset.value = 'custom'; } invalidate(view); });
    on('batchRenamePreset', 'change', event => { const pattern = PRESETS[event.target.value]; if (pattern) { node(view, 'batchNamePattern').value = pattern; invalidate(view); } });
    on('batchSort', 'change', () => invalidate(view, { animate: true }));
    on('batchSearch', 'input', () => { view.limit = 60; render(view); }); on('batchOnlyConflicts', 'change', () => { view.limit = 60; render(view, true); });
    on('batchShowMore', 'click', () => { view.limit += 60; render(view); });
    on('batchPreview', 'click', () => previewBatch(view)); on('batchExecute', 'click', () => executeBatch(view));
    on('batchCancel', 'click', () => cancelBatch(view)); on('batchRestore', 'click', event => restoreBatch(view, event.currentTarget.dataset.recordId));
    on('batchExport', 'click', () => exportList(view)); on('batchResetRules', 'click', () => resetRules(view));
    on('batchHelp', 'click', () => view.motion.open(node(view, 'batchHelpDialog')));
    on('batchConfirmPermanent', 'click', event => {
        event.preventDefault(); if (isBusy(view)) return;
        const valid = view.confirmKey && matchesPreview(view) && view.preview.key === view.confirmKey;
        view.confirmKey = null; view.motion.close(node(view, 'batchDangerDialog'));
        if (valid) startBatch(view); else status(view, '规则已变化，请重新检查后再执行删除。', 'error');
    });
    view.root.addEventListener('click', event => {
        const remove = event.target.closest('[data-batch-remove]');
        if (remove && !isBusy(view)) {
            const index = view.files.findIndex(path => pathKey(path) === pathKey(remove.dataset.batchRemove));
            view.files = view.files.filter(path => pathKey(path) !== pathKey(remove.dataset.batchRemove)); invalidate(view, { animate: true });
            const buttons = [...node(view, 'batchPreviewList').querySelectorAll('.batch-row-remove')]; buttons[Math.min(index, buttons.length - 1)]?.focus({ preventScroll: true });
        }
        const restore = event.target.closest('[data-batch-restore]'); if (restore) restoreBatch(view, restore.dataset.batchRestore);
        const close = event.target.closest('[data-batch-close]'); if (close) { event.preventDefault(); view.confirmKey = null; view.motion.close(close.closest('dialog')); }
        const token = event.target.closest('[data-batch-token]'); if (token && !isBusy(view)) {
            const input = node(view, 'batchNamePattern'); input.setRangeText(token.dataset.batchToken, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end'); input.focus(); invalidate(view);
        }
        const preset = event.target.closest('[data-batch-preset]'); if (preset && PRESETS[preset.dataset.batchPreset] && !isBusy(view)) { node(view, 'batchNamePattern').value = PRESETS[preset.dataset.batchPreset]; invalidate(view); }
    }, { signal });
    for (const dialog of view.root.querySelectorAll('dialog')) {
        dialog.addEventListener('cancel', event => { event.preventDefault(); view.confirmKey = null; view.motion.close(dialog); }, { signal });
        dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) { view.confirmKey = null; view.motion.close(dialog); } } }, { signal });
    }
    document.addEventListener('keydown', event => {
        if (!alive(view)) return;
        const dialog = view.root.querySelector('dialog[open]');
        if (dialog) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); event.stopImmediatePropagation(); chooseFiles(view); }
        else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); previewBatch(view); }
        else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input,textarea,select,[contenteditable="true"]')) { event.preventDefault(); node(view, 'batchSearch').focus(); }
    }, { signal, capture: true });
}

function serialize() {
    const view = currentView; if (!view || !alive(view)) return null;
    const focused = view.root.contains(document.activeElement) ? document.activeElement : null;
    const focus = focused && [...FIELD_IDS, 'batchSearch', 'batchSort', 'batchRenamePreset'].includes(focused.id)
        ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
    return { version: 1, sessionId: view.sessionId, files: view.files, destination: view.destination, operation: view.operation, recordId: view.recordId,
        appliedJobId: view.appliedJobId, resultRecord: view.resultRecord, fields: Object.fromEntries(FIELD_IDS.map(id => [id, node(view, id).type === 'checkbox' ? node(view, id).checked : node(view, id).value])),
        query: node(view, 'batchSearch').value, sort: node(view, 'batchSort').value, onlyConflicts: node(view, 'batchOnlyConflicts').checked,
        history: [...records.values()].filter(record => record.sessionId === view.sessionId).slice(-20).map(record => ({ ...record, restoring: false, launching: false })), focus,
        advanced: view.root.querySelector('.batch-advanced')?.dataset.batchExpanded === 'false' ? false : view.root.querySelector('.batch-advanced')?.open || false, listScroll: node(view, 'batchPreviewList').scrollTop };
}

function restoreHistory(snapshot, view) {
    for (const entry of Array.isArray(snapshot.history) ? snapshot.history.slice(-20) : []) {
        if (!entry || typeof entry.id !== 'string' || entry.id.length > 100 || records.has(entry.id) || entry.sessionId !== view.sessionId
            || !Object.hasOwn(OPERATIONS, entry.request?.operation) || !Array.isArray(entry.request.sources) || entry.request.sources.length > 500
            || !entry.request.sources.every(path => typeof path === 'string') || !Array.isArray(entry.preview?.items) || entry.preview.items.length > 500
            || !entry.preview.items.every(item => typeof item?.source === 'string' && typeof item?.name === 'string' && (item.target == null || typeof item.target === 'string'))
            || !['starting', 'running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(entry.status)) continue;
        const result = entry.result && { processed: Math.max(0, Math.min(entry.preview.items.length, Number(entry.result.processed) || 0)),
            total: entry.preview.items.length, recoveryBatchId: /^file-batch-[a-zA-Z0-9-]{1,69}$/.test(entry.result.recoveryBatchId) ? entry.result.recoveryBatchId : null };
        records.set(entry.id, { ...entry, request: structuredClone(entry.request), preview: structuredClone(entry.preview), result,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(), progress: Math.max(0, Math.min(1, Number(entry.progress) || 0)), restoring: false });
    }
}

async function reconnectRecord(view, record) {
    if (TERMINAL.has(record.status) || record.launching) return;
    try {
        await ensureProgressListener();
        const payload = await invoke('get_file_batch_status', { jobId: record.jobId || record.id });
        if (payload) handleProgress(payload);
        else {
            record.status = 'failed'; record.error = '没有找到这次任务的运行记录，请检查文件状态后重新开始。';
            if (alive(view) && view.recordId === record.id) applyResult(view, record);
        }
    } catch (error) { status(view, `暂时无法重新连接任务：${String(error.message || error)}`, 'error'); }
}

function restore(snapshot) {
    const view = currentView; if (!view || !alive(view) || snapshot?.version !== 1) return;
    view.motion.dispose(); view.root.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    view.preview = null; view.checking = null; view.confirmKey = null; view.revision += 1;
    view.files = mergeSources([], Array.isArray(snapshot.files) ? snapshot.files : []).sources;
    view.destination = typeof snapshot.destination === 'string' ? snapshot.destination.slice(0, 32768) : '';
    view.operation = Object.hasOwn(OPERATIONS, snapshot.operation) ? snapshot.operation : 'rename';
    view.sessionId = typeof snapshot.sessionId === 'string' ? snapshot.sessionId : view.sessionId;
    restoreHistory(snapshot, view);
    view.recordId = records.has(snapshot.recordId) ? snapshot.recordId : null; view.appliedJobId = snapshot.appliedJobId; view.resultRecord = records.has(snapshot.resultRecord) ? snapshot.resultRecord : null;
    for (const id of FIELD_IDS) if (snapshot.fields && Object.hasOwn(snapshot.fields, id)) {
        const field = node(view, id); if (field.type === 'checkbox') field.checked = Boolean(snapshot.fields[id]); else if (typeof snapshot.fields[id] === 'string') field.value = snapshot.fields[id].slice(0, 1000);
    }
    node(view, 'batchSearch').value = typeof snapshot.query === 'string' ? snapshot.query.slice(0, 240) : '';
    node(view, 'batchSort').value = ['manual', 'name-asc', 'name-desc', 'extension'].includes(snapshot.sort) ? snapshot.sort : 'manual';
    node(view, 'batchOnlyConflicts').checked = Boolean(snapshot.onlyConflicts);
    view.root.querySelector(`input[name="batchOperation"][value="${view.operation}"]`).checked = true;
    const panel = node(view, view.operation === 'rename' ? 'batchRenameOptions' : view.operation === 'delete' ? 'batchDeleteOptions' : 'batchDestinationOptions');
    for (const element of node(view, 'batchOptions').children) { element.hidden = element !== panel; element.inert = element !== panel; }
    view.root.dataset.operation = view.operation;
    const advanced = view.root.querySelector('.batch-advanced'); if (advanced) { advanced.open = Boolean(snapshot.advanced); advanced.querySelector('.batch-disclosure-content').inert = !advanced.open; }
    const record = activeRecord(view);
    if (record && TERMINAL.has(record.status)) applyResult(view, record); else { render(view); status(view, isBusy(view) ? '任务正在后台继续处理。' : view.files.length ? '文件与规则已恢复，执行前请重新检查。' : '添加文件，从一份清晰的变更预览开始。'); }
    if (record && !TERMINAL.has(record.status)) reconnectRecord(view, record);
    node(view, 'batchPreviewList').scrollTop = Math.max(0, Number(snapshot.listScroll) || 0);
    if ([...FIELD_IDS, 'batchSearch', 'batchSort', 'batchRenamePreset'].includes(snapshot.focus?.id)) {
        const field = node(view, snapshot.focus.id);
        if (field && !field.disabled && !field.closest('[hidden],[inert]')) {
            field.focus({ preventScroll: true });
            if (['text', 'search'].includes(field.type) && Number.isInteger(snapshot.focus.start) && Number.isInteger(snapshot.focus.end)) field.setSelectionRange(snapshot.focus.start, snapshot.focus.end);
        }
    }
}

async function initFileBatchTool() {
    destroyFileBatchTool();
    const root = document.querySelector('.batch-tool-shell'); if (!root) return;
    const view = { root, controller: new AbortController(), files: [], destination: '', operation: 'rename', sessionId: crypto.randomUUID(), revision: 0,
        preview: null, checking: null, recordId: null, resultRecord: null, appliedJobId: null, limit: 60, urls: new Set(), timers: new Set() };
    currentView = view; view.motion = createBatchMotion(view.controller.signal); wire(view); updateOperation(view, false);
    try { await ensureProgressListener(); } catch { /* Native availability is explained when a file action is requested. */ }
}

function destroyFileBatchTool() {
    const view = currentView; if (!view) return;
    view.root.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    view.controller.abort(); view.motion.dispose();
    for (const url of view.urls) URL.revokeObjectURL(url); for (const timer of view.timers) clearTimeout(timer);
    currentView = null;
    // One application-level listener keeps in-flight results and recovery actions intact while changing pages.
}

registerTool({ id: 'file-batch', name: '文件批处理', icon: 'ri-file-list-3-line', colorClass: 'tool-card__icon--cyan', category: 'utility', status: 'ready',
    description: '实时预览、编号与查找替换，批量重命名、复制、移动和可恢复删除。', template: getTemplate,
    init: initFileBatchTool, destroy: destroyFileBatchTool, serialize, restore,
    getPagePanel: () => ({ summary: currentView ? `${currentView.files.length} 个文件 · ${OPERATIONS[currentView.operation]}` : '文件批处理',
        status: currentView ? node(currentView, 'batchStatus')?.textContent : '', actions: [{ id: 'add', label: '添加文件', icon: 'ri-folder-open-line' }, { id: 'check', label: '检查变更', icon: 'ri-check-line' }] }),
    runPageAction: action => { const view = currentView; if (!view || !alive(view)) return; if (action === 'add') return chooseFiles(view); if (action === 'check') return previewBatch(view); }
});

export { destroyFileBatchTool, initFileBatchTool };
