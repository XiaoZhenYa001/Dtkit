import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

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

test('XML output escapes text and attributes and decodes them once on return', () => {
    const value = { message: 'A & B < C > D', '@_label': 'say "hi" & <bye>',
        literal: '&amp;', '#text': 'text & more' };
    const result = convertData({ source: JSON.stringify(value), sourceFormat: 'json',
        targetFormat: 'xml', options: { pretty: false, rootName: 'payload' } });
    assert.equal(XMLValidator.validate(result.output), true);
    assert.match(result.output, /A &amp; B &lt; C &gt; D/);
    assert.match(result.output, /label="say &quot;hi&quot; &amp; &lt;bye&gt;"/);
    const returned = parseData(result.output, 'xml').value.payload;
    assert.equal(returned.message, value.message);
    assert.equal(returned['@_label'], value['@_label']);
    assert.equal(returned.literal, '&amp;');
    assert.equal(returned['#text'], value['#text']);
});

test('XML conversion preserves leading-zero identifiers and existing ordinary scalar inference', () => {
    const result = convertData({
        source: '<root code="00123" xml:lang="en"><id>00123</id><negative>-01</negative><number>12</number><ratio>0.5</ratio><enabled>true</enabled><text>A &amp; B &#65; &#x1F600;</text></root>',
        sourceFormat: 'xml', targetFormat: 'json', options: { pretty: false }
    });
    assert.deepEqual(JSON.parse(result.output), { root: {
        id: '00123', negative: '-01', number: 12, ratio: 0.5, enabled: true,
        text: 'A & B A 😀', '@_code': '00123', '@_xml:lang': 'en'
    } });
    assert.equal(XMLValidator.validate(convertData({ source: result.output,
        sourceFormat: 'json', targetFormat: 'xml' }).output), true);
});

test('XML entity handling never expands custom declarations or accepts invalid character references', () => {
    for (const source of ['<root>&unknown;</root>', '<root>&#0;</root>', '<root>&#xD800;</root>',
        '<root>&#x110000;</root>', '<root>\u0000</root>', '<root>\ud800</root>',
        '<!DOCTYPE root [<!ENTITY x "custom">]><root>&x;</root>']) {
        assert.throws(() => parseData(source, 'xml'), DataConversionError);
    }
    assert.throws(() => stringifyData({ invalid: '\u0000' }, 'xml'), /不支持的字符/);
    assert.throws(() => stringifyData('\ud800', 'xml'), /不支持的字符/);
});

test('same-format XML keeps interleaved child order, identifiers and namespaced attributes', () => {
    const source = '<root xml:lang="en"><a>001</a><b>A &amp; B</b><a>003</a></root>';
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false,
        parseTagValue: false, trimValues: true, ignoreDeclaration: true });
    for (const pretty of [true, false]) {
        const result = convertData({ source, sourceFormat: 'xml', targetFormat: 'xml',
            options: { pretty, indent: 4, rootName: 'ignored' } });
        assert.equal(XMLValidator.validate(result.output), true);
        assert.deepEqual(parser.parse(result.output), parser.parse(source));
        assert.doesNotMatch(result.output, /<ignored>/);
        assert.equal(result.preservedXmlLayout, false);
        if (!pretty) assert.doesNotMatch(result.output, /\n/);
    }
});

test('same-format XML preserves mixed text, CDATA and xml:space layouts instead of reflowing them', () => {
    for (const source of [
        '<p>Hello <b>world</b>!</p>',
        '<p>before<!--comment-->after</p>',
        '<root><text><![CDATA[A < B & C]]></text></root>',
        '<root xml:space="preserve"> <a>value</a>  <b>next</b> </root>'
    ]) {
        for (const pretty of [true, false]) {
            const result = convertData({ source, sourceFormat: 'xml', targetFormat: 'xml',
                options: { pretty, rootName: 'ignored' } });
            assert.equal(result.output, source);
            assert.equal(result.preservedXmlLayout, true);
        }
    }
});

test('same-format XML normalizes only element indentation and keeps comments', () => {
    const source = '<?xml version="1.0" encoding="UTF-16"?>\n<root>\n <a>001</a>\n <!-- note -->\n <b>2</b>\n</root>';
    const result = convertData({ source, sourceFormat: 'xml', targetFormat: 'xml',
        options: { pretty: true, indent: 4 } });
    assert.match(result.output, /encoding="UTF-8"/);
    assert.match(result.output, /\n {4}<a>001<\/a>/);
    assert.match(result.output, /<!-- note -->/);
    assert.ok(result.output.indexOf('<a>') < result.output.indexOf('<b>'));
});
