import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_STYLE, normalizeStyle, relativeLuminance, contrastRatio,
    payloadMetrics, validateQrPayload, applyQrPrefix, createQrFilename
} from '../src/tools/qr-generator/core.js';
import { QR_DIRECTORY_KEY, readQrDirectoryPreference, writeQrDirectoryPreference } from '../src/tools/qr-generator/preferences.js';

test('save directory is a durable preference including an explicit default choice', () => {
    const records = new Map();
    const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
    assert.equal(readQrDirectoryPreference(storage), null);
    assert.equal(writeQrDirectoryPreference('D:\\导出目录\\QR exports', storage), true);
    assert.equal(readQrDirectoryPreference(storage), 'D:\\导出目录\\QR exports');
    assert.equal(writeQrDirectoryPreference('', storage), true);
    assert.equal(readQrDirectoryPreference(storage), '');
    assert.equal(JSON.parse(records.get(QR_DIRECTORY_KEY)).version, 1);
});

test('unavailable or malformed save preferences do not break QR rendering or claim persistence', () => {
    const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    assert.equal(readQrDirectoryPreference(unavailable), null);
    assert.equal(writeQrDirectoryPreference('D:\\Exports', unavailable), false);
    for (const raw of ['not JSON', 'null', '42', '[]', '{}', '{"version":2,"directory":"D:"}', '{"version":1,"directory":4}']) {
        assert.equal(readQrDirectoryPreference({ getItem: () => raw }), null);
    }
    for (const directory of [null, 42, {}, [], 'a'.repeat(4097), 'D:\\bad\0path']) {
        const storage = { getItem: () => JSON.stringify({ version: 1, directory }), setItem() { throw new Error('must not write'); } };
        assert.equal(readQrDirectoryPreference(storage), null);
        assert.equal(writeQrDirectoryPreference(directory, storage), false);
    }
});

function approximately(actual, expected, tolerance = 1e-12) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('style normalization preserves supported choices and leaves its input and defaults intact', () => {
    assert.equal(Object.isFrozen(DEFAULT_STYLE), true);
    const defaults = { ...DEFAULT_STYLE };
    const source = { size: 400, dots: 'classy', corners: 'dot', foreground: '#A1B2C3', background: '#F0F0F0', extra: true };
    const before = { ...source };
    assert.deepEqual(normalizeStyle(source), { size: 400, dots: 'classy', corners: 'dot', foreground: '#a1b2c3', background: '#f0f0f0' });
    assert.deepEqual(source, before);
    assert.deepEqual(DEFAULT_STYLE, defaults);
    assert.deepEqual(normalizeStyle(), defaults);
    assert.notEqual(normalizeStyle(), DEFAULT_STYLE);
    for (const dots of ['rounded', 'dots', 'square', 'classy']) assert.equal(normalizeStyle({ dots }).dots, dots);
    for (const corners of ['extra-rounded', 'dot', 'square']) assert.equal(normalizeStyle({ corners }).corners, corners);
});

test('size rounding and clamping reject nonnumeric settings and unsafe style values', () => {
    for (const [size, expected] of [[-100, 180], [0, 180], [180, 180], [189, 180], [190, 200], [319, 320], [330, 340], [711, 720], [720, 720], [9999, 720]]) {
        assert.equal(normalizeStyle({ size }).size, expected);
    }
    for (const size of [undefined, null, '400', NaN, Infinity, -Infinity]) assert.equal(normalizeStyle({ size }).size, DEFAULT_STYLE.size);
    for (const color of ['', '#fff', '#12345g', 'red', 'url(example)', '#ffffffff', 123456, null]) {
        assert.equal(normalizeStyle({ foreground: color }).foreground, DEFAULT_STYLE.foreground);
        assert.equal(normalizeStyle({ background: color }).background, DEFAULT_STYLE.background);
    }
    assert.equal(normalizeStyle({ dots: 'unknown', corners: '<script>' }).dots, DEFAULT_STYLE.dots);
    assert.equal(normalizeStyle({ dots: 'unknown', corners: '<script>' }).corners, DEFAULT_STYLE.corners);
});

test('luminance and contrast use known RGB references and are symmetric', () => {
    approximately(relativeLuminance('#000000'), 0);
    approximately(relativeLuminance('#ffffff'), 1);
    approximately(relativeLuminance('#ff0000'), 0.2126);
    approximately(relativeLuminance('#00ff00'), 0.7152);
    approximately(relativeLuminance('#0000ff'), 0.0722);
    approximately(relativeLuminance('#777777'), 0.184474994500441);
    approximately(contrastRatio('#000000', '#ffffff'), 21);
    approximately(contrastRatio('#777777', '#ffffff'), 4.478089453577214);
    for (const [first, second] of [['#111111', '#fafafa'], ['#AABBCC', '#de1234'], ['#ffffff', '#ffffff']]) {
        approximately(contrastRatio(first, second), contrastRatio(second, first));
        assert.ok(contrastRatio(first, second) >= 1);
        approximately(contrastRatio(first, first), 1);
    }
    for (const color of ['#fff', '#12345g', 'white', '', null]) assert.throws(() => relativeLuminance(color));
    assert.throws(() => contrastRatio('#ffffff', '#xyzxyz'));
});

test('payload metrics count Unicode code points and match the independent UTF-8 byte oracle', () => {
    for (const text of ['', 'ASCII', '汉字', '😀', 'e\u0301', '👨‍👩‍👧‍👦', '\ufeffhello\nworld\0', '\ud800']) {
        const metrics = payloadMetrics(text);
        assert.equal(metrics.bytes, Buffer.byteLength(text, 'utf8'));
    }
    assert.deepEqual(payloadMetrics('汉😀a'), { characters: 3, bytes: 8 });
    assert.deepEqual(payloadMetrics('e\u0301'), { characters: 2, bytes: 3 });
    assert.deepEqual(payloadMetrics(''), { characters: 0, bytes: 0 });
});

test('payload validation preserves the exact source and bounds UTF-16 length without promising QR capacity', () => {
    for (const text of ['hello', '  hello\r\n', '中文 😀', 'mailto:person@example.com', 'tel:+8613800000000', 'https://example.com/?q=汉字', '\0', '\ufeffhello']) {
        assert.equal(validateQrPayload(text), text);
    }
    assert.equal(validateQrPayload('a'.repeat(4000)).length, 4000);
    assert.equal(validateQrPayload('😀'.repeat(2000)).length, 4000);
    for (const text of ['', ' \t\r\n', '\ufeff', undefined, null, 123, {}, 'a'.repeat(4001), '😀'.repeat(2001)]) {
        assert.throws(() => validateQrPayload(text));
    }
});

test('unpaired UTF-16 surrogates fail validation while valid supplementary characters survive', () => {
    for (const text of ['\ud800', '\udfff', 'before\ud800after', 'before\udc00after', '😀\ud800', '\ud800\ud800', '\udfff\ud800']) {
        assert.throws(() => validateQrPayload(text), /Unicode/);
    }
    for (const text of ['😀', '𝄞', '\ud800\udc00', '\udbff\udfff', 'A😀𝄞Z']) assert.equal(validateQrPayload(text), text);
});

test('content type switches replace only a leading mail or telephone prefix', () => {
    assert.equal(applyQrPrefix('person@example.com', 'mailto:'), 'mailto:person@example.com');
    assert.equal(applyQrPrefix('MAILTO:person@example.com', 'tel:'), 'tel:person@example.com');
    assert.equal(applyQrPrefix('TeL:+8613800000000', ''), '+8613800000000');
    assert.equal(applyQrPrefix('tel:+1234', 'tel:'), 'tel:+1234');
    assert.equal(applyQrPrefix('https://example.com/tel:123', ''), 'https://example.com/tel:123');
    assert.equal(applyQrPrefix('  mailto:keep-leading-space', ''), '  mailto:keep-leading-space');
    assert.equal(applyQrPrefix('', 'mailto:'), 'mailto:');
    for (const prefix of ['https:', 'MAILTO:', 'javascript:', null]) assert.throws(() => applyQrPrefix('text', prefix));
});

test('export names are unique safe qrcode leaves with only the supported extension', () => {
    const names = new Set();
    for (let index = 0; index < 100; index += 1) {
        const format = index % 2 ? 'svg' : 'png';
        const filename = createQrFilename(format);
        assert.match(filename, new RegExp(`^qrcode-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${format}$`));
        assert.equal(/[\\/]/.test(filename), false);
        assert.equal(names.has(filename), false);
        names.add(filename);
    }
    for (const format of ['', 'jpg', 'webp', 'PNG', '../png', undefined]) assert.throws(() => createQrFilename(format));
});
