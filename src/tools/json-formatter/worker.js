import { convertData, serializeConversionError } from './core.js';

self.addEventListener('message', event => {
    const { id, request } = event.data || {};
    try {
        self.postMessage({ id, ok: true, result: convertData(request) });
    } catch (error) {
        self.postMessage({ id, ok: false, error: serializeConversionError(error) });
    }
});
