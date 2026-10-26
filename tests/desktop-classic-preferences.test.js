import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CLASSIC_CATEGORY_STORAGE_KEY, readClassicCategoryPreferences,
    normalizeClassicCategoryPreferences, migrateClassicCategoryPath
} from '../src/desktop-organizer/classic-preferences.js';

const legacyKey = 'dtkit_desktop_space_v1';
function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('classic imports legacy aliases and ordering before the launcher retires its storage', () => {
    const saved = storage({ [legacyKey]: JSON.stringify({ groups: { document: { name: '项目资料', size: 'nine' } }, orders: { document: ['file:C:\\Desktop\\b.txt', 'app:editor'] } }) });
    const preferences = readClassicCategoryPreferences(saved);
    assert.deepEqual(preferences, { version: 1, names: { document: '项目资料' }, orders: { document: ['file:C:\\Desktop\\b.txt', 'app:editor'] } });
    assert.deepEqual(JSON.parse(saved.getItem(CLASSIC_CATEGORY_STORAGE_KEY)), preferences);
    saved.values.delete(legacyKey);
    assert.deepEqual(readClassicCategoryPreferences(saved), preferences);
});

test('a failed classic migration write prevents retirement of the old data', () => {
    const saved = storage({ [legacyKey]: JSON.stringify({ groups: { image: { name: '素材' } } }) });
    saved.setItem = () => { throw new Error('storage full'); };
    assert.throws(() => readClassicCategoryPreferences(saved), /storage full/);
    assert.ok(saved.getItem(legacyKey));
    assert.equal(saved.getItem(CLASSIC_CATEGORY_STORAGE_KEY), null);
});

test('classic path migration retains app identities and deduplicates the renamed file', () => {
    const preferences = { version: 1, names: { document: '文稿' }, orders: { document: ['file:C:\\Desktop\\old.txt', 'app:editor', 'file:C:\\Desktop\\new.txt'] } };
    const next = migrateClassicCategoryPath(preferences, 'C:\\Desktop\\old.txt', 'C:\\Desktop\\new.txt');
    assert.deepEqual(next.orders.document, ['file:C:\\Desktop\\new.txt', 'app:editor']);
    assert.equal(next.names.document, '文稿');
    assert.equal(preferences.orders.document.length, 3);
});

test('untrusted classic metadata excludes unsafe group keys and malformed orders', () => {
    const preferences = normalizeClassicCategoryPreferences(JSON.parse('{"names":{"__proto__":"bad","document":"  文档  "},"orders":{"constructor":["bad"],"document":["app:a",null,"app:a"]}}'));
    assert.deepEqual(preferences, { version: 1, names: { document: '文档' }, orders: { document: ['app:a'] } });
});
