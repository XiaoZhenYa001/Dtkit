import { currentWeek, dateKey, todayCourses, timeMinutes, weekDays } from './model.js';

export function matchesCourse(course, query = '') {
    const text = [course.name, course.room, course.teacher, course.notes].join('\n').toLocaleLowerCase();
    const terms = [...String(query).trim().toLocaleLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(match => match[1] || match[2]);
    return terms.every(term => text.includes(term));
}

export function weekOverview(state, week, query = '') {
    const days = new Set(weekDays(state, week).map(item => item.day));
    const all = state.semester.courses.filter(course => course.weeks.includes(week));
    const courses = all.filter(course => days.has(course.day) && matchesCourse(course, query));
    let periods = 0, minutes = 0;
    for (const course of courses) {
        periods += course.end - course.start + 1;
        for (let index = course.start - 1; index < course.end; index++) {
            const period = state.semester.periods[index]; minutes += timeMinutes(period.end) - timeMinutes(period.start);
        }
    }
    return { courses, arrangements: courses.length, subjects: new Set(courses.map(course => course.name)).size, periods, minutes,
        days: new Set(courses.map(course => course.day)).size, hidden: all.filter(course => !days.has(course.day)).length };
}

// Treat each teaching period as an actual time interval: neither lunch nor a
// short break between periods should be reported as a lesson in progress.
export function liveContext(state, now = new Date()) {
    const week = currentWeek(state, dateKey(now));
    if (week < 1) return { phase: 'before', label: '尚未开学', detail: `${state.semester.startDate} 开始新学期`, progress: 0 };
    if (week > state.semester.totalWeeks) return { phase: 'after', label: '学期已结束', detail: '回顾收获，也为下一段旅程留一点期待。', progress: 1 };
    const courses = todayCourses(state, dateKey(now));
    const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const slots = courses.flatMap(course => Array.from({ length: course.end - course.start + 1 }, (_, index) => {
        const period = course.start + index, times = state.semester.periods[period - 1];
        return { course, segment: { start: period, end: period, from: timeMinutes(times.start), until: timeMinutes(times.end), time: `${times.start}–${times.end}` } };
    })).sort((a, b) => a.segment.from - b.segment.from);
    const current = slots.find(slot => slot.segment.from <= minute && minute < slot.segment.until);
    const next = slots.find(slot => slot.segment.from > minute);
    const item = current || next;
    if (!item) return { phase: courses.length ? 'done' : 'empty', label: courses.length ? '今日课程已结束' : '今天没有课程', detail: '留一点时间给自己。', progress: courses.length ? 1 : 0 };
    const { course, segment } = item;
    const remainingMinutes = Math.max(1, Math.ceil((current ? segment.until : segment.from) - minute));
    return { phase: current ? 'current' : 'next', course, segment, remainingMinutes,
        progress: current ? Math.max(0, Math.min(1, (minute - segment.from) / (segment.until - segment.from))) : 0,
        label: current ? '正在上课' : '下一节课', detail: `${segment.time}${course.room ? ` · ${course.room}` : ''}${course.teacher ? ` · ${course.teacher}` : ''}` };
}

export function nextLiveRefresh(state, now = new Date()) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const context = liveContext(state, now);
    if (!['current', 'next'].includes(context.phase)) return Math.max(1000, midnight - now.getTime() + 100);
    // Minute precision is enough for a calm countdown. Wake at the exact next
    // period boundary too, without a permanent second-by-second timer.
    const minute = now.getHours() * 60 + now.getMinutes();
    let next = now.getTime() + (60000 - now.getSeconds() * 1000 - now.getMilliseconds());
    for (const course of todayCourses(state, dateKey(now))) for (let index = course.start - 1; index < course.end; index++) {
        for (const text of [state.semester.periods[index].start, state.semester.periods[index].end]) {
            const boundary = timeMinutes(text);
            if (boundary > minute) {
                const value = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(boundary / 60), boundary % 60).getTime();
                next = Math.min(next, value);
            }
        }
    }
    return Math.max(1000, next - now.getTime() + 100);
}

export class TimetableHistory {
    constructor({ maxEntries = 12, maxBytes = 8 * 1024 * 1024 } = {}) {
        this.undoStack = []; this.redoStack = []; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
    clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
    record(before, after, label = '修改课表') {
        const previous = structuredClone(before), next = structuredClone(after);
        delete previous.revision; delete next.revision;
        const from = JSON.stringify(previous), to = JSON.stringify(next);
        if (from === to) return;
        const entry = { before: previous, after: next, label, bytes: (from.length + to.length) * 2 };
        this.redoStack.length = 0;
        if (entry.bytes > this.maxBytes) { this.clear(); return; }
        this.undoStack.push(entry);
        while (this.undoStack.length > this.maxEntries || this.undoStack.reduce((sum, item) => sum + item.bytes, 0) > this.maxBytes) this.undoStack.shift();
    }
    peek(direction) { return (direction === 'redo' ? this.redoStack : this.undoStack).at(-1); }
    accept(direction) {
        const from = direction === 'redo' ? this.redoStack : this.undoStack;
        const to = direction === 'redo' ? this.undoStack : this.redoStack;
        const entry = from.pop(); if (entry) to.push(entry);
    }
}
