const encoder = new TextEncoder();

export class Base64CodecError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'Base64CodecError';
        this.code = code;
    }
}

function assertUnicode(text) {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++index);
            if (next >= 0xdc00 && next <= 0xdfff) continue;
        } else if (code < 0xdc00 || code > 0xdfff) {
            continue;
        }
        throw new Base64CodecError('文本包含未配对的 Unicode 代理字符，请检查输入。', 'invalid-unicode');
    }
}

export function encodeBase64(text, { urlSafe = false, omitPadding = false } = {}) {
    assertUnicode(text);
    const bytes = encoder.encode(text);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    let result = btoa(binary);
    if (urlSafe) result = result.replaceAll('+', '-').replaceAll('/', '_');
    return omitPadding ? result.replace(/=+$/, '') : result;
}

export function decodeBase64(text, { urlSafe = false } = {}) {
    const compact = text.replace(/[\t\n\f\r ]/g, '');
    if (!compact) return '';
    const alphabet = urlSafe ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
    if (!alphabet.test(compact)) {
        throw new Base64CodecError(urlSafe
            ? 'URL-safe Base64 只允许字母、数字、-、_ 和末尾的 =。'
            : '标准 Base64 只允许字母、数字、+、/ 和末尾的 =；URL-safe 内容请启用对应选项。', 'invalid-alphabet');
    }
    const content = compact.replace(/=+$/, '');
    const padding = compact.length - content.length;
    const remainder = content.length % 4;
    if (!content || remainder === 1) {
        throw new Base64CodecError('Base64 长度无效；去掉填充后的长度除以 4 不能余 1。', 'invalid-length');
    }
    const expectedPadding = (4 - remainder) % 4;
    if (padding && (compact.length % 4 !== 0 || padding !== expectedPadding)) {
        throw new Base64CodecError('末尾填充无效；请使用完整的 = 填充，或全部省略。', 'invalid-padding');
    }
    const standard = content.replaceAll('-', '+').replaceAll('_', '/');
    let binary;
    try {
        binary = atob(standard + '='.repeat(expectedPadding));
    } catch {
        throw new Base64CodecError('无法解码此 Base64 内容，请检查字符和填充。', 'invalid-base64');
    }
    if (btoa(binary).replace(/=+$/, '') !== standard) {
        throw new Base64CodecError('Base64 末尾包含非零填充位，请检查内容是否完整。', 'invalid-padding-bits');
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    try {
        // Preserve a leading BOM as text instead of silently removing a character.
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new Base64CodecError('解码后的字节不是有效的 UTF-8 文本，无法显示为文字。', 'invalid-utf8');
    }
}

export function convertBase64(text, { mode = 'encode', ...options } = {}) {
    if (mode === 'encode') return encodeBase64(text, options);
    if (mode === 'decode') return decodeBase64(text, options);
    throw new Base64CodecError('请选择编码或解码方向。', 'invalid-mode');
}

export function getTextMetrics(text) {
    return { characters: Array.from(text).length, bytes: encoder.encode(text).length };
}
