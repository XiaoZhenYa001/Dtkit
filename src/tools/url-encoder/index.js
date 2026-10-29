import { registerTool } from '../toolRegistry.js';
import { URL_ACTIONS, URL_MODES, transformUrlBatch, inspectUrlQuery } from './core.js';
import { getTemplate } from './template.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/url-encoder.css';

let state = null;
const MODE_HINTS = {
    component: '单个参数值或路径片段：&、=、/ 等会编码，空格为 %20；解码时保留字面 +。',
    full: '保留 : / ? & = # 等 URL 结构字符；解码也保留 %2F、%26 等已编码的结构字符。此模式不校验网址。',
    form: '单个表单参数值：空格编码为 +，字面 + 编码为 %2B；解码时将 + 还原为空格。'
};
function node(view, id) { return view.root.querySelector('#' + id); }
function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function settings(view) {
    return { input: node(view, 'urlInput').value, mode: node(view, 'urlMode').value, perLine: node(view, 'urlBatchMode').checked };
}
function setStatus(view, message, tone = '') {
    const status = node(view, 'urlStatus'); status.textContent = message; status.dataset.tone = tone;
}
function update(view) {
    const input = node(view, 'urlInput').value;
    const output = node(view, 'urlOutput').value;
    node(view, 'urlInputCount').textContent = `${Array.from(input).length.toLocaleString()} 字符`;
    node(view, 'urlOutputCount').textContent = output ? `${Array.from(output).length.toLocaleString()} 字符` : '等待转换';
    node(view, 'urlModeHint').textContent = MODE_HINTS[node(view, 'urlMode').value];
    node(view, 'urlCopyBtn').disabled = !view.valid || !output;
    node(view, 'urlSwapBtn').disabled = !view.valid || !output;
    node(view, 'urlResultState').textContent = view.valid ? '已转换' : output ? '待更新' : '未转换';
    view.root.querySelector('.url-output-panel').dataset.stale = String(!view.valid && !!output);
}
function invalidate(view) {
    view.revision++; view.valid = false; view.attempted = null; view.query = null;
    node(view, 'urlInput').removeAttribute('aria-invalid');
    node(view, 'urlErrors').replaceChildren(); node(view, 'urlErrors').hidden = true;
    node(view, 'urlQueryPanel').hidden = true; node(view, 'urlQueryCopyBtn').disabled = true;
    setStatus(view, node(view, 'urlOutput').value ? '输入或模式已改变，结果待重新转换。' : '输入内容，选择模式后编码或解码。');
    update(view);
}
function run(view, action, { restoring = false } = {}) {
    if (!active(view) || (view.suspended && !restoring)) return;
    const config = settings(view); view.revision++;
    view.attempted = { ...config, action }; view.valid = false;
    node(view, 'urlErrors').replaceChildren(); node(view, 'urlErrors').hidden = true;
    node(view, 'urlInput').removeAttribute('aria-invalid');
    try {
        if (!config.input) throw new TypeError('请先输入需要处理的内容');
        const result = transformUrlBatch(config.input, action, config.mode, { perLine: config.perLine });
        node(view, 'urlOutput').value = result.output;
        if (result.errors.length) {
            node(view, 'urlInput').setAttribute('aria-invalid', 'true');
            node(view, 'urlErrors').hidden = false;
            for (const error of result.errors.slice(0, 12)) {
                const item = document.createElement('li'); item.textContent = `第 ${error.line} 行：${error.message}`;
                node(view, 'urlErrors').append(item);
            }
            setStatus(view, `${result.errors.length} ${config.perLine ? '行' : '处'}转换失败${result.errors.length > 12 ? '（下方显示前 12 行）' : ''}，修正后可重新转换并复制完整结果。`, 'error');
        } else {
            view.valid = true;
            setStatus(view, `${action === URL_ACTIONS.ENCODE ? '编码' : '解码'}完成${config.perLine ? ` · ${result.lines} 行` : ''}`, 'success');
        }
    } catch (error) {
        node(view, 'urlOutput').value = ''; node(view, 'urlInput').setAttribute('aria-invalid', 'true');
        setStatus(view, error.message || '转换失败', 'error');
    }
    update(view);
}
function inspect(view, { restoring = false } = {}) {
    if (!active(view) || (view.suspended && !restoring)) return;
    const panel = node(view, 'urlQueryPanel'); panel.hidden = false; panel.open = true; view.query = null;
    node(view, 'urlQueryRows').replaceChildren(); node(view, 'urlQueryMeta').textContent = '';
    node(view, 'urlQueryCount').textContent = ''; node(view, 'urlQueryCopyBtn').disabled = true;
    const status = node(view, 'urlQueryStatus'); status.dataset.tone = '';
    try {
        const query = inspectUrlQuery(node(view, 'urlInput').value); view.query = query;
        node(view, 'urlQueryCount').textContent = `${query.rows.length} 项`;
        status.textContent = query.rows.length ? '按表单规则解码名称与值，保留重复参数及原有顺序。' : '未发现查询参数。';
        if (!query.valid) { status.textContent = '部分参数包含无效编码，已标出并保留原文。修正后可复制 JSON。'; status.dataset.tone = 'error'; }
        node(view, 'urlQueryMeta').textContent = query.hasFragment ? `片段 #${query.fragment}（保留原文，不参与参数解析）` : '没有 # 片段；参数值中的 + 按空格解释。';
        for (const row of query.rows) {
            const tr = document.createElement('tr'); tr.dataset.urlQueryRow = String(row.index);
            if (row.errors.length) tr.dataset.invalid = 'true';
            for (const text of [String(row.index), row.name || '（空名称）', row.value || '（空值）', row.errors.join('；') || (row.hasEquals ? '' : '未写 =')]) {
                const td = document.createElement('td'); td.textContent = text; tr.append(td);
            }
            node(view, 'urlQueryRows').append(tr);
        }
        node(view, 'urlQueryCopyBtn').disabled = !query.valid || !query.rows.length;
    } catch (error) { status.textContent = error.message || '参数解析失败'; status.dataset.tone = 'error'; }
}
async function copy(view, query = false) {
    if (!active(view) || view.suspended) return;
    if (query ? !view.query?.valid || !view.query.rows.length : !view.valid || !node(view, 'urlOutput').value) return;
    const text = query ? JSON.stringify(view.query.rows.map(({ name, value, hasEquals }) => ({ name, value, hasEquals })), null, 2) : node(view, 'urlOutput').value;
    const revision = view.revision;
    try {
        await navigator.clipboard.writeText(text);
        if (!active(view) || view.suspended || revision !== view.revision) return;
        if (query) node(view, 'urlQueryStatus').textContent = '已复制 JSON 数组，重复参数及顺序已保留。';
        else setStatus(view, '转换结果已复制', 'success');
    } catch {
        if (!active(view) || view.suspended || revision !== view.revision) return;
        if (query) { node(view, 'urlQueryStatus').textContent = '复制失败，可从表格手动选择参数。'; node(view, 'urlQueryStatus').dataset.tone = 'error'; }
        else setStatus(view, '复制失败，请手动选择结果。', 'error');
    }
}
function initUrlEncoder() {
    destroyUrlEncoder();
    const root = document.querySelector('.url-tool'); if (!root) return;
    const view = { root, controller: new AbortController(), revision: 0, valid: false, attempted: null, query: null, suspended: false }; state = view;
    const on = (element, event, handler) => element.addEventListener(event, handler, { signal: view.controller.signal });
    on(node(view, 'urlInput'), 'input', () => invalidate(view));
    on(node(view, 'urlMode'), 'change', () => invalidate(view));
    on(node(view, 'urlBatchMode'), 'change', () => invalidate(view));
    on(node(view, 'urlEncodeBtn'), 'click', () => run(view, URL_ACTIONS.ENCODE));
    on(node(view, 'urlDecodeBtn'), 'click', () => run(view, URL_ACTIONS.DECODE));
    on(node(view, 'urlCopyBtn'), 'click', () => { void copy(view); });
    on(node(view, 'urlQueryCopyBtn'), 'click', () => { void copy(view, true); });
    on(node(view, 'urlInspectBtn'), 'click', () => inspect(view));
    on(node(view, 'urlSwapBtn'), 'click', () => {
        if (!view.valid || !node(view, 'urlOutput').value) return;
        node(view, 'urlInput').value = node(view, 'urlOutput').value; node(view, 'urlOutput').value = '';
        invalidate(view); node(view, 'urlInput').focus({ preventScroll: true }); setStatus(view, '结果已移到输入框，可以反向转换。');
    });
    on(node(view, 'urlClearBtn'), 'click', () => {
        node(view, 'urlInput').value = ''; node(view, 'urlOutput').value = ''; invalidate(view);
        node(view, 'urlInput').focus({ preventScroll: true });
    });
    root.querySelectorAll('[data-url-example]').forEach(button => on(button, 'click', () => {
        node(view, 'urlInput').value = button.dataset.urlExample; node(view, 'urlMode').value = button.dataset.urlMode;
        node(view, 'urlBatchMode').checked = false; invalidate(view);
        if (button.hasAttribute('data-url-inspect')) inspect(view);
        else node(view, 'urlInput').focus({ preventScroll: true });
    }));
    on(node(view, 'urlInput'), 'keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
            event.preventDefault(); run(view, event.shiftKey ? URL_ACTIONS.DECODE : URL_ACTIONS.ENCODE);
        }
    });
    on(window, 'dtkit:power-state', event => { view.suspended = event.detail?.suspended === true; view.revision++; });
    update(view);
}
function serializePageDraft() {
    if (!state) return null;
    const view = state; const editors = {};
    for (const id of ['urlInput', 'urlOutput']) {
        const editor = node(view, id);
        editors[id] = { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft };
    }
    return { version: 1, ...settings(view), editors, attempted: view.attempted,
        queryShown: !node(view, 'urlQueryPanel').hidden, queryOpen: node(view, 'urlQueryPanel').open };
}
function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return;
    const view = state; view.revision++;
    node(view, 'urlMode').value = Object.values(URL_MODES).includes(snapshot.mode) ? snapshot.mode : URL_MODES.COMPONENT;
    node(view, 'urlBatchMode').checked = snapshot.perLine === true;
    for (const id of ['urlInput', 'urlOutput']) node(view, id).value = typeof snapshot.editors?.[id]?.value === 'string' ? snapshot.editors[id].value : '';
    invalidate(view);
    const attempt = snapshot.attempted; const config = settings(view);
    if (attempt && Object.values(URL_ACTIONS).includes(attempt.action) && attempt.input === config.input && attempt.mode === config.mode && attempt.perLine === config.perLine) run(view, attempt.action, { restoring: true });
    if (snapshot.queryShown) { inspect(view, { restoring: true }); node(view, 'urlQueryPanel').open = snapshot.queryOpen !== false; }
    for (const id of ['urlInput', 'urlOutput']) {
        const editor = node(view, id); const saved = snapshot.editors?.[id];
        if (Number.isInteger(saved?.start) && Number.isInteger(saved?.end)) editor.setSelectionRange(saved.start, saved.end, saved.direction);
        editor.scrollTop = Number.isFinite(saved?.scrollTop) ? saved.scrollTop : 0;
        editor.scrollLeft = Number.isFinite(saved?.scrollLeft) ? saved.scrollLeft : 0;
    }
}
function destroyUrlEncoder() { if (state) { state.controller.abort(); state = null; } }

registerTool({
    id: 'url-encoder', name: 'URL 编码', icon: 'ri-global-line', colorClass: 'tool-card__icon--blue', category: 'other', status: 'ready',
    description: 'URL 与表单参数值编解码，支持逐行处理和查询参数查看。',
    template: getTemplate, init: initUrlEncoder, destroy: destroyUrlEncoder,
    serialize: serializePageDraft, restore: restorePageDraft
});
export { destroyUrlEncoder, initUrlEncoder };
