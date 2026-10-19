import { registerTool } from '../toolRegistry.js';
import { mountSegmentedControl, revealContent, transitionLayout } from '../../core/toolMotion.js';
import { validateHashResults, inspectHashVerification, formatHashBytes, textByteLength } from './core.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/hash-tool.css';

let state = null;
const DEFAULT_ALGORITHMS = ['md5', 'sha1', 'sha256'];
const LABELS = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
const LENGTHS = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };

function getTemplate() {
    return `<div class="view-container dev-workbench hash-tool-view">
        <header class="dw-header"><div><p class="dw-eyebrow">CHECKSUM WORKSPACE</p><h1 class="dw-title">MD5 / Hash</h1>
            <p class="dw-subtitle">为文本与文件，生成一份准确的指纹。</p></div><span class="dw-chip">本地计算</span></header>
        <div class="hash-layout hash-glass-container">
            <main class="hash-main-panel" aria-label="输入与计算结果">
                <section class="dw-card hash-input-card">
                    <header class="dw-card-header"><div id="hashModeGroup" class="dw-segmented" role="group" aria-label="计算来源">
                        <button type="button" data-hash-mode="text" aria-pressed="true">文本</button>
                        <button type="button" data-hash-mode="file" aria-pressed="false">文件</button></div>
                        <span id="hashInputMeta" class="dw-label">0 字节 · UTF-8</span></header>
                    <div id="hashInputPanels">
                        <div id="hashTextPanel" class="hash-source-panel"><label class="hash-sr-only" for="hashTextInput">需要计算的文本</label>
                            <textarea id="hashTextInput" class="dw-mono hash-textarea" spellcheck="false" placeholder="输入文本，或直接计算空文本的摘要…"></textarea>
                            <div class="hash-input-actions dw-actions"><button id="hashPasteBtn" class="dw-button" type="button">粘贴文本</button>
                                <button id="hashClearTextBtn" class="dw-button" type="button">清空</button><span class="dw-status">保留空格与换行</span></div></div>
                        <div id="hashFilePanel" class="hash-source-panel" hidden>
                            <div id="hashFileUpload" class="hash-file-upload"><i class="ri-upload-cloud-2-line" aria-hidden="true"></i>
                                <p id="hashFileName">将文件拖放到这里</p><span id="hashFileMeta" class="dw-status">文件在本机读取与计算。</span>
                                <div class="dw-actions"><button id="hashChooseFileBtn" class="dw-button" type="button">选择文件</button>
                                    <button class="dw-button hash-clear-file" type="button" hidden>移除文件</button></div></div>
                            <input type="file" id="hashFileInput" hidden></div>
                    </div>
                </section>
                <div id="hashProgressContainer" class="hash-progress-container" hidden>
                    <div class="hash-progress-heading"><span id="hashProgressLabel">正在计算…</span><button id="hashCancelBtn" type="button" class="dw-button">取消等待</button></div>
                    <div class="hash-progress-track" role="progressbar" aria-label="Hash 计算进度" aria-valuemin="0" aria-valuemax="100"><div id="hashProgressBar" class="hash-progress-bar"></div></div>
                </div>
                <section id="hashResultsSection" class="dw-card hash-results-container" data-stale="false">
                    <header class="dw-card-header"><h2 class="dw-card-title">计算结果</h2><button id="hashCopyAllBtn" type="button" class="dw-button" disabled>复制全部</button></header>
                    <div id="hashResultsList"><div class="dw-empty hash-empty-results">选择算法，点击计算。空文本也有自己的摘要。</div></div>
                </section>
                <section class="dw-card hash-verify-section"><header class="dw-card-header"><h2 class="dw-card-title">核对摘要</h2><span class="dw-label">忽略大小写</span></header>
                    <div class="dw-card-body"><label class="hash-sr-only" for="hashVerifyInput">要核对的十六进制摘要</label>
                        <input id="hashVerifyInput" class="dw-control dw-mono hash-verify-input" type="text" spellcheck="false" autocomplete="off" placeholder="粘贴一串十六进制摘要…">
                        <p id="hashVerifyResult" class="dw-status hash-verify-result" role="status" aria-live="polite"></p></div></section>
                <p id="hashStatus" class="dw-status" role="status" aria-live="polite">准备就绪 · Ctrl / ⌘ + Enter 计算</p>
            </main>
            <aside class="dw-card hash-config-panel" aria-label="计算设置">
                <div class="hash-config-heading"><p class="dw-eyebrow">ALGORITHMS</p><h2 class="dw-card-title">算法与输出</h2><p class="dw-status">可以同时计算多种摘要。</p></div>
                ${Object.entries(LABELS).map(([id, label]) => `<div class="hash-switch-group"><div><span class="hash-algorithm-label">${label}</span><p class="dw-status">${LENGTHS[id]} 位十六进制</p></div>
                    <button class="hash-switch${DEFAULT_ALGORITHMS.includes(id) ? ' active' : ''}" type="button" role="switch" aria-checked="${DEFAULT_ALGORITHMS.includes(id)}" aria-label="${label}" data-algo="${id}"><span></span></button></div>`).join('')}
                <div class="hash-switch-group hash-switch-group--separated"><div><span class="hash-algorithm-label">大写输出</span><p class="dw-status">仅改变显示，不影响摘要。</p></div>
                    <button class="hash-switch active" type="button" role="switch" aria-checked="true" aria-label="大写输出" data-option="uppercase"><span></span></button></div>
                <button id="hashCalculateBtn" class="dw-button dw-button--primary hash-btn-calculate" type="button">计算摘要</button>
                <p class="dw-status hash-shortcut">Ctrl / ⌘ + Enter 快速计算</p>
                <div class="hash-security-tip"><h3>选择合适的算法</h3><p class="dw-status">一般文件校验可使用 SHA-256。MD5 与 SHA-1 适合兼容既有校验值。</p><p class="dw-status">输入中的每个空格、换行和字节都会参与计算。</p></div>
            </aside>
        </div></div>`;
}

function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function node(view, id) { return view.root.querySelector('#' + id); }
function status(view, message, tone = '') { const target = node(view, 'hashStatus'); target.textContent = message; target.dataset.tone = tone; }
function selectedAlgorithms(view) { return Object.keys(LABELS).filter(id => view.algorithms.includes(id)); }
function displayHash(view, hash) { return view.uppercase ? hash.toUpperCase() : hash.toLowerCase(); }
function updateVerification(view) {
    const result = inspectHashVerification(node(view, 'hashVerifyInput').value, view.results, view.valid);
    const target = node(view, 'hashVerifyResult'); target.textContent = result.message; target.dataset.tone = result.tone;
    target.classList.toggle('match', result.tone === 'success'); target.classList.toggle('mismatch', result.tone === 'error');
    node(view, 'hashVerifyInput').setAttribute('aria-invalid', String(result.tone === 'error'));
}
function updateActions(view) {
    node(view, 'hashCalculateBtn').disabled = Boolean(view.job);
    node(view, 'hashCalculateBtn').textContent = view.job ? '正在计算…' : '计算摘要';
    node(view, 'hashResultsList').setAttribute('aria-busy', String(Boolean(view.job)));
    node(view, 'hashCopyAllBtn').disabled = !view.valid;
    view.root.querySelectorAll('.hash-copy-btn').forEach(button => { button.disabled = !view.valid; });
    node(view, 'hashResultsSection').dataset.stale = String(!view.valid && Object.keys(view.results).length > 0);
    node(view, 'hashProgressContainer').hidden = !view.job;
}
function renderResults(view, animate = false) {
    const list = node(view, 'hashResultsList'); const children = [];
    for (const id of Object.keys(LABELS)) {
        if (!view.results[id]) continue;
        const row = document.createElement('div'); row.className = 'hash-result-pill'; row.dataset.algo = id;
        const name = document.createElement('span'); name.className = 'hash-algo-tag'; name.textContent = LABELS[id];
        const hash = document.createElement('code'); hash.className = 'hash-string dw-mono'; hash.textContent = displayHash(view, view.results[id]);
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'dw-button hash-copy-btn'; copy.dataset.algo = id;
        copy.textContent = '复制'; copy.setAttribute('aria-label', `复制 ${LABELS[id]} 摘要`); row.append(name, hash, copy); children.push(row);
    }
    if (!children.length) { const empty = document.createElement('div'); empty.className = 'dw-empty hash-empty-results'; empty.textContent = '选择算法，点击计算。空文本也有自己的摘要。'; children.push(empty); }
    list.replaceChildren(...children); updateActions(view); updateVerification(view);
    if (animate) revealContent(list, { signal: view.controller.signal, distance: 4 });
}
function updateInputMeta(view) {
    node(view, 'hashInputMeta').textContent = view.mode === 'text' ? `${textByteLength(node(view, 'hashTextInput').value).toLocaleString()} 字节 · UTF-8`
        : view.file ? (Number.isFinite(view.file.size) ? formatHashBytes(view.file.size) : '大小将在计算时读取') : '未选择文件';
}
function updateSettings(view) {
    view.root.querySelectorAll('[data-hash-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.hashMode === view.mode)));
    node(view, 'hashTextPanel').hidden = view.mode !== 'text'; node(view, 'hashFilePanel').hidden = view.mode !== 'file';
    view.root.querySelectorAll('.hash-switch[data-algo]').forEach(button => { const checked = view.algorithms.includes(button.dataset.algo); button.setAttribute('aria-checked', String(checked)); button.classList.toggle('active', checked); });
    const uppercase = view.root.querySelector('[data-option="uppercase"]'); uppercase.setAttribute('aria-checked', String(view.uppercase)); uppercase.classList.toggle('active', view.uppercase);
    updateInputMeta(view);
}
function renderFile(view) {
    const file = view.file; node(view, 'hashFileName').textContent = file?.name || '将文件拖放到这里';
    node(view, 'hashFileMeta').textContent = file?.needsReselect ? '此浏览器文件需要重新选择，才能继续计算。'
        : file ? (Number.isFinite(file.size) ? formatHashBytes(file.size) : '大小将在计算时读取') : '文件在本机读取与计算。';
    node(view, 'hashChooseFileBtn').textContent = file?.needsReselect ? '重新选择文件' : file ? '更换文件' : '选择文件';
    view.root.querySelector('.hash-clear-file').hidden = !file;
    node(view, 'hashFileUpload').classList.toggle('has-file', Boolean(file)); updateInputMeta(view);
}
function resetIo(view) { view.ioGeneration++; view.choosing = false; view.pasting = false; node(view, 'hashChooseFileBtn').disabled = false; node(view, 'hashPasteBtn').disabled = false; }
function cancelJob(view) {
    const job = view.job; if (!job) return;
    view.job = null; job.worker?.terminate(); job.reject?.(new DOMException('计算已取消', 'AbortError')); updateActions(view);
}
function invalidate(view, message = '输入或算法已更新，请重新计算。') {
    view.revision++; cancelJob(view); view.valid = false; resetIo(view); updateActions(view); updateVerification(view); updateInputMeta(view); status(view, message);
}
function selectFile(view, file) {
    if (!active(view)) return;
    view.file = file; view.mode = 'file'; invalidate(view, '文件已就绪，点击计算摘要。');
    transitionLayout(node(view, 'hashInputPanels'), () => { updateSettings(view); renderFile(view); }, { signal: view.controller.signal });
}
async function chooseFile(view) {
    if (view.choosing) return;
    const open = window.__TAURI__?.dialog?.open;
    if (!open) { node(view, 'hashFileInput').click(); return; }
    const token = ++view.ioGeneration; const revision = view.revision;
    view.choosing = true; node(view, 'hashChooseFileBtn').disabled = true;
    try {
        const path = await open({ multiple: false, title: '选择要计算摘要的文件' });
        if (!active(view) || view.suspended || revision !== view.revision || token !== view.ioGeneration) return;
        if (typeof path === 'string' && path) selectFile(view, { name: path.split(/[/\\]/).pop() || path, path, size: null });
    } catch (error) {
        if (active(view) && !view.suspended && revision === view.revision && token === view.ioGeneration) status(view, `无法选择文件：${error?.message || error}`, 'error');
    } finally {
        if (active(view) && token === view.ioGeneration) { view.choosing = false; node(view, 'hashChooseFileBtn').disabled = false; }
    }
}
async function paste(view) {
    if (view.pasting) return;
    const token = ++view.ioGeneration; const revision = view.revision;
    view.pasting = true; node(view, 'hashPasteBtn').disabled = true;
    try {
        const text = await navigator.clipboard.readText();
        if (!active(view) || view.suspended || revision !== view.revision || token !== view.ioGeneration) return;
        node(view, 'hashTextInput').value = text; invalidate(view); node(view, 'hashTextInput').focus({ preventScroll: true });
    } catch {
        if (active(view) && !view.suspended && revision === view.revision && token === view.ioGeneration) status(view, '无法读取剪贴板，请使用 Ctrl + V。', 'error');
    } finally {
        if (active(view) && token === view.ioGeneration) { view.pasting = false; node(view, 'hashPasteBtn').disabled = false; }
    }
}
async function copy(view, algorithm = null) {
    if (!view.valid) return;
    const revision = view.revision;
    const value = algorithm ? displayHash(view, view.results[algorithm]) : Object.keys(LABELS).filter(id => view.results[id]).map(id => `${LABELS[id]}: ${displayHash(view, view.results[id])}`).join('\n');
    try { await navigator.clipboard.writeText(value); if (active(view) && !view.suspended && view.valid && revision === view.revision) status(view, algorithm ? `${LABELS[algorithm]} 摘要已复制` : '全部摘要已复制', 'success'); }
    catch { if (active(view) && !view.suspended && revision === view.revision) status(view, '复制失败，请选择摘要手动复制。', 'error'); }
}
function currentJob(view, job) { return active(view) && view.job === job && view.revision === job.revision; }
function progress(view, percent, detail = '') {
    const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
    const track = view.root.querySelector('.hash-progress-track'); track.classList.toggle('is-indeterminate', value === null);
    if (value === null) track.removeAttribute('aria-valuenow'); else track.setAttribute('aria-valuenow', String(Math.round(value)));
    node(view, 'hashProgressBar').style.width = value === null ? '35%' : `${value}%`;
    node(view, 'hashProgressLabel').textContent = detail || (value === null ? '正在计算…' : `正在计算 ${Math.round(value)}%`);
}
async function workerHashes(view, job, input, algorithms) {
    let payload;
    if (typeof input === 'string') payload = { text: input };
    else { progress(view, null, '正在读取文件…'); payload = { bytes: await input.arrayBuffer() }; }
    if (!currentJob(view, job)) throw new DOMException('计算已取消', 'AbortError');
    return new Promise((resolve, reject) => {
        job.reject = reject;
        try {
            const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); job.worker = worker;
            worker.onmessage = event => { if (event.data?.id !== job.id || !currentJob(view, job)) return;
                if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.results); };
            worker.onerror = event => { event.preventDefault(); reject(new Error('计算线程无法运行，请重试。')); };
            worker.addEventListener('messageerror', () => reject(new Error('无法读取计算线程结果，请重试。')), { once: true });
            progress(view, null, '正在计算摘要…'); worker.postMessage({ id: job.id, ...payload, algorithms }, payload.bytes ? [payload.bytes] : []);
        } catch (error) { reject(error); }
    });
}
async function calculate(view) {
    if (!active(view) || view.suspended || view.job) return;
    const algorithms = selectedAlgorithms(view);
    if (!algorithms.length) { status(view, '请至少选择一种算法。', 'error'); return; }
    if (view.mode === 'file' && (!view.file || view.file.needsReselect)) { status(view, view.file?.needsReselect ? '请重新选择此浏览器文件。' : '请先选择文件。', 'error'); return; }
    const job = { id: crypto.randomUUID(), revision: view.revision, mode: view.mode, worker: null, reject: null };
    const file = view.file; const text = node(view, 'hashTextInput').value; const invoke = window.__TAURI__?.core?.invoke;
    view.job = job; view.valid = false; resetIo(view); updateActions(view); updateVerification(view); progress(view, null); status(view, '正在计算摘要…');
    try {
        let results;
        if (invoke && job.mode === 'text') results = await invoke('calculate_text_hash', { text, algorithms, uppercase: false });
        else if (invoke && file?.path) {
            await view.progressReady; if (!currentJob(view, job)) return;
            results = await invoke('calculate_file_hash', { filePath: file.path, algorithms, uppercase: false, taskId: job.id });
        } else {
            if (job.mode === 'file' && !file.file) throw new Error('此文件路径需要在桌面应用中读取，请重新选择文件。');
            results = await workerHashes(view, job, job.mode === 'text' ? text : file.file, algorithms);
        }
        if (!currentJob(view, job)) return;
        view.results = validateHashResults(results, algorithms); view.valid = true; view.resultMode = job.mode;
        renderResults(view, true); status(view, `${job.mode === 'text' ? '文本' : '文件'}摘要已完成 · ${algorithms.length} 种算法`, 'success');
    } catch (error) {
        if (currentJob(view, job) && error?.name !== 'AbortError') { view.valid = false; updateVerification(view); status(view, `计算失败：${error?.message || error}`, 'error'); }
    } finally {
        job.worker?.terminate(); job.reject = null;
        if (currentJob(view, job)) { view.job = null; updateActions(view); }
    }
}
async function listenProgress(view) {
    const listen = window.__TAURI__?.event?.listen; if (!listen) return;
    try {
        const unlisten = await listen('hash-progress', event => {
            const payload = event.payload; const job = view.job;
            if (!job || !currentJob(view, job) || job.mode !== 'file' || payload?.taskId !== job.id) return;
            if (Number.isFinite(payload.totalBytes) && payload.totalBytes >= 0 && view.file) { view.file.size = payload.totalBytes; renderFile(view); }
            const percentage = Number.isFinite(payload.progress) ? Math.max(0, Math.min(100, payload.progress)) : null;
            progress(view, percentage, Number.isFinite(payload.bytesProcessed) && Number.isFinite(payload.totalBytes)
                ? `${formatHashBytes(payload.bytesProcessed)} / ${formatHashBytes(payload.totalBytes)}${percentage === null ? '' : ` · ${Math.round(percentage)}%`}` : '');
        });
        if (active(view)) view.unlisten = unlisten; else unlisten();
    } catch { if (active(view)) view.unlisten = null; }
}

export function initHashTool() {
    destroyHashTool(); const root = document.querySelector('.hash-tool-view'); if (!root) return;
    const view = { root, controller: new AbortController(), mode: 'text', file: null, algorithms: [...DEFAULT_ALGORITHMS], uppercase: true,
        results: {}, valid: false, resultMode: null, revision: 0, ioGeneration: 0, job: null, unlisten: null, choosing: false, pasting: false,
        suspended: document.documentElement.classList.contains('app-is-suspended') };
    state = view; const { signal } = view.controller; const on = (target, name, callback) => target.addEventListener(name, callback, { signal });
    on(node(view, 'hashTextInput'), 'input', () => invalidate(view));
    on(node(view, 'hashVerifyInput'), 'input', () => updateVerification(view));
    root.querySelectorAll('[data-hash-mode]').forEach(button => on(button, 'click', () => {
        if (view.mode === button.dataset.hashMode) return; view.mode = button.dataset.hashMode; invalidate(view);
        transitionLayout(node(view, 'hashInputPanels'), () => updateSettings(view), { signal }); revealContent(node(view, view.mode === 'text' ? 'hashTextPanel' : 'hashFilePanel'), { signal, distance: 4 });
    }));
    root.querySelectorAll('.hash-switch[data-algo]').forEach(button => on(button, 'click', () => {
        const id = button.dataset.algo; view.algorithms = view.algorithms.includes(id) ? view.algorithms.filter(value => value !== id) : [...view.algorithms, id];
        invalidate(view); updateSettings(view);
    }));
    on(root.querySelector('[data-option="uppercase"]'), 'click', () => { view.uppercase = !view.uppercase; updateSettings(view); renderResults(view); });
    on(node(view, 'hashChooseFileBtn'), 'click', () => { void chooseFile(view); });
    on(node(view, 'hashFileInput'), 'change', event => { const file = event.target.files?.[0]; if (file) selectFile(view, { name: file.name, size: file.size, path: typeof file.path === 'string' ? file.path : null, file }); event.target.value = ''; });
    on(root.querySelector('.hash-clear-file'), 'click', () => { view.file = null; invalidate(view, '文件已移除。'); renderFile(view); });
    const drop = node(view, 'hashFileUpload');
    on(drop, 'dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
    on(drop, 'dragleave', event => { if (!drop.contains(event.relatedTarget)) drop.classList.remove('dragover'); });
    on(drop, 'drop', event => { event.preventDefault(); drop.classList.remove('dragover'); const file = event.dataTransfer.files?.[0]; if (file) selectFile(view, { name: file.name, size: file.size, path: typeof file.path === 'string' ? file.path : null, file }); });
    on(node(view, 'hashPasteBtn'), 'click', () => { void paste(view); });
    on(node(view, 'hashClearTextBtn'), 'click', () => { node(view, 'hashTextInput').value = ''; invalidate(view, '文本已清空，可以计算空文本摘要。'); node(view, 'hashTextInput').focus(); });
    on(node(view, 'hashCalculateBtn'), 'click', () => { void calculate(view); });
    on(root, 'keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void calculate(view); } });
    on(node(view, 'hashCancelBtn'), 'click', () => { invalidate(view, '已取消等待，修改内容后可重新计算。'); });
    on(node(view, 'hashCopyAllBtn'), 'click', () => { void copy(view); });
    on(node(view, 'hashResultsList'), 'click', event => { const button = event.target.closest('.hash-copy-btn'); if (button) void copy(view, button.dataset.algo); });
    on(window, 'dtkit:power-state', event => {
        view.suspended = event.detail?.suspended === true;
        if (view.suspended) { resetIo(view); if (view.job) invalidate(view, '计算已暂停，回来后可重新计算。'); }
    });
    mountSegmentedControl(node(view, 'hashModeGroup'), { signal });
    updateSettings(view); renderFile(view); renderResults(view); revealContent(root, { signal }); view.progressReady = listenProgress(view);
}
function serializeDraft() {
    if (!state) return null; const view = state; const fields = {};
    for (const id of ['hashTextInput', 'hashVerifyInput']) { const field = node(view, id); fields[id] = { value: field.value, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection, scrollTop: field.scrollTop, scrollLeft: field.scrollLeft }; }
    return { version: 1, mode: view.mode, algorithms: [...view.algorithms], uppercase: view.uppercase, fields,
        file: view.file ? { name: view.file.name, size: view.file.size, path: view.file.path || null } : null,
        results: view.results, valid: view.valid, resultMode: view.resultMode,
        panelScroll: [...view.root.querySelectorAll('.hash-main-panel,.hash-config-panel')].map(panel => panel.scrollTop),
        focusedField: document.hasFocus() ? document.activeElement?.id : null };
}
function restoreDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return; const view = state;
    invalidate(view, '草稿已恢复，点击计算摘要。'); view.mode = snapshot.mode === 'file' ? 'file' : 'text'; view.uppercase = snapshot.uppercase !== false;
    view.algorithms = Array.isArray(snapshot.algorithms) ? Object.keys(LABELS).filter(id => snapshot.algorithms.includes(id)) : [...DEFAULT_ALGORITHMS];
    for (const id of ['hashTextInput', 'hashVerifyInput']) node(view, id).value = typeof snapshot.fields?.[id]?.value === 'string' ? snapshot.fields[id].value : '';
    view.file = snapshot.file && typeof snapshot.file.name === 'string' ? { name: snapshot.file.name, size: Number.isFinite(snapshot.file.size) && snapshot.file.size >= 0 ? snapshot.file.size : null,
        path: typeof snapshot.file.path === 'string' && snapshot.file.path ? snapshot.file.path : null, needsReselect: !(typeof snapshot.file.path === 'string' && snapshot.file.path) } : null;
    view.resultMode = snapshot.resultMode === 'file' ? 'file' : 'text'; view.results = {}; view.valid = false;
    try {
        if (Object.keys(snapshot.results || {}).length) view.results = validateHashResults(snapshot.results, Object.keys(snapshot.results));
        view.valid = snapshot.valid === true && Object.keys(view.results).length > 0 && view.resultMode === 'text' && view.mode === 'text'
            && selectedAlgorithms(view).join() === Object.keys(view.results).join();
    } catch { view.results = {}; }
    if (view.resultMode === 'file' && view.file?.needsReselect) view.results = {};
    updateSettings(view); renderFile(view); renderResults(view);
    status(view, view.valid ? '草稿与有效摘要已恢复。' : view.file?.needsReselect && view.mode === 'file' ? '草稿已恢复，请重新选择浏览器文件。' : '草稿已恢复，点击计算摘要。', view.valid ? 'success' : '');
    for (const id of ['hashTextInput', 'hashVerifyInput']) { const field = node(view, id); const saved = snapshot.fields?.[id];
        if (Number.isInteger(saved?.start) && Number.isInteger(saved?.end)) field.setSelectionRange(saved.start, saved.end, saved.direction);
        field.scrollTop = Number.isFinite(saved?.scrollTop) ? saved.scrollTop : 0; field.scrollLeft = Number.isFinite(saved?.scrollLeft) ? saved.scrollLeft : 0;
    }
    view.root.querySelectorAll('.hash-main-panel,.hash-config-panel').forEach((panel, index) => { panel.scrollTop = Number.isFinite(snapshot.panelScroll?.[index]) ? snapshot.panelScroll[index] : 0; });
    if (['hashTextInput', 'hashVerifyInput'].includes(snapshot.focusedField) && document.hasFocus() && !view.suspended) node(view, snapshot.focusedField).focus({ preventScroll: true });
}
export function destroyHashTool() {
    if (!state) return; const view = state; cancelJob(view); resetIo(view); state = null; view.controller.abort(); view.unlisten?.(); view.unlisten = null;
}
registerTool({ id: 'hash-tool', name: 'MD5 / Hash', icon: 'ri-hashtag', description: '本地计算文本或文件的 MD5、SHA-1、SHA-256 与 SHA-512，核对摘要。',
    category: 'dev', template: getTemplate, init: initHashTool, destroy: destroyHashTool, serialize: serializeDraft, restore: restoreDraft });
