import { escapeHtml } from '../../core/html.js';
import { filterStartupItems, groupStartupItems, paginateStartupGroups, prepareStartupSnapshot, sortStartupItems } from './model.js';
import { buildStartupCsv } from './export.js';
import '../../css/tools/system-assistant.css';

const PAGE_SIZE = 80;
const MODULES = [
    { id: 'overview', name: '概览', icon: 'ri-layout-grid-line' },
    { id: 'startup', name: '开机启动', icon: 'ri-rocket-2-line' }
];

// Each entry point owns its lifecycle; importing this shared view registers no tool.
export function createSystemAssistantView({ toolId, standalone = false }) {
    let controller = null;
    let root = null;
    let snapshot = null;
    let generation = 0;
    let busy = false;
    let activeId = null;
    let stale = false;
    let page = 1;
    let expanded = new Set();
    let opening = new Set();
    let lastChange = null;
    let pendingForget = null;
    let pendingAdoptFingerprint = null;
    let adoptMode = 'bind';
    let composerGeneration = 0;
    let refreshOnReturn = false;
    let leftForSettings = false;
    const exportUrls = new Map();
    const byId = id => root?.querySelector(`#${id}`);
    const available = () => Boolean(globalThis.window?.__TAURI__?.core?.invoke);
    const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, { ...args, toolId });

    function template() {
        return `<div class="system-assistant-shell${standalone ? ' system-assistant-shell--standalone' : ''}" data-system-tool="${escapeHtml(toolId)}">
            ${standalone ? '' : `<aside class="system-module-rail" aria-label="系统助手模块">
                <div class="system-brand"><span class="system-brand__icon"><i class="ri-windows-line"></i></span><div><span>SYSTEM ASSISTANT</span><strong>系统助手</strong></div></div>
                <nav id="systemModuleNav" class="system-module-nav">${MODULES.map(module => `<button type="button" data-system-module="${module.id}"><i class="${module.icon}"></i><span>${module.name}</span><small></small></button>`).join('')}</nav>
                <div class="system-rail-note"><i class="ri-leaf-line"></i><div><strong>按需工作</strong><span>不轮询 · 不驻留扫描</span></div></div>
            </aside>`}
            <main class="system-workspace">
                ${standalone ? '' : `<section id="systemOverviewPanel" class="system-panel" data-system-panel="overview">
                    <header class="system-hero"><div><span class="system-eyebrow">SYSTEM OVERVIEW</span><h2>少而精的系统工具箱</h2><p>把相关的小功能收进独立模块；每个模块仅在打开时工作，保持 DtKit 轻量。</p></div><span class="system-hero__status"><i class="ri-shield-check-line"></i> 保留恢复记录</span></header>
                    <div class="system-overview-metrics" aria-label="开机启动概览">
                        <article><span>已检测</span><strong id="systemOverviewTotal">—</strong><small>常规启动入口</small></article>
                        <article><span>已启用</span><strong id="systemOverviewEnabled">—</strong><small>已配置自动启动</small></article>
                        <article><span>我关闭的</span><strong id="systemOverviewDisabled">—</strong><small>可由 DtKit 恢复</small></article>
                        <article><span>系统级</span><strong id="systemOverviewSystem">—</strong><small>适用于所有用户</small></article>
                    </div>
                    <section class="system-module-card"><span class="system-module-card__icon"><i class="ri-rocket-2-line"></i></span><div class="system-module-card__body"><span>系统模块</span><h3>开机启动管理</h3><p>检查当前用户与所有用户的 Run、RunOnce 和启动文件夹。定位程序文件，关闭不需要的自动启动并随时恢复。</p><div><span><i class="ri-history-line"></i> 保留完整恢复记录</span><span><i class="ri-folder-open-line"></i> 定位程序与启动文件</span><span><i class="ri-refresh-line"></i> 按需扫描</span></div></div><button class="system-button system-button--primary" type="button" data-open-system-module="startup">管理启动项 <i class="ri-arrow-right-line"></i></button></section>
                    <section class="system-scope-card"><div><span class="system-eyebrow">SCAN SCOPE</span><h3>常规自动启动入口</h3></div><p>检测注册表 Run、RunOnce 和 Windows 启动文件夹。计划任务、服务、驱动和应用商店的启动任务不在此列表；其他应用可在 Windows 启动设置中查看。</p></section>
                </section>`}
                <section id="systemStartupPanel" class="system-panel" data-system-panel="startup" ${standalone ? '' : 'hidden'}>
                    <header class="system-page-heading"><div><span class="system-eyebrow">STARTUP MANAGER</span><h2>${standalone ? '自启动管理' : '开机启动'}</h2><p>整理登录时自动运行的程序，关闭后随时恢复，也可添加自己的应用。</p></div><div class="system-heading-actions"><button id="systemAdd" class="system-button system-button--secondary" type="button"><i class="ri-add-line"></i>添加启动项</button><button id="systemStartupSettings" class="system-button system-button--secondary" type="button"><i class="ri-settings-3-line"></i>Windows 启动设置</button><button id="systemRefresh" class="system-button system-button--primary" type="button"><i class="ri-refresh-line"></i><span>重新扫描</span></button></div></header>
                    <div class="system-startup-summary">
                        <button type="button" data-system-status="all"><i class="ri-rocket-2-line"></i><div><span>全部</span><strong id="systemTotal">—</strong></div></button>
                        <button type="button" data-system-status="enabled"><i class="ri-checkbox-circle-line"></i><div><span>已启用</span><strong id="systemEnabled">—</strong></div></button>
                        <button type="button" data-system-status="disabled"><i class="ri-forbid-2-line"></i><div><span>已关闭</span><strong id="systemDisabled">—</strong></div></button>
                        <button type="button" data-system-status="readOnly"><i class="ri-admin-line"></i><div><span>仅查看</span><strong id="systemReadOnly">—</strong></div></button>
                    </div>
                    <div class="system-safety-note"><i class="ri-shield-check-line"></i><div><strong>按需扫描，可恢复启停</strong><span>关闭前保存恢复信息。“我关闭的”可重新启用；Windows 设置关闭或不支持安全管理的项目仅供查看。关闭自启动会在以后登录时生效。</span></div></div>
                    <div id="systemRecovery" class="system-recovery" hidden><strong>恢复记录需要处理</strong><p id="systemRecoveryMessage"></p><button id="systemAdopt" class="system-button system-button--secondary" type="button" hidden>绑定本机旧记录</button><button id="systemStartFresh" class="system-button system-button--secondary" type="button" hidden>保留旧记录，在本机重新开始</button></div>
                    <div class="system-filterbar">
                        <label class="system-search"><i class="ri-search-line"></i><input id="systemStartupSearch" type="search" placeholder="搜索软件、名称、命令或路径…" autocomplete="off" aria-label="搜索软件和启动项"></label>
                        <label><span>状态</span><select id="systemStatusFilter"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已关闭</option><option value="managed">我关闭的</option><option value="readOnly">仅查看</option><option value="conflicts">恢复记录冲突</option><option value="unlocated">未定位程序</option></select></label>
                        <label><span>范围</span><select id="systemScopeFilter"><option value="all">全部范围</option><option value="user">当前用户</option><option value="system">所有用户</option></select></label>
                        <label><span>来源</span><select id="systemSourceFilter"><option value="all">全部来源</option><option value="registry">注册表</option><option value="startupFolder">启动文件夹</option></select></label>
                    </div>
                    <div class="system-list-tools"><div class="system-quick-filters" aria-label="常用筛选"><button class="system-filter-chip" type="button" data-system-status="managed">我关闭的 <span id="systemManagedCount">0</span></button><button class="system-filter-chip" type="button" data-system-status="conflicts">恢复冲突 <span id="systemConflictCount">0</span></button><button class="system-filter-chip" type="button" data-system-status="unlocated">未定位 <span id="systemUnlocatedCount">0</span></button><button id="systemClearFilters" class="system-detail-button" type="button">清空筛选</button></div><div class="system-list-options"><label class="system-sort-label">显示<select id="systemGroupMode"><option value="software">按软件分组</option><option value="flat">平铺列表</option></select></label><label class="system-sort-label">排序<select id="systemSort"><option value="name">名称</option><option value="state">启用状态</option><option value="source">来源</option><option value="recent">最近关闭</option></select></label></div></div>
                    <div class="system-secondary-actions"><button id="systemOpenFolder" class="system-button system-button--secondary" type="button"><i class="ri-folder-open-line"></i>启动文件夹</button><button id="systemExport" class="system-button system-button--secondary" type="button"><i class="ri-download-2-line"></i>导出筛选结果</button><button id="systemUndo" class="system-button system-button--secondary" type="button" hidden>撤销上次更改</button></div>
                    <section class="system-list-card" aria-labelledby="systemListTitle">
                        <div class="system-list-heading"><div><h3 id="systemListTitle">启动项目</h3><span id="systemResultCount" tabindex="-1">等待扫描</span></div><span id="systemScannedAt">尚未扫描</span></div>
                        <p id="systemGroupingNote" class="system-grouping-note">同一软件的入口集中显示，每条独立管理。未确认归属的项目单独显示。</p>
                        <div class="system-list-columns" aria-hidden="true"><span>项目</span><span>状态</span><span>范围</span><span>来源</span><span>操作</span></div>
                        <div id="systemStartupList" class="system-startup-list" aria-live="polite"></div>
                        <div id="systemEmpty" class="system-empty" hidden><i class="ri-search-eye-line"></i><strong></strong><span></span></div>
                        <nav id="systemPagination" class="system-pagination" aria-label="启动项分页" hidden><button id="systemPrevious" class="system-button system-button--secondary" type="button">上一页</button><span id="systemPage"></span><button id="systemNext" class="system-button system-button--secondary" type="button">下一页</button></nav>
                    </section>
                    <div id="systemWarnings" class="system-warnings" hidden></div>
                    <details class="system-help"><summary>扫描范围与使用说明</summary><p>检测当前用户及所有用户的 Run、RunOnce 注册表入口和 Windows 启动文件夹。这里显示的是自动启动配置，程序是否正在运行需要在任务管理器中查看。计划任务、服务、驱动和应用商店的启动任务不在此列表。</p><p>“程序位置”定位实际目标文件，“启动文件位置”定位启动文件夹内的快捷方式或文件。路径不存在或无法确认时按钮会禁用。系统级项目可能需要以管理员身份打开 DtKit 后更改。</p><p>被 Windows 启动设置或其他软件关闭的项目仅供查看，可通过“Windows 启动设置”调整。DtKit 只在打开工具、手动扫描和更改后读取状态，不持续扫描；恢复记录仅保存在本机。</p></details>
                </section>
                <p id="systemStatus" class="system-status" role="status" aria-live="polite"></p>
                <dialog id="systemAddDialog" class="system-dialog" aria-labelledby="systemAddTitle"><form id="systemAddForm"><header><h3 id="systemAddTitle">添加登录启动项</h3><p>选择本地程序，为当前用户创建启动快捷方式。下次登录时按此配置启动。</p></header><label>程序文件<div class="system-program-picker"><input id="systemAddPath" readonly required placeholder="选择 .exe 程序" aria-label="程序文件"><button id="systemChooseProgram" class="system-button system-button--secondary" type="button">选择程序</button></div></label><label>显示名称<input id="systemAddName" maxlength="100" required autocomplete="off"></label><label>启动参数 <span>可选</span><input id="systemAddArguments" maxlength="4096" autocomplete="off" placeholder="例如 --minimized"></label><p id="systemAddError" class="system-dialog-error" role="alert"></p><footer><button class="system-button system-button--secondary" type="button" data-system-close="systemAddDialog">取消</button><button id="systemAddSubmit" class="system-button system-button--primary" type="submit">添加启动项</button></footer></form></dialog>
                <dialog id="systemForgetDialog" class="system-dialog" aria-labelledby="systemForgetTitle"><h3 id="systemForgetTitle">放弃旧恢复记录</h3><p id="systemForgetDescription"></p><p>保留当前启动配置，移除 DtKit 保存的旧记录。之后将按当前配置管理。</p><p id="systemForgetError" class="system-dialog-error" role="alert"></p><footer><button class="system-button system-button--secondary" type="button" data-system-close="systemForgetDialog">取消</button><button id="systemForgetConfirm" class="system-button system-button--primary" type="button">放弃旧记录</button></footer></dialog>
                <dialog id="systemAdoptDialog" class="system-dialog" aria-labelledby="systemAdoptTitle"><h3 id="systemAdoptTitle">绑定本机旧记录</h3><p id="systemAdoptDescription"></p><label class="system-confirm-check"><input id="systemAdoptCheck" type="checkbox"><span id="systemAdoptCheckLabel"></span></label><p id="systemAdoptError" class="system-dialog-error" role="alert"></p><footer><button class="system-button system-button--secondary" type="button" data-system-close="systemAdoptDialog">取消</button><button id="systemAdoptConfirm" class="system-button system-button--primary" type="button" disabled>确认绑定</button></footer></dialog>
            </main>
        </div>`;
    }

    function setStatus(message, type = '') {
        const node = byId('systemStatus');
        if (node) { node.textContent = message; node.dataset.type = type; }
    }

    function setText(id, value) { const node = byId(id); if (node) node.textContent = value ?? '—'; }

    function switchModule(moduleId) {
        if (!MODULES.some(module => module.id === moduleId)) return;
        root?.querySelectorAll('[data-system-panel]').forEach(panel => { panel.hidden = panel.dataset.systemPanel !== moduleId; });
        root?.querySelectorAll('[data-system-module]').forEach(button => {
            const active = button.dataset.systemModule === moduleId;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
    }

    function filters() {
        return { query: byId('systemStartupSearch')?.value, status: byId('systemStatusFilter')?.value,
            scope: byId('systemScopeFilter')?.value, source: byId('systemSourceFilter')?.value };
    }

    function visibleItems() {
        const items = filterStartupItems(snapshot?.items || [], filters());
        const order = byId('systemSort')?.value;
        return grouped() ? groupStartupItems(items, order).flatMap(group => group.items) : sortStartupItems(items, order);
    }

    function grouped() { return byId('systemGroupMode')?.value !== 'flat'; }

    function groupReason(reason) {
        return reason === 'registered' ? '按已登记的安装目录归组' : reason === 'sameExecutable' ? '按同一程序文件归组' : '未确认软件归属，单独显示';
    }

    function dateText(value) {
        return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
    }

    function detail(item) {
        const field = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value || '未提供')}</dd></div>`;
        return `<div class="system-startup-detail"><dl>${field('所属软件', item.groupName ? `${item.groupName}（${groupReason(item.groupReason)}）` : '未确认软件归属')}${field('启动命令', item.command)}${field('程序位置', item.targetPath)}${field('注册来源', item.sourceDetail)}${item.sourceKind === 'startupFolder' ? field('启动文件', item.sourcePath) : ''}${item.backupPath ? field('保留的旧文件', item.backupPath) : ''}${item.backupDisabledAt ? field('关闭时间', dateText(item.backupDisabledAt)) : ''}${item.disabledReason ? field('管理说明', item.disabledReason) : ''}</dl><button class="system-button system-button--secondary" type="button" data-startup-copy="${escapeHtml(item.id)}"><i class="ri-file-copy-2-line"></i>复制详情</button>${item.canRevealBackup ? `<button class="system-button system-button--secondary" type="button" data-startup-backup="${escapeHtml(item.id)}" ${opening.has(`${item.id}:backup`) ? 'disabled' : ''}>旧文件位置</button>` : ''}${item.canForgetBackup ? `<button class="system-button system-button--secondary" type="button" data-startup-forget="${escapeHtml(item.id)}" ${busy || stale ? 'disabled' : ''}>放弃旧恢复记录</button>` : ''}</div>`;
    }

    function iconButton(icon, label, attribute, id, disabled = false) {
        return `<button type="button" class="system-icon-button" ${attribute}="${escapeHtml(id)}" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''}><i class="${icon}"></i></button>`;
    }

    function row(item) {
        const open = expanded.has(item.id);
        const state = item.enabled ? '已启用' : item.managed ? '我关闭的' : '已关闭';
        const blocked = !item.canToggle || busy || stale;
        const title = !item.canToggle ? item.disabledReason || '此项目仅供查看' : stale ? '请重新扫描后再更改' : `${item.enabled ? '关闭' : '启用'}自启动${item.requiresElevation ? '（可能需要管理员权限）' : ''}`;
        return `<article class="system-startup-row${item.enabled ? '' : ' is-disabled'}" data-startup-id="${escapeHtml(item.id)}">
            <div class="system-startup-identity"><span class="system-startup-icon"><i class="${item.sourceKind === 'registry' ? 'ri-terminal-window-line' : 'ri-folder-open-line'}"></i></span><div><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span title="${escapeHtml(item.command)}">${escapeHtml(item.command || item.targetPath || '展开详情查看来源')}</span><div class="system-mobile-tags"><span>${state}</span><span>${item.scope === 'system' ? '所有用户' : '当前用户'}</span>${!item.canToggle ? '<span>仅查看</span>' : ''}</div></div></div>
            <span class="system-chip system-chip--${item.enabled ? 'enabled' : 'disabled'}">${activeId === item.id ? '正在更改' : state}</span>
            <span class="system-chip system-chip--scope"><i class="${item.scope === 'system' ? 'ri-admin-line' : 'ri-user-line'}"></i>${item.scope === 'system' ? '所有用户' : '当前用户'}</span>
            <div class="system-startup-source"><strong>${escapeHtml(item.sourceLabel)}${!item.canToggle ? ' · 仅查看' : ''}</strong><span title="${escapeHtml(item.sourceDetail)}">${escapeHtml(item.sourceDetail)}</span></div>
            <div class="system-row-actions">${iconButton('ri-folder-open-line', item.canReveal ? '打开程序文件位置' : '无法确认可定位的程序文件', 'data-startup-reveal', item.id, !item.canReveal || opening.has(`${item.id}:program`))}${item.sourceKind === 'startupFolder' ? iconButton('ri-file-list-3-line', item.canRevealSource ? '打开启动文件位置' : '启动文件不存在，无法定位', 'data-startup-source', item.id, !item.canRevealSource || opening.has(`${item.id}:source`)) : ''}<button class="system-toggle" type="button" role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? '关闭' : '启用'} ${escapeHtml(item.name)}" data-startup-toggle="${escapeHtml(item.id)}" title="${escapeHtml(title)}" ${blocked ? 'disabled' : ''}><span></span></button></div>
            <div class="system-row-footer">${item.disabledReason && !item.canToggle ? `<span class="system-readonly-reason">${escapeHtml(item.disabledReason)}</span>` : `<span>${item.targetPath ? escapeHtml(item.targetPath) : '程序文件未定位'}${item.backupConflict ? ' · 恢复记录冲突，请展开详情处理' : ''}${item.backupDisabledAt ? ` · 关闭于 ${escapeHtml(dateText(item.backupDisabledAt))}` : ''}</span>`}<button class="system-detail-button" type="button" data-startup-details="${escapeHtml(item.id)}" aria-expanded="${open}">${open ? '收起' : '详情'}<i class="ri-arrow-down-s-line"></i></button></div>
            ${open ? detail(item) : ''}
        </article>`;
    }

    function softwareGroup(group) {
        const named = group.reason !== 'unconfirmed' || group.totalCount > 1;
        const count = `${group.totalCount} 项 · ${group.enabled} 已启用 · ${group.disabled} 已关闭${group.totalCount > group.items.length ? ` · 本页 ${group.items.length} 项` : ''}`;
        return `<section class="system-startup-group${named ? ' is-named' : ''}" data-system-group="${escapeHtml(group.id)}" aria-label="${escapeHtml(group.name)}">${named ? `<header class="system-group-heading"><div><h4>${escapeHtml(group.name)}${group.continued ? ' <small>（续）</small>' : ''}</h4><span>${groupReason(group.reason)}</span></div><span class="system-group-count">${count}</span></header>` : ''}${group.items.map(row).join('')}</section>`;
    }

    function render() {
        if (!root?.isConnected) return;
        const focused = document.activeElement;
        const focusAttribute = focused?.getAttributeNames?.().find(name => name.startsWith('data-startup-') && name !== 'data-startup-id');
        const focusId = focusAttribute ? focused.getAttribute(focusAttribute) : null;
        const desktop = available();
        byId('systemRefresh').disabled = busy || !desktop;
        byId('systemRefresh').querySelector('span').textContent = busy && !activeId ? '正在扫描' : '重新扫描';
        byId('systemStartupSettings').disabled = !desktop || opening.has('settings');
        byId('systemAdd').disabled = busy || stale || !desktop || !snapshot || snapshot.recoveryState !== 'ready';
        byId('systemOpenFolder').disabled = !desktop || opening.has('folder');
        byId('systemExport').disabled = !snapshot || !visibleItems().length;
        setText('systemManagedCount', snapshot?.managed || 0);
        setText('systemConflictCount', snapshot?.conflicts || 0);
        setText('systemUnlocatedCount', snapshot?.unlocated || 0);
        root.querySelectorAll('[data-system-status]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.systemStatus === byId('systemStatusFilter').value)));
        byId('systemClearFilters').hidden = !filters().query && ['status', 'scope', 'source'].every(key => filters()[key] === 'all');
        byId('systemRecovery').hidden = !snapshot || snapshot.recoveryState === 'ready';
        setText('systemRecoveryMessage', snapshot?.recoveryMessage || '恢复记录当前不可用，仍可查看启动配置。');
        byId('systemAdopt').hidden = snapshot?.recoveryState !== 'legacy';
        byId('systemAdopt').disabled = busy || !snapshot?.recoveryFingerprint;
        byId('systemStartFresh').hidden = snapshot?.recoveryState !== 'legacy';
        byId('systemStartFresh').disabled = busy || !snapshot?.recoveryFingerprint;
        byId('systemAddSubmit').disabled = busy || opening.has('choose');
        byId('systemForgetConfirm').disabled = busy || stale;
        byId('systemAdoptConfirm').disabled = busy || !byId('systemAdoptCheck').checked;
        root.querySelectorAll('[data-system-close]').forEach(button => { button.disabled = busy; });
        const undoItem = lastChange && snapshot?.items.find(item => item.id === lastChange.id && item.fingerprint === lastChange.fingerprint && item.canToggle);
        if (lastChange && !undoItem) lastChange = null;
        byId('systemUndo').hidden = !lastChange;
        byId('systemUndo').disabled = busy || stale;
        byId('systemUndo').textContent = lastChange ? `撤销${lastChange.enabled ? '关闭' : '启用'}：${lastChange.name}` : '撤销上次更改';
        const metrics = [['systemOverviewTotal', snapshot?.total], ['systemOverviewEnabled', snapshot?.enabled],
            ['systemOverviewDisabled', snapshot?.managed], ['systemOverviewSystem', snapshot?.systemItems],
            ['systemTotal', snapshot?.total], ['systemEnabled', snapshot?.enabled], ['systemDisabled', snapshot?.disabled],
            ['systemReadOnly', snapshot?.readOnly]];
        metrics.forEach(([id, value]) => setText(id, value));
        const badge = root.querySelector('[data-system-module="startup"] small');
        if (badge) badge.textContent = snapshot ? String(snapshot.total) : '';
        const date = new Date(snapshot?.scannedAt);
        setText('systemScannedAt', snapshot && !Number.isNaN(date.getTime()) ? `上次扫描 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未扫描');
        const items = visibleItems();
        const isGrouped = grouped();
        const groups = isGrouped ? groupStartupItems(items, byId('systemSort')?.value) : [];
        const groupPages = isGrouped ? paginateStartupGroups(groups, PAGE_SIZE) : [];
        const pages = Math.max(1, isGrouped ? groupPages.length : Math.ceil(items.length / PAGE_SIZE));
        page = Math.max(1, Math.min(page, pages));
        setText('systemResultCount', snapshot ? `显示 ${items.length} / ${snapshot.total} 项` : busy ? '正在检测本机启动项…' : '等待扫描');
        byId('systemGroupingNote').hidden = !isGrouped;
        setText('systemGroupingNote', `同一软件的入口集中显示，每条独立管理。未确认归属的项目单独显示。当前筛选 ${groups.length} 组。`);
        const list = byId('systemStartupList');
        list.setAttribute('aria-busy', String(busy));
        list.innerHTML = isGrouped ? (groupPages[page - 1] || []).map(softwareGroup).join('') : items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row).join('');
        if (focusAttribute) {
            const target = [...list.querySelectorAll(`[${focusAttribute}]`)].find(button => button.getAttribute(focusAttribute) === focusId && !button.disabled);
            if (target) target.focus({ preventScroll: true });
            else if (!items.some(item => item.id === focusId)) byId('systemResultCount')?.focus({ preventScroll: true });
        }
        const empty = byId('systemEmpty');
        empty.hidden = items.length > 0;
        empty.querySelector('strong').textContent = !desktop ? '在 Windows 桌面版中管理自启动' : busy ? '正在读取启动配置' : !snapshot ? '启动项列表尚未就绪' : snapshot.total ? '没有匹配的启动项' : '没有检测到常规启动项';
        empty.querySelector('span').textContent = !desktop ? '请打开桌面版 DtKit 使用此工具。' : busy ? '只读取配置，不会运行任何启动程序。' : !snapshot ? '点击“重新扫描”再试一次。' : snapshot.total ? '清除搜索内容或调整筛选条件。' : '其他启动类型可在 Windows 启动设置中查看。';
        byId('systemPagination').hidden = pages < 2;
        setText('systemPage', `${page} / ${pages}`);
        byId('systemPrevious').disabled = page === 1;
        byId('systemNext').disabled = page === pages;
        const warnings = snapshot?.warnings || [];
        byId('systemWarnings').hidden = warnings.length === 0;
        byId('systemWarnings').innerHTML = warnings.length ? `<details><summary>有 ${warnings.length} 条扫描提示，部分项目可能未被读取</summary>${warnings.map(message => `<p><i class="ri-error-warning-line"></i><span>${escapeHtml(message)}</span></p>`).join('')}</details>` : '';
    }

    function focusAction(id, attribute = 'data-startup-toggle') {
        const button = [...(byId('systemStartupList')?.querySelectorAll(`[${attribute}]`) || [])].find(node => node.getAttribute(attribute) === id && !node.disabled);
        (button || byId('systemResultCount'))?.focus({ preventScroll: true });
    }

    async function refreshSnapshot() {
        if (busy || !available()) return;
        const current = generation;
        busy = true; activeId = null;
        setStatus('正在按需扫描常规开机启动入口…');
        render();
        try {
            const result = await invoke('scan_system_startup_items');
            if (current !== generation) return;
            snapshot = prepareStartupSnapshot(result); stale = false; page = 1;
            setStatus(`扫描完成：共检测到 ${snapshot.total} 个启动项。`, 'success');
        } catch (error) {
            if (current === generation) {
                stale = true;
                setStatus(`扫描失败：${String(error)}${snapshot ? '。保留上次列表，请重新扫描后再更改。' : ''}`, 'error');
            }
        } finally { if (current === generation) { busy = false; render(); } }
    }

    async function toggleItem(item, { enabled = !item.enabled, undo = false } = {}) {
        if (busy || stale || !item.canToggle || !snapshot || !available()) return;
        const current = generation;
        const action = enabled ? '启用' : '关闭';
        busy = true; activeId = item.id;
        setStatus(`正在${action}“${item.name}”的自启动…`); render();
        try {
            const result = await invoke('set_system_startup_enabled', { id: item.id, enabled, expectedFingerprint: item.fingerprint });
            if (current !== generation) return;
            snapshot = prepareStartupSnapshot(result); stale = false;
            const changed = snapshot.items.find(entry => entry.id === item.id);
            lastChange = !undo && changed?.canToggle ? { id: item.id, enabled: item.enabled, name: item.name, fingerprint: changed.fingerprint } : null;
            setStatus(`已${action}“${item.name}”的自启动。${enabled ? '将在以后登录时按原配置启动。' : '需要时可在“我关闭的”中恢复。'}`, 'success');
        } catch (error) {
            if (current !== generation) return;
            stale = true;
            const message = `${action}未完成：${String(error)}${item.requiresElevation ? '。此项目可能需要以管理员身份打开 DtKit。' : ''}`;
            setStatus(`${message}。正在重新读取实际状态…`, 'error');
            try {
                const result = await invoke('scan_system_startup_items');
                if (current !== generation) return;
                snapshot = prepareStartupSnapshot(result); stale = false;
                setStatus(`${message}。列表已更新为当前实际状态。`, 'error');
            } catch (refreshError) {
                if (current === generation) setStatus(`${message}。读取实际状态也失败：${String(refreshError)}。请重新扫描后再更改。`, 'error');
            }
        } finally {
            if (current === generation) {
                const restoreFocus = document.activeElement === document.body;
                busy = false; activeId = null; render();
                if (restoreFocus) focusAction(item.id);
            }
        }
    }

    async function revealItem(item, target) {
        const key = `${item.id}:${target}`;
        if (!available() || opening.has(key) || !(target === 'program' ? item.canReveal : target === 'backup' ? item.canRevealBackup : item.canRevealSource)) return;
        const current = generation;
        opening.add(key); render();
        try {
            await invoke('reveal_system_startup_item', { id: item.id, target });
            if (current === generation) setStatus(`已在资源管理器中定位“${item.name}”的${target === 'program' ? '程序文件' : '启动文件'}。`, 'success');
        } catch (error) { if (current === generation) setStatus(`无法定位${target === 'program' ? '程序文件' : '启动文件'}：${String(error)}`, 'error'); }
        finally {
            if (current === generation) {
                const restoreFocus = document.activeElement === document.body;
                opening.delete(key); render();
                if (restoreFocus) focusAction(item.id, target === 'program' ? 'data-startup-reveal' : target === 'backup' ? 'data-startup-backup' : 'data-startup-source');
            }
        }
    }

    async function openSettings() {
        if (!available() || opening.has('settings')) return;
        const current = generation;
        refreshOnReturn = true; leftForSettings = false;
        opening.add('settings'); render();
        try {
            await invoke('open_system_startup_settings');
            if (current === generation && refreshOnReturn) setStatus('已打开 Windows 启动设置，返回后会更新一次列表。', 'success');
        } catch (error) { if (current === generation) { refreshOnReturn = false; setStatus(`无法打开 Windows 启动设置：${String(error)}`, 'error'); } }
        finally { if (current === generation) { opening.delete('settings'); render(); } }
    }

    function clearFilters() {
        byId('systemStartupSearch').value = '';
        for (const id of ['systemStatusFilter', 'systemScopeFilter', 'systemSourceFilter']) byId(id).value = 'all';
        updateFilter();
    }

    function exportList() {
        if (!snapshot) return;
        const items = visibleItems();
        const csv = buildStartupCsv(items);
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = `DtKit-启动项-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.append(link); link.click(); link.remove();
        const timer = setTimeout(() => { URL.revokeObjectURL(url); exportUrls.delete(url); }, 30000);
        exportUrls.set(url, timer);
        setStatus(`已导出当前筛选的 ${items.length} 项（包含全部分页），关闭时间使用 UTC。`, 'success');
    }

    async function openStartupFolder() {
        if (!available() || opening.has('folder')) return;
        const current = generation;
        opening.add('folder'); render();
        try { await invoke('open_system_startup_folder'); if (current === generation) setStatus('已打开当前用户的启动文件夹。', 'success'); }
        catch (error) { if (current === generation) setStatus(`无法打开启动文件夹：${error}`, 'error'); }
        finally { if (current === generation) { opening.delete('folder'); render(); } }
    }

    async function recordOperation(command, args, errorId, success) {
        if (busy || !available()) return false;
        const current = generation;
        busy = true; lastChange = null; byId(errorId).textContent = ''; render();
        try {
            const result = await invoke(command, args);
            if (current !== generation) return false;
            snapshot = prepareStartupSnapshot(result); stale = false;
            setStatus(success, 'success');
            return true;
        } catch (error) {
            if (current === generation) {
                byId(errorId).textContent = String(error);
                setStatus(String(error), 'error');
                try {
                    const result = await invoke('scan_system_startup_items');
                    if (current === generation) { snapshot = prepareStartupSnapshot(result); stale = false; }
                } catch { if (current === generation) stale = true; }
            }
            return false;
        } finally { if (current === generation) { busy = false; render(); } }
    }

    function openAddDialog() {
        if (byId('systemAdd').disabled) return;
        composerGeneration += 1;
        byId('systemAddForm').reset(); byId('systemAddError').textContent = '';
        byId('systemAddDialog').showModal(); byId('systemChooseProgram').focus();
    }

    async function chooseProgram() {
        if (busy || opening.has('choose')) return;
        const current = generation;
        const composer = composerGeneration;
        opening.add('choose'); byId('systemChooseProgram').disabled = true;
        try {
            const dialog = window.__TAURI__?.dialog;
            if (!dialog?.open) throw new Error('当前环境不支持选择程序文件');
            const path = await dialog.open({ multiple: false, directory: false, filters: [{ name: 'Windows 程序', extensions: ['exe'] }] });
            if (current !== generation || composer !== composerGeneration || !byId('systemAddDialog').open || !path || Array.isArray(path)) return;
            byId('systemAddPath').value = path;
            if (!byId('systemAddName').value.trim()) byId('systemAddName').value = path.split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
            byId('systemAddName').focus(); byId('systemAddError').textContent = '';
        } catch (error) { if (current === generation) byId('systemAddError').textContent = String(error); }
        finally { if (current === generation) { opening.delete('choose'); byId('systemChooseProgram').disabled = false; } }
    }

    async function addItem(event) {
        event.preventDefault();
        const path = byId('systemAddPath').value;
        const name = byId('systemAddName').value.trim();
        if (!path || !name) { byId('systemAddError').textContent = '请选择程序并填写显示名称。'; return; }
        const current = generation;
        const ok = await recordOperation('add_system_startup_item', { path, name, arguments: byId('systemAddArguments').value }, 'systemAddError', `已添加“${name}”，将在下次登录时启动。`);
        if (ok && current === generation) { byId('systemAddDialog').close(); clearFilters(); byId('systemAdd').focus(); }
    }

    function openForget(item) {
        if (busy || stale || !item.canForgetBackup) return;
        pendingForget = { id: item.id, expectedFingerprint: item.fingerprint };
        byId('systemForgetDescription').textContent = `项目：${item.name}${item.backupDisabledAt ? `；旧记录关闭于 ${dateText(item.backupDisabledAt)}` : ''}。`;
        byId('systemForgetError').textContent = ''; byId('systemForgetDialog').showModal();
    }

    async function forgetRecord() {
        if (!pendingForget) return;
        const current = generation;
        const ok = await recordOperation('forget_system_startup_backup', pendingForget, 'systemForgetError', '已放弃旧恢复记录，当前启动配置保持原样。');
        if (ok && current === generation) { byId('systemForgetDialog').close(); pendingForget = null; byId('systemRefresh').focus(); }
    }

    function openAdopt(mode = 'bind') {
        adoptMode = mode;
        pendingAdoptFingerprint = snapshot?.recoveryFingerprint;
        setText('systemAdoptTitle', mode === 'fresh' ? '在本机建立新的恢复记录' : '绑定本机旧记录');
        setText('systemAdoptDescription', mode === 'fresh' ? '保留旧版恢复文件，当前电脑和账户从空记录开始管理。旧记录将不再参与本机恢复；此前停用的旧项目仍需保留原文件妥善处理。' : '旧版恢复文件没有电脑和账户标记。仅在确认记录来自当前电脑和当前账户时绑定，否则可能恢复其他环境的启动配置。');
        setText('systemAdoptCheckLabel', mode === 'fresh' ? '我确认保留旧文件，并在本机从空记录开始' : '我确认这些旧记录属于当前电脑和账户');
        setText('systemAdoptConfirm', mode === 'fresh' ? '建立本机记录' : '确认绑定');
        byId('systemAdoptCheck').checked = false; byId('systemAdoptConfirm').disabled = true;
        byId('systemAdoptError').textContent = ''; byId('systemAdoptDialog').showModal();
    }

    async function adoptRecords() {
        if (!byId('systemAdoptCheck').checked || snapshot?.recoveryState !== 'legacy') return;
        const current = generation;
        const ok = await recordOperation(adoptMode === 'fresh' ? 'create_system_startup_recovery' : 'adopt_system_startup_backups', { expectedStoreFingerprint: pendingAdoptFingerprint }, 'systemAdoptError', adoptMode === 'fresh' ? '已保留旧恢复文件，并为当前电脑建立空记录。' : '旧恢复记录已绑定到当前电脑和账户。');
        if (ok && current === generation) { byId('systemAdoptDialog').close(); byId('systemRefresh').focus(); }
    }

    async function copyDetails(item, button) {
        const current = generation;
        const text = [item.name, `状态：${item.enabled ? '已启用' : item.managed ? '我关闭的' : '已关闭'}`,
            `范围：${item.scope === 'system' ? '所有用户' : '当前用户'}`, `启动命令：${item.command}`,
            `程序位置：${item.targetPath || '未确认'}`, `来源：${item.sourceLabel}`, `注册来源：${item.sourceDetail}`,
            item.sourcePath && `启动文件：${item.sourcePath}`, item.groupName && `所属软件：${item.groupName}（${groupReason(item.groupReason)}）`, item.disabledReason].filter(Boolean).join('\n');
        button.disabled = true;
        try { await navigator.clipboard.writeText(text); if (current === generation) setStatus('启动项详情已复制。', 'success'); }
        catch (error) { if (current === generation) setStatus(`复制失败，可展开详情手动选择：${String(error)}`, 'error'); }
        finally { if (current === generation && button.isConnected) button.disabled = false; }
    }

    function listAction(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const id = button.dataset.startupToggle || button.dataset.startupReveal || button.dataset.startupSource || button.dataset.startupDetails || button.dataset.startupCopy || button.dataset.startupForget || button.dataset.startupBackup;
        const item = snapshot?.items.find(entry => entry.id === id);
        if (!item) return;
        if (button.hasAttribute('data-startup-details')) {
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            render(); focusAction(id, 'data-startup-details');
        } else if (button.hasAttribute('data-startup-forget')) { openForget(item); }
        else if (button.hasAttribute('data-startup-copy')) { void copyDetails(item, button); }
        else if (button.hasAttribute('data-startup-reveal')) { void revealItem(item, 'program'); }
        else if (button.hasAttribute('data-startup-source')) { void revealItem(item, 'source'); }
        else if (button.hasAttribute('data-startup-backup')) { void revealItem(item, 'backup'); }
        else { void toggleItem(item); }
    }

    function updateFilter() { page = 1; render(); }

    function changePage(delta) {
        page += delta; render();
        byId('systemResultCount')?.focus({ preventScroll: true });
        byId('systemListTitle')?.scrollIntoView({ block: 'start' });
    }

    async function init() {
        destroy();
        root = [...document.querySelectorAll('.system-assistant-shell')].find(node => node.dataset.systemTool === toolId) || null;
        if (!root) return;
        controller = new AbortController();
        const { signal } = controller;
        snapshot = null; busy = false; activeId = null; stale = false; page = 1; lastChange = null; pendingForget = null; refreshOnReturn = false; leftForSettings = false;
        expanded = new Set(); opening = new Set();
        switchModule(standalone ? 'startup' : 'overview');
        root.querySelectorAll('[data-system-module]').forEach(button => button.addEventListener('click', () => switchModule(button.dataset.systemModule), { signal }));
        root.querySelectorAll('[data-open-system-module]').forEach(button => button.addEventListener('click', () => switchModule(button.dataset.openSystemModule), { signal }));
        byId('systemRefresh').addEventListener('click', refreshSnapshot, { signal });
        byId('systemStartupSettings').addEventListener('click', openSettings, { signal });
        byId('systemAdd').addEventListener('click', openAddDialog, { signal });
        byId('systemChooseProgram').addEventListener('click', chooseProgram, { signal });
        byId('systemAddForm').addEventListener('submit', addItem, { signal });
        byId('systemAddDialog').addEventListener('close', () => { composerGeneration += 1; }, { signal });
        byId('systemOpenFolder').addEventListener('click', openStartupFolder, { signal });
        byId('systemExport').addEventListener('click', exportList, { signal });
        byId('systemClearFilters').addEventListener('click', clearFilters, { signal });
        byId('systemSort').addEventListener('change', updateFilter, { signal });
        byId('systemGroupMode').addEventListener('change', updateFilter, { signal });
        byId('systemUndo').addEventListener('click', () => {
            const item = lastChange && snapshot?.items.find(entry => entry.id === lastChange.id && entry.fingerprint === lastChange.fingerprint);
            if (item) void toggleItem(item, { enabled: lastChange.enabled, undo: true });
        }, { signal });
        root.querySelectorAll('[data-system-status]').forEach(button => button.addEventListener('click', () => {
            byId('systemStatusFilter').value = button.dataset.systemStatus; updateFilter();
        }, { signal }));
        root.querySelectorAll('[data-system-close]').forEach(button => button.addEventListener('click', () => {
            if (!busy) byId(button.dataset.systemClose).close();
        }, { signal }));
        root.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); }, { signal }));
        byId('systemForgetConfirm').addEventListener('click', forgetRecord, { signal });
        byId('systemAdopt').addEventListener('click', () => openAdopt(), { signal });
        byId('systemStartFresh').addEventListener('click', () => openAdopt('fresh'), { signal });
        byId('systemAdoptCheck').addEventListener('change', () => { byId('systemAdoptConfirm').disabled = busy || !byId('systemAdoptCheck').checked; }, { signal });
        byId('systemAdoptConfirm').addEventListener('click', adoptRecords, { signal });
        const checkReturn = () => { if (refreshOnReturn && leftForSettings && !busy) { refreshOnReturn = false; leftForSettings = false; void refreshSnapshot(); } };
        const ownerWindow = window.parent || window;
        ownerWindow.addEventListener('blur', () => { if (refreshOnReturn) leftForSettings = true; }, { signal });
        ownerWindow.addEventListener('focus', checkReturn, { signal });
        window.addEventListener('dtkit:power-state', event => {
            if (event.detail?.suspended && refreshOnReturn) leftForSettings = true;
            else if (!event.detail?.suspended) checkReturn();
        }, { signal });
        root.addEventListener('pointerdown', checkReturn, { signal, capture: true });
        byId('systemStartupSearch').addEventListener('input', updateFilter, { signal });
        ['systemStatusFilter', 'systemScopeFilter', 'systemSourceFilter'].forEach(id => byId(id).addEventListener('change', updateFilter, { signal }));
        byId('systemStartupList').addEventListener('click', listAction, { signal });
        byId('systemPrevious').addEventListener('click', () => changePage(-1), { signal });
        byId('systemNext').addEventListener('click', () => changePage(1), { signal });
        render();
        if (!available()) { setStatus('此工具需要 Windows 桌面版 DtKit，扫描结果和恢复记录仅保存在本机。'); return; }
        await refreshSnapshot();
    }

    function destroy() {
        generation += 1;
        controller?.abort(); controller = null; root = null;
        for (const [url, timer] of exportUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
        exportUrls.clear();
        snapshot = null; expanded.clear(); opening.clear(); busy = false; activeId = null;
    }

    return { template, init, destroy };
}
