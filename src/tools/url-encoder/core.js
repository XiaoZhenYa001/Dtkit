export const URL_MODES = Object.freeze({
    COMPONENT: 'component',
    FULL: 'full'
});

export const URL_ACTIONS = Object.freeze({
    ENCODE: 'encode',
    DECODE: 'decode'
});

/**
 * URL 编解码的纯函数入口。
 * component 使用 encodeURIComponent，full 使用 encodeURI 并保留 URL 结构字符。
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
            return mode === URL_MODES.FULL ? encodeURI(input) : encodeURIComponent(input);
        }
        return mode === URL_MODES.FULL ? decodeURI(input) : decodeURIComponent(input);
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
