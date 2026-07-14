import { registerTool } from '../toolRegistry.js';
import { UNIT_CATEGORIES, convertUnit, formatConvertedValue } from './core.js';
import '../../css/tools/utility-suite.css';

let abortController = null;

function categoryOptions() {
    return Object.values(UNIT_CATEGORIES)
        .map(category => `<option value="${category.id}">${category.label}</option>`)
        .join('');
}

function getTemplate() {
    return `
        <div class="utility-tool-shell unit-tool">
            <header class="utility-tool-hero">
                <div>
                    <span class="utility-tool-kicker">CONVERTER</span>
                    <h2>单位换算</h2>
                    <p>覆盖数据存储、长度、质量、温度、面积与速度，区分十进制 KB 和二进制 KiB。</p>
                </div>
                <label class="utility-mode-control" for="unitCategory">
                    <span>换算类别</span>
                    <select id="unitCategory" class="utility-select">${categoryOptions()}</select>
                </label>
            </header>

            <section class="unit-conversion-card">
                <div class="unit-value-column">
                    <label for="unitInput">原始数值</label>
                    <input id="unitInput" class="utility-number-input" type="number" inputmode="decimal" step="any" value="1" autocomplete="off">
                    <select id="unitFrom" class="utility-select" aria-label="原始单位"></select>
                </div>

                <button id="unitSwapBtn" class="unit-swap-button" type="button" title="交换单位" aria-label="交换原始单位与目标单位">
                    <i class="ri-arrow-left-right-line"></i>
                </button>

                <div class="unit-value-column">
                    <label for="unitOutput">换算结果</label>
                    <div class="unit-output-wrap">
                        <input id="unitOutput" class="utility-number-input" type="text" readonly>
                        <button id="unitCopyBtn" class="utility-icon-button" type="button" title="复制结果" aria-label="复制换算结果">
                            <i class="ri-file-copy-line"></i>
                        </button>
                    </div>
                    <select id="unitTo" class="utility-select" aria-label="目标单位"></select>
                </div>
            </section>

            <div class="unit-equation" id="unitEquation" role="status" aria-live="polite">1 B = 8 bit</div>

            <section class="utility-examples" aria-labelledby="unitTipsTitle">
                <div>
                    <span class="utility-section-label" id="unitTipsTitle">常用换算</span>
                    <p>点击即可切换类别和单位。</p>
                </div>
                <div class="utility-chip-row">
                    <button class="utility-example-chip" type="button" data-unit-preset="data,1024,byte,kib">1024 B → KiB</button>
                    <button class="utility-example-chip" type="button" data-unit-preset="length,1,km,mi">1 km → mi</button>
                    <button class="utility-example-chip" type="button" data-unit-preset="temperature,100,c,f">100 °C → °F</button>
                    <button class="utility-example-chip" type="button" data-unit-preset="speed,100,kph,mph">100 km/h → mph</button>
                </div>
            </section>
        </div>
    `;
}

function renderUnitOptions(select, category, selectedId) {
    select.innerHTML = category.units
        .map(unit => `<option value="${unit.id}"${unit.id === selectedId ? ' selected' : ''}>${unit.label}（${unit.symbol}）</option>`)
        .join('');
}

function initUnitConverterTool() {
    abortController?.abort();
    abortController = new AbortController();
    const { signal } = abortController;

    const categorySelect = document.getElementById('unitCategory');
    const fromSelect = document.getElementById('unitFrom');
    const toSelect = document.getElementById('unitTo');
    const input = document.getElementById('unitInput');
    const output = document.getElementById('unitOutput');
    const equation = document.getElementById('unitEquation');
    const copyButton = document.getElementById('unitCopyBtn');
    if (!categorySelect || !fromSelect || !toSelect || !input || !output || !equation || !copyButton) return;

    const update = () => {
        const category = UNIT_CATEGORIES[categorySelect.value];
        const fromUnit = category?.units.find(unit => unit.id === fromSelect.value);
        const toUnit = category?.units.find(unit => unit.id === toSelect.value);

        try {
            const result = convertUnit(input.value, categorySelect.value, fromSelect.value, toSelect.value);
            const formatted = formatConvertedValue(result);
            output.value = formatted;
            equation.textContent = `${input.value} ${fromUnit?.symbol || ''} = ${formatted} ${toUnit?.symbol || ''}`;
            equation.classList.remove('unit-equation--error');
        } catch (error) {
            output.value = '';
            equation.textContent = error.message;
            equation.classList.add('unit-equation--error');
        }
    };

    const updateCategory = (fromId, toId) => {
        const category = UNIT_CATEGORIES[categorySelect.value];
        if (!category) return;
        renderUnitOptions(fromSelect, category, fromId || category.units[0].id);
        renderUnitOptions(toSelect, category, toId || category.units[1]?.id || category.units[0].id);
        update();
    };

    categorySelect.addEventListener('change', () => updateCategory(), { signal });
    fromSelect.addEventListener('change', update, { signal });
    toSelect.addEventListener('change', update, { signal });
    input.addEventListener('input', update, { signal });

    document.getElementById('unitSwapBtn')?.addEventListener('click', () => {
        const previousFrom = fromSelect.value;
        fromSelect.value = toSelect.value;
        toSelect.value = previousFrom;
        if (output.value) input.value = output.value;
        update();
    }, { signal });

    copyButton.addEventListener('click', async () => {
        if (!output.value) return;
        try {
            await navigator.clipboard.writeText(output.value);
            const original = copyButton.innerHTML;
            copyButton.innerHTML = '<i class="ri-check-line"></i>';
            setTimeout(() => {
                if (copyButton.isConnected) copyButton.innerHTML = original;
            }, 1200);
        } catch {
            equation.textContent = '复制失败，请手动选择结果';
            equation.classList.add('unit-equation--error');
        }
    }, { signal });

    document.querySelectorAll('[data-unit-preset]').forEach(button => {
        button.addEventListener('click', () => {
            const [categoryId, value, fromId, toId] = button.dataset.unitPreset.split(',');
            categorySelect.value = categoryId;
            input.value = value;
            updateCategory(fromId, toId);
        }, { signal });
    });

    categorySelect.value = 'data';
    updateCategory('byte', 'bit');
    input.focus();
    input.select();
}

function destroyUnitConverterTool() {
    abortController?.abort();
    abortController = null;
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
