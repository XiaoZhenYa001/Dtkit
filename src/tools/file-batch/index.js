import { registerTool } from '../toolRegistry.js';
import '../../css/tools/file-batch.css';

let abortController = null;
let unlistenProgress = null;
let selectedFiles = [];
let destination = '';
let activeJobId = null;
let lastPreview = null;
const pendingProgress = new Map();

function getTemplate() {
    return `
        <div class="batch-tool-shell">
            <header class="batch-hero">
                <div>
                    <span class="batch-kicker">FILE BATCH</span>
                    <h2>文件批处理</h2>
                    <p>显式选择、先预检再执行；不覆盖已有文件，任务由原生后台按需处理。</p>
                </div>
                <span class="batch-limit"><i class="ri-speed-line"></i> 单次最多 500 个文件</span>
            </header>

            <div class="batch-layout">
                <section class="batch-config-card">
                    <div class="batch-section-heading">
                        <div><span>01</span><strong>选择文件</strong></div>
                        <button id="batchSelectFiles" class="batch-button batch-button--secondary" type="button">
                            <i class="ri-folder-open-line"></i> 选择文件
                        </button>
                    </div>
                    <div id="batchSelectionSummary" class="batch-selection batch-selection--empty">尚未选择文件</div>

                    <div class="batch-section-heading batch-section-heading--spaced">
                        <div><span>02</span><strong>处理方式</strong></div>
                    </div>
                    <div class="batch-operation-grid" role="radiogroup" aria-label="批处理方式">
                        <label><input type="radio" name="batchOperation" value="rename" checked><span><i class="ri-text"></i>重命名</span></label>
                        <label><input type="radio" name="batchOperation" value="copy"><span><i class="ri-file-copy-line"></i>复制</span></label>
                        <label><input type="radio" name="batchOperation" value="move"><span><i class="ri-folder-download-line"></i>移动</span></label>
                        <label><input type="radio" name="batchOperation" value="delete"><span><i class="ri-delete-bin-line"></i>删除</span></label>
                    </div>

                    <div id="batchRenameOptions" class="batch-options-grid">
                        <label class="batch-field batch-field--wide">
                            <span>文件名模板</span>
                            <input id="batchNamePattern" type="text" value="{name}_{n}{dotext}" autocomplete="off">
                            <small>{name} 原名 · {n} 序号 · {dotext} 点号与扩展名</small>
                        </label>
                        <label class="batch-field">
                            <span>起始序号</span>
                            <input id="batchStartIndex" type="number" min="0" max="999999" value="1">
                        </label>
                    </div>

                    <div id="batchDestinationOptions" class="batch-destination" hidden>
                        <div><span>目标文件夹</span><strong id="batchDestinationPath">尚未选择</strong></div>
                        <button id="batchSelectDestination" class="batch-button batch-button--secondary" type="button">选择文件夹</button>
                    </div>

                    <label class="batch-field batch-filter-field">
                        <span>扩展名筛选（可选）</span>
                        <input id="batchExtensions" type="text" placeholder="例如：jpg, png, pdf" autocomplete="off">
                        <small>留空处理全部已选文件；筛选由原生侧再次校验。</small>
                    </label>

                    <div id="batchDeleteOptions" class="batch-delete-options" hidden>
                        <div><i class="ri-archive-line"></i><span>默认删除会移入 DtKit 恢复区，可在完成后恢复。</span></div>
                        <label><input id="batchPermanent" type="checkbox"><span>彻底删除，不进入恢复区</span></label>
                    </div>

                    <div class="batch-actions">
                        <button id="batchPreview" class="batch-button batch-button--secondary" type="button">预检变更</button>
                        <button id="batchExecute" class="batch-button batch-button--primary" type="button" disabled>确认执行</button>
                    </div>
                    <p id="batchStatus" class="batch-status" role="status" aria-live="polite">选择文件后进行预检。</p>
                </section>

                <section class="batch-preview-card" aria-labelledby="batchPreviewTitle">
                    <div class="batch-preview-header">
                        <div><span class="batch-kicker">PREVIEW</span><h3 id="batchPreviewTitle">变更预览</h3></div>
                        <span id="batchPreviewMeta">等待预检</span>
                    </div>
                    <div id="batchPreviewList" class="batch-preview-list">
                        <div class="batch-empty-state"><i class="ri-file-list-3-line"></i><strong>不会直接执行</strong><span>预检会显示目标名称和冲突。</span></div>
                    </div>
                    <div id="batchProgressPanel" class="batch-progress" hidden>
                        <div><strong id="batchProgressLabel">正在处理</strong><span id="batchProgressValue">0%</span></div>
                        <progress id="batchProgressBar" max="1" value="0"></progress>
                        <div class="batch-progress-actions">
                            <button id="batchCancel" class="batch-button batch-button--secondary" type="button">取消任务</button>
                            <button id="batchRestore" class="batch-button batch-button--secondary" type="button" hidden>恢复本批文件</button>
                        </div>
                    </div>
                </section>
            </div>

            <dialog id="batchDangerDialog" class="batch-danger-dialog" aria-labelledby="batchDangerTitle">
                <form method="dialog">
                    <div class="batch-danger-icon"><i class="ri-error-warning-line"></i></div>
                    <h3 id="batchDangerTitle">确认彻底删除？</h3>
                    <p>这些文件不会进入恢复区，也无法通过 DtKit 撤销。请确认你已经检查预览列表。</p>
                    <div><button value="cancel" class="batch-button batch-button--secondary">返回检查</button>
                    <button id="batchConfirmPermanent" value="default" class="batch-button batch-button--danger">仍然彻底删除</button></div>
                </form>
            </dialog>
        </div>
    `;
}

const byId = id => document.getElementById(id);
const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);

function operation() {
    return document.querySelector('input[name="batchOperation"]:checked')?.value || 'rename';
}

function parseExtensions() {
    return byId('batchExtensions').value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean);
}

function requestPayload() {
    return {
        sources: selectedFiles,
        operation: operation(),
        destination: destination || null,
        namePattern: byId('batchNamePattern').value,
        startIndex: Number(byId('batchStartIndex').value) || 0,
        extensions: parseExtensions(),
        permanent: byId('batchPermanent').checked
    };
}

function setStatus(message, type = '') {
    const element = byId('batchStatus');
    element.textContent = message;
    element.dataset.type = type;
}

function invalidatePreview() {
    lastPreview = null;
    byId('batchExecute').disabled = true;
    byId('batchPreviewMeta').textContent = '设置已变化，请重新预检';
}

function updateOperation() {
    const value = operation();
    byId('batchRenameOptions').hidden = value !== 'rename';
    byId('batchDestinationOptions').hidden = value !== 'copy' && value !== 'move';
    byId('batchDeleteOptions').hidden = value !== 'delete';
    if (value !== 'delete') byId('batchPermanent').checked = false;
    invalidatePreview();
}

function renderSelection() {
    const summary = byId('batchSelectionSummary');
    if (!selectedFiles.length) {
        summary.className = 'batch-selection batch-selection--empty';
        summary.textContent = '尚未选择文件';
        return;
    }
    summary.className = 'batch-selection';
    summary.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = `已选择 ${selectedFiles.length} 个文件`;
    const names = document.createElement('span');
    names.textContent = selectedFiles.slice(0, 3).map(path => path.split(/[\\/]/).pop()).join('、') + (selectedFiles.length > 3 ? '…' : '');
    summary.append(strong, names);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function renderPreview(preview) {
    const list = byId('batchPreviewList');
    const fragment = document.createDocumentFragment();
    preview.items.slice(0, 80).forEach(item => {
        const row = document.createElement('div');
        row.className = `batch-preview-row${item.conflict ? ' batch-preview-row--conflict' : ''}`;
        const identity = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = item.name;
        const source = document.createElement('small');
        source.textContent = item.source;
        identity.append(name, source);
        const arrow = document.createElement('i');
        arrow.className = item.conflict ? 'ri-error-warning-line' : 'ri-arrow-right-line';
        const target = document.createElement('span');
        target.textContent = item.conflict || item.target || (preview.permanent ? '彻底删除' : '移入恢复区');
        row.append(identity, arrow, target);
        fragment.append(row);
    });
    if (preview.items.length > 80) {
        const more = document.createElement('div');
        more.className = 'batch-preview-more';
        more.textContent = `其余 ${preview.items.length - 80} 项已完成原生预检，为减少内存不在此展开。`;
        fragment.append(more);
    }
    list.replaceChildren(fragment);
    byId('batchPreviewMeta').textContent = `${preview.items.length} 项 · ${formatBytes(preview.totalBytes)}${preview.skipped ? ` · 跳过 ${preview.skipped}` : ''}`;
    byId('batchExecute').disabled = preview.hasConflicts;
    setStatus(preview.hasConflicts ? '检测到冲突；DtKit 不会覆盖目标文件。' : '预检通过，可以执行。', preview.hasConflicts ? 'error' : 'success');
}

async function previewBatch() {
    if (!selectedFiles.length) return setStatus('请先选择文件。', 'error');
    setStatus('正在由原生侧检查路径和冲突…');
    byId('batchPreview').disabled = true;
    try {
        lastPreview = await invoke('preview_file_batch', { request: requestPayload() });
        renderPreview(lastPreview);
    } catch (error) {
        lastPreview = null;
        byId('batchExecute').disabled = true;
        setStatus(String(error), 'error');
    } finally {
        byId('batchPreview').disabled = false;
    }
}

function setBusy(busy) {
    document.querySelectorAll('.batch-config-card input, .batch-config-card button').forEach(element => {
        if (element.id !== 'batchCancel') element.disabled = busy;
    });
    byId('batchProgressPanel').hidden = !busy && !activeJobId;
}

async function executeBatch() {
    if (!lastPreview) return setStatus('请先重新预检。', 'error');
    if (operation() === 'delete' && byId('batchPermanent').checked) {
        byId('batchDangerDialog').showModal();
        return;
    }
    await startBatch();
}

async function startBatch() {
    setBusy(true);
    byId('batchProgressPanel').hidden = false;
    byId('batchProgressLabel').textContent = '正在准备后台任务';
    try {
        const started = await invoke('start_file_batch', { request: requestPayload() });
        activeJobId = started.jobId;
        byId('batchProgressLabel').textContent = `正在处理 ${started.fileCount} 个文件`;
        setStatus('任务已交给原生后台；关闭当前页面也会继续执行。');
        const pending = pendingProgress.get(activeJobId);
        if (pending) {
            pendingProgress.delete(activeJobId);
            handleProgress(pending);
        }
    } catch (error) {
        activeJobId = null;
        setBusy(false);
        setStatus(String(error), 'error');
    }
}

function handleProgress(payload) {
    if (!activeJobId || payload.jobId !== activeJobId) {
        if (payload?.jobId) {
            pendingProgress.set(payload.jobId, payload);
            if (pendingProgress.size > 8) pendingProgress.delete(pendingProgress.keys().next().value);
        }
        return;
    }
    byId('batchProgressBar').value = payload.progress;
    byId('batchProgressValue').textContent = `${Math.round(payload.progress * 100)}%`;
    if (payload.status === 'completed' || payload.status === 'cancelled' || payload.status === 'failed') {
        setBusy(false);
        byId('batchCancel').hidden = true;
        byId('batchProgressLabel').textContent = payload.status === 'completed' ? '处理完成' : payload.status === 'cancelled' ? '任务已取消' : '处理失败';
        if (payload.result?.recoveryBatchId) {
            byId('batchRestore').hidden = false;
            byId('batchRestore').dataset.batchId = payload.result.recoveryBatchId;
        }
        setStatus(payload.error || `${payload.result?.processed || 0} 个文件已处理。`, payload.status === 'completed' ? 'success' : 'error');
        activeJobId = null;
        invalidatePreview();
    }
}

async function initFileBatchTool() {
    abortController?.abort();
    if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
    abortController = new AbortController();
    const { signal } = abortController;
    selectedFiles = [];
    destination = '';
    activeJobId = null;
    lastPreview = null;
    pendingProgress.clear();

    byId('batchSelectFiles')?.addEventListener('click', async () => {
        const result = await globalThis.window?.__TAURI__?.dialog?.open({ multiple: true, directory: false, title: '选择要批量处理的文件' });
        selectedFiles = Array.isArray(result) ? result.slice(0, 500) : result ? [result] : [];
        renderSelection();
        invalidatePreview();
        if (Array.isArray(result) && result.length > 500) setStatus('仅保留前 500 个文件。', 'error');
    }, { signal });
    byId('batchSelectDestination')?.addEventListener('click', async () => {
        const result = await globalThis.window?.__TAURI__?.dialog?.open({ directory: true, multiple: false, title: '选择目标文件夹' });
        if (!result || Array.isArray(result)) return;
        destination = result;
        byId('batchDestinationPath').textContent = result;
        invalidatePreview();
    }, { signal });
    document.querySelectorAll('input[name="batchOperation"]').forEach(input => input.addEventListener('change', updateOperation, { signal }));
    ['batchNamePattern', 'batchStartIndex', 'batchExtensions', 'batchPermanent'].forEach(id => byId(id)?.addEventListener('input', invalidatePreview, { signal }));
    byId('batchPreview')?.addEventListener('click', previewBatch, { signal });
    byId('batchExecute')?.addEventListener('click', executeBatch, { signal });
    byId('batchConfirmPermanent')?.addEventListener('click', event => {
        event.preventDefault();
        byId('batchDangerDialog').close();
        startBatch();
    }, { signal });
    byId('batchCancel')?.addEventListener('click', async () => {
        if (activeJobId) await invoke('cancel_job', { jobId: activeJobId });
    }, { signal });
    byId('batchRestore')?.addEventListener('click', async event => {
        try {
            const restored = await invoke('restore_file_batch', { batchId: event.currentTarget.dataset.batchId });
            event.currentTarget.hidden = true;
            setStatus(`已恢复 ${restored.restored} 个文件${restored.skipped ? `，跳过 ${restored.skipped} 个冲突项` : ''}。`, 'success');
        } catch (error) { setStatus(String(error), 'error'); }
    }, { signal });

    const listen = globalThis.window?.__TAURI__?.event?.listen;
    if (listen) {
        const unlisten = await listen('file-batch-progress', event => handleProgress(event.payload));
        if (signal.aborted) unlisten(); else unlistenProgress = unlisten;
    }
    renderSelection();
    updateOperation();
}

function destroyFileBatchTool() {
    abortController?.abort();
    abortController = null;
    if (unlistenProgress) unlistenProgress();
    unlistenProgress = null;
    selectedFiles = [];
    destination = '';
    lastPreview = null;
    pendingProgress.clear();
}

registerTool({
    id: 'file-batch', name: '文件批处理', icon: 'ri-file-list-3-line',
    colorClass: 'tool-card__icon--cyan', category: 'utility', status: 'ready',
    description: '安全预检后批量重命名、复制、移动或删除文件。',
    template: getTemplate, init: initFileBatchTool, destroy: destroyFileBatchTool
});

export { destroyFileBatchTool, initFileBatchTool };
