export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const COLORS = ['blue', 'green', 'purple', 'orange', 'rose', 'cyan'];
export const EDUCATIONS = ['小学', '初中', '高中', '中专', '大专', '本科', '硕士', '博士', '其他'];
export const DAY_MS = 86400000;
export const newId = () => globalThis.crypto.randomUUID();
export function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dayValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式应为 YYYY-MM-DD');
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('日期无效');
    return timestamp;
}
export const addDays = (date, days) => new Date(dayValue(date) + days * DAY_MS).toISOString().slice(0, 10);
export const weekday = date => (new Date(dayValue(date)).getUTCDay() + 6) % 7 + 1;
export const weekStart = (date, startsOn = 1) => addDays(date, -((weekday(date) - startsOn + 7) % 7));
export function currentWeek(state, today = dateKey()) {
    return Math.floor((dayValue(weekStart(today, state.settings.weekStartsOn)) - dayValue(weekStart(state.semester.startDate, state.settings.weekStartsOn))) / (7 * DAY_MS)) + 1;
}
export function weekDays(state, week) {
    const start = addDays(weekStart(state.semester.startDate, state.settings.weekStartsOn), (week - 1) * 7);
    return Array.from({ length: 7 }, (_, offset) => ({ date: addDays(start, offset), day: weekday(addDays(start, offset)) }))
        .filter(item => state.settings.showWeekend || item.day <= 5);
}
export function timeMinutes(time) {
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('上课时间无效');
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
const timeText = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export function generatePeriods(count = 12, start = '08:00', duration = 45, rest = 10) {
    integer(count, 1, 24, '每天节数'); integer(duration, 10, 180, '每节时长'); integer(rest, 0, 120, '课间时长');
    let cursor = timeMinutes(start);
    return Array.from({ length: count }, (_, index) => {
        if (index === 4) cursor = Math.max(cursor, 14 * 60);
        if (index === 8) cursor = Math.max(cursor, 19 * 60);
        if (cursor + duration >= 1440) throw new Error('生成的节次超过当天，请减少节数或调整时长');
        const period = { start: timeText(cursor), end: timeText(cursor + duration) };
        cursor += duration + rest;
        return period;
    });
}
export function createState(today = dateKey()) {
    return { version: 1, revision: 0,
        settings: { showWeekend: true, showOtherWeeks: false, weekStartsOn: 1, education: '本科', background: { preset: 'paper', image: '', dim: 85 }, widgetMode: 'today', widgetPinned: false },
        semester: { id: newId(), name: '我的学期', startDate: weekStart(today), totalWeeks: 20, periods: generatePeriods(), courses: [] }, archives: [] };
}
function integer(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}应为 ${min}–${max} 的整数`);
}
function string(value, max, label, required = false) {
    if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) throw new Error(`${label}无效或过长（最多 ${max} 字）`);
}
export function parseWeeks(expression, totalWeeks, parity = 'all') {
    if (!['all', 'odd', 'even'].includes(parity)) throw new Error('单双周选项无效');
    const result = new Set();
    for (const token of String(expression).trim().replace(/[，、]/g, ',').split(',')) {
        const match = /^(\d+)(?:\s*[-–~至]\s*(\d+))?$/.exec(token.trim());
        if (!match) throw new Error('周次请填写 1-16 或 1-4,6,8-12');
        const start = Number(match[1]), end = Number(match[2] || match[1]);
        integer(start, 1, totalWeeks, '开始周'); integer(end, start, totalWeeks, '结束周');
        for (let week = start; week <= end; week++) if (parity === 'all' || (week % 2 === (parity === 'odd' ? 1 : 0))) result.add(week);
    }
    if (!result.size) throw new Error('选定范围中没有符合条件的周次');
    return [...result].sort((a, b) => a - b);
}
export function formatWeeks(weeks) {
    const parts = [];
    for (let i = 0; i < weeks.length; i++) {
        const start = weeks[i];
        while (weeks[i + 1] === weeks[i] + 1) i++;
        parts.push(start === weeks[i] ? `${start}` : `${start}-${weeks[i]}`);
    }
    return parts.join(',');
}
export function validateCourse(course, semester) {
    string(course.id, 80, '课程标识', true); string(course.name, 120, '课程名', true);
    string(course.room, 120, '教室'); string(course.teacher, 80, '教师'); string(course.notes, 1000, '备注');
    integer(course.day, 1, 7, '星期'); integer(course.start, 1, semester.periods.length, '开始节'); integer(course.end, course.start, semester.periods.length, '结束节');
    if (!COLORS.includes(course.color)) throw new Error('课程颜色无效');
    if (!Array.isArray(course.weeks) || !course.weeks.length || course.weeks.length > semester.totalWeeks) throw new Error('课程周次无效');
    course.weeks.forEach((week, index) => { integer(week, 1, semester.totalWeeks, '课程周次'); if (index && week <= course.weeks[index - 1]) throw new Error('课程周次应递增且不重复'); });
    return course;
}
export function conflicts(course, courses) {
    const weeks = new Set(course.weeks);
    return courses.filter(other => other.id !== course.id && other.day === course.day && other.start <= course.end && course.start <= other.end && other.weeks.some(week => weeks.has(week)));
}
export function validateSemester(semester) {
    if (!semester || typeof semester !== 'object') throw new Error('学期数据无效');
    string(semester.id, 80, '学期标识', true); string(semester.name, 80, '学期名称', true);
    dayValue(semester.startDate); integer(semester.totalWeeks, 1, 60, '学期总周数');
    if (!Array.isArray(semester.periods) || semester.periods.length < 1 || semester.periods.length > 24) throw new Error('每天应设置 1–24 节课');
    let previous = -1;
    semester.periods.forEach(period => {
        const start = timeMinutes(period.start), end = timeMinutes(period.end);
        if (start >= end || start < previous) throw new Error('节次时间必须先后排列，且不能重叠');
        previous = end;
    });
    if (!Array.isArray(semester.courses) || semester.courses.length > 600) throw new Error('每学期最多 600 条课程安排');
    const ids = new Set();
    for (const course of semester.courses) {
        validateCourse(course, semester);
        if (ids.has(course.id)) throw new Error('课程标识重复');
        ids.add(course.id);
        const collision = conflicts(course, semester.courses);
        if (collision.length) throw new Error(`「${course.name}」与「${collision[0].name}」的时间和周次冲突`);
    }
    return semester;
}
export function validateState(state) {
    if (!state || state.version !== 1) throw new Error('不支持的课表文件版本');
    integer(state.revision, 0, Number.MAX_SAFE_INTEGER - 1, '数据版本');
    const settings = state.settings;
    if (!settings || typeof settings.showWeekend !== 'boolean' || typeof settings.showOtherWeeks !== 'boolean' || typeof settings.widgetPinned !== 'boolean') throw new Error('课表设置无效');
    integer(settings.weekStartsOn, 1, 7, '每周起始日');
    if (!EDUCATIONS.includes(settings.education) || !['today', 'week'].includes(settings.widgetMode)) throw new Error('学历或小部件模式无效');
    const background = settings.background;
    if (!background || !['paper', 'mint', 'sky', 'lavender', 'image'].includes(background.preset)) throw new Error('背景设置无效');
    string(background.image, 600000, '背景图片'); integer(background.dim, 40, 100, '背景遮罩');
    if (background.image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(background.image)) throw new Error('背景必须是本地静态图片');
    if (background.preset === 'image' && !background.image) throw new Error('请先选择背景图片');
    validateSemester(state.semester);
    if (!Array.isArray(state.archives) || state.archives.length > 10) throw new Error('最多保留 10 个历史学期');
    state.archives.forEach(validateSemester);
    if (new Set([state.semester.id, ...state.archives.map(item => item.id)]).size !== state.archives.length + 1) throw new Error('学期标识重复');
    return state;
}
export function startSemester(state, name, startDate, totalWeeks) {
    if (state.archives.length >= 10) throw new Error('已保留 10 个历史学期，请先导出备份并删除不需要的归档');
    state.archives.unshift(structuredClone(state.semester));
    state.semester = { id: newId(), name: name.trim(), startDate, totalWeeks, periods: structuredClone(state.semester.periods), courses: [] };
    return validateState(state);
}
export function todayCourses(state, today = dateKey()) {
    const week = currentWeek(state, today);
    return state.semester.courses.filter(course => course.day === weekday(today) && course.weeks.includes(week)).sort((a, b) => a.start - b.start);
}
export function nextBoundary(state, now = new Date()) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    let next = tomorrow;
    for (const course of todayCourses(state, dateKey(now))) {
        for (const time of [state.semester.periods[course.start - 1].start, state.semester.periods[course.end - 1].end]) {
            const minute = timeMinutes(time), timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minute / 60), minute % 60).getTime();
            if (timestamp > now.getTime()) next = Math.min(next, timestamp);
        }
    }
    return Math.max(1000, next - now.getTime() + 100);
}
