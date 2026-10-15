import assert from 'node:assert/strict';
import test from 'node:test';
import {
    collectApplicationCategoryGroups,
    isValidFileCategoryKey,
    reconcileFileCategories
} from '../src/desktop-organizer/categories.js';
import { createCategoryController } from '../src/desktop-organizer/category-controller.js';
import { createFileActions } from '../src/desktop-organizer/file-actions.js';
import { filesForCategory, renderCategoryListMarkup } from '../src/desktop-organizer/views/category-view.js';

const file = (path, category = 'document', extras = {}) => ({
    path, name: path.split(/[\\/]/).at(-1), category, size: 16, is_folder: category === 'folder', ...extras
});

function stateWith(files, extras = {}) {
    return {
        files: {
            applications: [], recent: [], documents: [], images: [], videos: [], audios: [],
            archives: [], programs: [], folders: [], others: [], ...files
        },
        customCategories: [], fileCategories: {}, searchIndex: [], expandedCategories: new Set(), ...extras
    };
}

test('file category validation accepts current canonical and encoded groups without reviving deleted custom groups', () => {
    const custom = [{ key: 'custom_123', name: '项目' }];
    for (const key of ['document', 'image', 'video', 'audio', 'archive', 'program', 'folder', 'other', 'custom_123', 'app_category_%E6%B8%B8%E6%88%8F']) {
        assert.equal(isValidFileCategoryKey(key, custom), true, key);
    }
    for (const key of ['documents', 'recent', 'custom_999', 'app_category_', 'app_category_%ZZ', 'app_category_游戏', 'app_category_%20', '__proto__', null]) {
        assert.equal(isValidFileCategoryKey(key, custom), false, String(key));
    }
});

test('reloading category storage preserves builtin and dynamic assignments and only existing custom definitions', () => {
    const state = stateWith({});
    const values = new Map([
        ['desktop_organizer_custom_categories', JSON.stringify([{ key: 'custom_123', name: '工作', icon: '💼' }])],
        ['desktop_organizer_file_categories', JSON.stringify({
            'C:\\one.txt': 'image', 'C:\\two.txt': 'app_category_%E6%B8%B8%E6%88%8F',
            'C:\\three.txt': 'custom_123', 'C:\\four.txt': 'custom_456', 'C:\\five.txt': 'documents'
        })]
    ]);
    const controller = createCategoryController({ state, storage: { getItem: key => values.get(key) }, renderCategories() {} });
    controller.load();
    assert.deepEqual(state.fileCategories, {
        'C:\\one.txt': 'image', 'C:\\two.txt': 'app_category_%E6%B8%B8%E6%88%8F', 'C:\\three.txt': 'custom_123'
    });
});

test('fresh scan reconciliation keeps builtin/dynamic assignments while pruning removed paths and custom groups', () => {
    const first = file('C:\\one.txt');
    const second = file('C:\\two.txt');
    const third = file('C:\\three.txt');
    const assignments = {
        [first.path]: 'image', [second.path]: 'app_category_%E6%B8%B8%E6%88%8F',
        [third.path]: 'custom_removed', 'C:\\deleted.txt': 'document'
    };
    const files = { documents: [first, second, third] };
    assert.deepEqual(reconcileFileCategories(assignments, files, key => isValidFileCategoryKey(key, [])), {
        [first.path]: 'image', [second.path]: 'app_category_%E6%B8%B8%E6%88%8F'
    });
    assert.deepEqual(reconcileFileCategories(assignments, files, new Set(['image'])), { [first.path]: 'image' });
});

test('same-name files at different paths survive custom grouping even when the search index omitted one', () => {
    const first = file('C:\\Desktop\\notes.txt');
    const second = file('D:\\Desktop\\notes.txt');
    const state = stateWith({ documents: [first, second], recent: [first, second] }, {
        customCategories: [{ key: 'custom_1', name: '工作', icon: '💼' }],
        fileCategories: { [first.path]: 'custom_1', [second.path]: 'custom_1' },
        searchIndex: [{ file: first }]
    });
    assert.deepEqual(filesForCategory(state, 'custom_1').map(item => item.path), [first.path, second.path]);
    assert.deepEqual(filesForCategory(state, 'document'), []);
    assert.deepEqual(filesForCategory(state, 'recent').map(item => item.path), [first.path, second.path]);
});

test('builtin destinations include explicitly assigned files and remove them from their natural group', () => {
    const document = file('C:\\Desktop\\brief.txt');
    const image = file('C:\\Desktop\\cover.png', 'image');
    const state = stateWith({ documents: [document], images: [image] }, {
        fileCategories: { [document.path]: 'image' }
    });
    assert.deepEqual(filesForCategory(state, 'image').map(item => item.path), [document.path, image.path]);
    assert.deepEqual(filesForCategory(state, 'document'), []);
    state.fileCategories[document.path] = 'custom_removed';
    assert.deepEqual(filesForCategory(state, 'document'), [document], 'invalid deleted groups restore natural classification');
});

test('a dynamic category keeps ordinary files and its definition after the last application moves out', () => {
    const document = file('C:\\Desktop\\save.txt');
    const categoryKey = 'app_category_%E6%B8%B8%E6%88%8F';
    const state = stateWith({ documents: [document] }, { fileCategories: { [document.path]: categoryKey } });
    assert.deepEqual(filesForCategory(state, categoryKey), [document]);
    assert.deepEqual(collectApplicationCategoryGroups([], [], state.fileCategories), [
        { key: categoryKey, name: '游戏', count: 1 }
    ]);
    assert.match(renderCategoryListMarkup(state), /class="category-name">游戏<\/span><span class="category-count">1/);
});

test('classic groups share escaped aliases and stable file/app ordering with desktop space', () => {
    const first = file('C:\\Desktop\\a.txt');
    const second = file('C:\\Desktop\\b.txt');
    const application = file('C:\\Tools\\editor.exe', 'program', { app_id: 'editor', app_category: 'document' });
    const state = stateWith({ documents: [first, second], applications: [application] }, {
        expandedCategories: new Set(['document']),
        groupPresentation: key => key === 'document' ? {
            name: '项目 <资料>', size: 'nine', order: [`app:${application.app_id}`, `file:${second.path}`, `file:${first.path}`]
        } : {}
    });
    assert.deepEqual(filesForCategory(state, 'document'), [application, second, first]);
    const markup = renderCategoryListMarkup(state);
    assert.match(markup, /class="category-name">项目 &lt;资料&gt;<\/span>/);
    assert.ok(markup.indexOf('data-app-id="editor"') < markup.indexOf('data-name="b.txt"'));
    assert.ok(markup.indexOf('data-name="b.txt"') < markup.indexOf('data-name="a.txt"'));
});

test('a renamed builtin group remains visible after its final file moves elsewhere', () => {
    const state = stateWith({}, { groupPresentation: key => key === 'document' ? { name: '项目资料' } : {} });
    assert.match(renderCategoryListMarkup(state), /class="category-name">项目资料<\/span><span class="category-count">0/);
});

test('rename migration hook runs after native success and before the next scan for every file', async () => {
    const oldPath = 'C:\\Desktop\\old.txt';
    const newPath = 'C:\\Desktop\\new.txt';
    const events = [];
    let hasAssignment = true;
    const state = { fileCategories: { [oldPath]: 'image' }, folderView: { active: false } };
    const actions = createFileActions({
        state,
        invoke: async () => { events.push('native'); return newPath; },
        saveCategories: () => events.push('assignments'),
        setStatus() {}, refreshCurrentView() {},
        onRename: async (oldValue, newValue) => {
            assert.equal(oldValue, oldPath);
            assert.equal(newValue, newPath);
            assert.deepEqual(state.fileCategories, hasAssignment ? { [newPath]: 'image' } : {});
            events.push('presentation');
        },
        loadDesktopFiles: async () => events.push('scan')
    });
    await actions.rename(oldPath, 'new.txt');
    assert.deepEqual(events, ['native', 'assignments', 'presentation', 'scan']);
    state.fileCategories = {};
    hasAssignment = false;
    events.length = 0;
    await actions.rename(oldPath, 'new.txt');
    assert.deepEqual(events, ['native', 'presentation', 'scan']);
});
