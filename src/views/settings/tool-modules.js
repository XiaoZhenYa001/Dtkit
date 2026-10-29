import { applyDisabledTools, getAllTools } from '../../tools/index.js';
import { createSettingsDisclosure } from './motion.js';

const invoke = (...args) => {
    const nativeInvoke = globalThis.window?.__TAURI__?.core?.invoke;
    if (!nativeInvoke) throw new Error('请在 DtKit 桌面程序中管理工具模块');
    return nativeInvoke(...args);
};
let initialized = false;
let disabled = new Set();
let query = '';
let category = 'all';
let disabledOnly = false;
let loaded = false;
let loading = false;
let disclosure = null;
const pending = new Map();
const queue = [];
let processing = false;
const collapseStorageKey = 'dtkit_toolModulesCollapsed';
const categoryLabels = Object.freeze({ dev: '开发', design: '设计', utility: '效率', other: '其他' });

function statusMessage(message, tone = '') {
    const status = document.getElementById('toolModuleStatus');
    if (!status) return;
    status.textContent = message; status.dataset.tone = tone; status.setAttribute('role', 'status');
}

function setCollapsed(collapsed, persist = true, animate = true) {
    const button = document.getElementById('toolModulesCollapse');
    if (!button || !disclosure) return;
    disclosure.setExpanded(!collapsed, { animate });
    button.querySelector('span').textContent = collapsed ? '展开' : '收起';
    document.getElementById('toolModulesSection')?.classList.toggle('is-collapsed', collapsed);
    if (persist) try { localStorage.setItem(collapseStorageKey, String(collapsed)); } catch { /* Session-only preference. */ }
}

function render() {
    const list = document.getElementById('toolModuleList');
    if (!list) return;
    const focusedRow = document.activeElement?.closest('.tool-module-row');
    const focusedId = focusedRow?.dataset.toolRow;
    const focusedIndex = focusedRow ? [...list.children].indexOf(focusedRow) : -1;
    const tools = getAllTools({ includeDisabled: true, includePrimary: true }).filter(tool => tool.status !== 'planned');
    const needle = query.trim().toLowerCase();
    const visible = tools.filter(tool => (category === 'all' || tool.category === category)
        && (!disabledOnly || disabled.has(tool.id) || pending.has(tool.id))
        && (!needle || `${tool.name} ${tool.description} ${tool.id}`.toLowerCase().includes(needle)));
    const rows = visible.map(tool => {
        const isPending = pending.has(tool.id);
        const enabled = isPending ? pending.get(tool.id) : !disabled.has(tool.id);
        const row = document.createElement('label');
        row.className = `tool-module-row${enabled ? '' : ' is-disabled'}`;
        row.dataset.toolRow = tool.id; row.tabIndex = -1;
        if (isPending || loading) row.setAttribute('aria-busy', 'true');
        const icon = document.createElement('span'); icon.className = 'tool-module-row__icon';
        const glyph = document.createElement('i'); glyph.className = tool.icon; glyph.setAttribute('aria-hidden', 'true'); icon.append(glyph);
        const text = document.createElement('span'); text.className = 'tool-module-row__text';
        const title = document.createElement('strong'); title.textContent = tool.name;
        const badge = document.createElement('em'); badge.textContent = categoryLabels[tool.category] || '工具'; title.append(badge);
        const detail = document.createElement('small');
        detail.textContent = !loaded ? '正在读取模块状态…' : isPending ? `正在${enabled ? '启用' : '停用'}…`
            : disabled.has(tool.id) ? '已停用 · 数据仍保留' : '按需加载 · 当前启用';
        text.append(title, detail);
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'tool-module-toggle';
        toggle.checked = enabled; toggle.disabled = !loaded || loading || isPending; toggle.dataset.toolId = tool.id;
        toggle.setAttribute('aria-label', `${enabled ? '停用' : '启用'}${tool.name}`);
        row.append(icon, text, toggle); return row;
    });
    if (!rows.length) {
        const empty = document.createElement('div'); empty.className = 'tool-module-empty';
        const icon = document.createElement('i'); icon.className = 'ri-search-line'; icon.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong'); title.textContent = '没有匹配的工具模块';
        const detail = document.createElement('span'); detail.textContent = '调整分类或清空搜索条件后重试。';
        empty.append(icon, title, detail); rows.push(empty);
    }
    list.replaceChildren(...rows);
    list.setAttribute('aria-busy', String(loading || pending.size > 0));
    if (focusedId) {
        const current = rows.find(row => row.dataset.toolRow === focusedId) || rows[Math.min(focusedIndex, rows.length - 1)];
        const control = current?.querySelector('input:not(:disabled)') || (current?.dataset.toolRow ? current : document.getElementById('toolModuleSearch'));
        control?.focus({ preventScroll: true });
    }
    const count = document.getElementById('toolModuleEnabledCount');
    if (count) count.textContent = `${loaded ? tools.filter(tool => !disabled.has(tool.id)).length : '—'} / ${tools.length}`;
    const disabledCount = document.getElementById('toolModuleDisabledCount');
    if (disabledCount) disabledCount.textContent = loaded ? String(tools.filter(tool => disabled.has(tool.id)).length) : '—';
}

async function processQueue() {
    if (processing) return;
    processing = true;
    const problems = [];
    let latestSuccess = '';
    try {
        while (queue.length) {
            const { toolId, enabled } = queue.shift();
            const toolName = getAllTools({ includeDisabled: true, includePrimary: true }).find(tool => tool.id === toolId)?.name || toolId;
            statusMessage(`正在${enabled ? '启用' : '停用'}“${toolName}”…`, 'pending');
            try {
                const result = await invoke('set_tool_module_enabled', { toolId, enabled });
                if (!Array.isArray(result) || result.some(id => typeof id !== 'string')) throw new Error('模块服务返回了无效结果');
                disabled = new Set(result); applyDisabledTools(result);
                let warning = '';
                if (!enabled) {
                    try {
                        const bindings = await invoke('get_shortcut_bindings');
                        if (!Array.isArray(bindings)) throw new Error('无法读取快捷键配置');
                        for (const binding of bindings.filter(item => item.target?.kind === 'tool' && item.target.toolId === toolId)) {
                            await invoke('remove_shortcut_binding', { target: binding.target });
                        }
                    } catch (error) { warning = `旧快捷键已失效，但配置清理失败：${error}`; }
                }
                latestSuccess = `“${toolName}”已${enabled ? '启用' : '停用'}${!enabled && !warning ? '并解除专属快捷键' : ''}。`;
                if (warning) problems.push({ message: `“${toolName}”：${warning}`, tone: 'warning' });
                window.dispatchEvent(new CustomEvent('dtkit-tool-modules-changed'));
            } catch (error) { problems.push({ message: `“${toolName}”更新失败：${error}`, tone: 'error' }); }
            finally { pending.delete(toolId); render(); }
        }
    } finally {
        processing = false;
        if (problems.length) statusMessage(problems.slice(0, 3).map(item => item.message).join('；'), problems.some(item => item.tone === 'error') ? 'error' : 'warning');
        else statusMessage(latestSuccess, 'success');
    }
}

function change(event) {
    const input = event.target.closest('input[data-tool-id]');
    if (!input) return;
    const toolId = input.dataset.toolId;
    if (!loaded || loading || pending.has(toolId)) { render(); return; }
    pending.set(toolId, input.checked); queue.push({ toolId, enabled: input.checked });
    render(); void processQueue();
}

async function loadSettings() {
    if (loading || processing) return;
    loading = true; render(); statusMessage('正在读取工具模块设置…', 'pending');
    const retry = document.getElementById('toolModuleRetry'); retry.hidden = true;
    try {
        const result = await invoke('get_tool_module_settings');
        if (!Array.isArray(result) || result.some(id => typeof id !== 'string')) throw new Error('模块服务返回了无效结果');
        disabled = new Set(result); applyDisabledTools(result); loaded = true;
        statusMessage('已读取模块状态，停用工具会保留已有数据。');
    } catch (error) { statusMessage(`读取失败：${error}`, 'error'); retry.hidden = false; }
    finally { loading = false; render(); }
}

export async function initToolModuleSettings() {
    if (initialized) return;
    const button = document.getElementById('toolModulesCollapse');
    const content = document.getElementById('toolModulesContent');
    const status = document.getElementById('toolModuleStatus');
    if (!button || !content || !status) return;
    initialized = true;
    disclosure = createSettingsDisclosure({ content, trigger: button });
    let storedCollapsed = null;
    try { storedCollapsed = localStorage.getItem(collapseStorageKey); } catch { /* Use the initial collapsed state. */ }
    setCollapsed(storedCollapsed === null || storedCollapsed === 'true', false, false);
    button.addEventListener('click', event => setCollapsed(event.currentTarget.getAttribute('aria-expanded') === 'true', true, event.detail !== 0));
    document.getElementById('toolModuleList')?.addEventListener('change', change);
    document.getElementById('toolModuleSearch')?.addEventListener('input', event => { query = event.target.value; render(); });
    const categories = [...document.querySelectorAll('[data-module-category]')];
    categories.forEach((button, index) => {
        button.addEventListener('click', () => {
            category = button.dataset.moduleCategory;
            categories.forEach(node => { const active = node === button; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
            render();
        });
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
            categories[next].click(); categories[next].focus({ preventScroll: true });
        });
    });
    document.getElementById('toolModuleDisabledOnly')?.addEventListener('change', event => { disabledOnly = event.target.checked; render(); });
    const retry = document.createElement('button'); retry.id = 'toolModuleRetry'; retry.type = 'button';
    retry.className = 'settings-btn settings-btn--secondary'; retry.textContent = '重新加载'; retry.hidden = true;
    status.insertAdjacentElement('afterend', retry); retry.addEventListener('click', () => loadSettings());
    await loadSettings();
}
