import { escapeHtml } from '../../core/html.js';

const statuses = { selecting: '正在框选', live: '实时显示', minimized: '源窗口已最小化', hidden: '源窗口不可见', resized: '选区超出源窗口', closed: '源窗口已关闭' };
const hints = {
    minimized: '点击「返回源窗口」恢复窗口，画面会自动继续。',
    hidden: '返回源窗口后继续显示；若源窗口在其他虚拟桌面，请先切回。',
    resized: '放大源窗口使其包含原选区，或重新框选。选区按窗口内的固定位置显示。',
    closed: '原应用已关闭。重新打开应用后点击「重新框选」替换此小窗。'
};

export function renderMirror(item, { pending = false, canReselect = true, open = false } = {}) {
    const id = escapeHtml(item.id);
    const title = escapeHtml(item.title);
    const selection = item.status === 'selecting';
    const disabled = pending || selection ? 'disabled' : '';
    const control = action => `data-mirror-action="${action}" data-mirror-id="${id}"`;
    const opacity = Number.isInteger(item.opacity) ? item.opacity : 100;
    const opacityOptions = [...new Set([30, 50, 70, 85, 100, opacity])].sort((a, b) => a - b);
    return `<article class="mirror-row ${selection ? 'is-selecting' : ''}">
        <div class="mirror-row__main">
            <span class="mirror-row__icon"><i class="ri-picture-in-picture-line" aria-hidden="true"></i></span>
            <div class="mirror-row__body"><strong title="${title}">${title}</strong><span><b class="mirror-status ${item.status === 'live' ? 'is-live' : ''}">${escapeHtml(statuses[item.status] || '等待画面')}</b>${item.width ? ` · ${escapeHtml(item.width)} × ${escapeHtml(item.height)}` : ''}${item.clickThrough ? ' · 鼠标穿透中' : ''}${item.compact ? ' · 纯画面' : ''}</span></div>
            <div class="mirror-row__actions">
                <button class="mirror-button" ${control('show')} ${pending ? 'disabled' : ''} type="button" title="恢复到屏幕内，并解除鼠标穿透">${selection ? '返回框选' : '找回小窗'}</button>
                <button class="mirror-button" ${control('source')} ${disabled || (item.status === 'closed' ? 'disabled' : '')} type="button">返回源窗口</button>
                <button class="mirror-button" ${control('pin')} ${disabled} type="button" aria-pressed="${Boolean(item.pinned)}">${item.pinned ? '已置顶' : '置顶'}</button>
                <button class="mirror-button mirror-button--close" ${control('close')} ${pending ? 'disabled' : ''} type="button" aria-label="${selection ? '取消框选' : `关闭 ${title}`}"><i class="ri-close-line" aria-hidden="true"></i></button>
            </div>
        </div>
        ${item.error ? `<p class="mirror-row__hint mirror-row__hint--error" role="alert">${escapeHtml(item.error)}</p>` : ''}
        ${hints[item.status] ? `<p class="mirror-row__hint" role="status">${hints[item.status]}</p>` : ''}
        ${selection ? '<p class="mirror-row__hint">在应用窗口内框选后按 Enter 确认，Esc 或右键取消。</p>' : `<details class="mirror-options" data-mirror-options="${id}" ${open ? 'open' : ''}>
            <summary>显示与调整 <span>${item.clickThrough ? '鼠标穿透' : item.compact ? '纯画面' : '标准小窗'} · 不透明度 ${opacity}%</span></summary>
            <div class="mirror-options__controls">
                <label>小窗大小<select class="mirror-select" ${control('scale')} ${disabled} aria-label="${title} 小窗大小"><option value="">调整大小…</option><option value="50">原选区的 50%</option><option value="100">原选区的 100%</option><option value="150">原选区的 150%</option></select></label>
                <label>不透明度<select class="mirror-select" ${control('opacity')} ${disabled} aria-label="${title} 不透明度">${opacityOptions.map(value => `<option value="${value}" ${value === opacity ? 'selected' : ''}>${value}%</option>`).join('')}</select></label>
                <button class="mirror-button" ${control('compact')} ${disabled} type="button" aria-pressed="${Boolean(item.compact)}">纯画面</button>
                <button class="mirror-button" ${control('clickThrough')} ${disabled} type="button" aria-pressed="${Boolean(item.clickThrough)}">鼠标穿透</button>
                <button class="mirror-button" ${control('reset')} ${disabled} type="button">重置显示</button>
                <button class="mirror-button" ${control('reselect')} ${!canReselect || pending ? 'disabled' : ''} type="button">重新框选</button>
            </div>
            <p>穿透后点击「找回小窗」恢复操作。重新框选成功才替换原小窗，取消会保留。</p>
        </details>`}
    </article>`;
}

export function template() {
    return `<div class="mirror-shell">
        <header class="mirror-hero">
            <div class="mirror-hero__copy"><span class="mirror-eyebrow">区域悬浮 / LIVE VIEW</span>
                <h2>需要关注的，始终在眼前</h2>
                <p>把视频、任务进度或参考资料的一块区域放到桌面小窗，继续做手头的事。</p>
                <button class="mirror-button mirror-button--primary" id="mirrorSelect" type="button"><i class="ri-screenshot-2-line" aria-hidden="true"></i><span>框选悬浮区域</span></button>
                <span class="mirror-hero__caption" id="mirrorLimit">在目标窗口内拖动框选，按 Enter 确认 · Esc 取消</span>
            </div>
            <div class="mirror-illustration" aria-hidden="true"><div class="mirror-demo-window"><span></span><span></span><span></span><div class="mirror-demo-content"><i class="ri-play-circle-line"></i></div></div><div class="mirror-demo-float"><div><span>实时关注</span><i class="ri-pushpin-line"></i></div><i class="ri-play-circle-line"></i></div></div>
        </header>
        <div class="mirror-benefits"><span><i class="ri-leaf-line" aria-hidden="true"></i> 轻量原生悬窗</span><span><i class="ri-drag-move-2-line" aria-hidden="true"></i> 拖动缩放 · 等比显示</span><span><i class="ri-pushpin-line" aria-hidden="true"></i> 默认置顶 · 最多 6 个</span></div>
        <p id="mirrorNotice" class="mirror-notice" role="status" aria-live="polite"></p>
        <section class="mirror-windows" aria-labelledby="mirrorWindowsHeading">
            <div class="mirror-section-heading"><h3 id="mirrorWindowsHeading">我的悬浮窗 <span id="mirrorCount" aria-live="polite">0 / 6</span></h3><button class="mirror-button" id="mirrorRefresh" type="button"><i class="ri-refresh-line" aria-hidden="true"></i> 刷新</button></div>
            <div id="mirrorList"></div>
        </section>
        <div class="mirror-guide-grid">
            <section class="mirror-guide"><h3>顺手的小窗操作</h3><dl>
                <div><dt>移动 / 缩放</dt><dd>拖动画面移动，拖动边缘调整大小</dd></div>
                <div><dt>操作原内容</dt><dd>双击画面或按 <kbd>Enter</kbd> 返回源窗口</dd></div>
                <div><dt>置顶 / 纯画面</dt><dd><kbd>P</kbd> 切换置顶 · <kbd>C</kbd> 隐藏工具栏</dd></div>
                <div><dt>更多 / 关闭</dt><dd>右键打开菜单 · <kbd>Esc</kbd> 关闭小窗</dd></div>
            </dl></section>
            <section class="mirror-guide mirror-guide--tips"><h3>持续显示的小提示</h3><p>保持源窗口打开、视频标签页不变。窗口可移动和缩放；原选区超出窗口时会暂停，放大恢复或重新框选即可。最小化后可通过「返回源窗口」恢复。</p><p>声音由原应用播放。受保护的视频可能黑屏，部分应用被遮挡后会停止渲染。画面内容随源窗口变化，滚动页面或切换标签后需重新确认选区。</p><span><i class="ri-checkbox-circle-line" aria-hidden="true"></i> 切换工具或关闭工具页，小窗继续保留</span></section>
        </div>
    </div>`;
}
