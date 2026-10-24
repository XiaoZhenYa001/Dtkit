import { extractPalette, formatColor } from './core.js';
import { saveImageAsset, loadImageAsset, removeImageAsset } from './assets.js';

const MAX_FILE_SIZE = 24 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

export function createImagePicker({ root, signal, onPick, onPalette, onStatus }) {
    const get = id => root.querySelector('#' + id);
    const canvas = get('colorImageCanvas'), stage = get('colorImageStage'), empty = get('colorImageEmpty');
    const loupe = get('colorImageLoupe'), loupeCanvas = get('colorLoupeCanvas'), marker = get('colorImageMarker');
    let source = null, file = null, point = null, selection = null, assetId = null;
    let version = 0, frame = null, worker = null, assetJob = Promise.resolve(), image = null, imageUrl = null;
    let dragging = false, activePointer = null, palette = [], stopped = false, workerTimer = null, rejectWorker = null, assetWarning = false;
    const current = token => !stopped && !signal.aborted && version === token;
    const status = (text, tone) => onStatus(text, tone);
    const stopWorker = () => {
        worker?.terminate(); worker = null; clearTimeout(workerTimer); workerTimer = null;
        const reject = rejectWorker; rejectWorker = null; reject?.(new DOMException('已取消图片分析', 'AbortError'));
    };
    const clearDecode = () => { if (image) image.src = ''; image = null; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; };
    const fitRect = () => {
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
        const width = canvas.width * scale, height = canvas.height * scale;
        return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2,
            scaleX: source ? width / source.width : 1, scaleY: source ? height / source.height : 1 };
    };
    function pixelAt(event) {
        if (!source) return null;
        const rect = fitRect(), x = (event.clientX - rect.left) / rect.scaleX, y = (event.clientY - rect.top) / rect.scaleY;
        if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;
        return { x: Math.floor(x), y: Math.floor(y) };
    }
    function sample(at) {
        const [r, g, b, a] = source.getContext('2d', { willReadFrequently: true }).getImageData(at.x, at.y, 1, 1).data;
        return { r, g, b, a: a / 255 };
    }
    function positionMarker(at, node) {
        const rect = fitRect(), area = canvas.parentElement.getBoundingClientRect();
        node.style.left = (rect.left - area.left + (at.x + .5) * rect.scaleX) + 'px';
        node.style.top = (rect.top - area.top + (at.y + .5) * rect.scaleY) + 'px';
    }
    function renderLoupe() {
        frame = null; if (!source || !point || stopped) return;
        const context = loupeCanvas.getContext('2d'), size = loupeCanvas.width;
        context.clearRect(0, 0, size, size); context.imageSmoothingEnabled = false;
        context.drawImage(source, point.x - 4, point.y - 4, 9, 9, 0, 0, size, size);
        context.strokeStyle = '#fff'; context.lineWidth = 2; context.strokeRect(size * 4 / 9, size * 4 / 9, size / 9, size / 9);
        context.strokeStyle = '#1d1d1f'; context.lineWidth = 1; context.strokeRect(size * 4 / 9 - 1, size * 4 / 9 - 1, size / 9 + 2, size / 9 + 2);
        get('colorLoupeValue').textContent = formatColor(sample(point), 'hex');
        const rect = fitRect(), area = canvas.parentElement.getBoundingClientRect();
        const x = rect.left - area.left + point.x * rect.scaleX, y = rect.top - area.top + point.y * rect.scaleY;
        loupe.hidden = false;
        const width = loupe.offsetWidth || 132, height = loupe.offsetHeight || 160;
        loupe.style.left = Math.max(0, Math.min(area.width - width, x + width + 20 < area.width ? x + 18 : x - width - 18)) + 'px';
        loupe.style.top = Math.max(0, Math.min(area.height - height, y + height + 18 < area.height ? y + 18 : y - height - 18)) + 'px';
    }
    function move(event) {
        if (dragging && event.pointerId !== activePointer) return;
        const next = pixelAt(event); if (!next) { loupe.hidden = true; return; }
        point = next; if (frame === null) frame = requestAnimationFrame(renderLoupe);
        if (dragging) choose(false);
    }
    function choose(commit = true) {
        if (!source || !point) return;
        selection = { ...point }; marker.hidden = false; positionMarker(selection, marker);
        onPick(sample(point), { commit });
    }
    function finishDrag(event) {
        if (!dragging || event.pointerId !== activePointer) return; move(event); dragging = false; activePointer = null; choose(true);
        try { canvas.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    }
    canvas.addEventListener('pointermove', move, { signal });
    canvas.addEventListener('pointerleave', () => { if (!dragging) loupe.hidden = true; }, { signal });
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !source || dragging) return;
        if (!pixelAt(event)) { loupe.hidden = true; return; }
        event.preventDefault(); canvas.focus({ preventScroll: true }); move(event); dragging = true; activePointer = event.pointerId;
        try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers. */ }
        choose(false);
    }, { signal });
    canvas.addEventListener('pointerup', finishDrag, { signal });
    canvas.addEventListener('pointercancel', event => { if (event.pointerId === activePointer) { dragging = false; activePointer = null; loupe.hidden = true; } }, { signal });
    canvas.addEventListener('lostpointercapture', event => { if (event.pointerId === activePointer) { dragging = false; activePointer = null; } }, { signal });
    canvas.addEventListener('keydown', event => {
        if (!source) return;
        point ||= { x: Math.floor(source.width / 2), y: Math.floor(source.height / 2) };
        const step = event.shiftKey ? 10 : 1;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[event.key]) {
            event.preventDefault(); const [x, y] = moves[event.key];
            point = { x: Math.max(0, Math.min(source.width - 1, point.x + x)), y: Math.max(0, Math.min(source.height - 1, point.y + y)) }; renderLoupe();
        } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); renderLoupe(); choose(true); }
        else if (event.key === 'Escape' && !loupe.hidden) { event.preventDefault(); loupe.hidden = true; }
    }, { signal });

    async function analyze(token) {
        const thumbnail = document.createElement('canvas'), scale = Math.min(1, 180 / Math.max(source.width, source.height));
        thumbnail.width = Math.max(1, Math.round(source.width * scale)); thumbnail.height = Math.max(1, Math.round(source.height * scale));
        const context = thumbnail.getContext('2d', { willReadFrequently: true }); context.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
        const pixels = context.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
        const fallback = () => extractPalette(pixels, thumbnail.width, thumbnail.height, 6);
        let result;
        try {
            result = await new Promise((resolve, reject) => {
                const activeWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); worker = activeWorker;
                rejectWorker = reject;
                const finish = () => { clearTimeout(timer); if (worker === activeWorker) { workerTimer = null; rejectWorker = null; } };
                const timer = setTimeout(() => { finish(); activeWorker.terminate(); reject(new Error('主色分析超时')); }, 12000); workerTimer = timer;
                activeWorker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.palette); };
                activeWorker.onerror = () => { finish(); reject(new Error('主色分析不可用')); };
                activeWorker.postMessage({ id: token, pixels: pixels.buffer.slice(0), width: thumbnail.width, height: thumbnail.height, count: 6 });
            });
        } catch { if (current(token)) result = fallback(); }
        finally { if (current(token)) stopWorker(); thumbnail.width = thumbnail.height = 0; }
        if (!current(token)) return;
        palette = result || []; onPalette(palette);
        status(assetWarning ? '主色已提取；本地缓存不可用，重新打开后需再次导入' : palette.length ? '主色已提取，点击图片可精确取色' : '图片完全透明，可点击像素查看透明度', assetWarning ? 'warning' : 'success');
    }

    async function load(nextFile, restored = null) {
        if (!nextFile || !nextFile.size) { status('请选择一张有效图片', 'error'); return; }
        if (!nextFile.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(nextFile.name || '')) { status('请选择 PNG、JPEG、WebP 等图片文件', 'error'); return; }
        if (nextFile.size > MAX_FILE_SIZE) { status('图片超过 24 MB，请选择较小的文件', 'error'); return; }
        const token = ++version; stopWorker(); clearDecode();
        stage.setAttribute('aria-busy', 'true'); status('正在读取图片…', 'loading');
        const next = new Image(), url = URL.createObjectURL(nextFile); image = next; imageUrl = url;
        try {
            next.src = url; await next.decode(); if (!current(token)) return;
            if (!next.naturalWidth || !next.naturalHeight || next.naturalWidth * next.naturalHeight > MAX_PIXELS) throw new Error('图片超过 2400 万像素，请先缩小后再导入');
            const full = document.createElement('canvas'); full.width = next.naturalWidth; full.height = next.naturalHeight;
            const fullContext = full.getContext('2d', { willReadFrequently: true });
            if (!fullContext) throw new Error('当前图片无法创建像素预览，请缩小图片后重试');
            fullContext.drawImage(next, 0, 0);
            try { fullContext.getImageData(0, 0, 1, 1); }
            catch { full.width = full.height = 0; throw new Error('图片包含无法读取的外部内容，请转为本地 PNG 或 JPEG 后重试'); }
            const oldSource = source;
            source = full; file = nextFile; point = null; selection = null; assetId = restored?.assetId || null; palette = []; assetWarning = false;
            if (oldSource) oldSource.width = oldSource.height = 0;
            const scale = Math.min(1, 1400 / Math.max(full.width, full.height));
            canvas.width = Math.max(1, Math.round(full.width * scale)); canvas.height = Math.max(1, Math.round(full.height * scale));
            canvas.getContext('2d').drawImage(full, 0, 0, canvas.width, canvas.height);
            canvas.setAttribute('aria-label', '图片像素取色；方向键移动，Enter 选择');
            stage.hidden = false; empty.hidden = true; get('colorDropZone').hidden = true; loupe.hidden = true; marker.hidden = true;
            get('colorImageName').textContent = nextFile.name || restored?.name || '剪贴板图片';
            get('colorImageMeta').textContent = full.width + ' × ' + full.height + ' · ' + (nextFile.size / 1024).toFixed(nextFile.size >= 10240 ? 0 : 1) + ' KB';
            get('colorImageClear').disabled = false; onPalette([]);
            if (restored?.point && Number.isFinite(restored.point.x) && Number.isFinite(restored.point.y)) {
                point = { x: Math.max(0, Math.min(full.width - 1, Math.round(restored.point.x))), y: Math.max(0, Math.min(full.height - 1, Math.round(restored.point.y))) };
                selection = { ...point }; marker.hidden = false; positionMarker(point, marker);
            }
            // Cached identities can also belong to a duplicated or sleeping page; bounded cache eviction owns their lifetime.
            assetJob = restored ? Promise.resolve() : saveImageAsset(nextFile).then(id => {
                if (current(token)) assetId = id; else void removeImageAsset(id).catch(() => {});
            }).catch(() => { if (current(token)) { assetWarning = true; onStatus('图片可正常取色；本地缓存不可用，重新打开后需再次导入', 'warning'); } });
            await analyze(token);
        } catch (error) { if (current(token)) status(error?.message || '图片无法读取，请选择其他文件', 'error'); }
        finally { if (current(token)) { clearDecode(); stage.setAttribute('aria-busy', 'false'); } }
    }
    function clear() {
        version++; stopWorker(); clearDecode(); if (frame !== null) cancelAnimationFrame(frame); frame = null;
        assetId = null; dragging = false; activePointer = null;
        if (source) source.width = source.height = 0; source = null; file = null; selection = point = null; palette = [];
        canvas.width = canvas.height = 1; stage.hidden = true; empty.hidden = false; get('colorDropZone').hidden = false; loupe.hidden = marker.hidden = true;
        get('colorFileInput').value = ''; get('colorImageName').textContent = '尚未导入图片'; get('colorImageMeta').textContent = 'PNG、JPEG、WebP 等常用格式';
        get('colorImageClear').disabled = true; onPalette([]); status('图片已移除', 'idle');
    }
    const resize = new ResizeObserver(() => { loupe.hidden = true; if (source && selection) positionMarker(selection, marker); }); resize.observe(stage);
    signal.addEventListener('abort', () => {
        stopped = true; version++; stopWorker(); clearDecode(); resize.disconnect(); if (frame !== null) cancelAnimationFrame(frame);
        if (source) source.width = source.height = 0; source = null;
    }, { once: true });
    return { load, clear, flush: () => assetJob,
        serialize: () => file ? { assetId, name: file.name || '图片', point: selection ? { ...selection } : null } : null,
        async restore(value) {
            if (!value?.assetId) { if (value) status('重新导入图片即可继续取色，之前的颜色已保留', 'warning'); return; }
            const token = version;
            try { const saved = await loadImageAsset(value.assetId); if (!current(token)) return;
                if (saved) await load(saved, value); else status('图片缓存已释放，请重新导入；之前的颜色已保留', 'warning');
            } catch { if (!signal.aborted) status('图片缓存不可用，请重新导入', 'warning'); }
        }
    };
}
