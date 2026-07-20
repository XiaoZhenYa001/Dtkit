import assert from 'node:assert/strict';
import test from 'node:test';

import {
    convertAcrossCategory,
    convertUnit,
    formatConvertedValue,
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
    assert.equal(Object.keys(UNIT_CATEGORIES).length, 6);
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
