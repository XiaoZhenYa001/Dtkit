import assert from 'node:assert/strict';
import test from 'node:test';

import { URL_ACTIONS, URL_MODES, URL_LIMITS, transformUrl, transformUrlBatch, inspectUrlQuery } from '../src/tools/url-encoder/core.js';

test('component mode safely round-trips Unicode and reserved characters', () => {
    const source = 'name=张三&tags=效率 工具';
    const encoded = transformUrl(source, URL_ACTIONS.ENCODE, URL_MODES.COMPONENT);

    assert.equal(encoded, 'name%3D%E5%BC%A0%E4%B8%89%26tags%3D%E6%95%88%E7%8E%87%20%E5%B7%A5%E5%85%B7');
    assert.equal(transformUrl(encoded, URL_ACTIONS.DECODE, URL_MODES.COMPONENT), source);
});

test('full URL mode preserves URL structure while encoding Unicode', () => {
    const source = 'https://example.com/搜索?q=桌面 工具&lang=zh-CN';
    const encoded = transformUrl(source, URL_ACTIONS.ENCODE, URL_MODES.FULL);

    assert.match(encoded, /^https:\/\/example\.com\//);
    assert.ok(encoded.includes('?q='));
    assert.ok(encoded.includes('&lang=zh-CN'));
    assert.equal(transformUrl(encoded, URL_ACTIONS.DECODE, URL_MODES.FULL), source);
});

test('invalid percent sequences return a useful decoding error', () => {
    assert.throws(
        () => transformUrl('%E4%B8', URL_ACTIONS.DECODE),
        /不完整或无效的百分号编码/
    );
    assert.throws(
        () => transformUrl('\uD800', URL_ACTIONS.ENCODE),
        /无法编码的 Unicode 字符/
    );
});

test('empty content is a valid pure-function input and invalid modes are rejected', () => {
    assert.equal(transformUrl('', URL_ACTIONS.ENCODE), '');
    assert.throws(() => transformUrl('value', 'compress'), /不支持的操作/);
    assert.throws(() => transformUrl('value', URL_ACTIONS.ENCODE, 'query'), /不支持的编码模式/);
});

test('form values distinguish spaces and literal pluses and follow the form encode set', () => {
    const source = 'a+b & 中文 😀 ~!*\'()';
    const encoded = transformUrl(source, 'encode', 'form');
    assert.equal(encoded, 'a%2Bb+%26+%E4%B8%AD%E6%96%87+%F0%9F%98%80+%7E%21*%27%28%29');
    assert.equal(encoded, new URLSearchParams([['x', source]]).toString().slice(2));
    assert.equal(transformUrl(encoded, 'decode', 'form'), source);
    assert.equal(transformUrl('a+b%2Bc', 'decode', 'component'), 'a+b+c');
    assert.equal(transformUrl('a+b%2Bc', 'decode', 'form'), 'a b+c');
    assert.throws(() => transformUrl('%ED%A0%80', 'decode', 'form'), /不完整或无效/);
    assert.throws(() => transformUrl('\uD800', 'encode', 'form'), /无法编码/);
});

test('full URL decoding keeps encoded reserved delimiters while component mode decodes them', () => {
    assert.equal(transformUrl('https://host/a%2Fb?q=x%26y%3Dz%23f%20%E4%B8%AD', 'decode', 'full'), 'https://host/a%2Fb?q=x%26y%3Dz%23f 中');
    assert.equal(transformUrl('%2F%26%3D%23', 'decode', 'component'), '/&=#');
    assert.equal(transformUrl('q=%20', 'encode', 'full'), 'q=%2520');
});

test('line mode preserves blank lines and reports failures without mixing errors into output', () => {
    const result = transformUrlBatch('a+b\r\n\r\n%E4%B8%AD\r', 'decode', 'form', { perLine: true });
    assert.deepEqual(result, { output: 'a b\n\n中\n', errors: [], lines: 4 });
    const failed = transformUrlBatch('ok\n%Q1\n%E4%B8\nlast', 'decode', 'component', { perLine: true });
    assert.equal(failed.output, '');
    assert.deepEqual(failed.errors.map(error => error.line), [2, 3]);
    assert.match(failed.errors[0].message, /无效/);
    assert.equal(transformUrlBatch('a\nb', 'encode').output, 'a%0Ab');
    assert.throws(() => transformUrlBatch('a', 'encode', 'bad'), /不支持的编码模式/);
});

test('query inspection retains repeated keys, empty values, equals signs and fragments', () => {
    const query = inspectUrlQuery('https://example.test/search?tag=%E5%B7%A5%E5%85%B7&tag=two&q=a+b%2Bc&empty=&flag&=v&eq=a=b#part?inside');
    assert.equal(query.valid, true);
    assert.deepEqual(query.rows.map(({ name, value, hasEquals }) => ({ name, value, hasEquals })), [
        { name: 'tag', value: '工具', hasEquals: true },
        { name: 'tag', value: 'two', hasEquals: true },
        { name: 'q', value: 'a b+c', hasEquals: true },
        { name: 'empty', value: '', hasEquals: true },
        { name: 'flag', value: '', hasEquals: false },
        { name: '', value: 'v', hasEquals: true },
        { name: 'eq', value: 'a=b', hasEquals: true }
    ]);
    assert.equal(query.fragment, 'part?inside');
    assert.equal(query.hasFragment, true);
    assert.equal(inspectUrlQuery('?a=1&&b=2&').rows.length, 2);
    assert.equal(inspectUrlQuery('https://example.test/path#?a=1').rows.length, 0);
    assert.equal(inspectUrlQuery('/relative/path').rows.length, 0);
    assert.equal(inspectUrlQuery('/relative/path?x=%23').rows[0].value, '#');
    assert.equal(inspectUrlQuery('bare').rows[0].hasEquals, false);
    assert.equal(inspectUrlQuery('?x=%2526').rows[0].value, '%26');
    assert.equal(inspectUrlQuery('a=b?c=d').rows[0].value, 'b?c=d');
    assert.equal(inspectUrlQuery('page.html?q=a?b').rows[0].value, 'a?b');
});

test('query inspection exposes malformed percent or UTF-8 instead of silently replacing them', () => {
    const query = inspectUrlQuery('?%GG=ok&utf=%FF&empty=%&fine=%E4%B8%AD');
    assert.equal(query.valid, false);
    assert.equal(query.rows[0].name, '%GG');
    assert.equal(query.rows[1].value, '%FF');
    assert.equal(query.rows[2].value, '%');
    assert.deepEqual(query.rows.map(row => row.errors.length), [1, 1, 1, 0]);
    assert.equal(query.rows[3].value, '中');
    assert.throws(() => inspectUrlQuery('a=1\nb=2'), /一次只支持一个/);
    assert.equal(inspectUrlQuery('').rows.length, 0);
});

test('batch processing and query rendering have explicit useful work limits', () => {
    assert.throws(() => transformUrlBatch('a'.repeat(URL_LIMITS.characters + 1), 'encode'), /内容过大/);
    assert.throws(() => inspectUrlQuery('a'.repeat(URL_LIMITS.characters + 1)), /内容过大/);
    assert.throws(() => transformUrlBatch('a\n'.repeat(URL_LIMITS.lines), 'encode', 'component', { perLine: true }), /最多支持 1000 行/);
    assert.throws(() => inspectUrlQuery(Array.from({ length: URL_LIMITS.parameters + 1 }, () => 'x=1').join('&')), /最多支持 500 项/);
    assert.equal(transformUrlBatch('a\n'.repeat(URL_LIMITS.lines - 1), 'encode', 'component', { perLine: true }).lines, URL_LIMITS.lines);
});
