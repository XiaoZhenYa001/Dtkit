import '../../css/tools/timetable.css';
import { registerTool } from '../toolRegistry.js';
import { escapeHtml as e } from '../../core/html.js';
import { dateKey, newId, currentWeek, weekStart, addDays, weekDays, generatePeriods, parseWeeks, validateCourse, validateState, startSemester, nextBoundary } from './model.js';
import { STORAGE_KEY, CHANGED_EVENT, readState, updateState } from './store.js';
import { summary, renderGrid, applyBackground } from './view.js';
import { COLOR_HEX, courseForm, settingsForm, semesterForm, courseList, periodRows, actions } from './panels.js';
import { exportCsv, importCsv, importJson, exportIcs, download } from './transfer.js';

const byId = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
let state, controller, timer, suspended = false, selectedWeek = 1, followCurrent = true, panelRevision, editId, draftImage = '', imported, busy = false, generation = 0, importRequest = 0, imageRequest = 0;

function template() {
    return `<div class="tt-shell"><header class="tt-header"><div class="tt-heading"><span class="tt-emblem"><i class="ri-calendar-line"></i></span><div><h2>我的课表</h2><p id="ttSemesterLabel">这一周，从容安排。</p></div></div><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="manage">管理课程</button><button class="tt-button" type="button" data-tt-action="settings"><i class="ri-settings-3-line"></i> 设置</button><button class="tt-button tt-button--primary" type="button" data-tt-action="add"><i class="ri-add-line"></i> 添加课程</button></div></header>
        <p id="ttNotice" class="tt-notice" role="status" aria-live="polite"></p><div class="tt-toolbar"><div class="tt-week-control"><button id="ttPrevious" class="tt-button" type="button" data-tt-action="previous" aria-label="上一周"><i class="ri-arrow-left-s-line"></i></button><select id="ttWeek" aria-label="查看周次"></select><button id="ttNext" class="tt-button" type="button" data-tt-action="next" aria-label="下一周"><i class="ri-arrow-right-s-line"></i></button><button class="tt-button" type="button" data-tt-action="today">回到本周</button></div><span id="ttDateRange" class="tt-range"></span></div>
        <div class="tt-today"><span>今天</span><p id="ttTodaySummary"></p></div><div id="ttEmpty" class="tt-empty" hidden></div><section id="ttBoard" class="tt-board" aria-label="每周课表"><div class="tt-board-scroll"><div id="ttGrid" class="tt-grid"></div></div></section><footer class="tt-footer"><span>点击课程查看与编辑 · 点击空白格添加</span><span id="ttWeekCount"></span><span>保存在本机</span></footer>
        <input id="ttImportFile" type="file" accept=".json,.csv,application/json,text/csv" hidden><dialog id="ttDialog" class="tt-dialog" aria-labelledby="ttDialogTitle"><header class="tt-dialog-header"><h3 id="ttDialogTitle"></h3><button class="tt-button" type="button" data-tt-action="close" aria-label="关闭面板">✕</button></header><div id="ttDialogContent"></div></dialog></div>`;
}
function notice(message = '', error = false, panel = false) {
    const node = byId(panel ? 'ttPanelNotice' : 'ttNotice');
    if (node) { node.textContent = message; node.classList.toggle('is-error', error); }
}
function clampWeek(week) { return Math.max(1, Math.min(state.semester.totalWeeks, week)); }
function render() {
    if (!state || !byId('ttGrid')) return;
    selectedWeek = clampWeek(followCurrent ? currentWeek(state) : selectedWeek);
    const actual = currentWeek(state), days = weekDays(state, selectedWeek);
    byId('ttSemesterLabel').textContent = `${state.semester.name} · ${state.settings.education} · ${actual < 1 ? '尚未开学' : actual > state.semester.totalWeeks ? '学期已结束' : `当前第 ${actual} 周`}`;
    byId('ttWeek').innerHTML = Array.from({ length: state.semester.totalWeeks }, (_, index) => `<option value="${index + 1}"${selectedWeek === index + 1 ? ' selected' : ''}>第 ${index + 1} 周${actual === index + 1 ? ' · 本周' : ''}</option>`).join('');
    byId('ttPrevious').disabled = selectedWeek === 1; byId('ttNext').disabled = selectedWeek === state.semester.totalWeeks;
    byId('ttDateRange').textContent = `${days[0].date} — ${days.at(-1).date}`;
    byId('ttTodaySummary').textContent = summary(state);
    const visibleDays = new Set(days.map(day => day.day));
    const count = state.semester.courses.filter(course => course.weeks.includes(selectedWeek) && visibleDays.has(course.day)).length;
    const hidden = state.semester.courses.filter(course => course.weeks.includes(selectedWeek) && !visibleDays.has(course.day)).length;
    byId('ttWeekCount').textContent = `${count} 条课程安排${hidden ? ` · ${hidden} 条周末课程已隐藏` : ''}${state.settings.showOtherWeeks ? ' · 虚线表示非本周课程' : ''}`;
    const empty = byId('ttEmpty'); empty.hidden = state.semester.courses.length > 0;
    if (!empty.hidden) empty.innerHTML = '<div><strong>给这一周添上第一门课</strong><p>手动添加，也可以从 JSON 备份或 CSV 导入。</p></div><button class="tt-button" type="button" data-tt-action="import">导入课表</button>';
    applyBackground(byId('ttBoard'), state.settings.background);
    renderGrid(byId('ttGrid'), state, selectedWeek);
    schedule();
}
function schedule() {
    clearTimeout(timer);
    if (!state || suspended || document.hidden) return;
    timer = setTimeout(render, nextBoundary(state));
}
function refresh() {
    if (busy) return;
    try { const previous = state?.semester.id; state = readState(); if (previous !== state.semester.id) selectedWeek = clampWeek(currentWeek(state)); render(); }
    catch (error) { notice(error.message, true); }
}
function openPanel(title, html, revision = state.revision) {
    panelRevision = revision;
    const dialog = byId('ttDialog');
    byId('ttDialogTitle').textContent = title; byId('ttDialogContent').innerHTML = html;
    byId('ttDialogContent').querySelectorAll('form').forEach(form => { form.noValidate = true; });
    byId('ttDialogContent').querySelectorAll('[data-swatch]').forEach(node => node.style.setProperty('--swatch', COLOR_HEX[node.dataset.swatch]));
    if (!dialog.open) dialog.showModal();
    (dialog.querySelector('[autofocus]') || dialog.querySelector('input,select,button'))?.focus();
}
function closePanel() { if (!busy) { byId('ttDialog').close(); refresh(); } }
function editCourse(course, copy = false) {
    editId = copy ? null : course?.id || null;
    openPanel(editId ? '编辑课程' : copy ? '复制课程安排' : '添加课程', courseForm(state, copy ? { ...course, id: null } : course));
}
function settings() { draftImage = state.settings.background.image; openPanel('课表设置', settingsForm(state)); }
function showTab(tab) {
    byId('ttDialogContent').querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
    byId('ttDialogContent').querySelectorAll('.tt-settings-section').forEach(section => { section.hidden = section.id !== `ttSection-${tab}`; });
}
function validForm(form) {
    if (form.checkValidity()) return true;
    const invalid = form.querySelector(':invalid');
    const section = invalid?.closest('.tt-settings-section');
    if (section) showTab(section.id.replace('ttSection-', ''));
    invalid?.reportValidity(); return false;
}
function readSettings() {
    const draft = structuredClone(state);
    const t = draft.semester, s = draft.settings;
    t.name = byId('ttSemesterName').value.trim(); t.startDate = byId('ttStartDate').value; t.totalWeeks = Number(byId('ttTotalWeeks').value);
    t.periods = [...byId('ttPeriodRows').children].map(row => ({ start: row.querySelector('[data-period-start]').value, end: row.querySelector('[data-period-end]').value }));
    if (t.periods.length !== Number(byId('ttPeriodCount').value)) throw new Error('节数已修改，请先点击「生成节次时间」');
    if (t.periods[0].start !== byId('ttFirstTime').value) throw new Error('第一节开始时间已修改，请生成节次时间或同步修改第 1 节');
    s.showWeekend = byId('ttShowWeekend').checked; s.showOtherWeeks = byId('ttShowOther').checked; s.weekStartsOn = Number(byId('ttWeekStart').value); s.education = byId('ttEducation').value;
    s.background = { preset: byId('ttBackground').value, image: draftImage, dim: Number(byId('ttBackgroundDim').value) };
    s.widgetMode = byId('ttWidgetMode').value; s.widgetPinned = byId('ttWidgetPinned').value === 'true';
    return validateState(draft);
}
async function commit(mutate, close = true) {
    if (busy) return false;
    const ticket = generation;
    busy = true;
    const buttons = [...byId('ttDialog').querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
    try {
        const result = await updateState(mutate, panelRevision);
        if (ticket !== generation) return false;
        state = result; panelRevision = state.revision; render();
        if (close) byId('ttDialog').close();
        notice('已保存课表。'); return true;
    } catch (error) { if (ticket === generation) notice(error.message, true, true); return false; }
    finally { if (ticket === generation) { busy = false; buttons.forEach(button => { button.disabled = false; }); } }
}
async function submit(event) {
    event.preventDefault();
    if (busy || !validForm(event.target)) return;
    try {
        if (event.target.id === 'ttCourseForm') {
            const course = validateCourse({ id: editId || newId(), name: byId('ttCourseName').value.trim(), room: byId('ttCourseRoom').value.trim(), teacher: byId('ttCourseTeacher').value.trim(), day: Number(byId('ttCourseDay').value), start: Number(byId('ttCourseStart').value), end: Number(byId('ttCourseEnd').value), weeks: parseWeeks(byId('ttCourseWeeks').value, state.semester.totalWeeks, byId('ttCourseParity').value), color: event.target.querySelector('[name="ttCourseColor"]:checked').value, notes: byId('ttCourseNotes').value.trim() }, state.semester);
            await commit(data => { const index = data.semester.courses.findIndex(item => item.id === course.id); if (editId && index < 0) throw new Error('课程已被删除，请重新打开课表'); if (index < 0) data.semester.courses.push(course); else data.semester.courses[index] = course; });
        } else if (event.target.id === 'ttSettingsForm') {
            const draft = readSettings();
            await commit(data => { data.settings = draft.settings; data.semester = draft.semester; });
        } else if (event.target.id === 'ttNewSemesterForm') {
            const name = byId('ttNewSemesterName').value, date = byId('ttNewSemesterDate').value, weeks = Number(byId('ttNewSemesterWeeks').value);
            if (await commit(data => startSemester(data, name, date, weeks))) { selectedWeek = clampWeek(currentWeek(state)); render(); }
        } else if (event.target.id === 'ttImportForm') {
            const mode = event.target.querySelector('[name="ttImportMode"]:checked')?.value;
            if (await commit(data => {
                if (imported.type === 'json') { const revision = data.revision; Object.assign(data, structuredClone(imported.value)); data.revision = revision; }
                else data.semester.courses = mode === 'replace' ? imported.value : [...data.semester.courses, ...imported.value];
            })) { selectedWeek = clampWeek(currentWeek(state)); imported = null; render(); notice('课表已导入。'); }
        }
    } catch (error) { notice(error.message, true, true); }
}
function confirmPanel(title, message, action, id) {
    openPanel(title, `<div class="tt-dialog-body"><p class="tt-hint">${e(message)}</p><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div><footer class="tt-dialog-actions"><button class="tt-button" type="button" data-tt-action="close">取消</button><button class="tt-button tt-button--danger" type="button" data-tt-action="${action}" data-id="${e(id)}">确认${title}</button></footer>`, panelRevision);
}
async function selectImport(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const ticket = generation, request = ++importRequest, revision = state.revision;
    try {
        // Pretty JSON and UTF-8 Chinese text can be much larger than the compact
        // UTF-16 record. Allow all valid exported backups, then enforce store limits.
        if (file.size > 16 * 1024 * 1024) throw new Error('导入文件不能超过 16 MB');
        const text = await file.text(); if (ticket !== generation || request !== importRequest) return;
        if (/\.json$/i.test(file.name)) imported = { type: 'json', value: importJson(text) };
        else if (/\.csv$/i.test(file.name)) imported = { type: 'csv', value: importCsv(text, state.semester) };
        else throw new Error('请选择 JSON 或 CSV 文件');
        const json = imported.type === 'json', semester = json ? imported.value.semester : state.semester;
        openPanel('导入预览', `<form id="ttImportForm"><div class="tt-dialog-body"><div class="tt-preview"><h4>${e(file.name)}</h4><p class="tt-hint">${json ? `恢复「${e(semester.name)}」· ${semester.totalWeeks} 周 · ${semester.courses.length} 条课程 · ${imported.value.archives.length} 个历史学期` : `导入 ${imported.value.length} 条课程到「${e(semester.name)}」`}</p><p class="tt-hint">${json ? '确认后替换当前课表、设置和归档。建议先导出完整备份。' : '星期、节次与周次已校验。合并时若与已有课程冲突，将保留原课表并提示。'}</p></div>${json ? '' : '<div class="tt-checks"><label><input type="radio" name="ttImportMode" value="merge" checked>合并到现有课程</label><label><input type="radio" name="ttImportMode" value="replace">替换当前学期课程</label></div>'}<p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions(json ? '确认恢复备份' : '确认导入', '<button class="tt-button" type="button" data-tt-action="export-json">先导出备份</button>')}</form>`, revision);
    } catch (error) { notice(error.message, true, byId('ttDialog').open); notice(error.message, true); }
}
async function backgroundFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    const ticket = generation, request = ++imageRequest, form = byId('ttSettingsForm');
    try {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 15000000) throw new Error('请选择 15 MB 以内的 PNG、JPEG 或 WebP 静态图片');
        const bitmap = await createImageBitmap(file);
        try {
            if (bitmap.width * bitmap.height > 50000000) throw new Error('图片尺寸过大，请选择 5000 万像素以内的图片');
            const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f7f9f6'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const image = canvas.toDataURL('image/jpeg', .78);
            if (image.length > 600000) throw new Error('图片压缩后仍过大，请选择内容更简单的图片');
            if (ticket !== generation || request !== imageRequest || form !== byId('ttSettingsForm')) return;
            draftImage = image; byId('ttBackground').value = 'image'; byId('ttBackgroundInfo').textContent = `图片已压缩至 ${canvas.width} × ${canvas.height}，约 ${Math.round(image.length * .75 / 1024)} KB，保存设置后生效。`;
        } finally { bitmap.close(); }
    } catch (error) { if (ticket === generation) notice(error.message, true, true); }
}
function syncDate(event) {
    if (event.target.id === 'ttCurrentWeek') {
        const value = Number(event.target.value), startsOn = Number(byId('ttWeekStart').value);
        if (Number.isInteger(value) && value >= 1 && value <= 60) byId('ttStartDate').value = addDays(weekStart(dateKey(), startsOn), -(value - 1) * 7);
    } else if (['ttStartDate', 'ttWeekStart', 'ttTotalWeeks'].includes(event.target.id) && byId('ttStartDate').value) {
        const draft = { ...state, settings: { ...state.settings, weekStartsOn: Number(byId('ttWeekStart').value) }, semester: { ...state.semester, startDate: byId('ttStartDate').value } };
        byId('ttCurrentWeek').value = Math.max(1, Math.min(Number(byId('ttTotalWeeks').value) || 60, currentWeek(draft)));
    } else if (event.target.matches('[data-period-start]') && event.target.closest('.tt-period-edit') === byId('ttPeriodRows')?.firstElementChild) byId('ttFirstTime').value = event.target.value;
}
async function perform(event) {
    const button = event.target.closest('[data-tt-action]'); if (!button || button.disabled || busy) return;
    const action = button.dataset.ttAction, id = button.dataset.id;
    try {
        if (action === 'export-raw') { download(localStorage.getItem(STORAGE_KEY) || '', '课表-原始数据.json', 'application/json'); return; }
        if (!state) return;
        notice();
        if (action === 'close') closePanel();
        else if (action === 'settings') settings();
        else if (action === 'settings-tab') showTab(button.dataset.tab);
        else if (action === 'add') editCourse();
        else if (action === 'add-cell') editCourse({ day: Number(button.dataset.day), start: Number(button.dataset.period), end: Number(button.dataset.period), weeks: Array.from({ length: state.semester.totalWeeks }, (_, index) => index + 1) });
        else if (action === 'edit' || action === 'duplicate') editCourse(state.semester.courses.find(course => course.id === id), action === 'duplicate');
        else if (action === 'manage') openPanel('管理课程', `<div class="tt-dialog-body"><input id="ttCourseSearch" class="tt-search" type="search" aria-label="搜索课程" placeholder="搜索课程名、教室或教师"><div id="ttCourseList" class="tt-course-list">${courseList(state)}</div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div><footer class="tt-dialog-actions"><button class="tt-button tt-button--primary" type="button" data-tt-action="add">添加课程</button></footer>`);
        else if (['previous', 'next', 'today'].includes(action)) { followCurrent = action === 'today'; selectedWeek = followCurrent ? clampWeek(currentWeek(state)) : clampWeek(selectedWeek + (action === 'next' ? 1 : -1)); render(); }
        else if (action === 'generate-periods') {
            byId('ttPeriodRows').innerHTML = periodRows(generatePeriods(Number(byId('ttPeriodCount').value), byId('ttFirstTime').value, Number(byId('ttDuration').value), Number(byId('ttRest').value))); notice('已生成，可继续逐节调整。', false, true);
        } else if (action === 'remove-background') { draftImage = ''; byId('ttBackground').value = 'paper'; byId('ttBackgroundFile').value = ''; byId('ttBackgroundInfo').textContent = '自定义图片已移除，保存设置后生效。'; }
        else if (action === 'new-semester') openPanel('开始新学期', semesterForm(state));
        else if (action === 'delete-course') confirmPanel('删除课程', `删除「${state.semester.courses.find(course => course.id === editId)?.name}」的这条安排？其他安排会保留。`, 'confirm-delete-course', editId);
        else if (action === 'confirm-delete-course') await commit(data => { data.semester.courses = data.semester.courses.filter(course => course.id !== id); });
        else if (action === 'restore-archive') confirmPanel('切换学期', `切换到「${state.archives.find(item => item.id === id)?.name}」？当前学期会保留在历史学期中。`, 'confirm-restore', id);
        else if (action === 'confirm-restore') {
            if (await commit(data => { const index = data.archives.findIndex(item => item.id === id); if (index < 0) throw new Error('历史学期已不存在'); const target = data.archives[index]; data.archives[index] = data.semester; data.semester = target; })) { selectedWeek = clampWeek(currentWeek(state)); render(); }
        } else if (action === 'delete-archive') confirmPanel('删除归档', `永久删除「${state.archives.find(item => item.id === id)?.name}」？建议先导出完整备份。`, 'confirm-delete-archive', id);
        else if (action === 'confirm-delete-archive') await commit(data => { data.archives = data.archives.filter(item => item.id !== id); });
        else if (action === 'import') byId('ttImportFile').click();
        else if (action === 'csv-template') download(exportCsv([{ name: '示例课程（导入前请修改）', day: 1, start: 1, end: Math.min(2, state.semester.periods.length), weeks: [1], room: 'A-101', teacher: '', color: 'blue', notes: '' }]), '课表导入模板.csv', 'text/csv;charset=utf-8');
        else if (action === 'export-json') download(JSON.stringify(state, null, 2), `课表备份-${dateKey()}.json`, 'application/json');
        else if (action === 'export-csv') download(exportCsv(state.semester.courses), '课表课程.csv', 'text/csv;charset=utf-8');
        else if (action === 'export-ics') download(exportIcs(state), '课表日历.ics', 'text/calendar;charset=utf-8');
        else if (action === 'export-png') { const { exportPng } = await import('./imageExport.js'); await exportPng(state, selectedWeek); }
        else if (action === 'widget-open' || action === 'widget-close') {
            if (!window.__TAURI__?.core?.invoke) throw new Error('请在 DtKit 桌面版中添加桌面小部件');
            if (action === 'widget-open') { if (!validForm(byId('ttSettingsForm'))) return; const draft = readSettings(); if (!await commit(data => { data.settings = draft.settings; data.semester = draft.semester; }, false)) return; await invoke('open_timetable_widget', { pinned: state.settings.widgetPinned }); }
            else await invoke('close_timetable_widget');
            notice(action === 'widget-open' ? '桌面小部件已打开。' : '小部件已关闭，窗口资源已释放。', false, true);
        }
    } catch (error) { notice(String(error.message || error), true, byId('ttDialog').open); if (!byId('ttDialog').open) notice(String(error.message || error), true); }
}
function init() {
    destroy(); controller = new AbortController(); const { signal } = controller;
    const root = document.querySelector('.tt-shell');
    root.addEventListener('click', perform, { signal }); root.addEventListener('submit', submit, { signal });
    root.addEventListener('input', event => { if (event.target.id === 'ttCourseSearch') byId('ttCourseList').innerHTML = courseList(state, event.target.value); }, { signal });
    root.addEventListener('change', event => {
        if (event.target.id === 'ttWeek') { selectedWeek = Number(event.target.value); followCurrent = false; render(); }
        else if (event.target.id === 'ttImportFile') selectImport(event);
        else if (event.target.id === 'ttBackgroundFile') backgroundFile(event);
        else syncDate(event);
    }, { signal });
    root.addEventListener('keydown', event => {
        const tab = event.target.closest('[role="tab"]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...root.querySelectorAll('[role="tab"]')], index = tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); tabs[next].focus(); showTab(tabs[next].dataset.tab);
    }, { signal });
    byId('ttDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); }, { signal });
    byId('ttDialog').addEventListener('close', refresh, { signal });
    window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) refresh(); }, { signal });
    window.addEventListener(CHANGED_EVENT, refresh, { signal });
    window.addEventListener('dtkit:power-state', event => { suspended = Boolean(event.detail?.suspended); if (suspended) clearTimeout(timer); else refresh(); }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); }, { signal });
    window.addEventListener('focus', refresh, { signal });
    try { state = readState(); followCurrent = true; selectedWeek = clampWeek(currentWeek(state)); render(); }
    catch (error) {
        state = null; notice(error.message, true);
        root.querySelectorAll('button,select').forEach(button => { button.disabled = true; });
        byId('ttEmpty').hidden = false; byId('ttEmpty').innerHTML = '<div><strong>暂时无法读取课表</strong><p>可以导出原始数据进行恢复。</p></div><button class="tt-button" type="button" data-tt-action="export-raw">导出原始数据</button>';
    }
}
function destroy() { generation++; controller?.abort(); controller = null; clearTimeout(timer); state = null; busy = false; suspended = false; imported = null; }
registerTool({ id: 'timetable', name: '课表', icon: 'ri-calendar-line', colorClass: 'tool-card__icon--green', category: 'utility', status: 'ready', description: '一目了然的每周课表，支持单双周、学期归档、导入导出与轻量桌面小部件。', template, init, destroy,
    serialize: () => ({ selectedWeek, followCurrent }),
    restore: snapshot => { if (state && snapshot && Number.isInteger(snapshot.selectedWeek)) { selectedWeek = clampWeek(snapshot.selectedWeek); followCurrent = Boolean(snapshot.followCurrent); render(); } }
});
