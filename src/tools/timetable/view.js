import { escapeHtml as e } from '../../core/html.js';
import { COLORS, DAYS, currentWeek, dateKey, weekDays, todayCourses, timeMinutes, formatWeeks } from './model.js';

export function applyBackground(element, background) {
    element.dataset.background = background.preset;
    element.style.setProperty('--tt-image', background.preset === 'image' ? `url("${background.image}")` : 'none');
    element.style.setProperty('--tt-mask', String(background.dim / 100));
}
export function courseTime(course, semester) {
    return `${semester.periods[course.start - 1].start}–${semester.periods[course.end - 1].end}`;
}
export function courseStatus(course, semester, now = new Date()) {
    const minute = now.getHours() * 60 + now.getMinutes();
    return minute < timeMinutes(semester.periods[course.start - 1].start) ? '待上课' : minute >= timeMinutes(semester.periods[course.end - 1].end) ? '已结束' : '上课中';
}
export function summary(state, now = new Date()) {
    const week = currentWeek(state, dateKey(now));
    if (week < 1) return '学期尚未开始';
    if (week > state.semester.totalWeeks) return '本学期已结束';
    const courses = todayCourses(state, dateKey(now));
    const next = courses.find(course => courseStatus(course, state.semester, now) !== '已结束');
    if (!next) return courses.length ? '今天的课程已结束' : '今天没有课程，好好安排自己的时间';
    return `${courseStatus(next, state.semester, now) === '上课中' ? '正在上课' : '下一节'} · ${next.name} · ${courseTime(next, state.semester)}${next.room ? ` · ${next.room}` : ''}`;
}
// Each day owns a small grid. Disjoint-week courses can share a slot; when
// ghost courses are shown they receive separate lanes instead of covering text.
export function renderGrid(container, state, week, editable = true) {
    const days = weekDays(state, week), periods = state.semester.periods;
    const today = dateKey();
    container.style.setProperty('--tt-days', days.length);
    container.style.setProperty('--tt-periods', periods.length);
    container.innerHTML = `<div class="tt-grid-corner">节次</div>${days.map(item => `<div class="tt-day-head ${item.date === today ? 'is-today' : ''}"><strong>${DAYS[item.day - 1]}</strong><span>${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8))}${item.date === today ? ' · 今天' : ''}</span></div>`).join('')}
        <div class="tt-ruler">${periods.map((period, index) => `<div class="tt-period"><strong>${index + 1}</strong><span>${period.start}<br>${period.end}</span></div>`).join('')}</div>`;
    for (const item of days) {
        const column = document.createElement('div'); column.className = `tt-day-column${item.date === today ? ' is-today' : ''}`;
        const courses = state.semester.courses.filter(course => course.day === item.day && (state.settings.showOtherWeeks || course.weeks.includes(week)))
            .sort((a, b) => a.start - b.start || Number(b.weeks.includes(week)) - Number(a.weeks.includes(week)));
        const lanes = [], placements = [];
        for (const course of courses) {
            let lane = lanes.findIndex(end => end < course.start);
            if (lane === -1) lane = lanes.length;
            lanes[lane] = course.end; placements.push({ course, lane });
        }
        column.style.setProperty('--tt-lanes', Math.max(1, lanes.length));
        for (let index = 1; index <= periods.length; index++) {
            const cell = document.createElement(editable ? 'button' : 'div'); cell.className = 'tt-cell';
            cell.style.gridRow = String(index); cell.style.gridColumn = '1 / -1';
            if (editable) { cell.type = 'button'; cell.dataset.ttAction = 'add-cell'; cell.dataset.day = item.day; cell.dataset.period = index; cell.setAttribute('aria-label', `添加${DAYS[item.day - 1]}第 ${index} 节课程`); }
            column.append(cell);
        }
        for (const { course, lane } of placements) {
            const active = course.weeks.includes(week), block = document.createElement(editable ? 'button' : 'div');
            block.className = `tt-course${course.start === course.end ? ' is-single' : ''}${active ? '' : ' is-other-week'}`; block.dataset.color = COLORS.includes(course.color) ? course.color : 'blue';
            block.style.gridRow = `${course.start} / span ${course.end - course.start + 1}`; block.style.gridColumn = String(lane + 1);
            block.title = `${course.name}\n${course.room || '未设置教室'}${course.teacher ? ` · ${course.teacher}` : ''}\n${courseTime(course, state.semester)} · 第 ${formatWeeks(course.weeks)} 周${course.notes ? `\n${course.notes}` : ''}`;
            block.innerHTML = `<strong>${e(course.name)}</strong>${course.room ? `<span>${e(course.room)}</span>` : ''}<small>${course.start === course.end ? `第 ${course.start} 节` : `${course.start}–${course.end} 节`}${active ? '' : ' · 非本周'}</small>`;
            if (editable) { block.type = 'button'; block.dataset.ttAction = 'edit'; block.dataset.id = course.id; block.setAttribute('aria-label', `编辑 ${course.name}，${DAYS[course.day - 1]} ${course.start}–${course.end} 节${active ? '' : '，非本周'}`); }
            column.append(block);
        }
        container.append(column);
    }
}
export function renderAgenda(container, state) {
    const courses = todayCourses(state);
    container.innerHTML = courses.length ? courses.map(course => `<article class="tt-agenda-card" data-color="${course.color}" data-status="${courseStatus(course, state.semester)}"><div><time>${courseTime(course, state.semester)}</time><span>${courseStatus(course, state.semester)}</span></div><strong>${e(course.name)}</strong><p>${e([course.room, course.teacher].filter(Boolean).join(' · ') || '未设置教室')}</p><small>${course.start}–${course.end} 节${course.notes ? ` · ${e(course.notes)}` : ''}</small></article>`).join('') : `<div class="tt-agenda-empty"><span>☀</span><strong>${e(summary(state))}</strong><p>留一点时间给自己。</p></div>`;
}
