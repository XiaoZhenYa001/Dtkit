import assert from 'node:assert/strict';
import test from 'node:test';

import { URL_ACTIONS, URL_MODES, transformUrl } from '../src/tools/url-encoder/core.js';

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
