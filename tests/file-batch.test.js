import test from 'node:test';
import assert from 'node:assert/strict';
import {
    basename, extension, parseExtensions, normalizeRenameOptions, renderRename,
    mergeSources, sortSources, formatBytes, requestFingerprint,
} from '../src/tools/file-batch/core.js';

test('file paths retain Unicode and split Windows, UNC and POSIX names', () => {
    assert.equal(basename('C:\\文件夹\\报告.v2.TXT'), '报告.v2.TXT');
    assert.equal(basename('\\\\server\\share\\说明.md'), '说明.md');
    assert.equal(extension('/home/user/report.tar.gz'), 'gz');
    assert.equal(extension('.gitignore'), '');
    assert.equal(extension('without-extension'), '');
    assert.equal(extension('trailing.'), '');
});

test('rename expands only template tokens once', () => {
    assert.equal(
        renderRename('C:\\你好{n}{ext}.TXT', 7, '{name}_{n}-{ext}{dotext}-{name}'),
        '你好{n}{ext}_7-TXT.TXT-你好{n}{ext}',
    );
    assert.equal(renderRename('/tmp/.gitignore', 0), '.gitignore_0');
    assert.equal(renderRename('/tmp/a.txt', 1, '{unknown}-{name}{dotext}'), '{unknown}-a.txt');
});

test('literal rename replacement runs before Unicode case conversion and preserves extension', () => {
    assert.equal(renderRename('[旧]Straße[旧].Txt', 12, '{name}_{n}{dotext}', {
        find: '[旧]', replace: '新{n}', caseMode: 'upper', numberPadding: 4,
    }), '新{N}STRASSE新{N}_0012.Txt');
    assert.equal(renderRename('ABC中文.TXT', 1, '{name}{dotext}', { caseMode: 'lower' }), 'abc中文.TXT');
    assert.equal(renderRename('ΟΣ ΣΟΣ.TXT', 1, '{name}{dotext}', { caseMode: 'lower' }), 'ος σος.TXT');
    assert.equal(renderRename('foo.foo.txt', 1, '{name}{dotext}', { find: '.', replace: '$&' }), 'foo$&foo.txt');
    assert.equal(renderRename('foo.txt', 1, '{name}{dotext}', { find: '', replace: 'x' }), 'foo.txt');
});

test('renderRename receives an actual sequence number without applying step again', () => {
    assert.equal(renderRename('a.txt', 15, '{n}{dotext}', { numberStep: 7, numberPadding: 3 }), '015.txt');
    assert.equal(renderRename('a.txt', 12345, '{n}', { numberPadding: 2 }), '12345');
    assert.equal(renderRename('a.txt', 0, '{n}'), '0');
});

test('rename validates options, indexes and unsafe final names', () => {
    for (const options of [
        { numberPadding: 0 }, { numberPadding: 9 }, { numberStep: 0 },
        { numberStep: 10001 }, { numberStep: 1.5 }, { caseMode: 'title' },
    ]) assert.throws(() => normalizeRenameOptions(options));
    for (const pattern of ['', '../{name}', 'CON{dotext}', '{name}.', '{name} ', 'LPT1', 'COM01', 'LPT+1']) {
        assert.throws(() => renderRename('ok.txt', 1, pattern));
    }
    assert.throws(() => renderRename('ok.txt', -1));
    assert.throws(() => renderRename('ok.txt', 0x100000000));
    assert.throws(() => renderRename('ok.txt', 1, '{name}', { find: 'ok', replace: '../bad' }));
    assert.throws(() => renderRename('ok.txt', 1, '😀'.repeat(128)));
});

test('extension filters are normalized, deduplicated and preserve intended order', () => {
    assert.deepEqual(parseExtensions(' .PNG, jpg，TXT;png； .md\njson  '), ['png', 'jpg', 'txt', 'md', 'json']);
    assert.deepEqual(parseExtensions(['.TXT', 'txt', 'PNG']), ['txt', 'png']);
    assert.deepEqual(parseExtensions(''), []);
});

test('adding files preserves order, deduplicates Windows paths and enforces the limit', () => {
    const original = ['C:\\Data\\one.txt'];
    const incoming = ['c:/data/ONE.txt', 'C:\\Data\\two.txt', 'C:\\Data\\three.txt', 'C:\\Data\\three.txt'];
    assert.deepEqual(mergeSources(original, incoming, 2), {
        sources: ['C:\\Data\\one.txt', 'C:\\Data\\two.txt'], added: 1, duplicates: 2, overflow: 1,
    });
    assert.deepEqual(original, ['C:\\Data\\one.txt']);
});

test('extended Windows and UNC paths identify the same source', () => {
    assert.deepEqual(mergeSources(['C:\\Data\\one.txt'], ['\\\\?\\C:\\Data\\one.txt']).sources, ['C:\\Data\\one.txt']);
    const normal = '\\\\server\\share\\note.txt';
    assert.equal(mergeSources([normal], ['\\\\?\\UNC\\SERVER\\share\\NOTE.txt']).duplicates, 1);
});

test('file sorting is natural, stable and leaves manual selections untouched', () => {
    const sources = ['C:\\a10.txt', 'C:\\b.md', 'C:\\a2.txt'];
    assert.deepEqual(sortSources(sources, 'name-asc'), ['C:\\a2.txt', 'C:\\a10.txt', 'C:\\b.md']);
    assert.deepEqual(sortSources(sources, 'name-desc'), ['C:\\b.md', 'C:\\a10.txt', 'C:\\a2.txt']);
    assert.deepEqual(sortSources(sources, 'extension'), ['C:\\b.md', 'C:\\a2.txt', 'C:\\a10.txt']);
    assert.deepEqual(sortSources(sources), sources);
    assert.notEqual(sortSources(sources), sources);
});

test('byte formatting covers large files and invalid inputs', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
});

test('preview fingerprints track order and relevant settings with normalized defaults', () => {
    const base = { sources: ['a.txt', 'b.txt'], operation: 'rename' };
    assert.equal(requestFingerprint(base), requestFingerprint({ ...base, startIndex: 1, renameOptions: {} }));
    assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, sources: ['b.txt', 'a.txt'] }));
    assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, renameOptions: { numberStep: 2 } }));
    const copying = { ...base, operation: 'copy', destination: 'C:\\Output' };
    assert.equal(requestFingerprint(copying), requestFingerprint({ ...copying, renameOptions: { numberPadding: 0 }, permanent: true }));
    assert.equal(requestFingerprint({ ...base, extensions: ['TXT', '.png'] }), requestFingerprint({ ...base, extensions: ['png', 'txt', 'TXT'] }));
});
