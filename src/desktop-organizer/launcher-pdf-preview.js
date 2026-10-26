import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url';
import './launcher-pdf.css';

const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_EDGE = 4096;
let libraryPromise;
const pdfLibrary = () => libraryPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs').then(library => {
    library.GlobalWorkerOptions.workerSrc = workerUrl;
    return library;
});

// Render inside this document so Escape and the preview focus trap also work
// while a PDF has focus. The native command has already bounded the file bytes.
export function mountPdfPreview(container, dataUrl, { name = 'PDF 预览', onError } = {}) {
    const viewer = document.createElement('div'); viewer.className = 'pdf-preview';
    viewer.innerHTML = '<div class="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具"><button type="button" data-pdf="previous" aria-label="上一页">‹</button><label>第 <input type="number" min="1" value="1" aria-label="PDF 页码"> 页</label><span class="pdf-page-count" aria-live="polite">正在读取…</span><button type="button" data-pdf="next" aria-label="下一页">›</button><span class="pdf-toolbar-spacer"></span><button type="button" data-pdf="out" aria-label="缩小 PDF">−</button><span class="pdf-zoom" aria-live="polite"></span><button type="button" data-pdf="in" aria-label="放大 PDF">+</button><button type="button" data-pdf="fit">适合宽度</button></div><div class="pdf-stage" tabindex="0" aria-label="PDF 页面，可使用方向键翻页，按 Escape 关闭预览"><canvas role="img"></canvas></div><p class="pdf-status" role="status">正在读取 PDF…</p>';
    container.append(viewer);
    const canvas = viewer.querySelector('canvas'), stage = viewer.querySelector('.pdf-stage');
    const pageInput = viewer.querySelector('input'), count = viewer.querySelector('.pdf-page-count');
    const status = viewer.querySelector('.pdf-status'), zoomLabel = viewer.querySelector('.pdf-zoom');
    const buttons = Object.fromEntries([...viewer.querySelectorAll('[data-pdf]')].map(button => [button.dataset.pdf, button]));
    const events = new AbortController();
    let disposed = false, loadingTask = null, documentProxy = null, renderTask = null, activePage = null, worker = null;
    let renderCompletion = Promise.resolve();
    let pageNumber = 1, zoom = 1, fit = true, revision = 0, resizeFrame = 0;

    function controls() {
        const ready = !!documentProxy;
        buttons.previous.disabled = !ready || pageNumber <= 1;
        buttons.next.disabled = !ready || pageNumber >= documentProxy.numPages;
        buttons.in.disabled = !ready || !fit && zoom >= 3;
        buttons.out.disabled = !ready || !fit && zoom <= .25;
        buttons.fit.disabled = !ready;
        pageInput.disabled = !ready;
        pageInput.value = String(pageNumber);
        if (ready) { pageInput.max = String(documentProxy.numPages); count.textContent = `/ ${documentProxy.numPages}`; }
    }
    function releasePage() {
        try { renderTask?.cancel(); } catch { /* Already completed. */ }
        renderTask = null;
    }
    async function renderPage() {
        if (disposed || !documentProxy) return;
        const token = ++revision;
        const previousRender = renderCompletion;
        releasePage();
        status.hidden = false; status.textContent = '正在绘制页面…';
        try {
            // Cancellation settles asynchronously. Do not clear/reuse the canvas
            // or release its image resources until the previous draw has stopped.
            await previousRender;
            if (disposed || token !== revision) return;
            const page = await documentProxy.getPage(pageNumber);
            if (disposed || token !== revision) return;
            if (activePage && activePage !== page) activePage.cleanup();
            activePage = page;
            const base = page.getViewport({ scale: 1 });
            const width = Math.max(180, stage.clientWidth - 32);
            if (![base.width, base.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('页面尺寸无效');
            const desiredScale = fit ? Math.min(3, width / base.width) : zoom;
            const scale = Math.min(desiredScale, 16384 / base.width, 16384 / base.height);
            const viewport = page.getViewport({ scale });
            const ratio = Math.min(window.devicePixelRatio || 1, 2,
                Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
                MAX_CANVAS_EDGE / viewport.width, MAX_CANVAS_EDGE / viewport.height);
            canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
            canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
            canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
            canvas.setAttribute('aria-label', `${name}，第 ${pageNumber} 页，共 ${documentProxy.numPages} 页`);
            zoomLabel.textContent = `${Math.round(scale * 100)}%`;
            controls();
            const task = page.render({ canvas, viewport,
                transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' });
            renderTask = task;
            renderCompletion = task.promise.catch(() => {});
            await task.promise;
            if (disposed || token !== revision) return;
            renderTask = null; status.hidden = true;
        } catch (error) {
            if (disposed || token !== revision || error?.name === 'RenderingCancelledException') return;
            status.textContent = '此页面无法显示，可使用默认应用打开 PDF。';
        }
    }
    function changePage(next) {
        if (!documentProxy) return;
        const requested = Math.max(1, Math.min(documentProxy.numPages, Number.isFinite(next) ? Math.round(next) : pageNumber));
        pageInput.value = String(requested);
        if (requested === pageNumber) return;
        pageNumber = requested; stage.scrollTop = 0; stage.scrollLeft = 0; controls(); void renderPage();
    }
    function changeZoom(factor) {
        if (!documentProxy) return;
        const current = Number.parseFloat(zoomLabel.textContent) / 100 || 1;
        zoom = Math.max(.25, Math.min(3, (fit ? current : zoom) * factor)); fit = false;
        controls(); void renderPage();
    }
    viewer.addEventListener('click', event => {
        const action = event.target.closest('[data-pdf]')?.dataset.pdf;
        if (action === 'previous') changePage(pageNumber - 1);
        else if (action === 'next') changePage(pageNumber + 1);
        else if (action === 'in') changeZoom(1.2);
        else if (action === 'out') changeZoom(1 / 1.2);
        else if (action === 'fit') { fit = true; void renderPage(); }
    }, { signal: events.signal });
    pageInput.addEventListener('change', () => changePage(Number(pageInput.value)), { signal: events.signal });
    pageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); changePage(Number(pageInput.value)); stage.focus(); }
    }, { signal: events.signal });
    stage.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); changePage(pageNumber - 1); }
        else if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); changePage(pageNumber + 1); }
        else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.2); }
        else if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.2); }
    }, { signal: events.signal });
    let observedWidth = stage.clientWidth;
    const observer = new ResizeObserver(() => {
        const width = stage.clientWidth;
        if (width === observedWidth) return;
        observedWidth = width;
        if (!fit || disposed || resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; void renderPage(); });
    }); observer.observe(stage);
    controls();

    void (async () => {
        try {
            const library = await pdfLibrary();
            if (disposed) return;
            const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1), bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
            if (bytes.length > 12 * 1024 * 1024) throw new Error('文件超过 12 MB 预览上限');
            worker = new library.PDFWorker();
            const resources = new URL('../pdfjs/', import.meta.url);
            loadingTask = library.getDocument({ data: bytes, worker, isEvalSupported: false,
                cMapUrl: new URL('cmaps/', resources).href, cMapPacked: true,
                standardFontDataUrl: new URL('standard_fonts/', resources).href,
                wasmUrl: new URL('wasm/', resources).href, iccUrl: new URL('iccs/', resources).href,
                maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000,
                disableAutoFetch: true, stopAtErrors: false });
            const pdf = await loadingTask.promise;
            if (disposed) { await pdf.destroy(); return; }
            documentProxy = pdf; controls(); await renderPage();
        } catch (error) { if (!disposed) onError?.(error); }
    })();

    return () => {
        if (disposed) return;
        disposed = true; revision++; events.abort(); observer.disconnect();
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        releasePage();
        const task = loadingTask; loadingTask = null; documentProxy = null; activePage = null;
        try { Promise.resolve(task?.destroy()).catch(() => {}); } catch { /* WebView is already disposing. */ }
        worker?.destroy(); worker = null;
        canvas.width = 1; canvas.height = 1;
        viewer.remove();
    };
}
