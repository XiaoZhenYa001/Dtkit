/**
 * Color values use byte RGB channels and a floating-point alpha in [0, 1].
 * Parsing follows CSS channel clamping; it never accepts a partial expression.
 * HSV and HSL saturation/value/lightness are percentages, hue is degrees.
 */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const byte = value => Math.round(clamp(value, 0, 255));
const hue = value => ((value % 360) + 360) % 360;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
const numeric = new RegExp(`^(${NUMBER})(%)?$`, 'i');
const angle = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)?$`, 'i');
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function channel(token, maximum) {
    const match = numeric.exec(token);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) ? clamp(match[2] ? number * maximum / 100 : number, 0, maximum) : null;
}

function percent(token) {
    const match = numeric.exec(token);
    return match?.[2] && Number.isFinite(Number(match[1])) ? clamp(Number(match[1]), 0, 100) : null;
}

function angleDegrees(token) {
    const match = angle.exec(token);
    if (!match || !Number.isFinite(Number(match[1]))) return null;
    const number = Number(match[1]);
    const factor = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[match[2]?.toLowerCase() || 'deg'];
    const degrees = number * factor;
    return Number.isFinite(degrees) ? hue(degrees) : null;
}

function functionChannels(body) {
    if (body.includes(',')) {
        if (body.includes('/')) return null;
        const parts = body.split(',').map(part => part.trim());
        return (parts.length === 3 || parts.length === 4) && parts.every(Boolean) ? parts : null;
    }
    const parts = body.split('/');
    if (parts.length > 2) return null;
    const values = parts[0].trim().split(/\s+/);
    if (values.length !== 3) return null;
    if (parts.length === 2) {
        const alpha = parts[1].trim();
        if (!alpha || /\s/.test(alpha)) return null;
        values.push(alpha);
    }
    return values;
}

export function parseColor(text) {
    if (typeof text !== 'string' || text.length > 256) return null;
    const input = text.trim();
    if (input.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const hex = /^#?([a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(input);
    if (hex) {
        const value = hex[1].length <= 4 ? [...hex[1]].map(char => char + char).join('') : hex[1];
        return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16), a: value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1 };
    }
    const expression = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(input);
    if (!expression) return null;
    const parts = functionChannels(expression[2]);
    if (!parts) return null;
    const alpha = parts.length === 4 ? channel(parts[3], 1) : 1;
    if (alpha === null) return null;
    if (expression[1].toLowerCase().startsWith('rgb')) {
        const channels = parts.slice(0, 3).map(part => channel(part, 255));
        if (channels.includes(null)) return null;
        return { r: byte(channels[0]), g: byte(channels[1]), b: byte(channels[2]), a: alpha };
    }
    const h = angleDegrees(parts[0]); const s = percent(parts[1]); const l = percent(parts[2]);
    return h === null || s === null || l === null ? null : hslToRgb(h, s, l, alpha);
}

function normalizedColor(color) {
    if (typeof color === 'string') return parseColor(color);
    if (!color || typeof color !== 'object' || Array.isArray(color)) return null;
    const { r, g, b, a = 1 } = color;
    if (![r, g, b, a].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}

function requiredColor(color) {
    const value = normalizedColor(color);
    if (!value) throw new TypeError('无效的颜色');
    return value;
}

const decimal = (value, precision = 3) => String(Number(value.toFixed(precision)));
const hexByte = value => byte(value).toString(16).padStart(2, '0').toUpperCase();

export function formatColor(color, format = 'hex') {
    const value = requiredColor(color);
    const { a } = value; const [r, g, b] = [value.r, value.g, value.b].map(byte);
    if (format === 'hex' || format === 'hex8') return '#' + [r, g, b, ...(format === 'hex8' || a < 1 ? [a * 255] : [])].map(hexByte).join('');
    if (format === 'rgba' || (format === 'rgb' && a < 1)) return `rgba(${r}, ${g}, ${b}, ${decimal(a, 6)})`;
    if (format === 'rgb') return `rgb(${r}, ${g}, ${b})`;
    if (format === 'hsl') {
        const converted = rgbToHsl(value);
        const body = `${decimal(converted.h)}, ${decimal(converted.s)}%, ${decimal(converted.l)}%`;
        return a < 1 ? `hsla(${body}, ${decimal(a, 6)})` : `hsl(${body})`;
    }
    throw new TypeError('不支持的颜色格式');
}

function rgbArguments(color, g, b) {
    return requiredColor(typeof color === 'number' ? { r: color, g, b } : color);
}

export function rgbToHsv(color, g, b) {
    const value = rgbArguments(color, g, b);
    const [r, green, blue] = [value.r, value.g, value.b].map(component => component / 255);
    const max = Math.max(r, green, blue); const min = Math.min(r, green, blue); const difference = max - min;
    let h = 0;
    if (difference) {
        if (max === r) h = ((green - blue) / difference) % 6;
        else if (max === green) h = (blue - r) / difference + 2;
        else h = (r - green) / difference + 4;
        h = hue(h * 60);
    }
    return { h, s: max ? difference / max * 100 : 0, v: max * 100 };
}

function cylindricalArguments(h, s, level, a, levelKey) {
    if (h && typeof h === 'object') ({ h, s, [levelKey]: level, a = 1 } = h);
    if (![h, s, level, a].every(value => typeof value === 'number' && Number.isFinite(value))) throw new TypeError('无效的颜色通道');
    return { h: hue(h), s: clamp(s, 0, 100) / 100, level: clamp(level, 0, 100) / 100, a: clamp(a, 0, 1) };
}

function chromaRgb(h, chroma, minimum, a) {
    const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const segments = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
    const values = segments[Math.floor(h / 60)];
    return { r: byte((values[0] + minimum) * 255), g: byte((values[1] + minimum) * 255), b: byte((values[2] + minimum) * 255), a };
}

export function hsvToRgb(h, s, v, a = 1) {
    const value = cylindricalArguments(h, s, v, a, 'v');
    const chroma = value.level * value.s;
    return chromaRgb(value.h, chroma, value.level - chroma, value.a);
}

export function rgbToHsl(color, g, b) {
    const value = rgbArguments(color, g, b);
    const hsv = rgbToHsv(value);
    const min = Math.min(value.r, value.g, value.b) / 255; const max = Math.max(value.r, value.g, value.b) / 255;
    const l = (min + max) / 2; const difference = max - min;
    return { h: hsv.h, s: difference ? difference / (1 - Math.abs(2 * l - 1)) * 100 : 0, l: l * 100 };
}

export function hslToRgb(h, s, l, a = 1) {
    const value = cylindricalArguments(h, s, l, a, 'l');
    const chroma = (1 - Math.abs(2 * value.level - 1)) * value.s;
    return chromaRgb(value.h, chroma, value.level - chroma / 2, value.a);
}

/** Straight-alpha source-over compositing in the displayed sRGB color space. */
export function compositeColors(foreground, background = WHITE) {
    const fg = requiredColor(foreground); const bg = requiredColor(background);
    const a = fg.a + bg.a * (1 - fg.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    // Keep fractional display channels until luminance calculation, not byte rounding.
    const component = key => (fg[key] * fg.a + bg[key] * bg.a * (1 - fg.a)) / a;
    return { r: component('r'), g: component('g'), b: component('b'), a };
}

function luminance(color) {
    const linear = channelValue => {
        const value = channelValue / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return linear(color.r) * 0.2126 + linear(color.g) * 0.7152 + linear(color.b) * 0.0722;
}

/** WCAG 2.2 G18: https://www.w3.org/WAI/WCAG22/Techniques/general/G18 */
export function contrastRatio(foreground, background = WHITE) {
    const bg = compositeColors(background, WHITE);
    const fg = compositeColors(foreground, bg);
    const a = luminance(fg); const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function shadeColors(color, count = 9) {
    const value = requiredColor(color); const hsl = rgbToHsl(value);
    const size = Number.isFinite(count) ? clamp(Math.trunc(count), 1, 32) : 9;
    return Array.from({ length: size }, (_, index) => hslToRgb(hsl.h, hsl.s, size === 1 ? hsl.l : 95 - index / (size - 1) * 90, value.a));
}

export function sanitizeColorList(colors, max = 12) {
    if (!Array.isArray(colors)) return [];
    const limit = Number.isFinite(max) ? clamp(Math.trunc(max), 0, 256) : 12;
    const seen = new Set(); const result = [];
    for (const item of colors.slice(0, 4096)) {
        if (result.length >= limit) break;
        const color = normalizedColor(item);
        if (!color) continue;
        const text = formatColor(color);
        if (!seen.has(text)) { seen.add(text); result.push(text); }
    }
    return result;
}

const colorDistance = (first, second) => (first.r - second.r) ** 2 + (first.g - second.g) ** 2 + (first.b - second.b) ** 2;

/**
 * Deterministic alpha-weighted palette. At most 65,536 stratified pixel samples,
 * 32,768 occupied RGB bins and 8 clustering passes keep large images bounded.
 * Transparent pixels contribute no color, partially transparent pixels contribute
 * their unflattened RGB in proportion to alpha, preserving saturated colors.
 */
export function extractPalette(pixels, width, height, count = 6) {
    if (!pixels || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height) || pixels.length < width * height * 4) return [];
    const size = Number.isFinite(count) ? clamp(Math.trunc(count), 1, 12) : 6;
    const budget = 65536; const total = width * height;
    const samplesX = total <= budget ? width : Math.min(width, budget, Math.max(1, Math.floor(Math.sqrt(budget * width / height))));
    const samplesY = total <= budget ? height : Math.min(height, Math.max(1, Math.floor(budget / samplesX)));
    const bins = new Map();
    for (let y = 0; y < samplesY; y++) for (let x = 0; x < samplesX; x++) {
        // Jitter inside each stratum avoids repeated stripe/checkerboard aliasing.
        const seed = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0);
        const px = total <= budget ? x : Math.min(width - 1, Math.floor((x + (seed % 1024) / 1024) * width / samplesX));
        const py = total <= budget ? y : Math.min(height - 1, Math.floor((y + ((seed >>> 10) % 1024) / 1024) * height / samplesY));
        const offset = (py * width + px) * 4;
        const [r, g, b, alpha] = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
        if (![r, g, b, alpha].every(value => typeof value === 'number' && Number.isFinite(value)) || alpha <= 0) continue;
        const [red, green, blue] = [byte(r), byte(g), byte(b)]; const weight = clamp(alpha, 0, 255) / 255;
        const key = (red >> 3) * 1024 + (green >> 3) * 32 + (blue >> 3);
        let bin = bins.get(key);
        if (!bin) { bin = { r: 0, g: 0, b: 0, weight: 0, key }; bins.set(key, bin); }
        bin.r += red * weight; bin.g += green * weight; bin.b += blue * weight; bin.weight += weight;
    }
    const points = [...bins.values()].map(point => ({ ...point, r: point.r / point.weight, g: point.g / point.weight, b: point.b / point.weight })).sort((a, b) => b.weight - a.weight || a.key - b.key);
    if (!points.length) return [];
    const sumWeight = points.reduce((sum, point) => sum + point.weight, 0);
    const centers = [{ ...points[0] }];
    while (centers.length < Math.min(size, points.length)) {
        let candidate = null; let highest = 0;
        for (const point of points) {
            const distance = Math.min(...centers.map(center => colorDistance(point, center)));
            const score = distance * Math.sqrt(point.weight / sumWeight);
            if (score > highest) { highest = score; candidate = point; }
        }
        if (!candidate) break;
        centers.push({ ...candidate });
    }
    let groups = [];
    for (let iteration = 0; iteration < 8; iteration++) {
        groups = centers.map(() => ({ r: 0, g: 0, b: 0, weight: 0 }));
        for (const point of points) {
            let closest = 0; let distance = Infinity;
            for (let index = 0; index < centers.length; index++) {
                const value = colorDistance(point, centers[index]);
                if (value < distance) { distance = value; closest = index; }
            }
            const group = groups[closest]; group.weight += point.weight;
            group.r += point.r * point.weight; group.g += point.g * point.weight; group.b += point.b * point.weight;
        }
        let difference = 0;
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index];
            if (!group.weight) continue;
            const center = { r: group.r / group.weight, g: group.g / group.weight, b: group.b / group.weight };
            difference += colorDistance(center, centers[index]); centers[index] = center;
        }
        if (difference < 0.01) break;
    }
    const unique = new Map();
    for (const group of groups) {
        if (!group.weight) continue;
        const color = { r: byte(group.r / group.weight), g: byte(group.g / group.weight), b: byte(group.b / group.weight), a: 1 };
        const key = formatColor(color); const prior = unique.get(key);
        if (prior) prior.weight += group.weight / sumWeight;
        else unique.set(key, { color, weight: group.weight / sumWeight });
    }
    return [...unique.values()].sort((a, b) => {
        if (a.weight !== b.weight) return b.weight - a.weight;
        const first = formatColor(a.color); const second = formatColor(b.color);
        return first < second ? -1 : first > second ? 1 : 0;
    });
}

export function paletteText(colors, format = 'css') {
    const list = sanitizeColorList(Array.isArray(colors) ? colors.map(item => item?.color ?? item) : [], 256);
    if (format === 'json') return JSON.stringify(list, null, 2);
    if (format === 'text') return list.join('\n');
    if (format === 'css') return `:root {\n${list.map((color, index) => `  --color-${index + 1}: ${color};`).join('\n')}\n}`;
    throw new TypeError('不支持的调色板格式');
}
