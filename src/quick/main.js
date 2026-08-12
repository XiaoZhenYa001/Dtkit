import { detectCommand, evaluateExpression, formatNumber, transformText } from './commandEngine.js';
import '../css/tool-shortcut.css';

const TOOL_LABELS = Object.freeze({
    'timestamp-converter': '时间戳转换', 'json-formatter': 'JSON / YAML / XML 转换',
    'base64-codec': 'Base64 编解码', 'hash-tool': 'MD5 / Hash',
    'qr-generator': '二维码生成', 'color-picker': '颜色提取器',
    'html-preview': 'HTML 预览', 'url-encoder': 'URL 编码',
    'crontab-explainer': 'Crontab 解释', 'unit-converter': '单位换算',
    'alarm-clock': '定时闹钟', 'file-batch': '文件批处理',
    'transfer-station': '临时文件中转站', 'resource-center': '资源控制中心',
    'whiteboard': '白板', 'password-vault': '密码',
    'text-snippets': '文本片段库', 'screenshot-annotator': '截图与标注'
});
const RECENT_KEY = 'dtkit_quick_recent_actions';
const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const title = document.getElementById('quickTitle');
const heading = document.getElementById('quickHeading');
const description = document.getElementById('quickDescription');
const content = document.getElementById('quickContent');
const status = document.getElementById('quickStatus');
const toolContainer = document.getElementById('dynamicToolContainer');
const palette = document.getElementById('quickPalette');
const input = document.getElementById('commandInput');
const results = document.getElementById('commandResults');
const paletteHint = document.getElementById('paletteHint');
const shell = document.querySelector('.quick-shell');
const titlebar = document.querySelector('.quick-titlebar');
const pinButton = document.getElementById('quickPin');
let activeToolId = null;
let alwaysOnTop = false;
let pinBusy = false;
let toolRuntime = null;
let renderGeneration = 0;
let searchGeneration = 0;
let searchDelay = null;
let selectedIndex = 0;
let currentActions = [];
let disabledToolIds = new Set();
let lastActivityTouch = 0;

async function loadToolModulePolicy() {
    try {
        const ids = await invoke('get_tool_module_settings');
        disabledToolIds = new Set(Array.isArray(ids) ? ids : []);
    } catch {
        disabledToolIds = new Set();
    }
}

function setToolChrome(toolId = null) {
    const isWhiteboard = toolId === 'whiteboard';
    shell?.classList.toggle('quick-shell--whiteboard', isWhiteboard);
    [...document.documentElement.classList]
        .filter(name => name.startsWith('quick-tool--'))
        .forEach(name => document.documentElement.classList.remove(name));
    if (toolId) document.documentElement.classList.add(`quick-tool--${toolId}`);
}

async function getToolRuntime() {
    if (toolRuntime) return toolRuntime;
    await import('../tools/index.js');
    toolRuntime = await import('../tools/toolRegistry.js');
    return toolRuntime;
}

function releaseTool() {
    if (activeToolId && toolRuntime) toolRuntime.destroyTool(activeToolId);
    activeToolId = null;
    setToolChrome();
    toolContainer.replaceChildren();
    content.classList.remove('quick-content--tool');
}

function schedulePaletteIdleDismiss() {
    if (palette.hidden) return;
    const now = Date.now();
    if (now - lastActivityTouch < 750) return;
    lastActivityTouch = now;
    invoke('touch_quick_host_activity').catch(() => {});
}

function readRecent() {
    try {
        const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(value) ? value.filter(item => item?.query && item?.label).slice(0, 8) : [];
    } catch { return []; }
}

function remember(action) {
    if (!action.query || !action.label) return;
    const next = [{ query: action.query, label: action.label, detail: action.detail || '' },
        ...readRecent().filter(item => item.query !== action.query)].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* optional cache */ }
}

async function copyText(value) {
    await navigator.clipboard.writeText(value);
    paletteHint.textContent = '已复制到剪贴板';
}

function actionButton(action, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `command-result${index === selectedIndex ? ' is-selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === selectedIndex));
    const icon = document.createElement('span');
    const iconClasses = {
        open: 'ri-arrow-right-up-line', tools: 'ri-apps-2-line', recent: 'ri-history-line',
        calculate: 'ri-calculator-line', code: 'ri-code-line', timer: 'ri-time-line',
        folder: 'ri-folder-line', file: 'ri-file-line'
    };
    icon.className = `command-result__icon ${iconClasses[action.icon] || iconClasses.open}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'command-result__text';
    const label = document.createElement('strong');
    label.textContent = action.label;
    const detail = document.createElement('small');
    detail.textContent = action.detail || '';
    text.append(label, detail);
    const key = document.createElement('kbd');
    key.textContent = action.key || 'Enter';
    button.append(icon, text, key);
    button.addEventListener('click', () => executeAction(action));
    return button;
}

function showActions(actions, hint = '') {
    currentActions = actions;
    selectedIndex = Math.min(selectedIndex, Math.max(0, actions.length - 1));
    results.replaceChildren(...actions.map(actionButton));
    paletteHint.textContent = hint || (actions.length ? `${actions.length} 个结果` : '没有匹配结果');
}

function toolActions(query = '') {
    const needle = query.toLowerCase();
    return Object.entries(TOOL_LABELS)
        .filter(([id]) => !disabledToolIds.has(id))
        .filter(([id, label]) => !needle || `${id} ${label}`.toLowerCase().includes(needle))
        .map(([toolId, label]) => ({
            label, detail: '在轻量窗口中打开', icon: 'tools', query: label,
            run: () => invoke('open_quick_host', { target: { kind: 'tool', toolId } })
        }));
}

function renderHome() {
    const recent = readRecent().map(item => ({
        ...item, icon: 'recent',
        run: async () => {
            input.value = item.query;
            await refreshPalette();
            if (currentActions.length === 1) await executeAction(currentActions[0]);
        }
    }));
    const tools = toolActions();
    const toolLabels = new Set(tools.map(action => action.label));
    const extraRecent = recent
        .filter(action => !toolLabels.has(action.label))
        .map(action => ({ ...action, detail: `最近操作 · ${action.detail || '再次执行'}` }));
    showActions([...tools, ...extraRecent], `全部 ${tools.length} 个可用工具${extraRecent.length ? ` · ${extraRecent.length} 条最近操作` : ''}`);
}

function renderCalculation(command, rawQuery) {
    try {
        const value = formatNumber(evaluateExpression(command.expression));
        showActions([{ label: value, detail: `${command.expression} · Enter 复制`, icon: 'calculate',
            query: rawQuery, run: () => copyText(value) }], '计算在本地完成，不执行脚本');
    } catch (error) { showActions([], error.message); }
}

function renderTransform(command, rawQuery) {
    try {
        showActions(transformText(command.operation, command.value).map(result => ({
            label: result.label, detail: result.value, icon: 'code', query: rawQuery,
            run: () => copyText(result.value)
        })), 'Enter 复制结果');
    } catch (error) { showActions([], error.message); }
}

function renderCountdown(command, rawQuery) {
    showActions([{ label: `创建 ${command.name}`,
        detail: `${command.seconds} 秒 · 最小化或深度休眠时仍会系统提醒`, icon: 'timer', query: rawQuery,
        run: async () => {
            await invoke('create_quick_countdown', { seconds: command.seconds, name: command.name });
            paletteHint.textContent = '倒计时已交给原生后台调度';
        }
    }], '不依赖前端计时');
}

function renderFileSearch(command, rawQuery) {
    const generation = ++searchGeneration;
    if (searchDelay) clearTimeout(searchDelay);
    if (command.query.length < 2) return showActions([], '输入至少 2 个字符，例如：> report');
    showActions([], '正在按需搜索常用目录…');
    searchDelay = setTimeout(async () => {
        try {
            const response = await invoke('search_local_files', { query: command.query, limit: 24 });
            if (generation !== searchGeneration) return;
            const actions = response.items.map(item => ({
                label: item.name, detail: item.parent,
                icon: item.isDirectory ? 'folder' : 'file', query: rawQuery,
                run: () => invoke('open_local_search_result', { path: item.path })
            }));
            showActions(actions, `${response.elapsedMs}ms · ${response.rootsSearched} 个常用目录${response.truncated ? ' · 已达到本次搜索上限' : ''}`);
        } catch (error) {
            if (generation === searchGeneration) showActions([], String(error));
        }
    }, 220);
}

async function refreshPalette() {
    selectedIndex = 0;
    const rawQuery = input.value.trim();
    const command = detectCommand(rawQuery);
    if (command.kind !== 'file') {
        searchGeneration += 1;
        if (searchDelay) clearTimeout(searchDelay);
    }
    if (command.kind === 'home') return renderHome();
    if (command.kind === 'calculation') return renderCalculation(command, rawQuery);
    if (command.kind === 'transform') return renderTransform(command, rawQuery);
    if (command.kind === 'countdown') return renderCountdown(command, rawQuery);
    if (command.kind === 'file') return renderFileSearch(command, rawQuery);
    showActions(toolActions(command.query), '匹配内部工具');
}

async function executeAction(action) {
    if (!action?.run) return;
    try { await action.run(); remember(action); }
    catch (error) { paletteHint.textContent = String(error); }
}

function moveSelection(offset) {
    if (!currentActions.length) return;
    selectedIndex = (selectedIndex + offset + currentActions.length) % currentActions.length;
    [...results.children].forEach((element, index) => {
        const selected = index === selectedIndex;
        element.classList.toggle('is-selected', selected);
        element.setAttribute('aria-selected', String(selected));
    });
    results.children[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

async function renderTarget(target) {
    const generation = ++renderGeneration;
    releaseTool();
    palette.hidden = target.kind !== 'palette';
    if (target.kind === 'palette') {
        await loadToolModulePolicy();
        if (generation !== renderGeneration) return;
        document.title = '万能命令面板 · DtKit';
        title.textContent = '万能命令面板';
        status.hidden = true;
        content.classList.add('quick-content--palette');
        input.value = '';
        renderHome();
        input.focus();
        schedulePaletteIdleDismiss();
        return;
    }
    content.classList.remove('quick-content--palette');
    const toolName = TOOL_LABELS[target.toolId] || target.toolId || '工具';
    document.title = `正在加载 ${toolName} · DtKit`;
    title.textContent = toolName;
    heading.textContent = `正在加载 ${toolName}…`;
    description.textContent = '仅加载当前工具所需的代码与样式。';
    status.hidden = false;
    try {
        const runtime = await getToolRuntime();
        const tool = await runtime.loadTool(target.toolId);
        if (generation !== renderGeneration) return;
        if (typeof tool.template !== 'function' || typeof tool.init !== 'function') throw new Error('工具缺少快捷窗口适配器');
        toolContainer.innerHTML = tool.template();
        activeToolId = target.toolId;
        setToolChrome(target.toolId);
        await Promise.resolve(tool.init());
        if (generation !== renderGeneration) return releaseTool();
        status.hidden = true;
        content.classList.add('quick-content--tool');
        document.title = `${toolName} · DtKit`;
    } catch (error) {
        setToolChrome();
        document.title = '加载失败 · DtKit';
        heading.textContent = `${toolName} 暂时无法打开`;
        description.textContent = String(error?.message || error);
    }
}

function targetFromLocation() {
    const params = new URLSearchParams(location.search);
    return params.get('kind') === 'tool' ? { kind: 'tool', toolId: params.get('toolId') } : { kind: 'palette' };
}

async function dismiss() {
    releaseTool();
    await invoke('dismiss_quick_host');
}

document.getElementById('quickClose').addEventListener('click', dismiss);
pinButton.addEventListener('click', async () => {
    if (pinBusy) return;
    pinBusy = true;
    const next = !alwaysOnTop;
    try {
        await globalThis.window?.__TAURI__?.window?.getCurrentWindow?.().setAlwaysOnTop?.(next);
        alwaysOnTop = next;
        pinButton.classList.toggle('is-active', alwaysOnTop);
        pinButton.setAttribute('aria-pressed', String(alwaysOnTop));
        pinButton.setAttribute('aria-label', alwaysOnTop ? '取消置顶快捷窗口' : '置顶快捷窗口');
        pinButton.title = alwaysOnTop ? '取消置顶' : '置顶窗口';
        pinButton.querySelector('i').className = alwaysOnTop ? 'ri-pushpin-fill' : 'ri-pushpin-line';
    } catch (error) {
        pinButton.title = `置顶失败：${String(error)}`;
    } finally {
        pinBusy = false;
    }
});
document.getElementById('quickMinimize').addEventListener('click', () => {
    globalThis.window?.__TAURI__?.window?.getCurrentWindow?.().minimize?.();
});
document.getElementById('quickMaximize').addEventListener('click', () => {
    globalThis.window?.__TAURI__?.window?.getCurrentWindow?.().toggleMaximize?.();
});
titlebar?.addEventListener('dblclick', event => {
    if (event.target.closest('button')) return;
    globalThis.window?.__TAURI__?.window?.getCurrentWindow?.().toggleMaximize?.();
});
input.addEventListener('input', refreshPalette);
input.addEventListener('input', schedulePaletteIdleDismiss);
['pointerdown', 'keydown', 'wheel', 'focusin'].forEach(type => {
    document.addEventListener(type, schedulePaletteIdleDismiss, { passive: type === 'wheel' });
});
input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        executeAction(currentActions[selectedIndex]);
    } else if (event.key === 'Escape' && input.value) {
        event.stopPropagation();
        input.value = '';
        refreshPalette();
    }
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !input.value) dismiss();
});
globalThis.window?.__TAURI__?.event?.listen('quick-host-target', event => renderTarget(event.payload));
renderTarget(targetFromLocation());
