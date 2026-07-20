import { registerTool } from '../toolRegistry.js';
import {
    UNIT_CATEGORIES,
    convertAcrossCategory,
    convertUnit,
    formatConvertedValue
} from './core.js';
import '../../css/tools/utility-suite.css';
import '../../css/tools/unit-converter.css';

const UNIT_SELECTION_KEY = 'dtkit_unit_converter_selection_v1';
const CATEGORY_HINTS = Object.freeze({
    data: '区分十进制 KB 与二进制 KiB',
    length: '公制与英制长度快速互换',
    mass: '覆盖日常与工程常用质量单位',
    temperature: '自动校验绝对零度边界',
    area: '适合面积、土地与房屋换算',
    speed: '公制、英制与航速统一换算'
});
const DEFAULT_PAIRS = Object.freeze({
    data: ['byte', 'bit'],
    length: ['m', 'km'],
    mass: ['kg', 'lb'],
    temperature: ['c', 'f'],
    area: ['sqm', 'sqft'],
    speed: ['kph', 'mph']
});
const PRESETS = Object.freeze([
    ['data', '1024', 'byte', 'kib', '1024 B', '1 KiB'],
    ['length', '1', 'km', 'mi', '1 km', '英里'],
    ['temperature', '100', 'c', 'f', '100 °C', '华氏度'],
    ['speed', '100', 'kph', 'mph', '100 km/h', 'mph']
]);

let abortController = null;
let copyResetTimer = null;

function categoryTabs() {
    return Object.values(UNIT_CATEGORIES).map(category => `
        <button class="unit-category-tab" type="button" role="tab"
            data-unit-category="${category.id}" aria-selected="false">
            <span>${category.label}</span>
            <small>${category.units.length} 个单位</small>
        </button>
    `).join('');
}

function presetButtons() {
    return PRESETS.map(([category, value, from, to, source, target]) => `
        <button class="unit-preset" type="button" data-unit-preset="${category},${value},${from},${to}">
            <span>${source}</span><i class="ri-arrow-right-line" aria-hidden="true"></i><strong>${target}</strong>
        </button>
    `).join('');
}

function getTemplate() {
    return `
        <div class="utility-tool-shell unit-tool">
            <header class="unit-tool__hero">
                <div>
                    <span class="utility-tool-kicker">UNIT CONVERTER</span>
                    <h2>单位换算</h2>
                    <p>输入一次，即时查看同类全部结果。计算完全在本地完成。</p>
                </div>
                <span class="unit-local-badge"><i aria-hidden="true"></i> 本地即时计算</span>
            </header>

            <nav class="unit-category-tabs" role="tablist" aria-label="换算类别">
                ${categoryTabs()}
            </nav>

            <section class="unit-workbench" aria-label="单位换算工作区">
                <article class="unit-value-panel unit-value-panel--source">
                    <div class="unit-panel-heading">
                        <span class="unit-step">01</span>
                        <div><strong>输入数值</strong><small id="unitCategoryHint"></small></div>
                    </div>
                    <label class="unit-value-control" for="unitInput">
                        <span class="sr-only">需要换算的数值</span>
                        <input id="unitInput" type="text" inputmode="decimal" value="1" autocomplete="off" spellcheck="false">
                        <select id="unitFrom" aria-label="原始单位"></select>
                    </label>
                </article>

                <button id="unitSwapBtn" class="unit-swap-button" type="button" title="交换单位" aria-label="交换原始单位和目标单位">
                    <i class="ri-arrow-left-right-line" aria-hidden="true"></i>
                </button>

                <article class="unit-value-panel unit-value-panel--result">
                    <div class="unit-panel-heading">
                        <span class="unit-step">02</span>
                        <div><strong>换算结果</strong><small>随输入实时更新</small></div>
                    </div>
                    <div class="unit-value-control unit-value-control--result">
                        <input id="unitOutput" type="text" readonly aria-label="换算结果">
                        <select id="unitTo" aria-label="目标单位"></select>
                        <button id="unitCopyBtn" class="unit-copy-button" type="button" aria-label="复制换算结果">
                            <i class="ri-file-copy-line" aria-hidden="true"></i><span>复制</span>
                        </button>
                    </div>
                </article>
            </section>

            <div class="unit-equation" id="unitEquation" role="status" aria-live="polite"></div>

            <section class="unit-overview" aria-labelledby="unitOverviewTitle">
                <div class="unit-section-heading">
                    <div><span class="utility-section-label">ALL RESULTS</span><h3 id="unitOverviewTitle">同类单位总览</h3></div>
                    <p>点击任一结果，将它设为目标单位</p>
                </div>
                <div class="unit-overview-grid" id="unitOverviewList"></div>
            </section>

            <section class="unit-presets" aria-labelledby="unitPresetsTitle">
                <div class="unit-section-heading">
                    <div><span class="utility-section-label">QUICK START</span><h3 id="unitPresetsTitle">常用场景</h3></div>
                </div>
                <div class="unit-preset-row">${presetButtons()}</div>
            </section>
        </div>
    `;
}

function getElements() {
    return {
        tabs: Array.from(document.querySelectorAll('[data-unit-category]')),
        input: document.getElementById('unitInput'),
        output: document.getElementById('unitOutput'),
        from: document.getElementById('unitFrom'),
        to: document.getElementById('unitTo'),
        hint: document.getElementById('unitCategoryHint'),
        equation: document.getElementById('unitEquation'),
        overview: document.getElementById('unitOverviewList'),
        swap: document.getElementById('unitSwapBtn'),
        copy: document.getElementById('unitCopyBtn')
    };
}

function unitOptions(category, selectedId) {
    return category.units.map(unit => `
        <option value="${unit.id}"${unit.id === selectedId ? ' selected' : ''}>
            ${unit.label} · ${unit.symbol}
        </option>
    `).join('');
}

function readSelection() {
    try {
        const saved = JSON.parse(localStorage.getItem(UNIT_SELECTION_KEY));
        const category = UNIT_CATEGORIES[saved?.category];
        if (!category) return null;
        const ids = new Set(category.units.map(unit => unit.id));
        if (!ids.has(saved.from) || !ids.has(saved.to)) return null;
        return saved;
    } catch {
        return null;
    }
}

function saveSelection(category, from, to) {
    try {
        localStorage.setItem(UNIT_SELECTION_KEY, JSON.stringify({ category, from, to }));
    } catch {
        // 无持久化权限时不影响换算。
    }
}

function renderOverview(elements, results, targetId) {
    elements.overview.innerHTML = results.map(({ unit, formatted }) => `
        <button class="unit-overview-item${unit.id === targetId ? ' is-target' : ''}"
            type="button" data-unit-target="${unit.id}" aria-pressed="${unit.id === targetId}">
            <span><strong>${unit.symbol}</strong><small>${unit.label}</small></span>
            <output>${formatted}</output>
        </button>
    `).join('');
}

function showConversionError(elements, error) {
    elements.output.value = '';
    elements.equation.textContent = error.message;
    elements.equation.classList.add('unit-equation--error');
    elements.overview.innerHTML = '<p class="unit-overview-empty">输入有效数值后，这里会展示全部换算结果。</p>';
}

function updateConversion(elements, categoryId) {
    const category = UNIT_CATEGORIES[categoryId];
    const fromUnit = category?.units.find(unit => unit.id === elements.from.value);
    const toUnit = category?.units.find(unit => unit.id === elements.to.value);

    try {
        const converted = convertUnit(elements.input.value, categoryId, elements.from.value, elements.to.value);
        const formatted = formatConvertedValue(converted);
        elements.output.value = formatted;
        elements.equation.textContent = `${elements.input.value} ${fromUnit.symbol} = ${formatted} ${toUnit.symbol}`;
        elements.equation.classList.remove('unit-equation--error');
        renderOverview(
            elements,
            convertAcrossCategory(elements.input.value, categoryId, elements.from.value),
            elements.to.value
        );
    } catch (error) {
        showConversionError(elements, error);
    }
}

function activateCategory(elements, categoryId, fromId, toId) {
    const category = UNIT_CATEGORIES[categoryId];
    if (!category) return;
    const [defaultFrom, defaultTo] = DEFAULT_PAIRS[categoryId];
    elements.tabs.forEach(tab => {
        const active = tab.dataset.unitCategory === categoryId;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
    });
    elements.from.innerHTML = unitOptions(category, fromId || defaultFrom);
    elements.to.innerHTML = unitOptions(category, toId || defaultTo);
    elements.hint.textContent = CATEGORY_HINTS[categoryId];
    elements.input.dataset.category = categoryId;
    saveSelection(categoryId, elements.from.value, elements.to.value);
    updateConversion(elements, categoryId);
}

function applyPreset(elements, preset) {
    const [category, value, from, to] = preset.split(',');
    elements.input.value = value;
    activateCategory(elements, category, from, to);
}

async function copyResult(elements) {
    if (!elements.output.value) return;
    try {
        await navigator.clipboard.writeText(elements.output.value);
        clearTimeout(copyResetTimer);
        elements.copy.classList.add('is-success');
        elements.copy.querySelector('i').className = 'ri-check-line';
        elements.copy.querySelector('span').textContent = '已复制';
        copyResetTimer = setTimeout(() => {
            if (!elements.copy.isConnected) return;
            elements.copy.classList.remove('is-success');
            elements.copy.querySelector('i').className = 'ri-file-copy-line';
            elements.copy.querySelector('span').textContent = '复制';
        }, 1200);
    } catch {
        showConversionError(elements, new Error('复制失败，请手动选择结果'));
    }
}

function bindUnitEvents(elements, signal) {
    elements.tabs.forEach(tab => tab.addEventListener('click', () => {
        activateCategory(elements, tab.dataset.unitCategory);
    }, { signal }));
    elements.input.addEventListener('input', () => updateConversion(elements, elements.input.dataset.category), { signal });
    elements.from.addEventListener('change', () => {
        saveSelection(elements.input.dataset.category, elements.from.value, elements.to.value);
        updateConversion(elements, elements.input.dataset.category);
    }, { signal });
    elements.to.addEventListener('change', () => {
        saveSelection(elements.input.dataset.category, elements.from.value, elements.to.value);
        updateConversion(elements, elements.input.dataset.category);
    }, { signal });
    elements.swap.addEventListener('click', () => {
        [elements.from.value, elements.to.value] = [elements.to.value, elements.from.value];
        if (elements.output.value) elements.input.value = elements.output.value;
        saveSelection(elements.input.dataset.category, elements.from.value, elements.to.value);
        updateConversion(elements, elements.input.dataset.category);
    }, { signal });
    elements.copy.addEventListener('click', () => copyResult(elements), { signal });
    elements.overview.addEventListener('click', event => {
        const target = event.target.closest('[data-unit-target]');
        if (!target) return;
        elements.to.value = target.dataset.unitTarget;
        saveSelection(elements.input.dataset.category, elements.from.value, elements.to.value);
        updateConversion(elements, elements.input.dataset.category);
    }, { signal });
    document.querySelectorAll('[data-unit-preset]').forEach(button => {
        button.addEventListener('click', () => applyPreset(elements, button.dataset.unitPreset), { signal });
    });
}

function initUnitConverterTool() {
    abortController?.abort();
    abortController = new AbortController();
    const elements = getElements();
    if (!elements.input || !elements.output || !elements.from || !elements.to || !elements.overview) return;

    bindUnitEvents(elements, abortController.signal);
    const saved = readSelection();
    activateCategory(elements, saved?.category || 'data', saved?.from, saved?.to);
    elements.input.focus();
    elements.input.select();
}

function destroyUnitConverterTool() {
    abortController?.abort();
    abortController = null;
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
}

registerTool({
    id: 'unit-converter',
    name: '单位换算',
    icon: 'ri-calculator-line',
    colorClass: 'tool-card__icon--slate',
    category: 'other',
    status: 'ready',
    description: '换算数据存储、长度、质量、温度、面积和速度。',
    template: getTemplate,
    init: initUnitConverterTool,
    destroy: destroyUnitConverterTool
});

export { destroyUnitConverterTool, initUnitConverterTool };
