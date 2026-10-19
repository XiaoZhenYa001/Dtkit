import { registerTool } from '../toolRegistry.js';
import { mountSegmentedControl, revealContent, transitionLayout } from '../../core/toolMotion.js';
import { DEFAULT_STYLE, normalizeStyle, contrastRatio, payloadMetrics, validateQrPayload, applyQrPrefix, createQrFilename } from './core.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/qr-generator.css';

const invoke = (...args) => window.__TAURI__?.core?.invoke?.(...args);
let state = null;
let qrClassPromise;
function template() {
    return `<div class='dev-workbench qr-workspace'>
      <header class='dw-header qr-hero'><div><p class='dw-eyebrow'>QR STUDIO</p><h1 class='dw-title'>二维码</h1><p class='dw-subtitle'>让文字、链接和文件，轻松抵达另一块屏幕。</p></div><span class='dw-chip'>本地生成 · PNG / SVG</span></header>
      <div class='qr-tabs dw-segmented' role='tablist' aria-label='二维码模式'><button id='qrCreateTab' type='button' role='tab' data-qr-tab='create' aria-selected='true' aria-controls='qrCreatePanel'>生成二维码</button><button id='qrTemporaryTab' type='button' role='tab' data-qr-tab='temporary' aria-selected='false' aria-controls='qrTemporaryPanel'>临时二维码</button></div>
      <div class='qr-main'><section class='dw-card qr-panel'><div id='qrModePanels'>
        <div id='qrCreatePanel' role='tabpanel' aria-labelledby='qrCreateTab'>
          <header class='dw-card-header'><h2 class='dw-card-title'>内容与外观</h2><span class='dw-label'>实时预览</span></header><div class='dw-card-body'>
            <div class='qr-content-types dw-segmented' role='group' aria-label='内容类型'><button type='button' data-qr-prefix='' aria-pressed='true'>文本 / 链接</button><button type='button' data-qr-prefix='mailto:' aria-pressed='false'>邮件</button><button type='button' data-qr-prefix='tel:' aria-pressed='false'>电话</button></div>
            <div class='dw-field'><label class='dw-label' for='qrDataInput'>需要编码的内容</label><textarea id='qrDataInput' class='dw-control dw-mono' maxlength='4000' rows='5' spellcheck='false' placeholder='输入链接、文字或联系方式'>https://example.com</textarea><span id='qrDataCount' class='dw-label'>19 字符 · 19 字节</span></div>
            <div class='qr-style-heading'><h3 class='dw-card-title'>外观</h3><button id='qrResetStyle' class='dw-button' type='button'>恢复默认</button></div><div class='qr-style-grid'>
              <label class='dw-field'><span class='dw-label'>码点</span><select id='qrDots' class='dw-control'><option value='rounded'>圆润</option><option value='dots'>圆点</option><option value='square'>方形</option><option value='classy'>经典</option></select></label>
              <label class='dw-field'><span class='dw-label'>定位框</span><select id='qrCorners' class='dw-control'><option value='extra-rounded'>超圆角</option><option value='dot'>圆点</option><option value='square'>方形</option></select></label>
              <label class='dw-field'><span class='dw-label'>前景色</span><span class='qr-color'><input id='qrForeground' type='color' value='#1d1d1f'><code id='qrForegroundText'>#1d1d1f</code></span></label>
              <label class='dw-field'><span class='dw-label'>背景色</span><span class='qr-color'><input id='qrBackground' type='color' value='#ffffff'><code id='qrBackgroundText'>#ffffff</code></span></label>
              <label class='dw-field qr-size'><span class='dw-label'>导出尺寸 <output id='qrSizeValue'>320 px</output></span><input id='qrSize' type='range' min='180' max='720' step='20' value='320'></label>
              <div class='dw-field qr-logo'><label class='dw-label' for='qrLogo'>中心图标 <span id='qrLogoState'>未添加</span></label><input id='qrLogo' type='file' accept='image/png,image/jpeg,image/webp' hidden><button id='qrChooseLogo' type='button' class='dw-button qr-logo-choose'>选择图标</button><div class='dw-inline'><span class='dw-status'>PNG、JPEG、WebP · 最大 5 MiB</span><button id='qrClearLogo' type='button' class='dw-button'>清除图标</button></div></div>
            </div></div></div>
        <div id='qrTemporaryPanel' role='tabpanel' aria-labelledby='qrTemporaryTab' hidden><header class='dw-card-header'><h2 class='dw-card-title'>临时文件分享</h2><span class='dw-chip'>同一局域网</span></header><div class='dw-card-body'>
          <div class='qr-temp-intro'><strong>用手机扫码，下载电脑上的文件。</strong><p class='dw-status'>文件复制到本地中转站后开始分享，下载一次或 10 分钟后自动停止。</p></div><button id='qrChooseFile' type='button' class='dw-button dw-button--primary qr-file-button'>选择一个文件</button>
          <div id='qrShareCard' class='qr-share-card' hidden><span class='dw-chip'>分享进行中</span><strong id='qrShareName'></strong><input id='qrShareUrl' class='dw-control dw-mono' readonly aria-label='临时下载链接'><p id='qrShareExpiry' class='dw-status'></p><button id='qrStopShare' type='button' class='dw-button'>停止分享</button></div><div id='qrShareEmpty' class='dw-empty qr-share-empty'>选择文件后生成临时下载二维码。</div><p class='dw-status'>关闭工具后，已开始的分享继续有效，直到下载完成或到期。原文件保留在原处。</p>
        </div></div></div></section>
        <aside class='dw-card qr-preview'><header class='dw-card-header'><h2 id='qrPreviewMode' class='dw-card-title'>实时预览</h2><span id='qrPreviewState' class='dw-chip'>准备中</span></header><div class='dw-card-body'>
          <div class='qr-preview-stage'><div id='qrCodePreview' class='qr-canvas' data-state='loading' aria-label='二维码预览' hidden></div><div id='qrPreviewEmpty' class='qr-preview-empty'><i class='ri-qr-code-line' aria-hidden='true'></i><strong id='qrEmptyTitle'>正在准备预览</strong><span id='qrEmptyHint'>生成完成后即可保存。</span></div></div>
          <div class='qr-preview-meta'><span id='qrContrastBadge'></span><span id='qrPayloadMeta'></span></div><div class='qr-actions dw-actions'><button type='button' data-qr-download='png' class='dw-button dw-button--primary' disabled>保存 PNG</button><button type='button' data-qr-download='svg' class='dw-button' disabled>保存 SVG</button><button type='button' id='qrCopyContent' class='dw-button' disabled>复制内容</button></div>
          <div id='qrDirectoryOptions' class='qr-directory'><span class='dw-label'>保存位置</span><span id='qrSaveDirectory' class='dw-status'>默认下载目录</span><div class='dw-actions'><button id='qrChooseDirectory' type='button' class='dw-button'>选择文件夹</button><button id='qrDefaultDirectory' type='button' class='dw-button'>恢复默认</button></div></div><p id='qrStatus' class='dw-status' role='status' aria-live='polite'>二维码在本机生成。</p>
        </div></aside></div><footer class='dw-footer'><p class='dw-status'>较短的内容和清晰的颜色，更便于扫码。分享前可先用手机试扫。</p><span class='dw-status'>外观与输入自动保留为页面草稿</span></footer>
    </div>`;
}
const node = (view, id) => view.root.querySelector('#' + id);
const active = view => state === view && !view.controller.signal.aborted && view.root.isConnected;
const native = () => typeof window.__TAURI__?.core?.invoke === 'function';
const payload = view => view.tab === 'create' ? view.createData : view.share?.url || '';
const current = (view, generation) => active(view) && view.qrGeneration === generation && !view.suspended;
function setStatus(view, message, type = '') { const target = node(view, 'qrStatus'); target.textContent = message; target.dataset.type = type; }
function updateActions(view) {
    const ready = view.phase === 'ready' && !!view.qr && !view.logoBusy && !view.exporting && !view.directoryBusy;
    view.root.querySelectorAll('[data-qr-download],#qrCopyContent').forEach(button => { button.disabled = !ready; });
    node(view, 'qrChooseDirectory').disabled = view.directoryBusy || view.exporting;
    node(view, 'qrDefaultDirectory').disabled = view.directoryBusy || view.exporting || !view.directory;
    node(view, 'qrCodePreview').setAttribute('aria-busy', String(view.phase === 'loading' || view.logoBusy));
}
function setPhase(view, phase) {
    view.phase = phase; const preview = node(view, 'qrCodePreview'); preview.dataset.state = phase;
    const visible = ['ready', 'loading'].includes(phase) && preview.childElementCount > 0;
    preview.hidden = !visible; node(view, 'qrPreviewEmpty').hidden = visible;
    node(view, 'qrPreviewState').textContent = { ready: '已就绪', loading: '更新中', empty: '等待内容', error: '需要调整' }[phase];
    node(view, 'qrEmptyTitle').textContent = phase === 'loading' ? '正在生成二维码' : phase === 'error' ? '内容暂时无法生成' : view.tab === 'temporary' ? '等待创建临时二维码' : '等待输入内容';
    node(view, 'qrEmptyHint').textContent = phase === 'error' ? '请精简内容，或调整图标后重试。' : view.tab === 'temporary' ? '选择文件后才会开始局域网分享。' : '输入文字、链接或联系方式即可预览。'; updateActions(view);
}
function updateInsights(view) {
    const metrics = payloadMetrics(view.createData); node(view, 'qrDataCount').textContent = `${metrics.characters} 字符 · ${metrics.bytes} 字节`;
    const encoded = payloadMetrics(payload(view)); node(view, 'qrPayloadMeta').textContent = `${encoded.characters} 字符 · ${encoded.bytes} 字节`;
    const ratio = contrastRatio(view.style.foreground, view.style.background), badge = node(view, 'qrContrastBadge');
    badge.textContent = ratio >= 3 ? `对比度 ${ratio.toFixed(1)} : 1` : `建议提高对比度 · ${ratio.toFixed(1)} : 1`; badge.classList.toggle('is-warning', ratio < 3);
}
function updateForm(view) {
    view.root.querySelectorAll('[data-qr-tab]').forEach(button => { const selected = button.dataset.qrTab === view.tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    const prefix = /^(mailto:|tel:)/i.exec(view.createData)?.[0].toLowerCase() || '';
    view.root.querySelectorAll('[data-qr-prefix]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.qrPrefix === prefix)));
    node(view, 'qrCreatePanel').hidden = view.tab !== 'create'; node(view, 'qrTemporaryPanel').hidden = view.tab !== 'temporary'; node(view, 'qrPreviewMode').textContent = view.tab === 'create' ? '实时预览' : '临时下载码';
    for (const [id, key] of [['qrDots', 'dots'], ['qrCorners', 'corners'], ['qrForeground', 'foreground'], ['qrBackground', 'background'], ['qrSize', 'size']]) node(view, id).value = String(view.style[key]);
    node(view, 'qrForegroundText').textContent = view.style.foreground; node(view, 'qrBackgroundText').textContent = view.style.background; node(view, 'qrSizeValue').value = `${view.style.size} px`;
    node(view, 'qrLogoState').textContent = view.image ? '已添加' : '未添加'; node(view, 'qrClearLogo').disabled = !view.image && !view.logoBusy;
    node(view, 'qrDirectoryOptions').hidden = !native(); node(view, 'qrSaveDirectory').textContent = view.directory || (native() ? '默认下载目录' : '浏览器下载目录'); updateInsights(view); updateActions(view);
}
async function ensureQrClass() {
    qrClassPromise ||= import('qr-code-styling').then(module => module.default).catch(error => { qrClassPromise = null; throw error; }); return qrClassPromise;
}
async function renderQr(view, generation) {
    view.timer = null;
    try {
        const text = validateQrPayload(payload(view)), QrClass = await ensureQrClass(); if (!current(view, generation)) return;
        const style = view.style;
        const margin = Math.round(style.size * .14);
        const candidate = new QrClass({ width: style.size, height: style.size, type: 'svg', data: text, margin, qrOptions: { errorCorrectionLevel: view.image ? 'H' : 'M' },
            dotsOptions: { type: style.dots, color: style.foreground, roundSize: false }, cornersSquareOptions: { type: style.corners, color: style.foreground }, cornersDotOptions: { type: 'dot', color: style.foreground }, backgroundOptions: { color: style.background },
            image: view.image || undefined, imageOptions: { margin: 4, imageSize: .24, crossOrigin: 'anonymous', hideBackgroundDots: true, saveAsBlob: false } });
        // Check the encoded matrix, rather than estimating capacity from text length.
        // Fractional SVG dots also prevent zero-size paths if the renderer changes.
        const modules = candidate._qr?.getModuleCount?.();
        if (Number.isFinite(modules) && style.size - margin * 2 < modules) throw new Error('当前尺寸不足以清晰绘制这些内容，请增大导出尺寸或缩短内容。');
        const vector = await candidate.getRawData('svg'); if (!current(view, generation)) return; if (!vector?.size) throw new Error('二维码绘制未完成，请重试。');
        const container = node(view, 'qrCodePreview'); container.replaceChildren(); candidate.append(container); view.qr = candidate; view.pending = false; setPhase(view, 'ready');
        node(view, 'qrDataInput').removeAttribute('aria-invalid'); setStatus(view, '二维码已就绪，可保存 PNG 或 SVG。', 'success'); revealContent(container, { signal: view.controller.signal, distance: 3 });
    } catch (error) {
        if (!current(view, generation)) return;
        view.qr = null; view.pending = false; node(view, 'qrCodePreview').replaceChildren(); setPhase(view, 'error'); if (view.tab === 'create') node(view, 'qrDataInput').setAttribute('aria-invalid', 'true');
        const message = String(error?.message || error); setStatus(view, /overflow|too long|code length/i.test(message) ? '内容超出二维码容量，请缩短内容，或移除中心图标后重试。' : message, 'error');
    }
}
function scheduleQr(view, immediate = false) {
    clearTimeout(view.timer); view.timer = null; view.qrGeneration += 1; view.qr = null; view.pending = false; view.exportJob = null; view.exporting = false;
    updateInsights(view); node(view, 'qrDataInput').removeAttribute('aria-invalid');
    if (!payload(view).trim()) { node(view, 'qrCodePreview').replaceChildren(); setPhase(view, 'empty'); setStatus(view, view.tab === 'temporary' ? '选择文件后生成临时下载码。' : '请输入需要生成二维码的内容。'); return; }
    view.pending = true; setPhase(view, 'loading'); setStatus(view, '正在生成最新预览…'); const generation = view.qrGeneration;
    if (!view.suspended) view.timer = setTimeout(() => { void renderQr(view, generation); }, immediate ? 0 : 110);
}
function renderShare(view) {
    const share = view.share; node(view, 'qrShareCard').hidden = !share; node(view, 'qrShareEmpty').hidden = !!share;
    if (share) { node(view, 'qrShareName').textContent = share.itemName; node(view, 'qrShareUrl').value = share.url; node(view, 'qrShareExpiry').textContent = `${new Date(share.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，成功下载后自动停止。`; }
    if (view.tab === 'temporary') scheduleQr(view, true);
}
async function refreshShare(view) {
    if (view.shareBusy) return;
    const revision = view.shareRevision, query = ++view.shareQuery;
    try { const share = native() ? await invoke('get_lan_share') : null;
        if (!active(view) || revision !== view.shareRevision || query !== view.shareQuery) return;
        view.share = share?.shareId && typeof share.url === 'string' && share.expiresAt > Date.now() ? share : null; renderShare(view);
    } catch { if (active(view) && revision === view.shareRevision && query === view.shareQuery) { view.share = null; renderShare(view); } }
}
async function chooseTemporaryFile(view) {
    if (view.shareBusy) return;
    if (!native() || !window.__TAURI__?.dialog?.open) { setStatus(view, '临时文件分享请在桌面应用中使用。', 'error'); return; }
    if (view.share && !confirm('创建新分享将替换当前临时链接，是否继续？')) return;
    const revision = ++view.shareRevision; view.shareBusy = true; node(view, 'qrChooseFile').disabled = true;
    try {
        const selected = await window.__TAURI__.dialog.open({ multiple: false, directory: false, title: '选择需要临时分享的文件' });
        if (!active(view) || revision !== view.shareRevision || typeof selected !== 'string' || !selected) return;
        setStatus(view, '正在复制文件到本地中转站…'); const imported = await invoke('import_transfer_files', { request: { sources: [selected], ttlSeconds: 3600 } });
        if (!active(view) || revision !== view.shareRevision) return; const item = imported?.imported?.[0]; if (!item?.id) throw new Error('文件未能导入中转站，请重试。');
        const share = await invoke('start_lan_share', { itemId: item.id, durationSeconds: 600 }); if (!active(view) || revision !== view.shareRevision) return;
        if (!share?.shareId || !share.url) throw new Error('临时分享未能启动，请重试。'); view.shareQuery++; view.share = share; renderShare(view); setStatus(view, '临时分享已开始，下载一次或到期后停止。', 'success');
    } catch (error) { if (active(view) && revision === view.shareRevision) setStatus(view, `创建分享失败：${error?.message || error}`, 'error'); }
    finally { if (active(view) && revision === view.shareRevision) { view.shareBusy = false; node(view, 'qrChooseFile').disabled = false; } }
}
async function stopShare(view) {
    if (view.shareBusy) return; const revision = ++view.shareRevision; view.shareBusy = true; node(view, 'qrStopShare').disabled = true;
    try { await invoke('stop_lan_share'); if (active(view) && revision === view.shareRevision) { view.shareQuery++; view.share = null; renderShare(view); setStatus(view, '临时分享已停止。'); } }
    catch (error) { if (active(view) && revision === view.shareRevision) setStatus(view, `停止分享失败：${error?.message || error}`, 'error'); }
    finally { if (active(view) && revision === view.shareRevision) { view.shareBusy = false; node(view, 'qrStopShare').disabled = false; } }
}
async function listenShare(view) {
    const listen = window.__TAURI__?.event?.listen; if (!listen) return;
    try { const unlisten = await listen('lan-share-stopped', event => {
        if (!active(view) || event.payload?.shareId !== view.share?.shareId) return;
        view.shareQuery++; view.share = null; renderShare(view); setStatus(view, '临时分享已自动停止。');
    }); if (active(view)) view.unlisten = unlisten; else unlisten(); }
    catch { /* Share state is refreshed when the page resumes. */ }
}
async function chooseDirectory(view) {
    if (view.directoryBusy || view.exporting) return;
    const token = ++view.directoryGeneration; view.directoryBusy = true; updateActions(view);
    try { const layout = await invoke('get_storage_layout'); if (!active(view) || token !== view.directoryGeneration) return;
        const selected = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: '选择二维码保存文件夹', defaultPath: view.directory || layout?.downloads });
        if (!active(view) || token !== view.directoryGeneration || typeof selected !== 'string' || !selected) return;
        view.directory = selected; updateForm(view); setStatus(view, '保存文件夹已更新。');
    } catch (error) { if (active(view) && token === view.directoryGeneration) setStatus(view, `无法选择文件夹：${error?.message || error}`, 'error'); }
    finally { if (active(view) && token === view.directoryGeneration) { view.directoryBusy = false; updateActions(view); } }
}
async function download(view, format) {
    if (view.phase !== 'ready' || !view.qr || view.exporting || view.logoBusy || view.directoryBusy) return;
    const generation = view.qrGeneration, candidate = view.qr, job = {}; view.exportJob = job; view.exporting = true; updateActions(view);
    const exportCurrent = () => current(view, generation) && view.exportJob === job;
    try { const blob = await candidate.getRawData(format); if (!exportCurrent()) return; if (!blob?.size) throw new Error('导出内容为空，请重新生成。'); const filename = createQrFilename(format);
        if (native()) {
            const buffer = await blob.arrayBuffer(); if (!exportCurrent()) return;
            const layout = view.directory ? null : await invoke('get_storage_layout'); if (!exportCurrent()) return;
            const directory = view.directory || layout?.downloads; if (typeof directory !== 'string' || !directory) throw new Error('无法读取下载目录，请先选择保存文件夹。');
            const path = await invoke('write_qr_code', { directory, filename, data: Array.from(new Uint8Array(buffer)) }); if (!exportCurrent()) return;
            if (typeof path !== 'string' || !path) throw new Error('保存未返回有效路径，请重试。'); setStatus(view, `已保存到 ${path}`, 'success');
        } else {
            const url = URL.createObjectURL(blob); view.urls.add(url); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
            const timer = setTimeout(() => { URL.revokeObjectURL(url); view.urls.delete(url); view.urlTimers.delete(timer); }, 1000); view.urlTimers.add(timer); setStatus(view, '已交给浏览器下载。', 'success');
        }
    } catch (error) { if (exportCurrent()) setStatus(view, `保存失败：${error?.message || error}`, 'error'); }
    finally { if (active(view) && view.exportJob === job) { view.exportJob = null; view.exporting = false; updateActions(view); } }
}
async function copyContent(view) {
    if (view.phase !== 'ready') return; const generation = view.qrGeneration;
    try { await navigator.clipboard.writeText(payload(view)); if (current(view, generation)) setStatus(view, '二维码内容已复制。', 'success'); }
    catch { if (current(view, generation)) setStatus(view, '复制失败，请手动选择内容复制。', 'error'); }
}
function clearLogo(view) {
    view.logoGeneration++; view.reader?.abort(); view.reader = null; view.logoBusy = false; view.image = null; node(view, 'qrLogo').value = ''; updateForm(view); scheduleQr(view);
}
async function loadLogo(view, file) {
    if (!file) return;
    const generation = ++view.logoGeneration; view.reader?.abort(); view.reader = null; view.logoBusy = false; updateForm(view);
    if (file.size > 5 * 1024 * 1024 || (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { node(view, 'qrLogo').value = ''; setStatus(view, '请选择 5 MiB 以内的 PNG、JPEG 或 WebP 图标。', 'error'); return; }
    view.logoBusy = true; updateForm(view);
    try {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); view.reader = reader; reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图标读取失败。')); reader.onabort = () => reject(new DOMException('已取消', 'AbortError')); reader.readAsDataURL(file); });
        if (!active(view) || generation !== view.logoGeneration) return; const image = new Image(); image.src = data; await image.decode(); if (!active(view) || generation !== view.logoGeneration) return;
        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight)), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        view.image = canvas.toDataURL('image/png'); updateForm(view); scheduleQr(view);
    } catch (error) { if (active(view) && generation === view.logoGeneration && error?.name !== 'AbortError') { node(view, 'qrLogo').value = ''; setStatus(view, '图标无法读取，请选择有效的图片。', 'error'); } }
    finally { if (active(view) && generation === view.logoGeneration) { view.reader = null; view.logoBusy = false; updateForm(view); } }
}
function init() {
    destroy(); const root = document.querySelector('.qr-workspace'); if (!root) return;
    const view = { root, controller: new AbortController(), tab: 'create', createData: 'https://example.com', style: { ...DEFAULT_STYLE }, image: null, qr: null, qrGeneration: 0, phase: 'loading', timer: null, pending: false, exporting: false, exportJob: null, directory: '', directoryBusy: false, directoryGeneration: 0, logoGeneration: 0, logoBusy: false, reader: null, share: null, shareRevision: 0, shareQuery: 0, shareBusy: false, unlisten: null, urls: new Set(), urlTimers: new Set(), suspended: document.documentElement.classList.contains('app-is-suspended') };
    state = view; const { signal } = view.controller; const on = (target, name, handler) => target.addEventListener(name, handler, { signal });
    root.querySelectorAll('[data-qr-tab]').forEach(button => on(button, 'click', () => { if (view.tab === button.dataset.qrTab) return; view.tab = button.dataset.qrTab; transitionLayout(node(view, 'qrModePanels'), () => updateForm(view), { signal }); scheduleQr(view, true); revealContent(node(view, view.tab === 'create' ? 'qrCreatePanel' : 'qrTemporaryPanel'), { signal }); }));
    root.querySelectorAll('[data-qr-prefix]').forEach(button => on(button, 'click', () => { view.createData = applyQrPrefix(node(view, 'qrDataInput').value, button.dataset.qrPrefix); node(view, 'qrDataInput').value = view.createData; updateForm(view); scheduleQr(view); node(view, 'qrDataInput').focus({ preventScroll: true }); }));
    on(node(view, 'qrDataInput'), 'input', event => { view.createData = event.target.value; updateForm(view); scheduleQr(view); });
    for (const [id, key, event] of [['qrDots', 'dots', 'change'], ['qrCorners', 'corners', 'change'], ['qrForeground', 'foreground', 'input'], ['qrBackground', 'background', 'input'], ['qrSize', 'size', 'input']]) on(node(view, id), event, change => { view.style = normalizeStyle({ ...view.style, [key]: key === 'size' ? Number(change.target.value) : change.target.value }); updateForm(view); scheduleQr(view); });
    on(node(view, 'qrChooseLogo'), 'click', () => node(view, 'qrLogo').click()); on(node(view, 'qrLogo'), 'change', event => { void loadLogo(view, event.target.files?.[0]); }); on(node(view, 'qrClearLogo'), 'click', () => clearLogo(view)); on(node(view, 'qrResetStyle'), 'click', () => { view.style = { ...DEFAULT_STYLE }; clearLogo(view); });
    on(node(view, 'qrChooseFile'), 'click', () => { void chooseTemporaryFile(view); }); on(node(view, 'qrStopShare'), 'click', () => { void stopShare(view); }); on(node(view, 'qrChooseDirectory'), 'click', () => { void chooseDirectory(view); });
    on(node(view, 'qrDefaultDirectory'), 'click', () => { view.directory = ''; updateForm(view); setStatus(view, '已恢复默认下载目录。'); }); root.querySelectorAll('[data-qr-download]').forEach(button => on(button, 'click', () => { void download(view, button.dataset.qrDownload); })); on(node(view, 'qrCopyContent'), 'click', () => { void copyContent(view); });
    on(window, 'dtkit:power-state', event => { view.suspended = event.detail?.suspended === true; if (view.suspended) { clearTimeout(view.timer); view.timer = null; if (view.pending) view.qrGeneration += 1; view.exportJob = null; view.exporting = false; updateActions(view); } else { if (view.pending) scheduleQr(view, true); void refreshShare(view); } });
    root.querySelectorAll('.dw-segmented').forEach(group => mountSegmentedControl(group, { signal })); updateForm(view); renderShare(view); scheduleQr(view, true); void refreshShare(view); void listenShare(view); revealContent(root, { signal });
}
function serialize() {
    if (!state) return null; const view = state, input = node(view, 'qrDataInput'); return { version: 1, createData: view.createData, style: { ...view.style }, image: view.image, tab: view.tab, directory: view.directory, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, selectionDirection: input.selectionDirection, scrollTop: input.scrollTop, scrollLeft: input.scrollLeft, focusedField: document.hasFocus() ? document.activeElement?.id : null };
}
function restore(snapshot) {
    if (!state || snapshot?.version !== 1) return; const view = state;
    view.logoGeneration++; view.reader?.abort(); view.reader = null; view.logoBusy = false; view.directoryGeneration++; view.directoryBusy = false; view.shareRevision++; view.shareBusy = false; node(view, 'qrChooseFile').disabled = false; node(view, 'qrStopShare').disabled = false;
    view.createData = typeof snapshot.createData === 'string' ? snapshot.createData.slice(0, 4000) : 'https://example.com'; view.style = normalizeStyle(snapshot.style && typeof snapshot.style === 'object' ? snapshot.style : {});
    view.image = typeof snapshot.image === 'string' && snapshot.image.length < 600000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(snapshot.image) ? snapshot.image : null;
    view.tab = snapshot.tab === 'temporary' ? 'temporary' : 'create'; view.directory = typeof snapshot.directory === 'string' ? snapshot.directory.slice(0, 4096) : ''; const input = node(view, 'qrDataInput'); input.value = view.createData; node(view, 'qrLogo').value = '';
    updateForm(view); renderShare(view); scheduleQr(view, true); void refreshShare(view); if (Number.isInteger(snapshot.selectionStart) && Number.isInteger(snapshot.selectionEnd)) input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection); input.scrollTop = Number(snapshot.scrollTop) || 0; input.scrollLeft = Number(snapshot.scrollLeft) || 0;
    if (snapshot.focusedField === 'qrDataInput' && document.hasFocus() && !view.suspended) input.focus({ preventScroll: true });
}
function destroy() {
    if (!state) return; const view = state; state = null; view.controller.abort(); view.qrGeneration += 1; view.logoGeneration++; view.reader?.abort(); clearTimeout(view.timer); view.unlisten?.(); for (const timer of view.urlTimers) clearTimeout(timer); for (const url of view.urls) URL.revokeObjectURL(url); view.urls.clear(); view.urlTimers.clear(); view.qr = null;
}
registerTool({ id: 'qr-generator', name: '二维码生成', icon: 'ri-qr-code-line', colorClass: 'tool-card__icon--cyan', category: 'dev', status: 'ready', description: '在本机生成 PNG / SVG 二维码，或创建临时局域网下载码。', template, init, destroy, serialize, restore });
