export const HASH_ALGORITHMS = Object.freeze([
    Object.freeze({ id: 'md5', label: 'MD5', length: 32, webCrypto: null }),
    Object.freeze({ id: 'sha1', label: 'SHA-1', length: 40, webCrypto: 'SHA-1' }),
    Object.freeze({ id: 'sha256', label: 'SHA-256', length: 64, webCrypto: 'SHA-256' }),
    Object.freeze({ id: 'sha512', label: 'SHA-512', length: 128, webCrypto: 'SHA-512' })
]);

const algorithmById = new Map(HASH_ALGORITHMS.map(algorithm => [algorithm.id, algorithm]));
const encoder = new TextEncoder();
const md5Shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const md5Constants = Uint32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000));

function requireBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('摘要输入必须是 Uint8Array 字节数据');
    return bytes;
}

function requireAlgorithms(algorithms) {
    if (!Array.isArray(algorithms) || algorithms.length === 0) throw new Error('请至少选择一种摘要算法');
    if (new Set(algorithms).size !== algorithms.length) throw new Error('摘要算法不能重复');
    for (const id of algorithms) {
        if (!algorithmById.has(id)) throw new Error(`不支持的摘要算法：${String(id)}`);
    }
    return algorithms;
}

function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** MD5 consumes full blocks directly; only the final padded block needs a copy. */
export function md5Bytes(input) {
    const bytes = requireBytes(input);
    const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    const words = new Uint32Array(16);

    function consume(block, offset) {
        for (let index = 0; index < 16; index += 1) {
            const position = offset + index * 4;
            words[index] = block[position] | (block[position + 1] << 8) | (block[position + 2] << 16) | (block[position + 3] << 24);
        }
        let [a, b, c, d] = state;
        for (let index = 0; index < 64; index += 1) {
            let mixed;
            let wordIndex;
            if (index < 16) {
                mixed = (b & c) | (~b & d);
                wordIndex = index;
            } else if (index < 32) {
                mixed = (d & b) | (~d & c);
                wordIndex = (5 * index + 1) % 16;
            } else if (index < 48) {
                mixed = b ^ c ^ d;
                wordIndex = (3 * index + 5) % 16;
            } else {
                mixed = c ^ (b | ~d);
                wordIndex = (7 * index) % 16;
            }
            const value = (a + mixed + md5Constants[index] + words[wordIndex]) | 0;
            const shift = md5Shifts[index];
            const previousD = d;
            d = c;
            c = b;
            b = (b + ((value << shift) | (value >>> (32 - shift)))) | 0;
            a = previousD;
        }
        state[0] += a;
        state[1] += b;
        state[2] += c;
        state[3] += d;
    }

    const completeLength = bytes.length - bytes.length % 64;
    for (let offset = 0; offset < completeLength; offset += 64) consume(bytes, offset);
    const remainderLength = bytes.length - completeLength;
    const tail = new Uint8Array(remainderLength < 56 ? 64 : 128);
    tail.set(bytes.subarray(completeLength));
    tail[remainderLength] = 0x80;
    const tailView = new DataView(tail.buffer);
    tailView.setUint32(tail.length - 8, (bytes.length * 8) >>> 0, true);
    tailView.setUint32(tail.length - 4, Math.floor(bytes.length / 0x20000000) >>> 0, true);
    for (let offset = 0; offset < tail.length; offset += 64) consume(tail, offset);

    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    state.forEach((word, index) => digestView.setUint32(index * 4, word, true));
    return bytesToHex(digest);
}

/** Reject partial or malformed native/worker results before displaying success. */
export function validateHashResults(results, algorithms) {
    const requested = requireAlgorithms(algorithms);
    if (!results || typeof results !== 'object' || Array.isArray(results)) throw new Error('摘要计算返回了无效结果');
    const keys = Object.keys(results);
    if (keys.length !== requested.length || keys.some(key => !requested.includes(key))) throw new Error('摘要计算结果不完整');
    const canonical = {};
    for (const id of requested) {
        const value = results[id];
        const algorithm = algorithmById.get(id);
        if (!Object.hasOwn(results, id) || typeof value !== 'string' || value.length !== algorithm.length || !/^[0-9a-f]+$/i.test(value)) {
            throw new Error(`${algorithm.label} 摘要无效，请重新计算`);
        }
        canonical[id] = value.toLowerCase();
    }
    return canonical;
}

export async function hashBytes(input, algorithms) {
    const bytes = requireBytes(input);
    const requested = [...requireAlgorithms(algorithms)];
    if (requested.some(id => algorithmById.get(id).webCrypto) && !globalThis.crypto?.subtle) {
        throw new Error('当前环境不支持 SHA 摘要计算，请在应用中打开或使用安全连接');
    }
    const entries = await Promise.all(requested.map(async id => {
        const algorithm = algorithmById.get(id);
        if (id === 'md5') return [id, md5Bytes(bytes)];
        const digest = await globalThis.crypto.subtle.digest(algorithm.webCrypto, bytes);
        return [id, bytesToHex(new Uint8Array(digest))];
    }));
    return validateHashResults(Object.fromEntries(entries), requested);
}

export function textByteLength(text) {
    if (typeof text !== 'string') throw new TypeError('摘要文本必须是字符串');
    return encoder.encode(text).length;
}

export function formatHashBytes(size) {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '—';
    if (size < 1024) return `${Math.floor(size)} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let value = size / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${Number(value.toFixed(value < 10 ? 2 : 1))} ${units[unitIndex]}`;
}

export function inspectHashVerification(input, results, valid = true) {
    const expected = typeof input === 'string' ? input.trim() : '';
    if (!expected) return { tone: 'neutral', message: '粘贴摘要，与计算结果进行校验' };
    if (!/^[0-9a-f]+$/i.test(expected)) return { tone: 'error', message: '请输入有效的十六进制摘要' };
    const algorithm = HASH_ALGORITHMS.find(item => item.length === expected.length);
    if (!algorithm) return { tone: 'error', message: '摘要长度应为 32、40、64 或 128 位' };
    if (!valid) return { tone: 'neutral', message: '输入已更改，请重新计算摘要后校验' };
    const resultKeys = results && typeof results === 'object' && !Array.isArray(results) ? Object.keys(results) : [];
    if (!resultKeys.length) return { tone: 'neutral', message: '请先计算摘要再校验' };
    let canonical;
    try {
        canonical = validateHashResults(results, resultKeys);
    } catch {
        return { tone: 'neutral', message: '请先计算有效的摘要再校验' };
    }
    if (!Object.hasOwn(canonical, algorithm.id)) return { tone: 'neutral', message: `当前结果未包含 ${algorithm.label}，请选择该算法并重新计算` };
    if (canonical[algorithm.id] !== expected.toLowerCase()) return { tone: 'error', message: `与当前 ${algorithm.label} 摘要不匹配` };
    return { tone: 'success', message: `与 ${algorithm.label} 摘要一致`, matchedAlgorithm: algorithm.id };
}
