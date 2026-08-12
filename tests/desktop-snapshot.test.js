import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDesktopSnapshot,
    desktopSnapshotFingerprint,
    readDesktopSnapshot,
    writeDesktopSnapshot
} from '../src/desktop-organizer/snapshot.js';

function file(name, overrides = {}) {
    return {
        name,
        path: `C:\\Users\\demo\\Desktop\\${name}`,
        category: 'document',
        is_folder: false,
        size: 1024,
        extension: 'txt',
        modified_time: 10,
        accessed_time: 20,
        children: null,
        children_truncated: false,
        icon: 'data:image/png;base64,large-icon',
        ...overrides
    };
}

function files(items = [file('notes.txt')]) {
    return {
        recent: items.slice(0, 1),
        documents: items,
        images: [],
        videos: [],
        audios: [],
        archives: [],
        programs: [],
        applications: [],
        folders: [],
        others: [],
        total_count: items.length
    };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

test('desktop snapshot round-trips a compact icon-free preview', () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 20);

    assert.equal(writeDesktopSnapshot(storage, files(), now), true);
    const restored = readDesktopSnapshot(storage, now + 1_000);

    assert.equal(restored.files.documents[0].name, 'notes.txt');
    assert.equal(restored.files.documents[0].icon, null);
    assert.equal(restored.files.total_count, 1);
    assert.equal(restored.capturedAt, now);
});

test('desktop snapshot rejects expired and malformed cache data', () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 20);
    const snapshot = createDesktopSnapshot(files(), now);
    storage.setItem('dtkit_desktop_snapshot_v1', JSON.stringify(snapshot));

    assert.equal(readDesktopSnapshot(storage, now + 8 * 24 * 60 * 60 * 1000), null);
    storage.setItem('dtkit_desktop_snapshot_v1', '{broken');
    assert.equal(readDesktopSnapshot(storage, now), null);
});

test('desktop fingerprint ignores scan order but detects metadata changes', () => {
    const alpha = file('alpha.txt');
    const beta = file('beta.txt', { modified_time: 11 });
    const first = files([alpha, beta]);
    const reordered = files([beta, alpha]);
    const changed = files([alpha, { ...beta, size: 2048 }]);

    assert.equal(desktopSnapshotFingerprint(first), desktopSnapshotFingerprint(reordered));
    assert.notEqual(desktopSnapshotFingerprint(first), desktopSnapshotFingerprint(changed));
});

test('application search entries survive snapshots without inflating desktop totals', () => {
    const indexedApp = file('Steam', {
        path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Steam\\Steam.lnk',
        category: 'program',
        extension: 'lnk',
        app_id: 'app-steam',
        app_manual: true
    });
    const source = files();
    source.applications = [indexedApp];
    const snapshot = createDesktopSnapshot(source);

    assert.equal(snapshot.files.applications.length, 1);
    assert.equal(snapshot.files.applications[0].app_id, 'app-steam');
    assert.equal(snapshot.files.applications[0].app_manual, true);
    assert.equal(snapshot.files.total_count, 1);
    assert.equal(snapshot.files.programs.length, 0);
});
