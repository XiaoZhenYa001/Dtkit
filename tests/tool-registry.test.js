import assert from 'node:assert/strict';
import test from 'node:test';

import { toolManifests } from '../src/tools/index.js';
import {
    getAllTools,
    getTool,
    isToolLoaded,
    loadTool,
    registerTool,
    registerToolManifest
} from '../src/tools/toolRegistry.js';

test('startup registers metadata without loading tool implementations', () => {
    assert.equal(toolManifests.length, 20);
    assert.equal(new Set(toolManifests.map(tool => tool.id)).size, toolManifests.length);
    assert.equal(getAllTools().length, toolManifests.length);
    assert.ok(toolManifests.every(tool => !isToolLoaded(tool.id)));
    assert.deepEqual(
        toolManifests.filter(tool => tool.status === 'planned').map(tool => tool.id),
        ['image-compressor', 'favicon-generator']
    );
    assert.equal(toolManifests.filter(tool => tool.status === 'ready').length, 18);
});

test('planned tools are blocked before their loader runs', async () => {
    registerToolManifest({
        id: 'test-planned-tool',
        name: '计划中工具',
        category: 'other',
        status: 'planned'
    });

    await assert.rejects(loadTool('test-planned-tool'), /工具尚未开放/);
    assert.equal(getTool('test-planned-tool').status, 'planned');
});

test('concurrent load requests share one dynamic import', async () => {
    let loadCount = 0;
    registerToolManifest({
        id: 'test-concurrent-loader',
        name: '并发加载测试',
        category: 'other',
        loader: async () => {
            loadCount += 1;
            await Promise.resolve();
            registerTool({
                id: 'test-concurrent-loader',
                name: '并发加载测试',
                category: 'other',
                init() {}
            });
        }
    });

    const [first, second] = await Promise.all([
        loadTool('test-concurrent-loader'),
        loadTool('test-concurrent-loader')
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first, second);
    assert.equal(isToolLoaded('test-concurrent-loader'), true);
    assert.equal(getTool('test-concurrent-loader').status, 'ready');
});

test('a failed loader can be retried', async () => {
    let loadCount = 0;
    registerToolManifest({
        id: 'test-retry-loader',
        name: '重试加载测试',
        category: 'other',
        loader: async () => {
            loadCount += 1;
            if (loadCount === 1) throw new Error('temporary failure');
            registerTool({
                id: 'test-retry-loader',
                name: '重试加载测试',
                category: 'other',
                init() {}
            });
        }
    });

    await assert.rejects(loadTool('test-retry-loader'), /temporary failure/);
    await assert.doesNotReject(loadTool('test-retry-loader'));
    assert.equal(loadCount, 2);
});
