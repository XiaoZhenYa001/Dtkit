import { escapeHtml as e } from '../../core/html.js';
import { COLORS, DAYS, currentWeek, dateKey, weekDays, todayCourses, timeMinutes, formatWeeks, courseHighlights } from './model.js';
import { coursePalette } from './appearance.js';
import { periodLayout, courseSegments } from './layout.js';

export function applyBackground(element, background) {
    element.dataset.background = background.preset;
    element.style.setProperty('--tt-image', background.preset === 'image' ? `url("${background.image}")` : 'none');
    element.style.setProperty('--tt-mask', String(background.dim / 100));
    element.dataset.backgroundFit = background.fit || 'contain';
    element.style.setProperty('--tt-image-fit', background.fit || 'contain');
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
    const today = dateKey(), rows = periodLayout(periods.length);
    const highlights = new Map(courseHighlights(state, week).map(item => [`${item.id}:${item.start}`, item.label]));
    container.dataset.density = state.settings.density || 'compact';
    const rowOf = period => rows.findIndex(row => row.period === period) + 1;
    container.style.setProperty('--tt-days', days.length);
    container.style.setProperty('--tt-periods', periods.length);
    container.style.setProperty('--tt-rest-count', rows.length - periods.length);
    container.style.setProperty('--tt-rows', rows.map(row => row.period ? 'var(--tt-row-height)' : 'var(--tt-rest-height)').join(' '));
    container.innerHTML = `<div class="tt-grid-corner">节次</div>${days.map(item => `<div class="tt-day-head ${item.date === today ? 'is-today' : ''}"><strong>${DAYS[item.day - 1]}</strong><span>${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8))}${item.date === today ? ' · 今天' : ''}</span></div>`).join('')}
        <div class="tt-ruler">${rows.map(row => row.period ? `<div class="tt-period"><strong>${row.period}</strong><span>${periods[row.period - 1].start}<br>${periods[row.period - 1].end}</span></div>` : `<div class="tt-rest tt-rest-label">${row.label}</div>`).join('')}</div>`;
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
            cell.style.gridRow = String(rowOf(index)); cell.style.gridColumn = '1 / -1';
            if (editable) { cell.type = 'button'; cell.dataset.ttAction = 'add-cell'; cell.dataset.day = item.day; cell.dataset.period = index; cell.setAttribute('aria-label', `添加${DAYS[item.day - 1]}第 ${index} 节课程`); }
            column.append(cell);
        }
        for (const [index, row] of rows.entries()) if (!row.period) {
            const rest = document.createElement('div'); rest.className = 'tt-rest'; rest.dataset.restAfter = row.after;
            rest.style.gridRow = String(index + 1); rest.style.gridColumn = '1 / -1'; rest.setAttribute('aria-hidden', 'true'); column.append(rest);
        }
        for (const { course, lane } of placements) {
          for (const segment of courseSegments(course)) {
            const active = course.weeks.includes(week), block = document.createElement(editable ? 'button' : 'div');
            block.className = `tt-course${segment.start === segment.end ? ' is-single' : ''}${active ? '' : ' is-other-week'}`; block.dataset.color = COLORS.includes(course.color) ? course.color : 'custom';
            const [paper, ink, line] = coursePalette(course.color, active);
            block.style.setProperty('--tt-card', paper); block.style.setProperty('--tt-card-ink', ink); block.style.setProperty('--tt-card-line', line);
            block.style.gridRow = `${rowOf(segment.start)} / span ${segment.end - segment.start + 1}`; block.style.gridColumn = String(lane + 1);
            const status = highlights.get(`${course.id}:${segment.start}`) || (active ? '' : '非本周');
            if (status) block.dataset.status = status;
            block.dataset.id = course.id;
            block.innerHTML = `<strong>${e(course.name)}</strong>${course.room ? `<span>${e(course.room)}</span>` : ''}<small>${segment.start === segment.end ? `第 ${segment.start} 节` : `${segment.start}–${segment.end} 节`}${status ? ` · ${status}` : ''}</small>`;
            block.setAttribute('aria-label', `${editable ? '编辑 ' : ''}${course.name}，${DAYS[course.day - 1]} ${course.start}–${course.end} 节${course.room ? `，${course.room}` : ''}${status ? `，${status}` : ''}`);
            if (editable) { block.type = 'button'; block.dataset.ttAction = 'edit'; }
            column.append(block);
          }
        }
        container.append(column);
    }
}
export function renderAgenda(container, state) {
    const courses = todayCourses(state);
    container.innerHTML = courses.length ? courses.map(course => `<article class="tt-agenda-card" data-color="${course.color}" data-status="${courseStatus(course, state.semester)}"><div><time>${courseTime(course, state.semester)}</time><span>${courseStatus(course, state.semester)}</span></div><strong>${e(course.name)}</strong><p>${e([course.room, course.teacher].filter(Boolean).join(' · ') || '未设置教室')}</p><small>${course.start}–${course.end} 节${course.notes ? ` · ${e(course.notes)}` : ''}</small></article>`).join('') : `<div class="tt-agenda-empty"><span>☀</span><strong>${e(summary(state))}</strong><p>留一点时间给自己。</p></div>`;
    container.querySelectorAll('.tt-agenda-card').forEach((card, index) => {
        const [paper, ink, line] = coursePalette(courses[index].color);
        card.style.setProperty('--tt-card', paper); card.style.setProperty('--tt-card-ink', ink); card.style.setProperty('--tt-card-line', line);
    });
}
