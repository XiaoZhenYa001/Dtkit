import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/tools/timetable/model.js';
import { analyzeCourseDraft, collisionMessage, toggleWeekSelection } from '../src/tools/timetable/editor.js';
import { weekPreset } from '../src/tools/timetable/editorEnhancements.js';
import { additionalArrangement, courseForm, courseList } from '../src/tools/timetable/panels.js';

const fields = { name: '高等数学', teacher: '李老师', color: 'blue', notes: '' };
const schedule = (overrides = {}) => ({ day: '1', start: '1', end: '2', weeks: '1-4', parity: 'all', room: 'A-301', ...overrides });
const course = (overrides = {}) => ({ id: crypto.randomUUID(), ...fields, day: 1, start: 1, end: 2, weeks: [1, 2, 3, 4], room: 'A-301', ...overrides });

test('course draft preview counts real occurrences and validates without touching saved data', () => {
    const state = createState(), original = structuredClone(state);
    const result = analyzeCourseDraft(fields, [schedule({ parity: 'odd' }), schedule({ day: '3', start: '5', end: '5', weeks: '2,4' })], state.semester);
    assert.equal(result.meetings, 4);
    assert.equal(result.periods, 6);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.collisions, []);
    assert.match(result.summaries[0], /周一 · 08:00–09:40 · 1–2 节 · 2 周 · A-301/);
    assert.deepEqual(state, original);
});

test('live conflicts exclude edited arrangements and identify actual shared weeks and periods', () => {
    const state = createState(), own = course(), other = course({ name: '物理', start: 2, end: 3, weeks: [2, 4], room: 'B-202' });
    state.semester.courses = [own, other];
    const clear = analyzeCourseDraft(fields, [schedule({ parity: 'odd' })], state.semester, [own.id]);
    assert.deepEqual(clear.collisions, []);
    const result = analyzeCourseDraft(fields, [schedule()], state.semester, [own.id]);
    assert.equal(result.collisions.length, 1);
    assert.deepEqual(result.collisions[0].weeks, [2, 4]);
    assert.equal(result.collisions[0].start, 2);
    assert.equal(result.collisions[0].end, 2);
    assert.match(collisionMessage(result.collisions[0]), /周一第 2 节 · 第 2,4 周，与「物理」冲突（B-202）/);
});

test('live preview catches conflicts between new arrangements and reports malformed rows independently', () => {
    const state = createState();
    const result = analyzeCourseDraft(fields, [schedule(), schedule({ start: '2', end: '3' }), schedule({ day: '3', weeks: '2-x' })], state.semester);
    assert.equal(result.collisions.length, 1);
    assert.equal(result.collisions[0].index, 1);
    assert.equal(result.errors[0].index, 2);
    assert.match(result.errors[0].message, /周次/);
    assert.equal(result.courses.length, 2);
    assert.equal(result.meetings, 8);
    assert.deepEqual(analyzeCourseDraft(fields, [schedule({ start: '4', end: '2' })], state.semester).courses, []);
});

test('week chips normalize parity into explicit selected weeks and allow empty/recovery states', () => {
    assert.equal(toggleWeekSelection('1-8', 20, 'odd', 3), '1,5,7');
    assert.equal(toggleWeekSelection('1-8', 20, 'even', 3), '2-4,6,8');
    assert.equal(toggleWeekSelection('1', 20, 'all', 1), '');
    assert.equal(toggleWeekSelection('', 20, 'all', 5), '5');
    assert.equal(toggleWeekSelection('not a range', 20, 'all', 7), '7');
    assert.throws(() => toggleWeekSelection('1-4', 4, 'all', 5), /范围/);
});

test('preset detection follows the actual selection instead of raw syntax or stale parity', () => {
    assert.equal(weekPreset('1-6', 6, 'all'), 'all');
    assert.equal(weekPreset('1,3,5', 6, 'all'), 'odd');
    assert.equal(weekPreset('1-6', 6, 'even'), 'even');
    assert.equal(weekPreset('1-4', 6, 'odd'), 'custom');
    assert.equal(weekPreset('1-x', 6, 'all'), 'custom');
    assert.equal(weekPreset('1-1', 1, 'all'), 'all');
});

test('course forms preserve original hooks while excluding only intended records from conflict previews', () => {
    const state = createState(), first = course({ id: 'course-one' }), second = course({ id: 'course-two', day: 3 }), unrelated = course({ name: '物理' });
    state.semester.courses = [first, second, unrelated];
    const single = courseForm(state, first), group = courseForm(state, first, true), copy = courseForm(state, { ...first, id: null });
    assert.match(single, /data-edit-ids="\[&quot;course-one&quot;\]"/);
    assert.match(group, /data-edit-ids="\[&quot;course-one&quot;,&quot;course-two&quot;\]"/);
    assert.match(copy, /data-edit-ids="\[\]"/);
    for (const id of ['ttCourseForm', 'ttCourseName', 'ttCourseRoom', 'ttCourseTeacher', 'ttCourseStart', 'ttCourseEnd', 'ttCourseParity', 'ttCourseWeeks', 'ttCourseNotes', 'ttExtraArrangements', 'ttCourseCustomColor']) assert.ok(group.includes(`id="${id}"`));
    assert.equal((single.match(/data-week="/g) || []).length, state.semester.totalWeeks);
    const extra = additionalArrangement(state, { ...schedule(), id: 'arrangement-id' });
    assert.match(extra, /data-course-id="arrangement-id"/);
    for (const key of ['day', 'start', 'end', 'weeks', 'parity', 'room']) assert.ok(extra.includes(`data-schedule="${key}"`));
});

test('course management searches whole named groups, gives useful counts and escapes all course metadata', () => {
    const state = createState(), first = course({ name: '<数学>', room: '理论教室' }), second = course({ name: '<数学>', room: '机房', day: 3 });
    state.semester.courses = [first, second, course({ name: '物理' })];
    const html = courseList(state, '机房');
    assert.match(html, /找到 1 门课程 · 2 条上课安排/);
    assert.match(html, /&lt;数学&gt;/);
    assert.ok(!html.includes('<数学>'));
    assert.equal((html.match(/class="tt-course-row"/g) || []).length, 2);
    assert.match(courseList(state, '不存在'), /没有匹配的课程/);
});
