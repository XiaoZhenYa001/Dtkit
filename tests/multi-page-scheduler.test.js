import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolPageScheduler } from '../src/core/toolPageScheduler.js';

function clock() {
    let time = 0;
    let sequence = 0;
    const jobs = new Map();
    const target = {
        performance: { now: () => time },
        setTimeout(callback, delay) {
            const id = ++sequence;
            jobs.set(id, { at: time + delay, callback });
            return id;
        },
        clearTimeout(id) { jobs.delete(id); },
        requestAnimationFrame(callback) {
            const id = ++sequence;
            jobs.set(id, { at: time + 16, callback: () => callback(time) });
            return id;
        },
        cancelAnimationFrame(id) { jobs.delete(id); }
    };
    return {
        target,
        get nativeCount() { return jobs.size; },
        advance(milliseconds) {
            const end = time + milliseconds;
            let guard = 0;
            while (true) {
                const candidate = [...jobs].filter(([,job]) => job.at <= end)
                    .sort((left,right) => left[1].at - right[1].at || left[0] - right[0])[0];
                if (!candidate) break;
                assert.ok(++guard < 1000, 'Timer unexpectedly entered an infinite loop');
                const [id,job] = candidate;
                time = job.at;
                jobs.delete(id);
                job.callback();
            }
            time = end;
        }
    };
}

test('a hidden page owns no native timers and resumes a timeout with its remaining delay', () => {
    const fake = clock();
    const scheduler = createToolPageScheduler(fake.target);
    const calls = [];
    fake.target.setTimeout((...args) => calls.push(args), 100, 'value', 42);
    fake.advance(35);
    scheduler.setSuspended(true);
    assert.equal(fake.nativeCount, 0);
    assert.equal(scheduler.pendingCount, 1);
    fake.advance(10000);
    assert.deepEqual(calls, []);
    scheduler.setSuspended(false);
    fake.advance(64);
    assert.deepEqual(calls, []);
    fake.advance(1);
    assert.deepEqual(calls, [['value',42]]);
    assert.equal(scheduler.pendingCount, 0);
    assert.equal(fake.nativeCount, 0);
});

test('hidden intervals do not catch up and cancellation remains valid after repeated pause cycles', () => {
    const fake = clock();
    const scheduler = createToolPageScheduler(fake.target);
    let calls = 0;
    const id = fake.target.setInterval(() => calls++, 50);
    fake.advance(70);
    assert.equal(calls, 1);
    scheduler.setSuspended(true);
    fake.advance(5000);
    scheduler.setSuspended(false);
    fake.advance(10);
    scheduler.setSuspended(true);
    fake.advance(5000);
    scheduler.setSuspended(false);
    fake.advance(19);
    assert.equal(calls, 1);
    fake.advance(1);
    assert.equal(calls, 2);
    fake.target.clearInterval(id);
    fake.advance(5000);
    assert.equal(calls, 2);
    assert.equal(fake.nativeCount, 0);
    assert.equal(scheduler.pendingCount, 0);
});

test('work scheduled while hidden starts after resume, including a deferred animation frame', () => {
    const fake = clock();
    const scheduler = createToolPageScheduler(fake.target);
    scheduler.setSuspended(true);
    const calls = [];
    fake.target.setTimeout(() => calls.push('timeout'), 5);
    fake.target.requestAnimationFrame(timestamp => calls.push(timestamp));
    const cancelled = fake.target.requestAnimationFrame(() => calls.push('cancelled'));
    fake.target.cancelAnimationFrame(cancelled);
    assert.equal(fake.nativeCount, 0);
    fake.advance(1000);
    scheduler.setSuspended(false);
    fake.advance(5);
    assert.deepEqual(calls, ['timeout']);
    fake.advance(11);
    assert.deepEqual(calls, ['timeout',1016]);
    assert.equal(scheduler.pendingCount, 0);
});

test('closing a page cancels all pending work and a later resume cannot restart it', () => {
    const fake = clock();
    const scheduler = createToolPageScheduler(fake.target);
    let calls = 0;
    fake.target.setTimeout(() => calls++, 25);
    fake.target.setInterval(() => calls++, 25);
    fake.target.requestAnimationFrame(() => calls++);
    scheduler.dispose();
    scheduler.setSuspended(false);
    fake.advance(10000);
    assert.equal(calls, 0);
    assert.equal(scheduler.pendingCount, 0);
    assert.equal(fake.nativeCount, 0);
});

test('an interval can cancel itself inside its callback without being rearmed', () => {
    const fake = clock();
    const scheduler = createToolPageScheduler(fake.target);
    let calls = 0;
    const id = fake.target.setInterval(() => { calls++; fake.target.clearTimeout(id); }, 10);
    fake.advance(1000);
    assert.equal(calls, 1);
    assert.equal(scheduler.pendingCount, 0);
    assert.equal(fake.nativeCount, 0);
});
