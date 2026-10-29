import assert from 'node:assert/strict';
import test from 'node:test';

import {
    convertAcrossCategory,
    convertUnit,
    formatConvertedValue,
    getUnitCategory,
    parseUnitValue,
    UNIT_CATEGORIES
} from '../src/tools/unit-converter/core.js';

test('data conversion distinguishes bytes, bits, decimal KB and binary KiB', () => {
    assert.equal(convertUnit(1, 'data', 'byte', 'bit'), 8);
    assert.equal(convertUnit(1024, 'data', 'byte', 'kib'), 1);
    assert.equal(convertUnit(1000, 'data', 'byte', 'kb'), 1);
    assert.equal(convertUnit(1000, 'data', 'byte', 'kib'), 0.9765625);
});

test('linear and temperature conversions use stable reference factors', () => {
    assert.ok(Math.abs(convertUnit(1, 'length', 'km', 'mi') - 0.621371192237334) < 1e-12);
    assert.equal(convertUnit(100, 'temperature', 'c', 'f'), 212);
    assert.equal(convertUnit(32, 'temperature', 'f', 'c'), 0);
    assert.equal(convertUnit(0, 'temperature', 'c', 'k'), 273.15);
    assert.equal(convertUnit(100, 'speed', 'kph', 'mps'), 100 / 3.6);
});

test('invalid values, mismatched units and impossible temperatures are rejected', () => {
    assert.throws(() => convertUnit('', 'length', 'm', 'km'), /请输入/);
    assert.throws(() => convertUnit(Infinity, 'length', 'm', 'km'), /有限数值/);
    assert.throws(() => convertUnit(1, 'length', 'kg', 'm'), /不属于当前类别/);
    assert.throws(() => convertUnit(-274, 'temperature', 'c', 'k'), /绝对零度/);
});

test('conversion output formatting remains readable across magnitudes', () => {
    assert.equal(formatConvertedValue(-0), '0');
    assert.equal(formatConvertedValue(1 / 3), '0.333333333333');
    assert.match(formatConvertedValue(1e15), /^1e\+15$/);
    assert.match(formatConvertedValue(1e-12), /^1e-12$/);
    assert.equal(Object.keys(UNIT_CATEGORIES).length, 9);
});

test('decimal input grammar accepts scientific notation without interpreting other number syntaxes', () => {
    assert.equal(parseUnitValue('  +1.5e3  '), 1500);
    assert.equal(parseUnitValue('-.5E-2'), -0.005);
    assert.equal(parseUnitValue('0e999'), 0);
    assert.equal(parseUnitValue('001.20'), 1.2);
    for (const value of ['', '  ', '\n\t', null, undefined]) {
        assert.throws(() => parseUnitValue(value), /请输入/);
    }
    for (const value of ['0x10', '0b10', '1,000', '1 000', '2+3', '1e', true, [], {}]) {
        assert.throws(() => parseUnitValue(value), /十进制/);
    }
    for (const value of [Infinity, NaN, '1e999']) assert.throws(() => parseUnitValue(value), /有限数值/);
    assert.throws(() => parseUnitValue('1e-999'), /过小/);
});

test('new quantity definitions distinguish US liquid gallons, standard atmosphere and thermochemical calories', () => {
    assert.equal(convertUnit(1, 'volume', 'usgal', 'l'), 3.785411784);
    assert.equal(convertUnit(1, 'volume', 'm3', 'l'), 1000);
    assert.equal(convertUnit(1, 'volume', 'ml', 'cm3'), 1);
    assert.equal(convertUnit(1, 'pressure', 'atm', 'pa'), 101325);
    assert.equal(convertUnit(1, 'pressure', 'bar', 'kpa'), 100);
    assert.ok(Math.abs(convertUnit(1, 'pressure', 'psi', 'pa') - 6894.757293168) < 1e-8);
    assert.equal(convertUnit(1, 'energy', 'kwh', 'kj'), 3600);
    assert.equal(convertUnit(1, 'energy', 'kcalth', 'j'), 4184);
    assert.equal(convertUnit(1, 'data', 'tib', 'gib'), 1024);
});

test('exact absolute-zero inputs are accepted in all three scales and values below them are rejected', () => {
    const boundaries = [['c', -273.15], ['f', -459.67], ['k', 0]];
    for (const [from, value] of boundaries) {
        assert.equal(convertUnit(value, 'temperature', from, 'k'), 0);
        assert.equal(convertUnit(value, 'temperature', from, from), value);
        assert.throws(() => convertUnit(value - 1e-8, 'temperature', from, from), /绝对零度/);
    }
    assert.equal(convertUnit(0, 'temperature', 'k', 'f'), -459.67);
    assert.equal(convertUnit(0, 'temperature', 'k', 'c'), -273.15);
});

test('finite identities and finite linear results do not overflow through an unnecessary base unit', () => {
    assert.equal(convertUnit(1e308, 'mass', 'kg', 'kg'), 1e308);
    assert.ok(Number.isFinite(convertUnit(1e308, 'length', 'km', 'mi')));
    assert.equal(convertUnit(Number.MIN_VALUE, 'length', 'km', 'km'), Number.MIN_VALUE);
    assert.throws(() => convertUnit(1e308, 'mass', 'kg', 'mg'), /超出/);
    assert.throws(() => convertUnit(Number.MIN_VALUE, 'length', 'mm', 'km'), /过小/);
});

test('an overflowing overview row does not remove finite targets or disguise an invalid source', () => {
    const results = convertAcrossCategory(1e308, 'mass', 'kg');
    assert.equal(results.find(item => item.unit.id === 'kg').value, 1e308);
    assert.equal(results.find(item => item.unit.id === 'mg').value, null);
    assert.equal(results.find(item => item.unit.id === 'mg').formatted, '超出范围');
    assert.throws(() => convertAcrossCategory('  ', 'mass', 'kg'), /请输入/);
});

test('display precision is consistent across magnitudes and stays textually finite at numeric boundaries', () => {
    assert.equal(formatConvertedValue(1 / 3, 6), '0.333333');
    assert.equal(formatConvertedValue(1 / 3, 15), '0.333333333333333');
    assert.equal(formatConvertedValue(1.234567891234e15, 12), '1.23456789123e+15');
    assert.equal(formatConvertedValue(1.234567891234e-15, 12), '1.23456789123e-15');
    for (const precision of [6, 12, 15]) {
        const maximum = formatConvertedValue(Number.MAX_VALUE, precision);
        assert.match(maximum, /^1\.\d+e\+308$/);
        assert.doesNotMatch(maximum, /Infinity|NaN/);
        assert.match(formatConvertedValue(Number.MIN_VALUE, precision), /^4\.\d+e-324$/);
    }
    assert.equal(formatConvertedValue(-0, 6), '0');
    assert.equal(convertAcrossCategory(1, 'length', 'km', 6).find(item => item.unit.id === 'mi').formatted, '0.621371');
});

test('category names only resolve own registered definitions', () => {
    for (const category of ['constructor', '__proto__', 'toString', 'missing']) {
        assert.equal(getUnitCategory(category), null);
        assert.throws(() => convertUnit(1, category, 'm', 'm'), /未知/);
    }
});

test('category overview calculates every target without duplicating conversion rules', () => {
    const overview = convertAcrossCategory(1, 'length', 'm');

    assert.equal(overview.length, UNIT_CATEGORIES.length.units.length);
    assert.deepEqual(overview.find(item => item.unit.id === 'cm'), {
        unit: UNIT_CATEGORIES.length.units.find(unit => unit.id === 'cm'),
        value: 100,
        formatted: '100'
    });
});
