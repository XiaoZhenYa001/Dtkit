import test from 'node:test';
import assert from 'node:assert/strict';
import {
    basename, extension, parseExtensions, normalizeRenameOptions, renderRename,
    mergeSources, sortSources, formatBytes, requestFingerprint, csvCell, batchCsv,
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

test('name cleanup trims then removes Unicode characters before literal replacement and case conversion', () => {
    assert.equal(renderRename('  😀旧x🧩  .tXt', 7, '{name}_{n}{dotext}', {
        trimWhitespace: true, removeStart: 1, removeEnd: 1, find: '旧x', replace: 'Straße{n}',
        caseMode: 'upper', extensionCase: 'lower', numberPadding: 3,
    }), 'STRASSE{N}_007.txt');
    assert.equal(renderRename('😀旧🧩.Txt', 1, '{name}{dotext}', {
        removeStart: 1, removeEnd: 1, find: '😀旧🧩', replace: 'wrong',
    }), '旧.Txt');
    assert.equal(renderRename('a😀🧩z.TXT', 1, '{name}{dotext}', { removeStart: 1, removeEnd: 1 }), '😀🧩.TXT');
    assert.equal(renderRename('NAME.tXt', 1, '{name}-{ext}{dotext}', { caseMode: 'lower', extensionCase: 'upper' }), 'name-TXT.TXT');
    assert.equal(renderRename('without-extension', 1, '{name}{dotext}', { extensionCase: 'upper' }), 'without-extension');
});

test('name trimming uses Unicode White_Space, including NEXT LINE and excluding BOM', () => {
    assert.equal(renderRename('\u0085\u2003  文档 \u00a0.TXT', 1, '{name}{dotext}', { trimWhitespace: true }), '文档.TXT');
    assert.equal(renderRename(' \uFEFF文档\uFEFF .TXT', 1, 'safe_{name}{dotext}', { trimWhitespace: true }), 'safe_\uFEFF文档\uFEFF.TXT');
});

test('name cleanup validates boundaries and permits removing the entire original stem', () => {
    for (const options of [
        { removeStart: -1 }, { removeStart: 161 }, { removeStart: 1.5 },
        { removeEnd: -1 }, { removeEnd: 161 }, { removeEnd: Infinity },
        { trimWhitespace: 'true' }, { extensionCase: 'title' },
    ]) assert.throws(() => normalizeRenameOptions(options));
    assert.equal(normalizeRenameOptions({ removeStart: 160, removeEnd: 160 }).removeEnd, 160);
    assert.equal(renderRename('😀'.repeat(160) + '.TXT', 1, 'fixed{name}{dotext}', { removeStart: 160 }), 'fixed.TXT');
    assert.equal(renderRename('a.txt', 1, 'fixed{name}{dotext}', { removeStart: 160, removeEnd: 160 }), 'fixed.txt');
    assert.throws(() => renderRename('😀', 1, '{name}', { removeEnd: 1 }));
});

test('folder token supports Windows, UNC, extended and POSIX parent directories without recursive expansion', () => {
    for (const source of [
        'C:\\资料\\photo.jpg', 'C:/资料/photo.jpg', '\\\\server\\share\\资料\\photo.jpg',
        '\\\\?\\C:\\资料\\photo.jpg', '\\\\?\\UNC\\server\\share\\资料\\photo.jpg', '/home/资料/photo.jpg',
    ]) assert.equal(renderRename(source, 1, '{folder}_{name}{dotext}'), '资料_photo.jpg');
    for (const source of [
        'C:\\photo.jpg', 'C:/photo.jpg', '/photo.jpg', 'photo.jpg', '\\\\server\\share\\photo.jpg',
        '\\\\?\\C:\\photo.jpg', '\\\\?\\UNC\\server\\share\\photo.jpg',
    ]) assert.equal(renderRename(source, 1, 'pre{folder}_{name}{dotext}'), 'pre_photo.jpg');
    assert.equal(renderRename('C:\\folder{n}\\name{folder}.TXT', 3, '{folder}_{name}_{n}{dotext}'), 'folder{n}_name{folder}_3.TXT');
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

test('cleanup defaults keep legacy requests equivalent and every new rename rule invalidates checks', () => {
    const base = { sources: ['a.txt'], operation: 'rename' };
    assert.equal(requestFingerprint(base), requestFingerprint({ ...base, renameOptions: {
        trimWhitespace: false, removeStart: 0, removeEnd: 0, extensionCase: 'keep',
    } }));
    for (const renameOptions of [
        { trimWhitespace: true }, { removeStart: 1 }, { removeEnd: 1 }, { extensionCase: 'lower' }, { extensionCase: 'upper' },
    ]) assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, renameOptions }));
    const copying = { ...base, operation: 'copy', destination: 'C:\\Output' };
    assert.equal(requestFingerprint(copying), requestFingerprint({ ...copying, renameOptions: { trimWhitespace: 'invalid', removeEnd: -1 } }));
});

test('CSV cells preserve zero, blank nulls, quote delimiters and neutralize whitespace-prefixed formulas', () => {
    assert.equal(csvCell(0), '"0"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(undefined), '""');
    assert.equal(csvCell('one,"two"\nthree'), '"one,""two""\nthree"');
    for (const value of ['=SUM(1,2)', '  +1', '\u00a0\u0085@command', '\uFEFF -1', '\ttext', '\rtext']) {
        assert.equal(csvCell(value), `"'${value}"`);
    }
    assert.equal(csvCell('ordinary.txt'), '"ordinary.txt"');
});

test('CSV draft exports distinguish unchecked, checked, excluded and conflicting items', () => {
    const csv = batchCsv([
        { source: 'zero.txt', target: 'renamed.txt', size: 0, draft: true },
        { source: 'unknown.txt', target: null, size: null },
        { source: 'skip.txt', excluded: true, draft: true },
        { source: 'conflict.txt', target: 'taken.txt', size: 4, conflict: '文件已存在' },
    ], { operation: '重命名' });
    assert.equal(csv, '\uFEFF' + [
        '"原文件","目标路径","操作","大小（字节）","检查或执行状态","任务提示"',
        '"zero.txt","renamed.txt","重命名","0","待检查",""',
        '"unknown.txt","","重命名","","已检查",""',
        '"skip.txt","","重命名","","排除",""',
        '"conflict.txt","taken.txt","重命名","4","冲突：文件已存在",""',
    ].join('\r\n'));
    assert.equal(batchCsv([]).split('\r\n').length, 1);
});

test('CSV task results export partial completion and failure details instead of checked status', () => {
    const items = [{ source: 'a.txt', size: 0 }, { source: 'b.txt', size: null }, { source: 'c.txt' }];
    for (const taskStatus of ['completed', 'cancelled', 'failed']) {
        const csv = batchCsv(items, { operation: '复制', taskStatus, processed: 1, error: '目标文件已存在' });
        assert.equal((csv.match(/"已完成"/g) || []).length, 1);
        assert.equal((csv.match(/"未处理"/g) || []).length, 2);
        assert.equal((csv.match(/"目标文件已存在"/g) || []).length, 3);
        assert.ok(!csv.includes('已检查'));
    }
    const running = batchCsv(items, { taskStatus: 'running', processed: 1 });
    assert.equal((running.match(/"等待"/g) || []).length, 2);
    const failed = batchCsv(items, { taskStatus: 'failed', processed: 0, error: '  =UNTRUSTED("x")\nnext' });
    assert.equal((failed.match(/"未处理"/g) || []).length, 3);
    assert.ok(!failed.includes('已完成'));
    assert.ok(failed.includes('"\'  =UNTRUSTED(""x"")\nnext"'));
});
