import { registerTool } from '../toolRegistry.js';
import { mountSegmentedControl, revealContent } from '../../core/toolMotion.js';
import { convertBase64, getTextMetrics } from './core.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/base64-codec.css';

let state = null;
const AUTO_DELAY = 180;

function getTemplate() {
    return `
        <div class="view-container dev-workbench base64-container">
            <header class="dw-header">
                <div><p class="dw-eyebrow">TEXT & ENCODING</p><h1 class="dw-title">Base64 编解码</h1>
                    <p class="dw-subtitle">让文本与 Base64，自然往返。</p></div>
                <span class="dw-chip">UTF-8 · 本地处理</span>
            </header>
            <section class="dw-card base64-options" aria-label="转换设置">
                <div class="base64-option-row">
                    <div class="dw-field"><span class="dw-label" id="base64ModeLabel">转换方向</span>
                        <div id="base64ModeGroup" class="dw-segmented" role="group" aria-labelledby="base64ModeLabel">
                            <button id="base64EncodeBtn" type="button" data-base64-mode="encode" aria-pressed="true">文本 → Base64</button>
                            <button id="base64DecodeBtn" type="button" data-base64-mode="decode" aria-pressed="false">Base64 → 文本</button>
                        </div>
                    </div>
                    <div class="dw-field"><span class="dw-label" id="base64VariantLabel">字符集</span>
                        <div id="base64VariantGroup" class="dw-segmented" role="group" aria-labelledby="base64VariantLabel">
                            <button type="button" data-base64-variant="standard" aria-pressed="true">标准</button>
                            <button type="button" data-base64-variant="url" aria-pressed="false">URL-safe</button>
                        </div>
                    </div>
                    <div class="base64-toggles">
                        <label class="base64-toggle"><input id="base64OmitPadding" type="checkbox"><span>编码时省略 = 填充</span></label>
                        <label class="base64-toggle"><input id="base64AutoConvert" type="checkbox" checked><span>自动转换</span></label>
                    </div>
                </div>
                <div class="base64-option-footer"><p id="base64FormatHint" class="dw-status">标准字符集使用 + 和 /；解码时兼容换行与省略的填充。</p>
                    <button id="base64RunBtn" class="dw-button dw-button--primary" type="button">立即编码</button></div>
            </section>
            <div class="dw-grid base64-editor-container">
                <section class="dw-card base64-panel" aria-labelledby="base64InputLabel">
                    <header class="dw-card-header base64-panel-header"><h2 id="base64InputLabel" class="dw-card-title">原始文本</h2>
                        <div class="dw-actions"><button id="base64PasteBtn" class="dw-button" type="button" title="从剪贴板粘贴">粘贴</button>
                            <button id="base64CopyInputBtn" class="dw-button" type="button" title="复制输入">复制</button>
                            <button id="base64ClearBtn" class="dw-button" type="button">清空</button></div></header>
                    <div class="base64-editor-body"><label class="base64-sr-only" for="base64Input">输入内容</label>
                        <textarea id="base64Input" class="dw-mono base64-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="输入文本，中文与 emoji 也可以…" aria-describedby="base64Status"></textarea></div>
                </section>
                <section class="dw-card base64-panel base64-output-panel" aria-labelledby="base64OutputLabel" data-stale="false">
                    <header class="dw-card-header base64-panel-header"><h2 id="base64OutputLabel" class="dw-card-title">Base64 结果</h2>
                        <div class="dw-actions"><button id="base64UseResultBtn" class="dw-button" type="button" disabled title="把结果送回输入，并切换转换方向">反向转换</button>
                            <button id="base64CopyBtn" class="dw-button" type="button" disabled title="复制输出">复制</button></div></header>
                    <div class="base64-editor-body"><label class="base64-sr-only" for="base64Output">转换结果</label>
                        <textarea id="base64Output" class="dw-mono base64-textarea" spellcheck="false" readonly placeholder="转换结果显示在这里…"></textarea></div>
                </section>
            </div>
            <div class="base64-bottom"><p id="base64Status" class="dw-status" role="status" aria-live="polite">输入后按所选方向转换，或按 Ctrl + Enter。</p>
                <div id="base64Stats" class="base64-stats" aria-label="文本统计"><span id="base64InputStats"></span><span id="base64OutputStats"></span></div></div>
            <footer class="dw-footer"><p class="dw-status">Base64 是编码方式。解码结果按 UTF-8 文本读取。</p><span class="dw-status">Ctrl / ⌘ + Enter 转换</span></footer>
        </div>`;
}

function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function node(view, id) { return view.root.querySelector('#' + id); }
function setStatus(view, text, tone = '') {
    const status = node(view, 'base64Status'); status.textContent = text; status.dataset.tone = tone;
}
function clearTimer(view) { clearTimeout(view.timer); view.timer = null; }
function updateStats(view) {
    for (const [field, target, label] of [['base64Input', 'base64InputStats', '输入'], ['base64Output', 'base64OutputStats', '输出']]) {
        const metrics = getTextMetrics(node(view, field).value);
        node(view, target).textContent = `${label} ${metrics.characters.toLocaleString()} 字符 · ${metrics.bytes.toLocaleString()} 字节`;
    }
    node(view, 'base64CopyInputBtn').disabled = !node(view, 'base64Input').value;
}
function updateResultActions(view) {
    node(view, 'base64CopyBtn').disabled = !view.valid || !node(view, 'base64Output').value;
    node(view, 'base64UseResultBtn').disabled = !view.valid;
    view.root.querySelector('.base64-output-panel').dataset.stale = String(!view.valid && !!node(view, 'base64Output').value);
}
function updateSettings(view) {
    view.root.querySelectorAll('[data-base64-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.base64Mode === view.mode)));
    view.root.querySelectorAll('[data-base64-variant]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.base64Variant === 'url') === view.urlSafe)));
    node(view, 'base64AutoConvert').checked = view.auto;
    node(view, 'base64OmitPadding').checked = view.omitPadding;
    node(view, 'base64RunBtn').textContent = view.mode === 'encode' ? '立即编码' : '立即解码';
    node(view, 'base64InputLabel').textContent = view.mode === 'encode' ? '原始文本' : 'Base64 输入';
    node(view, 'base64OutputLabel').textContent = view.mode === 'encode' ? 'Base64 结果' : 'UTF-8 文本';
    node(view, 'base64Input').placeholder = view.mode === 'encode' ? '输入文本，中文与 emoji 也可以…' : '粘贴 Base64 内容，支持换行与省略的填充…';
    node(view, 'base64FormatHint').textContent = (view.urlSafe ? 'URL-safe 使用 - 和 _，适合 URL 参数；' : '标准字符集使用 + 和 /；')
        + (view.mode === 'decode' ? '解码时自动补齐省略的填充，并严格检查 UTF-8。' : '解码时兼容换行与省略的填充。');
}
function invalidate(view) {
    view.revision++; clearTimer(view); view.pending = false; view.valid = false; view.attempted = false;
    node(view, 'base64Input').removeAttribute('aria-invalid');
    setStatus(view, node(view, 'base64Output').value ? '输入或设置已更新，结果待重新转换。' : '输入后按所选方向转换，或按 Ctrl + Enter。');
    updateResultActions(view); updateStats(view);
}
function runConversion(view, { animate = true, restoring = false } = {}) {
    clearTimer(view); view.pending = false;
    if (!active(view) || (view.suspended && !restoring)) return;
    view.attempted = true;
    try {
        const output = convertBase64(node(view, 'base64Input').value, view);
        node(view, 'base64Output').value = output; view.valid = true;
        node(view, 'base64Input').removeAttribute('aria-invalid');
        setStatus(view, (view.mode === 'encode' ? '编码完成' : '解码完成') + (output ? ' · UTF-8' : ' · 结果为空文本'), 'success');
        if (animate && output) revealContent(node(view, 'base64Output'), { signal: view.controller.signal, distance: 3 });
    } catch (error) {
        view.valid = false; node(view, 'base64Output').value = '';
        node(view, 'base64Input').setAttribute('aria-invalid', 'true');
        setStatus(view, error.message, 'error');
    }
    updateStats(view); updateResultActions(view);
}
function schedule(view) {
    clearTimer(view); view.pending = view.auto && node(view, 'base64Input').value.length > 0;
    if (!view.pending || view.suspended) return;
    view.timer = setTimeout(() => { view.timer = null; runConversion(view); }, AUTO_DELAY);
}
async function paste(view) {
    if (view.pasting) return;
    const revision = view.revision;
    const token = ++view.ioGeneration;
    view.pasting = true; node(view, 'base64PasteBtn').disabled = true;
    try {
        const value = await navigator.clipboard.readText();
        if (!active(view) || view.suspended || revision !== view.revision || token !== view.ioGeneration) return;
        node(view, 'base64Input').value = value;
        invalidate(view); schedule(view); node(view, 'base64Input').focus();
    } catch {
        if (active(view) && !view.suspended && revision === view.revision && token === view.ioGeneration) setStatus(view, '无法读取剪贴板，请使用 Ctrl + V。', 'error');
    } finally {
        if (active(view) && token === view.ioGeneration) { view.pasting = false; node(view, 'base64PasteBtn').disabled = false; }
    }
}
async function copy(view, source) {
    if (source === 'base64Output' && !view.valid) return;
    const value = node(view, source).value;
    if (!value) return;
    const revision = view.revision;
    try {
        await navigator.clipboard.writeText(value);
        if (active(view) && !view.suspended && view.revision === revision) setStatus(view, source === 'base64Output' ? '转换结果已复制' : '输入内容已复制', 'success');
    } catch {
        if (active(view) && !view.suspended && view.revision === revision) setStatus(view, '复制失败，请手动选择文本复制。', 'error');
    }
}
function reverse(view) {
    if (!view.valid) return;
    const output = node(view, 'base64Output').value;
    view.mode = view.mode === 'encode' ? 'decode' : 'encode';
    node(view, 'base64Input').value = output;
    updateSettings(view); invalidate(view); runConversion(view);
    node(view, 'base64Input').focus({ preventScroll: true });
}

export function initBase64Tool() {
    destroyBase64Tool();
    const root = document.querySelector('.base64-container');
    if (!root) return;
    const view = { root, controller: new AbortController(), mode: 'encode', urlSafe: false, omitPadding: false,
        auto: true, valid: false, attempted: false, revision: 0, ioGeneration: 0, timer: null, pending: false,
        pasting: false, suspended: document.documentElement.classList.contains('app-is-suspended') };
    state = view;
    const { signal } = view.controller;
    const on = (target, event, handler) => target.addEventListener(event, handler, { signal });
    on(node(view, 'base64Input'), 'input', () => { invalidate(view); schedule(view); });
    root.querySelectorAll('[data-base64-mode]').forEach(button => on(button, 'click', () => {
        view.mode = button.dataset.base64Mode; updateSettings(view); invalidate(view); runConversion(view);
    }));
    root.querySelectorAll('[data-base64-variant]').forEach(button => on(button, 'click', () => {
        view.urlSafe = button.dataset.base64Variant === 'url'; updateSettings(view); invalidate(view); schedule(view);
    }));
    on(node(view, 'base64OmitPadding'), 'change', event => {
        view.omitPadding = event.currentTarget.checked; invalidate(view); schedule(view);
    });
    on(node(view, 'base64AutoConvert'), 'change', event => {
        view.auto = event.currentTarget.checked; clearTimer(view); view.pending = false;
        if (view.auto) schedule(view);
    });
    on(node(view, 'base64RunBtn'), 'click', () => runConversion(view));
    on(node(view, 'base64PasteBtn'), 'click', () => { void paste(view); });
    on(node(view, 'base64CopyBtn'), 'click', () => { void copy(view, 'base64Output'); });
    on(node(view, 'base64CopyInputBtn'), 'click', () => { void copy(view, 'base64Input'); });
    on(node(view, 'base64UseResultBtn'), 'click', () => reverse(view));
    on(node(view, 'base64ClearBtn'), 'click', () => {
        node(view, 'base64Input').value = ''; node(view, 'base64Output').value = '';
        invalidate(view); node(view, 'base64Input').focus({ preventScroll: true });
    });
    on(node(view, 'base64Input'), 'keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); runConversion(view); }
    });
    on(window, 'dtkit:power-state', event => {
        view.suspended = event.detail?.suspended === true;
        if (view.suspended) { clearTimer(view); view.ioGeneration++; view.pasting = false; node(view, 'base64PasteBtn').disabled = false; }
        else if (view.pending) schedule(view);
    });
    root.querySelectorAll('.dw-segmented').forEach(group => mountSegmentedControl(group, { signal }));
    updateSettings(view); updateStats(view); updateResultActions(view); revealContent(root, { signal });
}

function serializePageDraft() {
    if (!state) return null;
    const view = state;
    const editors = {};
    for (const id of ['base64Input', 'base64Output']) {
        const editor = node(view, id);
        editors[id] = { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd,
            direction: editor.selectionDirection, scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft };
    }
    return { version: 1, mode: view.mode, urlSafe: view.urlSafe, omitPadding: view.omitPadding, auto: view.auto,
        valid: view.valid, attempted: view.attempted, pending: view.pending, editors,
        focusedField: document.hasFocus() ? document.activeElement?.id : null, scrollTop: view.root.scrollTop };
}
function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return;
    const view = state;
    clearTimer(view); view.revision++; view.ioGeneration++; view.pasting = false;
    node(view, 'base64PasteBtn').disabled = false;
    view.mode = snapshot.mode === 'decode' ? 'decode' : 'encode'; view.urlSafe = snapshot.urlSafe === true;
    view.omitPadding = snapshot.omitPadding === true; view.auto = snapshot.auto !== false;
    view.valid = false; view.attempted = false; view.pending = false;
    for (const id of ['base64Input', 'base64Output']) node(view, id).value = typeof snapshot.editors?.[id]?.value === 'string' ? snapshot.editors[id].value : '';
    node(view, 'base64Input').removeAttribute('aria-invalid'); updateSettings(view);
    if (snapshot.attempted) runConversion(view, { animate: false, restoring: true });
    else setStatus(view, node(view, 'base64Output').value ? '输入或设置已更新，结果待重新转换。' : '输入后按所选方向转换，或按 Ctrl + Enter。');
    updateStats(view); updateResultActions(view);
    for (const id of ['base64Input', 'base64Output']) {
        const saved = snapshot.editors?.[id]; const editor = node(view, id);
        if (Number.isInteger(saved?.start) && Number.isInteger(saved?.end)) editor.setSelectionRange(saved.start, saved.end, saved.direction);
        editor.scrollTop = Number.isFinite(saved?.scrollTop) ? saved.scrollTop : 0;
        editor.scrollLeft = Number.isFinite(saved?.scrollLeft) ? saved.scrollLeft : 0;
    }
    view.root.scrollTop = Number.isFinite(snapshot.scrollTop) ? snapshot.scrollTop : 0;
    if (snapshot.pending && view.auto) schedule(view);
    if (['base64Input', 'base64Output'].includes(snapshot.focusedField) && document.hasFocus() && !view.suspended) node(view, snapshot.focusedField).focus({ preventScroll: true });
}
export function destroyBase64Tool() {
    if (!state) return;
    const view = state; state = null; clearTimer(view); view.controller.abort();
}

registerTool({
    id: 'base64-codec', name: 'Base64 编解码', icon: 'ri-lock-2-line', colorClass: 'tool-card__icon--green', category: 'dev',
    description: 'UTF-8 文本与 Base64 相互转换，支持 URL-safe 和省略填充。',
    template: getTemplate, init: initBase64Tool, destroy: destroyBase64Tool,
    serialize: serializePageDraft, restore: restorePageDraft
});
