import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpaceGroups, folderPreviewSlots, migrateSpaceOrderPath, normalizeSpacePreferences, spaceFileId, updateSpaceOrder } from '../src/desktop-organizer/space-model.js';

const file = (name, category = 'document') => ({ path: `C:\\Desktop\\${name}`, name, category, is_folder: false });
const a = file('a.txt');
const b = file('b.txt');
const c = file('c.png', 'image');
const state = () => ({ files: { documents: [a, b], images: [c], recent: [a], applications: [] }, searchIndex: [{ file: a }, { file: b }, { file: c }], customCategories: [], fileCategories: {} });

test('space uses each real path once and retains same-name files from different paths', () => {
    const current = state();
    current.files.documents.push({ ...a, path: 'D:\\a.txt' });
    const groups = createSpaceGroups(current);
    assert.equal(groups.flatMap(group => group.files).length, 4);
    assert.equal(groups.some(group => group.key === 'recent'), false);
});

test('native applications take precedence over matching shortcut paths', () => {
    const current = state();
    current.files.applications.push({ ...a, app_id: 'native-a', app_category: 'recent' });
    const groups = createSpaceGroups(current);
    assert.equal(groups.flatMap(group => group.files).length, 3);
    assert.equal(groups.find(group => group.key === 'program').files[0].app_id, 'native-a');
});

test('reorder inserts before the requested item and survives a fresh scan without mutating files', () => {
    const current = state();
    const groups = createSpaceGroups(current);
    const next = updateSpaceOrder({}, groups, spaceFileId(b), 'document', spaceFileId(a));
    assert.deepEqual(createSpaceGroups(state(), next).find(group => group.key === 'document').files, [b, a]);
    assert.deepEqual(current.files.documents, [a, b]);
});

test('cross-group order works with shared category metadata and keeps custom empty groups', () => {
    const current = state();
    current.customCategories = [{ key: 'custom_1', name: '工作', icon: '💼' }];
    const groups = createSpaceGroups(current);
    const next = updateSpaceOrder({}, groups, spaceFileId(a), 'image', spaceFileId(c));
    current.fileCategories[a.path] = 'image';
    const updated = createSpaceGroups(current, next);
    assert.deepEqual(updated.find(group => group.key === 'image').files, [a, c]);
    assert.equal(updated.find(group => group.key === 'custom_1').files.length, 0);
    assert.deepEqual(updated.find(group => group.key === 'document').files, [b]);
});

test('new scan entries append after ordered entries and missing paths do not hide surviving files', () => {
    const current = state();
    current.files.documents.push(file('new.txt'));
    const prefs = { orders: { document: ['file:gone', spaceFileId(b), spaceFileId(a)] } };
    assert.deepEqual(createSpaceGroups(current, prefs).find(group => group.key === 'document').files.map(item => item.name), ['b.txt', 'a.txt', 'new.txt']);
});

test('persisted editor data is bounded and invalid folder types safely fall back', () => {
    const prefs = normalizeSpacePreferences(JSON.parse('{"groups":{"document":{"name":"  Plans  ","size":"large"},"__proto__":{"name":"bad"}},"orders":{"document":["x","x",7]}}'));
    assert.deepEqual(prefs.groups.document, { name: 'Plans', size: 'quad' });
    assert.equal(Object.hasOwn(prefs.groups, '__proto__'), false);
    assert.deepEqual(prefs.orders.document, ['x']);
});

test('all folder types expose their exact approved visible capacity', () => {
    const files = Array.from({ length: 20 }, (_, index) => file(`${index}.txt`));
    assert.equal(folderPreviewSlots(files, 'small').direct.length, 9);
    assert.deepEqual([folderPreviewSlots(files, 'quad').direct.length, folderPreviewSlots(files, 'quad').mini.length], [3, 4]);
    assert.deepEqual([folderPreviewSlots(files, 'nine').direct.length, folderPreviewSlots(files, 'nine').mini.length], [8, 4]);
});

test('renaming a real desktop file carries its saved order to the new path', () => {
    const renamed = file('renamed.txt');
    const prefs = { orders: { document: [spaceFileId(b), spaceFileId(a)] } };
    const next = migrateSpaceOrderPath(prefs, b.path, renamed.path);
    assert.deepEqual(next.orders.document, [spaceFileId(renamed), spaceFileId(a)]);
    assert.deepEqual(prefs.orders.document, [spaceFileId(b), spaceFileId(a)]);
});

test('a dynamic app category remains visible while it contains assigned desktop files', () => {
    const current = state();
    const key = `app_category_${encodeURIComponent('项目工具')}`;
    current.fileCategories[a.path] = key;
    const groups = createSpaceGroups(current);
    assert.equal(groups.find(group => group.key === key).name, '项目工具');
    assert.deepEqual(groups.find(group => group.key === key).files, [a]);
    assert.deepEqual(groups.find(group => group.key === 'document').files, [b]);
});
