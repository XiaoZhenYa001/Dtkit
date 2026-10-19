export const DATE_LIMIT_MS = 8_640_000_000_000_000;
const UNITS = new Set(['auto', 'sec', 'ms']);
const ZONES = new Set(['local', 'utc']);
const INTEGER_LIMIT = BigInt(DATE_LIMIT_MS);

export const TIMESTAMP_REFERENCES = Object.freeze([
    { id: 'billion', label: '十亿秒' },
    { id: 'year-2024', label: '2024 年元旦 · UTC' },
    { id: 'year-2025', label: '2025 年元旦 · UTC' },
    { id: 'year-2026', label: '2026 年元旦 · UTC' },
    { id: 'epoch', label: 'Unix 纪元 · UTC' },
    { id: 'day-ago', label: '24 小时前' },
    { id: 'week-ago', label: '7 天前' },
    { id: 'now', label: '此刻' }
]);

function validMilliseconds(milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > DATE_LIMIT_MS) {
        throw new Error('超出日期范围，请检查数值和秒 / 毫秒单位。');
    }
    return milliseconds;
}

export function parseTimestamp(source, unit = 'auto') {
    if (!UNITS.has(unit)) throw new Error('请选择有效的时间戳单位。');
    const text = String(source ?? '').trim();
    if (!text) throw new Error('请输入时间戳。');
    if (text.length > 40 || !/^[+-]?\d+(?:\.\d{1,3})?$/.test(text)) {
        throw new Error('请输入完整的十进制时间戳；秒最多保留 3 位小数。');
    }
    const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
    const integer = BigInt(whole);
    const detected = unit === 'auto'
        ? fraction ? 'sec' : integer >= 10_000_000_000n ? 'ms' : 'sec'
        : unit;
    if (detected === 'ms' && fraction) throw new Error('毫秒时间戳必须是整数。');
    const magnitude = detected === 'sec'
        ? integer * 1000n + BigInt(fraction.padEnd(3, '0') || '0')
        : integer;
    if (magnitude > INTEGER_LIMIT) throw new Error('超出日期范围，请检查数值和秒 / 毫秒单位。');
    const milliseconds = Number(text.startsWith('-') ? -magnitude : magnitude);
    return { milliseconds, unit: detected, automatic: unit === 'auto' };
}

export function parseDateTime(source, zone = 'local') {
    if (!ZONES.has(zone)) throw new Error('请选择本地时间或 UTC。');
    const match = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(source ?? '').trim());
    if (!match) throw new Error('请选择完整的日期时间。');
    const [, year, month, day, hour, minute, second = '0', fraction = ''] = match;
    const parts = [year, month, day, hour, minute, second, fraction.padEnd(3, '0') || '0'].map(Number);
    const [y, mo, d, h, mi, s, ms] = parts;
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
        throw new Error('日期时间无效，请检查年月日和时分秒。');
    }
    const date = new Date(0);
    const prefix = zone === 'utc' ? 'UTC' : '';
    date[`set${prefix}FullYear`](y, mo - 1, d);
    date[`set${prefix}Hours`](h, mi, s, ms);
    validMilliseconds(date.getTime());
    const actual = ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']
        .map(field => date[`get${prefix}${field}`]());
    actual[1] += 1;
    if (actual.some((value, index) => value !== parts[index])) {
        throw new Error(zone === 'local'
            ? '此本地日期时间不存在，请检查日期或夏令时跳转，也可切换为 UTC。'
            : '日期时间无效，请检查年月日和时分秒。');
    }
    return date.getTime();
}

function pad(value, length = 2) { return String(value).padStart(length, '0'); }

export function formatDateTimeInput(milliseconds, zone = 'local') {
    validMilliseconds(milliseconds);
    if (!ZONES.has(zone)) throw new Error('请选择本地时间或 UTC。');
    const date = new Date(milliseconds);
    const prefix = zone === 'utc' ? 'UTC' : '';
    const get = field => date[`get${prefix}${field}`]();
    const year = get('FullYear');
    const yearLabel = year < 0 ? '-' + pad(Math.abs(year), 6) : pad(year, 4);
    return `${yearLabel}-${pad(get('Month') + 1)}-${pad(get('Date'))}`
        + `T${pad(get('Hours'))}:${pad(get('Minutes'))}:${pad(get('Seconds'))}.${pad(get('Milliseconds'), 3)}`;
}

function unixSeconds(milliseconds) {
    const negative = milliseconds < 0;
    const absolute = Math.abs(milliseconds);
    const remainder = absolute % 1000;
    return (negative ? '-' : '') + Math.floor(absolute / 1000)
        + (remainder ? '.' + pad(remainder, 3).replace(/0+$/, '') : '');
}

export function describeInstant(milliseconds) {
    validMilliseconds(milliseconds);
    const date = new Date(milliseconds);
    const iso = date.toISOString();
    const offset = -date.getTimezoneOffset();
    const offsetLabel = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return {
        milliseconds,
        seconds: unixSeconds(milliseconds),
        iso,
        local: formatDateTimeInput(milliseconds).replace('T', ' ') + ' · ' + offsetLabel,
        utc: iso.replace('T', ' ').replace(/Z$/, '') + ' UTC',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || offsetLabel
    };
}

export function resolveTimestampReference(id, now = Date.now()) {
    const fixed = {
        billion: 1_000_000_000_000,
        'year-2024': Date.UTC(2024, 0, 1),
        'year-2025': Date.UTC(2025, 0, 1),
        'year-2026': Date.UTC(2026, 0, 1),
        epoch: 0
    };
    if (Object.hasOwn(fixed, id)) return fixed[id];
    const offsets = { now: 0, 'day-ago': 86_400_000, 'week-ago': 604_800_000 };
    if (!Object.hasOwn(offsets, id)) throw new Error('时间参考无效。');
    return validMilliseconds(now - offsets[id]);
}
