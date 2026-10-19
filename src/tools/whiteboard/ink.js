function applyStrokeStyle(context, stroke, alpha) {
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = stroke.width;
    context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.globalAlpha = alpha;
}

function dot(context, value, width) {
    context.beginPath(); context.arc(value[0], value[1], width / 2, 0, Math.PI * 2); context.fill();
}

export function drawStroke(context, stroke) {
    const points = stroke.points; if (!points.length) return;
    context.save(); applyStrokeStyle(context, stroke, stroke.tool === 'highlighter' ? 0.28 : 1);
    if (points.length === 1) dot(context, points[0], stroke.width);
    else {
        context.beginPath(); context.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length - 1; index++) {
            const current = points[index]; const next = points[index + 1];
            context.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) / 2, (current[1] + next[1]) / 2);
        }
        context.lineTo(points.at(-1)[0], points.at(-1)[1]); context.stroke();
    }
    context.restore();
}

export function paintStrokeIncrement(context, stroke, nextIndex = 1, initialized = false) {
    const points = stroke.points;
    if (!points.length) return { nextIndex: 1, tail: null, initialized: false };
    let index = initialized ? Math.max(1, nextIndex) : 1;
    context.save(); applyStrokeStyle(context, stroke, 1);
    if (!initialized) dot(context, points[0], stroke.width);
    const previous = index === 1 ? points[0] : [(points[index - 1][0] + points[index][0]) / 2, (points[index - 1][1] + points[index][1]) / 2];
    let from = previous;
    if (index < points.length - 1) {
        context.beginPath(); context.moveTo(from[0], from[1]);
        for (; index < points.length - 1; index++) {
            const current = points[index]; const next = points[index + 1];
            from = [(current[0] + next[0]) / 2, (current[1] + next[1]) / 2];
            context.quadraticCurveTo(current[0], current[1], from[0], from[1]);
        }
        context.stroke();
    }
    context.restore();
    return { nextIndex: index, tail: points.length > 1 ? { from: [...from], to: points.at(-1).slice(0, 2) } : null, initialized: true };
}
