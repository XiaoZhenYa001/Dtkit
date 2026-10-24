import assert from 'node:assert/strict';
import test from 'node:test';
import { filterStartupItems, prepareStartupSnapshot, sortStartupItems,
    groupStartupItems, paginateStartupGroups } from '../src/tools/system-assistant/model.js';

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

test('recovery metadata remains strict and supports conflict and unlocated filters', () => {
    const snapshot = prepareStartupSnapshot({ items: [entry({ backupConflict: true, canForgetBackup: true, backupDisabledAt: 1234 }), entry({ id: 'unknown', targetExists: false, backupConflict: 'true', canForgetBackup: 1, backupDisabledAt: '1234' })], recoveryState: 'legacy', recoveryFingerprint: 'store-token', recoveryMessage: '旧记录需要认领' });
    assert.equal(snapshot.items[0].backupDisabledAt, 1234);
    assert.equal(snapshot.items[1].backupDisabledAt, null);
    assert.equal(snapshot.items[1].canForgetBackup, false);
    assert.deepEqual(ids(snapshot.items, { status: 'conflicts' }), ['cloud']);
    assert.deepEqual(ids(snapshot.items, { status: 'unlocated' }), ['unknown']);
    assert.equal(snapshot.recoveryState, 'legacy');
    assert.equal(snapshot.recoveryFingerprint, 'store-token');
    assert.ok(snapshot.items.every(item => !item.canToggle && !item.canForgetBackup));
});

test('natural sorting is stable, deterministic and never mutates inventory order', () => {
    const input = prepareStartupSnapshot({ items: [entry({ id: 'z', name: 'App 10', enabled: false, backupDisabledAt: 2000 }), entry({ id: 'b', name: 'App 2', backupDisabledAt: 1000 }), entry({ id: 'a', name: 'app 2' })] }).items;
    const before = structuredClone(input);
    assert.deepEqual(sortStartupItems(input).map(item => item.id), ['a', 'b', 'z']);
    assert.deepEqual(sortStartupItems(input, 'state').map(item => item.id), ['a', 'b', 'z']);
    assert.deepEqual(sortStartupItems(input, 'recent').map(item => item.id), ['z', 'b', 'a']);
    assert.deepEqual(input, before);
});

test('software grouping metadata stays plain text and joins the existing multiword search', () => {
    const snapshot = prepareStartupSnapshot({ items: [
        entry({ groupId: 'registered:vendor', groupName: '工作套件 <img src=x>', groupReason: 'registered' }),
        entry({ id: 'malformed', groupId: 12, groupName: { name: 'wrong' }, groupReason: true })
    ] });
    assert.deepEqual([snapshot.items[0].groupId, snapshot.items[0].groupName, snapshot.items[0].groupReason],
        ['registered:vendor', '工作套件 <img src=x>', 'registered']);
    assert.deepEqual([snapshot.items[1].groupId, snapshot.items[1].groupName, snapshot.items[1].groupReason], ['', '', '']);
    assert.deepEqual(ids(snapshot.items, { query: '工作套件 cloud.exe' }), ['cloud']);
    assert.deepEqual(ids(snapshot.items, { query: 'wrong' }), []);
});

test('one confirmed software group combines sources and counts only the supplied filtered items', () => {
    const items = prepareStartupSnapshot({ items: [
        entry({ id: 'run', groupId: 'suite', groupName: 'Office Suite', groupReason: 'registered', name: 'Helper 10' }),
        entry({ id: 'folder', groupId: 'suite', groupName: 'Office Suite', groupReason: 'registered', name: 'Helper 2',
            sourceKind: 'startupFolder', scope: 'system', enabled: false, managed: true }),
        entry({ id: 'extra', groupId: 'suite', groupName: 'Office Suite', groupReason: 'registered', name: 'Helper 3',
            enabled: false, managed: false })
    ] }).items;
    const before = structuredClone(items);
    const [group] = groupStartupItems(items);
    assert.equal(group.id, 'suite');
    assert.equal(group.name, 'Office Suite');
    assert.equal(group.reason, 'registered');
    assert.deepEqual(group.items.map(item => item.id), ['folder', 'extra', 'run']);
    assert.deepEqual([group.enabled, group.disabled], [1, 2]);
    const [disabled] = groupStartupItems(filterStartupItems(items, { status: 'disabled' }));
    assert.deepEqual([disabled.enabled, disabled.disabled], [0, 2]);
    const [user] = groupStartupItems(filterStartupItems(items, { scope: 'user' }));
    assert.deepEqual(user.items.map(item => item.id), ['extra', 'run']);
    assert.deepEqual([user.enabled, user.disabled], [1, 1]);
    assert.deepEqual(items, before);
});

test('matching display names never merge different software identities or unknown items', () => {
    const items = prepareStartupSnapshot({ items: [
        entry({ id: 'first', name: 'Same name', groupName: 'Ignored unknown software name' }),
        entry({ id: 'second', name: 'Same name', groupId: '   ', groupReason: 'registered' }),
        entry({ id: 'third', name: 'Same name', groupId: 'vendor-a', groupName: 'Suite' }),
        entry({ id: 'fourth', name: 'Same name', groupId: 'vendor-b', groupName: 'Suite' }),
        entry({ id: 'fifth', name: 'Collision', groupId: 'startup-item:first', groupName: 'Explicit group' })
    ] }).items;
    const groups = groupStartupItems(items);
    assert.equal(groups.length, 5);
    assert.equal(new Set(groups.map(group => group.id)).size, 5);
    const unknown = groups.filter(group => ['first', 'second'].includes(group.items[0].id));
    assert.ok(unknown.every(group => group.name === 'Same name' && group.reason === 'unconfirmed'));
    assert.equal(groups.find(group => group.id === 'vendor-a').items.length, 1);
    assert.equal(groups.find(group => group.id === 'vendor-b').items.length, 1);
});

test('software group order supports natural names, enabled state, source and latest close time', () => {
    const items = prepareStartupSnapshot({ items: [
        entry({ id: 'a10', name: 'Helper 10', groupId: 'app10', groupName: 'App 10', sourceLabel: 'B source', enabled: false }),
        entry({ id: 'a2-old', name: 'Helper 10', groupId: 'app2', groupName: 'App 2', sourceLabel: 'C source', backupDisabledAt: 1000 }),
        entry({ id: 'a2-new', name: 'Helper 2', groupId: 'app2', groupName: 'App 2', sourceLabel: 'A source', enabled: false, backupDisabledAt: 4000 }),
        entry({ id: 'managed', name: 'Managed app', enabled: false, managed: true, sourceLabel: 'D source', backupDisabledAt: 2000 })
    ] }).items;
    assert.deepEqual(groupStartupItems(items).map(group => group.name), ['App 2', 'App 10', 'Managed app']);
    const state = groupStartupItems(items, 'state');
    assert.deepEqual(state.map(group => group.name), ['App 2', 'Managed app', 'App 10']);
    assert.deepEqual(state[0].items.map(item => item.id), ['a2-old', 'a2-new']);
    assert.deepEqual(groupStartupItems(items, 'source').map(group => group.name), ['App 2', 'App 10', 'Managed app']);
    const recent = groupStartupItems(items, 'recent');
    assert.deepEqual(recent.map(group => group.name), ['App 2', 'Managed app', 'App 10']);
    assert.deepEqual(recent[0].items.map(item => item.id), ['a2-new', 'a2-old']);
    assert.deepEqual(groupStartupItems([]), []);
});

test('ungrouped inventories retain the existing flat sorting semantics', () => {
    const items = prepareStartupSnapshot({ items: [
        entry({ id: 'z', name: 'App 10', enabled: false, sourceLabel: 'C', backupDisabledAt: 3000 }),
        entry({ id: 'b', name: 'App 2', sourceLabel: 'A', backupDisabledAt: 2000 }),
        entry({ id: 'a', name: 'app 2', enabled: false, managed: true, sourceLabel: 'B' })
    ] }).items;
    for (const order of ['name', 'state', 'source', 'recent']) {
        assert.deepEqual(groupStartupItems(items, order).flatMap(group => group.items).map(item => item.id),
            sortStartupItems(items, order).map(item => item.id), order);
    }
});

function pageGroup(id, count, { enabled = count, disabled = 0 } = {}) {
    return { id, name: id, reason: 'sameExecutable', enabled, disabled,
        items: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}` })) };
}

function pageIds(pages) {
    return pages.flatMap(groups => groups.flatMap(group => group.items.map(item => item.id)));
}

test('pagination keeps small groups together and fits exact 80-item boundaries', () => {
    const groups = [pageGroup('A', 40), pageGroup('B', 40), pageGroup('C', 1), pageGroup('D', 80)];
    const before = structuredClone(groups);
    const pages = paginateStartupGroups(groups);
    assert.deepEqual(pages.map(page => page.map(group => [group.id, group.items.length])),
        [[['A', 40], ['B', 40]], [['C', 1]], [['D', 80]]]);
    assert.ok(pages.flat().every(group => !group.continued && group.totalCount === group.items.length));
    assert.deepEqual(pageIds(pages), groups.flatMap(group => group.items.map(item => item.id)));
    assert.deepEqual(groups, before);
    assert.deepEqual(paginateStartupGroups([]), []);
});

test('large groups fill available space and carry total group counts through continuation pages', () => {
    const groups = [pageGroup('Small', 60), pageGroup('Large', 170, { enabled: 100, disabled: 70 }), pageGroup('Last', 10)];
    const before = structuredClone(groups);
    const pages = paginateStartupGroups(groups);
    assert.deepEqual(pages.map(page => page.map(group => [group.id, group.items.length, group.continued])), [
        [['Small', 60, false], ['Large', 20, false]],
        [['Large', 80, true]],
        [['Large', 70, true], ['Last', 10, false]]
    ]);
    assert.ok(pages.every(page => page.reduce((sum, group) => sum + group.items.length, 0) <= 80));
    for (const fragment of pages.flat().filter(group => group.id === 'Large')) {
        assert.deepEqual([fragment.totalCount, fragment.enabled, fragment.disabled], [170, 100, 70]);
    }
    const flattened = pageIds(pages);
    assert.equal(new Set(flattened).size, 240);
    assert.deepEqual(flattened, groups.flatMap(group => group.items.map(item => item.id)));
    assert.deepEqual(groups, before);
});

test('single oversized groups, empty groups and custom page sizes do not create empty or duplicate pages', () => {
    assert.deepEqual(paginateStartupGroups([pageGroup('Empty', 0)]), []);
    assert.deepEqual(paginateStartupGroups([pageGroup('Exact', 80)]).map(page => page[0].items.length), [80]);
    const pages = paginateStartupGroups([pageGroup('Empty', 0), pageGroup('Big', 7), pageGroup('Tail', 1)], 3);
    assert.deepEqual(pages.map(page => page.reduce((sum, group) => sum + group.items.length, 0)), [3, 3, 2]);
    assert.deepEqual(pages.flat().filter(group => group.id === 'Big').map(group => group.continued), [false, true, true]);
    assert.deepEqual(pageIds(pages), ['Big-0', 'Big-1', 'Big-2', 'Big-3', 'Big-4', 'Big-5', 'Big-6', 'Tail-0']);
    for (const size of [0, -1, 1.5, NaN, Infinity, '80']) assert.throws(() => paginateStartupGroups([], size), RangeError);
});
