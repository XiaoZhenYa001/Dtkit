import { registerTool } from '../toolRegistry.js';
import { UNIT_CATEGORIES, getUnitCategory, convertAcrossCategory, convertUnit, formatConvertedValue } from './core.js';
import { CATEGORY_HINTS, DEFAULT_PAIRS, getTemplate } from './template.js';
import '../../css/tools/utility-suite.css';
import '../../css/tools/unit-converter.css';

const UNIT_SELECTION_KEY = 'dtkit_unit_converter_selection_v1';
let state = null;

function getElements(root) {
    const node = id => root.querySelector('#' + id);
    return {
        tabs: [...root.querySelectorAll('[data-unit-category]')],
        input: node('unitInput'), output: node('unitOutput'), from: node('unitFrom'), to: node('unitTo'),
        hint: node('unitCategoryHint'), equation: node('unitEquation'), overview: node('unitOverviewList'),
        swap: node('unitSwapBtn'), copy: node('unitCopyBtn'), copyEquation: node('unitCopyEquationBtn'),
        precision: node('unitPrecision'), formula: node('unitFormula'), copyStatus: node('unitCopyStatus'),
        workbench: node('unitWorkbench')
    };
}

function categoryOf(elements) { return UNIT_CATEGORIES[elements.input.dataset.category]; }
function precisionOf(elements) { return Number(elements.precision.value); }
function comboboxFor(select) { return select.closest('.unit-combobox'); }

function closeCombobox(root, returnFocus = false) {
    const trigger = root.querySelector('.unit-combobox__trigger');
    trigger.setAttribute('aria-expanded', 'false');
    root.querySelector('.unit-combobox__popover').hidden = true;
    if (returnFocus) trigger.focus({ preventScroll: true });
}

function closeAll(view) {
    view.root.querySelectorAll('.unit-combobox').forEach(root => closeCombobox(root));
}

function syncCombobox(select, category) {
    const root = comboboxFor(select);
    const unit = category.units.find(item => item.id === select.value) || category.units[0];
    root.querySelector('[data-unit-selected-label]').textContent = unit.label;
    root.querySelector('[data-unit-selected-symbol]').textContent = unit.symbol;
    root.querySelector('.unit-combobox__options').replaceChildren();
}

function renderComboboxOptions(select, category, query = '') {
    const root = comboboxFor(select);
    const needle = query.trim().toLowerCase();
    const units = category.units.filter(unit => !needle || (unit.label + ' ' + unit.symbol).toLowerCase().includes(needle));
    root.querySelector('.unit-combobox__options').innerHTML = units.map(unit =>
        '<button type="button" role="option" tabindex="-1" data-unit-option="' + unit.id + '" aria-selected="' + (unit.id === select.value) + '">'
        + '<span><strong>' + unit.label + '</strong><small>' + unit.symbol + '</small></span>'
        + '<i class="ri-check-line" aria-hidden="true"></i></button>'
    ).join('') || '<p role="status">没有匹配的单位</p>';
}

function bindCombobox(view, select) {
    const { elements, controller } = view;
    const root = comboboxFor(select);
    const trigger = root.querySelector('.unit-combobox__trigger');
    const popover = root.querySelector('.unit-combobox__popover');
    const search = root.querySelector('.unit-combobox__search input');
    const on = (target, event, fn) => target.addEventListener(event, fn, { signal: controller.signal });
    const open = (focusOption = false) => {
        closeAll(view);
        search.value = '';
        renderComboboxOptions(select, categoryOf(elements));
        popover.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        const option = root.querySelector('[aria-selected="true"][data-unit-option]');
        (focusOption && option ? option : search).focus({ preventScroll: true });
    };
    const changed = () => { syncCombobox(select, categoryOf(elements)); saveSelection(elements); updateConversion(view); };
    on(trigger, 'click', () => popover.hidden ? open() : closeCombobox(root));
    on(trigger, 'keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); open(true);
    });
    on(search, 'input', () => renderComboboxOptions(select, categoryOf(elements), search.value));
    on(root, 'keydown', event => {
        if (popover.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); closeCombobox(root, true); return;
        }
        if (event.key === 'Tab') { closeCombobox(root, true); return; }
        const options = [...root.querySelectorAll('[data-unit-option]')];
        if (event.key === 'Enter' && event.target === search) {
            event.preventDefault(); options[0]?.click(); return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) return;
        if (event.target === search && ['Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : current < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0)
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus({ preventScroll: true }); options[next].scrollIntoView({ block: 'nearest' });
    });
    on(root, 'click', event => {
        const option = event.target.closest('[data-unit-option]');
        if (!option) return;
        select.value = option.dataset.unitOption; closeCombobox(root, true); changed();
    });
    on(select, 'change', changed);
}

function validSelection(saved) {
    const category = getUnitCategory(saved?.category);
    return category && [saved.from, saved.to].every(id => category.units.some(unit => unit.id === id));
}

function readSelection() {
    try {
        const saved = JSON.parse(localStorage.getItem(UNIT_SELECTION_KEY));
        return validSelection(saved) ? saved : null;
    } catch { return null; }
}

function saveSelection(elements) {
    try {
        localStorage.setItem(UNIT_SELECTION_KEY, JSON.stringify({ category: elements.input.dataset.category,
            from: elements.from.value, to: elements.to.value, precision: precisionOf(elements) }));
    } catch { /* Storage permissions do not affect conversion. */ }
}

function renderOverview(elements, results) {
    elements.overview.innerHTML = results.map(({ unit, formatted, error }) =>
        '<button class="unit-overview-item' + (unit.id === elements.to.value ? ' is-target' : '') + (error ? ' is-unavailable' : '')
        + '" type="button" data-unit-target="' + unit.id + '" aria-pressed="' + (unit.id === elements.to.value) + '">'
        + '<span><strong>' + unit.symbol + '</strong><small>' + unit.label + '</small></span>'
        + '<output>' + formatted + '</output></button>'
    ).join('');
}

function formulaText(categoryId, from, to, precision) {
    if (from.id === to.id) return '相同单位，数值保持不变。';
    if (categoryId === 'temperature') {
        const formulas = { 'c-f': '°F = °C × 9/5 + 32', 'f-c': '°C = (°F − 32) × 5/9',
            'c-k': 'K = °C + 273.15', 'k-c': '°C = K − 273.15',
            'f-k': 'K = (°F + 459.67) × 5/9', 'k-f': '°F = K × 9/5 − 459.67' };
        return '换算公式：' + formulas[from.id + '-' + to.id] + '。此处换算绝对温度，不适用于温差。';
    }
    return '单位关系：1 ' + from.symbol + ' ≈ ' + formatConvertedValue(from.factor / to.factor, precision)
        + ' ' + to.symbol + ' · 显示最多 ' + precision + ' 位有效数字。';
}

function updateConversion(view) {
    view.revision = (view.revision || 0) + 1;
    const elements = view.elements;
    const category = categoryOf(elements);
    const from = category.units.find(unit => unit.id === elements.from.value);
    const to = category.units.find(unit => unit.id === elements.to.value);
    const precision = precisionOf(elements);
    elements.copyStatus.textContent = '';
    try {
        const converted = convertUnit(elements.input.value, category.id, from.id, to.id);
        const formatted = formatConvertedValue(converted, precision);
        view.result = converted;
        elements.output.value = formatted;
        const relation = Number(formatted) === converted ? ' = ' : ' ≈ ';
        elements.equation.textContent = elements.input.value.trim() + ' ' + from.symbol + relation + formatted + ' ' + to.symbol;
        elements.equation.classList.remove('unit-equation--error');
        elements.input.removeAttribute('aria-invalid');
        elements.formula.textContent = formulaText(category.id, from, to, precision);
        renderOverview(elements, convertAcrossCategory(elements.input.value, category.id, from.id, precision));
        elements.copy.disabled = elements.copyEquation.disabled = false;
    } catch (error) {
        view.result = null;
        elements.output.value = '';
        elements.equation.textContent = error.message;
        elements.equation.classList.add('unit-equation--error');
        elements.input.setAttribute('aria-invalid', 'true');
        elements.formula.textContent = '';
        // Keep usable targets available even when the selected target overflows.
        try { renderOverview(elements, convertAcrossCategory(elements.input.value, category.id, from.id, precision)); }
        catch { elements.overview.innerHTML = '<p class="unit-overview-empty">输入有效数值后，这里会展示全部换算结果。</p>'; }
        elements.copy.disabled = elements.copyEquation.disabled = true;
    }
}

function activateCategory(view, categoryId, fromId, toId) {
    const elements = view.elements;
    const category = getUnitCategory(categoryId);
    if (!category) return;
    closeAll(view);
    const [defaultFrom, defaultTo] = DEFAULT_PAIRS[categoryId];
    const options = selected => category.units.map(unit => '<option value="' + unit.id + '"' + (unit.id === selected ? ' selected' : '')
        + '>' + unit.label + ' · ' + unit.symbol + '</option>').join('');
    elements.tabs.forEach(tab => {
        const active = tab.dataset.unitCategory === categoryId;
        tab.classList.toggle('is-active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    });
    elements.workbench.setAttribute('aria-labelledby', 'unitCategory-' + categoryId);
    elements.from.innerHTML = options(fromId || defaultFrom); elements.to.innerHTML = options(toId || defaultTo);
    syncCombobox(elements.from, category); syncCombobox(elements.to, category);
    elements.hint.textContent = CATEGORY_HINTS[categoryId]; elements.input.dataset.category = categoryId;
    saveSelection(elements); updateConversion(view);
}

async function copyResult(view, equation) {
    if (view.result === null || view.suspended) return;
    const revision = view.revision;
    const text = equation ? view.elements.equation.textContent : view.elements.output.value;
    try {
        await navigator.clipboard.writeText(text);
        if (state !== view || view.suspended || revision !== view.revision) return;
        view.elements.copyStatus.textContent = equation ? '已复制等式（含单位）' : '已复制数值';
    } catch {
        if (state === view && !view.suspended && revision === view.revision) view.elements.copyStatus.textContent = '复制失败，可手动选择结果复制。';
    }
}

function bindUnitEvents(view) {
    const { elements, root, controller } = view;
    const on = (target, event, fn) => target.addEventListener(event, fn, { signal: controller.signal });
    elements.tabs.forEach((tab, index) => {
        on(tab, 'click', () => activateCategory(view, tab.dataset.unitCategory));
        on(tab, 'keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? elements.tabs.length - 1
                : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + elements.tabs.length) % elements.tabs.length;
            elements.tabs[next].click(); elements.tabs[next].focus({ preventScroll: true });
        });
    });
    on(elements.input, 'input', () => updateConversion(view));
    on(elements.precision, 'change', () => { saveSelection(elements); updateConversion(view); });
    bindCombobox(view, elements.from); bindCombobox(view, elements.to);
    on(elements.swap, 'click', () => {
        // Use the unrounded result rather than the display precision when reversing.
        if (view.result !== null) elements.input.value = String(view.result);
        [elements.from.value, elements.to.value] = [elements.to.value, elements.from.value];
        syncCombobox(elements.from, categoryOf(elements)); syncCombobox(elements.to, categoryOf(elements));
        closeAll(view); saveSelection(elements); updateConversion(view);
    });
    on(elements.copy, 'click', () => { void copyResult(view, false); });
    on(elements.copyEquation, 'click', () => { void copyResult(view, true); });
    on(elements.overview, 'click', event => {
        const target = event.target.closest('[data-unit-target]');
        if (!target) return;
        elements.to.value = target.dataset.unitTarget;
        syncCombobox(elements.to, categoryOf(elements)); saveSelection(elements); updateConversion(view);
        elements.overview.querySelector('[data-unit-target="' + elements.to.value + '"]')?.focus({ preventScroll: true });
    });
    root.querySelectorAll('[data-unit-preset]').forEach(button => on(button, 'click', () => {
        const [category, value, from, to] = button.dataset.unitPreset.split(',');
        elements.input.value = value; activateCategory(view, category, from, to);
    }));
    on(document, 'pointerdown', event => root.querySelectorAll('.unit-combobox__popover:not([hidden])').forEach(panel => {
        if (!panel.closest('.unit-combobox').contains(event.target)) closeCombobox(panel.closest('.unit-combobox'));
    }));
    on(window, 'dtkit:power-state', event => {
        view.suspended = event.detail?.suspended === true;
        if (view.suspended) closeAll(view);
    });
}

function initUnitConverterTool() {
    destroyUnitConverterTool();
    const root = document.querySelector('.unit-tool');
    if (!root) return;
    const view = { root, elements: getElements(root), controller: new AbortController(), result: null,
        suspended: document.documentElement.classList.contains('app-is-suspended') };
    state = view;
    const saved = readSelection();
    view.elements.precision.value = [6, 12, 15].includes(saved?.precision) ? String(saved.precision) : '12';
    bindUnitEvents(view); activateCategory(view, saved?.category || 'data', saved?.from, saved?.to);
    view.elements.input.focus({ preventScroll: true }); view.elements.input.select();
}

function serializePageDraft() {
    if (!state) return null;
    const { elements, root } = state;
    return { version: 1, category: elements.input.dataset.category, from: elements.from.value, to: elements.to.value,
        input: elements.input.value, precision: precisionOf(elements), scrollTop: root.scrollTop,
        focus: root.contains(document.activeElement) ? document.activeElement?.id : null,
        start: elements.input.selectionStart, end: elements.input.selectionEnd };
}

function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1 || !validSelection(snapshot)) return;
    const view = state;
    view.elements.precision.value = [6, 12, 15].includes(snapshot.precision) ? String(snapshot.precision) : '12';
    view.elements.input.value = typeof snapshot.input === 'string' ? snapshot.input : '1';
    activateCategory(view, snapshot.category, snapshot.from, snapshot.to);
    if (Number.isInteger(snapshot.start) && Number.isInteger(snapshot.end)) view.elements.input.setSelectionRange(snapshot.start, snapshot.end);
    view.root.scrollTop = Number.isFinite(snapshot.scrollTop) ? snapshot.scrollTop : 0;
    if (!view.suspended && document.hasFocus() && ['unitInput', 'unitOutput', 'unitPrecision'].includes(snapshot.focus)) {
        view.root.querySelector('#' + snapshot.focus)?.focus({ preventScroll: true });
    }
}

function destroyUnitConverterTool() {
    if (!state) return;
    state.controller.abort(); closeAll(state); state = null;
}

registerTool({
    id: 'unit-converter', name: '单位换算', icon: 'ri-calculator-line', colorClass: 'tool-card__icon--slate',
    category: 'other', status: 'ready', description: '九类单位即时换算，支持精度设置、公式与同类结果对照。',
    template: getTemplate, init: initUnitConverterTool, destroy: destroyUnitConverterTool,
    serialize: serializePageDraft, restore: restorePageDraft
});

export { destroyUnitConverterTool, initUnitConverterTool };
