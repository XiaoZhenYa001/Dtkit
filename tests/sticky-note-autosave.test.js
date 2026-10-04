import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoteAutosave } from '../src/sticky-note/autosave.js';

const note = () => ({
    id: '8a17b626-4dcb-40bb-9455-2c85befcf7d0', title: '想法', content: '原文',
    color: 'yellow', pinned: true, revision: 7
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(save) {
    let nextTimer = 0;
    const timers = new Map();
    const states = [];
    const recoveries = [];
    let forgotten = 0;
    const controller = createNoteAutosave({
        initialNote: note(), save,
        schedule: callback => { const key = ++nextTimer; timers.set(key, callback); return key; },
        cancel: key => timers.delete(key),
        onState: state => states.push(state),
        remember: draft => recoveries.push(draft),
        forget: () => { forgotten += 1; }
    });
    return {
        controller, timers, states, recoveries,
        get forgotten() { return forgotten; },
        fireTimers() {
            for (const [key, callback] of [...timers]) {
                timers.delete(key);
                callback();
            }
        }
    };
}

test('coalesces typing into one debounced write with the latest content', async () => {
    const writes = [];
    const app = harness(async draft => { writes.push(draft); return { ...draft, revision: draft.revision + 1 }; });
    app.controller.edit({ content: '第一笔' });
    app.controller.edit({ content: '第一笔和第二笔' });
    assert.equal(app.timers.size, 1);
    assert.equal(writes.length, 0);
    app.fireTimers();
    await app.controller.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].content, '第一笔和第二笔');
    assert.equal(app.controller.getState().status, 'saved');
    assert.equal(app.controller.getState().draft.revision, 8);
    assert.equal(app.forgotten, 1);
});

test('preserves typing during a save and serializes it with the acknowledged revision', async () => {
    const writes = [];
    const requests = [];
    const app = harness(draft => {
        writes.push(draft);
        const pending = deferred();
        requests.push(pending);
        return pending.promise;
    });
    app.controller.edit({ content: '保存中的文字' });
    const completion = app.controller.flush();
    await Promise.resolve();
    app.controller.edit({ content: '保存中继续追加', color: 'blue' });
    assert.equal(writes.length, 1);
    assert.equal(app.forgotten, 0);
    requests[0].resolve({ ...writes[0], revision: 8 });
    await Promise.resolve();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].revision, 8);
    assert.equal(writes[1].content, '保存中继续追加');
    assert.equal(writes[1].color, 'blue');
    assert.equal(app.forgotten, 0, 'new edits must retain their recovery draft until their own acknowledgment');
    requests[1].resolve({ ...writes[1], revision: 9 });
    await completion;
    assert.equal(app.controller.getState().draft.content, '保存中继续追加');
    assert.equal(app.controller.getState().draft.revision, 9);
    assert.equal(app.controller.getState().dirty, false);
    assert.equal(app.forgotten, 1);
});

test('reverting to the original value during a request still persists the reversion', async () => {
    const first = deferred();
    const writes = [];
    const app = harness(draft => {
        writes.push(draft);
        return writes.length === 1 ? first.promise : Promise.resolve({ ...draft, revision: draft.revision + 1 });
    });
    app.controller.edit({ content: '暂时编辑' });
    const completion = app.controller.flush();
    await Promise.resolve();
    app.controller.edit({ content: '原文' });
    assert.equal(app.recoveries.at(-1).content, '原文');
    assert.equal(app.forgotten, 0);
    first.resolve({ ...writes[0], revision: 8 });
    await completion;
    assert.equal(writes.length, 2);
    assert.equal(writes[1].content, '原文');
    assert.equal(writes[1].revision, 8);
});

test('flush waits for all in-flight edits before it permits a close', async () => {
    const pending = deferred();
    let count = 0;
    const app = harness(async draft => {
        count += 1;
        if (count === 1) await pending.promise;
        return { ...draft, revision: draft.revision + 1 };
    });
    app.controller.edit({ content: 'A' });
    const firstFlush = app.controller.flush();
    await Promise.resolve();
    app.controller.edit({ content: 'B' });
    const closeFlush = app.controller.flush();
    assert.equal(firstFlush, closeFlush);
    let closed = false;
    closeFlush.then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    pending.resolve();
    await closeFlush;
    assert.equal(count, 2);
    assert.equal(closed, true);
    assert.equal(app.controller.getState().draft.content, 'B');
});

test('a failed save keeps the revision and draft, and typing does not silently retry', async () => {
    let attempts = 0;
    const app = harness(async () => { attempts += 1; throw new Error('磁盘空间不足'); });
    app.controller.edit({ content: '不可丢失的文字' });
    await assert.rejects(app.controller.flush(), /磁盘空间不足/);
    assert.equal(app.controller.getState().draft.revision, 7);
    assert.equal(app.controller.getState().status, 'error');
    assert.equal(app.forgotten, 0);
    app.controller.edit({ content: '失败后继续追加' });
    assert.equal(app.timers.size, 0);
    await assert.rejects(app.controller.flush(), /磁盘空间不足/);
    assert.equal(attempts, 1);
    assert.equal(app.recoveries.at(-1).content, '失败后继续追加');
});

test('explicit retry sends the newest draft rather than the failed snapshot', async () => {
    const writes = [];
    const app = harness(async draft => {
        writes.push(draft);
        if (writes.length === 1) throw new Error('暂时失败');
        return { ...draft, revision: draft.revision + 1 };
    });
    app.controller.edit({ content: '第一次' });
    await assert.rejects(app.controller.flush());
    app.controller.edit({ content: '重试前的新内容', pinned: false });
    await app.controller.retry();
    assert.equal(writes[1].content, '重试前的新内容');
    assert.equal(writes[1].pinned, false);
    assert.equal(writes[1].revision, 7);
    assert.equal(app.controller.getState().status, 'saved');
});

test('a conflict is surfaced without a blind revision increment or automatic overwrite', async () => {
    const writes = [];
    const app = harness(async draft => { writes.push(draft); throw new Error('便签已更新，请重新加载'); });
    app.controller.edit({ title: '本机修改' });
    await assert.rejects(app.controller.flush(), /重新加载/);
    await assert.rejects(app.controller.retry(), /重新加载/);
    assert.deepEqual(writes.map(value => value.revision), [7, 7]);
    assert.equal(app.controller.getState().draft.title, '本机修改');
    assert.equal(app.forgotten, 0);
});

test('an invalid acknowledgment cannot clear the recovery draft', async () => {
    const app = harness(async draft => ({ ...draft, content: '与发出的内容不一致', revision: 8 }));
    app.controller.edit({ content: '必须保留' });
    await assert.rejects(app.controller.flush(), /无法确认/);
    assert.equal(app.forgotten, 0);
    assert.equal(app.controller.getState().draft.revision, 7);
    assert.equal(app.recoveries.at(-1).content, '必须保留');
});

test('an unchanged note never writes, and disposing cancels deferred writes', async () => {
    let writes = 0;
    const app = harness(async draft => { writes += 1; return { ...draft, revision: 8 }; });
    await app.controller.flush();
    assert.equal(writes, 0);
    app.controller.edit({ content: '稍后保存' });
    assert.equal(app.timers.size, 1);
    app.controller.dispose();
    assert.equal(app.timers.size, 0);
    app.fireTimers();
    await Promise.resolve();
    assert.equal(writes, 0);
    assert.equal(app.recoveries.at(-1).content, '稍后保存');
});
