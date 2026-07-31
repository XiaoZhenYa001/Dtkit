import '../../css/tools/qr-generator.css';
import { registerTool } from '../toolRegistry.js';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
const byId = id => document.getElementById(id);
let controller;
let qr;
let QrClass;
let activeShare;
let unlisten;
let renderTimer;
let activeTab = 'create';
let lifecycle = 0;
let qrGeneration = 0;
const DEFAULT_STYLE = Object.freeze({
    size: 320,
    dots: 'rounded',
    foreground: '#202938',
    background: '#ffffff',
    corners: 'extra-rounded'
});
const state = {
    data: 'https://example.com',
    ...DEFAULT_STYLE,
    image: null
};

function template() {
    return `<div class="qr-workspace">
      <header class="qr-hero">
        <div class="qr-hero__icon"><i class="ri-qr-code-line"></i></div>
        <div><span class="qr-kicker">QR STUDIO</span><h2>二维码</h2>
          <p>生成精致二维码，或将中转站文件临时分享给同一局域网设备。</p></div>
        <div class="qr-security"><i class="ri-shield-check-line"></i><span>临时分享一次下载后停止<br>不经过云端</span></div>
      </header>
      <div class="qr-tabs" role="tablist" aria-label="二维码模式">
        <button id="qrCreateTab" class="is-active" data-qr-tab="create" role="tab" aria-selected="true" aria-controls="qrCreatePanel"><i class="ri-qr-code-line"></i> 生成二维码</button>
        <button id="qrTemporaryTab" data-qr-tab="temporary" role="tab" aria-selected="false" aria-controls="qrTemporaryPanel"><i class="ri-wifi-line"></i> 临时二维码</button>
      </div>
      <div class="qr-main">
        <section class="qr-panel">
          <div id="qrCreatePanel" role="tabpanel" aria-labelledby="qrCreateTab">
            <div class="qr-section-head"><span>01</span><div><strong>内容</strong><small>输入链接、文字或联系方式</small></div></div>
            <div class="qr-content-types">
              <button class="is-active" data-qr-prefix="" aria-pressed="true"><i class="ri-text"></i> 文本 / 链接</button>
              <button data-qr-prefix="mailto:" aria-pressed="false"><i class="ri-mail-line"></i> 邮件</button>
              <button data-qr-prefix="tel:" aria-pressed="false"><i class="ri-phone-line"></i> 电话</button>
            </div>
            <div class="qr-textarea-wrap"><textarea id="qrDataInput" maxlength="4000" rows="5" placeholder="输入需要编码的内容">https://example.com</textarea><span id="qrDataCount">19 / 4000</span></div>
            <div class="qr-section-head"><span>02</span><div><strong>外观</strong><small>调整码点、颜色和尺寸</small></div><button id="qrResetStyle" class="qr-reset-style" type="button"><i class="ri-refresh-line"></i> 恢复默认</button></div>
            <div class="qr-style-grid">
              <label>码点<select id="qrDots"><option value="rounded">圆润</option><option value="dots">圆点</option><option value="square">方形</option><option value="classy">经典</option></select></label>
              <label>定位框<select id="qrCorners"><option value="extra-rounded">超圆角</option><option value="dot">圆点</option><option value="square">方形</option></select></label>
              <label>前景色<span class="qr-color"><input id="qrForeground" type="color" value="#202938"><code id="qrForegroundText">#202938</code></span></label>
              <label>背景色<span class="qr-color"><input id="qrBackground" type="color" value="#ffffff"><code id="qrBackgroundText">#ffffff</code></span></label>
              <label class="qr-size">尺寸<input id="qrSize" type="range" min="180" max="720" step="20" value="320"><output id="qrSizeValue">320 px</output></label>
              <label class="qr-logo">中心图标<span><input id="qrLogo" type="file" accept="image/png,image/jpeg,image/webp"><button id="qrClearLogo" type="button">清除</button></span></label>
            </div>
          </div>
          <div id="qrTemporaryPanel" role="tabpanel" aria-labelledby="qrTemporaryTab" hidden>
            <div class="qr-temp-intro"><i class="ri-router-line"></i><div><strong>手机与电脑处于同一局域网即可下载</strong><p>文件先复制到本地中转站；监听仅在创建后启动，下载一次或 10 分钟后自动停止。</p></div></div>
            <button id="qrChooseFile" class="qr-file-button"><i class="ri-file-add-line"></i><span><strong>选择一个文件</strong><small>原文件不会被移动或删除</small></span><i class="ri-arrow-right-s-line"></i></button>
            <div id="qrShareCard" class="qr-share-card" hidden>
              <div><span class="qr-live-dot"></span><small>临时二维码正在监听</small></div>
              <strong id="qrShareName"></strong>
              <input id="qrShareUrl" readonly>
              <p id="qrShareExpiry"></p>
              <button id="qrStopShare" type="button"><i class="ri-stop-circle-line"></i> 立即停止分享</button>
            </div>
            <div id="qrShareEmpty" class="qr-share-empty"><i class="ri-qr-scan-2-line"></i><span>选择文件后，这里会生成临时下载二维码。</span></div>
          </div>
        </section>
        <aside class="qr-preview">
          <div class="qr-preview__top"><span id="qrPreviewMode">实时预览</span><span class="qr-ready"><i></i> 本地生成</span></div>
          <div id="qrCodePreview" class="qr-canvas"></div>
          <div id="qrPreviewEmpty" class="qr-preview-empty" hidden><i class="ri-qr-scan-2-line"></i><strong>等待创建临时二维码</strong><span>选择文件后才会启动局域网监听并生成下载码。</span></div>
          <div class="qr-preview-meta"><span id="qrContrastBadge"><i class="ri-contrast-2-line"></i> 对比度良好</span><span id="qrPayloadMeta">19 个字符</span></div>
          <div class="qr-actions">
            <button data-qr-download="png" class="qr-primary"><i class="ri-download-2-line"></i> 保存 PNG</button>
            <button data-qr-download="svg"><i class="ri-code-s-slash-line"></i> SVG</button>
            <button id="qrCopyContent"><i class="ri-file-copy-line"></i> 复制内容</button>
          </div>
          <p id="qrStatus" role="status">二维码仅在当前页面本地生成。</p>
        </aside>
      </div>
    </div>`;
}

function setStatus(message, type = '') {
    const status = byId('qrStatus');
    if (status) { status.textContent = message; status.dataset.type = type; }
}

function relativeLuminance(hex) {
    const channels = hex.match(/[0-9a-f]{2}/gi)?.map(value => {
        const channel = Number.parseInt(value, 16) / 255;
        return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }) || [0, 0, 0];
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function updateQrInsights() {
    const length = state.data.trim().length;
    const count = byId('qrDataCount');
    const payload = byId('qrPayloadMeta');
    if (count) count.textContent = `${length} / 4000`;
    if (payload) payload.textContent = activeTab === 'temporary' ? '局域网临时链接' : `${length} 个字符`;
    const foreground = relativeLuminance(state.foreground);
    const background = relativeLuminance(state.background);
    const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    const badge = byId('qrContrastBadge');
    if (activeTab === 'temporary' && !activeShare) {
        if (payload) payload.textContent = '尚未创建链接';
        if (badge) {
            badge.className = 'is-idle';
            badge.innerHTML = '<i class="ri-pause-circle-line"></i> 监听未启动';
        }
        return;
    }
    if (badge) {
        const safe = ratio >= 3;
        badge.className = safe ? '' : 'is-warning';
        badge.innerHTML = `<i class="${safe ? 'ri-shield-check-line' : 'ri-error-warning-line'}"></i> ${safe ? '对比度良好' : '建议提高对比度'}`;
    }
}

async function ensureQr() {
    QrClass ||= (await import('qr-code-styling')).default;
}

async function renderQr() {
    clearTimeout(renderTimer);
    const current = ++qrGeneration;
    await ensureQr();
    if (current !== qrGeneration || !controller) return;
    const container = byId('qrCodePreview');
    if (!container) return;
    const options = {
        width: state.size, height: state.size, type: 'canvas', data: state.data || ' ',
        margin: 8, qrOptions: { errorCorrectionLevel: state.image ? 'H' : 'M' },
        dotsOptions: { type: state.dots, color: state.foreground },
        cornersSquareOptions: { type: state.corners, color: state.foreground },
        cornersDotOptions: { type: 'dot', color: state.foreground },
        backgroundOptions: { color: state.background },
        imageOptions: { margin: 5, imageSize: .3, crossOrigin: 'anonymous' }
    };
    if (state.image) options.image = state.image;
    container.replaceChildren();
    qr = new QrClass(options);
    qr.append(container);
}

function scheduleQr() {
    clearTimeout(renderTimer);
    updateQrInsights();
    if (activeTab === 'temporary' && !activeShare) {
        qrGeneration += 1;
        qr = null;
        byId('qrCodePreview')?.replaceChildren();
        return;
    }
    renderTimer = setTimeout(() => renderQr().catch(error => setStatus(String(error), 'error')), 90);
}

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('[data-qr-tab]').forEach(button => {
        const selected = button.dataset.qrTab === tab;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    byId('qrCreatePanel').hidden = tab !== 'create';
    byId('qrTemporaryPanel').hidden = tab !== 'temporary';
    byId('qrPreviewMode').textContent = tab === 'temporary' ? '临时下载码' : '实时预览';
    state.data = tab === 'create' ? byId('qrDataInput').value || ' ' : activeShare?.url || ' ';
    updatePreviewActions();
    updateQrInsights();
    scheduleQr();
}

function resetStyle() {
    Object.assign(state, DEFAULT_STYLE, { image: null });
    byId('qrDots').value = state.dots;
    byId('qrCorners').value = state.corners;
    byId('qrForeground').value = state.foreground;
    byId('qrBackground').value = state.background;
    byId('qrForegroundText').textContent = state.foreground;
    byId('qrBackgroundText').textContent = state.background;
    byId('qrSize').value = String(state.size);
    byId('qrSizeValue').value = `${state.size} px`;
    byId('qrLogo').value = '';
    setStatus('外观已恢复默认值。');
    scheduleQr();
}

function updatePreviewActions() {
    const unavailable = activeTab === 'temporary' && !activeShare;
    const preview = byId('qrCodePreview');
    const empty = byId('qrPreviewEmpty');
    if (preview) preview.hidden = unavailable;
    if (empty) empty.hidden = !unavailable;
    document.querySelectorAll('[data-qr-download], #qrCopyContent').forEach(button => {
        button.disabled = unavailable;
    });
}

function renderShare() {
    const enabled = Boolean(activeShare);
    byId('qrShareCard').hidden = !enabled;
    byId('qrShareEmpty').hidden = enabled;
    updatePreviewActions();
    if (!enabled) {
        if (activeTab === 'temporary') {
            state.data = ' ';
            scheduleQr();
        }
        return;
    }
    byId('qrShareName').textContent = activeShare.itemName;
    byId('qrShareUrl').value = activeShare.url;
    byId('qrShareExpiry').textContent = `${new Date(activeShare.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效；成功下载后立即停止。`;
    if (activeTab === 'temporary') {
        state.data = activeShare.url;
        scheduleQr();
    }
}

async function chooseTemporaryFile() {
    if (activeShare && !confirm('创建新的临时二维码会替换当前局域网分享，是否继续？')) return;
    const selected = await globalThis.window?.__TAURI__?.dialog?.open({
        multiple: false, directory: false, title: '选择需要临时分享的文件'
    });
    if (!selected || Array.isArray(selected)) return;
    byId('qrChooseFile').disabled = true;
    setStatus('正在复制到本地中转区…');
    try {
        const imported = await invoke('import_transfer_files', {
            request: { sources: [selected], ttlSeconds: 3600 }
        });
        const item = imported.imported[0];
        activeShare = await invoke('start_lan_share', { itemId: item.id, durationSeconds: 600 });
        renderShare();
        setStatus('临时二维码已生成；不会上传到云端。', 'success');
    } catch (error) { setStatus(String(error), 'error'); }
    finally { byId('qrChooseFile').disabled = false; }
}

async function stopShare() {
    const button = byId('qrStopShare');
    if (button) button.disabled = true;
    try {
        await invoke('stop_lan_share');
        activeShare = null;
        renderShare();
        setStatus('局域网分享已停止。');
    } catch (error) {
        setStatus(`停止分享失败：${error}`, 'error');
    } finally {
        if (button?.isConnected) button.disabled = false;
    }
}

async function download(format) {
    if (!qr) return;
    try {
        const blob = await qr.getRawData(format);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const path = await invoke('write_qr_code', {
            request: {
                filename: `qrcode-${Date.now()}.${format}`,
                dataBase64: btoa(binary)
            }
        });
        setStatus(`已保存到 ${path}`, 'success');
    } catch (error) { setStatus(String(error), 'error'); }
}

async function init() {
    controller?.abort(); controller = new AbortController();
    const currentLifecycle = ++lifecycle;
    const { signal } = controller;
    document.querySelectorAll('[data-qr-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.qrTab), { signal }));
    document.querySelectorAll('[data-qr-prefix]').forEach(button => button.addEventListener('click', () => {
        document.querySelectorAll('[data-qr-prefix]').forEach(node => {
            const active = node === button;
            node.classList.toggle('is-active', active);
            node.setAttribute('aria-pressed', String(active));
        });
        const input = byId('qrDataInput');
        const content = input.value.replace(/^(mailto:|tel:)/i, '');
        input.value = `${button.dataset.qrPrefix}${content}`;
        state.data = input.value || ' '; input.focus(); scheduleQr();
    }, { signal }));
    byId('qrDataInput')?.addEventListener('input', event => { state.data = event.target.value || ' '; scheduleQr(); }, { signal });
    byId('qrDots')?.addEventListener('change', event => { state.dots = event.target.value; scheduleQr(); }, { signal });
    byId('qrCorners')?.addEventListener('change', event => { state.corners = event.target.value; scheduleQr(); }, { signal });
    [['qrForeground', 'foreground'], ['qrBackground', 'background']].forEach(([id, key]) => byId(id)?.addEventListener('input', event => {
        state[key] = event.target.value; byId(`${id}Text`).textContent = event.target.value; scheduleQr();
    }, { signal }));
    byId('qrSize')?.addEventListener('input', event => {
        state.size = Number(event.target.value); byId('qrSizeValue').value = `${state.size} px`; scheduleQr();
    }, { signal });
    byId('qrLogo')?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file || file.size > 5 * 1024 * 1024) return setStatus('中心图标需小于 5MB。', 'error');
        const reader = new FileReader();
        reader.onload = () => {
            if (currentLifecycle !== lifecycle) return;
            state.image = reader.result;
            scheduleQr();
        };
        reader.readAsDataURL(file);
    }, { signal });
    byId('qrClearLogo')?.addEventListener('click', () => { state.image = null; byId('qrLogo').value = ''; scheduleQr(); }, { signal });
    byId('qrResetStyle')?.addEventListener('click', resetStyle, { signal });
    byId('qrChooseFile')?.addEventListener('click', chooseTemporaryFile, { signal });
    byId('qrStopShare')?.addEventListener('click', stopShare, { signal });
    document.querySelectorAll('[data-qr-download]').forEach(button => button.addEventListener('click', () => download(button.dataset.qrDownload), { signal }));
    byId('qrCopyContent')?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(state.data);
            setStatus('二维码内容已复制。', 'success');
        } catch (error) {
            setStatus(`复制失败：${error}`, 'error');
        }
    }, { signal });
    activeTab = 'create';
    state.data = byId('qrDataInput').value || ' ';
    state.size = Number(byId('qrSize').value);
    state.dots = byId('qrDots').value;
    state.corners = byId('qrCorners').value;
    state.foreground = byId('qrForeground').value;
    state.background = byId('qrBackground').value;
    state.image = null;
    updatePreviewActions();
    try {
        const share = await invoke('get_lan_share');
        if (currentLifecycle !== lifecycle) return;
        activeShare = share;
        renderShare();
    } catch {
        if (currentLifecycle !== lifecycle) return;
        activeShare = null;
        renderShare();
    }
    if (globalThis.window?.__TAURI__?.event?.listen) {
        const stopListening = await globalThis.window.__TAURI__.event.listen('lan-share-stopped', event => {
            if (activeShare?.shareId !== event.payload?.shareId) return;
            activeShare = null; renderShare(); setStatus('临时分享已自动停止。');
        });
        if (currentLifecycle !== lifecycle) {
            stopListening();
            return;
        }
        unlisten = stopListening;
    }
    await renderQr();
}

function destroy() {
    controller?.abort(); controller = null; clearTimeout(renderTimer);
    lifecycle += 1;
    qrGeneration += 1;
    unlisten?.(); unlisten = null; qr = null; activeShare = null; state.image = null;
}

registerTool({
    id: 'qr-generator', name: '二维码生成', icon: 'ri-qr-code-line',
    colorClass: 'tool-card__icon--cyan', category: 'dev', status: 'ready',
    description: '生成自定义二维码，并通过本地中转站创建临时局域网下载码。',
    template, init, destroy
});
