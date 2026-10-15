export const COLOR_HEX = { blue: '#aac7ed', green: '#b5d5a9', purple: '#cbb5e5', orange: '#e9c69b', rose: '#e9b1c5', cyan: '#a6d7d2' };
const palettes = { blue: ['#e0ebf8', '#365e8d', '#bfd2e9'], green: ['#e2eedf', '#4a7143', '#c1d8ba'], purple: ['#ebe3f6', '#725490', '#d6c4e7'], orange: ['#faead7', '#916535', '#e9d0af'], rose: ['#f7e1e8', '#97596f', '#e9bdcb'], cyan: ['#dff1ef', '#397b79', '#b7dad8'] };
export function coursePalette(color, active = true) {
    if (!active) return ['#ffffff', '#6b7280', '#d1d5db'];
    if (palettes[color]) return palettes[color];
    if (!/^#[a-f\d]{6}$/i.test(color)) return palettes.blue;
    const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
    const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    return [color, luminance > .179 ? '#000000' : '#ffffff', color];
}
export function backgroundRect(width, height, imageWidth, imageHeight, fit = 'contain') {
    const scale = (fit === 'cover' ? Math.max : Math.min)(width / imageWidth, height / imageHeight);
    return { x: (width - imageWidth * scale) / 2, y: (height - imageHeight * scale) / 2, width: imageWidth * scale, height: imageHeight * scale };
}
