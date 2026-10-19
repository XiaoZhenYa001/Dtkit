export const DEFAULT_STYLE = Object.freeze({
    size: 320, dots: 'rounded', corners: 'extra-rounded', foreground: '#1d1d1f', background: '#ffffff'
});

export function normalizeStyle(value = {}) {
    const color = (input, fallback) => /^#[0-9a-f]{6}$/i.test(input || '') ? input.toLowerCase() : fallback;
    return {
        size: typeof value.size === 'number' && Number.isFinite(value.size)
            ? Math.max(180, Math.min(720, Math.round(value.size / 20) * 20)) : DEFAULT_STYLE.size,
        dots: ['rounded', 'dots', 'square', 'classy'].includes(value.dots) ? value.dots : DEFAULT_STYLE.dots,
        corners: ['extra-rounded', 'dot', 'square'].includes(value.corners) ? value.corners : DEFAULT_STYLE.corners,
        foreground: color(value.foreground, DEFAULT_STYLE.foreground),
        background: color(value.background, DEFAULT_STYLE.background)
    };
}

export function relativeLuminance(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('请选择有效的六位颜色值。');
    const channels = hex.slice(1).match(/../g).map(value => {
        const channel = Number.parseInt(value, 16) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

export function contrastRatio(foreground, background) {
    const first = relativeLuminance(foreground), second = relativeLuminance(background);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

export function payloadMetrics(text) {
    return { characters: Array.from(text).length, bytes: new TextEncoder().encode(text).length };
}

export function validateQrPayload(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请先输入需要生成二维码的内容。');
    if (text.length > 4000) throw new Error('内容超过 4000 字符，请精简后再生成。');
    for (const character of text) {
        const point = character.codePointAt(0);
        if (point >= 0xd800 && point <= 0xdfff) throw new Error('内容包含不完整的 Unicode 字符，请检查输入。');
    }
    return text;
}

export function applyQrPrefix(text, prefix) {
    if (!['', 'mailto:', 'tel:'].includes(prefix)) throw new Error('请选择有效的内容类型。');
    return prefix + text.replace(/^(mailto:|tel:)/i, '');
}

export function createQrFilename(format) {
    if (!['png', 'svg'].includes(format)) throw new Error('请选择 PNG 或 SVG 格式。');
    return `qrcode-${crypto.randomUUID()}.${format}`;
}
