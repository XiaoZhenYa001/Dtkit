import assert from 'node:assert/strict';
import test from 'node:test';

test('preview announces readiness after listening and shows accepted frames', async () => {
    const create = tag => ({ tag, className: '', textContent: '', hidden: false, children: [],
        classList: { values: [], add(value) { this.values.push(value); } },
        append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); },
        scrollHeight: 750, scrollWidth: 900, scrollTop: 0, scrollLeft: 0 });
    const root = create('div'), status = create('span'), calls = [];
    root.append(status);
    globalThis.document = { querySelector: () => root, getElementById: () => status, createElement: create };
    globalThis.location = { href: 'http://localhost/long-capture-border.html?mode=manual&direction=horizontal&session=abc' };
    globalThis.addEventListener = () => {};
    let receive;
    globalThis.window = { __TAURI__: { event: {
        async listen(name, callback) { calls.push(name); receive = callback; return () => {}; },
        async emit(name, payload) { calls.push([name, payload]); },
    } } };
    await import('../src/long-capture-border/main.js');
    assert.deepEqual(calls, ['screen-long-progress', ['screen-long-preview-ready', { session: 'abc' }]]);
    assert.ok(root.classList.values.includes('is-horizontal'));
    const frame = root.children.find(item => item.className === 'long-capture-preview__frame');
    const image = frame.children.find(item => item.tag === 'img');
    const dimensions = root.children.find(item => item.className === 'long-capture-preview__dimensions');
    receive({ payload: { message: '已采集 2 段', dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 400, segments: 2 } });
    assert.equal(status.textContent, '已采集 2 段');
    assert.equal(image.src, 'data:image/png;base64,AAAA');
    assert.equal(image.hidden, false);
    assert.equal(dimensions.textContent, '800 × 400 px · 2 段');
    image.onload();
    assert.equal(frame.scrollLeft, 900);
    receive({ payload: { message: '等待画面稳定', dataUrl: 'https://invalid.example/image' } });
    assert.equal(status.textContent, '等待画面稳定');
    assert.equal(image.src, 'data:image/png;base64,AAAA');
});
