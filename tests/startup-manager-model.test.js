import assert from 'node:assert/strict';
import test from 'node:test';
import { filterStartupItems, prepareStartupSnapshot } from '../src/tools/system-assistant/model.js';

const entry = (overrides = {}) => ({
    id: 'cloud', name: 'Cloud Sync', command: '"C:\\Apps\\Cloud.exe" --background',
    targetPath: 'C:\\Apps\\Cloud.exe', sourceKind: 'registry', sourceLabel: '当前用户 · 注册表 Run',
    sourceDetail: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    scope: 'user', enabled: true, canToggle: true, managed: false, fingerprint: 'revision-1',
    canReveal: true, targetExists: true, ...overrides
});

const records = () => prepareStartupSnapshot({ items: [
    entry(),
    entry({ id: 'workspace', name: 'Workspace Helper', sourceKind: 'startupFolder',
        command: 'C:\\Users\\Demo\\Startup\\Workspace.lnk', targetPath: 'C:\\Apps\\Workspace.exe',
        sourcePath: 'C:\\Users\\Demo\\Startup\\Workspace.lnk.dtkit-disabled',
        sourceLabel: '当前用户 · 启动文件夹', sourceDetail: 'C:\\Users\\Demo\\Startup',
        enabled: false, managed: true, canRevealSource: true }),
    entry({ id: 'system', name: 'All-user Utility', command: 'C:\\Apps\\Utility.exe',
        targetPath: 'C:\\Apps\\Utility.exe', scope: 'system', canToggle: false,
        sourceDetail: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        disabledReason: '需要管理员权限，仅可查看' }),
    entry({ id: 'external', name: 'External app', command: 'C:\\Apps\\External.exe --login',
        targetPath: 'C:\\Apps\\External.exe', enabled: false, canToggle: false,
        disabledReason: '已在 Windows 启动应用中停用' })
] }).items;
const ids = (items, filters) => filterStartupItems(items, filters).map(item => item.id).sort();

test('incomplete snapshots cannot create actionable startup rows', () => {
    for (const value of [null, undefined, {}, { items: null }, { items: [null, {}, { id: '' }] }]) {
        const snapshot = prepareStartupSnapshot(value);
        assert.deepEqual(snapshot.items, []);
        assert.equal(snapshot.total, 0);
    }
    const legacy = prepareStartupSnapshot({ items: [entry({ fingerprint: null })] }).items[0];
    assert.equal(legacy.canToggle, false, 'A row without a concurrency token must remain read-only');
    assert.equal(legacy.canReveal, true, 'Read-only entries can still reveal a confirmed file');
});

test('strict native booleans prevent malformed states from enabling controls', () => {
    const item = prepareStartupSnapshot({ items: [entry({ enabled: 'true', canToggle: 1,
        managed: 'true', canReveal: 'true', canRevealSource: 1, requiresElevation: 'false' })] }).items[0];
    assert.equal(item.enabled, false);
    assert.equal(item.canToggle, false);
    assert.equal(item.managed, false);
    assert.equal(item.canReveal, false);
    assert.equal(item.canRevealSource, false);
    assert.equal(item.requiresElevation, false);
});

test('summary derives from unique usable identities instead of trusting stale aggregate fields', () => {
    const items = records();
    const snapshot = prepareStartupSnapshot({ items: [...items, { ...items[0], name: 'Duplicate identity' }],
        total: 500, enabled: 500, managed: 500, readOnly: 500 });
    assert.equal(snapshot.items[0].name, 'Cloud Sync');
    assert.deepEqual([snapshot.total, snapshot.enabled, snapshot.disabled, snapshot.managed,
        snapshot.readOnly, snapshot.userItems, snapshot.systemItems], [4, 2, 2, 1, 2, 3, 1]);
});

test('my disabled entries distinguish recoverable changes from external shutdown and enabled records', () => {
    const items = [...records(), entry({ id: 'restored', managed: true })];
    assert.deepEqual(ids(items, { status: 'managed' }), ['workspace']);
    assert.deepEqual(ids(items, { status: 'disabled' }), ['external', 'workspace']);
    assert.deepEqual(ids(items, { status: 'readOnly' }), ['external', 'system']);
    assert.deepEqual(ids(items, { status: 'enabled' }), ['cloud', 'restored', 'system']);
});

test('source and scope filters combine with state without native rescans', () => {
    const items = records();
    assert.deepEqual(ids(items, { source: 'startupFolder', status: 'managed', scope: 'user' }), ['workspace']);
    assert.deepEqual(ids(items, { source: 'registry', scope: 'system', status: 'enabled' }), ['system']);
    assert.deepEqual(ids(items, { source: 'startupFolder', scope: 'system' }), []);
    assert.equal(filterStartupItems(items).length, 4);
});

test('multiword search is case insensitive and reaches commands, program files and launch source', () => {
    const items = records();
    assert.deepEqual(ids(items, { query: '  CLOUD.exe  BACKGROUND  ' }), ['cloud']);
    assert.deepEqual(ids(items, { query: 'Workspace.exe' }), ['workspace']);
    assert.deepEqual(ids(items, { query: 'workspace.LNK.dtkit-disabled' }), ['workspace']);
    assert.deepEqual(ids(items, { query: 'HKLM\\Software', status: 'enabled' }), ['system']);
    assert.deepEqual(ids(items, { query: '启动文件夹 workspace' }), ['workspace']);
    assert.deepEqual(ids(items, { query: 'Windows 停用' }), ['external']);
    assert.deepEqual(ids(items, { query: 'not-installed-program' }), []);
});

test('snapshot preparation and local filtering preserve the input and keep unsafe text as plain data', () => {
    const source = { items: [entry({ name: '<img src=x onerror=alert(1)>', command: '<script>run()</script>',
        targetPath: null, sourcePath: null })], warnings: ['拒绝访问 <img src=x>', 7, null] };
    const before = structuredClone(source);
    const snapshot = prepareStartupSnapshot(source);
    filterStartupItems(snapshot.items, { query: 'script' });
    assert.deepEqual(source, before);
    assert.equal(snapshot.items[0].name, '<img src=x onerror=alert(1)>');
    assert.equal(snapshot.items[0].command, '<script>run()</script>');
    assert.equal(snapshot.items[0].targetPath, '');
    assert.deepEqual(snapshot.warnings, ['拒绝访问 <img src=x>']);
});

test('empty search and an empty inventory stay usable after malformed optional fields', () => {
    const snapshot = prepareStartupSnapshot({ items: [entry({ name: '', sourceLabel: null,
        sourceDetail: null, disabledReason: null })] });
    assert.equal(snapshot.items[0].name, '未命名启动项');
    assert.equal(snapshot.items[0].sourceLabel, '注册表');
    assert.deepEqual(ids(snapshot.items, { query: null }), ['cloud']);
    assert.deepEqual(filterStartupItems([], { status: 'managed', source: 'registry' }), []);
});
