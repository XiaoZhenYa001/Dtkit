import { applyDisabledTools, getAllTools } from '../../tools/index.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
let initialized = false;
let disabled = new Set();
let query = '';
let category = 'all';
let disabledOnly = false;
const collapseStorageKey = 'dtkit_toolModulesCollapsed';

function setCollapsed(collapsed, persist = true) {
    const button = document.getElementById('toolModulesCollapse');
    const content = document.getElementById('toolModulesContent');
    if (!button || !content) return;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.querySelector('span').textContent = collapsed ? '展开' : '收起';
    content.hidden = collapsed;
    document.getElementById('toolModulesSection')?.classList.toggle('is-collapsed', collapsed);
    if (persist) localStorage.setItem(collapseStorageKey, String(collapsed));
}

const categoryLabels = Object.freeze({
    dev: '开发',
    design: '设计',
    utility: '效率',
    other: '其他'
});

function render() {
    const list = document.getElementById('toolModuleList');
    if (!list) return;
    const tools = getAllTools({ includeDisabled: true, includePrimary: true }).filter(tool => tool.status !== 'planned');
    const needle = query.trim().toLowerCase();
    const visible = tools.filter(tool =>
        (category === 'all' || tool.category === category)
        && (!disabledOnly || disabled.has(tool.id))
        && (!needle || `${tool.name} ${tool.description} ${tool.id}`.toLowerCase().includes(needle)));
    const rows = visible.map(tool => {
        const row = document.createElement('label');
        row.className = `tool-module-row${disabled.has(tool.id) ? ' is-disabled' : ''}`;
        const icon = document.createElement('span');
        icon.className = 'tool-module-row__icon';
        icon.innerHTML = `<i class="${tool.icon}"></i>`;
        const text = document.createElement('span');
        text.className = 'tool-module-row__text';
        const title = document.createElement('strong'); title.textContent = tool.name;
        const categoryBadge = document.createElement('em');
        categoryBadge.textContent = categoryLabels[tool.category] || '工具';
        title.append(categoryBadge);
        const detail = document.createElement('small');
        detail.textContent = disabled.has(tool.id) ? '已停用 · 数据仍保留' : '按需加载 · 当前启用';
        text.append(title, detail);
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'tool-module-toggle';
        toggle.checked = !disabled.has(tool.id);
        toggle.dataset.toolId = tool.id;
        toggle.setAttribute('aria-label', `${toggle.checked ? '停用' : '启用'}${tool.name}`);
        row.append(icon, text, toggle);
        return row;
    });
    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'tool-module-empty';
        empty.innerHTML = '<i class="ri-search-line"></i><strong>没有匹配的工具模块</strong><span>调整分类或清空搜索条件后重试。</span>';
        rows.push(empty);
    }
    list.replaceChildren(...rows);
    const count = document.getElementById('toolModuleEnabledCount');
    if (count) count.textContent = `${tools.filter(tool => !disabled.has(tool.id)).length} / ${tools.length}`;
    const disabledCount = document.getElementById('toolModuleDisabledCount');
    if (disabledCount) disabledCount.textContent = String(tools.filter(tool => disabled.has(tool.id)).length);
}

async function change(event) {
    const input = event.target.closest('[data-tool-id]');
    if (!input) return;
    const requestedEnabled = input.checked;
    input.disabled = true;
    input.closest('.tool-module-row')?.setAttribute('aria-busy', 'true');
    const status = document.getElementById('toolModuleStatus');
    try {
        const result = await invoke('set_tool_module_enabled', {
            toolId: input.dataset.toolId, enabled: requestedEnabled
        });
        disabled = new Set(result);
        applyDisabledTools(result);
        let shortcutWarning = '';
        if (!requestedEnabled) {
            try {
                const bindings = await invoke('get_shortcut_bindings');
                await invoke('replace_shortcut_bindings', {
                    bindings: bindings.filter(binding =>
                        binding.target?.kind !== 'tool' || binding.target.toolId !== input.dataset.toolId)
                });
            } catch (error) {
                shortcutWarning = `；旧快捷键已失效，但配置清理失败：${error}`;
            }
        }
        render();
        window.dispatchEvent(new CustomEvent('dtkit-tool-modules-changed'));
        if (status) {
            status.textContent = requestedEnabled ? '模块已启用。' : `模块已停用${shortcutWarning || '并解除专属快捷键。'}`;
            status.dataset.tone = shortcutWarning ? 'warning' : 'success';
        }
    } catch (error) {
        input.checked = !requestedEnabled;
        if (status) {
            status.textContent = `更新失败：${error}`;
            status.dataset.tone = 'error';
        }
    } finally {
        if (input.isConnected) {
            input.disabled = false;
            input.closest('.tool-module-row')?.removeAttribute('aria-busy');
        }
    }
}

export async function initToolModuleSettings() {
    if (initialized) return;
    initialized = true;
    const storedCollapsed = localStorage.getItem(collapseStorageKey);
    setCollapsed(storedCollapsed === null ? true : storedCollapsed === 'true', false);
    document.getElementById('toolModulesCollapse')?.addEventListener('click', event => {
        setCollapsed(event.currentTarget.getAttribute('aria-expanded') === 'true');
    });
    document.getElementById('toolModuleList')?.addEventListener('change', change);
    document.getElementById('toolModuleSearch')?.addEventListener('input', event => {
        query = event.target.value;
        render();
    });
    document.querySelectorAll('[data-module-category]').forEach(button => button.addEventListener('click', () => {
        category = button.dataset.moduleCategory;
        document.querySelectorAll('[data-module-category]').forEach(node => {
            const active = node === button;
            node.classList.toggle('is-active', active);
            node.setAttribute('aria-pressed', String(active));
        });
        render();
    }));
    document.getElementById('toolModuleDisabledOnly')?.addEventListener('change', event => {
        disabledOnly = event.target.checked;
        render();
    });
    try {
        disabled = new Set(await invoke('get_tool_module_settings'));
        applyDisabledTools([...disabled]);
        render();
    } catch (error) {
        const status = document.getElementById('toolModuleStatus');
        if (status) {
            status.textContent = `读取失败：${error}`;
            status.dataset.tone = 'error';
        }
    }
}
