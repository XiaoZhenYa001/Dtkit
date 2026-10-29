function linearUnit(id, label, symbol, factor) {
    return Object.freeze({ id, label, symbol, factor });
}

export const UNIT_CATEGORIES = Object.freeze({
    data: Object.freeze({
        id: 'data',
        label: '数据存储',
        units: Object.freeze([
            linearUnit('bit', '比特', 'bit', 0.125),
            linearUnit('byte', '字节', 'B', 1),
            linearUnit('kb', '千字节（十进制）', 'KB', 1_000),
            linearUnit('mb', '兆字节（十进制）', 'MB', 1_000_000),
            linearUnit('gb', '吉字节（十进制）', 'GB', 1_000_000_000),
            linearUnit('kib', '千二进制字节', 'KiB', 1_024),
            linearUnit('mib', '兆二进制字节', 'MiB', 1_048_576),
            linearUnit('gib', '吉二进制字节', 'GiB', 1_073_741_824),
            linearUnit('tb', '太字节（十进制）', 'TB', 1_000_000_000_000),
            linearUnit('tib', '太二进制字节', 'TiB', 1_099_511_627_776)
        ])
    }),
    length: Object.freeze({
        id: 'length',
        label: '长度',
        units: Object.freeze([
            linearUnit('mm', '毫米', 'mm', 0.001),
            linearUnit('cm', '厘米', 'cm', 0.01),
            linearUnit('m', '米', 'm', 1),
            linearUnit('km', '千米', 'km', 1_000),
            linearUnit('in', '英寸', 'in', 0.0254),
            linearUnit('ft', '英尺', 'ft', 0.3048),
            linearUnit('yd', '码', 'yd', 0.9144),
            linearUnit('mi', '英里', 'mi', 1_609.344)
        ])
    }),
    mass: Object.freeze({
        id: 'mass',
        label: '质量',
        units: Object.freeze([
            linearUnit('mg', '毫克', 'mg', 0.000001),
            linearUnit('g', '克', 'g', 0.001),
            linearUnit('kg', '千克', 'kg', 1),
            linearUnit('t', '公吨', 't', 1_000),
            linearUnit('oz', '盎司', 'oz', 0.028349523125),
            linearUnit('lb', '磅', 'lb', 0.45359237)
        ])
    }),
    temperature: Object.freeze({
        id: 'temperature',
        label: '温度',
        units: Object.freeze([
            Object.freeze({ id: 'c', label: '摄氏度', symbol: '°C', minimum: -273.15, toBase: value => value + 273.15, fromBase: value => value - 273.15 }),
            Object.freeze({ id: 'f', label: '华氏度', symbol: '°F', minimum: -459.67, toBase: value => (value - 32) * (5 / 9) + 273.15, fromBase: value => (value - 273.15) * (9 / 5) + 32 }),
            Object.freeze({ id: 'k', label: '开尔文', symbol: 'K', minimum: 0, toBase: value => value, fromBase: value => value })
        ])
    }),
    area: Object.freeze({
        id: 'area',
        label: '面积',
        units: Object.freeze([
            linearUnit('sqm', '平方米', 'm²', 1),
            linearUnit('sqkm', '平方千米', 'km²', 1_000_000),
            linearUnit('hectare', '公顷', 'ha', 10_000),
            linearUnit('acre', '英亩', 'acre', 4_046.8564224),
            linearUnit('sqft', '平方英尺', 'ft²', 0.09290304)
        ])
    }),
    speed: Object.freeze({
        id: 'speed',
        label: '速度',
        units: Object.freeze([
            linearUnit('mps', '米每秒', 'm/s', 1),
            linearUnit('kph', '千米每小时', 'km/h', 1 / 3.6),
            linearUnit('mph', '英里每小时', 'mph', 0.44704),
            linearUnit('knot', '节', 'kn', 0.5144444444444445)
        ])
    }),
    volume: Object.freeze({
        id: 'volume', label: '体积',
        units: Object.freeze([
            linearUnit('ml', '毫升', 'mL', 0.001),
            linearUnit('l', '升', 'L', 1),
            linearUnit('cm3', '立方厘米', 'cm³', 0.001),
            linearUnit('m3', '立方米', 'm³', 1_000),
            linearUnit('ft3', '立方英尺', 'ft³', 28.316846592),
            linearUnit('usgal', '美制液体加仑', 'US gal', 3.785411784)
        ])
    }),
    pressure: Object.freeze({
        id: 'pressure', label: '压力',
        units: Object.freeze([
            linearUnit('pa', '帕斯卡', 'Pa', 1),
            linearUnit('kpa', '千帕', 'kPa', 1_000),
            linearUnit('mpa', '兆帕', 'MPa', 1_000_000),
            linearUnit('bar', '巴', 'bar', 100_000),
            linearUnit('atm', '标准大气压', 'atm', 101_325),
            linearUnit('psi', '磅力每平方英寸', 'psi', 0.45359237 * 9.80665 / (0.0254 ** 2))
        ])
    }),
    energy: Object.freeze({
        id: 'energy', label: '能量',
        units: Object.freeze([
            linearUnit('j', '焦耳', 'J', 1),
            linearUnit('kj', '千焦', 'kJ', 1_000),
            linearUnit('wh', '瓦时', 'Wh', 3_600),
            linearUnit('kwh', '千瓦时（度电）', 'kWh', 3_600_000),
            linearUnit('calth', '卡（热化学）', 'calₜₕ', 4.184),
            linearUnit('kcalth', '千卡（热化学）', 'kcalₜₕ', 4_184)
        ])
    })
});

export function getUnitCategory(categoryId) {
    return Object.hasOwn(UNIT_CATEGORIES, categoryId) ? UNIT_CATEGORIES[categoryId] : null;
}

function getUnit(category, unitId) {
    return category.units.find(unit => unit.id === unitId) || null;
}

export function parseUnitValue(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
        throw new TypeError('请输入需要换算的数值');
    }
    if (typeof value !== 'number' && (typeof value !== 'string'
        || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
        throw new TypeError('请输入十进制数值，可使用科学记数法（例如 1.5e3）');
    }
    const numericValue = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(numericValue)) {
        throw new TypeError('请输入有效的有限数值');
    }
    if (numericValue === 0 && typeof value === 'string' && /[1-9]/.test(value.split(/[eE]/)[0])) {
        throw new RangeError('数值过小，超出可表示范围');
    }
    return numericValue;
}

export function convertUnit(value, categoryId, fromUnitId, toUnitId) {
    const numericValue = parseUnitValue(value);

    const category = getUnitCategory(categoryId);
    if (!category) throw new TypeError(`未知的单位类别: ${categoryId}`);

    const fromUnit = getUnit(category, fromUnitId);
    const toUnit = getUnit(category, toUnitId);
    if (!fromUnit || !toUnit) throw new TypeError('所选单位不属于当前类别');

    if (categoryId === 'temperature' && numericValue < fromUnit.minimum) {
        throw new RangeError('温度不能低于绝对零度（0 K）');
    }
    if (fromUnitId === toUnitId) return numericValue;
    let result;
    if (categoryId === 'temperature') {
        // Compare the source scale directly so the exact Fahrenheit boundary is not rejected by rounding.
        const baseValue = numericValue === fromUnit.minimum ? 0 : fromUnit.toBase(numericValue);
        result = baseValue === 0 ? toUnit.minimum : toUnit.fromBase(baseValue);
    } else {
        // Taking the ratio first avoids intermediate overflow for finite results (e.g. 1e308 km → mi).
        result = numericValue * (fromUnit.factor / toUnit.factor);
        if (numericValue !== 0 && result === 0) throw new RangeError('换算结果过小，超出可表示范围');
    }

    if (!Number.isFinite(result)) throw new RangeError('换算结果超出可表示范围');
    return result;
}

export function formatConvertedValue(value, precision = 12) {
    if (!Number.isFinite(value)) return '';
    if (Object.is(value, -0) || value === 0) return '0';
    const digits = Number.isInteger(precision) && precision >= 1 && precision <= 15 ? precision : 12;
    const absolute = Math.abs(value);
    if (absolute >= 1e12 || absolute < 1e-9) {
        // Keep the rounded text: parsing MAX_VALUE's rounded mantissa would become Infinity.
        return value.toExponential(digits - 1).replace(/\.0+(?=e)/, '').replace(/(\.\d*?)0+(?=e)/, '$1');
    }
    return Number(value.toPrecision(digits)).toString();
}

export function convertAcrossCategory(value, categoryId, fromUnitId, precision = 12) {
    const category = getUnitCategory(categoryId);
    if (!category) throw new TypeError(`未知的单位类别: ${categoryId}`);

    // Validate the source once; a single overflowing target must not hide the other useful results.
    convertUnit(value, categoryId, fromUnitId, fromUnitId);
    return category.units.map(unit => {
        try {
            const converted = convertUnit(value, categoryId, fromUnitId, unit.id);
            return { unit, value: converted, formatted: formatConvertedValue(converted, precision) };
        } catch (error) {
            return { unit, value: null, formatted: '超出范围', error: error.message };
        }
    });
}
