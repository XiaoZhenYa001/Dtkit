import assert from 'node:assert/strict';
import test from 'node:test';

import { explainCron, getNextOccurrences, parseCronExpression } from '../src/tools/crontab-explainer/core.js';

function localParts(date) {
    return [
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes()
    ];
}

test('parser supports steps, ranges and named weekdays', () => {
    const schedule = parseCronExpression('*/15 9-18 * * MON-FRI');

    assert.deepEqual(schedule.fields.minute.sortedValues, [0, 15, 30, 45]);
    assert.deepEqual(schedule.fields.hour.sortedValues, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    assert.deepEqual(schedule.fields.dayOfWeek.sortedValues, [1, 2, 3, 4, 5]);
    assert.equal(schedule.fields.dayOfMonth.wildcard, true);
    assert.match(explainCron(schedule).summary, /周一/);
    assert.match(explainCron(schedule).summary, /每 15 分钟/);
});

test('common aliases and named months normalize to standard five-field syntax', () => {
    assert.equal(parseCronExpression('@daily').normalized, '0 0 * * *');
    const yearly = parseCronExpression('0 0 1 JAN *');
    assert.deepEqual(yearly.fields.month.sortedValues, [1]);

    const namedFields = parseCronExpression('0 12 * JUL WED');
    assert.deepEqual(namedFields.fields.month.sortedValues, [7]);
    assert.deepEqual(namedFields.fields.dayOfWeek.sortedValues, [3]);
});

test('invalid field counts, ranges and non-standard extensions are rejected', () => {
    assert.throws(() => parseCronExpression('* * * *'), /需要 5 个字段/);
    assert.throws(() => parseCronExpression('60 * * * *'), /超出范围/);
    assert.throws(() => parseCronExpression('* 18-9 * * *'), /起点不能大于终点/);
    assert.throws(() => parseCronExpression('0 0 L * *'), /不支持/);
});

test('next occurrences respect minute steps and start strictly after the base time', () => {
    const from = new Date(2026, 6, 13, 10, 7, 30);
    const occurrences = getNextOccurrences('*/15 * * * *', 3, from);

    assert.deepEqual(occurrences.map(localParts), [
        [2026, 7, 13, 10, 15],
        [2026, 7, 13, 10, 30],
        [2026, 7, 13, 10, 45]
    ]);
});

test('weekday schedules skip weekends and cron day fields use OR semantics', () => {
    const fridayMorning = new Date(2026, 6, 10, 9, 1, 0);
    const nextWorkday = getNextOccurrences('0 9 * * MON-FRI', 1, fridayMorning)[0];
    assert.deepEqual(localParts(nextWorkday), [2026, 7, 13, 9, 0]);

    const beforeFifteenth = new Date(2026, 6, 14, 10, 0, 0);
    const dayOrMonday = getNextOccurrences('0 9 15 * MON', 1, beforeFifteenth)[0];
    assert.deepEqual(localParts(dayOrMonday), [2026, 7, 15, 9, 0]);
});
