import { registerTool } from '../toolRegistry.js';
import { mountSegmentedControl, revealContent, transitionLayout } from '../../core/toolMotion.js';
import { describeInstant, formatDateTimeInput, parseDateTime, parseTimestamp,
    resolveTimestampReference, TIMESTAMP_REFERENCES } from './core.js';
import '../../css/tools/developer-workbench.css';
import '../../css/tools/timestamp-converter.css';

let state = null;
const UNIT_LABELS = { auto: '自动', sec: '秒', ms: '毫秒' };

function getTemplate() {
    return `
        <div class="view-container dev-workbench timestamp-container">
            <header class="dw-header">
                <div><p class="dw-eyebrow">UNIX TIME</p><h1 class="dw-title">时间戳转换</h1>
                    <p class="dw-subtitle">在时间戳与日期之间，找到同一个时刻。</p></div>
                <span class="dw-chip"><i class="ri-computer-line" aria-hidden="true"></i> 本地转换</span>
            </header>
            <section class="dw-card current-time-section" aria-label="当前时间">
                <div class="timestamp-current-heading">
                    <span class="current-time-label">当前 Unix 时间戳 <span id="currentTimestampUnit">秒</span></span>
                    <div class="dw-segmented" role="group" aria-label="当前读数单位">
                        <button type="button" data-current-unit="sec" aria-pressed="true">秒</button>
                        <button type="button" data-current-unit="ms" aria-pressed="false">毫秒</button>
                    </div>
                </div>
                <div class="current-time-display"><span id="currentTimestamp" class="timestamp-value dw-mono">--</span>
                    <button id="copyCurrentBtn" class="dw-button timestamp-copy" type="button" title="复制当前时间戳" aria-label="复制当前时间戳"><i class="ri-file-copy-line" aria-hidden="true"></i></button></div>
                <p id="currentTimeLabel" class="dw-status"></p>
            </section>
            <div class="dw-grid conversion-panels">
                <section class="dw-card conversion-panel" aria-labelledby="timestampToDateTitle">
                    <header class="dw-card-header panel-header"><h2 class="dw-card-title panel-title" id="timestampToDateTitle">时间戳转日期</h2><span class="dw-chip">01</span></header>
                    <div class="dw-card-body panel-body">
                        <div class="dw-field input-group">
                            <label class="dw-label label" for="timestampInput">Unix 时间戳</label>
                            <input id="timestampInput" class="dw-control dw-mono input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="64" placeholder="例如 1767225600" aria-describedby="timestampUnitHint timestampStatus">
                        </div>
                        <div class="dw-field"><span class="dw-label" id="timestampUnitLabel">输入单位</span>
                            <div class="dw-segmented" role="group" aria-labelledby="timestampUnitLabel">
                                <button type="button" data-timestamp-unit="auto" aria-pressed="true">自动识别</button>
                                <button type="button" data-timestamp-unit="sec" aria-pressed="false">秒</button>
                                <button type="button" data-timestamp-unit="ms" aria-pressed="false">毫秒</button>
                            </div><p id="timestampUnitHint" class="dw-status"></p>
                        </div>
                        <div class="dw-inline timestamp-form-actions">
                            <button id="toDateBtn" class="dw-button dw-button--primary" type="button"><i class="ri-arrow-right-line" aria-hidden="true"></i> 转换日期</button>
                            <button id="timestampPasteBtn" class="dw-button" type="button"><i class="ri-clipboard-line" aria-hidden="true"></i> 粘贴</button>
                            <button id="timestampNowBtn" class="dw-button" type="button">现在</button>
                        </div>
                        <p id="timestampStatus" class="dw-status" role="status" aria-live="polite">支持负数、0，以及精确到毫秒的小数秒。</p>
                        <div id="dateResult" class="result-box"><div class="dw-empty">输入一个时间戳，查看本地与 UTC 时间。</div></div>
                    </div>
                </section>
                <section class="dw-card conversion-panel" aria-labelledby="dateToTimestampTitle">
                    <header class="dw-card-header panel-header"><h2 class="dw-card-title panel-title" id="dateToTimestampTitle">日期转时间戳</h2><span class="dw-chip">02</span></header>
                    <div class="dw-card-body panel-body">
                        <div class="dw-field input-group"><label class="dw-label label" for="dateInput">日期时间</label>
                            <input id="dateInput" class="dw-control dw-mono input" type="datetime-local" step="0.001" aria-describedby="dateZoneHint dateStatus">
                        </div>
                        <div class="dw-field"><span class="dw-label" id="dateZoneLabel">按哪个时区解释</span>
                            <div class="dw-segmented" role="group" aria-labelledby="dateZoneLabel">
                                <button type="button" data-date-zone="local" aria-pressed="true">本地时间</button>
                                <button type="button" data-date-zone="utc" aria-pressed="false">UTC</button>
                            </div><p id="dateZoneHint" class="dw-status"></p>
                        </div>
                        <div class="dw-inline timestamp-form-actions">
                            <button id="toTimestampBtn" class="dw-button dw-button--primary" type="button"><i class="ri-arrow-right-line" aria-hidden="true"></i> 转换时间戳</button>
                            <button id="nowBtn" class="dw-button" type="button"><i class="ri-time-line" aria-hidden="true"></i> 现在</button>
                        </div>
                        <p id="dateStatus" class="dw-status" role="status" aria-live="polite">可输入秒与毫秒；按 Enter 转换。</p>
                        <div id="timestampResult" class="result-box"><div class="dw-empty">选择日期时间，查看秒与毫秒时间戳。</div></div>
                    </div>
                </section>
            </div>
            <section class="dw-card quick-reference" aria-labelledby="timestampReferencesTitle">
                <header class="dw-card-header"><h2 id="timestampReferencesTitle" class="dw-card-title quick-ref-title">常用时刻</h2><span class="dw-label">点击即可转换</span></header>
                <div id="quickReferenceGrid" class="quick-ref-grid"></div>
            </section>
            <footer class="dw-footer"><p class="dw-status">Unix 时间戳表示同一个时刻，不受显示时区影响。</p><span class="dw-status">Enter 转换 · 点击结果右侧复制</span></footer>
        </div>`;
}

function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function node(view, id) { return view.root.querySelector('#' + id); }
function status(view, id, message, tone = '') {
    const element = node(view, id);
    element.textContent = message;
    element.dataset.tone = tone;
}
function setPressed(view, attribute, value) {
    view.root.querySelectorAll('[' + attribute + ']').forEach(button => {
        button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === value));
    });
}
function updateModes(view) {
    setPressed(view, 'data-timestamp-unit', view.unit);
    setPressed(view, 'data-current-unit', view.currentUnit);
    setPressed(view, 'data-date-zone', view.dateZone);
    node(view, 'currentTimestampUnit').textContent = UNIT_LABELS[view.currentUnit];
    node(view, 'timestampUnitHint').textContent = view.unit === 'auto'
        ? '常见 10 位秒 / 13 位毫秒自动识别；较早日期或特殊数值请指定单位。'
        : view.unit === 'sec' ? '1 秒 = 1000 毫秒；小数最多 3 位。' : '按整数毫秒解释，包括 0 与负数。';
    node(view, 'dateZoneHint').textContent = view.dateZone === 'utc'
        ? 'UTC（零时区）。切换时区后，按新时区重新解释输入值。'
        : '本地时区：' + Intl.DateTimeFormat().resolvedOptions().timeZone + '。夏令时重复时刻按浏览器规则解释。';
}

function showRows(view, id, rows) {
    const result = node(view, id);
    const content = document.createElement('div');
    content.className = 'result-content dw-result-list';
    for (const [key, label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'result-row dw-result-row';
        const title = document.createElement('span');
        title.className = 'result-label dw-result-label'; title.textContent = label;
        const text = document.createElement('span');
        text.className = 'result-value dw-result-value dw-mono'; text.dataset.resultKey = key;
        text.dataset.copyValue = String(value); text.textContent = String(value);
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'dw-button btn--copy timestamp-copy';
        button.dataset.copy = String(value); button.title = '复制' + label;
        button.setAttribute('aria-label', '复制' + label);
        button.innerHTML = '<i class="ri-file-copy-line" aria-hidden="true"></i>';
        row.append(title, text, button); content.append(row);
    }
    transitionLayout(result, () => {
        result.replaceChildren(content);
        result.className = 'result-box result-box--success';
    }, { signal: view.controller.signal });
    if (!view.restoring) revealContent(content, { signal: view.controller.signal });
}

function clearResult(view, id, message) {
    const result = node(view, id);
    if (result.querySelector('.dw-empty')) return;
    const empty = document.createElement('div'); empty.className = 'dw-empty'; empty.textContent = message;
    transitionLayout(result, () => {
        result.replaceChildren(empty); result.className = 'result-box';
    }, { signal: view.controller.signal });
}

function convertTimestamp(view) {
    view.timestampAttempted = true;
    try {
        const parsed = parseTimestamp(node(view, 'timestampInput').value, view.unit);
        const result = describeInstant(parsed.milliseconds);
        showRows(view, 'dateResult', [['iso', 'ISO 8601', result.iso], ['local', '本地时间', result.local], ['utc', 'UTC', result.utc]]);
        node(view, 'timestampInput').removeAttribute('aria-invalid');
        status(view, 'timestampStatus', (parsed.automatic ? '自动识别为' : '已按') + UNIT_LABELS[parsed.unit] + ' · 转换完成', 'success');
    } catch (error) {
        clearResult(view, 'dateResult', '修正输入后，按 Enter 重新转换。');
        node(view, 'timestampInput').setAttribute('aria-invalid', 'true');
        status(view, 'timestampStatus', error.message, 'error');
    }
}

function convertDate(view) {
    view.dateAttempted = true;
    try {
        const result = describeInstant(parseDateTime(node(view, 'dateInput').value, view.dateZone));
        showRows(view, 'timestampResult', [['seconds', 'Unix 秒', result.seconds], ['milliseconds', 'Unix 毫秒', result.milliseconds], ['iso', 'ISO 8601', result.iso]]);
        node(view, 'dateInput').removeAttribute('aria-invalid');
        status(view, 'dateStatus', '按' + (view.dateZone === 'utc' ? ' UTC ' : '本地时间') + '转换完成', 'success');
    } catch (error) {
        clearResult(view, 'timestampResult', '选择有效日期时间后，按 Enter 转换。');
        node(view, 'dateInput').setAttribute('aria-invalid', 'true');
        status(view, 'dateStatus', error.message, 'error');
    }
}

function updateCurrentTime(view) {
    const now = Date.now();
    node(view, 'currentTimestamp').textContent = String(view.currentUnit === 'sec' ? Math.floor(now / 1000) : now);
    const date = new Date(now);
    node(view, 'currentTimeLabel').textContent = date.toLocaleString('zh-CN', { hourCycle: 'h23' })
        + ' · ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const reference of TIMESTAMP_REFERENCES) {
        const text = view.root.querySelector('[data-timestamp-reference="' + reference.id + '"] .quick-ref-value');
        if (text) text.textContent = String(Math.floor(resolveTimestampReference(reference.id, now) / 1000));
    }
}
function stopClock(view) {
    if (view.interval !== null) clearInterval(view.interval);
    view.interval = null;
}
function startClock(view) {
    stopClock(view);
    if (!active(view) || document.hidden || document.documentElement.classList.contains('app-is-suspended')) return;
    updateCurrentTime(view);
    view.interval = setInterval(() => { if (active(view)) updateCurrentTime(view); }, 1000);
}

async function copyValue(view, value, button, statusId) {
    try {
        await navigator.clipboard.writeText(value);
        if (!active(view)) return;
        status(view, statusId, '已复制到剪贴板', 'success');
        const icon = button.querySelector('i');
        if (icon) icon.className = 'ri-check-line';
        clearTimeout(view.copyTimers.get(button));
        const timer = setTimeout(() => {
            view.copyTimers.delete(button);
            if (active(view) && icon) icon.className = 'ri-file-copy-line';
        }, 1500);
        view.copyTimers.set(button, timer);
    } catch {
        if (active(view)) status(view, statusId, '复制失败，请手动选择结果复制。', 'error');
    }
}

async function pasteTimestamp(view) {
    if (view.pasting) return;
    const revision = view.timestampRevision;
    view.pasting = true;
    const button = node(view, 'timestampPasteBtn'); button.disabled = true;
    try {
        const text = await navigator.clipboard.readText();
        if (!active(view) || revision !== view.timestampRevision) return;
        node(view, 'timestampInput').value = text.trim().slice(0, 64);
        view.timestampRevision++;
        convertTimestamp(view);
    } catch {
        if (active(view) && revision === view.timestampRevision) {
            status(view, 'timestampStatus', '无法读取剪贴板，请使用 Ctrl + V。', 'error');
        }
    } finally {
        if (active(view)) { view.pasting = false; button.disabled = false; }
    }
}

function initTimestampTool() {
    destroyTimestampTool();
    const root = document.querySelector('.timestamp-container');
    if (!root) return;
    const view = { root, controller: new AbortController(), unit: 'auto', currentUnit: 'sec', dateZone: 'local',
        timestampRevision: 0, timestampAttempted: false, dateAttempted: false, restoring: false,
        interval: null, copyTimers: new Map(), pasting: false };
    state = view;
    const { signal } = view.controller;
    const on = (target, event, handler) => target.addEventListener(event, handler, { signal });
    node(view, 'dateInput').value = formatDateTimeInput(Date.now());
    for (const reference of TIMESTAMP_REFERENCES) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'quick-ref-item'; button.dataset.timestampReference = reference.id;
        const label = document.createElement('span'); label.className = 'quick-ref-label'; label.textContent = reference.label;
        const value = document.createElement('span'); value.className = 'quick-ref-value dw-mono';
        button.append(label, value); node(view, 'quickReferenceGrid').append(button);
        on(button, 'click', () => {
            node(view, 'timestampInput').value = describeInstant(resolveTimestampReference(reference.id)).seconds;
            view.unit = 'sec'; view.timestampRevision++; updateModes(view); convertTimestamp(view);
        });
    }
    root.querySelectorAll('[data-timestamp-unit]').forEach(button => on(button, 'click', () => {
        view.unit = button.dataset.timestampUnit; view.timestampRevision++; updateModes(view);
        if (node(view, 'timestampInput').value.trim()) convertTimestamp(view);
    }));
    root.querySelectorAll('[data-current-unit]').forEach(button => on(button, 'click', () => {
        view.currentUnit = button.dataset.currentUnit; updateModes(view); updateCurrentTime(view);
    }));
    root.querySelectorAll('[data-date-zone]').forEach(button => on(button, 'click', () => {
        view.dateZone = button.dataset.dateZone; updateModes(view);
        if (node(view, 'dateInput').value) convertDate(view);
    }));
    on(node(view, 'timestampInput'), 'input', () => {
        view.timestampRevision++; view.timestampAttempted = false;
        node(view, 'timestampInput').removeAttribute('aria-invalid');
        clearResult(view, 'dateResult', '输入已更新，按 Enter 转换。');
        status(view, 'timestampStatus', '按 Enter 或点击“转换日期”。');
    });
    on(node(view, 'dateInput'), 'input', () => {
        view.dateAttempted = false; node(view, 'dateInput').removeAttribute('aria-invalid');
        clearResult(view, 'timestampResult', '日期已更新，按 Enter 转换。');
        status(view, 'dateStatus', '按 Enter 或点击“转换时间戳”。');
    });
    on(node(view, 'toDateBtn'), 'click', () => convertTimestamp(view));
    on(node(view, 'toTimestampBtn'), 'click', () => convertDate(view));
    on(node(view, 'timestampNowBtn'), 'click', () => {
        const now = Date.now();
        node(view, 'timestampInput').value = view.unit === 'sec' ? describeInstant(now).seconds : String(now);
        view.timestampRevision++; convertTimestamp(view);
    });
    on(node(view, 'nowBtn'), 'click', () => {
        node(view, 'dateInput').value = formatDateTimeInput(Date.now(), view.dateZone); convertDate(view);
    });
    on(node(view, 'timestampPasteBtn'), 'click', () => { void pasteTimestamp(view); });
    on(node(view, 'copyCurrentBtn'), 'click', event => {
        void copyValue(view, node(view, 'currentTimestamp').textContent, event.currentTarget, 'timestampStatus');
    });
    on(root, 'click', event => {
        const button = event.target.closest('[data-copy]');
        if (button) void copyValue(view, button.dataset.copy, button,
            button.closest('#timestampResult') ? 'dateStatus' : 'timestampStatus');
    });
    for (const [id, convert] of [['timestampInput', convertTimestamp], ['dateInput', convertDate]]) {
        on(node(view, id), 'keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); convert(view); }
        });
    }
    on(document, 'visibilitychange', () => { if (document.hidden) stopClock(view); else startClock(view); });
    on(window, 'dtkit:power-state', event => { if (event.detail?.suspended) stopClock(view); else startClock(view); });
    root.querySelectorAll('.dw-segmented').forEach(group => mountSegmentedControl(group, { signal }));
    updateModes(view); updateCurrentTime(view); startClock(view);
    revealContent(root, { signal });
}

function serializePageDraft() {
    if (!state) return null;
    const view = state;
    const input = node(view, 'timestampInput');
    return { version: 1, timestamp: input.value, unit: view.unit, currentUnit: view.currentUnit,
        date: node(view, 'dateInput').value, dateZone: view.dateZone,
        timestampAttempted: view.timestampAttempted, dateAttempted: view.dateAttempted,
        selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
        focusedField: document.hasFocus() ? document.activeElement?.id : null };
}

function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return;
    const view = state; view.restoring = true; view.timestampRevision++;
    view.unit = ['auto', 'sec', 'ms'].includes(snapshot.unit) ? snapshot.unit : 'auto';
    view.currentUnit = ['sec', 'ms'].includes(snapshot.currentUnit) ? snapshot.currentUnit : 'sec';
    view.dateZone = ['local', 'utc'].includes(snapshot.dateZone) ? snapshot.dateZone : 'local';
    node(view, 'timestampInput').value = typeof snapshot.timestamp === 'string' ? snapshot.timestamp.slice(0, 64) : '';
    node(view, 'dateInput').value = typeof snapshot.date === 'string' ? snapshot.date.slice(0, 64) : '';
    node(view, 'timestampInput').removeAttribute('aria-invalid');
    node(view, 'dateInput').removeAttribute('aria-invalid');
    status(view, 'timestampStatus', '按 Enter 或点击“转换日期”。');
    status(view, 'dateStatus', '按 Enter 或点击“转换时间戳”。');
    updateModes(view); updateCurrentTime(view);
    view.timestampAttempted = snapshot.timestampAttempted === true;
    view.dateAttempted = snapshot.dateAttempted === true;
    if (view.timestampAttempted) convertTimestamp(view);
    else clearResult(view, 'dateResult', '按 Enter 转换当前输入。');
    if (view.dateAttempted) convertDate(view);
    else clearResult(view, 'timestampResult', '按 Enter 转换当前日期时间。');
    const input = node(view, 'timestampInput');
    if (Number.isInteger(snapshot.selectionStart) && Number.isInteger(snapshot.selectionEnd)) {
        input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
    view.restoring = false;
    if (['timestampInput', 'dateInput'].includes(snapshot.focusedField)
        && !document.documentElement.classList.contains('app-is-suspended') && document.hasFocus()) {
        node(view, snapshot.focusedField).focus({ preventScroll: true });
    }
}

function destroyTimestampTool() {
    if (!state) return;
    const view = state; state = null;
    stopClock(view); view.controller.abort();
    for (const timer of view.copyTimers.values()) clearTimeout(timer);
    view.copyTimers.clear();
}

registerTool({
    id: 'timestamp-converter', name: '时间戳转换', icon: 'ri-time-line', colorClass: 'tool-card__icon--blue',
    category: 'dev', description: '在 Unix 时间戳和日期时间之间相互转换。',
    template: getTemplate, init: initTimestampTool, destroy: destroyTimestampTool,
    serialize: serializePageDraft, restore: restorePageDraft
});

export { initTimestampTool, destroyTimestampTool };
