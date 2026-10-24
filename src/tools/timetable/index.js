import '../../css/tools/timetable.css';
import { registerTool } from '../toolRegistry.js';
import { escapeHtml as e } from '../../core/html.js';
import { dateKey, currentWeek, weekStart, addDays, weekDays, generatePeriods, validateState, startSemester } from './model.js';
import { STORAGE_KEY, CHANGED_EVENT, readState, updateState } from './store.js';
import { summary, renderGrid, renderWeekAgenda, renderDayPicker, applyBackground } from './view.js';
import { COLOR_HEX, courseForm, additionalArrangement, settingsForm, semesterForm, courseList, periodRows, actions } from './panels.js';
import { exportCsv, importCsv, importJson, exportIcs, download } from './transfer.js';
import { linkedEnd, prepareCourseEdits, replaceArrangements } from './editor.js';
import { attachCourseDetails } from './details.js';
import { template } from './template.js';
import { liveContext, nextLiveRefresh, weekOverview, TimetableHistory } from './core.js';
import { createTimetableMotion } from './motion.js';
import { attachEditorEnhancements } from './editorEnhancements.js';
import { mountSegmentedControl } from '../../core/toolMotion.js';

const byId = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
let state, controller, timer, suspended = false, selectedWeek = 1, followCurrent = true, panelRevision, editId, draftImage = '', imported, busy = false, generation = 0, importRequest = 0, imageRequest = 0;
let draftImageName = '', imageLoading = false;
let editIds = [], hideDetails = null;
let motion, history = new TimetableHistory(), viewMode = 'week', selectedDay = 0, searchQuery = '', gridKey = '', agendaKey = '', lastWeek = 1;
let dialogClosing = false, panelFocus = null, scheduleFrame = null, fitFrame = null, disposeSettingsIndicator = null, panelIntent = 0;
let refreshPending = false;

function fitWeekGrid() {
    fitFrame = null;
    const root = document.querySelector('.tt-shell'), grid = byId('ttGrid'), board = byId('ttBoard');
    if (!root || !state || !board?.offsetParent) return;
    const rootStyle = getComputedStyle(root);
    const width = root.clientWidth - parseFloat(rootStyle.paddingLeft) - parseFloat(rootStyle.paddingRight);
    const periods = state.semester.periods.length;
    if (width < 900 || state.settings.density !== 'compact' || periods > 14) {
        grid.style.removeProperty('--tt-fit-row-height'); grid.classList.remove('is-fitted'); return;
    }
    let viewport = root.parentElement;
    while (viewport && viewport !== document.documentElement && !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
    if (viewport === document.documentElement) viewport = null;
    const boardTop = board.getBoundingClientRect().top;
    // Include the outer page's scroll offset so rows keep their size while scrolling.
    const available = viewport
        ? viewport.clientHeight - (boardTop - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientTop)
        : innerHeight - (boardTop + scrollY);
    const footer = root.querySelector('.tt-footer'), gridStyle = getComputedStyle(grid);
    const footerSpace = footer.getBoundingClientRect().height + parseFloat(getComputedStyle(footer).marginTop);
    const restSpace = Number(gridStyle.getPropertyValue('--tt-rest-count')) * parseFloat(gridStyle.getPropertyValue('--tt-rest-height'));
    const headerSpace = grid.firstElementChild?.getBoundingClientRect().height || 61;
    const rowHeight = Math.max(32, Math.min(54, Math.floor((available - footerSpace - parseFloat(rootStyle.paddingBottom) - headerSpace - restSpace - 3) / periods)));
    const value = `${rowHeight}px`;
    if (grid.style.getPropertyValue('--tt-fit-row-height') !== value) grid.style.setProperty('--tt-fit-row-height', value);
    grid.classList.toggle('is-fitted', rowHeight < 48);
}
function requestGridFit() {
    if (fitFrame == null) fitFrame = requestAnimationFrame(fitWeekGrid);
}

function notice(message = '', error = false, panel = false) {
    const node = byId(panel ? 'ttPanelNotice' : 'ttNotice');
    if (node) { node.textContent = message; node.classList.toggle('is-error', error); }
}
function clampWeek(week) { return Math.max(1, Math.min(state.semester.totalWeeks, week)); }
function render({ animate = true } = {}) {
    if (!state || !byId('ttGrid')) return;
    selectedWeek = clampWeek(followCurrent ? currentWeek(state) : selectedWeek);
    const actual = currentWeek(state), days = weekDays(state, selectedWeek);
    const context = liveContext(state), overview = weekOverview(state, selectedWeek, searchQuery);
    byId('ttSemesterTitle').textContent = `${state.semester.name} · ${actual < 1 ? '尚未开学' : actual > state.semester.totalWeeks ? '学期已结束' : `第 ${actual} 周`} · 共 ${state.semester.totalWeeks} 周`;
    byId('ttLiveBadge').textContent = context.label;
    byId('ttLiveSummary').textContent = context.course?.name || context.label;
    byId('ttLiveDetail').textContent = `${context.detail}${context.remainingMinutes ? ` · ${context.phase === 'current' ? '距下课' : '距上课'} ${context.remainingMinutes} 分钟` : ''}`;
    byId('ttLiveProgress').style.width = `${Math.round(context.progress * 100)}%`;
    byId('ttLiveBadge').closest('.tt-live').dataset.phase = context.phase;
    byId('ttWeekStats').innerHTML = `<span class="tt-stat"><strong>${overview.subjects}</strong><small>门课程</small></span><span class="tt-stat"><strong>${overview.periods}</strong><small>节课</small></span><span class="tt-stat"><strong>${Math.round(overview.minutes / 60 * 10) / 10}</strong><small>小时</small></span><span class="tt-stat"><strong>${overview.days}</strong><small>个上课日</small></span>`;
    byId('ttSearchHint').hidden = !searchQuery;
    byId('ttSearchHint').textContent = overview.arrangements ? `本周匹配 ${overview.arrangements} 条安排 · 周视图淡化其他课程，日程仅显示匹配内容` : '本周没有匹配的课程，试试课程名、教师或教室。';
    byId('ttSearchClear').hidden = !searchQuery;
    byId('ttWeekendToggle').setAttribute('aria-pressed', String(state.settings.showWeekend));
    byId('ttUndo').disabled = !history.canUndo || busy; byId('ttRedo').disabled = !history.canRedo || busy;
    byId('ttUndo').title = history.canUndo ? `撤销：${history.peek('undo').label}（Ctrl+Z）` : '撤销（Ctrl+Z）';
    byId('ttRedo').title = history.canRedo ? `重做：${history.peek('redo').label}（Ctrl+Shift+Z）` : '重做（Ctrl+Shift+Z）';
    document.querySelectorAll('.tt-view-switch [data-tt-action]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.ttAction === `view-${viewMode}`)));
    byId('ttSemesterLabel').textContent = `${state.semester.name} · ${state.settings.education} · ${actual < 1 ? '尚未开学' : actual > state.semester.totalWeeks ? '学期已结束' : `当前第 ${actual} 周`}`;
    const weekMenuKey = `${state.semester.totalWeeks}:${selectedWeek}:${actual}`;
    if (byId('ttWeek').dataset.renderKey !== weekMenuKey) {
        byId('ttWeek').innerHTML = Array.from({ length: state.semester.totalWeeks }, (_, index) => `<option value="${index + 1}"${selectedWeek === index + 1 ? ' selected' : ''}>第 ${index + 1} 周${actual === index + 1 ? ' · 本周' : ''}</option>`).join('');
        byId('ttWeek').dataset.renderKey = weekMenuKey;
    }
    byId('ttPrevious').disabled = selectedWeek === 1; byId('ttNext').disabled = selectedWeek === state.semester.totalWeeks;
    byId('ttDateRange').textContent = `${days[0].date} — ${days.at(-1).date}`;
    byId('ttTodaySummary').textContent = summary(state);
    const visibleDays = new Set(days.map(day => day.day));
    const count = state.semester.courses.filter(course => course.weeks.includes(selectedWeek) && visibleDays.has(course.day)).length;
    const hidden = state.semester.courses.filter(course => course.weeks.includes(selectedWeek) && !visibleDays.has(course.day)).length;
    byId('ttWeekCount').textContent = `${count} 条课程安排${hidden ? ` · ${hidden} 条周末课程已隐藏` : ''}${state.settings.showOtherWeeks ? ' · 虚线表示非本周课程' : ''}`;
    const empty = byId('ttEmpty'); empty.hidden = state.semester.courses.length > 0;
    if (!empty.hidden) empty.innerHTML = '<p>点击空白格添加第一门课，也可以导入 JSON 备份或 CSV 课表。</p>';
    const direction = Math.sign(selectedWeek - lastWeek); lastWeek = selectedWeek;
    const nextGridKey = JSON.stringify([state.revision, selectedWeek, searchQuery, context.phase, context.course?.id, context.segment?.start]);
    if (gridKey !== nextGridKey) {
        hideDetails?.();
        const focused = document.activeElement?.closest('#ttGrid [data-tt-action]');
        const focus = focused ? { id: focused.dataset.id, row: focused.style.gridRow, day: focused.dataset.day, period: focused.dataset.period } : null;
        motion.content(byId('ttBoard'), () => { applyBackground(byId('ttBoard'), state.settings.background); renderGrid(byId('ttGrid'), state, selectedWeek, true, { query: searchQuery }); }, { direction, animate: animate && Boolean(gridKey) && viewMode === 'week' });
        gridKey = nextGridKey;
        if (focus) [...byId('ttGrid').querySelectorAll('[data-tt-action]')].find(button => focus.id ? button.dataset.id === focus.id && button.style.gridRow === focus.row : button.dataset.day === focus.day && button.dataset.period === focus.period)?.focus({ preventScroll: true });
    }
    const availableDays = new Set(days.map(day => day.day));
    if (selectedDay && !availableDays.has(selectedDay)) selectedDay = 0;
    const nextAgendaKey = JSON.stringify([nextGridKey, selectedDay]);
    if (agendaKey !== nextAgendaKey) {
        const pickerFocus = document.activeElement?.closest('#ttDayPicker button')?.dataset.ttDay;
        const pickerKey = JSON.stringify([days, selectedDay]);
        if (byId('ttDayPicker').dataset.renderKey !== pickerKey) {
            renderDayPicker(byId('ttDayPicker'), state, selectedWeek, selectedDay); byId('ttDayPicker').dataset.renderKey = pickerKey;
            if (pickerFocus != null) [...byId('ttDayPicker').querySelectorAll('button')].find(button => button.dataset.ttDay === pickerFocus)?.focus({ preventScroll: true });
        }
        const agendaFocus = document.activeElement?.closest('#ttAgendaList [data-tt-action]')?.dataset.id;
        motion.content(byId('ttAgendaList'), () => renderWeekAgenda(byId('ttAgendaList'), state, selectedWeek, selectedDay, { query: searchQuery }), { direction, animate: animate && Boolean(agendaKey) && viewMode === 'agenda' });
        if (agendaFocus) [...byId('ttAgendaList').querySelectorAll('[data-id]')].find(button => button.dataset.id === agendaFocus)?.focus({ preventScroll: true });
        agendaKey = nextAgendaKey;
    }
    motion.show(byId('ttViews'), byId(viewMode === 'week' ? 'ttBoard' : 'ttAgenda'), { animate });
    requestGridFit();
    schedule();
}
function schedule() {
    clearTimeout(timer);
    if (!state || suspended || document.hidden) return;
    timer = setTimeout(render, nextLiveRefresh(state));
}
function refresh() {
    if (busy) { refreshPending = true; return; }
    refreshPending = false;
    try { const previous = state?.semester.id, revision = state?.revision; state = readState(); if (revision != null && revision !== state.revision) history.clear(); if (previous !== state.semester.id) selectedWeek = clampWeek(currentWeek(state)); render(); }
    catch (error) { notice(error.message, true); }
}
function openPanel(title, html, revision = state.revision) {
    hideDetails?.();
    panelRevision = revision;
    const dialog = byId('ttDialog');
    const wasOpen = dialog.open, reopening = dialogClosing;
    panelIntent++;
    if (!wasOpen) panelFocus = document.activeElement;
    dialogClosing = false;
    byId('ttDialogTitle').textContent = title;
    motion.content(byId('ttDialogContent'), () => { byId('ttDialogContent').innerHTML = html; }, { animate: wasOpen });
    byId('ttDialogContent').querySelectorAll('form').forEach(form => { form.noValidate = true; });
    disposeSettingsIndicator?.(); disposeSettingsIndicator = null;
    const tabs = byId('ttDialogContent').querySelector('.tt-settings-nav');
    if (tabs) disposeSettingsIndicator = mountSegmentedControl(tabs, { signal: controller.signal });
    byId('ttDialogContent').querySelectorAll('[data-swatch]').forEach(node => node.style.setProperty('--swatch', COLOR_HEX[node.dataset.swatch]));
    initializeScheduleLinks(byId('ttDialogContent'));
    if (!dialog.open || reopening) motion.open(dialog);
    (dialog.querySelector('[autofocus]') || dialog.querySelector('input,select,button'))?.focus();
}
async function closePanel() {
    if (busy || dialogClosing) return;
    dialogClosing = true; const ticket = generation, intent = ++panelIntent;
    await motion.close(byId('ttDialog'));
    if (ticket !== generation || intent !== panelIntent) return;
    dialogClosing = false; if (panelFocus?.isConnected) panelFocus.focus({ preventScroll: true }); refresh();
}
function editCourse(course, copy = false) {
    editId = copy ? null : course?.id || null;
    editIds = editId ? [editId] : [];
    openPanel(editId ? '编辑课程' : copy ? '复制课程安排' : '添加课程', courseForm(state, copy ? { ...course, id: null } : course));
}
function editGroup(id) {
    const first = state.semester.courses.find(course => course.id === id);
    const courses = state.semester.courses.filter(course => course.name === first.name).sort((a, b) => a.day - b.day || a.start - b.start);
    editId = courses[0].id; editIds = courses.map(course => course.id);
    openPanel(`编辑课程 · ${courses.length} 条安排`, courseForm(state, courses[0], true));
    for (const course of courses.slice(1)) byId('ttExtraArrangements').insertAdjacentHTML('beforeend', additionalArrangement(state, { ...course, weeks: course.weeks.join(','), parity: 'all' }));
    initializeScheduleLinks(byId('ttExtraArrangements'));
}
function settings() {
    imageRequest++; imageLoading = false; draftImage = state.settings.background.image; draftImageName = state.settings.background.imageName || '';
    openPanel('课表设置', settingsForm(state)); previewAppearance();
}
function previewAppearance() {
    const preview = byId('ttAppearancePreview'); if (!preview) return;
    const preset = byId('ttBackground').value, dim = Number(byId('ttBackgroundDim').value), fit = byId('ttBackgroundFit').value;
    applyBackground(preview, { preset, image: draftImage, dim, fit });
    byId('ttBackgroundPreview').hidden = preset !== 'image' || !draftImage;
    byId('ttBackgroundDimValue').value = `${dim}%`;
    preview.dataset.density = byId('ttDensity').value;
}
function initializeScheduleLinks(container) {
    container.querySelectorAll('#ttCourseStart, [data-schedule="start"]').forEach(input => { input.dataset.previousStart = input.value; });
}
function linkSchedule(target) {
    const primary = target.id === 'ttCourseStart' || target.id === 'ttCourseEnd';
    if (!primary && !target.matches('[data-schedule="start"], [data-schedule="end"]')) return;
    const row = target.closest('.tt-extra-arrangement');
    const start = primary ? byId('ttCourseStart') : row.querySelector('[data-schedule="start"]');
    const end = primary ? byId('ttCourseEnd') : row.querySelector('[data-schedule="end"]');
    if (target === start) end.value = String(linkedEnd(Number(start.dataset.previousStart), Number(end.value), Number(start.value), state.semester.periods.length));
    else if (Number(end.value) < Number(start.value)) start.value = end.value;
    start.dataset.previousStart = start.value;
}
function showTab(tab) {
    const content = byId('ttDialogContent');
    content.querySelectorAll('[data-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === tab)); button.tabIndex = button.dataset.tab === tab ? 0 : -1; });
    const target = byId(`ttSection-${tab}`);
    if (target) motion.show(target.parentElement, target, { selector: '.tt-settings-section' });
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
    s.density = byId('ttDensity').value;
    if (imageLoading) throw new Error('背景图片正在处理，请稍后保存');
    s.background = { preset: byId('ttBackground').value, image: draftImage, imageName: draftImageName, fit: byId('ttBackgroundFit').value, dim: Number(byId('ttBackgroundDim').value) };
    s.widgetMode = byId('ttWidgetMode').value; s.widgetPinned = byId('ttWidgetPinned').value === 'true';
    return validateState(draft);
}
async function commit(mutate, close = true, revision = panelRevision, label = '修改课表') {
    if (busy) return false;
    const ticket = generation, intent = panelIntent;
    const before = structuredClone(state);
    busy = true;
    const buttons = [...byId('ttDialog').querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
    try {
        const result = await updateState(mutate, revision);
        if (ticket !== generation) return false;
        state = result; panelRevision = state.revision; history.record(before, result, label); render();
        if (close && intent === panelIntent && byId('ttDialog').open) { dialogClosing = true; await motion.close(byId('ttDialog')); }
        if (ticket !== generation) return false;
        if (intent === panelIntent) { dialogClosing = false; if (close && panelFocus?.isConnected) panelFocus.focus({ preventScroll: true }); }
        notice('已保存课表。'); return true;
    } catch (error) { if (ticket === generation) notice(error.message, true, true); return false; }
    finally { if (ticket === generation) { busy = false; buttons.forEach(button => { button.disabled = false; }); if (refreshPending) refresh(); else render({ animate: false }); } }
}

async function travelHistory(direction) {
    if (busy || byId('ttDialog').open || !state) return;
    const entry = history.peek(direction); if (!entry) return;
    const ticket = generation, revision = state.revision;
    busy = true; render({ animate: false });
    try {
        const result = await updateState(data => { const next = structuredClone(direction === 'redo' ? entry.after : entry.before); Object.assign(data, next); }, revision);
        if (ticket !== generation) return;
        state = result; history.accept(direction); panelRevision = result.revision;
        notice(`${direction === 'redo' ? '已重做' : '已撤销'}：${entry.label}`);
    } catch (error) { if (ticket === generation) {
        try { if (readState().revision !== state.revision) { history.clear(); state = readState(); } } catch { /* Keep the last verified state available for export. */ }
        notice(error.message, true);
    } }
    finally { if (ticket === generation) { busy = false; if (refreshPending) refresh(); else render(); } }
}
async function submit(event) {
    event.preventDefault();
    if (busy || !validForm(event.target)) return;
    try {
        if (event.target.id === 'ttCourseForm') {
            const selectedColor = event.target.querySelector('[name="ttCourseColor"]:checked').value;
            const common = { name: byId('ttCourseName').value.trim(), teacher: byId('ttCourseTeacher').value.trim(), color: selectedColor === 'custom' ? byId('ttCourseCustomColor').value : selectedColor, notes: byId('ttCourseNotes').value.trim() };
            const first = { id: editId, room: byId('ttCourseRoom').value, day: byId('ttCourseDay').value, start: byId('ttCourseStart').value, end: byId('ttCourseEnd').value, weeks: byId('ttCourseWeeks').value, parity: byId('ttCourseParity').value };
            const schedules = [first, ...[...byId('ttExtraArrangements').children].map(row => ({ id: row.dataset.courseId, ...Object.fromEntries([...row.querySelectorAll('[data-schedule]')].map(input => [input.dataset.schedule, input.value])) }))];
            const originals = editIds.map(id => state.semester.courses.find(course => course.id === id));
            if (originals.some(course => !course)) throw new Error('课程已被删除，请重新打开课表');
            const courses = prepareCourseEdits(common, schedules, originals, state.semester);
            await commit(data => replaceArrangements(data, editIds, courses), true, panelRevision, editIds.length ? '编辑课程' : '添加课程');
        } else if (event.target.id === 'ttSettingsForm') {
            const draft = readSettings();
            await commit(data => { data.settings = draft.settings; data.semester = draft.semester; }, true, panelRevision, '修改课表设置');
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
    event.target.value = '';
    const ticket = generation, request = ++imageRequest, form = byId('ttSettingsForm');
    imageLoading = true;
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
            draftImage = image; draftImageName = file.name; byId('ttBackground').value = 'image';
            byId('ttBackgroundName').textContent = file.name;
            byId('ttBackgroundPreview').src = image; byId('ttBackgroundPreview').hidden = false;
            previewAppearance();
            byId('ttBackgroundInfo').textContent = `图片已压缩至 ${canvas.width} × ${canvas.height}，约 ${Math.round(image.length * .75 / 1024)} KB，保存设置后生效。`;
        } finally { bitmap.close(); }
    } catch (error) { if (ticket === generation && request === imageRequest && form === byId('ttSettingsForm')) notice(error.message, true, true); }
    finally { if (ticket === generation && request === imageRequest) imageLoading = false; }
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
function setLocalPanelOpen(open, restoreFocus = true) {
    motion.disclose(byId('ttLocalPanel'), open);
    byId('ttToolsToggle').setAttribute('aria-expanded', String(open));
    if (open) byId('ttLocalPanel').querySelector('[data-tt-action="import"]')?.focus();
    else if (restoreFocus) byId('ttToolsToggle').focus();
}
function perform(event) {
    const button = event.target.closest('[data-tt-action]'); if (!button || button.disabled || busy) return;
    const action = button.dataset.ttAction;
    if (action === 'toggle-tools') { setLocalPanelOpen(byId('ttToolsToggle').getAttribute('aria-expanded') !== 'true'); return; }
    if (button.closest('.tt-local-panel')) setLocalPanelOpen(false);
    return performAction(action, button);
}
async function performAction(action, button = { dataset: {} }) {
    if (busy) return;
    const id = button.dataset.id;
    try {
        if (action === 'export-raw') { download(localStorage.getItem(STORAGE_KEY) || '', '课表-原始数据.json', 'application/json'); return; }
        if (!state) return;
        notice();
        if (action === 'close') closePanel();
        else if (action === 'undo' || action === 'redo') await travelHistory(action);
        else if (action === 'view-week' || action === 'view-agenda') { viewMode = action === 'view-week' ? 'week' : 'agenda'; render(); }
        else if (action === 'select-day' || action === 'day') { selectedDay = Number(button.dataset.day || button.dataset.ttDay) || 0; render(); }
        else if (action === 'clear-search') { searchQuery = ''; byId('ttSearch').value = ''; render(); byId('ttSearch').focus(); }
        else if (action === 'toggle-weekend') await commit(data => { data.settings.showWeekend = !data.settings.showWeekend; }, false, state.revision, '切换周末显示');
        else if (action === 'help') openPanel('课表使用帮助', `<div class="tt-dialog-body"><p class="tt-hint">周视图看全局，日程按天查看。搜索课程、教师或教室时，周视图保留原位置并淡化其他课程。</p><div class="tt-shortcuts"><p><kbd>N</kbd> 添加课程　<kbd>/</kbd> 搜索</p><p><kbd>←</kbd> / <kbd>→</kbd> 切换周次　<kbd>T</kbd> 回到本周</p><p><kbd>Ctrl Z</kbd> 撤销　<kbd>Ctrl Shift Z</kbd> 重做</p><p><kbd>Esc</kbd> 关闭面板　<kbd>Ctrl Enter</kbd> 保存表单</p></div><p class="tt-hint">输入框内保留文字编辑快捷键。课表修改最多可撤销 12 步；其他窗口保存后会重置撤销记录，避免覆盖新内容。</p></div>`);
        else if (action === 'settings') settings();
        else if (action === 'transfer') { settings(); showTab('transfer'); }
        else if (action === 'settings-tab') showTab(button.dataset.tab);
        else if (action === 'add') editCourse();
        else if (action === 'add-arrangement') {
            const schedule = Object.fromEntries(['room', 'day', 'start', 'end', 'weeks', 'parity'].map(key => [key, byId(`ttCourse${key[0].toUpperCase()}${key.slice(1)}`).value]));
            byId('ttExtraArrangements').insertAdjacentHTML('beforeend', additionalArrangement(state, schedule));
            initializeScheduleLinks(byId('ttExtraArrangements').lastElementChild);
            byId('ttExtraArrangements').lastElementChild.querySelector('select').focus();
        } else if (action === 'remove-arrangement') { const row = button.closest('.tt-extra-arrangement'); motion.content(byId('ttExtraArrangements'), () => row?.remove()); }
        else if (action === 'add-cell') editCourse({ day: Number(button.dataset.day), start: Number(button.dataset.period), end: Number(button.dataset.period), weeks: Array.from({ length: state.semester.totalWeeks }, (_, index) => index + 1) });
        else if (action === 'edit' || action === 'duplicate') editCourse(state.semester.courses.find(course => course.id === id), action === 'duplicate');
        else if (action === 'edit-group') editGroup(id);
        else if (action === 'manage') openPanel('管理课程', `<div class="tt-dialog-body"><input id="ttCourseSearch" class="tt-search" type="search" aria-label="搜索课程" placeholder="搜索课程名、教室或教师"><div id="ttCourseList" class="tt-course-list">${courseList(state)}</div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div><footer class="tt-dialog-actions"><button class="tt-button tt-button--primary" type="button" data-tt-action="add">添加课程</button></footer>`);
        else if (['previous', 'next', 'today'].includes(action)) { followCurrent = action === 'today'; selectedWeek = followCurrent ? clampWeek(currentWeek(state)) : clampWeek(selectedWeek + (action === 'next' ? 1 : -1)); render(); }
        else if (action === 'generate-periods') {
            byId('ttPeriodRows').innerHTML = periodRows(generatePeriods(Number(byId('ttPeriodCount').value), byId('ttFirstTime').value, Number(byId('ttDuration').value), Number(byId('ttRest').value))); notice('已生成，可继续逐节调整。', false, true);
        } else if (action === 'choose-background') byId('ttBackgroundFile').click();
        else if (action === 'remove-background') {
            imageRequest++; imageLoading = false; draftImage = ''; draftImageName = ''; byId('ttBackground').value = 'paper'; byId('ttBackgroundFile').value = '';
            byId('ttBackgroundPreview').hidden = true; byId('ttBackgroundPreview').removeAttribute('src'); byId('ttBackgroundName').textContent = '尚未设置背景图片';
            previewAppearance();
            byId('ttBackgroundInfo').textContent = '自定义图片已移除，保存设置后生效。';
        }
        else if (action === 'new-semester') openPanel('开始新学期', semesterForm(state));
        else if (action === 'delete-course') confirmPanel('删除课程', `删除「${state.semester.courses.find(course => course.id === editId)?.name}」的这条安排？其他安排会保留。`, 'confirm-delete-course', editId);
        else if (action === 'delete-group') confirmPanel('删除整门课程', `删除「${state.semester.courses.find(course => course.id === editId)?.name}」及其 ${editIds.length} 条安排？`, 'confirm-delete-group', editId);
        else if (action === 'confirm-delete-group') await commit(data => replaceArrangements(data, editIds, []), true, panelRevision, '删除整门课程');
        else if (action === 'confirm-delete-course') await commit(data => { data.semester.courses = data.semester.courses.filter(course => course.id !== id); }, true, panelRevision, '删除课程安排');
        else if (action === 'restore-archive') confirmPanel('切换学期', `切换到「${state.archives.find(item => item.id === id)?.name}」？当前学期会保留在历史学期中。`, 'confirm-restore', id);
        else if (action === 'confirm-restore') {
            if (await commit(data => { const index = data.archives.findIndex(item => item.id === id); if (index < 0) throw new Error('历史学期已不存在'); const target = data.archives[index]; data.archives[index] = data.semester; data.semester = target; })) { selectedWeek = clampWeek(currentWeek(state)); render(); }
        } else if (action === 'delete-archive') confirmPanel('删除归档', `永久删除「${state.archives.find(item => item.id === id)?.name}」？建议先导出完整备份。`, 'confirm-delete-archive', id);
        else if (action === 'confirm-delete-archive') await commit(data => { data.archives = data.archives.filter(item => item.id !== id); });
        else if (action === 'import') byId('ttImportFile').click();
        else if (action === 'csv-template') download(exportCsv([{ name: '示例课程（导入前请修改）', day: 1, start: 1, end: Math.min(2, state.semester.periods.length), weeks: [1], room: 'A-101', teacher: '', color: 'blue', notes: '' }]), '课表导入模板.csv', 'text/csv;charset=utf-8');
        else if (action === 'export-json') download(JSON.stringify(readState(), null, 2), `课表备份-${dateKey()}.json`, 'application/json');
        else if (action === 'export-csv') download(exportCsv(readState().semester.courses), '课表课程.csv', 'text/csv;charset=utf-8');
        else if (action === 'export-ics') download(exportIcs(readState()), '课表日历.ics', 'text/calendar;charset=utf-8');
        else if (action === 'export-png') { const saved = readState(), week = Math.max(1, Math.min(saved.semester.totalWeeks, selectedWeek)); const { exportPng } = await import('./imageExport.js'); await exportPng(saved, week); }
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
    motion = createTimetableMotion(signal); history = new TimetableHistory(); viewMode = 'week'; selectedDay = 0; searchQuery = ''; gridKey = ''; agendaKey = ''; lastWeek = 1; dialogClosing = false;
    const root = document.querySelector('.tt-shell');
    const boardScroll = root.querySelector('.tt-board-scroll');
    const resizeObserver = new ResizeObserver(() => { byId('ttScrollHint').hidden = boardScroll.scrollWidth <= boardScroll.clientWidth + 1; requestGridFit(); });
    resizeObserver.observe(root); resizeObserver.observe(root.parentElement); resizeObserver.observe(root.querySelector('.tt-workspace'));
    signal.addEventListener('abort', () => resizeObserver.disconnect(), { once: true });
    window.addEventListener('resize', requestGridFit, { signal });
    root.dataset.embedded = String(Boolean(window.__DTKIT_TOOL_PAGE__?.embedded));
    document.addEventListener('pointerdown', event => {
        if (byId('ttToolsToggle').getAttribute('aria-expanded') === 'true' && !event.target.closest('.tt-local-panel, .tt-local-panel-toggle')) setLocalPanelOpen(false, false);
    }, { signal });
    document.addEventListener('keydown', event => {
        if (event.isComposing || !state) return;
        const editing = event.target.closest('input,textarea,select,[contenteditable=true]');
        const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase(), dialog = byId('ttDialog');
        if (dialog.open) {
            if (event.key === 'Escape') event.stopPropagation();
            if (modifier && event.key === 'Enter') { const form = dialog.querySelector('form'); if (form && !busy) { event.preventDefault(); form.requestSubmit(); } }
            return;
        }
        if (event.key === 'Escape' && byId('ttToolsToggle').getAttribute('aria-expanded') === 'true') { event.preventDefault(); event.stopPropagation(); setLocalPanelOpen(false); return; }
        if (editing || event.altKey) return;
        if (modifier && key === 'z') { event.preventDefault(); travelHistory(event.shiftKey ? 'redo' : 'undo'); }
        else if (modifier && key === 'y') { event.preventDefault(); travelHistory('redo'); }
        else if (!modifier && key === 'n') { event.preventDefault(); editCourse(); }
        else if (!modifier && (key === '/' || key === 'f')) { event.preventDefault(); byId('ttSearch').focus(); }
        else if (!modifier && key === 't') { event.preventDefault(); performAction('today'); }
        else if (!modifier && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.target.closest('.tt-view-switch,#ttDayPicker')) { event.preventDefault(); performAction(event.key === 'ArrowLeft' ? 'previous' : 'next'); }
    }, { signal, capture: true });
    root.addEventListener('click', perform, { signal }); root.addEventListener('submit', submit, { signal });
    hideDetails = attachCourseDetails(root, () => state, signal);
    attachEditorEnhancements(byId('ttDialogContent'), () => state, { signal });
    root.addEventListener('input', event => {
        if (event.target.id === 'ttSearch') {
            searchQuery = event.target.value.trim(); cancelAnimationFrame(scheduleFrame); scheduleFrame = requestAnimationFrame(() => { scheduleFrame = null; render(); });
        } else if (event.target.id === 'ttCourseSearch') byId('ttCourseList').innerHTML = courseList(state, event.target.value);
        else if (event.target.id === 'ttCourseCustomColor') root.querySelector('[name="ttCourseColor"][value="custom"]').checked = true;
        else if (['ttBackgroundDim', 'ttBackgroundFit', 'ttBackground', 'ttDensity'].includes(event.target.id)) previewAppearance();
    }, { signal });
    root.addEventListener('change', event => {
        if (event.target.id === 'ttWeek') { selectedWeek = Number(event.target.value); followCurrent = false; render(); }
        else if (event.target.id === 'ttImportFile') selectImport(event);
        else if (event.target.id === 'ttBackgroundFile') backgroundFile(event);
        else { syncDate(event); linkSchedule(event.target); if (['ttBackgroundFit', 'ttBackground', 'ttDensity'].includes(event.target.id)) previewAppearance(); }
    }, { signal });
    root.addEventListener('keydown', event => {
        if (event.defaultPrevented) return;
        const tab = event.target.closest('[role="tab"]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...root.querySelectorAll('[role="tab"]')], index = tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); tabs[next].focus(); showTab(tabs[next].dataset.tab);
    }, { signal });
    byId('ttDialog').addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); if (!busy) closePanel(); }, { signal });
    byId('ttDialog').addEventListener('close', refresh, { signal });
    window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) refresh(); }, { signal });
    window.addEventListener(CHANGED_EVENT, refresh, { signal });
    window.addEventListener('dtkit:power-state', event => { suspended = Boolean(event.detail?.suspended); if (suspended) clearTimeout(timer); else refresh(); }, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); }, { signal });
    window.addEventListener('focus', refresh, { signal });
    try { state = readState(); followCurrent = true; selectedWeek = clampWeek(currentWeek(state)); render({ animate: false }); }
    catch (error) {
        state = null; notice(error.message, true);
        root.querySelectorAll('button,select').forEach(button => { button.disabled = true; });
        byId('ttEmpty').hidden = false; byId('ttEmpty').innerHTML = '<div><strong>暂时无法读取课表</strong><p>可以导出原始数据进行恢复。</p></div><button class="tt-button" type="button" data-tt-action="export-raw">导出原始数据</button>';
        byId('ttGrid').innerHTML = '<div class="tt-error-state"><strong>暂时无法读取课表</strong><p>原数据已保留，可以导出原始文件进行恢复。</p><button class="tt-button" type="button" data-tt-action="export-raw">导出原始数据</button></div>';
    }
}
function destroy() { generation++; controller?.abort(); controller = null; motion?.dispose(); motion = null; disposeSettingsIndicator?.(); disposeSettingsIndicator = null; clearTimeout(timer); cancelAnimationFrame(scheduleFrame); scheduleFrame = null; cancelAnimationFrame(fitFrame); fitFrame = null; state = null; busy = false; suspended = false; refreshPending = false; imported = null; byId('ttDialog')?.close(); }

function capturePanelDraft() {
    const dialog = byId('ttDialog'), form = dialog?.querySelector('form');
    if (!dialog?.open || !['ttCourseForm', 'ttSettingsForm', 'ttNewSemesterForm'].includes(form?.id)) return null;
    const fields = [...form.querySelectorAll('input[id],select[id],textarea[id],input[type="radio"]')]
        .filter(field => field.type !== 'file' && !field.closest('[data-tt-snapshot]')).map(field => ({ id: field.id, name: field.name, value: field.value.slice(0, 2000), checked: field.checked }));
    const arrangements = [...form.querySelectorAll('.tt-extra-arrangement')].filter(row => !row.closest('[data-tt-snapshot]')).slice(0, 600).map(row => ({ id: row.dataset.courseId,
        ...Object.fromEntries([...row.querySelectorAll('[data-schedule]')].map(input => [input.dataset.schedule, input.value.slice(0, 2000)])) }));
    const active = document.activeElement;
    return { form: form.id, revision: panelRevision, editIds: [...editIds], fields, arrangements,
        tab: form.querySelector('[data-tab][aria-selected="true"]')?.dataset.tab,
        image: form.id === 'ttSettingsForm' ? draftImage : '', imageName: draftImageName,
        focus: form.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, scrollTop: active.scrollTop } : null,
        scrollTop: dialog.scrollTop };
}

function restorePanelDraft(draft) {
    if (!draft || !Array.isArray(draft.fields) || draft.fields.length > 200 || !['ttCourseForm', 'ttSettingsForm', 'ttNewSemesterForm'].includes(draft.form)) return;
    const revision = Number.isSafeInteger(draft.revision) && draft.revision >= 0 ? draft.revision : state.revision;
    if (draft.form === 'ttCourseForm') {
        editIds = Array.isArray(draft.editIds) ? draft.editIds.filter(id => typeof id === 'string' && state.semester.courses.some(course => course.id === id)).slice(0, 600) : [];
        editId = editIds[0] || null;
        const first = state.semester.courses.find(course => course.id === editId);
        openPanel(editId ? '继续编辑课程' : '继续添加课程', courseForm(state, first, editIds.length > 1), revision);
        byId('ttCourseForm').dataset.editIds = JSON.stringify(editIds);
        for (const schedule of Array.isArray(draft.arrangements) ? draft.arrangements.slice(0, 600) : []) {
            if (!schedule || ['room', 'weeks', 'parity'].some(key => typeof schedule[key] !== 'string' || schedule[key].length > 2000)) continue;
            const safe = { ...schedule, id: editIds.includes(schedule.id) ? schedule.id : null };
            byId('ttExtraArrangements').insertAdjacentHTML('beforeend', additionalArrangement(state, safe));
        }
    } else if (draft.form === 'ttSettingsForm') { settings(); panelRevision = revision; }
    else openPanel('继续设置新学期', semesterForm(state), revision);
    const form = byId(draft.form);
    for (const field of draft.fields) {
        if (!field || typeof field.value !== 'string' || field.value.length > 2000) continue;
        const input = field.id ? document.getElementById(field.id) : [...form.querySelectorAll('input[type="radio"]')].find(input => input.name === field.name && input.value === field.value);
        if (!input || input.closest('form') !== form || !input.matches('input:not([type="file"]),select,textarea')) continue;
        if (input.type === 'radio' || input.type === 'checkbox') input.checked = field.checked === true;
        else input.value = field.value;
    }
    if (draft.form === 'ttSettingsForm') {
        if (typeof draft.image === 'string' && draft.image.length <= 600000 && (!draft.image || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(draft.image))) draftImage = draft.image;
        draftImageName = typeof draft.imageName === 'string' ? draft.imageName.slice(0, 255) : '';
        if (['basic', 'features', 'transfer', 'other'].includes(draft.tab)) showTab(draft.tab);
        previewAppearance();
    }
    initializeScheduleLinks(form); form.dispatchEvent(new Event('input', { bubbles: true }));
    const focus = draft.focus && document.getElementById(draft.focus.id);
    if (focus && form.contains(focus) && focus.matches('input,textarea,select')) {
        focus.focus({ preventScroll: true });
        if (['text', 'search', 'textarea'].includes(focus.type) && Number.isInteger(draft.focus.start) && Number.isInteger(draft.focus.end)) focus.setSelectionRange(draft.focus.start, draft.focus.end);
        focus.scrollTop = Math.max(0, Number(draft.focus.scrollTop) || 0);
    }
    byId('ttDialog').scrollTop = Math.max(0, Number(draft.scrollTop) || 0);
}

registerTool({ id: 'timetable', name: '课表', icon: 'ri-calendar-line', colorClass: 'tool-card__icon--green', category: 'utility', status: 'ready', description: '周视图与日程、课程搜索、可视化周次、冲突预览和桌面小部件，从容安排每一周。', template, init, destroy,
    getPagePanel: () => ({ summary: byId('ttSemesterLabel')?.textContent, status: state ? byId('ttTodaySummary')?.textContent : byId('ttNotice')?.textContent,
        hint: state?.semester.courses.length === 0 ? '点击空白格添加第一门课，也可以导入 JSON 备份或 CSV 课表。' : '',
        actions: state ? [
            { id: 'import', label: '导入课表', icon: 'ri-upload-2-line' },
            { id: 'manage', label: '管理课程', icon: 'ri-calendar-line' },
            { id: 'settings', label: '课表设置', icon: 'ri-settings-3-line' },
            { id: 'transfer', label: '导入与导出', icon: 'ri-download-2-line' }
        ] : [{ id: 'export-raw', label: '导出原始数据', icon: 'ri-download-2-line' }] }),
    runPageAction: action => { if (['import', 'manage', 'settings', 'transfer', 'export-raw'].includes(action)) return performAction(action); },
    serialize: () => ({ version: 2, selectedWeek, followCurrent, viewMode, selectedDay, searchQuery, panelDraft: capturePanelDraft() }),
    restore: snapshot => { if (state && snapshot && Number.isInteger(snapshot.selectedWeek)) {
        selectedWeek = clampWeek(snapshot.selectedWeek); followCurrent = Boolean(snapshot.followCurrent);
        viewMode = snapshot.viewMode === 'agenda' ? 'agenda' : 'week'; selectedDay = Number.isInteger(snapshot.selectedDay) && snapshot.selectedDay >= 0 && snapshot.selectedDay <= 7 ? snapshot.selectedDay : 0;
        searchQuery = typeof snapshot.searchQuery === 'string' ? snapshot.searchQuery.slice(0, 240) : ''; byId('ttSearch').value = searchQuery;
        render({ animate: false }); restorePanelDraft(snapshot.panelDraft);
    } }
});
