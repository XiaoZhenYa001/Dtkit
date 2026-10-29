import { UNIT_CATEGORIES } from './core.js';

export const CATEGORY_HINTS = Object.freeze({
    data: '区分十进制 KB 与二进制 KiB', length: '公制与英制长度快速互换', mass: '盎司、磅采用常衡制',
    temperature: '绝对温度换算，自动校验 0 K 边界', area: '公顷、国际英亩与房屋面积换算',
    speed: '公制、英制与航速统一换算', volume: '加仑采用美制液体加仑',
    pressure: '保持原有压力基准，不转换表压与绝压', energy: '卡、千卡采用热化学定义（1 cal = 4.184 J）'
});
export const DEFAULT_PAIRS = Object.freeze({
    data: ['byte', 'bit'], length: ['m', 'km'], mass: ['kg', 'lb'], temperature: ['c', 'f'],
    area: ['sqm', 'sqft'], speed: ['kph', 'mph'], volume: ['l', 'ml'], pressure: ['bar', 'psi'], energy: ['kwh', 'kj']
});
const PRESETS = Object.freeze([
    ['data', '1024', 'byte', 'kib', '1024 B', 'KiB'], ['length', '1', 'km', 'mi', '1 km', '英里'],
    ['temperature', '100', 'c', 'f', '100 °C', '华氏度'], ['speed', '100', 'kph', 'mph', '100 km/h', 'mph'],
    ['volume', '1', 'usgal', 'l', '1 US gal', '升'], ['pressure', '2.5', 'bar', 'psi', '2.5 bar', 'psi'],
    ['energy', '1', 'kwh', 'kj', '1 度电', '千焦'], ['area', '100', 'sqm', 'sqft', '100 m²', '平方英尺']
]);
function unitCombobox(id, label) {
    return `<div class="unit-combobox" data-unit-combobox="${id}">
        <select id="${id}" class="unit-native-select" aria-hidden="true" tabindex="-1"></select>
        <button class="unit-combobox__trigger" type="button" role="combobox" aria-label="${label}"
            aria-haspopup="dialog" aria-controls="${id}Popover" aria-expanded="false">
            <span><strong data-unit-selected-label>选择单位</strong><small data-unit-selected-symbol>--</small></span>
            <i class="ri-arrow-down-s-line" aria-hidden="true"></i></button>
        <div class="unit-combobox__popover" id="${id}Popover" role="dialog" aria-label="${label}" hidden>
            <label class="unit-combobox__search"><i class="ri-search-line" aria-hidden="true"></i>
                <input type="search" placeholder="搜索单位或符号" aria-label="搜索${label}"></label>
            <div class="unit-combobox__options" role="listbox" aria-label="${label}"></div>
            <small class="unit-combobox__help">↑ ↓ 选择 · Enter 确认 · Esc 返回</small></div></div>`;
}
export function getTemplate() {
    const tabs = Object.values(UNIT_CATEGORIES).map(category => `
        <button class="unit-category-tab" id="unitCategory-${category.id}" type="button" role="tab"
            aria-controls="unitWorkbench" data-unit-category="${category.id}" aria-selected="false" tabindex="-1">
            <span>${category.label}</span><small>${category.units.length} 个单位</small></button>`).join('');
    const presets = PRESETS.map(([category, value, from, to, source, target]) => `
        <button class="unit-preset" type="button" data-unit-preset="${category},${value},${from},${to}">
            <span>${source}</span><i class="ri-arrow-right-line" aria-hidden="true"></i><strong>${target}</strong></button>`).join('');
    return `<div class="utility-tool-shell unit-tool">
        <header class="unit-tool__hero"><div><span class="utility-tool-kicker">UNIT CONVERTER</span><h2>单位换算</h2>
            <p>输入一次，即时比较同类单位。九种常用量纲，清楚呈现换算依据。</p></div>
            <span class="unit-local-badge"><i aria-hidden="true"></i> 本地即时计算</span></header>
        <nav class="unit-category-tabs" role="tablist" aria-label="换算类别">${tabs}</nav>
        <section class="unit-conversion" id="unitWorkbench" role="tabpanel" aria-label="单位换算工作区">
            <div class="unit-settings-row"><p id="unitCategoryHint"></p><label for="unitPrecision">显示有效位数
                <select id="unitPrecision"><option value="6">6 位 · 简洁</option><option value="12" selected>12 位 · 标准</option>
                <option value="15">15 位 · 详细</option></select></label></div>
            <div class="unit-workbench">
                <article class="unit-value-panel unit-value-panel--source">
                    <div class="unit-panel-heading"><span class="unit-step">01</span><div><strong>输入数值</strong>
                        <small>支持负数、小数、科学记数法，如 1.5e3</small></div></div>
                    <div class="unit-value-control"><label class="sr-only" for="unitInput">需要换算的数值</label>
                        <input id="unitInput" type="text" inputmode="decimal" value="1" autocomplete="off" spellcheck="false" aria-describedby="unitEquation">
                        ${unitCombobox('unitFrom', '原始单位')}</div></article>
                <button id="unitSwapBtn" class="unit-swap-button" type="button" title="交换数值与单位" aria-label="交换原始单位和目标单位">
                    <i class="ri-arrow-left-right-line" aria-hidden="true"></i></button>
                <article class="unit-value-panel unit-value-panel--result">
                    <div class="unit-panel-heading"><span class="unit-step">02</span><div><strong>换算结果</strong>
                        <small>显示精度不影响后续计算</small></div></div>
                    <div class="unit-value-control unit-value-control--result"><input id="unitOutput" type="text" readonly aria-label="换算结果">
                        ${unitCombobox('unitTo', '目标单位')}</div>
                    <button id="unitCopyBtn" class="unit-copy-button" type="button" disabled>
                        <i class="ri-file-copy-line" aria-hidden="true"></i><span>复制数值</span></button></article>
            </div>
            <div class="unit-result-detail"><p class="unit-equation" id="unitEquation" role="status" aria-live="polite"></p>
                <button id="unitCopyEquationBtn" class="unit-copy-button" type="button" disabled>
                    <i class="ri-file-copy-line" aria-hidden="true"></i>复制等式</button></div>
            <p class="unit-formula" id="unitFormula"></p><p class="unit-copy-status" id="unitCopyStatus" role="status" aria-live="polite"></p>
        </section>
        <section class="unit-overview" aria-labelledby="unitOverviewTitle"><div class="unit-section-heading">
            <div><span class="utility-section-label">ALL RESULTS</span><h3 id="unitOverviewTitle">同类单位总览</h3></div>
            <p>点击结果，设为目标单位</p></div><div class="unit-overview-grid" id="unitOverviewList"></div></section>
        <section class="unit-presets" aria-labelledby="unitPresetsTitle"><div class="unit-section-heading">
            <div><span class="utility-section-label">QUICK START</span><h3 id="unitPresetsTitle">常用场景</h3></div>
            <p>载入示例后可继续修改</p></div><div class="unit-preset-row">${presets}</div></section>
        <p class="unit-footnote">结果按所选有效位数显示，极大或极小数使用科学记数法。采用 JavaScript 双精度浮点数计算。</p>
    </div>`;
}
