import { registerTool } from '../toolRegistry.js';
import { escapeHtml } from '../../core/html.js';
import { CONTEXT_CATEGORIES, categoryLabel, normalizeExtension, prepareSnapshot, filterItems, categoryCounts } from './model.js';
import '../../css/tools/context-menu.css';

const PAGE_SIZE = 80;
const byId = id => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let controller;
let generation = 0;
let snapshot;
let busy = false;
let stale = false;
let category = 'all';
let page = 1;
let expanded = new Set();
let confirmation = null;
let activeId = null;

function template() {
    return `<div class="context-shell">
        <header class="context-header"><div class="context-heading"><span class="context-emblem"><i class="ri-menu-2-line"></i></span><div><span class="context-kicker">整理每一次右键</span><h2>右键菜单管理</h2><p>找到不常用的菜单项，随时关闭，也能再开启。</p></div></div><span class="context-local"><i class="ri-computer-line"></i> 本机菜单</span></header>
        <section class="context-overview" aria-label="菜单概览"><div><strong id="contextTotal">—</strong><span>检测到的项目</span></div><div><strong id="contextEnabled">—</strong><span><b class="context-dot"></b>已开启</span></div><div><strong id="contextDisabled">—</strong><span>已关闭</span></div><div><strong id="contextReadOnly">—</strong><span>仅查看</span></div></section>
        <form id="contextScanForm" class="context-scanbar"><div><label for="contextExtension">额外检测一种文件类型</label><span>通用菜单会一并扫描</span></div><div class="context-scanbar__actions"><input id="contextExtension" type="text" placeholder="例如 .pdf（选填）" aria-label="文件扩展名" autocomplete="off" spellcheck="false" maxlength="64"><button id="contextScan" class="context-button context-button--primary" type="submit"><i class="ri-refresh-line"></i><span>重新扫描</span></button></div></form>
        <p id="contextNotice" class="context-notice" role="status" aria-live="polite"></p>
        <div id="contextWarnings" class="context-warnings"></div>
        <nav id="contextCategories" class="context-categories" aria-label="右键菜单分类">${CONTEXT_CATEGORIES.map(item => `<button type="button" data-context-category="${item.id}" aria-pressed="${item.id === 'all'}"><i class="${item.icon}"></i>${item.name}<span data-context-count="${item.id}">0</span></button>`).join('')}</nav>
        <div class="context-filters"><label class="context-search"><i class="ri-search-line"></i><input id="contextSearch" type="search" placeholder="搜索名称、应用或命令" aria-label="搜索菜单项" autocomplete="off"></label><select id="contextStatus" aria-label="菜单状态"><option value="all">全部状态</option><option value="enabled">已开启</option><option value="disabled">已关闭</option><option value="managed">我关闭的</option><option value="readOnly">仅查看</option></select><select id="contextScope" aria-label="注册范围"><option value="all">全部范围</option><option value="user">当前用户</option><option value="system">系统范围</option></select><select id="contextKind" aria-label="菜单类型"><option value="all">全部类型</option><option value="verb">普通菜单项</option><option value="extension">菜单扩展</option></select></div>
        <div class="context-list-heading"><span id="contextResultCount" tabindex="-1">正在准备检测</span><span id="contextScannedAt"></span></div>
        <div id="contextList" class="context-list" aria-label="菜单项目" aria-busy="false"></div>
        <div id="contextPagination" class="context-pagination" hidden><button id="contextPrevious" class="context-button" type="button">上一页</button><span id="contextPage"></span><button id="contextNext" class="context-button" type="button">下一页</button></div>
        <details class="context-help"><summary><i class="ri-information-line"></i> 哪些菜单可以管理？</summary><p>检测 Windows 文件资源管理器的常见经典右键菜单。Windows 11 中，它们可能位于“显示更多选项”里；浏览器等应用内部的右键菜单不在此范围。列表展示注册状态，实际出现的项目还取决于所选文件、应用和 Windows 设置。</p><p>菜单扩展按扩展标识对当前用户统一关闭，会影响它在各个位置提供的选项，也可能影响同一组件的其他资源管理器功能。普通菜单项在其原注册位置更改，系统范围的项目可能需要管理员权限。系统保留项和其他软件关闭的项目会标记为“仅查看”。更改后重新打开右键菜单；部分扩展需要下次登录后生效。</p><p>只在打开工具或手动扫描时读取列表，更改后更新实际状态。关闭项目会保留恢复记录，在“我关闭的”中可重新开启。</p></details>
    </div>`;
}

function notice(message = '', error = false) {
    const element = byId('contextNotice');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', error);
}

function filters() {
    return { category, query: byId('contextSearch').value, status: byId('contextStatus').value,
        scope: byId('contextScope').value, kind: byId('contextKind').value };
}

function timeLabel(value) {
    const time = new Date(value);
    return value && !Number.isNaN(time.getTime()) ? `上次扫描 ${time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
}

function details(item) {
    const field = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value || '未提供')}</dd></div>`;
    return `<div class="context-detail"><dl>${field('注册位置', item.registryPath)}${field(item.kind === 'extension' ? '扩展程序 / 命令' : '执行命令', item.command)}${item.clsid ? field('扩展标识', item.clsid) : ''}${field('适用位置', item.categories.map(categoryLabel).join('、'))}${item.detail ? field('说明', item.detail) : ''}${item.disabledReason ? field('只读原因', item.disabledReason) : ''}</dl><button class="context-button" type="button" data-context-copy="${escapeHtml(item.id)}"><i class="ri-file-copy-line"></i>复制详情</button></div>`;
}

function confirmPanel(item) {
    return `<section class="context-confirm" role="group" aria-label="确认关闭菜单扩展"><div><strong>关闭“${escapeHtml(item.name)}”？</strong><p>这会对<b>当前用户统一关闭整个扩展</b>，它提供的多个菜单选项将一并隐藏。检测到的适用位置：<b>${escapeHtml(item.categories.map(categoryLabel).join('、') || '多个位置')}</b>。同一扩展在其他文件类型或位置的菜单，以及同一组件的其他资源管理器功能，也可能受到影响。</p><p>之后可在“我关闭的”中重新开启。</p></div><div class="context-confirm__actions"><button id="contextCancel" class="context-button" type="button">取消</button><button id="contextConfirm" class="context-button context-button--primary" type="button">确认关闭</button></div></section>`;
}

function focusToggle(id) {
    const button = [...(byId('contextList')?.querySelectorAll('[data-context-toggle]') || [])]
        .find(element => element.dataset.contextToggle === id && !element.disabled);
    (button || byId('contextResultCount'))?.focus({ preventScroll: true });
}

function cancelConfirmation() {
    const id = confirmation;
    confirmation = null;
    render();
    if (id) focusToggle(id);
}

function changePage(delta) {
    page += delta;
    confirmation = null;
    render();
    byId('contextResultCount')?.focus({ preventScroll: true });
    byId('contextResultCount')?.scrollIntoView({ block: 'start' });
}

function row(item) {
    const id = escapeHtml(item.id);
    const open = expanded.has(item.id);
    const disabled = busy || stale || !item.canToggle;
    const stateLabel = item.enabled ? '已开启' : item.managed ? '我关闭的' : '已关闭';
    return `<article class="context-row ${item.enabled ? '' : 'is-off'}" data-context-id="${id}">
        <div class="context-row__main"><span class="context-row__icon"><i class="${item.kind === 'extension' ? 'ri-apps-2-line' : 'ri-menu-2-line'}"></i></span><div class="context-row__body"><h3 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3><div class="context-tags"><span>${item.kind === 'extension' ? '菜单扩展' : '普通菜单项'}</span><span>${item.scope === 'system' ? '系统范围' : '当前用户'}</span>${item.categories.length > 1 ? `<span class="context-shared" title="${escapeHtml(item.categories.map(categoryLabel).join('、'))}">${item.categories.length} 类位置共用</span>` : item.categories.length ? `<span>${escapeHtml(categoryLabel(item.categories[0]))}</span>` : ''}${!item.canToggle ? '<span class="context-readonly">仅查看</span>' : item.requiresElevation ? '<span>需要管理员权限</span>' : ''}</div>${!item.canToggle && item.disabledReason ? `<p class="context-reason">${escapeHtml(item.disabledReason)}</p>` : ''}</div><div class="context-row__control"><span>${busy && activeId === item.id ? '正在更改' : stateLabel}</span><button class="context-switch" type="button" role="switch" aria-checked="${item.enabled}" aria-label="${item.enabled ? '关闭' : '开启'} ${escapeHtml(item.name)}" data-context-toggle="${id}" ${disabled ? 'disabled' : ''} title="${escapeHtml(!item.canToggle ? item.disabledReason || '此项目仅供查看' : stale ? '请重新扫描后再更改' : item.enabled ? '关闭此项目' : '开启此项目')}"><span></span></button></div></div>
        <div class="context-row__bottom"><span>${item.kind === 'extension' ? '一个扩展可能包含多个右键选项' : item.command ? escapeHtml(item.command) : '查看详情了解注册来源'}</span><button type="button" data-context-details="${id}" aria-expanded="${open}">${open ? '收起' : '详情'}<i class="ri-arrow-down-s-line"></i></button></div>${open ? details(item) : ''}${confirmation === item.id ? confirmPanel(item) : ''}
    </article>`;
}

function render() {
    const list = byId('contextList');
    if (!list) return;
    const available = Boolean(window.__TAURI__?.core?.invoke);
    byId('contextScan').disabled = busy || !available;
    byId('contextScan').querySelector('span').textContent = busy && !activeId ? '正在扫描' : '重新扫描';
    byId('contextExtension').disabled = busy || !available;
    list.setAttribute('aria-busy', String(busy));
    for (const [id, value] of [['contextTotal', snapshot?.total], ['contextEnabled', snapshot?.enabled], ['contextDisabled', snapshot?.disabled], ['contextReadOnly', snapshot?.readOnly]]) byId(id).textContent = value ?? '—';
    const counts = categoryCounts(snapshot?.items || []);
    byId('contextCategories').querySelectorAll('[data-context-category]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.contextCategory === category));
        button.querySelector('span').textContent = counts[button.dataset.contextCategory];
    });
    byId('contextWarnings').innerHTML = snapshot?.warnings.length ? `<details><summary>有 ${snapshot.warnings.length} 条扫描提示，部分项目可能未被读取</summary><ul>${snapshot.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : '';
    byId('contextScannedAt').textContent = snapshot ? timeLabel(snapshot.scannedAt) : '';
    const visible = filterItems(snapshot?.items || [], filters());
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, pages));
    byId('contextResultCount').textContent = snapshot ? `${categoryLabel(category)} · ${visible.length} 项${snapshot.extension ? ` · 含 ${snapshot.extension}` : ''}` : busy ? '正在检测本机菜单…' : '等待检测';
    list.innerHTML = visible.length ? visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row).join('')
        : `<div class="context-empty"><i class="${busy ? 'ri-refresh-line' : 'ri-menu-2-line'}"></i><strong>${!available ? '在桌面版中管理右键菜单' : busy ? '正在读取菜单注册信息' : !snapshot ? '菜单列表尚未就绪' : snapshot.total ? '没有符合条件的菜单项' : '没有检测到可列出的菜单项'}</strong><p>${!available ? '请打开 Windows 桌面版 DtKit 使用此工具。' : busy ? '首次读取可能需要一点时间。' : !snapshot ? '点击“重新扫描”再试一次。' : snapshot.total ? '尝试其他分类、关键词或筛选条件。' : '可以填写一种文件扩展名，再扫描该类型的专用菜单。'}</p></div>`;
    byId('contextPagination').hidden = pages < 2;
    byId('contextPage').textContent = `${page} / ${pages}`;
    byId('contextPrevious').disabled = page === 1;
    byId('contextNext').disabled = page === pages;
}

async function scan(event) {
    event?.preventDefault();
    if (busy || !window.__TAURI__?.core?.invoke) return;
    let extension;
    try { extension = normalizeExtension(byId('contextExtension').value); }
    catch (error) { notice(error.message, true); byId('contextExtension').focus(); return; }
    const current = generation;
    busy = true; activeId = null; confirmation = null;
    notice(); render();
    try {
        const result = await invoke('scan_context_menu_items', { extension });
        if (current !== generation) return;
        snapshot = prepareSnapshot(result);
        stale = false; page = 1;
        byId('contextExtension').value = snapshot.extension || '';
        notice(snapshot.total ? `扫描完成。菜单关闭后，可在“我关闭的”中重新开启。` : '扫描完成，暂未发现菜单项目。');
    } catch (error) {
        if (current === generation) { stale = true; notice(`扫描失败：${String(error)}${snapshot ? '。当前保留上次列表，请重新扫描后再更改。' : ''}`, true); }
    } finally { if (current === generation) { busy = false; render(); } }
}

async function setEnabled(item) {
    if (busy || stale || !item?.canToggle || !snapshot) return;
    const current = generation;
    const extension = snapshot.extension;
    const enabled = !item.enabled;
    busy = true; activeId = item.id; confirmation = null;
    notice(); render();
    try {
        const result = await invoke('set_context_menu_enabled', { id: item.id, enabled, expectedFingerprint: item.fingerprint, extension });
        if (current !== generation) return;
        snapshot = prepareSnapshot(result);
        stale = false;
        notice(`已${enabled ? '开启' : '关闭'}“${item.name}”。重新打开右键菜单即可查看；部分扩展需要下次登录后生效。`);
    } catch (error) {
        if (current !== generation) return;
        stale = true;
        const message = `更改未完成：${String(error)}${item.requiresElevation ? '。此项目可能需要管理员权限，可关闭 DtKit 后以管理员身份重新打开。' : ''}`;
        notice(`${message}。正在重新读取实际状态…`, true);
        try {
            const result = await invoke('scan_context_menu_items', { extension });
            if (current !== generation) return;
            snapshot = prepareSnapshot(result); stale = false;
            notice(`${message}。列表已更新为当前实际状态。`, true);
        } catch (refreshError) {
            if (current === generation) notice(`${message}。读取当前状态也失败了：${String(refreshError)}。请重新扫描后再更改。`, true);
        }
    } finally {
        if (current === generation) {
            const restoreFocus = document.activeElement === document.body;
            busy = false; activeId = null; render();
            if (restoreFocus) focusToggle(item.id);
        }
    }
}

async function copyDetails(item, button) {
    const current = generation;
    button.disabled = true;
    const text = [item.name, `状态：${item.enabled ? '已开启' : '已关闭'}`, `类型：${item.kind === 'extension' ? '菜单扩展' : '普通菜单项'}`,
        `适用位置：${item.categories.map(categoryLabel).join('、')}`, `注册位置：${item.registryPath}`, `命令：${item.command}`,
        item.clsid && `CLSID：${item.clsid}`, item.detail, item.disabledReason].filter(Boolean).join('\n');
    try {
        await navigator.clipboard.writeText(text);
        if (current === generation) notice('菜单详情已复制。');
    } catch (error) { if (current === generation) notice(`复制失败，可展开详情手动选择文字：${String(error)}`, true); }
    finally { if (current === generation && button.isConnected) button.disabled = false; }
}

function listAction(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'contextCancel') { cancelConfirmation(); return; }
    if (button.id === 'contextConfirm') {
        const item = snapshot?.items.find(entry => entry.id === confirmation);
        if (item) void setEnabled(item);
        return;
    }
    const id = button.dataset.contextToggle || button.dataset.contextDetails || button.dataset.contextCopy;
    const item = snapshot?.items.find(entry => entry.id === id);
    if (!item) return;
    if (button.hasAttribute('data-context-details')) {
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
        byId('contextList').querySelectorAll('[data-context-details]').forEach(element => { if (element.dataset.contextDetails === id) element.focus({ preventScroll: true }); });
    } else if (button.hasAttribute('data-context-copy')) { void copyDetails(item, button); }
    else if (!busy && !stale && item.canToggle) {
        if (item.kind === 'extension' && item.enabled) {
            confirmation = id; render(); byId('contextCancel')?.focus();
        } else { void setEnabled(item); }
    }
}

function updateFilter() { page = 1; confirmation = null; render(); }

async function init() {
    destroy();
    controller = new AbortController();
    const { signal } = controller;
    snapshot = null; busy = false; stale = false; category = 'all'; page = 1;
    expanded = new Set(); confirmation = null; activeId = null;
    byId('contextScanForm').addEventListener('submit', scan, { signal });
    byId('contextSearch').addEventListener('input', updateFilter, { signal });
    ['contextStatus', 'contextScope', 'contextKind'].forEach(id => byId(id).addEventListener('change', updateFilter, { signal }));
    byId('contextCategories').addEventListener('click', event => {
        const button = event.target.closest('[data-context-category]');
        if (!button) return;
        category = button.dataset.contextCategory; updateFilter();
    }, { signal });
    byId('contextList').addEventListener('click', listAction, { signal });
    byId('contextList').addEventListener('keydown', event => {
        if (event.key === 'Escape' && confirmation) { event.preventDefault(); event.stopPropagation(); cancelConfirmation(); }
    }, { signal });
    byId('contextPrevious').addEventListener('click', () => changePage(-1), { signal });
    byId('contextNext').addEventListener('click', () => changePage(1), { signal });
    render();
    if (!window.__TAURI__?.core?.invoke) { notice('此工具需要 Windows 桌面版 DtKit，检测结果及恢复记录仅保存在本机。'); return; }
    await scan();
}

function destroy() {
    generation += 1;
    controller?.abort(); controller = null;
    snapshot = null; confirmation = null; activeId = null;
    expanded.clear();
}

registerTool({ id: 'context-menu', name: '右键菜单管理', icon: 'ri-menu-2-line', colorClass: 'tool-card__icon--blue', category: 'utility', status: 'ready', description: '按位置整理 Windows 右键菜单，关闭不常用的选项并随时恢复。', template, init, destroy });
