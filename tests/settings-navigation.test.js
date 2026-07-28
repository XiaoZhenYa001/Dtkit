import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

test('settings navigation fallback order matches the real settings section order', () => {
    const nav = html.match(/<nav class="settings-side-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    const panels = html.match(/<div class="settings-panels">[\s\S]*?<div class="settings-footer">/)?.[0] || '';
    const linkOrder = [...nav.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
    const sectionOrder = [...panels.matchAll(/<section class="settings-section[^"]*" id="([^"]+)"/g)]
        .map(match => match[1]);
    assert.deepEqual(linkOrder, sectionOrder);
});

test('every settings section provides navigation metadata', () => {
    const sections = [...html.matchAll(/<section class="settings-section[^>]+>/g)].map(match => match[0]);
    assert.ok(sections.length >= 5);
    for (const section of sections) {
        assert.match(section, /data-settings-nav-label="[^"]+"/);
        assert.match(section, /data-settings-nav-icon="[^"]+"/);
    }
});
