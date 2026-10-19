import { registerTool } from '../toolRegistry.js';
import { mountSegmentedControl, revealContent, transitionLayout } from '../../core/toolMotion.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/json-formatter.css';

const FORMAT_LABELS = Object.freeze({ auto: '自动识别', json: 'JSON', yaml: 'YAML', xml: 'XML' });
const FORMAT_EXTENSIONS = Object.freeze({ json: 'json', yaml: 'yaml', xml: 'xml' });
const INPUT_LIMIT = 5 * 1024 * 1024;
const AUTO_CONVERT_LIMIT = 350_000;
const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN');

const EXAMPLES = Object.freeze({
    json: `{
  "project": "DtKit",
  "portable": true,
  "features": ["低能耗", "按需加载"],
  "release": { "version": "0.2.7", "channel": "stable" }
}`,
    yaml: `project: DtKit
portable: true
features:
  - 低能耗
  - 按需加载
release:
  version: 0.2.7
  channel: stable`,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<project name="DtKit">
  <portable>true</portable>
  <features>
    <item>低能耗</item>
    <item>按需加载</item>
  </features>
</project>`
});

let state = null;

function template() {
    return `
        <div class="dev-workbench data-converter-shell">
            <header class="data-converter-hero">
                <div class="data-converter-identity">
                    <span class="data-converter-icon" aria-hidden="true"><i class="ri-code-box-line"></i></span>
                    <div>
                        <span class="data-converter-kicker">STRUCTURED DATA</span>
                        <h2>JSON / YAML / XML 转换</h2>
                        <p>在本机转换与校验，让结构清晰，让数据流动。</p>
                    </div>
                </div>
                <div class="data-converter-hero-actions">
                    <button id="jsonFileBtn" class="data-quiet-button" type="button"><i class="ri-file-upload-line"></i> 打开文件</button>
                    <input id="jsonFileInput" type="file" accept=".json,.yaml,.yml,.xml,application/json,application/xml,text/xml,text/yaml" hidden>
                    <button id="jsonPasteBtn" class="data-quiet-button" type="button"><i class="ri-clipboard-line"></i> 粘贴</button>
                    <button id="jsonClearBtn" class="data-quiet-button" type="button"><i class="ri-delete-bin-line"></i> 清空</button>
                </div>
            </header>

            <section class="data-converter-route" aria-label="转换方向">
                <fieldset class="data-format-group" id="jsonSourceFormats">
                    <legend>输入格式</legend>
                    <div class="data-segmented" role="group" aria-label="输入格式">
                        <button type="button" data-source-format="auto" class="is-active" aria-pressed="true">自动</button>
                        <button type="button" data-source-format="json" aria-pressed="false">JSON</button>
                        <button type="button" data-source-format="yaml" aria-pressed="false">YAML</button>
                        <button type="button" data-source-format="xml" aria-pressed="false">XML</button>
                    </div>
                </fieldset>
                <button id="jsonSwapBtn" class="data-swap-button" type="button" title="将结果作为新的输入" aria-label="交换输入和输出">
                    <i class="ri-arrow-left-right-line"></i>
                </button>
                <fieldset class="data-format-group">
                    <legend>输出格式</legend>
                    <div class="data-segmented" role="group" aria-label="输出格式">
                        <button type="button" data-target-format="json" aria-pressed="false">JSON</button>
                        <button type="button" data-target-format="yaml" class="is-active" aria-pressed="true">YAML</button>
                        <button type="button" data-target-format="xml" aria-pressed="false">XML</button>
                    </div>
                </fieldset>
                <div class="data-route-options">
                    <div class="data-option-block">
                        <span>输出样式</span>
                        <div class="data-mini-segmented" role="group" aria-label="输出样式">
                            <button type="button" data-output-style="pretty" class="is-active" aria-pressed="true">易读</button>
                            <button type="button" data-output-style="compact" aria-pressed="false">紧凑</button>
                        </div>
                    </div>
                    <div class="data-option-block" id="jsonIndentOption">
                        <span>缩进</span>
                        <div class="data-mini-segmented" role="group" aria-label="缩进空格数">
                            <button type="button" data-indent="2" class="is-active" aria-pressed="true">2</button>
                            <button type="button" data-indent="4" aria-pressed="false">4</button>
                        </div>
                    </div>
                    <label id="jsonRootOption" class="data-root-option" hidden>
                        <span>XML 根节点</span>
                        <input id="jsonRootName" value="root" spellcheck="false" maxlength="64">
                    </label>
                    <label class="data-auto-option">
                        <input id="jsonAutoConvert" type="checkbox" checked>
                        <span>自动转换</span>
                    </label>
                </div>
            </section>

            <div class="data-editor-grid">
                <section class="data-editor-panel" id="jsonInputPanel">
                    <header>
                        <div>
                            <span class="data-panel-title">源数据</span>
                            <span id="jsonDetectedBadge" class="data-format-badge">等待输入</span>
                        </div>
                        <span id="jsonInputMeta" class="data-editor-meta">0 字符 · 0 行</span>
                    </header>
                    <textarea id="jsonInput" spellcheck="false" autocomplete="off" aria-label="源数据" placeholder="粘贴内容、拖入文件，或从下方选择一个示例…"></textarea>
                    <div class="data-drop-hint"><i class="ri-drag-drop-line"></i> 可将 .json / .yaml / .yml / .xml 文件拖到这里</div>
                </section>

                <section class="data-editor-panel data-editor-panel--output">
                    <header>
                        <div>
                            <span class="data-panel-title">转换结果</span>
                            <span id="jsonValidBadge" class="data-format-badge">YAML</span>
                        </div>
                        <div class="data-panel-actions">
                            <span id="jsonOutputMeta" class="data-editor-meta">尚未转换</span>
                            <button id="jsonCopyOutputBtn" type="button" title="复制结果" aria-label="复制结果" disabled><i class="ri-file-copy-line"></i></button>
                            <button id="jsonDownloadBtn" type="button" title="下载结果" aria-label="下载结果" disabled><i class="ri-download-2-line"></i></button>
                        </div>
                    </header>
                    <textarea id="jsonOutput" readonly spellcheck="false" aria-label="转换结果" aria-describedby="jsonOutputMeta" placeholder="有效结果会显示在这里"></textarea>
                </section>
            </div>

            <section id="jsonErrorPanel" class="data-error-panel" role="alert" hidden>
                <i class="ri-error-warning-line" aria-hidden="true"></i>
                <div>
                    <strong id="jsonErrorTitle">无法解析输入</strong>
                    <p id="jsonErrorMessage"></p>
                    <code id="jsonErrorExcerpt" hidden></code>
                </div>
                <button id="jsonLocateError" type="button" hidden>定位错误</button>
            </section>

            <footer class="data-converter-footer">
                <div class="data-primary-actions">
                    <button id="jsonConvertBtn" class="btn btn--primary" type="button"><i class="ri-arrow-right-line"></i> 开始转换</button>
                    <span id="jsonStatus" class="data-status" role="status" aria-live="polite">等待输入 · Ctrl + Enter 转换</span>
                </div>
                <div class="data-examples" aria-label="快速示例">
                    <span>示例</span>
                    <button type="button" data-example-format="json">JSON</button>
                    <button type="button" data-example-format="yaml">YAML</button>
                    <button type="button" data-example-format="xml">XML</button>
                </div>
            </footer>
            <p class="data-converter-note">跨格式转换不保留注释与原排版。XML 普通数字和布尔值按值识别，前导零保留为文本；混合内容格式化时保留原结构。</p>
        </div>
    `;
}

function createState(root) {
    return { root, controller: new AbortController(), worker: null, requestId: 0, revision: 0, ioGeneration: 0,
        busy: false, debounceTimer: null, resumePending: false, pasting: false,
        sourceFormat: 'auto', targetFormat: 'yaml', detectedFormat: null, outputFormat: null,
        outputValid: false, pretty: true, indent: 2, lastError: null, resultMeta: '',
        preservedXmlLayout: false, downloads: new Map() };
}
function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function byId(view, id) { return view.root.querySelector('#' + id); }
function formatCount(value) { return NUMBER_FORMATTER.format(value); }
function textMeta(value) {
    return value ? `${formatCount(value.length)} 字符 · ${formatCount(value.split('\n').length)} 行` : '0 字符 · 0 行';
}
function setStatus(view, message, type = '') {
    const element = byId(view, 'jsonStatus');
    element.textContent = message; element.dataset.tone = type;
    element.className = `data-status${type ? ` data-status--${type}` : ''}`;
}
function clearError(view) {
    const panel = byId(view, 'jsonErrorPanel');
    if (!panel.hidden) transitionLayout(view.root, () => { panel.hidden = true; }, { signal: view.controller.signal });
    view.lastError = null; byId(view, 'jsonInput').removeAttribute('aria-invalid');
}
function showError(view, error) {
    view.lastError = error;
    byId(view, 'jsonErrorTitle').textContent = error.line
        ? `第 ${error.line} 行${error.column ? `，第 ${error.column} 列` : ''}` : '无法完成转换';
    byId(view, 'jsonErrorMessage').textContent = error.message || '输入内容无效。';
    const excerpt = byId(view, 'jsonErrorExcerpt');
    excerpt.textContent = error.excerpt || ''; excerpt.hidden = !error.excerpt;
    byId(view, 'jsonLocateError').hidden = !error.line;
    transitionLayout(view.root, () => { byId(view, 'jsonErrorPanel').hidden = false; }, { signal: view.controller.signal });
    if (error.line) byId(view, 'jsonInput').setAttribute('aria-invalid', 'true');
    setStatus(view, '请修正标记的问题后重试', 'error');
}
function updateOutputActions(view) {
    const ready = view.outputValid && Boolean(byId(view, 'jsonOutput').value) && Boolean(view.outputFormat);
    for (const id of ['jsonCopyOutputBtn', 'jsonDownloadBtn', 'jsonSwapBtn']) byId(view, id).disabled = !ready;
    const stale = !view.outputValid && Boolean(byId(view, 'jsonOutput').value);
    byId(view, 'jsonOutput').dataset.stale = String(stale);
    view.root.querySelector('.data-editor-panel--output').classList.toggle('is-stale', stale);
    byId(view, 'jsonConvertBtn').disabled = view.busy;
    byId(view, 'jsonOutput').setAttribute('aria-busy', String(view.busy));
}
function setPressed(view, selector, value, attribute) {
    view.root.querySelectorAll(selector).forEach(button => {
        const selected = button.dataset[attribute] === String(value);
        button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
    });
}
function updateRouteOptions(view) {
    const sameXml = view.sourceFormat === 'xml'
        || (view.sourceFormat === 'auto' && byId(view, 'jsonInput').value.trimStart().startsWith('<'));
    const hideRoot = view.targetFormat !== 'xml' || sameXml;
    if (byId(view, 'jsonRootOption').hidden === hideRoot && byId(view, 'jsonIndentOption').hidden === !view.pretty) return;
    transitionLayout(view.root, () => {
        byId(view, 'jsonRootOption').hidden = hideRoot;
        byId(view, 'jsonIndentOption').hidden = !view.pretty;
    }, { signal: view.controller.signal });
}
function updateFormatUi(view) {
    setPressed(view, '[data-source-format]', view.sourceFormat, 'sourceFormat');
    setPressed(view, '[data-target-format]', view.targetFormat, 'targetFormat');
    setPressed(view, '[data-output-style]', view.pretty ? 'pretty' : 'compact', 'outputStyle');
    setPressed(view, '[data-indent]', view.indent, 'indent');
    updateRouteOptions(view);
    byId(view, 'jsonValidBadge').textContent = FORMAT_LABELS[view.targetFormat];
}
function cancelConversion(view, { terminateIdle = false } = {}) {
    clearTimeout(view.debounceTimer); view.debounceTimer = null;
    view.requestId++;
    if ((view.busy || terminateIdle) && view.worker) { view.worker.terminate(); view.worker = null; }
    view.busy = false;
    updateOutputActions(view);
}
function invalidateOutput(view) {
    view.outputValid = false; view.outputFormat = null;
    byId(view, 'jsonOutputMeta').textContent = byId(view, 'jsonOutput').value ? '输入或选项已更新 · 上次结果已失效' : '尚未转换';
    byId(view, 'jsonDetectedBadge').textContent = byId(view, 'jsonInput').value.trim() ? '等待校验' : '等待输入';
    byId(view, 'jsonDetectedBadge').classList.remove('is-valid');
    updateOutputActions(view);
}
function resultStatus(view) {
    return `${FORMAT_LABELS[view.detectedFormat]} → ${FORMAT_LABELS[view.outputFormat]} · 本地完成`
        + (view.preservedXmlLayout ? ' · 混合内容或保留空白的 XML 已保留原结构' : '');
}
function ensureWorker(view) {
    if (view.worker) return view.worker;
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const { signal } = view.controller;
    worker.addEventListener('message', event => {
        if (!active(view) || view.worker !== worker || event.data?.id !== view.requestId) return;
        view.busy = false;
        if (!event.data.ok) {
            view.outputValid = false; view.outputFormat = null;
            byId(view, 'jsonOutput').value = '';
            byId(view, 'jsonOutputMeta').textContent = '转换失败';
            updateOutputActions(view);
            showError(view, event.data.error || { message: '转换失败' });
            return;
        }
        clearError(view);
        const result = event.data.result;
        view.detectedFormat = result.detectedFormat; view.outputFormat = result.targetFormat;
        view.outputValid = true; view.preservedXmlLayout = result.preservedXmlLayout === true;
        byId(view, 'jsonOutput').value = result.output;
        byId(view, 'jsonDetectedBadge').textContent = `${FORMAT_LABELS[result.detectedFormat]} 已识别`;
        byId(view, 'jsonDetectedBadge').classList.add('is-valid');
        const nodes = formatCount(result.nodes) + (result.nodeCountTruncated ? '+' : '') + ' 节点';
        view.resultMeta = `${textMeta(result.output)} · ${nodes} · ${result.elapsedMs} ms`;
        byId(view, 'jsonOutputMeta').textContent = view.resultMeta;
        updateFormatUi(view); updateOutputActions(view);
        setStatus(view, resultStatus(view), 'success');
        revealContent(byId(view, 'jsonOutput'), { signal });
    }, { signal });
    const fail = event => {
        event.preventDefault?.();
        if (!active(view) || view.worker !== worker) return;
        worker.terminate(); view.worker = null; view.busy = false;
        invalidateOutput(view);
        showError(view, { message: '转换引擎暂时不可用，请点击“开始转换”重试。' });
    };
    worker.addEventListener('error', fail, { signal });
    worker.addEventListener('messageerror', fail, { signal });
    view.worker = worker;
    return worker;
}
function runConversion(view) {
    if (!active(view)) return;
    cancelConversion(view); clearError(view); invalidateOutput(view);
    view.resumePending = false;
    const input = byId(view, 'jsonInput');
    byId(view, 'jsonInputMeta').textContent = textMeta(input.value);
    if (!input.value.trim()) {
        byId(view, 'jsonOutput').value = ''; updateOutputActions(view);
        setStatus(view, '请先输入需要转换的内容'); return;
    }
    if (input.value.length > INPUT_LIMIT) {
        showError(view, { message: '输入超过 5 MB 安全上限，请拆分后再转换。' }); return;
    }
    view.busy = true; updateOutputActions(view); setStatus(view, '正在校验并转换…');
    try {
        ensureWorker(view).postMessage({ id: view.requestId, request: {
            source: input.value, sourceFormat: view.sourceFormat, targetFormat: view.targetFormat,
            options: { pretty: view.pretty, indent: view.indent, rootName: byId(view, 'jsonRootName').value }
        } });
    } catch {
        cancelConversion(view, { terminateIdle: true });
        showError(view, { message: '无法启动转换引擎，请点击“开始转换”重试。' });
    }
}
function scheduleConversion(view) {
    cancelConversion(view); view.revision++; view.resumePending = false;
    clearError(view); invalidateOutput(view);
    updateRouteOptions(view);
    const input = byId(view, 'jsonInput');
    byId(view, 'jsonInputMeta').textContent = textMeta(input.value);
    if (!input.value.trim()) {
        byId(view, 'jsonOutput').value = ''; updateOutputActions(view);
        byId(view, 'jsonOutputMeta').textContent = '尚未转换';
        setStatus(view, '等待输入 · Ctrl + Enter 转换'); return;
    }
    if (!byId(view, 'jsonAutoConvert').checked) {
        setStatus(view, '输入已更新 · 点击“开始转换”'); return;
    }
    if (input.value.length > AUTO_CONVERT_LIMIT) {
        setStatus(view, '大文本已暂停自动转换 · 点击“开始转换”以继续'); return;
    }
    if (document.documentElement.classList.contains('app-is-suspended')) {
        view.resumePending = true; return;
    }
    setStatus(view, '输入已更新 · 等待转换');
    view.debounceTimer = setTimeout(() => {
        view.debounceTimer = null;
        if (active(view)) runConversion(view);
    }, 360);
}
function currentIo(view, revision, generation) {
    return active(view) && revision === view.revision && generation === view.ioGeneration;
}
async function pasteInput(view) {
    if (view.pasting) return;
    view.pasting = true; byId(view, 'jsonPasteBtn').disabled = true;
    const revision = view.revision, generation = ++view.ioGeneration;
    try {
        const text = await navigator.clipboard.readText();
        if (!currentIo(view, revision, generation)) return;
        byId(view, 'jsonInput').value = text;
        scheduleConversion(view); byId(view, 'jsonInput').focus();
    } catch {
        if (currentIo(view, revision, generation)) setStatus(view, '无法读取剪贴板，请使用 Ctrl + V', 'error');
    } finally {
        if (active(view)) { view.pasting = false; byId(view, 'jsonPasteBtn').disabled = false; }
    }
}
function setSourceFromFileName(view, name) {
    const extension = name.split('.').pop()?.toLowerCase();
    const format = extension === 'yml' ? 'yaml' : extension;
    if (!['json', 'yaml', 'xml'].includes(format)) return;
    view.sourceFormat = format;
    if (view.targetFormat === format) view.targetFormat = format === 'json' ? 'yaml' : 'json';
    updateFormatUi(view);
}
async function loadFile(view, file) {
    if (!file) return;
    const revision = view.revision, generation = ++view.ioGeneration;
    if (file.size > INPUT_LIMIT) {
        showError(view, { message: '文件超过 5 MB 安全上限，请拆分后再转换。' }); return;
    }
    try {
        const content = await file.text();
        if (!currentIo(view, revision, generation)) return;
        view.revision++; byId(view, 'jsonInput').value = content;
        setSourceFromFileName(view, file.name); runConversion(view);
        byId(view, 'jsonInputMeta').textContent = `${textMeta(content)} · ${file.name}`;
    } catch {
        if (currentIo(view, revision, generation)) showError(view, { message: '无法读取该文件，请确认它是 UTF-8 文本文件。' });
    }
}
async function copyOutput(view) {
    if (!view.outputValid) return;
    const output = byId(view, 'jsonOutput').value, revision = view.revision;
    try {
        await navigator.clipboard.writeText(output);
        if (active(view) && revision === view.revision && view.outputValid) setStatus(view, '转换结果已复制', 'success');
    } catch {
        if (active(view) && revision === view.revision) setStatus(view, '复制失败，请手动选择结果', 'error');
    }
}
function downloadOutput(view) {
    if (!view.outputValid || !view.outputFormat) return;
    const mime = { json: 'application/json', xml: 'application/xml', yaml: 'text/yaml' }[view.outputFormat];
    const url = URL.createObjectURL(new Blob([byId(view, 'jsonOutput').value], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url; link.download = `DtKit-converted.${FORMAT_EXTENSIONS[view.outputFormat]}`; link.click();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); view.downloads.delete(url); }, 0);
    view.downloads.set(url, timer); setStatus(view, '转换结果已下载', 'success');
}
function swapResultToInput(view) {
    if (!view.outputValid || !view.outputFormat) return;
    const previousFormat = view.detectedFormat || (view.sourceFormat === 'auto' ? null : view.sourceFormat);
    byId(view, 'jsonInput').value = byId(view, 'jsonOutput').value;
    byId(view, 'jsonOutput').value = ''; view.sourceFormat = view.outputFormat;
    if (previousFormat) view.targetFormat = previousFormat;
    view.detectedFormat = null; updateFormatUi(view); scheduleConversion(view);
    byId(view, 'jsonInput').focus();
}
function locateError(view) {
    const input = byId(view, 'jsonInput');
    const lines = input.value.split('\n');
    const line = Math.min(lines.length, Math.max(1, Number(view.lastError?.line) || 1));
    let start = lines.slice(0, line - 1).reduce((length, text) => length + text.length + 1, 0);
    const end = start + lines[line - 1].length;
    start = Math.min(end, start + Math.max(0, (Number(view.lastError?.column) || 1) - 1));
    input.focus(); input.setSelectionRange(start, Math.min(input.value.length, Math.max(start + 1, end)));
}
function initializeJsonFormatter() {
    destroyJsonFormatter();
    const root = document.querySelector('.data-converter-shell');
    if (!root) return;
    const view = createState(root); state = view;
    const { signal } = view.controller;
    const on = (target, event, handler) => target.addEventListener(event, handler, { signal });
    const group = (selector, handler) => root.querySelectorAll(selector).forEach(button => on(button, 'click', () => handler(button)));
    const input = byId(view, 'jsonInput'), fileInput = byId(view, 'jsonFileInput'), panel = byId(view, 'jsonInputPanel');
    group('[data-source-format]', button => { view.sourceFormat = button.dataset.sourceFormat; updateFormatUi(view); scheduleConversion(view); });
    group('[data-target-format]', button => { view.targetFormat = button.dataset.targetFormat; updateFormatUi(view); scheduleConversion(view); });
    group('[data-output-style]', button => { view.pretty = button.dataset.outputStyle === 'pretty'; updateFormatUi(view); scheduleConversion(view); });
    group('[data-indent]', button => { view.indent = Number(button.dataset.indent) === 4 ? 4 : 2; updateFormatUi(view); scheduleConversion(view); });
    group('[data-example-format]', button => {
        view.revision++; view.ioGeneration++;
        const format = button.dataset.exampleFormat;
        view.sourceFormat = format; view.targetFormat = format === 'json' ? 'yaml' : 'json';
        input.value = EXAMPLES[format]; updateFormatUi(view); runConversion(view); input.focus();
    });
    on(input, 'input', () => scheduleConversion(view));
    on(input, 'keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runConversion(view); }
    });
    on(byId(view, 'jsonRootName'), 'input', () => scheduleConversion(view));
    on(byId(view, 'jsonAutoConvert'), 'change', () => {
        view.revision++;
        if (byId(view, 'jsonAutoConvert').checked) scheduleConversion(view);
        else { cancelConversion(view); view.resumePending = false; setStatus(view, '自动转换已关闭 · Ctrl + Enter 仍可转换'); }
    });
    on(byId(view, 'jsonConvertBtn'), 'click', () => runConversion(view));
    on(byId(view, 'jsonPasteBtn'), 'click', () => { void pasteInput(view); });
    on(byId(view, 'jsonClearBtn'), 'click', () => {
        input.value = ''; byId(view, 'jsonOutput').value = ''; view.detectedFormat = null;
        view.ioGeneration++; scheduleConversion(view); input.focus();
    });
    on(byId(view, 'jsonSwapBtn'), 'click', () => swapResultToInput(view));
    on(byId(view, 'jsonCopyOutputBtn'), 'click', () => { void copyOutput(view); });
    on(byId(view, 'jsonDownloadBtn'), 'click', () => downloadOutput(view));
    on(byId(view, 'jsonLocateError'), 'click', () => locateError(view));
    on(byId(view, 'jsonFileBtn'), 'click', () => fileInput.click());
    on(fileInput, 'change', () => { void loadFile(view, fileInput.files?.[0]); fileInput.value = ''; });
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) on(panel, type, event => {
        event.preventDefault(); panel.classList.toggle('is-dragging', type === 'dragenter' || type === 'dragover');
        if (type === 'drop') void loadFile(view, event.dataTransfer?.files?.[0]);
    });
    on(window, 'dtkit:power-state', event => {
        if (event.detail?.suspended) {
            view.resumePending ||= view.busy || view.debounceTimer !== null;
            if (view.resumePending) { cancelConversion(view); setStatus(view, '转换已暂停，返回页面后继续'); }
        } else if (view.resumePending) { view.resumePending = false; runConversion(view); }
    });
    updateFormatUi(view); updateOutputActions(view);
    root.querySelectorAll('.data-segmented,.data-mini-segmented').forEach(element => mountSegmentedControl(element, { signal }));
    revealContent(root, { signal });
}
function captureEditor(node) {
    return { selectionStart: node.selectionStart, selectionEnd: node.selectionEnd,
        selectionDirection: node.selectionDirection, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft };
}
function serializePageDraft() {
    if (!state) return null;
    const view = state;
    return { version: 1, input: byId(view, 'jsonInput').value, output: byId(view, 'jsonOutput').value,
        sourceFormat: view.sourceFormat, targetFormat: view.targetFormat, pretty: view.pretty, indent: view.indent,
        rootName: byId(view, 'jsonRootName').value, autoConvert: byId(view, 'jsonAutoConvert').checked,
        detectedFormat: view.detectedFormat, outputFormat: view.outputFormat, outputValid: view.outputValid,
        resultMeta: view.resultMeta, lastError: view.lastError, preservedXmlLayout: view.preservedXmlLayout,
        pendingConversion: view.busy || view.debounceTimer !== null || view.resumePending,
        inputEditor: captureEditor(byId(view, 'jsonInput')), outputEditor: captureEditor(byId(view, 'jsonOutput')),
        focusedField: document.hasFocus() ? document.activeElement?.id : null };
}
function restoreEditor(node, saved) {
    if (!saved) return;
    if (Number.isInteger(saved.selectionStart) && Number.isInteger(saved.selectionEnd)) {
        node.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection || 'none');
    }
    node.scrollTop = Math.max(0, Number(saved.scrollTop) || 0); node.scrollLeft = Math.max(0, Number(saved.scrollLeft) || 0);
}
function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return;
    const view = state;
    cancelConversion(view); view.revision++; view.ioGeneration++; view.resumePending = false;
    view.sourceFormat = ['auto', 'json', 'yaml', 'xml'].includes(snapshot.sourceFormat) ? snapshot.sourceFormat : 'auto';
    view.targetFormat = ['json', 'yaml', 'xml'].includes(snapshot.targetFormat) ? snapshot.targetFormat : 'yaml';
    view.pretty = snapshot.pretty !== false; view.indent = snapshot.indent === 4 ? 4 : 2;
    view.detectedFormat = ['json', 'yaml', 'xml'].includes(snapshot.detectedFormat) ? snapshot.detectedFormat : null;
    view.outputFormat = ['json', 'yaml', 'xml'].includes(snapshot.outputFormat) ? snapshot.outputFormat : null;
    byId(view, 'jsonInput').value = typeof snapshot.input === 'string' ? snapshot.input : '';
    byId(view, 'jsonOutput').value = typeof snapshot.output === 'string' ? snapshot.output : '';
    byId(view, 'jsonRootName').value = typeof snapshot.rootName === 'string' ? snapshot.rootName.slice(0, 64) : 'root';
    byId(view, 'jsonAutoConvert').checked = snapshot.autoConvert !== false;
    view.outputValid = snapshot.outputValid === true && Boolean(view.outputFormat) && Boolean(byId(view, 'jsonOutput').value);
    view.resultMeta = typeof snapshot.resultMeta === 'string' ? snapshot.resultMeta : textMeta(byId(view, 'jsonOutput').value);
    view.preservedXmlLayout = snapshot.preservedXmlLayout === true;
    clearError(view); updateFormatUi(view);
    byId(view, 'jsonInputMeta').textContent = textMeta(byId(view, 'jsonInput').value);
    if (view.outputValid) {
        byId(view, 'jsonDetectedBadge').textContent = `${FORMAT_LABELS[view.detectedFormat]} 已识别`;
        byId(view, 'jsonDetectedBadge').classList.add('is-valid');
        byId(view, 'jsonOutputMeta').textContent = view.resultMeta;
        setStatus(view, resultStatus(view), 'success');
    } else { invalidateOutput(view); setStatus(view, '草稿已恢复 · Ctrl + Enter 转换'); }
    updateOutputActions(view);
    if (snapshot.lastError && typeof snapshot.lastError.message === 'string') showError(view, snapshot.lastError);
    if (snapshot.pendingConversion && !view.outputValid) scheduleConversion(view);
    restoreEditor(byId(view, 'jsonInput'), snapshot.inputEditor); restoreEditor(byId(view, 'jsonOutput'), snapshot.outputEditor);
    if (['jsonInput', 'jsonOutput', 'jsonRootName'].includes(snapshot.focusedField)
        && !document.documentElement.classList.contains('app-is-suspended') && document.hasFocus()) {
        byId(view, snapshot.focusedField).focus({ preventScroll: true });
    }
}
function destroyJsonFormatter() {
    if (!state) return;
    const view = state; state = null;
    cancelConversion(view, { terminateIdle: true }); view.controller.abort();
    for (const [url, timer] of view.downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    view.downloads.clear();
}
registerTool({
    id: 'json-formatter', name: 'JSON / YAML / XML 转换', icon: 'ri-code-box-line', colorClass: 'tool-card__icon--orange',
    category: 'dev', status: 'ready', description: '在本地完成 JSON、YAML 与 XML 的互转、校验、格式化和压缩。',
    template, init: initializeJsonFormatter, destroy: destroyJsonFormatter,
    serialize: serializePageDraft, restore: restorePageDraft
});
export { destroyJsonFormatter, initializeJsonFormatter };
