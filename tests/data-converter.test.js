import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DATA_FORMATS,
    DataConversionError,
    convertData,
    detectDataFormat,
    parseData,
    stringifyData
} from '../src/tools/json-formatter/core.js';

test('detects JSON, YAML and XML without executing input', () => {
    assert.equal(detectDataFormat('\ufeff  {"ready":true}'), DATA_FORMATS.JSON);
    assert.equal(detectDataFormat('  <root><ready>true</ready></root>'), DATA_FORMATS.XML);
    assert.equal(detectDataFormat('ready: true\nitems:\n  - one'), DATA_FORMATS.YAML);
});

test('converts JSON to YAML and preserves scalar types', () => {
    const result = convertData({
        source: '{"name":"DtKit","enabled":true,"count":2,"empty":null}',
        sourceFormat: 'json',
        targetFormat: 'yaml',
        options: { pretty: true, indent: 2 }
    });
    assert.equal(result.detectedFormat, 'json');
    assert.match(result.output, /name: DtKit/);
    assert.match(result.output, /enabled: true/);
    assert.match(result.output, /count: 2/);
    assert.match(result.output, /empty: null/);
});

test('converts YAML arrays to XML with a configurable root', () => {
    const result = convertData({
        source: 'users:\n  - name: Alice\n  - name: Bob\n',
        sourceFormat: 'yaml',
        targetFormat: 'xml',
        options: { pretty: true, indent: 4, rootName: 'payload' }
    });
    assert.match(result.output, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(result.output, /<payload>/);
    assert.match(result.output, /<users>\s+<name>Alice<\/name>\s+<\/users>/);
    assert.match(result.output, /<users>\s+<name>Bob<\/name>\s+<\/users>/);
});

test('preserves XML attributes and repeated elements when converting to JSON', () => {
    const result = convertData({
        source: '<project name="DtKit"><feature>portable</feature><feature>local</feature></project>',
        sourceFormat: 'xml',
        targetFormat: 'json',
        options: { pretty: true, indent: 2 }
    });
    assert.deepEqual(JSON.parse(result.output), {
        project: { feature: ['portable', 'local'], '@_name': 'DtKit' }
    });
});

test('compact conversion emits single-line JSON and XML', () => {
    assert.equal(stringifyData({ a: 1, b: [2, 3] }, 'json', { pretty: false }), '{"a":1,"b":[2,3]}');
    const xml = stringifyData({ a: 1 }, 'xml', { pretty: false, rootName: 'root' });
    assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?><root><a>1</a></root>');
});

test('XML to XML formatting preserves the existing document root', () => {
    const result = convertData({
        source: '<project><name>DtKit</name></project>',
        sourceFormat: 'xml',
        targetFormat: 'xml',
        options: { pretty: true, indent: 2, rootName: 'root' }
    });
    assert.match(result.output, /<project>/);
    assert.doesNotMatch(result.output, /<root>/);
});

test('reports useful source positions for malformed input', () => {
    assert.throws(
        () => parseData('{\n  "name": "DtKit",\n  broken\n}', 'json'),
        error => error instanceof DataConversionError && error.format === 'json' && error.line === 3
    );
    assert.throws(
        () => parseData('name: DtKit\nitems: [one, two\n', 'yaml'),
        error => error instanceof DataConversionError && error.format === 'yaml' && error.line >= 2
    );
    assert.throws(
        () => parseData('<root>\n  <item>one</root>', 'xml'),
        error => error instanceof DataConversionError && error.format === 'xml' && error.line === 2
    );
});

test('rejects dangerous XML declarations and invalid root names', () => {
    assert.throws(
        () => parseData('<!DOCTYPE root [<!ENTITY x "boom">]><root>&x;</root>', 'xml'),
        /不支持 DOCTYPE/
    );
    assert.throws(
        () => stringifyData({ item: 1, other: 2 }, 'xml', { rootName: '1 invalid' }),
        /根节点名称无效/
    );
    assert.throws(
        () => stringifyData({ 'invalid field': 1 }, 'xml', { rootName: 'root' }),
        /不是合法的 XML 节点/
    );
});
