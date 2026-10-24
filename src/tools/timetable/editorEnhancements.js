import { COLORS, formatWeeks, parseWeeks } from './model.js';
import { COLOR_HEX } from './appearance.js';
import { analyzeCourseDraft, collisionMessage, toggleWeekSelection } from './editor.js';

const scheduleKeys = ['day', 'start', 'end', 'weeks', 'parity', 'room'];
const primaryId = key => `ttCourse${key[0].toUpperCase()}${key.slice(1)}`;

function scheduleFields(form, row = null) {
    return Object.fromEntries(scheduleKeys.map(key => [key, row ? row.querySelector(`[data-schedule="${key}"]`) : form.querySelector(`#${primaryId(key)}`)]));
}
function values(inputs) { return Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input?.value || ''])); }
function weekSelection(expression, total, parity) {
    try { return parseWeeks(expression, total, parity); } catch { return []; }
}
function sameWeeks(first, second) { return first.length === second.length && first.every((week, index) => week === second[index]); }

export function weekPreset(expression, totalWeeks, parity = 'all') {
    const selected = weekSelection(expression, totalWeeks, parity);
    if (!selected.length) return 'custom';
    const all = Array.from({ length: totalWeeks }, (_, index) => index + 1);
    if (sameWeeks(selected, all)) return 'all';
    if (sameWeeks(selected, all.filter(week => week % 2 === 1))) return 'odd';
    if (sameWeeks(selected, all.filter(week => week % 2 === 0))) return 'even';
    return 'custom';
}

/** Delegated bindings keep inputs, focus and draft selection intact while arrangements are added. */
export function attachEditorEnhancements(container, stateOrGetter, { signal } = {}) {
    const getState = typeof stateOrGetter === 'function' ? stateOrGetter : () => stateOrGetter;
    const controller = new AbortController();
    let queued = false, disposed = false;
    const options = { signal: controller.signal };
    function refresh() {
        queued = false;
        const form = container.querySelector('#ttCourseForm'), state = getState();
        if (disposed || !form || !state) return;
        const total = state.semester.totalWeeks, rows = [...form.querySelectorAll('.tt-extra-arrangement')].filter(row => !row.closest('[data-tt-snapshot]'));
        const inputs = [scheduleFields(form), ...rows.map(row => scheduleFields(form, row))];
        for (const picker of form.querySelectorAll('[data-week-picker]')) {
            if (picker.closest('[data-tt-snapshot]')) continue;
            const row = picker.closest('.tt-extra-arrangement'), fields = scheduleFields(form, row);
            const selected = new Set(weekSelection(fields.weeks.value, total, fields.parity.value));
            const preset = weekPreset(fields.weeks.value, total, fields.parity.value);
            const focusedWeek = picker.querySelector('[data-week]:focus')?.dataset.week || picker.dataset.focusWeek || String([...selected][0] || 1);
            picker.querySelectorAll('[data-week]').forEach(button => {
                button.setAttribute('aria-pressed', String(selected.has(Number(button.dataset.week))));
                button.tabIndex = button.dataset.week === focusedWeek ? 0 : -1;
            });
            picker.querySelectorAll('[data-week-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.weekPreset === preset)));
            const count = picker.querySelector('.tt-week-count');
            if (count) count.textContent = selected.size ? `已选 ${selected.size} / ${total} 周 · 第 ${formatWeeks([...selected])} 周` : '请选择至少一周，或直接填写周次';
            fields.weeks.setAttribute('aria-invalid', String(!selected.size));
        }
        const checked = form.querySelector('[name="ttCourseColor"]:checked');
        const color = checked?.value === 'custom' ? form.querySelector('#ttCourseCustomColor').value : checked?.value || 'blue';
        const fields = { name: form.querySelector('#ttCourseName').value, teacher: form.querySelector('#ttCourseTeacher').value,
            notes: form.querySelector('#ttCourseNotes').value, color };
        let originalIds = [];
        try { originalIds = JSON.parse(form.dataset.editIds || '[]'); } catch { /* An absent preview exclusion never changes saving. */ }
        const result = analyzeCourseDraft(fields, inputs.map(values), state.semester, originalIds);
        const preview = form.querySelector('#ttCourseLivePreview');
        if (!preview) return;
        preview.dataset.tone = result.errors.length ? 'error' : result.collisions.length ? 'warning' : 'success';
        const title = preview.querySelector('strong'), description = preview.querySelector('p'), detail = preview.querySelector('small');
        title.textContent = fields.name.trim() || '新课程预览';
        description.textContent = result.errors.length ? `第 ${result.errors[0].index + 1} 条安排：${result.errors[0].message}` : result.collisions.length ? collisionMessage(result.collisions[0]) : result.summaries[0] || '选择时间和上课周次';
        detail.textContent = result.errors.length ? '修改后会即时更新预览' : `${inputs.length} 条安排 · 全学期 ${result.meetings} 次上课 · ${result.periods} 节${result.collisions.length ? ` · ${result.collisions.length} 处冲突，请调整时间或周次` : ' · 时间无冲突'}`;
        preview.style.setProperty('--preview-color', COLORS.includes(color) ? COLOR_HEX[color] : /^#[a-f\d]{6}$/i.test(color) ? color : COLOR_HEX.blue);
        rows.forEach((row, index) => { const summary = row.querySelector('.tt-arrangement-summary'); if (summary) summary.textContent = result.summaries[index + 1] || ''; });
    }
    function queueRefresh() {
        if (disposed || queued) return;
        queued = true; queueMicrotask(refresh);
    }
    container.addEventListener('input', queueRefresh, options);
    container.addEventListener('change', queueRefresh, options);
    container.addEventListener('click', event => {
        const button = event.target.closest('[data-week], [data-week-preset]');
        const form = button?.closest('#ttCourseForm'), state = getState();
        if (!form || !state || button.disabled) return;
        event.preventDefault();
        const fields = scheduleFields(form, button.closest('.tt-extra-arrangement'));
        const preset = button.dataset.weekPreset;
        if (button.dataset.week) button.closest('[data-week-picker]').dataset.focusWeek = button.dataset.week;
        if (preset === 'custom') { fields.weeks.focus(); fields.weeks.select(); return; }
        if (preset) { fields.weeks.value = `1-${state.semester.totalWeeks}`; fields.parity.value = preset; }
        else { fields.weeks.value = toggleWeekSelection(fields.weeks.value, state.semester.totalWeeks, fields.parity.value, Number(button.dataset.week)); fields.parity.value = 'all'; }
        fields.weeks.dispatchEvent(new Event('input', { bubbles: true }));
        queueRefresh();
    }, options);
    container.addEventListener('keydown', event => {
        const button = event.target.closest('[data-week]');
        if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...button.parentElement.querySelectorAll('[data-week]')], index = buttons.indexOf(button);
        const firstTop = buttons[0].offsetTop, columns = buttons.filter(item => item.offsetTop === firstTop).length || 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns })[event.key]));
        event.preventDefault();
        button.tabIndex = -1; buttons[next].tabIndex = 0; buttons[next].focus();
        button.closest('[data-week-picker]').dataset.focusWeek = buttons[next].dataset.week;
    }, options);
    const observer = new MutationObserver(records => {
        const relevant = node => node.nodeType === 1 && (node.matches('form, .tt-extra-arrangement, #ttCourseForm, #ttExtraArrangements') || node.querySelector('form, .tt-extra-arrangement'));
        if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(relevant))) queueRefresh();
    });
    observer.observe(container, { childList: true, subtree: true });
    function cleanup() { if (disposed) return; disposed = true; controller.abort(); observer.disconnect(); }
    if (signal?.aborted) cleanup(); else signal?.addEventListener('abort', cleanup, { once: true });
    refresh();
    return cleanup;
}
