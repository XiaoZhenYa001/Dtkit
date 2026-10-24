import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseColor, formatColor, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb,
    compositeColors, contrastRatio, shadeColors, sanitizeColorList, extractPalette, paletteText,
} from '../src/tools/color-picker/core.js';

const close = (value, expected, tolerance = 1e-9) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);
const color = (r, g, b, a = 1) => ({ r, g, b, a });
const pixels = (...groups) => new Uint8ClampedArray(groups.flatMap(([value, count]) => Array.from({ length: count }, () => [value.r, value.g, value.b, Math.round(value.a * 255)]).flat()));

test('HEX accepts short and long alpha forms, case and optional hash', () => {
    assert.deepEqual(parseColor(' #aBc '), color(170, 187, 204));
    assert.deepEqual(parseColor('f08c'), color(255, 0, 136, 204 / 255));
    assert.deepEqual(parseColor('#3B82F6'), color(59, 130, 246));
    assert.deepEqual(parseColor('3b82f680'), color(59, 130, 246, 128 / 255));
    assert.deepEqual(parseColor('transparent'), color(0, 0, 0, 0));
});

test('RGB parses legacy and modern syntax with percentages and scientific numbers', () => {
    assert.deepEqual(parseColor('rgb(59, 130, 246)'), color(59, 130, 246));
    assert.deepEqual(parseColor('RGB(100% 50% 0% / 25%)'), color(255, 128, 0, 0.25));
    assert.deepEqual(parseColor('rgba(2.55e2, .5e2, 10, .125)'), color(255, 50, 10, 0.125));
    assert.deepEqual(parseColor('rgba(255 128 0)'), color(255, 128, 0));
    assert.deepEqual(parseColor('rgb(10,20,30,50%)'), color(10, 20, 30, 0.5));
});

test('finite out-of-range CSS channels clamp and hue wraps', () => {
    assert.deepEqual(parseColor('rgb(300 -10 1.4 / 250%)'), color(255, 0, 1));
    assert.deepEqual(parseColor('rgba(-2, 10, 20, -1)'), color(0, 10, 20, 0));
    assert.deepEqual(parseColor('hsl(-120 120% 50%)'), color(0, 0, 255));
    assert.deepEqual(parseColor('hsl(480deg, 100%, 50%)'), color(0, 255, 0));
    assert.deepEqual(parseColor('hsl(0 100% 150%)'), color(255, 255, 255));
});

test('HSL supports angle units and alpha in both function syntaxes', () => {
    assert.deepEqual(parseColor('hsla(.5turn 100% 50% / .2)'), color(0, 255, 255, 0.2));
    assert.deepEqual(parseColor(`hsl(${Math.PI}rad, 100%, 50%, 75%)`), color(0, 255, 255, 0.75));
    assert.deepEqual(parseColor('hsl(100grad 100% 50%)'), color(128, 255, 0));
    assert.deepEqual(parseColor('hsl(0, 0%, 50%)'), color(128, 128, 128));
});

test('invalid input never partially parses, executes CSS, or leaks non-finite channels', () => {
    for (const text of [null, {}, 123, '', '#12', '#12345', '#123456789', 'red', 'rgb(1,2,3) garbage', 'xrgb(1,2,3)',
        'rgb(1,2,3);color:red', 'rgba(1,2,3 / .5)', 'rgb(1 2 3 .5)', 'rgb(1,,3)', 'rgb(1,2,3,)', 'rgb(1 2 3 /)',
        'rgb(NaN 2 3)', 'rgb(Infinity 2 3)', 'rgb(1e999 2 3)', 'hsl(0 50 50)', 'hsl(0deg 10% 20% / NaN)',
        'hsl(0 10% 20% / .2 / .3)', 'rgb(calc(1) 2 3)', 'var(--color)', '#'.repeat(300)]) {
        assert.equal(parseColor(text), null, String(text));
    }
});

test('formatting preserves transparency in every user-facing format', () => {
    const value = color(59, 130, 246, 0.5);
    assert.equal(formatColor(value), '#3B82F680');
    assert.equal(formatColor({ ...value, a: 1 }), '#3B82F6');
    assert.equal(formatColor({ ...value, a: 1 }, 'hex8'), '#3B82F6FF');
    assert.equal(formatColor(value, 'rgb'), 'rgba(59, 130, 246, 0.5)');
    assert.equal(formatColor({ ...value, a: 1 }, 'rgba'), 'rgba(59, 130, 246, 1)');
    assert.equal(formatColor(value, 'hsl').startsWith('hsla('), true);
    assert.throws(() => formatColor(value, 'unknown'), /格式/);
    assert.throws(() => formatColor({ r: NaN, g: 0, b: 0 }), /无效/);
});

test('RGB to HSV and HSL round trips preserve byte channels across grays and all hue sectors', () => {
    for (const r of [0, 1, 59, 127, 128, 254, 255]) for (const g of [0, 1, 59, 127, 128, 254, 255]) for (const b of [0, 1, 59, 127, 128, 254, 255]) {
        const value = color(r, g, b, 0.32);
        const hsv = rgbToHsv(value); const hsl = rgbToHsl(value);
        assert.ok(hsv.h >= 0 && hsv.h < 360 && hsv.s >= 0 && hsv.s <= 100 && hsv.v >= 0 && hsv.v <= 100);
        assert.deepEqual(hsvToRgb({ ...hsv, a: value.a }), value);
        assert.deepEqual(hslToRgb({ ...hsl, a: value.a }), value);
        assert.deepEqual(parseColor(formatColor(value, 'hsl')), value);
    }
    assert.deepEqual(rgbToHsv(255, 0, 0), { h: 0, s: 100, v: 100 });
    assert.deepEqual(rgbToHsl(128, 128, 128), { h: 0, s: 0, l: 128 / 255 * 100 });
});

test('conversions wrap continuous hue and reject non-finite slider channels', () => {
    assert.deepEqual(hsvToRgb(360, 100, 100), hsvToRgb(0, 100, 100));
    assert.deepEqual(hsvToRgb(-60, 100, 100), color(255, 0, 255));
    assert.deepEqual(hslToRgb(0, 200, -5, 2), color(0, 0, 0));
    for (const values of [[Infinity, 0, 0], [0, NaN, 0], [0, 0, -Infinity]]) {
        assert.throws(() => hsvToRgb(...values), /无效/);
        assert.throws(() => hslToRgb(...values), /无效/);
    }
});

test('all byte alpha values survive HEX and six-digit alpha formatting round trips', () => {
    for (let alpha = 0; alpha <= 255; alpha++) {
        const value = color(34, 136, 204, alpha / 255);
        assert.deepEqual(parseColor(formatColor(value, 'hex8')), value);
        assert.equal(Math.round(parseColor(formatColor(value, 'rgba')).a * 255), alpha);
    }
});

test('source-over compositing retains fractional channels until contrast calculation', () => {
    assert.deepEqual(compositeColors(color(0, 0, 0, 0.5), color(255, 255, 255)), color(127.5, 127.5, 127.5));
    assert.deepEqual(compositeColors(color(255, 0, 0, 0), color(0, 0, 255, 0)), color(0, 0, 0, 0));
    const combined = compositeColors(color(255, 0, 0, 0.5), color(0, 0, 255, 0.5));
    close(combined.r, 170); close(combined.b, 85); close(combined.a, 0.75);
});

test('WCAG contrast uses unrounded ratios and composites alpha over the declared background', () => {
    close(contrastRatio('#000', '#FFF'), 21);
    close(contrastRatio('#FFF', '#000'), 21);
    close(contrastRatio('#777', '#FFF'), 4.478089453577214);
    assert.ok(contrastRatio('#777', '#FFF') < 4.5);
    assert.ok(contrastRatio('#757575', '#FFF') > 4.5);
    close(contrastRatio('#FFF', '#FFF'), 1);
    close(contrastRatio('rgba(0,0,0,.5)', '#FFF'), 3.976653024912438, 1e-9);
    close(contrastRatio('#FFF', 'rgba(0,0,0,.5)'), 3.976653024912438, 1e-9);
    close(contrastRatio('transparent', '#123456'), 1);
    close(contrastRatio('#000', 'transparent'), 21);
});

test('shade ramps preserve hue and alpha without inventing saturation in gray colors', () => {
    const shades = shadeColors('#3B82F680');
    assert.equal(shades.length, 9);
    assert.ok(rgbToHsl(shades[0]).l > 94.5);
    assert.ok(rgbToHsl(shades.at(-1)).l < 5.5);
    for (const value of shades) close(value.a, 128 / 255);
    assert.ok(shadeColors('#808080').every(value => value.r === value.g && value.g === value.b));
    assert.deepEqual(shadeColors('#3B82F6', 1), [parseColor('#3B82F6')]);
});

test('storage color lists validate, canonicalize, deduplicate and bound untrusted input', () => {
    const input = ['#abc', '#AABBCC', 'rgb(170,187,204)', 'rgba(170,187,204,.5)', 'invalid-color', null,
        { r: '255', g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, { r: Infinity, g: 0, b: 0 }, '#fff'];
    assert.deepEqual(sanitizeColorList(input), ['#AABBCC', '#AABBCC80', '#FF0000', '#FFFFFF']);
    assert.deepEqual(sanitizeColorList(input, 2), ['#AABBCC', '#AABBCC80']);
    assert.deepEqual(sanitizeColorList(input, 0), []);
    assert.deepEqual(sanitizeColorList({ colors: ['#fff'] }), []);
    assert.equal(input[0], '#abc');
});

test('image palettes retain the real dominant saturated color and its weight', () => {
    const data = pixels([color(255, 0, 0), 8], [color(0, 0, 255), 2]);
    const palette = extractPalette(data, 5, 2, 6);
    assert.deepEqual(palette.map(item => item.color), [color(255, 0, 0), color(0, 0, 255)]);
    close(palette[0].weight, 0.8); close(palette[1].weight, 0.2);
    assert.deepEqual(extractPalette(data, 5, 2, 6), palette);
    assert.deepEqual(extractPalette(data, 5, 2, 1)[0].color, color(204, 0, 51));
});

test('transparent pixels do not bias palettes and partial alpha is weighted without whitening', () => {
    const data = pixels([color(0, 255, 0, 0), 40], [color(255, 0, 0, 128 / 255), 2], [color(0, 0, 255), 2]);
    const palette = extractPalette(data, 11, 4, 6);
    assert.deepEqual(palette.map(item => item.color), [color(0, 0, 255), color(255, 0, 0)]);
    close(palette[0].weight, 255 / 383);
    close(palette.reduce((sum, item) => sum + item.weight, 0), 1);
    assert.deepEqual(extractPalette(pixels([color(255, 0, 0, 0), 4]), 2, 2), []);
});

test('uniform and grayscale images do not produce duplicate or chromatic palette entries', () => {
    assert.deepEqual(extractPalette(pixels([color(59, 130, 246), 4]), 2, 2), [{ color: color(59, 130, 246), weight: 1 }]);
    const gray = pixels([color(0, 0, 0), 4], [color(128, 128, 128), 4], [color(255, 255, 255), 4]);
    const palette = extractPalette(gray, 4, 3, 6);
    assert.equal(palette.length, 3);
    assert.ok(palette.every(item => item.color.r === item.color.g && item.color.g === item.color.b));
    assert.equal(new Set(palette.map(item => formatColor(item.color))).size, palette.length);
});

test('image validation rejects inconsistent dimensions and handles a bounded large stripe sample', () => {
    for (const [data, width, height] of [[null, 1, 1], [new Uint8Array(3), 1, 1], [[], -1, 1], [[], 1.5, 2], [[], Infinity, 2], [[], Number.MAX_SAFE_INTEGER, 2]]) assert.deepEqual(extractPalette(data, width, height), []);
    const data = new Uint8ClampedArray(1024 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 1024; x++) {
        const offset = (y * 1024 + x) * 4;
        data[offset + (x < 768 ? 0 : 2)] = 255; data[offset + 3] = 255;
    }
    const palette = extractPalette(data, 1024, 256, 6);
    assert.deepEqual(palette.map(item => item.color), [color(255, 0, 0), color(0, 0, 255)]);
    close(palette[0].weight, 0.75, 0.005);
});

test('palette export supports copyable CSS, JSON and plain text with normalized alpha', () => {
    const colors = ['#F00', { color: color(0, 0, 255, 0.5), weight: 0.3 }, color(255, 0, 0)];
    assert.equal(paletteText(colors), ':root {\n  --color-1: #FF0000;\n  --color-2: #0000FF80;\n}');
    assert.deepEqual(JSON.parse(paletteText(colors, 'json')), ['#FF0000', '#0000FF80']);
    assert.equal(paletteText(colors, 'text'), '#FF0000\n#0000FF80');
    assert.throws(() => paletteText(colors, 'script'), /格式/);
});
