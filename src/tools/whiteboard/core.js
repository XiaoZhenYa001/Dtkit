export const MAX_STROKES = 300;
export const MAX_POINTS = 50_000;
export const BOARD_STORAGE_VERSION = 1;

const VALID_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function normalizePoint(x, y, width, height, pressure = 0.5) {
    const safeWidth = Math.max(Number(width) || 1, 1);
    const safeHeight = Math.max(Number(height) || 1, 1);
    return [
        rounded(clamp((Number(x) || 0) / safeWidth, 0, 1), 4),
        rounded(clamp((Number(y) || 0) / safeHeight, 0, 1), 4),
        rounded(clamp(Number(pressure) || 0, 0, 1), 3)
    ];
}

function normalizeStoredPoint(point) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const x = Number(point[0]);
    const y = Number(point[1]);
    const pressure = point.length > 2 ? Number(point[2]) : 0.5;
    if (![x, y, pressure].every(Number.isFinite)) return null;
    return [
        rounded(clamp(x, 0, 1), 4),
        rounded(clamp(y, 0, 1), 4),
        rounded(clamp(pressure, 0, 1), 3)
    ];
}

function normalizeStroke(stroke) {
    if (!stroke || typeof stroke !== 'object' || !VALID_TOOLS.has(stroke.tool)) return null;
    const points = Array.isArray(stroke.points)
        ? stroke.points.map(normalizeStoredPoint).filter(Boolean)
        : [];
    if (points.length === 0) return null;

    const width = Number(stroke.width);
    return {
        id: typeof stroke.id === 'string' || typeof stroke.id === 'number' ? stroke.id : '',
        tool: stroke.tool,
        color: HEX_COLOR.test(stroke.color) ? stroke.color.toLowerCase() : '#242937',
        width: rounded(clamp(Number.isFinite(width) ? width : 4, 1, 40), 1),
        points
    };
}

export function compactStrokes(strokes, maxStrokes = MAX_STROKES, maxPoints = MAX_POINTS) {
    const strokeLimit = Math.max(1, Math.floor(maxStrokes));
    let remainingPoints = Math.max(1, Math.floor(maxPoints));
    const candidates = Array.isArray(strokes) ? strokes.slice(-strokeLimit) : [];
    const compacted = [];

    for (let index = candidates.length - 1; index >= 0 && remainingPoints > 0; index -= 1) {
        const item = candidates[index];
        if (!item || !Array.isArray(item.points) || item.points.length === 0) continue;
        const points = item.points.length > remainingPoints
            ? item.points.slice(-remainingPoints)
            : item.points;
        compacted.push({ ...item, points });
        remainingPoints -= points.length;
    }

    return compacted.reverse();
}

export function serializeBoard(strokes, gridEnabled = true) {
    const safeStrokes = compactStrokes(
        (Array.isArray(strokes) ? strokes : []).map(normalizeStroke).filter(Boolean)
    );
    return JSON.stringify({
        version: BOARD_STORAGE_VERSION,
        gridEnabled: gridEnabled !== false,
        strokes: safeStrokes
    });
}

export function deserializeBoard(serialized) {
    const fallback = { strokes: [], gridEnabled: true };
    try {
        const parsed = JSON.parse(serialized);
        if (!parsed || parsed.version !== BOARD_STORAGE_VERSION || !Array.isArray(parsed.strokes)) {
            return fallback;
        }
        const strokes = compactStrokes(parsed.strokes.map(normalizeStroke).filter(Boolean));
        return { strokes, gridEnabled: parsed.gridEnabled !== false };
    } catch {
        return fallback;
    }
}
