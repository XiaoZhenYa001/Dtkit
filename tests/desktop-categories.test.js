import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectApplicationCategoryGroups,
    migrateFileCategory,
    reconcileFileCategories,
    resolveApplicationCategoryKey
} from '../src/desktop-organizer/categories.js';

function file(path, overrides = {}) {
    return {
        path,
        name: path.split(/[\\/]/).pop(),
        category: 'document',
        is_folder: false,
        app_id: null,
        ...overrides
    };
}

test('renaming a categorized desktop item migrates its assignment to the new path', () => {
    const oldPath = 'C:\\Users\\demo\\Desktop\\draft.txt';
    const newPath = 'C:\\Users\\demo\\Desktop\\final.txt';
    const assignments = { [oldPath]: 'custom_work' };

    assert.deepEqual(migrateFileCategory(assignments, oldPath, newPath), {
        [newPath]: 'custom_work'
    });
    assert.deepEqual(assignments, { [oldPath]: 'custom_work' });
});

test('live scans prune stale or invalid custom-category assignments', () => {
    const currentPath = 'C:\\Users\\demo\\Desktop\\current.txt';
    const stalePath = 'C:\\Users\\demo\\Desktop\\deleted.txt';
    const appPath = 'C:\\ProgramData\\Tools\\tool.lnk';
    const assignments = {
        [currentPath]: 'custom_work',
        [stalePath]: 'custom_work',
        [appPath]: 'custom_work',
        'C:\\Users\\demo\\Desktop\\invalid.txt': 'custom_removed'
    };
    const files = {
        documents: [file(currentPath)],
        applications: [file(appPath, { app_id: 'app-tool' })]
    };

    assert.deepEqual(
        reconcileFileCategories(assignments, files, new Set(['custom_work'])),
        { [currentPath]: 'custom_work' }
    );
});

test('applications resolve to program, custom, or dynamic categories', () => {
    const customCategories = [{ key: 'custom_work', name: '工作' }];

    assert.equal(resolveApplicationCategoryKey({ app_category: 'program' }, customCategories), 'program');
    assert.equal(resolveApplicationCategoryKey({ app_category: '程序' }, customCategories), 'program');
    assert.equal(resolveApplicationCategoryKey({ app_category: '最近使用' }, customCategories), 'recent');
    assert.equal(resolveApplicationCategoryKey({ app_category: '文件夹' }, customCategories), 'folder');
    assert.equal(resolveApplicationCategoryKey({ app_category: '其他' }, customCategories), 'other');
    assert.equal(resolveApplicationCategoryKey({ app_category: '工作' }, customCategories), 'custom_work');
    assert.equal(resolveApplicationCategoryKey({ app_category: '游戏' }, customCategories), 'app_category_%E6%B8%B8%E6%88%8F');
});

test('application category groups expose categories that have no predefined section', () => {
    const applications = [
        { app_category: '游戏' },
        { app_category: '游戏' },
        { app_category: '影音' },
        { app_category: 'program' },
        { app_category: '工作' }
    ];

    assert.deepEqual(
        collectApplicationCategoryGroups(applications, [{ key: 'custom_work', name: '工作' }]),
        [
            { key: 'app_category_%E5%BD%B1%E9%9F%B3', name: '影音', count: 1 },
            { key: 'app_category_%E6%B8%B8%E6%88%8F', name: '游戏', count: 2 }
        ]
    );
});
