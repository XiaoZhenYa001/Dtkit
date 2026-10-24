const status = document.getElementById('longCaptureStatus');
const manual = new URL(location.href).searchParams.get('mode') === 'manual';
status.textContent = manual
    ? '手动滚轮 · 选区内缓慢滚动并稍停 · Enter 完成 · Esc 取消'
    : '自动滚动拼接中… · Esc 取消';

const listen = window.__TAURI__?.event?.listen;
if (listen) {
    const stop = await listen('screen-long-progress', event => {
        if (typeof event.payload === 'string') status.textContent = event.payload;
    });
    addEventListener('pagehide', stop, { once: true });
}
