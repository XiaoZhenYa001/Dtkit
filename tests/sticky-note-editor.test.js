import assert from 'node:assert/strict';
import test from 'node:test';
import { continueNoteList, findNoteMatches, formatNoteSelection, noteStats, renderNoteMarkdown, toggleNoteTask } from '../src/sticky-note/editor-model.js';

test('Markdown escapes raw HTML, scripts, links and image payloads everywhere', () => {
    const output = renderNoteMarkdown('# <img src=x onerror="alert(1)">\n- [ ] <script>alert(1)</script>\n**<svg/onload=x>**\n`<iframe>`\n[x](javascript:alert(1))\n```\n</code><script>x</script>\n```');
    assert.ok(!/<(?:img|script|svg|iframe|a)\b/i.test(output));
    assert.match(output, /&lt;img/);
    assert.match(output, /<strong>&lt;svg\/onload=x&gt;<\/strong>/);
    assert.match(output, /aria-label="标记任务：&lt;script&gt;/);
    assert.ok(!output.includes('aria-label="标记任务：<script>'));
});

test('Markdown task controls refer to original lines and preserve code as literal text', () => {
    const content = '# 今天\n\n- [ ] 牛奶\n- [X] 苹果\n```text\n- [ ] 并不是任务\n```\n1. 事项\n> 引用';
    const output = renderNoteMarkdown(content);
    assert.match(output, /data-task-line="2"/);
    assert.match(output, /data-task-line="3"[^>]* checked/);
    assert.ok(!output.includes('data-task-line="5"'));
    assert.match(output, /<pre><code>- \[ \] 并不是任务<\/code><\/pre>/);
    assert.match(output, /<ol><li>事项<\/li><\/ol>/);
    assert.match(output, /<blockquote>引用<\/blockquote>/);
});

test('task toggles change only the requested checkbox marker and ignore fenced or invalid lines', () => {
    const content = '- [ ] 第一项\n- [x] 第二项\n```\n- [ ] 代码项\n```';
    assert.equal(toggleNoteTask(content, 0, true), '- [x] 第一项\n- [x] 第二项\n```\n- [ ] 代码项\n```');
    assert.equal(toggleNoteTask(content, 1, false), '- [ ] 第一项\n- [ ] 第二项\n```\n- [ ] 代码项\n```');
    for (const line of [-1, 2, 3, 4, 10, NaN]) assert.equal(toggleNoteTask(content, line, true), content);
});

test('stats count user-visible Unicode characters and real tasks, excluding fenced examples', () => {
    assert.deepEqual(noteStats('你好😀'), { characters: 3, tasks: 0, completed: 0 });
    const text = '- [ ] a\n- [x] b\n```\n- [X] example\n```';
    assert.deepEqual(noteStats(text), { characters: [...text].length, tasks: 2, completed: 1 });
});

test('formatting wraps a selection while preserving its contents and supports toggling off', () => {
    const first = formatNoteSelection('早上喝牛奶', 2, 5, 'bold');
    assert.equal(first.value, '早上**喝牛奶**');
    assert.equal(first.value.slice(first.selectionStart, first.selectionEnd), '喝牛奶');
    const second = formatNoteSelection(first.value, first.selectionStart, first.selectionEnd, 'bold');
    assert.equal(second.value, '早上喝牛奶');
    assert.equal(formatNoteSelection('**喝牛奶**', 0, 7, 'bold').value, '喝牛奶');
});

test('formatting at an empty caret inserts a selected useful placeholder', () => {
    const result = formatNoteSelection('abc', 1, 1, 'code');
    assert.equal(result.value, 'a`代码`bc');
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '代码');
});

test('line formatting affects whole selected lines without touching following content', () => {
    const content = '第一行\n第二行\n第三行';
    const result = formatNoteSelection(content, 1, 8, 'checklist');
    assert.equal(result.value, '- [ ] 第一行\n- [ ] 第二行\n第三行');
    assert.equal(formatNoteSelection(result.value, 0, 20, 'checklist').value, content);
    assert.equal(formatNoteSelection('\n正文', 0, 0, 'heading').value, '# \n正文');
    assert.equal(formatNoteSelection('第一行\n第二行', 0, 4, 'list').value, '- 第一行\n第二行');
});

test('formatting respects the backend maximum without silently truncating note content', () => {
    assert.equal(formatNoteSelection('a'.repeat(20000), 0, 4, 'bold'), null);
    assert.equal(formatNoteSelection('a'.repeat(20000), 0, 0, 'checklist'), null);
    assert.equal(formatNoteSelection('**' + 'a'.repeat(19996) + '**', 2, 19998, 'bold').value.length, 19996);
    assert.equal(formatNoteSelection('abc', 0, 0, 'unknown'), null);
});

test('Enter continues bullets, unchecked tasks and ordered items; empty items exit the list', () => {
    assert.equal(continueNoteList('- [x] 完成', 8)?.replacement, '\n- [ ] ');
    assert.equal(continueNoteList('  8. 内容', 7)?.replacement, '\n  9. ');
    assert.equal(continueNoteList('* 内容', 4)?.replacement, '\n* ');
    assert.deepEqual(continueNoteList('正文\n- [ ] ', 9), { from: 3, to: 9, replacement: '', selectionStart: 3, selectionEnd: 3 });
    assert.equal(continueNoteList('普通正文', 4), null);
    assert.equal(continueNoteList('```\n- 内容', 8), null);
    assert.equal(continueNoteList('- existing', 2)?.replacement, '\n- ');
    assert.equal(continueNoteList('- ' + 'a'.repeat(19998), 20000), null);
});

test('indent and outdent operate on lines and preserve content', () => {
    assert.equal(formatNoteSelection('a\nb', 0, 3, 'indent').value, '  a\n  b');
    assert.equal(formatNoteSelection('  a\n b\n\tc', 0, 10, 'outdent').value, 'a\nb\nc');
});

test('search treats regex symbols literally and uses original Unicode offsets', () => {
    assert.deepEqual(findNoteMatches('Ab AB ab', 'ab'), [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }]);
    assert.deepEqual(findNoteMatches('a.* b.*', '.*'), [{ start: 1, end: 3 }, { start: 5, end: 7 }]);
    assert.deepEqual(findNoteMatches('İ X hello', 'hello'), [{ start: 4, end: 9 }]);
    assert.deepEqual(findNoteMatches('😀 hello 😀', '😀'), [{ start: 0, end: 2 }, { start: 9, end: 11 }]);
    assert.deepEqual(findNoteMatches('anything', ''), []);
});
