import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
    DATE_LIMIT_MS,
    describeInstant,
    formatDateTimeInput,
    parseDateTime,
    parseTimestamp,
    resolveTimestampReference
} from '../src/tools/timestamp-converter/core.js';

test('timestamp units accept zero and distinguish signed seconds from signed milliseconds', () => {
    assert.equal(parseTimestamp('0').milliseconds, 0);
    assert.equal(parseTimestamp('-1000', 'ms').milliseconds, -1000);
    assert.equal(parseTimestamp('-1000', 'sec').milliseconds, -1_000_000);
    assert.deepEqual(parseTimestamp('1767225600'), {
        milliseconds: 1_767_225_600_000, unit: 'sec', automatic: true
    });
    assert.deepEqual(parseTimestamp('-1767225600000'), {
        milliseconds: -1_767_225_600_000, unit: 'ms', automatic: true
    });
    assert.equal(parseTimestamp('1767225600000', 'ms').automatic, false);
    assert.equal(describeInstant(parseTimestamp('0').milliseconds).iso, '1970-01-01T00:00:00.000Z');
});

test('decimal seconds preserve millisecond precision without floating-point truncation', () => {
    assert.equal(parseTimestamp('1.001', 'sec').milliseconds, 1001);
    assert.equal(parseTimestamp('-0.001').milliseconds, -1);
    assert.equal(parseTimestamp('  +1767225600.123  ').milliseconds, 1_767_225_600_123);
    assert.equal(describeInstant(-1).seconds, '-0.001');
    assert.equal(describeInstant(1001).seconds, '1.001');
    assert.equal(describeInstant(1200).seconds, '1.2');
});

test('timestamp validation rejects trailing text, non-decimal notation and excessive precision', () => {
    for (const source of ['', '   ', '1767225600abc', '1e3', '0x10', 'NaN', 'Infinity',
        '1,000', '1 000', '1.2345', '--1', '.5', '1.']) {
        assert.throws(() => parseTimestamp(source), undefined, source);
    }
    assert.throws(() => parseTimestamp('1.5', 'ms'), /毫秒时间戳必须是整数/);
    assert.throws(() => parseTimestamp('1', 'minutes'), /有效的时间戳单位/);
});

test('full Date range is validated before ISO formatting', () => {
    for (const milliseconds of [DATE_LIMIT_MS, -DATE_LIMIT_MS]) {
        assert.equal(parseTimestamp(String(milliseconds), 'ms').milliseconds, milliseconds);
        assert.ok(describeInstant(milliseconds).iso);
    }
    assert.equal(parseTimestamp('8640000000000', 'sec').milliseconds, DATE_LIMIT_MS);
    assert.throws(() => parseTimestamp('8640000000000.001', 'sec'), /超出日期范围/);
    assert.throws(() => parseTimestamp('-8640000000000001', 'ms'), /超出日期范围/);
    assert.throws(() => parseTimestamp('999999999999999999999999999999', 'ms'), /超出日期范围/);
    assert.throws(() => describeInstant(Number.NaN), /超出日期范围/);
    assert.throws(() => describeInstant(Infinity), /超出日期范围/);
    assert.throws(() => describeInstant(0.5), /超出日期范围/);
});

test('UTC date parsing keeps seconds, milliseconds and years before 100', () => {
    assert.equal(parseDateTime('1970-01-01T00:00', 'utc'), 0);
    assert.equal(parseDateTime('1969-12-31T23:59:59.999', 'utc'), -1);
    const timestamp = parseDateTime('2026-01-01T09:30:45.123', 'utc');
    assert.equal(describeInstant(timestamp).iso, '2026-01-01T09:30:45.123Z');
    assert.equal(formatDateTimeInput(timestamp, 'utc'), '2026-01-01T09:30:45.123');
    assert.equal(describeInstant(parseDateTime('0001-01-01T00:00', 'utc')).iso, '0001-01-01T00:00:00.000Z');
    assert.equal(formatDateTimeInput(Date.parse('-000001-01-01T00:00:00Z'), 'utc'), '-000001-01-01T00:00:00.000');
});

test('date parsing rejects normalized invalid dates instead of silently rolling them forward', () => {
    for (const source of ['', '2026-02-29T12:00', '2024-02-30T12:00', '2026-04-31T12:00',
        '2026-13-01T00:00', '2026-01-00T00:00', '2026-01-01T24:00',
        '2026-01-01T00:00:60', '2026-01-01T00:00:00.1234', '0000-01-01T00:00',
        '2026-01-01T00:00Z', '2026-01-01T00:00+08:00']) {
        assert.throws(() => parseDateTime(source, 'utc'), undefined, source);
    }
    assert.equal(describeInstant(parseDateTime('2024-02-29T12:00', 'utc')).iso, '2024-02-29T12:00:00.000Z');
    assert.throws(() => parseDateTime('2026-01-01T00:00', 'GMT'), /本地时间或 UTC/);
});

function evaluateInZone(zone, body) {
    const moduleUrl = new URL('../src/tools/timestamp-converter/core.js', import.meta.url).href;
    const script = `import {parseDateTime,describeInstant,formatDateTimeInput} from ${JSON.stringify(moduleUrl)};\n${body}`;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', env: { ...process.env, TZ: zone }, windowsHide: true
    }));
}

test('local date parsing follows the browser time zone while UTC stays independent', () => {
    const shanghai = evaluateInZone('Asia/Shanghai', `
        const value=parseDateTime('2026-01-01T08:00:00.123');
        console.log(JSON.stringify({iso:describeInstant(value).iso,local:formatDateTimeInput(value),utc:parseDateTime('1970-01-01T00:00','utc')}));
    `);
    assert.deepEqual(shanghai, { iso: '2026-01-01T00:00:00.123Z', local: '2026-01-01T08:00:00.123', utc: 0 });
    const newYork = evaluateInZone('America/New_York', `
        const value=parseDateTime('2026-01-01T08:00');
        console.log(JSON.stringify({iso:describeInstant(value).iso,local:formatDateTimeInput(value)}));
    `);
    assert.deepEqual(newYork, { iso: '2026-01-01T13:00:00.000Z', local: '2026-01-01T08:00:00.000' });
});

test('DST gaps are rejected and repeated local times follow native Date resolution', () => {
    const result = evaluateInZone('America/New_York', `
        let rejected=false;
        try {parseDateTime('2026-03-08T02:30');} catch(error) {rejected=/本地日期时间不存在/.test(error.message);}
        const fall=parseDateTime('2026-11-01T01:30');
        console.log(JSON.stringify({rejected,fall,native:new Date(2026,10,1,1,30).getTime()}));
    `);
    assert.equal(result.rejected, true);
    assert.equal(result.fall, result.native);
});

test('quick references use correct UTC dates and resolve relative times at each click', () => {
    for (const year of [2024, 2025, 2026]) {
        assert.equal(describeInstant(resolveTimestampReference('year-' + year)).iso, `${year}-01-01T00:00:00.000Z`);
    }
    assert.equal(resolveTimestampReference('epoch'), 0);
    assert.equal(resolveTimestampReference('billion'), 1_000_000_000_000);
    const now = 1_800_000_000_123;
    assert.equal(resolveTimestampReference('now', now), now);
    assert.equal(resolveTimestampReference('day-ago', now), now - 86_400_000);
    assert.equal(resolveTimestampReference('week-ago', now + 60_000), now + 60_000 - 604_800_000);
    assert.throws(() => resolveTimestampReference('missing', now), /时间参考无效/);
});
