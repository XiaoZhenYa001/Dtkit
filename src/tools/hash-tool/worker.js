import { hashBytes } from './core.js';

self.addEventListener('message', async event => {
    const { id, text, bytes, algorithms } = event.data || {};
    try {
        if ((typeof text === 'string') === (bytes instanceof ArrayBuffer)) throw new Error('请选择文本或文件字节进行计算');
        const input = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(bytes);
        const results = await hashBytes(input, algorithms);
        self.postMessage({ id, results });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : '摘要计算失败' });
    }
});
