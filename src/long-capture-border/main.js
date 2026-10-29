const root = document.querySelector('.long-capture-border');
const status = document.getElementById('longCaptureStatus');
const params = new URL(location.href).searchParams;
const manual = params.get('mode') === 'manual';
const vertical = params.get('direction') !== 'horizontal';
const session = params.get('session') || '';

root.classList.add('long-capture-preview');
if (!vertical) root.classList.add('is-horizontal');
const heading = document.createElement('strong');
heading.className = 'long-capture-preview__title';
heading.textContent = '长截图预览';
const imageFrame = document.createElement('div');
imageFrame.className = 'long-capture-preview__frame';
const image = document.createElement('img');
image.className = 'long-capture-preview__image';
image.alt = '已拼接的截图预览';
image.hidden = true;
imageFrame.append(image);
const empty = document.createElement('span');
empty.className = 'long-capture-preview__empty';
empty.textContent = '正在准备预览…';
imageFrame.append(empty);
const dimensions = document.createElement('small');
dimensions.className = 'long-capture-preview__dimensions';
root.prepend(heading);
root.append(imageFrame, dimensions);
status.textContent = manual
    ? '在选区内缓慢滚动 · Enter 完成 · Esc 取消'
    : '自动滚动拼接中 · Esc 取消';

const eventApi = window.__TAURI__?.event;
if (eventApi?.listen) {
    // Signal readiness only after registration, before the first frame arrives.
    const stop = await eventApi.listen('screen-long-progress', event => {
        const payload = event.payload;
        if (typeof payload === 'string') { status.textContent = payload; return; }
        if (!payload || typeof payload !== 'object') return;
        if (typeof payload.message === 'string') status.textContent = payload.message;
        if (typeof payload.dataUrl === 'string' && payload.dataUrl.startsWith('data:image/png;base64,')) {
            image.onload = () => {
                imageFrame.scrollTop = vertical ? imageFrame.scrollHeight : 0;
                imageFrame.scrollLeft = vertical ? 0 : imageFrame.scrollWidth;
            };
            image.src = payload.dataUrl;
            image.hidden = false;
            empty.hidden = true;
        }
        if (Number.isFinite(payload.width) && Number.isFinite(payload.height)) {
            const count = Number.isFinite(payload.segments) ? ` · ${payload.segments} 段` : '';
            dimensions.textContent = `${payload.width} × ${payload.height} px${count}`;
        }
    });
    addEventListener('pagehide', stop, { once: true });
    if (session && eventApi.emit) await eventApi.emit('screen-long-preview-ready', { session });
}
