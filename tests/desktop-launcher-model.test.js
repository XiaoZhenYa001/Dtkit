import assert from 'node:assert/strict';
import test from 'node:test';
import {
    LAUNCHER_STORAGE_KEY, collectLauncherFiles, launcherFileId, launcherFolderScope,
    migrateLauncherPath, migrateLauncherPreferences, readLauncherPreferences, normalizeLauncherPreferences,
    orderedLauncherFiles, reorderLauncherFiles, setLauncherPinned
} from '../src/desktop-organizer/launcher-model.js';

const file = (name, overrides = {}) => ({ path: `C:\\Desktop\\${name}`, name, is_folder: false, size: 12, category: 'document', ...overrides });
const a = file('a.txt'), b = file('b.txt'), c = file('c.txt'), hidden = file('hidden.txt');
const ids = files => files.map(launcherFileId);
const memoryStorage = (initial = {}, failKey = null) => {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: key => values.get(key) ?? null,
        setItem(key, value) { if (key === failKey) throw new Error('quota exceeded'); values.set(key, value); },
        removeItem: key => values.delete(key)
    };
};

test('Windows identities deduplicate slash and case variants, with applications taking precedence', () => {
    const shortcut = file('Tool.lnk');
    const app = { ...shortcut, path: 'c:/desktop/TOOL.lnk', app_id: 'managed-app' };
    assert.equal(launcherFileId(shortcut), launcherFileId({ ...shortcut, path: 'c:/DESKTOP/tool.LNK' }));
    assert.equal(launcherFolderScope('C:/Desktop/Project/'), 'folder:c:\\desktop\\project');
    assert.deepEqual(collectLauncherFiles({ documents: [shortcut], applications: [app], recent: [shortcut] }), [app]);
    assert.equal(launcherFolderScope('\\\\Server\\Share\\Folder'), 'folder:\\\\server\\share\\folder');
    assert.equal(normalizeLauncherPreferences({ orders: { 'C:\\Desktop\\Project': ids([shortcut]) } }).orders['folder:c:\\desktop\\project'].length, 1);
    assert.equal(normalizeLauncherPreferences({ pinned: [app, { ...app, path: 'C:\\Desktop\\Another.lnk' }] }).pinned.length, 1);
    const movedAppPin = setLauncherPinned(setLauncherPinned({}, app, true), { ...app, path: 'C:\\Desktop\\Another.lnk' }, true);
    assert.equal(movedAppPin.pinned.length, 1);
    assert.equal(movedAppPin.pinned[0].path, 'C:\\Desktop\\Another.lnk');
});

test('unrecorded files have stable natural name order regardless of scan order', () => {
    const two = file('note2.txt'), ten = file('note10.txt');
    const prefs = { orders: { root: ids([b]) } };
    assert.deepEqual(orderedLauncherFiles([ten, a, two, b], prefs).map(item => item.name), ['b.txt', 'a.txt', 'note2.txt', 'note10.txt']);
    assert.deepEqual(ids(orderedLauncherFiles([two, b, ten, a], prefs)), ids(orderedLauncherFiles([ten, a, two, b], prefs)));
});

test('canonical native extended paths share ordinary Windows identities and pins', () => {
    const extended = { ...a, path: '\\\\?\\C:\\Desktop\\a.txt' };
    assert.equal(launcherFileId(extended), launcherFileId(a));
    assert.equal(launcherFolderScope('\\\\?\\UNC\\Server\\Share\\Folder'), launcherFolderScope('\\\\Server\\Share\\Folder'));
    const prefs = setLauncherPinned({}, extended, true);
    assert.equal(setLauncherPinned(prefs, a, false).pinned.length, 0);
    assert.deepEqual(collectLauncherFiles({ documents: [extended], recent: [a] }).length, 1);
    const renamed = migrateLauncherPath(prefs, 'C:\\Desktop\\a.txt', 'C:\\Desktop\\renamed.txt');
    assert.equal(renamed.pinned[0].name, 'renamed.txt');
});

test('adding an application identity preserves the existing file position before and after dragging', () => {
    const shortcut = file('Z Tool.lnk'), app = { ...shortcut, app_id: 'managed-tool' };
    const prefs = setLauncherPinned({ orders: { root: ids([shortcut, a]) } }, shortcut, true);
    const pinned = setLauncherPinned(prefs, a, true);
    assert.deepEqual(ids(orderedLauncherFiles([a, app], prefs)), ids([app, a]));
    assert.deepEqual(ids(orderedLauncherFiles([a, app], pinned, 'pinned')), ids([app, a]));
    const next = reorderLauncherFiles(prefs, 'root', launcherFileId(a), launcherFileId(app), ids([app, a]), [app, a]);
    assert.deepEqual(next.orders.root, ids([a, app]));
    assert.deepEqual(ids(orderedLauncherFiles([app, a], next)), ids([a, app]));
});

test('the first filtered drag initializes the whole scope before replacing visible slots', () => {
    const prefs = normalizeLauncherPreferences({});
    const full = [a, hidden, b, c];
    const next = reorderLauncherFiles(prefs, 'root', launcherFileId(c), launcherFileId(a), ids([a, b, c]), full);
    assert.deepEqual(next.orders.root, ids([c, hidden, a, b]));
    assert.deepEqual(ids(orderedLauncherFiles(full, next)), ids([c, hidden, a, b]));
});

test('saved missing-file positions survive scans and take effect when the file returns', () => {
    const missing = file('missing.txt');
    const prefs = normalizeLauncherPreferences({ orders: { root: ids([b, missing, a]) } });
    assert.deepEqual(ids(orderedLauncherFiles([a, b], prefs)), ids([b, a]));
    assert.deepEqual(ids(orderedLauncherFiles([a, missing, b], prefs)), ids([b, missing, a]));
    assert.deepEqual(prefs.orders.root, ids([b, missing, a]));
});

test('a deep folder pin keeps sufficient metadata across a fresh root scan and reload', () => {
    const nested = file('draft.md', { path: 'C:\\Desktop\\Project\\Notes\\draft.md', size: 128, icon: 'large-data-url', children: ['not persisted'] });
    const next = setLauncherPinned({}, nested, true);
    const restored = normalizeLauncherPreferences(JSON.parse(JSON.stringify(next)));
    assert.deepEqual(restored.pinned, [{ path: nested.path, name: nested.name, is_folder: false, size: 128, category: 'document' }]);
    assert.deepEqual(ids(orderedLauncherFiles(restored.pinned, restored, 'pinned')), ids([nested]));
    assert.equal('icon' in restored.pinned[0], false);
    assert.deepEqual(setLauncherPinned(restored, { ...nested, path: nested.path.toLowerCase() }, true).pinned.length, 1);
    assert.equal(setLauncherPinned(restored, nested, false).pinned.length, 0);
});

test('filtered drag rearranges visible slots and retains hidden files and missing entries', () => {
    const prefs = normalizeLauncherPreferences({ orders: { root: ids([a, hidden, b, c]) } });
    const next = reorderLauncherFiles(prefs, 'root', launcherFileId(c), launcherFileId(a), ids([a, b, c]));
    assert.deepEqual(next.orders.root, ids([c, hidden, a, b]));
    const end = reorderLauncherFiles(next, 'root', launcherFileId(c), null, ids([c, a, b]));
    assert.deepEqual(end.orders.root, ids([a, hidden, b, c]));
    assert.deepEqual(prefs.orders.root, ids([a, hidden, b, c]));
});

test('folder and pinned sorting are isolated and do not change pin membership', () => {
    const scope = launcherFolderScope('C:\\Desktop\\Project');
    const prefs = setLauncherPinned(setLauncherPinned({}, a, true), b, true);
    const sorted = reorderLauncherFiles(prefs, 'pinned', launcherFileId(b), launcherFileId(a), ids([a, b]));
    const folder = reorderLauncherFiles(sorted, scope, launcherFileId(c), launcherFileId(a), ids([a, c]));
    assert.deepEqual(ids(orderedLauncherFiles(folder.pinned, folder, 'pinned')), ids([b, a]));
    assert.deepEqual(folder.orders[scope], ids([c, a]));
    assert.deepEqual(folder.orders.root, []);
    assert.deepEqual(folder.pinned, prefs.pinned);
});

test('invalid drops and malformed metadata are harmless, bounded and pure', () => {
    const prefs = normalizeLauncherPreferences(JSON.parse('{"orders":{"__proto__":["file:c:\\\\bad"],"root":["file:C:/Desktop/a.txt","file:c:\\\\desktop\\\\a.txt",7]},"pinned":[]}'));
    assert.equal(Object.hasOwn(prefs.orders, '__proto__'), false);
    assert.deepEqual(prefs.orders.root, ids([a]));
    assert.deepEqual(reorderLauncherFiles(prefs, 'root', launcherFileId(b), launcherFileId(a), ids([a])), prefs);
    assert.deepEqual(reorderLauncherFiles(prefs, 'root', launcherFileId(a), launcherFileId(c), ids([a, b])), prefs);
    assert.equal(normalizeLauncherPreferences({ pinned: [file('bad', { path: 'x'.repeat(1401) })] }).pinned.length, 0);
    assert.equal(normalizeLauncherPreferences({ orders: { root: Array.from({ length: 4100 }, (_, i) => `file:c:\\${i}`) } }).orders.root.length, 4000);
    const before = structuredClone(prefs);
    orderedLauncherFiles([b, a], prefs);
    setLauncherPinned(prefs, b, true);
    migrateLauncherPath(prefs, a.path, 'C:\\Desktop\\renamed.txt');
    assert.deepEqual(prefs, before);
});

test('rename carries pin references and all saved orders to the new identity', () => {
    const prefs = setLauncherPinned({ orders: { root: ids([b, a]), [launcherFolderScope(a.path)]: ids([a]) } }, a, true);
    const newPath = 'C:\\Desktop\\renamed.txt';
    const next = migrateLauncherPath(prefs, a.path, newPath);
    assert.equal(next.pinned[0].path, newPath);
    assert.equal(next.pinned[0].name, 'renamed.txt');
    assert.deepEqual(next.orders.root, [launcherFileId(b), launcherFileId({ ...a, path: newPath })]);
    assert.equal(Object.hasOwn(next.orders, launcherFolderScope(a.path)), false);
    assert.deepEqual(next.orders[launcherFolderScope(newPath)], [launcherFileId({ ...a, path: newPath })]);
    assert.equal(prefs.pinned[0].path, a.path);
});

test('renaming a containing folder migrates descendant pins without touching similarly named folders', () => {
    const nested = file('Notes.md', { path: 'C:\\Desktop\\Project\\Sub\\Notes.md' });
    const other = file('Other.md', { path: 'C:\\Desktop\\ProjectExtra\\Other.md' });
    const oldScope = launcherFolderScope('C:\\Desktop\\Project\\Sub');
    const prefs = setLauncherPinned(setLauncherPinned({ orders: { [oldScope]: ids([nested]) } }, nested, true), other, true);
    const next = migrateLauncherPath(prefs, 'C:\\Desktop\\Project', 'C:\\Desktop\\Renamed');
    assert.equal(next.pinned[0].path, 'C:\\Desktop\\Renamed\\sub\\notes.md');
    assert.equal(next.pinned[0].name, 'Notes.md');
    assert.equal(next.pinned[1].path, other.path);
    assert.deepEqual(next.orders[launcherFolderScope('C:\\Desktop\\Renamed\\Sub')], ['file:c:\\desktop\\renamed\\sub\\notes.md']);
    assert.equal(Object.hasOwn(next.orders, oldScope), false);
});

test('legacy migration preserves classic names and order before retiring the old layout', () => {
    const legacy = JSON.stringify({ version: 1, groups: { document: { name: '项目文稿', size: 'nine' } }, orders: { document: ['file:C:\\Desktop\\b.txt', 'file:C:\\Desktop\\a.txt'], image: ['file:C:\\Desktop\\a.txt'] } });
    const storage = memoryStorage({ dtkit_desktop_space_v1: legacy, unrelated: 'keep' });
    const migrated = migrateLauncherPreferences(storage);
    assert.deepEqual(migrated.orders.root, ids([b, a]));
    assert.deepEqual(migrated.pinned, []);
    assert.equal(storage.getItem('dtkit_desktop_space_v1'), null);
    assert.equal(storage.getItem('unrelated'), 'keep');
    const classic = JSON.parse(storage.getItem('dtkit_desktop_classic_categories_v1'));
    assert.equal(classic.names.document, '项目文稿');
    assert.deepEqual(classic.orders.document, ['file:C:\\Desktop\\b.txt', 'file:C:\\Desktop\\a.txt']);
    assert.deepEqual(JSON.parse(storage.getItem(LAUNCHER_STORAGE_KEY)), migrated);
});

test('failed launcher or classic persistence retains the source data and throws', () => {
    const legacy = JSON.stringify({ groups: { document: { name: '保留名字' } }, orders: { document: ids([b, a]) } });
    for (const failKey of [LAUNCHER_STORAGE_KEY, 'dtkit_desktop_classic_categories_v1']) {
        const storage = memoryStorage({ dtkit_desktop_space_v1: legacy, unrelated: 'keep' }, failKey);
        assert.throws(() => migrateLauncherPreferences(storage), /quota exceeded/);
        assert.equal(storage.getItem('dtkit_desktop_space_v1'), legacy);
        assert.equal(storage.getItem('unrelated'), 'keep');
    }
});

test('existing v2 is authoritative, while any remaining legacy classic metadata is backed up', () => {
    const current = setLauncherPinned({ orders: { root: ids([a, b]) } }, b, true);
    const storage = memoryStorage({
        [LAUNCHER_STORAGE_KEY]: JSON.stringify(current),
        dtkit_desktop_space_v1: JSON.stringify({ groups: { document: { name: '旧名称' } }, orders: { document: ids([b, a]) } })
    });
    assert.deepEqual(migrateLauncherPreferences(storage), current);
    assert.equal(JSON.parse(storage.getItem('dtkit_desktop_classic_categories_v1')).names.document, '旧名称');
    assert.equal(storage.getItem('dtkit_desktop_space_v1'), null);
});

test('opening existing v2 never needs a write and preserves pins and order during a temporary write failure', () => {
    const current = setLauncherPinned({ orders: { root: ids([c, a, b]) } }, b, true);
    const serialized = JSON.stringify(current, null, 2);
    const storage = memoryStorage({ [LAUNCHER_STORAGE_KEY]: serialized }, LAUNCHER_STORAGE_KEY);
    assert.deepEqual(migrateLauncherPreferences(storage), current);
    assert.equal(storage.getItem(LAUNCHER_STORAGE_KEY), serialized, 'opening must not normalize-write the saved source');
});

test('read preferences survives failed legacy migration without dropping the readable order', () => {
    const legacy = JSON.stringify({ version: 1, groups: { document: { name: '保留名称' } }, orders: { document: ids([c, b, a]) } });
    const storage = memoryStorage({ dtkit_desktop_space_v1: legacy }, 'dtkit_desktop_classic_categories_v1');
    const loaded = readLauncherPreferences(storage);
    assert.deepEqual(loaded.orders.root, ids([c, b, a]));
    assert.throws(() => migrateLauncherPreferences(storage), /quota exceeded/);
    assert.deepEqual(loaded.orders.root, ids([c, b, a]));
    assert.equal(storage.getItem('dtkit_desktop_space_v1'), legacy);
    assert.equal(storage.getItem(LAUNCHER_STORAGE_KEY), null);
});

test('malformed and future v2 sources are retained byte-for-byte instead of being normalized to empty state', () => {
    for (const raw of ['{bad json', 'null', '[]', '{"version":3,"pinned":[],"orders":{}}', '{"version":2,"pinned":"corrupt","orders":{}}']) {
        const storage = memoryStorage({ [LAUNCHER_STORAGE_KEY]: raw });
        assert.throws(() => readLauncherPreferences(storage));
        assert.throws(() => migrateLauncherPreferences(storage));
        assert.equal(storage.getItem(LAUNCHER_STORAGE_KEY), raw);
    }
});

test('authoritative valid v2 is readable while legacy retirement waits for a successful classic backup', () => {
    const current = setLauncherPinned({ orders: { root: ids([b, a]) } }, c, true);
    const serialized = JSON.stringify(current, null, 2);
    const legacy = JSON.stringify({ version: 1, groups: { document: { name: '旧类别' } }, orders: { document: ids([a, b]) } });
    const storage = memoryStorage({ [LAUNCHER_STORAGE_KEY]: serialized, dtkit_desktop_space_v1: legacy }, 'dtkit_desktop_classic_categories_v1');
    assert.deepEqual(readLauncherPreferences(storage), current);
    assert.throws(() => migrateLauncherPreferences(storage), /quota exceeded/);
    assert.equal(storage.getItem(LAUNCHER_STORAGE_KEY), serialized);
    assert.equal(storage.getItem('dtkit_desktop_space_v1'), legacy);
});
