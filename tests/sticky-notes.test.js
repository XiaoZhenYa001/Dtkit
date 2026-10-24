import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, TEMPLATES, extractTags, taskProgress, normalizeNote, filterNotes, validateSeed, makeBackup, parseImport, noteMarkdown, safeFilename } from '../src/tools/sticky-notes/core.js';

const seed = (changes = {}) => ({ title: '工作计划', content: '设计评审 #工作', color: 'yellow', pinned: false, ...changes });
const note = (changes = {}) => normalizeNote({ ...seed(), id: '1', revision: 1, createdAt: 100, updatedAt: 200, trashedAt: null, opened: false, ...changes });

test('tags support Chinese, punctuation and deduplicate casing without treating headings as tags', () => {
    assert.deepEqual(extractTags('#工作， #Design #design #两步-走\n## 标题 https://a.test/#anchor foo#bar #'), ['工作', 'Design', '两步-走']);
    assert.deepEqual(extractTags('<img src=x> #安全'), ['安全']);
});

test('task statistics skip fenced code and ordinary brackets', () => {
    assert.deepEqual(taskProgress('- [ ] 要做\n* [X] 完成\n```md\n- [x] 代码\n```\n[ ] 文字\n- [x]x'), { total: 2, done: 1 });
});

test('normalization tolerates invalid native data without throwing during display', () => {
    assert.equal(normalizeNote(null), null);
    assert.equal(normalizeNote({ id: '1', title: [] }), null);
    const normalized = note({ color: 'unknown', createdAt: NaN, updatedAt: 1e100, trashedAt: -1 });
    assert.equal(normalized.color, 'yellow'); assert.equal(normalized.updatedAt, 0); assert.equal(normalized.trashedAt, null);
    assert.doesNotThrow(() => new Date(normalized.updatedAt).toISOString());
});

test('search combines tokens and quoted phrases across title/body safely', () => {
    const items = [note(), note({ id: '2', title: '下次会议', content: '前端 Design Review #工作' })];
    assert.deepEqual(filterNotes(items, { query: '"design review" 工作' }).map(item => item.id), ['2']);
    assert.deepEqual(filterNotes(items, { query: '<img [' }), []);
    assert.deepEqual(filterNotes(items, { query: '设计 工作' }).map(item => item.id), ['1']);
});

test('all/opened/pinned/trash filters compose with colors and exact tags', () => {
    const items = [note({ pinned: true }), note({ id: '2', color: 'green', opened: true }), note({ id: '3', trashedAt: 300, pinned: true, opened: true })];
    assert.equal(filterNotes(items).length, 2);
    assert.deepEqual(filterNotes(items, { filter: 'pinned' }).map(item => item.id), ['1']);
    assert.deepEqual(filterNotes(items, { filter: 'opened', color: 'green', tag: '工作' }).map(item => item.id), ['2']);
    assert.deepEqual(filterNotes(items, { filter: 'trash' }).map(item => item.id), ['3']);
    assert.equal(filterNotes(items, { tag: '作' }).length, 0);
});

test('sorting is stable, newest first and keeps pinned notes ahead', () => {
    const items = [note({ id: 'old', updatedAt: 200, createdAt: 100 }), note({ id: 'new', updatedAt: 400, createdAt: 300 }), note({ id: 'pin', pinned: true, title: 'A' })];
    assert.deepEqual(filterNotes(items).map(item => item.id), ['pin', 'new', 'old']);
    assert.deepEqual(filterNotes(items, { sort: 'created' }).map(item => item.id), ['pin', 'new', 'old']);
});

test('seeds enforce UTF16 native limits and strip unrelated/imported identity fields', () => {
    assert.deepEqual(validateSeed({ ...seed(), id: '../no', revision: 999, opened: true }), seed());
    assert.throws(() => validateSeed(seed({ title: '📝'.repeat(41) })), /80/);
    assert.throws(() => validateSeed(seed({ content: 'x\0y' })), /空字符/);
    assert.throws(() => validateSeed(seed({ color: 'red' })), /颜色/);
    assert.throws(() => validateSeed(seed({ pinned: 'true' })), /设置/);
    assert.doesNotThrow(() => validateSeed(seed({ content: '📝'.repeat(10000) })));
});

test('all templates are valid native seeds', () => {
    for (const value of Object.values(TEMPLATES)) assert.doesNotThrow(() => validateSeed({ ...value, pinned: false }));
    assert.equal(COLORS.length, 6);
});

test('JSON backup round trip includes trash and regenerable content, excludes window and identity state', () => {
    const items = [note(), note({ id: '2', trashedAt: 300, opened: true, pinned: true })];
    const backup = makeBackup(items, new Date('2026-10-20T00:00:00Z'));
    assert.equal(JSON.parse(backup).format, 'dtkit-sticky-notes');
    assert.equal(JSON.parse(backup).notes[0].id, undefined);
    assert.equal(JSON.parse(backup).notes[1].opened, undefined);
    const imported = parseImport(backup, { filename: '备份.json' });
    assert.equal(imported.length, 2); assert.equal(imported[1].trashedAt, 300); assert.equal(imported[1].pinned, true);
});

test('imports reject malformed, unsupported, empty and partial-invalid backups', () => {
    assert.throws(() => parseImport('{', { filename: 'bad.json' }), /解析/);
    assert.throws(() => parseImport('{"version":2,"notes":[]}', { filename: 'bad.json' }), /格式/);
    assert.throws(() => parseImport('[]', { filename: 'empty.json' }), /没有便签/);
    assert.throws(() => parseImport(JSON.stringify([seed(), seed({ content: 42 })]), { filename: 'bad.json' }), /第 2 张/);
    assert.throws(() => parseImport('hello', { filename: 'bad.exe' }), /支持导入/);
});

test('native-store backup import strips geometry and supports BOM', () => {
    const imported = parseImport('\uFEFF' + JSON.stringify({ version: 1, notes: [{ ...seed(), geometry: { x: 1 }, id: 'old', revision: 500 }] }), { filename: 'notes.json' });
    assert.deepEqual(imported, [{ ...seed(), trashedAt: null }]);
});

test('capacity checked before native import and markdown text keeps exact content', () => {
    assert.throws(() => parseImport(JSON.stringify([seed(), seed()]), { filename: 'notes.json', currentCount: 199 }), /剩余 1/);
    assert.deepEqual(parseImport('\uFEFF# 标题\n- [ ] 工作', { filename: '会议信息.md' }), [{ title: '会议信息', content: '# 标题\n- [ ] 工作', color: 'yellow', pinned: false, trashedAt: null }]);
    assert.throws(() => parseImport('x'.repeat(20001), { filename: 'long.txt' }), /第 1 张/);
});

test('exports Markdown and portable filenames without interpreting markup', () => {
    assert.equal(noteMarkdown(seed({ title: '<img>', content: '- [ ] hello' })), '# <img>\n\n- [ ] hello\n');
    assert.equal(safeFilename('a/b:c*?. '), 'a-b-c--.md');
    assert.equal(safeFilename(''), '未命名便签.md');
});
