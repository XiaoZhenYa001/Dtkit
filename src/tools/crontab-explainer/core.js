const MONTH_NAMES = Object.freeze({ JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 });
const WEEKDAY_NAMES = Object.freeze({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 });
const WEEKDAY_LABELS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

export const CRON_ALIASES = Object.freeze({
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *'
});

const FIELD_DEFINITIONS = Object.freeze([
    Object.freeze({ key: 'minute', label: '分钟', min: 0, max: 59 }),
    Object.freeze({ key: 'hour', label: '小时', min: 0, max: 23 }),
    Object.freeze({ key: 'dayOfMonth', label: '日期', min: 1, max: 31, allowQuestion: true }),
    Object.freeze({ key: 'month', label: '月份', min: 1, max: 12, names: MONTH_NAMES }),
    Object.freeze({ key: 'dayOfWeek', label: '星期', min: 0, max: 7, names: WEEKDAY_NAMES, allowQuestion: true, normalize: value => value === 7 ? 0 : value })
]);

function parseInteger(token, definition, context) {
    const upperToken = token.toUpperCase();
    const namedValue = definition.names?.[upperToken];
    const value = namedValue ?? Number(token);

    if (!Number.isInteger(value) || value < definition.min || value > definition.max) {
        throw new SyntaxError(`${definition.label}字段中的“${context}”超出范围 ${definition.min}-${definition.max}`);
    }
    return value;
}

function addRange(values, start, end, step, definition, context) {
    if (start > end) throw new SyntaxError(`${definition.label}字段中的范围“${context}”起点不能大于终点`);
    for (let value = start; value <= end; value += step) {
        values.add(definition.normalize ? definition.normalize(value) : value);
    }
}

function parseField(source, definition) {
    const raw = source.trim().toUpperCase();
    if (!raw) throw new SyntaxError(`${definition.label}字段不能为空`);
    const usesQuartzExtension = raw.includes('#') || /(?:^|,)(?:L|LW|L-\d+|\d+[LW])(?:,|$)/.test(raw);
    if (usesQuartzExtension) throw new SyntaxError(`标准 Crontab 不支持 ${definition.label}字段中的 L、W 或 # 扩展语法`);
    if (raw.includes('?') && (!definition.allowQuestion || raw !== '?')) {
        throw new SyntaxError(`${definition.label}字段不支持“?”`);
    }

    const values = new Set();
    for (const segment of raw.split(',')) {
        if (!segment) throw new SyntaxError(`${definition.label}字段包含空列表项`);

        const stepParts = segment.split('/');
        if (stepParts.length > 2) throw new SyntaxError(`${definition.label}字段中的“${segment}”步长格式无效`);
        const base = stepParts[0];
        const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
        if (!Number.isInteger(step) || step <= 0) throw new SyntaxError(`${definition.label}字段中的步长必须是正整数`);

        if (base === '*' || base === '?') {
            addRange(values, definition.min, definition.max, step, definition, segment);
            continue;
        }

        if (base.includes('-')) {
            const bounds = base.split('-');
            if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
                throw new SyntaxError(`${definition.label}字段中的范围“${segment}”格式无效`);
            }
            const start = parseInteger(bounds[0], definition, segment);
            const end = parseInteger(bounds[1], definition, segment);
            addRange(values, start, end, step, definition, segment);
            continue;
        }

        const start = parseInteger(base, definition, segment);
        const end = stepParts.length === 2 ? definition.max : start;
        addRange(values, start, end, step, definition, segment);
    }

    const expectedSize = definition.key === 'dayOfWeek'
        ? 7
        : definition.max - definition.min + 1;

    return Object.freeze({
        raw,
        values,
        sortedValues: Object.freeze([...values].sort((a, b) => a - b)),
        wildcard: values.size === expectedSize
    });
}

export function parseCronExpression(expression) {
    const source = String(expression ?? '').trim();
    if (!source) throw new SyntaxError('请输入 Cron 表达式');

    const alias = source.toLowerCase();
    const normalized = CRON_ALIASES[alias] || source;
    const parts = normalized.split(/\s+/);
    if (parts.length !== 5) {
        throw new SyntaxError(`标准 Crontab 需要 5 个字段，当前检测到 ${parts.length} 个`);
    }

    const fields = {};
    FIELD_DEFINITIONS.forEach((definition, index) => {
        fields[definition.key] = parseField(parts[index], definition);
    });

    return Object.freeze({
        source,
        alias: CRON_ALIASES[alias] ? alias : null,
        normalized: parts.join(' '),
        fields: Object.freeze(fields)
    });
}

function formatNumericList(values, formatter = String) {
    if (values.length <= 4) return values.map(formatter).join('、');
    return `${values.slice(0, 3).map(formatter).join('、')} 等 ${values.length} 个值`;
}

function describeField(field, definition) {
    if (field.wildcard) return `任意${definition.label}`;
    const stepMatch = field.raw.match(/^\*\/(\d+)$/);
    if (stepMatch) return `每 ${stepMatch[1]} ${definition.label}`;

    if (definition.key === 'dayOfWeek') {
        return formatNumericList(field.sortedValues, value => WEEKDAY_LABELS[value]);
    }
    return formatNumericList(field.sortedValues);
}

function buildSummary(schedule) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = schedule.fields;
    const parts = [];

    if (!month.wildcard) parts.push(`${formatNumericList(month.sortedValues)} 月`);
    if (!dayOfMonth.wildcard) parts.push(`每月 ${formatNumericList(dayOfMonth.sortedValues)} 日`);
    if (!dayOfWeek.wildcard) parts.push(formatNumericList(dayOfWeek.sortedValues, value => WEEKDAY_LABELS[value]));

    if (hour.wildcard && minute.wildcard) {
        parts.push('每分钟');
    } else if (hour.wildcard && minute.raw.match(/^\*\/(\d+)$/)) {
        parts.push(`每 ${minute.raw.slice(2)} 分钟`);
    } else if (hour.sortedValues.length === 1 && minute.sortedValues.length === 1) {
        parts.push(`${String(hour.sortedValues[0]).padStart(2, '0')}:${String(minute.sortedValues[0]).padStart(2, '0')}`);
    } else {
        if (!hour.wildcard) parts.push(`${formatNumericList(hour.sortedValues)} 点`);
        if (minute.wildcard) parts.push('每分钟');
        else if (minute.raw.match(/^\*\/(\d+)$/)) parts.push(`每 ${minute.raw.slice(2)} 分钟`);
        else parts.push(`第 ${formatNumericList(minute.sortedValues)} 分钟`);
    }

    return parts.join('，');
}

export function explainCron(expression) {
    const schedule = typeof expression === 'string' ? parseCronExpression(expression) : expression;
    const details = FIELD_DEFINITIONS.map(definition => Object.freeze({
        key: definition.key,
        label: definition.label,
        source: schedule.fields[definition.key].raw,
        description: describeField(schedule.fields[definition.key], definition)
    }));

    return Object.freeze({
        normalized: schedule.normalized,
        summary: buildSummary(schedule),
        details: Object.freeze(details)
    });
}

function matchesCalendarDay(date, fields) {
    const dayOfMonthMatches = fields.dayOfMonth.values.has(date.getDate());
    const dayOfWeekMatches = fields.dayOfWeek.values.has(date.getDay());

    if (fields.dayOfMonth.wildcard && fields.dayOfWeek.wildcard) return true;
    if (fields.dayOfMonth.wildcard) return dayOfWeekMatches;
    if (fields.dayOfWeek.wildcard) return dayOfMonthMatches;
    return dayOfMonthMatches || dayOfWeekMatches;
}

function nextAllowed(values, current) {
    return values.find(value => value >= current);
}

export function getNextOccurrences(expression, count = 5, from = new Date()) {
    const schedule = typeof expression === 'string' ? parseCronExpression(expression) : expression;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new RangeError('执行次数必须是 1 到 20 之间的整数');
    }

    const start = new Date(from);
    if (Number.isNaN(start.getTime())) throw new TypeError('起始时间无效');

    const cursor = new Date(start);
    cursor.setSeconds(0, 0);
    if (cursor <= start) cursor.setMinutes(cursor.getMinutes() + 1);

    const results = [];
    const lastYear = cursor.getFullYear() + 30;
    const fields = schedule.fields;

    while (results.length < count && cursor.getFullYear() <= lastYear) {
        const currentMonth = cursor.getMonth() + 1;
        if (!fields.month.values.has(currentMonth)) {
            const month = nextAllowed(fields.month.sortedValues, currentMonth);
            cursor.setDate(1);
            cursor.setHours(0, 0, 0, 0);
            if (month === undefined) {
                cursor.setFullYear(cursor.getFullYear() + 1);
                cursor.setMonth(fields.month.sortedValues[0] - 1);
            } else {
                cursor.setMonth(month - 1);
            }
            continue;
        }

        if (!matchesCalendarDay(cursor, fields)) {
            cursor.setDate(cursor.getDate() + 1);
            cursor.setHours(0, 0, 0, 0);
            continue;
        }

        const currentHour = cursor.getHours();
        if (!fields.hour.values.has(currentHour)) {
            const hour = nextAllowed(fields.hour.sortedValues, currentHour);
            if (hour === undefined) {
                cursor.setDate(cursor.getDate() + 1);
                cursor.setHours(fields.hour.sortedValues[0], 0, 0, 0);
            } else {
                cursor.setHours(hour, 0, 0, 0);
            }
            continue;
        }

        const currentMinute = cursor.getMinutes();
        if (!fields.minute.values.has(currentMinute)) {
            const minute = nextAllowed(fields.minute.sortedValues, currentMinute);
            if (minute === undefined) {
                cursor.setHours(cursor.getHours() + 1, fields.minute.sortedValues[0], 0, 0);
            } else {
                cursor.setMinutes(minute, 0, 0);
            }
            continue;
        }

        results.push(new Date(cursor));
        cursor.setMinutes(cursor.getMinutes() + 1);
    }

    if (results.length < count) {
        throw new RangeError('未来 30 年内没有找到足够的执行时间');
    }
    return results;
}
