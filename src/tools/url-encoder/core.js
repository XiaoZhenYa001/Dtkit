export const URL_MODES = Object.freeze({
    COMPONENT: 'component',
    FULL: 'full',
    FORM: 'form'
});

export const URL_ACTIONS = Object.freeze({
    ENCODE: 'encode',
    DECODE: 'decode'
});

/**
 * URL 编解码的纯函数入口。
 * form 处理单个表单参数值（空格为 +），不是整段键值对。
 */
export function transformUrl(value, action, mode = URL_MODES.COMPONENT) {
    const input = String(value ?? '');

    if (!Object.values(URL_ACTIONS).includes(action)) {
        throw new TypeError(`不支持的操作: ${action}`);
    }
    if (!Object.values(URL_MODES).includes(mode)) {
        throw new TypeError(`不支持的编码模式: ${mode}`);
    }

    try {
        if (action === URL_ACTIONS.ENCODE) {
            if (mode === URL_MODES.FORM) {
                return encodeURIComponent(input).replace(/[!'()~]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
            }
            return mode === URL_MODES.FULL ? encodeURI(input) : encodeURIComponent(input);
        }
        return mode === URL_MODES.FULL ? decodeURI(input) : decodeURIComponent(mode === URL_MODES.FORM ? input.replace(/\+/g, ' ') : input);
    } catch (error) {
        if (error instanceof URIError) {
            const message = action === URL_ACTIONS.DECODE
                ? '输入包含不完整或无效的百分号编码'
                : '输入包含无法编码的 Unicode 字符';
            throw new URIError(message);
        }
        throw error;
    }
}

export const URL_LIMITS = Object.freeze({ characters: 1_048_576, lines: 1000, parameters: 500 });

function checkInputSize(input) {
    if (input.length > URL_LIMITS.characters) throw new RangeError('内容过大，请控制在 1,048,576 字符以内');
}

/** Keep output positions intact; errors live separately and never enter copyable text. */
export function transformUrlBatch(value, action, mode = URL_MODES.COMPONENT, { perLine = false } = {}) {
    const input = String(value ?? '');
    checkInputSize(input);
    const lines = perLine ? input.split(/\r\n|\r|\n/) : [input];
    if (lines.length > URL_LIMITS.lines) throw new RangeError(`逐行处理最多支持 ${URL_LIMITS.lines} 行`);
    const errors = [];
    const output = lines.map((line, index) => {
        try { return transformUrl(line, action, mode); }
        catch (error) {
            if (!(error instanceof URIError)) throw error;
            errors.push({ line: index + 1, message: error.message });
            return '';
        }
    });
    return { output: errors.length ? '' : output.join('\n'), errors, lines: lines.length };
}

/**
 * Inspect the query as written, without URL's normalisation or forgiving UTF-8 replacement.
 * Form semantics apply to each key/value. Duplicate keys and whether '=' appeared are retained.
 */
export function inspectUrlQuery(value) {
    const input = String(value ?? '');
    checkInputSize(input);
    if (/[\r\n]/.test(input)) throw new TypeError('参数查看一次只支持一个 URL 或一段查询串');
    const hash = input.indexOf('#');
    const fragment = hash < 0 ? '' : input.slice(hash + 1);
    const beforeHash = hash < 0 ? input : input.slice(0, hash);
    const question = beforeHash.indexOf('?');
    const isUrl = /^[a-z][a-z\d+.-]*:/i.test(beforeHash) || beforeHash.startsWith('/');
    const isRelativeUrl = question >= 0 && !/[=&]/.test(beforeHash.slice(0, question));
    const query = beforeHash.startsWith('?') || isUrl || isRelativeUrl
        ? question >= 0 ? beforeHash.slice(question + 1) : ''
        : beforeHash;
    const parts = query.split('&').filter(part => part !== '');
    if (parts.length > URL_LIMITS.parameters) throw new RangeError(`参数查看最多支持 ${URL_LIMITS.parameters} 项`);
    const rows = parts.map((part, index) => {
        const equals = part.indexOf('=');
        const rawName = equals < 0 ? part : part.slice(0, equals);
        const rawValue = equals < 0 ? '' : part.slice(equals + 1);
        let name = rawName;
        let decodedValue = rawValue;
        const errors = [];
        try { name = transformUrl(rawName, URL_ACTIONS.DECODE, URL_MODES.FORM); }
        catch (error) { errors.push(`名称：${error.message}`); }
        try { decodedValue = transformUrl(rawValue, URL_ACTIONS.DECODE, URL_MODES.FORM); }
        catch (error) { errors.push(`值：${error.message}`); }
        return { index: index + 1, name, value: decodedValue, rawName, rawValue, hasEquals: equals >= 0, errors };
    });
    return { query, fragment, hasFragment: hash >= 0, rows, valid: rows.every(row => row.errors.length === 0) };
}
