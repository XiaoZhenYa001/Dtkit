import { newId, parseWeeks, validateCourse } from './model.js';

export function linkedEnd(previousStart, previousEnd, nextStart, count) {
    return Math.min(count, nextStart + Math.max(0, previousEnd - previousStart));
}
export function groupCourses(courses, query = '') {
    const groups = new Map(), needle = query.trim().toLocaleLowerCase();
    for (const course of [...courses].sort((a, b) => a.day - b.day || a.start - b.start)) {
        if (!groups.has(course.name)) groups.set(course.name, []);
        groups.get(course.name).push(course);
    }
    return [...groups.values()].filter(group => group.some(course => `${course.name} ${course.room} ${course.teacher}`.toLocaleLowerCase().includes(needle)));
}
export function prepareCourseEdits(fields, schedules, originals, semester) {
    const baseline = originals[0], originalById = new Map(originals.map(course => [course.id, course]));
    return schedules.map((schedule, index) => {
        const original = originalById.get(schedule.id);
        return validateCourse({ id: original?.id || newId(), name: fields.name.trim(),
            teacher: original && baseline.teacher.trim() === fields.teacher.trim() ? original.teacher : fields.teacher,
            color: original && baseline.color.toLowerCase() === fields.color.toLowerCase() ? original.color : fields.color,
            notes: index === 0 || !original ? fields.notes : original.notes,
            room: schedule.room.trim(), day: Number(schedule.day), start: Number(schedule.start), end: Number(schedule.end),
            weeks: parseWeeks(schedule.weeks, semester.totalWeeks, schedule.parity) }, semester);
    });
}
export function replaceArrangements(state, originalIds, courses) {
    if (originalIds.some(id => !state.semester.courses.some(course => course.id === id))) throw new Error('课程已被删除，请重新打开课表');
    state.semester.courses = [...state.semester.courses.filter(course => !originalIds.includes(course.id)), ...courses];
}
