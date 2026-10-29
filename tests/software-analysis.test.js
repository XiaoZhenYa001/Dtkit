import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PAGE_SIZE, REPORT_CACHE_LIMIT, createReportCache, directoryBreakdown, filterSoftware, formatBytes,
    isPathWithin, normalizeWindowsPath, paginateSoftware, prepareReport, prepareSoftware, registrationDate
} from '../src/tools/software-analysis/core.js';
import { relatedStartupItems } from '../src/tools/software-analysis/startup.js';
import { csvCell, inventoryCsv, reportJson, reportSummary } from '../src/tools/software-analysis/export.js';

const software = (overrides = {}) => ({
    id: 'editor', name: 'Example Editor', version: '2.0', publisher: 'Example Labs',
    installLocation: 'C:\\Apps\\Editor', estimatedBytes: 4096, installDate: '20261001',
    scope: 'user', source: 'HKCU · 64 位', canAnalyze: true, reason: null, ...overrides
});

test('inventory normalization rejects incomplete identities, deduplicates records and preserves input', () => {
    const source = [null, {}, software(), software({ name: 'Duplicate' }),
        software({ id: 'zero', estimatedBytes: 0 }), software({ id: 'unknown', estimatedBytes: null })];
    const before = structuredClone(source);
    const items = prepareSoftware(source);
    assert.deepEqual(items.map(item => item.id), ['editor', 'zero', 'unknown']);
    assert.equal(items[0].name, 'Example Editor');
    assert.equal(items[1].estimatedBytes, 0);
    assert.equal(items[2].estimatedBytes, null);
    assert.deepEqual(source, before);
    for (const malformed of [null, undefined, {}, 'inventory']) assert.deepEqual(prepareSoftware(malformed), []);
});

test('unknown sizes stay distinct from empty directories and malformed numbers never become measurements', () => {
    assert.equal(formatBytes(0), '0 B');
    for (const size of [null, undefined, NaN, Infinity, -1, '1024']) {
        assert.notEqual(formatBytes(size), '0 B');
        const item = prepareSoftware([software({ estimatedBytes: size })])[0];
        assert.equal(item.estimatedBytes, null);
    }
    assert.match(formatBytes(1024), /1(?:\.0)?\s*(?:KiB|KB)/);
    const invalid = prepareSoftware([software({ canAnalyze: 'true', installLocation: null })])[0];
    assert.equal(invalid.canAnalyze, false);
});

test('multiword search combines publisher, path and version with scope without mutating inventory', () => {
    const items = prepareSoftware([
        software(), software({ id: 'system', name: 'System Helper', scope: 'system',
            publisher: 'Other Labs', version: '3.1', installLocation: 'D:\\Shared\\Helper' })
    ]);
    const before = structuredClone(items);
    assert.deepEqual(filterSoftware(items, { query: '  EXAMPLE  2.0  ' }).map(item => item.id), ['editor']);
    assert.deepEqual(filterSoftware(items, { query: 'shared helper', scope: 'system' }).map(item => item.id), ['system']);
    assert.deepEqual(filterSoftware(items, { query: 'example', scope: 'system' }), []);
    assert.deepEqual(filterSoftware(items, { query: 'not-installed-program' }), []);
    assert.deepEqual(items, before);
});

test('descending size sorts place known zero ahead of unknown and use measured bytes independently', () => {
    const items = prepareSoftware([
        software({ id: 'unknown', name: 'A Unknown', estimatedBytes: null }),
        software({ id: 'zero', name: 'B Empty', estimatedBytes: 0 }),
        software({ id: 'large', name: 'C Large', estimatedBytes: 1048576 }),
        software({ id: 'small', name: 'D Small', estimatedBytes: 4096 })
    ]);
    const originalIds = items.map(item => item.id);
    assert.deepEqual(filterSoftware(items, { sort: 'estimated' }).map(item => item.id), ['large', 'small', 'zero', 'unknown']);
    const reports = new Map([['zero', { totalBytes: 0, complete: true }], ['small', { totalBytes: 8000, complete: true }],
        ['large', { totalBytes: 500, complete: true }], ['unknown', { totalBytes: 999999, complete: false }]]);
    assert.deepEqual(filterSoftware(items, { sort: 'measured' }, reports).map(item => item.id), ['small', 'large', 'zero', 'unknown']);
    assert.deepEqual(items.map(item => item.id), originalIds, 'Sorting cannot reorder the cached inventory');
});

test('incomplete scans retain totals and warnings but cannot masquerade as complete size comparisons', () => {
    const report = prepareReport({ totalBytes: 4096, files: 5, skipped: 1, complete: 'true', cancelled: true,
        largestFiles: Array.from({ length: 1500 }, (_, index) => ({ path: `C:\\Apps\\file-${index}`, bytes: index })),
        warnings: [...Array(45).fill('Access denied'), null, 7] });
    assert.equal(report.totalBytes, 4096);
    assert.equal(report.files, 5);
    assert.equal(report.skipped, 1);
    assert.equal(report.complete, false);
    assert.equal(report.cancelled, true);
    assert.equal(report.largestFiles.length, 20, 'Reports must not retain an unbounded file tree');
    assert.equal(report.warnings.length, 30);
    const bounded = createReportCache(99999);
    for (let index = 0; index < 1500; index++) bounded.set(String(index), report);
    assert.equal(bounded.size, REPORT_CACHE_LIMIT);
});

test('pagination bounds a large inventory and clamps stale pages after filtering', () => {
    assert.equal(PAGE_SIZE, 60);
    const items = Array.from({ length: 1501 }, (_, index) => software({ id: String(index) }));
    const first = paginateSoftware(items, 1);
    const last = paginateSoftware(items, 9999);
    assert.equal(first.items.length, PAGE_SIZE);
    assert.equal(first.items[0].id, '0');
    assert.equal(last.items.length, 1);
    assert.equal(last.items[0].id, '1500');
    assert.equal(last.page, 26);
    assert.equal(paginateSoftware(items, -10).page, 1);
    assert.deepEqual(paginateSoftware([], 900).items, []);
    assert.equal(paginateSoftware(items.slice(0, 1), 26).page, 1);
});

test('report cache evicts the least recently used report and replacing a record does not grow it', () => {
    assert.equal(REPORT_CACHE_LIMIT, 20);
    const cache = createReportCache(2);
    cache.set('first', { totalBytes: 1 });
    cache.set('second', { totalBytes: 2 });
    assert.equal(cache.get('first').totalBytes, 1);
    cache.set('third', { totalBytes: 3 });
    assert.equal(cache.size, 2);
    assert.equal(cache.has('first'), true);
    assert.equal(cache.has('second'), false);
    cache.set('third', { totalBytes: 4 });
    assert.equal(cache.size, 2);
    assert.equal(cache.get('third').totalBytes, 4);
    cache.clear();
    assert.equal(cache.size, 0);
});

test('Windows path association uses directory boundaries, slash normalization and case folding', () => {
    assert.equal(normalizeWindowsPath('C:/Apps/Editor/'), normalizeWindowsPath('c:\\apps\\editor'));
    assert.equal(isPathWithin('c:\\APPS\\EDITOR\\bin\\Editor.exe', 'C:\\Apps\\Editor'), true);
    assert.equal(isPathWithin('C:/Apps/Editor', 'c:\\apps\\editor\\'), true);
    assert.equal(isPathWithin('C:\\Apps\\EditorExtra\\bad.exe', 'C:\\Apps\\Editor'), false);
    assert.equal(isPathWithin('D:\\Apps\\Editor\\Editor.exe', 'C:\\Apps\\Editor'), false);
    assert.equal(isPathWithin('C:\\Other\\program.exe', ''), false);
    assert.equal(isPathWithin(null, 'C:\\Apps'), false);
    assert.equal(isPathWithin('C:\\Apps\\Editor\\..\\Other.exe', 'C:\\Apps\\Editor'), false);
    assert.equal(isPathWithin('relative\\Editor.exe', 'C:\\Apps\\Editor'), false);
    assert.equal(isPathWithin('\\\\?\\C:\\Apps\\Editor\\Editor.exe', 'C:\\Apps\\Editor'), true);
    assert.equal(isPathWithin('\\\\server\\share\\Editor\\Editor.exe', '\\\\SERVER\\SHARE\\Editor'), true);
});

test('untrusted names and locations remain plain data through preparation, search and pagination', () => {
    const name = '<img src=x onerror=window.__softwareXss=1>';
    const installLocation = 'C:\\Apps\\<svg onload=window.__softwareXss=2>';
    const prepared = prepareSoftware([software({ name, installLocation })]);
    const result = paginateSoftware(filterSoftware(prepared, { query: 'onerror svg' }), 1).items[0];
    assert.equal(result.name, name);
    assert.equal(result.installLocation, installLocation);
});

test('startup correlation needs an explicit child program path and bounds the retained preview', () => {
    const matching = Array.from({ length: 25 }, (_, index) => ({
        id: `startup-${index}`, name: `Editor task ${index}`, targetPath: `c:\\apps\\EDITOR\\task-${index}.exe`, enabled: true
    }));
    const related = relatedStartupItems({ items: [...matching,
        { id: 'name-only', name: 'Example Editor', targetPath: null },
        { id: 'prefix-neighbor', name: 'Editor', targetPath: 'C:\\Apps\\EditorExtra\\editor.exe' }
    ] }, 'C:\\Apps\\Editor');
    assert.equal(related.total, 25);
    assert.equal(related.items.length, 20);
    assert.equal(related.items[0].name, 'Editor task 0');
    assert.equal(related.items.some(item => item.name === 'Example Editor'), false);
    assert.deepEqual(relatedStartupItems({ items: matching }, '').items, []);
});

test('publisher, text, scope and scan-state filters combine without losing unknown or zero sizes', () => {
    const items = prepareSoftware([
        software({ id: 'empty', name: 'Editor Empty', estimatedBytes: 0 }),
        software({ id: 'partial', name: 'Editor Partial', estimatedBytes: null }),
        software({ id: 'missing', name: 'Editor Missing', canAnalyze: false, installLocation: '' }),
        software({ id: 'large', name: 'Editor Large', estimatedBytes: 1024 ** 3 }),
        software({ id: 'system', name: 'Editor System', scope: 'system', estimatedBytes: 2 * 1024 ** 3 }),
        software({ id: 'other', name: 'Editor Other', publisher: 'Other Labs' }),
        software({ id: 'viewer', name: 'Viewer', installLocation: 'C:\\Apps\\Viewer' })
    ]);
    const reports = new Map([
        ['empty', prepareReport({ totalBytes: 0, complete: true })],
        ['partial', prepareReport({ totalBytes: 9000, complete: false, cancelled: true })],
        ['system', prepareReport({ totalBytes: 1000, complete: true })],
        ['other', prepareReport({ totalBytes: 1000, complete: true })]
    ]);
    const before = structuredClone(items);
    const matching = status => filterSoftware(items,
        { query: 'editor 2.0', scope: 'user', publisher: 'Example Labs', status }, reports).map(item => item.id);
    assert.deepEqual(matching('measured'), ['empty']);
    assert.deepEqual(matching('partial'), ['partial']);
    assert.deepEqual(matching('unknown-size'), ['partial'], 'A known zero is not an unknown estimate');
    assert.deepEqual(matching('no-location'), ['missing']);
    assert.deepEqual(matching('large'), ['large'], 'The large-size threshold includes exactly one GiB');
    assert.deepEqual(matching('unmeasured'), ['large', 'missing']);
    assert.deepEqual(matching('analyzable'), ['empty', 'large', 'partial']);
    assert.deepEqual(filterSoftware(items, { publisher: 'Uninstalled Publisher' }, reports), []);
    assert.deepEqual(items, before);
});

test('publisher and registration date sorting are deterministic and invalid dates sort last', () => {
    assert.equal(registrationDate('20240229'), '2024-02-29');
    assert.equal(registrationDate('20000229'), '2000-02-29');
    for (const date of ['', null, undefined, 20261001, '2026-10-01', '2026101', '20260229',
        '19000229', '20261301', '20260431', '20260010', '20261000', ' 20261001']) {
        assert.equal(registrationDate(date), '', `Invalid installer date: ${String(date)}`);
    }
    const items = prepareSoftware([
        software({ id: 'old', name: 'Old', publisher: 'Zulu Labs', installDate: '20240101' }),
        software({ id: 'invalid-a', name: 'A Invalid', publisher: 'Beta Labs', installDate: '20261301' }),
        software({ id: 'recent-z', name: 'Z Recent', publisher: 'Alpha Labs', installDate: '20261028' }),
        software({ id: 'invalid-z', name: 'Z Invalid', publisher: 'Beta Labs', installDate: '99999999' }),
        software({ id: 'recent-a', name: 'A Recent', publisher: 'Alpha Labs', installDate: '20261028' })
    ]);
    assert.deepEqual(filterSoftware(items, { sort: 'date' }).map(item => item.id),
        ['recent-a', 'recent-z', 'old', 'invalid-a', 'invalid-z']);
    assert.deepEqual(filterSoftware(items, { sort: 'publisher' }).map(item => item.id),
        ['recent-a', 'recent-z', 'invalid-a', 'invalid-z', 'old']);
});

test('file-type aggregates stay bounded and distinguish unavailable legacy data from a known empty result', () => {
    const legacy = prepareReport({ totalBytes: 25, complete: true });
    assert.equal(legacy.rootFilesBytes, null);
    assert.equal(legacy.fileTypesAvailable, false);
    assert.deepEqual(legacy.fileTypes, []);
    assert.equal(prepareReport(legacy).fileTypesAvailable, false,
        'Preparing a cached legacy report again must not invent file-type availability');
    const empty = prepareReport({ rootFilesBytes: 0, fileTypes: [], fileTypesAvailable: true });
    assert.equal(empty.rootFilesBytes, 0);
    assert.equal(empty.fileTypesAvailable, true);
    const bounded = prepareReport({ fileTypes: Array.from({ length: 1000 }, (_, index) =>
        ({ extension: `.type${index}`, bytes: index, files: index + 1 })) });
    assert.equal(bounded.fileTypesAvailable, true);
    assert.equal(bounded.fileTypes.length, 64);
    assert.deepEqual(bounded.fileTypes[0], { extension: '.type0', bytes: 0, files: 1 });
    const malformed = prepareReport({ rootFilesBytes: -1, fileTypes: [null, { extension: 2 },
        { extension: 'x'.repeat(65), bytes: 8 }, { extension: '.log', bytes: NaN, files: -4 }] });
    assert.equal(malformed.rootFilesBytes, null);
    assert.deepEqual(malformed.fileTypes, [{ extension: '.log', bytes: 0, files: 0 }]);
});

test('directory distribution conserves bytes and separates root files from omitted directories', () => {
    const largestDirectories = Array.from({ length: 8 }, (_, index) =>
        ({ path: `C:\\Apps\\Editor\\dir${index + 1}`, bytes: (8 - index) * 10 }));
    const report = prepareReport({ totalBytes: 400, rootFilesBytes: 40, largestDirectories, complete: true });
    const before = structuredClone(report);
    const rows = directoryBreakdown(report);
    const rootFiles = rows.find(row => row.label === '根目录直属文件');
    const otherDirectories = rows.find(row => row.label === '其他直属目录');
    assert.equal(rows.reduce((sum, row) => sum + row.bytes, 0), 400);
    assert.equal(rootFiles.bytes, 40);
    assert.equal(otherDirectories.bytes, 30, 'The seventh and eighth directories are not root files');
    assert.equal(rows.filter(row => row.path).length, 6);
    assert.equal(rows[0].label, 'dir1');
    assert.equal(rows.every(row => row.bytes > 0), true);
    assert.deepEqual(report, before);

    const legacyRows = directoryBreakdown(prepareReport({ totalBytes: 400, largestDirectories }));
    assert.equal(legacyRows.reduce((sum, row) => sum + row.bytes, 0), 400);
    assert.equal(legacyRows.find(row => row.label === '其他已统计内容').bytes, 70);
    assert.equal(legacyRows.some(row => row.label === '根目录直属文件'), false);
    assert.equal(legacyRows.some(row => row.label === '其他直属目录'), false);
    assert.deepEqual(directoryBreakdown(prepareReport({ totalBytes: 0, rootFilesBytes: 0 })), []);
    const rootOnly = directoryBreakdown(prepareReport({ totalBytes: 35, rootFilesBytes: 35 }));
    assert.deepEqual(rootOnly, [{ label: '根目录直属文件', bytes: 35 }]);
    const inconsistent = directoryBreakdown(prepareReport({ totalBytes: 10, rootFilesBytes: 30,
        largestDirectories: [{ path: 'C:\\Apps\\Editor\\oversize', bytes: 25 }] }));
    assert.equal(inconsistent.reduce((sum, row) => sum + row.bytes, 0), 10,
        'A malformed aggregate cannot make the chart exceed the scanned total');
});

// Parse the exported CSV as a consumer would, including embedded line breaks.
function csvRows(csv) {
    const rows = [], row = [];
    let cell = '', quoted = false;
    const source = csv.replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '"') {
            if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
            else quoted = !quoted;
        } else if (character === ',' && !quoted) {
            row.push(cell); cell = '';
        } else if (character === '\r' && source[index + 1] === '\n' && !quoted) {
            row.push(cell); rows.push([...row]); row.length = 0; cell = ''; index++;
        } else cell += character;
    }
    assert.equal(quoted, false, 'CSV ends outside a quoted field');
    row.push(cell); rows.push(row);
    return rows;
}

test('CSV cells preserve delimiters and quotes while neutralizing spreadsheet formulas with whitespace prefixes', () => {
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(undefined), '""');
    assert.equal(csvCell(0), '"0"');
    assert.equal(csvCell('Editor, "Pro"\r\nSecond line'), '"Editor, ""Pro""\r\nSecond line"');
    for (const value of ['=1+1', '+SUM(A1:A2)', '-2+3', '@SUM(A1:A2)', '  =1+1',
        ' \t+1', '\t=1+1', '\r-1', '\n@SUM(A1:A2)', '\u00a0=1+1', '\tplain text']) {
        assert.equal(csvRows(csvCell(value))[0][0], `'${value}`, `Formula-like cell: ${JSON.stringify(value)}`);
    }
    assert.equal(csvRows(csvCell('Plain, "quoted"\ntext'))[0][0], 'Plain, "quoted"\ntext');
    assert.equal(csvRows(csvCell('  normal text'))[0][0], '  normal text');
});

test('inventory export includes all filtered rows beyond a page and keeps unknown, zero and partial sizes distinct', () => {
    const items = prepareSoftware(Array.from({ length: 75 }, (_, index) => software({
        id: String(index), name: `Editor ${index}`, estimatedBytes: index === 0 ? null : 0
    })));
    items[0].name = 'Editor, "Quoted"\nNext line';
    const reports = new Map([
        ['1', prepareReport({ totalBytes: 0, complete: true })],
        ['2', prepareReport({ totalBytes: 25, complete: false, cancelled: true })],
        ['3', prepareReport({ totalBytes: 10, complete: false })]
    ]);
    const exported = inventoryCsv(items, reports);
    assert.equal(exported.charCodeAt(0), 0xFEFF, 'UTF-8 CSV includes an Excel-friendly BOM');
    const [headers, ...rows] = csvRows(exported);
    assert.equal(rows.length, 75);
    assert.ok(rows.length > PAGE_SIZE);
    const column = label => { const index = headers.indexOf(label); assert.notEqual(index, -1); return index; };
    const estimate = column('登记大小（字节）'), measured = column('已统计逻辑大小（字节）');
    const status = column('扫描状态');
    assert.equal(rows[0][column('软件名称')], items[0].name);
    assert.equal(rows.at(-1)[column('软件名称')], 'Editor 74');
    assert.equal(rows[0][estimate], '');
    assert.equal(rows[0][measured], '');
    assert.equal(rows[0][status], '未扫描');
    assert.equal(rows[1][estimate], '0');
    assert.equal(rows[1][measured], '0');
    assert.equal(rows[1][status], '完整');
    assert.equal(rows[2][measured], '25');
    assert.equal(rows[2][status], '已取消（部分）');
    assert.equal(rows[3][status], '不完整');
    assert.equal(rows.every(row => row.length === headers.length), true);
});

test('JSON and text report exports retain partial state, source warnings and logical-size caveats', () => {
    const item = prepareSoftware([software({ estimatedBytes: null })])[0];
    const report = prepareReport({ root: 'C:\\Apps\\Editor', totalBytes: 25, files: 3,
        skipped: 1, complete: false, cancelled: true, warnings: ['无法读取 locked.dat'],
        largestDirectories: [{ path: 'C:\\Apps\\Editor\\bin', bytes: 25 }] });
    const exportedAt = '2026-10-28T01:02:03.000Z';
    const json = JSON.parse(reportJson(item, report, exportedAt));
    assert.equal(json.format, 'dtkit-software-report');
    assert.equal(json.exportedAt, exportedAt);
    assert.equal(json.measurement, 'logical-file-bytes');
    assert.equal(json.software.estimatedBytes, null);
    assert.equal(json.report.totalBytes, 25);
    assert.equal(json.report.complete, false);
    assert.equal(json.report.cancelled, true);
    assert.equal(json.report.skipped, 1);
    assert.equal(json.report.rootFilesBytes, null);
    assert.equal(json.report.fileTypesAvailable, false, 'Legacy data stays unavailable through JSON export');
    assert.deepEqual(json.report.warnings, ['无法读取 locked.dat']);
    assert.match(json.scopeNote, /逻辑大小不等于实际分配空间/);
    assert.match(json.scopeNote, /未自动归属其他位置/);
    const summary = reportSummary(item, report);
    assert.match(summary, /已取消（部分）/);
    assert.match(summary, /结果不完整，不能作为全目录占用结论/);
    assert.match(summary, /逻辑文件大小不等于磁盘实际分配空间/);
    assert.match(summary, /无法读取 locked\.dat/);
    assert.match(summary, /登记大小：未提供/);
    const complete = prepareReport({ complete: true, totalBytes: 0, rootFilesBytes: 0, fileTypes: [] });
    const completeJson = JSON.parse(reportJson(item, complete, exportedAt));
    assert.equal(completeJson.report.totalBytes, 0);
    assert.equal(completeJson.report.fileTypesAvailable, true);
    assert.doesNotMatch(reportSummary(item, complete), /结果不完整/);
});
