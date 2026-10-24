import { extractPalette } from './core.js';

self.onmessage = event => {
    const { id, pixels, width, height, count } = event.data;
    try { self.postMessage({ id, palette: extractPalette(new Uint8ClampedArray(pixels), width, height, count) }); }
    catch (error) { self.postMessage({ id, error: error?.message || String(error) }); }
};
