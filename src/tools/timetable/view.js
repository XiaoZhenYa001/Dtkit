import { escapeHtml as e } from '../../core/html.js';
import { COLORS, DAYS, dateKey, weekDays, todayCourses, timeMinutes, formatWeeks, courseHighlights } from './model.js';
import { coursePalette } from './appearance.js';
import { periodLayout, courseSegments } from './layout.js';
import { icon } from './template.js';
import { liveContext, matchesCourse } from './core.js';
function highlighted(text, query) {
    const value = String(text), needle = String(query || '').trim();
    if (!needle) return e(value);
    const lower = value.toLocaleLowerCase(), parts = [...needle.toLocaleLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(match => match[1] || match[2]);
    const ranges = parts.flatMap(part => {
        const found = []; let start = lower.indexOf(part);
        while (start !== -1) { found.push([start, start + part.length]); start = lower.indexOf(part, start + part.length); }
        return found;
    }).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
        else merged.push(range);
    }
    let cursor = 0, result = '';
    for (const [start, end] of merged) { result += `${e(value.slice(cursor, start))}<mark>${e(value.slice(start, end))}</mark>`; cursor = end; }
    return result + e(value.slice(cursor));
}

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
    if (minute >= timeMinutes(semester.periods[course.end - 1].end)) return '已结束';
    for (let index = course.start - 1; index < course.end; index++) {
        const period = semester.periods[index];
        if (minute >= timeMinutes(period.start) && minute < timeMinutes(period.end)) return '上课中';
    }
    return '待上课';
}
export function summary(state, now = new Date()) {
    const context = liveContext(state, now);
    if (!context.course) return context.label;
    return `${context.phase === 'current' ? '正在上课' : '下一节'} · ${context.course.name} · ${context.detail}`;
}
// Each day owns a small grid. Disjoint-week courses can share a slot; when
// ghost courses are shown they receive separate lanes instead of covering text.
export function renderGrid(container, state, week, editable = true, options = {}) {
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
            block.className = `tt-course${segment.start === segment.end ? ' is-single' : ''}${active ? '' : ' is-other-week'}${matchesCourse(course, options.query) ? '' : ' is-search-muted'}`; block.dataset.color = COLORS.includes(course.color) ? course.color : 'custom';
            const [paper, ink, line] = coursePalette(course.color, active);
            block.style.setProperty('--tt-card', paper); block.style.setProperty('--tt-card-ink', ink); block.style.setProperty('--tt-card-line', line);
            block.style.gridRow = `${rowOf(segment.start)} / span ${segment.end - segment.start + 1}`; block.style.gridColumn = String(lane + 1);
            const status = highlights.get(`${course.id}:${segment.start}`) || (active ? '' : '非本周');
            if (status) block.dataset.status = status;
            block.dataset.id = course.id;
            block.innerHTML = `<strong>${highlighted(course.name, options.query)}</strong>${course.room ? `<span>${highlighted(course.room, options.query)}</span>` : ''}<small>${segment.start === segment.end ? `第 ${segment.start} 节` : `${segment.start}–${segment.end} 节`}${status ? ` · ${status}` : ''}</small>`;
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
    container.innerHTML = courses.length ? courses.map(course => `<article class="tt-agenda-card" data-color="${e(course.color)}" data-status="${courseStatus(course, state.semester)}"><div><time>${courseTime(course, state.semester)}</time><span>${courseStatus(course, state.semester)}</span></div><strong>${e(course.name)}</strong><p>${e([course.room, course.teacher].filter(Boolean).join(' · ') || '未设置教室')}</p><small>${course.start}–${course.end} 节${course.notes ? ` · ${e(course.notes)}` : ''}</small></article>`).join('') : `<div class="tt-agenda-empty"><span>${icon('sun')}</span><strong>${e(summary(state))}</strong><p>留一点时间给自己。</p></div>`;
    container.querySelectorAll('.tt-agenda-card').forEach((card, index) => {
        const [paper, ink, line] = coursePalette(courses[index].color);
        card.style.setProperty('--tt-card', paper); card.style.setProperty('--tt-card-ink', ink); card.style.setProperty('--tt-card-line', line);
    });
}

export function renderDayPicker(container, state, week, selectedDay = 0) {
    const days = weekDays(state, week), today = dateKey();
    container.innerHTML = `<button type="button" data-tt-action="select-day" data-tt-day="0" aria-pressed="${selectedDay === 0}"><span>本周</span><strong>全部</strong></button>${days.map(item => `<button type="button" data-tt-action="select-day" data-tt-day="${item.day}" aria-pressed="${selectedDay === item.day}"${item.date === today ? ' class="is-today" aria-label="今天"' : ''}><span>${DAYS[item.day - 1]}</span><strong>${Number(item.date.slice(8))}</strong>${item.date === today ? '<i aria-hidden="true"></i>' : ''}</button>`).join('')}`;
}

export function renderWeekAgenda(container, state, week, selectedDay = 0, options = {}) {
    const today = dateKey(), days = weekDays(state, week).filter(item => !selectedDay || item.day === selectedDay);
    const query = String(options.query || '').trim();
    const courses = state.semester.courses.filter(course => course.weeks.includes(week) && matchesCourse(course, query));
    const sections = days.map(item => {
        const arranged = courses.filter(course => course.day === item.day).sort((a, b) => a.start - b.start);
        if (!arranged.length && query) return '';
        return `<section class="tt-agenda-day" data-day="${item.day}"><header class="tt-agenda-day-header"><div><span class="tt-agenda-date">${Number(item.date.slice(5, 7))} / ${Number(item.date.slice(8))}</span><strong>${DAYS[item.day - 1]}${item.date === today ? '<i>今天</i>' : ''}</strong></div><small>${arranged.length ? `${arranged.length} 条安排` : '自由安排'}</small></header><div class="tt-agenda-timeline">${arranged.length ? arranged.map(course => {
            const status = item.date === today ? courseStatus(course, state.semester) : item.date < today ? '已结束' : '待上课';
            const periods = state.semester.periods;
            return `<button type="button" class="tt-agenda-entry" data-tt-action="edit" data-id="${e(course.id)}" data-status="${status}" data-color="${COLORS.includes(course.color) ? course.color : 'custom'}"><span class="tt-agenda-time"><strong>${periods[course.start - 1].start}</strong><small>${periods[course.end - 1].end}</small></span><span class="tt-agenda-course"><span class="tt-agenda-course-top"><strong>${highlighted(course.name, query)}</strong><small>${status}</small></span><span class="tt-agenda-meta">${course.room ? `<span>${highlighted(course.room, query)}</span>` : '<span>未设置教室</span>'}${course.teacher ? `<span>${highlighted(course.teacher, query)}</span>` : ''}</span>${course.notes ? `<span class="tt-agenda-notes">${highlighted(course.notes, query)}</span>` : ''}<span class="tt-agenda-periods">第 ${course.start}${course.start === course.end ? '' : `–${course.end}`} 节 · 第 ${e(formatWeeks(course.weeks))} 周</span></span><span class="tt-agenda-open" aria-hidden="true">${icon('right')}</span></button>`;
        }).join('') : `<button type="button" class="tt-agenda-day-empty" data-tt-action="add-cell" data-day="${item.day}" data-period="1">${icon('plus')}<span>这一天没有课程，添加一门</span></button>`}</div></section>`;
    }).join('');
    container.innerHTML = sections || `<div class="tt-agenda-empty"><span>${icon('search')}</span><strong>没有找到匹配的课程</strong><p>试试其他课程名、教师或教室。</p><button class="tt-button" type="button" data-tt-action="clear-search">清除搜索</button></div>`;
    container.querySelectorAll('.tt-agenda-entry').forEach(card => {
        const course = courses.find(item => item.id === card.dataset.id);
        const [paper, ink, line] = coursePalette(course.color);
        card.style.setProperty('--tt-card', paper); card.style.setProperty('--tt-card-ink', ink); card.style.setProperty('--tt-card-line', line);
    });
}
