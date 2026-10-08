import { escapeHtml as e } from '../../core/html.js';
import { COLORS, DAYS, EDUCATIONS, currentWeek, dateKey, formatWeeks } from './model.js';
import { courseTime } from './view.js';

export const COLOR_HEX = { blue: '#aac7ed', green: '#b5d5a9', purple: '#cbb5e5', orange: '#e9c69b', rose: '#e9b1c5', cyan: '#a6d7d2' };
const COLOR_NAMES = ['雾蓝', '青绿', '藤紫', '杏橙', '樱粉', '湖青'];
const checked = value => value ? ' checked' : '';
const selected = value => value ? ' selected' : '';
const field = (label, id, type, value, extra = '') => `<label class="tt-field">${label}<input id="${id}" type="${type}" value="${e(value)}" ${extra}></label>`;
const dayOptions = value => DAYS.map((name, index) => `<option value="${index + 1}"${selected(value === index + 1)}>${name}</option>`).join('');
const periodOptions = (value, count) => Array.from({ length: count }, (_, index) => `<option value="${index + 1}"${selected(value === index + 1)}>第 ${index + 1} 节</option>`).join('');
export const actions = (primary, extra = '') => `<footer class="tt-dialog-actions">${extra}<button class="tt-button" type="button" data-tt-action="close">取消</button><button class="tt-button tt-button--primary" type="submit">${primary}</button></footer>`;
export function courseForm(state, course) {
    return `<form id="ttCourseForm"><div class="tt-dialog-body"><div class="tt-form-grid">
        <label class="tt-field tt-field--full">课程名称<input id="ttCourseName" maxlength="120" required value="${e(course?.name || '')}" placeholder="例如：高等数学" autofocus></label>
        ${field('教室 / 地点', 'ttCourseRoom', 'text', course?.room || '', 'maxlength="120" placeholder="例如：教学楼 A-302"')}
        ${field('授课教师', 'ttCourseTeacher', 'text', course?.teacher || '', 'maxlength="80"')}
        <label class="tt-field">星期<select id="ttCourseDay">${dayOptions(course?.day || 1)}</select></label>
        <label class="tt-field">周次规律<select id="ttCourseParity"><option value="all">每周 / 指定周</option><option value="odd">仅单周</option><option value="even">仅双周</option></select></label>
        <label class="tt-field">开始节次<select id="ttCourseStart">${periodOptions(course?.start || 1, state.semester.periods.length)}</select></label>
        <label class="tt-field">结束节次<select id="ttCourseEnd">${periodOptions(course?.end || 2, state.semester.periods.length)}</select></label>
        <label class="tt-field tt-field--full">上课周次<input id="ttCourseWeeks" required value="${e(course ? formatWeeks(course.weeks) : `1-${state.semester.totalWeeks}`)}" placeholder="1-16 或 1-4,6,8-12"><small class="tt-hint">范围和单周可用逗号组合，单双周会进一步筛选。不同周的课程可共用节次。</small></label>
        <div class="tt-field tt-field--full">课程颜色<div class="tt-color-choices">${COLORS.map((color, index) => `<label class="tt-color-choice"><input type="radio" name="ttCourseColor" value="${color}"${checked((course?.color || 'blue') === color)}><i data-swatch="${color}"></i>${COLOR_NAMES[index]}</label>`).join('')}</div></div>
        <label class="tt-field tt-field--full">备注<textarea id="ttCourseNotes" maxlength="1000" rows="2" placeholder="教材、上课要求等（选填）">${e(course?.notes || '')}</textarea></label>
    </div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('保存课程', course?.id ? '<button class="tt-button tt-button--danger" type="button" data-tt-action="delete-course">删除课程</button>' : '')}</form>`;
}
export function periodRows(periods) {
    return periods.map((period, index) => `<label class="tt-period-edit"><span>第 ${index + 1} 节</span><input type="time" required data-period-start aria-label="第 ${index + 1} 节开始时间" value="${e(period.start)}"><span>—</span><input type="time" required data-period-end aria-label="第 ${index + 1} 节结束时间" value="${e(period.end)}"></label>`).join('');
}
export function settingsForm(state) {
    const { settings: s, semester: t } = state;
    const week = Math.max(1, Math.min(t.totalWeeks, currentWeek(state)));
    return `<form id="ttSettingsForm"><nav class="tt-settings-nav" role="tablist" aria-label="课表设置">
        ${[['basic', '基本设置'], ['features', '特色设置'], ['transfer', '导入与导出'], ['other', '其他设置']].map(([id, label], index) => `<button id="ttTab-${id}" type="button" role="tab" aria-selected="${index === 0}" aria-controls="ttSection-${id}" data-tt-action="settings-tab" data-tab="${id}">${label}</button>`).join('')}</nav><div class="tt-dialog-body">
        <section id="ttSection-basic" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-basic"><h4>学期与周次</h4><div class="tt-form-grid">
            ${field('学期名称', 'ttSemesterName', 'text', t.name, 'maxlength="80" required')}
            ${field('本学期总周数', 'ttTotalWeeks', 'number', t.totalWeeks, 'min="1" max="60" required')}
            ${field('第一周开始上课日期', 'ttStartDate', 'date', t.startDate, 'required')}
            ${field('当前周数', 'ttCurrentWeek', 'number', week, 'min="1" max="60" required')}
            <label class="tt-field tt-field--full">每周起始日<select id="ttWeekStart">${dayOptions(s.weekStartsOn)}</select></label>
        </div><p class="tt-hint">当前周数随日期自动推进。修改当前周数会同步调整第一周日期；指定日期所在的周计为第一周。</p>
        <div class="tt-checks"><label><input id="ttShowWeekend" type="checkbox"${checked(s.showWeekend)}>显示周末</label><label><input id="ttShowOther" type="checkbox"${checked(s.showOtherWeeks)}>显示非本周课程</label></div>
        <h4>节次与作息</h4><div class="tt-form-grid">
            ${field('每天节数', 'ttPeriodCount', 'number', t.periods.length, 'min="1" max="24" required')}
            ${field('第一节开始上课时间', 'ttFirstTime', 'time', t.periods[0].start, 'required')}
            ${field('每节时长（分钟）', 'ttDuration', 'number', 45, 'min="10" max="180" required')}
            ${field('课间时长（分钟）', 'ttRest', 'number', 10, 'min="0" max="120" required')}
        </div><p class="tt-hint">点击生成后可逐节调整。默认第 5 节不早于 14:00，第 9 节不早于 19:00。减少节数或总周数前，请先调整超出范围的课程。</p>
        <button class="tt-button" type="button" data-tt-action="generate-periods">生成节次时间</button><div id="ttPeriodRows" class="tt-period-table">${periodRows(t.periods)}</div></section>
        <section id="ttSection-features" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-features" hidden><h4>课表背景</h4><div class="tt-form-grid">
            <label class="tt-field">背景样式<select id="ttBackground"><option value="paper"${selected(s.background.preset === 'paper')}>素纸</option><option value="mint"${selected(s.background.preset === 'mint')}>薄荷</option><option value="sky"${selected(s.background.preset === 'sky')}>晴空</option><option value="lavender"${selected(s.background.preset === 'lavender')}>浅紫</option><option value="image"${selected(s.background.preset === 'image')}>自定义图片</option></select></label>
            ${field('图片遮罩（40–100%，越高越清晰）', 'ttBackgroundDim', 'number', s.background.dim, 'min="40" max="100" required')}
            <label class="tt-field tt-field--full">选择本地背景图片<input id="ttBackgroundFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
        </div><p id="ttBackgroundInfo" class="tt-hint">${s.background.image ? '已保存自定义图片，可重新选择或移除。' : '静态图片自动缩小到 1280 像素以内，保存在本机。'}</p><button class="tt-button" type="button" data-tt-action="remove-background">移除自定义图片</button>
        <h4>桌面小部件</h4><div class="tt-form-grid"><label class="tt-field">显示内容<select id="ttWidgetMode"><option value="today"${selected(s.widgetMode === 'today')}>今日课程</option><option value="week"${selected(s.widgetMode === 'week')}>本周课表</option></select></label><label class="tt-field">窗口位置<select id="ttWidgetPinned"><option value="false"${selected(!s.widgetPinned)}>普通桌面浮窗</option><option value="true"${selected(s.widgetPinned)}>始终置顶</option></select></label></div>
        <p class="tt-hint">只在添加时创建一个小窗，关闭即释放。数据变化、上下课和跨日时更新，隐藏时暂停计时；没有每秒刷新，也不会随启动自动打开。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="widget-open">添加 / 显示小部件</button><button class="tt-button" type="button" data-tt-action="widget-close">收起小部件</button></div><p class="tt-hint">添加时会保存当前设置；桌面小部件需在 DtKit 桌面版中使用。</p></section>
        <section id="ttSection-transfer" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-transfer" hidden><h4>导入</h4><p class="tt-hint">JSON 可恢复全部设置、背景和历史学期。CSV 可合并或替换当前学期课程。文件会先校验并显示预览，再由你确认导入。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="import">选择 JSON / CSV 文件</button><button class="tt-button" type="button" data-tt-action="csv-template">下载 CSV 模板</button></div>
        <h4>导出</h4><p class="tt-hint">JSON 用于完整备份；CSV 用于表格编辑；ICS 可导入日历，按本机当地时间排课；PNG 保存当前正在查看的一周。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="export-json">完整备份 JSON</button><button class="tt-button" type="button" data-tt-action="export-csv">课程 CSV</button><button class="tt-button" type="button" data-tt-action="export-ics">日历 ICS</button><button class="tt-button" type="button" data-tt-action="export-png">本周图片 PNG</button></div><p class="tt-hint">导出使用已保存的数据。编辑设置后请先保存。</p></section>
        <section id="ttSection-other" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-other" hidden><h4>个人设置</h4><label class="tt-field">学历 / 学段<select id="ttEducation">${EDUCATIONS.map(level => `<option${selected(s.education === level)}>${level}</option>`).join('')}</select></label><p class="tt-hint">学历仅用于标记，不会改动你的节次和课程。</p>
        <h4>新学期</h4><p class="tt-hint">当前学期归档，新学期从空白课表开始，保留作息和外观设置。最多保留 10 个历史学期。</p><button class="tt-button" type="button" data-tt-action="new-semester">开始新学期</button><h4>历史学期</h4><div id="ttArchives">${state.archives.length ? state.archives.map(item => `<div class="tt-archive-row"><div>${e(item.name)}<small>${e(item.startDate)} · ${item.courses.length} 条课程安排</small></div><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="restore-archive" data-id="${e(item.id)}">切换</button><button class="tt-button tt-button--danger" type="button" data-tt-action="delete-archive" data-id="${e(item.id)}">删除</button></div></div>`).join('') : '<p class="tt-hint">还没有归档学期。</p>'}</div>
        <h4>数据保存</h4><p class="tt-hint">课表自动保存在当前设备的应用本地存储中。建议定期导出 JSON 备份；清除应用数据会移除本地课表。</p></section>
        <p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('保存设置')}</form>`;
}
export function courseList(state, query = '') {
    const courses = state.semester.courses.filter(course => `${course.name} ${course.room} ${course.teacher}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .sort((a, b) => a.day - b.day || a.start - b.start);
    return courses.length ? courses.map(course => `<article class="tt-course-row"><div><strong>${e(course.name)}</strong><p>${DAYS[course.day - 1]} · ${course.start}–${course.end} 节 · ${courseTime(course, state.semester)} · 第 ${formatWeeks(course.weeks)} 周</p><p>${e([course.room, course.teacher].filter(Boolean).join(' · ') || '未填写教室 / 教师')}</p></div><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="edit" data-id="${e(course.id)}">编辑</button><button class="tt-button" type="button" data-tt-action="duplicate" data-id="${e(course.id)}">复制安排</button></div></article>`).join('') : '<p class="tt-hint">没有匹配的课程。可以添加课程或导入 CSV。</p>';
}
export function semesterForm(state) {
    return `<form id="ttNewSemesterForm"><div class="tt-dialog-body"><p class="tt-hint">「${e(state.semester.name)}」的 ${state.semester.courses.length} 条课程安排会完整归档，可随时切换回来。</p><div class="tt-form-grid">${field('新学期名称', 'ttNewSemesterName', 'text', '', 'maxlength="80" required placeholder="例如：2026–2027 学年第二学期" autofocus')}${field('总周数', 'ttNewSemesterWeeks', 'number', state.semester.totalWeeks, 'min="1" max="60" required')}${field('第一周上课日期', 'ttNewSemesterDate', 'date', dateKey(), 'required')}</div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('归档并开始新学期')}</form>`;
}
