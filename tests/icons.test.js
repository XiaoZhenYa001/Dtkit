import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve('src');
const upstreamCssPath = resolve('src/assets/remixicon.css');
const subsetCssPath = resolve('src/assets/remixicon-subset.css');
const sourceExtensions = new Set(['.css', '.html', '.js']);
const iconReference = /\bri-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const iconDefinition = /\.([a-z0-9-]+):before\s*\{/g;

function collectFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectFiles(path);
        return sourceExtensions.has(extname(entry.name)) ? [resolve(path)] : [];
    });
}

function collectDefinitions(cssPath) {
    return new Set([...readFileSync(cssPath, 'utf8').matchAll(iconDefinition)].map(match => match[1]));
}

test('Remix Icon subset covers every complete icon class used by the application', () => {
    const upstreamDefinitions = collectDefinitions(upstreamCssPath);
    const subsetDefinitions = collectDefinitions(subsetCssPath);
    const referencedIcons = new Set();

    for (const path of collectFiles(sourceRoot)) {
        if (path === upstreamCssPath || path === subsetCssPath) continue;
        const references = readFileSync(path, 'utf8').match(iconReference) || [];
        references.forEach(name => {
            if (upstreamDefinitions.has(name)) referencedIcons.add(name);
        });
    }

    const missing = [...referencedIcons].filter(name => !subsetDefinitions.has(name));
    assert.deepEqual(missing, [], `Regenerate the icon subset; missing: ${missing.join(', ')}`);
    assert.ok(subsetDefinitions.size < upstreamDefinitions.size / 10);
});
