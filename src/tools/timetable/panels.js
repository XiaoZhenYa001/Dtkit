import { escapeHtml as e } from '../../core/html.js';
import { COLORS, DAYS, EDUCATIONS, currentWeek, dateKey, formatWeeks } from './model.js';
import { courseTime } from './view.js';
import { COLOR_HEX } from './appearance.js';
import { groupCourses } from './editor.js';

export { COLOR_HEX };
const COLOR_NAMES = ['雾蓝', '青绿', '藤紫', '杏橙', '樱粉', '湖青'];
const checked = value => value ? ' checked' : '';
const selected = value => value ? ' selected' : '';
const field = (label, id, type, value, extra = '') => `<label class="tt-field">${label}<input id="${id}" type="${type}" value="${e(value)}" ${extra}></label>`;
const dayOptions = value => DAYS.map((name, index) => `<option value="${index + 1}"${selected(value === index + 1)}>${name}</option>`).join('');
const periodOptions = (value, count) => Array.from({ length: count }, (_, index) => `<option value="${index + 1}"${selected(value === index + 1)}>第 ${index + 1} 节</option>`).join('');
export const actions = (primary, extra = '') => `<footer class="tt-dialog-actions">${extra}<button class="tt-button" type="button" data-tt-action="close">取消</button><button class="tt-button tt-button--primary" type="submit">${primary}</button></footer>`;
export function weekPicker(totalWeeks) {
    return `<div class="tt-week-picker" data-week-picker><div class="tt-week-presets" role="group" aria-label="快捷选择上课周次">${[['all', '全学期'], ['odd', '单周'], ['even', '双周'], ['custom', '自定义']].map(([preset, label]) => `<button class="tt-button" type="button" data-week-preset="${preset}" aria-pressed="false">${label}</button>`).join('')}</div><div class="tt-week-chips" role="group" aria-label="选择具体上课周次">${Array.from({ length: totalWeeks }, (_, index) => `<button type="button" data-week="${index + 1}" aria-label="第 ${index + 1} 周" aria-pressed="false">${index + 1}</button>`).join('')}</div><small class="tt-week-count"></small></div>`;
}
export function courseForm(state, course, group = false) {
    const custom = /^#[a-f\d]{6}$/i.test(course?.color);
    const editIds = course?.id ? group ? state.semester.courses.filter(item => item.name === course.name).map(item => item.id) : [course.id] : [];
    return `<form id="ttCourseForm" data-edit-ids="${e(JSON.stringify(editIds))}"><div class="tt-dialog-body"><div id="ttCourseLivePreview" class="tt-editor-preview" data-tone="neutral" role="status" aria-live="polite" aria-atomic="true"><strong>${e(course?.name || '新课程预览')}</strong><p>选择时间和上课周次，即时检查课程冲突</p><small>每条上课安排可以拥有独立的教室与周次</small></div><div class="tt-form-grid">
        <div class="tt-form-section"><h4>课程信息</h4><span>先记下这门课的基本资料</span></div>
        ${group ? '<p class="tt-hint tt-field--full">名称统一修改；更改教师或颜色会应用到全部安排。各条安排的教室和周次分别保存。</p>' : ''}<label class="tt-field tt-field--full">课程名称<input id="ttCourseName" maxlength="120" required value="${e(course?.name || '')}" placeholder="例如：高等数学" autofocus></label>
        ${field('教室 / 地点（本次安排）', 'ttCourseRoom', 'text', course?.room || '', 'maxlength="120" placeholder="例如：教学楼 A-302"')}
        ${field('授课教师', 'ttCourseTeacher', 'text', course?.teacher || '', 'maxlength="80"')}
        <div class="tt-form-section"><h4>上课安排</h4><span>同一门课可添加多次上课时间</span></div>
        <label class="tt-field">星期<select id="ttCourseDay">${dayOptions(course?.day || 1)}</select></label>
        <label class="tt-field">周次规律<select id="ttCourseParity"><option value="all">每周 / 指定周</option><option value="odd">仅单周</option><option value="even">仅双周</option></select></label>
        <label class="tt-field">开始节次<select id="ttCourseStart">${periodOptions(course?.start || 1, state.semester.periods.length)}</select></label>
        <label class="tt-field">结束节次<select id="ttCourseEnd">${periodOptions(course?.end || Math.min(2, state.semester.periods.length), state.semester.periods.length)}</select></label>
        <label class="tt-field tt-field--full">上课周次<input id="ttCourseWeeks" required value="${e(course ? formatWeeks(course.weeks) : `1-${state.semester.totalWeeks}`)}" aria-describedby="ttCourseWeeksHelp" placeholder="1-16 或 1-4,6,8-12"><small id="ttCourseWeeksHelp" class="tt-hint">点击周次可单独增减，也可以填写范围。单双周会进一步筛选；不同周可共用节次。</small></label>
        <div class="tt-field--full">${weekPicker(state.semester.totalWeeks)}</div>
        <div class="tt-field tt-field--full"><div id="ttExtraArrangements"></div><button class="tt-button" type="button" data-tt-action="add-arrangement"><i class="ri-add-line"></i> 添加上课安排</button><small class="tt-hint">同一门课可在不同时间使用不同教室。每条安排单独设置星期、节次、周次和地点。</small></div>
        <div class="tt-form-section"><h4>颜色与备注</h4><span>让课表更容易辨认</span></div>
        <div class="tt-field tt-field--full">课程颜色<div class="tt-color-choices">${COLORS.map((color, index) => `<label class="tt-color-choice"><input type="radio" name="ttCourseColor" value="${color}"${checked((course?.color || 'blue') === color)}><i data-swatch="${color}"></i>${COLOR_NAMES[index]}</label>`).join('')}</div><div class="tt-color-custom"><label class="tt-color-choice"><input type="radio" name="ttCourseColor" value="custom"${checked(custom)}>自选颜色</label><input id="ttCourseCustomColor" type="color" value="${custom ? e(course.color) : COLOR_HEX.blue}" aria-label="自选课程颜色"></div></div>
        <label class="tt-field tt-field--full">备注<textarea id="ttCourseNotes" maxlength="1000" rows="2" placeholder="教材、上课要求等（选填）">${e(course?.notes || '')}</textarea></label>
    </div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('保存课程', course?.id ? `<button class="tt-button tt-button--danger" type="button" data-tt-action="${group ? 'delete-group' : 'delete-course'}">${group ? '删除整门课程' : '删除课程'}</button>` : '')}</form>`;
}
export function additionalArrangement(state, schedule) {
    return `<section class="tt-extra-arrangement"${schedule.id ? ` data-course-id="${e(schedule.id)}"` : ''}><header><strong>另一次上课安排</strong><button class="tt-button" type="button" data-tt-action="remove-arrangement" aria-label="移除此上课安排">移除</button></header><p class="tt-arrangement-summary" aria-live="polite"></p><div class="tt-form-grid">
        <label class="tt-field">星期<select data-schedule="day">${dayOptions(Number(schedule.day))}</select></label>
        <label class="tt-field">周次规律<select data-schedule="parity"><option value="all"${selected(schedule.parity === 'all')}>每周 / 指定周</option><option value="odd"${selected(schedule.parity === 'odd')}>仅单周</option><option value="even"${selected(schedule.parity === 'even')}>仅双周</option></select></label>
        <label class="tt-field">开始节次<select data-schedule="start">${periodOptions(Number(schedule.start), state.semester.periods.length)}</select></label>
        <label class="tt-field">结束节次<select data-schedule="end">${periodOptions(Number(schedule.end), state.semester.periods.length)}</select></label>
        <label class="tt-field tt-field--full">上课周次<input data-schedule="weeks" required value="${e(schedule.weeks)}" placeholder="1-16 或 1-4,6,8-12"></label>
        <div class="tt-field--full">${weekPicker(state.semester.totalWeeks)}</div>
        <label class="tt-field tt-field--full">教室 / 地点<input data-schedule="room" maxlength="120" value="${e(schedule.room)}" placeholder="例如：实验楼 B-305"></label>
    </div></section>`;
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
            <label class="tt-field">背景淡化 <output id="ttBackgroundDimValue" for="ttBackgroundDim">${s.background.dim}%</output><input id="ttBackgroundDim" type="range" value="${s.background.dim}" min="40" max="100" step="1" aria-label="背景淡化程度"><small class="tt-hint">越高背景越淡，文字越清晰。</small></label>
            <label class="tt-field tt-field--full">图片显示方式<select id="ttBackgroundFit"><option value="contain"${selected(s.background.fit !== 'cover')}>完整显示（保留全部图片）</option><option value="cover"${selected(s.background.fit === 'cover')}>铺满课表（可能裁剪边缘）</option></select></label>
            <div class="tt-field tt-field--full"><span>本地背景图片</span><div class="tt-background-picker"><button class="tt-button" type="button" data-tt-action="choose-background">选择 / 更换图片</button><span id="ttBackgroundName" class="tt-background-name" role="status">${s.background.image ? e(s.background.imageName || '已保存的背景图片') : '尚未设置背景图片'}</span></div><input id="ttBackgroundFile" type="file" accept="image/png,image/jpeg,image/webp" hidden></div>
            <div class="tt-field tt-field--full"><span>效果预览 · 保存后应用</span><div id="ttAppearancePreview" class="tt-board tt-appearance-preview"><img id="ttBackgroundPreview" class="tt-background-preview" alt="当前背景图片预览"${s.background.image ? ` src="${e(s.background.image)}"` : ' hidden'}><div class="tt-preview-sample"><strong>高等数学</strong><span>教学楼 A-302</span><small>1–2 节</small></div></div></div>
            <label class="tt-field tt-field--full">显示密度<select id="ttDensity"><option value="compact"${selected(s.density !== 'comfortable')}>紧凑 · 同屏显示更多课程</option><option value="comfortable"${selected(s.density === 'comfortable')}>舒适 · 更大的文字和间距</option></select></label>
        </div><p id="ttBackgroundInfo" class="tt-hint">${s.background.image ? '已保存自定义图片，可重新选择或移除。' : '静态图片自动缩小到 1280 像素以内，保存在本机。'}</p><button class="tt-button" type="button" data-tt-action="remove-background">移除自定义图片</button>
        <h4>桌面小部件</h4><div class="tt-form-grid"><label class="tt-field">显示内容<select id="ttWidgetMode"><option value="today"${selected(s.widgetMode === 'today')}>今日课程</option><option value="week"${selected(s.widgetMode === 'week')}>本周课表</option></select></label><label class="tt-field">窗口位置<select id="ttWidgetPinned"><option value="false"${selected(!s.widgetPinned)}>普通桌面浮窗</option><option value="true"${selected(s.widgetPinned)}>始终置顶</option></select></label></div>
        <p class="tt-hint">把今天或本周课程放在桌面，上下课与跨日时自动更新。关闭后可随时从这里重新打开。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="widget-open">添加 / 显示小部件</button><button class="tt-button" type="button" data-tt-action="widget-close">收起小部件</button></div><p class="tt-hint">添加时会保存当前设置；桌面小部件需在 DtKit 桌面版中使用。</p></section>
        <section id="ttSection-transfer" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-transfer" hidden><h4>导入</h4><p class="tt-hint">JSON 可恢复全部设置、背景和历史学期。CSV 可合并或替换当前学期课程。文件会先校验并显示预览，再由你确认导入。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="import">选择 JSON / CSV 文件</button><button class="tt-button" type="button" data-tt-action="csv-template">下载 CSV 模板</button></div>
        <h4>导出</h4><p class="tt-hint">JSON 用于完整备份；CSV 用于表格编辑；ICS 可导入日历，按本机当地时间排课；PNG 保存当前正在查看的一周。</p><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="export-json">完整备份 JSON</button><button class="tt-button" type="button" data-tt-action="export-csv">课程 CSV</button><button class="tt-button" type="button" data-tt-action="export-ics">日历 ICS</button><button class="tt-button" type="button" data-tt-action="export-png">本周图片 PNG</button></div><p class="tt-hint">导出使用已保存的数据。编辑设置后请先保存。</p></section>
        <section id="ttSection-other" class="tt-settings-section" role="tabpanel" aria-labelledby="ttTab-other" hidden><h4>个人设置</h4><label class="tt-field">学历 / 学段<select id="ttEducation">${EDUCATIONS.map(level => `<option${selected(s.education === level)}>${level}</option>`).join('')}</select></label><p class="tt-hint">学历仅用于标记，不会改动你的节次和课程。</p>
        <h4>新学期</h4><p class="tt-hint">当前学期归档，新学期从空白课表开始，保留作息和外观设置。最多保留 10 个历史学期。</p><button class="tt-button" type="button" data-tt-action="new-semester">开始新学期</button><h4>历史学期</h4><div id="ttArchives">${state.archives.length ? state.archives.map(item => `<div class="tt-archive-row"><div>${e(item.name)}<small>${e(item.startDate)} · ${item.courses.length} 条课程安排</small></div><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="restore-archive" data-id="${e(item.id)}">切换</button><button class="tt-button tt-button--danger" type="button" data-tt-action="delete-archive" data-id="${e(item.id)}">删除</button></div></div>`).join('') : '<p class="tt-hint">还没有归档学期。</p>'}</div>
        <h4>数据保存</h4><p class="tt-hint">课表自动保存在当前设备的应用本地存储中。建议定期导出 JSON 备份；清除应用数据会移除本地课表。</p></section>
        <p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('保存设置')}</form>`;
}
export function courseList(state, query = '') {
    const groups = groupCourses(state.semester.courses, query);
    return groups.length ? `<p class="tt-list-summary" role="status">${query.trim() ? '找到 ' : '共 '}${groups.length} 门课程 · ${groups.reduce((sum, courses) => sum + courses.length, 0)} 条上课安排</p>` + groups.map(courses => `<details class="tt-course-group"${query ? ' open' : ''}><summary><strong>${e(courses[0].name)}</strong><span class="tt-course-group-count">${courses.length} 条安排</span></summary><div class="tt-group-toolbar"><button class="tt-button" type="button" data-tt-action="edit-group" data-id="${e(courses[0].id)}">统一编辑课程</button></div>${courses.map(course => `<article class="tt-course-row"><div><p>${DAYS[course.day - 1]} · ${course.start}–${course.end} 节 · ${courseTime(course, state.semester)} · 第 ${formatWeeks(course.weeks)} 周</p><p>${e([course.room, course.teacher].filter(Boolean).join(' · ') || '未填写教室 / 教师')}</p></div><div class="tt-actions"><button class="tt-button" type="button" data-tt-action="edit" data-id="${e(course.id)}">编辑安排</button><button class="tt-button" type="button" data-tt-action="duplicate" data-id="${e(course.id)}">复制安排</button></div></article>`).join('')}</details>`).join('') : '<p class="tt-hint" role="status">没有匹配的课程。可以添加课程或导入 CSV。</p>';
}
export function semesterForm(state) {
    return `<form id="ttNewSemesterForm"><div class="tt-dialog-body"><p class="tt-hint">「${e(state.semester.name)}」的 ${state.semester.courses.length} 条课程安排会完整归档，可随时切换回来。</p><div class="tt-form-grid">${field('新学期名称', 'ttNewSemesterName', 'text', '', 'maxlength="80" required placeholder="例如：2026–2027 学年第二学期" autofocus')}${field('总周数', 'ttNewSemesterWeeks', 'number', state.semester.totalWeeks, 'min="1" max="60" required')}${field('第一周上课日期', 'ttNewSemesterDate', 'date', dateKey(), 'required')}</div><p id="ttPanelNotice" class="tt-notice" role="alert"></p></div>${actions('归档并开始新学期')}</form>`;
}
