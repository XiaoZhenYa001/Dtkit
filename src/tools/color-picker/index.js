import '../../css/tools/color-picker.css';
import { registerTool } from '../toolRegistry.js';
import { getTemplate } from './template.js';
import { parseColor, formatColor, rgbToHsv, hsvToRgb, contrastRatio, compositeColors, shadeColors, sanitizeColorList, paletteText } from './core.js';
import { createImagePicker } from './imagePicker.js';
import { createPanelMotion } from './motion.js';
import { mountSegmentedControl } from '../../core/toolMotion.js';

const RECENT_KEY = 'colorPickerRecent';
const SAVED_KEY = 'colorPickerSaved_v2';
const LAST_KEY = 'colorPickerLast_v2';
const PRESETS = ['#FF453A','#FF9F0A','#FFD60A','#30D158','#66D4CF','#64D2FF','#0A84FF','#5E5CE6','#BF5AF2','#FF375F','#1D1D1F','#636366','#8E8E93','#AEAEB2','#E5E5EA','#FFFFFF'];
const FIELDS = [{ id: 'hexInput', format: 'hex', copy: 'copyHex' }, { id: 'rgbInput', format: 'rgb', copy: 'copyRgb' },
    { id: 'hslInput', format: 'hsl', copy: 'copyHsl' }, { id: 'rgbaInput', format: 'rgba', copy: 'copyRgba' }];
const WHITE = { r: 255, g: 255, b: 255, a: 1 }, BLACK = { r: 0, g: 0, b: 0, a: 1 };
const invoke = (command, args = {}) => window.__TAURI__?.core?.invoke?.(command, { ...args, instanceId: window.__DTKIT_TOOL_PAGE_CONTEXT?.instanceId ?? null });
let state = null;
const active = view => state === view && !view.controller.signal.aborted;
const node = (view, id) => view.root.querySelector('#' + id);

function readColors(key, maximum) {
    try { return sanitizeColorList(JSON.parse(localStorage.getItem(key) || '[]'), maximum); } catch { return []; }
}
function persist(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function setStatus(view, text, tone = 'idle', id = 'colorStatus') {
    if (!active(view)) return;
    const target = node(view, id); target.textContent = text; target.dataset.tone = tone;
}
function currentHex(view) { return formatColor(view.color, 'hex'); }

function createSwatch(color, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'color-swatch ' + className;
    button.dataset.color = color; button.style.setProperty('--swatch-color', color);
    button.setAttribute('aria-label', '使用颜色 ' + color); button.title = color;
    const paint = document.createElement('span'); paint.className = 'color-swatch__color'; paint.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'color-swatch__value'; label.textContent = color;
    button.append(paint, label); return button;
}

function renderGrid(view, id, colors, { removable = false, empty = '暂无颜色' } = {}) {
    const grid = node(view, id), signature = colors.join('|');
    if (grid.dataset.signature !== signature) {
        const focusColor = grid.contains(document.activeElement) ? document.activeElement.dataset.color || document.activeElement.dataset.removeColor : null;
        grid.dataset.signature = signature; grid.replaceChildren();
        for (const color of colors) {
            const swatch = createSwatch(color, id === 'recentColors' ? 'color-recent' : id === 'colorPresets' ? 'color-preset' : '');
            if (!removable) grid.append(swatch);
            else {
                const item = document.createElement('div'); item.className = 'color-saved-item';
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'color-swatch-remove';
                remove.dataset.removeColor = color; remove.setAttribute('aria-label', '删除收藏 ' + color); remove.title = '取消收藏'; remove.textContent = '×';
                item.append(swatch, remove); grid.append(item);
            }
        }
        if (!colors.length) { const text = document.createElement('p'); text.className = 'color-library-empty'; text.textContent = empty; grid.append(text); }
        if (focusColor) [...grid.querySelectorAll('button[data-color]')].find(button => button.dataset.color === focusColor)?.focus({ preventScroll: true });
    }
    grid.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === currentHex(view))));
}

function renderLibraries(view) {
    renderGrid(view, 'recentColors', view.recent, { empty: '选过的颜色会留在这里。' });
    renderGrid(view, 'savedColors', view.saved, { removable: true, empty: '收藏喜欢的颜色，下次继续使用。' });
    renderGrid(view, 'colorPresets', PRESETS);
    const saved = view.saved.includes(currentHex(view)), save = node(view, 'colorSave');
    save.setAttribute('aria-pressed', String(saved)); save.querySelector('span').textContent = saved ? '已收藏' : '收藏';
    save.querySelector('i').className = saved ? 'ri-check-line' : 'ri-add-line';
    node(view, 'colorClearRecent').hidden = view.library !== 'recent'; node(view, 'colorClearRecent').disabled = !view.recent.length;
    node(view, 'colorCopyPalette').disabled = !libraryColors(view).length || view.copies.has(node(view, 'colorCopyPalette'));
}

function addRecent(view) {
    const hex = currentHex(view); view.recent = [hex, ...view.recent.filter(color => color !== hex)].slice(0, 12);
    const saved = persist(RECENT_KEY, view.recent); persist(LAST_KEY, formatColor(view.color, 'rgba')); renderLibraries(view);
    if (!saved) setStatus(view, '颜色可正常使用，当前环境暂时无法保存最近记录', 'warning');
}

function setColor(view, color, { commit = false, sourceInput = null, hsv = null } = {}) {
    if (!active(view) || !color) return;
    view.color = { r: Math.round(Math.max(0, Math.min(255, color.r))), g: Math.round(Math.max(0, Math.min(255, color.g))),
        b: Math.round(Math.max(0, Math.min(255, color.b))), a: Math.max(0, Math.min(1, color.a ?? 1)) };
    const next = hsv || rgbToHsv(view.color);
    view.hsv = hsv || { ...next, h: next.s === 0 ? view.hsv.h : next.h };
    for (const field of FIELDS) {
        const input = node(view, field.id);
        if (input !== sourceInput) { input.value = formatColor(view.color, field.format); input.removeAttribute('aria-invalid'); view.errors.delete(field.id); }
        node(view, field.copy).disabled = view.errors.has(field.id) || view.copies.has(node(view, field.copy));
    }
    const solid = formatColor({ ...view.color, a: 1 }, 'hex'), rgba = formatColor(view.color, 'rgba');
    view.root.style.setProperty('--cp-color', rgba); view.root.style.setProperty('--cp-solid', solid);
    view.root.style.setProperty('--cp-hue', formatColor(hsvToRgb(view.hsv.h, 100, 100), 'hex'));
    view.root.style.setProperty('--cp-preview-ink', contrastRatio(BLACK, view.color) >= contrastRatio(WHITE, view.color) ? '#1d1d1f' : '#ffffff');
    node(view, 'colorInput').value = solid.toLowerCase(); node(view, 'colorPreviewValue').textContent = currentHex(view);
    node(view, 'colorPreviewAlpha').textContent = Math.round(view.color.a * 100) + '% 不透明';
    node(view, 'colorHue').value = String(view.hsv.h); node(view, 'colorHueValue').textContent = Math.round(view.hsv.h) + '°';
    node(view, 'colorAlpha').value = String(view.color.a * 100); node(view, 'colorAlphaValue').textContent = Math.round(view.color.a * 100) + '%';
    const pad = node(view, 'colorSaturation'), thumb = node(view, 'colorSaturationThumb');
    thumb.style.left = view.hsv.s + '%'; thumb.style.top = (100 - view.hsv.v) + '%';
    pad.setAttribute('aria-valuenow', String(Math.round(view.hsv.s)));
    pad.setAttribute('aria-valuetext', '饱和度 ' + Math.round(view.hsv.s) + '%，明度 ' + Math.round(view.hsv.v) + '%');
    const shades = shadeColors(view.color, 9), grid = node(view, 'colorShades');
    if (!grid.children.length) shades.forEach(() => grid.append(createSwatch('#FFFFFF', 'color-shade')));
    shades.forEach((shade, index) => {
        const button = grid.children[index], value = formatColor(shade, 'hex'); button.dataset.color = value;
        button.style.setProperty('--swatch-ink', contrastRatio(BLACK, shade) >= contrastRatio(WHITE, shade) ? '#1d1d1f' : '#ffffff');
        button.style.setProperty('--swatch-color', value); button.title = value; button.setAttribute('aria-label', '使用色阶 ' + value);
        button.querySelector('.color-swatch__value').textContent = value; button.setAttribute('aria-pressed', String(value === currentHex(view)));
    });
    updateContrast(view); renderLibraries(view); updateErrors(view);
    if (commit) addRecent(view);
}

function updateErrors(view) {
    node(view, 'colorInputError').textContent = view.errors.size ? '颜色格式尚未完成，请检查数值；Escape 可还原。' : '';
}
function updateContrast(view) {
    const ratio = contrastRatio(view.color, view.background), backing = compositeColors(view.color, view.background);
    node(view, 'colorContrastValue').textContent = ratio.toFixed(2) + ':1';
    node(view, 'colorContrastText').textContent = ratio >= 7 ? 'AAA 正文可用' : ratio >= 4.5 ? 'AA 正文可用' : ratio >= 3 ? 'AA 大号文字可用' : '文字对比度偏低';
    node(view, 'colorContrastText').dataset.tone = ratio >= 4.5 ? 'success' : 'warning';
    for (const [id, text] of [['colorContrastBlack', BLACK], ['colorContrastWhite', WHITE]]) {
        const target = node(view, id); target.style.backgroundColor = formatColor(backing, 'rgb'); target.style.color = formatColor(text, 'hex');
        target.querySelector('small').textContent = contrastRatio(text, backing).toFixed(2) + ':1';
    }
}

function selectTab(view, kind, key, immediate = false) {
    const source = kind === 'source', attribute = source ? 'colorTab' : 'colorLibrary';
    if (!(source ? ['studio', 'image'] : ['recent', 'saved', 'presets']).includes(key)) return;
    if (source) view.mode = key; else view.library = key;
    view.root.querySelectorAll(source ? '[data-color-tab]' : '[data-color-library]').forEach(button => {
        const selected = button.dataset[attribute] === key; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    const target = view.root.querySelector('[' + (source ? 'data-color-panel' : 'data-color-library-panel') + '="' + key + '"]');
    view.showPanel(node(view, source ? 'colorSourcePanels' : 'colorLibraryPanels'), target, { immediate }); renderLibraries(view);
}
function libraryColors(view) { return view.library === 'saved' ? view.saved : view.library === 'presets' ? PRESETS : view.recent; }

async function copy(view, text, button) {
    const token = {}; view.copies.set(button, token); button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
        await navigator.clipboard.writeText(text); if (!active(view) || view.copies.get(button) !== token) return;
        button.classList.add('is-copied'); button.querySelector('i').className = 'ri-check-line'; setStatus(view, text.includes('\n') ? '色板已复制' : '已复制 ' + text, 'success');
        clearTimeout(view.copyTimers.get(button));
        view.copyTimers.set(button, setTimeout(() => { view.copyTimers.delete(button); if (active(view)) { button.classList.remove('is-copied'); button.querySelector('i').className = 'ri-file-copy-line'; } }, 1300));
    } catch (error) { if (active(view) && view.copies.get(button) === token) { button.classList.remove('is-copied'); button.querySelector('i').className = 'ri-file-copy-line'; setStatus(view, '复制失败，请重试：' + (error?.message || error), 'error'); } }
    finally {
        if (active(view) && view.copies.get(button) === token) {
            view.copies.delete(button); button.disabled = false; button.setAttribute('aria-busy', 'false');
            const field = FIELDS.find(item => item.copy === button.id); if (field) button.disabled = view.errors.has(field.id);
            if (button.id === 'colorCopyPalette') button.disabled = !libraryColors(view).length;
        }
    }
}

function toggleSaved(view, color = currentHex(view), remove = false) {
    const exists = view.saved.includes(color);
    if (!exists && view.saved.length >= 36) { setStatus(view, '最多收藏 36 种颜色，请先移除不再使用的颜色', 'warning'); return; }
    view.saved = exists ? view.saved.filter(item => item !== color) : remove ? view.saved : [...view.saved, color];
    const stored = persist(SAVED_KEY, view.saved); renderLibraries(view);
    setStatus(view, stored ? exists ? '已取消收藏 ' + color : '已收藏 ' + color : '收藏已在本页更新，本地存储暂不可用', stored ? 'success' : 'warning');
}

async function startScreenPick(view) {
    if (!active(view) || view.pendingRequest) return;
    const button = node(view, 'screenColorPicker'), requestId = crypto.randomUUID(); view.pendingRequest = requestId;
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.querySelector('span').textContent = '正在取色'; button.querySelector('small').textContent = '选择像素，Esc 取消';
    try {
        if (window.__TAURI__?.core?.invoke) await invoke('start_screen_color_pick', { requestId });
        else if (typeof window.EyeDropper === 'function') {
            view.screenAbort = new AbortController(); const result = await new window.EyeDropper().open({ signal: view.screenAbort.signal });
            finishScreenPick(view, { requestId, color: result.sRGBHex });
        } else throw new Error('当前环境不支持屏幕取色，可使用图片取色');
    } catch (error) {
        if (!active(view) || view.pendingRequest !== requestId) return;
        finishScreenPick(view, { requestId, cancelled: true });
        if (error?.name !== 'AbortError') setStatus(view, '取色未完成：' + (error?.message || error), 'error');
    }
}
function finishScreenPick(view, result) {
    if (!active(view) || !view.pendingRequest || result?.requestId !== view.pendingRequest) return;
    const instance = window.__DTKIT_TOOL_PAGE_CONTEXT?.instanceId;
    if (result.instanceId && result.instanceId !== instance) return;
    view.pendingRequest = null; view.screenAbort = null;
    const button = node(view, 'screenColorPicker'); button.disabled = false; button.setAttribute('aria-busy', 'false'); button.querySelector('span').textContent = '屏幕取色'; button.querySelector('small').textContent = '选择屏幕上的任意颜色';
    const color = parseColor(result.color);
    if (!result.cancelled && color) { setColor(view, color, { commit: true }); setStatus(view, '已从屏幕提取 ' + currentHex(view), 'success'); }
    else setStatus(view, result.cancelled ? '已取消屏幕取色' : '未收到有效颜色，请重试', result.cancelled ? 'idle' : 'error');
}

function loadImage(view, file) {
    if (!file) return;
    selectTab(view, 'source', 'image'); view.imageJob = view.imagePicker.load(file); return view.imageJob;
}

function bindEvents(view) {
    const signal = view.controller.signal, on = (id, type, fn) => node(view, id).addEventListener(type, fn, { signal });
    FIELDS.forEach(field => {
        const input = node(view, field.id);
        input.addEventListener('input', () => {
            const color = parseColor(input.value);
            input.setAttribute('aria-invalid', String(!color));
            if (color) { view.errors.delete(field.id); setColor(view, color, { sourceInput: input }); }
            else { view.errors.add(field.id); node(view, field.copy).disabled = true; updateErrors(view); }
        }, { signal });
        input.addEventListener('change', () => { if (parseColor(input.value)) addRecent(view); }, { signal });
        input.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); input.value = formatColor(view.color, field.format); input.removeAttribute('aria-invalid'); view.errors.delete(field.id); node(view, field.copy).disabled = false; updateErrors(view); }
            else if (event.key === 'Enter') { event.preventDefault(); if (parseColor(input.value)) { input.value = formatColor(view.color, field.format); addRecent(view); } else updateErrors(view); }
        }, { signal });
        on(field.copy, 'click', () => void copy(view, formatColor(view.color, field.format), node(view, field.copy)));
    });
    on('colorPreview', 'click', () => node(view, 'colorInput').click());
    on('colorInput', 'input', event => { const color = parseColor(event.target.value); if (color) setColor(view, { ...color, a: view.color.a }); });
    on('colorInput', 'change', () => addRecent(view));
    on('colorHue', 'input', event => { const hsv = { ...view.hsv, h: Number(event.target.value) }; setColor(view, hsvToRgb(hsv.h, hsv.s, hsv.v, view.color.a), { hsv }); });
    on('colorAlpha', 'input', event => setColor(view, { ...view.color, a: Number(event.target.value) / 100 }, { hsv: view.hsv }));
    on('colorHue', 'change', () => addRecent(view)); on('colorAlpha', 'change', () => addRecent(view));
    const pad = node(view, 'colorSaturation');
    const drag = event => {
        const rect = pad.getBoundingClientRect(), hsv = { h: view.hsv.h, s: Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)), v: Math.max(0, Math.min(100, 100 - (event.clientY - rect.top) / rect.height * 100)) };
        setColor(view, hsvToRgb(hsv.h, hsv.s, hsv.v, view.color.a), { hsv });
    };
    const flushPad = () => {
        if (view.padFrame !== null) cancelAnimationFrame(view.padFrame); view.padFrame = null;
        if (view.padSample) { const sample = view.padSample; view.padSample = null; drag(sample); }
    };
    pad.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); pad.focus({ preventScroll: true }); view.dragPointer = event.pointerId; view.root.classList.add('is-adjusting'); try { pad.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer. */ } drag(event); }, { signal });
    pad.addEventListener('pointermove', event => {
        if (event.pointerId !== view.dragPointer) return;
        view.padSample = { clientX: event.clientX, clientY: event.clientY };
        if (view.padFrame === null) view.padFrame = requestAnimationFrame(() => { if (active(view)) flushPad(); });
    }, { signal });
    const finish = event => { if (event.pointerId !== view.dragPointer) return; flushPad(); view.dragPointer = null; view.root.classList.remove('is-adjusting'); addRecent(view); };
    pad.addEventListener('pointerup', finish, { signal }); pad.addEventListener('pointercancel', finish, { signal }); pad.addEventListener('lostpointercapture', finish, { signal });
    pad.addEventListener('keydown', event => {
        const step = event.shiftKey ? 10 : 1, hsv = { ...view.hsv };
        if (event.key === 'ArrowLeft') hsv.s -= step; else if (event.key === 'ArrowRight') hsv.s += step;
        else if (event.key === 'ArrowUp') hsv.v += step; else if (event.key === 'ArrowDown') hsv.v -= step;
        else if (event.key === 'Home') hsv.s = 0; else if (event.key === 'End') hsv.s = 100; else return;
        event.preventDefault(); hsv.s = Math.max(0, Math.min(100, hsv.s)); hsv.v = Math.max(0, Math.min(100, hsv.v));
        setColor(view, hsvToRgb(hsv.h, hsv.s, hsv.v, view.color.a), { hsv, commit: true });
    }, { signal });
    on('colorSave', 'click', () => toggleSaved(view)); on('screenColorPicker', 'click', () => void startScreenPick(view));
    on('colorContrastInput', 'input', event => { view.background = parseColor(event.target.value) || WHITE; updateContrast(view); });
    view.root.querySelectorAll('[data-color-tab]').forEach(button => button.addEventListener('click', () => selectTab(view, 'source', button.dataset.colorTab), { signal }));
    view.root.querySelectorAll('[data-color-library]').forEach(button => button.addEventListener('click', () => selectTab(view, 'library', button.dataset.colorLibrary), { signal }));
    view.root.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove-color]'); if (remove) { toggleSaved(view, remove.dataset.removeColor, true); return; }
        const swatch = event.target.closest('button[data-color]'); if (swatch) setColor(view, parseColor(swatch.dataset.color), { commit: !swatch.closest('#recentColors') });
    }, { signal });
    on('colorClearRecent', 'click', () => { view.recent = []; persist(RECENT_KEY, []); renderLibraries(view); setStatus(view, '最近记录已清空'); });
    on('colorCopyPalette', 'click', () => void copy(view, paletteText(libraryColors(view), node(view, 'colorExportFormat').value), node(view, 'colorCopyPalette')));
    const choose = () => { selectTab(view, 'source', 'image'); node(view, 'colorFileInput').click(); };
    on('colorUploadTrigger', 'click', choose); on('colorImageReplace', 'click', choose); on('colorDropZone', 'click', choose);
    on('colorDropZone', 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
    on('colorFileInput', 'change', event => { const file = event.target.files?.[0]; event.target.value = ''; void loadImage(view, file); });
    on('colorImageClear', 'click', () => view.imagePicker.clear());
    view.root.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); view.root.classList.add('is-dragover'); } }, { signal });
    view.root.addEventListener('dragleave', event => { if (!view.root.contains(event.relatedTarget)) view.root.classList.remove('is-dragover'); }, { signal });
    view.root.addEventListener('drop', event => { event.preventDefault(); view.root.classList.remove('is-dragover'); void loadImage(view, [...event.dataTransfer.files].find(file => file.type.startsWith('image/')) || event.dataTransfer.files[0]); }, { signal });
    document.addEventListener('paste', event => {
        if (event.target.closest('input,textarea,[contenteditable="true"]')) return;
        const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
        if (file) { event.preventDefault(); void loadImage(view, file); return; }
        const color = parseColor(event.clipboardData?.getData('text/plain')); if (color) { event.preventDefault(); setColor(view, color, { commit: true }); }
    }, { signal });
    window.addEventListener('storage', event => { if ([RECENT_KEY, SAVED_KEY].includes(event.key) || event.key === null) { view.recent = readColors(RECENT_KEY, 12); view.saved = readColors(SAVED_KEY, 36); renderLibraries(view); } }, { signal });
    window.addEventListener('dtkit:power-state', event => { if (event.detail?.suspended) { flushPad(); view.root.classList.remove('is-adjusting'); view.dragPointer = null; } }, { signal });
}

async function initColorPickerTool() {
    await destroyColorPickerTool();
    const root = document.querySelector('.color-picker-container'); if (!root) return;
    const view = { root, controller: new AbortController(), color: parseColor('#3B82F6'), hsv: { h: 217.2, s: 76, v: 96 }, background: WHITE,
        mode: 'studio', library: 'recent', recent: readColors(RECENT_KEY, 12), saved: readColors(SAVED_KEY, 36), errors: new Set(),
        copies: new Map(), copyTimers: new Map(), pendingRequest: null, screenAbort: null, unlisten: null, dragPointer: null, padFrame: null, padSample: null, imageJob: Promise.resolve() };
    state = view; view.showPanel = createPanelMotion(view.controller.signal);
    view.imagePicker = createImagePicker({ root, signal: view.controller.signal, onPick: (color, options) => setColor(view, color, options),
        onStatus: (text, tone) => setStatus(view, text, tone, 'colorImageStatus'), onPalette: palette => {
            if (!active(view)) return; const grid = node(view, 'colorImagePalette'); grid.replaceChildren();
            for (const item of palette) { const button = createSwatch(formatColor(item.color, 'hex'), 'color-image-swatch'); button.title += ' · ' + Math.round(item.weight * 100) + '%'; grid.append(button); }
        } });
    bindEvents(view); mountSegmentedControl(node(view, 'colorSourceTabs'), { signal: view.controller.signal }); mountSegmentedControl(node(view, 'colorLibraryTabs'), { signal: view.controller.signal });
    let previous; try { previous = parseColor(JSON.parse(localStorage.getItem(LAST_KEY) || 'null')); } catch { /* optional */ }
    setColor(view, previous || view.color); selectTab(view, 'source', 'studio', true); selectTab(view, 'library', 'recent', true);
    if (window.__TAURI__?.core?.invoke) {
        const button = node(view, 'screenColorPicker'); button.disabled = true;
        try {
            if (!window.__TAURI__.event?.listen) throw new Error('取色事件通道不可用');
            const unlisten = await window.__TAURI__.event.listen('screen-color-picked', event => finishScreenPick(view, event.payload));
            if (!active(view)) unlisten?.(); else { view.unlisten = unlisten; button.disabled = false; }
        } catch (error) { if (active(view)) { button.disabled = true; button.querySelector('small').textContent = '屏幕取色暂不可用，可导入图片'; setStatus(view, String(error?.message || error), 'warning'); } }
    }
}

function serializeColorPicker() {
    const view = state; if (!view) return null;
    return { version: 2, color: formatColor(view.color, 'rgba'), hue: view.hsv.h, mode: view.mode, library: view.library,
        background: formatColor(view.background, 'hex'), exportFormat: node(view, 'colorExportFormat').value, image: view.imagePicker.serialize(),
        drafts: Object.fromEntries(FIELDS.map(field => [field.id, node(view, field.id).value.slice(0, 256)])) };
}
async function restoreColorPicker(snapshot) {
    const view = state; if (!view || snapshot?.version !== 2) return;
    const color = parseColor(snapshot.color); if (color) setColor(view, color);
    if (Number.isFinite(snapshot.hue)) { view.hsv.h = Math.max(0, Math.min(360, snapshot.hue)); setColor(view, view.color, { hsv: view.hsv }); }
    const background = parseColor(snapshot.background); if (background) { view.background = background; node(view, 'colorContrastInput').value = formatColor(background); updateContrast(view); }
    selectTab(view, 'source', snapshot.mode, true); selectTab(view, 'library', snapshot.library, true);
    if (['css', 'json', 'text'].includes(snapshot.exportFormat)) node(view, 'colorExportFormat').value = snapshot.exportFormat;
    for (const field of FIELDS) {
        const value = snapshot.drafts?.[field.id]; if (typeof value !== 'string' || value.length > 256) continue;
        const input = node(view, field.id); input.value = value;
        if (!parseColor(value)) { view.errors.add(field.id); input.setAttribute('aria-invalid', 'true'); node(view, field.copy).disabled = true; }
    }
    updateErrors(view); view.imageJob = view.imagePicker.restore(snapshot.image); await view.imageJob;
}
async function flushColorPicker() { const view = state; if (!view) return; await view.imageJob; await view.imagePicker.flush(); }
function destroyColorPickerTool() {
    const view = state; if (!view) return Promise.resolve(); state = null;
    const requestId = view.pendingRequest; view.controller.abort(); view.unlisten?.(); view.screenAbort?.abort();
    if (view.padFrame !== null) cancelAnimationFrame(view.padFrame); view.padSample = null;
    for (const timer of view.copyTimers.values()) clearTimeout(timer); view.copyTimers.clear(); view.pendingRequest = null;
    if (requestId && window.__TAURI__?.core?.invoke) return Promise.resolve(invoke('cancel_screen_color_pick', { requestId })).catch(() => {});
    return Promise.resolve();
}

registerTool({ id: 'color-picker', name: '颜色提取器', icon: 'ri-palette-line', colorClass: 'tool-card__icon--pink', category: 'design',
    description: '屏幕与图片取色、透明度调色、颜色转换与色板收藏。', template: getTemplate, init: initColorPickerTool,
    destroy: destroyColorPickerTool, serialize: serializeColorPicker, restore: restoreColorPicker, flush: flushColorPicker });
export { initColorPickerTool, destroyColorPickerTool };
