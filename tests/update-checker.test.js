import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    CURRENT_VERSION,
    LATEST_RELEASE_API,
    compareVersions,
    fetchLatestRelease,
    parseVersion
} from '../src/views/settings/update-checker.js';

test('release versions are parsed and compared as semantic numeric triples', () => {
    assert.deepEqual(parseVersion('v0.2.6'), [0, 2, 6]);
    assert.equal(compareVersions('v0.10.0', '0.2.6'), 1);
    assert.equal(compareVersions('0.2.6', CURRENT_VERSION), 0);
    assert.equal(compareVersions('v0.2.5', CURRENT_VERSION), -1);
    assert.equal(parseVersion('release-0.2.6'), null);
});

test('latest release lookup is on demand and validates GitHub response', async () => {
    let request;
    const release = await fetchLatestRelease(async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.3.0', name: 'DtKit 0.3.0' }) };
    });
    assert.equal(request.url, LATEST_RELEASE_API);
    assert.equal(request.options.cache, 'no-store');
    assert.deepEqual(release, { version: '0.3.0', name: 'DtKit 0.3.0' });
});

test('a repository without a published release is a supported state', async () => {
    const release = await fetchLatestRelease(async () => ({ ok: false, status: 404 }), 50);
    assert.equal(release, null);
});

test('application manifests and visible build information stay on v0.2.6', () => {
    const root = new URL('../', import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
    const tauriConfig = JSON.parse(fs.readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
    const cargo = fs.readFileSync(new URL('src-tauri/Cargo.toml', root), 'utf8');
    const html = fs.readFileSync(new URL('src/index.html', root), 'utf8');
    assert.equal(packageJson.version, '0.2.6');
    assert.equal(tauriConfig.version, '0.2.6');
    assert.match(cargo, /^version = "0\.2\.6"/m);
    assert.match(html, /v0\.2\.6/);
    assert.match(html, /Build 20260731/);
});
