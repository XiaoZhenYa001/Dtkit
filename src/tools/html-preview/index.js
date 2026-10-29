import '../../css/tools/html-preview.css';
/**
 * HTML 代码预览工具
 * 实时预览 HTML/CSS/JavaScript 代码效果
 */
import { registerTool } from '../toolRegistry.js';
import previewRunnerSource from '../../preview-runner.js?raw';
import { getTemplate } from './template.js';
import { exampleCodes } from './examples.js';
import { createWorkspace } from './workspace.js';

// ============================================
// 工具状态
// ============================================
const previewState = {
    autoRefresh: true,
    refreshTimer: null,
    refreshDelay: 500,
    isFullscreen: false,
    suspended: false,
    disposed: false,
    runnerReady: false,
    lastRendered: null,
    pendingPayload: null,
    requestId: null,
    runResult: 'empty',
    abortController: null  // 用于清理事件监听器
};
let workspace = null;

// ============================================
// 初始化函数
// ============================================
async function init() {
    console.log('[HTMLPreview] 初始化 HTML 预览工具');

    // 清理之前的事件监听器
    if (previewState.abortController) {
        previewState.abortController.abort();
    }
    previewState.abortController = new AbortController();
    previewState.disposed = false;
    previewState.suspended = document.documentElement.classList.contains('app-is-suspended');
    previewState.autoRefresh = document.getElementById('autoRefreshToggle')?.checked !== false;
    previewState.isFullscreen = false;
    previewState.lastRendered = null;
    previewState.pendingPayload = null;
    previewState.requestId = null;
    previewState.runResult = 'empty';

    workspace = createWorkspace({ signal: previewState.abortController.signal, onEdit: handleEdit });
    bindEvents();
    initializePreviewRunner();
}

function initializePreviewRunner(payload = previewState.lastRendered || editorPayload()) {
    const previewFrame = document.getElementById('previewFrame');
    if (!previewFrame || previewState.suspended || previewState.disposed) return;
    previewState.runnerReady = false;

    const nonce = crypto.randomUUID().replaceAll('-', '');
    previewState.requestId = nonce;
    previewState.pendingPayload = { ...payload };
    previewState.runResult = 'running';
    setRunStatus('running', '正在更新…');
    document.getElementById('previewNotice').hidden = true;
    const runnerDocument = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; style-src blob:; img-src data: blob: http: https:; media-src data: blob:; font-src data:">
    <title>DtKit HTML Preview Sandbox</title>
</head>
<body>
    <script nonce="${nonce}">${previewRunnerSource}</script>
</body>
</html>`;

    previewFrame.src = `data:text/html;charset=utf-8,${encodeURIComponent(runnerDocument)}`;
}

// ============================================
// 绑定事件
// ============================================
function bindEvents() {
    const signal = previewState.abortController?.signal;

    // 刷新按钮
    const refreshBtn = document.getElementById('refreshPreviewBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', refreshPreview, { signal });
    }

    // 清空按钮
    const clearBtn = document.getElementById('clearCodeBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearCode, { signal });
    }

    // 自动刷新开关
    const autoRefreshToggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshToggle) {
        autoRefreshToggle.addEventListener('change', (e) => {
            previewState.autoRefresh = e.target.checked;
            if (previewState.autoRefresh) debounceRefresh();
            else { cancelRefresh(); updateDraftStatus(); }
        }, { signal });
    }

    // 全屏按钮
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', toggleFullscreen, { signal });
    }

    // ESC 键退出全屏（使用 signal 管理）
    document.addEventListener('keydown', handleKeydown, { signal });
    window.addEventListener('dtkit:power-state', handlePowerState, { signal });
    window.addEventListener('message', handleRunnerStatus, { signal });

    // runner 加载完成后补发当前内容，避免首次消息早于 iframe 初始化。
    const previewFrame = document.getElementById('previewFrame');
    previewFrame?.addEventListener('load', () => {
        if (previewState.suspended || previewState.disposed || !previewFrame.src.startsWith('data:text/html')) return;
        previewState.runnerReady = true;
        renderPayload(previewState.pendingPayload || editorPayload());
    }, { signal });

    // 示例按钮
    document.querySelectorAll('.html-preview-example-btn').forEach(btn => {
        btn.addEventListener('click', () => loadExample(btn.dataset.example), { signal });
    });
}

function handlePowerState(event) {
    const previewFrame = document.getElementById('previewFrame');
    if (!previewFrame || previewState.disposed) return;
    const suspended = Boolean(event.detail?.suspended);
    if (suspended === previewState.suspended) return;
    previewState.suspended = suspended;
    if (suspended) {
        cancelRefresh();
        previewState.runnerReady = false;
        previewState.requestId = null;
        previewFrame.src = 'about:blank';
        previewState.runResult = 'paused';
        setRunStatus('paused', '预览已暂停');
    } else {
        initializePreviewRunner(previewState.autoRefresh ? editorPayload() : previewState.lastRendered || editorPayload());
    }
}

// ============================================
// 全屏切换
// ============================================
function toggleFullscreen() {
    setFullscreen(!previewState.isFullscreen);
}

function setFullscreen(fullscreen) {
    const panel = document.getElementById('previewResultPanel');
    const btn = document.getElementById('fullscreenBtn');
    if (!panel || !btn) return;

    previewState.isFullscreen = Boolean(fullscreen);
    panel.classList.toggle('fullscreen', previewState.isFullscreen);

    // 更新按钮图标
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = previewState.isFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line';
    }
    btn.title = previewState.isFullscreen ? '退出全屏' : '全屏预览';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(previewState.isFullscreen));
    for (const selector of ['.html-preview-toolbar', '#previewEditorPanel', '#previewDivider', '.html-preview-examples']) {
        const node = document.querySelector(selector);
        if (node) node.inert = previewState.isFullscreen;
    }
    workspace?.fitViewport();
}

// ============================================
// 键盘事件处理
// ============================================
function handleKeydown(e) {
    // ESC 退出全屏
    if (e.key === 'Escape' && previewState.isFullscreen) {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
        document.getElementById('fullscreenBtn')?.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
        e.preventDefault(); refreshPreview();
    }
}

// ============================================
// 切换标签页
// ============================================
function switchTab(tab, focus = true) {
    workspace?.setTab(tab, focus);
}

function handleEdit() {
    const payload = editorPayload();
    updateSizeInfo(payload.html, payload.css, payload.js);
    updateDraftStatus();
    if (previewState.autoRefresh) debounceRefresh();
}

function hasDraftChanges() {
    const payload = editorPayload();
    return ['html', 'css', 'js'].some(type => payload[type] !== (previewState.lastRendered?.[type] || ''));
}

function updateDraftStatus() {
    if (hasDraftChanges()) setRunStatus('pending', previewState.autoRefresh ? '等待更新…' : '有未运行的修改');
    else {
        const result = previewState.runResult;
        setRunStatus(result, { empty: '等待代码', ready: '已更新', error: '运行出错', running: '正在更新…', paused: '预览已暂停' }[result]);
    }
}

function setRunStatus(state, text) {
    const status = document.getElementById('previewRunStatus');
    if (!status) return;
    status.dataset.state = state; status.textContent = text;
}

function handleRunnerStatus(event) {
    const frame = document.getElementById('previewFrame'), data = event.data;
    if (previewState.disposed || previewState.suspended || event.source !== frame?.contentWindow
        || !previewState.requestId || data?.requestId !== previewState.requestId) return;
    if (data.type === 'dtkit-preview-escape' && previewState.isFullscreen) {
        setFullscreen(false); document.getElementById('fullscreenBtn')?.focus();
        return;
    }
    if (data.type !== 'dtkit-preview-status') return;
    if (data.status === 'error') {
        const notice = document.getElementById('previewNotice');
        notice.textContent = `预览出错：${String(data.message || '请检查 JavaScript 代码').slice(0, 200)}`;
        notice.hidden = false; previewState.runResult = 'error'; setRunStatus('error', '运行出错');
    } else if (data.status === 'ready') {
        const empty = !Object.values(previewState.lastRendered || {}).some(value => value.trim());
        document.getElementById('previewEmpty').hidden = !empty;
        previewState.runResult = empty ? 'empty' : 'ready';
        updateDraftStatus();
    }
}

// ============================================
// 防抖刷新
// ============================================
function debounceRefresh() {
    cancelRefresh();
    if (previewState.suspended || previewState.disposed) return;
    previewState.refreshTimer = setTimeout(() => {
        previewState.refreshTimer = null;
        refreshPreview();
    }, previewState.refreshDelay);
}

function cancelRefresh() {
    if (previewState.refreshTimer !== null) clearTimeout(previewState.refreshTimer);
    previewState.refreshTimer = null;
}

// ============================================
// 刷新预览
// ============================================
function refreshPreview() {
    cancelRefresh();
    if (previewState.suspended || previewState.disposed) return;
    const payload = editorPayload();
    previewState.lastRendered = payload;
    updateSizeInfo(payload.html, payload.css, payload.js);
    // A refresh is a new user-code context. This also stops timers/workers created
    // by a previous render instead of accumulating them in the runner document.
    initializePreviewRunner(payload);
}

function editorPayload() {
    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');
    const html = htmlEditor?.value || '';
    const css = cssEditor?.value || '';
    const js = jsEditor?.value || '';
    return { html, css, js };
}

function renderPayload(payload) {
    if (previewState.suspended || previewState.disposed) return;
    const previewFrame = document.getElementById('previewFrame');
    if (!previewFrame) return;
    previewState.lastRendered = { ...payload };
    const current = editorPayload();
    updateSizeInfo(current.html, current.css, current.js);
    document.getElementById('previewEmpty').hidden = Object.values(payload).some(value => value.trim());
    if (!previewState.runnerReady) return;

    previewFrame.contentWindow?.postMessage({
        type: 'dtkit-preview-render',
        requestId: previewState.requestId,
        payload
    }, '*');
}

// ============================================
// 更新大小信息
// ============================================
function updateSizeInfo(html, css, js) {
    const sizeEl = document.getElementById('previewSize');
    if (!sizeEl) return;

    const totalBytes = new Blob([html, css, js]).size;
    let sizeText;

    if (totalBytes < 1024) {
        sizeText = `${totalBytes} B`;
    } else {
        sizeText = `${(totalBytes / 1024).toFixed(1)} KB`;
    }

    sizeEl.textContent = sizeText;
}

// ============================================
// 清空代码
// ============================================
function clearCode() {
    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');

    if (htmlEditor) htmlEditor.value = '';
    if (cssEditor) cssEditor.value = '';
    if (jsEditor) jsEditor.value = '';
    workspace?.updateEditors();
    refreshPreview();
}

// ============================================
// 加载示例
// ============================================
function loadExample(name) {
    const example = exampleCodes[name];
    if (!example) return;

    const htmlEditor = document.getElementById('htmlEditor');
    const cssEditor = document.getElementById('cssEditor');
    const jsEditor = document.getElementById('jsEditor');

    if (htmlEditor) htmlEditor.value = example.html || '';
    if (cssEditor) cssEditor.value = example.css || '';
    if (jsEditor) jsEditor.value = example.js || '';
    workspace?.updateEditors();
    switchTab('html', false);
    refreshPreview();
}

// ============================================
// 销毁函数
// ============================================
function destroy() {
    cancelRefresh();
    setFullscreen(false);
    previewState.disposed = true;
    previewState.suspended = true;
    previewState.runnerReady = false;
    previewState.requestId = null;
    const previewFrame = document.getElementById('previewFrame');
    if (previewFrame) previewFrame.src = 'about:blank';

    // 取消所有事件监听器（包括键盘事件）
    if (previewState.abortController) {
        previewState.abortController.abort();
        previewState.abortController = null;
    }
    workspace = null;

    console.log('[HTMLPreview] 工具已销毁');
}

function serialize() {
    const editors = {};
    for (const type of ['html', 'css', 'js']) {
        const editor = document.getElementById(`${type}Editor`);
        if (!editor) continue;
        editors[type] = { value: editor.value, selectionStart: editor.selectionStart,
            selectionEnd: editor.selectionEnd, selectionDirection: editor.selectionDirection,
            ...workspace.scrollPosition(type) };
    }
    return { version: 1, editors, activeTab: document.querySelector('.panel-tab.active')?.dataset.tab || 'html',
        ...workspace?.snapshot(),
        autoRefresh: previewState.autoRefresh, fullscreen: previewState.isFullscreen,
        rendered: previewState.lastRendered,
        focusedEditor: document.hasFocus() ? document.activeElement?.id : null };
}

function restore(snapshot) {
    if (snapshot?.version !== 1 || !snapshot.editors || previewState.disposed) return;
    cancelRefresh();
    previewState.autoRefresh = snapshot.autoRefresh !== false;
    const toggle = document.getElementById('autoRefreshToggle');
    if (toggle) toggle.checked = previewState.autoRefresh;
    switchTab(snapshot.activeTab || 'html', false);
    for (const type of ['html', 'css', 'js']) {
        const editor = document.getElementById(`${type}Editor`);
        const saved = snapshot.editors[type];
        if (!editor || typeof saved?.value !== 'string') continue;
        editor.value = saved.value;
        if (Number.isInteger(saved.selectionStart) && Number.isInteger(saved.selectionEnd)) {
            editor.setSelectionRange(saved.selectionStart, saved.selectionEnd,
                ['forward', 'backward', 'none'].includes(saved.selectionDirection) ? saved.selectionDirection : 'none');
        }
        workspace?.restoreScroll(type, saved);
    }
    setFullscreen(snapshot.fullscreen);
    workspace?.updateEditors();
    workspace?.restore(snapshot);
    const rendered = snapshot.rendered;
    previewState.lastRendered = rendered && ['html', 'css', 'js'].every(type => typeof rendered[type] === 'string')
        ? { html: rendered.html, css: rendered.css, js: rendered.js } : editorPayload();
    if (!previewState.suspended) {
        const payload = previewState.autoRefresh ? editorPayload() : previewState.lastRendered;
        previewState.lastRendered = payload;
        updateSizeInfo(payload.html, payload.css, payload.js);
        initializePreviewRunner(payload);
        if (['htmlEditor', 'cssEditor', 'jsEditor'].includes(snapshot.focusedEditor)) document.getElementById(snapshot.focusedEditor)?.focus({ preventScroll: true });
    }
}

// ============================================
// 注册工具
// ============================================
registerTool({
    id: 'html-preview',
    name: 'HTML 预览',
    icon: 'ri-code-box-line',
    colorClass: 'tool-card__icon--orange',
    category: 'design',
    description: '实时预览 HTML/CSS/JS 代码效果',
    template: getTemplate,
    init,
    destroy,
    serialize,
    restore
});

console.log('[HTMLPreview] 模块已加载');
