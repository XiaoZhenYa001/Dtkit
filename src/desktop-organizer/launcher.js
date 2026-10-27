import {
    LAUNCHER_STORAGE_KEY, collectLauncherFiles, launcherFileId, launcherFolderScope,
    migrateLauncherPreferences, readLauncherPreferences, normalizeLauncherPreferences, orderedLauncherFiles,
    reorderLauncherFiles, setLauncherPinned
} from './launcher-model.js';
import { createLauncherMotion } from './launcher-motion.js';
import { createIconHydrator } from './icon-hydration.js';
import { formatFileSize } from './views/file-view.js';
import { launcherFallbackIcon } from './launcher-icons.js';
import { desktopSnapshotFingerprint, readDesktopSnapshot, writeDesktopSnapshot } from './snapshot.js';
import { getLauncherOptions } from './launcher-appearance.js';
import { mountPdfPreview } from './launcher-pdf-preview.js';

const { invoke } = window.__TAURI__.core;
const root = document.getElementById('launcher');
const $ = selector => root.querySelector(selector);
const search = $('#spaceSearch'), lists = $('#spaceLists'), fileGrid = $('#fileGrid'), pinnedGrid = $('#pinnedGrid');
const filters = $('.launcher-filters'), breadcrumb = $('.launcher-breadcrumb'), status = $('#spaceStatus');
const preview = $('#filePreview'), previewContent = $('#previewContent'), menu = $('#fileMenu');
const background = $('.launcher-inner');
const nodes = new Map(), unlisteners = [];
const iconSources = new WeakMap();
let iconRevision = 0;
let previewReturnId = '', menuReturnId = '', disposePdfPreview = null;
const state = {
    files: [], folders: [], filter: 'all', query: '', selected: '', activeId: '', visible: false,
    previewFile: null, previewOpen: false, previewRevision: 0, folderRevision: 0,
    scan: null, scanPromise: null, scanDirty: true, openPromise: null, drag: null,
    pendingRender: false, menuFile: null, poll: null, destroyed: false, nativeSession: null
};
let preferences = normalizeLauncherPreferences({}), preferencesWritable = false, metadataError = '', closeRevision = 0, previewMotionRevision = 0;
let groupCache = null, pinCache = null;
let composing = false;
let backdropGrid = null, contrastFrame = 0;
const contrastMedia = window.matchMedia('(prefers-contrast: more), (prefers-reduced-transparency: reduce)');
const hydrator = createIconHydrator({ invoke, document, window });
const motion = createLauncherMotion({
    root, panel: root, material: $('.launcher-material'), inner: $('.launcher-inner'), lists,
    reducedMotion: () => getLauncherOptions().reducedMotion === true
});
const keyboardHelp = document.createElement('p');
keyboardHelp.id = 'spaceKeyboardHelp'; keyboardHelp.hidden = true;
keyboardHelp.textContent = '方向键切换当前项目，Enter 打开，空格预览，Shift+F10 打开操作菜单，可固定或取消固定；Tab 离开文件区。';
lists.append(keyboardHelp);
for (const [grid, label] of [[pinnedGrid, '固定项目'], [fileGrid, '文件与应用']]) {
    grid.setAttribute('role', 'list'); grid.setAttribute('aria-label', label);
}
menu.setAttribute('role', 'menu');
for (const item of menu.children) if (!item.hasAttribute('role')) item.setAttribute('role', 'none');
for (const button of menu.querySelectorAll('button')) button.setAttribute('role', 'menuitem');

function setStatus(message, error = false) {
    status.textContent = message; status.dataset.error = String(error);
}
function scheduleBackdropInk() {
    if (contrastFrame || !state.visible || state.destroyed) return;
    contrastFrame = requestAnimationFrame(() => {
        contrastFrame = 0;
        if (!state.visible || state.destroyed) return;
        const width = root.clientWidth, height = root.clientHeight;
        if (!width || !height) return;
        for (const target of root.querySelectorAll('.launcher-card[data-id],.launcher-header h1,.launcher-search,.launcher-search kbd,.launcher-header .icon-button,.launcher-filters,.launcher-breadcrumb button,#folderName,#spaceStatus,.launcher-hints')) {
            if (!backdropGrid || document.documentElement.dataset.nativeBackdrop === 'unavailable' || contrastMedia.matches) {
                delete target.dataset.ink;
                for (const name of ['--space-ink', '--space-muted', '--space-blue', '--space-glyph', '--space-text-shadow']) target.style.removeProperty(name);
                continue;
            }
            // Layout offsets exclude the spring/FLIP transforms, so a moving
            // card receives the ink for its destination. No backdrop is copied.
            let x = target.classList.contains('launcher-search') ? Math.min(44, target.offsetWidth / 2) : target.offsetWidth / 2;
            let y = target.offsetHeight / 2;
            for (let node = target; node && node !== root; node = node.offsetParent) {
                x += node.offsetLeft; y += node.offsetTop;
            }
            if (lists.contains(target)) y -= lists.scrollTop;
            const gx = Math.max(0, Math.min(8, (x / width - .05) / .1125));
            const gy = Math.max(0, Math.min(4, (y / height - .05) / .225));
            const ix = Math.min(7, Math.floor(gx)), iy = Math.min(3, Math.floor(gy));
            const mix = (a, b, ratio) => a + (b - a) * ratio;
            const value = mix(mix(backdropGrid[iy * 9 + ix], backdropGrid[iy * 9 + ix + 1], gx - ix),
                mix(backdropGrid[(iy + 1) * 9 + ix], backdropGrid[(iy + 1) * 9 + ix + 1], gx - ix), gy - iy);
            const light = value > .28, ink = light ? 'light' : 'dark';
            if (target.dataset.ink === ink) continue;
            target.dataset.ink = ink;
            target.style.setProperty('--space-ink', light ? '#202b3b' : '#f4f6fb');
            target.style.setProperty('--space-muted', light ? '#28394dd1' : '#dae1edc7');
            target.style.setProperty('--space-blue', light ? '#286da6' : '#b9ddff');
            target.style.setProperty('--space-glyph', light ? '#526980' : '#eff6ff');
            target.style.setProperty('--space-text-shadow', light ? '0 1px 1px #ffffff40' : '0 1px 3px #0008');
        }
    });
}
function fileKind(file) {
    if (file.is_folder) return 'folder';
    if (file.app_id || file.category === 'program') return 'app';
    return ['document', 'image'].includes(file.category) ? file.category : 'other';
}
function scope() { return state.folders.length ? launcherFolderScope(state.folders.at(-1).path) : 'root'; }
function currentFiles() { return state.folders.length ? state.folders.at(-1).items : state.files; }
function pinnedIndex() {
    if (pinCache?.preferences !== preferences) pinCache = { preferences,
        ids: new Set(preferences.pinned.map(launcherFileId)), paths: new Set(preferences.pinned.map(file => launcherFolderScope(file.path))) };
    return pinCache;
}
function isPinned(file) {
    const index = pinnedIndex();
    return index.ids.has(launcherFileId(file)) || index.paths.has(launcherFolderScope(file.path));
}
function knownFile(id) {
    return currentFiles().find(file => launcherFileId(file) === id)
        || state.files.find(file => launcherFileId(file) === id)
        || preferences.pinned.find(file => launcherFileId(file) === id);
}
function matches(file) {
    return (state.filter === 'all' || fileKind(file) === state.filter)
        && (!state.query || file.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
}
function groups({ filtered = true } = {}) {
    const atRoot = !state.folders.length;
    const files = currentFiles(), key = scope();
    // Search and category filters reuse sorted lanes. A scan, folder read or
    // preference transaction replaces its array/object and invalidates this cache.
    if (!groupCache || groupCache.rootFiles !== state.files || groupCache.files !== files
        || groupCache.preferences !== preferences || groupCache.scope !== key) {
        const live = new Map(state.files.map(file => [launcherFileId(file), file]));
        const livePaths = new Map(state.files.map(file => [launcherFolderScope(file.path), file]));
        const pins = atRoot ? preferences.pinned.map(file => live.get(launcherFileId(file)) || livePaths.get(launcherFolderScope(file.path)) || file) : [];
        const pinnedIds = new Set(pins.map(launcherFileId));
        const pinnedPaths = new Set(pins.map(file => launcherFolderScope(file.path)));
        groupCache = { rootFiles: state.files, files, preferences, scope: key,
            pinned: orderedLauncherFiles(pins, preferences, 'pinned'),
            ordered: orderedLauncherFiles(files, preferences, key).filter(file => !atRoot || !pinnedIds.has(launcherFileId(file)) && !pinnedPaths.has(launcherFolderScope(file.path))) };
    }
    return {
        pinned: groupCache.pinned.filter(file => !filtered || matches(file)),
        files: groupCache.ordered.filter(file => !filtered || matches(file))
    };
}
function savePreferences(next) {
    if (!preferencesWritable) {
        setStatus(metadataError || '固定与排序设置暂时只读，原数据已保留；重新打开空间后可重试。', true);
        return false;
    }
    const normalized = normalizeLauncherPreferences(next);
    try {
        // A failed legacy migration must finish its backup before a user edit
        // can replace v2; a transient failure never discards the loaded state.
        if (localStorage.getItem(LAUNCHER_STORAGE_KEY) === null) migrateLauncherPreferences(localStorage);
        else readLauncherPreferences(localStorage);
        localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify(normalized));
        preferences = normalized; metadataError = ''; return true;
    } catch (error) {
        setStatus(`无法保存固定与排序设置 · ${String(error)}`, true); return false;
    }
}
function updateNode(node, file, lane) {
    const id = launcherFileId(file), button = node.querySelector('.launcher-file'), pin = node.querySelector('.pin-button');
    node.dataset.id = id; node.dataset.lane = lane; node.dataset.selected = String(state.selected === id);
    node.draggable = true;
    button.tabIndex = -1; pin.tabIndex = -1;
    const previousIcon = iconSources.get(button), source = file.icon || null;
    if (button.dataset.path !== file.path || previousIcon?.source !== source || previousIcon?.revision !== iconRevision) {
        button.removeAttribute('data-icon-loaded');
        const holder = button.querySelector('.file-icon');
        holder.classList.remove('file-icon-real');
        holder.innerHTML = launcherFallbackIcon(file);
        if (source) {
            const image = document.createElement('img'); image.src = source; image.alt = ''; image.className = 'file-icon-img';
            holder.classList.add('file-icon-real'); holder.replaceChildren(image); button.dataset.iconLoaded = 'true';
        } else if (fileKind(file) === 'document') {
            const ext = document.createElement('span'); ext.className = 'file-extension';
            ext.textContent = (file.extension || file.name.split('.').pop() || '').slice(0, 6).toUpperCase(); holder.append(ext);
        }
        iconSources.set(button, { source, revision: iconRevision });
    }
    button.dataset.path = file.path; button.dataset.name = file.name; button.dataset.isFolder = String(file.is_folder === true);
    if (file.app_id) button.dataset.appId = file.app_id; else delete button.dataset.appId;
    if (!file.app_id && file.category === 'program') button.dataset.iconKind = 'file'; else delete button.dataset.iconKind;
    button.querySelector('.file-icon').dataset.kind = fileKind(file);
    const artwork = button.querySelector('.file-art');
    artwork.dataset.kind = fileKind(file); artwork.dataset.media = file.category || 'other';
    button.querySelector('.file-name').textContent = file.name; button.title = file.name;
    const pinned = isPinned(file);
    pin.setAttribute('aria-pressed', String(pinned)); pin.setAttribute('aria-label', `${pinned ? '取消固定' : '固定'} ${file.name}`);
    pin.title = pinned ? '取消固定' : '固定到空间';
}
function cardFor(file, lane) {
    const id = launcherFileId(file);
    let node = nodes.get(id);
    if (!node) {
        node = document.createElement('article'); node.className = 'launcher-card';
        node.setAttribute('role', 'listitem');
        node.innerHTML = '<button class="launcher-file file-item" type="button" draggable="false" tabindex="-1" aria-describedby="spaceKeyboardHelp" aria-haspopup="menu" aria-controls="fileMenu" aria-keyshortcuts="Enter Space Shift+F10"><span class="file-art glass-icon-tile"><span class="file-icon"></span></span><span class="file-name"></span></button><button type="button" class="pin-button" draggable="false" tabindex="-1"><i class="ri-pushpin-line" aria-hidden="true"></i></button>';
        node.addEventListener('dragstart', event => startDrag(event, node));
        node.addEventListener('dragend', finishDrag);
        nodes.set(id, node);
    }
    updateNode(node, file, lane); return node;
}
function syncGrid(grid, files, lane) {
    const ids = new Set(files.map(launcherFileId));
    for (const node of [...grid.children]) if (!ids.has(node.dataset.id)) node.remove();
    files.forEach((file, index) => {
        const node = cardFor(file, lane);
        if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
    });
    grid.dataset.lane = lane;
}
function releaseDetachedCards() {
    for (const [id, node] of nodes) {
        if (node.isConnected) continue;
        motion.cancel(node);
        nodes.delete(id);
    }
}
function syncFileNavigation(preferredId = state.activeId) {
    const cards = [...lists.querySelectorAll('.launcher-card[data-id]')];
    const ids = new Set(cards.map(node => node.dataset.id));
    state.activeId = ids.has(preferredId) ? preferredId : ids.has(state.selected) ? state.selected : cards[0]?.dataset.id || '';
    if (state.selected && !ids.has(state.selected)) state.selected = state.activeId;
    for (const node of cards) {
        const current = node.dataset.id === state.selected, button = node.querySelector('.launcher-file');
        button.tabIndex = node.dataset.id === state.activeId ? 0 : -1;
        button.setAttribute('aria-current', String(current));
        node.dataset.selected = String(current);
    }
}
function render({ instant = false, preserveStatus = false } = {}) {
    if (state.drag) { state.pendingRender = true; return; }
    const focusedId = document.activeElement?.closest('.launcher-card[data-id]')?.dataset.id;
    const visible = groups(), total = visible.pinned.length + visible.files.length;
    motion.layout(() => {
        syncGrid(pinnedGrid, visible.pinned, 'pinned'); syncGrid(fileGrid, visible.files, scope());
        $('#pinnedSection').hidden = !visible.pinned.length; $('#filesTitle').hidden = !visible.pinned.length;
        $('#spaceEmpty').hidden = total > 0;
        $('#emptyMessage').textContent = state.query ? '没有找到匹配的文件' : state.folders.length ? '这个文件夹是空的' : state.filter !== 'all' ? '这个类别还没有文件' : '桌面上还没有可显示的文件';
        filters.hidden = state.folders.length > 0; breadcrumb.hidden = !state.folders.length;
        $('#folderName').textContent = state.folders.at(-1)?.name || '';
        const trail = $('#folderTrail'); trail.replaceChildren();
        state.folders.slice(0, -1).forEach((folder, depth) => {
            const separator = document.createElement('span'); separator.textContent = '/'; separator.setAttribute('aria-hidden', 'true');
            const button = document.createElement('button'); button.type = 'button'; button.textContent = folder.name;
            button.title = folder.path; button.dataset.depth = String(depth); trail.append(separator, button);
        });
        const folder = state.folders.at(-1), summary = $('#folderSummary');
        summary.hidden = !folder?.truncated;
        summary.textContent = folder?.truncated ? `已加载 ${folder.items.length} 项，共 ${folder.totalCount} 项。搜索仅覆盖已加载内容，可在资源管理器中查看全部。` : '';
        for (const button of filters.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }, { instant });
    syncFileNavigation(focusedId || state.activeId);
    releaseDetachedCards();
    if (focusedId && !background.inert && !root.inert) restoreFileFocus(state.activeId);
    scheduleBackdropInk();
    motion.indicator(filters, filters.querySelector(`[data-filter="${state.filter}"]`), instant);
    hydrator.hydrate(root);
    if (!preserveStatus) {
        const file = knownFile(state.selected);
        setStatus(metadataError || (file ? `${file.name}${file.is_folder ? ' · 文件夹' : formatFileSize(file.size) ? ` · ${formatFileSize(file.size)}` : ''}` : `${total} 个项目`), !!metadataError);
    }
}
function select(id, focus = false) {
    const file = knownFile(id); if (!file) return;
    state.selected = id;
    syncFileNavigation(id);
    setStatus(`${file.name}${file.is_folder ? ' · 文件夹' : formatFileSize(file.size) ? ` · ${formatFileSize(file.size)}` : ''}`);
    if (focus) nodes.get(id)?.querySelector('.launcher-file').focus({ preventScroll: true });
}
function restoreFileFocus(id) {
    const target = nodes.get(id)?.querySelector('.launcher-file');
    if (target?.isConnected && !background.inert) target.focus({ preventScroll: true });
    else if (state.visible && !root.inert) search.focus({ preventScroll: true });
}
function closeMenu({ restoreFocus = false } = {}) {
    const id = menuReturnId;
    menu.hidden = true; state.menuFile = null; menuReturnId = '';
    if (restoreFocus) restoreFileFocus(id);
}
function togglePin(file) {
    if (!file || !savePreferences(setLauncherPinned(preferences, file, !isPinned(file)))) return;
    closeMenu(); render();
}
async function scan({ force = false } = {}) {
    if (state.scanPromise) return state.scanPromise;
    if (!force && !state.scanDirty && state.files.length) return;
    state.scanDirty = false;
    $('#refreshSpace').disabled = true;
    const previous = state.scan;
    const operation = (async () => {
        try {
            const result = await invoke('desktop_scan');
            if (state.destroyed) return;
            const changed = desktopSnapshotFingerprint(result) !== desktopSnapshotFingerprint(state.scan);
            state.scan = result; state.files = collectLauncherFiles(result);
            if (changed) { writeDesktopSnapshot(localStorage, result); render(); }
            else if (force && !state.previewOpen) render({ instant: true });
        } catch (error) {
            state.scanDirty = true;
            if (!previous && !state.files.length) $('#emptyMessage').textContent = '暂时无法读取文件，可点击刷新重试';
            setStatus(`读取文件失败 · ${String(error)}`, true);
        } finally { $('#refreshSpace').disabled = false; }
    })();
    state.scanPromise = operation;
    try { await operation; } finally { if (state.scanPromise === operation) state.scanPromise = null; }
}
function startPolling() {
    clearInterval(state.poll);
    state.poll = setInterval(() => { if (state.visible && !state.drag && !state.previewOpen && !state.folders.length) void scan({ force: true }); }, 15_000);
}
async function reveal(payload = {}) {
    if (Number.isSafeInteger(payload.session)) {
        if (state.nativeSession !== null && payload.session < state.nativeSession) return;
        state.nativeSession = payload.session;
    }
    if (typeof payload.lightBackground === 'boolean') {
        document.documentElement.dataset.appearance = payload.lightBackground ? 'light' : 'dark';
    }
    if (Array.isArray(payload.backgroundLuminance) && payload.backgroundLuminance.length === 45
        && payload.backgroundLuminance.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        backdropGrid = payload.backgroundLuminance;
    }
    closeRevision++; state.visible = true; root.inert = false; root.setAttribute('aria-hidden', 'false');
    scheduleBackdropInk();
    closeMenu(); startPolling();
    void motion.setOpen(true, { instant: payload.reducedMotion === true }); search.focus({ preventScroll: true });
    await scan({ force: state.scanDirty });
}
async function dismiss({ instant = false } = {}) {
    if (!state.visible) return;
    const revision = ++closeRevision, session = state.nativeSession;
    state.visible = false; state.folderRevision++; clearInterval(state.poll); state.poll = null;
    closeMenu(); await closePreview({ instant: true }); root.inert = true; root.setAttribute('aria-hidden', 'true');
    if (revision !== closeRevision || state.visible || state.destroyed) return;
    // Native hide runs the matching backdrop exit and owns the final deadline,
    // so a suspended renderer cannot leave the glass window on the desktop.
    void motion.setOpen(false, { instant });
    try { await invoke('desktop_space_hide', session === null ? {} : { session }); }
    catch (error) { if (revision === closeRevision) { state.visible = true; root.inert = false; root.setAttribute('aria-hidden', 'false'); void motion.setOpen(true); setStatus(`收起失败 · ${String(error)}`, true); } }
}
async function browse(file) {
    if (!file?.is_folder) return;
    const revision = ++state.folderRevision;
    setStatus(`正在读取 ${file.name}…`);
    try {
        const result = await invoke('desktop_list_folder', { path: file.path });
        if (revision !== state.folderRevision || !state.visible) return;
        await closePreview({ instant: true });
        if (state.folders.length) state.folders.at(-1).scroll = lists.scrollTop;
        state.folders.push({ path: result.path || file.path, name: result.name || file.name, items: Array.isArray(result.items) ? result.items : [], scroll: 0, truncated: result.truncated === true, totalCount: result.total_count ?? result.items?.length ?? 0 });
        state.query = ''; search.value = ''; state.filter = 'all'; state.selected = ''; lists.scrollTop = 0; closeMenu(); render();
    } catch (error) { if (revision === state.folderRevision) setStatus(`无法进入文件夹 · ${String(error)}`, true); }
}
function back({ toRoot = false } = {}) {
    state.folderRevision++;
    if (!state.folders.length) return;
    if (toRoot) state.folders.length = 0; else state.folders.pop();
    state.query = ''; search.value = ''; state.selected = ''; state.filter = 'all'; render();
    lists.scrollTop = state.folders.at(-1)?.scroll || 0;
}
async function open(file) {
    if (!file || state.openPromise) return;
    if (file.is_folder) { await browse(file); return; }
    const session = closeRevision;
    const operation = (async () => {
        try { await invoke(file.app_id ? 'desktop_open_app' : 'desktop_open_file', { path: file.path }); if (session === closeRevision && state.visible && getLauncherOptions().closeAfterOpen !== false) await dismiss(); }
        catch (error) { if (session === closeRevision) setStatus(`打开失败 · ${String(error)}`, true); }
    })();
    state.openPromise = operation;
    try { await operation; } finally { if (state.openPromise === operation) state.openPromise = null; }
}
function previewOrigin(file) { return nodes.get(launcherFileId(file))?.querySelector('.file-art').getBoundingClientRect(); }
function previewTransform(file) {
    const rect = preview.getBoundingClientRect(), source = previewOrigin(file);
    if (!source?.width || !rect.width) return 'translateY(12px) scale(.94)';
    return `translate(${source.x + source.width / 2 - rect.x - rect.width / 2}px,${source.y + source.height / 2 - rect.y - rect.height / 2}px) scale(${Math.max(.06, source.width / rect.width)},${Math.max(.06, source.height / rect.height)})`;
}
function animatePreview(opened, file, instant = false) {
    const token = ++previewMotionRevision, material = $('.preview-material'), inner = $('.preview-inner'), hidden = preview.hidden;
    if (opened) preview.hidden = false;
    if (!opened && hidden) return Promise.resolve();
    const pose = previewTransform(file), from = hidden ? pose : getComputedStyle(material).transform, fromOpacity = hidden ? 0 : getComputedStyle(material).opacity;
    const textOpacity = hidden ? 0 : getComputedStyle(inner).opacity;
    motion.cancel(material); motion.cancel(inner);
    material.style.transform = opened ? 'none' : pose; material.style.opacity = opened ? '1' : '0'; inner.style.opacity = opened ? '1' : '0';
    if (instant || motion.reduced()) { if (!opened) { preview.hidden = true; clearPreviewContent(); } return Promise.resolve(); }
    return new Promise(resolve => {
        motion.animate(material, [{ transform: from, opacity: fromOpacity }, { transform: opened ? 'none' : pose, opacity: opened ? 1 : 0 }], { duration: opened ? 340 : 220, easing: 'cubic-bezier(.2,.8,.2,1)' }, () => { if (token === previewMotionRevision && !state.previewOpen) { preview.hidden = true; clearPreviewContent(); } resolve(); });
        motion.animate(inner, [{ opacity: textOpacity }, { opacity: opened ? 1 : 0 }], { duration: opened ? 200 : 100, delay: opened && hidden ? 50 : 0, easing: 'ease-out' });
    });
}
function clearPreviewContent() {
    disposePdfPreview?.(); disposePdfPreview = null;
    previewContent.replaceChildren();
}
function previewMessage(message, path = '') {
    const wrapper = document.createElement('div'); wrapper.className = 'preview-metadata';
    const icon = document.createElement('i'); icon.className = 'ri-file-text-line'; icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('p'); text.textContent = message; wrapper.append(icon, text);
    if (path) { const code = document.createElement('code'); code.textContent = path; wrapper.append(code); }
    clearPreviewContent(); previewContent.append(wrapper);
}
function renderPreview(result) {
    $('#previewName').textContent = result.name || state.previewFile?.name || '快速预览';
    $('#previewDetails').textContent = [result.extension?.toUpperCase(), formatFileSize(result.size || 0)].filter(Boolean).join(' · ');
    clearPreviewContent();
    if (result.kind === 'text') { const pre = document.createElement('pre'); pre.textContent = result.text || ''; previewContent.append(pre); }
    else if (result.kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,/i.test(result.dataUrl || '')) {
        const image = document.createElement('img'); image.alt = result.name || '图像预览'; image.src = result.dataUrl;
        image.addEventListener('error', () => previewMessage('无法解码此图像，可以用默认应用打开。'), { once: true }); previewContent.append(image);
    } else if (result.kind === 'pdf' && /^data:application\/pdf;base64,/i.test(result.dataUrl || '')) {
        disposePdfPreview = mountPdfPreview(previewContent, result.dataUrl, {
            name: result.name || 'PDF 预览',
            onError: error => previewMessage(`无法读取 PDF：${String(error)}，可使用默认应用打开。`)
        });
    } else previewMessage(result.message || '此格式暂不支持内容预览，可以用默认应用打开。', result.path || '');
}
async function showPreview(file) {
    if (!file) return;
    const revision = ++state.previewRevision;
    previewReturnId = launcherFileId(file);
    state.previewFile = file; state.previewOpen = true; root.dataset.preview = 'true'; closeMenu();
    background.inert = true;
    $('#previewName').textContent = file.name; $('#previewDetails').textContent = '正在读取预览…';
    $('#previewOpen').textContent = file.is_folder ? '进入文件夹' : '打开文件'; previewMessage('正在读取预览…');
    void animatePreview(true, file); $('#previewClose').focus({ preventScroll: true });
    try {
        let result;
        if (file.app_id) result = { ...file, kind: 'metadata', extension: '应用程序', message: '应用程序入口，可直接启动或在文件夹中显示。' };
        else if (file.is_folder) {
            const folder = await invoke('desktop_list_folder', { path: file.path });
            result = { ...file, kind: 'metadata', message: `${folder.total_count ?? folder.items?.length ?? 0} 个项目${folder.items?.length ? `：${folder.items.slice(0, 12).map(item => item.name).join('、')}` : ''}${folder.truncated ? '（内容已截取）' : ''}` };
        } else result = await invoke('desktop_preview_file', { path: file.path });
        if (revision !== state.previewRevision || !state.previewOpen || state.destroyed) return;
        renderPreview(result);
    } catch (error) {
        if (revision !== state.previewRevision || !state.previewOpen) return;
        $('#previewDetails').textContent = '无法预览'; previewMessage(String(error), file.path);
    }
}
function closePreview({ instant = false, restoreFocus = false } = {}) {
    state.previewRevision++; state.previewOpen = false; root.dataset.preview = 'false';
    background.inert = false;
    if (restoreFocus) restoreFileFocus(previewReturnId);
    previewReturnId = '';
    disposePdfPreview?.(); disposePdfPreview = null;
    const file = state.previewFile;
    if (!file || preview.hidden) return Promise.resolve();
    return animatePreview(false, file, instant);
}
function showMenu(event, file, { keyboard = false } = {}) {
    event.preventDefault(); if (!file) return;
    menuReturnId = launcherFileId(file);
    select(menuReturnId); state.menuFile = file; menu.hidden = false;
    menu.querySelector('[data-action=pin]').textContent = isPinned(file) ? '取消固定' : '固定到空间';
    const bounds = root.getBoundingClientRect(), size = menu.getBoundingClientRect();
    const anchor = keyboard ? nodes.get(menuReturnId)?.getBoundingClientRect() : null;
    const x = anchor ? anchor.x + Math.min(24, anchor.width / 2) : event.clientX;
    const y = anchor ? anchor.bottom : event.clientY;
    menu.style.left = `${Math.max(8, Math.min(x - bounds.x, bounds.width - size.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y - bounds.y, bounds.height - size.height - 8))}px`;
    menu.querySelector('button').focus({ preventScroll: true });
}
function clearDrop() { root.querySelectorAll('.drop-before,.drop-at-end').forEach(node => node.classList.remove('drop-before', 'drop-at-end')); }
function startDrag(event, node) {
    if (!event.dataTransfer || state.previewOpen) { event.preventDefault(); return; }
    state.drag = { id: node.dataset.id, lane: node.dataset.lane, before: null }; closeMenu();
    event.dataTransfer.setData('application/x-dtkit-space-item', node.dataset.id); event.dataTransfer.effectAllowed = 'move';
    node.classList.add('is-dragging'); setStatus('拖动调整此区域的顺序，原文件位置保持不变');
}
function finishDrag() {
    state.drag = null; clearDrop(); root.querySelectorAll('.is-dragging').forEach(node => node.classList.remove('is-dragging'));
    if (state.pendingRender) { state.pendingRender = false; render(); }
}
for (const grid of [pinnedGrid, fileGrid]) {
    grid.addEventListener('dragover', event => {
        if (!state.drag || state.drag.lane !== grid.dataset.lane) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; clearDrop();
        const target = event.target.closest('.launcher-card[data-id]');
        if (target?.dataset.id === state.drag.id) { state.drag.before = state.drag.id; return; }
        if (!target) { state.drag.before = null; grid.classList.add('drop-at-end'); return; }
        const rect = target.getBoundingClientRect();
        const before = event.clientX < rect.x + rect.width / 2 ? target : target.nextElementSibling;
        state.drag.before = before?.dataset.id || null;
        if (before) before.classList.add('drop-before'); else grid.classList.add('drop-at-end');
    });
    grid.addEventListener('drop', event => {
        if (!state.drag || state.drag.lane !== grid.dataset.lane) return;
        event.preventDefault();
        const drag = state.drag, ids = [...grid.children].map(node => node.dataset.id);
        const all = groups({ filtered: false });
        const next = reorderLauncherFiles(preferences, drag.lane, drag.id, drag.before, ids, drag.lane === 'pinned' ? all.pinned : all.files);
        state.drag = null; clearDrop(); root.querySelectorAll('.is-dragging').forEach(node => node.classList.remove('is-dragging'));
        if (savePreferences(next)) render();
    });
}
root.addEventListener('dragover', event => { if (!state.drag) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; } });
root.addEventListener('drop', event => { event.preventDefault(); });
lists.addEventListener('focusin', event => {
    const button = event.target.closest('.launcher-file');
    if (button) select(button.closest('.launcher-card').dataset.id);
});
lists.addEventListener('click', event => {
    const node = event.target.closest('.launcher-card[data-id]'); if (!node) return;
    const file = knownFile(node.dataset.id);
    if (event.target.closest('.pin-button')) togglePin(file); else if (event.target.closest('.launcher-file')) select(node.dataset.id);
});
lists.addEventListener('dblclick', event => {
    if (!event.target.closest('.launcher-file')) return;
    void open(knownFile(event.target.closest('.launcher-card')?.dataset.id));
});
lists.addEventListener('contextmenu', event => showMenu(event, knownFile(event.target.closest('.launcher-card')?.dataset.id)));
filters.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]'); if (!button || state.filter === button.dataset.filter) return;
    state.filter = button.dataset.filter; state.selected = ''; lists.scrollTop = 0; closeMenu(); render();
});
function applySearch() { state.query = search.value.trim(); state.selected = ''; lists.scrollTop = 0; closeMenu(); render(); }
search.addEventListener('compositionstart', () => { composing = true; });
search.addEventListener('compositionend', () => { composing = false; applySearch(); });
search.addEventListener('input', () => { if (!composing) applySearch(); });
$('#closeSpace').addEventListener('click', () => void dismiss());
$('#refreshSpace').addEventListener('click', () => {
    if (state.folders.length) {
        const file = state.folders.at(-1), revision = ++state.folderRevision;
        void invoke('desktop_list_folder', { path: file.path }).then(result => {
            if (revision !== state.folderRevision || !state.visible) return;
            file.items = result.items || []; file.truncated = result.truncated === true;
            file.totalCount = result.total_count ?? file.items.length; render();
        }).catch(error => setStatus(`刷新失败 · ${String(error)}`, true));
    } else void scan({ force: true });
});
$('#folderBack').addEventListener('click', () => back());
$('#folderRoot').addEventListener('click', () => back({ toRoot: true }));
$('#folderTrail').addEventListener('click', event => {
    const button = event.target.closest('[data-depth]'); if (!button) return;
    state.folderRevision++; state.folders.length = Number(button.dataset.depth) + 1;
    state.query = ''; search.value = ''; state.selected = ''; render(); lists.scrollTop = state.folders.at(-1).scroll || 0;
});
$('#folderExternal').addEventListener('click', async () => {
    const folder = state.folders.at(-1); if (!folder) return;
    try { await invoke('desktop_open_file', { path: folder.path }); }
    catch (error) { setStatus(`打开文件夹失败 · ${String(error)}`, true); }
});
$('#previewClose').addEventListener('click', () => { void closePreview({ restoreFocus: true }); });
$('#previewOpen').addEventListener('click', () => void open(state.previewFile));
menu.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action, file = state.menuFile;
    if (!file || !action) return; closeMenu({ restoreFocus: true });
    if (action === 'open') void open(file);
    else if (action === 'preview') void showPreview(file);
    else if (action === 'pin') togglePin(file);
    else try {
        if (action === 'locate') await invoke(file.app_id ? 'desktop_locate_app' : 'desktop_locate_file', { path: file.path });
        else if (action === 'copy') await navigator.clipboard.writeText(file.path);
    } catch (error) { setStatus(`操作失败 · ${String(error)}`, true); }
});
document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu({ restoreFocus: true }); });
document.addEventListener('keydown', event => {
    if (!state.visible || event.isComposing || composing) return;
    const editing = event.target.matches('input,textarea,[contenteditable=true]');
    if (event.key === 'Escape') {
        event.preventDefault();
        if (!menu.hidden) closeMenu({ restoreFocus: true });
        else if (state.previewOpen) void closePreview({ restoreFocus: true });
        else if (state.folders.length) back(); else void dismiss();
        return;
    }
    if (state.previewOpen) {
        if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); return; }
        if (event.key === 'Tab') {
            const controls = [...preview.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
            const index = controls.indexOf(document.activeElement);
            if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) {
                event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
            }
        }
        return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select(); return; }
    if (event.key === 'F5') { event.preventDefault(); $('#refreshSpace').click(); return; }
    if (!menu.hidden) {
        const controls = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
            controls[next]?.focus();
        } else if (event.key === 'Tab') closeMenu({ restoreFocus: true });
        return;
    }
    const focused = event.target.closest('.launcher-card[data-id]');
    if (focused && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
        showMenu(event, knownFile(focused.dataset.id), { keyboard: true }); return;
    }
    if (event.key === 'Enter' && (event.target === search || event.target.closest('.launcher-file'))) {
        event.preventDefault(); void open(knownFile(focused?.dataset.id || state.selected || lists.querySelector('.launcher-card[data-id]')?.dataset.id)); return;
    }
    if (event.code === 'Space' && !editing && event.target.closest('.launcher-file')) {
        event.preventDefault(); void showPreview(knownFile(focused?.dataset.id || state.selected)); return;
    }
    if (editing) return;
    if ((event.altKey && event.key === 'ArrowLeft') || event.key === 'Backspace') { if (state.folders.length) { event.preventDefault(); back(); } return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        const candidates = [...lists.querySelectorAll('.launcher-card[data-id]')], activeId = focused?.dataset.id || state.selected;
        const index = candidates.findIndex(node => node.dataset.id === activeId);
        if (!candidates.length) return;
        const next = directionalCard(candidates, index, event.key);
        event.preventDefault(); select(next.dataset.id, true); next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
});
function directionalCard(candidates, index, key) {
    if (index < 0) return candidates[0];
    const current = candidates[index], rect = current.getBoundingClientRect();
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    const vertical = key === 'ArrowUp' || key === 'ArrowDown', forward = key === 'ArrowDown' || key === 'ArrowRight';
    const positions = candidates.filter(node => node !== current).map(node => {
        const to = node.getBoundingClientRect();
        return { node, dx: to.x + to.width / 2 - cx, dy: to.y + to.height / 2 - cy };
    }).filter(to => vertical ? (forward ? to.dy > 2 : to.dy < -2)
        : Math.abs(to.dy) < rect.height / 2 && (forward ? to.dx > 2 : to.dx < -2));
    if (!positions.length) return vertical ? current : candidates[Math.max(0, Math.min(candidates.length - 1, index + (forward ? 1 : -1)))];
    const nearestRow = vertical ? Math.min(...positions.map(to => Math.abs(to.dy))) : 0;
    return positions.filter(to => !vertical || Math.abs(to.dy) <= nearestRow + 4)
        .sort((a, b) => vertical ? Math.abs(a.dx) - Math.abs(b.dx) || Math.abs(a.dy) - Math.abs(b.dy)
            : Math.abs(a.dx) - Math.abs(b.dx))[0].node;
}
window.addEventListener('storage', event => {
    if (event.key === LAUNCHER_STORAGE_KEY) {
        try {
            preferences = readLauncherPreferences(localStorage);
            preferencesWritable = true; metadataError = ''; render();
        } catch (error) {
            preferencesWritable = false;
            metadataError = `固定与排序设置更新失败，已暂停修改以保护原数据 · ${String(error)}`;
            setStatus(metadataError, true);
        }
    } else if (event.key === 'dtkit_desktop_organizer') motion.refresh();
});
window.addEventListener('dtkit:space-settings-applied', () => motion.refresh());
window.addEventListener('dtkit:space-material-applied', scheduleBackdropInk);
contrastMedia.addEventListener('change', scheduleBackdropInk);
const observer = new ResizeObserver(() => {
    scheduleBackdropInk();
    motion.indicator(filters, filters.querySelector(`[data-filter="${state.filter}"]`), true);
    if (state.previewOpen && state.previewFile) void animatePreview(true, state.previewFile);
}); observer.observe(root);
lists.addEventListener('scroll', scheduleBackdropInk, { passive: true });

async function listen(name, callback) {
    const unlisten = await window.__TAURI__.event.listen(name, callback);
    if (state.destroyed) unlisten(); else unlisteners.push(unlisten);
}
async function initialize() {
    try {
        preferences = readLauncherPreferences(localStorage);
        preferencesWritable = true;
        try { migrateLauncherPreferences(localStorage); }
        catch (error) { metadataError = `固定与排序设置已读取，旧数据迁移未完成，原数据已保留 · ${String(error)}`; }
    } catch (error) {
        preferencesWritable = false;
        metadataError = `固定与排序设置读取失败，已暂停修改以保护原数据 · ${String(error)}`;
    }
    const snapshot = readDesktopSnapshot(localStorage);
    if (snapshot) { state.scan = snapshot.files; state.files = collectLauncherFiles(snapshot.files); }
    render({ instant: true });
    try {
        await Promise.all([
            listen('desktop-space-opened', event => void reveal(event.payload)),
            listen('desktop-space-closing', event => {
                if (Number.isSafeInteger(event.payload?.session) && event.payload.session !== state.nativeSession) return;
                void dismiss({ instant: event.payload?.reducedMotion === true });
            }),
            listen('desktop-app-index-changed', () => { iconRevision++; hydrator.invalidate(); state.scanDirty = true; if (state.visible) void scan({ force: true }); }),
            listen('desktop-organizer-presentation-changed', () => motion.refresh())
        ]);
        await invoke('desktop_space_ready');
        void scan();
    } catch (error) { setStatus(`空间初始化失败 · ${String(error)}`, true); }
}
window.addEventListener('pagehide', () => {
    state.destroyed = true; state.previewRevision++; state.folderRevision++; closeRevision++;
    clearInterval(state.poll); observer.disconnect(); hydrator.destroy(); motion.destroy();
    if (contrastFrame) cancelAnimationFrame(contrastFrame);
    window.removeEventListener('dtkit:space-material-applied', scheduleBackdropInk);
    contrastMedia.removeEventListener('change', scheduleBackdropInk);
    disposePdfPreview?.(); disposePdfPreview = null; nodes.clear();
    groupCache = null; pinCache = null;
    unlisteners.forEach(unlisten => unlisten());
});
void initialize();
