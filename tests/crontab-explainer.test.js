import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { explainCron, getNextOccurrences, parseCronExpression, parseCronStart } from '../src/tools/crontab-explainer/core.js';

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

test('numeric fields reject coercion, Quartz syntax, single-value steps and prototype names', () => {
    for (const source of ['1e1 * * * *', '0xA * * * *', '+1 * * * *', '*/1e1 * * * *', '*/0 * * * *', '0 0 ? * MON', '0 0 * * MON#2']) {
        assert.throws(() => parseCronExpression(source), SyntaxError, source);
    }
    assert.throws(() => parseCronExpression('5/10 * * * *'), /5-59\/10/);
    assert.throws(() => parseCronExpression('constructor'), /需要 5 个字段/);
    assert.throws(() => parseCronExpression('__proto__'), /需要 5 个字段/);
    assert.throws(() => parseCronExpression('@reboot'), /重启/);
    assert.throws(() => parseCronExpression('0 0 0 * * *'), /需要 5 个字段/);
});

test('explicit full ranges preserve OR semantics while starred day steps intersect weekday', () => {
    const from = new Date('2026-07-06T10:00:00Z');
    const next = source => getNextOccurrences(source, 1, from, { timeZone: 'utc' })[0].toISOString();
    assert.equal(next('0 9 1-31 * MON'), '2026-07-07T09:00:00.000Z');
    assert.equal(next('0 9 * * MON'), '2026-07-13T09:00:00.000Z');
    assert.equal(next('0 9 */1 * MON'), '2026-07-13T09:00:00.000Z');
    assert.equal(next('0 9 */2 * MON'), '2026-07-13T09:00:00.000Z');
    assert.match(explainCron('0 9 15 * MON').summary, /15 日或周一/);
    assert.match(explainCron('0 9 15 * MON').dayRule, /“或”/);
    assert.match(explainCron('0 9 */2 * MON').summary, /且周一/);
});

test('step explanations describe field boundaries rather than promise a fixed elapsed interval', () => {
    const explanation = explainCron('*/35 * * * *');
    assert.match(explanation.summary, /每小时.*0、35/);
    assert.doesNotMatch(explanation.summary, /每 35 分钟/);
    const times = getNextOccurrences('*/35 * * * *', 3, '2026-07-06T10:01:00Z', { timeZone: 'utc' });
    assert.deepEqual(times.map(date => date.toISOString()), ['2026-07-06T10:35:00.000Z', '2026-07-06T11:00:00.000Z', '2026-07-06T11:35:00.000Z']);
});

test('UTC mode has deterministic strict-after times and Sunday 0/7 equivalence', () => {
    const next = source => getNextOccurrences(source, 1, '2026-07-05T09:00:00.000Z', { timeZone: 'utc' })[0].toISOString();
    assert.equal(next('0 9 * * 0'), '2026-07-12T09:00:00.000Z');
    assert.equal(next('0 9 * * 7'), next('0 9 * * SUN'));
    assert.deepEqual(parseCronExpression('0 9 * * MON-SUN').fields.dayOfWeek.sortedValues, [0, 1, 2, 3, 4, 5, 6]);
    assert.throws(() => getNextOccurrences('* * * * *', 21), /1 到 20/);
    assert.throws(() => getNextOccurrences('* * * * *', 1, new Date('bad')), /无效/);
    assert.throws(() => getNextOccurrences('* * * * *', 1, new Date(), { timeZone: 'wrong' }), /时区/);
});

test('unreachable calendar dates fail within the bounded search while leap schedules work', () => {
    const started = performance.now();
    assert.throws(() => getNextOccurrences('0 0 31 FEB *', 5, '2026-01-01T00:00:00Z', { timeZone: 'utc' }), /30 年/);
    assert.throws(() => getNextOccurrences('0 0 29 FEB *', 20, '2026-01-01T00:00:00Z', { timeZone: 'utc' }), /30 年/);
    assert.ok(performance.now() - started < 2000, 'rare / impossible schedules should skip nonmatching calendar days');
    assert.deepEqual(getNextOccurrences('0 0 29 FEB *', 2, '2026-01-01T00:00:00Z', { timeZone: 'utc' }).map(date => date.toISOString()), ['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z']);
});

test('custom start validation rejects normalized invalid dates and supports early years', () => {
    assert.equal(parseCronStart('2026-07-06T10:05', 'utc').toISOString(), '2026-07-06T10:05:00.000Z');
    assert.equal(parseCronStart('0001-01-01T00:00', 'utc').getUTCFullYear(), 1);
    assert.throws(() => parseCronStart('2026-02-31T10:00', 'utc'), /无效/);
    assert.throws(() => parseCronStart('2026-07-06T24:00', 'utc'), /无效/);
    assert.throws(() => parseCronStart('2026-07-06'), /完整/);
});

test('local DST matching skips missing times and keeps both repeated times in chronological order', () => {
    const moduleUrl = new URL('../src/tools/crontab-explainer/core.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { getNextOccurrences, parseCronStart } from ${JSON.stringify(moduleUrl)};
        const times = (expr, from, count = 2) => getNextOccurrences(expr, count, from).map(date => date.toISOString());
        let missingStartRejected = false;
        try { parseCronStart('2026-03-08T02:30'); } catch { missingStartRejected = true; }
        console.log(JSON.stringify({
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            spring: times('30 2 * * *', '2026-03-08T05:00:00Z'),
            fall: times('30 1 * * *', '2026-11-01T04:00:00Z'),
            afterFirst: times('30 1 * * *', '2026-11-01T05:45:00Z', 1),
            missingStartRejected
        }));
    `], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' }, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.zone, 'America/New_York');
    assert.deepEqual(actual.spring, ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
    assert.deepEqual(actual.fall, ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    assert.deepEqual(actual.afterFirst, ['2026-11-01T06:30:00.000Z']);
    assert.equal(actual.missingStartRejected, true);
});
