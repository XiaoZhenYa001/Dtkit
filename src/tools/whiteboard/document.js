export const MAX_ELEMENTS = 2_000;
export const MAX_POINTS = 100_000;
export const MAX_STROKE_POINTS = 20_000;
export const BACKGROUNDS = Object.freeze(['blank', 'dots', 'grid', 'math', 'ruled', 'english']);
const TYPES = new Set(['stroke', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note', 'formula']);
const HEX = /^#[0-9a-f]{6}$/i;

function fail(message) { throw new Error(`白板数据无效：${message}`); }
function finite(value, label) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}必须为有限数值`); return value; }
function positive(value, label, fallback) { const number = value === undefined ? fallback : finite(value, label); if (!(number > 0)) fail(`${label}必须大于 0`); return number; }
function text(value, label) { if (typeof value !== 'string') fail(`${label}必须为文本`); return value; }

export function normalizeDocumentV2(raw) {
    const source = raw?.document || raw;
    if (!source || source.version !== 2 || source.infinite !== true || !Array.isArray(source.elements)) fail('不支持的文档版本或格式');
    if (source.elements.length > MAX_ELEMENTS) fail(`对象超过 ${MAX_ELEMENTS} 个，请拆分白板`);
    const background = source.background ?? 'dots';
    if (!BACKGROUNDS.includes(background)) fail('纸张样式无效');
    const cameraSource = source.camera ?? { x: 0, y: 0, zoom: 1 };
    const camera = { x: finite(cameraSource.x, '画布横坐标'), y: finite(cameraSource.y, '画布纵坐标'), zoom: Math.min(8, Math.max(0.1, finite(cameraSource.zoom, '缩放比例'))) };
    const ids = new Set(); let totalPoints = 0;
    const elements = source.elements.map((item, index) => {
        const label = `第 ${index + 1} 个对象`;
        if (!item || typeof item !== 'object' || !TYPES.has(item.type)) fail(`${label}类型无效`);
        const id = item.id;
        if ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'number' && !Number.isFinite(id)) || !String(id).length || String(id).length > 128 || ids.has(String(id))) fail(`${label}标识无效或重复`);
        ids.add(String(id));
        if (typeof item.color !== 'string' || !HEX.test(item.color)) fail(`${label}颜色无效`);
        const result = { id: String(id), type: item.type, color: item.color.toLowerCase() };
        if (item.type === 'stroke') {
            if (!['pen', 'highlighter', 'eraser'].includes(item.tool)) fail(`${label}笔迹类型无效`);
            if (!Array.isArray(item.points) || !item.points.length || item.points.length > MAX_STROKE_POINTS) fail(`${label}笔迹点数必须为 1 至 ${MAX_STROKE_POINTS}`);
            totalPoints += item.points.length;
            if (totalPoints > MAX_POINTS) fail(`笔迹总点数超过 ${MAX_POINTS}，请拆分白板`);
            result.tool = item.tool; result.width = positive(item.width, `${label}笔宽`, 4);
            result.points = item.points.map(value => {
                if (!Array.isArray(value) || value.length < 2) fail(`${label}笔迹坐标无效`);
                const pressure = value[2] === undefined ? 0.5 : finite(value[2], `${label}压力`);
                if (pressure < 0 || pressure > 1) fail(`${label}压力必须在 0 至 1 之间`);
                return [finite(value[0], `${label}横坐标`), finite(value[1], `${label}纵坐标`), pressure];
            });
        } else if (['line', 'arrow', 'rect', 'ellipse'].includes(item.type)) {
            for (const key of ['x1', 'y1', 'x2', 'y2']) result[key] = finite(item[key], `${label}${key}`);
            result.width = positive(item.width, `${label}线宽`, 4);
        } else {
            result.x = finite(item.x, `${label}横坐标`); result.y = finite(item.y, `${label}纵坐标`);
            if (item.type === 'formula') { result.latex = text(item.latex, `${label}公式`); result.width = positive(item.width, `${label}宽度`, 220); result.height = positive(item.height, `${label}高度`, 60); }
            else {
                result.text = text(item.text, `${label}内容`);
                if (item.type === 'text') result.size = positive(item.size, `${label}字号`, 24);
                else { result.width = positive(item.width, `${label}宽度`, 220); result.height = positive(item.height, `${label}高度`, 150); }
            }
        }
        return result;
    });
    return { version: 2, infinite: true, background, camera, elements };
}

export function historyWeight(snapshot) {
    return (Array.isArray(snapshot) ? snapshot : snapshot?.elements || []).reduce((total, element) => total + 1 + (element.type === 'stroke' ? element.points.length : String(element.text || element.latex || '').length), 0);
}
