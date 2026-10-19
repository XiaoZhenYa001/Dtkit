import { escapeHtml as escape } from '../../core/html.js';
import { createReportCache, filterSoftware, formatBytes, formatCount, formatDuration, paginateSoftware, prepareSoftware } from './core.js';
import { detailMarkup, softwareRow, template } from './ui.js';
import { relatedStartupItems } from './startup.js';

export function createSoftwareAnalysisView() {
    let root = null, controller = null, generation = 0, searchTimer = null;
    let items = [], snapshot = null, selectedId = null, manualItem = null, page = 1;
    let listing = false, choosing = false, suspended = false, needsList = true;
    let request = null, startup = emptyStartup(), startupGeneration = 0;
    let reports = createReportCache();
    const byId = id => root?.querySelector(`#${id}`);
    const available = () => Boolean(window.__TAURI__?.core?.invoke);
    const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
    const selected = () => manualItem?.id === selectedId ? manualItem : items.find(item => item.id === selectedId);
    const current = token => Boolean(root && token === generation);

    function emptyStartup() { return { busy: false, loaded: false, items: [], total: 0, error: '' }; }
    function notice(message = '', error = false) {
        const node = byId('softwareNotice');
        if (node) { node.textContent = message; node.classList.toggle('is-error', error); }
    }

    function renderDetail() {
        if (!root || suspended) return;
        const item = selected();
        byId('softwareDetail').innerHTML = detailMarkup(item, item ? reports.get(item.id) : null, {
            available: available(), suspended, running: Boolean(request), cancelling: Boolean(request?.cancelled),
            progress: request?.progress
        }, startup);
    }

    function filters() {
        return { query: byId('softwareSearch')?.value || '', scope: byId('softwareScope')?.value || 'all', sort: byId('softwareSort')?.value || 'name' };
    }

    function renderList() {
        if (!root || suspended) return;
        const filtered = filterSoftware(items, filters(), reports);
        const result = paginateSoftware(filtered, page); page = result.page;
        const list = byId('softwareList');
        list.setAttribute('aria-busy', String(listing));
        list.innerHTML = result.items.length ? result.items.map(item => softwareRow(item, reports.peek(item.id), selectedId === item.id, Boolean(request))).join('')
            : `<div class="software-empty"><i class="${listing ? 'ri-refresh-line' : 'ri-apps-2-line'}"></i><strong>${!available() ? '请在 Windows 桌面版中使用' : listing ? '正在读取软件登记信息' : !snapshot ? '软件列表尚未就绪' : items.length ? '没有匹配的软件' : '没有可列出的软件'}</strong><p>${!available() ? '浏览器预览无法读取本机软件或扫描目录。' : listing ? '只读取软件清单，不扫描文件。' : !snapshot ? '点击“刷新列表”重试。' : items.length ? '试试其他关键词或范围。' : '可点击“选择软件目录”分析绿色软件。'}</p></div>`;
        byId('softwareTotal').textContent = snapshot ? formatCount(items.length) : '—';
        byId('softwareAnalyzable').textContent = snapshot ? formatCount(items.filter(item => item.canAnalyze).length) : '—';
        byId('softwareMeasured').textContent = formatCount([...reports.entries()].filter(([, report]) => report.complete).length);
        byId('softwareResultCount').textContent = snapshot ? `${formatCount(result.total)} 款软件 · 每页最多 60 项` : listing ? '正在读取软件列表…' : '等待读取';
        byId('softwareScannedAt').textContent = snapshot ? `${snapshot.cached ? '缓存列表' : '本次读取'}${timeLabel(snapshot.scannedAt)}` : '';
        byId('softwarePagination').hidden = result.pages < 2;
        byId('softwarePage').textContent = `${result.page} / ${result.pages}`;
        byId('softwarePrevious').disabled = page <= 1; byId('softwareNext').disabled = page >= result.pages;
        byId('softwareRefresh').disabled = !available() || listing || choosing || Boolean(request);
        byId('softwareRefresh').innerHTML = `<i class="ri-refresh-line"></i>${listing ? '正在读取…' : '刷新列表'}`;
        byId('softwareChooseFolder').disabled = !available() || !window.__TAURI__?.dialog?.open || choosing || Boolean(request);
        const warnings = snapshot?.warnings || [];
        byId('softwareWarnings').innerHTML = warnings.length ? `<details><summary>列表读取提示（${warnings.length}）</summary><ul>${warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul></details>` : '';
    }

    function timeLabel(value) {
        const date = new Date(value);
        return value && !Number.isNaN(date.getTime()) ? ` · ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
    }
    function render() { renderList(); renderDetail(); }

    function applySoftwareSnapshot(result) {
        items = prepareSoftware(result?.items);
        snapshot = { scannedAt: result?.scannedAt, cached: result?.cached === true,
            warnings: (Array.isArray(result?.warnings) ? result.warnings : []).filter(item => typeof item === 'string').slice(0, 30) };
        needsList = false;
        if (selectedId && !selected()) { selectedId = null; startup = emptyStartup(); }
    }

    async function loadSoftware(refresh = false) {
        if (!available() || listing || suspended || request) return;
        const token = generation;
        needsList = false; listing = true; notice(); renderList();
        try {
            const result = await invoke('list_installed_software', { refresh });
            if (!current(token)) return;
            applySoftwareSnapshot(result);
            if (refresh) reports.clear();
            notice(`已读取 ${formatCount(items.length)} 款软件。选择软件后，点击“分析占用”开始扫描。`);
        } catch (error) {
            if (current(token)) notice(`读取软件列表失败：${String(error)}。可点击“刷新列表”重试。`, true);
        } finally { if (current(token)) { listing = false; render(); } }
    }

    function changeSelection(id) {
        if (request || suspended || id === selectedId) return;
        selectedId = id; startupGeneration++; startup = emptyStartup();
        render();
    }

    async function chooseFolder() {
        if (!available() || !window.__TAURI__?.dialog?.open || request || choosing || suspended) return;
        const token = generation; choosing = true; renderList();
        try {
            const path = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: '选择要分析的软件目录' });
            if (!current(token) || suspended || typeof path !== 'string' || !path) return;
            const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
            manualItem = { id: `folder:${path}`, name, publisher: '', version: '', installLocation: path,
                estimatedBytes: null, source: '手动选择目录', installDate: '', canAnalyze: true, reason: '', scope: 'user', manual: true };
            changeSelection(manualItem.id);
            notice('已选择目录。点击“分析占用”后开始扫描，请确认这是该软件的专用目录。');
        } catch (error) { if (current(token)) notice(`选择目录失败：${String(error)}`, true); }
        finally { if (current(token)) { choosing = false; renderList(); } }
    }

    function progressText(progress) {
        return `已统计 ${formatCount(progress.files)} 个文件 · ${formatCount(progress.directories)} 个目录 · ${formatBytes(progress.totalBytes)} · ${formatDuration(progress.elapsedMs)}${progress.skipped ? ` · 跳过 ${formatCount(progress.skipped)} 项` : ''}`;
    }

    async function analyzeWithRefresh(active, item, token) {
        const mayStart = () => current(token) && request === active && !active.cancelled && !active.discardResults && !suspended;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!mayStart()) return null;
            active.started = true;
            try {
                return await invoke('analyze_software_space', {
                    requestId: active.id, softwareId: item.manual ? null : item.id, path: item.manual ? item.installLocation : null
                });
            } catch (error) {
                active.started = false;
                if (!mayStart()) return null;
                if (attempt !== 0 || item.manual || !String(error).includes('软件列表已过期')) throw error;
                // A different page may have released the native cache, or its TTL elapsed.
                // Refresh only for this user-requested scan; registered IDs never fall back to old paths.
                active.progress = '软件列表已过期，正在更新软件信息…'; renderDetail();
                const refreshed = await invoke('list_installed_software', { refresh: false });
                if (!mayStart()) return null;
                applySoftwareSnapshot(refreshed); reports.clear(); startupGeneration++; startup = emptyStartup();
                const refreshedItem = items.find(candidate => candidate.id === item.id);
                render();
                if (!refreshedItem) throw new Error('所选软件已不在最新列表中，请重新选择软件');
                if (!refreshedItem.canAnalyze || !refreshedItem.installLocation) {
                    throw new Error(refreshedItem.reason || '最新登记信息没有可分析的安装位置，请重新选择软件或手动选择目录');
                }
                item = refreshedItem; active.progress = '软件信息已更新，正在准备目录扫描…'; renderDetail();
            }
        }
        return null;
    }

    async function scanSelected() {
        const item = selected();
        if (!available() || !item?.canAnalyze || !item.installLocation || request || suspended) return;
        const token = generation;
        const active = { id: globalThis.crypto?.randomUUID?.() || `software-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            itemId: item.id, cancelled: false, started: false, unlisten: null, cancellation: null, progress: '' };
        request = active; notice(); render();
        try {
            if (!window.__TAURI__?.event?.listen) throw new Error('扫描进度接口不可用，请重新打开工具后重试');
            const unlisten = await window.__TAURI__.event.listen('software-analysis-progress', event => {
                const progress = event.payload;
                if (!current(token) || request !== active || progress?.requestId !== active.id || suspended) return;
                active.progress = progressText(progress);
                const node = byId('softwareProgress')?.querySelector('p');
                if (node) node.textContent = active.cancelled ? '正在停止，等待当前目录操作结束…' : active.progress;
            });
            active.unlisten = unlisten;
            if (!current(token) || active.cancelled || suspended) return;
            const result = await analyzeWithRefresh(active, item, token);
            if (!result) {
                if (current(token) && request === active && active.cancelled && !active.discardResults) notice('扫描已取消。');
                return;
            }
            if (!current(token) || request !== active || active.discardResults || result?.requestId !== active.id) return;
            reports.set(item.id, result);
            notice(result.cancelled ? '扫描已取消，保留已统计的部分结果。' : result.complete ? '扫描完成。结果仅包含分析位置内的文件。' : '扫描结束，存在未读取的内容，请查看扫描提示。');
        } catch (error) {
            if (current(token) && request === active && !active.discardResults) {
                if (active.cancelled) { notice('扫描已取消。'); return; }
                const item = selected();
                notice(`分析未完成：${String(error)}。${item?.canAnalyze && item.installLocation ? '可再次点击“分析占用”重试。' : '请重新选择软件，或手动选择软件目录。'}`, true);
            }
        } finally {
            active.unlisten?.(); active.unlisten = null;
            if (request === active) request = null;
            if (current(token)) render();
        }
    }

    async function cancelScan(message = '', discardResults = false) {
        const active = request;
        if (!active) return;
        if (discardResults) active.discardResults = true;
        active.cancelled = true;
        if (message) notice(message);
        if (!suspended) renderDetail();
        if (!active.started) return;
        if (!active.cancellation) active.cancellation = invoke('cancel_software_analysis', { requestId: active.id });
        try { await active.cancellation; }
        catch (error) {
            active.cancellation = null;
            if (request === active && root) notice(`停止请求未成功：${String(error)}。可以再次点击取消。`, true);
            active.cancelled = false; if (!suspended) renderDetail();
        }
    }

    async function startupScan() {
        const item = selected();
        if (!available() || !item?.installLocation || request || startup.busy || suspended) return;
        const token = generation, selectionToken = ++startupGeneration;
        startup = { ...emptyStartup(), busy: true }; renderDetail();
        try {
            const result = await invoke('scan_system_startup_items', { toolId: 'startup-manager' });
            if (!current(token) || startupGeneration !== selectionToken) return;
            const related = relatedStartupItems(result, item.installLocation);
            startup = { ...related, busy: false, loaded: true, error: '', warning: related.warnings.length ? `部分启动来源未读取：${related.warnings.join('；')}` : '' };
        } catch (error) {
            if (current(token) && startupGeneration === selectionToken) startup = { ...emptyStartup(), error: `读取自启动失败：${String(error)}。可重试。` };
        } finally { if (current(token) && startupGeneration === selectionToken) renderDetail(); }
    }

    async function pathAction(button) {
        const token = generation;
        const path = button.dataset.softwareCopy || button.dataset.softwareReveal;
        if (!path || suspended) return;
        button.disabled = true;
        try {
            if (button.hasAttribute('data-software-copy')) { await navigator.clipboard.writeText(path); if (current(token)) notice('路径已复制。'); }
            else if (available()) { await invoke('reveal_software_location', { path }); if (current(token)) notice('已打开文件位置。'); }
        } catch (error) { if (current(token)) notice(`操作失败：${String(error)}`, true); }
        finally { if (current(token) && button.isConnected) button.disabled = false; }
    }

    async function openStartup() {
        const token = generation;
        try { await invoke('open_quick_host', { target: { kind: 'tool', toolId: 'startup-manager' } }); }
        catch (error) { if (current(token)) notice(`打开自启动管理失败：${String(error)}`, true); }
    }

    function actions(event) {
        const button = event.target.closest('button');
        if (!button || button.disabled || suspended) return;
        if (button.hasAttribute('data-software-id')) changeSelection(button.dataset.softwareId);
        else if (button.hasAttribute('data-software-copy') || button.hasAttribute('data-software-reveal')) void pathAction(button);
        else if (button.id === 'softwareRefresh') void loadSoftware(true);
        else if (button.id === 'softwareChooseFolder') void chooseFolder();
        else if (button.id === 'softwareScan') void scanSelected();
        else if (button.id === 'softwareCancel') void cancelScan('正在请求停止扫描…');
        else if (button.id === 'softwareStartupScan') void startupScan();
        else if (button.id === 'softwareStartupOpen') void openStartup();
        else if (button.id === 'softwarePrevious' || button.id === 'softwareNext') {
            page += button.id === 'softwarePrevious' ? -1 : 1; renderList();
            byId('softwareResultCount')?.focus({ preventScroll: true });
        }
    }

    function setSuspended(value) {
        const wasSuspended = suspended; suspended = Boolean(value);
        if (suspended) { clearTimeout(searchTimer); searchTimer = null; void cancelScan('', true); }
        else if (wasSuspended) { if (needsList) void loadSoftware(); else render(); }
    }

    async function init() {
        await destroy();
        root = document.querySelector('.software-shell'); if (!root) return;
        controller = new AbortController(); const { signal } = controller;
        suspended = Boolean(document.hidden || window.__DTKIT_TOOL_PAGE__?.suspended);
        root.addEventListener('click', actions, { signal });
        byId('softwareSearch').addEventListener('input', () => {
            clearTimeout(searchTimer);
            if (!suspended) searchTimer = setTimeout(() => { searchTimer = null; page = 1; renderList(); }, 140);
        }, { signal });
        for (const id of ['softwareScope', 'softwareSort']) byId(id).addEventListener('change', () => { clearTimeout(searchTimer); page = 1; renderList(); }, { signal });
        window.addEventListener('dtkit:power-state', event => setSuspended(event.detail?.suspended), { signal });
        document.addEventListener('visibilitychange', () => setSuspended(document.hidden || window.__DTKIT_TOOL_PAGE__?.suspended), { signal });
        window.addEventListener('pagehide', () => { void cancelScan('', true); }, { signal });
        render();
        if (!available()) { notice('此工具需要 Windows 桌面版 DtKit。浏览器预览不会读取软件信息或扫描本机文件。'); return; }
        await loadSoftware();
    }

    function serialize() {
        return { version: 1, ...filters(), selectedId: manualItem?.id === selectedId ? null : selectedId, page };
    }

    function restore(state) {
        if (!root || state?.version !== 1) return;
        byId('softwareSearch').value = typeof state.query === 'string' ? state.query.slice(0, 256) : '';
        byId('softwareScope').value = ['all', 'user', 'system'].includes(state.scope) ? state.scope : 'all';
        byId('softwareSort').value = ['name', 'estimated', 'measured'].includes(state.sort) ? state.sort : 'name';
        selectedId = typeof state.selectedId === 'string' ? state.selectedId : null;
        page = Math.max(1, Math.floor(Number(state.page)) || 1); render();
    }

    async function destroy() {
        generation++; startupGeneration++;
        clearTimeout(searchTimer); searchTimer = null;
        controller?.abort(); controller = null;
        const hadRoot = Boolean(root);
        const active = request;
        await cancelScan('', true);
        active?.unlisten?.(); if (active) active.unlisten = null;
        root = null; request = null; items = []; snapshot = null; selectedId = null; manualItem = null;
        reports.clear(); reports = createReportCache(); startup = emptyStartup(); page = 1;
        listing = false; choosing = false; suspended = false; needsList = true;
        if (hadRoot && available()) { try { await invoke('release_software_analysis'); } catch { /* Module may already have been disabled. */ } }
    }

    return { template, init, destroy, serialize, restore, flush: () => cancelScan() };
}
