import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, courseHighlights } from '../src/tools/timetable/model.js';
import { matchesCourse, weekOverview, liveContext, nextLiveRefresh, TimetableHistory } from '../src/tools/timetable/core.js';

const course = (changes = {}) => ({ id: crypto.randomUUID(), name: '高等数学', room: 'A-301', teacher: '李老师', notes: '携带教材', color: 'blue', day: 1, start: 1, end: 2, weeks: [1, 2], ...changes });
const fixture = () => {
    const state = createState('2026-10-05');
    state.semester.courses = [course()]; return state;
};
const at = (hours, minutes = 0, seconds = 0) => new Date(2026, 9, 5, hours, minutes, seconds);

test('search matches literal tokens across course, room, teacher and notes', () => {
    assert.equal(matchesCourse(course(), '数学 李老师 A-301'), true);
    assert.equal(matchesCourse(course({ name: 'Design Review' }), '"design review" 教材'), true);
    assert.equal(matchesCourse(course(), '<img ['), false);
    assert.equal(matchesCourse(course(), ''), true);
});

test('weekly statistics count teaching minutes without breaks and respect weekends/search', () => {
    const state = fixture(); state.semester.courses.push(course({ day: 7 }), course({ day: 2, name: '物理', end: 1, weeks: [2] }));
    assert.deepEqual(Object.fromEntries(Object.entries(weekOverview(state, 1)).filter(([key]) => key !== 'courses')), { arrangements: 2, subjects: 1, periods: 4, minutes: 180, days: 2, hidden: 0 });
    state.settings.showWeekend = false;
    assert.equal(weekOverview(state, 1).hidden, 1); assert.equal(weekOverview(state, 1).minutes, 90);
    assert.equal(weekOverview(state, 2, '物理').arrangements, 1); assert.equal(weekOverview(state, 1, '不存在').arrangements, 0);
});

test('live context distinguishes actual teaching, short break, upcoming class and finished day', () => {
    const state = fixture();
    assert.equal(liveContext(state, at(7, 50)).phase, 'next');
    const current = liveContext(state, at(8, 20));
    assert.equal(current.phase, 'current'); assert.equal(current.remainingMinutes, 25); assert.ok(Math.abs(current.progress - 20 / 45) < 1e-9);
    const pause = liveContext(state, at(8, 46));
    assert.equal(pause.phase, 'next'); assert.equal(pause.segment.start, 2); assert.equal(pause.remainingMinutes, 9);
    assert.equal(liveContext(state, at(9, 20)).phase, 'current');
    assert.equal(liveContext(state, at(9, 40)).phase, 'done');
    assert.deepEqual(courseHighlights(state, 1, at(8, 46)).map(item => item.label), ['下一节']);
    assert.deepEqual(courseHighlights(state, 1, at(8, 55)).map(item => item.label), ['正在上课']);
});

test('lunch and evening rest never count as teaching for a course spanning both', () => {
    const state = fixture(); state.semester.courses[0].start = 3; state.semester.courses[0].end = 10;
    assert.equal(liveContext(state, at(12)).phase, 'next'); assert.equal(liveContext(state, at(12)).segment.start, 5);
    assert.equal(liveContext(state, at(18)).phase, 'next'); assert.equal(liveContext(state, at(18)).segment.start, 9);
    assert.equal(liveContext(state, at(14, 10)).phase, 'current');
});

test('live summary honors exact boundary, week parity and semester bounds', () => {
    const state = fixture();
    assert.equal(liveContext(state, at(8, 45)).phase, 'next');
    assert.equal(liveContext(state, at(8, 55)).phase, 'current');
    assert.equal(liveContext(state, at(8, 44, 59)).remainingMinutes, 1);
    assert.equal(liveContext(state, new Date(2026, 9, 6, 9)).phase, 'empty');
    assert.equal(liveContext(state, new Date(2026, 8, 1)).phase, 'before');
    assert.equal(liveContext(state, new Date(2027, 8, 1)).phase, 'after');
    state.semester.courses[0].weeks = [2]; assert.equal(liveContext(state, at(8, 20)).phase, 'empty');
});

test('countdown refresh is minute-aligned while active and sleeps until midnight after classes', () => {
    const state = fixture();
    assert.equal(nextLiveRefresh(state, at(8, 20, 30)), 30100);
    assert.equal(nextLiveRefresh(state, at(8, 44, 59)), 1100);
    assert.equal(nextLiveRefresh(state, at(10)), 14 * 3600000 + 100);
    assert.ok(nextLiveRefresh(state, at(8, 20, 59)) >= 1000);
});

test('history owns immutable copies and keeps revisions under store control', () => {
    const history = new TimetableHistory(), before = fixture(), after = structuredClone(before);
    after.revision++; after.semester.courses[0].room = 'B-102';
    history.record(before, after, '改教室'); before.semester.courses[0].room = '后来改动';
    assert.equal(history.canUndo, true); assert.equal(history.canRedo, false);
    assert.equal(history.peek('undo').before.revision, undefined); assert.equal(history.peek('undo').before.semester.courses[0].room, 'A-301');
    history.accept('undo'); assert.equal(history.canUndo, false); assert.equal(history.peek('redo').after.semester.courses[0].room, 'B-102');
    history.accept('redo'); assert.equal(history.canRedo, false); assert.equal(history.canUndo, true);
});

test('history ignores revision-only writes and drops redo after a new edit', () => {
    const history = new TimetableHistory(), before = fixture(), after = structuredClone(before);
    after.revision++; history.record(before, after); assert.equal(history.canUndo, false);
    after.semester.name = '新学期'; history.record(before, after); history.accept('undo');
    const next = structuredClone(before); next.settings.showWeekend = false; history.record(before, next);
    assert.equal(history.canRedo, false); assert.equal(history.peek('undo').after.settings.showWeekend, false);
});

test('history has entry and memory bounds without leaving a stale undo after oversized edits', () => {
    const history = new TimetableHistory({ maxEntries: 2 }), state = fixture();
    for (let index = 0; index < 5; index++) { const next = structuredClone(state); next.semester.name = String(index); history.record(state, next); }
    assert.equal(history.undoStack.length, 2);
    const tiny = new TimetableHistory({ maxBytes: 1 }); tiny.record(state, { ...state, version: 2 }); assert.equal(tiny.canUndo, false);
    history.clear(); assert.equal(history.canUndo, false); assert.equal(history.canRedo, false);
});
