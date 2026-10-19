import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PAGE_SIZE, REPORT_CACHE_LIMIT, createReportCache, filterSoftware, formatBytes,
    isPathWithin, normalizeWindowsPath, paginateSoftware, prepareReport, prepareSoftware
} from '../src/tools/software-analysis/core.js';
import { relatedStartupItems } from '../src/tools/software-analysis/startup.js';

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
