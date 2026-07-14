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
            linearUnit('gib', '吉二进制字节', 'GiB', 1_073_741_824)
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
            Object.freeze({ id: 'c', label: '摄氏度', symbol: '°C', toBase: value => value + 273.15, fromBase: value => value - 273.15 }),
            Object.freeze({ id: 'f', label: '华氏度', symbol: '°F', toBase: value => (value - 32) * 5 / 9 + 273.15, fromBase: value => (value - 273.15) * 9 / 5 + 32 }),
            Object.freeze({ id: 'k', label: '开尔文', symbol: 'K', toBase: value => value, fromBase: value => value })
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
    })
});

export function getUnitCategory(categoryId) {
    return UNIT_CATEGORIES[categoryId] || null;
}

function getUnit(category, unitId) {
    return category.units.find(unit => unit.id === unitId) || null;
}

export function convertUnit(value, categoryId, fromUnitId, toUnitId) {
    if (value === '' || value === null || value === undefined) {
        throw new TypeError('请输入需要换算的数值');
    }

    const numericValue = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numericValue)) {
        throw new TypeError('请输入有效的有限数值');
    }

    const category = getUnitCategory(categoryId);
    if (!category) throw new TypeError(`未知的单位类别: ${categoryId}`);

    const fromUnit = getUnit(category, fromUnitId);
    const toUnit = getUnit(category, toUnitId);
    if (!fromUnit || !toUnit) throw new TypeError('所选单位不属于当前类别');

    const baseValue = typeof fromUnit.toBase === 'function'
        ? fromUnit.toBase(numericValue)
        : numericValue * fromUnit.factor;

    if (categoryId === 'temperature' && baseValue < 0) {
        throw new RangeError('温度不能低于绝对零度（0 K）');
    }

    const result = typeof toUnit.fromBase === 'function'
        ? toUnit.fromBase(baseValue)
        : baseValue / toUnit.factor;

    if (!Number.isFinite(result)) throw new RangeError('换算结果超出可表示范围');
    return result;
}

export function formatConvertedValue(value) {
    if (!Number.isFinite(value)) return '';
    if (Object.is(value, -0) || value === 0) return '0';

    const absolute = Math.abs(value);
    if (absolute >= 1e12 || absolute < 1e-9) {
        return value.toExponential(8).replace(/\.0+(?=e)/, '').replace(/(\.\d*?)0+(?=e)/, '$1');
    }

    return Number.parseFloat(value.toPrecision(12)).toString();
}
