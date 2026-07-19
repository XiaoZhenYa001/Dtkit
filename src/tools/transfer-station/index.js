import { registerTool } from '../toolRegistry.js';
import '../../css/tools/transfer-station.css';

let abortController = null;
let unlistenShare = null;
let items = [];
let activeShare = null;
let pendingRemoval = null;
let lastRecoveryBatch = null;

function getTemplate() {
    return `
        <div class="transfer-tool-shell">
            <header class="transfer-hero">
                <div><span class="transfer-kicker">TEMP TRANSFER</span><h2>临时文件中转站</h2>
                    <p>文件只保存在本机受管目录；局域网分享默认关闭，并在下载一次或到期后停止。</p></div>
                <div class="transfer-import-controls">
                    <label><span>保存时间</span><select id="transferTtl">
                        <option value="3600">1 小时</option><option value="86400" selected>24 小时</option>
                        <option value="604800">7 天</option><option value="2592000">30 天</option>
                    </select></label>
                    <button id="transferImport" class="transfer-button transfer-button--primary" type="button"><i class="ri-add-line"></i> 添加文件</button>
                </div>
            </header>

            <div class="transfer-layout">
                <section class="transfer-list-card">
                    <div class="transfer-section-header"><div><span class="transfer-kicker">LOCAL</span><h3>本地中转文件</h3></div>
                        <span id="transferSummary">正在读取…</span></div>
                    <div id="transferItems" class="transfer-items" aria-live="polite"></div>
                    <div id="transferUndo" class="transfer-undo" hidden>
                        <span><i class="ri-archive-line"></i> 文件已移入恢复区</span>
                        <button id="transferRestore" class="transfer-button transfer-button--secondary" type="button">撤销移除</button>
                    </div>
                </section>

                <aside class="transfer-share-card">
                    <div class="transfer-section-header"><div><span class="transfer-kicker">LAN SHARE</span><h3>局域网分享</h3></div>
                        <span id="transferShareState" class="transfer-state">未开启</span></div>
                    <div id="transferShareEmpty" class="transfer-share-empty">
                        <i class="ri-wifi-line"></i><strong>按需开启，不常驻监听</strong>
                        <p>从左侧选择一个文件。链接含随机令牌，仅供同一局域网内下载。</p>
                    </div>
                    <div id="transferShareActive" class="transfer-share-active" hidden>
                        <div class="transfer-shared-file"><i class="ri-file-line"></i><div><span>正在分享</span><strong id="transferShareName"></strong></div></div>
                        <label class="transfer-link-field"><span>一次性下载链接</span><textarea id="transferShareUrl" rows="3" readonly></textarea></label>
                        <div class="transfer-share-actions">
                            <button id="transferCopyLink" class="transfer-button transfer-button--primary" type="button">复制链接</button>
                            <button id="transferStopShare" class="transfer-button transfer-button--secondary" type="button">停止分享</button>
                        </div>
                        <p id="transferShareExpiry"></p>
                    </div>
                    <div class="transfer-security-note"><i class="ri-shield-check-line"></i><div><strong>安全边界</strong>
                        <span>只读、单文件、单次下载；无目录浏览、无云端、无自动发现。链接使用 HTTP，不提供传输加密：仅在可信私人网络使用，不要分享密码、密钥等敏感文件。首次使用防火墙提示时只允许私人网络。</span></div></div>
                </aside>
            </div>
            <p id="transferStatus" class="transfer-status" role="status" aria-live="polite"></p>

            <dialog id="transferRemoveDialog" class="transfer-dialog" aria-labelledby="transferRemoveTitle">
                <form method="dialog">
                    <div id="transferRemoveIcon" class="transfer-dialog-icon"><i class="ri-archive-line"></i></div>
                    <h3 id="transferRemoveTitle">移除中转文件？</h3>
                    <p id="transferRemoveDescription">默认会移入恢复区，可以撤销。</p>
                    <label class="transfer-permanent-check"><input id="transferPermanent" type="checkbox"><span>彻底删除，不进入恢复区</span></label>
                    <div><button value="cancel" class="transfer-button transfer-button--secondary">取消</button>
                        <button id="transferConfirmRemove" value="default" class="transfer-button transfer-button--primary">移入恢复区</button></div>
                </form>
            </dialog>
        </div>
    `;
}

const byId = id => document.getElementById(id);
const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatExpiry(value) {
    const remaining = Math.max(0, value - Date.now());
    const hours = Math.ceil(remaining / 3_600_000);
    if (hours < 24) return `${hours} 小时后过期`;
    return `${Math.ceil(hours / 24)} 天后过期`;
}

function setStatus(message, type = '') {
    const status = byId('transferStatus');
    status.textContent = message;
    status.dataset.type = type;
}

function itemRow(item) {
    const row = document.createElement('article');
    row.className = 'transfer-item';
    row.dataset.itemId = item.id;
    const icon = document.createElement('span');
    icon.className = 'transfer-item-icon ri-file-line';
    const detail = document.createElement('div');
    detail.className = 'transfer-item-detail';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.textContent = `${formatBytes(item.size)} · ${formatExpiry(item.expiresAt)}`;
    detail.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'transfer-item-actions';
    for (const [action, label, iconName] of [
        ['open', '打开', 'ri-arrow-right-up-line'], ['export', '导出', 'ri-download-2-line'],
        ['share', '局域网分享', 'ri-wifi-line'], ['remove', '移除', 'ri-delete-bin-line']
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.transferAction = action;
        button.title = label;
        button.setAttribute('aria-label', `${label} ${item.name}`);
        button.innerHTML = `<i class="${iconName}"></i><span>${label}</span>`;
        actions.append(button);
    }
    row.append(icon, detail, actions);
    return row;
}

function renderItems() {
    const container = byId('transferItems');
    byId('transferSummary').textContent = `${items.length} / 100 项 · ${formatBytes(items.reduce((sum, item) => sum + item.size, 0))}`;
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'transfer-empty';
        empty.innerHTML = '<i class="ri-box-3-line"></i><strong>中转站为空</strong><span>添加文件后可在本机临时保存或通过局域网分享。</span>';
        container.replaceChildren(empty);
        return;
    }
    container.replaceChildren(...items.map(itemRow));
}

function renderShare() {
    const enabled = Boolean(activeShare);
    byId('transferShareEmpty').hidden = enabled;
    byId('transferShareActive').hidden = !enabled;
    byId('transferShareState').textContent = enabled ? '正在监听' : '未开启';
    byId('transferShareState').classList.toggle('is-active', enabled);
    if (!enabled) return;
    byId('transferShareName').textContent = activeShare.itemName;
    byId('transferShareUrl').value = activeShare.url;
    byId('transferShareExpiry').textContent = `${new Date(activeShare.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，成功下载后立即停止。`;
}

async function refresh() {
    try {
        [items, activeShare] = await Promise.all([
            invoke('list_transfer_items'), invoke('get_lan_share')
        ]);
        renderItems();
        renderShare();
    } catch (error) {
        setStatus(String(error), 'error');
    }
}

async function importFiles() {
    const selected = await globalThis.window?.__TAURI__?.dialog?.open({ multiple: true, directory: false, title: '添加到临时文件中转站' });
    if (!selected) return;
    const sources = Array.isArray(selected) ? selected.slice(0, 50) : [selected];
    byId('transferImport').disabled = true;
    setStatus('正在流式复制到本地中转区…');
    try {
        const result = await invoke('import_transfer_files', { request: { sources, ttlSeconds: Number(byId('transferTtl').value) } });
        setStatus(`已导入 ${result.imported.length} 个文件，共 ${formatBytes(result.totalBytes)}。`, 'success');
        await refresh();
    } catch (error) { setStatus(String(error), 'error'); }
    finally { byId('transferImport').disabled = false; }
}

async function exportItem(item) {
    const destination = await globalThis.window?.__TAURI__?.dialog?.open({ directory: true, multiple: false, title: `导出 ${item.name}` });
    if (!destination || Array.isArray(destination)) return;
    try {
        const path = await invoke('export_transfer_item', { itemId: item.id, destination });
        setStatus(`已导出到 ${path}`, 'success');
    } catch (error) { setStatus(String(error), 'error'); }
}

async function shareItem(item) {
    setStatus('正在按需启动局域网监听…');
    try {
        activeShare = await invoke('start_lan_share', { itemId: item.id, durationSeconds: 600 });
        renderShare();
        setStatus('局域网分享已开启；下载一次或 10 分钟后自动停止。', 'success');
    } catch (error) { setStatus(String(error), 'error'); }
}

function openRemoveDialog(item) {
    pendingRemoval = item;
    byId('transferPermanent').checked = false;
    byId('transferRemoveTitle').textContent = `移除“${item.name}”？`;
    updateRemovalMode();
    byId('transferRemoveDialog').showModal();
}

function updateRemovalMode() {
    const permanent = byId('transferPermanent').checked;
    byId('transferRemoveDescription').textContent = permanent
        ? '文件将被彻底删除，无法通过 DtKit 恢复。请确认这不是唯一副本。'
        : '默认会移入 DtKit 恢复区，可以立即撤销。原始来源文件不受影响。';
    byId('transferConfirmRemove').textContent = permanent ? '仍然彻底删除' : '移入恢复区';
    byId('transferConfirmRemove').className = `transfer-button ${permanent ? 'transfer-button--danger' : 'transfer-button--primary'}`;
    byId('transferRemoveIcon').classList.toggle('is-danger', permanent);
}

async function confirmRemoval(event) {
    event.preventDefault();
    const item = pendingRemoval;
    if (!item) return;
    const permanent = byId('transferPermanent').checked;
    byId('transferRemoveDialog').close();
    try {
        const result = await invoke('remove_transfer_item', { itemId: item.id, permanent });
        activeShare = activeShare?.itemId === item.id ? null : activeShare;
        if (result.recoveryBatchId) {
            lastRecoveryBatch = result.recoveryBatchId;
            byId('transferUndo').hidden = false;
        }
        setStatus(permanent ? '文件已彻底删除。' : '文件已移入恢复区。', permanent ? '' : 'success');
        await refresh();
    } catch (error) { setStatus(String(error), 'error'); }
    pendingRemoval = null;
}

async function handleItemAction(event) {
    const button = event.target.closest('[data-transfer-action]');
    if (!button) return;
    const item = items.find(candidate => candidate.id === button.closest('[data-item-id]')?.dataset.itemId);
    if (!item) return;
    const action = button.dataset.transferAction;
    if (action === 'open') {
        try { await invoke('open_transfer_item', { itemId: item.id }); }
        catch (error) { setStatus(String(error), 'error'); }
    } else if (action === 'export') await exportItem(item);
    else if (action === 'share') await shareItem(item);
    else if (action === 'remove') openRemoveDialog(item);
}

async function initTransferStationTool() {
    abortController?.abort();
    if (unlistenShare) unlistenShare();
    abortController = new AbortController();
    const { signal } = abortController;
    items = [];
    activeShare = null;
    pendingRemoval = null;
    lastRecoveryBatch = null;

    byId('transferImport')?.addEventListener('click', importFiles, { signal });
    byId('transferItems')?.addEventListener('click', handleItemAction, { signal });
    byId('transferPermanent')?.addEventListener('change', updateRemovalMode, { signal });
    byId('transferConfirmRemove')?.addEventListener('click', confirmRemoval, { signal });
    byId('transferCopyLink')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(activeShare?.url || ''); setStatus('分享链接已复制。', 'success'); }
        catch { setStatus('复制失败，请手动选择链接。', 'error'); }
    }, { signal });
    byId('transferStopShare')?.addEventListener('click', async () => {
        await invoke('stop_lan_share');
        activeShare = null;
        renderShare();
        setStatus('局域网分享已停止。');
    }, { signal });
    byId('transferRestore')?.addEventListener('click', async () => {
        if (!lastRecoveryBatch) return;
        try {
            await invoke('restore_transfer_item', { batchId: lastRecoveryBatch });
            lastRecoveryBatch = null;
            byId('transferUndo').hidden = true;
            setStatus('中转文件已恢复。', 'success');
            await refresh();
        } catch (error) { setStatus(String(error), 'error'); }
    }, { signal });
    const listen = globalThis.window?.__TAURI__?.event?.listen;
    if (listen) {
        const unlisten = await listen('lan-share-stopped', event => {
            if (activeShare?.shareId !== event.payload?.shareId) return;
            activeShare = null;
            renderShare();
            const labels = { downloaded: '文件已下载，分享自动停止。', expired: '分享已到期并停止。', stopped: '分享已停止。', failed: '分享服务异常停止。' };
            setStatus(labels[event.payload.reason] || '分享已停止。', event.payload.reason === 'failed' ? 'error' : '');
        });
        if (signal.aborted) unlisten(); else unlistenShare = unlisten;
    }
    await refresh();
}

function destroyTransferStationTool() {
    abortController?.abort();
    abortController = null;
    if (unlistenShare) unlistenShare();
    unlistenShare = null;
    items = [];
    pendingRemoval = null;
}

registerTool({
    id: 'transfer-station', name: '临时文件中转站', icon: 'ri-box-3-line',
    colorClass: 'tool-card__icon--orange', category: 'utility', status: 'ready',
    description: '本地临时保存文件，并按需通过局域网安全分享。',
    template: getTemplate, init: initTransferStationTool, destroy: destroyTransferStationTool
});

export { destroyTransferStationTool, initTransferStationTool };
