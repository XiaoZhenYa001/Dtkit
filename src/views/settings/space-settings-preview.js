import { launcherFallbackIcon } from '../../desktop-organizer/launcher-icons.js';
import { applyGlassSettings, mountGlassMaterial } from '../../desktop-organizer/glass-material.js';

const FILES = [
    { id: 'folder', name: '项目资料', category: 'folder', is_folder: true },
    { id: 'plan', name: '项目计划.md', category: 'document', text: '# 项目计划\n\n周一 · 梳理想法与资料\n周三 · 完成第一版设计\n周五 · 分享本周进展\n\n让常用文件，触手可及。' },
    { id: 'coast', name: '海岸壁纸.png', category: 'image' },
    { id: 'app', name: '设计工具', category: 'program' },
    { id: 'notes', name: '会议记录.txt', category: 'document', text: '设计例会\n\n• 留出清晰的呼吸空间\n• 保持文件名称易读\n• 让常用操作更轻松\n\n下一步：整理素材，确认细节。' },
    { id: 'video', name: '演示视频.mp4', category: 'video' }
];
const FILTERS = [['all', '全部'], ['document', '文档'], ['image', '图片'], ['program', '应用']];
const DENSITIES = { small: '紧凑', medium: '标准', large: '宽松' };

export function spaceSettingsPreviewMarkup() {
    return `<section class="space-detail-preview" data-appearance="dark" aria-label="桌面空间实时演示">
        <header class="space-demo-heading"><div><strong>实时演示</strong><span>拖动下方设置，即时查看效果</span></div>
            <div class="space-demo-backgrounds" role="group" aria-label="演示背景">${[['light', '浅色'], ['dark', '深色'], ['mixed', '混合']].map(([value, label]) => `<button type="button" data-preview-background="${value}" aria-pressed="${value === 'mixed'}"><i aria-hidden="true"></i>${label}</button>`).join('')}</div>
        </header>
        <div class="space-demo-stage" data-preview-stage data-background="mixed">
            <div class="space-demo-wallpaper" aria-hidden="true"><span class="space-demo-desktop-label">09:41<small>留一点空间，给新的想法。</small></span><span class="space-demo-desktop-note"><i class="ri-file-text-line"></i>周计划</span><span class="space-demo-desktop-folder"><i class="ri-folder-2-line"></i>灵感</span></div>
            <div class="space-detail-preview-surface liquid-glass" data-appearance="dark" data-icon-size="medium" aria-label="示例桌面空间">
                <header class="space-demo-panel-heading"><strong><i class="ri-layout-grid-line" aria-hidden="true"></i><span>空间</span></strong><label class="space-detail-preview-search"><i class="ri-search-line" aria-hidden="true"></i><input data-preview-search aria-label="搜索示例文件" placeholder="搜索示例文件" autocomplete="off"></label></header>
                <nav class="space-demo-filters" aria-label="示例文件筛选">${FILTERS.map(([value, label]) => `<button type="button" data-preview-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('')}</nav>
                <div class="space-demo-grid" data-preview-grid aria-label="示例文件"></div>
                <footer class="space-demo-panel-footer"><span data-preview-count>6 个示例项目</span><span>空格预览</span></footer>
                <section class="space-demo-quick-look" data-preview-quick-look role="dialog" aria-modal="false" aria-label="示例文件预览" hidden><header><strong data-preview-file-title></strong><button type="button" data-preview-action="close-preview" aria-label="关闭示例文件预览">×</button></header><div class="space-demo-preview-content" data-preview-file-content></div></section>
            </div>
            <div class="space-demo-collapsed" data-preview-collapsed hidden><i class="ri-layout-grid-line" aria-hidden="true"></i><strong>示例空间已收起</strong><button type="button" data-preview-action="show">重新呼出</button></div>
        </div>
        <div class="space-demo-metrics"><span data-preview-dimensions>工作区的 90% × 70%</span><span data-preview-density>标准密度</span></div>
        <div class="space-demo-actions" role="group" aria-label="演示操作"><button type="button" data-preview-action="quick-look"><i class="ri-eye-line" aria-hidden="true"></i>预览文件</button><button type="button" data-preview-action="open"><i class="ri-external-link-line" aria-hidden="true"></i>演示打开</button><button type="button" data-preview-action="blur"><i class="ri-window-line" aria-hidden="true"></i>演示失焦</button></div>
        <p class="space-demo-feedback" data-preview-feedback role="status">选择示例文件，体验筛选、预览和收起行为。</p><small class="space-demo-caption">示例文件仅用于演示，不会打开真实文件。</small>
    </section>`;
}

export function mountSpaceSettingsPreview(root) {
    const surface = root.querySelector('.space-detail-preview-surface');
    const stage = root.querySelector('[data-preview-stage]');
    const grid = root.querySelector('[data-preview-grid]');
    const quickLook = root.querySelector('[data-preview-quick-look]');
    const feedback = root.querySelector('[data-preview-feedback]');
    const search = root.querySelector('[data-preview-search]');
    const controller = new AbortController();
    const { signal } = controller;
    let settings = {}, selected = 'plan', filter = 'all', background = 'mixed', animation = null, paintFrame = 0;
    const reduced = () => settings.reducedMotion === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const material = mountGlassMaterial(surface, { interactionTarget: surface, reducedMotion: reduced });
    const selectedFile = () => FILES.find(file => file.id === selected);
    const isVisible = () => !surface.hidden;
    const announce = message => { feedback.textContent = message; };
    const contentParts = [...surface.querySelectorAll('.space-demo-panel-heading,.space-demo-filters,[data-preview-grid],.space-demo-panel-footer')];
    function setQuickLookOpen(open) {
        quickLook.hidden = !open;
        for (const part of contentParts) part.inert = open;
    }
    function refreshInk() {
        if (paintFrame) window.cancelAnimationFrame(paintFrame);
        paintFrame = window.requestAnimationFrame(() => {
            paintFrame = 0;
            if (!isVisible()) return;
            const bounds = stage.getBoundingClientRect();
            for (const target of surface.querySelectorAll('[data-preview-file],.space-demo-panel-heading>strong,[data-preview-search],[data-preview-filter],.space-demo-panel-footer>span')) {
                const rect = (target.querySelector('.space-demo-file-name') || target).getBoundingClientRect();
                // Match the diagonal wallpaper at the label, rather than the
                // icon's center: lower rows cross the light/dark seam earlier.
                const angle = 117 * Math.PI / 180, dx = Math.sin(angle), dy = -Math.cos(angle);
                const projection = ((rect.left + rect.width / 2 - bounds.left) * dx
                    + (rect.top + rect.height / 2 - bounds.top) * dy) / (bounds.width * dx + bounds.height * dy);
                const bright = background === 'light' || background === 'mixed' && projection < .475;
                target.dataset.previewInk = bright ? 'light' : 'dark';
            }
        });
    }
    function select(id) {
        selected = id;
        for (const button of grid.querySelectorAll('[data-preview-file]')) button.setAttribute('aria-pressed', String(button.dataset.previewFile === id));
    }
    function renderFiles() {
        const query = search.value.trim().toLocaleLowerCase();
        const files = FILES.filter(file => (filter === 'all' || file.category === filter) && (!query || file.name.toLocaleLowerCase().includes(query)));
        if (!files.some(file => file.id === selected)) selected = files[0]?.id || '';
        grid.innerHTML = files.length ? files.map(file => `<button type="button" class="space-demo-file" data-preview-file="${file.id}" title="${file.name}" aria-label="${file.name}" aria-pressed="${file.id === selected}"><span class="space-demo-file-art" data-kind="${file.category}">${launcherFallbackIcon(file)}</span><span class="space-demo-file-name">${file.name}</span></button>`).join('') : '<p class="space-demo-empty">没有匹配的示例文件</p>';
        refreshInk();
        root.querySelector('[data-preview-count]').textContent = `${files.length} 个示例项目`;
        for (const action of ['quick-look', 'open']) root.querySelector(`[data-preview-action="${action}"]`).disabled = !selected || !isVisible();
    }
    function setVisible(visible) {
        animation?.cancel();
        surface.hidden = !visible;
        root.querySelector('[data-preview-collapsed]').hidden = visible;
        root.querySelector('[data-preview-action="blur"]').disabled = !visible;
        if (visible && !reduced()) animation = surface.animate([{ opacity: .25, transform: 'translateY(7px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.75,.25,1)' });
        if (!visible) setQuickLookOpen(false);
        renderFiles();
    }
    function previewFile() {
        const file = selectedFile();
        if (!file || !isVisible()) return;
        root.querySelector('[data-preview-file-title]').textContent = file.name;
        const content = root.querySelector('[data-preview-file-content]');
        if (file.text) {
            const text = document.createElement('pre'); text.textContent = file.text; content.replaceChildren(text);
        } else if (file.category === 'image') {
            content.innerHTML = '<div class="space-demo-coast" role="img" aria-label="蓝色海岸示例插画"><span></span><i></i></div>';
        } else {
            content.innerHTML = `<span class="space-demo-preview-art">${launcherFallbackIcon(file)}</span><p>${file.is_folder ? '示例资料夹 · 包含设计稿与参考素材' : file.category === 'program' ? '示例应用 · 用于体验选择与打开后的行为' : '示例视频 · 用于体验文件预览'}</p>`;
        }
        setQuickLookOpen(true);
        root.querySelector('[data-preview-action="close-preview"]').focus({ preventScroll: true });
        announce(`正在预览「${file.name}」。`);
    }
    function closePreview() {
        setQuickLookOpen(false);
        grid.querySelector(`[data-preview-file="${selected}"]`)?.focus({ preventScroll: true });
    }
    function openFile() {
        const file = selectedFile();
        if (!file || !isVisible()) return;
        if (settings.closeAfterOpen) {
            setVisible(false);
            announce(`已演示打开「${file.name}」：开启了“打开后收起”，示例空间随之收起。`);
        } else announce(`已演示打开「${file.name}」：关闭了“打开后收起”，示例空间保持显示。`);
    }
    root.addEventListener('click', event => {
        const backgroundButton = event.target.closest('[data-preview-background]');
        if (backgroundButton) {
            background = backgroundButton.dataset.previewBackground;
            stage.dataset.background = background;
            root.dataset.appearance = surface.dataset.appearance = background === 'light' ? 'light' : 'dark';
            for (const button of root.querySelectorAll('[data-preview-background]')) button.setAttribute('aria-pressed', String(button === backgroundButton));
            refreshInk();
            announce(`已切换到${backgroundButton.textContent.trim()}背景，可查看玻璃边缘与文字的对比。`);
            return;
        }
        const filterButton = event.target.closest('[data-preview-filter]');
        if (filterButton) {
            filter = filterButton.dataset.previewFilter;
            for (const button of root.querySelectorAll('[data-preview-filter]')) button.setAttribute('aria-pressed', String(button === filterButton));
            setQuickLookOpen(false); renderFiles(); return;
        }
        const fileButton = event.target.closest('[data-preview-file]');
        if (fileButton) { select(fileButton.dataset.previewFile); announce(`已选择「${selectedFile().name}」，按空格预览，按 Enter 演示打开。`); return; }
        const action = event.target.closest('[data-preview-action]')?.dataset.previewAction;
        if (action === 'quick-look') previewFile();
        if (action === 'close-preview') closePreview();
        if (action === 'open') openFile();
        if (action === 'blur') {
            if (settings.closeOnBlur) { setVisible(false); announce('已演示切换到其他窗口：开启了“失去焦点时收起”，示例空间随之收起。'); }
            else announce('已演示切换到其他窗口：关闭了“失去焦点时收起”，示例空间保持显示。');
        }
        if (action === 'show') { setVisible(true); announce('示例空间已重新呼出，继续选择文件或调整设置。'); }
    }, { signal });
    grid.addEventListener('dblclick', event => { if (event.target.closest('[data-preview-file]')) openFile(); }, { signal });
    grid.addEventListener('keydown', event => {
        if (!event.target.closest('[data-preview-file]') || event.isComposing) return;
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            select(event.target.closest('[data-preview-file]').dataset.previewFile);
            if (event.key === ' ') previewFile(); else openFile();
        }
    }, { signal });
    quickLook.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePreview(); } }, { signal });
    search.addEventListener('input', () => { setQuickLookOpen(false); renderFiles(); }, { signal });
    const resizeObserver = new ResizeObserver(refreshInk);
    resizeObserver.observe(stage);
    renderFiles();
    return {
        update(values) {
            settings = { ...values };
            applyGlassSettings(surface, settings);
            surface.dataset.iconSize = settings.iconSize;
            surface.style.width = `${settings.windowWidth}%`;
            surface.style.height = `${settings.windowHeight}%`;
            root.querySelector('[data-preview-dimensions]').textContent = `工作区的 ${settings.windowWidth}% × ${settings.windowHeight}%`;
            root.querySelector('[data-preview-density]').textContent = `${DENSITIES[settings.iconSize] || '标准'}密度`;
            if (reduced()) animation?.cancel();
            material.refresh(); refreshInk();
        },
        destroy() { controller.abort(); resizeObserver.disconnect(); animation?.cancel(); if (paintFrame) window.cancelAnimationFrame(paintFrame); material.destroy(); }
    };
}
