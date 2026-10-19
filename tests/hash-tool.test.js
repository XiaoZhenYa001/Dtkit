import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
    HASH_ALGORITHMS, hashBytes, md5Bytes, validateHashResults,
    inspectHashVerification, formatHashBytes, textByteLength
} from '../src/tools/hash-tool/core.js';

const algorithmIds = HASH_ALGORITHMS.map(algorithm => algorithm.id);
const encode = text => new TextEncoder().encode(text);
const oracle = (bytes, algorithms = algorithmIds) => Object.fromEntries(algorithms.map(id => [id, createHash(id).update(bytes).digest('hex')]));

test('all four algorithms match Node crypto for empty, whitespace and Unicode text', async () => {
    for (const text of ['', ' ', '\t\r\n', 'a', 'abc', 'message digest', '你好，世界 👋', '\ufeffé e\u0301 𝄞\0']) {
        const bytes = encode(text);
        assert.deepEqual(await hashBytes(bytes, algorithmIds), oracle(bytes), JSON.stringify(text));
        assert.equal(textByteLength(text), Buffer.byteLength(text, 'utf8'));
    }
    assert.equal(md5Bytes(encode('')), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Bytes(encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
    assert.notEqual(md5Bytes(encode('')), md5Bytes(encode(' ')));
});

test('MD5 padding and block boundaries match an independent oracle', () => {
    for (const length of [1, 31, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 4096]) {
        const bytes = Uint8Array.from({ length }, (_, index) => (index * 197 + 53) % 256);
        assert.equal(md5Bytes(bytes), oracle(bytes, ['md5']).md5, `${length} bytes`);
    }
});

test('binary and one-megabyte inputs preserve every byte and do not mutate the source', async () => {
    for (const length of [256, 1024 * 1024]) {
        const storage = Uint8Array.from({ length: length + 9 }, (_, index) => (index * 29 + (index >>> 8)) % 256);
        const bytes = storage.subarray(4, length + 4);
        const before = bytes.slice();
        assert.deepEqual(await hashBytes(bytes, ['sha512', 'md5', 'sha1', 'sha256']), oracle(bytes, ['sha512', 'md5', 'sha1', 'sha256']));
        assert.deepEqual(bytes, before);
    }
});

test('algorithm requests require a nonempty canonical whitelist without duplicates', async () => {
    for (const algorithms of [undefined, null, [], 'md5', ['MD5'], ['sha-1'], ['sha384'], ['md5', 'md5'], ['constructor']]) {
        await assert.rejects(hashBytes(encode('x'), algorithms));
    }
    assert.deepEqual(await hashBytes(encode('x'), ['md5']), oracle(encode('x'), ['md5']));
    assert.throws(() => md5Bytes(new ArrayBuffer(3)), TypeError);
    await assert.rejects(hashBytes([1, 2], ['md5']), TypeError);
    assert.throws(() => textByteLength(123), TypeError);
});

test('result validation rejects incomplete, extra, inherited and non-hex values', () => {
    const results = oracle(encode('hello'));
    assert.deepEqual(validateHashResults(Object.fromEntries(Object.entries(results).map(([id, value]) => [id, value.toUpperCase()])), algorithmIds), results);
    for (const invalid of [null, [], {}, { md5: results.md5 }, { ...results, sha384: 'abc' }, { ...results, sha1: '0'.repeat(39) }, { ...results, md5: 'g'.repeat(32) }, { ...results, md5: ' ' + results.md5 }, { ...results, md5: 123 }, { ...results, md5: '当前环境不支持 MD5' }]) {
        assert.throws(() => validateHashResults(invalid, algorithmIds));
    }
    assert.throws(() => validateHashResults(Object.create({ md5: results.md5 }), ['md5']));
    assert.throws(() => validateHashResults(results, []));
});

test('SHA availability and digest failures reject the entire request', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
        assert.deepEqual(await hashBytes(encode('a'), ['md5']), oracle(encode('a'), ['md5']));
        await assert.rejects(hashBytes(encode('a'), ['md5', 'sha256']), /不支持 SHA/);
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw new Error('digest unavailable'); } } } });
        await assert.rejects(hashBytes(encode('a'), ['md5', 'sha256']), /digest unavailable/);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    }
});

test('verification distinguishes empty, stale, malformed, unselected, matching and mismatching input', () => {
    const results = oracle(encode('hello'));
    assert.equal(inspectHashVerification('', results).tone, 'neutral');
    assert.equal(inspectHashVerification(results.md5, results, false).tone, 'neutral');
    assert.match(inspectHashVerification(results.md5, results, false).message, /重新计算/);
    assert.equal(inspectHashVerification('z'.repeat(32), results).tone, 'error');
    assert.equal(inspectHashVerification('0'.repeat(31), results).tone, 'error');
    assert.equal(inspectHashVerification('0'.repeat(33), results).tone, 'error');
    assert.equal(inspectHashVerification('aa aa', results).tone, 'error');
    assert.equal(inspectHashVerification(results.md5, {}).tone, 'neutral');
    assert.equal(inspectHashVerification(results.sha256, { md5: results.md5 }).tone, 'neutral');
    assert.match(inspectHashVerification(results.sha256, { md5: results.md5 }).message, /未包含 SHA-256/);
    assert.equal(inspectHashVerification('0'.repeat(32), results).tone, 'error');
    assert.equal(inspectHashVerification(results.md5, { md5: 'x'.repeat(32) }).tone, 'neutral');
    for (const id of algorithmIds) {
        const verification = inspectHashVerification(`  ${results[id].toUpperCase()}\n`, results);
        assert.equal(verification.tone, 'success');
        assert.equal(verification.matchedAlgorithm, id);
    }
});

test('UTF-8 byte counts and file size labels handle real text and unknown sizes', () => {
    assert.equal(textByteLength('中🙂e\u0301'), 10);
    assert.equal(textByteLength(''), 0);
    for (const [size, expected] of [[0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1024 ** 2, '1 MB'], [1024 ** 3, '1 GB'], [1024 ** 4, '1 TB']]) {
        assert.equal(formatHashBytes(size), expected);
    }
    for (const size of [undefined, null, '1024', -1, Infinity, NaN]) assert.equal(formatHashBytes(size), '—');
});

test('worker protocol handles UTF-8 text and transferred file bytes and reports invalid requests', async () => {
    const previousSelf = globalThis.self;
    let handler;
    const messages = [];
    globalThis.self = {
        addEventListener(type, callback) { assert.equal(type, 'message'); handler = callback; },
        postMessage(message) { messages.push(message); }
    };
    try {
        await import('../src/tools/hash-tool/worker.js');
        await handler({ data: { id: 1, text: '中文👋', algorithms: algorithmIds } });
        assert.deepEqual(messages.shift(), { id: 1, results: oracle(encode('中文👋')) });
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        await handler({ data: { id: 'file', bytes: bytes.buffer, algorithms: ['md5', 'sha256'] } });
        assert.deepEqual(messages.shift(), { id: 'file', results: oracle(bytes, ['md5', 'sha256']) });
        await handler({ data: { id: 2, text: '', algorithms: ['md5'] } });
        assert.deepEqual(messages.shift(), { id: 2, results: oracle(encode(''), ['md5']) });
        for (const request of [{ id: 3 }, { id: 4, text: 'both', bytes: bytes.buffer, algorithms: ['md5'] }, { id: 5, text: 'x', algorithms: ['invalid'] }]) {
            await handler({ data: request });
            const response = messages.shift();
            assert.equal(response.id, request.id);
            assert.equal(typeof response.error, 'string');
            assert.ok(response.error.length > 0);
            assert.equal(Object.hasOwn(response, 'results'), false);
        }
    } finally {
        if (previousSelf === undefined) delete globalThis.self;
        else globalThis.self = previousSelf;
    }
});
