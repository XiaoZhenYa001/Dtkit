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
    Object.freeze({ key: 'dayOfMonth', label: '日期', min: 1, max: 31 }),
    Object.freeze({ key: 'month', label: '月份', min: 1, max: 12, names: MONTH_NAMES }),
    Object.freeze({ key: 'dayOfWeek', label: '星期', min: 0, max: 7, names: WEEKDAY_NAMES, normalize: value => value === 7 ? 0 : value })
]);

function parseInteger(token, definition, context) {
    const upperToken = token.toUpperCase();
    const namedValue = definition.names?.[upperToken];
    if (namedValue === undefined && !/^\d+$/.test(token)) {
        throw new SyntaxError(`${definition.label}字段中的“${context}”不是有效的整数或名称`);
    }
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
    if (raw.includes('?')) throw new SyntaxError('五段 Crontab 不支持“?”；不限制日期或星期时请使用“*”');

    const values = new Set();
    for (const segment of raw.split(',')) {
        if (!segment) throw new SyntaxError(`${definition.label}字段包含空列表项`);

        const stepParts = segment.split('/');
        if (stepParts.length > 2) throw new SyntaxError(`${definition.label}字段中的“${segment}”步长格式无效`);
        const base = stepParts[0];
        const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
        if ((stepParts.length === 2 && !/^\d+$/.test(stepParts[1])) || !Number.isSafeInteger(step) || step <= 0) {
            throw new SyntaxError(`${definition.label}字段中的步长必须是正整数`);
        }

        if (base === '*') {
            addRange(values, definition.min, definition.max, step, definition, segment);
            continue;
        }

        if (base.includes('-')) {
            const bounds = base.split('-');
            if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
                throw new SyntaxError(`${definition.label}字段中的范围“${segment}”格式无效`);
            }
            const start = parseInteger(bounds[0], definition, segment);
            let end = parseInteger(bounds[1], definition, segment);
            // Cronie accepts MON-SUN / 1-0 as ranges ending at Sunday (7).
            if (definition.key === 'dayOfWeek' && end === 0 && start > 0) end = 7;
            addRange(values, start, end, step, definition, segment);
            continue;
        }

        const start = parseInteger(base, definition, segment);
        if (stepParts.length === 2) throw new SyntaxError(`${definition.label}字段的步长请写为“${base}-${definition.max}/${step}”或“*/${step}”`);
        addRange(values, start, start, step, definition, segment);
    }

    const expectedSize = definition.key === 'dayOfWeek'
        ? 7
        : definition.max - definition.min + 1;

    return Object.freeze({
        raw,
        values,
        sortedValues: Object.freeze([...values].sort((a, b) => a - b)),
        // Cronie preserves whether the field starts with *, independently of its value set.
        wildcard: raw.startsWith('*'),
        allValues: values.size === expectedSize
    });
}

export function parseCronExpression(expression) {
    const source = String(expression ?? '').trim();
    if (!source) throw new SyntaxError('请输入 Cron 表达式');
    if (source.length > 512) throw new SyntaxError('表达式过长，请仅输入五段时间规则');
    if (source.toLowerCase() === '@reboot') throw new SyntaxError('@reboot 取决于实际重启事件，无法预估日历执行时间');

    const alias = source.toLowerCase();
    const hasAlias = Object.hasOwn(CRON_ALIASES, alias);
    const normalized = hasAlias ? CRON_ALIASES[alias] : source;
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
        alias: hasAlias ? alias : null,
        normalized: parts.join(' '),
        fields: Object.freeze(fields)
    });
}

function formatNumericList(values, formatter = String) {
    if (values.length <= 4) return values.map(formatter).join('、');
    return `${values.slice(0, 3).map(formatter).join('、')} 等 ${values.length} 个值`;
}

function describeField(field, definition) {
    if (field.allValues) return `任意${definition.label}`;
    const stepMatch = field.raw.match(/^\*\/(\d+)$/);
    if (stepMatch) return `从 ${definition.min} 起，每 ${stepMatch[1]} 个${definition.label}值`;

    if (definition.key === 'dayOfWeek') {
        return formatNumericList(field.sortedValues, value => WEEKDAY_LABELS[value]);
    }
    return formatNumericList(field.sortedValues);
}

function buildSummary(schedule) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = schedule.fields;
    const parts = [];

    if (!month.allValues) parts.push(`仅 ${formatNumericList(month.sortedValues)} 月`);
    const andDays = dayOfMonth.wildcard || dayOfWeek.wildcard;
    const monthDays = `每月 ${formatNumericList(dayOfMonth.sortedValues)} 日`;
    const weekDays = formatNumericList(dayOfWeek.sortedValues, value => WEEKDAY_LABELS[value]);
    if (andDays) {
        if (!dayOfMonth.allValues) parts.push(monthDays);
        if (!dayOfWeek.allValues) parts.push((!dayOfMonth.allValues ? '且' : '') + weekDays);
        if (dayOfMonth.allValues && dayOfWeek.allValues) parts.push('每天');
    } else if (dayOfMonth.allValues || dayOfWeek.allValues) {
        parts.push('每天（日或周有一项覆盖所有日期）');
    } else {
        parts.push(`${monthDays}或${weekDays}`);
    }

    if (hour.allValues && minute.allValues) {
        parts.push('每分钟');
    } else if (hour.allValues && minute.raw.match(/^\*\/(\d+)$/) && 60 % Number(minute.raw.slice(2)) === 0) {
        parts.push(`每 ${minute.raw.slice(2)} 分钟`);
    } else if (hour.sortedValues.length === 1 && minute.sortedValues.length === 1) {
        parts.push(`${String(hour.sortedValues[0]).padStart(2, '0')}:${String(minute.sortedValues[0]).padStart(2, '0')}`);
    } else {
        parts.push(hour.allValues ? '每小时' : `${formatNumericList(hour.sortedValues)} 点`);
        if (minute.allValues) parts.push('每分钟');
        else if (minute.raw.match(/^\*\/(\d+)$/) && 60 % Number(minute.raw.slice(2)) === 0) parts.push(`每 ${minute.raw.slice(2)} 分钟`);
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
        dayRule: schedule.fields.dayOfMonth.wildcard || schedule.fields.dayOfWeek.wildcard
            ? '日期与星期同时匹配；以 * 开头的字段按其展开值参与判断。'
            : '日期与星期按“或”匹配：任意一项满足即可。',
        details: Object.freeze(details)
    });
}

function matchesCalendarDay(date, fields) {
    const dayOfMonthMatches = fields.dayOfMonth.values.has(date.getUTCDate());
    const dayOfWeekMatches = fields.dayOfWeek.values.has(date.getUTCDay());

    if (fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard) return dayOfMonthMatches && dayOfWeekMatches;
    return dayOfMonthMatches || dayOfWeekMatches;
}

export function parseCronStart(value, timeZone = 'local') {
    if (!['local', 'utc'].includes(timeZone)) throw new RangeError('时区仅支持 local 或 utc');
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) throw new TypeError('请选择完整的起算日期与时间');
    const expected = match.slice(1).map((part, index) => index === 5 && part === undefined ? 0 : Number(part));
    const [year, month, day, hour, minute, second] = expected;
    const utc = timeZone === 'utc';
    const date = new Date(0);
    if (utc) { date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0); }
    else { date.setFullYear(year, month - 1, day); date.setHours(hour, minute, second, 0); }
    const actual = utc
        ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
        : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    if (year < 1 || year > 9969 || actual.some((part, index) => part !== expected[index])) {
        throw new RangeError('起算日期无效，或该本地时刻因夏令时跳转而不存在');
    }
    return date;
}

export function getNextOccurrences(expression, count = 5, from = new Date(), options = {}) {
    const schedule = typeof expression === 'string' ? parseCronExpression(expression) : expression;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new RangeError('执行次数必须是 1 到 20 之间的整数');
    }

    const start = new Date(from);
    if (Number.isNaN(start.getTime())) throw new TypeError('起始时间无效');
    const timeZone = options.timeZone ?? 'local';
    if (!['local', 'utc'].includes(timeZone)) throw new RangeError('时区仅支持 local 或 utc');
    const utc = timeZone === 'utc';
    const year = utc ? start.getUTCFullYear() : start.getFullYear();
    if (year < 1 || year > 9969) throw new RangeError('起算年份需在 1–9969 之间');

    // Walk calendar days first, so impossible dates never cause a 30-year minute scan.
    const day = new Date(0);
    day.setUTCFullYear(year, utc ? start.getUTCMonth() : start.getMonth(), utc ? start.getUTCDate() : start.getDate());
    day.setUTCHours(0, 0, 0, 0);
    const results = [];
    const lastYear = year + 30;
    const horizon = new Date(start);
    if (utc) horizon.setUTCFullYear(lastYear);
    else horizon.setFullYear(lastYear);
    const fields = schedule.fields;
    while (results.length < count && day.getUTCFullYear() <= lastYear) {
        if (fields.month.values.has(day.getUTCMonth() + 1) && matchesCalendarDay(day, fields)) {
            const nextDay = new Date(day);
            nextDay.setUTCDate(nextDay.getUTCDate() + 1);
            const localBoundary = calendar => {
                if (utc) return calendar.getTime();
                const boundary = new Date(0);
                boundary.setFullYear(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate());
                boundary.setHours(0, 0, 0, 0);
                return boundary.getTime();
            };
            const dayStart = localBoundary(day);
            const end = localBoundary(nextDay);
            const firstMinute = dayStart + Math.max(0, Math.floor((start.getTime() - dayStart) / 60000) + 1) * 60000;
            // Iterate actual instants inside matching days: gaps disappear and repeated DST minutes remain.
            for (let timestamp = firstMinute; timestamp < end; timestamp += 60000) {
                if (timestamp > horizon.getTime()) break;
                const candidate = new Date(timestamp);
                if (!utc && (candidate.getFullYear() !== day.getUTCFullYear() || candidate.getMonth() !== day.getUTCMonth() || candidate.getDate() !== day.getUTCDate())) continue;
                const hour = utc ? candidate.getUTCHours() : candidate.getHours();
                const minute = utc ? candidate.getUTCMinutes() : candidate.getMinutes();
                if (fields.hour.values.has(hour) && fields.minute.values.has(minute)) {
                    results.push(candidate);
                    if (results.length === count) break;
                }
            }
        }
        day.setUTCDate(day.getUTCDate() + 1);
    }

    if (results.length < count) {
        throw new RangeError('未来 30 年内没有找到足够的执行时间');
    }
    return results;
}
