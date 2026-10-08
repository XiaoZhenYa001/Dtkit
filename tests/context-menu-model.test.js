import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_CATEGORIES, categoryCounts, categoryLabel, normalizeExtension, prepareSnapshot, filterItems } from '../src/tools/context-menu/model.js';

const item = (overrides = {}) => ({
    id: 'editor', name: 'Editor', kind: 'verb', categories: ['files', 'folders'],
    scope: 'user', registryPath: 'HKCU\\Software\\Classes\\*\\shell\\Editor',
    command: 'C:\\Apps\\Editor.exe "%1"', clsid: null, enabled: true,
    canToggle: true, disabledReason: null, requiresElevation: false,
    managed: false, fingerprint: 'revision-1', detail: '', ...overrides
});

const preparedItems = () => prepareSnapshot({
    items: [
        item(),
        item({ id: 'zip', name: 'Archive', kind: 'extension', scope: 'system',
            categories: ['folders', 'desktop'], clsid: '{AAAA-BBBB}', command: 'C:\\Apps\\Compress.dll',
            registryPath: 'HKLM\\Software\\Classes\\Folder\\shellex\\ContextMenuHandlers\\Archive' }),
        item({ id: 'mine', name: 'PDF converter', enabled: false, managed: true,
            categories: ['fileTypes'] }),
        item({ id: 'external', name: 'Externally blocked', enabled: false, canToggle: false,
            categories: ['drives'], disabledReason: 'Closed by another application' })
    ],
    total: 4, enabled: 2, disabled: 2, readOnly: 1, scannedAt: Date.now(), warnings: [], extension: '.pdf'
}).items;
const matchingIds = (items, filters) => filterItems(items, filters).map(entry => entry.id).sort();

test('extension filters normalize case and optional leading dot without admitting registry paths', () => {
    assert.equal(normalizeExtension(''), null);
    assert.equal(normalizeExtension('  '), null);
    assert.equal(normalizeExtension('PDF'), '.pdf');
    assert.equal(normalizeExtension('  .PdF  '), '.pdf');
    assert.equal(normalizeExtension(null), null);
    assert.equal(normalizeExtension(undefined), null);
    assert.equal(normalizeExtension('a'.repeat(31)), `.${'a'.repeat(31)}`);
    assert.equal(normalizeExtension('.my_type-2'), '.my_type-2');
    for (const invalid of ['.', '*', '.p df', '..\\shell', '.pdf\\shell', 'HKCU\\Software\\Classes', '.pdf:command', '.pdf;.txt', '.pdf/command']) {
        assert.throws(() => normalizeExtension(invalid), undefined, invalid);
    }
    assert.throws(() => normalizeExtension('a'.repeat(32)));
    assert.throws(() => normalizeExtension('.中文'));
});

test('category filters preserve items shared by multiple menu scenes', () => {
    const items = preparedItems();
    assert.deepEqual(matchingIds(items, { category: 'folders' }), ['editor', 'zip']);
    assert.deepEqual(matchingIds(items, { category: 'desktop' }), ['zip']);
    assert.equal(filterItems(items, { category: 'all' }).length, 4);
});

test('managed and read-only filters distinguish our reversible changes from externally disabled items', () => {
    const items = preparedItems();
    assert.deepEqual(matchingIds(items, { status: 'managed' }), ['mine']);
    assert.deepEqual(matchingIds(items, { status: 'readOnly' }), ['external']);
    assert.deepEqual(matchingIds(items, { status: 'disabled' }), ['external', 'mine']);
    assert.deepEqual(matchingIds(items, { status: 'enabled' }), ['editor', 'zip']);
});

test('search covers registration details and combines with scope/type/category constraints', () => {
    const items = preparedItems();
    assert.deepEqual(matchingIds(items, { query: 'compress.DLL' }), ['zip']);
    assert.deepEqual(matchingIds(items, { query: 'aaaa-bbbb' }), ['zip']);
    assert.deepEqual(matchingIds(items, { category: 'folders', scope: 'system', kind: 'extension' }), ['zip']);
    assert.deepEqual(filterItems(items, { query: 'editor', scope: 'system' }), []);
    assert.deepEqual(filterItems(items, { query: 'missing-word' }), []);
    assert.deepEqual(matchingIds(items, { query: '  文件夹  ', status: 'enabled' }), ['editor', 'zip']);
    assert.deepEqual(matchingIds(items, { query: 'HKCU\\Software' }), ['editor', 'external', 'mine']);
});

test('snapshot rejects duplicate identities and incomplete concurrency tokens before rows become actionable', () => {
    for (const invalid of [null, {}, { items: null }, { items: [null] },
        { items: [item({ id: '' })] }, { items: [item({ enabled: 'true' })] },
        { items: [item({ fingerprint: undefined })] }, { items: [item(), item()] }]) {
        assert.throws(() => prepareSnapshot(invalid));
    }
});

test('snapshot derives summary from records and normalizes optional fields without mutating input', () => {
    const source = { items: [item({ name: '', categories: ['files', 'files', 'desktop'], canToggle: 1,
        managed: 'true', requiresElevation: 'true', registryPath: null, command: null, clsid: null })],
        total: 999, enabled: 999, disabled: 999, readOnly: 999, warnings: ['A', 12], extension: 'PDF' };
    const before = structuredClone(source);
    const snapshot = prepareSnapshot(source);
    assert.deepEqual(source, before);
    assert.deepEqual([snapshot.total, snapshot.enabled, snapshot.disabled, snapshot.readOnly], [1, 1, 0, 1]);
    assert.equal(snapshot.extension, '.pdf');
    assert.deepEqual(snapshot.warnings, ['A', '12']);
    assert.equal(snapshot.items[0].canToggle, false);
    assert.equal(snapshot.items[0].managed, false);
    assert.equal(snapshot.items[0].requiresElevation, false);
    assert.equal(snapshot.items[0].name, '未命名菜单项');
    assert.deepEqual(snapshot.items[0].categories, ['files', 'desktop']);
});

test('category counts count each shared record once per scene and every record once in all', () => {
    const counts = categoryCounts(preparedItems());
    assert.deepEqual(Object.keys(counts), CONTEXT_CATEGORIES.map(category => category.id));
    assert.equal(counts.all, 4);
    assert.equal(counts.folders, 2);
    assert.equal(counts.folderBackground, 0);
    assert.equal(counts.fileTypes, 1);
    assert.equal(categoryLabel('folderBackground'), '文件夹空白处');
    assert.equal(categoryLabel('future-category'), 'future-category');
});

test('managed filter never presents enabled or externally disabled entries as our recoverable change', () => {
    const snapshot = prepareSnapshot({ items: [item({ managed: true }), item({ id: 'external', enabled: false }),
        item({ id: 'recoverable', enabled: false, managed: true })] });
    assert.deepEqual(matchingIds(snapshot.items, { status: 'managed' }), ['recoverable']);
    assert.deepEqual(filterItems(prepareSnapshot({ items: [] }).items), []);
});
