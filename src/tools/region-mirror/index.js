import { registerTool } from '../toolRegistry.js';
import { escapeHtml } from '../../core/html.js';
import '../../css/tools/region-mirror.css';

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const statuses = { selecting: '正在框选', live: '实时显示', minimized: '源窗口已最小化', hidden: '源窗口不可见', resized: '源窗口尺寸已改变', closed: '源窗口已关闭' };
let controller = null;
let unlisten = null;
let generation = 0;
let revision = 0;
let busy = false;
let items = [];

function template() {
    return `<div class="mirror-shell">
        <header class="mirror-hero">
            <div class="mirror-hero__copy"><span class="mirror-eyebrow">随手一框，留在眼前</span>
                <h2>只留下你想看的部分</h2>
                <p>视频、直播、进度条。把窗口里的一块区域放到桌面上，边做事，边关注。</p>
                <button class="mirror-button mirror-button--primary" id="mirrorSelect" type="button"><i class="ri-screenshot-2-line"></i> 框选悬浮区域</button>
                <span class="mirror-hero__caption">框选后按 Enter 确认 · Esc 取消</span>
            </div>
            <div class="mirror-illustration" aria-hidden="true"><div class="mirror-demo-window"><span></span><span></span><span></span><div class="mirror-demo-content"><i class="ri-play-circle-line"></i></div></div><div class="mirror-demo-float"><div><span>正在播放</span><i class="ri-pushpin-line"></i></div><i class="ri-play-circle-line"></i></div></div>
        </header>
        <div class="mirror-benefits"><span><i class="ri-leaf-line"></i> 轻量原生悬窗</span><span><i class="ri-drag-move-2-line"></i> 自由拖动 · 等比显示</span><span><i class="ri-pushpin-line"></i> 默认置顶</span></div>
        <p id="mirrorNotice" class="mirror-notice" role="status" aria-live="polite"></p>
        <section class="mirror-windows" aria-labelledby="mirrorWindowsHeading">
            <div class="mirror-section-heading"><h3 id="mirrorWindowsHeading">我的悬浮窗 <span id="mirrorCount">0 / 6</span></h3><button class="mirror-button" id="mirrorRefresh" type="button"><i class="ri-refresh-line"></i> 刷新</button></div>
            <div id="mirrorList"></div>
        </section>
        <div class="mirror-guide-grid">
            <section class="mirror-guide"><h3>小窗，随你安排</h3><dl>
                <div><dt>移动 / 缩放</dt><dd>拖动画面移动，拖动边缘调整大小</dd></div>
                <div><dt>控制原视频</dt><dd>双击画面或按 <kbd>Enter</kbd> 返回源窗口</dd></div>
                <div><dt>置顶 / 纯画面</dt><dd><kbd>P</kbd> 切换置顶 · <kbd>C</kbd> 隐藏工具栏</dd></div>
                <div><dt>更多 / 关闭</dt><dd>右键打开菜单 · <kbd>Esc</kbd> 关闭小窗</dd></div>
            </dl></section>
            <section class="mirror-guide mirror-guide--tips"><h3>让画面持续播放</h3><p>保持源窗口打开、视频标签页不变。可以移动源窗口；最小化、改变窗口尺寸或切换标签页会影响画面，部分应用被遮挡后也可能暂停渲染。</p><p>声音继续由原应用播放，小窗仅显示画面。受保护的视频可能显示黑屏。支持 Windows，可同时开启 6 个小窗。</p><span><i class="ri-checkbox-circle-line"></i> 切换工具或关闭工具页，小窗继续保留</span></section>
        </div>
    </div>`;
}

function notice(message = '', error = false) {
    const element = document.getElementById('mirrorNotice');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', error);
}

function render() {
    const list = document.getElementById('mirrorList');
    if (!list) return;
    document.getElementById('mirrorCount').textContent = `${items.length} / 6`;
    document.getElementById('mirrorSelect').disabled = busy || !window.__TAURI__?.core?.invoke || items.length >= 6 || items.some(item => item.status === 'selecting');
    list.innerHTML = items.length ? items.map(item => `<article class="mirror-row">
        <span class="mirror-row__icon"><i class="ri-picture-in-picture-line"></i></span>
        <div class="mirror-row__body"><strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong><span><b class="mirror-status ${item.status === 'live' ? 'is-live' : ''}">${escapeHtml(statuses[item.status] || '等待画面')}</b>${item.width ? ` · ${escapeHtml(item.width)} × ${escapeHtml(item.height)}` : ''}</span></div>
        <div class="mirror-row__actions"><button class="mirror-button" data-mirror-action="show" data-mirror-id="${escapeHtml(item.id)}" type="button">显示</button><button class="mirror-button" data-mirror-action="pin" data-mirror-id="${escapeHtml(item.id)}" type="button" aria-pressed="${Boolean(item.pinned)}" ${item.status === 'selecting' ? 'disabled' : ''}>${item.pinned ? '已置顶' : '置顶'}</button><button class="mirror-button mirror-button--close" data-mirror-action="close" data-mirror-id="${escapeHtml(item.id)}" type="button" aria-label="关闭 ${escapeHtml(item.title)}"><i class="ri-close-line"></i></button></div>
    </article>`).join('') : `<div class="mirror-empty"><i class="ri-picture-in-picture-line"></i><strong>还没有悬浮窗</strong><span>先打开想看的视频或窗口，再点击上方按钮框选。</span></div>`;
}

async function refresh() {
    const current = generation;
    const before = revision;
    try {
        const result = await invoke('list_region_mirrors');
        if (current !== generation || before !== revision) return;
        items = Array.isArray(result) ? result : [];
        render();
    } catch (error) { if (current === generation) notice(String(error), true); }
}

async function selectRegion() {
    if (busy) return;
    const current = generation;
    busy = true;
    notice('在目标窗口内拖动框选，然后按 Enter 确认。');
    render();
    try { await invoke('start_region_mirror'); }
    catch (error) { if (current === generation) notice(String(error), true); }
    finally { if (current === generation) { busy = false; render(); } }
}

async function control(event) {
    const button = event.target.closest('[data-mirror-action]');
    if (!button || button.disabled) return;
    const current = generation;
    button.disabled = true;
    try { await invoke('control_region_mirror', { id: Number(button.dataset.mirrorId), action: button.dataset.mirrorAction }); }
    catch (error) { if (current === generation) notice(String(error), true); }
    finally { if (current === generation && button.isConnected) button.disabled = false; }
}

async function init() {
    destroy();
    const current = generation;
    controller = new AbortController();
    const { signal } = controller;
    items = [];
    busy = false;
    render();
    if (!window.__TAURI__?.core?.invoke) { notice('请在 Windows 桌面版 DtKit 中使用区域悬浮。'); document.getElementById('mirrorRefresh').disabled = true; return; }
    document.getElementById('mirrorSelect').addEventListener('click', selectRegion, { signal });
    document.getElementById('mirrorRefresh').addEventListener('click', refresh, { signal });
    document.getElementById('mirrorList').addEventListener('click', control, { signal });
    if (!window.__DTKIT_TOOL_PAGE_CONTEXT?.embedded) window.addEventListener('focus', refresh, { signal });
    window.addEventListener('dtkit:power-state', event => { if (!event.detail?.suspended) refresh(); }, { signal });
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
        try {
            const dispose = await listen('region-mirrors-changed', event => {
                if (current !== generation) return;
                revision += 1;
                items = Array.isArray(event.payload) ? event.payload : [];
                notice();
                render();
            });
            if (current !== generation) { dispose(); return; }
            unlisten = dispose;
        } catch (error) { if (current === generation) notice(`窗口状态监听失败，可点击刷新：${error}`, true); }
    }
    if (current === generation) await refresh();
}

function destroy() {
    generation += 1;
    controller?.abort();
    controller = null;
    unlisten?.();
    unlisten = null;
}

registerTool({ id: 'region-mirror', name: '区域悬浮', icon: 'ri-picture-in-picture-line', colorClass: 'tool-card__icon--green', category: 'utility', status: 'ready', description: '将窗口里的选定区域实时置顶显示。', template, init, destroy });
