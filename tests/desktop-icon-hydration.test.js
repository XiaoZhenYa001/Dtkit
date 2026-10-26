import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIconHydrator } from '../src/desktop-organizer/icon-hydration.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    let visibility;
    const watched = new Set();
    class Observer {
        constructor(callback) { visibility = callback; }
        observe(target) { watched.add(target); }
        unobserve(target) { watched.delete(target); }
        disconnect() { watched.clear(); }
    }
    const document = { createElement: () => ({}) };
    const target = path => {
        const holder = { classList: { add() {} }, replaceChildren(image) { this.image = image; } };
        return { isConnected: true, dataset: { path }, holder,
            closest: () => null, matches: () => false, querySelector: () => holder };
    };
    return { document, window: { IntersectionObserver: Observer }, watched, target,
        root: targets => ({ querySelectorAll: () => targets }),
        visible: targets => visibility(targets.map(target => ({ target, isIntersecting: true }))) };
}

test('desktop shortcut icons use the file command and a changed path never receives an old icon', async () => {
    const dom = fixture(), calls = [];
    let release;
    const target = dom.target('C:\\Desktop\\old.lnk'); target.dataset.iconKind = 'file';
    const hydrator = createIconHydrator({ ...dom, invoke: (command, args) => {
        calls.push({ command, ...args }); return new Promise(resolve => { release = resolve; });
    } });
    hydrator.hydrate(dom.root([target])); dom.visible([target]); await flush();
    target.dataset.path = 'C:\\Desktop\\new.lnk';
    release('old-icon'); await flush();
    assert.equal(calls[0].command, 'desktop_get_icon');
    assert.equal(target.holder.image, undefined);
    assert.equal(target.dataset.iconLoaded, undefined);
    hydrator.destroy();
});

test('slow extraction keeps at most four requests active and coalesces duplicate paths', async () => {
    const dom = fixture(), calls = [], releases = [];
    let active = 0, peak = 0;
    const hydrator = createIconHydrator({ ...dom, invoke: (_, { path }) => {
        calls.push(path); active++; peak = Math.max(peak, active);
        return new Promise(resolve => releases.push(() => { active--; resolve(`icon:${path}`); }));
    } });
    const targets = Array.from({ length: 10 }, (_, index) => dom.target(`app-${index}`));
    const duplicate = dom.target('app-0');
    hydrator.hydrate(dom.root([...targets, duplicate]));
    dom.visible([...targets, duplicate]); await flush();
    assert.equal(calls.length, 4); assert.equal(peak, 4);
    for (let index = 0; index < 10; index++) { releases[index](); await flush(); }
    assert.equal(calls.length, 10); assert.equal(peak, 4);
    assert.equal(duplicate.holder.image.src, targets[0].holder.image.src);
    hydrator.destroy();
});

test('scroll visibility loads the end of a 217-item list without a 96-item cutoff', async () => {
    const dom = fixture(), calls = [];
    const hydrator = createIconHydrator({ ...dom, invoke: async (_, { path }) => { calls.push(path); return `icon:${path}`; } });
    const targets = Array.from({ length: 217 }, (_, index) => dom.target(`app-${index}`));
    hydrator.hydrate(dom.root(targets));
    assert.equal(dom.watched.size, 217);
    dom.visible(targets.slice(0, 10)); await flush(); await flush();
    assert.equal(calls.length, 10);
    assert.equal(targets.at(-1).dataset.iconLoaded, undefined);
    dom.visible(targets.slice(-12)); await flush(); await flush();
    assert.equal(targets.at(-1).dataset.iconLoaded, 'true');
    assert.equal(targets.at(-1).holder.image.src, 'icon:app-216');
    assert.equal(calls.length, 22);
    hydrator.destroy();
});

test('removed targets are not painted and queued invisible views do not extract icons', async () => {
    const dom = fixture(), calls = [], releases = [];
    const hydrator = createIconHydrator({ ...dom, invoke: (_, { path }) => {
        calls.push(path); return new Promise(resolve => releases.push(resolve));
    } });
    const targets = Array.from({ length: 8 }, (_, index) => dom.target(`app-${index}`));
    hydrator.hydrate(dom.root(targets)); dom.visible(targets); await flush();
    targets.forEach(target => { target.isConnected = false; });
    hydrator.hydrate(dom.root([]));
    releases.forEach(resolve => resolve('late-icon')); await flush();
    assert.equal(calls.length, 4);
    assert(targets.every(target => !target.holder.image));
    hydrator.destroy();
});

test('cached replacements reuse icons, external invalidation reloads, and teardown cancels painting', async () => {
    const dom = fixture(), cache = new Map([['cached', 'cached-icon']]), calls = [];
    let resolve;
    const hydrator = createIconHydrator({ ...dom, cache, invoke: (_, { path }) => {
        calls.push(path); return new Promise(done => { resolve = done; });
    } });
    const target = dom.target('cached');
    hydrator.hydrate(dom.root([target])); dom.visible([target]);
    assert.equal(target.holder.image.src, 'cached-icon'); assert.equal(calls.length, 0);
    cache.clear();
    const replacement = dom.target('cached');
    hydrator.hydrate(dom.root([replacement])); dom.visible([replacement]); await flush();
    assert.deepEqual(calls, ['cached']);
    hydrator.destroy(); resolve('late-icon'); await flush();
    assert.equal(replacement.holder.image, undefined);
    assert.equal(dom.watched.size, 0);
});
