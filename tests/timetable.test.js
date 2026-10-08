import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, currentWeek, weekDays, weekStart, parseWeeks, generatePeriods, validateState, conflicts, startSemester, nextBoundary, todayCourses } from '../src/tools/timetable/model.js';
import { readState, updateState, STORAGE_KEY } from '../src/tools/timetable/store.js';
import { exportCsv, importCsv, importJson, exportIcs, parseCsv } from '../src/tools/timetable/transfer.js';
const course = (overrides = {}) => ({ id: crypto.randomUUID(), name: '高等数学', day: 1, start: 1, end: 2, weeks: [1, 2, 3], room: 'A-301', teacher: '李老师', color: 'blue', notes: '', ...overrides });
function memory(state) {
    const data = new Map(state ? [[STORAGE_KEY, JSON.stringify(state)]] : []);
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
test('week calculation uses calendar days with configurable week start and semester boundaries', () => {
    const state = createState('2026-10-07'); state.semester.startDate = '2026-09-01';
    assert.equal(currentWeek(state, '2026-08-30'), 0);
    assert.equal(currentWeek(state, '2026-09-06'), 1);
    assert.equal(currentWeek(state, '2026-09-07'), 2);
    assert.equal(currentWeek(state, '2026-10-07'), 6);
    state.settings.weekStartsOn = 7;
    assert.equal(weekStart('2026-09-01', 7), '2026-08-30');
    assert.equal(currentWeek(state, '2026-09-06'), 2);
    assert.deepEqual(weekDays(state, 1).map(item => item.day), [7, 1, 2, 3, 4, 5, 6]);
    state.settings.showWeekend = false;
    assert.deepEqual(weekDays(state, 1).map(item => item.day), [1, 2, 3, 4, 5]);
});
test('week patterns support ranges, exceptions, parity and reject invalid ranges', () => {
    assert.deepEqual(parseWeeks('1-4，6,8-10', 20), [1, 2, 3, 4, 6, 8, 9, 10]);
    assert.deepEqual(parseWeeks('1-8', 20, 'odd'), [1, 3, 5, 7]);
    assert.deepEqual(parseWeeks('1-8', 20, 'even'), [2, 4, 6, 8]);
    for (const expression of ['0-4', '4-1', '1-21', '', '1-x', '1,']) assert.throws(() => parseWeeks(expression, 20));
    assert.throws(() => parseWeeks('2', 20, 'odd'), /没有符合/);
});
test('course conflicts require intersecting weekdays, periods and actual weeks', () => {
    const odd = course({ weeks: [1, 3] }), even = course({ weeks: [2, 4] });
    assert.deepEqual(conflicts(odd, [even]), []);
    assert.equal(conflicts(odd, [course({ weeks: [3], start: 2, end: 3 })]).length, 1);
    assert.deepEqual(conflicts(odd, [course({ start: 3, end: 4 }), course({ day: 2 })]), []);
    const state = createState(); state.semester.courses = [odd, even]; assert.doesNotThrow(() => validateState(state));
    state.semester.courses.push(course({ weeks: [1] })); assert.throws(() => validateState(state), /冲突/);
});
test('period generation preserves lunch/evening breaks and invalid settings never trim existing courses', () => {
    const periods = generatePeriods(); assert.equal(periods[4].start, '14:00'); assert.equal(periods[8].start, '19:00');
    assert.throws(() => generatePeriods(24, '23:30'), /超过当天/);
    const state = createState(); state.semester.courses = [course({ start: 11, end: 12 })];
    state.semester.periods = periods.slice(0, 10); assert.throws(() => validateState(state), /开始节/);
    state.semester.periods = periods; state.semester.totalWeeks = 2; assert.throws(() => validateState(state), /课程周次/);
    state.semester.totalWeeks = 20; state.semester.periods[1].start = '08:10'; assert.throws(() => validateState(state), /不能重叠/);
});
test('CSV round trips unicode, commas, quotes, newline and formula-like text', () => {
    const state = createState(), original = course({ name: '=中文,"测试"', notes: '第一行\n第二行,逗号', room: '\t+A-301' });
    const text = exportCsv([original]); assert.ok(text.includes("'=中文"));
    const [result] = importCsv(text, state.semester);
    assert.deepEqual({ ...result, id: original.id }, original);
    assert.throws(() => parseCsv('"unfinished'), /未闭合/);
    assert.throws(() => parseCsv('"abc"x,2'), /引号格式/);
    assert.throws(() => importCsv('name,day\n数学,1', state.semester), /表头/);
    assert.throws(() => importCsv(text.replace('"1-3"', '"1-99"'), state.semester), /第 2 行/);
});
test('JSON backup restores settings, archives and rejects unsafe backgrounds, dates and versions', () => {
    const state = createState(); state.semester.courses = [course()];
    startSemester(state, '新学期', '2027-02-22', 20);
    assert.equal(importJson(JSON.stringify(state)).archives[0].courses[0].name, '高等数学');
    for (const mutate of [data => { data.version = 2; }, data => { data.semester.startDate = '2026-02-30'; }, data => { data.settings.background.image = 'javascript:alert(1)'; }]) {
        const draft = structuredClone(state); mutate(draft); assert.throws(() => importJson(JSON.stringify(draft)));
    }
});
test('new semester archives all courses and refuses silent eviction at the history limit', () => {
    const state = createState(); state.semester.courses = [course()];
    const original = structuredClone(state.semester);
    startSemester(state, '春季', '2027-02-22', 18);
    assert.deepEqual(state.archives[0], original); assert.equal(state.semester.courses.length, 0);
    assert.deepEqual(state.semester.periods, original.periods);
    for (let i = 1; i < 10; i++) startSemester(state, `学期 ${i}`, '2027-02-22', 18);
    assert.throws(() => startSemester(state, '第 11 个', '2027-02-22', 18), /10 个/);
});
test('transactions reject stale editors and invalid imports without changing saved data', async () => {
    const storage = memory(createState());
    await updateState(state => state.semester.courses.push(course()), 0, { storage });
    const saved = storage.getItem(STORAGE_KEY);
    await assert.rejects(updateState(state => { state.semester.name = '旧窗口'; }, 0, { storage }), /另一个窗口/);
    await assert.rejects(updateState(state => state.semester.courses.push(course()), 1, { storage }), /冲突/);
    assert.equal(storage.getItem(STORAGE_KEY), saved);
    const broken = memory(); broken.setItem(STORAGE_KEY, '{broken');
    assert.throws(() => readState(broken), /原数据已保留/); assert.equal(broken.getItem(STORAGE_KEY), '{broken');
});
test('quota failure retains the original state and serialized concurrent mutations retain both edits', async () => {
    const storage = memory(createState()), before = storage.getItem(STORAGE_KEY);
    const full = { ...storage, setItem() { throw new Error('quota'); } };
    await assert.rejects(updateState(state => { state.semester.name = '新名称'; }, 0, { storage: full }), /存储空间/);
    assert.equal(storage.getItem(STORAGE_KEY), before);
    let chain = Promise.resolve(); const locks = { request: (_key, fn) => (chain = chain.then(fn)) };
    await Promise.all([updateState(state => state.semester.courses.push(course()), undefined, { storage, locks }), updateState(state => state.semester.courses.push(course({ day: 2 })), undefined, { storage, locks })]);
    assert.equal(readState(storage).semester.courses.length, 2); assert.equal(readState(storage).revision, 2);
});
test('widget schedules only the next course boundary or midnight and respects non-teaching weeks', () => {
    const state = createState('2026-10-05'); state.semester.courses = [course()];
    assert.equal(nextBoundary(state, new Date(2026, 9, 5, 7)), 3600100);
    assert.equal(nextBoundary(state, new Date(2026, 9, 5, 8)), 6000100);
    assert.equal(nextBoundary(state, new Date(2026, 9, 5, 10)), 50400100);
    assert.equal(todayCourses(state, '2026-10-12').length, 1);
    assert.equal(todayCourses(state, '2026-10-26').length, 0);
});
test('ICS exports precise occurrences including hidden weekends, escapes fields and folds UTF-8 safely', () => {
    const state = createState('2026-10-05'); state.settings.showWeekend = false;
    state.semester.courses = [course({ day: 7, weeks: [1, 3], name: '很长的中文课程名称'.repeat(10), notes: '教材;第二册\n带笔,纸' })];
    const ics = exportIcs(state), unfolded = ics.replaceAll('\r\n ', '');
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.ok(unfolded.includes('DTSTART:20261011T080000'));
    assert.ok(unfolded.includes('DTSTART:20261025T080000'));
    assert.ok(unfolded.includes('DTEND:20261011T094000'));
    assert.ok(unfolded.includes('教材\\;第二册\\n带笔\\,纸'));
    assert.ok(ics.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75));
});
