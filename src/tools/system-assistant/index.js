import { registerTool } from '../toolRegistry.js';
import '../../css/tools/system-assistant.css';

const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);

const MODULES = Object.freeze([
    { id: 'overview', name: '概览', icon: 'ri-layout-grid-line', eyebrow: 'SYSTEM OVERVIEW' },
    { id: 'startup', name: '开机启动', icon: 'ri-rocket-2-line', eyebrow: 'STARTUP MANAGER' }
]);

let controller = null;
let snapshot = null;
let activeModule = 'overview';
let requestGeneration = 0;
let busyIds = new Set();

function template() {
    return `
        <div class="system-assistant-shell">
            <aside class="system-module-rail" aria-label="系统助手模块">
                <div class="system-brand">
                    <span class="system-brand__icon"><i class="ri-windows-line"></i></span>
                    <div><span>SYSTEM ASSISTANT</span><strong>系统助手</strong></div>
                </div>
                <nav id="systemModuleNav" class="system-module-nav">
                    ${MODULES.map(module => `<button type="button" data-system-module="${module.id}"><i class="${module.icon}"></i><span>${module.name}</span><small></small></button>`).join('')}
                </nav>
                <div class="system-rail-note">
                    <i class="ri-leaf-line"></i>
                    <div><strong>按需工作</strong><span>不轮询 · 不驻留扫描</span></div>
                </div>
            </aside>

            <main class="system-workspace">
                <section id="systemOverviewPanel" class="system-panel" data-system-panel="overview">
                    <header class="system-hero">
                        <div>
                            <span class="system-eyebrow">SYSTEM OVERVIEW</span>
                            <h2>少而精的系统工具箱</h2>
                            <p>把相关的小功能收进独立模块；每个模块仅在打开时工作，保持 DtKit 轻量。</p>
                        </div>
                        <span class="system-hero__status"><i class="ri-shield-check-line"></i> 可逆操作优先</span>
                    </header>

                    <div class="system-overview-metrics" aria-label="开机启动概览">
                        <article><span>已检测</span><strong id="systemOverviewTotal">—</strong><small>普通启动入口</small></article>
                        <article><span>正在启用</span><strong id="systemOverviewEnabled">—</strong><small>随系统登录运行</small></article>
                        <article><span>已安全停用</span><strong id="systemOverviewDisabled">—</strong><small>可由 DtKit 恢复</small></article>
                        <article><span>系统级</span><strong id="systemOverviewSystem">—</strong><small>修改可能需管理员权限</small></article>
                    </div>

                    <section class="system-module-card">
                        <span class="system-module-card__icon"><i class="ri-rocket-2-line"></i></span>
                        <div class="system-module-card__body">
                            <span>首个系统模块</span><h3>开机启动管理</h3>
                            <p>检查当前用户与所有用户的 Run、RunOnce 和启动文件夹。支持搜索、筛选、定位与可恢复启停。</p>
                            <div><span><i class="ri-checkbox-circle-line"></i> 不删除原始配置</span><span><i class="ri-history-line"></i> 保留恢复信息</span><span><i class="ri-refresh-line"></i> 仅手动刷新</span></div>
                        </div>
                        <button class="system-button system-button--primary" type="button" data-open-system-module="startup">管理启动项 <i class="ri-arrow-right-line"></i></button>
                    </section>

                    <section class="system-scope-card">
                        <div><span class="system-eyebrow">CLEAR BOUNDARY</span><h3>本期扫描边界</h3></div>
                        <p>当前只管理常规注册表启动入口与 Windows 启动文件夹；计划任务、系统服务、驱动等应作为后续独立模块处理，避免混在一起造成误操作。</p>
                    </section>
                </section>

                <section id="systemStartupPanel" class="system-panel" data-system-panel="startup" hidden>
                    <header class="system-page-heading">
                        <div><span class="system-eyebrow">STARTUP MANAGER</span><h2>开机启动</h2><p>扫描只在进入工具或手动刷新时发生，不会在后台持续占用资源。</p></div>
                        <button id="systemRefresh" class="system-button system-button--primary" type="button"><i class="ri-refresh-line"></i> 重新扫描</button>
                    </header>

                    <div class="system-startup-summary">
                        <article><i class="ri-rocket-2-line"></i><div><span>全部</span><strong id="systemTotal">—</strong></div></article>
                        <article><i class="ri-checkbox-circle-line"></i><div><span>已启用</span><strong id="systemEnabled">—</strong></div></article>
                        <article><i class="ri-forbid-2-line"></i><div><span>已停用</span><strong id="systemDisabled">—</strong></div></article>
                        <article><i class="ri-admin-line"></i><div><span>系统级</span><strong id="systemSystemItems">—</strong></div></article>
                    </div>

                    <div class="system-safety-note"><i class="ri-shield-check-line"></i><div><strong>安全启停，不提供直接删除</strong><span>注册表项会先保存完整恢复信息；启动文件夹项目仅做可恢复改名。系统级项目可能要求管理员权限。</span></div></div>

                    <div class="system-filterbar">
                        <label class="system-search"><i class="ri-search-line"></i><input id="systemStartupSearch" type="search" placeholder="搜索名称、命令或来源…" autocomplete="off"></label>
                        <label><span>状态</span><select id="systemStatusFilter"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label>
                        <label><span>范围</span><select id="systemScopeFilter"><option value="all">全部范围</option><option value="user">当前用户</option><option value="system">所有用户</option></select></label>
                    </div>

                    <section class="system-list-card" aria-labelledby="systemListTitle">
                        <div class="system-list-heading"><div><h3 id="systemListTitle">启动项目</h3><span id="systemResultCount">等待扫描</span></div><span id="systemScannedAt">尚未扫描</span></div>
                        <div class="system-list-columns" aria-hidden="true"><span>项目</span><span>状态</span><span>范围</span><span>来源</span><span>操作</span></div>
                        <div id="systemStartupList" class="system-startup-list" aria-live="polite"></div>
                        <div id="systemEmpty" class="system-empty" hidden><i class="ri-search-eye-line"></i><strong>没有匹配的启动项</strong><span>可以清除搜索内容或调整筛选条件。</span></div>
                    </section>
                    <div id="systemWarnings" class="system-warnings" hidden></div>
                </section>
                <p id="systemStatus" class="system-status" role="status" aria-live="polite"></p>
            </main>
        </div>`;
}

function setStatus(message, type = '') {
    const node = byId('systemStatus');
    if (!node) return;
    node.textContent = message;
    node.dataset.type = type;
}

function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value;
}

function switchModule(moduleId) {
    if (!MODULES.some(module => module.id === moduleId)) return;
    activeModule = moduleId;
    document.querySelectorAll('[data-system-panel]').forEach(panel => { panel.hidden = panel.dataset.systemPanel !== moduleId; });
    document.querySelectorAll('[data-system-module]').forEach(button => {
        const active = button.dataset.systemModule === moduleId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-current', active ? 'page' : 'false');
    });
}

function renderSummary() {
    if (!snapshot) return;
    setText('systemOverviewTotal', snapshot.total);
    setText('systemOverviewEnabled', snapshot.enabled);
    setText('systemOverviewDisabled', snapshot.disabled);
    setText('systemOverviewSystem', snapshot.systemItems);
    setText('systemTotal', snapshot.total);
    setText('systemEnabled', snapshot.enabled);
    setText('systemDisabled', snapshot.disabled);
    setText('systemSystemItems', snapshot.systemItems);
    setText('systemScannedAt', `扫描于 ${new Date(snapshot.scannedAt).toLocaleTimeString()}`);
    const startupBadge = document.querySelector('[data-system-module="startup"] small');
    if (startupBadge) startupBadge.textContent = String(snapshot.total);
}

function filteredItems() {
    if (!snapshot) return [];
    const query = byId('systemStartupSearch')?.value.trim().toLocaleLowerCase() || '';
    const status = byId('systemStatusFilter')?.value || 'all';
    const scope = byId('systemScopeFilter')?.value || 'all';
    return snapshot.items.filter(item => {
        if (status === 'enabled' && !item.enabled) return false;
        if (status === 'disabled' && item.enabled) return false;
        if (scope !== 'all' && item.scope !== scope) return false;
        if (!query) return true;
        return [item.name, item.command, item.sourceLabel, item.sourceDetail].some(value => value?.toLocaleLowerCase().includes(query));
    });
}

function iconButton(icon, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `system-icon-button ${className}`.trim();
    button.title = label;
    button.setAttribute('aria-label', label);
    const iconNode = document.createElement('i');
    iconNode.className = icon;
    button.append(iconNode);
    return button;
}

function createStartupRow(item) {
    const row = document.createElement('article');
    row.className = `system-startup-row${item.enabled ? '' : ' is-disabled'}`;
    row.dataset.startupId = item.id;

    const identity = document.createElement('div');
    identity.className = 'system-startup-identity';
    const icon = document.createElement('span');
    icon.className = 'system-startup-icon';
    const iconGlyph = document.createElement('i');
    iconGlyph.className = item.sourceKind === 'registry' ? 'ri-terminal-window-line' : 'ri-folder-open-line';
    icon.append(iconGlyph);
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = item.name;
    const command = document.createElement('span');
    command.textContent = item.command;
    command.title = item.command;
    copy.append(name, command);
    identity.append(icon, copy);

    const state = document.createElement('span');
    state.className = `system-chip system-chip--${item.enabled ? 'enabled' : 'disabled'}`;
    state.textContent = item.enabled ? '已启用' : '已停用';

    const scope = document.createElement('span');
    scope.className = 'system-chip system-chip--scope';
    const scopeIcon = document.createElement('i');
    scopeIcon.className = item.scope === 'system' ? 'ri-admin-line' : 'ri-user-line';
    scope.append(scopeIcon, document.createTextNode(item.scope === 'system' ? '所有用户' : '当前用户'));

    const source = document.createElement('div');
    source.className = 'system-startup-source';
    const sourceLabel = document.createElement('strong');
    sourceLabel.textContent = item.sourceLabel;
    const sourceDetail = document.createElement('span');
    sourceDetail.textContent = item.sourceDetail;
    sourceDetail.title = item.sourceDetail;
    source.append(sourceLabel, sourceDetail);

    const actions = document.createElement('div');
    actions.className = 'system-row-actions';
    const locate = iconButton('ri-folder-open-line', '定位文件');
    locate.disabled = !item.targetPath;
    locate.addEventListener('click', () => revealItem(item), { signal: controller.signal });
    const copyCommand = iconButton('ri-file-copy-2-line', '复制启动命令');
    copyCommand.addEventListener('click', () => copyStartupCommand(item), { signal: controller.signal });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'system-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(item.enabled));
    toggle.setAttribute('aria-label', `${item.enabled ? '停用' : '启用'} ${item.name}`);
    toggle.title = item.requiresElevation ? `${item.enabled ? '停用' : '启用'}（可能需要管理员权限）` : `${item.enabled ? '停用' : '启用'}启动项`;
    toggle.disabled = !item.canToggle || busyIds.has(item.id);
    const knob = document.createElement('span');
    toggle.append(knob);
    toggle.addEventListener('click', () => toggleItem(item), { signal: controller.signal });
    actions.append(locate, copyCommand, toggle);
    row.append(identity, state, scope, source, actions);
    return row;
}

function renderWarnings() {
    const node = byId('systemWarnings');
    if (!node) return;
    const warnings = snapshot?.warnings || [];
    node.hidden = warnings.length === 0;
    node.replaceChildren(...warnings.map(message => {
        const row = document.createElement('p');
        const icon = document.createElement('i'); icon.className = 'ri-error-warning-line';
        const text = document.createElement('span'); text.textContent = message;
        row.append(icon, text); return row;
    }));
}

function renderList() {
    const list = byId('systemStartupList');
    const empty = byId('systemEmpty');
    if (!list || !empty) return;
    const items = filteredItems();
    list.replaceChildren(...items.map(createStartupRow));
    empty.hidden = items.length !== 0;
    setText('systemResultCount', snapshot ? `显示 ${items.length} / ${snapshot.total} 项` : '等待扫描');
    renderWarnings();
}

function renderSnapshot() {
    renderSummary();
    renderList();
}

async function refreshSnapshot({ quiet = false } = {}) {
    const generation = ++requestGeneration;
    const button = byId('systemRefresh');
    if (button) button.disabled = true;
    if (!quiet) setStatus('正在按需扫描常规开机启动入口…');
    try {
        const next = await invoke('scan_system_startup_items');
        if (generation !== requestGeneration || controller?.signal.aborted) return;
        snapshot = next;
        renderSnapshot();
        setStatus(`扫描完成：共检测到 ${next.total} 个启动项。`, 'success');
    } catch (error) {
        if (generation !== requestGeneration || controller?.signal.aborted) return;
        setStatus(`扫描失败：${error}`, 'error');
        const list = byId('systemStartupList');
        if (list) list.replaceChildren();
        const empty = byId('systemEmpty');
        if (empty) {
            empty.hidden = false;
            empty.querySelector('strong').textContent = '暂时无法读取启动项';
            empty.querySelector('span').textContent = '请确认 DtKit 数据目录可用，或稍后重新扫描。';
        }
    } finally {
        if (generation === requestGeneration && button) button.disabled = false;
    }
}

async function toggleItem(item) {
    if (busyIds.has(item.id)) return;
    busyIds.add(item.id);
    renderList();
    const action = item.enabled ? '停用' : '启用';
    setStatus(`正在${action}“${item.name}”…`);
    try {
        snapshot = await invoke('set_system_startup_enabled', { id: item.id, enabled: !item.enabled });
        setStatus(`已${action}“${item.name}”，需要时可以随时恢复。`, 'success');
    } catch (error) {
        setStatus(`${action}失败：${error}`, 'error');
    } finally {
        busyIds.delete(item.id);
        if (!controller?.signal.aborted) renderSnapshot();
    }
}

async function revealItem(item) {
    try {
        await invoke('reveal_system_startup_item', { id: item.id });
        setStatus(`已定位“${item.name}”。`, 'success');
    } catch (error) { setStatus(`无法定位：${error}`, 'error'); }
}

async function copyStartupCommand(item) {
    try {
        await navigator.clipboard.writeText(item.command);
        setStatus(`已复制“${item.name}”的启动命令。`, 'success');
    } catch (error) { setStatus(`复制失败：${error}`, 'error'); }
}

function initializeSystemAssistant() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    snapshot = null;
    activeModule = 'overview';
    busyIds.clear();
    switchModule(activeModule);
    document.querySelectorAll('[data-system-module]').forEach(button => button.addEventListener('click', () => switchModule(button.dataset.systemModule), { signal }));
    document.querySelectorAll('[data-open-system-module]').forEach(button => button.addEventListener('click', () => switchModule(button.dataset.openSystemModule), { signal }));
    byId('systemRefresh')?.addEventListener('click', () => refreshSnapshot(), { signal });
    byId('systemStartupSearch')?.addEventListener('input', renderList, { signal });
    byId('systemStatusFilter')?.addEventListener('change', renderList, { signal });
    byId('systemScopeFilter')?.addEventListener('change', renderList, { signal });
    refreshSnapshot({ quiet: true });
}

function destroySystemAssistant() {
    controller?.abort();
    controller = null;
    snapshot = null;
    busyIds.clear();
    requestGeneration += 1;
}

registerTool({
    id: 'system-assistant',
    name: '系统助手',
    icon: 'ri-windows-line',
    colorClass: 'tool-card__icon--purple',
    category: 'utility',
    status: 'ready',
    description: '按需检测并安全管理开机启动项，后续系统小功能统一在这里扩展。',
    template,
    init: initializeSystemAssistant,
    destroy: destroySystemAssistant
});

export { destroySystemAssistant, initializeSystemAssistant };
