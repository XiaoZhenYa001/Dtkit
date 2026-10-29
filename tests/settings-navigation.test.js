import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { activeSettingsSection } from '../src/views/settings/navigation.js';
import { parseSettingsMotionTiming } from '../src/views/settings/motion.js';

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

test('active settings follows every section position instead of the last observer callback subset', () => {
    const sections = [{ id: 'storage', top: -1400 }, { id: 'shortcuts', top: -100 }, { id: 'tools', top: 160 }, { id: 'general', top: 900 }];
    assert.equal(activeSettingsSection(sections, 80), 'shortcuts');
    assert.equal(activeSettingsSection(sections, 180), 'tools');
    assert.equal(activeSettingsSection(sections, -1600), 'storage');
    assert.equal(activeSettingsSection(sections, 80, true), 'general');
    assert.equal(activeSettingsSection([], 80), null);
});

test('settings motion reuses application transition tokens and bounds duration', () => {
    assert.deepEqual(parseSettingsMotionTiming('180ms cubic-bezier(0.22, 1, 0.36, 1)'),
        { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    assert.deepEqual(parseSettingsMotionTiming('0.24s ease-out'), { duration: 240, easing: 'ease-out' });
    assert.equal(parseSettingsMotionTiming('2s linear').duration, 300);
    assert.equal(parseSettingsMotionTiming('.ms ease').duration, 240);
    assert.equal(parseSettingsMotionTiming('').duration, 240);
});
