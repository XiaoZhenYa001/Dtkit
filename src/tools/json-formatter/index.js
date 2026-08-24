import { registerTool } from '../toolRegistry.js';
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
        <div class="data-converter-shell">
            <header class="data-converter-hero">
                <div class="data-converter-identity">
                    <span class="data-converter-icon" aria-hidden="true"><i class="ri-code-box-line"></i></span>
                    <div>
                        <span class="data-converter-kicker">STRUCTURED DATA</span>
                        <h2>JSON / YAML / XML 转换</h2>
                        <p>转换与校验全部在本机完成；内容不会上传，注释和原始排版不会保留。</p>
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
                    <div class="data-segmented" role="radiogroup" aria-label="输入格式">
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
                    <div class="data-segmented" role="radiogroup" aria-label="输出格式">
                        <button type="button" data-target-format="json" aria-pressed="false">JSON</button>
                        <button type="button" data-target-format="yaml" class="is-active" aria-pressed="true">YAML</button>
                        <button type="button" data-target-format="xml" aria-pressed="false">XML</button>
                    </div>
                </fieldset>
                <div class="data-route-options">
                    <div class="data-option-block">
                        <span>输出样式</span>
                        <div class="data-mini-segmented">
                            <button type="button" data-output-style="pretty" class="is-active" aria-pressed="true">易读</button>
                            <button type="button" data-output-style="compact" aria-pressed="false">紧凑</button>
                        </div>
                    </div>
                    <div class="data-option-block" id="jsonIndentOption">
                        <span>缩进</span>
                        <div class="data-mini-segmented">
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
                            <button id="jsonCopyOutputBtn" type="button" title="复制结果" aria-label="复制结果"><i class="ri-file-copy-line"></i></button>
                            <button id="jsonDownloadBtn" type="button" title="下载结果" aria-label="下载结果"><i class="ri-download-2-line"></i></button>
                        </div>
                    </header>
                    <textarea id="jsonOutput" readonly spellcheck="false" aria-label="转换结果" placeholder="有效结果会显示在这里"></textarea>
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
        </div>
    `;
}

function createState() {
    return {
        controller: new AbortController(),
        worker: null,
        requestId: 0,
        busy: false,
        debounceTimer: null,
        sourceFormat: 'auto',
        targetFormat: 'yaml',
        detectedFormat: null,
        outputFormat: null,
        pretty: true,
        indent: 2,
        lastError: null
    };
}

function byId(id) {
    return document.getElementById(id);
}

function setPressed(selector, value, attribute) {
    document.querySelectorAll(selector).forEach(button => {
        const active = button.dataset[attribute] === String(value);
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function formatCount(value) {
    return NUMBER_FORMATTER.format(value);
}

function textMeta(value) {
    if (!value) return '0 字符 · 0 行';
    const lines = (value.match(/\n/g)?.length || 0) + 1;
    return `${formatCount(value.length)} 字符 · ${formatCount(lines)} 行`;
}

function setStatus(message, type = '') {
    const element = byId('jsonStatus');
    if (!element) return;
    element.textContent = message;
    element.className = `data-status${type ? ` data-status--${type}` : ''}`;
}

function clearError() {
    const panel = byId('jsonErrorPanel');
    if (panel) panel.hidden = true;
    state.lastError = null;
}

function showError(error) {
    const panel = byId('jsonErrorPanel');
    if (!panel) return;
    state.lastError = error;
    byId('jsonErrorTitle').textContent = error.line
        ? `第 ${error.line} 行${error.column ? `，第 ${error.column} 列` : ''}`
        : '无法完成转换';
    byId('jsonErrorMessage').textContent = error.message || '输入内容无效。';
    const excerpt = byId('jsonErrorExcerpt');
    excerpt.textContent = error.excerpt || '';
    excerpt.hidden = !error.excerpt;
    byId('jsonLocateError').hidden = !error.line;
    panel.hidden = false;
    setStatus('请修正标记的问题后重试', 'error');
}

function updateFormatUi() {
    setPressed('[data-source-format]', state.sourceFormat, 'sourceFormat');
    setPressed('[data-target-format]', state.targetFormat, 'targetFormat');
    setPressed('[data-output-style]', state.pretty ? 'pretty' : 'compact', 'outputStyle');
    setPressed('[data-indent]', state.indent, 'indent');
    byId('jsonRootOption').hidden = state.targetFormat !== 'xml';
    byId('jsonIndentOption').hidden = !state.pretty;
    byId('jsonValidBadge').textContent = FORMAT_LABELS[state.targetFormat];
}

function ensureWorker() {
    if (state.worker) return state.worker;
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', handleWorkerMessage, { signal: state.controller.signal });
    worker.addEventListener('error', () => {
        state.busy = false;
        state.worker?.terminate();
        state.worker = null;
        const button = byId('jsonConvertBtn');
        if (button) button.disabled = false;
        showError({ message: '转换引擎加载失败，请重新打开工具后再试。' });
    }, { signal: state.controller.signal });
    state.worker = worker;
    return worker;
}

function handleWorkerMessage(event) {
    if (!state || event.data?.id !== state.requestId) return;
    state.busy = false;
    const button = byId('jsonConvertBtn');
    if (button) button.disabled = false;
    if (!event.data.ok) {
        byId('jsonOutput').value = '';
        byId('jsonOutputMeta').textContent = '转换失败';
        showError(event.data.error || { message: '转换失败' });
        return;
    }

    clearError();
    const result = event.data.result;
    state.detectedFormat = result.detectedFormat;
    state.outputFormat = result.targetFormat;
    const output = byId('jsonOutput');
    output.value = result.output;
    byId('jsonDetectedBadge').textContent = `${FORMAT_LABELS[result.detectedFormat]} 已识别`;
    byId('jsonDetectedBadge').classList.add('is-valid');
    byId('jsonOutputMeta').textContent = `${textMeta(result.output)} · ${result.elapsedMs} ms`;
    const nodeText = result.nodeCountTruncated ? `${formatCount(result.nodes)}+ 节点` : `${formatCount(result.nodes)} 节点`;
    setStatus(`${FORMAT_LABELS[result.detectedFormat]} → ${FORMAT_LABELS[result.targetFormat]} · ${nodeText} · 本地完成`, 'success');
}

function runConversion() {
    const input = byId('jsonInput');
    if (!input?.value.trim()) {
        byId('jsonOutput').value = '';
        byId('jsonOutputMeta').textContent = '尚未转换';
        byId('jsonDetectedBadge').textContent = '等待输入';
        byId('jsonDetectedBadge').classList.remove('is-valid');
        clearError();
        setStatus('请先输入需要转换的内容', 'error');
        return;
    }
    if (input.value.length > INPUT_LIMIT) {
        showError({ message: '输入超过 5 MB 安全上限，请拆分后再转换。' });
        return;
    }

    clearTimeout(state.debounceTimer);
    clearError();
    if (state.busy) {
        state.worker?.terminate();
        state.worker = null;
    }
    state.requestId += 1;
    state.busy = true;
    byId('jsonConvertBtn').disabled = true;
    setStatus('正在校验并转换…');
    ensureWorker().postMessage({
        id: state.requestId,
        request: {
            source: input.value,
            sourceFormat: state.sourceFormat,
            targetFormat: state.targetFormat,
            options: {
                pretty: state.pretty,
                indent: state.indent,
                rootName: byId('jsonRootName').value
            }
        }
    });
}

function scheduleConversion() {
    clearTimeout(state.debounceTimer);
    state.requestId += 1;
    state.busy = false;
    state.worker?.terminate();
    state.worker = null;
    const convertButton = byId('jsonConvertBtn');
    if (convertButton) convertButton.disabled = false;
    const input = byId('jsonInput');
    byId('jsonInputMeta').textContent = textMeta(input.value);
    if (!input.value) {
        runConversion();
        return;
    }
    if (!byId('jsonAutoConvert').checked) {
        setStatus('输入已更新 · 点击“开始转换”');
        return;
    }
    if (input.value.length > AUTO_CONVERT_LIMIT) {
        setStatus('大文本已暂停自动转换 · 点击“开始转换”以继续');
        return;
    }
    state.debounceTimer = setTimeout(runConversion, 360);
}

async function pasteInput() {
    try {
        const text = await navigator.clipboard.readText();
        byId('jsonInput').value = text;
        scheduleConversion();
        byId('jsonInput').focus();
    } catch {
        setStatus('无法读取剪贴板，请使用 Ctrl + V', 'error');
    }
}

function setSourceFromFileName(name) {
    const extension = name.split('.').pop()?.toLowerCase();
    const format = extension === 'yml' ? 'yaml' : extension;
    if (!['json', 'yaml', 'xml'].includes(format)) return;
    state.sourceFormat = format;
    if (state.targetFormat === format) state.targetFormat = format === 'json' ? 'yaml' : 'json';
    updateFormatUi();
}

async function loadFile(file) {
    if (!file) return;
    if (file.size > INPUT_LIMIT) {
        showError({ message: '文件超过 5 MB 安全上限，请拆分后再转换。' });
        return;
    }
    try {
        const content = await file.text();
        setSourceFromFileName(file.name);
        byId('jsonInput').value = content;
        byId('jsonInputMeta').textContent = `${textMeta(content)} · ${file.name}`;
        runConversion();
    } catch {
        showError({ message: '无法读取该文件，请确认它是 UTF-8 文本文件。' });
    }
}

async function copyOutput() {
    const output = byId('jsonOutput').value;
    if (!output) return setStatus('当前没有可复制的结果', 'error');
    try {
        await navigator.clipboard.writeText(output);
        setStatus('转换结果已复制', 'success');
    } catch {
        setStatus('复制失败，请手动选择结果', 'error');
    }
}

function downloadOutput() {
    const output = byId('jsonOutput').value;
    if (!output || !state.outputFormat) return setStatus('当前没有可下载的结果', 'error');
    const mime = state.outputFormat === 'json' ? 'application/json' : state.outputFormat === 'xml' ? 'application/xml' : 'text/yaml';
    const url = URL.createObjectURL(new Blob([output], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `DtKit-converted.${FORMAT_EXTENSIONS[state.outputFormat]}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('转换结果已下载', 'success');
}

function swapResultToInput() {
    const output = byId('jsonOutput').value;
    if (!output || !state.outputFormat) return setStatus('当前没有可以交换的结果', 'error');
    const previousInputFormat = state.detectedFormat || (state.sourceFormat === 'auto' ? null : state.sourceFormat);
    byId('jsonInput').value = output;
    byId('jsonOutput').value = '';
    state.sourceFormat = state.outputFormat;
    if (previousInputFormat) state.targetFormat = previousInputFormat;
    state.outputFormat = null;
    state.detectedFormat = null;
    updateFormatUi();
    scheduleConversion();
    byId('jsonInput').focus();
}

function locateError() {
    if (!state.lastError?.line) return;
    const input = byId('jsonInput');
    const lines = input.value.split(/\n/);
    let lineStart = 0;
    for (let index = 0; index < state.lastError.line - 1; index += 1) lineStart += lines[index].length + 1;
    const columnOffset = Math.max(0, (state.lastError.column || 1) - 1);
    const start = Math.min(input.value.length, lineStart + columnOffset);
    const lineEnd = lineStart + (lines[state.lastError.line - 1]?.length || 0);
    const end = Math.min(input.value.length, Math.max(start + 1, lineEnd));
    input.focus();
    input.setSelectionRange(start, end);
}

function bindButtonGroup(selector, handler) {
    document.querySelectorAll(selector).forEach(button => {
        button.addEventListener('click', () => handler(button), { signal: state.controller.signal });
    });
}

function initializeJsonFormatter() {
    destroyJsonFormatter();
    state = createState();
    const { signal } = state.controller;
    const input = byId('jsonInput');
    const fileInput = byId('jsonFileInput');
    const inputPanel = byId('jsonInputPanel');
    if (!input || !fileInput || !inputPanel) return;

    bindButtonGroup('[data-source-format]', button => {
        state.sourceFormat = button.dataset.sourceFormat;
        updateFormatUi();
        scheduleConversion();
    });
    bindButtonGroup('[data-target-format]', button => {
        state.targetFormat = button.dataset.targetFormat;
        updateFormatUi();
        scheduleConversion();
    });
    bindButtonGroup('[data-output-style]', button => {
        state.pretty = button.dataset.outputStyle === 'pretty';
        updateFormatUi();
        scheduleConversion();
    });
    bindButtonGroup('[data-indent]', button => {
        state.indent = Number(button.dataset.indent) === 4 ? 4 : 2;
        updateFormatUi();
        scheduleConversion();
    });
    bindButtonGroup('[data-example-format]', button => {
        const format = button.dataset.exampleFormat;
        state.sourceFormat = format;
        state.targetFormat = format === 'json' ? 'yaml' : 'json';
        input.value = EXAMPLES[format];
        updateFormatUi();
        runConversion();
        input.focus();
    });

    input.addEventListener('input', scheduleConversion, { signal });
    input.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            runConversion();
        }
    }, { signal });
    byId('jsonRootName').addEventListener('input', scheduleConversion, { signal });
    byId('jsonAutoConvert').addEventListener('change', () => {
        if (byId('jsonAutoConvert').checked) scheduleConversion();
        else setStatus('自动转换已关闭 · Ctrl + Enter 仍可转换');
    }, { signal });
    byId('jsonConvertBtn').addEventListener('click', runConversion, { signal });
    byId('jsonPasteBtn').addEventListener('click', pasteInput, { signal });
    byId('jsonClearBtn').addEventListener('click', () => {
        input.value = '';
        byId('jsonOutput').value = '';
        state.detectedFormat = null;
        state.outputFormat = null;
        scheduleConversion();
        input.focus();
    }, { signal });
    byId('jsonSwapBtn').addEventListener('click', swapResultToInput, { signal });
    byId('jsonCopyOutputBtn').addEventListener('click', copyOutput, { signal });
    byId('jsonDownloadBtn').addEventListener('click', downloadOutput, { signal });
    byId('jsonLocateError').addEventListener('click', locateError, { signal });
    byId('jsonFileBtn').addEventListener('click', () => fileInput.click(), { signal });
    fileInput.addEventListener('change', () => {
        loadFile(fileInput.files?.[0]);
        fileInput.value = '';
    }, { signal });

    ['dragenter', 'dragover'].forEach(type => inputPanel.addEventListener(type, event => {
        event.preventDefault();
        inputPanel.classList.add('is-dragging');
    }, { signal }));
    ['dragleave', 'drop'].forEach(type => inputPanel.addEventListener(type, event => {
        event.preventDefault();
        inputPanel.classList.remove('is-dragging');
        if (type === 'drop') loadFile(event.dataTransfer?.files?.[0]);
    }, { signal }));

    updateFormatUi();
    input.focus();
}

function destroyJsonFormatter() {
    if (!state) return;
    clearTimeout(state.debounceTimer);
    state.controller.abort();
    state.worker?.terminate();
    state = null;
}

registerTool({
    id: 'json-formatter',
    name: 'JSON / YAML / XML 转换',
    icon: 'ri-code-box-line',
    colorClass: 'tool-card__icon--orange',
    category: 'dev',
    status: 'ready',
    description: '在本地完成 JSON、YAML 与 XML 的互转、校验、格式化和压缩。',
    template,
    init: initializeJsonFormatter,
    destroy: destroyJsonFormatter
});

export { destroyJsonFormatter, initializeJsonFormatter };
