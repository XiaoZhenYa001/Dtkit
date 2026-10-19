import test from 'node:test';
import assert from 'node:assert/strict';
import { Base64CodecError, convertBase64, decodeBase64, encodeBase64, getTextMetrics } from '../src/tools/base64-codec/core.js';

test('RFC 4648 text vectors match the Buffer oracle in both directions', () => {
    for (const text of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'test']) {
        const expected = Buffer.from(text, 'utf8').toString('base64');
        assert.equal(encodeBase64(text), expected);
        assert.equal(decodeBase64(expected), text);
        assert.equal(convertBase64(text), expected);
        assert.equal(convertBase64(expected, { mode: 'decode' }), text);
    }
});

test('UTF-8 preserves Chinese, emoji, control characters, BOM and maximum Unicode scalar', () => {
    for (const text of ['你好，世界 👋', '\0\t\n\r', '\ufeff开头 BOM', '\u{10ffff}', 'é e\u0301 𝄞']) {
        const expected = Buffer.from(text, 'utf8').toString('base64');
        assert.equal(encodeBase64(text), expected);
        assert.equal(decodeBase64(expected), text);
    }
});

test('URL-safe encoding and optional padding match Buffer without mixing alphabets', () => {
    const text = '\u{10ffff}😀?';
    const standard = Buffer.from(text).toString('base64');
    const url = Buffer.from(text).toString('base64url');
    assert.match(standard, /[+/]/);
    assert.equal(encodeBase64(text, { urlSafe: true, omitPadding: true }), url);
    assert.equal(encodeBase64(text, { urlSafe: true }), standard.replaceAll('+', '-').replaceAll('/', '_'));
    assert.equal(encodeBase64('f', { omitPadding: true }), 'Zg');
    assert.equal(decodeBase64(url, { urlSafe: true }), text);
    assert.throws(() => decodeBase64(url), error => error.code === 'invalid-alphabet');
    assert.throws(() => decodeBase64(standard, { urlSafe: true }), error => error.code === 'invalid-alphabet');
});

test('decode accepts ASCII whitespace and entirely omitted padding', () => {
    assert.equal(decodeBase64(' Z m\t9\nv\rY m\fE= '), 'fooba');
    assert.equal(decodeBase64('Zg'), 'f');
    assert.equal(decodeBase64('Zm8'), 'fo');
    assert.equal(decodeBase64('\t\n\r '), '');
});

test('decode rejects malformed alphabet, padding, length and noncanonical tail bits', () => {
    const cases = [
        ['Zg==!', 'invalid-alphabet'], ['Zg==\u00a0', 'invalid-alphabet'], ['Z=g=', 'invalid-alphabet'],
        ['Zg===', 'invalid-alphabet'], ['A', 'invalid-length'], ['=', 'invalid-length'],
        ['Zg=', 'invalid-padding'], ['Zm9v=', 'invalid-padding'], ['Zm8==', 'invalid-padding'],
        ['Zh==', 'invalid-padding-bits'], ['Zh', 'invalid-padding-bits'], ['Zm9=', 'invalid-padding-bits']
    ];
    for (const [encoded, code] of cases) assert.throws(() => decodeBase64(encoded), error => error instanceof Base64CodecError && error.code === code, encoded);
});

test('binary, overlong, truncated and surrogate UTF-8 are rejected instead of replaced', () => {
    for (const bytes of [[0xff], [0xc0, 0xaf], [0xe4, 0xb8], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
        assert.throws(() => decodeBase64(Buffer.from(bytes).toString('base64')), error => error.code === 'invalid-utf8');
    }
});

test('encode rejects unpaired UTF-16 surrogates without silent replacement', () => {
    for (const text of ['\ud800', '\udc00', 'x\ud800x', '\ud800\ud800']) assert.throws(() => encodeBase64(text), error => error.code === 'invalid-unicode');
});

test('chunked encoding handles input across the argument-spread boundary', () => {
    const text = '中文🙂\n'.repeat(7000);
    const expected = Buffer.from(text).toString('base64');
    assert.equal(encodeBase64(text), expected);
    assert.equal(decodeBase64(expected), text);
});

test('metrics count Unicode code points and UTF-8 bytes, and invalid modes fail clearly', () => {
    assert.deepEqual(getTextMetrics('中🙂e\u0301'), { characters: 4, bytes: 10 });
    assert.deepEqual(getTextMetrics(''), { characters: 0, bytes: 0 });
    assert.throws(() => convertBase64('x', { mode: 'guess' }), error => error.code === 'invalid-mode');
});
